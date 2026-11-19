/**
 * browser/process.ts — 槽位 Chrome 进程的启动、探活、回收
 *
 * 🔴🔴 **本文件的每一行都源自一次真实事故**（2026-11-09）：
 *    我起了一个 headless Chrome 拍截图，做完没关。整机功耗异常、风扇转了很久，
 *    owner 要睡了才发现。**这不是"忘记"这个层面的问题** —— 它暴露的是：
 *    旧的 `browser` MSM **只提供 launch，不提供"谁负责关"**。
 *
 *    判据（本文件的设计原则）：
 *    1. **每个槽位必须有归属**（pid + 会话 id）——没有归属的进程无法被追责，也就无法被回收。
 *    2. **回收必须有两个入口**（主动 release ＋ 看守兜底）。只靠"用完自觉"就是没有机制，
 *       因为"忘了"不是异常，是**常态**。
 *    3. **进程必须能被独立杀死**（`--user-data-dir` 指向槽位专属目录 ⇒ 可按目录精确认领，
 *       不会误杀 user 自己的浏览器 —— 这是本次事故里我差点犯的第二个错）。
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  readlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { SLOT_RESOLUTION, slotPort, type SlotId, slotNumber, slotLabel } from './state.js'
import { slotsHomeDir } from './home.js'
import {
  isMac,
  macChromeCandidates,
  macDisplayDetail,
  macFindChrome,
  macFindPidsByProfile,
  macIsAlive,
  macPortHolders,
  macSample,
  macPidClaimsProfile,
  MAC_CHROME_CANDIDATES,
  type MacProcSample,
} from './platform.js'
import {
  isWin,
  winChromeCandidates,
  winDisplayDetail,
  winFindChrome,
  winFindPidsByProfile,
  winIsAlive,
  winKillTree,
  winPidClaimsProfile,
  winPortHolders,
  winSample,
  WIN_CHROME_CANDIDATES,
} from './platform-win.js'

/**
 * 平台的人话名（只用于**回执文案**，⛔ 不参与任何判定）。
 *
 * 🔴 为什么要有它（v1.137.8 的一处小疏漏）：原文案写的是
 *   `isMac() ? 'macOS' : process.platform` ⇒ 在 mac 上印 `macOS`，
 *   在 Windows 上会印出裸的 `win32` —— 而 `win32` 是 Node 的内部标识，
 *   不是用户认得的名字（他会去搜"win32 是什么系统"）。
 */
function platformLabel(platform: string = process.platform): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  return platform
}

/**
 * 槽位工作目录 —— **全局唯一，不跟着 CCC 走**。
 *
 * 🔴🔴 原实现是 `<CCC 根>/_tmp/browser-slots/`，而端口与 Chrome 进程是**全机唯一**的：
 *    两个 CCC 各自在自己的根下建 b1，都认为自己拥有 9301 ⇒ 抢同一个端口，
 *    而**没有任何读数会显示这件事**（两份台账都自洽）。
 *    ⇒ 判据：**资源的唯一性必须由状态载体的唯一性保证**。
 *
 * ⚠️ 副作用（如实登记）：profile **不再随 CCC 的 git 走**。这是刻意的 ——
 *    槽位 b1 今天给 A、明天给 B，若 profile 跟着 CCC 走就会有两份"b1 的登录态"，
 *    而那两份在读数上无法区分（你会以为自己登着，其实是另一个 profile）。
 */
export const SLOTS_DIR_NAME = 'serenity-browser-slots'

/** 一个槽位的目录布局（全部在**全局**家目录内） */
export interface SlotPaths {
  /** 槽位根目录 */
  home: string
  /** Chrome user-data-dir（**独立 profile** 的物理载体） */
  profile: string
  /**
   * 身份文件（owner 2026-11-10 要求「每个槽位的浏览器 profile 里加点标识」）。
   *
   * 🔴 它解决的问题：`user-data` 目录名只有 `b1`，而**谁在用 b1** 这个事实
   *    只存在于台账里。台账丢了/被别人读到一半 ⇒ 一个 Chrome 进程跑在 9301 上，
   *    你从它的 profile 里**看不出它属于哪个 CCC、哪个会话**。
   *    ⇒ 把身份**写进 profile 本身**：`chrome --user-data-dir` 被认领时能直接读到。
   * ⚠️ 它是**冗余**记录（权威仍在台账），作用是让"归属"这件事在进程侧也能被回答。
   */
  identity: string
  /** 截图落点 */
  shots: string
  /** Chrome stderr 日志 */
  log: string
  /** pid 文件（冗余记录，权威在台账） */
  pidFile: string
}

export function slotPaths(n: number, homeDir?: string): SlotPaths {
  const home = join(homeDir ?? slotsHomeDir(), slotLabel(n))
  return {
    home,
    profile: join(home, 'user-data'),
    identity: join(home, 'identity.json'),
    shots: join(home, 'shots'),
    log: join(home, 'chrome.log'),
    pidFile: join(home, 'pid'),
  }
}

/**
 * 一个槽位的身份（写进 `<槽位目录>/identity.json`）。
 *
 * 判据：**profile 侧也答得出"我是谁"** —— 只靠台账回答归属，会让"台账坏了"与
 * "槽位无主"在读数上同形（D253 同族：恒空读数器与真无数据同形）。
 */
export interface SlotIdentity {
  /** 槽位号 */
  slot: number
  /** 槽位标号（b1..b20） */
  label: string
  /** CDP 端口 */
  port: number
  /** 占用它的 CCC 根（空串 = 无归属） */
  cccRoot: string
  /** 占用它的 dsc 会话 id */
  sessionId: string
  /** 占用它的轨迹目录名 */
  trajectory: string
  /** 租出时刻（ms） */
  leasedAt: number
  /** 写入时刻（ms）—— 用来判断这份身份有多旧 */
  writtenAt: number
}

/** 读槽位身份（不存在/损坏 ⇒ null，⛔ 不抛） */
export function readSlotIdentity(n: number, homeDir?: string): SlotIdentity | null {
  const p = slotPaths(n, homeDir).identity
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<SlotIdentity>
    if (!raw || typeof raw !== 'object') return null
    return {
      slot: Number(raw.slot) || n,
      label: typeof raw.label === 'string' ? raw.label : slotLabel(n),
      port: Number(raw.port) || slotPort(n),
      cccRoot: typeof raw.cccRoot === 'string' ? raw.cccRoot : '',
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      trajectory: typeof raw.trajectory === 'string' ? raw.trajectory : '',
      leasedAt: Number(raw.leasedAt) || 0,
      writtenAt: Number(raw.writtenAt) || 0,
    }
  } catch {
    return null
  }
}

