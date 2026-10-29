// 预热就绪判定（纯函数）：worker 自己学出「这份输出稳了没有」。
//
// 这里没有、也不许有任何绝对长度数字。换一个客户端版本的 bdms.node，稳态签名的长度就可能
// 不一样；把长度写死的那台机器会永远停在「没就绪」，而运维看到的症状是「服务起不来」。
// 真机观察到的冷启动形态是 init 之后还有一小段输出偏短的窗口，所以判据只能是「相邻几次
// 彼此相同」，不能是「等到了某个数」。
//
// 采样节奏（循环调用探针请求）归 worker；本模块只回答「这一份像不像、和第上一份同不同」。

/** 连续几次同长才算稳态。是采样条数，不是长度。 */
const REQUIRED_SAMPLES = 3

/** 结构下限的形状判据：标准 base64 或 base64url，填充只在末尾。 */
const BASE64_LIKE = /^[A-Za-z0-9+/_-]+={0,2}$/

/**
 * 结构下限：非空，且每一项都能按 base64 解出字节。
 *
 * 只看「能不能解出东西」，不看解出来的东西多长 —— 长度由上面那条「彼此相同」去管。
 */
function passesFloor(values) {
    if (!Array.isArray(values) || values.length === 0) return false
    return values.every(value => {
        const text = String(value ?? '').trim()
        if (!text) return false
        return BASE64_LIKE.test(text) && Buffer.from(text, 'base64').length > 0
    })
}

/** 起点：还没数过任何一次。 */
export const WARMUP_START = Object.freeze({ streak: 0, total: null, ready: false })

/**
 * 吃掉一次采样的签名值，返回新状态和「此刻是否就绪」。
 *
 * ready 是定住的：一旦就绪就不再撤回 —— 一个正在服务流量的 worker 因为一次抖动下线，
 * 比它偶尔回一份偏短的签名更难排查。
 */
export function nextWarmup(state, values) {
    if (state.ready) return { state, ready: true }
    if (!passesFloor(values)) return { state: { ...state, streak: 0, total: null }, ready: false }
    const total = values.reduce((sum, value) => sum + String(value).trim().length, 0)
    const streak = state.total === total ? state.streak + 1 : 1
    return { state: { streak, total, ready: streak >= REQUIRED_SAMPLES }, ready: streak >= REQUIRED_SAMPLES }
}

/** 连着几次「这一下直接抛」就停：那不是预热窗口，是坏了。 */
const MAX_THROWN_SAMPLES = 5

/**
 * 用固定探针循环采样，直到判据说「稳了」。
 *
 * sample 与 now 都是传进来的：真模块一次签名要一两百毫秒，循环本身就是节奏，不需要 sleep；
 * 但模块抛得飞快时（配置坏了、原生模块加载不了）这个前提就不成立了，不拦就会拿整份预算
 * 把一颗核空转掉，还顺着逐台预热把后面的 worker 一起堵住。
 */
export function settleWarmup({ sample, budgetMs, now = Date.now }) {
    const deadline = now() + budgetMs
    let state = WARMUP_START
    let thrown = 0
    let lastError = ''
    for (;;) {
        let values = []
        try {
            values = sample()
            thrown = 0
        } catch (error) {
            thrown += 1
            lastError = String(error?.message || error)
        }
        const step = nextWarmup(state, values)
        state = step.state
        if (step.ready) return { ready: true }
        if (thrown >= MAX_THROWN_SAMPLES) return { ready: false, reason: lastError, thrown }
        if (now() >= deadline) return { ready: false, reason: `预热 ${budgetMs}ms 内输出长度没收敛` }
    }
}
