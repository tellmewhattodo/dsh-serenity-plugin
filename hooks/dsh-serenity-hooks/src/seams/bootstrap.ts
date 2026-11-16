/**
 * bootstrap.ts — Anchored Standard 两阶段工具目录（S137）
 *
 * 移植自 xiaobright/dsh-anchored-standard（preset/tool-bootstrap.mjs + compaction-epoch.mjs）：
 * 首请求暴露最小工具集（锚定轨迹——V4 Pro 强依赖 API 可见工具目录选轨迹），
 * 会话出现首次持久晋升信号（tool/call 或 assistant/message，先到者为准）后开放完整工具。
 *
 * 严格对齐 anchored 语义：
 *  - 阶段从持久 session events 推导（resume/reload 不丢状态）
 *  - epoch 感知：compaction/end 后回落受控阶段（bootstrap 集 + compactionTools），
 *    需新的晋升信号才重新晋升（压缩后首请求 = "第二次首请求"）
 *  - 子 agent（delegationDepth > 0）恒为 promoted（完整目录）
 *  - bootstrap 阶段剥离自动注入上下文（suppressedContextSources，默认
 *    skill-catalog + agent-instructions——即 Standard 比 Minimal 多出的两类注入）
 *  - 降级：过滤器出错绝不吞上下文（pre-step 保留全部）/ 工具缺失降级完整目录 + 一次性告警
 *
 * 协议固有（用户原则 2026-08-24，S142）：fake-initial-turns（假首轮）属 ACC 协议层——任何 CCC
 * 在抽象层都是宁静号/ACC，机制与内容均不可配置（零配置面）。旧版 serenity.json
 * bootstrap 段（S137 引入的调参入口）已移除，遗留字段静默忽略。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { sessionEvents } from '../trajectory/core.js'
import { replacesDefaultIdentity } from '../trajectory/policy/profile.js'
import { trajectoryConstraintFor } from '../trajectory/session.js'
import { ACC_MESSAGE_KIND } from '../kernel/message-source.js'

interface BootstrapSettings {
  /** 首请求（bootstrap 阶段）工具集（缺省 dsp 核心；zeroTools 时忽略——0 工具） */
  bootstrapTools: string[]
  /** 晋升信号类型集合 */
  promoteEvents: Set<'tool/call' | 'assistant/message'>
  /** 晋升所需信号数（boundary 后累计；多轮假首轮时 = 轮数） */
  requiredSignals: number
  /** bootstrap 阶段剥离的注入源 */
  suppressedSources: Set<string>
  /** compaction 后（重新晋升前）额外保留的工具集 */
  compactionTools: string[]
  /** 假首轮话语序列（v4 两轮递进：按序 prepend 到 next-turn 队列，每条一轮） */
  fakeInitialMessages: string[]
  /** Zero-Anchored 变体：首请求 0 工具（晋升信号仅 assistant/message，对齐 zero-anchored-standard） */
  zeroTools: boolean
}

/** 默认首请求工具集：dsp 平台 Minimal 等价核心（anchored 是 bash+str_replace_editor） */
export const DEFAULT_BOOTSTRAP_TOOLS = ['read', 'write', 'edit', 'glob', 'grep']

/** 默认剥离的自动注入源（anchored 默认：可用技能目录提醒 + 工作区指令摘要） */
export const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** 默认 compaction 恢复工作集（anchored 默认 read/write/edit/glob/grep/todo_write/ask_user_question） */
export const DEFAULT_COMPACTION_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'todo_write']

