/**
 * trajectory/session.ts — 轨迹的**会话（载体）管理**（**2026-10-19 重做**：轨迹约束 = 带 `trajectory-constraint.json` 的认知轨迹）
 *
 * ## 与旧版的根本差别（R↓，这是那次重做的全部内容）
 *
 * 旧版：轨迹约束是**一个角色**（`serenity.json` 的 `轨迹约束.roles.<name>`），会话身份由
 * dsh sessionId 前缀 `轨迹约束-` 判定，工作台由 `ensureTrajectorySession` **另建一个 SESSION**。
 *
 * 新版：轨迹约束是**一条认知轨迹**（目录里有 `trajectory-constraint.json`）——
 * · **身份 = 轨迹编码**（不是角色名，不是 sessionId 前缀）；
 * · **工作台 = 该轨迹自己的 SESSION.md**（不再另建，`ensureTrajectorySession` 已删除）；
 * · **判据 = 绑定的轨迹有没有 `trajectory-constraint.json`**（唯一入口 `policy/profile.ts` 的 `trajectoryConstraintForSession`）。
 *
 * ⇒ 删掉的东西（它们只是旧模型的补丁，不是通用机制）：
 * `SKIFF_SESSION_PREFIX` 判定 ／ `ensureTrajectorySession` 自动建工作台 ／
 * `kind: temporary|persistent` ／ 换代计数器（`im/route.ts` 的 `.weixin-session-gen.json`）。
 *
 * ## 本文件仍负责
 * agent 创建/复用（resume-or-create）／系统提示词段注册／提问与等本轮回答／守门查询。
 *
 * ## S13（2026-10-19，轨迹中心重构）：此前位于 `role/轨迹约束/` 下（该目录已随本重构消失）
 *
 * 文件名从 `core` 改为 `session`：它管的是**轨迹的会话（载体）**——
 * 与同目录 `live.ts`（活载体查询）／`rebuild.ts`（换船板）／`cleanup.ts`（清理）同族。
 * `core` 描述的是"它在角色目录里居中"，而那层含义随目录一起消失了。
 *
 * 🔴 **不拆**（S13 判据）：26 KB 未过 30 KB 阈值 ⇒ 按计划 R-d 的候选 ②，
 * 本期是**零语义改动**，拆函数体属另一件事。
 */

import type { Context } from 'cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  constraintCognitiveTrajectory,
  profileMsmWhitelist,
  profileToolWhitelist,
  buildTrajectoryBasePrompt,
  resolveConstraintSystemPrompt,
  createProfilePromptReader,
} from './policy/rules.js'
import { readTrajectoryConstraintAt, readTrajectoryConstraintByCode, trajectoryConstraintForSession, findDirNameByCode, type TrajectoryConstraint } from './policy/profile.js'
import {
  registerTrajectorySession as registryRegister,
  unregisterTrajectorySession as registryUnregister,
  trajectoryDirNameForSession as registryTrajectoryDirName,
  trajectorySessionInfo as registrySessionInfo,
  trajectorySessionSnapshot as registrySnapshot,
} from './policy/window.js'
import { sessionsRoot } from './core.js'
import { hasTrajectoryPrompt } from './prompt.js'
import { hostAgents, hostAgentDefaultModel } from '../host/access.js'
import { waitAgentIdle } from './carrier.js'
import { registerCognitiveTrajectorySkillSection } from '../seams/system-prompt.js'
import { toMessage, makeInjection, deliver } from '../kernel/injection.js'

export type { TrajectoryConstraint }

// ── 会话注册表（sessionId → 轨迹目录名 ＋ CCC；见 registry.ts 的 R↓）──

const trajectoryAgents = new Map<string, Agent>()

/** 查 sessionId 承载的轨迹目录名（无 → null） */
export function trajectoryDirNameForSession(sessionId: string): string | null {
  return registryTrajectoryDirName(sessionId)
}

/** 查 sessionId 的会话绑定（轨迹 ＋ ccc；无 → null）——追问校验 */
export function trajectorySessionInfo(sessionId: string): { trajectoryDirName: string; ccc: string } | null {
  return registrySessionInfo(sessionId)
}

/** 查 sessionId 的活体 agent（进程内会话延续用；未注册/已清理 → undefined） */
export function getTrajectoryAgent(sessionId: string): Agent | undefined {
  return trajectoryAgents.get(sessionId)
}

/** 该会话当前绑定的 轨迹约束面（不是 轨迹约束 → null）。**守门与提示词的唯一查询入口。** */
export function trajectoryConstraintFor(root: string, sessionId: string | undefined): TrajectoryConstraint | null {
  if (sessionId === undefined) return null
  return trajectoryConstraintForSession(root, sessionId, registryTrajectoryDirName(sessionId))
}

export function registerTrajectorySession(sessionId: string, trajectoryDirName: string, ccc: string, agent: Agent): void {
  trajectoryAgents.set(sessionId, agent)
  registryRegister(sessionId, trajectoryDirName, ccc)
}

export function unregisterTrajectorySession(sessionId: string): void {
  trajectoryAgents.delete(sessionId)
  registryUnregister(sessionId)
}

/** 测试/调试：注册表快照 */
export function trajectorySessionSnapshot(): ReadonlyMap<string, { trajectoryDirName: string; ccc: string }> {
  return new Map(registrySnapshot())
}

