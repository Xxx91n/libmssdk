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
/** 判据要求「连跑数十轮」；嫌慢可以用 LIBMSSDK_IDENTITY_RACE_ROUNDS 调小，但调不成 0 —— 那等于不断言。 */
const requestedRounds = Number(process.env.LIBMSSDK_IDENTITY_RACE_ROUNDS)
const ROUNDS = Number.isInteger(requestedRounds) && requestedRounds > 0 ? requestedRounds : 30
const STARTUP_TIMEOUT_MS = 20_000

const running = new Set()

after(() => {
    for (const child of running) child.kill()
})

function tempStateDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-identity-'))
}

/** 每个用例一个空目录，收完就删；warn 不进 stdout，改进 notes。 */
function withTempStateDir(run) {
    const dir = tempStateDir()
    const notes = []
    try {
        return run({ dir, notes, log: (event, detail) => notes.push(detail) })
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
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
        // 就绪也要有超时：子进程在 import 阶段就死了的话，这里不能把整个用例挂住
        await withTimeout(
            Promise.all(children.map(child => once(child, 'message'))),
            STARTUP_TIMEOUT_MS,
            () => `身份竞争子进程未就绪（可能压根没起来）：${output.join('')}`,
        )
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
        // 子进程的告警不单独判失败：并发进程等不到写盘时会重建一次，那是处理过的情况。
        // 分裂由下面的设备号断言抓，不用这里的日志抓。
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
            assert.equal(stored.device_id, results[0].deviceId, `第 ${round} 轮磁盘上的设备号和进程读到的不一致${seen}`)
            assert.equal(stored.fp, stored.device_id, `第 ${round} 轮 fp 没跟 device_id 成套${seen}`)
            // 目录里不该出现第二个身份文件，也不该出现「临时文件改名」留下的那种名字。
            // identity.json.corrupt 允许出现：创建者卡住 1 秒以上时，别人会把它那份还是空的文件
            // 当成坏文件挪走 —— 实测迟到的写入会把已被改名的那一份填满合法内容，所以这里不能改用
            // 「.corrupt 的内容必须不合法」来区分抖动和真错；分裂由上面的设备号断言抓。
            const files = fs.readdirSync(dir).sort()
            assert.deepEqual(
                files.filter(name => name !== 'identity.json' && name !== 'identity.json.corrupt'),
                [],
                `第 ${round} 轮状态目录里出现了计划外的文件：${JSON.stringify(files)}${seen}`,
            )
            assert.equal(files.filter(name => name === 'identity.json').length, 1, `第 ${round} 轮不止一份身份文件${seen}`)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
})

test('身份文件已存在时只回读，不覆盖也不告警', () => {
    const existing = {
        device_id: '3123456789012345',
        iid: '3987654321098765',
        fp: '3123456789012345',
        created_at: '2026-01-01T00:00:00.000Z',
    }
    const before = `${JSON.stringify(existing, null, 2)}\n`
    withTempStateDir(({ dir, notes, log }) => {
        fs.writeFileSync(identityFile(dir), before)
        const prepared = prepareStoredIdentity({ dir, log })
        assert.equal(prepared.created, false)
        assert.equal(prepared.persisted, true)
        assert.equal(prepared.identity.device_id, existing.device_id)
        assert.equal(fs.readFileSync(identityFile(dir), 'utf8'), before, '格式合法就不该动这个文件')
        assert.deepEqual(notes, [], '正常回读不该出声')
    })
})

test('内容损坏时重建并留下告警日志，坏文件挪开而不是删掉', () => {
    for (const broken of ['', '{ 不是 JSON', '{"device_id":"700000000000000"}', '{"device_id":""}']) {
        withTempStateDir(({ dir, notes, log }) => {
            fs.writeFileSync(identityFile(dir), broken)
            const prepared = prepareStoredIdentity({ dir, readBudgetMs: 30, log })
            assert.equal(prepared.created, true, `损坏内容应重建：${JSON.stringify(broken)}`)
            assert.match(readStoredIdentity(dir).device_id, /^[1-8]\d{15}$/)
            assert.deepEqual(fs.readdirSync(dir).sort(), ['identity.json', 'identity.json.corrupt'])
            assert.equal(
                notes.filter(item => item.level === 'warn').length,
                1,
                `重建应该只留一条告警：${JSON.stringify(broken)} → ${JSON.stringify(notes)}`,
            )
        })
    }
})

