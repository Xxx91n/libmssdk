// 分发器：主进程独占监听、解析 HTTP、持有队列与等待预算；计算全部交给 worker。
//
// 为什么要拆开：一次签名要阻塞一百到几百毫秒并吃满一个核，期间那个进程什么都做不了 ——
// 包括「读自己的时钟」。拆开之后主进程的事件循环一直是空的，它才可能计时、才可能在超出
// 等待预算时回那个 503。
//
// 这一票只建路径，不接线：默认仍走 src/server.mjs 那条老路（切线是 #7）。
//
// 不传 socket 句柄：Node 现行文档写明不支持在 Windows 上发送 IPC socket，Windows 上逐连接
// 句柄分发的问题多年未修。这里转的是请求（上限沿用 256 KB）与响应（约 1 KB）的字节。

import http from 'node:http'
import { fork } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isAuthorized } from './auth.mjs'
import { maskDeviceId } from './config.mjs'
import { errorResponse, normalizeSignRequest, ValidationError } from './contract.mjs'
import { Queue, deriveWorkerCount, parsePositiveInt, shouldReject } from './dispatch.mjs'
import { ERROR_KINDS, failureResponse } from './errors.mjs'
import { logEvent } from './log.mjs'
import { createWorkerPool } from './workerpool.mjs'

/** 客户端超时约 6 秒，留余量：预算是「还在服务里等」的时间，不包含它自己那头的网络时间。 */
const DEFAULT_WAIT_BUDGET_MS = 5000

/** 全局队列上限：worker 数的几倍。超过就当场拒，而不是堆到大家一起超时。 */
const QUEUE_LIMIT_PER_WORKER = 4

/** 503 写完之后的宽限：让字节先出去，别让客户端在上传中途读到连接重置。 */
const CLOSE_GRACE_MS = 300

function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        request.on('data', chunk => {
            size += chunk.length
            if (size > limit) {
                reject(new ValidationError(`请求体超过 ${limit} 字节`))
                request.destroy()
                return
            }
            chunks.push(chunk)
        })
        request.on('end', () => resolve(Buffer.concat(chunks)))
        request.on('error', reject)
    })
}

/** 只留请求形状：路径、方法、头数量、体字节数、脱敏设备号。Cookie 与签名值一律不落盘。 */
function requestShape(spec, config) {
    return {
        path: String(spec.url).split('?')[0],
        method: spec.method,
        headers: Object.keys(spec.headers).length,
        bodyBytes: Buffer.byteLength(spec.body || ''),
        deviceId: maskDeviceId(spec.deviceId || config.deviceId),
    }
}

/**
 * 预拼好的 503：状态码、头、体在启动时就算完，热路径上不再 JSON.stringify。
 *
 * 拒绝发生在最忙的那一刻，所以这里能不干活就一点都不干。等待时长由 #4 的分类表说了算。
 */
function prebuildBusy() {
    const failure = failureResponse(ERROR_KINDS.BUSY, { message: '服务忙：没有空闲的签名槽位' })
    const body = Buffer.from(JSON.stringify(failure.body))
    return {
        status: failure.status,
        headers: {
            ...failure.headers,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(body.byteLength),
            Connection: 'close',
        },
        body,
    }
}

