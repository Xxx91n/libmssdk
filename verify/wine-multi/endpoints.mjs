// 两个控制面共用的 HTTP 观察：/healthz 取脱敏状态，以及「等到答话为止」。
// 只返回端口状态与失败形态（refused / timeout / http），不返回响应体内容。

async function probeHealth(port, probeTimeoutMs) {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(probeTimeoutMs) })
    return response.status
}

export async function fetchHealthz(port, probeTimeoutMs = 5000) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(probeTimeoutMs) })
        return response.ok ? response.json() : null
    } catch {
        return null
    }
}

/** 返回仍未就绪的进程：{index, lastErrorKind}；kind 用来区分「没监听」与「起了但不答话」。 */
export async function waitForReady(ports, { timeoutMs, intervalMs, probeTimeoutMs }) {
    const deadline = Date.now() + timeoutMs
    const pending = new Map(ports.map((_, index) => [index, 'unknown']))
    while (pending.size && Date.now() < deadline) {
        for (const index of [...pending.keys()]) {
            try {
                const status = await probeHealth(ports[index], probeTimeoutMs)
                if (status < 400) pending.delete(index)
                else pending.set(index, 'http')
            } catch (error) {
                pending.set(index, error?.name === 'TimeoutError' ? 'timeout' : 'refused')
            }
        }
        if (pending.size) await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
    return [...pending.entries()].map(([index, lastErrorKind]) => ({ index, lastErrorKind }))
}
