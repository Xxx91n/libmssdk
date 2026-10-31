// 路由解析的纯判据：pathname 只从请求行来，Host 头不参与；解析永不抛。
//
// 这一条不是洁癖：handler 是 async，`new URL()` 在 handler 里抛一次，就是一条 unhandled
// rejection —— Node 15+ 默认直接退进程。而畸形请求目标是匿名客户端发得出来的（llhttp
// 会收下 `//`）。真 TCP 那一端的行为在 test/dispatcher.test.mjs 与 test/signing.test.mjs。

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { requestPathname } = await import('../src/route.mjs')

test('pathname 只从请求行里取：Host 头写成什么样都不影响', () => {
    assert.equal(requestPathname({ url: '/sign?x=1', headers: { host: '127.0.0.1:8080' } }), '/sign')
    assert.equal(requestPathname({ url: '/sign', headers: { host: 'a b' } }), '/sign', '畸形 Host 不参与解析')
    assert.equal(requestPathname({ url: '/probe?track_id=1', headers: { host: 'evil.example' } }), '/probe')
    assert.equal(requestPathname({ url: '', headers: {} }), '/', '没有请求目标时退回根路径')
})

test('畸形请求目标返回 null 而不是抛错', () => {
    // 这几条都被 llhttp 收下过（见 src/route.mjs 的注释），而 new URL() 对它们抛 TypeError
    for (const target of ['//', 'http://[', 'http://', 'https://[']) {
        assert.equal(requestPathname({ url: target, headers: {} }), null, `畸形目标 ${target} 应判为拿不到 pathname`)
    }
})
