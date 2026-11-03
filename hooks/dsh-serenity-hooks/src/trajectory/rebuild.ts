/**
 * trajectory/rebuild.ts — 轨迹跟踪器（Cognitive Trajectory Tracker）超限重建：cognitive_trajectory rebuild
 * （v1.30 起并入 logbook 的 rebuild action，v1.33 随 logbook 并入 trajectory，v1.34 工具名硬切
 *   为 container_trajectory；原独立 session_rebuild 工具）
 *
 * 概念（S142 用户拍板命名，v1.22.1 语义修正；v1.22.4 定稿语义）：
 *   **SESSION.md = 持久 agent（轨迹）**——身份/决策/进度/未解决问题的本体，
 *   永远留在 AGENT_SESSIONS/ 原位，**不归档、不移动**。
 *   **自身 dsh 会话 = 临时可重建（工作副本）**——上下文超阈值时**完全清空重来**，
 *   身份从 SESSION.md 自动延续。
 *
 * v1.22.4 定稿语义（用户明确：**复用旧会话 + 完全清空重来**，不要新建会话）：
 *   ① rebuild 工具执行时**只排队**（pending map：sessionId → 锚点文本），不立即改 surface
 *   ② `agent/turn-stopping`（turn 结束前 serial 触发）时真正执行：
 *      surface replace 全部节点 → 锚点 user/message（「继续 {SESSION 名} 的工作」）
 *   ③ 同一会话 id 不变 → 同工作区天然满足、无新/旧会话之分、无需销毁/切换/归档
 *
 * 为何不在工具执行时立即 replace（v1.22.2 方案废弃）：
 *   S141 实测崩溃——rebuild 工具在 turn 中途执行 surface replace，把**当前 turn
 *   的 assistant tool-call 节点**也 shadow 掉；工具返回后 agent-loop append
 *   tool/result（sourceEventSeqs 引用被 shadow 的 callSeq），deriveMessages 折叠出
 *   孤儿 tool 消息 → LLM API 报 "Messages with role 'tool' must be a response to
 *   a preceding message with 'tool_calls'"（INVALID_REQUEST）。
 *   **延迟到 turn 结束清空**：届时当前 turn 所有 tool/result 已完整 append，replace
 *   一并 shadow，无孤儿。
 *
 * v1.22.5 增强（S142 用户需求）：
 *   ① **自动继续**：turn-stopping 执行 replace 后 `agent.steer()` 注入自动继续指令
 *      （DSH 官方先例：hooks-claude-code Stop hook 在 turn-stopping 里 steer 强制
 *      再执行一步）——next-step 队列非空 → turn 循环不 break → 模型自动读取
 *      SESSION.md 继续工作，无需用户手工输入。
 *   ② **保留协议正文**：并入 DEFAULT_FAKE_INITIAL_MESSAGES 正文（ACC 身份/
 *      EAP/协作协议），去掉 acknowledge 尾句（重建后直接干活，不重走确认轮）——
 *      系统提示词层身份未丢（每轮注入），bootstrap 晋升状态不受影响（surface
 *      replace 不改 events，promoted 保持完整工具目录）。
 *
 * 触发：LLM 主动调用（keeper 超阈值后提示 [TRAJECTORY]，不自动执行——防误清空）。
 * 门控：仅 CCC 内 + 简单配置 rebuild.enabled。
 */

import type { Context } from 'cordis'
import type { SessionId, Session } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { hostService } from '../host/access.js'
import { deliver, makeInjection } from '../kernel/injection.js'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { agentCwdFor, cccRootForCwd } from '../kernel/ccc-roots.js'
import {
  getActiveSessionInfo,
  parseSessionContextFromEvents,
  extractSessionMdPathFromText,
  namingTitleFor,
  parseTrajectoryCode,
  sessionEvents,
} from './core.js'
import { DEFAULT_FAKE_INITIAL_MESSAGES } from '../seams/bootstrap.js'
import { eventToken, REBUILD_TODO_FILENAME } from './assistant.js'
import { appendBound, readLastBound } from './bound.js'
import { isoLocal } from '../kernel/time.js'

/** acknowledge 尾句（fake-initial-turns 的确认要求——rebuild 重建后不重走确认轮，直接继续） */
const ACK_SUFFIX_RE = /Please simply reply "acknowledge" — no action needed\.\s*$/

