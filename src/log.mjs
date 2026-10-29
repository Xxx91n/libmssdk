// 日志：只记录"请求形状 + 签名长度"，绝不落 Cookie / 签名值。

const SECRET_HEADERS = /^(cookie|authorization|set-cookie|x-helios|x-medusa|x-ss-stub)$/i

export function redactHeaders(headers = {}) {
    const result = {}
    for (const [name, value] of Object.entries(headers)) {
        result[name] = SECRET_HEADERS.test(name) ? `<redacted ${String(value).length} chars>` : String(value)
    }
    return result
}

export function logEvent(event, detail = {}) {
    const line = { at: new Date().toISOString(), event, ...detail }
    process.stdout.write(`${JSON.stringify(line)}\n`)
}

/**
 * 告警走 stderr，不进 stdout：`bridge` / `selftest` / `config` 用 stdout 吐机器可读结果
 * （libresoda 按次拉起 `bridge` 并 JSON.parse 那一个对象），降级告警一旦混进去就会让调用方
 * 要么解析失败、要么拿到一个没有 X-Helios 的对象。`serve` 模式 stdout/stderr 都会被容器日志收走。
 */
export function logWarn(event, detail = {}) {
    const line = { at: new Date().toISOString(), event, level: 'warn', ...detail }
    process.stderr.write(`${JSON.stringify(line)}\n`)
}

export function logError(message) {
    const line = { at: new Date().toISOString(), event: 'error', message: String(message) }
    process.stderr.write(`${JSON.stringify(line)}\n`)
}