/**
 * 写槽位身份（**原子写**：temp → rename）。
 *
 * ⚠️ 与台账同一个纪律：**只写事实，不写状态** —— 状态由 `state.ts` 现算。
 *    这里写的是"这个 profile 属于谁"，那是**租出那一刻的事实**，不会随闲置时长变化。
 */
export function writeSlotIdentity(ident: SlotIdentity, homeDir?: string): void {
  const p = slotPaths(ident.slot, homeDir).identity
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify({ ...ident, writtenAt: Date.now() }, null, 2), 'utf8')
  renameSync(tmp, p)
}

/** 释放时清掉身份（⛔ 保留 profile 本身 —— 登录态是槽位的资产） */
export function clearSlotIdentity(n: number, homeDir?: string): void {
  rmSync(slotPaths(n, homeDir).identity, { force: true })
}

/**
 * 挑 Chrome 可执行文件。
 *
 * ⚠️ 顺序有意义：本机 snap 版 Chromium 对所有 profile 加了 AppArmor 限制
 * （`~/snap/chromium/common/chromium` 之外不可写）⇒ 槽位 profile 若在 CCC 根内，
 * snap 版**会起不来或写不进去**。故优先用**非 snap** 的 google-chrome / chromium。
 */
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  // snap 兜底放最后（其对 user-data-dir 的约束更严）
  '/snap/bin/chromium',
]

/**
 * 找 Chrome。
 *
 * 🔴 **2026-11-18（owner 令「需要兼容 mac」）**：macOS 分派到 `platform.ts` ——
 *    那边的路径在 `.app/Contents/MacOS/` 下，与上面六条**一条都不重合**
 *    （原实现在 mac 上必然"未找到 Chrome"，而回执照样印 Linux 路径，把人指错方向）。
 * ⚠️ Linux 分支**逐字未改**。
 */
export function findChrome(): string | null {
  return findChromeFor(process.platform)
}

/**
 * 按平台找 Chrome（**平台可注入**，理由见 {@link chromeCandidatesFor}）。
 *
 * ⚠️ 这里的 `platform` 参数不只是为了测试：它是**让"mac 分支存在"这件事在 Linux 上可判**的唯一办法。
 *    否则删掉 mac 分支，Linux 上的测试**一条都不会红**。
 *
 * @param exists 可选存在性探针（测试用；生产是 `existsSync`）
 */
export function findChromeFor(
  platform: string,
  exists: (p: string) => boolean = existsSync,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (platform === 'darwin') {
    for (const p of macChromeCandidates(env)) if (exists(p)) return p
    return null
  }
  if (platform === 'win32') {
    for (const p of winChromeCandidates(env)) if (exists(p)) return p
    return null
  }
  for (const p of CHROME_CANDIDATES) if (exists(p)) return p
  return null
}

/** 错误回执要印出的候选路径（**按平台给**，⛔ 别在 mac 上印 Linux 路径） */
/**
 * 按平台选候选路径清单（**纯函数，平台可注入**）。
 *
 * 🔴🔴 **为什么要抽成纯函数**（2026-11-18，我在这里踩了一次）：
 *    第一版写成 `isMac() ? MAC : LINUX`，然后写测试断言"Linux 上不得印 .app 路径"——
 *    **变异把 `isMac()` 删掉后测试照样全绿**，因为本机是 Linux，两条分支**结果相同**。
 *    ⇒ 这正是本仓反复踩的「判据没有判别力」：`process.platform` 在测试里改不了，
 *      于是"平台分派"这件事**在 Linux 上永远读不出对错**。
 *    ⇒ 修法：把平台作为**参数**传进来，测试即可构造 `'darwin'` 走真分派。
 *    ⚠️ 生产调用点仍走默认参数（`process.platform`），行为零变化。
 *
 * 🆕 **2026-11-19 三向**（owner 令「做」/「在 win 上能用就行」）：加 `win32` 一支。
 *    Linux 与 darwin 两支**逐字未改**，只是 win32 分支插在它们之间。
 */
export function chromeCandidatesFor(
  platform: string = process.platform,
): readonly string[] {
  if (platform === 'darwin') return MAC_CHROME_CANDIDATES
  if (platform === 'win32') return WIN_CHROME_CANDIDATES
  return CHROME_CANDIDATES
}

/** 生产包装（默认当前平台） */
export function chromeCandidatesForMessage(): readonly string[] {
  return chromeCandidatesFor()
}

/**
 * 给子进程挑一个**能真的打开**的显示后端。
 *
 * 🔴🔴 **真机踩到的第一格**（2026-11-09 首次 LIVE 探针）：
 *    进程起得来（pid 有了、能被认领、能被杀），但 CDP **20 秒一声不响**。
 *    日志给出根因：
 *      `Authorization required, but no authorization protocol specified`
 *      `Missing X server or $DISPLAY`
 *      `The platform failed to initialize.  Exiting.`
 *    ⇒ 这台机器是 **Wayland**（`gnome-shell --mode=ubuntu`），`:0` 是 Xwayland 的 socket
 *      且需要 `XAUTHORITY`；而 `{...process.env}` 里**没有**那份授权
 *      ⇒ Chrome 连显示层都初始化不了 ⇒ 直接退出。
 *
 * 🔴 **判据（这条比修法更值钱）**：**"进程起来了"与"它能工作"之间隔着显示层。**
 *    我的 `launchSlot` 原样继承了 `DISPLAY ?? ':0'` 就把 env 传下去了 ——
 *    那在宿主机自己的 shell 里成立，在**从服务进程 fork 出来的上下文里不成立**。
 *
 * 修法（按优先级）：
 *   ① 有 Wayland socket ⇒ 走 `--ozone-platform=wayland`（这台机器的真实形态，不需要 X 授权）
 *   ② 否则有 X socket ⇒ 走 X，并把 `XAUTHORITY` 指到用户目录下的 `.Xauthority`
 *   ③ 都没有 ⇒ 退 `--headless=new`（无显示也能跑，取证截图仍然可用）
 */
export interface DisplayChoice {
  args: string[]
  env: Record<string, string | undefined>
  /**
   * 选中的后端（诊断用）。
   * `cocoa` = macOS 原生窗口；`native` = Windows 原生窗口（DWM）。
   * 🔴 两者**刻意不合并成 `native`**：回执要说清是哪个平台的原生栈，
   *    否则「为什么这台 mac 上没有 `--ozone-platform` 参数」又要重查一遍。
   */
  backend: 'wayland' | 'x11' | 'cocoa' | 'native' | 'headless'
  /** 人话说明（进日志/回执，别让下一个我重查一遍） */
  detail: string
}

