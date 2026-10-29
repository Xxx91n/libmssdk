// 原始字节发一条 HTTP 请求，读到连接关闭为止。
//
// 为什么要自己拼字节：fetch / http.request 都发不出畸形请求目标（`GET // HTTP/1.1`），
// 而那里正是「URL 解析抛错 → unhandled rejection → 进程退出」的入口。resolve 时把
// socket 的错误一起带回去，才能分清「读到回应」和「连接被重置」这两件事。

import net from 'node:net'

export function rawExchange(port, { requestLine, headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        const chunks = []
        let error = null
        socket.on('data', chunk => chunks.push(chunk))
        socket.on('error', cause => {
            error = cause
        })
        socket.on('close', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), error }))
        socket.setTimeout(5000, () => {
            socket.destroy()
            reject(new Error('五秒内没等到连接关闭'))
        })
        const lines = [`${requestLine} HTTP/1.1`]
        for (const [name, value] of Object.entries({ host: '127.0.0.1', connection: 'close', ...headers })) {
            lines.push(`${name}: ${value}`)
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`)
    })
}