/**
 * 剥离假首轮消息的 acknowledge 尾句（rebuild 锚点保留协议正文但不要求确认回复）。
 */
export function stripAckSuffix(text: string): string {
  return text.replace(ACK_SUFFIX_RE, '').trimEnd()
}

/**
 * 构建重建锚点消息（v1.22.4 定稿语义 + v1.22.5 保留协议正文）：
 * 「[TRAJECTORY-REBUILD] + fake-initial-turns 协议正文（去 acknowledge 尾句）+ 继续 {SESSION 名} 的工作」。
 * v1.29.2（R1）：可选 task focus 段——简短任务焦点文字传入重建后会话（不含历史，
 * 历史完整在 SESSION.md；让重建后的自己第一时间理解本轮焦点，降低冷启动认知成本）。
 * @param root - CCC 根
 * @param sessionName - 当前 use 的宁静号 SESSION 名（如 S142）；无激活则通用指令
 * @param activeMdPath - 持久轨迹 SESSION.md 绝对路径（保持原位）
 * @param protocolMessages - 协议正文消息序列（缺省 DEFAULT_FAKE_INITIAL_MESSAGES；可注入测试）
 * @param focus - 可选任务焦点（单行化 + ≤200 字消毒；无则不输出 focus 段——向后兼容）
 */
export function buildRebuildAnchor(
  root: string,
  sessionName: string,
  activeMdPath: string,
  protocolMessages: string[] = DEFAULT_FAKE_INITIAL_MESSAGES,
  focus?: string | null,
): string {
  const rel = activeMdPath.startsWith(root) ? activeMdPath.slice(root.length + 1) : activeMdPath
  // 交界便签（v1.49.0）：与 SESSION.md **同目录**的兄弟文件；路径同样独立成行（便于新我直接 read）
  const todoAbs = join(dirname(activeMdPath), REBUILD_TODO_FILENAME)
  const todoRel = todoAbs.startsWith(root) ? todoAbs.slice(root.length + 1) : todoAbs
  // 会话目录名 = SESSION.md 的父目录 basename（可含空格，如 "…--S142--dsh-serenity-plugin 长期维护"）
  const sessionDir = basename(dirname(activeMdPath))
  const sessionLine =
    sessionDir !== 'AGENT_SESSIONS'
      ? `- Serenity session: ${sessionName !== '' ? `${sessionName} (${sessionDir})` : sessionDir}`
      : null
  const focusLine = sanitizeFocusLine(focus)
  const lines = [
    `${eventToken('rebuild')} The conversation has been cleared and rebuilt (Ship of Theseus: the carrier is replaced, the cognitive trajectory continues).`,
    '',
    ...protocolMessages.flatMap((text) => [stripAckSuffix(text), '']),
    sessionName !== '' ? `Continue the work of ${sessionName}.` : 'Continue the current work.',
    ...(sessionLine ? [sessionLine] : []),
    // v1.24.11 规范行：与 `session use` 上下文同格式（SESSION.md path:）——路径独立成行，
    // 恢复机制（parseSessionContextFromEvents）从 events 解析路径即可恢复，无需 [SESSION CONTEXT] 标记
    `- Persistent cognitive trajectory — SESSION.md path: ${rel}`,
    `  (the cognitive trajectory's persistent body — stays in place through rebuilds)`,
    `- Read that SESSION.md first (goal/decisions/progress/unresolved), then continue from the last checkpoint.`,
    // v1.49.0 交接协议（owner 2026-09-26 裁决"**砍掉 in-flight**，这正是目的"）：读侧改指**独立便签文件**。
    // 🔴 便签**不是权威**（可被随时丢弃）——权威仍是 SESSION.md；此处刻意点明，防新我拿便签当状态真相源。
    `- Then read the handover scratch note: ${todoRel} (path: ${todoAbs}) — the previous self paused mid-task and left its in-flight items there. That file carries no format obligation and may be discarded at any time; it is NOT the authoritative state. If it is missing, infer the in-flight items from SESSION.md's latest progress entries.`,
    // v1.29.2（R1）：任务焦点——重建后会话理解当前任务（无历史；SESSION.md 含完整历史）
    ...(focusLine ? [`- Task focus: ${focusLine}`] : []),
  ]
  return lines.join('\n')
}