/**
 * 文件系统探针（**唯一的测试注入点**）。
 *
 * 🔴🔴 **为什么要开这个缝**（2026-11-09，这一格付出了两次代价）：
 *    `resolveDisplay` 的输入一半来自 env、一半来自**文件系统**（wayland socket / X socket）。
 *    只改 env 的测试**判不了后端**：它只能断言"结果 ∈ {wayland,x11,headless}"，
 *    而那在一台真机上**恒真** ⇒ 我把 wayland 分支改成 `if (false && …)` 后
 *    `--filter browser-slot-process` **仍 18/18 全绿**。这就是假绿（D254 同族：判据没有判别力）。
 *    同理，若判据写死依赖本机有 `/tmp/.X11-unix/X0`，换一台机器（CI / 容器）就**结构上判不了** x11，
 *    而"判不了"会伪装成"通过"。
 *
 *    ⇒ 把**存在性判断**做成可注入的，默认仍是 `existsSync`（生产行为零变化），
 *    测试即可构造三档确定输入：只有 wayland / 只有 X / 都没有，并**逐档钉死后端**。
 */
export interface DisplayProbe {
  /** 路径是否存在（默认 `existsSync`；仅测试替换） */
  exists?: (p: string) => boolean
}

export function resolveDisplay(
  env: Record<string, string | undefined> = process.env,
  probe: DisplayProbe = {},
  platform: string = process.platform,
): DisplayChoice {
  // 🔴 **2026-11-18：macOS 分支**（owner 令「需要兼容 mac」）。
  //    macOS 用的是 Cocoa，**没有 Wayland/X11 socket** ⇒ 原实现在 mac 上必然落到
  //    `headless` 那一支，而那是**静默降级**：页面还能求值、截图也出得来，
  //    但"人能在屏幕上看见它"这件槽位价值没了，且回执照样写"无显示服务"（一句假话）。
  // ⚠️ `platform` 是**可注入参数**（理由见 `chromeCandidatesFor`）：否则 mac 分支
  //    在 Linux 上永远读不出对错，删掉它测试也不会红。
  // ⚠️ Linux 分支（下面）逐字未改。
  if (platform === 'darwin') {
    return { args: [], env: { ...env }, backend: 'cocoa', detail: macDisplayDetail() }
  }
  // 🔴 **2026-11-19：Windows 分支**（owner 令「做」/「在 win 上能用就行」）。
  //    Windows 走原生窗口（DWM），同样**没有** Wayland/X11 socket ⇒ 不加这一支，
  //    原实现会落到下面的 `headless` 兜底 —— 而那与 macOS 那次的失效形态**一模一样**：
  //    页面求值/截图都还能用，但"人能在屏幕上看见它"这件槽位价值没了，
  //    回执照样写「无显示服务」（一句在 Windows 上恒假的话）。
  // ⚠️ 同样刻意**不加 `--headless`**，理由与 macOS 分支同。
  if (platform === 'win32') {
    return { args: [], env: { ...env }, backend: 'native', detail: winDisplayDetail() }
  }
  const exists = probe.exists ?? existsSync
  const uid = process.getuid?.() ?? 1000
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`
  const wayland = env.WAYLAND_DISPLAY ?? 'wayland-0'
  const waylandPath = wayland.startsWith('/') ? wayland : join(runtimeDir, wayland)
  const xSocket = exists('/tmp/.X11-unix/X0') ? '/tmp/.X11-unix/X0' : null
  const xauth = env.XAUTHORITY ?? join(env.HOME ?? `/home/${env.USER ?? 'user'}`, '.Xauthority')

  if (exists(waylandPath)) {
    return {
      args: ['--ozone-platform=wayland', `--wayland-socket-path=${waylandPath}`],
      env: { ...env, XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: wayland },
      backend: 'wayland',
      detail: `Wayland（${waylandPath}）`,
    }
  }
  if (xSocket) {
    return {
      args: ['--ozone-platform=x11'],
      env: { ...env, DISPLAY: env.DISPLAY ?? ':0', XAUTHORITY: xauth },
      backend: 'x11',
      detail: `X11（:0），XAUTHORITY=${xauth}`,
    }
  }
  return {
    args: ['--headless=new'],
    env: { ...env },
    backend: 'headless',
    detail: '无显示服务 ⇒ headless=new（截图/求值仍可用；⚠️ 该模式下页面没有可见性概念）',
  }
}

/**
 * 启动参数。
 *
 * 🔴 逐条都有理由，⛔ 不要"精简"：
 * - `--user-data-dir=<槽位专属>`：独立 profile 的物理实现；也是**按目录精确杀进程**的锚点
 * - `--remote-debugging-port=<槽位端口>`：CDP 入口（9301+ 起，避开既有 9222 段）
 * - `--remote-allow-origins=*`：缺了它 WS 握手会被 Origin 校验挡掉（tg 侧实测需要；pg 侧没有，
 *   两者只在这一点上不同）。带上更省事，且槽位只绑 127.0.0.1。
 * - `--no-first-run` / `--no-default-browser-check`：否则首启会弹窗并**卡住等交互**
 * - `--no-sandbox`：🔴 **必需**。容器内 Chrome 自身 sandbox 初始化会失败
 *   （`Failed to initialize sandbox: Operation not permitted` ⇒ GPU 进程崩 ⇒
 *   `FATAL: GPU process isn't usable. Goodbye.` ⇒ **约 1.5s 后自杀**）。
 *   这一条的权威副本在 `tg-browser-pool/references/known-bugs.md`；**删掉它即回归**。
 * - `--disable-dev-shm-usage`：容器 `/dev/shm` 通常只有 64MB ⇒ 不关会随机崩
 *
 * 🔴🔴 **刻意不加的两个 flag（这是耗电事故的直接经验）**：
 *   ⛔ `--disable-renderer-backgrounding`
 *   ⛔ `--disable-backgrounding-occluded-windows`
 *   这两个名字听起来"对后台更友好"，实际含义正好相反 —— 它们**禁止**浏览器把
 *   后台/被遮挡的窗口降速 ⇒ 一个被遗忘的标签页会**全速**渲染。
 *   本仓 2026-11-09 事故里，那个页面在后台以 60fps 跑了 36 小时、累计 CPU 12h57m。
 *   ⇒ 我们要的是**允许**它节流，所以这两个 flag 一个都不能有。
 *   （同理 `--disable-background-timer-throttling` 也不加。）
 *
 * ⚠️ 同样刻意**不用** `--disable-gpu`：Chrome 的 GPU 进程崩溃是这次实打实的死因，
 *   但关掉 GPU 会让截图与 3D 页面拿到不同的渲染路径（软件光栅化）⇒ **取证条件变了**。
 *   两条实现都保留 GPU（只用 `--no-sandbox` 解决 sandbox 问题），本实现跟随。
 *
 * 🔴🔴 **`--no-sandbox` 与 `--disable-dev-shm-usage` 是 Linux 专属**（v1.137.10，2026-11-19）。
 *
 *   这两条都**不是**"为了跨平台统一"的通用参数，它们的成因**只存在于 Linux**：
 *   - `--no-sandbox`：容器内 Chrome 自身 sandbox 初始化失败（`Operation not permitted`）。
 *     macOS / Windows 上**没有这个故障** ⇒ 在那里加上它等于**主动拆掉用户的浏览器沙箱**，
 *     把一个本可以正常工作的安全边界关掉，且**没有任何收益**。
 *   - `--disable-dev-shm-usage`：容器 `/dev/shm` 只有 64MB。Windows 上没有 `/dev/shm` 这回事。
 *
 *   ⇒ 判据：**平台专属的参数必须按平台给，⛔ 不能因为"统一"就全局带上。**
 *     这是本轨迹里"删值 = 删契约"的**反面**：这里是"**带值 = 造不存在的契约**"。
 *   ⚠️ macOS 上原实现同样带着这两条（v1.137.8 没动它，那版只把启动跑通）；
 *     本次**一并修正**：mac 上也不再带 `--no-sandbox`。
 *     🔴 **这是一处行为变更，不是纯重构** —— 它在 mac 上是**变好**（沙箱回来了），
 *        但属于"mac 上从未真机验过"的那一格里，所以只改参数、**不改那段诚实边界声明**。
 */
export function buildArgs(
  n: number,
  paths: SlotPaths,
  display?: DisplayChoice,
  platform: string = process.platform,
): string[] {
  const { width, height } = SLOT_RESOLUTION(n)
  const disp = display ?? resolveDisplay(process.env, {}, platform)
  // Linux 专属的两条（见上方注释）：容器内 sandbox 起不来 + /dev/shm 只有 64MB。
  const linuxOnly = platform === 'win32' || platform === 'darwin' ? [] : ['--no-sandbox', '--disable-dev-shm-usage']
  return [
    `--user-data-dir=${paths.profile}`,
    `--remote-debugging-port=${slotPort(n)}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    ...disp.args,
    '--no-first-run',
    '--no-default-browser-check',
    ...linuxOnly,
    '--disable-extensions',
    `--force-device-scale-factor=1`,
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    '--hide-scrollbars',
    'about:blank',
  ]
}

/** 启动结果 */
export interface LaunchResult {
  ok: boolean
  pid: number
  detail: string
}

/**
 * 启动一个槽位（**不等待 CDP 就绪** —— 就绪判定走 {@link waitCdp}，与既有实现同款纪律：
 * `launch` 立即返回，不让调用方卡在一个可能永远不返回的等待上）。
 *
 * 🔴 v1.129.0：签名里**删掉了 `root`** —— 它曾是一个**完全没被读过**的参数
 *    （槽位目录已全局化，见 `home.ts`）。留着一个不读的参数是**声明与行为分叉**：
 *    下一个人读签名会以为"启动是跟着某个 CCC 走的"，而事实相反（D289 同族）。
 */
export function launchSlot(n: number): LaunchResult {
  const chrome = findChrome()
  if (!chrome) {
    return {
      ok: false,
      pid: 0,
      detail:
        '未找到 Chrome/Chromium（平台：' + platformLabel() + '）。候选路径：'
        + chromeCandidatesForMessage().join(' / ') + '\n'
        + '  ⇒ 装一个 Chrome，或把路径加入上面任一位置。',
    }
  }
  const paths = slotPaths(n)
  if (!existsSync(paths.home)) mkdirSync(paths.home, { recursive: true })
  if (!existsSync(paths.profile)) mkdirSync(paths.profile, { recursive: true })
  if (!existsSync(paths.shots)) mkdirSync(paths.shots, { recursive: true })

  // 🔴 启动前先按 profile 目录扫一遍残留：同一 profile 被两个 Chrome 同时用会**互相破坏**，
  //    而 Chrome 自己只会打印一行警告然后继续 —— 那种损坏是静默的。
  const leftovers = findPidsByProfile(paths.profile)
  for (const pid of leftovers) killPid(pid)

  // 🔴🔴 **"不可达 ≠ 空闲"**（这条判据抄自 pg 的 `scripts/cdp.ts`，是它最值钱的一处）：
  //    端口可能被一个**残留但 CDP 不通**的实例占着。此时直接 spawn 会得到
  //    **两个 Chrome 抢同一个端口** —— 后起的那个要么静默失败，要么绑到 `[::1]`，
  //    而调用方以为自己在跟"自己起的那个"说话。
  //    判据：解析不出 pid 时**拒绝启动**，⛔ 不盲目再起一个。
  const holders = portHolders(slotPort(n))
  if (holders.length > 0) {
    for (const pid of holders) killPid(pid)
    const still = portHolders(slotPort(n))
    if (still.length > 0) {
      return {
        ok: false,
        pid: 0,
        detail:
          `端口 ${slotPort(n)} 仍被占用（pid ${still.join(',')}）⇒ ⛔ 拒绝盲目再起一个 Chrome。\n` +
          `  ⚠️ 直接 spawn 会得到两个实例抢同一端口，而它们**在读数上分不开**。\n` +
          `  ⇒ 手工确认后重试，或换一个槽位。`,
      }
    }
  }

  const out = openSync(paths.log, 'a')
  try {
    const disp = resolveDisplay()
    const child = spawn(chrome, buildArgs(n, paths, disp), {
      detached: true,
      stdio: ['ignore', out, out],
      env: disp.env,
      // 🔴 Windows 专属：不加它，从服务进程 spawn Chrome 会**弹出控制台窗口**，
      //    且那个窗口会抢焦点（槽位是给"人能在屏幕上看见"用的，但不能把用户的焦点抢走）。
      windowsHide: true,
    })
    child.unref()
    const pid = child.pid ?? 0
    if (pid > 0) writeFileSync(paths.pidFile, String(pid), 'utf8')
    return {
      ok: pid > 0,
      pid,
      detail:
        pid > 0
          ? `已启动 ${chrome}（pid ${pid}，端口 ${slotPort(n)}，显示后端 ${disp.detail}）`
          : 'spawn 未返回 pid',
    }
  } finally {
    closeSync(out)
  }
}

/**
 * 找**监听**某端口的全部 pid。
 *
 * 🔴 为什么不用 `lsof`/`ss` 子进程：本仓的 `sys` 白名单不含它们（且 `lsof` 在部分镜像里没有）。
 *    走 `/proc/net/tcp` + `/proc/<pid>/fd` 反查，零依赖、零子进程。
 *
 * ⚠️ 与既有两支护实现的差别（它们只杀 `head -1` / 第一个 pid）：
 *    端口被**多个**进程持有是可能的（父子/多个 fd），只杀一个会留下残骸。
 *    本实现返回**全部**。
 */
export function portHolders(port: number): number[] {
  // 🔴 2026-11-18：macOS 走 `lsof`（Darwin 无 `/proc`）。⚠️ 能力降级已在 platform.ts 头注登记。
  if (isMac()) return macPortHolders(port)
  // 🔴 2026-11-19：Windows 走 `netstat -ano`（无 `/proc`；且 win32 无 POSIX socket inode）。
  //    ⚠️ 权限面比 Linux 弱（别人的进程可能查不到 ⇒ 回空），已在 platform-win.ts 头注登记。
  if (isWin()) return winPortHolders(port)
  // ① 从 /proc/net/tcp{,6} 找 inode：LISTEN 状态 = 0A
  const inodes = new Set<string>()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      const local = cols[1] ?? ''
      const st = cols[3] ?? ''
      const inode = cols[9] ?? ''
      if (st !== '0A') continue // 0A = TCP_LISTEN
      const portHex = local.split(':')[1] ?? ''
      if (Number.parseInt(portHex, 16) === port && inode !== '0') inodes.add(inode)
    }
  }
  if (inodes.size === 0) return []

  // ② 反查哪些进程持有这些 socket inode
  const pids: number[] = []
  let entries: string[]
  try {
    entries = readdirSync('/proc') as string[]
  } catch {
    return []
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${name}/fd`) as string[]
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = require_readlink(`/proc/${name}/fd/${fd}`)
      } catch {
        continue
      }
      const m = /^socket:\[(\d+)\]$/.exec(target)
      if (m && inodes.has(m[1]!)) {
        pids.push(Number(name))
        break
      }
    }
  }
  // 排除自身（本进程不会监听槽位端口，但留着这层判断防止将来误伤）
  return pids.filter((p) => p !== process.pid)
}

