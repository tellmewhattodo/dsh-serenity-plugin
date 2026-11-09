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
}

export const DEFAULT_POLICY: SlotPolicy = {
  idleMs: 15 * 60_000,
  leaseMaxMs: 2 * 60 * 60_000,
  cpuPct: 80,
  rssMb: 2500,
  nudgeCooldownMs: 20 * 60_000,
  nudgeEscalateAt: 2,
}

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
  if (idle > policy.idleMs) reasons.push(`已 ${Math.round(idle / 60_000)} 分钟无动作`)
  if (now - lease.leasedAt > policy.leaseMaxMs) {
    reasons.push(`占用已超 ${Math.round(policy.leaseMaxMs / 60_000)} 分钟上限`)
  }
  if (proc && proc.cpuPct >= policy.cpuPct) reasons.push(`CPU ${proc.cpuPct.toFixed(0)}% 超阈值`)
  if (proc && proc.rssMb >= policy.rssMb) reasons.push(`内存 ${proc.rssMb.toFixed(0)}MB 超阈值`)

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
  const head = `[浏览器槽位看守] 槽位 ${slotLabel(slot)}（端口 ${slotPort(slot)}）需要你处理。`
  const rel = `  已租用，请**用完立刻 release**：\`browser_slot release ${slotLabel(slot)}\``
  if (state === 'orphaned') {
    return (
      `${head}\n` +
      `  现象：该槽位的 Chrome 进程已经不在了。\n` +
      `  ⚠️ 你现在如果还在用它，接下来的操作会失败 —— 但**不会自动恢复**。\n` +
      `  ⇒ 要做的事：\`browser_slot release ${slotLabel(slot)}\` 交还，再 \`acquire\` 重新租一个。\n` +
      `${rel}`
    )
  }
  const why = reasons.length > 0 ? reasons.join('；') : '状态异常'
  const thresholds =
    `  判据（你越了哪条线）：闲置 ${Math.round(policy.idleMs / 60_000)} 分钟 / ` +
    `CPU ${policy.cpuPct}% / 内存 ${policy.rssMb}MB / 占用上限 ${Math.round(policy.leaseMaxMs / 60_000)} 分钟。`
  const escalate = `若你已不再需要它，release 即可 —— 这是最省事的一步。`
  return (
    `${head}\n` +
    `  现象：${why}\n` +
    `${thresholds}\n` +
    `  为什么找你：这个槽位是**你**租的，只有你知道它还有没有用。\n` +
    `  ⇒ 还在用：把闲置阈值以下的动作做一次，或先 release 再重新租（会刷新计时）。\n` +
    `  ⇒ 不用了：${escalate}\n` +
    `${rel}`
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