/**
 * 任务焦点行消毒（纯函数可单测）：单行化（换行/回车 → 空格）+ 控制字符清除 +
 * ≤200 字截断。空/纯空白 → null（不输出 focus 段）。防 LLM 传多行注入伪造锚点结构。
 */
export function sanitizeFocusLine(focus: string | null | undefined): string | null {
  if (!focus) return null
  const single = focus
    // 换行/回车/制表 → 空格（防注入额外锚点行）
    .replace(/[\r\n\t]+/g, ' ')
    // 其余控制字符清除（保留可见文本）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
  if (single === '') return null
  return single.length <= FOCUS_MAX_CHARS ? single : single.slice(0, FOCUS_MAX_CHARS)
}

/** 任务焦点最大长度（字/码点；200 足够一句话任务焦点——非历史） */
const FOCUS_MAX_CHARS = 200

interface RebuildResult {
  /** 是否成功排队（turn 结束时执行清空重建） */
  queued: boolean
  /** 锚点消息文本（将在 turn 结束时注入） */
  anchor: string
  /** 宁静号 SESSION.md（持久轨迹，保持原位） */
  sessionMdPath: string | null
}

// ── v1.24.11 稳固化：SESSION.md 多层定位（S142 用户需求：重建后新会话必须准确知道从哪个 SESSION 恢复）──

/** 从会话 surface 首条 user 消息（重建锚点）解析 SESSION.md 路径（events 异常/缺失时的兜底） */
function parseAnchorMdPath(session: Session): string | null {
  try {
    const nodes = [...session.surface.nodes]
    if (nodes.length === 0) return null
    const events = sessionEvents<SessionEvent>(session)
    if (events.length === 0) return null
    const event = events[nodes[0]!]
    if (!event) return null
    const message = deriveEventMessage(event)
    if (!message) return null
    const text =
      message.content
        ?.map((c) => ((c as { type?: string; text?: string }).type === 'text' ? (c as { text?: string }).text ?? '' : ''))
        .join('') ?? ''
    return extractSessionMdPathFromText(text)
  } catch {
    return null
  }
}

/** 从 SESSION.md 绝对路径派生会话名（编码；issue 目录回退完整目录名） */
function sessionNameFromMdPath(mdPath: string): string {
  const dirName = basename(dirname(mdPath))
  return parseTrajectoryCode(dirName) ?? dirName
}

/**
 * 稳固的 SESSION.md 定位（多层候选 + 存在性校验，**绝不输出虚假路径**）：
 * ① 内存活跃会话（本会话显式 use 过）→ ② events 恢复（use 标记 + 重建锚点规范行，进程重启后）
 * → ②b **权威绑定**（`AGENT_SESSIONS/.bindings.json`，本会话持久绑定）→ ③ surface 首条锚点
 * （events 异常时兜底）。
 *
 * v1.30.13（S142 用户"微信桥 + 轨迹约束会话锚定要准确"，诊断 D4）：**移除**原 ④「全局最新未完成
 * 会话」（`findLatestActiveSessionMd`）。理由（R↓）：④ 是**跨轨迹**猜测——候选①②③全空时，
 * 它会把 rebuild 静默接到 AGENT_SESSIONS 里最新的另一个会话（临时 轨迹约束会话 persistent=false、
 * 重启后首条消息前、新会话首条消息都命中该形态），而"接错轨迹"比重建失败危险得多
 * （错误轨迹被继续写入 + 正确轨迹静默丢失）。现在全部候选失败 → 返回 null → 调用方
 * 报错引导用户显式 `cognitive_trajectory use`（响亮失败优于静默接错）。
 * 备选：④ 仅在"同 scope 确无绑定"时兜底——同样会接错轨迹，故不采纳。
 *
 * 每候选 resolve 后 existsSync 校验（相对路径按 root 解析）；全部失败返回 null → 调用方报错引导。
 */
