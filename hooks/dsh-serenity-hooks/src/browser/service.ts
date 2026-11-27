/**
 * browser/service.ts — 槽位管理器的动作实现（ACC 级）
 *
 * 三层结构（⛔ 不要合并成一个大函数 —— 它们的失效面完全不同）：
 *   · 纯判定（state.ts）—— 无 I/O，可逐边界测
 *   · 事实台账（ledger.ts）—— 带锁读改写，只存事实不存状态
 *   · 进程（process.ts）—— 起/探/杀，全部按 profile 目录精确认领
 *
 * 本文件负责**编排**，并把 owner 要的那条闭环接上：
 *   槽位异常（长期不动 / CPU 过高）⇒ **反过来向占用它的会话注入一条消息**。
 *   注入走 `sendToCognitiveTrajectory`（现成通道，语义 = 已注入，不证已执行）。
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_POLICY,
  HOLD_MAX_MINUTES,
  MAX_SLOTS,
  SLOT_RESOLUTION,
  deriveSlotState,
  findLeaseBySession,
  forceReapText,
  nudgeText,
  pickFreeSlot,
  policyFromEnv,
  shouldForceReap,
  shouldNudge,
  slotLabel,
  slotPort,
  type SlotLease,
  type SlotPolicy,
  type SlotState,
} from './state.js'
import { listLeases, withLedger, readLedger, ledgerPath, type Ledger } from './ledger.js'
import {
  clearSlotIdentity,
  destroySlot,
  launchSlot,
  findPidsByProfile,
  readSlotIdentity,
  sampleProcTree,
  slotPaths,
  waitCdp,
  writeSlotIdentity,
  type ProcSample,
} from './process.js'
import {
  boxCenterByBackendId,
  captureAx,
  clickAt,
  closeTab,
  dragFromTo,
  enableDownloads,
  evalInPage,
  fillByBackendId,
  handleDialog,
  hitTestAt,
  insertText,
  listDownloaded,
  listTargets,
  navigate,
  openTab,
  pageHtml,
  pageText,
  pageUrl,
  pressKey,
  reloadPage,
  resolveShotPath,
  screenshot,
  screenshotOrNull,
  scrollAt,
  uploadFiles,
  waitForInPage,
  type CdpTarget,
} from './cdp.js'
import { headlessShot } from './headless-shot.js'
import {
  EXT_DIR_REL,
  buildExtPayload,
  findExtension,
  listExtensions,
  runExtension,
  type ExtEntry,
  type ExtRunResult,
} from './extend.js'
import { resolveInside } from '../kernel/ccc.js'
import { pickTarget, renderHits } from './target-pick.js'
import { COLLECT_CLICKABLE, pickClickable, renderClickables, type Clickable } from './click-target.js'
import { parseKeyStroke, type KeyStroke } from './keys.js'
import { pruneAx, refToBackendId, type AxLine } from './ax.js'
import { explainWaitTimeout, parseWaitSpec, type WaitSpec } from './wait-spec.js'
import { judgeHit, renderHit, type HitVerdict } from './hit-test.js'

/**
 * 动作枚举（对外暴露的唯一清单）
 *
 * 🔴 v1.129.0（owner 2026-11-10 令「所有浏览器能力都集中到这个 browser_slot」）：
 *    **前 6 个管槽位，后 9 个管页面，最后 2 个管扩展** —— 三组各归一层，⛔ 不混。
 *
 *    分组不是装饰：它们失效的面完全不同（槽位层看进程/端口，页面层看 CDP，
 *    扩展层看子进程）。一个读数在哪个组里，决定了它坏了该往哪儿查。
 *
 * ⚠️ 页面组**必须带 `--slot`**（⛔ 不用裸端口）：槽位号是循环复用的，
 *    裸端口会让「这是谁的浏览器」变成一个隐含状态。
 *    先例 `browser` MSM 收 `--port=` —— 那正是它和槽位体系断开的那个口子。
 */
export const SLOT_ACTIONS = [
  // ① 槽位层
  'acquire',
  'release',
  'list',
  'status',
  'reap',
  'hold',
  'doctor',
  // ② 页面层（CDP）—— 全部要求 --slot
  'targets',
  'open',
  'goto',
  'eval',
  'text',
  'html',
  'shot',
  'reload',
  'close',
  'click',
  // ②b 高阶页面动作（v1.130.0：键盘/填值/滚动/等待/拖拽/AX/上传/下载/dialog）
  'ax',
  'press',
  'type',
  'fill',
  'scroll',
  'wait',
  'drag',
  'upload',
  'downloads',
  'dialog',
  // ③ 扩展层
  'ext-list',
  'ext',
] as const
export type SlotAction = (typeof SLOT_ACTIONS)[number]

/** 哪些动作需要 `--slot`（页面层 + ext 需要，槽位层不需要） */
export const ACTIONS_NEED_SLOT: ReadonlySet<SlotAction> = new Set<SlotAction>([
  'targets',
  'open',
  'goto',
  'eval',
  'text',
  'html',
  'shot',
  'reload',
  'close',
  'click',
  'ax',
  'press',
  'type',
  'fill',
  'scroll',
  'wait',
  'drag',
  'upload',
  'downloads',
  'dialog',
  'ext',
])

/** 一次采样缓存（进程内）：CPU 是增量读数，必须有上一次才成立 */
const sampleCache = new Map<number, ProcSample>()

/** 按 profile 目录采一次样（有 prev 才给出瞬时 CPU） */
function readProcFor(root: string, n: number, now: number, pidHint = 0): ProcSample {
  const paths = slotPaths(n)
  const pids = findPidsByProfile(paths.profile)
  const prev = sampleCache.get(n) ?? null
  const cur = sampleProcTree(pids, prev, now)
  sampleCache.set(n, cur)
  /**
   * 🔴🔴 **"还没启动" ≠ "已经死了"（本条是测试抓出来的真缺陷）**。
   *
   * `findPidsByProfile` 扫不到进程有两种成因：
   *   ① 进程**还没起来**（acquire 刚落在台账上、spawn 尚未完成）—— 这是**正常中间态**
   *   ② 进程**起过又没了**（崩溃 / 被回收）—— 这才是 orphaned
   *
   * 第一版把两者都当 `alive:false` ⇒ **每一个刚租下的槽位都会立刻被判 orphaned**
   * 并收到一条"你的 Chrome 已经死了"的误导提醒。而它其实马上就会起来。
   *
   * 判据：**台账里记着 pid ⇒ 才算"它本该活着"**；pid 为 0 ＝ 已知它还没被启动过，
   * 此时**不做死活判断**（返回 alive:true 表示"不下此结论"），把它留给闲置/资源那几条去判。
   * ⚠️ 这不是"忽略异常"，而是**不从一个不承载该结论的读数里推结论**（同 D-族判据）。
   */
  if (pids.length === 0 && pidHint === 0) {
    return { ...cur, alive: true }
  }
  return cur
}

/** 槽位视图（对外输出的一行） */
export interface SlotView {
  slot: number
  label: string
  port: number
  resolution: string
  state: SlotState
  reasons: string[]
  sessionId: string
  trajectory: string
  /** 占用时长（分钟） */
  heldMin: number
  /** 距最后一次动作（分钟） */
  idleMin: number
  cpuPct: number
  rssMb: number
  pid: number
  nudges: number
  /**
   * 这次视图的 CPU/内存读数**是否真采过**。
   * `false` ⇒ 渲染成 `cpu—` / `内存—`，⛔ 不能渲染成 `cpu0%`（那是「测了，很低」的同形假读数）。
   * 当前只有 Windows 为 `false`（见 `process.ts` 的 `sampleProcTree` win32 分支）。
   */
  sampled: boolean
}