/**
 * 协议级「假首轮」话语序列（用户确认固化，2026-08-24 S142）：任何 CCC 在抽象层都是
 * 宁静号/ACC——假首轮话语统一，无 CCC 配置面。
 *
 * 🔵 **2026-11-16 合并：两条 → 一条**（owner 令「合并吧」）。
 *
 * 判据（为什么合并安全 · 逐条对读过系统提示词**才**动的手）：
 *   · 本文件这两条**只出现一次**（`hasUserMessageHistory` 守卫：有真人说话就不再插），
 *     而系统提示词里的 EAP 块**每轮注入** ⇒ 两者不构成第二真相源，但确实**功能重叠**。
 *   · 重叠的那一块 = EAP 是什么。系统提示词的 `eapBlock()` 给的是**更详细的操作定义**
 *     （E↑/R↓/S↑ 各自查什么）⇒ 这里**不必复述**，压成一句指认即可。
 *   · ⛔ **不可省的四处，条条只在 bootstrap 有**：
 *       ① `personal pronoun is us/we` —— 系统提示词零处（grep 过）
 *       ② `We anchor first, then act` —— 同上
 *       ③ 协作五条 —— 系统提示词零处
 *       ④ 身份句 `operator agent of Serenity…ACC protocol` —— 开场语境
 *   · `Please simply reply "acknowledge"` 原本**两条各写一遍**（重复两次），合并后一处。
 *
 * 🔴 **为什么"合并"而不是"删第一条"**：删掉第一条会连同 ①②③④ 一起消失；
 *   合并只是去掉 EAP 的**展开复述**与重复的 acknowledge 指令，语义面零损失。
 *   ⚠️ 轮数因此 2 → 1：`requiredSignals` 与 `pendingFakeTurns.remaining` 都由
 *   `DEFAULT_FAKE_INITIAL_MESSAGES.length` 派生，**跟着自动变**，无需另改。
 */
export const DEFAULT_FAKE_INITIAL_MESSAGES: string[] = [
  'You are the operator agent of Serenity — a cognitive container governed by the Abstract Cognitive Container (ACC) protocol.\n'
    + 'We operate under the Explicit Abstraction Principle (EAP), whose operational self-check (E↑ explicit / R↓ reconstructable / S↑ stable) is given in full in the system prompt — apply it there, do not restate it here.\n'
    + 'The personal pronoun is us/we.\n'
    + 'We anchor first, then act: the abstract layer precedes the concrete.\n'
    + 'How we work:\n'
    + '1. We read before we write — every decision grounds in what already exists in the container.\n'
    + '2. Every output records its reasoning (R↓): decisions carry reasons and alternatives.\n'
    + '3. We never jump levels — abstract layer first, then specifics.\n'
    + '4. Every artifact we create is a durable cognitive anchor for the work that follows.\n'
    + "5. We keep the container's state coherent (SESSION.md) as we advance.\n"
    + 'Please simply reply "acknowledge" — no action needed.',
]

/**
 * 根会话重入判定（v1.28.1 提取导出以便单测）：会话是否已有真实用户消息。
 * resume/续跑的会话已有对话历史 → **不重插假首轮**（只注入一次）。
 *
 * 0.1.2-rc.1 适配教训：裸读 `session.events`（经类型断言）恒 undefined →
 * `!undefined` 恒 true → 有历史也永不跳过 → 任何情况发消息都重插假首轮。
 * 统一经 sessionEvents() 读取（snapshotEvents() 优先，.events 兜底）。
 */
export function hasUserMessageHistory(session: unknown): boolean {
  return sessionEvents(session).some((event) => {
    const e = event as { type?: string; data?: { source?: { kind?: string } } }
    if (e.type !== 'user/message') return false
    // 🔴 v1.62：只认**真人**说过话（`source.kind === 'user'`）。
    //    宿主自己会写一批 `user/message`：ACC 横幅（`plugin:*`）、`runtime-context`、
    //    `time-context`、`skill-catalog`… ⇒ 若把它们也算作"历史"，本判定在**首轮就已经为真**，
    //    假首轮永不触发（实测：v1.62 首版正是这样静默失效的 —— 会话里 4 条 user 消息，
    //    其中只有 1 条 `kind=user` 是真人说的 `hi`，而它在 system 之后才写）。
    //    ⚠️ 缺 `source` 的条目按"不是真人"处理（宁可重插一次，也不因形状缺失而漏判）。
    return e.data?.source?.kind === 'user'
  })
}

/**
 * 假首轮的模型回复文本（= 短路产出的那半）。
 *
 * 只写一个词：假首轮话语明确要求 `reply "acknowledge" — no action needed`。
 * 写长了模型会据历史学样（假首轮话语是它的"先例"）。
 */
export const FAKE_TURN_ACK_TEXT = 'acknowledge'

