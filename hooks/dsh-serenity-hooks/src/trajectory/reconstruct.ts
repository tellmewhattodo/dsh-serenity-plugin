/**
 * trajectory/reconstruct.ts — **载体换代**：会话累计用量过大时换一条新载体（owner 2026-11-06 令）
 *
 * ## owner 要的是什么（原话拆成可判定的四条）
 *
 * > 「做个新功能，一个隐藏 tool：当当前会话累计输入 token 超过 1000m 的时候，
 * >  有个叫 `reconstruct` 的 tool 自动出现，配合提示词注入：当前轨迹载体会话 xxxx 已经过于庞大，
 * >  需要调用 `reconstruct` 进行重建。用起来和 rebuild 完全一样，唯一区别是先创建新会话 …
 * >  在提示词中指令绑定好轨迹并继续，然后归档当前会话」
 *
 * | # | 要素 | 落地形态 |
 * |---|---|---|
 * | 1 | 累计输入 token > 1000m | 阈值 = **1e9**（owner 裁「我这有好几个十亿的」） |
 * | 2 | 隐藏 tool 自动出现 | **`ctx.tools.register(def, { when })`** —— 不是 restrict，见下 |
 * | 3 | 提示词注入 | `seams/keeper.ts` 每轮超阈值注入一句，指明会话 id 与动作 |
 * | 4 | 与 rebuild 同语义、区别 = 先建新会话 → 绑轨迹 → 注入继续 → 归档旧的 | 本文件 |
 *
 * ## 🔴 「累计输入 token」到底是哪个量（**判错会让功能在最需要的会话上永不触发**）
 *
 * 宿主有两个**完全不同**的 token 量（`dsh-token-meter` 的两个 projection unit）：
 *
 * | 量 | 投影 key | 语义 | rebuild 后会不会回落 |
 * |---|---|---|---|
 * | 上下文压力 `projectedTokens` | `contextPressure` | **当前** prompt 有多大 | ✅ 会 |
 * | 累计用量 `totals`（四桶） | `tokenUsage` | **跨轮累加**的 provider 上报用量 | ❌ 不会 |
 *
 * owner 要的是后者。**但四桶里选哪几桶，两个读数都"像对的"**：
 *
 * | 口径 | 本轨 2026-11-06 实测（`session-afc28ede`） | 与 owner 截图（1372M）的判 |
 * |---|---|---|
 * | **四桶全加**（uncachedInput + cacheRead + cacheWrite + output） | **1391 M** | ✅ 就是它 |
 * | 只输入侧（前三桶） | 1388 M | 几乎同值（output 只占 3.0 M） |
 * | **只 `uncachedInputTokens`** | **37 M** | ❌ 差 37 倍 |
 *
 * ⇒ 成因：该会话 **97% 的输入是 cacheRead**（1351 M / 1388 M）。只读未命中缓存的那一格，
 *   会让阈值 10 亿**永远不触发**——而两个读数在代码里长得一样，谁都"像对的"
 *   （D252 同族：读数器在跑，读的不是那个量）。
 * ⇒ 所以本文件把口径**写死成一个函数** {@link cumulativeTokens}。
 *   宿主自己的界面 pill 用的是同一口径（`dsh-client-ui-chat` 的
 *   `billedInputTokens(usage) + usage.outputTokens`，逐字 = 三桶输入相加再＋输出）。
 *
 * ## 🔴 为什么用 `register(def, { when })`，而不是 `restrict({deny})`
 *
 * 宿主 `dsh-tools` 契约（逐字）：`ToolRegistrationOptions.when` —— *"Decide whether the step's
 * requests may call the tool. Omission enables it. **False excludes it from both declarations
 * and dispatch**"*，且 `ToolActivationContext` 直接给出 `agent`。
 *
 * 而 `restrict` **只能 deny，不能 allow**（本仓 `TOOL_VISIBILITY_DENY_ONLY`）⇒ 只能"平时藏起来"，
 * 做不到"达阈值再放出来"。
 *
 * 🔴 **我上一版判「动态注册做不到」是错的，成因值得记**：我只读了自己写的那一层
 * （`seams/tool-visibility.ts`），就据此对**整条注册通路**下结论 ——
 * **「我扫了 X」≠「X 之外没有 Y」**（D259 第三次同族）。答案在 `register()` 的**第二个参数**里，
 * 一个我没想到去查的位置。
 *
 * ⚠️ **档位兼容（如实登记，不粉饰）**：`register(def, options?)` 的第二个参数**只在宿主
 * `0.2.2-rc.1` 起存在**（0.1.7 / 0.2.0 / 0.2.1 三档签名是 `register(definition)`）。
 * ⇒ 低档下多传的实参被 JS 静默忽略 ⇒ 那个档位上 `reconstruct` **常驻可见**（不达阈值也出现）。
 * 这**不是缺陷**，是"宿主没这个能力"的降级；{@link supportsActivation} 把档位判出来并落进诊断，
 * 让读数面能区分"没出现"与"出现了但做不到隐藏"。
 *
 * ## 🔴 与 `rebuild` 的关系：**并存，不替代**（owner Q3「并存」）
 *
 * | 动作 | 治什么 | 清空谁 | 建新会话 | 旧会话 |
 * |---|---|---|---|---|
 * | `rebuild` | **模型上下文**（surface replace ⇒ 下一轮 prompt 变小） | 当前这条，原地 | ✗ | 仍是它自己 |
 * | `reconstruct` | **日志体积本身**（旧日志封存，新日志从零开始） | 不清空任何东西 | ✓ | **归档** |
 *
 * ⇒ `rebuild` 之后同一个会话 id 的日志**继续增长**，而 `reconstruct` 是**真正换一条日志**。
 *
 * ## 为什么不照抄 `rebuild` 的「turn-stopping 里 steer 自动继续」
 *
 * `rebuild` 的自动继续是 `deliver(..., 'wake-now')` = `agent.steer`，让**同一条**会话在清空后
 * 立刻接上。`reconstruct` 的语义**相反**：旧会话要退役，绝不能再让它继续跑
 * （否则「旧会话还在跑、新会话已经在继续」＝双跑，提案 §6.1 记的就是这个风险）。
 * ⇒ 本文件在 turn-stopping 里**只对新 agent 投递（followup）**，对旧 agent 一个字节都不投。
 *
 * @see AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/proposals/2026-11-06T0050-a3f1-reconstruct-tool-proposal.md
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { basename, dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { hostService } from '../host/access.js'
import { agentCwdFor, cccRootForCwd } from '../kernel/ccc-roots.js'
import { makeInjection, toMessage } from '../kernel/injection.js'
import { isoLocal } from '../kernel/time.js'
import { compareSemver } from '../host/contract.js'
import { readDshVersion } from '../surface/status.js'
import { DEFAULT_FAKE_INITIAL_MESSAGES } from '../seams/bootstrap.js'
import { createAndBindTarget } from '../wake/scheduler.js'
import { namingTitleFor, parseTrajectoryCode } from './core.js'
import { buildRebuildAnchor, resolveSessionMdPath } from './rebuild.js'

/**
 * 触发阈值：**10 亿**累计 token（owner 2026-11-06 裁「我这有好几个十亿的」＋ 截图 1372M）。
 *
 * 🔴 **不要"顺手"改成 100 万**：本轨实测一条长期维护会话累计已到 **1391 M**，
 *   同机另一条（`platform-9063`）是 **322 M** ⇒ 100 万对它们都是**恒真**；
 *   阈值一旦恒真，"达阈值才出现"这个机制等于不存在 —— 而它**看起来完全正常**（最坏的形态）。
 */
