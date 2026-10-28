// 离线测试：对照实验的请求形状必须「一次只动一个因素」，否则结论不成立。
// 全部不打网络、不需要真实 bdms.node。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const mockBdms = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-bdms.mjs')

const {
    APP_PROFILES,
    ARMS,
    BASELINE,
    armReadings,
    buildIdentity,
    buildPcTrackV2Request,
    encodeSortedParams,
    extractScalars,
    maskTrackId,
    queryEscape,
    runArm,
    safeMessage,
} = await import('../tools/entitlement-matrix.mjs')

const FIXED_NOW = 1789435000000
/** 每种身份形状给一个固定值，避免随机项混进 diff。 */
const IDENTITY_SEEDS = {
    ts: { now: FIXED_NOW },
    rand16: { deviceId: '3000000000000003', iid: '4000000000000004' },
    service: { deviceId: '1000000000000001', iid: '2000000000000002', fp: '1000000000000001' },
    captured: { deviceId: '5000000000000005', iid: '6000000000000006', fp: '5000000000000005' },
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
    const base = shapeOf(ARMS.find(item => item.name === BASELINE).request)
    const mine = shapeOf(arm.request)
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
    for (const arm of ARMS.filter(item => !item.request.seo)) {
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
    const base = shapeOf(ARMS.find(item => item.name === BASELINE).request)
    assert.deepEqual(shapeOf(mismatch.request), base)
    assert.equal(mismatch.request.signWith, 'other16')
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
    const without = shapeOf(ARMS.find(item => item.name === 'no-cookie').request)
    const withCookie = shapeOf(ARMS.find(item => item.name === 'good-ts').request)
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
    assert.deepEqual(
        Object.keys(extractScalars(JSON.stringify({ message: '登录提示里可能夹着地址', status_code: 0 }))),
        ['status_code'],
        '字符串型字段一律不收：文案 / 地址 / 标识都可能夹凭据',
    )
})

test('空回包与坏 JSON 都能给出可读判定', () => {
    assert.equal(extractScalars('').status_code, undefined)
    assert.equal(extractScalars('not json').constructor, Object)
})

test('captured 身份必须显式给设备号，缺了就报错而不是悄悄换成别的一份', () => {
    assert.throws(() => buildIdentity('captured', {}), /--device/)
    assert.deepEqual(buildIdentity('captured', { deviceId: '5000000000000005' }), {
        deviceId: '5000000000000005',
        iid: '5000000000000005',
        fp: '5000000000000005',
        shape: 'captured',
    })
})

test('报错信息里的本机绝对路径会被换成文件名（日志要被人贴进票里）', () => {
    const cases = [
        'bdms.node 不存在：D:\\Users\\someone\\nope\\bdms.node',
        'bdms.node 不存在：D:/Users/someone/nope/bdms.node',
        'bdms.node 不存在：/home/someone/vendor/soda-music/bdms.node',
    ]
    for (const message of cases) {
        const out = safeMessage(new Error(message))
        assert.equal(out, 'bdms.node 不存在：bdms.node', `没剥掉路径：${out}`)
    }
    assert.equal(safeMessage(new Error('未找到 bdms.node：请设置 LIBMSSDK_CLIENT_DIR')), '未找到 bdms.node：请设置 LIBMSSDK_CLIENT_DIR')
})

test('读数不带曲名与完整曲目号，所以日志可以直接贴进票里', () => {
    const row = armReadings(
        JSON.stringify({
            track: { id: '7151823294864295937', name: '某首私人歌单里的歌', duration: 185262 },
            track_player: {
                video_model: JSON.stringify({ video_duration: 185.309, video_list: [] }),
            },
        }),
        '7151823294864295937',
    )
    const text = JSON.stringify(row)
    assert.equal(row.fullTrack, true)
    assert.equal(row.track, '***5937')
    assert.ok(!text.includes('7151823294864295937'), '完整曲目号不该出现在读数里')
    assert.ok(!text.includes('某首私人歌单里的歌'), '曲名不该出现在读数里')
    assert.equal(maskTrackId('123'), '123')
})

test('CLI 直接跑 captured 而不给 --device 时，报错要说清缺什么（不起网络）', () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'entitlement-matrix.mjs')
    const result = spawnSync(process.execPath, [cli, '--track', '123', '--arm', 'captured'], {
        encoding: 'utf8',
        env: {
            ...process.env,
            LIBMSSDK_COOKIE: 'sessionid_ss=test',
            LIBMSSDK_DEVICE_ID: '7000000000000001',
            LIBMSSDK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-matrix-')),
        },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--device/)
})

test('真实那条路径（stub fetch，不打网络）：签名头在最后、读数脱敏到底', async () => {
    const { BdmsSigner } = await import('../src/bdms.mjs')
    const context = {
        trackId: '7151823294864295937',
        cookie: 'sessionid_ss=SECRET-COOKIE',
        timeoutMs: 5000,
        service: { deviceId: '1000000000000001', iid: '2000000000000002', fp: '1000000000000001' },
        captured: { deviceId: '5000000000000005', iid: '6000000000000006', fp: '5000000000000005' },
    }
    context.signer = new BdmsSigner({ modulePath: mockBdms, deviceId: context.service.deviceId })
    const payload = JSON.stringify({
        track: { id: '7151823294864295937', name: '私人曲目名', duration: 185262 },
        track_player: {
            url_player_info: 'https://example.com/play?sign=SECRET-URL',
            video_model: JSON.stringify({
                video_duration: 185.309,
                video_list: [{ gear_des_key: '0:MP4|5:lossless', video_meta: { quality: 'lossless', bitrate: 1572199, size: 36408802 } }],
            }),
        },
    })
    const seen = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), headers: init.headers })
        return new Response(payload)
    }
    try {
        const row = await runArm(ARMS.find(item => item.name === 'captured'), context)
        assert.equal(row.fullTrack, true)
        assert.equal(row.deviceId, '500***005')
        assert.equal(row.track, '***5937')
        const reading = JSON.stringify(row)
        assert.ok(!reading.includes('SECRET-COOKIE'), 'cookie 不得进读数')
        assert.ok(!reading.includes('SECRET-URL'), '播放地址不得进读数')
        assert.ok(!reading.includes('私人曲目名'), '曲名不得进读数')
        assert.ok(!reading.includes('7151823294864295937'), '完整曲目号不得进读数')
        assert.deepEqual(seen[0].headers.slice(-2).map(([name]) => name), ['X-Helios', 'X-Medusa'])
        assert.ok(seen[0].url.includes('device_id=5000000000000005'), 'captured 用的必须是传进来的那份设备号')
    } finally {
        globalThis.fetch = original
    }
})