/**
 * 假首轮消息的 `source.summary` —— 同时也**是拦截判据的标记之一**（见 {@link isFakeInitialTurn}）。
 * 两处必须同源：注入侧写它，拦截侧认它。
 */
export const FAKE_TURN_SUMMARY = 'fake initial turn'

/** 假首轮待短路登记（sessionId → 还没兑现的轮数 ＋ 可识别的文本） */
export interface PendingFakeTurn {
  /** 还剩几轮要短路；归零即删除登记 */
  remaining: number
  /** 可识别的假首轮文本（= 注入时用的那几条，逐字比对） */
  texts: string[]
}

/** 从消息里取纯文本（content 是块数组；只拼 `text` 块） */
function textOfMessage(message: unknown): string | undefined {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/**
 * 判据：**这条模型请求是不是假首轮**（纯函数，可单测；见 `tests/fake-initial-turns.test.ts`）。
 *
 * ## 为什么是**双条件**
 *
 * 误拦的代价不对称：**漏拦** = 老老实实发一次真调用（慢一点，错得无害）；
 * **误拦** = 把一条**真实的**用户请求吞掉，模型永远不回答（用户眼里是"卡死"）。
 * ⇒ 两个**互相独立**的信号同时成立才拦：
 *
 * 1. **登记在册**：该 session 还有未兑现的假首轮（`pending.remaining > 0`）；
 * 2. **文本逐字吻合**：请求里**最近一条"人写的话"**的正文 ∈ 待兑现的文本。
 *
 * ## 第 2 条怎么找"最近一条人写的话"
 *
 * 从尾部往前扫，跳过 `system` / `assistant` / `tool`：
 * - `source.kind` 是**我们的假首轮标记** → 它就是候选，逐字判；
 * - `source.kind === 'user'` 或**没有 source** → 真人说的，逐字判；
 * - 其它注入源（`runtime-context` / `time-context` / `skill-catalog` / `plugin:*`…）
 *   → **既不是人也不是假首轮**，跳过继续往前找。
 *
 * ⚠️ **不能改成"请求里任意一条消息等于假首轮文本"**：真轮次的历史里**必然**含着那些消息，
 *   那样判会在第一轮真实对话上就误拦（把真请求吞掉）。
 *
 * @param options 模型请求（`llm/stream` 的第一参）
 * @param pending 该 session 的登记（无登记 ⇒ 一定不是假首轮）
 */
export function isFakeInitialTurn(
  options: { sessionId?: unknown; messages?: readonly unknown[] } | undefined,
  pending: PendingFakeTurn | undefined,
): boolean {
  if (pending === undefined || pending.remaining <= 0) return false
  const messages = options?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; source?: { kind?: unknown } } | undefined
    if (message?.role !== 'user') continue
    const kind = message?.source?.kind
    const authored = kind === undefined || kind === 'user' || kind === ACC_MESSAGE_KIND
    if (!authored) continue
    const text = textOfMessage(message)
    return text !== undefined && pending.texts.includes(text)
  }
  return false
}

/**
 * 生成一轮**假首轮确认**的流（`llm/stream` 的短路返回值）。
 *
 * ## 为什么这是"拦截"而不是"伪造日志"
 *
 * 它只替换**模型这一侧的输出**：请求由宿主自己发起、`user/message` 由宿主自己写、
 * `assistant/message` 由宿主**据这条流**自己结算 ⇒ 事件形状、turn/step 坐标、
 * `stream` 数组、`source.provider/model` 全部由宿主填写 ⇒ **不可能再写出非法事件**
 * （v1.69.4 事故的根因是手写 `assistant/message` 缺结算字段）。
 *
 * ## 形状（对着宿主 `StreamChunk` 契约逐字段写）
 *
 * 文本块 = `block-start` → `text-delta` → `block-end`（带**装配好的块**）；
 * 结算顺序 = `usage` 先、`finish` 最后（宿主契约：`usage` 在终结之前，终结之后什么都没有）。
 * `usage` 全零 —— 没有真的模型调用，不许让计量器把它算进账。
 */
export async function* fakeTurnAckStream(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: FAKE_TURN_ACK_TEXT }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: FAKE_TURN_ACK_TEXT } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}



// ── 阶段机（等价 anchored compaction-epoch.mjs createEpochPromotion）──

