/**
 * browser/state.ts — 浏览器槽位状态机（纯逻辑，零 I/O）
 *
 * 🔴 为什么把"状态判定"单独抽成纯函数：槽位的三种异常（长期不动、CPU 过高、占用超时）
 *    全都会导致**同一个后果 —— 注入一条消息去提醒占用它的会话**。而这个后果是**有代价的**
 *    （打断一个正在干活的 agent）。⇒ 判定必须能在没有 Chrome、没有时钟、没有文件系统的
 *    情况下被**逐个用例验到边界**，否则它只能在真机上一次一次试。
 *
 * 槽位模型（owner 2026-11-09 令）：
 *   · 最多 20 个槽位，每个槽位**独立 profile**（互不共享 cookie/登录态）
 *   · 每个槽位**固定分辨率**（同一槽位跨会话分辨率不变 ⇒ 截图可比）
 *   · 每个槽位**有状态**，且"是否已被某会话占用"必须可读
 *   · 会话用完**自觉退出占用**（release）；不退出 ⇒ 由看守兜底
 *
 * ⚠️ 状态是**推导出来的**，不是存起来的。落盘的只有"事实"（谁租的、何时、最后一次动作何时），
 *    状态 = 事实 + 当前时刻的函数。理由：存状态会与事实漂移，而**漂移没有信号**。
 */

/** 槽位标号：`b1`..`b20`（1-based，与端口一一对应） */
export type SlotId = string

/** 槽位容量上限（owner 令：最多 20 个） */
export const MAX_SLOTS = 20

/** 槽位基端口。9222 已被现有 `browser` MSM 占用，故从 9301 起，避开 9222..9299 整段 */
export const BASE_PORT = 9301

/**
 * 固定分辨率表 —— 每个槽位**恒定**，⛔ 不随调用方变化。
 *
 * 🔴 为什么固定而不是"调用时随便传"：截图要能**跨会话对比**（改动前后的 UI 验收是本容器
 *    最常见的一类取证）。同一个槽位两次截图尺寸不同 ⇒ 差异里混进了"窗口变了"这个无关变量，
 *    而那**在图上分不出来**。⇒ 槽位 = 稳定的观测条件，变量留给被测对象。
 *
 * 分档理由：b1–b10 常用宽屏（1600×1000，与既有 pg/tg 两支实现的测试分辨率一致，
 * 便于把它们的用例平移过来）；b11–b20 给竖屏/窄幅场景（手机端 UI）。
 */
export const SLOT_RESOLUTION = (n: number): { width: number; height: number } =>
  n <= 10 ? { width: 1600, height: 1000 } : { width: 420, height: 900 }

/** 槽位 CDP 端口（n 为 1-based 槽位号） */
export const slotPort = (n: number): number => BASE_PORT + (n - 1)

/** 槽位标号生成 */
export const slotLabel = (n: number): SlotId => `b${n}`

/** 标号 → 槽位号（非法返回 0） */
export function slotNumber(id: SlotId): number {
  const m = /^b(\d{1,2})$/.exec(String(id ?? '').trim())
  if (!m) return 0
  const n = Number(m[1])
  return n >= 1 && n <= MAX_SLOTS ? n : 0
}

/**
 * 一条**占用事实**（= 落盘内容）。⛔ 不含状态：状态由 {@link deriveSlotState} 现算。
 *
 * `lastActionAt` 只由**成功的操作**推进 —— 见 staleSlotIds 的注释（这是本文件最容易被写错的一格）。
 */
