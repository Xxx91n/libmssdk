// 假池子：给分发器的 HTTP 用例用，只实现分发器真正调的那几件事
// （size / readyCount / blocker / lease / on('available')）。
//
// 分发器不该知道进程，所以这里连「worker」都没有，只有槽位和「什么时候报告完成」。
import { EventEmitter } from 'node:events'

export function fakePool({ size = 1, ready = true, blocker = null } = {}) {
    const events = new EventEmitter()
    const slots = Array.from({ length: size }, (unused, index) => ({
        id: `worker-${index}`,
        busy: false,
        ready,
    }))
    const inFlight = new Map()

    const pool = {
        size,
        blocker,
        requests: [],
        get readyCount() {
            return slots.filter(slot => slot.ready).length
        },
        on(event, handler) {
            events.on(event, handler)
            return pool
        },
        lease() {
            const slot = slots.find(candidate => candidate.ready && !candidate.busy)
            if (!slot) return null
            slot.busy = true
            return {
                id: slot.id,
                run(request) {
                    pool.requests.push({ slotId: slot.id, request })
                    return new Promise((resolve, reject) => {
                        inFlight.set(slot.id, { request, resolve, reject })
                    })
                },
            }
        },
        /** 测试替 worker 「报告完成」：这一刻之前槽位一直在忙。 */
        complete(slotId, outcome) {
            inFlight.get(slotId)?.resolve(outcome)
            inFlight.delete(slotId)
            const slot = slots.find(candidate => candidate.id === slotId)
            slot.busy = false
            events.emit('available')
        },
        /** 谁还在飞：分发器排队的用例要靠它确认「真的没被偷偷派发」。 */
        busyCount() {
            return slots.filter(slot => slot.busy).length
        },
        start: async () => {},
        stop: async () => {},
    }
    return pool
}

/** 假 worker 算出来的响应体：url 回显请求，用例才能确认「交回来的就是这一次算的」。 */
export const signedBody = (url = 'https://api.qishui.com/x') => ({
    ok: true,
    headers: { 'X-Helios': 'h', 'X-Medusa': 'm' },
    device_id: '7000000000000001',
    elapsed_ms: 1,
    url,
})
