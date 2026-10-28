// 错误分类：按「调用方下一步做什么」切开失败，而不是按内部异常命名。
//
// 只有两类失败是「等一会儿会好」——被限流、服务忙；其余都必须有人改请求或改机器，
// 所以只有它们带等待时长。502（网关收到无效上游响应）在这里不成立：本进程既不是
// 网关也没有上游，任何情况都不落到它。
//
// 时间不做成接缝：需要当前时刻的地方把它当参数传进纯函数，定时器只负责用当前时间去调。

/** 原因码是稳定字符串：同一个失败永远是同一个码；动态信息放平级扩展字段。 */
export const ERROR_KINDS = {
    SUCCESS: 'SUCCESS',
    INVALID_REQUEST: 'INVALID_REQUEST',
    UNAUTHORIZED: 'UNAUTHORIZED',
    RATE_LIMITED: 'RATE_LIMITED',
    BUSY: 'BUSY',
    SIGNER_UNAVAILABLE: 'SIGNER_UNAVAILABLE',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
}

/** 服务忙固定等多久（秒）：槽位自己会腾出来，不需要调用方算。 */
export const BUSY_RETRY_AFTER_SECONDS = 1

/** 拿不到「下次可请求时刻」时的兜底，也是契约规定的最小值。 */
const MIN_RETRY_AFTER_SECONDS = 1

const WAIT_NONE = 'none'
const WAIT_FIXED = 'fixed'
/** 等待时长由限流器算出的精确时刻决定。 */
const WAIT_FROM_CALLER = 'caller'

const TABLE = {
    [ERROR_KINDS.SUCCESS]: { status: 200, code: null, wait: WAIT_NONE },
    [ERROR_KINDS.INVALID_REQUEST]: { status: 400, code: ERROR_KINDS.INVALID_REQUEST, wait: WAIT_NONE },
    [ERROR_KINDS.UNAUTHORIZED]: { status: 401, code: ERROR_KINDS.UNAUTHORIZED, wait: WAIT_NONE },
    [ERROR_KINDS.RATE_LIMITED]: { status: 429, code: ERROR_KINDS.RATE_LIMITED, wait: WAIT_FROM_CALLER },
    [ERROR_KINDS.BUSY]: { status: 503, code: ERROR_KINDS.BUSY, wait: WAIT_FIXED },
    [ERROR_KINDS.SIGNER_UNAVAILABLE]: { status: 500, code: ERROR_KINDS.SIGNER_UNAVAILABLE, wait: WAIT_NONE },
    // 认不出来的原因一律按「必须有人来修」处理：不催调用方重试，也不冒充能重试。
    default: { status: 500, code: ERROR_KINDS.INTERNAL_ERROR, wait: WAIT_NONE },
}

/**
 * 下次可请求的精确时刻 → 整数秒：向上取整、最少 1 秒。
 *
 * 限流器拒绝时天然知道这个时刻，正好就是 `Retry-After` 要的数。
 */
export function retryAfterFromInstant(retryAtMs, nowMs = Date.now()) {
    const waitMs = Number(retryAtMs) - Number(nowMs)
    if (!Number.isFinite(waitMs)) return MIN_RETRY_AFTER_SECONDS
    return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(waitMs / 1000))
}

/** 分类一个失败：状态码、稳定原因码、以及有没有等待时长。 */
export function classify(kind, { retryAtMs, nowMs = Date.now() } = {}) {
    const entry = TABLE[kind] || TABLE.default
    let retryAfterSeconds = null
    if (entry.wait === WAIT_FIXED) retryAfterSeconds = BUSY_RETRY_AFTER_SECONDS
    else if (entry.wait === WAIT_FROM_CALLER) retryAfterSeconds = retryAfterFromInstant(retryAtMs, nowMs)
    return { status: entry.status, code: entry.code, retryAfterSeconds }
}

/**
 * 一次失败的完整回包形状。
 *
 * 等待时长在响应头与响应体各写一份：头是中间件唯一能读到的地方，体是客户端
 * 拿不到头时的兜底，两处必须是同一个整数。
 *
 * @param kind 见 {@link ERROR_KINDS}
 * @param message 人读的失败原因
 * @param details 平级扩展字段（哪个参数错了之类），客户端可以忽略不认识的东西
 */
export function failureResponse(kind, { message, details, retryAtMs, nowMs = Date.now() } = {}) {
    const { status, code, retryAfterSeconds } = classify(kind, { retryAtMs, nowMs })
    const body = { ...details, ok: false, error: message == null ? code : String(message), code }
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (retryAfterSeconds !== null) {
        body.retry_after_seconds = retryAfterSeconds
        headers['Retry-After'] = String(retryAfterSeconds)
    }
    return { status, headers, body }
}
