/**
 * browser/platform-win.ts — **Windows 差异的归集处**（2026-11-19，owner 令「做」/「在 win 上能用就行」）
 *
 * ## 定位（先说清楚它不是第二个 mac 移植）
 *
 * `platform.ts` 是 **darwin** 的归集处，本文件是 **win32** 的。两者**不共享实现**，
 * 只共享**形状**：`process.ts` 每个入口第一行做一次三向分派
 * （`win32 → 本文件` / `darwin → platform.ts` / 其余 → 原作 Linux 实现，逐字未动）。
 *
 * ⚠️ **Linux 与 macOS 才是主场**（owner 明言）。所以本文件的验收标准是
 *   「**在 Windows 上能用**」，不是「与 Linux 逐项等同」。凡是做不到等同的地方，
 *   一律**显式降级并让它在读数上看得见**，⛔ 不假装等同（见下方「三处降级」）。
 *
 * ## 与 macOS 的四处**结构性**差异（这些不是移植细节，是新问题）
 *
 * | # | 事项 | Linux / macOS | Windows |
 * |---|---|---|---|
 * | ① | 杀进程 | `SIGTERM` → 等 → `SIGKILL` | Node 的 `SIGTERM` 在 win32 上**就是** `TerminateProcess` ⇒ **没有优雅退出**，「先温和后强硬」这一层不存在 |
 * | ② | 进程树 | 子进程命令行里一般带 `--user-data-dir` ⇒ 按 profile 认领能认全 | **不保证**（renderer/GPU 未必带）⇒ 认领到主进程后要 `taskkill /T` 按树杀，否则留孤儿 renderer（= 2026-11-09 耗电事故的形态） |
 * | ③ | `--no-sandbox` | **必需**（容器内 Chrome 自身 sandbox 起不来 ⇒ 1.5s 自杀） | **⛔ 绝不能加** —— Windows 上没有那个故障，加上等于**主动拆掉用户的浏览器沙箱** |
 * | ④ | CPU/RSS 采样 | 读 `/proc/stat`（零成本） | 只能起子进程（PowerShell `Get-CimInstance`）⇒ **每 tick 每槽位几百毫秒**，看守自己会变成耗电来源 |
 *
 * ## 三处**显式降级**（都让它在读数上看得见，⛔ 不静默）
 *
 * 1. **不采样 CPU/RSS**（差异 ④）。`winSample` 返回 `sampled: false`，
 *    界面上渲染成 `cpu—/内存—`，而不是 `cpu0%/内存0M` —— 后者是「测了，很低」的
 *    **同形假读数**（D253「恒空读数器」同族）。看守在 Windows 上退化成
 *    **只验存活 + 租约超时/闲置**，那三条判据不依赖采样。
 * 2. **端口反查用 `netstat -ano`**（不是 `/proc/net/tcp`）。权限面比 Linux 弱：
 *    别人的进程可能查不到 ⇒ 回空，而空在调用方等价于「没人占」。真正的兜底是 CDP 探活。
 * 3. **进程认领靠一次 PowerShell 快照 + 1s 缓存**。不是每槽位起一个子进程
 *    （20 槽位会变成 20 次 PS，几秒钟只为算一个布尔量）。
 *
 * ## 为什么把「解析」与「取证」分开
 *
 * 凡是能从**字符串**判定对错的，一律做成**纯函数**（`parseNetstatListeners` /
 * `parseCimProcesses` / `winChromeCandidates`）。原因就是 v1.137.8 那次教训：
 * `process.platform` 在测试里改不了 ⇒ 写死平台的判据**在 Linux 上结构上判不了**，
 * 删掉整条 Windows 分支测试也照样全绿。⇒ 本文件里**所有判据都能在 Linux 上真跑**，
 * 只有 `execFileSync` 那几行薄包装不行（它们各自只用一条「失败方向」用例兜住）。
 */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** 当前是否 Windows（**纯函数**，测试可注入） */
export function isWin(platform: string = process.platform): boolean {
  return platform === 'win32'
}

