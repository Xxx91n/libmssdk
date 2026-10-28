// 设备身份文件：谁是写入者由文件系统的独占创建决定，不由进程自己判断。
//
// 为什么不能「读不到 → 随机生成 → 写盘」：三步之间没有原子性。多个进程同时首次启动会各自
// 生成一个设备号并各自写盘，磁盘上留一份、内存里两份，同一台机器对上游呈现出两张脸。
// 「写临时文件再改名」也不行 —— 改名保证的是「读者不会看到半截文件」，不是「只生成一次」。
// 这里用 open(..., 'wx')：内核保证同一路径只有一个创建者能成功，输的一方拿到 EEXIST
// 之后回头读赢家的值。
//
// 写入只有一个入口 prepareStoredIdentity()：入口命令启动时都会走到它（除了用
// LIBMSSDK_DEVICE_ID / QISHUI_DEVICE_ID 钉死设备号那种，那时根本不碰身份文件），
// 所以「只有一个写入者」靠的是独占创建本身 —— 无论哪个进程赢，磁盘上都只有一份。
// 将来 worker 池落地后，worker 侧改用 readStoredIdentity()，
// 那条路径上没有任何创建或改写的代码。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logWarn } from './log.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, 'data')

const IDENTITY_FILE_NAME = 'identity.json'

/** 确认损坏的身份文件挪到这里。用固定名字，只留最近一份：不直接删，删掉就等于抹掉
 *  「这台机器分裂过」的证据；但也不为每次损坏堆一堆文件。 */
const CORRUPT_SUFFIX = '.corrupt'

/** 独占创建的重试轮数：第二轮由「这一轮的坏内容被挪走了」或「并发进程刚刚动过文件」触发。 */
const CREATE_ATTEMPTS = 3

/** 独占创建成功的一方写盘需要时间，这段时间里文件可能是 0 字节或半截。把它判成「损坏」
 *  并挪走就会毁掉赢家的成果、重新分裂，所以要「连续两次读到同一份不合法内容」并且预算
 *  用完，才认定它是真的坏了。预算用完内容还在变（并发进程在反复动它）就不等了，直接放弃。
 *  慢 IO（Wine / 网络卷）下这个预算是同步阻塞，可用 LIBMSSDK_IDENTITY_READ_BUDGET_MS 调小。 */
const DEFAULT_READ_BUDGET_MS = 1000
const READ_POLL_MS = 5

function defaultReadBudgetMs() {
    const raw = (process.env.LIBMSSDK_IDENTITY_READ_BUDGET_MS || '').trim()
    if (!raw) return DEFAULT_READ_BUDGET_MS
    const value = Number(raw)
    // 0 或负数或非法值都退回默认：预算为 0 等于「观察到 in-flight 立刻放弃」，会把并发拆回多份
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_READ_BUDGET_MS
}

/** 写完回读核对的次数：读不动多半是几毫秒的抖动（EMFILE、杀软占用），多读两轮就过去了。 */
const READBACK_POLLS = 3

/** 身份文件目录：默认 <仓库>/data，可用 LIBMSSDK_STATE_DIR 改到别处。 */
function stateDir() {
    return (process.env.LIBMSSDK_STATE_DIR || '').trim() || DEFAULT_STATE_DIR
}

export function identityFile(dir = stateDir()) {
    return path.join(dir, IDENTITY_FILE_NAME)
}

/** 告警里的目录：把家目录折成 ~，别让用户名连同整段本机路径被贴进 issue。
 *  fs 错误只取 error.code（message 里的路径可能是 8.3 短名，折不动）。 */
function redactDir(dir) {
    const home = os.homedir()
    if (home && dir.startsWith(home)) return `~${dir.slice(home.length)}`
    return dir
}

/** 设备号格式与官方客户端一致：16 位数字，首位 1-8。 */
export function randomDeviceId() {
    const first = 1 + (crypto.randomBytes(1)[0] % 8)
    const rest = crypto.randomBytes(8).readBigUInt64BE() % 1000000000000000n
    return `${first}${rest.toString().padStart(15, '0')}`
}

function generateIdentity() {
    const identity = {
        device_id: randomDeviceId(),
        iid: randomDeviceId(),
        created_at: new Date().toISOString(),
    }
    identity.fp = identity.device_id
    return identity
}

