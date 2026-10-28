#!/usr/bin/env node
// 手动验证「Docker + Wine 下多个进程各自加载同一份 bdms.node 能不能同时工作」（#6）。
//
// 控制面在 driver 里：docker = 真环境（一个容器、同一 WINEPREFIX、两个 serve）；
// mock = 本机彩排（仓库自带的 mock 签名模块 + 假上游），在没有 Wine、没有凭据的机器上
// 验证判据流水线、三种失败形态的判定和输出脱敏本身。
//
// 判据只取外部可见事实：进程在不在、签名出不出、上游接不接受、杀掉一个后另一个还服不服务。
// 需要用户自备的原生模块与真实凭据，所以不进 npm test、不进 CI。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { maskDeviceId } from '../../src/config.mjs'
import { buildTrackV2Request, summarizeTrackV2Response } from '../../src/probe.mjs'
import { createDockerDriver } from './driver-docker.mjs'
import { createMockDriver, SCENARIOS } from './driver-mock.mjs'

const SHAPES = {
    processStart: '进程起不来',
    upstreamRejected: '签名能出但上游不接受',
    prefixContention: '一个进程把共享 prefix 拖垮',
    unclassified: '说不清（原始证据见 failures）',
}

const CRITERIA = [
    ['bothSign', '判据 1 两个进程同时签名'],
    ['upstreamOnce', '判据 2 各自签的头各打一次上游'],
    ['rounds', '判据 3 连打多轮'],
    ['survivor', '判据 4 杀掉一个后另一个继续服务'],
    ['identity', '判据 5 两个进程共用同一份身份'],
    ['logHygiene', '判据 6 服务日志与本输出不含敏感值'],
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseArgs(argv) {
    const values = {}
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index]
        if (!token.startsWith('--')) continue
        const key = token.slice(2)
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
            values[key] = true
            continue
        }
        values[key] = next
        index += 1
    }
    return values
}

const args = parseArgs(process.argv.slice(2))
const mode = args.mode || 'docker'
const scenario = args.scenario || 'ok'
if (mode !== 'docker' && mode !== 'mock') {
    console.log(`[verify] 未知 --mode：${mode}（可用：docker / mock）`)
    process.exit(3)
}
if (scenario !== 'ok' && mode !== 'mock') {
    console.log('[verify] --scenario 只在 mock 彩排模式下有效：真环境不做故障注入，只如实记录观察到的形态。')
    process.exit(3)
}
if (mode === 'mock' && !SCENARIOS.includes(scenario)) {
    console.log(`[verify] 未知 --scenario：${scenario}（可用：${SCENARIOS.join(' / ')}）`)
    process.exit(3)
}

const cookie =
    String(process.env.LIBMSSDK_COOKIE || '').trim() ||
    (mode === 'mock' ? `verify-mock-cookie-${crypto.randomBytes(12).toString('hex')}` : '')
const trackId = String(args.track || process.env.LIBMSSDK_VERIFY_TRACK_ID || (mode === 'mock' ? '1000000000000000001' : '')).trim()
const rounds = Number(args.rounds || (mode === 'mock' ? 3 : 10))
const readyTimeoutMs = Number(args['ready-timeout-ms'] || (mode === 'mock' ? 20000 : 180000))
const signTimeoutMs = Number(args['sign-timeout-ms'] || (mode === 'mock' ? 15000 : 60000))
const upstreamTimeoutMs = Number(args['upstream-timeout-ms'] || 15000)
const outDir = args.out || path.join(import.meta.dirname, 'results')

/** 输出脱敏：登记过的敏感值不允许出现在控制台行或结果文件里，命中即记一条泄漏并替换。 */
class Redactor {
    #forbidden = []
    leaks = []

