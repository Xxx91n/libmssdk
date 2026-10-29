// 假的 worker 传输：只提供真 child_process 那一层被池子用到的那几个动作
// （send / 'message' / 'exit' / 'disconnect' / 'error'）。
//
// 池子的整个价值就在「忙闲回收」上，而它必须能被确定性地形变：真进程什么时候「报告完成」
// 由测试说了算，不需要 sleep 也不需要真原生模块。
import { EventEmitter } from 'node:events'

export class FakeWorker extends EventEmitter {
    /** id 用池子给的槽位号，测试才能拿池子返回的 id 找回对应的那台假 worker。 */
    constructor(index = 0) {
        super()
        this.id = `worker-${index}`
        this.sent = []
        this.exited = false
    }

    /**
     * 真 child_process 对已关闭的通道 send 不是返回 false 就完事：它会在 process 上发一个
     * 'error' 事件（ERR_IPC_CHANNEL_CLOSED）。没有 error 监听就整个主进程被掀掉，所以假传输
     * 也照样抛 —— 不然「关池子时别再碰死通道」这条判据就测不出来。
     */
    send(message) {
        if (this.exited) throw new Error(`${this.id} 的 IPC 通道已关闭`)
        this.sent.push(message)
        return true
    }

    /** 池子派下来的最后一条任务。 */
    task() {
        return this.sent.filter(message => message.type === 'sign').at(-1)
    }

    /** 代替真 worker 的回包。 */
    report(message) {
        this.emit('message', message)
    }

    reportReady() {
        this.report({ type: 'ready' })
    }

    /** 按池子派下来的任务原样回一份成功签名（body 里带回 url 方便断言真的是它算的那一次）。 */
    reportResult() {
        const task = this.task()
        this.report({ type: 'result', id: task.id, kind: 'SUCCESS', body: { ok: true, url: task.request.url } })
    }

    /** 按池子派下来的任务回一份失败：原因文本要能原样交回分发器。 */
    reportFailure(kind, message) {
        const task = this.task()
        this.report({ type: 'result', id: task.id, kind, message })
    }

    /** 只有 'error'、没有随后的 'exit'：真 child_process 在 spawn 失败时就是这样。 */
    fail(error) {
        this.emit('error', error)
    }

    exit(code = 1) {
        this.emit('exit', code)
    }
}
