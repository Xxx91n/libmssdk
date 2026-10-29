// 假的 worker 传输：只提供真 child_process 那一层用到的四个动作（send / message / exit / kill）。
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
        this.killed = []
    }

    send(message) {
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
    reportResult({ kind = 'SUCCESS', extra = {} } = {}) {
        const task = this.task()
        this.report({ type: 'result', id: task.id, kind, body: { ok: true, url: task.request.url }, ...extra })
    }

    /** 按池子派下来的任务回一份失败：原因文本要能原样交回分发器。 */
    reportFailure(kind, message) {
        const task = this.task()
        this.report({ type: 'result', id: task.id, kind, message })
    }

    exit(code = 1) {
        this.emit('exit', code)
    }

    kill(signal) {
        this.killed.push(signal)
        return true
    }
}