function toView(
  root: string,
  n: number,
  lease: SlotLease | null,
  proc: ProcSample,
  now: number,
  policy: SlotPolicy,
): SlotView {
  const { state, reasons } = deriveSlotState(lease, proc, now, policy)
  const r = SLOT_RESOLUTION(n)
  return {
    slot: n,
    label: slotLabel(n),
    port: slotPort(n),
    resolution: `${r.width}x${r.height}`,
    state,
    reasons,
    sessionId: lease?.sessionId ?? '',
    trajectory: lease?.trajectory ?? '',
    heldMin: lease ? Math.round((now - lease.leasedAt) / 60_000) : 0,
    idleMin: lease ? Math.round((now - lease.lastActionAt) / 60_000) : 0,
    cpuPct: Number(proc.cpuPct.toFixed(1)),
    rssMb: Math.round(proc.rssMb),
    pid: lease?.pid ?? 0,
    nudges: lease?.nudges ?? 0,
    // `undefined` ⇒ `true`：Linux/macOS 一直在采；只有 Windows 显式给 `false`。
    sampled: proc.sampled !== false,
  }
}

/** acquire：租一个槽位（同会话已有 ⇒ 复用，⛔ 不再租第二个） */
export interface AcquireInput {
  root: string
  sessionId: string
  trajectory: string
  /** 指定槽位号（0 = 自动挑） */
  want?: number
  policy?: SlotPolicy
}

export interface AcquireResult {
  ok: boolean
  slot: number
  state: SlotState
  reused: boolean
  detail: string
}

export async function acquireSlot(input: AcquireInput): Promise<AcquireResult> {
  const policy = input.policy ?? policyFromEnv()
  const now = Date.now()

  // ① 同会话复用（防"租了两个只 release 一个"这种静默泄漏）
  const existing = findLeaseBySession(listLeases(readLedger()), input.sessionId)
  if (existing && input.sessionId !== '') {
    const launched = ensureRunning(input.root, existing.slot, existing.pid)
    if (launched.ok) {
      withLedger((lg) => {
        const cur = lg.leases[String(existing.slot)]
        if (cur) {
          cur.pid = launched.pid || cur.pid
          cur.lastActionAt = now
          // 旧版租约（v1.128.x 及以前）没有 cccRoot / 也没有 identity.json
          if (!cur.cccRoot) cur.cccRoot = input.root
        }
        return { ledger: lg, result: null }
      })
      // 复用同样补写身份：否则"这个 profile 属于谁"只在台账里，
      // 而旧租约正是从"台账有、profile 无"那一代过来的。
      stampIdentity(input.root, existing.slot, existing.sessionId, existing.trajectory, existing.leasedAt)
    }
    return {
      ok: launched.ok,
      slot: existing.slot,
      state: 'leased',
      reused: true,
      detail:
        `You already hold slot ${slotLabel(existing.slot)} (port ${slotPort(existing.slot)}); reusing it.\n` +
        `  ⛔ Do not lease a second one — two slots per session is exactly the shape of the incident (leased and forgotten).\n` +
        launched.detail,
    }
  }

  // ② 选址 + 落账（在锁内完成，防两条轨迹抢同一个空槽）
  const picked = withLedger((lg) => {
    const leases = listLeases(lg)
    const free = input.want && input.want > 0 ? input.want : pickFreeSlot(leases)
    if (free === 0) return { ledger: lg, result: 0 }
    if (lg.leases[String(free)]) {
      // 指定了一个已被占的槽 ⇒ 如实拒绝，⛔ 不抢占
      return { ledger: lg, result: -free }
    }
    lg.leases[String(free)] = {
      slot: free,
      cccRoot: input.root,
      sessionId: input.sessionId,
      trajectory: input.trajectory,
      leasedAt: now,
      lastActionAt: now,
      nudges: 0,
      lastNudgeAt: 0,
      pid: 0,
      holdUntil: 0,
    }
    return { ledger: lg, result: free }
  })

  if (picked === 0) {
    return {
      ok: false,
      slot: 0,
      state: 'free',
      reused: false,
      detail:
        `All 20 slots are taken, ⛔ refusing to lease another.\n` +
        `  ⇒ See who holds them: \`browser_slot list\`; hand one back with \`release <slot>\`.\n` +
        `  ⚠️ A full house is usually not "high demand" but **someone forgot to release** — look at the largest idleMin row.`,
    }
  }
  if (picked < 0) {
    return {
      ok: false,
      slot: -picked,
      state: 'leased',
      reused: false,
      detail: `Slot ${slotLabel(-picked)} is taken (⛔ not preempting). Use \`browser_slot list\` to see the owner, or omit --slot to let the system pick.`,
    }
  }

  const n = picked
  const launched = ensureRunning(input.root, n, 0)
  withLedger((lg) => {
    const cur = lg.leases[String(n)]
    if (cur) cur.pid = launched.pid || 0
    return { ledger: lg, result: null }
  })

  const r = SLOT_RESOLUTION(n)
  if (!launched.ok) {
    // 启动失败 ⇒ **立即释放**，⛔ 不留一个"已占用但没进程"的孤儿记录
    withLedger((lg) => {
      delete lg.leases[String(n)]
      return { ledger: lg, result: null }
    })
    // 身份也没必要留（本次租约从未成立）—— 但**不清 profile**，那是槽位的资产
    clearSlotIdentity(n)
    return { ok: false, slot: n, state: 'free', reused: false, detail: launched.detail }
  }

  stampIdentity(input.root, n, input.sessionId, input.trajectory, now)

  return {
    ok: true,
    slot: n,
    state: 'leased',
    reused: false,
    detail:
      `${launched.detail}\n` +
      `🔴 **You must hand it back**: \`browser_slot release ${slotLabel(n)}\`\n` +
      `  If you forget, the watchman will nudge you once it sits idle — by then you may have moved on.`,
  }
}

/** 启动退避：连续失败按指数推迟（G9）。返回 0 = 可以尝试，>0 = 还需等待的毫秒 */
function backoffWaitMs(root: string, n: number, now: number): number {
  const b = readLedger().backoff[String(n)]
  if (!b || b.failures === 0) return 0
  return Math.max(0, b.nextAt - now)
}

/** 记一次启动失败（推下次允许时刻） */
function noteLaunchFailure(root: string, n: number): number {
  return withLedger((lg) => {
    const cur = lg.backoff[String(n)] ?? { failures: 0, nextAt: 0 }
    const failures = cur.failures + 1
    // 指数退避：30s, 60s, 120s, 240s… 上限 10 分钟（槽位是稀缺资源，⛔ 不能永久封死）
    const wait = Math.min(30_000 * 2 ** (failures - 1), 10 * 60_000)
    lg.backoff[String(n)] = { failures, nextAt: Date.now() + wait }
    return { ledger: lg, result: wait }
  })
}

/** 启动成功 ⇒ 清零退避 */
function clearLaunchFailure(root: string, n: number): void {
  withLedger((lg) => {
    delete lg.backoff[String(n)]
    return { ledger: lg, result: null }
  })
}

