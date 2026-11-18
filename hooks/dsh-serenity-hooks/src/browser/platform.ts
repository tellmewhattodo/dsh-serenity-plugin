/**
 * browser/platform.ts — **macOS 差异的唯一归集处**（2026-11-18，owner 令「需要兼容 mac」）
 *
 * ## 为什么要有这个文件
 *
 * 槽位实现原本**整个建立在 `/proc` 之上**（2026-11-09 那次耗电事故逼出来的设计）。
 * macOS 上这些**一个都不存在**：
 *
 * | 能力 | Linux 实现 | macOS |
 * |---|---|---|
 * | Chrome 可执行文件 | `/usr/bin/google-chrome` 等 6 条路径 | **一条都没有**（在 `.app/Contents/MacOS/` 下） |
 * | 显示后端 | Wayland / X11 socket | **都不要**（走 Cocoa） |
 * | 按 profile 认领进程 | 读 `/proc/<pid>/cmdline` | **无 `/proc`** |
 * | 端口占用反查 | `/proc/net/tcp` ＋ `/proc/<pid>/fd` | **无 `/proc`** |
 * | CPU/RSS 采样 | `/proc/<pid>/stat` ＋ `/status` | **无 `/proc`** |
 *
 * ## 🔴 设计约束：**Linux 实现零搬迁**
 *
 * `process.ts` 那 850 行里，Linux 与 macOS **只在四个入口分岔**，其余（启动参数、
 * 杀进程三档、身份写盘、CDP 等待）**完全共用**。
 * ⇒ 本模块**只提供 macOS 那四件事**，`process.ts` 在原函数第一行做一次分派：
 *
 * ```ts
 * if (isMac()) return macFindPidsByProfile(profileDir)   // ← 新增
 * // ……原 Linux 实现，一行不改（本机测试跑的仍是它）
 * ```
 *
 * ⛔ **刻意不做的两件事**（都付过代价）：
 *  1. **不把 Linux 改成 `ps`**。「零依赖、不调 `ps`」是用事故换来的纪律
 *     （`ps` 的输出格式随版本/平台变，而 `/proc` 的字段是内核契约）。
 *  2. **不引入可变全局策略**。策略选择是**纯函数**（`isMac()` 读一次 `process.platform`），
 *     ⛔ 没有"注册/安装"那一层 —— 那会让测试之间互相污染（本仓已踩过此类）。
 *
 * ## macOS 侧为什么用子进程（如实登记，不粉饰）
 *
 * Darwin **没有**等价于 `/proc` 的内核接口：进程命令行要 `sysctl KERN_PROCARGS2`
 * （需原生模块），端口反查只能 `lsof`。⇒ **这是全项目唯一引入子进程的一处**。
 * 失败方向统一为**返回空集合**：不让"查不到"变成"槽位起不来"。
 *
 * ⚠️ **一处能力降级（不假装等同）**：`lsof` 对别人的端口可能因权限看不见 ⇒ 返回空，
 *   而空在调用方等价于"没人占" ⇒ macOS 上这条判据**比 Linux 弱**。
 *   真正的兜底是 CDP 探活那一步（连错实例会由 `webSocketDebuggerUrl` 判出来）。
 */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** 当前是否 macOS（**纯函数**，测试可注入） */
export function isMac(platform: string = process.platform): boolean {
  return platform === 'darwin'
}

/** 采样结果（与 `process.ts` 的 `ProcSample` 同形；独立声明以避免循环依赖） */
export interface MacProcSample {
  alive: boolean
  cpuPct: number
  rssMb: number
  at: number
  /** 累计 CPU 时间（**秒 × 1000** 的整数，避免浮点漂移）；Linux 侧同名字段是 ticks */
  ticks?: number
}