/**
 * Windows 上 Chrome 的位置（按优先级）。
 *
 * 🔴 顺序有意义：
 *   ① `%LOCALAPPDATA%` —— **用户级安装（最常见！）**。Chrome 默认装在这里
 *      （`C:\Users\<u>\AppData\Local\Google\Chrome\Application\chrome.exe`），
 *      不是 Program Files。把它排第一能少一次无谓的存在性检查。
 *   ② `%ProgramFiles%` —— 全机安装（管理员装的）。
 *   ③ `%ProgramFiles(x86)%` —— 32 位安装（老机器/老镜像）。
 *   ④ Chromium 便携版常见落点。
 *   ⑤ **Microsoft Edge（最后兜底）** —— 见下方说明。
 *
 * ⚠️ **为什么把 Edge 放进来**：owner 的验收标准是「**在 win 上能用就行**」。
 *   Edge 是 Chromium 内核、支持同一套 CDP、且**每台 Windows 都预装** ⇒
 *   在没有 Chrome 的机器上，它让槽位**真的能跑起来**，而不是回一句「未找到 Chrome」。
 *   ⛔ 但它与 macOS 那次刻意排除的 Playwright 缓存**不是同一类**：
 *     那份是「自动化副本、不是用户的浏览器」；Edge 是**用户机器上真实存在的浏览器**。
 *   ✅ 所以回执里会印出**实际选中的路径** —— 选到 Edge 时用户一眼能看出来。
 */
export function winChromeCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const local = env.LOCALAPPDATA ?? ''
  const pf = env.ProgramFiles ?? ''
  const pf86 = env['ProgramFiles(x86)'] ?? ''
  const out = [
    local !== '' ? join(local, 'Google/Chrome/Application/chrome.exe') : '',
    pf !== '' ? join(pf, 'Google/Chrome/Application/chrome.exe') : '',
    pf86 !== '' ? join(pf86, 'Google/Chrome/Application/chrome.exe') : '',
    local !== '' ? join(local, 'Chromium/Application/chrome.exe') : '',
    pf !== '' ? join(pf, 'Microsoft/Edge/Application/msedge.exe') : '',
    pf86 !== '' ? join(pf86, 'Microsoft/Edge/Application/msedge.exe') : '',
  ]
  return out.filter((p) => p !== '')
}

/**
 * 供错误回执印出「试过哪些路径」——**与环境变量无关的稳定形**。
 *
 * ⚠️ 与 `winChromeCandidates` 的差别只在于「用占位变量拼」而不是读当前 env：
 *   回执要能**在任何机器上**说清楚该往哪装，⛔ 不能因为本机没装 ProgramFiles 就少印一行。
 */
export const WIN_CHROME_CANDIDATES: readonly string[] = [
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe',
  '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** Windows 上找 Chrome/Edge；找不到 ⇒ `null`（⛔ 不猜、⛔ 不降级到假路径） */
export function winFindChrome(env: Record<string, string | undefined> = process.env): string | null {
  for (const p of winChromeCandidates(env)) if (existsSync(p)) return p
  return null
}

/**
 * 显示后端说明：Windows 走原生窗口（DWM），**不需要任何显示参数**。
 *
 * ⚠️ 与 macOS 同一条纪律：**刻意不加 `--headless`**。槽位的价值在于「人能在屏幕上看见它」；
 *   Windows 默认有窗口服务器 ⇒ 与 Linux 的 wayland/x11 分支**同语义**。
 *   ⛔ 不因为「这里没有 socket 概念」就静默退化成 headless —— 那会改变取证条件。
 */
export function winDisplayDetail(): string {
  return 'Windows 原生窗口（DWM；不需要 Wayland/X11 参数）'
}

/* ------------------------------------------------------------------ *
 * 纯解析器（Linux 上可判 —— 这是本文件判据的主体）
 * ------------------------------------------------------------------ */

/**
 * 从 `netstat -ano -p TCP` 的输出里取出**监听**某端口的 pid。
 *
 * 行形状（列间是空白，末列是 pid）：
 * ```
 *   TCP    127.0.0.1:9301         0.0.0.0:0              LISTENING       12345
 *   TCP    [::1]:9301             [::]:0                 LISTENING       12345
 * ```
 * 🔴 只认 `LISTENING`：`ESTABLISHED` 行里的本地端口也可能是 9301（我们自己的 CDP 连接），
 *   把它算成「占用者」会让 `launchSlot` 把自己刚建立的连接误判成「端口被别人的进程占着」。
 * 🔴 比对**末段冒号后的数字**，⛔ 不用 `includes(':9301')` —— 那会把 `:19301`、`:93010` 一起命中。
 */
export function parseNetstatListeners(text: string, port: number): number[] {
  const pids = new Set<number>()
  for (const raw of text.split('\n')) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 5) continue
    const proto = (cols[0] ?? '').toUpperCase()
    if (proto !== 'TCP') continue
    const state = (cols[3] ?? '').toUpperCase()
    if (state !== 'LISTENING') continue
    const local = cols[1] ?? ''
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    if (Number(local.slice(idx + 1)) !== port) continue
    const pid = Number(cols[4] ?? '')
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids].filter((p) => p !== process.pid)
}