/** 确保槽位进程在跑（内部）：不在则起 + 等就绪 */
function ensureRunning(root: string, n: number, pidHint: number): { ok: boolean; pid: number; detail: string } {
  const paths = slotPaths(n)
  const live = findPidsByProfile(paths.profile)
  if (live.length > 0) {
    return { ok: true, pid: live[0]!, detail: `Slot ${slotLabel(n)} already running (pid ${live[0]})` }
  }
  if (pidHint > 0 && existsSync(`/proc/${pidHint}`)) {
    return { ok: true, pid: pidHint, detail: `Slot ${slotLabel(n)} already running (pid ${pidHint})` }
  }
  const wait = backoffWaitMs(root, n, Date.now())
  if (wait > 0) {
    return {
      ok: false,
      pid: 0,
      detail:
        `Slot ${slotLabel(n)} is in **launch backoff** (${Math.ceil(wait / 1000)}s left).\n` +
        `  🔴 Cause: this slot failed to start repeatedly. ⇒ Retrying pays a full re-check again (seconds) and **is indistinguishable in the readings**.\n` +
        `  ⇒ Find the root cause first: \`browser_slot doctor\` for pidDrift and log paths; or use another slot.`,
    }
  }
  const launched = launchSlot(n)
  if (!launched.ok) {
    const w = noteLaunchFailure(root, n)
    return {
      ok: false,
      pid: 0,
      detail: `${launched.detail}\n  ⇒ One launch failure recorded; next attempt allowed in ${Math.ceil(w / 1000)}s.`,
    }
  }
  clearLaunchFailure(root, n)
  return { ok: true, pid: launched.pid, detail: launched.detail }
}

/** 启动后等 CDP（由 acquire 的可选步骤调用；默认 acquire 不阻塞等） */
export async function waitSlotReady(root: string, n: number): Promise<{ ok: boolean; detail: string }> {
  return await waitCdp(root, n)
}

/**
 * 把归属**同时**写进两处：台账（权威）＋ `identity.json`（profile 侧冗余）。
 *
 * 🔴 owner 2026-11-10 令：「每个槽位的浏览器 profile 里加点标识」。
 *    判据：**资源的归属必须在"资源自己身上"也能被读出来** —— 只靠台账回答归属，
 *    会让"台账坏了/读了一半"与"槽位无主"在读数上完全同形（D253 同族）。
 * ⚠️ 两处不一致时**以台账为准**；identity 是抓手，不是第二个真相源。
 */
function stampIdentity(
  root: string,
  n: number,
  sessionId: string,
  trajectory: string,
  leasedAt: number,
): void {
  try {
    writeSlotIdentity({
      slot: n,
      label: slotLabel(n),
      port: slotPort(n),
      cccRoot: root,
      sessionId,
      trajectory,
      leasedAt,
      writtenAt: 0, // writeSlotIdentity 自己盖时刻
    })
  } catch (err) {
    // ⚠️ 写 identity 失败**不许**让 acquire 失败：台账已经记了这次租约，那才是权威。
    //    但必须留声 —— 静默吞掉会让"标识没写上"与"标识写了但内容空"同形。
    console.warn(
      `[serenity-hooks] ⚠️ 槽位 ${slotLabel(n)} 的 identity.json 写入失败：${String((err as Error)?.message ?? err)}`,
    )
  }
}

/** release：交还槽位（**杀进程** + 删记录，⛔ 保留 profile 目录） */
export function releaseSlot(
  root: string,
  sessionId: string,
  target: number,
): { ok: boolean; detail: string; released: boolean } {
  const ledger = readLedger()
  const lease = ledger.leases[String(target)]
  if (!lease) {
    // 🔴 `released: false` 是**结构性**判据，⛔ 不是文案匹配：什么都没发生，
    //    所以释放后的"说说你的经验"提示**不该出现**（那条路径上提示它 = 凭空催人写文档）。
    return { ok: true, detail: `Slot ${slotLabel(target)} was already free (nothing to release).`, released: false }
  }
  // 🔴 归属校验：只能释放自己的。⛔ 允许释放别人的会让"互相踩"变成合法动作。
  if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
    return {
      ok: false,
      detail:
        `Slot ${slotLabel(target)} is not yours (owner: ${lease.trajectory || lease.sessionId || 'unknown'}).\n` +
        `  ⛔ Not releasing on someone else's behalf — they may be using it. If you are sure it is abandoned, use \`browser_slot reap <slot>\` (watchman action, records a reason).`,
      released: false,
    }
  }
  const destroyed = destroySlot(target, lease.pid)
  withLedger((lg) => {
    delete lg.leases[String(target)]
    return { ledger: lg, result: null }
  })
  // 🔴 身份必须跟着租约一起消失：留着会让"这个 profile 还有主"在读数上成立，
  //    而那正是 identity.json 存在的目的（回答"谁在用"）—— 留旧值等于让答案过期而不自知。
  //    ⛔ 但**不动 profile 目录本身**：登录态是槽位的资产，下一个租的人接着用。
  clearSlotIdentity(target)
  sampleCache.delete(target)
  return {
    ok: true,
    detail: `Released slot ${slotLabel(target)}. ${destroyed.detail}`,
    released: true,
  }
}

/** list：全部槽位一览（含空槽） */
export function listSlots(root: string, policy = policyFromEnv()): { views: SlotView[]; ledgerAgeMin: number } {
  const ledger = readLedger()
  const now = Date.now()
  const views: SlotView[] = []
  for (let n = 1; n <= MAX_SLOTS; n++) {
    const lease = ledger.leases[String(n)] ?? null
    const proc = lease ? readProcFor(root, n, now, lease.pid) : { alive: false, cpuPct: 0, rssMb: 0, at: now }
    views.push(toView(root, n, lease, proc, now, policy))
  }
  return {
    views,
    ledgerAgeMin: ledger.updatedAt > 0 ? Math.round((now - ledger.updatedAt) / 60_000) : 0,
  }
}

/** status：单槽位详情 */
export function slotStatus(root: string, target: number, policy = policyFromEnv()): SlotView | null {
  if (target < 1 || target > MAX_SLOTS) return null
  const ledger = readLedger()
  const lease = ledger.leases[String(target)] ?? null
  const now = Date.now()
  const proc = lease ? readProcFor(root, target, now, lease.pid) : { alive: false, cpuPct: 0, rssMb: 0, at: now }
  return toView(root, target, lease, proc, now, policy)
}

/**
 * reap：看守动作 —— 回收一个异常槽位。
 * ⛔ 与 release 的区别：release 是**占用者的自觉**，reap 是**兜底**，故必须记录原因。
 */
export function reapSlot(root: string, target: number, reason: string): { ok: boolean; detail: string } {
  const ledger = readLedger()
  const lease = ledger.leases[String(target)]
  const destroyed = destroySlot(target, lease?.pid ?? 0)
  withLedger((lg) => {
    delete lg.leases[String(target)]
    return { ledger: lg, result: null }
  })
  clearSlotIdentity(target)
  sampleCache.delete(target)
  return {
    ok: true,
    detail: `Reclaimed slot ${slotLabel(target)} (reason: ${reason}). ${destroyed.detail}`,
  }
}

/**
 * 🔴 **反向注入**：找到一个"该被提醒"的槽位，把消息投给**占用它的会话**。
 *
 * 这正是 owner 要的那条闭环：「状态异常 ⇒ 反过来向唤醒这个浏览器的会话注入消息提醒它」。
 *
 * 判据（每一句都有代价）：
 * - 提醒**不代它释放** —— 只有占用者知道那个浏览器还有没有用；代为释放可能中断一个正在取的证。
 * - 提醒**必须带具体动作**（见 nudgeText），⛔ 不说"你的槽位异常了"。
 * - 注入回执只到"已注入"，⛔ 不表示对方已执行（本仓 D 族判据）。
 */