// ── 工作台（= 该轨迹自己的 SESSION.md，不再另建）──

/**
 * 该 轨迹约束会话的**工作台路径** = 它自己轨迹的 SESSION.md。
 *
 * 🔴 与旧版的差别：旧版会在这里**自动新建**一个 SESSION（`ensureTrajectorySession`）；
 * 新版**没有新建这个动作** —— 轨迹就是工作台，`trajectory-constraint.json` 与 `SESSION.md` 同处一个目录。
 * ⇒ 语义变成纯粹的"查询：我自己的身体在哪"。
 *
 * @returns SESSION.md 绝对路径；不是 轨迹约束 / 文件不在 → null
 */
export function trajectoryWorkspaceMdPath(root: string, sessionId: string | undefined): string | null {
  if (sessionId === undefined) return null
  const dirName = registryTrajectoryDirName(sessionId)
  if (dirName === null) return null
  const md = join(sessionsRoot(root), dirName, 'SESSION.md')
  return existsSync(md) ? md : null
}

/**
 * 系统提示词中的**工作台纪律块**（S142 用户：只给路径 LLM 不会主动用）。
 *
 * SESSION = 工作台 —— 轨迹约束与主舱同一套机制（**零特调**，用户拍板）：
 * SESSION.md 是持久记忆载体、rebuild 自动从本 SESSION 续接。
 * 注入 agent 系统提示词（用户对话面不可见）。
 *
 * v1.30.13（S142 诊断 D5）：写入纪律**不点名具体工具** —— 旧文案写死 "with write/edit"，
 * 而某个 轨迹约束的工具白名单里根本没有 write/edit ⇒ 指令指向它没有的工具
 * （注入纪律与能力面矛盾，模型只能猜）。现文案改为「用本轨迹被授权的写入通道」。
 */
export function workspaceCognitiveTrajectoryLine(mdPath: string): string {
  return [
    '── Serenity Session Workspace ──',
    'You ARE a cognitive trajectory: this workspace SESSION is your own persistent body.',
    `  SESSION.md: ${mdPath}`,
    '',
    'Rules of the workspace:',
    '  1. This SESSION.md is your persistent memory carrier (like the main cabin SESSION) — ',
    '     read it first when context feels thin or work spans turns.',
    '  2. Record key decisions/progress/unresolved items INTO this SESSION.md using the write channel',
    '     your trajectory is actually granted (use whatever write tool or MSM you have — never assume',
    '     a specific write tool exists; if none is granted, report that instead of pretending to write).',
    '     Sections: 身份与边界 / 权威锚点 / 工作纪律 / 决策 / 日志 / 当前状态 / 待 owner 裁决.',
    '     Keep entries at milestone level (one line + evidence pointer); execution detail',
    '     belongs in commit messages. Keep it current — it is what a rebuild resumes from.',
    '  3. When context pressure is high, run cognitive_trajectory rebuild — it auto-resumes from THIS SESSION.md.',
    '  4. Never expose this internal path in user-facing replies (chat stays clean).',
    '── ──',
  ].join('\n')
}

/** 已挂工作台提示词段的 agent（幂等：同一 agent 只注册一次，避免 duplicate section） */
const workspaceSectionAgents = new WeakSet<object>()

/** systemPrompt.section 的最小结构（宿主成员，不可假定存在） */
interface SectionCapable {
  systemPrompt?: { section?: (section: { name: string; order?: number; text: () => string }) => unknown }
}

/**
 * 把**工作台纪律块**挂到 agent 的系统提示词段（单一注入点）。
 *
 * 用户原话（S142，2026-09-08）："微信桥的注入机制，每个用户消息都会注入，轨迹约束本身也会注入，
 * 这样就重复，能否微信桥情况下，注入内容直接取 轨迹约束的，这样不用配两遍"。
 *
 * 现形态：工作台行**只**经本函数挂系统提示词段（name `serenity-轨迹约束-workspace`，
 * 动态 `text()` 每轮按 scope 读当前活跃 mdPath）。
 *
 * @returns true = 段已在位；false = 该 agent 挂不上（调用方降级为 question 前缀注入）
 */
