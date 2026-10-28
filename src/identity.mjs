// 设备身份文件：谁是写入者由文件系统的独占创建决定，不由进程自己判断。
//
// 为什么不能「读不到 → 随机生成 → 写盘」：三步之间没有原子性。多个进程同时首次启动会各自
// 生成一个设备号并各自写盘，磁盘上留一份、内存里两份，同一台机器对上游呈现出两张脸。
// 「写临时文件再改名」也不行 —— 改名保证的是「读者不会看到半截文件」，不是「只生成一次」。
// 这里用 open(..., 'wx')：内核保证同一路径只有一个创建者能成功，输的一方拿到 EEXIST
// 之后回头读赢家的值。
//
// 写入只有一个入口 prepareStoredIdentity()，主进程在拉起任何 worker 之前调用它；
// worker 侧只用 readStoredIdentity()，那条路径上没有任何创建或改写的代码。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logEvent } from './log.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, 'data')

const IDENTITY_FILE_NAME = 'identity.json'

/** 确认损坏的身份文件挪到这里，不直接删：留着才知道这台机器曾经分裂过。 */
const CORRUPT_SUFFIX = '.corrupt'

/** 独占创建成功的一方写盘需要时间，这段时间里文件可能是 0 字节。
 *  把它判成「损坏」并挪走，就会毁掉赢家的成果、重新分裂，所以读不到时先等一会儿。 */
const DEFAULT_READ_BUDGET_MS = 1000
const READ_POLL_MS = 5

/** 身份文件目录：默认 <仓库>/data，可用 LIBMSSDK_STATE_DIR 改到别处。 */
export function stateDir() {
    return (process.env.LIBMSSDK_STATE_DIR || '').trim() || DEFAULT_STATE_DIR
}

export function identityFile(dir = stateDir()) {
    return path.join(dir, IDENTITY_FILE_NAME)
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
    let raw
    try {
        raw = fs.readFileSync(identityFile(dir), 'utf8')
    } catch {
        return null
    }
    return parseStoredIdentity(raw)
}

/** 独占创建：本进程成功即说明它是唯一写入者。 */
function createIdentityFile(dir) {
    const file = identityFile(dir)
    let fd
    try {
        fd = fs.openSync(file, 'wx', 0o600)
    } catch (error) {
        if (error.code === 'EEXIST') return { exists: true }
        return { error }
    }
    const identity = generateIdentity()
    try {
        fs.writeFileSync(fd, `${JSON.stringify(identity, null, 2)}\n`)
    } catch (error) {
        return { error }
    } finally {
        fs.closeSync(fd)
    }
    // 写完再回读一次核对：从创建到写盘之间如果隔得太久（Wine + 挂出来的数据卷上不是没可能），
    // 别人会把这个还是空的文件当成损坏文件挪走并重建。磁盘上的那份才是大家共用的身份，
    // 认它 —— 否则创建者内存里的设备号和文件里的就又不一样了。
    const stored = readStoredIdentity(dir)
    if (!stored || stored.device_id !== identity.device_id) return { exists: true }
    return { identity }
}

/**
 * 把确认损坏的文件挪开。改名本身是单赢家的：同一时刻只有一个进程能改成功，
 * 其余拿到 ENOENT（源文件已经不在了），同样回到独占创建那一轮 —— 磁盘上仍然只会出现一份新身份。
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
 * 主进程在拉起任何 worker 之前调用：读到就用，读不到就独占生成。
 *
 * 返回值里 created 表示「这份值是本次生成的」，persisted 表示「这份值已经在身份文件上」。
 * persisted 为 false 时 state 目录不可写或不可修，设备号只在内存里，重启会变。
 */
export function prepareStoredIdentity({ dir = stateDir(), readBudgetMs = DEFAULT_READ_BUDGET_MS, log = logEvent } = {}) {
    const warn = (reason, message, detail = {}) => log('identity', { level: 'warn', reason, ...detail, message })
    const ephemeral = () => ({ identity: generateIdentity(), created: true, persisted: false })

    try {
        fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
        warn('state-dir-unusable', `身份目录建不出来，本次只在内存里保留设备号：${dir}（${error.message}）`)
        return ephemeral()
    }

    // 一轮 = 一次独占创建尝试；只有「文件在，但读不出合法内容且已经等过」才会进入下一轮。
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const created = createIdentityFile(dir)
        if (created.identity) return { identity: created.identity, created: true, persisted: true }
        if (created.error) {
            warn('create-failed', `身份文件写不下去，本次只在内存里保留设备号：${created.error.message}`)
            return ephemeral()
        }

        // 已存在（多半是别的进程刚刚建的）：等它写完，然后回读，绝不覆盖。
        const deadline = performance.now() + readBudgetMs
        let stored = readStoredIdentity(dir)
        while (!stored && performance.now() < deadline) {
            sleep(READ_POLL_MS)
            stored = readStoredIdentity(dir)
        }
        if (stored) return { identity: stored, created: false, persisted: true }

        if (!retireCorruptIdentity(dir)) {
            warn('unreadable', '身份文件读不出合法设备号，而且挪不动（可能被占用），本次只在内存里保留设备号')
            return ephemeral()
        }
        warn(
            'rebuild',
            `身份文件内容不合法，已挪到 ${IDENTITY_FILE_NAME}${CORRUPT_SUFFIX} 并重建一个新设备号`,
            { dir },
        )
    }

    warn('unreadable', '身份文件反复读不出合法设备号，本次只在内存里保留设备号')
    return ephemeral()
}