export interface NudgeOutcome {
  slot: number
  state: SlotState
  trajectory: string
  delivered: boolean
  detail: string
}

/** 强关结果（与 NudgeOutcome 分开：一件事是"提醒了"，另一件是"关掉了"，⛔ 不可混） */
export interface ForceReapOutcome {
  slot: number
  trajectory: string
  idleMin: number
  killed: boolean
  killDetail: string
  delivered: boolean
  deliverDetail: string
}

export type Injector = (root: string, target: string, message: string) => Promise<{ ok: boolean; detail: string }>

/**
 * 🔴 **强关扫描（owner 2026-11-24 令：「浏览器一直不关的现象严重」）**。
 *
 * 与 {@link nudgeStaleSlots} **分两个函数**，⛔ 不合并：
 * 前者是"告诉它还活着"，后者是"真的关掉它" —— 两件事的失败面与后果完全不同，
 * 合进一个函数会让"提醒了没关"与"该关没关"在回执上同形。
 *
 * ## 顺序（由调用方保证，⛔ 不可换）
 *
 * 调用方先跑 `nudgeStaleSlots`（提醒），**再**跑本函数（强关）。
 * 而本函数内部还有第二道闸：`lease.nudges >= 1`（见 shouldForceReap ③）
 * ⇒ 即使调用顺序被写错，**也不会出现"没提醒过就杀掉"**。
 *
 * ## 一辆车能做两件事，但账要分开记
 *
 * 强关后：① 杀进程 ＋ 删租约 ＋ 清 identity（复用 `reapSlot`，它是既有生产路径）；
 * ② 向占用者注入**告知**（不是提醒 —— 提醒是"请你做"，告知是"我已经做了"）。
 */
export async function forceReapIdleSlots(
  root: string,
  inject: Injector,
  policy = policyFromEnv(),
): Promise<{ reaped: ForceReapOutcome[]; scanned: number }> {
  const ledger = readLedger()
  const now = Date.now()
  const out: ForceReapOutcome[] = []
  let scanned = 0
  for (const lease of listLeases(ledger)) {
    scanned += 1
    const proc = readProcFor(root, lease.slot, now, lease.pid)
    const verdict = shouldForceReap(lease, proc, now, policy)
    if (!verdict) continue
    // 🔴 复用 reapSlot：它已经做全了「杀进程 ＋ 删租约 ＋ 清 identity ＋ 清采样缓存」。
    //    ⛔ 不在这里再写一遍 —— 两套清理逻辑必然分叉（本仓栽过多次）。
    const res = reapSlot(root, lease.slot, `idle ${verdict.idleMin}m (nudged ${verdict.nudges}x)`)
    // 台账留痕（⚠️ 租约已被删，所以写的是 recentKills，不是 leases）
    recordRecentKill(lease.slot, lease.trajectory, verdict.idleMin, verdict.nudges, res.ok)
    const target = lease.trajectory || lease.sessionId
    let delivered = false
    let deliverDetail = ''
    if (target) {
      const text = forceReapText(lease.slot, verdict.idleMin, verdict.nudges, policy)
      try {
        const r = await inject(root, target, text)
        delivered = r.ok
        deliverDetail = r.detail
      } catch (err) {
        deliverDetail = String((err as Error)?.message ?? err)
      }
    } else {
      deliverDetail = 'This slot has no owning trajectory (sessionId and trajectory both empty) ⇒ cannot notify; the kill is still recorded in the ledger'
    }
    out.push({
      slot: lease.slot,
      trajectory: lease.trajectory,
      idleMin: verdict.idleMin,
      killed: res.ok,
      killDetail: res.detail,
      delivered,
      deliverDetail,
    })
  }
  return { reaped: out, scanned }
}

/**
 * 🔴 **保活**（owner 2026-11-24 裁：同意）—— 长下载／慢查询的唯一逃生阀。
 *
 * ## 它为什么必须存在
 *
 * 强关的判据是「30 分钟静默 ⇒ 你肯定不在用它」。而**长下载恰好合法地静默**。
 * 没有这条通道，强关就是粗糙的 —— 会把正在下载 2GB 镜像的人一脚踢掉。
 *
 * ## 🔴 它**不推进 `lastActionAt`**
 *
 * 那是关键设计：`lastActionAt` 的语义是「我刚做了一个动作」（**事实**），
 * 而 `holdUntil` 是「我预知接下来不动，别判我闲置」（**声明**）。
 * 若用推进 `lastActionAt` 来实现保活，那么「真的在干活」与「申请了豁免」在读数上**同形** ——
 * `status` 的读者（和看守自己）就会据此做错动作。⇒ 两个字段，⛔ 不合流。
 */
export function holdSlot(
  root: string,
  sessionId: string,
  target: number,
  minutes: number,
  reason: string,
): { ok: boolean; detail: string } {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, detail: `hold needs a positive number of minutes (got ${minutes})` }
  }
  if (minutes > HOLD_MAX_MINUTES) {
    return {
      ok: false,
      detail:
        `hold is capped at ${HOLD_MAX_MINUTES} minutes per call (got ${minutes}).\n` +
        `  ⛔ Never a permanent exemption — that would defeat idle reclaim. Renew before it expires if you need longer.`,
    }
  }
  const ledger = readLedger()
  const lease = ledger.leases[String(target)]
  if (!lease) return { ok: false, detail: `Slot ${slotLabel(target)} is not leased (nothing to hold).` }
  if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
    return { ok: false, detail: `Slot ${slotLabel(target)} is not yours; ⛔ cannot hold on someone else's behalf.` }
  }
  const until = Date.now() + minutes * 60_000
  withLedger((lg) => {
    const cur = lg.leases[String(target)]
    if (cur) cur.holdUntil = until
    return { ledger: lg, result: null }
  })
  return {
    ok: true,
    detail:
      `Held slot ${slotLabel(target)} until ${new Date(until).toLocaleTimeString('en-GB')} (${minutes} min).\n` +
      `  · Idle is NOT judged while held, but process liveness / CPU / rss still are.\n` +
      `  · Reason: ${reason || '(none given)'}\n` +
      `  · If still idle when it expires, the normal nudge→force-reclaim flow resumes.`,
  }
}

/**
 * 强关留痕（台账里的 `recentKills`，最多保留 20 条）。
 *
 * 🔴 **为什么必须有它**：强关删掉了租约 ⇒ 事后问"刚才那槽为什么被关"在台账上**无从回答**。
 * 而强关会**中断别人正在做的事**，那种事必须有可追溯的记录，否则下一个人只会看到"槽位突然空了"。
 */
function recordRecentKill(slot: number, trajectory: string, idleMin: number, nudges: number, ok: boolean): void {
  try {
    withLedger((lg) => {
      const list = Array.isArray(lg.recentKills) ? lg.recentKills : []
      list.unshift({ slot, trajectory, idleMin, nudges, ok, at: Date.now() })
      lg.recentKills = list.slice(0, 20)
      return { ledger: lg, result: null }
    })
  } catch (err) {
    // ⚠️ 留痕失败**不许**让强关失败：关掉进程才是主要目的（进程已经关了）。
    console.warn(`[serenity-hooks] ⚠️ 强关留痕写入失败（槽位 ${slotLabel(slot)}）：${String((err as Error)?.message ?? err)}`)
  }
}

