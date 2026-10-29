// 分发器的对外形状：主进程独占监听、解析 HTTP、把请求体交给空闲 worker、把 worker 交回的
// 响应字节写回连接。排队、等待预算、超预算那个预拼好的 503 都在这条路径上。
//
// 这一票不接线 —— src/server.mjs 那条老路径还在默认位置上（切换是 #7），所以这里的用例直接
// 对 createDispatcher 建出来的服务发真 HTTP 请求。
//
// 端口只用 listen(0)：Windows 上自选端口会撞上上一次绑定的 TIME_WAIT，「先探测空闲端口再绑定」
// 这个两步模式在该平台实测大面积失败。

import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { after, test } from 'node:test'

const { createDispatcher } = await import('../src/dispatcher.mjs')
const { fakePool, signedBody } = await import('./helpers/fake-pool.mjs')

const config = {
    version: 'test',
    host: '127.0.0.1',
    token: 'test-token',
    deviceId: '7000000000000001',
    maxBodyBytes: 256 * 1024,
}

const servers = []

after(async () => {
    for (const server of servers) await new Promise(resolve => server.close(resolve))
})

async function serve(pool, limits = {}) {
    const server = createDispatcher({ config: { ...config, ...limits }, pool, log: () => {} })
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    return { server, baseUrl: `http://127.0.0.1:${port}`, port }
}

const signPayload = (overrides = {}) => ({
    url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=7000000000000001',
    method: 'POST',
    body: '{"track_id":"1"}',
    headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
    ...overrides,
})

async function post(baseUrl, payload, { token = config.token, raw } = {}) {
    const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: raw ?? JSON.stringify(payload),
        // 用例失败时别让一条没回包的连接把整个文件吊死在 CI 上
        signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, headers: response.headers, text: await response.text() }
}

/** 真 HTTP 要跑几个事件循环才落到 handler，所以条件轮询而不是猜一个 tick。 */
async function until(condition, describe) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error(`等不到：${describe}`)
}

test('有空闲 worker 就派发：客户端拿到 200 与签名头，交回的是 worker 算出来的字节', async () => {
    const pool = fakePool({ size: 1 })
    const { baseUrl } = await serve(pool)

    const pending = post(baseUrl, signPayload())
    await until(() => pool.requests.length === 1, '请求被派发到空闲 worker')
    assert.equal(pool.busyCount(), 1, '在飞的那台要占着槽位')
    assert.equal(pool.requests[0].request.url, signPayload().url)
    assert.equal(pool.requests[0].request.headers['x-ss-stub'], 'ABC', '签名覆盖 URL + 全部请求头')
    assert.equal(pool.requests[0].request.body, '{"track_id":"1"}', '请求体由主进程转发给 worker')
    assert.equal(pool.requests[0].request.method, 'POST')

    pool.complete(pool.requests[0].slotId, { kind: 'SUCCESS', body: signedBody() })
    const response = await pending
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.text)
    assert.equal(payload.ok, true)
    assert.equal(payload.headers['X-Helios'], 'h')
    assert.equal(payload.headers['X-Medusa'], 'm')
})

// 用真实 CR/LF 拼请求行：写进源码的转义容易被编辑工具吞掉，这里直接给字符
const CRLF = String.fromCharCode(13, 10)
const rawRequest = payload => {
    const body = JSON.stringify(payload)
    return [
        'POST /sign HTTP/1.1',
        'Host: 127.0.0.1',
        `authorization: Bearer ${config.token}`,
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        '',
        body,
    ].join(CRLF)
}

test('客户端挂断之后，它占着的排队位置立刻还回来；槽位只给还活着的请求', async () => {
    const pool = fakePool({ size: 1 })
    const notes = []
    const server = createDispatcher({ config: { ...config, waitBudgetMs: 5000, queueLimit: 1 }, pool, log: (e, d) => notes.push({ e, ...d }) })
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const baseUrl = `http://127.0.0.1:${port}`
    // 服务端这一侧的连接：once() 当场挂上监听，所以「先关后等」也不会漏掉事件
    // —— 要等的是「服务端知道连接断了」这个事实，不是猜一个时长
    const serverCloses = []
    server.on('connection', socket => serverCloses.push(once(socket, 'close')))

    // 唯一那台占住在飞：任何请求都只能排队
    const held = pool.lease()
    held.run({ url: 'https://api.qishui.com/held' })
    await until(() => pool.requests.length === 1, '占位请求进入 worker')

    const socket = net.connect(port, '127.0.0.1')
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(rawRequest(signPayload({ url: 'https://api.qishui.com/abandoned' })))
    await new Promise(resolve => setTimeout(resolve, 50))

    // 队列只有 1 个位置且被上一条占了 —— 这条被当场拒就是「上一条确实排进去了」的凭据
    const witness = await post(baseUrl, signPayload({ url: 'https://api.qishui.com/witness' }))
    assert.equal(witness.status, 503, '队列已被占满')

    socket.destroy()
    await once(socket, 'close')
    // 客户端 destroy 之后服务端要过一问才知道连接断了：Linux 上 CI 就是栽在这一拍上，
    // 槽位被一条已经死掉的请求抢走。等到这里，队列里那一条已经被摘掉，后面的断言没有竞态。
    await serverCloses[0]

    // 挂断之后位置要还回来：还回来才谈得上「排得下」，否则这条又会被当场拒
    const pending = post(baseUrl, signPayload({ url: 'https://api.qishui.com/alive' }))
    pool.complete(held.id, { kind: 'SUCCESS', body: signedBody() })
    await until(() => pool.requests.length === 2, '腾出的槽位接住了一条排队的')
    assert.match(pool.requests[1].request.url, /\/alive$/, '接住槽位的是还活着的那一条')
    pool.complete(pool.requests[1].slotId, { kind: 'SUCCESS', body: signedBody() })

    const response = await pending
    assert.equal(response.status, 200, '等一会儿会好，就该真的等到')
    assert.ok(JSON.parse(response.text).headers['X-Medusa'])
})

