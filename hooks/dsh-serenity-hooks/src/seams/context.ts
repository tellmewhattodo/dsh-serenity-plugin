/**
 * context.ts — 拦截缝：ACC 上下文注入（agent/created + agent/prompt-submit）
 *
 * 对应 opencode-serenity-plugin 的 system.transform（ACC 身份/约束注入）+ Phase 2 访谈提示。
 *
 * 设计：
 * - session-start（emit）：CCC 内新会话一次性播种 ACC 身份（agent.inject）
 * - prompt-submit（waterfall）：每 agent 首次进入 CCC 时附加紧凑身份提示；
 *   只注入一次（Set 跟踪），避免每轮 token 膨胀；context-only 必须 next() 委托
 *   （短路会跳过后续策略监听器，interception-seams 笔记明确警告）。
 */

import type { Context } from 'cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { loadSerenityConfig, readUserQuotesEnabled, DEFAULT_SERENITY_CONFIG_PATHS } from '../kernel/ccc.js'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { ACC_VERSION } from '../kernel/constants.js'
import { makeInjection, toMessage } from '../kernel/injection.js'
import { truncateContent } from '../skills/discovery.js'
import { registerEntrySkillSection, registerCognitiveTrajectorySkillSection } from './system-prompt.js'
import { syncToolVisibility } from './guards.js'
import { parseSessionContextFromEvents, getActiveSessionInfo, setActiveSessionInfo, DEFAULT_SESSION_SCOPE, sessionEvents, resolveSessionByTitle, sessionsRoot } from '../trajectory/core.js'
import { readLastBound, appendBound } from '../trajectory/bound.js'
import { isTrajectoryConstrained, replacesDefaultIdentity } from '../trajectory/policy/profile.js'
import { trajectoryConstraintFor } from '../trajectory/session.js'
import { syncTrajectoryModel } from '../trajectory/model-runtime.js'
import { PLUGIN_SOURCE } from '../kernel/message-source.js'
import { recordUserQuotes, isSubagentSession } from '../trajectory/user-quotes.js'

/** 最小 agent 形状（本文件只需 session.id 与 ctx） */
type AgentLike = { session?: { id?: string }; ctx?: unknown }

/**
 * 该会话的轨迹**是否自带章程**（= 该不该旁路 ACC 身份类默认行为）。D183。
 *
 * 🔴 判据唯一入口 = `replacesDefaultIdentity`（见 `policy/profile.ts` 的判据表）。
 * ⛔ 不要在这里写 `isTrajectoryConstrained` —— 那个只回答"有没有声明"，
 * 用它做旁路就是 owner 2026-10-20 指出的那个 bug（只写 resident 也丢身份）。
 */
function hasTrajectoryOwnCharter(root: string, sessionId: string | undefined): boolean {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  try {
    return replacesDefaultIdentity(trajectoryConstraintFor(root, sessionId))
  } catch {
    return false
  }
}

/**
 * 该 agent 绑定的轨迹目录名（没有 ⇒ `null`）。
 *
 * 🔴 判据唯一入口 = `trajectoryConstraintFor`（它内部并取"持久绑定 + 内存注册表"两来源，
 * 见 `policy/profile.ts` 的 R↓）。⛔ 不要在这里另写一套解析 —— 两份判据会漂。
 */
function trajectoryDirNameOf(agent: AgentLike, root: string): string | null {
  const sessionId = agent.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    return trajectoryConstraintFor(root, sessionId)?.dirName ?? null
  } catch {
    return null
  }
}

/**
 * 同步该 agent 的**模型热切换**（D182）。
 *
 * 🔴 把它做成"按 agent 解析目录名 ⇒ 交给 `trajectory/model-runtime`"的薄适配，
 * 是为了让 `model-runtime` 保持**零 seams 依赖**（可独立单测）。
 */
function syncTrajectoryModelForSession(agent: AgentLike, root: string): void {
  const dirName = trajectoryDirNameOf(agent, root)
  if (dirName === null) return
  syncTrajectoryModel(agent as never, root, dirName)
}



const DEFAULT_ENTRY_SKILL_MAX_CHARS = 30000