/** 一条 PowerShell 进程快照记录（`Win32_Process` 的子集） */
export interface WinProcEntry {
  pid: number
  /** 命令行（无权读/系统进程可能是 `null`） */
  cmd: string
}

/**
 * 解析 `Get-CimInstance Win32_Process | Select ProcessId,CommandLine | ConvertTo-Json` 的输出。
 *
 * 🔴 两个必须处理的形状（都会真的出现）：
 *   ① **只有一条记录时 `ConvertTo-Json` 返回对象而不是数组** ⇒ 不归一化就会在 `.filter` 上炸；
 *   ② `CommandLine` 可能是 `null`（别人的/受保护进程）⇒ 不能直接 `.includes`。
 * 🔴 `ProcessId` 用 `Number()` 再校验整数：JSON 里是数字，但手抄夹具可能是字符串。
 */
export function parseCimProcesses(raw: string): WinProcEntry[] {
  if (raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: WinProcEntry[] = []
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue
    const rec = item as { ProcessId?: unknown; CommandLine?: unknown }
    const pid = Number(rec.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({ pid, cmd: typeof rec.CommandLine === 'string' ? rec.CommandLine : '' })
  }
  return out
}

/**
 * 从快照里挑出**命令行含本槽位 profile** 的 pid。
 *
 * 🔴 判据与 Linux/macOS **完全相同**（命令行里必须出现 `--user-data-dir=<本槽位专属>`）：
 *   ⛔ 绝不用「进程名叫 chrome.exe」当判据 —— 那会把**用户自己的浏览器**一起认领、一起杀掉
 *   （2026-11-09 事故差点犯的第二个错）。
 * ⚠️ **路径大小写**：Windows 大小写不敏感，而 Chrome 会把 `--user-data-dir` 的**盘符与首字母**
 *   规范化（实测常见 `C:\...` 与我们拼出来的 `c:\...` 不一致）⇒ 比对时必须 `toLowerCase()`。
 *   这一条**只在 Windows 上成立**，所以放在本文件、不进共用代码。
 */
export function pickPidsByProfile(entries: readonly WinProcEntry[], profileDir: string): number[] {
  if (profileDir === '') return []
  const needle = profileDir.toLowerCase()
  const out: number[] = []
  for (const e of entries) {
    if (e.pid === process.pid) continue // 必须排除自身（与 Linux 侧同一条纪律）
    if (e.cmd !== '' && e.cmd.toLowerCase().includes(needle)) out.push(e.pid)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 薄包装（I/O；每条只用一条「失败方向」用例兜住）
 * ------------------------------------------------------------------ */

/** PowerShell 可执行名（`windowsHide` 防闪窗；`-NoProfile` 防用户 profile 拖慢/污染） */
const PS = 'powershell.exe'

/**
 * 跑一段 PowerShell，成功返回 stdout，**任何失败一律返回 `null`**。
 *
 * 🔴 `[Console]::OutputEncoding` 必须显式设成 UTF8：中文 Windows 默认是 GBK/cp936，
 *   而命令行里常有**中文用户名路径**（`C:\Users\张三\…`）⇒ 不设就会拿到乱码，
 *   于是"认领"静默失败，且与"进程真的没了"在读数上同形。
 */
function runPs(script: string, timeoutMs = 8000): string | null {
  try {
    return execFileSync(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${script}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    )
  } catch {
    return null
  }
}

/**
 * 进程快照缓存（**1 秒 TTL**）。
 *
 * 🔴 为什么必须缓存：`browser_slot list` 会**逐槽位**调 `findPidsByProfile`。
 *   不缓存的话 20 个槽位 = 20 次 PowerShell（每次几百毫秒）⇒ 一次 list 要好几秒，
 *   而且那 20 份快照拍的是**同一个瞬间**，重复取毫无信息增益。
 * ⚠️ 1 秒是权衡：足够覆盖一次 list/一次看守 tick 的调用簇，又短到不会让
 *   「刚杀掉、立刻认领」读到陈旧名单（`killPidOutcome` 自己会轮询复检）。
 */
const SNAPSHOT_TTL_MS = 1000
let snapshotCache: { at: number; entries: WinProcEntry[] } | null = null

/** 取一次进程快照（含缓存） */
export function winProcessSnapshot(now = Date.now()): WinProcEntry[] {
  if (snapshotCache !== null && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.entries
  const raw = runPs('Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress')
  const entries = raw === null ? [] : parseCimProcesses(raw)
  snapshotCache = { at: now, entries }
  return entries
}

/** 清缓存（测试与「杀完之后立刻复认」用） */
export function resetWinSnapshotCache(): void {
  snapshotCache = null
}

/** 按 profile 认领 pid（Windows 版） */
export function winFindPidsByProfile(profileDir: string): number[] {
  if (profileDir === '') return []
  return pickPidsByProfile(winProcessSnapshot(), profileDir)
}

/** 某 pid 的命令行是否属于这个 profile（Windows 版；⛔ 供归因用，不是「杀谁」的依据） */
export function winPidClaimsProfile(pid: number, profileDir: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || profileDir === '') return false
  const found = winProcessSnapshot().find((e) => e.pid === pid)
  if (found === undefined) return false
  return found.cmd.toLowerCase().includes(profileDir.toLowerCase())
}

/**
 * 某端口的监听者 pid（`netstat -ano -p TCP`）。
 *
 * ⚠️ 降级已在上方文件头登记：别人的进程可能因权限查不到 ⇒ 回空，
 *   而空在调用方等价于「没人占」。兜底 = CDP 探活那一步。
 */
export function winPortHolders(port: number): number[] {
  let out: string
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
  } catch {
    return []
  }
  return parseNetstatListeners(out, port)
}

/**
 * 采样：**Windows 上刻意不采**（见文件头「三处显式降级 ①」）。
 *
 * `alive` 由调用方给的 pids 推出（**零额外成本** —— `findPidsByProfile` 已经跑过了）；
 * `cpuPct` / `rssMb` 固定 0 且 `sampled: false`，让界面渲染成「未测」而不是「很低」。
 */
export function winSample(pids: number[], now = Date.now()): { alive: boolean; cpuPct: number; rssMb: number; at: number; sampled: boolean } {
  return { alive: pids.length > 0, cpuPct: 0, rssMb: 0, at: now, sampled: false }
}

/**
 * 该 pid 是否活着。
 *
 * `process.kill(pid, 0)` 在 Windows 上由 libuv 实现为「打开进程句柄」——
 * 打不开即 ESRCH ⇒ 与 POSIX 同语义。`EPERM`（存在但无权）也算活着。
 * ⚠️ Windows 无「僵尸」概念（进程退出即回收句柄）⇒ 不存在 Linux 侧那个
 *   「`/proc/<pid>` 还在但已死」的坑。**这一格 Windows 比 Linux 简单**，如实登记。
 */
export function winIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 按**进程树**强杀（`taskkill /PID <pid> /T /F`）。
 *
 * 🔴 为什么必须有它（差异 ②）：Windows 上 Chrome 的 renderer/GPU 子进程**不保证**
 *   命令行里带 `--user-data-dir` ⇒ 按 profile 认领可能只认到主进程。
 *   只杀主进程会留下**孤儿 renderer**，而它们继续占 CPU —— 那正是 2026-11-09 耗电事故的形态，
 *   且「进程少了但 CPU 还在」在读数上极难归因。
 * ⚠️ 用 `/F`（强制）是刻意的：见差异 ①，Windows 上本来就**没有优雅退出**这回事。
 *   回执三档语义不变（`killed`/`absent`/`denied`），只是「先温和后强硬」两层并成了一层。
 */
export function winKillTree(pid: number): WinKillOutcome {
  if (!Number.isInteger(pid) || pid <= 1) return 'absent'
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      windowsHide: true,
    })
    return 'killed'
  } catch (e) {
    // taskkill 的非 0 退出同时代表多种情况 ⇒ 用「我们还活着吗」再判一次，⛔ 不猜错误码文案
    const err = e as { status?: number; stdout?: string; stderr?: string }
    const said = `${err.stdout ?? ''}${err.stderr ?? ''}`.toLowerCase()
    if (said.includes('not found') || said.includes('没有找到') || err.status === 128) return 'absent'
    return winIsAlive(pid) ? 'denied' : 'absent'
  }
}

/**
 * `winKillTree` 的三档结果。
 *
 * 🔴 与 `process.ts` 的 `KillOutcome` **同形但独立声明** —— 理由与 `MacProcSample` 相同：
 *   反向 import 会造出 `process.ts ⇄ platform-win.ts` 的循环依赖，而循环依赖在打包后
 *   表现为「某个函数在某个时机 undefined」，**只在真机上炸**（本仓付过这类代价）。
 * ⚠️ 两处必须保持同形；改名/加档时**两边一起改**（`process.ts` 的类型注解会当场报错兜住）。
 */
export type WinKillOutcome = 'killed' | 'absent' | 'denied'
