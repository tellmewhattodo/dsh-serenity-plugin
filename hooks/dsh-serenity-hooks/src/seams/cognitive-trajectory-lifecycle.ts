/**
 * cognitive-trajectory-lifecycle.ts — 拦截缝：**认知轨迹生命周期**提醒（post-execute observe-and-enrich）
 *
 * 🔵 **2026-11-16 改名（原 `seams/keeper.ts`）**：本文件的职责在 v1.13x 后已经**只剩轨迹生命周期**——
 * 计分 ／ 交接 ／ 上下文压缩 ／ rebuild 提醒，全部围绕"这条认知轨迹该怎么续下去"。
 * `keeper` 是沿袭 opencode-serenity-plugin 的旧名（session-keeper），**名不副实** ⇒ 改成本名。
 *
 * 🔴 **改名边界（重要，别顺手改）**：只改**文件路径与模块 id**。
 * ⛔ **不改** `cognitiveTrajectory.keeper`（配置键）与 `'keeper'`（轨迹约束子集维度）——
 * 那两个是**外部契约**：用户 `trajectory-constraint.json` 里写着它们，改一名会让所有存量配置静默失效。
 *
 * 照 dsh-external/tool-failure-guard 模式：先检测计分，`next()` 委托，
 * 再把提醒折叠到返回决策的 additionalContexts（绝不 veto）。
 *
 * 计分（对齐 opencode-serenity-plugin session-keeper）：
 *   write/edit=3, task=10, read/grep/glob/msm=1, 经过时间 +1 分/分钟
 * 阈值：.opencode/serenity.json sessionKeeper.threshold（规范位置，.dsh 回退；缺省 150）
 * 提醒要求模型回应 [COGNITIVE-TRAJECTORY-ASSISTANT-recorded-{code}] 确认（DCP 模式）。
 */

import type { Context } from 'cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { hostService } from '../host/access.js'
import { loadSerenityConfig } from '../kernel/ccc.js'
import { agentCwdFor, cccRootForCwd } from '../kernel/ccc-roots.js'
import { makeInjection, toMessage } from '../kernel/injection.js'
import { readSimpleSettings } from '../surface/settings.js'
import { trajectoryConstraintParticipates } from '../trajectory/session.js'
import { getActiveSessionInfo } from '../trajectory/core.js'
import { readLastBound } from '../trajectory/bound.js'
import { shouldOfferReconstruct, selectHandoverPath, type HandoverPath } from '../trajectory/reconstruct.js'
import { eventToken, ACK_PREFIX, ACK_SKIP_PREFIX, LOG_FILE_REL } from '../trajectory/assistant.js'
import { recordToolUsage } from '../surface/usage.js'
import { PLUGIN_SOURCE } from '../kernel/message-source.js'

// ── 纯跟踪器（可单测）──

const SCORES: Record<string, number> = {
  write: 3,
  edit: 3,
  str_replace_editor: 3,
  task: 10,
  read: 1,
  grep: 1,
  glob: 1,
  skill: 1,
  msm: 1,
  container_fs: 1,
}

export function scoreTool(toolName: string): number {
  return SCORES[toolName] ?? 0
}

export class KeeperTracker {
  private score = 0
  private lastTs = 0
  private counter = 0
  constructor(
    private threshold: number,
    private now: () => number = Date.now,
  ) {}

  /** 记录一次工具调用 + 经过时间；返回是否应触发提醒 */
  step(toolName: string): boolean {
    const now = this.now()
    if (this.lastTs > 0) {
      this.score += Math.floor((now - this.lastTs) / 60_000) // +1 分/分钟
    }
    this.lastTs = now
    this.score += scoreTool(toolName)
    return this.score >= this.threshold
  }

  /** 生成确认码并清零积分 */
  ack(): string {
    this.counter += 1
    this.score = 0
    this.lastTs = 0
    return `K${this.counter}`
  }

  get currentScore(): number {
    return this.score
  }
}