export interface SlotLease {
  /** 槽位号 1..20 */
  slot: number
  /** 占用它的 dsh 会话 id（空串 = 无法归属，按最保守处置） */
  sessionId: string
  /** 占用它的轨迹目录名（可读性用；判定不依赖它） */
  trajectory: string
  /**
   * 占用方的 **CCC 根**（v2 新增）。
   *
   * 🔴 为什么必须有它（owner 2026-11-10 纠正）：槽位是**全 CCC 共用**的，
   *    而一个宿主实测服务 3 个 CCC。没有这个字段，台账上只能看到一串会话 id，
   *    而「这个浏览器是谁在占」这个问题**在读数上无法回答** ——
   *    会话 id 是 UUID，它不告诉你属于哪个 CCC。
   * ⚠️ 旧记录（v1）读成空串 ⇒ 界面显示「(未知 CCC)」，⛔ 不猜、⛔ 不回落。
   */
  cccRoot: string
  /** 租出时刻（ms） */
  leasedAt: number
  /** 最后一次**成功操作**时刻（ms）；刚租出时 = leasedAt */
  lastActionAt: number
  /** 该槽位被提醒过几次（用于升级与去重，见 shouldNudge） */
  nudges: number
  /** 上一次提醒时刻（ms）；0 = 从未提醒 */
  lastNudgeAt: number
  /** 该槽位对应的 chrome 主进程 pid；0 = 尚未启动 */
  pid: number
  /**
   * 保活截止时刻（ms）；0 = 未申请保活（owner 2026-11-24 裁：同意 `hold`）。
   *
   * 🔴 **它与 `lastActionAt` 是两件事，⛔ 不许合流**：
   *    `lastActionAt` = 「我刚做了一个动作」（事实）；
   *    `holdUntil`   = 「我预知接下来一段时间不会有动作，别判我闲置」（声明）。
   *    若用推进 `lastActionAt` 来实现保活，那么"真的在干活"与"申请了豁免"在读数上**同形** ——
   *    读它的人（包括看守自己、以及 `status` 的读者）会据此做错动作。
   *    本仓这条判据立过多次：一个读数在两种相反情况下取同一个值，报它等于报假。
   */
  holdUntil: number
}

/** 槽位对外状态（四个，互相穷尽） */
export type SlotState =
  /** 空槽：无占用者，进程若在则也应被回收 */
  | 'free'
  /** 占用中且一切正常（进程在、最近有动作） */
  | 'leased'
  /** 占用中但**异常**：长期无动作 / CPU 过高 / 进程已死 / 占用超时 —— 需要提醒或回收 */
  | 'stale'
  /** 有占用记录但进程不在了（最需要处理的一格：占用者以为还在用） */
  | 'orphaned'

/** 判定阈值 —— 全部可经环境变量覆盖，便于真机调参与测试注入 */
export interface SlotPolicy {
  /** 多久没动作算"长期不动作"（默认 15 min） */
  idleMs: number
  /** 占用多久算超时（默认 2 h，兜底） */
  leaseMaxMs: number
  /** 槽位进程 CPU 占比阈值（百分比，默认 80%） */
  cpuPct: number
  /** 进程 RSS 阈值（MB，默认 2500） */
  rssMb: number
  /** 同一槽位两次提醒的最小间隔（默认 20 min，防刷屏） */
  nudgeCooldownMs: number
  /** 提醒几次后升级为"建议直接回收"（默认 2） */
  nudgeEscalateAt: number
  /**
   * 🔴 **强制回收阈值**（owner 2026-11-24 令：「浏览器一直不关的现象严重」）。
   *
   * 闲置超过它 ⇒ **真的关掉**（destroySlot ＋ 删租约），并向占用者注入一条告知。
   * `0` = **关闭强关**（留一个彻底不杀的开关）。
   *
   * ## 为什么这条可以破「提醒不代它释放」那条老判据
   *
   * 老判据防的是「代为释放可能中断一个正在取的证」。而强关的前提是
   * **30 分钟一次操作都没有** —— `lastActionAt` 只由**成功的操作**推进（见 touchSlot），
   * 所以一个正在取证的浏览器**不可能**静默 30 分钟。
   * ⇒ 判据从「我不知道它还要不要」变成「**30 分钟的静默本身就是证据**」。
   *
   * ⚠️ 真实例外是长下载／慢查询 ⇒ 由 `hold`（见 SlotLease.holdUntil）提供逃生阀。
   */
  idleKillMs: number
}

