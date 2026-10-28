#!/usr/bin/env node
// 对照实验：整曲还是试听，到底由「Cookie」「签名构造」「设备身份」里的哪一个决定。
//
// 一次运行只打 `POST /luna/pc/track_v2`（外加一条免签名的 SEO 对照），
// 每条 Arm 只改变声明出来的那几个字段，其余逐字节相同。
//
// 凭据边界：cookie 只从本机读取（环境变量 / 本机配置文件），不落盘、不打印；
// 输出只有请求形状、脱敏设备号、签名长度和回包判定。
//
//   node tools/entitlement-matrix.mjs --list                       # 只看矩阵，不打网络
//   node tools/entitlement-matrix.mjs --track <id> --arm good-ts   # 只跑一条
//   node tools/entitlement-matrix.mjs --track <id> --repeat 2      # 跑全部（重复关键条）

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BdmsSigner } from '../src/bdms.mjs'
import { loadConfig, maskDeviceId, randomDeviceId } from '../src/config.mjs'
import { summarizeTrackV2Response } from '../src/probe.mjs'

const PC_TRACK_V2 = 'https://api.qishui.com/luna/pc/track_v2'
const SEO_TRACK = 'https://beta-luna.douyin.com/luna/h5/seo_track'
const WEB_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

/** 客户端版本画像；UA 与 version_code 成对出现，拆开跑才知道谁在决定权益。 */
export const APP_PROFILES = {
    luna330: { version_name: '3.3.0', version_code: '30030000', user_agent: 'LunaPC/3.3.0(359450208)' },
    luna380: { version_name: '3.8.0', version_code: '30080000', user_agent: 'LunaPC/3.8.0(467160162)' },
}

/**
 * 设备身份形状。
 * - `ts`：libresoda 在配置为空时落到 URL 里的毫秒时间戳（13 位，每次都不一样）。
 * - `rand16`：本仓库 `randomDeviceId()` 的 16 位形状，每次运行换一个。
 * - `service`：本服务落盘的那一份身份（`data/identity.json`）。
 */
export function buildIdentity(shape, seed = {}) {
    if (shape === 'ts') {
        const now = seed.now ?? Date.now()
        const deviceId = String(now)
        return { deviceId, iid: String(now + 1), fp: deviceId, shape }
    }
    if (shape === 'rand16') {
        const deviceId = seed.deviceId || randomDeviceId()
        return { deviceId, iid: seed.iid || randomDeviceId(), fp: deviceId, shape }
    }
    if (shape === 'service') {
        return { deviceId: seed.deviceId, iid: seed.iid, fp: seed.fp, shape }
    }
    throw new Error(`未知设备身份形状：${shape}`)
}