export function reminderText(code: string): string {
  // v1.18.7：英文 + 不中断工作语气（用户要求）——无需停下，顺手回应即可
  // v1.23.0：前缀 SESSION-KEEPER → TRAJECTORY-STEWARD（用户定名：trajectory 维护机制）
  // v0.3/v1.29：统一进 cognitive-trajectory-assistant（TRAJECTORY-STEWARD → COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT）
  // 2026-09-16（S142 所有者指令，D64）：**不再注入计分数值**。
  //   计分是 ACC 的内部账目（工具调用次数换算），LLM 拿到它既不构成可执行动作，
  //   又与"上下文消耗"同属"非必要信息"（占用注意力 ⇒ 净损耗）。
  //   关联既有纪律：v1.23.3 "不向 LLM 植入阈值建议"——本条是同一原则的延伸。
  //   ⚠️ 计分**仍在**（KeeperTracker.score 决定何时该提醒；面板照常显示给人看），
  //   只是**不再进入注入文本**。
  return `${eventToken('checkpoint')} Score threshold reached. Please acknowledge with [${ACK_PREFIX}-${code}] once progress is synced to the working session (acc-session show). No need to interrupt your work — just acknowledge inline and keep going.`
}

/**
 * F2 rebuild 提示（v1.21；v1.22.1 对齐"轨迹跟踪器"概念；v1.23.0 英化 + 载体关系；
 * v1.23.3 行动指令化——用户反馈"一直在触发为啥没执行"：旧文案是状态播报式
 * （"[TRAJECTORY] Context usage at N%..."），模型当成系统状态而非行动请求，可一直忽略。
 * 新文案 = 明确的行动指令（ACT NOW + 何时执行 + 必须执行），对齐 steward ACK 协议风格。
 *
 * v1.24.12 沉淀协议（S142 用户需求）：rebuild 前若掌握值得沉淀的认知——修订 CCC 现有
 * skill（eap 结构化）；若需新建 skill——**不自行创建**，写提案进 SESSION.md 供用户参考。
 * 简短留自由度（不提"加载 eap 工具"，模型自知；只说修订 skill + 新建 skill 落 SESSION）。
 *
 * escalated=true（v1.23.3）：连续多轮超阈值仍未 rebuild → 升级强制语气
 * （STOP and rebuild now，持续注入直到调用 cognitive_trajectory rebuild）。
 *
 * 需求①（S142 用户拍板，v1.28.0）：百分比比例 → K 数值——**判定**改为绝对
 * `projectedTokens ≥ thresholdK*1000`（触发语义，未变）。
 * 🔴 2026-09-16（S142 所有者指令，D64）：**判定用 K，但注入文本里不再给任何数值**——
 *   原文案 `Context usage at NNNK (threshold NNNK)` 属于"向 LLM 透露上下文消耗与限制"，
 *   是非必要信息（LLM 不据此决策，只占注意力）。⇒ 参数退化为仅 `escalated`。
 *   ⚠️ 触发判定与提醒行为**一字未改**（仍读 projectedTokens / thresholdK 比对；仍升级催）；
 *   变的只是**注入文本不再携带 tokensK / thresholdK**。
 *   使用者若要查看当前占用/阈值：看面板（`rebuildThresholdK` 滑块 + 状态显示）——那是给人看的。
 *
 * v1.31.1 交接协议（S142 用户需求"要求 LLM 将当前手头事项写在 SESSION.md 尾部，并要求
 * rebuild 后去读并处理"）：**写侧** = 这里；**读侧** = rebuild 锚点（trajectory/rebuild.ts）。
 * 两侧共用 cognitive-trajectory-assistant 的常量（单一真相源）。
 *
 * 🔴 **v1.49.0（owner 2026-09-26 裁决："砍掉 in-flight，这正是目的"）**：写侧**不再**指向
 * SESSION.md 末尾的段，改指**独立便签文件** `REBUILD-TODO_FILENAME`（轨迹目录下）——
 * 理由见该常量的头注（持久文件 vs 只用一次的交界材料必须分家）。
 */
