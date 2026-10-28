// 身份文件的写入合约：并发首次启动只能有一个赢家；只读入口不创建；只有格式不合法才重建。
// 「同时首次启动」只在真进程里才成立，所以那一条用子进程 + IPC 栅栏，而不是在同一进程里假装并发。

import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const racerPath = path.join(here, 'helpers', 'identity-race-child.mjs')

const { identityFile, prepareStoredIdentity, readStoredIdentity } = await import('../src/identity.mjs')

const PROCESS_COUNT = 4
/** 判据要求「连跑数十轮」；CI 上嫌慢可以用 LIBMSSDK_IDENTITY_RACE_ROUNDS 调小。 */
const ROUNDS = Number(process.env.LIBMSSDK_IDENTITY_RACE_ROUNDS || 30)
const STARTUP_TIMEOUT_MS = 20_000

const running = new Set()

after(() => {
    for (const child of running) child.kill()
})

function tempStateDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-identity-'))
}

function once(emitter, event) {
    return new Promise(resolve => emitter.once(event, resolve))
}

function withTimeout(promise, ms, describe) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(describe())), ms)
        promise
            .then(resolve, reject)
            .finally(() => clearTimeout(timer))
    })
}

/** 同时启动 PROCESS_COUNT 个进程，让它们在一个空 state 目录上竞争首次创建。 */
async function raceStart(dir) {
    const output = []
    const children = Array.from({ length: PROCESS_COUNT }, () => {
        const child = fork(racerPath, [], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
                ...process.env,
                LIBMSSDK_STATE_DIR: dir,
                // 设备号一旦被环境变量覆盖，就不会再有人碰身份文件，竞争也就不成立了
                LIBMSSDK_DEVICE_ID: '',
                QISHUI_DEVICE_ID: '',
            },
        })
        running.add(child)
        child.on('exit', () => running.delete(child))
        for (const stream of [child.stdout, child.stderr]) {
            stream.setEncoding('utf8')
            stream.on('data', chunk => output.push(chunk))
        }
        return child
    })

    try {
        await Promise.all(children.map(child => once(child, 'message')))
        // 先把收信的监听挂上，再喊开始：子进程回话时不能有窗口没人听
        const replies = Promise.all(children.map(child => once(child, 'message')))
        for (const child of children) child.send({ go: true })
        const results = await withTimeout(
            replies,
            STARTUP_TIMEOUT_MS,
            () => `身份竞争子进程未在 ${STARTUP_TIMEOUT_MS}ms 内回话：${output.join('')}`,
        )
        for (const result of results) {
            if (result?.error) throw new Error(`身份解析子进程失败：${result.error}`)
        }
        // 子进程的告警不单独判失败：并发进程等不到写盘时会重建一次，那是处理过的情况，
        // 由下面的「目录里只有 identity.json」这一条抓住。出了错才把它一起打出来。
        return { results, noise: output.join('').trim() }
    } finally {
        await Promise.all(
            children.map(async child => {
                if (child.exitCode !== null) return
                const exited = once(child, 'exit')
                child.kill()
                await exited
            }),
        )
    }
}

test(`${PROCESS_COUNT} 个进程同时首次启动 ${ROUNDS} 轮：设备号始终唯一，且只有一个赢家`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
        const dir = tempStateDir()
        try {
            const { results, noise } = await raceStart(dir)
            const seen = noise ? `（子进程日志：${noise}）` : ''
            const deviceIds = new Set(results.map(item => item.deviceId))
            const winners = results.filter(item => item.created)
            assert.equal(deviceIds.size, 1, `第 ${round} 轮分裂出 ${deviceIds.size} 个设备号：${JSON.stringify([...deviceIds])}${seen}`)
            assert.equal(winners.length, 1, `第 ${round} 轮有 ${winners.length} 个进程自认为新建了身份${seen}`)
            assert.deepEqual(
                results.filter(item => !item.persisted),
                [],
                `第 ${round} 轮有进程没把身份落在文件上`,
            )
            const stored = readStoredIdentity(dir)
            assert.equal(stored.device_id, results[0].deviceId, `第 ${round} 轮磁盘上的设备号和进程读到的不一致`)
            assert.equal(stored.fp, stored.device_id, `第 ${round} 轮 fp 没跟 device_id 成套`)
            // 没有临时文件、没有 .corrupt、没有第二份：目录里就只有那一个身份文件
            assert.deepEqual(fs.readdirSync(dir), ['identity.json'], `第 ${round} 轮状态目录里不止一个文件`)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
})