/** readlink 的薄包装（保持 zero-dep，且便于测试替换） */
function require_readlink(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return readlinkSync(p)
}

/**
 * 按 **profile 目录**找出所有指向它的 chrome pid。
 *
 * 🔴 这是"精确认领"的核心：`pgrep chrome` 会连 **user 自己的浏览器**一起杀掉。
 *    本次事故里我差点犯这个错 —— 屏幕上有 36 小时的 renderer 是 user 的窗口，
 *    而我只该杀自己起的那些。判据 = 命令行里带**本槽位专属的** `--user-data-dir`。
 *
 * 实现走 `/proc`（零依赖，不调 ps）：读 cmdline 匹配。
 */
export function findPidsByProfile(profileDir: string): number[] {
  if (!profileDir) return []
  // 🔴 2026-11-18：macOS 走 `ps -ww`（Darwin 无 `/proc`）。
  //    ⚠️ `-ww` 不可省 —— 不加它命令行被终端宽度截断，而 `--user-data-dir=<长路径>`
  //       往往正好在被截掉的尾部 ⇒ 认领静默失败，且与"进程真的没了"同形。
  if (isMac()) return macFindPidsByProfile(profileDir)
  // 🔴 2026-11-19：Windows 走一次 PowerShell 进程快照（含 1s 缓存，见 platform-win.ts）。
  //    ⚠️ 路径比对必须**大小写不敏感**（Chrome 会把盘符/首字母规范化），该判据在 platform-win 里。
  //    ⚠️ 子进程（renderer/GPU）**不保证**命令行带 `--user-data-dir` ⇒ 认领可能只认到主进程，
  //       所以回收必须走 `taskkill /T`（见 destroySlot 与 platform-win 的 winKillTree）。
  if (isWin()) return winFindPidsByProfile(profileDir)
  const pids: number[] = []
  let names: string[]
  try {
    names = readdirSync('/proc') as string[]
  } catch {
    return pids
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    // 🔴 必须排除自身：本进程的命令行里也可能带有那个路径字符串（例如它正拿着这个参数在测试）
    //    ⇒ 不排除就会把**自己**当成浏览器杀掉。这是"认领"这件事上最贵的一次误判。
    if (pid === process.pid) continue
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8')
      if (cmd.includes(profileDir)) pids.push(pid)
    } catch {
      /* 进程已退出或无权读 ⇒ 跳过 */
    }
  }
  return pids
}

