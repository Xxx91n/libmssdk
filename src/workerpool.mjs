// worker 池：分发器唯一认识的「外部世界」。
//
// 这一票只建这个模块，不接线 —— 老的 serve 路径还在原地（切换是 #7 的事）。
//
// 池子负责的事：拉起 worker、记住谁在忙、谁就绪、谁已经没了；不负责排队和等待预算
// （那归分发器），也不负责算签名（那归 worker）。
//
// 传输对象是注入的（spawn 返回一个有 send / on('message') / on('exit') / kill 的东西）：
// 生产用 child_process.fork，测试用内存里的假对象。真进程「什么时候报告完成」没法约时间，
// 而忙闲回收恰恰是必须被确定性验证的那部分。

import { EventEmitter } from 'node:events'
import { ERROR_KINDS } from './errors.mjs'
import { GIVE_UP_WINDOW_MS, backoffDelayMs, shouldGiveUp } from './dispatch.mjs'

/** 槽位没了（进程崩了 / 管道断了）：在飞的请求按「内部算错」收口，不能让调用方永远等。 */
export class WorkerLost extends Error {
    constructor(slotId) {
        super(`worker ${slotId} 在处理途中退出`)
        this.name = 'WorkerLost'
        this.kind = ERROR_KINDS.INTERNAL_ERROR
    }
}