export const RECONSTRUCT_TOKEN_THRESHOLD = 1_000_000_000

/** `tokenUsage` 投影的四桶（字段名与日志里的 `usage` **不同**，见文件头注） */
export interface TokenTotals {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * 读一条会话的 `tokenUsage` 四桶。
 *
 * ⚠️ **必须显式给 keys**（`snapshot(session, ['tokenUsage'])`）：`tokenUsage` 的 `wire`
 *   **没有** `summary: false`（而 `contextPressure` 有）⇒ 走"摘要集"读法拿不到它。
 *   这里直接点名要它，与 `keeper.ts` 的 `readContextPressure`（不传 keys）**走法不同**，不是笔误。
 *
 * @returns 读不到（投影未装配 / 会话无该格）⇒ `null`，**不回报 0**
 */
export function readTokenTotals(ctx: unknown, session: unknown): TokenTotals | null {
  try {
    const projections = hostService<{
      snapshot?: (s: unknown, keys?: readonly string[]) => { values?: Record<string, unknown> }
    }>(ctx, 'sessionProjections')
    if (!projections || typeof projections.snapshot !== 'function') return null
    const snap = projections.snapshot(session, ['tokenUsage'])
    const totals = snap?.values?.tokenUsage as Partial<TokenTotals> | undefined
    if (!totals || typeof totals !== 'object') return null
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      uncachedInputTokens: n(totals.uncachedInputTokens),
      outputTokens: n(totals.outputTokens),
      cacheReadTokens: n(totals.cacheReadTokens),
      cacheWriteTokens: n(totals.cacheWriteTokens),
    }
  } catch {
    return null
  }
}