/**
 * macOS 上 Chrome 的位置（按优先级）。
 *
 * 🔴 顺序有意义：① 系统级 `/Applications` → ② 用户级 `~/Applications`（无管理员权限时装这里）
 *   → ③ Canary/Beta/Dev（开发者机器可能只有这些）→ ④ Chromium。
 *
 * ⚠️ **刻意不列 Playwright/Puppeteer 下载的那份**（`~/.cache/ms-playwright/…`）：
 *   它随工具升级换路径，且**不是用户的浏览器** —— 拿它冒充"找到 Chrome"会让人误判
 *   （以为自己登着用户的浏览器，实际是一个空 profile 的自动化副本）。
 */
export function macChromeCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME ?? ''
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    home !== '' ? join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') : '',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter((p) => p !== '')
}

/** 供错误回执印出"试过哪些路径"（`HOME` 无关的稳定版） */
export const MAC_CHROME_CANDIDATES: readonly string[] = macChromeCandidates({ HOME: '' })

/** macOS 上找 Chrome；找不到 ⇒ `null`（⛔ 不猜、不降级到 headless 假路径） */
export function macFindChrome(env: Record<string, string | undefined> = process.env): string | null {
  for (const p of macChromeCandidates(env)) if (existsSync(p)) return p
  return null
}

/**
 * macOS 显示后端参数：**空**（Chrome 走 Cocoa，不需要 Wayland/X11 参数）。
 *
 * ⚠️ 刻意**不加 `--headless`**：槽位的价值在于"人能在屏幕上看见它"，
 *   macOS 默认有窗口服务器 ⇒ 与 Linux 的 wayland/x11 分支**同语义**，
 *   ⛔ 不因为"没有 socket"就静默退化成 headless（那会改变取证条件）。
 */
export function macDisplayDetail(): string {
  return 'macOS 原生窗口（Cocoa；不需要 Wayland/X11 参数）'
}

/**
 * 按 profile 目录找 Chrome pid。
 *
 * 🔴 判据与 Linux 侧**完全相同**：命令行里必须出现**本槽位专属的** `--user-data-dir` 路径。
 *   ⛔ 绝不用 `pgrep chrome` —— 那会连**用户自己的浏览器**一起杀掉（2026-11-09 事故差点犯的第二个错）。
 *
 * ⚠️ **`ps -ww` 的 `-ww` 不可省**：不加它 `ps` 按终端宽度**截断**命令行，
 *   而 `--user-data-dir=<长路径>` 往往正好在被截掉的尾部 ⇒ 认领**静默失败**，
 *   且表现与"进程真的没了"在读数上同形。
 */
export function macFindPidsByProfile(profileDir: string): number[] {
  if (profileDir === '') return []
  let out: string
  try {
    out = execFileSync('ps', ['-ww', '-Ao', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return []
  }
  const pids: number[] = []
  for (const line of out.split('\n')) {
    if (!line.includes(profileDir)) continue
    const m = /^\s*(\d+)\s/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    // 🔴 必须排除自身（与 Linux 侧同一条纪律）：本进程命令行里也可能带同一路径
    if (pid === process.pid) continue
    pids.push(pid)
  }
  return pids
}

/**
 * 某端口的监听者 pid（`lsof`）。
 *
 * ⚠️ 降级已在上方文件头登记：`lsof` 可能因权限看不见别人的端口 ⇒ 返回空。
 *   `lsof` 非 0 退出同时代表「没有匹配」与「没权限」，两者此处不可分。
 */
export function macPortHolders(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)
  } catch {
    return []
  }
}

/**
 * 解析 `ps -o time=` 的输出：`[[dd-]hh:]mm:ss[.cc]` → 秒。
 * 例：`00:01.23` ／ `12:34` ／ `01:02:03` ／ `2-03:04:05`。
 *
 * 🔴 **解析不出 ⇒ `null`，⛔ 不返回 0**：返回 0 会让"读不到"伪装成"CPU 很低"，
 *   而后者正是 2026-11-09 事故里我们**没能及时发现**的那个读数。
 */