/**
 * 交接提醒（**rebuild 与 reconstruct 共用同一条文案**，2026-11-16 owner 裁定；
 * 2026-11-17 owner 再裁 **1.A：文案统一指名 `rebuild`**）。
 *
 * 🔴 为什么必须无差别：`rebuild`（原地清空、会话 id 不变）与 `reconstruct`
 * （另开日志、旧会话归档）对**会话本身**做的是同一件事——**把它换掉**。
 * 旧日志封不封存、id 变不变，是**机械层的账**，会话不需要知道，也不该据此改变行为。
 * 让模型看见两条不同文案 ⇒ 它要判断"我该调哪个" ⇒ 把一个机械决定变成一次思考，
 * 既浪费注意力，又可能选错。
 *
 * 🔴🔴 **1.A 的落地（2026-11-17）**：本函数**只指名 `rebuild`**，绝不出现 `reconstruct`。
 *   理由是执行面已经接好了：`cognitive-trajectory.ts` 的 `case 'rebuild'` 会在
 *   **累计量 ≥ `RECONSTRUCT_TOKEN_THRESHOLD`** 时把它**机械改道**成 `reconstruct`。
 *   ⇒ 模型只需知道**一个**动作名；"哪条路"由 ACC 算，不由模型猜。
 *   ⚠️ 这条裁定同时废止了 `trajectory/reconstruct.ts` 的 `reconstructReminderText()`
 *   （它自 v1.121.0 起**从未接线**，一直是死代码）——已随本版删除。
 *
 * 选路由本文件的 `registerKeeper` 一侧机械完成（`selectHandoverPath` 只是纯函数），规则见那里的注释。
 *
 * ⚠️ 便签落点 = `LOG/LOG.md` 的 `## Handover note` 节（2026-11-16 裁定）：
 * 它是**小步落盘的同一块地**，不另立文件；轮转时该节整节搬进新代出生头。
 */
export function handoverReminderText(escalated = false): string {
  if (escalated) {
    return `${eventToken('handover')} Repeatedly unacknowledged. STOP: write "## Handover note" into ${LOG_FILE_REL} `
      + `(the exact step you are in, what comes next, what is unfinished), then call `
      + `cognitive_trajectory rebuild --summary "<next phase ≤20 chars>" immediately.`
  }
  return `${eventToken('handover')} This carrier is being retired; the cognitive trajectory continues. `
    + `Write your in-flight state into ${LOG_FILE_REL} under "## Handover note", then call `
    + `cognitive_trajectory rebuild --summary "<next phase ≤20 chars>".`
}

/** 读取会话 contextPressure 投影（sessionProjections 可选服务；未装配返回 null） */
export function readContextPressure(
  ctx: Context,
  session: unknown,
): { projectedTokens: number; contextWindow: number | undefined } | null {
  try {
    const projections = hostService<{ snapshot?: (s: unknown) => { values?: Record<string, unknown> } }>(ctx, 'sessionProjections')
    if (!projections) return null
    const snap = projections.snapshot?.(session)
    const pressure = snap?.values?.contextPressure as { projectedTokens?: number; contextWindow?: number } | undefined
    if (!pressure || typeof pressure.projectedTokens !== 'number') return null
    return { projectedTokens: pressure.projectedTokens, contextWindow: pressure.contextWindow }
  } catch {
    return null
  }
}

// ── SESSION.md 体积超限 → LOGBOOK COMPACTION 提醒（v1.31.1，S142 用户需求）──

/**
 * 活跃 SESSION.md 体积上限缺省值（KB）。
 * CCC 级可覆盖：`.opencode/serenity.json` → `sessionKeeper.sessionMdMaxKB`（0 = 关闭）。
 *
 * 变更史（每次改都有明确 owner 令，别把它当调参）：
 * · v1.31.1 引入，缺省 **100**；
 * · v1.31.2（owner 2026-09-09）**100 → 200**：当时理由是"100KB 对长期维护会话偏紧"；
 * · 🔴 **v1.84.0（owner 2026-10-21）200 → 100** —— owner 明令「阈值改为 100k」。
 *   ⚠️ **同时**把重写文案换成「按 EAP 重构整个 SESSION.md」（同一次令）。两件事配套：
 *   更低的阈值 + 更明确的动作词 ⇒ 催得更早，但每次催都给出**可执行的重构判据**，
 *   而不是只报一个体积数。⇒ 旧理由（"催得勤会疲劳"）的前提被"催得更可执行"抵消。
 */