export function resolveSessionMdPath(root: string, scope: string, session: Session): string | null {
  const candidates: Array<string | null> = []
  candidates.push(getActiveSessionInfo(scope)?.mdPath ?? null)
  const events = sessionEvents<unknown>(session)
  if (events.length > 0) candidates.push(parseSessionContextFromEvents(events)?.mdPath ?? null)
  candidates.push(readLastBound(session)?.mdPath ?? null)
  candidates.push(parseAnchorMdPath(session))
  for (const c of candidates) {
    if (!c) continue
    const abs = c.startsWith(root) ? c : resolve(root, c)
    if (existsSync(abs)) return abs
  }
  return null
}

// ── pending 队列：sessionId → 待重建锚点（turn-stopping 时消费）──

interface PendingRebuild {
  /** 锚点消息文本 */
  anchor: string
  /** 需求②：重建后重命名标题用的内容概括（≤20 字；服务端清洗/截断） */
  summary: string
  /** 持久轨迹 SESSION.md（重建后重命名标题的编号/日期来源） */
  mdPath: string
  /** v1.29.2（R1）：任务焦点（可选——重建后会话理解当前任务；不含历史） */
  focus?: string
  /** 排队时间（防陈旧队列误清空——超时丢弃） */
  queuedAt: number
}

const pendingRebuilds = new Map<string, PendingRebuild>()
/** 陈旧队列存活时长（毫秒）：超过则丢弃（turn 异常结束/agent 崩溃时防残留误清空） */
const PENDING_TTL_MS = 10 * 60 * 1000

// ── rebuild 诊断（2026-09-05 用户 bug：调用成功但会话没重建——错误被 console.warn 吞掉不可见）──
// 每次排队/消费路径都落盘 AGENT_SESSIONS/.rebuild-diag.json（CCC 内可读诊断通道，
// 复用 .restrict-diag.json 先例——单文件覆盖保留最近状态）——复现后 agent/用户直接读文件定位断点。
//
// ⚠️ 计数语义（2026-09-20 回源码答复 S151 的观察，勿再当谜）：
//  · **四个计数都是「进程内累计量」**（模块级 `diagState`，进程启动归零），**不是单次快照**；
//    文件是「累计计数 + 最近一次事件」的**覆盖写快照**（每次事件重写，`lastTs` = 最后一次事件时间）。
//  · 🔴 **`queueCount − rebuiltCount` 不是常数，且差值不代表"丢账"**。除 `ttl-dropped` / `failed`
//    之外，**还有三类会让差值 +1 的路径**：
//      P1 **`empty-surface`（有事件、不计数）**——`performRebuild` 返回 false（无节点可清；见
//         `performRebuild` 的两处 `return false`）⇒ 落 `empty-surface` 事件，而下方增量只认
//         4 类事件名 ⇒ **它既不进 rebuilt 也不进 dropped/failed**。识别法：`lastEvent === 'empty-surface'`。
//      P2 **同会话在消费前重复排队**——`queueRebuild` 用 `pendingRebuilds.set()`（语义 = 覆盖同会话旧队列）
//         ⇒ N 条 `queued` 只对应 1 条 `rebuilt` ⇒ 差值 +(N−1)。**良性**：重建仍恰好发生一次。
//      P3 **进程重启**——`pendingRebuilds` 是内存 Map：重启即丢（**不产生任何事件**）；同时
//         `diagState` 归零 ⇒ **计数不可跨重启累加比较**，且**文件在下次事件前仍留着死进程的数值**。
//  · 🔴 **读这个文件的纪律**：必须同时读 `acc-diag` 的「武装于」——若 `lastTs < 武装于`，
//    则文件是**上一个进程的残留**，其计数与当前进程无关（判据可机械执行，别凭感觉）。
interface RebuildDiagState {
  lastTs: string
  lastSessionId: string
  lastEvent: string
  detail?: string
  queueCount: number
  rebuiltCount: number
  droppedCount: number
  failedCount: number
}

let diagState: RebuildDiagState = { lastTs: '', lastSessionId: '', lastEvent: '', queueCount: 0, rebuiltCount: 0, droppedCount: 0, failedCount: 0 }