export function parsePsTime(s: string): number | null {
  if (s === '') return null
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(s.trim())
  if (!m) return null
  const days = m[1] !== undefined ? Number(m[1]) : 0
  const hours = m[2] !== undefined ? Number(m[2]) : 0
  const mins = Number(m[3])
  const secs = Number(m[4])
  const frac = m[5] !== undefined ? Number(`0.${m[5]}`) : 0
  if (![days, hours, mins, secs, frac].every(Number.isFinite)) return null
  return days * 86400 + hours * 3600 + mins * 60 + secs + frac
}

/**
 * 采样（`ps -o time=,rss=`）。
 *
 * 🔴 与 Linux 侧**同一口径**：`time` 是**累计** CPU 时间（不是瞬时占比）⇒
 *   用两次采样的增量算占比。⛔ 不直接报 `%cpu`（那是"累计 ÷ 存活时长"：
 *   本仓事故里它给出 35.2%，而实际累计 12 小时 57 分 —— 判据量错了东西）。
 */
export function macSample(pids: number[], prev: MacProcSample | null, now = Date.now()): MacProcSample {
  let cpuSec = 0
  let rssKb = 0
  let anyAlive = false
  for (const pid of pids) {
    let out: string
    try {
      out = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      })
    } catch {
      continue // 该 pid 已退出
    }
    const line = out.trim()
    if (line === '') continue
    const parts = line.split(/\s+/)
    const sec = parsePsTime(parts[0] ?? '')
    if (sec === null) continue
    cpuSec += sec
    const rss = Number(parts[1] ?? '')
    if (Number.isFinite(rss)) rssKb += rss
    anyAlive = true
  }
  const ticks = Math.round(cpuSec * 1000)
  let cpuPct = 0
  if (prev && prev.alive && anyAlive && now > prev.at && prev.ticks !== undefined) {
    const dtSec = (now - prev.at) / 1000
    const dCpuSec = (ticks - prev.ticks) / 1000
    if (dtSec > 0 && dCpuSec >= 0) cpuPct = (dCpuSec / dtSec) * 100
  }
  return { alive: anyAlive, cpuPct, rssMb: rssKb / 1024, at: now, ticks }
}

/**
 * 某 pid 的**命令行是否属于**这个 profile（macOS 版 `pidClaimsProfile` 的判据来源）。
 *
 * 🔴 为什么要单独有它（2026-11-18 自查补漏）：`process.ts` 的 `pidClaimsProfile` 原实现在
 *   **没有 `/proc` 时直接 `catch → false`** ⇒ macOS 上**每一个 pid 都"不属于"本槽位**。
 *   而 `destroySlot` 用它的返回值决定"台账那条 pid 是不是陈旧/被污染"：
 *   `false` ⇒ 会印出「**台账那条记录是陈旧的或被污染**」—— 一句**在 mac 上恒假的话**。
 *   ⇒ 判据：**失败方向正确 ≠ 每条路径都正确**。`findPidsByProfile` 回空是安全的（不杀），
 *     但**归因文案**会替一个不存在的成因作证（D253「恒空读数器」同族）。
 *
 * ⚠️ `ps` 查不到该 pid ⇒ **false**（与 Linux 侧"读不到 = 不属于"同向，保守：不杀）。
 */
export function macPidClaimsProfile(pid: number, profileDir: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || profileDir === '') return false
  let out: string
  try {
    out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
  } catch {
    return false
  }
  return out.includes(profileDir)
}

/**
 * 该 pid 是否活着（`kill(pid, 0)` 语义）。
 *
 * 🔴 **不是"进程名存在"、也不是"目录存在"**（Linux 侧为此付过代价：僵尸进程会让
 *   `/proc/<pid>` 恒在，导致「杀掉了」被误判成「杀不动」）。
 * `EPERM` = 进程存在但无权发信号 ⇒ **仍算活着**（与 Linux 侧同口径）。
 */
export function macIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