/** 只看设备号格式。格式合法就不动它：给一个已经存在的身份「纠错」等于换第三张脸。 */
function parseStoredIdentity(raw) {
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (!/^[1-8]\d{15}$/.test(String(parsed?.device_id || ''))) return null
    return parsed
}

/**
 * 只读加载：worker 侧唯一的入口，这条路径上没有创建也没有改写。
 * 文件不存在、读不出、格式不合法一律返回 null，由调用方决定怎么办。
 */
export function readStoredIdentity(dir = stateDir()) {
    return inspectIdentityFile(dir).identity || null
}

/**
 * 读身份文件并把三种情况分开：没读到（absent / unreadable）和读到了但不合法（invalid）。
 * 没读到过的东西不能当成坏文件挪走 —— 那等于把一份合法的身份换成第三张脸。
 */
function inspectIdentityFile(dir) {
    const file = identityFile(dir)
    let raw
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
        // ENOENT：还没人建，或并发进程刚刚把坏文件挪走
        if (error.code === 'ENOENT') return { status: 'absent' }
        return { status: 'unreadable', error }
    }
    const identity = parseStoredIdentity(raw)
    return identity ? { status: 'valid', identity } : { status: 'invalid', raw }
}

/** 两次观察是不是同一份东西：状态加上原文一起比，内容变了就不算「稳定」。
 *  读不动的几次观察算作同一份（错误文本不进指纹）：否则同样的读不动会因为错误文本不同
 *  被判成「内容一直在变」，最后报成 churning 而不是 unreadable。 */
function fingerprint(found) {
    return `${found.status}:${found.raw ?? ''}`
}

/** 独占创建 + 回读核对，返回 created / unconfirmed / exists / failed 四种结果之一。 */
function createIdentityFile(dir) {
    const file = identityFile(dir)
    let fd
    try {
        fd = fs.openSync(file, 'wx', 0o600)
    } catch (error) {
        if (error.code === 'EEXIST') return { status: 'exists' }
        return { status: 'failed', error }
    }
    const identity = generateIdentity()
    try {
        fs.writeFileSync(fd, `${JSON.stringify(identity, null, 2)}\n`)
    } catch (error) {
        return { status: 'failed', error }
    } finally {
        fs.closeSync(fd)
    }
    // 写完再回读核对：从创建到写盘之间如果隔得太久（Wine + 挂出来的数据卷上不是没可能），
    // 别人会把这个还是空的文件当成损坏文件挪走并重建。磁盘上的那份才是大家共用的身份，认它。
    // 一直读不回来时（被占用 / 没权限）不能声称已验证，但内容确实是我们写下去的。
    return confirmIdentityFile(dir, identity)
}

/** 回读核对。读不动时先重试几次（EMFILE / 杀软占用都是几毫秒的抖动）再下结论。 */
function confirmIdentityFile(dir, identity) {
    for (let poll = 0; poll < READBACK_POLLS; poll += 1) {
        const found = inspectIdentityFile(dir)
        if (found.status === 'valid') {
            return found.identity.device_id === identity.device_id
                ? { status: 'created', identity: found.identity }
                : { status: 'exists' }
        }
        if (found.status === 'absent') return { status: 'exists' }
        // unreadable / invalid 都再等一轮：宁可多读一次，也不凭一次抖动就断定这份身份不算数
        if (poll + 1 < READBACK_POLLS) sleep(READ_POLL_MS)
    }
    return { status: 'unconfirmed', identity }
}

/**
 * 把确认损坏的文件挪开。源文件已经被别人挪走时拿到 ENOENT，同样回到独占创建那一轮。
 *
 * 注意残留窗口：改名作用于「此刻路径上的那份文件」，跟上面那次校验不是原子的。如果两个进程
 * 都在等同一份坏文件，其中一个已经挪走并建好了新的，另一个的改名就会把那份**合法的新文件**
 * 挪走并再建一份 —— 磁盘上仍然只有一份，但先建那个进程内存里留着另一个设备号。
 * 要撞上它，两个进程得同时在 1 秒预算上耗空、又恰好在微秒级缝隙里交错；发生时会留下
 * `reason=rebuild` 告警和一份内容合法的 .corrupt 供事后核对。
 */