export function createDispatcher({
    config,
    pool,
    waitBudgetMs = DEFAULT_WAIT_BUDGET_MS,
    queueLimit = Math.max(1, pool.size * QUEUE_LIMIT_PER_WORKER),
    closeGraceMs = CLOSE_GRACE_MS,
    log = logEvent,
} = {}) {
    const queue = new Queue(queueLimit)
    const busy503 = prebuildBusy()

    /** 把预拼好的那份 503 写到这条连接上，写完隔一小段再关。 */
    function writeBusy(item, reason) {
        if (item.closed) return
        log('busy', {
            ...item.shape,
            reason,
            queuedMs: Date.now() - item.startedAt,
            depth: queue.depth,
            readyWorkers: pool.readyCount,
            waitBudgetMs,
        })
        const response = item.response
        response.writeHead(busy503.status, busy503.headers)
        response.end(busy503.body)
        const socket = response.socket
        if (socket && !socket.destroyed) {
            socket.setTimeout(closeGraceMs, () => socket.end())
        }
    }

    function writeFailure(item, failure) {
        if (item.closed) return
        log('sign-failed', { ...item.shape, code: failure.body.code, reason: failure.body.error })
        const body = JSON.stringify(failure.body)
        item.response.writeHead(failure.status, {
            ...failure.headers,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        })
        item.response.end(body)
    }

    function writeResult(item, slot, outcome) {
        if (item.closed) return
        log('sign', {
            ...item.shape,
            worker: slot.id,
            elapsedMs: Date.now() - item.startedAt,
            queuedMs: item.enqueuedAt - item.startedAt,
        })
        const body = JSON.stringify(outcome.body)
        item.response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        })
        item.response.end(body)
    }

    /** 派发给一台 worker。槽位在 worker 报告完成之前不回池，所以这里不留「超时重试」。 */
    function assign(item, slot) {
        slot.run(item.request).then(
            outcome => {
                if (outcome?.kind === ERROR_KINDS.SUCCESS) {
                    writeResult(item, slot, outcome)
                    return
                }
                writeFailure(
                    item,
                    failureResponse(outcome?.kind || ERROR_KINDS.INTERNAL_ERROR, {
                        message: outcome?.message || '签名失败',
                    }),
                )
            },
            error => {
                writeFailure(
                    item,
                    failureResponse(error?.kind || ERROR_KINDS.INTERNAL_ERROR, {
                        message: '签名进程在处理途中退出',
                    }),
                )
            },
        )
    }

    /** 有槽位空出来就清队列：先进先出，队头超预算之前它一直是队头。 */
    function drain() {
        while (queue.depth > 0) {
            const item = queue.peek()
            if (item.closed) {
                queue.shift()
                continue
            }
            const slot = pool.lease()
            if (!slot) return
            queue.shift()
            assign(item, slot)
        }
    }

    /** 定时器只做一件事：拿当前时刻去问那个纯函数，然后照答案执行。判断本身不在这里。 */
    function expireQueue() {
        const now = Date.now()
        for (;;) {
            const item = queue.peek()
            if (!item) return
            if (!shouldReject(item.enqueuedAt, now, waitBudgetMs)) return
            queue.shift()
            writeBusy(item, '超出等待预算')
        }
    }

    pool.on('available', drain)

    const server = http.createServer(async (request, response) => {
        const startedAt = Date.now()
        const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
        try {
            // 分发器只做签名这一件事：健康检查与诊断端点是 #9 的活，其余路由保持老的 404 形状
            if (request.method !== 'POST' || url.pathname !== '/sign') {
                const body = JSON.stringify(errorResponse('not found', 'not_found'))
                response.writeHead(404, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body),
                })
                response.end(body)
                return
            }
            if (!isAuthorized(request, config)) {
                const item = { response, closed: false, shape: { path: '/sign' } }
                response.on('close', () => {
                    item.closed = true
                })
                writeFailure(item, failureResponse(ERROR_KINDS.UNAUTHORIZED, { message: '缺少或错误的 Bearer Token' }))
                return
            }

            let spec
            try {
                const text = (await readBody(request, config.maxBodyBytes)).toString('utf8')
                spec = normalizeSignRequest(JSON.parse(text || '{}'))
            } catch (error) {
                // 非法 JSON、缺 url、体太长 —— 都是「改请求，别重试」
                const item = { response, closed: false, shape: { path: url.pathname } }
                response.on('close', () => {
                    item.closed = true
                })
                writeFailure(
                    item,
                    failureResponse(ERROR_KINDS.INVALID_REQUEST, {
                        message: error instanceof ValidationError ? error.message : '请求体不是合法 JSON',
                    }),
                )
                return
            }

            const item = {
                request: spec,
                response,
                startedAt,
                enqueuedAt: startedAt,
                closed: false,
                shape: requestShape(spec, config),
            }
            response.on('close', () => {
                item.closed = true
            })

            if (pool.blocker) {
                writeFailure(item, failureResponse(pool.blocker, { message: '签名模块没加载或配置错' }))
                return
            }
            if (pool.readyCount === 0) {
                // 一台都不就绪 = 整体拒绝流量：排队也排不到东西去做
                writeBusy(item, '没有就绪的 worker')
                return
            }
            const slot = pool.lease()
            if (slot) {
                assign(item, slot)
                return
            }
            if (!queue.push(item)) {
                writeBusy(item, '队列已满')
                return
            }
        } catch (error) {
            log('dispatcher-error', { message: String(error?.message || error), path: url.pathname })
            if (!response.headersSent && !response.writableEnded) {
                response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                response.end(JSON.stringify(failureResponse(ERROR_KINDS.INTERNAL_ERROR, { message: '内部错误' }).body))
            }
        }
    })

    // 扫描间隔跟着预算走：预算 50ms 的用例不该等一个 100ms 的节拍才看到超时。
    const sweepMs = Math.max(10, Math.min(100, Math.floor(waitBudgetMs / 4)))
    const sweeper = setInterval(expireQueue, sweepMs)
    sweeper.unref()
    server.on('close', () => clearInterval(sweeper))

    return server
}

const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url))

/** 真的拉一个 worker 进程。stdio 用继承：worker 自己的日志要落到容器日志里，不用再搭管道。 */
export function forkWorker(index, env = process.env) {
    return fork(WORKER_PATH, [], { env: { ...env, LIBMSSDK_WORKER_INDEX: String(index) } })
}

/**
 * 组装生产形态的分发器：算出 worker 数、把来由打进日志、建池子、建服务。
 *
 * 这一票还没人调它 —— 默认路径仍是 src/server.mjs，切线是 #7。端口由调用方 listen，
 * worker 在后台一台一台预热；一台都没就绪时服务回的是那个 503，不是「端口没人应」。
 */
export function startDispatcher({
    config,
    env = process.env,
    log = logEvent,
    spawn = forkWorker,
    onGiveUp = () => process.exit(1),
} = {}) {
    const parallelism = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
    const { count, reason } = deriveWorkerCount({
        bind: config.host,
        override: (env.LIBMSSDK_WORKERS || '').trim(),
        parallelism,
    })
    const waitBudgetMs = parsePositiveInt(env.LIBMSSDK_WAIT_BUDGET_MS, DEFAULT_WAIT_BUDGET_MS)
    const queueLimit = parsePositiveInt(env.LIBMSSDK_QUEUE_LIMIT, count * QUEUE_LIMIT_PER_WORKER)

    const pool = createWorkerPool({
        workerCount: count,
        spawn: index => spawn(index, env),
        log,
        onGiveUp,
        respawnBaseMs: parsePositiveInt(env.LIBMSSDK_WORKER_RESPAWN_BASE_MS, 1000),
        respawnCapMs: parsePositiveInt(env.LIBMSSDK_WORKER_RESPAWN_CAP_MS, 60_000),
    })
    // 实际值与来由都要说出来：绑定地址一变进程数就变，日志不写就等于让人猜。
    log('dispatcher', { workers: count, reason, waitBudgetMs, queueLimit, bind: config.host })

    const server = createDispatcher({ config, pool, waitBudgetMs, queueLimit, log })
    const started = pool.start().catch(error => log('dispatcher-start-failed', { message: String(error?.message || error) }))
    return { server, pool, started }
}