/** 与 Go `url.QueryEscape` 一致：`A-Za-z0-9-_.~` 直通，空格转 `+`，其余 `%XX`。 */
export function queryEscape(value) {
    return encodeURIComponent(String(value))
        .replace(/%20/g, '+')
        .replace(/[!*'()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 与 libresoda `Params::encode` 一致：键按字典序排列后用 `&` 拼接。 */
export function encodeSortedParams(params) {
    return Object.entries(params)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${queryEscape(key)}=${queryEscape(value)}`)
        .join('&')
}

/** 公共查询参数；顺序与取值都照抄客户端，只有 identity / app 两处按 arm 替换。 */
export function buildPcTrackV2Request({ trackId, identity, app, localUser = '1', cookie = '' }) {
    const params = {
        ac: 'wifi',
        aid: '386088',
        app_name: 'luna_pc',
        build_mode: 'master',
        cdid: '',
        channel: 'official',
        device_id: identity.deviceId,
        device_platform: 'windows',
        device_type: 'Windows',
        fp: identity.fp,
        geo_region: 'cn',
        iid: identity.iid,
        network_carrier: '',
        os_region: 'cn',
        os_version: 'Windows 11',
        region: 'cn',
        resolution: '',
        sim_region: '',
        tz_name: 'Asia/Shanghai',
        version_code: app.version_code,
        version_name: app.version_name,
    }
    const body = JSON.stringify({
        track_id: String(trackId),
        media_type: 'track',
        queue_type: 'favorite_track_playlist',
        scene_name: 'library',
    })
    // 头部顺序照客户端实际发出的那一份；签名覆盖的必须就是发出去的这一份。
    const headers = [
        ['user-agent', app.user_agent],
        ['x-luna-background-type', 'foreground'],
        ['x-luna-is-background-req', '0'],
        ['x-luna-is-local-user', localUser],
        ['content-type', 'application/json; charset=utf-8'],
        ['x-ss-stub', crypto.createHash('md5').update(body).digest('hex').toUpperCase()],
    ]
    if (cookie) headers.push(['cookie', cookie])
    return { url: `${PC_TRACK_V2}?${encodeSortedParams(params)}`, params, body, headers }
}

/**
 * 实验矩阵。每条 arm 的 `changes` 就是它与 `good-ts` 基线之间唯一的不同，
 * `touches` 是这份不同落在请求上的字段，离线测试会逐条核对：
 * 任何一条 arm 只能动它声明过的字段，否则对照实验不成立。
 */
export const BASELINE = 'good-ts'
export const ARMS = [
    {
        name: 'good-ts',
        expect: '整曲（正对照：复刻本机播放器正在拿到整曲的那条请求）',
        changes: '身份=毫秒时间戳（每次不同）· 客户端 3.3.0 · local-user=1 · 带 Cookie',
        touches: [],
        arm: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'rand16',
        expect: '待定：只把身份换成一个全新的 16 位设备号',
        changes: '身份=全新随机 16 位（其余与 good-ts 相同）',
        touches: ['query.device_id', 'query.iid', 'query.fp'],
        arm: { identity: 'rand16', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'service-id',
        expect: '待定：复刻当初扫 7 首全试听时的那份身份',
        changes: '身份=服务落盘的固定 16 位（其余与 good-ts 相同）',
        touches: ['query.device_id', 'query.iid', 'query.fp'],
        arm: { identity: 'service', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'probe-shape',
        expect: '预期试听：现状 `node src/index.mjs probe` 的完整形状',
        changes: '身份=服务落盘 16 位 · 客户端 3.8.0 · local-user=0',
        touches: [
            'query.device_id',
            'query.iid',
            'query.fp',
            'query.version_name',
            'query.version_code',
            'header.user-agent',
            'header.x-luna-is-local-user',
        ],
        arm: { identity: 'service', app: APP_PROFILES.luna380, localUser: '0', useCookie: true },
    },
    {
        name: 'app380',
        expect: '待定：只把版本号/UA 推到 3.8.0，身份仍用时间戳',
        changes: '客户端 3.8.0（身份仍是时间戳）',
        touches: ['query.version_name', 'query.version_code', 'header.user-agent'],
        arm: { identity: 'ts', app: APP_PROFILES.luna380, localUser: '1', useCookie: true },
    },
    {
        name: 'localuser0',
        expect: '待定：只把 x-luna-is-local-user 从 1 改成 0',
        changes: 'local-user=0（身份仍是时间戳）',
        touches: ['header.x-luna-is-local-user'],
        arm: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '0', useCookie: true },
    },
    {
        name: 'no-cookie',
        expect: '预期试听（匿名对照：证明 Cookie 确实被服务端采纳）',
        changes: '不发 Cookie（其余与 good-ts 相同）',
        touches: ['header.cookie'],
        arm: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: false },
    },
    {
        name: 'sig-mismatch',
        expect: '预期空 body（签名失效对照：证明非空回包=签名被接受）',
        changes: '请求形状与基线逐字节相同，只是用另一个 16 位设备号签名',
        touches: [],
        arm: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: true, signWith: 'other16' },
    },
    {
        name: 'no-sign',
        expect: '预期空 body（无签名对照：证明前一条不是"根本不需要签名"）',
        changes: '请求形状与基线逐字节相同，只是不带 x-helios / x-medusa',
        touches: [],
        arm: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: true, skipSign: true },
    },
    {
        name: 'seo-web',
        expect: '免签名基线：曲目本身多长、试听多长、是否会员曲',
        changes: '不走签名，GET h5/seo_track',
        touches: ['(整条请求都不同：免签名的网页接口)'],
        arm: { seo: true },
    },
]

/** 只保留判定需要的标量，且永不输出 URL、token、cookie、设备号。 */
export function extractScalars(rawBody) {
    let payload
    try {
        payload = JSON.parse(String(rawBody || ''))
    } catch {
        return {}
    }
    const picked = {}
    const walk = (node, trail) => {
        if (!node || typeof node !== 'object' || trail.length > 4) return
        for (const [key, value] of Object.entries(node)) {
            const pathText = `${trail.join('.')}${trail.length ? '.' : ''}${key}`
            if (/url|token|sign|helios|medusa|cookie|auth|secret/i.test(key)) continue
            if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
                if (/status_code|error|message|code|duration|is_vip|vip|preview|tier|level/i.test(key)) {
                    picked[pathText] = typeof value === 'string' && value.length > 48 ? `${value.slice(0, 48)}…` : value
                }
                continue
            }
            walk(value, [...trail, key])
        }
    }
    walk(payload, [])
    return picked
}

/** cookie 只从本机读：`env` 取环境变量，`sodam` 取本机播放器配置，其余按文件路径读。 */
function readCookie(source) {
    const candidates = {
        env: () => (process.env.LIBMSSDK_COOKIE || '').trim(),
        sodam: () => {
            const root = process.env.APPDATA || path.join(process.env.HOME || '', '.config')
            return String(JSON.parse(fs.readFileSync(path.join(root, 'sodam', 'config.json'), 'utf8')).cookie || '').trim()
        },
    }
    if (candidates[source]) return candidates[source]()
    const text = fs.readFileSync(source, 'utf8').trim()
    return source.endsWith('.json') ? String(JSON.parse(text).cookie || '').trim() : text
}

function argValue(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/** init 之后有一个「短签名窗口」，所以每条 arm 都签两次、只用第二次的那一份。 */
function signWarmedUp(signer, { url, headers }, deviceId) {
    const pairs = Object.fromEntries(headers)
    signer.sign({ url, headers: pairs, deviceId })
    return signer.sign({ url, headers: pairs, deviceId })
}

async function runArm(arm, context) {
    const base = {
        arm: arm.name,
        expect: arm.expect,
        changes: arm.changes,
    }
    if (arm.arm.seo) {
        const url = `${SEO_TRACK}?${encodeSortedParams({ track_id: context.trackId, device_platform: 'web' })}`
        const response = await fetch(url, {
            headers: [['user-agent', WEB_UA]],
            signal: AbortSignal.timeout(context.timeoutMs),
        })
        const text = await response.text()
        return {
            ...base,
            http: response.status,
            bodyBytes: text.length,
            ...summarizeTrackV2Response(text, context.trackId),
            ...extractScalars(text),
        }
    }

    const seed =
        arm.arm.identity === 'service'
            ? { deviceId: context.service.deviceId, iid: context.service.iid, fp: context.service.fp }
            : {}
    const identity = buildIdentity(arm.arm.identity, seed)
    const signDevice = arm.arm.signWith === 'other16' ? randomDeviceId() : identity.deviceId
    const spec = buildPcTrackV2Request({
        trackId: context.trackId,
        identity,
        app: arm.arm.app,
        localUser: arm.arm.localUser,
        cookie: arm.arm.useCookie ? context.cookie : '',
    })
    const signed = arm.arm.skipSign ? { headers: {}, deviceId: identity.deviceId } : signWarmedUp(context.signer, spec, signDevice)
    const response = await fetch(spec.url, {
        method: 'POST',
        headers: [...spec.headers, ...Object.entries(signed.headers)],
        body: spec.body,
        signal: AbortSignal.timeout(context.timeoutMs),
    })
    const text = await response.text()
    return {
        ...base,
        http: response.status,
        signed: !arm.arm.skipSign,
        identityShape: identity.shape,
        deviceId: maskDeviceId(identity.deviceId),
        signDeviceId: maskDeviceId(signDevice),
        signedHeaders: Object.keys(signed.headers).length,
        signatureLengths: Object.fromEntries(
            Object.entries(signed.headers).map(([name, value]) => [name.toLowerCase(), String(value).length]),
        ),
        bodyBytes: text.length,
        ...summarizeTrackV2Response(text, context.trackId),
        ...extractScalars(text),
    }
}

async function main() {
    const only = argValue('arm')
    const trackId = argValue('track') || process.env.LIBMSSDK_PROBE_TRACK_ID || ''
    const repeat = Number(argValue('repeat') || 1)
    const cookieSource = argValue('cookie-from') || (process.env.LIBMSSDK_COOKIE ? 'env' : 'sodam')
    if (process.argv.includes('--list')) {
        process.stdout.write(`${JSON.stringify(ARMS.map(({ name, expect, changes }) => ({ name, expect, changes })), null, 2)}\n`)
        return
    }
    const arms = only ? ARMS.filter(item => item.name === only) : ARMS
    if (!arms.length) throw new Error(`未知 arm：${only}（可选：${ARMS.map(item => item.name).join(' / ')}）`)
    if (!trackId) throw new Error('需要 --track <track_id>（或 --list）')

    const config = loadConfig()
    const cookie = readCookie(cookieSource)
    if (!cookie) process.stderr.write('警告：没读到 cookie，带 Cookie 的 arm 会退化成匿名\n')
    const signer = new BdmsSigner({ modulePath: config.bdmsModule, deviceId: config.deviceId })
    const context = {
        trackId,
        cookie,
        timeoutMs: config.requestTimeoutMs,
        service: { deviceId: config.deviceId, iid: config.iid, fp: config.fp },
        signer,
    }

    process.stderr.write(
        `签名器：${path.basename(config.bdmsModule || '(无)')}｜本机身份：${maskDeviceId(config.deviceId)}｜` +
            `cookie：${cookie ? `${cookie.split(';').length} 个字段` : '无'}｜曲目：${trackId}\n`,
    )
    const rows = []
    for (let round = 0; round < repeat; round += 1) {
        for (const arm of arms) {
            const row = await runArm(arm, context)
            rows.push({ round: round + 1, ...row })
            process.stdout.write(`${JSON.stringify(row)}\n`)
        }
    }
    const verdict = rows.map(row => ({
        arm: row.arm,
        round: row.round,
        http: row.http,
        bytes: row.bodyBytes,
        fullTrack: row.fullTrack ?? null,
        trackSeconds: row.trackDurationSeconds ?? null,
        streamSeconds: row.streamDurationSeconds ?? null,
        gears: (row.gears || []).map(gear => gear.quality || gear.gear).join(','),
    }))
    process.stdout.write(`${JSON.stringify({ verdict }, null, 2)}\n`)
    if (!rows.some(row => row.ok)) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`${String(error?.message || error)}\n`)
        process.exitCode = 2
    })
}