export const DEFAULT_SESSION_MD_MAX_KB = 100

/** 连续超限轮数达此值 → 升级强制语气（对齐 rebuild 提醒的 REBUILD_ESCALATE_AFTER） */
const COMPACTION_ESCALATE_AFTER = 3

/** 路径/配置缓存 TTL（避免每次工具调用都解析路径与读配置；stat 每次都做，很便宜） */
const MD_CACHE_TTL_MS = 60_000

interface MdPathCacheEntry {
  mdPath: string | null
  at: number
}

const mdPathCache = new Map<string, MdPathCacheEntry>()
const mdLimitCache = new Map<string, { limitKB: number; at: number }>()

interface CompactionState {
  /** 连续超限轮数（文件降回限内即清零 → 重写完成后自动停止提醒） */
  consecutive: number
}

const compactionStates = new Map<string, CompactionState>()

/** 测试/调试：查看超限提醒状态 */
export function compactionStateSnapshot(): ReadonlyMap<string, CompactionState> {
  return new Map(compactionStates)
}

/** 会话销毁/测试重置：清理路径缓存与超限计数（防 per-会话 Map 无界增长，review F-08 同族） */
export function forgetLogbookCompactionState(scope: string): void {
  mdPathCache.delete(scope)
  compactionStates.delete(scope)
}

/** 测试辅助：清空全部缓存（含 root 维度的阈值缓存） */
export function __resetLogbookCompactionForTest(): void {
  mdPathCache.clear()
  mdLimitCache.clear()
  compactionStates.clear()
}

/**
 * 解析**活跃** SESSION.md 绝对路径（缓存 60s）。
 *
 * 候选链（刻意比 rebuild 的完整链短——这里每个工具调用都要跑，贵候选不划算）：
 * ① `getActiveSessionInfo(scope).mdPath`（`cognitive_trajectory use` / 轨迹约束 绑定 / 重启恢复都会写）
 * ② `readLastBound(session).mdPath`（`.bindings.json` 权威绑定——重启后内存空时兜底）
 * 两者都拿不到 → null（**不猜**：宁可不提醒，也不去猜别的轨迹——对齐 v1.30.13 D4 的教训）。
 */
export function resolveActiveSessionMdPath(
  root: string,
  scope: string,
  session: unknown,
  now: () => number = Date.now,
): string | null {
  const t = now()
  const cached = mdPathCache.get(scope)
  if (cached && t - cached.at < MD_CACHE_TTL_MS) return cached.mdPath
  let candidate: string | null = null
  try {
    candidate = getActiveSessionInfo(scope)?.mdPath ?? null
  } catch {
    candidate = null
  }
  if (!candidate) {
    try {
      candidate = readLastBound(session as never)?.mdPath ?? null
    } catch {
      candidate = null
    }
  }
  let abs: string | null = null
  if (candidate) {
    const p = candidate.startsWith(root) ? candidate : resolve(root, candidate)
    abs = existsSync(p) ? p : null
  }
  mdPathCache.set(scope, { mdPath: abs, at: t })
  return abs
}

/** 读文件字节数（读不到 → null，不抛错） */
export function readFileSize(absPath: string): number | null {
  try {
    return statSync(absPath).size
  } catch {
    return null
  }
}

/** 读该 CCC 的 SESSION.md 体积上限（KB；缓存 60s；0 = 关闭提醒） */
export function readSessionMdMaxKB(root: string, configPaths?: string[], now: () => number = Date.now): number {
  const t = now()
  const cached = mdLimitCache.get(root)
  if (cached && t - cached.at < MD_CACHE_TTL_MS) return cached.limitKB
  let limitKB = DEFAULT_SESSION_MD_MAX_KB
  try {
    const configured = loadSerenityConfig(root, configPaths).sessionKeeper?.sessionMdMaxKB
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) limitKB = configured
  } catch {
    /* 配置读不到 → 缺省值 */
  }
  mdLimitCache.set(root, { limitKB, at: t })
  return limitKB
}

