// 两个控制面共用的观察工具：/healthz 探活、就绪等待、日志取尾。
// 只返回状态与失败形态，不返回响应体内容。

const healthUrl = port => `http://127.0.0.1:${port}/healthz`

/**
 * 单一探活原语，四种结果都要分清：
 * 'ready' 应答且 2xx / 'http' 应答但非 2xx / 'refused' 连不上 / 'hung' 接了但不答话。
 * 'hung' 与 'refused' 混为一谈会把「卡死」读成「干净退出」，而卡死正是共享 prefix 被拖垮的样子。
 */
export async function probeHealthz(port, probeTimeoutMs = 4000) {
    try {
        const response = await fetch(healthUrl(port), { signal: AbortSignal.timeout(probeTimeoutMs) })
        return response.status < 400 ? 'ready' : 'http'
    } catch (error) {
        return error?.name === 'TimeoutError' ? 'hung' : 'refused'
    }
}

export async function fetchHealthz(port, probeTimeoutMs = 4000) {
    if ((await probeHealthz(port, probeTimeoutMs)) !== 'ready') return null
    try {
        const response = await fetch(healthUrl(port), { signal: AbortSignal.timeout(probeTimeoutMs) })
        return await response.json()
    } catch {
        return null
    }
}

/** 返回仍未就绪的进程：{index, lastErrorKind}；kind 直接来自 probeHealthz 的形态。 */
export async function waitForReady(ports, { timeoutMs, intervalMs, probeTimeoutMs }) {
    const deadline = Date.now() + timeoutMs
    const pending = new Map(ports.map((_, index) => [index, 'refused']))
    while (pending.size && Date.now() < deadline) {
        for (const index of [...pending.keys()]) {
            const kind = await probeHealthz(ports[index], probeTimeoutMs)
            if (kind === 'ready') pending.delete(index)
            else pending.set(index, kind)
        }
        if (pending.size) await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
    return [...pending.entries()].map(([index, lastErrorKind]) => ({ index, lastErrorKind }))
}

export function tailLines(text, count = 8) {
    return String(text || '').split('\n').filter(Boolean).slice(-count)
}
