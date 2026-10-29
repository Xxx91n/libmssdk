// 分发决策：只回答「现在该不该拒」「还能不能排」「下一个何时重生」这类问题。
//
// 时间不做成接缝 —— 每个判据都把当前时刻当参数收进来，所以同一组入参永远算出同一个答案，
// 测试不需要假时钟。真正的墙上时间只由分发器里的定时器读取，那里不含判断。

/**
 * 排队的请求是否已经超出等待预算。
 *
 * 预算「正好花完」就算超出：客户端的超时是从这一刻继续走的，再等就会把「等一会儿会好」
 * 变成「连接被客户端掐掉」。
 */
export function shouldReject(enqueuedAtMs, nowMs, budgetMs) {
    return nowMs - enqueuedAtMs >= budgetMs
}

/**
 * 等待队列：先进先出，长度有上限。
 *
 * 上限是「拒绝得快」的那一层 —— 排不下的请求当场回服务忙，而不是默默堆积到大家一起超时。
 */
export class Queue {
    #items = []

    constructor(limit) {
        this.limit = Number(limit)
    }

    get depth() {
        return this.#items.length
    }

    /** 排不下时返回 false，由调用方立刻回 503。 */
    push(item) {
        if (this.#items.length >= this.limit) return false
        this.#items.push(item)
        return true
    }

    shift() {
        return this.#items.shift()
    }

    /** 看一眼队头但不拿走：超时扫描要在确认「真的要拒」之后才出队。 */
    peek() {
        return this.#items[0]
    }

    clear() {
        this.#items = []
    }

    [Symbol.iterator]() {
        return this.#items[Symbol.iterator]()
    }
}

/** 环境变量里的正整数：非法值一律退回默认，0 个 worker 等于把服务关掉。 */
export function parsePositiveInt(raw, fallback) {
    const value = Math.trunc(Number(raw))
    return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 只在回环上转义：这些地址上来的流量一定是本机自己。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

/** 非回环时留 25% 的核给别人：这台机器通常还跑着别的东西。 */
const CORE_SHARE = 0.75

/**
 * worker 数怎么定：环境变量优先，其次看绑定的地址。
 *
 * 返回 reason 而不是只返回数字，因为启动日志必须说清「这个数是这么来的」——绑定地址一变
 * 进程数就变，不写出来只会让人以为是配置没生效。
 */
export function deriveWorkerCount({ bind = '', override = '', parallelism = 1 } = {}) {
    const requested = Math.trunc(Number(override))
    if (String(override).trim() !== '' && Number.isFinite(requested) && requested >= 1) {
        return { count: requested, reason: `LIBMSSDK_WORKERS=${requested}` }
    }
    const address = String(bind).trim()
    if (LOOPBACK.has(address)) {
        return { count: 1, reason: `绑定 ${address} 是回环地址，本机自用开 1 个` }
    }
    // 物理核估算：逻辑核除以 2（超线程）。宁可低估 —— 多开的 worker 每个都要吃一份原生模块的内存。
    const physical = Math.max(1, Math.floor(Number(parallelism) / 2))
    const count = Math.max(1, Math.floor(physical * CORE_SHARE))
    return { count, reason: `绑定 ${address} 对局域网开放，按约 ${physical} 个物理核的 ${Math.round(CORE_SHARE * 100)}% 开 ${count} 个` }
}

/** 重生退避：1 秒起、每次翻倍、封顶 60 秒。failures 是这台 worker 连着的第几次非零退出。 */
export function backoffDelayMs(failures, { baseMs = 1000, capMs = 60_000 } = {}) {
    if (!(failures > 0)) return 0
    return Math.min(capMs, baseMs * 2 ** (failures - 1))
}

/** 判「短时间反复退出」的窗口长度：池子修剪退出记录时要用同一个数，别各写一份 60000。 */
export const GIVE_UP_WINDOW_MS = 60_000

/** 60 秒窗口内退出 5 次就整体退出：无限重试只会把「机器坏了」拖成「谁都不知道坏了」。 */
export function shouldGiveUp(exitTimesMs, nowMs, { windowMs = GIVE_UP_WINDOW_MS, limit = 5 } = {}) {
    const recent = exitTimesMs.filter(at => nowMs - at <= windowMs)
    return recent.length >= limit
}