export async function nudgeStaleSlots(
  root: string,
  inject: Injector,
  policy = policyFromEnv(),
): Promise<{ nudged: NudgeOutcome[]; scanned: number }> {
  const ledger = readLedger()
  const now = Date.now()
  const out: NudgeOutcome[] = []
  let scanned = 0
  for (const lease of listLeases(ledger)) {
    scanned += 1
    const proc = readProcFor(root, lease.slot, now, lease.pid)
    const { state, reasons } = deriveSlotState(lease, proc, now, policy)
    if (!shouldNudge(lease, state, now, policy)) continue
    const target = lease.trajectory || lease.sessionId
    if (!target) {
      // 无归属 ⇒ 无法注入。这是设计缺陷暴露面，如实登记而不静默跳过。
      out.push({
        slot: lease.slot,
        state,
        trajectory: '',
        delivered: false,
        detail: 'This slot has no owning trajectory (sessionId and trajectory both empty) ⇒ cannot inject; needs manual handling',
      })
      continue
    }
    const text = nudgeText(lease.slot, state, reasons, policy)
    const res = await inject(root, target, text)
    // 记账（无论成败都记时刻，避免失败时每 tick 重试刷屏）
    withLedger((lg) => {
      const cur = lg.leases[String(lease.slot)]
      if (cur) {
        cur.nudges += 1
        cur.lastNudgeAt = now
      }
      return { ledger: lg, result: null }
    })
    out.push({ slot: lease.slot, state, trajectory: lease.trajectory, delivered: res.ok, detail: res.detail })
  }
  return { nudged: out, scanned }
}

/** 推进 lastActionAt（由"成功的浏览器操作"调用；这就是"是否长期不动作"的判据来源） */
export function touchSlot(root: string, target: number): void {
  withLedger((lg) => {
    const cur = lg.leases[String(target)]
    if (cur) cur.lastActionAt = Date.now()
    return { ledger: lg, result: null }
  })
}

/** doctor：自检（⛔ 不修改任何东西） */
export function doctorSlots(root: string, policy = policyFromEnv()): Record<string, unknown> {
  const ledger = readLedger()
  const now = Date.now()
  const drift: string[] = []
  // ① 台账里记的 pid 与 /proc 实际指向该 profile 的 pid 是否一致
  for (const lease of listLeases(ledger)) {
    const paths = slotPaths(lease.slot)
    const live = findPidsByProfile(paths.profile)
    if (lease.pid > 0 && live.length > 0 && !live.includes(lease.pid)) {
      drift.push(`槽位 ${slotLabel(lease.slot)}：台账 pid=${lease.pid}，实际=${live.join(',')}`)
    }
    if (lease.pid === 0 && live.length > 0) {
      drift.push(`槽位 ${slotLabel(lease.slot)}：台账无 pid，实际在跑 ${live.join(',')}`)
    }
  }
  const views = listSlots(root, policy).views.filter((v) => v.state !== 'free')
  // ② identity.json 与台账的对账。
  //   🔴 为什么必须在这里出现：identity 是**冗余**记录，冗余的价值只在"能被对账"时才成立。
  //      没有这一格，一份写坏/写旧/根本没写的 identity 与一份正确的在读数上完全一样。
  const identityDrift: string[] = []
  for (const lease of listLeases(ledger)) {
    const ident = readSlotIdentity(lease.slot)
    if (!ident) {
      identityDrift.push(`槽位 ${slotLabel(lease.slot)}：台账有租约但 identity.json 缺失`)
      continue
    }
    if (ident.sessionId !== lease.sessionId) {
      identityDrift.push(
        `槽位 ${slotLabel(lease.slot)}：identity.sessionId=${ident.sessionId || '(空)'} ≠ 台账=${lease.sessionId || '(空)'}`,
      )
    }
    if ((ident.cccRoot || '') !== (lease.cccRoot || '')) {
      identityDrift.push(
        `槽位 ${slotLabel(lease.slot)}：identity.cccRoot 与台账不一致（⛔ 以台账为准）`,
      )
    }
  }
  return {
    ledger: { path: ledgerPath(), leases: listLeases(ledger).length, ageMin: ledger.updatedAt ? Math.round((now - ledger.updatedAt) / 60_000) : 0 },
    policy,
    occupied: views,
    pidDrift: drift,
    identityDrift,
    verdict: drift.length === 0 && identityDrift.length === 0 ? 'clean' : 'drift',
  }
}

// ═══════════════════════════════════════════════════════════════════
// ② 页面层（CDP）—— v1.129.0 从 `browser` MSM 搬进 ACC
// ═══════════════════════════════════════════════════════════════════

/**
 * 页面操作的前置守卫：**这个槽位必须是你租的**。
 *
 * 🔴🔴 判据（这条比任何单个动作都值钱）：
 *    搬进来的动作以前是「给一个端口就能操作」，而端口与归属在**两处**各记一份
 *    ⇒ 谁都能操作任何人的浏览器，而**没有任何读数会显示这件事**。
 *    ⇒ 现在页面动作必须先过归属检查：`sessionId` 必须是该槽位的占用者。
 *
 * ⚠️ 豁免：`sessionId === ''`（无归属调用，例如 CLI 探针）**一律拒绝**，⛔ 不做"信任本地"的放宽
 *    —— 一旦放宽，归属就从"机制"退回成"习惯"。
 */
export function assertSlotOwned(root: string, slot: number, sessionId: string): void {
  const lease = readLedger().leases[String(slot)]
  if (!lease) {
    throw new Error(
      `Slot ${slotLabel(slot)} is not leased right now ⇒ \`browser_slot acquire\` one first.\n` +
        `  ⛔ Not auto-leasing for you: lease-and-forget is exactly the shape of the 2026-11-09 36-hour power incident.`,
    )
  }
  if (sessionId === '' || lease.sessionId !== sessionId) {
    throw new Error(
      `Slot ${slotLabel(slot)} is not yours (owner ${lease.sessionId || '(none)'}) ⇒ refusing the operation.\n` +
        `  ⇒ Find your own with \`browser_slot list\`; to open a new one use \`browser_slot acquire\`.\n` +
        `  ⚠️ A hard refusal is deliberate: allowing it would make "who drives whose browser" unanswerable.`,
    )
  }
}

/** 把页面上一次成功的操作推进 lastActionAt（这就是"长期不动作"判据的来源） */
function pageTouched(root: string, slot: number): void {
  touchSlot(root, slot)
}

/**
 * 解析「要操作哪个 target」——`--target`（身份）或 `--match`（子串线索）二选一。
 *
 * 🔴 **为什么必须有这一层**：`--match` 之前，用户要先跑 `targets` 抄一个 32 位 id 再回来
 *    （owner 2026-11-10 反馈：`msm cdp shot --match` 少一步，`browser_slot` 非要先取 targetId）。
 *    但"少一步"的代价必须由**判定**承担，不能由"猜"承担 —— 见 `target-pick.ts` 的四条判据。
 *
 * 🔴 **判据优先级**：`--target` 在则不读 `--match`（身份 > 线索）。
 *    ⛔ 不做"给了 target 找不到就回落到 match" —— 那会把打错的 id 变成"恰好相符的另一个页面"。
 *
 * @returns 解析好的 targetId（**唯一**），或抛出可读错误（0 命中 / 多命中都把候选列全）
 */