    forbid(value, kind) {
        const text = String(value || '')
        if (text.length >= 4 && !this.#forbidden.some(item => item.text === text)) this.#forbidden.push({ text, kind })
    }

    sanitize(where, text) {
        let output = String(text ?? '')
        for (const item of this.#forbidden) {
            if (!output.includes(item.text)) continue
            this.leaks.push({ where, kind: item.kind })
            output = output.split(item.text).join(`<已脱敏:${item.kind}>`)
        }
        return output
    }

    /** 只查不改：用来扫服务自己的日志里有没有出现过敏感值。 */
    find(text) {
        const kinds = new Set()
        for (const item of this.#forbidden) if (String(text || '').includes(item.text)) kinds.add(item.kind)
        return [...kinds]
    }

    /** 这次实际登记了哪些类别的敏感值。 */
    kinds() {
        return [...new Set(this.#forbidden.map(item => item.kind))]
    }
}

const redactor = new Redactor()
if (cookie) redactor.forbid(cookie, 'cookie')

const say = (...parts) => process.stdout.write(`${redactor.sanitize('console', parts.join(' '))}\n`)

const driver =
    mode === 'mock'
        ? createMockDriver({ scenario, cookie })
        : createDockerDriver({
              container: args.container || 'libmssdk-verify-wine',
              containerPorts: (args['container-ports'] || '8899,8900').split(',').map(Number),
              hostPorts: (args['host-ports'] || '18899,18900').split(',').map(Number),
          })

const report = {
    schema: 'libmssdk-verify-wine-multi/1',
    issue: 'sodahub-org/libmssdk#6',
    mode,
    scenario,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    environment: {},
    processes: [],
    identity: {},
    criteria: {},
    tally: {
        signAttempts: 0,
        signFailures: 0,
        upstreamAttempts: 0,
        upstreamFailures: 0,
        shapes: { processStart: 0, upstreamRejected: 0, prefixContention: 0, unclassified: 0 },
    },
    observations: {},
    failures: [],
    verdict: '',
    redaction: { forbidden: [], leaks: 0 },
}

function phaseFailed(phase) {
    return report.failures.some(failure => failure.phase === phase)
}

function recordFailure(phase, portIndex, shape, detail) {
    report.tally.shapes[shape] += 1
    const safe = redactor.sanitize('failure', detail)
    report.failures.push({ phase, port: driver.hostPorts[portIndex], shape, detail: safe })
    say(`[verify]   失败：端口 ${driver.hostPorts[portIndex]} — ${SHAPES[shape]}（${safe}）`)
}

/** 把一次「签不出 / 打不通」归到三种形态之一。 */
async function classifyUnavailable(portIndex, { hung, simultaneousFailures, phase }) {
    if (!(await driver.pidAlive(portIndex))) return 'processStart'
    if (phase === 'survivor') return 'prefixContention'
    if (simultaneousFailures >= 2) return 'prefixContention'
    return hung ? 'unclassified' : 'processStart'
}

/** 一次 /sign：只留长度与脱敏设备号，签名值当场登记为敏感后丢弃。 */
async function signOn(portIndex, { url, method = 'POST', body = '', headers, deviceId }) {
    const started = Date.now()
    report.tally.signAttempts += 1
    try {
        const response = await fetch(`http://127.0.0.1:${driver.hostPorts[portIndex]}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url, method, body, headers, device_id: deviceId }),
            signal: AbortSignal.timeout(signTimeoutMs),
        })
        const text = await response.text()
        if (response.status !== 200) throw new Error(`/sign HTTP ${response.status}: ${text.slice(0, 160)}`)
        const payload = JSON.parse(text)
        const signed = payload.headers || {}
        for (const value of Object.values(signed)) redactor.forbid(value, 'signature')
        redactor.forbid(payload.device_id, 'device_id')
        return {
            elapsedMs: Date.now() - started,
            lengths: { helios: String(signed['X-Helios'] || '').length, medusa: String(signed['X-Medusa'] || '').length },
            deviceIdMasked: maskDeviceId(payload.device_id || deviceId),
            headers: signed,
        }
    } catch (error) {
        report.tally.signFailures += 1
        throw error
    }
}

function isHang(error) {
    const name = String(error?.name || '')
    const message = String(error?.message || '')
    const cause = String(error?.cause?.code || error?.cause?.message || '')
    return name === 'TimeoutError' || message.includes('timeout') || cause.includes('ETIMEDOUT')
}

/** 签一次名并真的打一次上游；签名头里就是发出去的那一份。 */
async function upstreamWithSignature(portIndex, device) {
    const spec = buildTrackV2Request({ trackId, deviceId: device.deviceId, iid: device.iid, fp: device.fp, cookie })
    if (driver.upstreamOrigin) {
        const target = new URL(driver.upstreamOrigin)
        const parsed = new URL(spec.url)
        parsed.protocol = target.protocol
        parsed.host = target.host
        spec.url = parsed.toString()
    }
    const signed = await signOn(portIndex, { url: spec.url, method: spec.method, body: spec.body, headers: spec.headers, deviceId: device.deviceId })
    report.tally.upstreamAttempts += 1
    let response
    let text
    try {
        response = await fetch(spec.url, {
            method: 'POST',
            headers: { ...spec.headers, ...signed.headers },
            body: spec.body,
            signal: AbortSignal.timeout(upstreamTimeoutMs),
        })
        text = await response.text()
    } catch (error) {
        report.tally.upstreamFailures += 1
        throw error
    }
    const summary = summarizeTrackV2Response(text, trackId)
    if (!summary.accepted) report.tally.upstreamFailures += 1
    return {
        sign: signed,
        upstream: {
            http: response.status,
            bodyBytes: summary.bodyBytes || text.length,
            accepted: Boolean(summary.accepted),
            fullTrack: Boolean(summary.fullTrack),
            durations: { track: summary.trackDurationSeconds || 0, stream: summary.streamDurationSeconds || 0 },
        },
    }
}

async function main() {
    say(`[verify] 模式 ${mode}${scenario === 'ok' ? '' : ` / 注入场景 ${scenario}（彩排，不是真环境结论）`} — 起控制面…`)
    await driver.start()
    report.processes = await driver.processes()
    report.environment = await driver.environment()
    say(`[verify] 环境：${report.environment.summary}`)

    const identityText = await driver.readIdentityFile()
    if (!identityText) {
        report.verdict = 'INCOMPLETE'
        report.criteria.identity = { status: 'BLOCKED', reason: '读不到共享身份文件' }
        say('[verify] 读不到共享身份文件（两个 serve 的 LIBMSSDK_STATE_DIR 下应有 identity.json），验证无法继续。')
        return
    }
    let identity
    try {
        identity = JSON.parse(identityText)
    } catch (error) {
        report.verdict = 'INCOMPLETE'
        say(`[verify] 身份文件不是合法 JSON：${redactor.sanitize('console', error.message)}`)
        return
    }
    for (const key of ['device_id', 'iid', 'fp']) redactor.forbid(identity[key], key)
    const device = { deviceId: identity.device_id, iid: identity.iid, fp: identity.fp }
    report.identity = { deviceIdMasked: maskDeviceId(identity.device_id), hasIid: Boolean(identity.iid), hasFp: Boolean(identity.fp) }
    say(`[verify] 共享身份 device_id=${maskDeviceId(identity.device_id)}（只以脱敏形式出现）`)

    // ——— 就绪：进程起没起来，是三种形态的第一种 ———
    const notReady = await driver.waitForReady(readyTimeoutMs)
    if (notReady.length) {
        for (const entry of notReady) {
            const stderr = await driver.stderrOf(entry.index)
            const shape = await classifyUnavailable(entry.index, { hung: entry.lastErrorKind !== 'refused', simultaneousFailures: notReady.length, phase: 'ready' })
            recordFailure('ready', entry.index, shape, `就绪超时（${entry.lastErrorKind}）；stderr ${stderr.bytes} 字节`)
        }
        report.criteria.bothSign = { status: 'FAIL', reason: '不是所有进程都就绪', portsNotReady: notReady.map(entry => driver.hostPorts[entry.index]) }
        report.observations.stderrEvidence = await Promise.all(
            driver.hostPorts.map(async (_, index) => ({ port: driver.hostPorts[index], stderr: await driver.stderrOf(index) })),
        )
        report.verdict = 'FAIL'
        say('[verify] 判据 1 失败：有进程没起来，后续判据没有意义。')
        printConclusion()
        return
    }
    say(`[verify] ${driver.hostPorts.length} 个进程都就绪（/healthz 200）`)

    // ——— 判据 1：两个进程同时签名（不带 cookie 的中性请求）———
    const plainSpec = {
        url: `https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=${device.deviceId}&fp=${device.fp}`,
        headers: { 'user-agent': 'LunaPC/verify', 'content-type': 'application/json' },
        deviceId: device.deviceId,
    }
    const signResults = await Promise.allSettled(
        driver.hostPorts.map(async (_, index) => {
            const signed = await signOn(index, plainSpec)
            return { port: driver.hostPorts[index], elapsedMs: signed.elapsedMs, lengths: signed.lengths, deviceIdMasked: signed.deviceIdMasked }
        }),
    )
    const signFailures = signResults.map((item, index) => ({ item, index })).filter(entry => entry.item.status === 'rejected')
    for (const { item, index } of signFailures) {
        const detail = String(item.reason?.message || item.reason)
        const shape = await classifyUnavailable(index, { hung: isHang(item.reason), simultaneousFailures: signFailures.length, phase: 'bothSign' })
        recordFailure('bothSign', index, shape, detail)
    }
    report.criteria.bothSign = {
        status: signFailures.length ? 'FAIL' : 'PASS',
        samples: signResults.flatMap(item => (item.status === 'fulfilled' ? [item.value] : [])),
        stderrBytes: await Promise.all(driver.hostPorts.map(async (_, index) => (await driver.stderrOf(index)).bytes)),
    }
    say(`[verify] 判据 1 ${report.criteria.bothSign.status}：${signResults.length - signFailures.length}/${signResults.length} 出签名`)

    // ——— 判据 5：两个进程读到同一份身份 ———
    const healthMasks = []
    for (let index = 0; index < driver.hostPorts.length; index += 1) healthMasks.push((await driver.healthz(index))?.deviceId || '')
    const expectedMask = maskDeviceId(device.deviceId)
    const identityConsistent = healthMasks.every(mask => mask && mask === expectedMask)
    report.criteria.identity = {
        status: identityConsistent ? 'PASS' : 'FAIL',
        expected: expectedMask,
        perProcess: driver.hostPorts.map((port, index) => ({ port, deviceId: healthMasks[index] })),
        note: identityConsistent
            ? '两个进程读到的身份一致'
            : '两个进程身份不一致：device_id 分裂属 #2 的范围；本验证在起进程前已落盘身份，正常不该出现',
    }
    if (!identityConsistent) recordFailure('identity', 0, 'unclassified', '各进程 /healthz 报告的脱敏设备号不一致')

    // ——— 判据 2：各自签的头各打一次真实上游 ———
    const hasUpstream = Boolean(cookie && trackId)
    if (!hasUpstream) {
        report.criteria.upstreamOnce = { status: 'SKIPPED', reason: '缺少 LIBMSSDK_COOKIE 或 --track，不打真实上游' }
        say('[verify] 判据 2 跳过：没有 cookie 或 track_id。判据 3 退化为只连打签名。')
    } else {
        say('[verify] 判据 2：两边各自签的头各打一次上游')
        const upstreamResults = await Promise.allSettled(driver.hostPorts.map((_, index) => upstreamWithSignature(index, device)))
        const rows = []
        for (const [index, item] of upstreamResults.entries()) {
            if (item.status === 'rejected') {
                const detail = String(item.reason?.message || item.reason)
                const shape = detail.includes('/sign')
                    ? await classifyUnavailable(index, { hung: isHang(item.reason), simultaneousFailures: 1, phase: 'upstreamOnce' })
                    : 'unclassified'
                recordFailure('upstreamOnce', index, shape, detail)
                continue
            }
            const { sign, upstream } = item.value
            rows.push({ port: driver.hostPorts[index], ...upstream, signMs: sign.elapsedMs, medusaLength: sign.lengths.medusa })
            if (!upstream.accepted) recordFailure('upstreamOnce', index, 'upstreamRejected', `HTTP ${upstream.http}，回包 ${upstream.bodyBytes} 字节`)
        }
        const passed = rows.length === driver.hostPorts.length && rows.every(row => row.accepted)
        report.criteria.upstreamOnce = { status: passed ? 'PASS' : 'FAIL', rows }
        say(`[verify] 判据 2 ${report.criteria.upstreamOnce.status}：${rows.map(row => `${row.port}→HTTP ${row.http}/${row.bodyBytes}B`).join(' ')}`)
        report.observations.fullTrackNote =
            'fullTrack 只作观察：整曲还是试听取决于账号权益与设备身份（见 #10），不是多进程判据；本票的判据是「上游接不接受这份签名」。'
    }

    // ——— 判据 3：连打多轮 ———
    say(`[verify] 判据 3：连打 ${rounds} 轮（${hasUpstream ? '每轮两边各签 + 各打一次上游' : '每轮两边各签一次'}）`)
    const tally = { rounds, signAttempts: 0, signFailures: 0, upstreamAttempts: 0, upstreamFailures: 0, samples: [] }
    for (let round = 1; round <= rounds; round += 1) {
        const outcomes = await Promise.allSettled(
            driver.hostPorts.map(async (_, index) => {
                if (!hasUpstream) {
                    const signed = await signOn(index, plainSpec)
                    return { port: driver.hostPorts[index], sign: { ms: signed.elapsedMs, medusa: signed.lengths.medusa }, upstream: null }
                }
                const { sign, upstream } = await upstreamWithSignature(index, device)
                return { port: driver.hostPorts[index], sign: { ms: sign.elapsedMs, medusa: sign.lengths.medusa }, upstream }
            }),
        )
        const failureCount = outcomes.filter(item => item.status === 'rejected').length
        const row = { round }
        for (const [index, item] of outcomes.entries()) {
            const port = driver.hostPorts[index]
            tally.signAttempts += 1
            if (item.status === 'rejected') {
                const detail = String(item.reason?.message || item.reason)
                tally.signFailures += 1
                const shape = await classifyUnavailable(index, { hung: isHang(item.reason), simultaneousFailures: failureCount, phase: 'rounds' })
                recordFailure('rounds', index, shape, `第 ${round} 轮：${detail}`)
                row[port] = 'failed'
                continue
            }
            const sample = item.value
            if (sample.upstream) {
                tally.upstreamAttempts += 1
                if (!sample.upstream.accepted) {
                    tally.upstreamFailures += 1
                    recordFailure('rounds', index, 'upstreamRejected', `第 ${round} 轮：HTTP ${sample.upstream.http}，回包 ${sample.upstream.bodyBytes} 字节`)
                }
            }
            row[port] = { signMs: sample.sign.ms, medusa: sample.sign.medusa, http: sample.upstream?.http ?? null, accepted: sample.upstream?.accepted ?? null }
        }
        tally.samples.push(row)
        if (round === rounds || round % 5 === 0) say(`[verify]   第 ${round}/${rounds} 轮：${redactor.sanitize('console', JSON.stringify(row))}`)
    }
    const medusaLengths = new Set()
    for (const row of tally.samples) {
        for (const [key, value] of Object.entries(row)) if (key !== 'round' && value?.medusa) medusaLengths.add(value.medusa)
    }
    tally.medusaLengths = [...medusaLengths].sort((a, b) => a - b)
    tally.stderrBytes = {}
    for (const [index, port] of driver.hostPorts.entries()) tally.stderrBytes[port] = (await driver.stderrOf(index)).bytes
    tally.processes = await driver.processSnapshot()
    report.tally.rounds = tally
    report.criteria.rounds = {
        status: tally.signFailures === 0 && tally.upstreamFailures === 0 ? 'PASS' : 'FAIL',
        upstreamExecuted: hasUpstream,
        signAttempts: tally.signAttempts,
        signFailures: tally.signFailures,
        upstreamAttempts: tally.upstreamAttempts,
        upstreamFailures: tally.upstreamFailures,
        medusaLengths: tally.medusaLengths,
    }
    say(`[verify] 判据 3 ${report.criteria.rounds.status}：签名失败 ${tally.signFailures} / 上游未接受 ${tally.upstreamFailures}`)

    // ——— 判据 4：杀掉一个，另一个继续服务 ———
    const victimIndex = driver.hostPorts.length - 1
    const survivorIndex = 0
    say(`[verify] 判据 4：杀掉端口 ${driver.hostPorts[victimIndex]} 的进程，${driver.hostPorts[survivorIndex]} 应照常签名`)
    await driver.killProcess(victimIndex)
    await sleep(3000)
    report.observations.processesAfterKill = await driver.processSnapshot()
    const victimGone = !(await driver.pidAlive(victimIndex))
    let survivor
    try {
        const signed = await signOn(survivorIndex, plainSpec)
        survivor = { ok: true, lengths: signed.lengths, deviceIdMasked: signed.deviceIdMasked }
    } catch (error) {
        const detail = String(error?.message || error)
        const shape = await classifyUnavailable(survivorIndex, { hung: isHang(error), simultaneousFailures: 1, phase: 'survivor' })
        recordFailure('survivor', survivorIndex, shape, detail)
        survivor = { ok: false, hung: isHang(error) }
    }
    report.observations.victimGone = victimGone
    if (!victimGone) recordFailure('survivor', victimIndex, 'unclassified', '被杀的进程仍然存活，判据 4 的前提不成立')
    if (hasUpstream && survivor.ok) {
        try {
            const { upstream } = await upstreamWithSignature(survivorIndex, device)
            survivor.upstream = { http: upstream.http, bodyBytes: upstream.bodyBytes, accepted: upstream.accepted }
            if (!upstream.accepted) recordFailure('survivor', survivorIndex, 'upstreamRejected', `存活进程签出的头被打回：HTTP ${upstream.http}`)
        } catch (error) {
            recordFailure('survivor', survivorIndex, 'unclassified', `存活进程打上游失败：${String(error?.message || error)}`)
        }
    }
    report.criteria.survivor = {
        status: survivor.ok && victimGone && !phaseFailed('survivor') ? 'PASS' : 'FAIL',
        victimPort: driver.hostPorts[victimIndex],
        survivorPort: driver.hostPorts[survivorIndex],
        victimGone,
        survivor,
        survivorStderrBytes: (await driver.stderrOf(survivorIndex)).bytes,
    }
    say(`[verify] 判据 4 ${report.criteria.survivor.status}：存活方${survivor.ok ? '继续出签名' : '不再出签名'}`)

    // ——— 判据 6：服务自己的日志不该出现 cookie / 签名值 / 完整设备号 ———
    const leakedKinds = new Set()
    let scannedBytes = 0
    for (let index = 0; index < driver.hostPorts.length; index += 1) {
        const text = await driver.readLogText(index)
        scannedBytes += text.length
        for (const kind of redactor.find(text)) leakedKinds.add(kind)
    }
    report.criteria.logHygiene = { status: leakedKinds.size ? 'FAIL' : 'PASS', scannedBytes, leakedKinds: [...leakedKinds] }
    if (leakedKinds.size) recordFailure('logHygiene', 0, 'unclassified', `服务日志里出现了敏感值：${[...leakedKinds].join(', ')}`)
    say(`[verify] 判据 6 ${report.criteria.logHygiene.status}：扫了 ${scannedBytes} 字节 serve 日志`)

    printConclusion()
}

function printConclusion() {
    const rows = CRITERIA.map(([key, label]) => [label, report.criteria[key]?.status || 'NOT_RUN'])
    const failing = rows.filter(([, status]) => status === 'FAIL')
    const skipped = rows.filter(([, status]) => ['SKIPPED', 'BLOCKED', 'NOT_RUN'].includes(status))
    const shapeCounts = Object.entries(report.tally.shapes).filter(([, count]) => count > 0)
    report.verdict = failing.length ? 'FAIL' : skipped.length ? 'INCOMPLETE' : 'PASS'

    say('[verify] ============ 结论 ============')
    for (const [label, status] of rows) say(`[verify] ${label}：${status}`)
    say(`[verify] 环境：${report.environment.summary}`)
    say(
        `[verify] 计数：签名 ${report.tally.signAttempts} 次（失败 ${report.tally.signFailures}）/ 上游 ${report.tally.upstreamAttempts} 次（未接受 ${report.tally.upstreamFailures}）`,
    )
    say(`[verify] 失败形态：${shapeCounts.length ? shapeCounts.map(([shape, count]) => `${SHAPES[shape]} ${count}`).join(' / ') : '无'}`)
    if (report.observations.fullTrackNote) say(`[verify] 备注：${report.observations.fullTrackNote}`)
    say(`[verify] 结论：${{ PASS: '通过', FAIL: '失败', INCOMPLETE: '部分完成（有判据未执行）' }[report.verdict]}`)
}

try {
    await main()
} finally {
    await driver.teardown?.()
    report.finishedAt = new Date().toISOString()
    report.redaction = { forbidden: redactor.kinds(), leaks: redactor.leaks.length }
    const serialized = redactor.sanitize('report', `${JSON.stringify(report, null, 2)}\n`)
    if (redactor.leaks.length) {
        const kinds = [...new Set(redactor.leaks.map(item => item.kind))].join(', ')
        process.stdout.write(`[verify] 脱敏失败：输出里出现过敏感值（${kinds}），结果不写盘。\n`)
        process.exitCode = 1
    } else if (!report.verdict) {
        process.stdout.write('[verify] 未产出结论（提前异常退出），结果不写盘。\n')
        process.exitCode = 2
    } else {
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.join(outDir, `verify-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        fs.writeFileSync(file, serialized)
        say(`[verify] 结果写入 ${file}`)
        if (report.verdict === 'FAIL') process.exitCode = 1
        if (report.verdict === 'INCOMPLETE') process.exitCode = 2
    }
}