/** 读一个 pid 的进程树聚合读数（CPU% / RSS MB），走 /proc（不依赖 ps 的 pcpu 语义） */
export interface ProcSample {
  alive: boolean
  /** **瞬时** CPU 占比（不是 ps 的累计均值）*/
  cpuPct: number
  rssMb: number
  /** 采样时刻（ms） */
  at: number
  /**
   * 这次读数**是否真的采到了**资源量（CPU/RSS）。
   *
   * 🔴 为什么要这个字段（2026-11-19，v1.137.10）：Windows 上**刻意不采样**（成本见
   *   {@link sampleProcTree} 的 win32 分支）。若不给这个字段，`cpuPct: 0 / rssMb: 0`
   *   会在界面上渲染成 `cpu0% 内存0M` —— 与「测了，确实很低」**完全同形**。
   *   ⇒ 判据（D253 家族）：**「没测」必须与「测了是 0」在读数上分得开。**
   * `undefined` 视为 `true`（Linux/macOS 一直在采，历史调用方不必改）。
   */
  sampled?: boolean
}

/**
 * 采一次样。
 *
 * 🔴🔴 **为什么不用 `ps -o pcpu`**：那是 **累计 CPU ÷ 存活时长**。本次事故里它给出
 *    `35.2%` —— 听起来还好，实际含义是"36 小时里平均烧掉 1/3 个核"，**累计 12 小时 57 分**。
 *    一个刚空转 10 秒的进程和一个空转 36 小时的进程，在 pcpu 上**可能读数是同一个值**。
 *
 *    ⇒ 正确口径 = **两次采样之间的增量**（Δutime+Δstime ÷ Δt）。这需要保存上一次采样，
 *    故 {@link sampleProcTree} 接受 `prev` 并返回本次样本供下次用。
 */
