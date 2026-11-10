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

export function findChrome(): string | null {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p
  return null
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
  /** 选中的后端（诊断用） */
  backend: 'wayland' | 'x11' | 'headless'
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
): DisplayChoice {
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
 */
export function buildArgs(n: number, paths: SlotPaths, display?: DisplayChoice): string[] {
  const { width, height } = SLOT_RESOLUTION(n)
  const disp = display ?? resolveDisplay()
  return [
    `--user-data-dir=${paths.profile}`,
    `--remote-debugging-port=${slotPort(n)}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    ...disp.args,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
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
        '未找到 Chrome/Chromium。候选路径：' + CHROME_CANDIDATES.join(' / ') + '\n' +
        '  ⇒ 装一个或用 `browser_slot` 的 --chrome 指定路径（该选项尚未实现）。',
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
  }
  return out
}

/** 杀一个 pid（先 TERM，给 1.5s 收尾，再 KILL）；返回是否最终消失 */
export function killPid(pid: number, waitMs = 1500): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return true // 已经不在了
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!existsSync(`/proc/${pid}`)) return true
    const until = Date.now() + 50
    while (Date.now() < until) {
      /* spin */
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
  const hard = Date.now() + 500
  while (Date.now() < hard) {
    if (!existsSync(`/proc/${pid}`)) return true
    const until = Date.now() + 50
    while (Date.now() < until) {
      /* spin */
    }
  }
  return !existsSync(`/proc/${pid}`)
}

/**
 * 销毁一个槽位的**全部**进程与运行态。
 *
 * 顺序不可换：先按 profile 认领（进程可能换过 pid，台账里那个未必还准）→ 杀 →
 * 清 pid 文件 → **保留 profile 目录**（登录态是槽位的资产，⛔ 不因一次回收就丢）。
 *
 * 🔴 v1.129.0：同样删掉未被读的 `root` 参数（理由同 {@link launchSlot}）。
 */
export function destroySlot(n: number, pidHint = 0): { killed: number[]; detail: string } {
  const paths = slotPaths(n)
  const pids = new Set<number>(findPidsByProfile(paths.profile))
  if (pidHint > 0) pids.add(pidHint)
  const killed: number[] = []
  for (const pid of pids) {
    if (killPid(pid)) killed.push(pid)
  }
  rmSync(paths.pidFile, { force: true })
  return {
    killed,
    detail:
      killed.length > 0
        ? `已回收 ${killed.length} 个进程（${killed.join(', ')}）；profile 保留（登录态不丢）`
        : '无可回收进程（槽位本就空闲）',
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
