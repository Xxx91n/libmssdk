// 离线测试：对照实验的请求形状必须「一次只动一个因素」，否则结论不成立。
// 全部不打网络、不需要真实 bdms.node。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

const {
    APP_PROFILES,
    ARMS,
    BASELINE,
    buildIdentity,
    buildPcTrackV2Request,
    encodeSortedParams,
    extractScalars,
    queryEscape,
} = await import('../tools/entitlement-matrix.mjs')

const FIXED_NOW = 1789435000000
/** 每种身份形状给一个固定值，避免随机项混进 diff。 */
const IDENTITY_SEEDS = {
    ts: { now: FIXED_NOW },
    rand16: { deviceId: '3000000000000003', iid: '4000000000000004' },
    service: { deviceId: '1000000000000001', iid: '2000000000000002', fp: '1000000000000001' },
}

/** 把一条 arm 落成可比较的形状（设备号用固定值，避免随机项混进 diff）。 */
function shapeOf(arm) {
    const identity = buildIdentity(arm.identity, IDENTITY_SEEDS[arm.identity])
    const spec = buildPcTrackV2Request({
        trackId: '123',
        identity,
        app: arm.app,
        localUser: arm.localUser,
        cookie: arm.useCookie ? 'sessionid_ss=fixed' : '',
    })
    return {
        query: Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, String(v)])),
        headers: Object.fromEntries(spec.headers),
        body: spec.body,
    }
}

function diffAgainstBaseline(arm) {
    const base = shapeOf(ARMS.find(item => item.name === BASELINE).arm)
    const mine = shapeOf(arm.arm)
    const touched = []
    for (const key of new Set([...Object.keys(base.query), ...Object.keys(mine.query)])) {
        if (base.query[key] !== mine.query[key]) touched.push(`query.${key}`)
    }
    for (const key of new Set([...Object.keys(base.headers), ...Object.keys(mine.headers)])) {
        if (base.headers[key] !== mine.headers[key]) touched.push(`header.${key}`)
    }
    if (base.body !== mine.body) touched.push('body')
    return { touched, mine }
}

test('查询参数按字典序拼接，空格转 +（与客户端 Params::encode 同形）', () => {
    assert.equal(queryEscape('Windows 11'), 'Windows+11')
    assert.equal(queryEscape('a~b.c_d-e'), 'a~b.c_d-e')
    assert.equal(queryEscape("!*'()"), '%21%2A%27%28%29')
    assert.equal(encodeSortedParams({ zz: '1', aa: '2', mm: '' }), 'aa=2&mm=&zz=1')
})

test('时间戳身份与客户端回退一致：iid = device_id + 1，fp = device_id', () => {
    const identity = buildIdentity('ts', { now: FIXED_NOW })
    assert.equal(identity.deviceId, '1789435000000')
    assert.equal(identity.iid, '1789435000001')
    assert.equal(identity.fp, identity.deviceId)
    assert.match(buildIdentity('rand16', { deviceId: '1234567890123456' }).deviceId, /^[1-8]\d{15}$/)
})

test('每一条 arm 只改它声明过的字段', () => {
    for (const arm of ARMS.filter(item => !item.arm.seo)) {
        const { touched } = diffAgainstBaseline(arm)
        assert.deepEqual(
            touched.slice().sort(),
            arm.touches.slice().sort(),
            `${arm.name} 实际改动 ${touched.join(',') || '（无）'} 与声明 ${arm.touches.join(',') || '（无）'} 不一致`,
        )
    }
})

test('签名失效对照的请求形状与基线逐字节相同（差异只在用哪个设备号签名）', () => {
    const mismatch = ARMS.find(item => item.name === 'sig-mismatch')
    const base = shapeOf(ARMS.find(item => item.name === BASELINE).arm)
    assert.deepEqual(shapeOf(mismatch.arm), base)
    assert.equal(mismatch.arm.signWith, 'other16')
})

test('x-ss-stub 就是 body 的 MD5 大写，且签名设备号来自 URL 同一份身份', () => {
    const spec = buildPcTrackV2Request({
        trackId: '123',
        identity: buildIdentity('ts', { now: FIXED_NOW }),
        app: APP_PROFILES.luna330,
        localUser: '1',
        cookie: 'sessionid_ss=x',
    })
    const stub = spec.headers.find(([name]) => name === 'x-ss-stub')[1]
    assert.equal(stub, crypto.createHash('md5').update(spec.body).digest('hex').toUpperCase())
    assert.equal(new URL(spec.url).searchParams.get('device_id'), String(FIXED_NOW))
    assert.equal(new URL(spec.url).searchParams.get('fp'), String(FIXED_NOW))
})

test('匿名 arm 不带 cookie，其余 arm 都带', () => {
    const without = shapeOf(ARMS.find(item => item.name === 'no-cookie').arm)
    const withCookie = shapeOf(ARMS.find(item => item.name === 'good-ts').arm)
    assert.equal(without.headers.cookie, undefined)
    assert.equal(withCookie.headers.cookie, 'sessionid_ss=fixed')
})

test('读数只留判定用的标量，绝不外泄播放地址、签名与 cookie', () => {
    const cookie = 'sessionid_ss=SECRET-COOKIE-VALUE'
    const raw = JSON.stringify({
        status_code: 0,
        track: { id: 123, name: '某曲', duration: 236620, preview: { duration: 30001 } },
        track_player: {
            url_player_info: 'https://example.com/play?sign=SECRET-URL-TOKEN',
            video_model: JSON.stringify({ video_duration: 236.62, video_list: [] }),
        },
        cookie,
    })
    const picked = extractScalars(raw)
    const text = JSON.stringify(picked)
    assert.equal(picked.status_code, 0)
    assert.equal(picked['track.duration'], 236620)
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), 'cookie 值不得出现在读数里')
    assert.ok(!text.includes('SECRET-URL-TOKEN'), '播放地址不得出现在读数里')
    assert.ok(!text.includes('url_player_info'), 'url 字段本身也不该被带出来')
})

test('空回包与坏 JSON 都能给出可读判定', () => {
    assert.equal(extractScalars('').status_code, undefined)
    assert.equal(extractScalars('not json').constructor, Object)
})
