// 错误分类的纯函数单测：映射全枚举、等待时长的来由与落点、未知原因的默认出口。
// 这些用例不碰 HTTP 写出路径——本票只建模块，切换在接线那张票里做。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BUSY_RETRY_AFTER_SECONDS, ERROR_KINDS, classify, failureResponse, retryAfterFromInstant } from '../src/errors.mjs'

const NOW = 1_789_000_000_000

test('映射覆盖成功与每一类失败（含 502 不再是任何情况的出口）', () => {
    const expected = {
        [ERROR_KINDS.SUCCESS]: { status: 200, code: null, retryAfterSeconds: null },
        [ERROR_KINDS.INVALID_REQUEST]: { status: 400, code: 'INVALID_REQUEST', retryAfterSeconds: null },
        [ERROR_KINDS.UNAUTHORIZED]: { status: 401, code: 'UNAUTHORIZED', retryAfterSeconds: null },
        [ERROR_KINDS.RATE_LIMITED]: { status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 3 },
        [ERROR_KINDS.BUSY]: { status: 503, code: 'BUSY', retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS },
        [ERROR_KINDS.SIGNER_UNAVAILABLE]: { status: 500, code: 'SIGNER_UNAVAILABLE', retryAfterSeconds: null },
        [ERROR_KINDS.INTERNAL_ERROR]: { status: 500, code: 'INTERNAL_ERROR', retryAfterSeconds: null },
    }
    assert.deepEqual(Object.keys(expected).sort(), Object.values(ERROR_KINDS).sort(), '映射表要覆盖每一种情况')

    const statuses = new Set()
    for (const [kind, want] of Object.entries(expected)) {
        const got = classify(kind, { retryAtMs: NOW + 3000, nowMs: NOW })
        assert.deepEqual(got, want, `分类 ${kind}`)
        statuses.add(got.status)
    }
    statuses.add(classify('没听过的原因').status)
    assert.ok(!statuses.has(502), '502 不能是任何情况的出口')
    assert.deepEqual([...statuses].sort((a, b) => a - b), [200, 400, 401, 429, 500, 503])
})

test('只有「服务忙」与「被限流」带等待时长，其余都不带', () => {
    const withWait = []
    const withoutWait = []
    for (const kind of Object.values(ERROR_KINDS)) {
        const { retryAfterSeconds } = classify(kind, { retryAtMs: NOW + 30_000, nowMs: NOW })
        if (retryAfterSeconds === null) withoutWait.push(kind)
        else withWait.push(kind)
    }
    assert.deepEqual(withWait.sort(), [ERROR_KINDS.BUSY, ERROR_KINDS.RATE_LIMITED])
    assert.deepEqual(withoutWait.sort(), [
        ERROR_KINDS.INTERNAL_ERROR,
        ERROR_KINDS.INVALID_REQUEST,
        ERROR_KINDS.SIGNER_UNAVAILABLE,
        ERROR_KINDS.SUCCESS,
        ERROR_KINDS.UNAUTHORIZED,
    ])
})

test('被限流的等待时长由精确时刻向上取整、最少 1 秒', () => {
    const cases = [
        [0, 1], // 时刻已到也不能回 0 秒
        [1, 1],
        [999, 1],
        [1000, 1], // 正好整秒不额外加
        [1001, 2],
        [4001, 5],
        [60_000, 60],
        [-5000, 1], // 限流器给的时刻已经过期
    ]
    for (const [waitMs, want] of cases) {
        assert.equal(retryAfterFromInstant(NOW + waitMs, NOW), want, `等 ${waitMs} 毫秒`)
        assert.equal(classify(ERROR_KINDS.RATE_LIMITED, { retryAtMs: NOW + waitMs, nowMs: NOW }).retryAfterSeconds, want)
    }
})

test('限流器没给精确时刻时，被限流仍然带最少 1 秒而不是不带', () => {
    assert.equal(classify(ERROR_KINDS.RATE_LIMITED, { nowMs: NOW }).retryAfterSeconds, 1)
    assert.equal(classify(ERROR_KINDS.RATE_LIMITED, { retryAtMs: 'x', nowMs: NOW }).retryAfterSeconds, 1)
})

test('服务忙固定 1 秒，调用方给的时刻不参与', () => {
    for (const retryAtMs of [undefined, NOW + 1, NOW + 600_000, NOW - 600_000]) {
        assert.equal(classify(ERROR_KINDS.BUSY, { retryAtMs, nowMs: NOW }).retryAfterSeconds, 1)
    }
})

test('等待时长同时出现在响应头和响应体，且是同一个整数', () => {
    for (const [kind, want] of [
        [ERROR_KINDS.RATE_LIMITED, 4],
        [ERROR_KINDS.BUSY, 1],
    ]) {
        const { status, headers, body } = failureResponse(kind, {
            message: '稍后再试',
            retryAtMs: NOW + want * 1000 - 20,
            nowMs: NOW,
        })
        assert.equal(status, kind === ERROR_KINDS.RATE_LIMITED ? 429 : 503)
        assert.equal(headers['Retry-After'], String(want))
        assert.equal(body.retry_after_seconds, want)
        assert.equal(Number(headers['Retry-After']), body.retry_after_seconds)
    }
})

test('不带等待时长的情况，响应头和响应体都没有它', () => {
    for (const kind of [ERROR_KINDS.INVALID_REQUEST, ERROR_KINDS.UNAUTHORIZED, ERROR_KINDS.SIGNER_UNAVAILABLE, '未知']) {
        const { headers, body } = failureResponse(kind, { message: '不行', retryAtMs: NOW + 30_000, nowMs: NOW })
        assert.ok(!('Retry-After' in headers), `${kind} 不该有 Retry-After`)
        assert.ok(!('retry_after_seconds' in body), `${kind} 不该有 retry_after_seconds`)
    }
})

test('未知原因的默认落点是内部错误：500、不带时长、不冒充可重试', () => {
    for (const kind of [undefined, null, '', 'signer BlewUp', 42]) {
        assert.deepEqual(classify(kind, { retryAtMs: NOW + 9000, nowMs: NOW }), {
            status: 500,
            code: 'INTERNAL_ERROR',
            retryAfterSeconds: null,
        })
    }
})

test('动态信息放平级扩展字段，客户端忽略未知字段也不影响契约字段', () => {
    const { body } = failureResponse(ERROR_KINDS.INVALID_REQUEST, {
        message: 'url 不能为空',
        details: { field: 'url', received: 0, code: 'HACK', ok: true },
        nowMs: NOW,
    })
    assert.deepEqual(body, { ok: false, error: 'url 不能为空', code: 'INVALID_REQUEST', field: 'url', received: 0 })
})

test('同一个失败永远同一个分类结果', () => {
    const args = { retryAtMs: NOW + 2500, nowMs: NOW }
    for (const kind of Object.values(ERROR_KINDS)) {
        assert.deepEqual(classify(kind, args), classify(kind, args))
        assert.deepEqual(failureResponse(kind, { nowMs: NOW }), failureResponse(kind, { nowMs: NOW }))
    }
})