/** 自己写一条 POST 并读到连接被关闭：只有这样才能分清「读到 503」和「被连接重置」。 */
function rawPost(port, payload) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        const chunks = []
        let error = null
        socket.on('error', cause => {
            error = cause
        })
        socket.on('data', chunk => chunks.push(chunk))
        socket.on('close', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), error }))
        socket.setTimeout(5000, () => {
            socket.destroy()
            reject(new Error('五秒内没等到连接关闭'))
        })
        const body = JSON.stringify(payload)
        socket.write(
            `POST /sign HTTP/1.1\r\nHost: 127.0.0.1\r\nauthorization: Bearer ${config.token}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        )
    })
}

test('超出等待预算：客户端读到的是那个 503 与等待时长，不是连接重置', async () => {
    const pool = fakePool({ size: 1 })
    const { server, port } = await serve(pool, { waitBudgetMs: 50 })
    const body = signPayload()

    const held = pool.lease()
    held.run({ url: 'https://api.qishui.com/held' })
    await until(() => pool.requests.length === 1, '占位请求进入 worker')

    const { text, error } = await rawPost(port, body)
    assert.equal(error, null, `连接不该被重置：${error?.code || ''}`)
    assert.match(text, /^HTTP\/1\.1 503 /, '超预算回的是服务忙')
    assert.match(text, /retry-after: 1/i, '头里带等待时长')
    assert.match(text, /"code":"BUSY"/, '体里带稳定原因码')
    assert.match(text, /"retry_after_seconds":1/)
})

test('队列有上限：排不下的当场拒，而不是无限堆积到大家一起超时', async () => {
    const pool = fakePool({ size: 1 })
    const { baseUrl } = await serve(pool, { waitBudgetMs: 5000, queueLimit: 1 })

    const held = pool.lease()
    held.run({ url: 'https://api.qishui.com/held' })
    await until(() => pool.requests.length === 1, '占位请求进入 worker')

    // 谁先到不由我们定，所以断言的是「两条里恰好一条被当场拒」，而不是「第二条被拒」
    const a = post(baseUrl, signPayload())
    const b = post(baseUrl, signPayload())
    const early = await Promise.race([a, b])
    assert.equal(early.status, 503, '队列只有 1 个位置，第二条不该被收留')
    assert.match(early.text, /"code":"BUSY"/)
    assert.equal(early.headers.get('retry-after'), '1')

    pool.complete(held.id, { kind: 'SUCCESS', body: signedBody() })
    await until(() => pool.requests.length === 2, '腾出的槽位接住排着的那一条')
    pool.complete(pool.requests[1].slotId, { kind: 'SUCCESS', body: signedBody() })

    const settled = await Promise.all([a, b])
    assert.deepEqual(settled.map(entry => entry.status).sort(), [200, 503], '一条等到服务，一条当场被拒')
})

test('错误各回各的码：鉴权失败、请求非法、worker 算错、模块没加载，都不是 502', async () => {
    const pool = fakePool({ size: 1 })
    const { baseUrl } = await serve(pool, { waitBudgetMs: 5000 })

    const unauthorized = await post(baseUrl, signPayload(), { token: null })
    assert.equal(unauthorized.status, 401)
    assert.match(unauthorized.text, /"code":"UNAUTHORIZED"/)
    assert.equal(unauthorized.headers.get('retry-after'), null, '换凭据这种事没有「再等一秒」')
    assert.equal(pool.requests.length, 0, '没鉴权过的请求不该占 worker')

    const malformed = await post(baseUrl, undefined, { raw: '{"url":' })
    assert.equal(malformed.status, 400)
    assert.match(malformed.text, /"code":"INVALID_REQUEST"/)

    const missingUrl = await post(baseUrl, { method: 'POST' })
    assert.equal(missingUrl.status, 400)

    const inFlight = post(baseUrl, signPayload())
    await until(() => pool.requests.length === 1, '请求进入 worker')
    pool.complete(pool.requests[0].slotId, { kind: 'INTERNAL_ERROR', message: '签名不完整：只拿到 0 个头' })
    const broken = await inFlight
    assert.equal(broken.status, 500, 'worker 输出不对要按「必须有人来修」回，绝不能回没有签名的 200')
    assert.match(broken.text, /"code":"INTERNAL_ERROR"/)
    assert.match(broken.text, /签名不完整/, 'worker 那句原因要能走到调用方，否则线上只能看到一个笼统的 500')

    // 体太长：客户端要读得到那句 400，而不是在上传中途拿到一个连接重置
    const { baseUrl: cappedUrl } = await serve(fakePool({ size: 1 }), { maxBodyBytes: 64 })
    const oversized = await post(cappedUrl, signPayload({ body: 'x'.repeat(4096) }))
    assert.equal(oversized.status, 400, '超上限的请求体：回的是改请求，不是把连接掀了')
    assert.match(oversized.text, /请求体超过 64 字节/)

    const blocked = fakePool({ size: 1, ready: false, blocker: 'SIGNER_UNAVAILABLE' })
    const { baseUrl: blockedUrl } = await serve(blocked, { waitBudgetMs: 5000 })
    const unavailable = await post(blockedUrl, signPayload())
    assert.equal(unavailable.status, 500, '配置错不是「服务忙」：回 503 会让人一直等一个永远不会好的东西')
    assert.match(unavailable.text, /"code":"SIGNER_UNAVAILABLE"/)
})