/**
 * LOGBOOK COMPACTION 提醒文案（v1.31.1；🔴 **v1.84.0 文案改版**）。
 *
 * 归属（D23）：**ACC 内嵌机制事实 + 动作判据**——理由：判据是认知质量规范（与 EAP 同层，
 * 不是会随角色迭代的措辞），且未配置任何 CCC 文档的容器也要立刻可用。
 *
 * 🔴 **v1.84.0（owner 2026-10-21 令）**：文案从「4 条重写原则」换成
 * **「按 EAP 重构整个 SESSION.md」**（owner 选 B 案）。新文案的判据直接取 EAP 的三个变量：
 * · **E↑** 变量／边界／有向关系全部显式；
 * · **R↓** 带理由与被否项（下一个自我重建**推理**而非只有结论），并把长证据链外移到
 *   `AGENT_SESSIONS/<会话>/references/*.md`、在 SESSION.md 里留链接；
 * · **S↑** 结构每次都能同样地重建，而不是时间流水账。
 * ⚠️ **另两句是硬约束，不许删**（各自理由见函数体内的注释）：
 * ① `The fixed sections are a contract with the harness: keep their order and headings, …`
 *    —— 与系统提示词的 `Fixed sections, in this order: …` 对齐，「重构」不含契约骨架；
 * ② `frontmatterGuard` —— 唯一防住"skill 声明被抹掉"的东西。
 */
export function cognitiveTrajectoryCompactionReminderText(input: {
  sizeKB: number
  limitKB: number
  mdPath: string
  escalated?: boolean
}): string {
  const { sizeKB, limitKB, mdPath, escalated = false } = input
  const facts = `SESSION.md is ${sizeKB} KB (limit ${limitKB} KB): ${mdPath}`
  // 🔴 **2026-10-21（owner 令）**：原「4 条重写原则」（keep the EAP layered skeleton ／ move detail out ／
  //    merge or drop ／ full discretion）整段被**按 EAP 重构整个 SESSION.md** 取代。
  //    新文案（owner 选 B 案）把动作词从 `rewrite` 改成 `refactor … end to end under EAP`，
  //    并把三条具体细则换成 EAP 的三个**变量**（E↑ ／ R↓ ／ S↑）——判据来源从"上一版的口诀"
  //    回到**理论本身**（`praxis eap`），模型不必依赖这段文字转述才能做对。
  //
  //    🔴 **两句必须一起留着，理由不同**：
  //    ① `keep their order and headings, rewrite everything inside them` —— 系统提示词每轮逐字要求
  //       `Fixed sections, in this order: 身份与边界 / 权威锚点 / …` 且 `keep its format & granularity fixed`。
  //       「重构整个」若不划这条线，模型可能连**契约骨架**一起重建 ⇒ 与注入面直接冲突。
  //       ⇒ 重构的是**内容**，不是**契约**。
  //    ② `move detail out … references/*.md` —— EAP **推不出**"外移到哪"（EAP 只说 R↓，不指定落点）。
  //       它是一条独立的操作指令，owner 2026-10-21 明确要求保留。
  const principles =
    'Load eap (praxis eap) first, then restructure it as a layered abstraction tree — do not merely shorten it. '
    + 'Sort its contents BY NATURE (this is the whole point of the load): '
    + '(1) process — attempts, dead ends, raw readings — belongs in ' + LOG_FILE_REL + '; '
    + '(2) evidence and designs — long evidence chains, research, reference material — belongs in '
    + 'AGENT_SESSIONS/<session>/references/ and is reached by a pointer from SESSION.md; '
    + '(3) judgement stays in the body — identity and boundaries, decisions with rationale and rejected options, '
    + 'milestones with evidence pointers, current state, pending rulings. '
    + 'Keep the fixed sections in this order — 身份与边界 / 权威锚点 / 工作纪律 / 决策 / 日志 / 当前状态 / 待 owner 裁决 '
    + '— and rewrite everything inside them.'
  // v1.34.1 护栏（规格 docs/cognitive-trajectory-skill-injection.md §4）：compaction 是**唯一会重写 SESSION.md** 的时刻，
  // 也正因此是 frontmatter（轨迹 skill 声明的唯一真相源）最可能被抹掉的时刻——在提醒里点名它。
  // 残余风险（记录在案）：护栏是**文案级**，不是机械强制；文案只此一处，两条提醒共用（防两处漂移）。
  const frontmatterGuard =
    'Keep the YAML frontmatter at the top of the file exactly as it is — it carries this cognitive trajectory\'s skill declarations.'
  if (escalated) {
    return `${eventToken('compaction')} ${facts} — you have been reminded repeatedly and have NOT compacted SESSION.md. This is now mandatory: STOP the current task step, load eap (praxis eap), refactor SESSION.md end to end, then resume. ${principles} ${frontmatterGuard} This reminder persists until the file is under the limit.`
  }
  return `${eventToken('compaction')} ${facts}. Pause the current work and compact this cognitive trajectory's log (SESSION.md) before continuing — that log is the persistent body of this cognitive trajectory, and its size is operational entropy (H_op) the container pays on every read. ${principles} ${frontmatterGuard} After rewriting, resume the paused work; this reminder stops once the file is under the limit.`
}