export async function resolveTarget(
  root: string,
  slot: number,
  sessionId: string,
  opts: { target?: string; match?: string },
): Promise<string> {
  if (!opts.target && !opts.match) {
    throw new Error(
      `⛔ needs --target=<targetId> or --match=<URL or title substring>.\n` +
        `  ⇒ Run \`browser_slot targets --slot b1\` to see what is there, or just pass --match=example.com`,
    )
  }
  // 身份直通：⛔ 不去列 targets（少一次 CDP 往返，也避免"列的时候恰好变了"）
  if (opts.target) return opts.target

  const list = await slotTargets(root, slot, sessionId)
  const res = pickTarget(list, { match: opts.match })
  if (res.ok) return res.target.id
  const pages = list.filter((t) => t.type === 'page')
  if (res.reason === 'not-found') {
    throw new Error(
      `⛔ No page matches "${opts.match}" (matches url or title, case-insensitive).\n` +
        `  ⇒ ${pages.length} page(s) currently:\n${renderHits(pages)}`,
    )
  }
  // ambiguous
  throw new Error(
    `⛔ "${opts.match}" matched ${res.hits.length} pages — refusing to pick one for you (a wrong pick yields an image that looks right but belongs to someone else).\n` +
      `  ⇒ Use a longer substring, or name one with --target=<id>:\n${renderHits(res.hits)}`,
  )
}

/**
 * 语义化点击：`--text` 子串或 `--xy` 坐标。
 *
 * 🔴 判定在 `click-target.ts`（0 命中/多命中/不可点 **全部拒绝**）。
 *    这一层只做两件它必须做的事：**采集**（跑一次 `COLLECT_CLICKABLE`）与**执行**（真鼠标事件）。
 *
 * ⚠️ **返回的是"点了什么"**，不是"点成功了"。⛔ 不在这里等界面变化 ——
 *    等多久、等什么，属于调用方的判断（本工具不知道这个按钮应该产生什么后果）。
 */
export async function slotClick(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  opts: { text?: string; xy?: { x: number; y: number }; ref?: number },
): Promise<{
  picked: Clickable
  total: number
  dialogs: Array<{ type: string; message: string; accepted: boolean }>
  /** 「这一下**会点到谁**」的判定（B 项，D328）。⛔ 回执不说"点成功"，只说它落在哪 */
  hit: HitVerdict
}> {
  assertSlotOwned(root, slot, sessionId)
  if (!opts.text && !opts.xy) {
    throw new Error('⛔ needs --text=<visible label> or coordinates (run targets first for a targetId)')
  }

  // 坐标直通：不必采集整页（省一次大对象往返）——
  // 🔴 但**必须先做命中测试**（2026-11-13 B 项）：CDP 对"点在视口外 / 点在被盖住的元素上"**一行都不报**，
  //    回执照样写着 clicked @x,y。判据：**「发了鼠标事件」与「点到了目标」是两件事**（D311 的坐标版）。
  if (opts.xy) {
    const probe = await hitTestAt(slot, targetId, opts.xy.x, opts.xy.y)
    const hit = judgeHit(probe, opts.ref !== undefined ? { backendNodeId: opts.ref } : undefined)
    if (hit.kind === 'offscreen' || hit.kind === 'blank') {
      // 不点：点一个不存在的落点是纯副作用（事件发出去了，责任还在我们账上）
      throw new Error(
        `⛔ Not clicking: ${renderHit(hit)}\n` +
          `  ⇒ coords ${opts.xy.x},${opts.xy.y}. Get a ref via \`ax\` first (more reliable), or \`scroll\` the target into the viewport.`,
      )
    }
    if (hit.kind === 'blocked') {
      throw new Error(
        `⛔ Not clicking: ${renderHit(hit)}\n` +
          `  ⇒ When something covers it, the click runs ANOTHER element's handler (and a receipt saying "clicked" would never reveal it).\n` +
          `  ⇒ Fix: use \`ax\` to see what that layer is (overlay / sticky header / mask) and close it; or name the target with \`--ref\`.`,
      )
    }
    const r = await clickAt(slot, targetId, opts.xy.x, opts.xy.y)
    pageTouched(root, slot)
    return {
      picked: { tag: '', type: '', text: '', role: '', ...opts.xy, w: 0, h: 0, disabled: false, pointerNone: false, download: false },
      total: 0,
      dialogs: r.dialogs,
      hit,
    }
  }

  const raw = await evalInPage(slot, targetId, COLLECT_CLICKABLE, 15_000)
  const list = Array.isArray(raw) ? (raw as Clickable[]) : []
  const res = pickClickable(list, { text: opts.text })
  if (!res.ok) {
    const visible = list.filter((e) => e.w > 0 && e.h > 0)
    if (res.reason === 'ambiguous') {
      throw new Error(
        `⛔ "${opts.text}" matched ${res.hits.length} clickable elements — refusing to pick (a wrong click has already happened and will not undo itself).\n` +
          `  ⇒ Use a longer label, or name it with --xy=<x,y>:\n${renderClickables(res.hits)}`,
      )
    }
    if (res.reason === 'not-clickable') {
      throw new Error(
        `⛔ "${opts.text}" was found, but ${res.why}.\n` +
          `  ⇒ This is not a "try clicking anyway" situation: a dead click and no click read the same.\n${renderClickables(res.hits)}`,
      )
    }
    throw new Error(
      `⛔ No clickable element on the page matches "${opts.text}" (matches rendered visible text, incl. value/aria-label/title).\n` +
        `  ⇒ ${visible.length} visible clickable element(s) right now:\n${renderClickables(visible)}`,
    )
  }

  // 🔴 文本命中（`pickClickable`）判的是**元素本身能不能点**，但它看不见"谁盖在上面"——
  //    固定头／浮层／遮罩全部在 DOM 里"可见、可点、文字对得上"，**只有命中测试能问出来**。
  //    ⚠️ 这里的 `expect` 只能给到「同一位置的元素」这一层：采集器给的是坐标，不是 backendNodeId ⇒
  //       有 expect 时比的是**位置命中到的那个节点**；没有 expect 时只报告"落到了谁"。
  const probe = await hitTestAt(slot, targetId, res.el.x, res.el.y)
  const hit = judgeHit(probe)
  if (hit.kind === 'offscreen' || hit.kind === 'blank') {
    throw new Error(
      `⛔ Not clicking "${opts.text}": ${renderHit(hit)}\n` +
        `  ⇒ "Found" and "can be clicked" are two different things: visible and clickable in the DOM does not mean this click lands on it.`,
    )
  }

  const clicked = await clickAt(slot, targetId, res.el.x, res.el.y)
  pageTouched(root, slot)
  return { picked: res.el, total: list.length, dialogs: clicked.dialogs, hit }
}

/** 列当前槽位上的 targets */
export async function slotTargets(root: string, slot: number, sessionId: string): Promise<CdpTarget[]> {
  assertSlotOwned(root, slot, sessionId)
  const list = await listTargets(slot)
  pageTouched(root, slot)
  return list
}

/** 新开标签页 */
export async function slotOpen(
  root: string,
  slot: number,
  sessionId: string,
  url: string,
): Promise<string> {
  assertSlotOwned(root, slot, sessionId)
  const id = await openTab(slot, url)
  pageTouched(root, slot)
  return id
}

/** 导航 */
export async function slotGoto(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  url: string,
): Promise<void> {
  assertSlotOwned(root, slot, sessionId)
  await navigate(slot, targetId, url)
  pageTouched(root, slot)
}

/** 页面内求值 */
export async function slotEval(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  expression: string,
  timeoutMs?: number,
): Promise<unknown> {
  assertSlotOwned(root, slot, sessionId)
  const v = await evalInPage(slot, targetId, expression, timeoutMs)
  pageTouched(root, slot)
  return v
}

/** 正文 */
export async function slotText(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
): Promise<string> {
  assertSlotOwned(root, slot, sessionId)
  const v = await pageText(slot, targetId)
  pageTouched(root, slot)
  return v
}

