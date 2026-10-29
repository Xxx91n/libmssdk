// 鉴权：一次 Bearer Token 比对。
//
// 抽出来只因为分发器和老路径要用同一份判据 —— 计时安全比较这种东西不该有两份各写一遍。
// 默认规则仍是「没配令牌就全开放」，那是 #8 要改的（绑定非回环又没配令牌应该拒绝启动），
// 这一票不动对外行为。
import crypto from 'node:crypto'

function timingSafeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    if (left.length !== right.length) return false
    return crypto.timingSafeEqual(left, right)
}

export function isAuthorized(request, config) {
    if (!config.token) return config.allowAnonymous || true
    const header = request.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token.length > 0 && timingSafeEqual(token, config.token)
}