export function createWorkerPool({
    workerCount,
    spawn,
    log = () => {},
    onGiveUp = () => {},
    respawnBaseMs = 1000,
    respawnCapMs = 60_000,
} = {}) {
    const events = new EventEmitter()
    const slots = []
    const timers = new Set()
    const exits = []
    let requests = 0
    let stopping = false
    let givenUp = false

    /** 一台进程绑回它的槽位：槽位号是稳定身份，重生换的是进程不是位置。 */
    function bind(slot) {
        const transport = spawn(slot.index)
        slot.transport = transport
        slot.ready = false
        slot.busy = false
        slot.blocker = null
        slot.dead = false
        transport.on('message', message => handleMessage(slot, message))
        // 一次死亡会来两个事件（管道先断、进程随后退出），只认第一个：
        // 每个槽位同时只能有一个重生计划，否则一个位置会冒出两台进程。
        transport.on('exit', code => gone(slot, code))
        transport.on('disconnect', () => gone(slot, null))
        return transport
    }

    function gone(slot, code) {
        if (slot.dead) return
        slot.dead = true
        handleExit(slot, code)
    }

    function attach(index) {
        const slot = {
            id: `worker-${index}`,
            index,
            transport: null,
            ready: false,
            busy: false,
            dead: false,
            pending: new Map(),
            failures: 0,
            blocker: null,
        }
        // 「这一台冷启动的事办完了没有」：就绪、预热失败、进程没了，三种都算完。
        // 没完就不拉下一台 —— 几台同时做 bdms.init 会把启动时间叠成一份更长的不可用窗口。
        slot.settled = new Promise(resolve => {
            slot.settle = resolve
        })
        slots.push(slot)
        bind(slot)
        return slot
    }

    function handleMessage(slot, message) {
        if (!message || typeof message !== 'object') {
            log('worker-message-unknown', { id: slot.id, type: typeof message })
            return
        }
        if (message.type === 'ready') {
            slot.ready = true
            slot.blocker = null
            slot.failures = 0
            slot.settle()
            events.emit('available')
            return
        }
        if (message.type === 'warmup-failed') {
            // 保持未就绪、进程不退：这台不算进「能服务」，但别人还能干活
            slot.blocker = message.kind || ERROR_KINDS.INTERNAL_ERROR
            log('worker-warmup-failed', { id: slot.id, kind: slot.blocker, reason: message.reason })
            slot.settle()
            return
        }
        if (message.type === 'result') {
            const waiter = slot.pending.get(message.id)
            if (!waiter) return
            slot.pending.delete(message.id)
            slot.busy = false
            // message 一起带上：worker 那句「签名不完整：只拿到 N 个头」是排查时唯一能看到的东西
            waiter.resolve({ kind: message.kind, body: message.body, message: message.message })
            events.emit('available')
            return
        }
        log('worker-message-unknown', { id: slot.id, type: message.type })
    }

    function reclaim(slot) {
        slot.ready = false
        slot.busy = false
        for (const waiter of slot.pending.values()) waiter.reject(new WorkerLost(slot.id))
        slot.pending.clear()
    }

    function handleExit(slot, code) {
        reclaim(slot)
        slot.settle()
        if (stopping) return
        if (code !== 0) {
            // 只留窗口内那几次：这是一台要跑很多天的常驻进程，不能一直攒退出记录
            const now = Date.now()
            exits.push(now)
            while (exits.length > 0 && now - exits[0] > GIVE_UP_WINDOW_MS) exits.shift()
        }
        if (shouldGiveUp(exits, Date.now(), { windowMs: GIVE_UP_WINDOW_MS })) {
            if (!givenUp) {
                givenUp = true
                log('worker-giveup', { exits: exits.length, code })
                onGiveUp()
            }
            return
        }
        slot.failures += 1
        const delayMs = backoffDelayMs(slot.failures, { baseMs: respawnBaseMs, capMs: respawnCapMs })
        log('worker-respawn', { id: slot.id, delayMs, failures: slot.failures, code })
        const timer = setTimeout(() => {
            timers.delete(timer)
            if (stopping || givenUp) return
            bind(slot)
        }, delayMs)
        // 退避计时器不该把「本来该退出的进程」留在世上
        timer.unref()
        timers.add(timer)
    }

    return {
        get size() {
            return workerCount
        },
        get readyCount() {
            return slots.filter(slot => slot.ready).length
        },
        /** 在飞的签名数：黑盒用例靠它确认「这台正忙着」，#9 的诊断端点也要读这个数。 */
        get busyCount() {
            return slots.filter(slot => slot.busy).length
        },
        /**
         * 一台都不就绪时，「等一会儿会好」这句话还能不能说。
         *
         * 只有每台都明确报告「模块没加载 / 配置错」才认领 SIGNER_UNAVAILABLE（500，要人来修）；
         * 掺进任何一种「也许重生就好」的失败就退回 null，让分发器按服务忙（503）回。
         */
        get blocker() {
            if (this.readyCount > 0) return null
            if (slots.length === 0) return null
            return slots.every(slot => slot.blocker === ERROR_KINDS.SIGNER_UNAVAILABLE)
                ? ERROR_KINDS.SIGNER_UNAVAILABLE
                : null
        },
        on(event, handler) {
            events.on(event, handler)
            return this
        },
        /** 拿走一个空闲且就绪的 worker；一个都没有就是 null，由分发器决定排队还是拒绝。 */
        lease() {
            const slot = slots.find(candidate => candidate.ready && !candidate.busy)
            if (!slot) return null
            slot.busy = true
            return {
                id: slot.id,
                run(request) {
                    const id = `r${(requests += 1)}`
                    slot.transport.send({ type: 'sign', id, request })
                    return new Promise((resolve, reject) => {
                        slot.pending.set(id, { resolve, reject })
                    })
                },
            }
        },
        /** 一台一台拉：前一台把冷启动的事做完（就绪 / 预热失败 / 没了）才动下一台。 */
        async start() {
            for (let index = 0; index < workerCount; index += 1) {
                await attach(index).settled
            }
        },
        async stop() {
            stopping = true
            for (const timer of timers) clearTimeout(timer)
            timers.clear()
            for (const slot of slots) {
                reclaim(slot)
                // 死在退避窗口里的槽位手上还是那个已关闭的通道：对它 send 不是返回 false 就完事，
                // Node 会在 process 上发一个 'error' 事件，把整个主进程掀掉。关池子时跳过。
                if (slot.dead) continue
                slot.transport.send({ type: 'shutdown' })
            }
        },
    }
}