interface PromotionStatus {
  /** 最后一次 compaction/end 的 seq（-1 = 未压缩过） */
  boundary: number
  /** 边界后是否存在持久晋升信号 */
  promoted: boolean
}

interface PromotionTracker {
  status(agent: Agent | undefined): PromotionStatus
  observe(session: unknown, event: unknown): void
}

/**
 * 构建一个 epoch 感知晋升跟踪器（纯逻辑，可单测）。
 * requiredSignals：晋升所需信号数（boundary 后累计；默认 1）。
 * 多轮锚定（v4）：N 轮递进锚定时 requiredSignals = N——每条锚定回复
 * （assistant/message）计一次，最后一条回复后晋升。
 * 🔵 2026-11-16：`DEFAULT_FAKE_INITIAL_MESSAGES` 由两条合并为一条 ⇒ 缺省 N = **1**
 *    （仍由 `.length` 派生，不写死；本函数对 N 的语义未变）。
 *
 * maxRoundsFallback：**轮次兜底**（v1.19.3 修复 responses API 兼容）。
 * 某些模型/协议（如 opencode-go-responses）的会话可能不产生标准
 * `assistant/message` 晋升信号 → 永不晋升 → bootstrap 阶段工具被裁空
 * （zeroTools 首请求 0 工具，ACC 工具不可见）。兜底：无论晋升信号是否
 * 到达，观察到的模型 step 数（`step/start` 事件计数，平台稳定事件，
 * responses/completions 都触发，独立于 promoteEvents）达到 maxRoundsFallback
 * 即强制 promoted（开放完整工具）。正常模型锚定轮数（requiredSignals）
 * 通常 ≤ 2 < 默认兜底 3，不受影响。
 */