/** HTML */
export async function slotHtml(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  max?: number,
): Promise<string> {
  assertSlotOwned(root, slot, sessionId)
  const v = await pageHtml(slot, targetId, max)
  pageTouched(root, slot)
  return v
}

/**
 * 截图（落点必须在 CCC 根内）。
 *
 * 🔴 **两级策略**（2026-11-28 真机取证后定，⛔ 不是拍脑袋）：
 *   ① 先在**原页面**上拍（标准路径 / 三条变体）—— 这是唯一能保住登录态与滚动位置的路径。
 *   ② 原页面拍不到（锁屏时四条取帧通路全挂）⇒ 用**无头实例打开同一 URL 补拍**。
 *
 * ⚠️ **补拍不是原页取证**：全新 profile ⇒ 没有登录态、没有滚动位置、没有表单状态。
 *    ⇒ 返回值里 `rescued=true` 必须一路传到回执上，⛔ 不许静默替代。
 *    ⇒ 原页面取不到、补拍也失败 ⇒ 抛错（⛔ 不许返回空图冒充成功）。
 */
export async function slotShot(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  outRel: string,
): Promise<{ rel: string; via: string; ms: number; rescued: boolean }> {
  assertSlotOwned(root, slot, sessionId)
  const abs = resolveShotPath(root, outRel)

  // ① 原页面
  const direct = await screenshotOrNull(slot, targetId, abs)
  if (direct !== null) {
    pageTouched(root, slot)
    return { rel: outRel, via: direct.via, ms: direct.ms, rescued: false }
  }

  // ② 补拍：拿原 target 的 URL，开一个无头实例重拍
  const url = await pageUrl(slot, targetId)
  if (url === '') {
    throw new Error(
      '[browser_slot] shot 原页面取不到帧，且读不到它的当前地址 ⇒ 无法补拍。' +
        '（锁屏时最常见；解锁屏幕或换一个能读地址的目标）',
    )
  }
  const started = Date.now()
  const res = await headlessShot(url)
  if (res.data === '') {
    throw new Error(
      `[browser_slot] shot 原页面取不到帧（锁屏/遮挡），补拍也失败：${res.error ?? '未知原因'}。` +
        `这不是超时问题——该档在窗口不可见时不提交帧。`,
    )
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.from(res.data, 'base64'))
  pageTouched(root, slot)
  return { rel: outRel, via: 'headless-rescue', ms: Date.now() - started, rescued: true }
}

/** 重载（可先装探针脚本） */
export async function slotReload(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  script?: string,
): Promise<string> {
  assertSlotOwned(root, slot, sessionId)
  const state = await reloadPage(slot, targetId, script)
  pageTouched(root, slot)
  return state
}

/** 关标签页 */
export async function slotClose(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  all = false,
): Promise<string[]> {
  assertSlotOwned(root, slot, sessionId)
  const closed = await closeTab(slot, targetId, all)
  pageTouched(root, slot)
  return closed
}

// ═══════════════════════════════════════════════════════════════════
// ②b 高阶页面动作（v1.130.0）—— 判定在各自模块，执行在 cdp.ts，这里只编排
// ═══════════════════════════════════════════════════════════════════

/**
 * 把 `--ref` 解成 backendNodeId。**格式不对或已失效 ⇒ 明确拒绝**，⛔ 不回落。
 *
 * 🔴 判据（与 D311 的 `--match` 同族，但后果更重）：
 *    ref 失效（页面导航后、节点被删后）时，如果**悄悄重取一次快照再按顺序找**，
 *    很可能命中「另一个元素」—— 于是点击落在一个你看不见的地方，而回执完全正常。
 *    ⇒ 唯一允许的是**报错 ＋ 指路**：重跑 `ax` 拿新 ref。
 */
export function needBackendId(args: Record<string, unknown>): number {
  const ref = typeof args.ref === 'string' ? args.ref : ''
  if (!ref) {
    throw new Error(
      `⛔ needs --ref=<eNNN> (run \`browser_slot ax\` to get a ref first).\n` +
        `  ⇒ A ref comes from an accessibility-tree snapshot; ⛔ it is not a DOM selector or CSS path.`,
    );
  }
  const id = refToBackendId(ref)
  if (id === null) {
    throw new Error(
      `⛔ malformed --ref: ${JSON.stringify(ref)} (expected e12345, as printed by \`ax\`).\n` +
        `  ⛔ CSS selectors / text are not accepted — those need guessing, and a wrong guess drives another element with no signal.`,
    );
  }
  return id
}

/** AX 快照 */
export async function slotAx(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  limit = 200,
): Promise<{ lines: AxLine[]; total: number }> {
  assertSlotOwned(root, slot, sessionId)
  const nodes = await captureAx(slot, targetId)
  const lines = pruneAx(nodes, limit)
  pageTouched(root, slot)
  // total = 剪枝后未被 limit 截断时的条数（让渲染能说「另有 N 个」）
  const all = pruneAx(nodes, Number.MAX_SAFE_INTEGER)
  return { lines, total: all.length }
}

/** 按键（语义键 + 快捷键）；返回实际发出的次数 */
export async function slotPress(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  keyDesc: string,
  times = 1,
): Promise<{ stroke: KeyStroke; sent: number }> {
  assertSlotOwned(root, slot, sessionId)
  const stroke = parseKeyStroke(keyDesc)
  if (!stroke) {
    throw new Error(
      `⛔ Cannot parse key: ${JSON.stringify(keyDesc)}.\n` +
        `  ⇒ Accepted forms: Enter / Escape / Tab / ArrowUp|Down|Left|Right / Home / End / PageUp / PageDown / Space / Backspace / Delete; ` +
        `join modifiers with + (Control+A / Meta+Shift+Enter); single chars limited to a-z 0-9.\n` +
        `  ⇒ To type free text into a field use type (goes through Input.insertText, no key guessing): --text=<text>`,
    );
  }
  const sent = await pressKey(slot, targetId, stroke, times)
  pageTouched(root, slot)
  return { stroke, sent }
}

/** 打字（走浏览器文本输入路径；作用于当前焦点） */
export async function slotType(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  text: string,
): Promise<void> {
  assertSlotOwned(root, slot, sessionId)
  await insertText(slot, targetId, text)
  pageTouched(root, slot)
}

/**
 * 填值（按 ref）。
 *
 * 🔴 回执**只报读回来的值**，⛔ 不报「设置成功」—— 见 `cdp.ts` FILL_FN 的判据。
 *    调用方要判成功，必须自己比 `readBack === 期望值`（或再 `eval` 读一次）。
 */
export async function slotFill(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  backendNodeId: number,
  value: string,
): Promise<{ ok: boolean; tag: string; readBack: string; why?: string }> {
  assertSlotOwned(root, slot, sessionId)
  const r = await fillByBackendId(slot, targetId, backendNodeId, value)
  pageTouched(root, slot)
  return r;
}

/**
 * 滚动：`--ref`（滚到元素可见）/ `--xy`（在该点滚）/ `--to top|bottom`（整页）。
 *
 * 🔴 判据：滚到元素时**先量盒模型再滚**，⛔ 不用 `scrollIntoView` ——
 *    后者会改页面的滚动容器与动画状态，且**在虚拟列表里不触发懒加载**（它只移动视口）；
 *    而这里走的是**真实 wheel 事件**，浏览器自己会做该做的事。
 */
