// 默认服务的装配：/sign 走分发器（主进程监听 + worker 计算），其余端点暂时由老处理器承接。
//
// 为什么还留着老处理器：Docker 健康检查与 verify/wine-multi 都依赖 /healthz 和 /config，
// 而「收拢诊断端点、拆分健康检查」是 #9 的活。这一票只翻转 /sign 的行为，过渡端点保持可用，
// 但 /healthz 的 200 必须跟「至少一台 worker 就绪」绑定 —— 预热未完成就回 200，编排器会
// 立刻把流量放进来，第一个用户拿到的是 503。
//
// /probe 与 /track/stream 过渡期仍在主进程里同步签名。它们都会短暂阻塞事件循环，这是
// 端点收拢（#9）之前已知的例外；#9 把 /probe 收成命令行子命令并删除 /track/stream 之后，
// HTTP 层就不再有任何主进程同步签名的路径。

import { createLegacyHandler } from './server.mjs'
import { startDispatcher } from './dispatcher.mjs'

export function startServe({ config, signer, ...options } = {}) {
    return startDispatcher({
        config,
        ...options,
        createFallback: pool =>
            createLegacyHandler({
                config,
                signer,
                readiness: () => pool.readyCount > 0,
            }),
    })
}