export function sampleProcTree(pids: number[], prev: ProcSample | null, now = Date.now()): ProcSample {
  // 🔴 2026-11-18：macOS 走 `ps -o time=,rss=`（Darwin 无 `/proc`）。
  //    口径与下面 Linux 分支**相同**：累计 CPU 时间的增量，⛔ 不是 `%cpu`（累计÷存活时长）。
  if (isMac()) return macSample(pids, (prev as MacProcSample | null) ?? null, now) as ProcSample
  // 🔴 2026-11-19：Windows **刻意不采样**（owner 令「在 win 上能用就行」＋ 成本实测）。
  //    为什么不做：Windows 上拿累计 CPU 时间只能起子进程
  //    （`Get-CimInstance Win32_PerfRawData_PerfProc_Process` ／ `Get-Process`，每次几百毫秒），
  //    而看守是**每 tick × 每槽位**都要读一次 ⇒ 采样本身会变成耗电来源，
  //    正是 2026-11-09 事故要防的那一类。
  //    ⇒ 退化成「只验存活」（`alive` 由调用方已算出的 pids 推出，零额外成本），
  //      并把 `sampled: false` **一路带到界面上渲染成 `cpu—`**，
  //      ⛔ 绝不能让它渲染成 `cpu0%` —— 那是「测了，很低」的同形假读数（D253 同族）。
  //    ⚠️ 后果（如实登记）：Windows 上**没有 CPU/内存两条看守判据**，
  //      仍有效的三条 = 进程存活 ／ 闲置超时 ／ 租约超时。
  if (isWin()) return winSample(pids, now) as ProcSample
  let ticks = 0
  let rssKb = 0
  let anyAlive = false
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // comm 里可能有空格/括号 ⇒ 从最后一个 ')' 之后再切
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      // after[0]=state, [11]=utime, [12]=stime（相对 after 的下标；原字段 14/15）
      const utime = Number(after[11]) || 0
      const stime = Number(after[12]) || 0
      ticks += utime + stime
      anyAlive = true
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(status)
      if (m) rssKb += Number(m[1])
    } catch {
      /* 这一 pid 已退出 */
    }
  }
  const HZ = 100 // Linux 默认 USER_HZ
  let cpuPct = 0
  if (prev && prev.alive && anyAlive && now > prev.at) {
    const dtSec = (now - prev.at) / 1000
    // prev 里有上一次的 ticks —— 通过扩展字段传递
    const prevTicks = (prev as ProcSample & { ticks?: number }).ticks ?? 0
    const dtTicks = ticks - prevTicks
    if (dtSec > 0 && dtTicks >= 0) cpuPct = (dtTicks / HZ / dtSec) * 100
  }
  const out: ProcSample & { ticks?: number } = {
    alive: anyAlive,
    cpuPct,
    rssMb: rssKb / 1024,
    at: now,
    ticks,
    sampled: true,
  }
  return out
}

/**
 * 杀一个 pid（先 TERM，给 1.5s 收尾，再 KILL）。
 *
 * 🔴🔴 **返回值必须是三档，不能是 boolean**（2026-11-10 真机实测逼出来的）：
 *    原版在 `process.kill` 抛错时直接 `return true`，注释写的是"已经不在了"——
 *    但 `catch` 也会接住 **EPERM**（进程存在、但我们没权限）与 **EINVAL**（pid 非法）。
 *    ⇒ 「我杀掉了它」与「它本来就不在」与「它在但我杀不动」在读数上全是 `true`。
 *
 *    实测代价：台账被测试夹具污染成 `{pid: 4242}`，而 `/proc/4242` **根本不存在**，
 *    `reap` 的回执却写着「已回收 1 个进程（4242）」—— 于是那条清理记录**是假的**，
 *    下一个人会以为真有过一个浏览器进程被收掉。
 *
 *    ⇒ 判据：**"我做了什么"与"我看到了什么"必须分开报**。
 *    这也是本仓反复出现的同一形状（D253「恒空读数器」/ D252「读了数 ≠ 读的是那个数」）。
 */
export type KillOutcome =
  /** 它确实存在，且现在没了 —— 是**我们杀的** */
  | 'killed'
  /** 我们动手之前它就已经不在了（ESRCH）⇒ ⛔ 不能记成"已回收" */
  | 'absent'
  /** 它存在但我们没权限/不能动（EPERM 等）⇒ 要如实说出来 */
  | 'denied'

export function killPidOutcome(pid: number, waitMs = 1500): KillOutcome {
  if (!Number.isInteger(pid) || pid <= 1) return 'absent'
  // 🔴 2026-11-19：Windows 走 `taskkill /T /F`（**按进程树**）。
  //    两个成因都在 platform-win.ts 头注里：① Windows 上 Node 的 SIGTERM 本来就是
  //    `TerminateProcess`，没有"优雅退出"这一层；② Chrome 的 renderer/GPU **不保证**
  //    命令行带 `--user-data-dir` ⇒ 只杀主进程会留下孤儿 renderer（= 耗电事故的形态，
  //    且「进程少了但 CPU 还在」在读数上极难归因）。
  //    ⚠️ 返回的三档语义与下面**完全一致**（`killed`/`absent`/`denied`），只是实现换成外部命令。
  if (isWin()) return winKillTree(pid)
  // 动手之前先定格"它本来在不在" —— 这是区分 killed 与 absent 的唯一依据
  const existedBefore = pidIsAlive(pid)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ESRCH') return 'absent'
    // ⚠️ 不是"已经不在"，而是"动不了" —— 必须与上面分开
    return existedBefore ? 'denied' : 'absent'
  }
  const waitGone = (ms: number): boolean => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!pidIsAlive(pid)) return true
      const until = Date.now() + 50
      while (Date.now() < until) {
        /* spin */
      }
    }
    return !pidIsAlive(pid)
  }
  if (waitGone(waitMs)) return 'killed'
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* SIGKILL 也可能因 ESRCH 失败（刚死）⇒ 下面统一复核 */
  }
  if (waitGone(500)) return 'killed'
  return 'denied'
}

/**
 * 一个 pid **是否还活着**（⛔ 不是"`/proc/<pid>` 存不存在"）。
 *
 * 🔴🔴 这两个在 Linux 上**不是同一件事**：进程死后若父进程还没 `wait()` 它，
 *    `/proc/<pid>` 会继续存在（**僵尸**，`stat` 的 state = `Z`）。
 *    实测代价（2026-11-10，本文件 ㉛ 当场抓出）：杀掉一个自己的子进程后
 *    `existsSync('/proc/<pid>')` 仍为 true ⇒ 判据把「杀掉了」误判成「杀不动」，
 *    于是一笔**成功的回收被报成失败**。
 *
 *    ⇒ 判据：**"存在"与"活着"必须分开读** —— 存在性读目录，存活性读 `stat` 的 state。
 *    与 D253 同族：一个恒真的读数（`existsSync` 对僵尸为 true）会让相邻的两档同形。
 */
