// 预热就绪判定：判据是自学习的，代码里不许出现任何绝对长度数字。
//
// 为什么：换一个客户端版本的 bdms.node，稳态签名长度就可能不一样。写死「等于 840」会让这台
// 机器永远不就绪。真机观察到的冷启动形态是「init 之后有一小段时间输出比稳态短的签名」，
// 所以判据是「连续若干次长度彼此相同，且每次都过结构下限」，而不是「等到了那个数」。
//
// 时间同样不做成接缝：这里只喂采样序列，采样间隔由 worker 那边的循环负责。

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { WARMUP_START, nextWarmup, settleWarmup } = await import('../src/warmup.mjs')

/** 按顺序喂采样，返回每次的 ready 轨迹 —— 就绪只由「外部看得见的输出形状」决定。 */
function feed(samples) {
    let state = WARMUP_START
    return samples.map(sample => {
        const step = nextWarmup(state, sample)
        state = step.state
        return step.ready
    })
}

test('真信号在有限样本内收敛：连续三次同长才算就绪', () => {
    const steady = ['AAAAAAAA', 'BBBBBBBB']
    assert.deepEqual(feed([steady, steady, steady]), [false, false, true])
})

test('假信号不误判：短签名窗口里长度一直在换，就永远不就绪', () => {
    const short = ['AAAA', 'BB']
    const long = ['AAAAAAAAAAAA', 'BB']
    const alternating = [long, short, long, short, long, short, long, short]
    assert.deepEqual(
        feed(alternating),
        alternating.map(() => false),
    )
})

test('结构下限不过就不累计：总长度凑得上，但内容不像签名', () => {
    const plausible = ['AAAAAAAAAAAAAAAA']
    const junk = [['不是 base64'], ['===='], [''], ['A A=A']]
    // 四个坏样本之后，干净的三次才从 false,false,true 走回就绪
    assert.deepEqual(feed([...junk, plausible, plausible, plausible]).slice(-3), [false, false, true])
})

test('中途抖一次重新数；就绪之后定住，不会因为一次异常下线', () => {
    const steady = ['AAAAAAAA', 'BBBBBBBB']
    const wobble = ['AAAAAAAA', 'BB']
    assert.deepEqual(feed([steady, steady, wobble, steady, steady]), [false, false, false, false, false])
    const converged = feed([steady, steady, wobble, steady, steady, steady])
    assert.equal(converged.at(-1), true)
    assert.deepEqual(
        feed([steady, steady, steady, wobble, [''], steady]),
        [false, false, true, true, true, true],
        '就绪是定住的：正在服务的 worker 不该被撤回',
    )
})

test('采样循环：靠一次成功的调用就定下就绪，不需要谁提醒它', () => {
    const steady = ['AAAAAAAA', 'BBBBBBBB']
    const result = settleWarmup({ sample: () => steady, budgetMs: 30_000 })
    assert.equal(result.ready, true)
})

test('模块抛得飞快时不许空转：连着几次抛就收，别把一颗核烧到预算用完', () => {
    let calls = 0
    let nowValue = 0
    const result = settleWarmup({
        budgetMs: 30_000,
        now: () => nowValue,
        sample: () => {
            calls += 1
            throw new Error('bdms.node 不存在')
        },
    })
    assert.equal(result.ready, false)
    assert.equal(result.spun, true, '时钟一次没走 = 调用根本没在做事，这才叫空转')
    assert.equal(result.thrown, 5, '第 5 次抛就停')
    assert.equal(calls, 5, '时钟一次都没走，也不该一直签下去')
    assert.match(result.reason, /bdms\.node 不存在/, '把抛出来的原因带回去')
})

test('预算用完还没收敛：报的是「没等到稳态」，进程照旧活着', () => {
    let calls = 0
    const result = settleWarmup({
        budgetMs: 1000,
        now: () => calls * 100,
        // 长度一次短一次长地摆，永远凑不满「连续三次同长」
        sample: () => {
            calls += 1
            return calls % 2 === 1 ? ['AAAA'] : ['AAAAAAAAAA']
        },
    })
    assert.equal(result.ready, false)
    assert.match(result.reason, /预热 1000ms 内输出长度没收敛/)
    assert.equal(calls, 10, '采满预算就停，不许多跑')
})

test('只是慢、不是坏：每次抛都花几百毫秒时继续采样到预算用完，别提前判死', () => {
    let calls = 0
    const result = settleWarmup({
        budgetMs: 3000,
        // 真模块冷启动里「抛一次」本身就是一次几百毫秒的调用，时钟跟着调用走
        now: () => calls * 300,
        sample: () => {
            calls += 1
            throw new Error('原生模块还在初始化')
        },
    })
    assert.equal(result.spun, undefined, '调用是有代价的，就不算空转：要一直试到预算用完')
    assert.equal(result.ready, false)
    assert.match(result.reason, /没收敛/)
    assert.equal(calls, 10, '10 次慢抛之后预算才用完')
})
