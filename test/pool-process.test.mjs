// 黑盒多进程：真 fork、真 IPC、真 worker（src/worker.mjs），原生模块仍用 mock。
//
// 这一组只有真进程才测得到：预热判据要在一个独立的事件循环里自己收敛出「稳态」，
// 杀掉一台之后「在飞的请求被清理、槽位不永久停在忙」也只能用真退出验证。
//
// 不断言「第几个请求落到第几个 worker」——两个平台的分发模型不同，那种断言迟早会自己翻脸。

import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

const { forkWorker, startDispatcher } = await import('../src/dispatcher.mjs')

const config = {
    version: 'test',
    host: '127.0.0.1',
    token: '',
    deviceId: '7000000000000001',
    maxBodyBytes: 256 * 1024,
}

const running = []

after(async () => {
    for (const entry of running) {
        await entry.pool.stop()
        for (const child of entry.children) child.kill()
        await new Promise(resolve => entry.server.close(resolve))
    }
})

/** 起一套真的：按 startDispatcher 的生产装配，只把 fork 包一层好拿到进程句柄。 */
async function startReal({ workers, unstableCalls = 0, signDelayMs = 0, deviceId = '7000000000000001', stateDir }) {
    const children = []
    const notes = []
    const giveUps = []
    const env = {
        ...process.env,
        LIBMSSDK_WORKERS: String(workers),
        LIBMSSDK_BDMS_MODULE: mockBdms,
        LIBMSSDK_DEVICE_ID: deviceId,
        LIBMSSDK_WORKER_RESPAWN_BASE_MS: '100',
        LIBMSSDK_WORKER_RESPAWN_CAP_MS: '400',
        LIBMSSDK_WARMUP_BUDGET_MS: '20000',
        MOCK_BDMS_UNSTABLE_CALLS: String(unstableCalls),
        MOCK_BDMS_SIGN_DELAY_MS: String(signDelayMs),
    }
    if (stateDir) env.LIBMSSDK_STATE_DIR = stateDir
    if (deviceId === null) delete env.LIBMSSDK_DEVICE_ID
    const entry = await startDispatcher({
        config,
        env,
        log: (event, detail) => notes.push({ event, detail }),
        spawn: (index, childEnv) => {
            const child = forkWorker(index, childEnv)
            children.push(child)
            return child
        },
        onGiveUp: () => giveUps.push(Date.now()),
    })
    await new Promise(resolve => entry.server.listen(0, '127.0.0.1', resolve))
    const address = entry.server.address()
    entry.baseUrl = `http://127.0.0.1:${address.port}`
    entry.children = children
    entry.notes = notes
    entry.giveUps = giveUps
    running.push(entry)
    return entry
}

function until(condition, describe, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (condition()) return resolve()
            if (Date.now() > deadline) return reject(new Error(`等不到：${describe}`))
            setTimeout(poll, 10)
        }
        poll()
    })
}

const signPayload = () => ({
    url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=7000000000000001',
    method: 'POST',
    body: '{"track_id":"7501674235158431760"}',
    headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
})

async function post(baseUrl, payload) {
    const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
    })
    return { status: response.status, text: await response.text() }
}

test('真进程：预热判据自己学出稳态；杀掉正在算签名的那台，客户端读到 500 而不是永远等', async () => {
    // 前两次输出比稳态短（真机 init 之后就有这么一段窗口），单次调用同步占住 300ms
    const { pool, children, notes, baseUrl } = await startReal({ workers: 1, unstableCalls: 2, signDelayMs: 300 })

    await until(() => pool.readyCount === 1, 'worker 自学习到就绪')
    const started = notes.find(note => note.event === 'dispatcher')
    assert.equal(started.detail.workers, 1, '启动日志要写明实际值')
    assert.match(started.detail.reason, /LIBMSSDK_WORKERS=1/, '还要写明这个数是谁给的')

    const pending = post(baseUrl, signPayload())
    await until(() => pool.busyCount === 1, '真 worker 正在算这一份签名')
    children.at(-1).kill('SIGKILL')

    const killed = await pending
    assert.equal(killed.status, 500, `进程死在计算中途：${killed.text.slice(0, 120)}`)
    assert.match(killed.text, /"code":"INTERNAL_ERROR"/)

    // 槽位不能永久停在忙：退避重生 + 重新预热之后，同一个位置要再次接得住活
    await until(() => children.length === 2 && pool.readyCount === 1, '重生并重新就绪')
    await until(() => pool.busyCount === 0, '死掉那次的在飞状态已被清理')
    const recovery = await post(baseUrl, signPayload())
    assert.equal(recovery.status, 200)
    const payload = JSON.parse(recovery.text)
    assert.equal(payload.headers['X-Helios'].startsWith('mock-helios-'), true)
    assert.equal(payload.headers['X-Medusa'].startsWith('mock-medusa-'), true)
})

test('真进程多开：杀掉一台，其余继续服务，不需要有人介入', async () => {
    const { pool, children, baseUrl } = await startReal({ workers: 2 })

    await until(() => pool.readyCount === 2, '两台都自学习到就绪')
    assert.equal((await post(baseUrl, signPayload())).status, 200)

    // 两台此刻都闲着：杀其中一台，剩下的那台必须立刻独挑大梁
    children[0].kill()
    await once(children[0], 'exit')
    assert.equal(pool.readyCount, 1, '没了的那台不再算进「能服务」')

    const survivor = await post(baseUrl, signPayload())
    assert.equal(survivor.status, 200, '一台死了不该让客户端感到停机')

    await until(() => pool.readyCount === 2, '退避之后补齐到两台')
    assert.equal((await post(baseUrl, signPayload())).status, 200)
})

test('真 worker 只读身份：没有可读身份时报「配置错」，绝不自己建一份', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-worker-identity-'))
    try {
        const { pool, notes, baseUrl } = await startReal({ workers: 1, deviceId: null, stateDir: dir })

        await until(
            () => notes.some(note => note.event === 'worker-warmup-failed' && note.detail.kind === 'SIGNER_UNAVAILABLE'),
            'worker 把「没有身份」报成配置错',
        )
        assert.equal(pool.readyCount, 0, '没身份就还是不就绪，不能挂着「能服务」')
        assert.equal(
            fs.existsSync(path.join(dir, 'identity.json')),
            false,
            'worker 不许创建身份文件 —— 那是主进程 fork 之前用独占创建收敛好的事',
        )

        const response = await post(baseUrl, signPayload())
        assert.equal(response.status, 500, '配置错不是「再等等」：回 503 会让人一直等一个永远不会好的东西')
        assert.match(response.text, /"code":"SIGNER_UNAVAILABLE"/)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