export function pidIsAlive(pid: number): boolean {
  // 🔴 2026-11-18：macOS 无 `/proc` ⇒ 用 `kill(pid, 0)`。
  //    ⚠️ 两者语义**不完全等同**：Linux 版能识别僵尸（state=Z ⇒ 判死），
  //       macOS 版对僵尸会返回 true（`kill 0` 对僵尸仍成功）。
  //       ⇒ macOS 上"杀掉了但父进程还没回收"会短暂显示为活着，最长到父进程 wait 为止。
  //       这是**降级**，不影响正确性方向：`killPidOutcome` 会重试并在超时后报 `denied`，
  //       ⛔ 不会把"还活着"误报成"已回收"（方向是保守的）。
  if (isMac()) return macIsAlive(pid)
  // 🔴 2026-11-19：Windows 同样用 `kill(pid, 0)`（libuv 打开进程句柄）。
  //    ✅ **这一格 Windows 比 Linux 简单**（如实登记，不假装处处更难）：
  //      Windows 没有"僵尸"概念 —— 进程退出即回收，不存在 Linux 侧那个
  //      「`/proc/<pid>` 还在、但 state=Z 已死」的坑。`kill(pid,0)` 在 win32 上
  //      打不开句柄即 ESRCH ⇒ 与 POSIX 同语义，无需额外判据。
  if (isWin()) return winIsAlive(pid)
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // 格式：`pid (comm) state ...`；comm 可能含空格/括号 ⇒ 以**最后一个 `)`** 为界
    const after = stat.slice(stat.lastIndexOf(')') + 2)
    const state = after.charAt(0)
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

/** 兼容包装：只要"最终它不在了"就 true。⚠️ 新的调用方请用 {@link killPidOutcome} */
export function killPid(pid: number, waitMs = 1500): boolean {
  return killPidOutcome(pid, waitMs) !== 'denied' && !pidIsAlive(pid)
}

/**
 * 销毁一个槽位的**全部**进程与运行态。
 *
 * 顺序不可换：先按 profile 认领（进程可能换过 pid，台账里那个未必还准）→ 杀 →
 * 清 pid 文件 → **保留 profile 目录**（登录态是槽位的资产，⛔ 不因一次回收就丢）。
 *
 * 🔴 v1.129.0：同样删掉未被读的 `root` 参数（理由同 {@link launchSlot}）。
 *
 * 🔴🔴 **`pidHint` 必须先验证归属，⛔ 不许无脑 kill**（v1.129.0 真机实测逼出来的）：
 *    台账是**文件**，它会被污染 —— 测试夹具、手工编辑、旧版本残留都会留下
 *    「一个 pid 数字」。若直接 `killPid(pidHint)`，那个 pid 可能是**任何进程**：
 *    编辑器、user 自己的浏览器、别的 CCC 的服务。
 *
 *    实测取证（2026-11-10 08:2x）：全局化改动后，旧测试的 `readLedger(root)` 里
 *    那个多余参数被**静默忽略** ⇒ 测试夹具 `{slot:2, pid:4242}` 落进了**真实的**全局台账
 *    ⇒ `reap b2` 回执写着「已回收 1 个进程（4242）」—— 它真的向一个陌生 pid 发了 SIGTERM。
 *    那次 4242 恰好不存在（`killPid` 的 catch 把 ESRCH 当成功），**纯属运气**。
 *
 *    ⇒ 判据：**pid 只能作为"待验证的线索"，⛔ 不能作为"杀死目标"**。
 *    验证 = 该 pid 的 cmdline 里必须含**本槽位专属的 profile 路径**（与 `findPidsByProfile`
 *    同一条认领规则）。验不过 ⇒ 只记日志、不杀，并在回执里说出来。
 */
export function destroySlot(n: number, pidHint = 0): { killed: number[]; detail: string } {
  const paths = slotPaths(n)
  // ① 权威认领：命令行里带本槽位 profile 的那些（这是唯一可信的来源）
  const pids = new Set<number>(findPidsByProfile(paths.profile))
  // ② 台账里的 pid 只是线索 —— 必须先过同一条认领规则
  let rejectedHint = 0
  if (pidHint > 0 && !pids.has(pidHint)) {
    if (pidClaimsProfile(pidHint, paths.profile)) {
      pids.add(pidHint)
    } else {
      rejectedHint = pidHint
    }
  }
  const killed: number[] = []
  const absent: number[] = []
  const denied: number[] = []
  for (const pid of pids) {
    const out = killPidOutcome(pid)
    if (out === 'killed') killed.push(pid)
    else if (out === 'absent') absent.push(pid)
    else denied.push(pid)
  }
  rmSync(paths.pidFile, { force: true })
  const parts: string[] = []
  if (killed.length > 0) {
    parts.push(`已回收 ${killed.length} 个进程（${killed.join(', ')}）；profile 保留（登录态不丢）`)
  } else {
    parts.push('无可回收进程（槽位本就空闲）')
  }
  // 🔴 「我杀掉了」与「它本来就不在」必须分两行说 —— 否则台账清掉的是一次**不存在的回收**
  if (absent.length > 0) {
    // ⚠️ 两种成因**不能合并成一句**（2026-11-10 真机实测当场抓出）：
    //    · 「台账陈旧/被污染」= 那个 pid 本来就不存在（幽灵租约）
    //    · 「连带退出」= Chrome 的子进程在我杀父进程的那几百毫秒里一起死了
    //    第一版把 7 个子进程（父进程刚被杀）也写成"台账里那条是陈旧的"——
    //    而那次台账**一点都不陈旧**，它记的是真租约。⇒ 判据：**归因要与读数相称**。
    const hintAbsent = rejectedHint === 0 && absent.length === 1 && pidHint > 0 && absent[0] === pidHint
    parts.push(
      hintAbsent
        ? `  ℹ️ 台账记的 pid ${absent[0]} **动手前就已不存在** ⇒ 未计入"已回收"（那条租约是陈旧的或被污染）。`
        : `  ℹ️ 另有 ${absent.length} 个 pid（${absent.join(', ')}）在我逐个处置时**已经退出** ⇒ 未计入"已回收"。` +
          `\n     成因多半是**连带退出**：它们与本槽位同一条进程树，先处置的那个已经带走了它们（⛔ 不是台账陈旧）。`,
    )
  }
  if (denied.length > 0) {
    parts.push(
      `  ⛔ ${denied.length} 个 pid（${denied.join(', ')}）**杀不动**（多半是权限不足）` +
        `⇒ 它们可能仍在运行，请人工确认。`,
    )
  }
  if (rejectedHint > 0) {
    parts.push(
      `  ⚠️ 台账记的 pid ${rejectedHint} **未被杀死** —— 它的命令行里没有本槽位的 profile，` +
        `说明台账那条记录是陈旧的或被污染（⛔ 不按台账杀陌生进程）。`,
    )
  }
  return { killed, detail: parts.join('\n') }
}

/**
 * 某 pid 是否**真的**属于这个 profile（Linux：读 `/proc/<pid>/cmdline`；macOS：`ps`）。
 *
 * 判据与 `findPidsByProfile` 同源：命令行里必须出现本槽位专属的 `--user-data-dir`。
 * ⚠️ 单独包一个函数是为了让「pid 归属校验」这件事有一个**可被点名测试**的落点。
 *
 * 🔴 **2026-11-18（自查补漏，v1.137.9）**：原实现**没有 mac 分支** ⇒ macOS 上恒 `false`。
 *    而 `destroySlot` 用这个返回值决定"台账那条 pid 是不是陈旧/被污染" ⇒
 *    会印出「**台账那条记录是陈旧的或被污染**」——**一句在 mac 上恒假的话**。
 *    ⇒ 判据：**失败方向正确 ≠ 每条路径都正确**；回空集合是安全的（不杀），
 *      但**归因文案**会替一个不存在的成因作证（D253 同族）。
 *
 * 🔴 `platform` 与 `macClaim` 都是**可注入参数**（与 {@link chromeCandidatesFor} 同一理由）：
 *    否则"分派真的发生了"这件事在 Linux 上**永远读不出对错** —— 删掉 darwin 分支测试也不会红。
 *
 * 🔴 **2026-11-19（v1.137.10）**：加 `win32` 一支。**同一族的缺陷不该有第三个版本** ——
 *    这次在加 Windows 支持时**主动**把它一起做了，而不是等 mac 那次的形态在 win 上重演一遍
 *    （在 win 上重演的后果与 mac 完全相同：`destroySlot` 会印
 *    「台账那条记录是陈旧的或被污染」—— 一句在 win 上恒假的话）。
 * ⚠️ `winClaim` 同样是可注入参数，理由同上：⛔ 不能只靠"本机是 Linux"来验它。
 */
export function pidClaimsProfile(
  pid: number,
  profileDir: string,
  platform: string = process.platform,
  macClaim: (pid: number, profileDir: string) => boolean = macPidClaimsProfile,
  winClaim: (pid: number, profileDir: string) => boolean = winPidClaimsProfile,
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (platform === 'darwin') return macClaim(pid, profileDir)
  if (platform === 'win32') return winClaim(pid, profileDir)
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(profileDir)
  } catch {
    return false
  }
}