export const DEFAULT_POLICY: SlotPolicy = {
  idleMs: 15 * 60_000,
  leaseMaxMs: 2 * 60 * 60_000,
  cpuPct: 80,
  rssMb: 2500,
  nudgeCooldownMs: 20 * 60_000,
  nudgeEscalateAt: 2,
  idleKillMs: 30 * 60_000,
}

/**
 * `hold` 单次可申请的上限（分钟）。
 * 理由：⛔ 不让 `hold` 变成"永久豁免" —— 那等于把强关架空，而强关正是 owner 要的东西。
 */
export const HOLD_MAX_MINUTES = 240

/** 从环境变量读策略（缺省回落 DEFAULT_POLICY；非法值静默回落，⛔ 不抛错） */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): SlotPolicy {
  const num = (k: string, d: number): number => {
    const raw = env[k]
    if (raw === undefined || raw === '') return d
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  const min = 60_000
  return {
    idleMs: num('SERENITY_SLOT_IDLE_MS', DEFAULT_POLICY.idleMs),
    leaseMaxMs: num('SERENITY_SLOT_LEASE_MAX_MS', DEFAULT_POLICY.leaseMaxMs),
    cpuPct: num('SERENITY_SLOT_CPU_PCT', DEFAULT_POLICY.cpuPct),
    rssMb: num('SERENITY_SLOT_RSS_MB', DEFAULT_POLICY.rssMb),
    nudgeCooldownMs: Math.max(num('SERENITY_SLOT_NUDGE_COOLDOWN_MS', DEFAULT_POLICY.nudgeCooldownMs), min),
    nudgeEscalateAt: num('SERENITY_SLOT_NUDGE_ESCALATE_AT', DEFAULT_POLICY.nudgeEscalateAt),
    // 🔴 允许显式 0 = 关闭强关。⚠️ 但 `num()` 对"非法值"回落到默认 —— 所以这里必须区开
    //    「显式给 0」与「没给／给错」：前者是 owner 想要的关闭开关，后者是配置写错。
    idleKillMs: env['SERENITY_SLOT_IDLE_KILL_MS'] === '0'
      ? 0
      : num('SERENITY_SLOT_IDLE_KILL_MS', DEFAULT_POLICY.idleKillMs),
  }
}

/** 进程读数（由调用方采集；纯函数只消费，不采集） */
export interface SlotProcReading {
  /** 进程是否存活 */
  alive: boolean
  /** 该槽位进程树累计 CPU 百分比（ps 的 pcpu 语义：累计 CPU ÷ 存活时长） */
  cpuPct: number
  /** 进程树 RSS 合计（MB） */
  rssMb: number
}

/**
 * 推导槽位状态。
 *
 * 🔴 判定顺序**有意义**（⛔ 不要重排）：
 *   ① `orphaned` 优先于 `stale` —— 进程没了是比"不动作"更硬的事实。
 *      若先判 stale，一个死掉的槽位会被报成"它在闲置"，占用者据此以为还能继续用。
 *   ② `free` 只在"无占用者"时成立，与进程死活无关（空闲但进程还在 = 该被回收，仍是 free）。
 *   ③ 剩下的才看闲置/超时/资源。
 */
export function deriveSlotState(
  lease: SlotLease | null,
  proc: SlotProcReading | null,
  now: number,
  policy: SlotPolicy = DEFAULT_POLICY,
): { state: SlotState; reasons: string[] } {
  if (!lease) return { state: 'free', reasons: [] }

  const reasons: string[] = []
  if (proc && !proc.alive) return { state: 'orphaned', reasons: ['进程已退出'] }

  const idle = now - lease.lastActionAt
  // 🔴 保活期间**不判闲置**（owner 2026-11-24 裁：同意 hold）。
  //    ⚠️ 但 CPU／内存／占用上限**照判** —— 那三条与"我还在用"无关，
  //    一个申请了保活却把内存吃满的槽位仍然异常。
  const holding = lease.holdUntil > now
  if (!holding && idle > policy.idleMs) reasons.push(`idle ${Math.round(idle / 60_000)}m`)
  if (now - lease.leasedAt > policy.leaseMaxMs) {
    reasons.push(`held over ${Math.round(policy.leaseMaxMs / 60_000)}m cap`)
  }
  if (proc && proc.cpuPct >= policy.cpuPct) reasons.push(`CPU ${proc.cpuPct.toFixed(0)}% over threshold`)
  if (proc && proc.rssMb >= policy.rssMb) reasons.push(`rss ${proc.rssMb.toFixed(0)}MB over threshold`)

  return reasons.length > 0 ? { state: 'stale', reasons } : { state: 'leased', reasons: [] }
}

/**
 * 是否该给占用者发提醒。
 *
 * 🔴 **为什么不提醒 `orphaned`**：进程都没了，提醒它"管好你的浏览器"是**错的指令** ——
 *    占用者会去检查一个不存在的进程，而真正该做的是**重新租一个**。⇒ 这两种状态给**不同的文本**
 *    （见 nudgeText），⛔ 不合并成一句"你的槽位异常了"。
 *
 * 🔴 **为什么要有冷却**：看守每个 tick 都会重新判定，而"闲置"这个条件**一旦成立就一直成立**
 *    ⇒ 没有冷却的话，一个忘了退出的会话会被每 tick 叫一次，直到它被淹没。
 */
export function shouldNudge(lease: SlotLease, state: SlotState, now: number, policy: SlotPolicy): boolean {
  if (state !== 'stale' && state !== 'orphaned') return false
  if (lease.lastNudgeAt === 0) return true
  return now - lease.lastNudgeAt >= policy.nudgeCooldownMs
}

/**
 * 提醒文本。分四档，因为**四种成因要四种不同动作**。
 *
 * 🔴 这正是本仓反复付过代价的那条判据（同值歧义）：一个读数在两种相反情况下取同一个值 ⇒
 *    报状态名而不报集合，等于让收到的人去做错的动作。「槽位异常」四个字会让占用者去查 CPU，
 *    而它真正该做的是 `release`。⇒ 每条文本都把**具体动作**写明。
 */
export function nudgeText(
  slot: number,
  state: SlotState,
  reasons: string[],
  policy: SlotPolicy,
): string {
  const head = `[slot-watchman] slot ${slotLabel(slot)} (port ${slotPort(slot)}) needs your action.`
  const rel = `  You hold it — **release as soon as you are done**: \`browser_slot release ${slotLabel(slot)}\``
  if (state === 'orphaned') {
    return (
      `${head}\n` +
      `  What: the Chrome process for this slot is gone.\n` +
      `  ⚠️ If you still need it, further calls will fail — it will NOT recover by itself.\n` +
      `  ⇒ Do this: \`browser_slot release ${slotLabel(slot)}\` to hand it back, then \`acquire\` a fresh slot.\n` +
      `${rel}`
    )
  }
  const why = reasons.length > 0 ? reasons.join('; ') : 'abnormal state'
  const thresholds =
    `  Thresholds (which line you crossed): idle ${Math.round(policy.idleMs / 60_000)}m / ` +
    `CPU ${policy.cpuPct}% / rss ${policy.rssMb}MB / held cap ${Math.round(policy.leaseMaxMs / 60_000)}m.`
  const escalate = `if you no longer need it, just release — that is the cheapest step.`
  return (
    `${head}\n` +
    `  What: ${why}\n` +
    `${thresholds}\n` +
    `  Why you: **you** leased this slot; only you know whether it is still needed.\n` +
    `  ⇒ Still using it: perform any action below the idle threshold, or release and re-acquire (resets the timer).\n` +
    `  ⇒ Done with it: ${escalate}\n` +
    `${rel}`
  )
}

/**
 * 🔴 **强关判定（纯函数，owner 2026-11-24 令）**。
 *
 * 「浏览器一直不关的现象严重」⇒ 把"劝"改成"劝不动就关"。
 *
 * ## 三条**必须同时成立**（⛔ 少一条就退化成误杀）
 *
 * | # | 条件 | 为什么 |
 * |---|---|---|
 * | ① | 闲置 ≥ `idleKillMs`（默认 30 min） | owner 裁的阈值 |
 * | ② | 进程**仍活着** | 进程都没了走 `orphaned` 那条既有路径，⛔ 不走强关 |
 * | ③ | `nudges ≥ 1`（**至少提醒过一次**） | 🔴 **公平**：不能因为刚拍到它闲置就直接杀 —— 它可能一直在跑长任务、根本没看到提醒。**先提醒、后强关，顺序不可换** |
 *
 * 另外两条闸门：
 * - `idleKillMs === 0` ⇒ **永不强关**（owner 可整体关闭）；
 * - `holdUntil > now` ⇒ **不动**（保活期内）。
 *
 * @returns `null` = 不该强关；否则返回强关原因（用于注入文案与台账留痕）
 */
export function shouldForceReap(
  lease: SlotLease | null,
  proc: SlotProcReading | null,
  now: number,
  policy: SlotPolicy = DEFAULT_POLICY,
): { idleMin: number; nudges: number } | null {
  if (!lease) return null
  if (policy.idleKillMs <= 0) return null          // 闸门：owner 关闭了强关
  if (lease.holdUntil > now) return null           // 闸门：保活期内
  if (proc && !proc.alive) return null             // ② 进程已死 ⇒ 走 orphaned 那条
  if (lease.nudges < 1) return null                // ③ 先提醒、后强关
  const idle = now - lease.lastActionAt
  if (idle < policy.idleKillMs) return null        // ① 未到阈值
  return { idleMin: Math.round(idle / 60_000), nudges: lease.nudges }
}

/**
 * 强关后的**告知**文本（注入给占用者）。
 *
 * 🔴 判据：**必须三件事都给** ——
 * ① 发生了什么（被强制回收了，多少分钟没动作）；
 * ② 损失了什么／没损失什么（浏览器关了；**profile 保留、登录态还在**）；
 * ③ 下次怎么避免（`hold` 保活），以及怎么继续（重新 acquire）。
 * ⛔ 不写"你的槽位异常了" —— 那是无法行动的话。
 */
export function forceReapText(
  slot: number,
  idleMin: number,
  nudges: number,
  policy: SlotPolicy = DEFAULT_POLICY,
): string {
  return (
    `[slot-watchman] slot ${slotLabel(slot)} was **force-reclaimed** (idle ${idleMin}m, nudged ${nudges}x before).\n` +
    `  · Your browser is closed. **The profile dir is kept** ⇒ login sessions survive; re-acquire without re-login.\n` +
    `  · If this was a false kill (long download, slow query), hold it next time:\n` +
    `      \`browser_slot hold --slot ${slotLabel(slot)} --reason "<what you are doing>" --holdFor <minutes>\`\n` +
    `  · To continue: just \`acquire\` again.\n` +
    `  Why me: the idle threshold is ${Math.round(policy.idleKillMs / 60_000)}m — `
    + `a browser actually doing work does not go silent that long.`
  )
}

/**
 * 选一个空槽。⛔ 不做"最久未用优先"这类聪明事 —— 20 个槽位装得下，选择规则越简单越可预测。
 * 返回 0 = 满。
 */
export function pickFreeSlot(leases: SlotLease[]): number {
  const used = new Set(leases.map((l) => l.slot))
  for (let n = 1; n <= MAX_SLOTS; n++) if (!used.has(n)) return n
  return 0
}

/**
 * 同进程内"同一会话再次 acquire"应当**复用**它已持有的槽位，⛔ 而不是再租一个。
 * 理由：一次会话要两个浏览器实例是极少数；而"不小心租了两个又只 release 一个"
 * 会**静默泄漏**一个槽位和一个 Chrome 进程 —— 这正是本次事故的形状。
 */
export function findLeaseBySession(leases: SlotLease[], sessionId: string): SlotLease | null {
  if (!sessionId) return null
  return leases.find((l) => l.sessionId === sessionId) ?? null
}