function writeRebuildDiag(root: string, entry: { sessionId: string; event: string; detail?: string }): void {
  try {
    const dir = join(root, 'AGENT_SESSIONS')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, '.rebuild-diag.json')
    const s = diagState
    if (entry.event === 'queued') s.queueCount += 1
    if (entry.event === 'rebuilt') s.rebuiltCount += 1
    if (entry.event === 'ttl-dropped') s.droppedCount += 1
    if (entry.event === 'failed') s.failedCount += 1
    s.lastTs = isoLocal()
    s.lastSessionId = entry.sessionId
    s.lastEvent = entry.event
    s.detail = entry.detail
    writeFileSync(file, JSON.stringify(s, null, 2) + '\n', 'utf-8')
  } catch {
    /* 诊断写盘失败忽略（不影响 rebuild 主流程） */
  }
}

/** 测试/调试：查看 pending 队列内容 */
export function pendingRebuildSnapshot(): ReadonlyMap<string, PendingRebuild> {
  return new Map(pendingRebuilds)
}

/**
 * 排队一次重建（v1.22.4 定稿语义第一步）：
 * ① 门控校验（rebuild.enabled + 会话定位）
 * ② 构建锚点（激活会话名 + 持久轨迹路径）
 * ③ 写入 pending 队列——**不立即改 surface**（等 turn-stopping 执行）
 * @returns 排队结果；rebuild.enabled=false 或非 CCC 抛错
 */
export async function queueRebuild(
  ctx: Context,
  opts: { root: string; note?: string; summary: string; agentCwd: string; dshSessionId: string },
): Promise<RebuildResult> {
  // 🔴 v1.49.0（owner 2026-09-26 裁决）：原「总闸」`rebuild.enabled=false` 的拒绝分支**已砍掉** ——
  // 超限重建恒开、无闸。要调敏感度改阈值（`rebuildThresholdK`），不再有"整体关掉"这个态。
  const { root, note, summary, dshSessionId } = opts

  // ① 定位 dsh 会话（turn-stopping 时按 agent 匹配；此处先验证存在）
  const session = (ctx.sessions as { get?: (id: SessionId) => Session | undefined } | undefined)
    ?.get?.(dshSessionId as SessionId)
  if (!session) {
    throw new Error(`Unable to locate dsh session ${dshSessionId} (session may be closed)`)
  }

  // ② 稳固定位当前 use 的宁静号 SESSION（持久轨迹路径；多层候选 + 存在性校验 v1.24.11）
  const mdPath = resolveSessionMdPath(root, dshSessionId, session)
  if (!mdPath) {
    // v1.30.13（D4）：候选链不再含"全局最新会话"猜测 → 失败即响亮报错并说明查过哪些面
    // （E↑：用户/agent 一眼知道该补哪一步，而不是拿到一个别的轨迹）。
    throw new Error(
      'Unable to determine the active SESSION.md for this session — checked (in order): ' +
      'in-memory activation (cognitive_trajectory use in this process), [SESSION CONTEXT] events in this conversation, ' +
      'AGENT_SESSIONS/.bindings.json (authoritative binding), rebuild anchor in the surface. ' +
      'None matched an existing SESSION.md. Run "cognitive_trajectory use <S###> --summary <内容概括 ≤20 字>" to bind this ' +
      'conversation to a cognitive trajectory, then retry cognitive_trajectory rebuild. (No global fallback is applied on purpose — ' +
      'guessing could resume a different cognitive trajectory.)',
    )
  }
  const sessionName = getActiveSessionInfo(dshSessionId)?.sessionId ?? sessionNameFromMdPath(mdPath)
  // v1.29.2（R1）：note → 任务焦点（单行化+截断在 buildRebuildAnchor/sanitizeFocusLine 内做）
  const focus = note && note.trim() !== '' ? note : undefined
  const anchor = buildRebuildAnchor(root, sessionName, mdPath, DEFAULT_FAKE_INITIAL_MESSAGES, focus)

  // U1（方案 v1.0）：rebuild 排队时持久化绑定（action: rebuild）——权威绑定随会话日志
  // 存续跨 rebuild（同一 dsh 会话 id 日志保留）；post-rebuild 恢复读 last bound 即此记录。
  const dirName = basename(dirname(mdPath))
  // 🔴 D172（2026-10-20）：**不再传 `sessionId`**。旧写法传的是"展示码（S###），非 S### 则 undefined"，
  // 那是**旧记录语义**；新形态下 `sessionId` 恒等于 dsh 会话 id（硬锚，由 `appendBound` 从
  // `session.header.id` 取，**不读这个字段**）⇒ 那行参数从来就没生效过（死参数，且会让人误以为
  // 它决定落盘内容）。展示码现在由 `readLastBound` 从目录名派生到 `sessionId2`。
  const boundRec = { dirName, mdPath, note: 'rebuild queued' }
  appendBound(session, 'rebuild', boundRec)

  // ③ 排队（覆盖同会话旧队列）——需求②：存 summary + mdPath（turn-stopping 重建后重命名标题）
  pendingRebuilds.set(dshSessionId, { anchor, summary, mdPath, focus, queuedAt: Date.now() })
  writeRebuildDiag(root, { sessionId: dshSessionId, event: 'queued' })
  return { queued: true, anchor, sessionMdPath: mdPath }
}