function retireCorruptIdentity(dir) {
    const file = identityFile(dir)
    try {
        fs.renameSync(file, `${file}${CORRUPT_SUFFIX}`)
        return true
    } catch (error) {
        if (error.code === 'ENOENT') return true
        return false
    }
}

let sleepSlot

/** 同步等一小会儿：主进程在 fork 之前做完身份准备，这里不能用异步定时器。 */
function sleep(ms) {
    sleepSlot ??= new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(sleepSlot, 0, 0, ms)
}

/**
 * 进程启动时调用（worker 侧改用 readStoredIdentity）：读到就用，读不到就独占生成。
 *
 * 返回值里 created 表示「这份值是本次生成的」，persisted 表示「这份值已经在身份文件上」。
 * persisted 为 false 时 state 目录不可用或不可修，设备号只在内存里，重启会变，并留一条告警。
 */
export function prepareStoredIdentity({ dir = stateDir(), readBudgetMs = defaultReadBudgetMs(), log = logWarn } = {}) {
    const warn = (reason, message) => log('identity', { level: 'warn', reason, message })
    /** 只把设备号留在内存里：跨重启会变，所以必须留一条告警。 */
    const inMemoryOnly = (identity, reason, message) => {
        warn(reason, message)
        return { identity, created: true, persisted: false }
    }
    const giveUp = (reason, message) => inMemoryOnly(generateIdentity(), reason, message)

    try {
        fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
        return giveUp('state-dir-unusable', `身份目录建不出来，本次只在内存里保留设备号：${redactDir(dir)}（${error.code}）`)
    }

    // 一轮 = 一次独占创建尝试。退到下一轮只有三种来路：文件被人挪走了、刚挪走坏文件、
    // 或者坏文件在两次观察之间又变了。其余情况都直接返回。
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const created = createIdentityFile(dir)
        if (created.status === 'created') return { identity: created.identity, created: true, persisted: true }
        if (created.status === 'unconfirmed') {
            return inMemoryOnly(
                created.identity,
                'unconfirmed',
                '身份文件写得下去却读不回来（被占用 / 没权限）：这份设备号大概就在文件里，但没法验证',
            )
        }
        if (created.status === 'failed') {
            return giveUp('create-failed', `身份文件写不下去，本次只在内存里保留设备号（${created.error.code}）`)
        }
        // created.status === 'exists'：多半是别的进程刚刚建的，回读它的值，绝不覆盖。

        const settleAt = performance.now() + readBudgetMs
        const giveUpAt = settleAt + readBudgetMs
        let lastSeen
        for (;;) {
            const found = inspectIdentityFile(dir)
            if (found.status === 'valid') return { identity: found.identity, created: false, persisted: true }
            if (found.status === 'absent') break

            const now = performance.now()
            if (now >= giveUpAt) {
                return giveUp('churning', `身份文件在 ${readBudgetMs * 2}ms 里一直在变，判不出是没写完还是坏了，本次只在内存里保留设备号`)
            }
            // 判「坏」要连续两次读到同一份内容：内容还在变说明有人在写，这时候挪走它就会分裂。
            const seen = fingerprint(found)
            if (seen === lastSeen && now >= settleAt) {
                if (found.status === 'unreadable') {
                    return giveUp('unreadable', `身份文件读不动，本次只在内存里保留设备号（${found.error.code}）`)
                }
                // 动手之前再读最后一次：上面两次观察之间可能刚好有内容落进来（读 → 改名不是原子的），
                // 这一眼把「以为坏了、其实已经写好」的窗口压到一次读的长度。
                const latest = inspectIdentityFile(dir)
                if (latest.status === 'valid') return { identity: latest.identity, created: false, persisted: true }
                if (latest.status !== 'invalid' || fingerprint(latest) !== seen) break
                if (!retireCorruptIdentity(dir)) {
                    return giveUp('stuck', '身份文件内容不合法而且挪不动（可能被占用），本次只在内存里保留设备号')
                }
                warn('rebuild', `身份文件内容不合法，重建一个新设备号；原来的坏文件挪到同目录的 ${IDENTITY_FILE_NAME}${CORRUPT_SUFFIX}`)
                break
            }
            lastSeen = seen
            sleep(READ_POLL_MS)
        }
    }

    return giveUp('churning', `身份文件在 ${CREATE_ATTEMPTS} 次独占创建尝试里反复被并发进程改动，本次只在内存里保留设备号`)
}
