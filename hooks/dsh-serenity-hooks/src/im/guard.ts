/**
 * im/guard.ts — 手动输出模式的**机械闸门**（v1.30.16，S142 用户"LLM 不听"）
 *
 * 🔴 **2026-10-24（D238）后本模块从"边缘"变成"主路径"**：`autoReplyWithLastMessage` 那条开关
 * 已整条退役 ⇒ **所有会话都是手动输出**（桥永不自动回发）⇒ 本闸门**每轮恒生效**。
 * 由此得到一条必配件判据（D234）：打回前**必须**先确认 `im-bridge` 对该轨迹可见 ——
 * 否则"该轨迹没有发送权"会被无解地打回成"忘了发"。见 `isImWiredTrajectory` 的使用处。
 * 下面第 4 行起的"问题（实证）"是**当时**的缘起叙述，其中提到的开关现已不存在。
 *
 * 问题（实证）：`weixin.autoReplyWithLastMessage: false` 时桥不回发最终文本，输出权归 agent
 * （必须自己调 `im-bridge` 工具，v1.30.x 为 `msm("weixin-send", …)`）。提示词层面已说明，
 * 但用户实测 **LLM 仍经常不发**——结果用户什么都收不到（静默）。这类"提示词软约束失效"正是 ACC
 * 该用机械守卫兜底的场景（与 output-guard 同一套思路：turn-stopping + agent.steer）。
 *
 * 本模块做三件事（全部是机制，不含任何纪律措辞——措辞归 CCC 角色提示词）：
 *  ① `noteManualOutputSession`：桥每轮把手动模式会话登记进来（含 root/account/user/role/**channel**）
 *  ② 订阅 `tools/post-execute`：观察本轮是否真的成功调用过输出工具（`im-bridge` 的
 *     `action=send|send-file`，兼容旧 `msm("weixin-send", …)`）——**只在执行成功时**计入
 *  ③ 订阅 `agent/turn-stopping`：本轮结束仍没有成功发送 → `agent.steer` 打回一次（≤2 次），
 *     提示内容 = **标记 + 事实**（"本轮未发送，用户什么都没收到"），具体怎么做由 CCC 角色
 *     提示词定义（与 per-message 标记同名 `[serenity:weixin-manual-output]`，模型能对上）。
 *
 * 🔴 **渠道中立（2026-10-20，Q4 出站飞书）**：本模块原先**处处假定微信**——
 * "成功判定"硬比 `channel === 'weixin'`、打回文案硬写 `channel:"weixin"`。
 * 接第二个渠道后那两处会让**飞书会话永远打回**（详见 `isSuccessfulImSend` 的注释）。
 * ⇒ 现在渠道由**登记时**带进来（缺省 `'weixin'`，既有调用点与测试读数不变）。
 * ⚠️ **标记字符串 `[serenity:weixin-manual-output]` 不改名**：CCC 侧的角色提示词按它做判据，
 *    改名会把所有已写好的 CCC 纪律文档打成废纸；它是一个**协议标记**，不是渠道名
 *    （与 `weixinSessionIdForTrajectory` 同一个处置，A85）。
 *
 * 为什么不直接替 agent 发送（R↓）：用户拍板的语义是"输出权归 agent"——代发会让 agent 误以为
 * 自己发过、也掩盖了"模型没遵守"这一事实；打回让模型自己完成，且留下可观测的日志。
 *
 * 达上限后放弃并**响亮告警**（不静默失败）：宁可让日志里出现一条明确记录，也不要假装正常。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deliver, makeInjection } from '../kernel/injection.js'
// 🔴 D234 修法（2026-10-24）：打回前先判「这条轨迹有没有 im-bridge 发送权」。
// 两个都是**判据函数**（不是 UI 逻辑）：可见性判据与打回判据必须**同源**。
import { isImWiredTrajectory } from './channels.js'
import { trajectoryCodeForSession } from '../trajectory/policy/profile.js'

/** 打回上限（超过则放弃并告警——避免与模型无限拉扯） */
export const WEIXIN_OUTPUT_REBUKE_MAX = 2