/**
 * 执行真正的 surface replace（v1.22.4 定稿语义第二步，turn-stopping 时调用）：
 * 当前 turn 已完整结束（所有 tool/result 已 append）→ 全部节点替换为锚点消息。
 * 同一会话 id 原地重建——同工作区天然满足，无新/旧会话之分。
 *
 * **shadow-price 协议（v1.23.5 修复，S142 用户问询）**：DSH token-meter 的
 * `foldSurfaceProjection` 对 surface `replace` 要求**紧邻其前的 metering 事件**
 * （`compaction/summary` 或 `compaction/prune`）声明被替换范围的启发式 token 价，
 * 否则 claim 缺失 → `deltaTokens=0` → `contextBreakdown.messageTokens` 永不扣减
 * → UI「对话消息」虚高累计、往复 rebuild 计量爆炸（用户截图实证：总 15% 但
 * 对话消息 ~1M）。官方先例 = `compaction-tool-result-pruner`（append
 * `compaction/prune` → 紧接 replace）。此处同款：先 append `compaction/prune`
 * （定价全部被替换节点，经 ctx.tokenMeter.estimateMessage 逐节点累加），再
 * append 锚点 replace——meter 不可用时退化（无 claim，仅计量漂移，会话功能不受影响）。
 *
 * @returns 是否执行了 replace（false = 无 pending 或 surface 空）
 */