export async function slotScroll(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  opts: { ref?: number; xy?: { x: number; y: number }; to?: 'top' | 'bottom'; deltaY?: number },
): Promise<{ scrolledY: number; via: 'wheel' | 'js-fallback'; why?: string }> {
  assertSlotOwned(root, slot, sessionId)
  // 目标点：给了 ref 就量它的盒中心；给了 xy 就用它；否则视口中心
  let at = opts.xy ?? { x: 600, y: 400 }
  if (opts.ref !== undefined) {
    const b = await boxCenterByBackendId(slot, targetId, opts.ref)
    at = { x: b.x, y: b.y }
  }
  const before = Number(await evalInPage(slot, targetId, 'String(window.scrollY || 0)'))
  const r =
    opts.to === 'top'
      ? await scrollAt(slot, targetId, at.x, at.y, 0, -100_000)
      : opts.to === 'bottom'
        ? await scrollAt(slot, targetId, at.x, at.y, 0, 100_000)
        : await scrollAt(slot, targetId, at.x, at.y, 0, opts.deltaY ?? 600)
  // 🔴 等一帧再量：wheel 事件是异步生效的，立刻读 scrollY 会读到旧值（而那是「滚动没动」的形状）
  await new Promise((r) => setTimeout(r, 250))
  const after = Number(await evalInPage(slot, targetId, 'String(window.scrollY || 0)'))
  pageTouched(root, slot)
  return { scrolledY: Number.isFinite(after - before) ? after - before : 0, via: r.via, ...(r.why ? { why: r.why } : {}) }
}

/** 等待条件成立（条件由 `wait-spec.ts` 解析） */
export async function slotWait(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  raw: string,
  timeoutMs: number,
): Promise<{ spec: WaitSpec; waitedMs: number }> {
  assertSlotOwned(root, slot, sessionId)
  const spec = parseWaitSpec(raw)
  if (!spec) {
    throw new Error(
      `⛔ Cannot parse wait condition: ${JSON.stringify(raw)}.\n` +
        `  ⇒ Accepted forms (prefix required; a bare value is ambiguous and may wait for something that never comes):\n` +
        `     selector:<CSS>   text:<substring>   url:<substring>   gone:<CSS>   js:<expression>`,
    );
  }
  const r = await waitForInPage(slot, targetId, spec.expression, timeoutMs)
  pageTouched(root, slot)
  if (!r.ok) throw new Error(explainWaitTimeout(spec, r.waitedMs, r.last))
  return { spec, waitedMs: r.waitedMs }
}

/** 拖拽（坐标；判定在调用方，执行在 cdp.ts） */
export async function slotDrag(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  assertSlotOwned(root, slot, sessionId)
  await dragFromTo(slot, targetId, from, to, steps)
  pageTouched(root, slot)
}

/**
 * 上传（路径必须在 CCC 根内 —— 这是本轮唯一的「把本地文件送进网页」动作）。
 *
 * 🔴 守卫三条（判据在 `cdp.ts` uploadFiles 头注释；这里做**路径侧**那两条）：
 *   ① 每个路径都过 `resolveInside`（CCC 根外一律拒）
 *   ② 必须是**真实存在的普通文件**（`DOM.setFileInputFiles` 对不存在的路径**静默成功**）
 */
export function resolveUploadPath(cccRoot: string, relOrAbs: string): string {
  // resolveInside 自己会抛（越界/不存在由调用方另行核对）
  const abs = resolveInside(cccRoot, relOrAbs)
  let st: { isFile: () => boolean; size: number }
  try {
    st = statSync(abs)
  } catch {
    throw new Error(
      `⛔ File does not exist: ${relOrAbs} (resolved to ${abs}).\n` +
        `  ⚠️ This refusal is necessary: DOM.setFileInputFiles SILENTLY SUCCEEDS on a missing path, ` +
        `the form field stays empty, and the page looks exactly like "uploading".`,
    );
  }
  if (!st.isFile()) {
    throw new Error(`⛔ Not a regular file (directory/device/symlink): ${relOrAbs}`)
  }
  return abs;
}
export async function slotUpload(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  backendNodeId: number,
  absPaths: readonly string[],
): Promise<{ files: string[] }> {
  assertSlotOwned(root, slot, sessionId)
  const r = await uploadFiles(slot, targetId, backendNodeId, absPaths)
  pageTouched(root, slot)
  return r;
}

/**
 * 下载：把捕获目录指向 `<CCC 根>/_tmp/browser-downloads/b<slot>/` 并列出其中文件。
 *
 * 🔴 为什么目录**由本函数决定**而不是调用方传：
 *    下载落点是「这个文件哪来的」的一部分。让人随便传 ⇒ 下一次读数时
 *    没人能重建「这个文件是这次下载的，还是上次留下的」。⇒ 固定目录 + 前缀不清理。
 *    ⚠️ **不自动清理**：清理掉的是**证据**。要清理由人来做。
 */
export const DOWNLOAD_DIR_REL = '_tmp/browser-downloads';
export function downloadDirFor(root: string, slot: number): string {
  return join(root, DOWNLOAD_DIR_REL, slotLabel(slot));
}
export async function slotDownloads(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
): Promise<{ dir: string; files: Array<{ name: string; bytes: number }> }> {
  assertSlotOwned(root, slot, sessionId)
  const dir = downloadDirFor(root, slot)
  mkdirSync(dir, { recursive: true })
  await enableDownloads(slot, targetId, dir)
  pageTouched(root, slot)
  return { dir: `${DOWNLOAD_DIR_REL}/${slotLabel(slot)}`, files: listDownloaded(dir) }
}

/** dialog：默认 dismiss（见 cdp.ts handleDialog 判据） */
export async function slotDialog(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  accept: boolean,
  promptText?: string,
): Promise<{ hadDialog: boolean; type: string; message: string; accepted: boolean }> {
  assertSlotOwned(root, slot, sessionId)
  const r = await handleDialog(slot, targetId, accept, promptText)
  pageTouched(root, slot)
  return r;
}

// ═══════════════════════════════════════════════════════════════════
// ③ 扩展层 —— CCC 给 browser_slot 写扩展（ACC 只 spawn，从不 import）
// ═══════════════════════════════════════════════════════════════════

/** 列本 CCC 的扩展 */
export function slotExtList(root: string): ExtEntry[] {
  return listExtensions(root)
}

/**
 * 跑一个扩展。
 *
 * 🔴 归属检查与页面层同一条：扩展能驱动槽位里的浏览器 ⇒ 它跑的必须是你租的那个槽。
 * ⚠️ 扩展**不受 SLOT_ACTIONS 约束** —— 那正是扩展的意义（ACC 不预知它要做什么）。
 *    它拿到的只有 slot/port/cccRoot/args，⛔ 拿不到别人的台账。
 */
export async function slotExt(
  root: string,
  slot: number,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ExtRunResult> {
  assertSlotOwned(root, slot, sessionId)
  const entry = findExtension(root, name)
  if (!entry) {
    const known = listExtensions(root).map((e) => e.name)
    return {
      ok: false,
      code: 'ext-not-found',
      error:
        `No extension named "${name}".\n` +
        (known.length > 0
          ? `  ⇒ Extensions in this CCC: ${known.join(', ')}`
          : `  ⇒ This CCC has no extensions yet (no .ts files under <CCC root>/${EXT_DIR_REL}/).\n` +
            `     To add one: stdin gets {slot,port,cccRoot,args}; the last stdout line returns {"ok":true,"result":…}`),
    }
  }
  const payload = buildExtPayload({
    name,
    slot,
    port: slotPort(slot),
    cccRoot: root,
    args,
  })
  const res = await runExtension(entry, payload)
  pageTouched(root, slot)
  return res
}