/** 从 dsh 会话日志读标题（latest-wins `session/title` 事件；无返回 null）——供标题 reconcile（U3） */
function readDshSessionTitle(session: unknown): string | null {
  try {
    const events = sessionEvents<{ type?: string; data?: { title?: unknown } }>(session)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title.trim() !== '') {
        return e.data.title.trim()
      }
    }
  } catch {
    /* events 访问失败忽略 */
  }
  return null
}

export function accIdentityText(
  root: string,
  configPaths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
  entrySkillMaxChars: number = DEFAULT_ENTRY_SKILL_MAX_CHARS,
): string {
  const phase2 = existsSync(resolve(root, '.dsh', 'PHASE2-PROMPT.md'))
  const lines = [
    `[ACC] Serenity cognitive container active (dsh-serenity-hooks v${ACC_VERSION})`,
    `- CCC root: ${root}`,
    `- Constraints: path isolation (P3, fs sandbox) + session tracking (AGENT_SESSIONS/)`,
    `- Knowledge: load the acc-serenity entry skill; use acc-eap / acc-neat for design collaboration`,
  ]
  // 🔴 历史沿革（保留只为解释"为什么这里没有模型行"）：
  //   2026-09-16 曾删掉 `- cheap-worker default model: <model>` 这一行注入（所有者令，
  //   S142 §0e-G）——判据 = 模型名对 LLM **不构成可执行动作**，拿到也无法据此决策 ⇒ 纯噪音。
  //   2026-10-28 cheap-worker 整条下线（含 `readCheapWorkerConfig()`）⇒ **注入源已不存在**，
  //   这条缝不再是"刻意不注入"，而是"没有可注入的东西"。
  if (phase2) {
    lines.push('- ⚠️ **Phase 2 cognitive alignment interview pending**: work through the 5 Topics below and record answers in an AGENT_SESSIONS/ session')
    try {
      const prompt = readFileSync(resolve(root, '.dsh', 'PHASE2-PROMPT.md'), 'utf-8')
      lines.push(truncateContent(prompt, Math.min(entrySkillMaxChars, 8000)))
    } catch {
      /* 读取失败忽略 */
    }
  }
  return lines.join('\n')
}

// ── DSH 注册 ──

/**
 * ACC 注入消息（S134 去重）：**只含简短身份锚点**（[ACC] 已激活 + CCC 根 + 约束 + Phase 2）。
 * ⚠️ 原文案含「+ cheap-worker 模型」；该注入已于 2026-09-16 删除（§0e-G），
 *    且 cheap-worker 本身已于 2026-10-28 整条下线 ⇒ 此处订正（散文级残留已无对应实现）。
 * 完整身份（ACC 5 块 + CCE + Constraints + EAP + SKILL 全文 + Session 块）由**系统提示词层**
 * （systemPrompt.section，每轮 prompt 装配自动注入，含 subagent）承担——对话消息流/压缩重注入
 * 不再重复注入同一内容（token 双倍浪费，见 S134 注入方案梳理）。
 *
 * 🔴 **DII M2 · 注入点 #1**（2026-11-04）：改成走 `Injection` 声明层。
 * 六个轴里**新增的是 `form:'instructions'` 与 `origin:'acc'`** —— 这两格以前只活在注释里。
 * ⚠️ **行为零变更**：`sourceOf()` 对 `origin:'acc'` ＋ `form:'instructions'` 产出的
 * `kind` 仍是 `plugin:dsh-serenity-hooks`；只多带一个 `form` 字段（宿主 `ContextFormed` 支持它）。
 *
 * ⚠️ 本函数有**两个调用点**，通道不同（I3 的实例）：
 *   · `:480` 走 waterfall 返回 —— 无唤醒
 *   · `:354` 走 `agent.inject()`   —— 排队给下一个 pre-step，**也不唤醒**
 * 两者意图同为 `this-step`，故本函数的 `delivery` 声明成 `this-step`；由调用方各自接通道。
 */
export function accMessage(root: string, configPaths: string[], entrySkillMaxChars: number): UserMessage {
  const header = accIdentityText(root, configPaths, entrySkillMaxChars)
  return toMessage(
    makeInjection({
      origin: 'acc',
      form: 'instructions',
      text: header,
      delivery: 'this-step',
    }),
  )
}