/**
 * **累计口径的唯一真相源**：四桶全加。
 *
 * = 宿主界面 pill 的口径（`billedInputTokens = uncachedInput + cacheRead + cacheWrite`，再加 `output`）。
 * ⛔ 不要在这里"优化"成只加输入侧、更不要只加 `uncachedInputTokens` —— 见文件头注那张对照表。
 */
export function cumulativeTokens(totals: TokenTotals): number {
  return totals.uncachedInputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/**
 * 当前宿主是否支持 `register()` 的第二参数（工具准入条件）。
 *
 * 判据 = 宿主版本 ≥ `0.2.2-rc.1`（`ToolRegistrationOptions` 首次出现的档）。
 * 读不到版本 ⇒ `false`（保守：不传第二参数 ⇒ 退化成"常驻可见"，而不是赌它支持）。
 */
export function supportsActivation(): boolean {
  const v = readDshVersion()
  if (v === null) return false
  const cmp = compareSemver(v, '0.2.2-rc.1')
  return cmp !== null && cmp >= 0
}

/** 该会话此刻是否已达阈值（`when` 与 keeper 提醒**共用**这一条判据） */
export function shouldOfferReconstruct(ctx: unknown, session: unknown): boolean {
  const totals = readTokenTotals(ctx, session)
  if (totals === null) return false
  return cumulativeTokens(totals) >= RECONSTRUCT_TOKEN_THRESHOLD
}

/**
 * 达到阈值时注入的那句话（owner 给的语义，逐要素保留：**会话 id ＋ "过于庞大" ＋ 动作名**）。
 *
 * 🔴 与 `rebuildReminderText` 同一门禁口径（D64）：**不给 token 数值**——
 *   "当前有多大"是模型无法据以行动的信息，"该调用 reconstruct"才是。
 *   ⚠️ 会话 id **必须给**：owner 原话里就有它，且它是唯一能让模型分辨"说的是哪条"的锚。
 */
export function reconstructReminderText(dshSessionId: string): string {
  return [
    `[RECONSTRUCT] The carrier session of this cognitive trajectory — ${dshSessionId} — has grown too large: `
    + `its cumulative token usage passed the configured ceiling, so keeping it as the carrier costs every future turn.`,
    `Call the reconstruct tool. It behaves exactly like rebuild with one difference: it creates a NEW conversation, `
    + `binds this cognitive trajectory to it, injects the continue anchor there, and then archives the current session. `
    + `Nothing is lost — SESSION.md stays where it is and the new carrier resumes from it.`,
    `Call it with --summary "<content summary ≤20 chars>" naming the next phase (same parameter as rebuild), `
    + `optionally with --note "<task focus ≤200 chars>". It queues and runs when this turn ends, so finish the step you are in first.`,
  ].join(' ')
}

// ── 诊断（复用 `.rebuild-diag.json` 先例：单文件覆盖 ＋ 进程内累计；判据同族，别各造一套）──

interface ReconstructDiagState {
  lastTs: string
  lastSessionId: string
  lastEvent: string
  detail?: string
  observeCount: number
  queuedCount: number
  rebuiltCount: number
  archivedCount: number
  failedCount: number
}

let diagState: ReconstructDiagState = {
  lastTs: '', lastSessionId: '', lastEvent: '', observeCount: 0,
  queuedCount: 0, rebuiltCount: 0, archivedCount: 0, failedCount: 0,
}

/**
 * 落一份诊断快照。
 *
 * 🔴 **本函数在 `when` 回调里也会被调到** ⇒ 必须**永不抛**（宿主契约逐字：
 *   *"rejection fails step preparation"* ⇒ `when` 里任何一个异常都会让**这一步的准备失败**）。
 *   故整段 try/catch 兜底、失败静默。
 */
function writeReconstructDiag(root: string, entry: {
  sessionId: string
  event: string
  detail?: string
  /** 观测类事件单列计数（它们是节流后的心跳，不是动作 —— 混进动作计数会让读数说谎） */
  observe?: boolean
}): void {
  try {
    const s = diagState
    if (entry.observe === true) s.observeCount += 1
    if (entry.event === 'queued') s.queuedCount += 1
    if (entry.event === 'rebuilt') s.rebuiltCount += 1
    if (entry.event === 'archived') s.archivedCount += 1
    if (entry.event === 'failed' || entry.event === 'archive-failed') s.failedCount += 1
    s.lastTs = isoLocal()
    s.lastSessionId = entry.sessionId
    s.lastEvent = entry.event
    s.detail = entry.detail
    const file = join(root, 'AGENT_SESSIONS', '.reconstruct-diag.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(s, null, 2) + '\n', 'utf-8')
  } catch {
    /* 诊断写盘失败忽略（绝不影响主流程，更绝不能让 `when` 抛） */
  }
}

/** 测试/调试：读诊断状态 */
export function reconstructDiagSnapshot(): ReconstructDiagState {
  return { ...diagState }
}

/** 测试/调试：清空诊断状态（跨用例隔离） */
export function __resetReconstructDiagForTest(): void {
  diagState = {
    lastTs: '', lastSessionId: '', lastEvent: '', observeCount: 0,
    queuedCount: 0, rebuiltCount: 0, archivedCount: 0, failedCount: 0,
  }
}

/** 观测落盘的节流窗（`when` 每步都跑 ⇒ 写盘必须有界） */
const OBSERVE_THROTTLE_MS = 60_000

/**
 * 造 `when` 回调：**答"这一步要不要把这个工具放出来"**，并顺带落一次节流的观测。
 *
 * 为什么观测不能省：owner 要的第一件事是"达阈值才出现"，而**"它到底读到了多少"只有真机答得上**
 * （宿主的投影在本会话能否读出 1391 M 级 —— 这是方案阶段明确未验的那一格）。
 * 观测落盘让**第一次真机运行**同时完成"验投影"与"验功能"，不必再另写一次性探针
 * （探针验的是"我这样调能读懂"，诊断文件验的是**真实现每步真的算出什么** —— 后者才是上生产的那个数）。
 *
 * 🔴 三条硬约束（都来自宿主契约，逐字）：
 *   ① **绝不抛**（rejection fails step preparation）；
 *   ② **不改变任何注册、不启动任何工具工作**（契约：*"Conditions must not mutate registrations
 *      or start tool work"*）；
 *   ③ **便宜** —— 每步都会跑 ⇒ 落盘按会话**节流 60s**。
 */
export function makeReconstructWhen(ctx: unknown): (context: { agent?: Agent }) => boolean {
  const lastObserve = new Map<string, number>()
  return (context) => {
    try {
      const session = (context?.agent as { session?: unknown } | undefined)?.session
      if (!session) return false
      const totals = readTokenTotals(ctx, session)
      if (totals === null) return false
      const total = cumulativeTokens(totals)
      const id = String((session as { id?: string }).id ?? '')
      const root = cccRootForCwd(agentCwdFor({ session } as { session?: { header?: { cwd?: string } } }))
      if (root !== null) {
        const now = Date.now()
        if (now - (lastObserve.get(id) ?? 0) >= OBSERVE_THROTTLE_MS) {
          lastObserve.set(id, now)
          writeReconstructDiag(root, {
            sessionId: id,
            event: 'observe',
            observe: true,
            detail:
              `cumulative=${total} threshold=${RECONSTRUCT_TOKEN_THRESHOLD} visible=${total >= RECONSTRUCT_TOKEN_THRESHOLD} `
              + `buckets=${JSON.stringify(totals)} activation=${supportsActivation()}`,
          })
        }
      }
      return total >= RECONSTRUCT_TOKEN_THRESHOLD
    } catch {
      // 契约要求不抛：判不出来就当"不放出"（fail-closed，与其余可见性判据同向）
      return false
    }
  }
}

// ── 排队（与 rebuild 同一套 turn-stopping 语义）──────────────────────────────

interface PendingReconstruct {
  /** 继续锚点（与 rebuild 同源构造，末尾多一行交代上一代） */
  anchor: string
  /** 新载体标题用的内容概括 */
  summary: string
  /** 持久轨迹 SESSION.md */
  mdPath: string
  queuedAt: number
}

const pendingReconstructs = new Map<string, PendingReconstruct>()

/** 陈旧队列存活时长：超过则丢弃（turn 异常结束 / agent 崩溃时防残留误换代 —— 同 rebuild） */
const PENDING_TTL_MS = 10 * 60 * 1000

/** 测试/调试：查看待换代的队列 */
export function pendingReconstructSnapshot(): ReadonlyMap<string, PendingReconstruct> {
  return new Map(pendingReconstructs)
}

/** 测试/调试：清空待换代队列 */
export function __resetPendingReconstructForTest(): void {
  pendingReconstructs.clear()
}

/**
 * 排队一次换代（**不立即建新会话**）。
 *
 * 🔴 为什么必须排队、不能像 `send-now` 那样当场建：`send-now` 的目标是**别人**，
 *   而 `reconstruct` 的目标是**自己** —— 当场建并投递 ⇒ 新会话立刻开跑，而**本轮还没结束** ⇒
 *   两条会话同时工作在同一个 SESSION.md 上（提案 §6.1 的双跑风险）。
 *   ⇒ 与 `rebuild` 同款：**turn-stopping（本轮结束前）才真正执行**。
 *
 * @returns 排队结果；定位不到活跃轨迹 / 会话不存在 ⇒ **抛错**（响亮，与 rebuild 一致）
 */
export function queueReconstruct(
  ctx: unknown,
  opts: { root: string; note?: string; summary: string; dshSessionId: string },
): { queued: true; anchor: string; sessionMdPath: string; cumulative: number } {
  const { root, note, summary, dshSessionId } = opts
  const session = (ctx as { sessions?: { get?: (id: SessionId) => Session | undefined } } | undefined)
    ?.sessions?.get?.(dshSessionId as SessionId)
  if (!session) {
    throw new Error(`Unable to locate dsh session ${dshSessionId} (session may be closed)`)
  }
  const mdPath = resolveSessionMdPath(root, dshSessionId, session)
  if (!mdPath) {
    throw new Error(
      'Unable to determine the active SESSION.md for this session — checked (in order): '
      + 'in-memory activation (cognitive_trajectory use in this process), [SESSION CONTEXT] events in this conversation, '
      + 'the trajectory\'s binding declaration (current.dsh_session_bind), rebuild anchor in the surface. '
      + 'None matched an existing SESSION.md. Run "cognitive_trajectory use <S###> --summary <content summary ≤20 chars>" '
      + 'first, then retry reconstruct. (No global fallback is applied on purpose — guessing could resume a different '
      + 'cognitive trajectory.)',
    )
  }
  const dirName = basename(dirname(mdPath))
  const sessionName = parseTrajectoryCode(dirName) ?? dirName
  const base = buildRebuildAnchor(root, sessionName, mdPath, DEFAULT_FAKE_INITIAL_MESSAGES, note)
  // 末尾一行交代上一代：新我读到它就知道"那条会话已经封存，不要回头找它"。
  // ⚠️ 刻意写在**锚点正文里**而不是别处 —— 这是新会话唯一必然被读到的位置。
  const anchor = [
    base,
    `- The previous carrier (dsh session ${dshSessionId}) is being archived: this conversation is its successor. `
    + 'Ignore any instruction that points back at it — its log is sealed, the trajectory continues here.',
  ].join('\n')
  const totals = readTokenTotals(ctx, session)
  pendingReconstructs.set(dshSessionId, { anchor, summary, mdPath, queuedAt: Date.now() })
  writeReconstructDiag(root, {
    sessionId: dshSessionId,
    event: 'queued',
    detail: `cumulative=${totals ? cumulativeTokens(totals) : 'unknown'} summary=${summary}`,
  })
  return { queued: true, anchor, sessionMdPath: mdPath, cumulative: totals ? cumulativeTokens(totals) : 0 }
}

/**
 * 在 turn-stopping 里**真正执行**换代。
 *
 * 四步（顺序不可换；任一步失败即抛，不半途而废）：
 *   ① **建新会话并绑定**这条轨迹 —— 复用 `send-now` 已验证的通路
 *      （`createAndBindTarget`：`create({workspaceId})` → `resolveAgent` → `appendBound` ＋ 开场白 ＋ 钉标题）。
 *      🔴 **不另写一份**：那条通路每一步都是真机换来的判据（见 `wake/scheduler.ts` 的函数头）。
 *      🔴 **必须带 `takeover`**：此刻旧载体**还活着**，`claimBinding` 的
 *      「轨迹唯一」判据会把无 takeover 的写法判成 `TRAJECTORY_OCCUPIED` —— 而那个失败
 *      只会表现为回执里一句 `⚠️ 绑定写入失败`，**把换代悄悄降级成"多了一条没绑定的会话"**。
 *   ② 给新会话**钉上带 summary 的标题**（与 `use` / rebuild 同一条派生路径 `namingTitleFor`）。
 *   ③ 对**新** agent 投继续锚点（`followup`，**绝不用 steer** —— 见文件头）。
 *   ④ 归档旧会话（**延后 ＋ 有界重试**，见 {@link scheduleArchiveOldSession}）。
 *
 * @returns 新载体会话 id；任一步失败抛错（由调用方落诊断，不静默）
 */
export async function performReconstruct(
  ctx: unknown,
  root: string,
  oldSessionId: string,
  pending: PendingReconstruct,
): Promise<string> {
  const dirName = basename(dirname(pending.mdPath))
  /**
   * 🔴 **2026-11-10（owner 报障「这个东西不应当排队，应当直接进」）：锚点必须在开场白之前入队。**
   *
   * 真机缺陷（platform-9047 换代日志，逐字）：`seq 12` 是**开场白**落在 `next-turn`，
   * `seq 76` 才是**继续锚点**（也是 `next-turn`）⇒ 宿主 `inbox.claim('next-turn', …)`
   * **每轮只认领 1 条** ⇒ 第 1 轮只拿到开场白，而开场白正文写的就是"接着它 SESSION.md 里的
   * 工作往下做" ⇒ **模型在读到锚点之前就开始干活**，锚点在排队区等到第 2 轮。
   *
   * ⇒ 修法：锚点走 `agent.inject()`（`next-step`，**不唤醒**），开场白仍走 `followup`。
   * `claim()` **先整批取 `next-step` 再取 1 条 `next-turn`** ⇒ 第 1 轮第 1 步拿到
   * `[锚点, 开场白]`，锚点在前 —— 这才叫"直接进"。
   *
   * ⚠️ **`inject` 不是 `steer`**：`inject` = `send(msg,'next-step',false)`（不唤醒），
   * 正是我们要的（唤醒由开场白那条 `followup` 负责，一条消息只唤醒一次）。
   * 用 `steer` 会多唤一次，且语义上"插进正在跑的轮"在这里不成立（新 agent 没有在跑的轮）。
   */
  const created = await createAndBindTarget(ctx, root, dirName, {
    takeover: true,
    beforeOpening: (a) => {
      /**
       * ⚠️ **必须用 `toMessage` ＋ `agent.inject`，⛔ 不能用 `deliver(…, 'this-step')`** ——
       * `deliver()` 对 `this-step` 是**显式抛错**的（那一档走 `additionalContexts` 返回，
       * 不是调 agent 方法；见 `kernel/injection.ts` 的 `deliver` 头注）。这里要的正是
       * 调 agent 方法，故走 `toMessage` 那一半（它同样过 `assertInjection` ＋ `sourceOf`）。
       */
      (a as unknown as { inject?: (msg: unknown) => void }).inject?.(
        toMessage(
          makeInjection({
            origin: 'acc',
            form: 'instructions',
            summary: 'reconstruct 后继续',
            text: pending.anchor,
            delivery: 'this-step',
          }),
        ),
      )
    },
  })
  if ('error' in created) {
    throw new Error(`创建新载体失败：${created.error}`)
  }
  const agent = created.agent
  const newSessionId = String((agent as { id?: string }).id ?? '')
  // ② 标题：与 `use` / rebuild 同一个纯函数，只是带上 summary（⛔ 不另造命名规则）
  try {
    const titles = hostService<{ rename?: (session: unknown, title: string) => unknown }>(ctx, 'sessionTitle')
    const session = (agent as { session?: unknown }).session
    if (titles && typeof titles.rename === 'function' && session) {
      titles.rename(session, namingTitleFor({
        sessionId: parseTrajectoryCode(dirName) ?? dirName,
        dirName,
        mdPath: pending.mdPath,
      }, pending.summary))
    }
  } catch {
    /* 标题是观感，失败不阻断换代（与 rebuild 同口径） */
  }
  // ③ 继续锚点**已经在 ③b′ 投过了**（`beforeOpening` 回调里，走 `next-step`）。
  //    ⛔ **不要在这里再投一次** —— 那会让同一个锚点在 `next-step` 与 `next-turn` 各有一份，
  //    模型连续两轮收到同一份"继续"指令（实测代价见 `beforeOpening` 的注释）。
  writeReconstructDiag(root, {
    sessionId: newSessionId,
    event: 'rebuilt',
    detail: `old=${oldSessionId} dir=${dirName} how=${created.how}`,
  })
  console.log(`[serenity-hooks] reconstruct: 新载体 ${newSessionId} 已接管「${dirName}」（旧 ${oldSessionId}）`)
  scheduleArchiveOldSession(ctx, root, oldSessionId)
  return newSessionId
}

/** 归档重试的间隔与次数（**有界**，不是轮询：成功即停，最多 3 次共约 6s） */
const ARCHIVE_DELAY_MS = 2_000
const ARCHIVE_ATTEMPTS = 3

/**
 * 归档旧会话（**延后 ＋ 有界重试**）。
 *
 * ## 为什么延后
 * 本函数在 `agent/turn-stopping` 回调里被调，而那一刻**旧会话这一轮还没走完**。
 * 宿主 `archiveSession(id, { stopActivity: true })` 会**取消该会话仍在跑的工作**
 * ⇒ 当场归档等于在轮末去掐这一轮自己。延后一拍让 turn 先自然收尾。
 *
 * ## 为什么带重试
 * 宿主 provider 的"还有活动"判据（`workspace/session-activity` 瀑布）在轮末有很短的窗口。
 * 一次失败就放弃 ⇒ owner 要的"归档当前会话"会**静默不发生**。⇒ 有界重试；
 * 三次都失败就**如实落诊断并停止**（⛔ 不无限重试 —— 那是轮询）。
 *
 * ## 真机判据
 * `workspaceRegistry.archivedSessionIds` 里出现旧会话 id ⇒ 归档成立。
 * ⚠️ 归档**不动日志一个字节**（宿主逐字：*"Archiving never touches workspace accounting"*）
 * ⇒ **"日志还在"不能读成"没归档"**。
 */
export function scheduleArchiveOldSession(ctx: unknown, root: string, oldSessionId: string): void {
  const tryOnce = async (attempt: number): Promise<void> => {
    const reg = hostService<{
      archiveSession?: (id: string, opts?: { stopActivity?: boolean }) => Promise<void>
      archivedSessionIds?: readonly string[]
    }>(ctx, 'workspaceRegistry')
    if (!reg || typeof reg.archiveSession !== 'function') {
      writeReconstructDiag(root, {
        sessionId: oldSessionId,
        event: 'archive-failed',
        detail: 'workspaceRegistry.archiveSession 不可用 ⇒ 旧会话留在活跃清单里'
          + '（绑定已指向新载体，不影响工作；要清掉请用界面归档）',
      })
      return
    }
    try {
      await reg.archiveSession(oldSessionId, { stopActivity: true })
      // 回读归档集：它才是"归档成立"的判据（调用没报错 ≠ 归档了）
      const listed = Array.isArray(reg.archivedSessionIds)
        ? reg.archivedSessionIds.includes(oldSessionId)
        : null
      writeReconstructDiag(root, {
        sessionId: oldSessionId,
        event: 'archived',
        detail: `attempt=${attempt} archivedSessionIds含它=${listed === null ? '不可读' : String(listed)}`,
      })
      console.log(`[serenity-hooks] reconstruct: 旧会话 ${oldSessionId} 已归档（attempt ${attempt}）`)
    } catch (error) {
      const msg = String((error as Error)?.message ?? error)
      if (attempt < ARCHIVE_ATTEMPTS) {
        setTimeout(() => { void tryOnce(attempt + 1) }, ARCHIVE_DELAY_MS)
        return
      }
      writeReconstructDiag(root, {
        sessionId: oldSessionId,
        event: 'archive-failed',
        detail: `attempt=${attempt} ${msg} ⇒ 停止重试；旧会话仍在活跃清单里（绑定已指向新载体）`,
      })
    }
  }
  setTimeout(() => { void tryOnce(1) }, ARCHIVE_DELAY_MS)
}

/**
 * 注册 turn-stopping 钩子（`index.ts` 的 apply 调用）。
 *
 * 与 `registerRebuildTurnHook` 同形：**无 pending 零开销**；陈旧队列丢弃。
 * 🔴 回调**不返回 promise**（`agent/turn-stopping` 是同步派发点），异步主体自己 catch。
 */
export function registerReconstructTurnHook(ctx: unknown): void {
  const on = (ctx as {
    on?: (name: string, fn: (payload: { agent?: Agent; turn?: number }) => void) => void
  }).on
  if (typeof on !== 'function') return
  on.call(ctx, 'agent/turn-stopping', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    const id = agent.id
    const pending = pendingReconstructs.get(id)
    if (pending === undefined) return
    const root = cccRootForCwd(agentCwdFor(agent as { session?: { header?: { cwd?: string } } }))
    if (Date.now() - pending.queuedAt > PENDING_TTL_MS) {
      pendingReconstructs.delete(id)
      if (root !== null) {
        writeReconstructDiag(root, {
          sessionId: id,
          event: 'failed',
          detail: `ttl-dropped：queuedAt 早于 ${PENDING_TTL_MS / 60000} 分钟 ⇒ 本轮没有在时限内结束`,
        })
      }
      return
    }
    pendingReconstructs.delete(id)
    if (root === null) return
    void performReconstruct(ctx, root, id, pending).catch((error: unknown) => {
      const msg = String((error as Error)?.message ?? error)
      writeReconstructDiag(root, { sessionId: id, event: 'failed', detail: msg })
      console.warn(`[serenity-hooks] reconstruct failed: ${msg}`)
    })
  })
}