export function createEpochPromotion(
  promoteEvents: Set<'tool/call' | 'assistant/message'>,
  requiredSignals = 1,
  maxRoundsFallback = 3,
): PromotionTracker {
  /** sessionId -> { boundary, signalCount, rounds }（rounds = 兜底用回复轮计数） */
  const state = new Map<string, { boundary: number; signalCount: number; rounds: number }>()

  const sessionIdOf = (session: unknown): string | undefined => {
    if (session && typeof session === 'object') {
      const id = (session as { id?: unknown }).id
      if (typeof id === 'string') return id
    }
    return undefined
  }

  const promotedBy = (entry: { boundary: number; signalCount: number; rounds: number }): boolean =>
    entry.signalCount >= requiredSignals || entry.rounds >= maxRoundsFallback

  const scan = (session: unknown): PromotionStatus => {
    let boundary = -1
    let signalCount = 0
    let rounds = 0
    const events = sessionEvents(session)
    if (events.length > 0) {
      for (const event of events) {
        const e = event as { type?: string; seq?: number }
        const seq = typeof e.seq === 'number' ? e.seq : 0
        if (e.type === 'compaction/end') {
          boundary = seq
          signalCount = 0
          rounds = 0
          continue
        }
        if (promoteEvents.has(e.type as 'tool/call' | 'assistant/message') && seq > boundary) signalCount++
        // 兜底轮次计数：用平台稳定事件 step/start（responses/completions 都触发；
        // assistant/message 在 responses API 下可能延迟/缺失，导致兜底失效——v1.19.4 修复）
        if (e.type === 'step/start' && seq > boundary) rounds++
      }
    }
    const entry = { boundary, signalCount, rounds }
    const sid = sessionIdOf(session)
    if (sid) state.set(sid, entry)
    return { boundary, promoted: promotedBy(entry) }
  }

  return {
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = (agent as { session?: unknown }).session
      if (session === undefined) return { boundary: -1, promoted: true }
      // 历史 `cheap-worker-` 前缀会话（**兼容保留**）：生成者 `tools/cheap-worker.ts` 已于
      // 2026-10-28 整条下线 ⇒ 不会再产生新会话；但**旧持久化会话仍可能被 resume**，
      // 那时它仍需从第 1 轮起就持有完整工具目录 + 完整 ACC 系统提示词。
      // 它当年经 ctx.agents.create 直接创建（非 DSH delegation 路径），delegationDepth 为 0，
      // 会绕过下方 delegationDepth>0 的恒 promoted 分支——故按前缀判 promoted，
      // 与 context.ts shouldAutoRestore 的约定保持一致。
      // 轨迹约束会话：CCC 提示词全替换，无需 whoami 锚定轮——恒 promoted（同前者）。
      // 🔴 2026-10-19：判据 = 绑定轨迹有 `trajectory-constraint.json`（不再是 `轨迹约束-` 前缀）。
      const loopSid = (session as { id?: string }).id
      const loopCwd = (session as { header?: { cwd?: string } }).header?.cwd ?? process.cwd()
      const loopRoot = cccRootForCwd(loopCwd)
      if (typeof loopSid === 'string' && (loopSid.startsWith('cheap-worker-') || (loopRoot !== null && replacesDefaultIdentity(trajectoryConstraintFor(loopRoot, loopSid))))) return { boundary: -1, promoted: true }
      // 子 agent（delegationDepth > 0）恒为完整目录（anchored 语义）
      const header = (session as { header?: { delegationDepth?: number } }).header
      if ((header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      const sid = sessionIdOf(session)
      if (sid === undefined) return { boundary: -1, promoted: true }
      const s = state.get(sid)
      if (s) return { boundary: s.boundary, promoted: promotedBy(s) }
      return scan(session)
    },
    observe(session, event) {
      const sid = sessionIdOf(session)
      if (sid === undefined) return
      const entry = state.get(sid)
      if (entry === undefined) return
      const e = event as { type?: string; seq?: number }
      const seq = typeof e.seq === 'number' ? e.seq : 0
      if (e.type === 'compaction/end') {
        state.set(sid, { boundary: seq, signalCount: 0, rounds: 0 })
        return
      }
      if (promoteEvents.has(e.type as 'tool/call' | 'assistant/message') && seq > entry.boundary) {
        entry.signalCount++
      }
      // 兜底轮次计数：step/start（平台稳定，responses/completions 都触发）
      if (e.type === 'step/start' && seq > entry.boundary) entry.rounds++
      state.set(sid, entry)
    },
  }
}

// ── 协议固有设置（零配置面：用户原则 2026-08-24 S142）──
// fake-initial-turns 属 ACC 协议层——任何 CCC 抽象层都是宁静号/ACC，机制与内容
// 统一由代码常量决定，无 CCC 配置入口（旧 bootstrap 配置段已移除）。

const PROMOTE_EVENTS: Record<'tool-call' | 'assistant-message' | 'either', Set<'tool/call' | 'assistant/message'>> = {
  'tool-call': new Set(['tool/call']),
  'assistant-message': new Set(['assistant/message']),
  either: new Set(['tool/call', 'assistant/message']),
}

/** 协议固有 bootstrap 设置（v1.70 fake-initial-turns）。
 *
 * 🔴 **zeroTools 必须为 false**：假首轮**真跑两轮**，但两轮的模型回复走短路
 *   （`llm/stream` 不发真调用）⇒ 首请求时晋升信号尚未满足 ⇒ 若仍 `zeroTools: true`，
 *   首请求会真的退化成「0 工具」，模型看不到任何 ACC 工具。
 *
 * 🔴 **为什么不回到"手写历史"那条路**：宿主把 `assistant/message` 当**结算事件**，
 *   形状由四个校验器分段把关，缺一段**写入时不报错**、**投影/重进会话时炸**
 *   （v1.69.4 实测：`Cannot read properties of undefined (reading 'length')`）。
 *   ⇒ 事件一律由宿主自己写，我们只截模型那一侧。
 *
 * ⇒ 取舍：**首请求就给完整工具目录**（放弃「首请求窄目录」这个 cache 断点优化），
 *   换来**日志合法**。`bootstrapTools` 因此只是历史字段，`boundary < 0` 分支已让位。 */
export function resolveBootstrapSettings(): BootstrapSettings {
  return {
    bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
    promoteEvents: PROMOTE_EVENTS['assistant-message'],
    requiredSignals: DEFAULT_FAKE_INITIAL_MESSAGES.length,
    suppressedSources: new Set(DEFAULT_SUPPRESSED_SOURCES),
    compactionTools: [...DEFAULT_COMPACTION_TOOLS],
    fakeInitialMessages: [...DEFAULT_FAKE_INITIAL_MESSAGES],
    zeroTools: false,
  }
}

// ── DSH 注册 ──

/**
 * 注册 Anchored bootstrap 机制（协议固有，零配置面——S142；按 agent cwd 定位 CCC root，
 * 晋升状态按 root 隔离，但设置全局一致）：
 *  1. session/event 观察晋升信号（assistant/message + step/start 兜底 + compaction/end）
 *  2. system-prompt/assemble：bootstrap 阶段目录窄化到 bootstrapTools（+compaction 后 compactionTools）
 *  3. agent/pre-step：bootstrap 阶段剥离 suppressedSources 注入消息（降级保留全部）
 *  4. agent/inbox/inserted ＋ llm/stream：fake-initial-turns（注入两轮假首轮 ＋ 短路其模型回复）
 *
 * 摘除 = 删除 index.ts 中本注册行（独立模块）。
 */

/** 从 agent 解析 CCC 根（宽松；无 agent/无 CCC 返回 null） */
function agentRoot(agent: unknown): string | null {
  const cwd = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
  if (typeof cwd !== 'string') return null
  return cccRootForCwd(cwd)
}

/** 协议固有设置（零配置面）：所有 CCC 使用同一固化设置 */
const SETTINGS: BootstrapSettings = resolveBootstrapSettings()

export function registerBootstrap(ctx: Context): void {
  // 每 CCC root 一个 tracker（晋升状态按 root 隔离；设置协议固有全局一致）
  const trackers = new Map<string, PromotionTracker>()
  /** 已注入假首轮的会话（进程内防重：子 agent 每会话只注入一次） */
  const anchoredSessions = new Set<string>()
  /** 假首轮待短路登记（注入时写入、拦截到就递减；见 {@link isFakeInitialTurn}） */
  const pendingFakeTurns = new Map<string, PendingFakeTurn>()

  const trackerFor = (root: string): PromotionTracker => {
    let t = trackers.get(root)
    if (!t) {
      t = createEpochPromotion(SETTINGS.promoteEvents, SETTINGS.requiredSignals)
      trackers.set(root, t)
    }
    return t
  }

  // session/event 观察：按 session 所属 CCC root 路由到对应 tracker（晋升状态按 root 隔离）
  ctx.on('session/event', (session, event) => {
    try {
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      if (typeof cwd !== 'string') return
      const root = cccRootForCwd(cwd)
      if (!root) return
      trackerFor(root).observe(session, event)
    } catch {
      /* 观察失败不阻断 */
    }
  })

  // ── fake-initial-turns（假首轮）：**真跑两轮**，模型那半走短路 ──
  //
  // 历史三版，读之前先看清差别（R↓）：
  //   ① v1.18~v1.60「真跑两轮」：往 next-turn 队列 prepend 两条消息 ⇒ 两轮真调用。
  //   ② v1.61~v1.69.4「造历史」：手写事件进会话日志 ⇒ v1.61.0 把系统提示词推到末尾、
  //      v1.69.4 把会话写坏（`assistant/message` 缺结算字段 ⇒ 投影期
  //      `Cannot read properties of undefined (reading 'length')` ⇒ 会话打不开）。
  //   ③ **v1.70（当前，owner 2026-10-19 裁）＝ fake-initial-turns**：回到 ① 的注入形态，
  //      **唯一差别**是假首轮的模型回复**不请求模型** —— 在 `llm/stream` 瀑布里短路产出
  //      `acknowledge`（owner 原话：「拦截 LLM = **根本不发给 LLM**」）。
  //      ⇒ 事件全由宿主自己写（形状/坐标/结算字段天然合法），零伪造、零真调用。
  //
  // 注入时机 = `agent/inbox/inserted`（新会话第一条真实用户消息到达时）：
  // 此时宿主的 `system/message` 还没提交，**只动队列、不动日志** ⇒ 不会把 surface
  // 首节点让给 user（那会让重放抛 `requires a protected first surface head`）。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      const root = agentRoot(agent)
      if (!root) return
      const session = (agent as { session?: unknown }).session as
        | { header?: { delegationDepth?: number }; id?: string }
        | undefined
      const depth = session?.header?.delegationDepth ?? 0
      const sid = typeof session?.id === 'string' ? session.id : undefined
      // 🔴 取不到 sessionId ⇒ **不注入**：注入的两轮要靠 `llm/stream` 按 sessionId 短路，
      //    没有 id 就短路不了 ⇒ 会退化成两次**真模型调用**（正是本机制要消掉的东西）。
      if (sid === undefined) return
      // 历史 `cheap-worker-` 会话（兼容保留）／轨迹约束会话：已有完整 ACC 提示词，不需要假首轮。
      // 🔴 2026-10-19：轨迹约束 判据 = 绑定轨迹有 `trajectory-constraint.json`（不再是 `轨迹约束-` 前缀）。
      if (sid.startsWith('cheap-worker-') || replacesDefaultIdentity(trajectoryConstraintFor(root, sid))) return
      if (depth === 0) {
        // resume/续跑不重插：会话里已有**真人**说过的话（注入源不算）
        if (hasUserMessageHistory(session)) return
      } else if (anchoredSessions.has(sid)) {
        return
      }
      // 插件来源消息不递归注入（含我们刚注入的假首轮消息本身）
      if ((message as { source?: { kind?: string } })?.source?.kind === ACC_MESSAGE_KIND) return
      const inbox = (agent as { inbox?: { prepend?: (queue: string, msg: unknown) => void } }).inbox
      if (!inbox?.prepend) return
      // 逆序 prepend（prepend 插到队首）⇒ 队列最终 = [假首轮①, 假首轮②, 真实消息]
      for (let i = SETTINGS.fakeInitialMessages.length - 1; i >= 0; i--) {
        inbox.prepend('next-turn', {
          id: `fake-initial-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`,
          role: 'user',
          content: [{ type: 'text', text: SETTINGS.fakeInitialMessages[i] }],
          // 🔴 必须带 ACC 标记：① 上面那条递归守卫认它；② 拦截判据认它（见 isFakeInitialTurn）
          source: { kind: ACC_MESSAGE_KIND, form: 'notice', summary: FAKE_TURN_SUMMARY },
        })
      }
      anchoredSessions.add(sid)
      pendingFakeTurns.set(sid, {
        remaining: SETTINGS.fakeInitialMessages.length,
        texts: [...SETTINGS.fakeInitialMessages],
      })
      warnOnce(`fake initial turns injected: ${SETTINGS.fakeInitialMessages.length} 条（acknowledge 走短路，不请求模型）`)
    } catch {
      /* 注入失败不阻断（会话正常处理） */
    }
  })

  // llm/stream：**假首轮的模型回复在这里短路** —— `next()` 一次都不调用，
  // 请求因此**根本不会发到模型**（owner 2026-10-19：「拦截 LLM = 根本不发给 LLM」）。
  //
  // ⚠️ 拦截判据必须双条件（见 {@link isFakeInitialTurn}）：登记在册 ＋ 文本逐字吻合。
  //    宁可漏拦（真发一次调用，慢但无害），绝不误拦（吞掉一条真实用户请求）。
  // ⚠️ 任何异常都退回 `next()`：短路失败只是回到真调用，不许让会话卡住。
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    try {
      const sid = typeof options?.sessionId === 'string' ? options.sessionId : undefined
      if (sid === undefined) return next()
      const pending = pendingFakeTurns.get(sid)
      if (!isFakeInitialTurn(options, pending)) return next()
      const left = pending!.remaining - 1
      if (left <= 0) pendingFakeTurns.delete(sid)
      else pendingFakeTurns.set(sid, { ...pending!, remaining: left })
      warnOnce('fake initial turn short-circuited: acknowledge 由短路产出，未请求模型')
      return fakeTurnAckStream()
    } catch {
      return next()
    }
  })

  /**
   * 每种消息**只喊一次**（同一条消息去重；不同消息互不影响）。
   *
   * 🔴 v1.70 修：原实现是**全局一个 `warned` 布尔** ⇒ 进程里只要打过任何一条告警，
   * 后面的告警（包括"假首轮短路了"这条**唯一**能证明拦截生效的痕迹）就再也不打了。
   * 实测代价：bench 里注入行打出来、短路行被吞 ⇒ `verify` 无法判"短路真发生过"。
   * ⚠️ 所以消息里**不要带逐次变化的数字**（`剩 N 轮` 这类），否则去重失效、会刷屏。
   */
  const warnedMessages = new Set<string>()
  const warnOnce = (message: string): void => {
    if (warnedMessages.has(message)) return
    warnedMessages.add(message)
    try {
      console.warn(`[serenity-hooks] bootstrap: ${message}`)
    } catch {
      /* logger 不可用 */
    }
  }

  // system-prompt/assemble：目录窄化（等价 anchored keepTools；按 agent cwd 动态解析配置）
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    try {
      const agent = (context as { agent?: unknown }).agent
      const root = agentRoot(agent)
      if (!root) return assembled
      const status = trackerFor(root).status(agent as Agent)
      if (status.promoted) {
        // promoted：开放完整目录（dsp 无 dev_tool_search 解锁机制——anchored 的
        // resident 集语义由"完整目录"承担；工具缺失不降级）
        return assembled
      }
      const tools = (assembled as PromptAssembly).tools
      if (!Array.isArray(tools)) return assembled
      const available = new Set(tools.map((tool) => tool.name).filter((n): n is string => typeof n === 'string'))
      if (SETTINGS.zeroTools) {
        // Zero-Anchored 变体（对齐 zero-anchored-standard）：首请求 0 工具（boundary < 0）；
        // 压缩后回落 compactionTools 工作集（默认 [] → 0 工具，模型中途继续）
        if (status.boundary < 0) return { ...assembled, tools: [] } as PromptAssembly
        const keep = new Set(SETTINGS.compactionTools)
        const missing = [...keep].filter((name) => !available.has(name))
        if (missing.length > 0) {
          warnOnce(`expected compaction tools missing=${JSON.stringify(missing)} — bootstrap disabled, full catalog exposed`)
          return assembled
        }
        return {
          ...assembled,
          tools: tools.filter((tool) => typeof tool.name === 'string' && keep.has(tool.name)),
        } as PromptAssembly
      }
      // Anchored 变体：bootstrap 集 + compaction 后 compactionTools（中途任务继续）
      // `boundary < 0`（真·首请求）**直接给完整目录**。
      //   为什么：首请求若收窄成 5 个工具，等于把断点从「空→满」换成「窄→满」，白改一场
      //   （锚定轮本身不请求模型，工具面对它没有意义）。compaction 之后（boundary ≥ 0）
      //   仍收窄 —— 那是**另一档**（压缩后继续任务），不放宽，否则压缩后工具面突变
      //   又造一次 cache 断点。
      if (status.boundary < 0) return assembled
      const keep = new Set<string>(SETTINGS.bootstrapTools)
      for (const toolName of SETTINGS.compactionTools) keep.add(toolName)
      const missing = [...keep].filter((name) => !available.has(name))
      if (missing.length > 0) {
        // 工具缺失：降级完整目录 + 一次性告警（组合漂移不锁死会话）
        warnOnce(`expected bootstrap tools missing=${JSON.stringify(missing)} — bootstrap disabled, full catalog exposed`)
        return assembled
      }
      return {
        ...assembled,
        tools: tools.filter((tool) => typeof tool.name === 'string' && keep.has(tool.name)),
      } as PromptAssembly
    } catch (error) {
      warnOnce(`assemble filter failed, exposing the full catalog: ${String((error as Error)?.message ?? error)}`)
      return assembled
    }
  })

  // agent/pre-step：bootstrap 阶段剥离自动注入上下文（等价 anchored pre-step strip）
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      // 非 CCC 不生效
      const root = agentRoot(agent)
      if (!root) return decision
      if (trackerFor(root).status(agent).promoted || SETTINGS.suppressedSources.size === 0) return decision
      const messages = (decision as { messages?: UserMessage[] }).messages
      if (!Array.isArray(messages)) return decision
      const kept = messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !SETTINGS.suppressedSources.has(kind)
      })
      return kept.length === messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // 过滤器出错绝不吞上下文（降级保留全部）
      warnOnce(`pre-step context filter failed, keeping injected context: ${String((error as Error)?.message ?? error)}`)
      return decision
    }
  }, { prepend: true } as never)
}