/**
 * 每 agent 是否已注入过 —— **只作为本进程内的快路径**，⛔ 不是判据。
 *
 * 🔴🔴 2026-10-22（owner 报「send-now 创建的会话消息注入两次」的取证结论）：
 * 此前**它就是判据**，于是 `pre-step` 那道门拿它回答"**这条会话**注入过没有"——
 * 而它实际回答的是"**本进程**注入过没有"。进程一换（`restart-web` / 看门狗拉起 /
 * 崩溃重启）它就清空 ⇒ 老会话被冷载入时 `pre-step` 判"没注入过" ⇒ **再注入一遍**。
 *
 * 实测铁证（同一会话两条 `[ACC] … active` 横幅，相隔 18.6 小时）：
 * 只有**跨过重启**的会话有两条，没跨的只有一条 ⇒ 重复的量 = 跨了几个进程。
 *
 * ⇒ 判据改为 {@link hasAccBanner}（读**会话历史**）。本 Set 降级为"同进程免重复扫"的优化：
 *   命中它就直接返回（省一次扫），⛔ 它为空**不代表**没注入过。
 */
const injected = new Set<string>()

function agentKey(agent: Agent): string {
  return (agent.session as { id?: string }).id ?? 'global'
}

/**
 * ACC 身份横幅在**会话历史**里的识别特征（结构判据，不依赖措辞顺序）。
 *
 * 🔴 为什么认 `source.kind` ＋ 正文前缀两件：
 *   - 只认正文 ⇒ 将来文案一改就静默失效（D151 同族：判据不能长在措辞上）；
 *   - 只认 `source.kind` ⇒ 本插件注入的**所有**消息都算（`skill-catalog` 块、假首轮横幅…）
 *     ⇒ 会把"别的注入出现过"误当成"身份横幅出现过"，导致**永不再注入**。
 * ⇒ 两者与：由本插件发出 **且** 正文以 ACC 横幅首词开头。
 */
const ACC_BANNER_PREFIX = '[ACC] Serenity cognitive container active'

/**
 * 这条会话的历史里**是否已经有** ACC 身份横幅（= 判据的唯一权威）。
 *
 * 🔴 这是本条修复的核心：**"注入过没有"是会话的属性，不是进程的属性。**
 * 会话历史随会话走（落盘、重启后仍在），进程内状态随进程死。
 *
 * ⚠️ 读不到 events（受限宿主 / 投影未就绪）⇒ 返回 `false`（退回"注入一次"）。
 *   这是**偏保守**的选择：多注入一条横幅（可见、可清理）远好于
 *   **永远不再注入**（陈旧会话里 ACC 身份彻底缺失，且零信号）。
 *
 * @param session 目标会话（`sessionEvents` 能读的形状）
 */
export function hasAccBanner(session: unknown): boolean {
  return sessionEvents(session).some((event) => {
    const e = event as { type?: string; data?: { source?: { kind?: string }; content?: unknown } }
    if (e.type !== 'user/message') return false
    if (e.data?.source?.kind !== PLUGIN_SOURCE.kind) return false
    return textOfUserMessage(e.data)?.trimStart().startsWith(ACC_BANNER_PREFIX) === true
  })
}