test('身份文件已存在时只回读，不覆盖也不告警', () => {
    const dir = tempStateDir()
    const existing = {
        device_id: '3123456789012345',
        iid: '3987654321098765',
        fp: '3123456789012345',
        created_at: '2026-01-01T00:00:00.000Z',
    }
    const before = `${JSON.stringify(existing, null, 2)}\n`
    try {
        fs.writeFileSync(identityFile(dir), before)
        const notes = []
        const prepared = prepareStoredIdentity({ dir, log: (event, detail) => notes.push(detail) })
        assert.equal(prepared.created, false)
        assert.equal(prepared.persisted, true)
        assert.equal(prepared.identity.device_id, existing.device_id)
        assert.equal(fs.readFileSync(identityFile(dir), 'utf8'), before, '格式合法就不该动这个文件')
        assert.deepEqual(notes, [], '正常回读不该出声')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('内容损坏时重建并留下告警日志，坏文件挪开而不是删掉', () => {
    for (const broken of ['', '{ 不是 JSON', '{"device_id":"700000000000000"}', '{"device_id":""}']) {
        const dir = tempStateDir()
        try {
            fs.writeFileSync(identityFile(dir), broken)
            const notes = []
            const prepared = prepareStoredIdentity({
                dir,
                readBudgetMs: 30,
                log: (event, detail) => notes.push(detail),
            })
            assert.equal(prepared.created, true, `损坏内容应重建：${JSON.stringify(broken)}`)
            assert.match(readStoredIdentity(dir).device_id, /^[1-8]\d{15}$/)
            assert.equal(
                notes.filter(item => item.level === 'warn').length,
                1,
                `重建应该只留一条告警：${JSON.stringify(broken)} → ${JSON.stringify(notes)}`,
            )
            assert.deepEqual(fs.readdirSync(dir).sort(), ['identity.json', 'identity.json.corrupt'])
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
})

test('身份文件读不动时不挪走它：没读到过内容的东西不能当成坏文件', () => {
    const dir = tempStateDir()
    try {
        // identity.json 位置放一个目录：读它报的是 EISDIR 而不是 ENOENT，等价于「被占用 / 没权限」
        fs.mkdirSync(identityFile(dir))
        const notes = []
        const prepared = prepareStoredIdentity({
            dir,
            readBudgetMs: 30,
            log: (event, detail) => notes.push(detail),
        })
        assert.equal(prepared.persisted, false, '读不动时不该假装身份已经落盘')
        assert.match(prepared.identity.device_id, /^[1-8]\d{15}$/)
        assert.deepEqual(fs.readdirSync(dir), ['identity.json'], '读不动的那一份不该被挪走')
        assert.equal(fs.existsSync(`${identityFile(dir)}.corrupt`), false)
        assert.ok(
            notes.some(item => item.level === 'warn'),
            `读不动要留下告警：${JSON.stringify(notes)}`,
        )
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('只读入口不创建也不改写，worker 只能拿到主进程留下的那一份', () => {
    const dir = tempStateDir()
    try {
        assert.equal(readStoredIdentity(dir), null, '没有身份文件时只读入口不该生成')
        assert.deepEqual(fs.readdirSync(dir), [], '只读入口不该留下任何文件')

        const prepared = prepareStoredIdentity({ dir })
        const written = fs.readFileSync(identityFile(dir))
        assert.equal(readStoredIdentity(dir).device_id, prepared.identity.device_id)

        assert.equal(fs.readFileSync(identityFile(dir)).equals(written), true, '只读入口改了身份文件的内容')

        const missingDir = path.join(dir, 'never-created')
        assert.equal(readStoredIdentity(missingDir), null)
        assert.equal(fs.existsSync(missingDir), false, '只读入口不该把 state 目录建出来')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
