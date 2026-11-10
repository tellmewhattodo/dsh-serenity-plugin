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

import { existsSync } from 'node:fs'
import {
  DEFAULT_POLICY,
  MAX_SLOTS,
  SLOT_RESOLUTION,
  deriveSlotState,
  findLeaseBySession,
  nudgeText,
  pickFreeSlot,
  policyFromEnv,
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
  closeTab,
  evalInPage,
  listTargets,
  navigate,
  openTab,
  pageHtml,
  pageText,
  reloadPage,
  resolveShotPath,
  screenshot,
  type CdpTarget,
} from './cdp.js'
import {
  EXT_DIR_REL,
  buildExtPayload,
  findExtension,
  listExtensions,
  runExtension,
  type ExtEntry,
  type ExtRunResult,
} from './extend.js'

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
        `你在槽位 ${slotLabel(existing.slot)}（端口 ${slotPort(existing.slot)}）上已有占用，已复用。\n` +
        `  ⛔ 不要再租第二个 —— 一次会话占两个槽位是本次事故的形状（租了忘记退）。\n` +
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
        `20 个槽位已全部占用，⛔ 拒绝再租。\n` +
        `  ⇒ 先看谁占着：\`browser_slot list\`；不用了的用 \`release <槽>\` 交还。\n` +
        `  ⚠️ 槽位满通常不是"需求多"，而是**有人忘了 release** —— 看 idleMin 最大的那一行。`,
    }
  }
  if (picked < 0) {
    return {
      ok: false,
      slot: -picked,
      state: 'leased',
      reused: false,
      detail: `槽位 ${slotLabel(-picked)} 已被占用（⛔ 不抢占）。用 \`browser_slot list\` 看占用者，或省略槽位号让系统挑。`,
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
      `已租下槽位 ${slotLabel(n)}（端口 ${slotPort(n)}，${r.width}x${r.height}）。\n` +
      `${launched.detail}\n` +
      `🔴 **用完必须交还**：\`browser_slot release ${slotLabel(n)}\`\n` +
      `  忘了交还的话，看守会在它闲置超过阈值时来提醒你 —— 那时你可能已经换了话题。`,
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
    return { ok: true, pid: live[0]!, detail: `槽位 ${slotLabel(n)} 进程已在（pid ${live[0]}）` }
  }
  if (pidHint > 0 && existsSync(`/proc/${pidHint}`)) {
    return { ok: true, pid: pidHint, detail: `槽位 ${slotLabel(n)} 进程已在（pid ${pidHint}）` }
  }
  const wait = backoffWaitMs(root, n, Date.now())
  if (wait > 0) {
    return {
      ok: false,
      pid: 0,
      detail:
        `槽位 ${slotLabel(n)} 处于**启动退避**中（还需 ${Math.ceil(wait / 1000)} 秒）。\n` +
        `  🔴 起因：该槽位连续启动失败。⇒ 反复重试会白付一次完整复检（数秒），且**读数上分不出来**。\n` +
        `  ⇒ 先查根因：\`browser_slot doctor\` 看 pidDrift 与日志路径；或换一个槽位。`,
    }
  }
  const launched = launchSlot(n)
  if (!launched.ok) {
    const w = noteLaunchFailure(root, n)
    return {
      ok: false,
      pid: 0,
      detail: `${launched.detail}\n  ⇒ 已记一次启动失败，下次允许尝试在 ${Math.ceil(w / 1000)} 秒后。`,
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
export function releaseSlot(root: string, sessionId: string, target: number): { ok: boolean; detail: string } {
  const ledger = readLedger()
  const lease = ledger.leases[String(target)]
  if (!lease) {
    return { ok: true, detail: `槽位 ${slotLabel(target)} 本就无人占用（无需释放）。` }
  }
  // 🔴 归属校验：只能释放自己的。⛔ 允许释放别人的会让"互相踩"变成合法动作。
  if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
    return {
      ok: false,
      detail:
        `槽位 ${slotLabel(target)} 不属于你（占用者：${lease.trajectory || lease.sessionId || '未知'}）。\n` +
        `  ⛔ 不代别人释放 —— 它可能正在用。若确信它已废弃，用 \`browser_slot reap <槽>\`（看守动作，会记录原因）。`,
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
    detail: `已释放槽位 ${slotLabel(target)}。${destroyed.detail}`,
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
    detail: `已回收槽位 ${slotLabel(target)}（原因：${reason}）。${destroyed.detail}`,
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

export type Injector = (root: string, target: string, message: string) => Promise<{ ok: boolean; detail: string }>

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
        detail: '该槽位没有归属轨迹（sessionId/trajectory 皆空）⇒ 无法注入，请人工处置',
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
      `槽位 ${slotLabel(slot)} 当前无人占用 ⇒ 先 \`browser_slot acquire\` 租一个再用。\n` +
        `  ⛔ 不自动替你租：租了不还就是 2026-11-09 那次 36 小时功耗事故的形状。`,
    )
  }
  if (sessionId === '' || lease.sessionId !== sessionId) {
    throw new Error(
      `槽位 ${slotLabel(slot)} 不是你租的（占用者 ${lease.sessionId || '(无)'}）⇒ 拒绝操作。\n` +
        `  ⇒ 自己的槽位用 \`browser_slot list\` 查；要新开一个用 \`browser_slot acquire\`。\n` +
        `  ⚠️ 硬拒绝是刻意的：放行会让"谁在动谁的浏览器"变成没有读数可查的事。`,
    )
  }
}

/** 把页面上一次成功的操作推进 lastActionAt（这就是"长期不动作"判据的来源） */
function pageTouched(root: string, slot: number): void {
  touchSlot(root, slot)
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

/** 截图（落点必须在 CCC 根内） */
export async function slotShot(
  root: string,
  slot: number,
  sessionId: string,
  targetId: string,
  outRel: string,
): Promise<string> {
  assertSlotOwned(root, slot, sessionId)
  const abs = resolveShotPath(root, outRel)
  await screenshot(slot, targetId, abs)
  pageTouched(root, slot)
  return outRel
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
        `没有名为「${name}」的扩展。\n` +
        (known.length > 0
          ? `  ⇒ 本 CCC 现有的扩展：${known.join(', ')}`
          : `  ⇒ 本 CCC 还没有任何扩展（<CCC 根>/${EXT_DIR_REL}/ 下没有 .ts 文件）。\n` +
            `     写一个：stdin 收 {slot,port,cccRoot,args}，stdout 最后一行给 {"ok":true,"result":…}`),
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