/** 从 `user/message` 的 content 块数组里拼出纯文本（无 text 块 ⇒ undefined） */
function textOfUserMessage(data: { content?: unknown } | undefined): string | undefined {
  const content = data?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

function agentScope(agent: Agent): string {
  return (agent.session as { id?: string }).id ?? DEFAULT_SESSION_SCOPE
}

/**
 * 重启恢复的根会话判定（S134 需求）：
 * 只有"conversation 根会话"才自动恢复最近激活的宁静号会话——
 * - subagent：session header `origin === 'subagent'`（DSH 路由语义，agent-lookup.ts）
 * - 派生会话：`parentSession` 存在（任何子会话）
 * - 历史 `cheap-worker-` 前缀会话（**兼容保留**：生成者 `tools/cheap-worker.ts` 已于
 *   2026-10-28 整条下线 ⇒ **不会再产生新会话**，但**旧持久化会话仍可能被 resume**，
 *   那时它依旧不该把主会话激活注入子上下文）
 * 三者都不恢复（避免把主会话激活注入子上下文，违背 v1.16.2 scope 隔离）。
 */
export function shouldAutoRestore(agent: Agent, root?: string | null): boolean {
  const session = agent.session as { id?: string; header?: { origin?: string; parentSession?: string; cwd?: string } } | undefined
  if (!session) return false
  if (session.header?.origin === 'subagent') return false
  if (session.header?.parentSession) return false
  // 兼容保留：cheap-worker 已于 2026-10-28 下线（不再产生新会话），但旧会话仍可能被 resume
  if (session.id?.startsWith('cheap-worker-')) return false
  // 轨迹约束会话：完全独立（CCC 提示词全替换），不自动恢复宁静号会话激活信息。
  // 🔴 2026-10-19：判据从「id 前缀 `轨迹约束-`」改为「绑定轨迹有 `trajectory-constraint.json`」。
  //    ⇒ 需要 CCC 根；调用方通常已算出（seed/pre-step），没给就按会话 cwd 自己推导。
  const cccRoot = root !== undefined ? root : cccRootForCwd(session.header?.cwd ?? process.cwd())
  // 🔴 D183（owner 2026-10-20）：判据是「**这条轨迹自带章程**」而不是「有没有 trajectory.json」。
  //    只写 model/resident/白名单 的轨迹，仍应照常自动恢复宁静号会话 —— 那些 key 不取代身份。
  if (cccRoot && hasTrajectoryOwnCharter(cccRoot, session.id)) return false
  return true
}

/**
 * 恢复触发判定（S134 泄漏修复 v1.16.13）：根会话 **且已有对话历史**（续跑/恢复的会话）
 * 才自动恢复上次激活的宁静号会话——全新会话（新任务）无历史 → 不恢复，
 * 避免把过去的 SESSION 上下文注入新任务（跨任务污染）。
 */
export function shouldRestoreActive(agent: Agent, root?: string | null): boolean {
  if (!shouldAutoRestore(agent, root)) return false
  const events = sessionEvents(agent.session)
  return events.length > 0
}

interface ContextRegistration {
  configPaths?: string[]
  /** session-start 播种 */
  seedOnStart?: boolean
  /** prompt-submit 兜底注入 */
  injectOnPrompt?: boolean
  /** 入口 skill 内容注入上限（字符）；0 = 不注入 skill 内容 */
  entrySkillMaxChars?: number
}

export function registerContext(ctx: Context, opts: ContextRegistration = {}): void {
  const configPaths = opts.configPaths ?? DEFAULT_SERENITY_CONFIG_PATHS
  const entrySkillMaxChars = opts.entrySkillMaxChars ?? DEFAULT_ENTRY_SKILL_MAX_CHARS

  const seed = (agent: Agent): void => {
    const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
    const root = cccRootForCwd(cwd)
    // 🔴 v1.56.6（owner 报缺陷）：工具是 `apply()` 里注册到**宿主级**的 ⇒ 与会话 cwd 无关地
    //    出现在每个会话的清单里。其余各缝"不在 CCC ⇒ 不注入"即自然失效，**工具面必须显式隐藏**
    //    ⇒ 这一句就是那道门（必须在下面的 `if (!root) return` **之前**，否则非 CCC 永远走不到）。
    // 🔴 2026-10-22 方案 C（owner 裁）：**六源汇一**。
    //    改之前这里是 5 条独立 sync（各自在自己的 Map 里放 disposer），加上 pre-step
    //    那 5 条 ⇒ 一次交互发出多次 `tools.restrict` ⇒ 宿主每次发 `tools/change`
    //    ⇒ 模型侧看到工具清单**先进后出**（实测：`新增 7 个` 紧跟 `移除 7 个`）。
    //    宿主契约「Restrictions intersect」⇒ 先并集只发一次，**结果相同**、只触发一次变更。
    //    ⚠️ 必须在 `if (!root) return` **之前**调用：非 CCC 也要隐藏全部 ACC 工具。
    try {
      syncToolVisibility(agent, root)
    } catch {
      /* 可见性同步失败不阻断播种（最坏：工具可见，调用时仍被各工具自身的 !root 判据拒绝） */
    }
    if (!root) return
    const key = agentKey(agent)
    // 轨迹：**只有自带章程**才完全旁路（不注入 ACC 身份；CCC 提示词全替换）
    // 🔴 D183（owner 2026-10-20）：判据从「有 trajectory.json」收窄为「有 systemPromptFile/systemPrompt」。
    //    只写 model／resident／白名单 的轨迹**照常拿 ACC 身份** —— 那些 key 不取代"我是谁"。
    if (hasTrajectoryOwnCharter(root, key)) return
    // P0-1：agent 级 scoped 注册身份 section（最近层，抗 preset/动态插件同名 shadow）。
    // 与全局 section 同名 → scoped 胜出；全局保留为冷恢复/未走 session-start 的 fallback。
    registerEntrySkillSection(agent, root)
    // v1.34.1：轨迹声明的 skill 注入（绑定期间持续存在；无绑定/无声明 ⇒ 不注册，见 system-prompt.ts）
    registerCognitiveTrajectorySkillSection(agent, root)
    // 重启恢复（S134 v1.16.14 内存化，对齐 osp）：进程重启内存 Map 空 + 会话有历史 →
    // 从**当前会话 events** 解析 [SESSION CONTEXT] 标记恢复内存活跃会话（只扫自己会话，
    // 无跨会话串台）；全新会话（无历史）天然不恢复。autoRestoreSession 可关，默认开。
    const scope = agentScope(agent)
    if (shouldRestoreActive(agent) && getActiveSessionInfo(scope) === null) {
      try {
        const cfg = loadSerenityConfig(root, configPaths)
        if (cfg.hooks?.autoRestoreSession ?? true) {
          const dshSession = agent.session
          // v1.0 恢复链（方案：bound 权威 → 文本扫回退 → 标题 reconcile 兼容）——
          // 三层均绝对化 + existsSync 校验（陈旧/归档/删除不污染内存）。
          let restored: { dirName: string; mdPath: string; sessionId?: string } | null = null
          // ① 持久化绑定事件（权威，U1）
          const bound = readLastBound(dshSession)
          if (bound) {
            const abs = bound.mdPath.startsWith(root) ? bound.mdPath : resolve(root, bound.mdPath)
            if (existsSync(abs)) restored = { dirName: bound.dirName, mdPath: abs, sessionId: bound.sessionId }
          }
          // ② 旧会话回退：文本扫描 [SESSION CONTEXT] / SESSION.md path:
          if (!restored) {
            const info = parseSessionContextFromEvents(sessionEvents(dshSession))
            if (info) {
              const abs = info.mdPath.startsWith(root) ? info.mdPath : resolve(root, info.mdPath)
              if (existsSync(abs)) restored = { dirName: info.dirName, mdPath: abs, sessionId: info.sessionId }
            }
          }
          // ③ 标题 reconcile（U3/U4）：无 bound + 标题含 SESSION 引用 → 编码无关解析 + 持久化
          if (!restored) {
            const title = readDshSessionTitle(dshSession)
            if (title) {
              const md = resolveSessionByTitle(title, sessionsRoot(root))
              if (md && existsSync(md)) {
                const dirName = basename(dirname(md))
                restored = { dirName, mdPath: md, sessionId: undefined }
                appendBound(dshSession, 'reconcile', { dirName, mdPath: md, note: 'auto from title' })
                console.log(`[serenity-hooks] ↻ 标题兼容持久化绑定: ${title} → ${dirName}`)
              }
            }
          }
          if (restored) {
            // ActiveSessionInfo.sessionId 必填（展示码）：有则用；无则从目录名派生（S###/自定义编码段）或回退 dirName
            const derived = restored.sessionId
              ?? (restored.dirName.match(/--([^--]+)--/) ? restored.dirName.match(/--([^--]+)--/)![1] : undefined)
              ?? restored.dirName
            setActiveSessionInfo(scope, { ...restored, sessionId: derived })
            console.log(`[serenity-hooks] ↻ 从历史恢复激活会话: ${restored.dirName}`)
          }
        }
      } catch {
        /* 恢复失败不阻断播种（Session 块自然为空，用户可手动 session use） */
      }
    }
    // 🔴 2026-10-22 同批修复：`seed` 这条也改读会话历史。
    //    它是冷载入时唯一会跑的那条（`agent/created` 未必再触发）⇒ 若只用进程内 Set，
    //    "全新会话"与"跨重启的老会话"在这条路上完全不可分。
    if (injected.has(key) || hasAccBanner(agent.session)) {
      injected.add(key) // 补记快路径
      return
    }
    injected.add(key)
    agent.inject(accMessage(root, configPaths, entrySkillMaxChars))
    // 🔴 2026-10-22 方案 C：六源汇一，这里**一次**发射（原先在此另有 4 条独立 restrict）。
    //    `syncToolVisibility` 在函数开头已跑过一次（那时 root 可能是 null ⇒ 隐藏全部 ACC 工具）；
    //    这里 root 已知非 null ⇒ 再算一次得到"CCC 内"的目标态。**幂等**：两次判决相同则第二次不发。
    try {
      syncToolVisibility(agent, root)
    } catch {
      /* 可见性同步失败不阻断播种（最坏：工具可见，调用时仍被各工具自身判据拒绝） */
    }
    // 🆕 v1.78.0（D182）：模型运行时热切换 —— 只有该轨迹**声明了 model** 才装缝。
    //    为什么放在播种处：`agent/created` 是**我们唯一能拿到 agent.ctx** 的时机，
    //    而 `installModelSelection` 是 agent-scoped 的（装进 agent.ctx 才随会话销毁）。
    try {
      syncTrajectoryModelForSession(agent, root)
    } catch {
      /* 装配失败不阻断播种：模型不切换 ≠ 会话不可用（内部已告警） */
    }
  }

  // agent/created：serial 事件（监听器被 await、抛错会使创建失败）⇒ CCC 内新会话播种。
  // ⚠️ v0.1.7：由 `agent/session-start`（emit）取代为 `agent/created`（serial），载荷仍为 `{ agent, … }`。
  // 🔴 契约要求返回 `undefined | Promise<undefined>`（裸 `void` 不被接受）⇒ 用 `async`（宿主自身
  //    插件同款写法）；函数体同步执行到首个 await，播种仍是瞬时的，不会拖慢创建。
  if (opts.seedOnStart ?? true) {
    ctx.on('agent/created', async (payload) => {
      try {
        seed(payload.agent)
      } catch {
        /* 播种失败不阻断启动 */
      }
    })
  }

  // pre-step（DSH v2：prompt-submit → agent/pre-step，step 级准入）：首次进入 CCC 时前置身份消息（必须 next() 委托）
  if (opts.injectOnPrompt ?? true) {
    ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
      const { agent, messages } = payload
      const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
      const root = cccRootForCwd(cwd)
      const key = agentKey(agent)
      /**
       * 🔴 用户语录台账采集（v1.113.0，owner 2026-11-02 需求）。
       *
       * 放在 `next()` **之前**：`payload.messages` 是"本 step 从 inbox 取出、即将进入本步的消息"
       * （宿主 `runtime-types.d.ts` 逐字）。先记再放行 ⇒ **这一步真的会看见的话，就一定先记下了**；
       * 若下游 reject 掉这一步，台账上会多一条"它没看见"的记录 —— 那是**已知且可接受**的方向
       * （宁多记不漏记：owner 要的是"用户说过什么"，不是"模型最终读到了什么"）。
       *
       * ⚠️ **只旁路、不阻断**：`recordUserQuotes` 自己 catch 全部失败并 warn，
       *    这里再包一层 `try/catch` 是第二道保险 —— 台账坏了**绝不能让 step 跑不动**。
       * ⚠️ **必须排在 `next()` 之前且不改变 `messages`**：本函数是 waterfall，
       *    但我们**不修改** `payload.messages`（那是下游的输入，动它就是行为变更）。
       */
      if (root) {
        try {
          /**
           * 🔴🔴 **subagent 子会话不采集**（v1.113.2，owner 2026-11-03 裁：
           * 「subagent 任务书记录到用户语录是不对的，这个需要修掉」）。
           *
           * 判据**单一真相源 = `isSubagentSession`**（`trajectory/user-quotes.ts`），
           * ⛔ 这里不重写 `origin === 'subagent' || depth > 0` —— 两份判据会漂（D230）。
           * 完整理由（为什么 kind==='user' 分不开、为什么两条都要判）⇒ 那个函数的头注释。
           */
          const isSubagent = isSubagentSession(agent.session)
          if (!isSubagent && readUserQuotesEnabled(root, configPaths)) {
            const sessionId = (agent.session as { id?: string } | undefined)?.id
            if (typeof sessionId === 'string' && sessionId !== '') {
              recordUserQuotes(root, sessionId, messages)
            }
          }
        } catch (e) {
          console.warn(`[serenity-hooks] user-quotes 采集失败（不影响本步）：${String((e as Error)?.message ?? e)}`)
        }
      }
      const downstream = await next()
      // 🔴 2026-10-22 方案 C（owner 裁）：**六源汇一，每 step 只发一次 restrict**。
      //
      // 改之前这里有 5 条独立 sync（轨迹约束 / 非CCC / safeMode / im-bridge / 专属 / 宿主定时器），
      // 每条在自己的 Map 里放 disposer 且**每步都发** ⇒ 一次交互产生多次 `tools.restrict`
      // ⇒ 宿主每次发 `tools/change` ⇒ 模型侧看到工具清单**先进后出**
      // （实测症状：`新增 7 个：acc-diag, bash, im-bridge, schedule_*, …` 紧跟 `移除 7 个：同一批`）。
      //
      // 为什么合并是**等价**的：宿主 `ToolRuntime.restrict` 契约逐字
      // 「Restrictions **intersect**」⇒ N 次 `deny: Dᵢ` 的净效果 = `⋃Dᵢ`。
      // 先并集、只发一次 = 结果相同，但只触发一次 `tools/change`。
      //
      // 正确性怎么保住：六源**各自 catch**（见 `computeVisibilitySources`），
      // 某一源读配置抛错只让它自己不贡献 deny，**其余五源照常生效** —— 合并不放大失败面。
      // 幂等：判决签名不变 ⇒ `applyVisibilityDecision` 一个字节都不发。
      //
      // ⚠️ 必须在 `if (root)` **之外**调用：非 CCC 会话也要隐藏全部 ACC 工具（v1.56.6 缺陷）。
      try {
        syncToolVisibility(agent, root)
      } catch {
        /* 可见性同步失败不阻断 step（守卫仍兜底拦截） */
      }
      if (root) {
        // 🆕 v1.78.0（D182）：**每轮**重读 `trajectory.json` 的 model 并刷新选择。
        //    这是"运行时热加载"的落点：改文件 ⇒ 下一轮 `agent/request` 就拿到新路由，
        //    与该会话"是谁创建的/什么时候创建的"**无关**（owner 2026-10-20 令）。
        try {
          syncTrajectoryModelForSession(agent, root)
        } catch {
          /* 模型刷新失败不阻断 step（保持上一轮的选择） */
        }
      }
      // 轨迹：只有**自带章程**才旁路身份注入（D183；见上方 seed 处同段说明）
      // ⚠️ 本行不可省：它决定"这条轨迹还要不要拿 ACC 身份"。方案 C 只合并**可见性发射**，
      //    不碰身份注入的旁路判据 —— 两件事无关，合并时误删过一次，此处显式留住。
      if (root && hasTrajectoryOwnCharter(root, key)) return downstream
      if (root) {
        // P0-1：pre-step 兜底路径也启用 scoped 身份 section（session-start 之外的 agent）
        registerEntrySkillSection(agent, root)
        // v1.34.1：轨迹声明的 skill 注入（绑定期间持续存在；无绑定/无声明 ⇒ 不注册，见 system-prompt.ts）
        registerCognitiveTrajectorySkillSection(agent, root)
      }
      if (!root || downstream.kind !== 'enter') return downstream
      // 🔴 2026-10-22 修复（owner 报「消息注入两次」）：**判据必须读会话历史**。
      //    此前这里是 `injected.has(key)`（进程内 Set）⇒ 每次重启后老会话都会被再注入一遍。
      //    `injected` 仍保留为**快路径**：命中就直接返回（省一次扫历史），
      //    ⚠️ 但它为空**不代表**没注入过 —— 真相只在 `hasAccBanner(session)`。
      if (injected.has(key) || hasAccBanner(agent.session)) {
        injected.add(key) // 顺带补记快路径，下次省扫
        return downstream
      }
      injected.add(key)
      return { kind: 'enter', messages: [accMessage(root, configPaths, entrySkillMaxChars), ...messages, ...downstream.messages] }
    })
  }
}