/**
 * 把日志里**真正能定因的那几行**直接搬进回执。
 *
 * 判据：回执只说"看日志：<路径>"，等于把一次排查转嫁给下一个人 ——
 * 而 Chrome 的死因通常**一行就说完了**（`Missing X server or $DISPLAY`）。
 * ⇒ 挑 ERROR/FATAL/关键短语，最多 6 行；拿不到就退回只说路径。
 */
function tailLogHint(logPath: string, maxLines = 6): string {
  try {
    const text = readFileSync(logPath, 'utf8')
    const lines = text.split('\n').filter((l) => /ERROR|FATAL|Missing|Authorization|failed|Exiting/.test(l))
    if (lines.length > 0) {
      const shown = lines.slice(-maxLines)
      return `  ⇒ Chrome 自己的输出（最后 ${shown.length} 行关键报错）：\n` + shown.map((l) => `     ${l.trim()}`).join('\n')
    }
  } catch {
    /* 日志还没写出来 */
  }
  return `  ⇒ 日志：${logPath}`
}

/** CDP 就绪探测（`/json/version` 能返回 JSON 即就绪） */
export async function probeCdp(n: number, timeoutMs = 1200): Promise<boolean> {
  const port = slotPort(n)
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal })
    if (!res.ok) return false
    const body = await res.json()
    return typeof body === 'object' && body !== null
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/**
 * 等 CDP 就绪 —— 🔴 **判据分两段，缺一不可**。
 *
 * 🔴🔴 **第一段：端点答话（不是"进程还在"）。**
 *    两支既有实现都记录过同一条教训（`tg-browser-pool/references/known-bugs.md`
 *    §「Chrome 启动"成功"后随即自杀」）：容器里 Chrome **能 spawn 起来、CDP 也能就绪，
 *    然后约 1.5 秒后自己退出** —— 根因是 Chrome **自身的 sandbox** 初始化失败
 *    （`Operation not permitted` ⇒ GPU 进程连环崩 ⇒ `FATAL: GPU process isn't usable. Goodbye.`）。
 *    ⇒ "launch 报成功"与"可用"之间隔着一条命。
 *
 * 🔴🔴 **第二段：稳定性复检（这是我第一版漏掉的，比它更根本）。**
 *    自杀发生在 CDP 就绪**之后约 1.5s**。所以只要求"连续两次探测成功"（间隔 300ms = 600ms）
 *    **完全落在自杀窗口之内** ⇒ 会把一个正在死的实例判成健康。
 *    ⇒ 必须**就绪之后再等一段时间**再复检一次。对方实测取 2.5s；本实现取 2500ms 并留可调。
 *
 *    判据：**"失败了什么"必须能区分** —— 分 `never_ready`（端点从没答话）与
 *    `started_but_died`（答过话但随后死了）。这两者的处置不同：前者查参数/端口，
 *    后者查 sandbox 与日志。⛔ 合并成一句"启动失败"会让人查错方向。
 */
export async function waitCdp(
  root: string,
  n: number,
  timeoutMs = 20_000,
  stableMs = 2_500,
): Promise<{ ok: boolean; detail: string; kind?: 'never_ready' | 'started_but_died' }> {
  const deadline = Date.now() + timeoutMs
  let consecutive = 0
  let everReady = false
  while (Date.now() < deadline) {
    if (await probeCdp(n)) {
      consecutive += 1
      if (consecutive >= 2) {
        everReady = true
        break
      }
    } else {
      consecutive = 0
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  const paths = slotPaths(n)

  if (!everReady) {
    return {
      ok: false,
      kind: 'never_ready',
      detail:
        `CDP 在 ${timeoutMs}ms 内从未答话（端口 ${slotPort(n)}）。\n` +
        `  ⇒ 查方向：显示后端 / 端口被占 / 启动参数 / 可执行文件路径。\n` +
        tailLogHint(paths.log),
    }
  }

  // 稳定性复检（关键：这一段才排除"起来了又死"）
  await new Promise((r) => setTimeout(r, stableMs))
  if (!(await probeCdp(n))) {
    return {
      ok: false,
      kind: 'started_but_died',
      detail:
        `CDP 曾就绪，但在 ${stableMs}ms 复检时已不可达（端口 ${slotPort(n)}）。\n` +
        `  🔴 这是容器内 Chrome 的典型死法：**自身 sandbox 初始化失败** ⇒ GPU 崩溃 ⇒ 约 1.5s 后自杀。\n` +
        `  ⇒ 检查启动参数里是否有 \`--no-sandbox\`（本实现已强制带上）。\n` +
        `  ⇒ 日志：${paths.log}`,
    }
  }

  return { ok: true, detail: `CDP 就绪且稳定（端口 ${slotPort(n)}，复检 ${stableMs}ms 仍可达）` }
}

/** 槽位标号规范化（对外接受 b1 / 1 / B1 —— 大小写与前后空白都容忍） */
export function normalizeSlotId(raw: string): number {
  const s = String(raw ?? '').trim().toLowerCase()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n >= 1 && n <= 20 ? n : 0
  }
  return slotNumber(s as SlotId)
}