export function performRebuild(
  session: Session,
  pending: PendingRebuild,
  meter?: { estimateMessage(message: Message): number },
): boolean {
  const nodes = [...session.surface.nodes]
  if (nodes.length === 0) return false

  /**
   * v1.31.8 二次修正（0.1.5-rc.1 实证，diag 原文）：
   * `surface replace: node 0 holds the system prompt and may be rewritten only by a
   *  system/message over exactly that node`（宿主 `dsh-session/lib/types/surface.js`
   * `assertSystemHeadRewrite`）。
   *
   * → **surface node 0 是系统提示节点且被宿主保护**；而重建的语义恰恰是"保留系统提示、
   *   只清对话历史"，故替换范围必须从 **node 1** 起。（旧实现整体替换 `nodes[0..last]`，
   *   在 0.1.5 上必被拒——这是 §14 之后的第二条 rebuild 阻断规则。）
   */
  const targets = nodes.slice(1)
  if (targets.length === 0) return false // 只剩系统提示 → 无历史可清（不 replace）

  // shadow-price 协议：replace 前 append compaction/prune，定价被替换范围
  if (meter) {
    let shadowedTokenCount = 0
    const events = sessionEvents<SessionEvent>(session)
    for (const seq of targets) {
      const event = events[seq]
      if (!event) continue
      const message = deriveEventMessage(event)
      if (message) shadowedTokenCount += meter.estimateMessage(message)
    }
    session.append('compaction/prune', {
      shadowedRange: { start: targets[0]!, end: targets[targets.length - 1]! },
      shadowedSeqs: targets,
      shadowedTokenCount,
    } as never)
  }

  session.append('user/message', {
    /**
     * v1.31.13 修复（**会话打不开的真因**，S142 §26）：
     * `user/message` 的 payload 必须是**完整 UserMessage**——宿主
     * `dsh-session/lib/types/index.js:229-259` `assertMessageEventShape` 对四种消息事件
     * （system/user/assistant/message + tool/result）强制：
     *   `data.id` 非空字符串 → 否则 `"<subject> lacks an identified message"`
     *   `data.role === 'user'` → 否则 `"<subject> message must have role \"user\""`
     * 而 `user/message` 的 message **就是 data 本身**（`type==='user/message' ? record : record.message`）。
     *
     * 旧实现只写 `{content, source}`（缺 `id` 与 `role`）→ 该事件**当场落盘成功**，
     * 但宿主在**下一次打开该会话**时整份日志校验失败抛 `SessionPersistenceCorruptionError`
     * → **会话永久打不开**（用户报的"会话老是损坏"）。实证见 S142 §26.2（真实日志 seq 5066）。
     * 正确形状与 `seams/bootstrap.ts:306-311` 的锚定消息一致。
     *
     * 🔴 **DII M2 · 注入点 #10**（2026-11-04）：**这一处是 I1 最需要被看见的一格**。
     * 它是 ACC 产的消息（`origin:'acc'`），但宿主校验**强制**要求 `kind:'user'`
     * （缺了它会话打不开，见上）。⇒ 旧的 `source: { kind: 'user' }` 是**没办法的办法**：
     * 它丢掉了"谁产生的"这一信息。现在 `Injection` 记着 `origin:'acc'`，语料/语录
     * 那一侧（M3）就能按 `origin` 正确排除它 —— **不必再靠正文标记猜**。
     * ⚠️ **宿主 kind 仍是 `'user'`，一字不改**：这一格只把"我是谁"补回来，不改落点。
     */
    id: `rebuild-anchor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text: pending.anchor }],
    // source 必填（UserMessage 契约）——缺失会使 session.list sessionListMetadata 抛 TypeError
    // 🔴 `origin:'acc'` 但宿主强制 kind:'user' ⇒ 走 REBUILD_ANCHOR_SOURCE（见下）。
    source: REBUILD_ANCHOR_SOURCE,
  } as never, {
    surfaceOp: { op: 'replace', startSeq: targets[0]!, endSeq: targets[targets.length - 1]! },
    sourceEventSeqs: targets,
  } as never)
  return true
}

const REBUILD_ANCHOR_SOURCE: MessageSource = { kind: 'user' }

/**
 * 重建后重命名 dsh 会话标题（需求② S142 用户拍板：rebuild 后标题带新阶段概括）。
 * 标题 = S###-YYYY-MM-DD-<summary>——S### 与日期从持久轨迹目录名派生（不信任 LLM），
 * 概括来自 queueRebuild 的 summary 参数（服务端清洗截断）。
 * 失败仅 warn 不阻断重建主流程（标题美观非关键路径）。
 */
function renameAfterRebuild(ctx: Context, agent: Agent, pending: PendingRebuild): void {
  try {
    const mdPath = pending.mdPath
    const dirName = basename(dirname(mdPath))
    const sessionId = parseTrajectoryCode(dirName) ?? dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')
    const info = { sessionId, dirName, mdPath }
    const title = namingTitleFor(info, pending.summary)
    const titles = hostService<{ rename?: (session: unknown, title: string) => unknown }>(ctx, 'sessionTitle')
    if (!titles || typeof titles.rename !== 'function') {
      console.warn('[serenity-hooks] rebuild 后重命名跳过: sessionTitle 服务不可用')
      return
    }
    // 方法调用保 this 绑定（v1.23.2 教训：不解构 rename 后裸调用）
    titles.rename(agent.session, title)
    console.log(`[serenity-hooks] rebuild 后会话重命名: ${agent.id} → ${title}`)
  } catch (error) {
    console.warn(`[serenity-hooks] rebuild 后重命名失败（不阻断）: ${String((error as Error)?.message ?? error)}`)
  }
}

/**
 * 注册 turn-stopping 钩子（index.ts apply 调用）：
 * agent 每轮 turn 结束前（serial）检查 pending 队列——有该会话的重建请求 → 执行清空
 * 并 **steer 自动继续**（v1.22.5：next-step 非空 → turn 不 break → 模型自动读取
 * SESSION.md 继续，无需用户手工输入；DSH 官方先例 hooks-claude-code Stop hook）。
 * 陈旧队列（超 TTL）丢弃防误清空；无 pending 零开销。
 */
export function registerRebuildTurnHook(ctx: Context): void {
  ctx.on('agent/turn-stopping', (payload: { agent?: Agent; turn?: number }) => {
    const agent = payload?.agent
    if (!agent) return
    const id = agent.id
    const pending = pendingRebuilds.get(id)
    if (pending === undefined) return
    // 陈旧队列丢弃（turn 异常结束/agent 崩溃后残留不应误清空）
    if (Date.now() - pending.queuedAt > PENDING_TTL_MS) {
      pendingRebuilds.delete(id)
      writeRebuildDiag(resolveSerenityRootFor(agent), {
        sessionId: id,
        event: 'ttl-dropped',
        detail: `queuedAt=${isoLocal(pending.queuedAt)} older than ${PENDING_TTL_MS / 60000}min TTL — turn did not end in time`,
      })
      return
    }
    pendingRebuilds.delete(id)
    try {
      // tokenMeter 可选（DSH 装配通常有；缺失时退化——无 shadow-price 仅计量漂移）
      const tokenMeter = hostService<{ estimateMessage?: (message: Message) => number }>(ctx, 'tokenMeter')
      const meter =
        tokenMeter && typeof tokenMeter.estimateMessage === 'function'
          ? { estimateMessage: (m: Message) => tokenMeter.estimateMessage!(m) }
          : undefined
      const rebuilt = performRebuild(agent.session, pending, meter)
      if (rebuilt) {
        // 需求②：重建后重命名 dsh 会话标题为 S###-日期-概括（重建代表新工作阶段；
        // 编号日期从持久轨迹目录派生，概括来自 summary 参数——与 use/create 命名一致）
        renameAfterRebuild(ctx, agent, pending)
        // v1.22.5 自动继续：steer 到 next-step 队列 → turn 循环 nextStep 非空不 break →
        // 模型在同轮内自动消费该指令，读取 SESSION.md 从上次进度继续（无需用户手工输入）
        // 🔴 **DII M2 · 注入点 #9**（2026-11-04）：改走 `deliver()`。
        //    `delivery:'wake-now'` ⇒ 通道由 deliver 选（steer），行为零变更。
        deliver(
          makeInjection({
            origin: 'acc',
            form: 'instructions',
            summary: 'rebuild 后自动继续',
            text: `${eventToken('rebuild')} The conversation has been cleared and rebuilt. Follow the anchor instructions above now: read the persistent cognitive trajectory (SESSION.md) and continue the work automatically from the last checkpoint.`,
            delivery: 'wake-now',
          }),
          agent,
        )
        writeRebuildDiag(resolveSerenityRootFor(agent), { sessionId: id, event: 'rebuilt' })
        console.log(`[serenity-hooks] cognitive_trajectory rebuild executed with auto-continue (turn ${payload.turn ?? '?'} ended): ${id}`)
      } else {
        // surface 空（无节点可清）——极罕见；记录诊断
        writeRebuildDiag(resolveSerenityRootFor(agent), { sessionId: id, event: 'empty-surface' })
      }
    } catch (error) {
      // 2026-09-05 用户 bug（调用成功但没重建）：错误曾只 console.warn 不可见 →
      // 落盘诊断 + 保留 warn。诊断文件让 agent/用户可直接定位断点。
      const msg = String((error as Error)?.message ?? error)
      writeRebuildDiag(resolveSerenityRootFor(agent), { sessionId: id, event: 'failed', detail: msg })
      console.warn(`[serenity-hooks] cognitive_trajectory rebuild failed: ${msg}`)
    }
  })
}

/**
 * 从 agent 会话 cwd 解析 CCC 根（诊断落盘用）；无则回退进程 cwd。
 *
 * ⚠️ **语义与 `cccRootForExec` 不同且必须不同**：这里 `?? process.cwd()` 是**返回假根**
 * （诊断落盘总要有个位置，没有根也要写），而工具/缝入口要的是 `null`（让调用方报错）。
 * C2 归一后此处仍保留该差异，只把"取 cwd"那半交给 `agentCwdFor`（现状稿 §2.D 第 7 条）。
 */
function resolveSerenityRootFor(agent: Agent): string {
  return cccRootForCwd(agentCwdFor(agent as { session?: { header?: { cwd?: string } } })) ?? process.cwd()
}