test('身份文件读不动时不挪走它：没读到过内容的东西不能当成坏文件', () => {
    withTempStateDir(({ dir, notes, log }) => {
        // identity.json 位置放一个目录：读它报的是 EISDIR 而不是 ENOENT，等价于「被占用 / 没权限」
        fs.mkdirSync(identityFile(dir))
        const prepared = prepareStoredIdentity({ dir, readBudgetMs: 30, log })
        assert.equal(prepared.persisted, false, '读不动时不该假装身份已经落盘')
        assert.match(prepared.identity.device_id, /^[1-8]\d{15}$/)
        assert.deepEqual(fs.readdirSync(dir), ['identity.json'], '读不动的那一份不该被挪走')
        assert.ok(notes.some(item => item.level === 'warn'), `读不动要留下告警：${JSON.stringify(notes)}`)
    })
})

test('坏文件挪不动时不重建：留在原地、用内存里的设备号并告警', () => {
    withTempStateDir(({ dir, notes, log }) => {
        fs.writeFileSync(identityFile(dir), '{ 设备号都不合法')
        // 挪过去的目标位置被一个目录占住：rename 只会报错，不会成功
        fs.mkdirSync(`${identityFile(dir)}.corrupt`)
        const prepared = prepareStoredIdentity({ dir, readBudgetMs: 30, log })
        assert.equal(prepared.persisted, false, '挪不动时不该假装身份已经落盘')
        assert.equal(readStoredIdentity(dir), null)
        assert.equal(fs.readFileSync(identityFile(dir), 'utf8'), '{ 设备号都不合法', '挪不动就该原样留在原地')
        assert.ok(notes.some(item => item.reason === 'stuck'), `挪不动要留下告警：${JSON.stringify(notes)}`)
    })
})

test('身份告警走 stderr，不污染 stdout，也不带出整段本机路径', () => {
    const base = tempStateDir()
    const notADir = path.join(base, 'occupied')
    fs.writeFileSync(notADir, 'x') // 拿一个普通文件当 state 目录：mkdirSync 必失败 → state-dir-unusable
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)
    let out = ''
    let err = ''
    let prepared
    try {
        process.stdout.write = chunk => ((out += String(chunk)), true)
        process.stderr.write = chunk => ((err += String(chunk)), true)
        prepared = prepareStoredIdentity({ dir: notADir }) // 用默认 log，不加注入，才能验到真实通道
    } finally {
        process.stdout.write = realOut
        process.stderr.write = realErr
        fs.rmSync(base, { recursive: true, force: true })
    }
    assert.equal(prepared.persisted, false)
    assert.equal(out, '', `身份告警写进了 stdout，会打断 bridge / selftest 的 JSON.parse：${out}`)
    assert.match(err, /"event":"identity"/, '告警应走 stderr')
    assert.match(err, /"reason":"state-dir-unusable"/)
    assert.ok(!err.includes(os.homedir()), `告警不该带出家目录（含用户名）：${err}`)
})

test('只读入口不创建也不改写，worker 只能拿到主进程留下的那一份', () => {
    withTempStateDir(({ dir }) => {
        assert.equal(readStoredIdentity(dir), null, '没有身份文件时只读入口不该生成')
        assert.deepEqual(fs.readdirSync(dir), [], '只读入口不该留下任何文件')

        const prepared = prepareStoredIdentity({ dir })
        const written = fs.readFileSync(identityFile(dir))
        assert.equal(readStoredIdentity(dir).device_id, prepared.identity.device_id)
        assert.equal(fs.readFileSync(identityFile(dir)).equals(written), true, '只读入口改了身份文件的内容')

        const missingDir = path.join(dir, 'never-created')
        assert.equal(readStoredIdentity(missingDir), null)
        assert.equal(fs.existsSync(missingDir), false, '只读入口不该把 state 目录建出来')
    })
})