// ── 交界便签的体积提醒已于 2026-11-16 整块退役 ──
//
// 原 `rebuildTodoReminderText()` ＋ `DEFAULT_REBUILD_TODO_MAX_KB` ＋ 三个状态函数，
// 服务对象是**独立文件** `REBUILD-TODO.md`。owner 2026-11-16 裁定：便签改住
// `LOG/LOG.md` 的 `## Handover note` 节 ⇒ 它随之获得 **LOG 的机械轮转**（有界），
// 于是"另设一个 10 KB 软上限并提醒人去清理"成为第二套并行的熵管理 —— 删掉。
// 🔴 判据：**一个有硬轮转的东西，不需要再挂一个软提醒。**

// ── DSH 注册 ──

interface KeeperRegistration {
  /** 缺省阈值（serenity.json sessionKeeper.threshold 优先，其次此值） */
  defaultThreshold?: number
  /** CCC 配置相对路径 */
  configPaths?: string[]
}

/** 每 agent 一个跟踪器（进程内存态，agent token 维度） */
const trackers = new Map<string, KeeperTracker>()

/** v1.23.3 重建提醒状态：agentId → 连续超阈值累计轮数（进程内存态） */
interface RebuildReminderState {
  /** 连续超阈值未交接的累计轮数（达阈值 → 升级强制提醒） */
  consecutive: number
  /** 本呆机械选定的交接路径（⛔ 不进注入正文，只供诊断与测试观测） */
  path?: HandoverPath
}
/** 连续超阈值轮数达此值 → 升级为 [TRAJECTORY-ESCALATED] 强制语气（此后持续升级催，直到 rebuild） */
const REBUILD_ESCALATE_AFTER = 3
const rebuildReminderStates = new Map<string, RebuildReminderState>()

/** 测试/调试：查看重建提醒状态 */
export function rebuildReminderStateSnapshot(): ReadonlyMap<string, RebuildReminderState> {
  return new Map(rebuildReminderStates)
}

