// 并发冷启动用例的子进程：先就位，等父进程一声令下，几个进程就在同一时刻走同一个生产入口。
// 生产入口是 config.resolveIdentity()，所以这里测到的就是服务真实启动时的那一步。

import { resolveIdentity } from '../../src/config.mjs'

process.on('message', message => {
    if (message?.go !== true) return
    let reply
    try {
        reply = resolveIdentity()
    } catch (error) {
        reply = { error: String(error?.message || error) }
    }
    process.send(reply)
    process.disconnect()
})

process.send('ready')
