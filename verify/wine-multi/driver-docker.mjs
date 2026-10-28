// 真环境控制面：观察全部经 docker exec 落在同一个容器里 —— 同一个 WINEPREFIX、
// 同一份 identity.json、同一份 bdms.node，两个 serve 进程。
//
// 容器生命周期由 run.sh 负责（构建镜像 → docker cp 二进制 → 起 → 收尾），
// 这里只做「读日志 / 探活 / 杀进程」。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LOG_DIR = '/logs'
const IDENTITY_FILE = '/app/data/identity.json'
const NODE_WIN = '/opt/node-win/node.exe'

function toPort(value, label) {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 不是合法端口：${value}`)
    return port
}

export function createDockerDriver({ container, containerPorts, hostPorts }) {
    const servePorts = containerPorts.map(port => toPort(port, '容器内 serve 端口'))
    const publicPorts = hostPorts.map(port => toPort(port, '宿主端口'))
    if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error(`容器名不合法：${container}`)

    const docker = async (args) => {
        const { stdout } = await execFileAsync('docker', args, { maxBuffer: 32 * 1024 * 1024 })
        return stdout
    }
    const inContainer = script => docker(['exec', container, 'bash', '-lc', script])
    const pidFile = index => `${LOG_DIR}/serve-${servePorts[index]}.pid`
    const errFile = index => `${LOG_DIR}/serve-${servePorts[index]}.err`
    const outFile = index => `${LOG_DIR}/serve-${servePorts[index]}.out`

    async function readPid(index) {
        const text = (await inContainer(`cat ${pidFile(index)} 2>/dev/null || true`)).trim()
        return /^\d+$/.test(text) ? Number(text) : 0
    }

    /** Wine 下的 Windows 版 Node 打不开管道型 stdio，所以它的输出必须先落文件再 cat。 */
    async function wineNode(argsText) {
        const marker = `/tmp/verify-winnode-${process.pid}.txt`
        const out = await inContainer(`wine ${NODE_WIN} ${argsText} > ${marker} 2>&1; cat ${marker}; rm -f ${marker}`)
        return out.trim()
    }

    return {
        kind: 'docker',
        hostPorts: publicPorts,
        upstreamOrigin: null,
        container,
        servePorts,

        async start() {
            const state = (await docker(['inspect', '--format', '{{.State.Running}} {{.Config.Image}}', container])).trim()
            if (!state.startsWith('true ')) throw new Error(`容器 ${container} 没在运行（当前：${state || '未知'}）。请先执行 verify/wine-multi/run.sh。`)
        },

        async processes() {
            const rows = []
            for (const [index, port] of publicPorts.entries()) rows.push({ port, servePort: servePorts[index], pid: await readPid(index) })
            return rows
        },

        async environment() {
            const wine = (await inContainer('wine --version 2>&1 || true')).trim()
            const nodeWin = await wineNode('--version')
            const dockerVersion = (await docker(['version', '--format', '{{.Server.Version}}'])).trim()
            const image = (await docker(['inspect', '--format', '{{.Config.Image}}', container])).trim()
            const wineserver = (await inContainer("for p in /proc/[0-9]*; do [ -r \"$p/comm\" ] && cat \"$p/comm\"; done 2>/dev/null | grep -c wineserver || true")).trim()
            return {
                kind: 'docker',
                wine,
                nodeWin,
                nodeHost: process.version,
                dockerServer: dockerVersion,
                image,
                container,
                wineserverCount: Number(wineserver) || 0,
                sharedWinePrefix: true,
                sharedIdentityFile: IDENTITY_FILE,
                summary: `镜像 ${image || '?'} / ${wine || 'wine ?'} / Windows Node ${nodeWin || '?'} / 宿主 Node ${process.version} / Docker ${dockerVersion} / wineserver ${Number(wineserver) || 0} 个`,
            }
        },

        async processSnapshot() {
            const out = await inContainer('for p in /proc/[0-9]*; do [ -r "$p/comm" ] && cat "$p/comm"; done 2>/dev/null | sort | uniq -c')
            return out
                .split('\n')
                .map(line => line.trim())
                .filter(line => /node\.exe|wineserver/.test(line))
        },

        async healthz(index) {
            try {
                const response = await fetch(`http://127.0.0.1:${publicPorts[index]}/healthz`, { signal: AbortSignal.timeout(5000) })
                if (!response.ok) return null
                return await response.json()
            } catch {
                return null
            }
        },

        /** 返回没就绪的进程及最后一次失败的形态（refused = 没监听，timeout = 起了但不答话）。 */
        async waitForReady(timeoutMs) {
            const deadline = Date.now() + timeoutMs
            const pending = new Map(publicPorts.map((_, index) => [index, 'unknown']))
            while (pending.size && Date.now() < deadline) {
                for (const index of [...pending.keys()]) {
                    try {
                        const response = await fetch(`http://127.0.0.1:${publicPorts[index]}/healthz`, { signal: AbortSignal.timeout(4000) })
                        if (response.ok) pending.delete(index)
                        else pending.set(index, 'http')
                    } catch (error) {
                        pending.set(index, error?.name === 'TimeoutError' ? 'timeout' : 'refused')
                    }
                }
                if (pending.size) await new Promise(resolve => setTimeout(resolve, 2000))
            }
            return [...pending.entries()].map(([index, lastErrorKind]) => ({ index, lastErrorKind }))
        },

        async readLogText(index) {
            return inContainer(`cat ${outFile(index)} ${errFile(index)} 2>/dev/null || true`)
        },

        async stderrOf(index) {
            const text = await inContainer(`cat ${errFile(index)} 2>/dev/null || true`)
            return { bytes: text.length, tail: text.split('\n').filter(Boolean).slice(-8) }
        },

        async pidAlive(index) {
            const pid = await readPid(index)
            if (!pid) return false
            const out = await inContainer(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)
            return out.trim() === 'alive'
        },

        async killProcess(index) {
            const pid = await readPid(index)
            if (pid) await inContainer(`kill ${pid} 2>/dev/null || true`)
        },

        async readIdentityFile() {
            return inContainer(`cat ${IDENTITY_FILE} 2>/dev/null || true`)
        },

        teardown() {},
    }
}