/** 手动模式会话上下文（桥登记） */
interface ManualOutputSession {
  root: string
  accountId: string
  userId: string
  role: string
  /**
   * 这个会话走的是哪个渠道（2026-10-20 Q4）。
   *
   * 🔴 它决定两件事：① 打回文案里那条命令该写哪个 `channel`；
   * ② 判定"本轮是否真的发出去了"时该认哪个 `channel`。
   * ⚠️ 缺省 `'weixin'` 保留既有调用点与测试的读数（B1 判据：微信行为逐字不变）。
   */
  channel?: string
}

const manualSessions = new Map<string, ManualOutputSession>()
/**
 * 「已发送」记账 —— 值是**发送发生时的轮号**（`null` = 取不到轮号，退化为旧语义）。
 *
 * ## 🔴 为什么必须是「轮号」而不是一个布尔（2026-10-21 实测缺陷）
 *
 * 旧形态是 `Set<sessionId>`：桥在**每条入站一到达**就 `clearSentThisTurn()`（`inbound-event.ts`），
 * 而闸门只在 `tools/post-execute` 置位、`turn-stopping` 只读。
 * ⇒ **一个还在跑的轮，它"我已经发了"的证据会被后到的那条入站抹掉。**
 *
 * 现场时刻线（真机，12:08~12:10）：`12:08:25` 发送成功 → `12:08:56` 新入站（抹）→
 * `12:09:19` 那一轮的 `turn-stopping` 读空 ⇒ 判"没发" ⇒ 打回 ⇒ 模型重答。
 * 用户看到的就是"同一条消息被处理了两轮"。
 *
 * ⇒ 记**轮号**之后：抹除操作可以问"我要抹的这一发，是不是**当前这一轮**发的"；
 *   `turn-stopping` 也可以问"这一发是不是**我这一轮**发的"。两处都从"是不是同一轮"出发，
 *   而不是从"这个会话有没有发过"出发。
 */
const sentTurn = new Map<string, number | null>()
/** 连续打回计数（成功发送即清零） */
const rebukeCounts = new Map<string, number>()
/** 闸门是否装配成功（v1.30.17：桥据此判断能否信任"未发送"这一判定——未装配时不兜底，防重复发送） */
let guardActive = false

/** 桥：登记手动模式会话（每轮 incoming 都调用，幂等覆盖） */
export function noteManualOutputSession(sessionId: string, session: ManualOutputSession): void {
  if (typeof sessionId !== 'string' || sessionId === '') return
  manualSessions.set(sessionId, session)
}

/** 桥：非手动模式 / 会话失效 → 注销（闸门随之失效，零干预） */
export function forgetManualOutputSession(sessionId: string): void {
  manualSessions.delete(sessionId)
  sentTurn.delete(sessionId)
  rebukeCounts.delete(sessionId)
}

/** 是否手动模式会话（测试/诊断用） */
export function isManualOutputSession(sessionId: string): boolean {
  return manualSessions.has(sessionId)
}

/**
 * 本轮是否已成功发送。
 *
 * @param turn 期望的轮号（`agent/turn-stopping` 的 `payload.turn`）。
 *   - **省略** ⇒ 旧语义："这个会话发过就算"（测试与桥的兜底判定用）。
 *   - **给了** ⇒ 按轮比：只有"**这一轮**发的"才算。
 *   - **任一侧取不到轮号**（记录是 `null`，或 `turn` 传了 `null`）⇒ **偏向"发过"**。
 *     🔴 方向是刻意的：误判"没发"的代价 = 打回 + 重复回答（用户看到两轮，本缺陷本尊）；
 *     误判"发过"的代价 = 少打回一次（用户可能真没收到一条）。前者已经发生过、后者尚未。
 */
export function hasSentThisTurn(sessionId: string, turn?: number | null): boolean {
  if (!sentTurn.has(sessionId)) return false
  if (turn === undefined) return true
  const recorded = sentTurn.get(sessionId) ?? null
  if (recorded === null || turn === null) return true // 任一侧取不到轮号 ⇒ 少打回
  return recorded === turn
}