export function registerKeeper(ctx: Context, opts: KeeperRegistration = {}): void {
  const defaultThreshold = opts.defaultThreshold ?? 150

  const trackerFor = (exec: ToolExecution): KeeperTracker => {
    const key = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? 'global'
    let t = trackers.get(key)
    if (!t) {
      const root = cccRootForCwd(agentCwdFor(exec as { agent?: { session?: { header?: { cwd?: string } } } }))
      const threshold = root ? (loadSerenityConfig(root, opts.configPaths).sessionKeeper?.threshold ?? defaultThreshold) : defaultThreshold
      t = new KeeperTracker(threshold)
      trackers.set(key, t)
    }
    return t
  }

  // observe-and-enrich：先 next() 委托，再折叠提醒（block 决策也附加 context）。
  // v1.22.1 重构：**两个独立机制**——（🔴 **2026-09-22 起本缝为三个**，见 ③）
  // ① SESSION-KEEPER 计分提醒（DCP 确认码，阈值 150 缺省）
  // ② 轨迹跟踪器（Cognitive Trajectory Tracker）上下文压力检测：每次工具调用后独立检查
  //    contextPressure 投影，超 rebuildThresholdK（K 数值）追加 rebuild 提示——**不依赖计分达标**
  //    （此前嵌套在 shouldRemind 内 + inject 缺 sessionProjections → 永不触发）。
  // ③ 🆕 **用量统计**（owner 令 2026-09-22）= **纯观测**：把 `skill` / `msm` 两类调用记一笔到
  //    该 CCC 的 `_tmp/acc-usage.json`（逻辑在 `../surface/usage.ts`）。
  //    ⇒ 本缝的**决策**仍只有 ①②；**③ 一律忽略返回值、抛错被吞，绝不改变任何决策**。
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    if (!exec.agent) return next()
    // 激活门控：只在 .serenity 存在的 CCC 目录计分/提醒；其他目录零干预
    const cwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd ?? process.cwd()
    const root = cccRootForCwd(cwd)
    if (!root) return next()
    // 轨迹约束旁路：计分提醒按 `cognitiveTrajectory.keeper`、重建压力检测按
    // `cognitiveTrajectory.rebuild` 决定参与（**缺省全 true**）；非约束轨迹恒参与。
    const sessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
    const participatesKeeper = trajectoryConstraintParticipates(root, sessionId, 'keeper')
    const participatesRebuild = trajectoryConstraintParticipates(root, sessionId, 'rebuild')
    const tracker = trackerFor(exec)
    const shouldRemind = participatesKeeper ? tracker.step(exec.name) : false
    const downstream = await next()

    // ③ 用量统计（owner 令 2026-09-22）：`skill` 加载与 `msm` 执行各记一笔到该 CCC 的
    //    `_tmp/acc-usage.json`。🔴 **纯观测**：返回值一律忽略 —— 统计绝不改变本缝的任何决策。
    //    （`surface/usage.ts` 自身永不抛；此处再兜一层 try 是纵深防御：本缝每轮都跑，
    //    宁可少记一笔，也不能让统计打断会话。）
    try {
      recordToolUsage(root, exec.name, (exec as { arguments?: unknown }).arguments)
    } catch {
      /* 静默忽略（不打日志：本缝频度高，噪声会盖过信息） */
    }

    const blocks: ContentBlock[] = []

    // ① 计分达标 → SESSION-KEEPER 确认码提醒
    if (shouldRemind) {
      const code = tracker.ack()
      blocks.push({ type: 'text', text: reminderText(code) })
    }

    // ② **交接提醒**（⚠️ 2026-11-17 owner 定第一原则：**不打扰轨迹自身的节奏**）
    //
    // 🔴🔴 **只由上下文压力触发，累计量（`totalOver`）不是提醒触发源** —— 这是本轮修正的核心。
    //
    // 两个量治的不是同一件事，**触发权也不同**：
    //   · `contextPressure.projectedTokens` —— **当前** prompt 有多大。
    //     它会让**这一次请求**变贵/逼近上限 ⇒ **必须提醒**，且要模型去处理。
    //   · `tokenUsage.totals` 四桶累加     —— **跨轮累加**的用量。
    //     ⚠️ 它对"这一轮好不好过"**毫无影响**（原地清空也不会让它回落）。
    //     ⇒ **拿它去催模型，就是打扰轨迹自己的节奏**：模型正干到一半，却被一个
    //       与当下无关的累计数叫停。owner 明令：交给模型按自己节奏决定何时交接。
    //
    // ⇒ 累计量的唯一用武之地在**机械接手那一侧**：模型一旦调了 `rebuild`，
    //   `tools/cognitive-trajectory.ts` 的 `case 'rebuild'` 会按它分流
    //   （不到 1000M ⇒ rebuild；超过 ⇒ reconstruct）。**提醒与分流各管一段，不重叠。**
    if (participatesRebuild) {
      const session = (exec as { agent?: { session?: unknown } }).agent?.session
      if (session) {
        const thresholdK = readSimpleSettings().rebuildThresholdK
        const pressure = readContextPressure(ctx, session)
        const contextOver = pressure !== null && pressure.projectedTokens > 0
          && pressure.projectedTokens >= thresholdK * 1000
        if (contextOver) {
          const key = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? 'global'
          const st = rebuildReminderStates.get(key) ?? { consecutive: 0 }
          st.consecutive += 1
          rebuildReminderStates.set(key, st)
          // 🔴 选路只**记录**（诊断/测试可观测），⛔ 不进注入正文：
          //    提醒只指名 `rebuild`，走哪条路由机械层决定，模型不需要知道。
          let totalOver = false
          try {
            totalOver = shouldOfferReconstruct(ctx, session)
          } catch {
            /* 判据异常不得打断本缝；工具可见性那条 `when` 会独立再判一次 */
          }
          st.path = selectHandoverPath({ contextOver, totalOver }) ?? undefined
          blocks.push({
            type: 'text',
            text: handoverReminderText(st.consecutive >= REBUILD_ESCALATE_AFTER),
          })
        } else {
          // 上下文回到阈值内 → 清零，提醒自动停止
          const key = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? 'global'
          rebuildReminderStates.delete(key)
        }
      }
    }

    // ③ SESSION.md 体积检查（v1.31.1，S142 用户需求）：活跃轨迹工作台超限 → 提示暂停重写。
    // 独立于①②（与上下文压力无关——rebuild 只换载体，不会让 SESSION.md 变小）。
    // 门控按角色 cognitiveTrajectory.session（工作台参与项），非 轨迹约束会话恒参与。
    if (trajectoryConstraintParticipates(root, sessionId, 'session')) {
      const limitKB = readSessionMdMaxKB(root, opts.configPaths)
      if (limitKB > 0) {
        const scope = sessionId ?? 'global'
        const session = (exec as { agent?: { session?: unknown } }).agent?.session
        const mdPath = resolveActiveSessionMdPath(root, scope, session)
        const size = mdPath ? readFileSize(mdPath) : null
        if (mdPath && size !== null && size > limitKB * 1024) {
          const st = compactionStates.get(scope) ?? { consecutive: 0 }
          st.consecutive += 1
          blocks.push({
            type: 'text',
            text: cognitiveTrajectoryCompactionReminderText({
              sizeKB: Math.round(size / 1024),
              limitKB,
              mdPath,
              escalated: st.consecutive >= COMPACTION_ESCALATE_AFTER,
            }),
          })
          compactionStates.set(scope, st)
        } else {
          // 文件已回到限内（重写完成）→ 清零，提醒自动停止
          compactionStates.delete(scope)
        }
      }
    }

    // ④ 交界便签体积检查 —— **已于 2026-11-16 整块退役**。
    //    便签改住 `LOG/LOG.md` 的 `## Handover note` 节 ⇒ 它随之获得 LOG 的**机械轮转**（有界）。
    //    ⛔ 别再挂第二个"软上限 + 提醒清理"：一个有硬轮转的东西不需要软提醒。

    if (blocks.length === 0) return downstream
    // 🔴 **DII M2 · 注入点 #2**（2026-11-04）：改走声明层。
    //    ⚠️⚠️ **本处是最危险的一处**（失败面清单 #5）：它**必须仍然不唤醒**。
    //    判据不靠自觉：`delivery:'this-step'` 这一档在 `deliver()` 里**显式抛错**
    //    （它走 `additionalContexts` 返回，不是调 agent 方法）⇒ 谁想改成 `'wake-now'`
    //    都接不上，必须同时动别处，**无法静默发生**。
    //    🔴 `blocks` 是**多条提醒各自的块**（CHECKPOINT / REBUILD / SESSION 体积各一），
    //      刻意**保持块数与顺序不变** —— 若 join 成一块，模型看到的是"一个含换行的大块"，
    //      那是**形态变更**。故走 `blocks` 字段而非拼接正文。
    const blockTexts = blocks.map((b) => (b as { text?: string }).text ?? '')
    const reminderAll = toMessage(
      makeInjection({
        origin: 'acc',
        form: 'notice',
        // summary 是宿主 notice 形态的**构成要件**；只报"几条"，不重复正文。
        summary: `keeper 提醒 ${blocks.length} 条`,
        text: blockTexts.join('\n'),
        blocks: blockTexts,
        delivery: 'this-step',
      }),
    )

    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [reminderAll, ...(downstream.additionalContexts ?? [])],
      }
    }
    return {
      ...downstream,
      additionalContexts: [reminderAll, ...(downstream.additionalContexts ?? [])],
    }
  })
}