export function ensureWorkspacePromptSection(agent: Agent, scope: string, root: string): boolean {
  if (!agent || typeof agent !== 'object') return false
  if (workspaceSectionAgents.has(agent)) return true
  const api = (agent.ctx as SectionCapable | undefined)?.systemPrompt
  if (typeof api?.section !== 'function') return false
  try {
    api.section({
      name: 'serenity-轨迹约束-workspace',
      // 排在基础段（serenity-轨迹约束，-60）之后、CCC 提示词段之前
      order: -55,
      text: () => {
        const mdPath = trajectoryWorkspaceMdPath(root, scope)
        return mdPath ? workspaceCognitiveTrajectoryLine(mdPath) : ''
      },
    })
    workspaceSectionAgents.add(agent)
    return true
  } catch (err) {
    console.warn(`[serenity-hooks] 轨迹约束 工作台提示词段注册失败（回退 question 注入）: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

// ── agent 生命周期 ──

interface TrajectoryAgentRef {
  handle: AgentHandle
  agent: Agent
  sessionId: string
  /** true = 从持久化恢复既有会话（历史延续，非新对话）；false = 新建 */
  resumed: boolean
}

/** 轨迹约束 agent 挂载的 DSH preset（平台工具面由 preset 决定；白名单再按轨迹过滤） */
const TRAJECTORY_PRESET = 'standard'

/**
 * 解析「这条轨迹的载体该用哪个模型」—— **不能只返回 `''`**（v1.105.0，P0 回归修复）。
 *
 * ## 上一版错在哪（v1.102.0 → v1.104.0 之间的真实故障）
 *
 * v1.102.0 我删掉了「未声明 model ⇒ 回落到全局默认模型」这条回落，理由是它会让轨迹
 * **静默跑在别人的模型上**（真机实证：两条 IM 路由都没声明 model，却跑在 minimax 上）。
 * 修法写成「没声明 ⇒ 不传 `agentOptions` ⇒ 交给宿主」。
 *
 * 🔴 **「不传」不等于「安全」** —— 这是当时的判断错误：
 *   宿主 `system-prompt` 的 persona 模板是 `You are a coding agent powered by the {{model}} model.`
 *   （`dsh-web-app/cordis.patch.yml` 逐字），而 `{{model}}` 是 **`agent.options.model`**
 *   （`dsh-agent-loop/lib/index.js:1592`）；
 *   **插值是严格的** —— `dsh-system-prompt/lib/index.js:177`：
 *     `if (value === void 0) throw new Error('prompt variable "{{model}}" has no value for this assembly')`
 *   ⇒ `agent.options.model === undefined` ⇒ **每一轮装配都抛错 ⇒ 该轨迹完全不可用**。
 *
 * 我当时只验了"`agents.create` 不传 `agentOptions` 是合法的"，
 * **没验下游有没有人要求这个值必须存在**（D256 同族：删之前先核谁在依赖）。
 *
 * ## 正确修法 = 回落到**宿主权威的默认值**，而不是回落到我们自己的某个配置
 *
 * 宿主契约逐字（`dsh-agent-default-model/lib/types/index.d.ts`）：
 *   *"Default model selection for Agents created **without an explicit model**."*
 * ⇒ 这正是「没指定时该用什么」的**权威出处** —— 拿它显式传下去，不是另造一份真相源
 * （这与 v1.58.1 修 ACP 面同一个报错时的做法一致：`resolveAcpSelection()`）。
 *
 * 与旧回落的关键区别（这是本次判断成立的依据）：
 *   · 旧回落读的是 **CCC 里某个工具段的配置**（`cheap-worker.defaultModel`）—— 那是**我们的**猜测，
 *     而且读的是**已退役**的段；
 *   · 新回落读的是 **宿主自己承认的默认** —— 用户在界面换模型它跟着变，**不是第二个真相源**。
 *
 * @returns `provider/model` 串；拿不到宿主默认时返回 `''`（此时仍不传 agentOptions —— 那种宿主
 *          自己也没有默认模型，结果是宿主自己的问题，不该由我们编一个值出来）。
 */
function resolveAgentModel(ctx: Context, profile: TrajectoryConstraint): string {
  const declared = profile.model?.trim()
  if (declared) return declared
  // 未声明 ⇒ 问宿主「没指定时该用什么」。服务可选（不在 inject 里）⇒ 缺失时返回 undefined。
  try {
    const sel = hostAgentDefaultModel(ctx)?.currentSelection?.()
    const provider = typeof sel?.provider === 'string' ? sel.provider.trim() : ''
    const model = typeof sel?.model === 'string' ? sel.model.trim() : ''
    if (provider && model) return `${provider}/${model}`
  } catch {
    /* 读取失败 ⇒ 落到下面的 ''（不阻断创建；缺 model 的后果由宿主响亮报出） */
  }
  return ''
}

/**
 * 创建（或复用）一个 轨迹约束会话。
 *
 * **固定 sessionId 的 resume-or-create**（v1.27.2）：指定 sessionId 且磁盘已有持久化 log →
 * `ctx.agents.resume`（DSH 持久化语义：sessionId 即身份，历史 + turn 续号延续）；
 * 无 log（首次）→ `ctx.agents.create`。不指定 → 随机 id 恒 create（调试页路径）。
 *
 * @param profile 该 轨迹约束的约束面（来自 `trajectory-constraint.json`）
 * @param sessionId 指定会话 id（可选；微信桥等外部面用固定 id 实现"轨迹 ↔ 会话"长期映射）
 */
export async function createTrajectoryAgent(
  ctx: Context,
  root: string,
  profile: TrajectoryConstraint,
  sessionId?: string,
): Promise<TrajectoryAgentRef> {
  if (!ctx.agents) throw new Error('trajectory constraint: ctx.agents unavailable')
  // 🔴 **判据（v1.105.0）：载体必须拿到一个「非空」的模型。**
  //    来源优先级：① 轨迹自己声明的 `model` ② **宿主承认的默认模型**（`agentDefaultModel`）。
  //    ⛔ 绝不回落到「CCC 里某个工具段的配置」（v1.102.0 已删，那是第二真相源）；
  //    ⛔ 也绝不"什么都不传"（v1.102.0 的错误：宿主 persona 模板要 `{{model}}`，缺失即整轮失败）。
  //    完整根因与宿主出处见 `resolveAgentModel` 的 docstring。
  const model = resolveAgentModel(ctx, profile)
  const id = (sessionId ?? `轨迹约束-${profile.code}-${randomUUID()}`) as SessionId
  const setup = async (agentCtx: Context) => {
    try {
      // 挂载 standard preset → agent 工具面含 read/grep/glob/web_search 等平台工具；
      // agentPresets 可选服务缺失（未装配）→ 跳过（回退全局工具层，不阻断创建）
      const presets = agentCtx.get('agentPresets') as { mount?: (c: Context, id: string) => Promise<unknown> } | undefined
      await presets?.mount?.(agentCtx, TRAJECTORY_PRESET)
    } catch {
      /* preset 挂载失败不影响 agent 创建（白名单仍兜底约束） */
    }
  }
  const handle = await createOrResumeAgent(ctx, id, root, model, setup, sessionId !== undefined)
  const agent = handle.agent
  // 🔴 响亮而非静默（v1.105.0）：两个来源都空 ⇒ 载体**注定**在第一次装配时炸，而报出来的是
  //    宿主那句 `prompt variable "{{model}}" has no value` —— **它指不到根因**（看上去像宿主的 bug）。
  //    ⇒ 在**我们的**这一层先把真因说清楚：谁没给、我们试过什么、后果是什么。
  if (model === '') {
    console.warn(
      `[serenity-hooks] ✗ 轨迹「${profile.code}」的载体没有可用模型：`
      + `trajectory.json 未声明 model，宿主 agentDefaultModel 也取不到选择`
      + `（服务缺失或 currentSelection() 返回空）⇒ 该轨迹每一轮都会以 `
      + `prompt variable "{{model}}" has no value 失败。`
      + ` 修法：在 trajectory.json 里给这条轨迹写一个 model（provider/model），`
      + `或修好宿主 agent-default-model 那一行的配置。`,
    )
  }
  // scoped 系统提示词：基础段（动态发现路径）+ CCC 的提示词段。
  //
  // 🔴 热生效的**唯一判据 = 每次求值都重读配置**（owner 2026-10-19 令「工具清单也要热加载」）。
  //   两个事实：① 本 `text()` **每轮都被调用**；② 但 `profile` 是入参 = **创建时的快照**
  //   ⇒ 旧版即使每轮重算，算的也是冻结对象 ⇒ CCC 改了配置必须重启才生效。
  //   ⇒ 现在每轮按 `profile.path` 重读 `trajectory-constraint.json`；读不到（文件被删）就退回创建时那份。
  //   ⚠️ 提示词**文件**另有它自己的热重载（createProfilePromptReader 按 mtime+size），
  //   但那份 reader 是用创建时的 profile 造的 ⇒ `systemPromptFile` 路径本身变了不生效
  //   ⇒ 这里按路径缓存 reader：路径不变就复用（保住 mtime 缓存），变了重建。
  let readerPath: string | undefined = profile.systemPromptFile?.trim()
  let reader = createProfilePromptReader(root, profile)
  const livePrompt = (): string => {
    let live = profile
    try {
      const fresh = readTrajectoryConstraintAt(join(sessionsRoot(root), profile.dirName), root)
      if (fresh) live = fresh
    } catch {
      /* 配置读取失败 ⇒ 沿用创建时那份（不阻断本轮） */
    }
    const wantPath = live.systemPromptFile?.trim()
    if (wantPath !== readerPath) {
      reader = createProfilePromptReader(root, live)
      readerPath = wantPath
    }
    return reader()
  }
  // 首次求值（文件缺失/逃逸在创建时即告警；reader 内部对失败已降级为上次成功内容）
  void livePrompt()
  try {
    agent.ctx.systemPrompt.section({
      name: 'serenity-轨迹约束',
      order: -60,
      // 🔴 **T2（2026-10-19）：本段不再"立人格"，只剩两件窄事** ——
      //   ① 基础段 `buildTrajectoryBasePrompt`：**身份边界与能力发现路径**（"这是你，不是你演的角色"、
      //      "能力面由机制强制、按 schema 与 msm() 目录现取"）；
      //   ② **兼容期**：旧 `trajectory-constraint.json` 的 `systemPromptFile` 正文。
      //
      // 为什么②还留着：存量 CCC 的章程仍写在 `.opencode/skiff/<name>.md`，
      // 不迁也能继续工作 —— **不静默坏**。
      // 新形态是轨迹目录里的 `PROMPT.md`（`trajectory/prompt.ts`），由主装配的第 ⑧ 段注入。
      //
      // ⚠️ **两者同时存在时**：`PROMPT.md` 走第 ⑧ 段、`systemPromptFile` 走本段，
      //    会出现两份章程。⇒ 若该轨迹已有 `PROMPT.md`，本段的②**让位**（`livePrompt()` 返回空），
      //    判据由 `hasTrajectoryPrompt()` 给出（单一判据，不在这里自己拼路径）。
      text: () => {
        const legacy = hasTrajectoryPrompt(root, profile.dirName) ? '' : livePrompt()
        return [buildTrajectoryBasePrompt(profile.code), legacy].filter(Boolean).join('\n')
      },
    })
  } catch (err) {
    console.warn(`[serenity-hooks] 轨迹约束 系统提示词注册失败: ${String((err as Error)?.message ?? err)}`)
  }
  // CCC 级 `cognitiveTrajectory.skills` 与轨迹级 frontmatter 声明，同样送到 轨迹约束会话。
  //
  // 为什么这不与"轨迹约束旁路 ACC 身份注入"矛盾（R↓）：旁路掉的是**ACC 身份与纪律**
  // （轨迹约束 用 CCC 自己的提示词立人格）；而 skill 供给是**工作资料**（"这件事按哪套方法做"），
  // 与人格无关 ⇒ 照给。判据是「旁路的是谁的身份」，不是「凡是 ACC 的 section 都旁路」。
  if (agent?.session) {
    try {
      registerCognitiveTrajectorySkillSection(agent, root)
    } catch (err) {
      console.warn(`[serenity-hooks] 轨迹约束轨迹 skill 注入注册失败（不影响 agent 创建）: ${String((err as Error)?.message ?? err)}`)
    }
  }
  // 工作台纪律块**只**经 ensureWorkspacePromptSection 挂（单一注入点）
  if (trajectoryWorkspaceMdPath(root, id) !== null) ensureWorkspacePromptSection(agent, id, root)
  registerTrajectorySession(id, profile.dirName, root, agent)
  return { handle, agent, sessionId: id, resumed: handle.resumed }
}

/** 取 live agent（DSH 文档：`ctx.agents.get(id)` 返回 bare Agent；会话 live 时 resume/create 均不可用） */
function getLiveAgent(ctx: Context, id: string): Agent | undefined {
  try {
    return hostAgents(ctx)?.get?.(id) as Agent | undefined
  } catch {
    return undefined
  }
}

/** live 复用返回（resumed:true 历史延续；dispose 空操作——live agent 不归本模块所有，不能拆） */
function liveReuseRef(live: Agent, setup: (agentCtx: Context) => Promise<void>): Promise<AgentHandle & { resumed: boolean }> {
  // 重挂 standard preset：恢复后 agent 上下文重建，平台工具面（read/grep/glob 等）可能缺失；
  // setup 内部已吞错——已挂载则无害，服务缺失则跳过
  return setup(live.ctx).catch(() => {}).then(() => ({ agent: live, dispose: async () => {}, resumed: true }))
}

/**
 * resume-or-create 分派：固定 id → 优先 resume（持久化历史延续），失败降级 create；
 * 随机 id（无固定 sessionId）→ 恒 create。
 *
 * **v1.27.3 修复（微信桥"重启后不响应"根因）：live 会话优先复用**——重启后 DSH 把
 * 关闭时仍 live 的持久化会话恢复为 live。此时 resume 报
 * "cannot prepare session X while it is live"、create 报 "session X already exists"
 * ⇒ 唯一可行路径 = `ctx.agents.get(id)` 取 live agent 直接续用。
 */
async function createOrResumeAgent(
  ctx: Context,
  id: SessionId,
  root: string,
  model: string,
  setup: (agentCtx: Context) => Promise<void>,
  fixedId: boolean,
): Promise<AgentHandle & { resumed: boolean }> {
  if (!fixedId) {
    return {
      ...await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, agentPreset: TRAJECTORY_PRESET },
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: false,
    }
  }
  const liveAgent = getLiveAgent(ctx, id)
  if (liveAgent) {
    return liveReuseRef(liveAgent, setup)
  }
  // resume 可用性守卫：旧版 dsh / 测试环境无 resume 方法 → 直接 create
  const agentsWithResume = ctx.agents as { resume?: (o: { resumeSessionId: SessionId; setup?: (c: Context) => Promise<void>; agentOptions?: unknown }) => Promise<AgentHandle> }
  if (typeof agentsWithResume.resume !== 'function') {
    return {
      ...await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, agentPreset: TRAJECTORY_PRESET },
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: false,
    }
  }
  try {
    // 方法调用（this = ctx.agents）——⛔ 不要解构！DSH 的 resume 内部用 `this.ctx`。
    return {
      ...await agentsWithResume.resume({
        resumeSessionId: id,
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: true,
    }
  } catch (err) {
    // 竞态兜底：live 检查与 resume 之间会话可能变 live（多消息并发）→ 复用 live agent
    const liveNow = getLiveAgent(ctx, id)
    if (liveNow) {
      return liveReuseRef(liveNow, setup)
    }
    // v1.27.2 用户拍板：**resume 失败一律降级新建**（透传会让桥静默"不唤醒"）+ 打印堆栈定位
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? '') : ''
    console.log(`[serenity-hooks] 轨迹约束 resume 失败降级 create (id=${id}): ${msg}`)
    if (stack) console.log(`[serenity-hooks] 轨迹约束 resume stack:\n${stack.slice(0, 1200)}`)
    return {
      ...await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, agentPreset: TRAJECTORY_PRESET },
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: false,
    }
  }
}

/** `provider/model` → agentOptions（由 `model-string.ts` 提供，保持单一实现） */
import { splitModel } from './model-string.js'

// ── 提问（followup → 等本轮回答）──

interface TrajectoryAskResult {
  answer: string
  sessionId: string
}

/** 会话事件读取（兼容 `snapshotEvents()` 与测试替身的 `.events`） */
function sessionEvents(session: unknown): readonly unknown[] {
  const s = session as { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] }
  if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
  return s.events ?? []
}

/** 读会话最后一个 assistant/message 文本 */
function lastAssistantText(agent: Agent): string {
  const events = sessionEvents(agent.session)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { message?: { content?: unknown }; content?: unknown } } | undefined
    if (e && e.type === 'assistant/message') {
      const blocks = (e.data?.message?.content ?? e.data?.content ?? []) as Array<{ type?: string; text?: string }>
      const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
      if (text) return text
    }
  }
  return ''
}

/** 本轮等待上限（毫秒）：超时即判「本轮无产出」——**绝不**把上一轮的旧答案当本轮答案 */
const ASK_TURN_TIMEOUT_MS = 180_000

/** 会话里 `assistant/message` 的条数（判「本轮是否真的产出了回答」） */
function countAssistantMessages(session: unknown): number {
  let n = 0
  for (const e of sessionEvents(session)) {
    if ((e as { type?: string } | undefined)?.type === 'assistant/message') n += 1
  }
  return n
}

/**
 * 会话当前轮号（最后一个 `turn/start` 的 `turn`；取不到 ⇒ `null`）。
 *
 * 🔴 为什么需要它（2026-10-21，"同一条消息被处理两轮"的第二处缺陷）：
 * 判"本轮是否产出"用的是 **`assistant/message` 条数增长**。而在**并发入站**下，
 * 后一条的快照里，**前一条那一轮**还在继续产出 assistant 消息 ⇒ 计数照样增长
 * ⇒ 后一条会把**别人那一轮的文本**当成自己的答案（真机实测：兜底把内部过程话发给了家人）。
 * ⇒ 增长必须限定在「**这一轮开始之后**新出现的事件」里。
 */
function currentTurnOfSession(session: unknown): number | null {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: unknown; data?: { turn?: unknown } } | undefined
    if (e?.type === 'turn/start') {
      const t = e.data?.turn
      return typeof t === 'number' && Number.isFinite(t) ? t : null
    }
  }
  return null
}

/**
 * 会话快照：**调用那一刻**的（轮号, assistant 条数, 事件条数）。
 *
 * 三个值一起记，是因为判"增长"要能回答两个问题：
 * ① 有没有新的 assistant 消息？（条数）
 * ② 那些新消息是不是**我这一轮**产的？（轮号 ＋ 只看快照之后的事件）
 */
interface SessionSnapshot {
  turn: number | null
  assistantCount: number
  eventCount: number
}

function snapshotSession(session: unknown): SessionSnapshot {
  return {
    turn: currentTurnOfSession(session),
    assistantCount: countAssistantMessages(session),
    eventCount: sessionEvents(session).length,
  }
}

/**
 * **本轮**（快照之后）是否产出了 assistant 消息。
 *
 * 判据顺序（每一条都是被真账打出来的）：
 * ① 只数**快照之后**新增的事件 ⇒ 前一轮续跑的产出**不进账**（2026-10-21）；
 * ② 若快照时的轮号已知，且现在的轮号变了 ⇒ 那是**别的轮**在产出 ⇒ 不算我的；
 * ③ 条数确实增长 ⇒ 成功。
 */
function grewWithFreshAssistant(session: unknown, snap: SessionSnapshot): boolean {
  const events = sessionEvents(session)
  if (events.length <= snap.eventCount) return false
  const now = currentTurnOfSession(session)
  // ② 轮号变了 ⇒ 那些新消息属于**另一个轮**（并发入站的典型形态）
  if (snap.turn !== null && now !== null && now !== snap.turn) return false
  // ① 只看快照之后的事件
  let fresh = 0
  for (let i = snap.eventCount; i < events.length; i++) {
    if ((events[i] as { type?: string } | undefined)?.type === 'assistant/message') fresh += 1
  }
  if (fresh > 0) return true
  // 兜底：事件数组被压缩/重排过（长度回退但内容更新）时，退回"总条数增长"的旧判据
  return countAssistantMessages(session) > snap.assistantCount
}

/**
 * 等**本轮**产出一条 assistant 消息。
 *
 * ## 为什么不能用 `waitAgentIdle` 单独当判据（2026-10-19 复读缺陷）
 *
 * `waitAgentIdle` 的首行是 `if (agent.status === 'idle') finish()` —— 而 `followup()`
 * 是**异步投递**：刚投出去的这一刻 agent 状态**仍是 idle** ⇒ 等待**立刻结算** ⇒
 * `lastAssistantText()` 读到的是**上一轮的** `assistant/message` ⇒ 桥把它当"本轮答案"转发。
 * 而当时若 CCC 又开了 `fallbackOnNoSend`（该开关已于 D238 退役），同一条旧答案会被反复重发（实测三次间隔 300~400ms、逐字相同）。
 *
 * ## 判据（`idle` 只是"可以开始看"的信号，不是成功信号）
 *
 * ① 期望值 = 调用前 `assistant/message` 的**条数**；
 * ② 成功 ⟺ 该计数**增长**；
 * ③ 超时或有界轮询耗尽 ⇒ `false`（调用方据此给空答案，兜底不触发）。
 */
export async function waitForTurnAssistant(
  ctx: unknown,
  agent: Agent,
  before: number | SessionSnapshot,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? ASK_TURN_TIMEOUT_MS
  /**
   * 快照兼容两种入参：数字（旧调用方的"条数"）与 `SessionSnapshot`（新，带轮号与事件位）。
   * 🔴 数字形态**仍然可用**，因为既有测试与调用点按数字传，而它们的语义（"条数增长"）
   * 在本轮修法之后依然成立 —— 只是**并发**时不够。给 `SessionSnapshot` 才拿到全部判别力。
   */
  const snap: SessionSnapshot = typeof before === 'number'
    ? { turn: null, assistantCount: before, eventCount: 0 }
    : before
  const grew = (): boolean => (typeof before === 'number'
    ? countAssistantMessages(agent.session) > before
    : grewWithFreshAssistant(agent.session, snap))
  // ① 先与超时赛跑等一次 idle。**idle = 这一轮结束了**，是"可以结算"的信号。
  // 🔴 必须有界：若这一轮压根没起来（如被白名单全拒、宿主不发 idle），旧实现会永远挂着。
  const idleReached = await Promise.race([
    waitAgentIdle(ctx, agent).then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), timeoutMs) }),
  ])
  // ② **idle 一到就结算**（不再空等）：有产出 = 成功；没产出 = 这一轮没答，立刻判失败。
  if (idleReached) return grew()
  // ③ idle 没来（超时）：最后再看一眼计数，避免"产出已落盘但 idle 事件丢了"被误判为失败。
  return grew()
}

/**
 * 把一条用户消息**投进**载体会话 —— 🔴 **2026-10-24 owner 令：正在跑就直接进，不排队**。
 *
 * ## owner 原话
 * 「**当用户消息进来，且绑定轨迹正在活动时，消息是排队而不是直接进入，应当改为直接进入，
 *   这样确保来回通信的流畅性**」。
 *
 * ## 修前为什么是"排队"
 * 入站走 {@link askTrajectory}：它 `followup()`（**排队语义**，等本轮结束才开新一轮）
 * 然后**等整轮跑完**读答案。而 D238（2026-10-24，出站只剩 `im-bridge`）之后
 * 那个答案**已经没有消费方**（调用点是 `void result`）⇒
 * **整轮等待只剩副作用：把后一条消息堵在前一条那一轮后面**。
 *
 * ## 判据（与 `trajectory/interrupted.ts` 的 `createResumeOne` 同源）
 * - **`agent.status === 'running'` 且 `steer` 可用** ⇒ `steer`：**当场注入当前轮**
 *   （模型在同一次生成里就看到这句话 ⇒ 来回通信连续）。
 * - 否则 `followup`：空闲 ⇒ 立刻起一轮；`steer` 缺失 ⇒ 排队也比丢掉好。
 *
 * ## 为什么本函数**不等**回答
 * ① 答案没人读（D238 之后出站只能由 agent 自己调 `im-bridge`）；
 * ② **等待正是"排队"的机制本体** —— 不等，锁就只覆盖投递那一下，
 *    下一条消息才能也当场进去。
 * ⇒ 语义从"**问一句、等回答**"变成"**把话递进去**"。这也更贴近 IM 的真实形态：
 *    用户是连续说话的，不是一问一答的请求-响应。
 *
 * ⚠️ **与 {@link askTrajectory} 的分工**：后者保留"问 + 等本轮答案"的完整语义
 * （仍有消费方/测试在用）；本函数是**入站投递**专用。
 */
export function deliverToTrajectory(agent: Agent, text: string): { how: string } {
  const a = agent as unknown as {
    steer?: (m: unknown) => void
    followup?: (m: unknown) => void
    status?: string
  }
  // 🔴 **DII M2 · 注入点 #12**（2026-11-04）：改走声明层。
  //    ⚠️ **通道逐分支选**（在跑 ⇒ steer，否则 followup）—— I3 的又一实例：
  //    声明只有一份（origin/form/delivery），通道由目标 status 决定，⛔ 不写成一次 deliver()。
  const msg = toMessage(
    makeInjection({
      origin: 'acc',
      form: 'notice',
      summary: 'IM 入站消息',
      text,
      delivery: 'wake-now',
    }),
  )
  // 🔴 分支顺序即判据：在跑优先当场注入
  if (a.status === 'running' && typeof a.steer === 'function') {
    a.steer(msg)
    return { how: 'steer' }
  }
  if (typeof a.followup === 'function') {
    a.followup(msg)
    return { how: 'followup' }
  }
  return { how: 'none' }
}

/**
 * 提问一轮：followup → 等**本轮**回答 → 读答案。
 *
 * ⚠️ **2026-10-24：本函数已不再是 IM 入站的投递路径**（改用 {@link deliverToTrajectory}，
 * 因为 owner 要求"正在跑就直接进、不排队"，且 D238 之后答案已无消费方）。
 * 保留它是因为"问一句并等这一轮的答案"这个语义本身仍然有效（测试与将来的同步调用方）。
 * ⛔ **不要把它改回入站路径** —— 那会把排队一起带回来。
 *
 * ## 🔴 2026-10-21：快照从"条数"升级为"（轮号, 条数, 事件位）"
 *
 * 并发入站时，后一条的快照里**前一条那一轮还在产出** ⇒ 旧判据（条数增长）会被满足
 * ⇒ 后一条把**别人那一轮的文本**当自己的答案。新快照让"增长"只在**本轮的窗口内**才成立。
 * 配套：调用侧（`im/inbound-event.ts`）给**同一会话**加了串行锁 —— 两层都要，缺一不可：
 * 锁防"同时开两轮"，快照防"锁被绕过时（如别的路径直接调本函数）把错轮的文本当答案"。
 *
 * @param options.timeoutMs 本轮等待上限（测试注入；生产用缺省）
 */
export async function askTrajectory(
  ctx: Context,
  agent: Agent,
  question: string,
  options?: { timeoutMs?: number },
): Promise<TrajectoryAskResult> {
  const beforeSnapshot = snapshotSession(agent.session)
  // 🔴 **DII M2 · 注入点 #13**（2026-11-04）：改走 `deliver()`。
  //    `delivery:'next-turn'` ⇒ 通道由 deliver 选（followup），行为零变更。
  deliver(
    makeInjection({
      origin: 'acc',
      form: 'notice',
      summary: '轨迹提问（等本轮答案）',
      text: question,
      delivery: 'next-turn',
    }),
    agent,
  )
  const produced = await waitForTurnAssistant(ctx, agent, beforeSnapshot, { timeoutMs: options?.timeoutMs })
  // 🔴 本轮没产出 ⇒ **空答案**（绝不退回上一轮的旧文本：那正是复读的形态）
  const answer = produced ? lastAssistantText(agent) : ''
  return { answer, sessionId: String((agent.session as { id?: unknown }).id ?? '') }
}

// ── 守门查询（seams / guards 用；全部走 profile.ts 的单一判据）──

/**
 * 轨迹约束会话的轨迹纪律参与判定：**不是 轨迹约束恒 true**（正常参与）；
 * 轨迹约束 按 `trajectory-constraint.json` 的 `cognitiveTrajectory` 子集决定。
 *
 * 注册表缺失（进程刚重启、绑定还没读）⇒ 由 `trajectoryConstraintForSession` 回落持久绑定；
 * 两者都不中 ⇒ 判"不是 轨迹约束" ⇒ 恒 true（正常参与）。**fail-open 是有意的**：
 * 纪律参与项的失败不该让会话失去 keeper/rebuild（那是能力倒退，比多跑一次更糟）。
 */
export function trajectoryConstraintParticipates(
  root: string,
  sessionId: string | undefined,
  key: 'session' | 'keeper' | 'rebuild',
): boolean {
  if (sessionId === undefined) return true
  const profile = trajectoryConstraintFor(root, sessionId)
  if (profile === null) return true
  return constraintCognitiveTrajectory(profile)[key]
}

interface TrajectoryConstraintMsmGate {
  /** 拒绝原因（有则拒绝执行） */
  reject?: string
  /** list 显示白名单（msms）；仅 action==='list' 时有值 */
  whitelist?: Set<string>
}

/**
 * `msm` 工具的 轨迹约束门控：非 轨迹约束恒放行；轨迹约束会话——
 * exec 非白名单 MSM 拒绝（**不列名单**）、register/deregister 必拒、
 * list 白名单过滤、check/guide/ccc-config 只读放行。
 */
export function trajectoryConstraintMsmGate(root: string, sessionId: string | undefined, action: string, name?: string): TrajectoryConstraintMsmGate {
  if (sessionId === undefined) return {}
  const profile = trajectoryConstraintFor(root, sessionId)
  if (profile === null) return {}
  if (action === 'register' || action === 'deregister') {
    return { reject: 'register/deregister is not allowed in trajectory-constraint sessions' }
  }
  if (action === 'exec') {
    // ⚠️ D181：`msms` 缺省 = 不收窄（该轨迹没限制 MSM）⇒ 放行；显式 `[]` 才全拒
    if (profile.msms === undefined) return {}
    if (!name || !profile.msms.includes(name)) return { reject: 'MSM not allowed' }
    return {}
  }
  if (action === 'list') return { whitelist: profileMsmWhitelist(profile) }
  return {} // check / guide / ccc-config：只读放行
}

/** 该轨迹约束会话的工具白名单（guards 的 schema 收窄用） */
export function trajectoryConstraintToolWhitelist(root: string, sessionId: string | undefined): Set<string> | null {
  if (sessionId === undefined) return null
  const profile = trajectoryConstraintFor(root, sessionId)
  return profile === null ? null : profileToolWhitelist(profile)
}

/** 按编码解析 轨迹约束（路由/调试页/审计用） */
export function trajectoryConstraintByCode(root: string, code: string): TrajectoryConstraint | null {
  return readTrajectoryConstraintByCode(root, code)
}

/** 编码 → 轨迹目录名（路由用；只做精确匹配） */
export function trajectoryConstraintDirNameByCode(root: string, code: string): string | null {
  return findDirNameByCode(root, code)
}

/** 一次性解析提示词全文（admin/validate 用；热路径不要用） */
export function trajectoryConstraintSystemPrompt(root: string, profile: TrajectoryConstraint | null | undefined): string {
  return resolveConstraintSystemPrompt(root, profile)
}