/**
 * 🔴 **桥不再调用本函数**（2026-10-21）。
 *
 * 旧语义 `clearSentThisTurn(sessionId)` = "来了新消息就当这个会话没发过"，
 * 它**连正在跑那一轮的证据一起抹掉** —— 这正是"同一条消息被处理两轮"的根因：
 * `12:08:25 发送成功 → 12:08:56 新入站(抹) → 12:09:19 那一轮 turn-stopping 判"没发" ⇒ 打回`。
 *
 * ## 现在的分工（判据只有一处：轮号）
 *
 * - **置位**：`tools/post-execute` 发送成功 ⇒ 记下**当前轮号**（`currentTurnOf`）。
 * - **判定**：`agent/turn-stopping` 拿 `payload.turn` 与记录比对（`hasSentThisTurn`）。
 * - **陈旧**：靠"轮号不等"自然淘汰 —— 上一轮发的记录，在下一轮 stopping 时天然不匹配。
 *   ⇒ **不再需要任何"清空"动作**，也就不存在"清错人的记录"这件事。
 *
 * 本函数只留给**测试与显式重置**（如切换手动/自动模式）。`turn` 给定时按轮清，
 * 是给诊断用的窄口子，生产路径不调用。
 */
export function clearSentThisTurn(sessionId: string, turn?: number | null): void {
  if (turn === undefined || turn === null) {
    sentTurn.delete(sessionId)
    return
  }
  const recorded = sentTurn.get(sessionId)
  if (recorded !== undefined && recorded === turn) sentTurn.delete(sessionId)
}

/** 闸门是否装配成功（未装配 → 桥不做兜底：宁可静默也不冒重复发送的风险） */
export function isWeixinOutputGuardActive(): boolean {
  return guardActive
}

/** 从 agent / 会话对象取会话 id（形状宽容） */
function sessionIdOf(value: unknown): string | null {
  const v = value as { id?: unknown; session?: { id?: unknown } } | null | undefined
  const id = v?.session?.id ?? v?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 工具调用是否为「本轮成功发出了一条消息」。
 *
 * v1.31.0 起有两种合法形态（标记与闸门同时认，迁移期并存）：
 * - `im-bridge({channel:"<渠道>", action:"send"|"send-file", …})` —— ACC 工具（推荐）
 * - `msm("weixin-send", ["send"|"send-file", …])` —— CCC MSM（v1.30.x 通道，逐步退役）
 *
 * 🔴 **原名为 `isSuccessfulWeixinSend`，2026-10-20 改名**（Q4 出站飞书）：
 * 它曾硬比 `channel !== 'weixin' ⇒ false`。接第二个渠道后，那条判据的含义变成
 * **"只有微信算发出去了"** —— 而实际后果是：飞书会话里 agent 真的发成功了，
 * 闸门仍判"未发送" ⇒ 打回 ≤2 次，且当时的 `fallbackOnNoSend` 还会再兜底转发一遍
 * ⇒ **重复投递**。⇒ 判据从"是不是微信"改成"是不是**这个会话所在的那条渠道**"，
 * 函数名随之更正（**名字要能对着行为读**，D151/D179 同族）。
 *
 * @param channel 该会话的渠道（缺省 `'weixin'` = 既有调用点与测试的读数不变）
 */
export function isSuccessfulImSend(exec: unknown, result: unknown, channel = 'weixin'): boolean {
  const e = exec as { name?: unknown; arguments?: unknown } | null | undefined
  const r = result as { isError?: unknown } | null | undefined
  if (r?.isError === true) return false
  const args = e?.arguments as { name?: unknown; action?: unknown; channel?: unknown } | null | undefined
  if (e?.name === 'im-bridge') {
    const sent = typeof args?.channel === 'string' ? args.channel : ''
    if (sent !== channel) return false
    const action = typeof args?.action === 'string' ? args.action : ''
    return action === 'send' || action === 'send-file'
  }
  // 旧形态只存在于微信时代 ⇒ 只对微信渠道认它（飞书从来没有过这个 MSM）
  if (e?.name === 'msm') return channel === 'weixin' && args?.name === 'weixin-send'
  return false
}

/** 打回消息（机制事实 + 标记；怎么做由 CCC 角色提示词定义） */
export function buildManualOutputRebuke(session: ManualOutputSession): string {
  const channel = session.channel ?? 'weixin'
  return [
    '[serenity:weixin-manual-output] no send detected in this turn — the user has received NOTHING.',
    `ccc=${session.root} account=${session.accountId} user=${session.userId} channel=${channel}`,
    `im-bridge({channel:"${channel}", action:"send", account:"${session.accountId}", user:"${session.userId}", text:"<回复>"})`,
  ].join('\n')
}

/** 测试辅助：清空全部状态 */
export function __resetWeixinOutputGuardForTest(): void {
  manualSessions.clear()
  sentTurn.clear()
  rebukeCounts.clear()
  guardActive = false
}

/**
 * 从 `tools/post-execute` / 会话事件里取**当前轮号**（取不到 ⇒ `null`）。
 *
 * 为什么要费这个劲：修"同一条消息处理两轮"的判据是「这一发是不是**我这一轮**发的」，
 * 而 `tools/post-execute` 的 `exec` 上**不一定**带 turn（宿主形状随版本变）。
 * ⇒ 三级兜底：① `exec.turn` ② `agent.session` 的最后一个 `turn/start` ③ `null`（退化为旧语义）。
 * ⛔ `null` 时**绝不**当成"发过了/没发过"的强判据 —— 见 `hasSentThisTurn` 的降级说明。
 */
function currentTurnOf(exec: unknown, agent: unknown): number | null {
  const direct = (exec as { turn?: unknown } | null | undefined)?.turn
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const session = (agent as { session?: unknown } | null | undefined)?.session
  const events = (session as { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] } | null | undefined)
  const list = typeof events?.snapshotEvents === 'function' ? events.snapshotEvents() : events?.events
  if (!Array.isArray(list)) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i] as { type?: unknown; data?: { turn?: unknown } } | undefined
    if (e?.type === 'turn/start') {
      const t = e.data?.turn
      return typeof t === 'number' && Number.isFinite(t) ? t : null
    }
  }
  return null
}

