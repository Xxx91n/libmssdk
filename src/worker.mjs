#!/usr/bin/env node
// worker：不监听端口、不解析 HTTP，只做「拿一份请求 → 调原生模块 → 把响应字节交回去」。
//
// 为什么要单独一个进程：一次签名要阻塞一百到几百毫秒并且吃满一个核，期间这个进程什么都不能做。
// 把它隔离出去，主进程的事件循环才一直是空的 —— 只有它空着，才能计时、才能在超预算时回那个 503。
//
// 身份：worker 只读身份文件（readStoredIdentity），这条路径上没有创建。多进程首次启动不该分裂
// 出两个设备号，那是主进程 fork 之前用独占创建收敛好的事（见 src/identity.mjs）。

import os from 'node:os'
import path from 'node:path'
import { BdmsSigner } from './bdms.mjs'
import { PROJECT_ROOT, resolveBdmsModule } from './config.mjs'
import { parsePositiveInt } from './dispatch.mjs'
import { signResponse } from './contract.mjs'
import { ERROR_KINDS } from './errors.mjs'
import { readStoredIdentity } from './identity.mjs'
import { logWarn, redactMachinePaths } from './log.mjs'
import { WARMUP_START, nextWarmup } from './warmup.mjs'

const env = key => (process.env[key] || '').trim()

/** worker 侧的设备身份：环境变量钉死 > 身份文件里那一份。读不到就是没有，绝不代替主进程去建。 */
function workerIdentity() {
    const pinned = env('LIBMSSDK_DEVICE_ID') || env('QISHUI_DEVICE_ID')
    if (pinned) return { deviceId: pinned, iid: '', fp: pinned }
    const stored = readStoredIdentity()
    return {
        deviceId: stored?.device_id || '',
        iid: stored?.iid || '',
        fp: stored?.fp || stored?.device_id || '',
    }
}

/**
 * 预热探针：每次都用同一份输入。
 *
 * 只有输入固定，「这一轮输出和上一轮一样长吗」才只反映原生模块自己的状态；探针里放随机数
 * （比如官方那个 trace_id）会把噪声读成「还没稳」。
 */
function warmupProbe(deviceId) {
    return {
        url: `https://api.qishui.com/luna/pc/track_v2?aid=386088&app_name=luna_pc&device_id=${deviceId}&fp=${deviceId}`,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'user-agent': 'LunaPC/warmup',
        },
        deviceId,
    }
}

function send(message) {
    if (!process.send) return
    process.send(message)
}

/**
 * 部署者机器上的路径候选：报错原文里可能出现的不止 modulePath 一个 —— require 失败还会带上
 * 依赖所在的目录，容器里还常有 cwd 与 home 的短形。
 */
function machinePaths(modulePath) {
    return [modulePath, path.dirname(modulePath), PROJECT_ROOT, process.cwd(), os.homedir()].filter(Boolean)
}

/**
 * 报错文本要能进日志也能回给调用方，所以先过一遍本机路径脱敏。
 */
function describeError(error, modulePath) {
    const text = String(error?.message || error || '未知错误')
    return redactMachinePaths(text, machinePaths(modulePath)).slice(0, 200)
}

/**
 * 自学习预热：循环调用探针，直到连续几次输出的长度彼此相同。
 *
 * 判据里没有、也不该有任何绝对长度数字 —— 换一个客户端版本的原生模块，稳态长度就可能变，
 * 写死的那台机器会永远停在「没就绪」。这里也不 sleep：签一次本身就要一百多毫秒，循环本身就是节奏。
 */
function warmUp(signer, probe, budgetMs) {
    const deadline = Date.now() + budgetMs
    let state = WARMUP_START
    for (;;) {
        let values = []
        try {
            values = Object.values(signer.sign(probe).headers)
        } catch (error) {
            // 算不出来就当成一份不合格的采样：长度轨迹被打断，计数从零开始
            logWarn('warmup-sign', { level: 'warn', message: describeError(error, signer.modulePath) })
        }
        const step = nextWarmup(state, values)
        state = step.state
        if (step.ready) return { ready: true }
        if (Date.now() >= deadline) return { ready: false, samples: state.streak }
    }
}

function handleTask(signer, message) {
    const request = message.request || {}
    const startedAt = Date.now()
    try {
        const signed = signer.sign({
            url: request.url,
            headers: request.headers || {},
            deviceId: request.deviceId || '',
        })
        send({
            type: 'result',
            id: message.id,
            kind: ERROR_KINDS.SUCCESS,
            // elapsed_ms 是这一次计算的耗时：契约里这个字段本来就说的是算签名花了多久
            body: signResponse({ ...signed, elapsedMs: Date.now() - startedAt }),
        })
    } catch (error) {
        // 这里只可能是「模块算完了但东西不对」（缺 X-Helios / 抛异常）：按内部算错收口。
        // 请求合法性在主进程就判过了，配置错在启动时就报过了，两条路都不到这里。
        send({
            type: 'result',
            id: message.id,
            kind: ERROR_KINDS.INTERNAL_ERROR,
            message: describeError(error, signer.modulePath),
        })
    }
}

function main() {
    const identity = workerIdentity()
    const modulePath = resolveBdmsModule()
    const signer = new BdmsSigner({ modulePath, deviceId: identity.deviceId })

    // 起不来的原因先说清楚，别让「配置错了」被分发器读成「还在预热，等等就好」。
    const blockers = []
    if (!signer.available) blockers.push('bdms.node 没配置或文件不存在')
    if (!identity.deviceId) blockers.push('身份文件里没有可读的设备号')
    if (blockers.length === 0) {
        try {
            signer.load()
        } catch (error) {
            blockers.push(describeError(error, modulePath))
        }
    }
    if (blockers.length > 0) {
        send({ type: 'warmup-failed', kind: ERROR_KINDS.SIGNER_UNAVAILABLE, reason: blockers.join('；') })
        // 进程不退：这台不算进「能服务」，别的 worker 照常干活。
    } else {
        const budgetMs = parsePositiveInt(env('LIBMSSDK_WARMUP_BUDGET_MS'), 30_000)
        const warmup = warmUp(signer, warmupProbe(identity.deviceId), budgetMs)
        if (warmup.ready) send({ type: 'ready' })
        // 预算内没收敛：保持未就绪、进程不退。原因写清楚，别让主进程只剩一个数字
        else send({ type: 'warmup-failed', kind: ERROR_KINDS.INTERNAL_ERROR, reason: `预热 ${budgetMs}ms 内输出长度没收敛` })
    }

    process.on('message', message => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'shutdown') {
            process.exit(0)
        }
        if (message.type === 'sign') {
            handleTask(signer, message)
            return
        }
        // 认不出的东西不动状态：worker 的状态机只由自己推进
    })
}

main()