/**
 * 装配闸门（index.ts apply 调用）。
 * 只对**已登记的手动模式会话**生效——其他会话（主舱/其他 轨迹约束会话）零干预。
 */
export function registerWeixinOutputGuard(ctx: Context): void {
  // ① 观察工具调用：本轮是否真的发过
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next()
      try {
        const sessionId = sessionIdOf((exec as { agent?: unknown } | undefined)?.agent)
        if (sessionId && manualSessions.has(sessionId)) {
          // 🔴 按**该会话自己的渠道**判（缺省 weixin）—— 见 `isSuccessfulImSend` 的名字更正说明
          const session = manualSessions.get(sessionId)
          if (isSuccessfulImSend(exec, result, session?.channel ?? 'weixin')) {
            // 🔴 记**轮号**（2026-10-21）：记布尔会让"后到的入站"把正在跑那一轮的证据抹掉。
            sentTurn.set(sessionId, currentTurnOf(exec, (exec as { agent?: unknown }).agent))
            rebukeCounts.delete(sessionId)
          }
        }
      } catch {
        /* 观测失败不影响工具执行 */
      }
      return downstream
    })
  } catch {
    /* 事件通道缺失 → 闸门不可用（退化为纯提示词约束，不阻断装配） */
    console.warn('[serenity-hooks] ✗ weixin 输出闸门未装配：tools/post-execute 不可用')
    return
  }

  // ② turn 结束结算：未发送 → 打回
  try {
    ctx.on('agent/turn-stopping', (payload: { agent?: Agent; turn?: number }) => {
      const agent = payload?.agent
      if (!agent) return
      const sessionId = sessionIdOf(agent)
      if (!sessionId) return
      const session = manualSessions.get(sessionId)
      if (!session) return
      // 🔴 按**轮**判（2026-10-21 修"同一条消息处理两轮"）：
      //    旧判据是"这个会话发过没有" ⇒ 一条新入站把标记抹掉后，**正在跑的这一轮**会被误判"没发"。
      //    `payload.turn` 由宿主给出；取不到时 `hasSentThisTurn` 退化为旧语义（少打回，不误打回）。
      const sent = hasSentThisTurn(sessionId, payload?.turn ?? null)
      if (sent) return

      /**
       * 🔴🔴 **D234 修法（2026-10-24，D238 强制同批）：先确认"它有权发"，再打回。**
       *
       * 缺陷（我 2026-10-23 查出的真缺陷）：v1.88.0 起 `im-bridge` **只对 IM 路由表点名的
       * 轨迹可见**（取不到轨迹编码即 fail-closed 隐藏）。而本闸门**无条件打回**，打回文案
       * （`buildManualOutputRebuke`）逐字要求调用的正是那个工具 ⇒ 对一条"能收到消息但没被
       * 路由表点名"的轨迹，**agent 无论如何都满足不了** ⇒ 连打 2 次后只剩告警，
       * 用户侧零输出。**打回命中一个不可满足的前置条件**（D205 同族：前置不成立必须显式红，
       * 而不是继续走必然失败的重试）。
       *
       * 🔴 为什么砍掉自动回发后这条变成**必配件**：手动模式成了唯一路径 ⇒ 本闸门**恒生效**
       * （不再有"自动模式"这条安全退路），缺陷从边缘情形升级为主路径。
       *
       * 判据（与 `seams/guards.ts` 的可见性判据**同源**，D235 的要求）：
       * 用同一个 `isImWiredTrajectory` 判——**可见性判据与打回判据必须同源**，
       * 否则两处各判一套，又会长出"能发但被判成不能发"这类漂移。
       */
      if (!isImWiredTrajectory(session.root, trajectoryCodeForSession(session.root, sessionId))) {
        // 不打回，但**必须出声**（D186：可以拒绝，但不许不出声；出声必须指名哪一半）
        console.warn(
          `[serenity-hooks] ✗ im 输出闸门：session=${sessionId} role=${session.role} `
          + `**没有 im-bridge 发送权**（该轨迹不在本 CCC 的 IM 路由表 im.routes 里）⇒ **不打回**。`
          + `本轮 agent 若想说话也无路可走 —— 请把该轨迹编码加进 .opencode/serenity.json 的 im.routes，`
          + `或让它把话交给已被点名的接线轨迹。`,
        )
        rebukeCounts.delete(sessionId)
        return
      }

      const count = (rebukeCounts.get(sessionId) ?? 0) + 1
      if (count > WEIXIN_OUTPUT_REBUKE_MAX) {
        rebukeCounts.delete(sessionId)
        // 达上限：放弃打回但**响亮告警**。
        // 🔴 D238 起不再有兜底（`fallbackOnNoSend` 已退役）⇒ 这句是**唯一的**失败信号。
        console.warn(
          `[serenity-hooks] ✗ weixin 输出闸门：连续 ${WEIXIN_OUTPUT_REBUKE_MAX} 次打回后仍未发送`
          + `（session=${sessionId}, role=${session.role}）——**本轮用户将收不到任何消息**`
          + `（兜底转发已于 2026-10-24 整条退役，出站只剩 im-bridge 一条路）`,
        )
        return
      }
      rebukeCounts.set(sessionId, count)
      // 🔴 **DII M2 · 注入点 #8**（2026-11-04）：改走 `deliver()`。
      //    `delivery:'wake-now'` ⇒ 通道由 deliver 选（steer），行为零变更。
      try {
        deliver(
          makeInjection({
            origin: 'acc',
            form: 'notice',
            summary: `IM 输出闸门打回（第 ${count} 次）`,
            text: buildManualOutputRebuke(session),
            delivery: 'wake-now',
          }),
          agent,
        )
        console.log(
          `[serenity-hooks] weixin 输出闸门：打回 ${count}/${WEIXIN_OUTPUT_REBUKE_MAX}（session=${sessionId}, turn=${payload.turn ?? '?'}）`,
        )
      } catch (error) {
        console.warn(`[serenity-hooks] ✗ weixin 输出闸门 steer 失败: ${String((error as Error)?.message ?? error)}`)
      }
    })
  } catch {
    console.warn('[serenity-hooks] ✗ weixin 输出闸门未装配：agent/turn-stopping 不可用')
    return
  }
  // 两个事件通道都装配成功 → 桥可信任"未发送"判定（v1.30.17 兜底前置条件）
  guardActive = true
}
