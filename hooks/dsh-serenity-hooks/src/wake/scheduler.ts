/**
 * wake/scheduler.ts — 认知轨迹唤醒调度器（D58/D59/D60；S142 2026-09-13）
 *
 * 一个**中心调度器**（60s tick，2026-11-02 owner 令「整体都是 60 秒」），处理 CCC 唤醒注册表里
 * 到期的条目：把「未来时刻 + 一条 message」投递给目标认知轨迹，**fire-and-forget**
 * （无阻塞、无等待、无回执——发起方不 await，调度器不替模型结果负责）。
 *
 * 与 autopilot 的关系（D59）：**两个 tick 各自独立**。autopilot 是每 CCC 单例的
 * 周期自唤醒，逻辑一行不碰；本模块只处理注册表的一次性唤醒条目。
 *
 * 投递路径（P-1 证据链见 SESSION.md §30.6）：
 *  1. target（S### / 目录名）→ 目录名 + SESSION.md
 *  2. 目标 dsh 会话 id：`.bindings.json` 里绑定该目录名的会话（按绑定时间倒序，权威）
 *     → 回退：live 会话标题匹配
 *  3. agent：**live 优先**（`ctx.agents.get`）→ 冷会话走 `ctx.sessionController.resolveAgent`
 *     （宿主实现：live 优先 + resume 去重 + 由会话元数据恢复 preset）
 *     → `sessionController` 缺席 ⇒ 仅投递 live 目标，**不静默**（v1.39.3：**归为"环境未就绪"**
 *       而非"投递失败"，见 `WakeDeliveryResult.notReady` —— 启动那一拍早于懒服务就绪是常态）
 *  4. 投递：`agent.followup(...)`（"Queue an ordinary follow-up turn and wake the driver"）
 *
 * 守卫（2026-09-21 起**本钟无闸**）：🔴 **恒武装**——原 `wakeSchedulerEnabled` 已砍，
 * 本钟不再有「可被误关的开关」；旧配置残留该键**静默忽略**，且**不**回退 `autopilotEnabled`｜
 * CRO 阶段另有**独立**总闸 `croEnabled`（只停 CRO，**不影响**本注册表投递）｜
 * 补跑窗口 2h（超窗置 missed 留痕）｜同 tick 串行｜唤起后维持 live（人类可介入）。
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { basename, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { findSession, namingTitleFor, parseTrajectoryCode, sessionsRoot, trajectoryDescOf } from '../trajectory/core.js'
import { buildCarrierOpening, deliverCarrierOpening } from '../trajectory/user-carrier.js'
import { listBoundSessionIds, appendBound, carrierState } from '../trajectory/bound.js'
import { hostAliveProbe } from '../trajectory/alive.js'
import { hasSessionLogById, sessionsRootDir } from '../trajectory/cleanup.js'
import { evaluateCro, listCroCognitiveTrajectories, readCroSnapshotInput, renderCroOutcome, resolveCroHostBinding } from '../cro/core.js'
import { listRunningSessionIds, runningCarriersOf } from '../cro/turns.js'
import { appendCroWakeLog } from '../cro/log.js'
import { createResumeOne, projectDirNameForCwd, scanInterruptedSessions } from '../trajectory/interrupted.js'
import { hostAgents, hostService } from '../host/access.js'
import { registerDisposer } from '../host/effect.js'
import { readSimpleSettings } from '../surface/settings.js'
import { createClock, type ClockOptions, type ClockRuntime } from './clock.js'
import { listCccs } from '../kernel/ccc-roots.js'
import { isoLocal, localHuman } from '../kernel/time.js'
import {
  finalizeWake,
  loadWakeRegistry,
  purgeFinalizedWakes,
  splitDueWakes,
  updateWake,
  WAKE_CATCH_UP_MS,
  type WakeEntry,
} from './registry.js'
import { toMessage, makeInjection, deliver } from '../kernel/injection.js'

/**
 * ── 🔴 2026-09-25 I2 收敛（约束文档 §2.7 违反清单，L1 违反之一）────────────────
 * **`Context`（cordis）import 已清除**，本文件全部 `ctx` 参数类型 → `unknown`。
 *
 * 🔴 **本处是本清单上第三次「按文件整档」判错的实例**（前两次见 `kernel/ccc-roots.ts`
 * 与 `cro/turns.ts`）。本文件原被并进"**真依赖档**"，理由是"它用了 `Agent` 的
 * `followup`/`steer`"—— 但那证明的是 **`Agent` 是真依赖**，**不能顺带证明
 * `Context` 也是**。逐符号查证后：
 *   · `Agent` ⇒ ✅ **真依赖**（`followup`/`steer` **真被调用**；参与返回类型）⇒ **保留**。
 *   · `Context` ⇒ ❌ **纯透传档** —— 本文件 `ctx` 的**全部**去向是交给 L0 取数口
 *     （`hostAgents(ctx)` ／ `hostService(ctx,…)` ／ `listCccs(ctx)` ／
 *     `registerDisposer(ctx,…)`）或**转发给同文件内的其它函数**；
 *     🔵 **证据（可重跑）**：`ctx.` 在本文件**代码中 0 命中**（唯一命中在 :15 的注释里）。
 *     而上述四个被调方的签名**本就写作 `ctx: unknown`**（`host/access.ts` ／
 *     `host/effect.ts` ／ `kernel/ccc-roots.ts`）⇒ 该 import **未参与任何类型检查**。
 *   · 顺带化简 :145 的 `clockOpts.ctx as Context`（`ClockOptions.ctx` 本就声明 `unknown`）
 *     与 :322 的签名 —— 那两处 cast 都是**为了迁就一个没人需要的类型**。
 * ⇒ 🆕 **判据（第三次印证）**：**分档必须逐符号做**；"用了某个宿主类型"**不能**推出
 *   "这个文件的所有宿主 import 都是真依赖"。
 */

/** 宿主 `workspaceRegistry.list()` 条目的最小形状（只用本模块真要的那几个字段） */
interface WorkspaceLike {
  id?: string
  path?: string
  sessionIds?: readonly string[]
  attachSession?: (id: string) => Promise<void>
}

/** 宿主 sessionController 的最小形态（`resolveAgent`：live 优先，否则 resume） */
interface HostSessionController {
  resolveAgent?: (sessionId: string) => Promise<{ agent?: Agent; error?: unknown }>
  /**
   * 🆕 `send-now` 的「无活跃 dsh 会话 ⇒ 就地建一条」通路。
   *
   * 语义逐字取自宿主 `.d.ts`：*"Create or idempotently adopt one ordinary Session."*
   * —— **idempotently adopt** 是关键：同一 `sessionId` 重复调用**不会**建出第二条，
   * 且会把已有的那条 adopt 进来 ⇒ 本路径天然可重入，不必自造"先查再建"的竞态窗口。
   *
   * 🔴 **`workspaceId` 与 `cwd` 互斥**（宿主显式拒绝两者同传：
   * `session.create accepts workspaceId or cwd, not both`）。
   * 传 `workspaceId` ⇒ 宿主走 `if (workspace !== void 0) await workspace.attachSession(...)`
   * 那条分支（= **用户操作的同一条**）；传 `cwd` ⇒ 不挂工作区。
   */
  create?: (request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }) => Promise<{ sessionId?: string; agentPreset?: string }>
}

/** 投递结果（写回条目的 lastResult；人读） */
interface WakeDeliveryResult {
  ok: boolean
  detail: string
  /**
   * 🔴 **环境未就绪**（不是投递失败）——只有一种情形：目标需要**冷载入**，而宿主此刻**还没把
   * 懒服务 `sessionController` 供上来**（典型 = `dsh web` 刚重启：时钟武装时**立刻跑一次 tick**，
   * 那一拍早于懒服务就绪、也早于会话恢复）。
   *
   * 为什么要把它和"真失败"分开（2026-09-17 实测，S142 §0t）：
   * 旧实现把这一情形当成投递失败写进条目 ⇒ ① `attempts` 无端 +1 ② `lastResult` 留下一条
   * **误导性错误**（原文猜"headless profile？"，而真因是**重启窗口**，属**假陈述**）
   * ③ 注册表/面板里出现"失败的投递"，**每次 restart 都必然复现**——一个**假告警发生器**
   * （所有者 2026-09-17 就是被它引来的）。而消息**从未丢失**：下一个 tick 就投成功了。
   * ⇒ 判据：**"宿主服务还没起来"不是投递结果**，不得计入条目。
   */
  notReady?: boolean
}

/**
 * 调度器**进程态**（诊断用，模块级 = 进程级，正是诊断对象）。
 *
 * 为什么需要它（R↓，2026-09-14 F 段缺陷）：调度器此前**没有任何可观测面**——
 * "条目为何一直是 pending" 只能靠反推。有了这几个字段，`acc-diag` 一次调用即可回答
 * "时钟是否武装 / 上次 tick 何时 / 为何跳过"。
 *
 * C6b（P2）：字段由 {@link ClockRuntime} 提供（**工厂那份**，字段名与语义一个字未改）；
 * 此处只把 `lastTickLog` 收为**必需**（本钟独有，autopilot 没有它——现状稿 §2.4）。
 */
type WakeSchedulerRuntime = ClockRuntime & { lastTickLog: string[] }

/** 目标定位：目录名 + SESSION.md 绝对路径 */
interface WakeTarget {
  dirName: string
  mdPath: string
}

/**
 * 解析条目的 target（`S###` 或完整目录名）→ 目录名 + SESSION.md 路径。
 * @param root CCC 根
 * @param target 条目里的目标标识
 * @returns 命中返回目录信息，未命中 null
 */
export function resolveWakeTarget(root: string, target: string): WakeTarget | null {
  const found = findSession(sessionsRoot(root), target)
  if (!found) return null
  const mdPath = join(found.path, 'SESSION.md')
  if (!existsSync(mdPath)) return null
  return { dirName: basename(found.path), mdPath }
}

/**
 * 🔴 **本钟的全局闸已于 2026-09-21 砍掉**（所有者令逐字：「**send-later 的开关不再重要了，砍掉**」）。
 *
 * **为什么砍**（R↓）：唤醒已从"可选实验能力"长成**全容器的续接绳**（🔵 **术语说明，2026-09-23 补**：
 * **"绳" = 我们对自己用 `send-later` 给自己排的"定时叫醒"条目的俗称** —— 一条链每轮给自己排下一根，
 * 链才不断。本仓注释与 SESSION.md 沿用此说法，**它不是产品名、也不是宿主概念**）——S142/S151/S185 的链、
 * 跨轨迹投递、`send-now`/`send-later` 都走它。留一个"能被误关的开关"的**代价**是
 * "整条链静默停摆且无人告警"（本仓已实测过同族事故：闸关 6.6h 零 tick、断链 1 天 14 小时）；
 * 而**收益**只剩"关掉一个 5min unref 空检查"。⇒ **收益 < 代价，故删闸**（不是改为缺省开——是**没有这个键了**）。
 *
 * ⚠️ **兼容**：旧配置文件里残留的 `wakeSchedulerEnabled` **静默忽略**（无回退键、无告警噪声；
 * 与旧 `bootstrap` 段的处置先例一致）。**机制本身一行未动**（所有者："我说的只是开关"）。
 *
 * 历史（勿误读）：v1.34 S-1 曾把两闸解耦（周期自唤醒 `autopilotWakeEnabled` / 本钟 `wakeSchedulerEnabled`），
 * 理由是"关 auto-trajectory 不得连带关一次性唤醒"；随 ACC 侧 autopilot 于 v1.35.0 整段退场，
 * 两闸只剩本钟一座 ⇒ 现已整座移除。详见 `docs/cognitive-trajectory-scheduling.md` §S-1 与 v1.44 CHANGELOG。
 */

/**
 * 🔴 **本钟的串行域**（C6b 硬约束）：`clock.chain` 是**本实例私有**的——
 * 与 autopilot 的串行链**零共享**。autopilot 每轮跑 CCC 偏见脚本可能阻塞数十秒，
 * 共用链会把一次性唤醒一起卡住（这正是 P1 被否、取 P2 的理由，见 SESSION §12.8②）。
 *
 * **为什么这里是模块级常量**（而不是 `registerWakeScheduler` 的局部量）：本钟的进程态是
 * **进程级可观测面**（`acc-diag` ①b / `containerClocks` 在读），且 `wakeSchedulerState()` /
 * `__resetWakeSchedulerStateForTest()` 是**公开导出**、可在未装配时被调用 ⇒ 实例必须**恒在**
 * （旧实现的 `schedulerRuntime` 也正是模块级常量）。装配只做 `clock.start()`。
 */
/** 本钟的装配项（`ctx` 由 {@link registerWakeScheduler} 在装配点填入） */
const clockOpts: ClockOptions<string[]> = {
  label: '认知轨迹唤醒调度器',
  ctx: undefined,
  events: ['session/created', 'serenity/settings-changed'],
  // 🔴 无闸（2026-09-21 砍掉 `wakeSchedulerEnabled`）：**恒武装**。工厂的 `gate` 是可选能力，
  //    本钟不再使用它 ⇒ 永不因闸跳过（`lastSkipReason` 只由 tick 内的真实原因写，如"无 CCC 可扫"）。
  body: () => runWakeTick(clockOpts.ctx),
  // `countBeforeBody` 缺省 false：本钟 `ticks` = **真跑完**的 tick 数（既有语义，勿改）
  logFrom: { prefix: '[serenity-hooks] 认知轨迹唤醒 ', lines: (lines) => lines },
  startLog: () => '[serenity-hooks] ✓ 认知轨迹唤醒调度器启动（60s tick）',
}
const clock = createClock(clockOpts)

/** 调度器进程态快照（只读）。
 *  ⚠️ `enabled` 对**本钟已无意义**（2026-09-21 起无闸 ⇒ 恒 `true`）；保留字段只为沿用工厂快照形状。
 *  "这轮为什么没被唤起"现在看 `armed` / `lastSkipReason`（tick 内真实原因）+ **CRO 闸**（见 `croEnabled`）。 */
export function wakeSchedulerState(): WakeSchedulerRuntime & { enabled: boolean } {
  return clock.snapshot() as WakeSchedulerRuntime & { enabled: boolean }
}

/** 测试用：复位进程态（避免用例间串味） */
export function __resetWakeSchedulerStateForTest(): void {
  clock.reset()
}

/**
 * 取目标 agent：live 优先 → 冷会话走 sessionController.resolveAgent → 标题回退。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param dirName 目标认知轨迹目录名
 * @returns 命中返回 agent 与取得方式（how 进 lastResult，便于诊断）；未命中返回原因
 *   （原因带 `notReady` = **环境未就绪**而非投递失败，调用方**不得**据此记一次失败）
 *
 * 🔴 **前置条件：本轨迹名下必须有一条「未取代」的绑定记录**（2026-09-20 回源码答复 S151 实测）：
 * 选人是**遍历 `listBoundSessionIds(root, dirName)` 给出的 id**（按绑定时间倒序），**live 只是这条
 * 记录的一个加分项**——「绑定里的那条恰好 live ⇒ 直接注入」，否则走冷载入。
 * ⇒ **「有 live 会话」≠「有绑定」**：会话活着但该轨迹**零条未取代绑定**时，本函数**直接返回
 * `无绑定会话记录…`**（`send-now` / `send-later` 到点投递同此判据）。
 * 实证（2026-09-20）：S142 三条旧绑定于 **08:03** 被 `supersededAt` 取代（D69「同轨迹只留一条」），
 * 而当前载体的绑定**直到 17:05 那次 rebuild 才写入**（`queueRebuild` 内的 `appendBound(action:'rebuild')`）
 * ⇒ **10:42 的 `send-now` 落在这个窗口里** ⇒ 报"无绑定会话记录"（当时确有 live 会话）。
 * ⚠️ 已知**注释漂移**：本行上方"→ 标题回退"在函数体内**没有对应分支**（标题回退属 v1.29.2 R2，
 * 现行实现已只认绑定）；**仅登记，未改**（改它属 ACC 代码改动，须具名令）。
 */
async function acquireWakeAgent(
  ctx: unknown,
  root: string,
  dirName: string,
): Promise<{ agent: Agent; how: string } | { error: string; notReady?: boolean; noBinding?: boolean }> {
  const agents = hostAgents(ctx)
  // 🔴 2026-10-20（owner 裁决）：**必须传探针**。缺省语义是"文件在就算绑定"，
  //    而归档只加 id、日志不动 ⇒ 已归档会话会被当成可用载体，CRO 每个 tick 都去
  //    `resolveAgent` 一条使用者早已收起来的会话，且**没有退出条件**。
  const ids = listBoundSessionIds(root, dirName, hostAliveProbe(ctx))
  for (const id of ids) {
    const live = agents?.get?.(id) as Agent | undefined
    if (live) return { agent: live, how: `live(bound ${id})` }
  }
  if (ids.length > 0) {
    const sc = hostService<HostSessionController>(ctx, 'sessionController')
    const resolved = sc?.resolveAgent
    if (typeof resolved !== 'function') {
      // 🔴 这是**环境未就绪**，不是投递失败（见 `WakeDeliveryResult.notReady` 的说明）：
      //    典型成因 = `dsh web` 刚重启，启动那一拍早于懒服务就绪 / 早于会话恢复。
      //    ⚠️ 文案必须**说真话**：旧文猜"headless profile？"是错的猜测（真因常常是重启窗口），
      //    实测把维护者都引偏过一次 ⇒ 两种成因都要说，并点明"下个 tick 会重试"。
      return {
        error:
          `宿主尚未就绪：目标会话未加载，且 sessionController 服务此刻不可用` +
          `（重启后的启动窗口，或本进程确实无该服务）——绑定 id: ${ids[0]}`,
        notReady: true,
      }
    }
    const id = ids[0] as string
    try {
      const out = await resolved.call(sc, id)
      if (out?.agent) return { agent: out.agent, how: `cold-resume(${id})` }
      return { error: `sessionController.resolveAgent 未返回 agent（${id}）: ${String(out?.error ?? '未知原因')}` }
    } catch (err) {
      return { error: `冷会话载入失败（${id}）: ${String((err as Error)?.message ?? err)}` }
    }
  }
  return {
    /**
     * 🔴 **文案改指真相源（2026-10-23，guard 实测报障）**：原写「`AGENT_SESSIONS/.bindings.json` 中无 X」，
     * 而 D172 之后绑定真相源 = **`<轨迹目录>/current.dsh_session_bind`**，`.bindings.json`
     * **已退役且不在盘上**（实测不存在）⇒ 照旧文案排查的人会去翻一个**不存在的文件**。
     */
    error:
      `无绑定会话记录（AGENT_SESSIONS/${dirName}/current.dsh_session_bind 不存在或无有效会话）` +
      `——目标轨迹需先被 cognitive_trajectory use 激活过，或由 send-now 自动创建载体`,
    // 🆕 结构化判别符（2026-10-16，owner 令）：**不靠匹配错误文案**来分流。
    //    文案会漂（本仓已多次因"靠一句话给状态命名"翻车，见 D131），而"这条轨迹
    //    在绑定表里一条记录都没有"是一个**明确的判据结果** ⇒ 必须由产生它的地方显式标出。
    noBinding: true,
  }
}

/** 唤醒消息（唤起即投递正文：身份锚定 + 唤醒信息 + 任务） */
export function buildWakeText(entry: WakeEntry, target: WakeTarget): string {
  /**
   * 🔴 2026-11-02 §D1（owner 令「精简注入提示词模板尺寸」＋ Q3「全砍」）：**356 → 89 码点**。
   *
   * 砍掉的四类（判据 = 「这条信息能不能帮**目标**决定下一步怎么做」，D150）：
   * ① **审计信息**（`登记于`／`id`）—— 那是给人回溯注册表用的，目标拿到它无从行动；
   * ② **身份锚定整句**（`继续 <目录名> 的认知轨迹（SESSION.md: <绝对路径>）`）——
   *    目标**本来就知道**自己在哪条轨迹（它就是这个会话），重复一遍是纯噪声；
   * ③ 一节空行＋`唤醒信息：`标签 —— 标签本身不含信息，正文紧接其上即可；
   * ④ 末尾`任务：按上述唤醒信息继续…` —— 与正文同义反复。
   *
   * 🔴 **必须保留的三件**（每一件都有过代价）：
   * · **`[认知轨迹唤醒]` 标记** —— 与另外两种来源区分，缺了目标会把注入当成人类发言；
   * · **当前时间**（v1.39.2 owner 令）—— 冷载入的目标上下文里**没有任何近期时间锚**；
   * · **发起者** —— 目标要能判断"这是谁叫我"，且测试反向钉住"不得冒充其他来源"。
   *
   * ⚠️ `entry.createdAt` / `entry.id` 不再进正文（仍完整保存在注册表里，回溯走那里）。
   */
  return [
    `[认知轨迹唤醒] 到点（来自 ${entry.createdBy || '未知'}）。当前时间：${localHuman()}（当地时区）。`,
    '',
    entry.message,
  ].join('\n')
}

/**
 * 投递一条唤醒（fire-and-forget：`followup` 入队即返回，不等模型结果）。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param entry 唤醒条目
 * @returns 投递结果（写回 lastResult）
 */
export async function deliverWake(ctx: unknown, root: string, entry: WakeEntry): Promise<WakeDeliveryResult> {
  const target = resolveWakeTarget(root, entry.target)
  if (!target) return { ok: false, detail: `目标认知轨迹未命中（${entry.target}）` }
  const acquired = await acquireWakeAgent(ctx, root, target.dirName)
  if ('error' in acquired) return { ok: false, detail: acquired.error, notReady: acquired.notReady === true }
  try {
    // 🔴 **DII M2 · 注入点 #3**（2026-11-04）：改走 `deliver()`。
    //    `delivery:'next-turn'` ⇒ 通道由 deliver 选（followup），行为零变更。
    deliver(
      makeInjection({
        origin: 'acc',
        form: 'notice',
        summary: `到点唤醒（来自 ${entry.target}）`,
        text: buildWakeText(entry, target),
        delivery: 'next-turn',
      }),
      acquired.agent,
    )
  } catch (err) {
    return { ok: false, detail: `投递失败（${acquired.how}）: ${String((err as Error)?.message ?? err)}` }
  }
  return { ok: true, detail: `已投递 ${target.dirName}（${acquired.how}）` }
}

/**
 * 即时消息正文（**刻意不复用** {@link buildWakeText}）：唤醒文本以「**到点**（登记于…）」开头，
 * 对即时投递那是**错的事实**。本函数显式区分"这是即时消息、不是到点唤醒"。
 *
 * ⚠️ **v1.39.2 起"已入队"这句话必须删掉**（S142 §0r，所有者令「不排队、直接即时注入」）：
 * 旧文案写"消息已进入你的队列；你此前若正在跑轮次，它在本轮结束后生效"——
 * 那是**旧的 followup 语义**；现在在跑的目标走 `steer`（当场注入当前轮），
 * 留着这句话就是**注入一条假陈述**（比没有更坏：目标会误判自己看到它的时机）。
 * @param target 目标轨迹（目录名 + SESSION.md）
 * @param message 递送正文
 * @param sender 发起者轨迹标识（供目标与人类识别来源）
 */
export function buildSendText(target: WakeTarget, message: string, sender: string): string {
  /**
   * 🔴 2026-11-02 §D2（owner Q3「全砍」）：**330 → 98 码点（−70%）**。
   *
   * 砍掉的两类：
   * ① **身份锚定整句**（同 §D1 ①）—— 目标本就知道自己在哪条轨迹；
   * ② `说明：这是**即时投递**…不排队…当场注入当前轮，空闲则立即起一轮`（约 150 码点）——
   *    这是**纯实现说明**：它讲的时机语义**目标既无法验证也不需要验证**，
   *    却能占掉整条消息一半篇幅。目标只需要知道「谁发的、什么内容」。
   *
   * 🔴 **必须保留**：`[即时消息]` 标记（与到点唤醒／CRO 唤起区分）＋ 发起者 ＋ 当前时间。
   *
   * ⚠️ `target` 参数**保留**（调用方按位置传参，删参是破坏性改动；且未来若要做
   *    "多轨迹共用一条会话"的区分，它是唯一可用的锚）—— 但**不再进正文**。
   */
  void target
  return [
    `[即时消息] 来自 ${sender || '未知轨迹'}。当前时间：${localHuman()}（当地时区）。`,
    '',
    message,
  ].join('\n')
}

/**
 * 即时投递（`cognitive_trajectory send-now`）——与 `send-later`（预约）**共用取用通路**（`acquireWakeAgent`），
 * 区别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）：
 *   · `send-later`（原 `wake-later`）：未来时刻 + 一条 message → 落注册表 → 本文件的调度器到点投递（**fire-and-forget，无回执**）
 *   · `send-now`（原 `send-message`）：**此刻**把一条 message 递给目标 → **同步回执** → **不落注册表**
 *
 * **为什么冷路径落在这里（R↓，2026-09-16 所有者裁决）**：`addWake` 显式拒绝 `at ≤ now`
 * （"时刻必须在未来"——那是"**预约**"语义的地基，不许放宽）⇒ 即时投递**不能**靠一条
 * `at=now` 的注册表条目实现（那还会让调度器把一次性即时投递当 `pending` **每 tick 重试**）。
 * 必须直接走 {@link acquireWakeAgent}（live 优先 → `sessionController.resolveAgent` 冷载入）。
 * 这正对应所有者要的「**会话不活跃则等效于直接 wake**」：**同一条冷载入通路**，只是**不等 tick**。
 *
 * ⚠️ **承诺边界（不许含糊）**：回执只到「**已注入 / 已起轮**」（宿主调用未抛错），
 * **到不了**"目标已执行/已答复" —— 与 `deliverWake` 同一层。
 * 判"目标真的动了"必须用**文件级判据**（它自己的 SESSION.md），
 * **不得凭回执结案**（§12.B 的 `delivered ≠ 跑了一轮`）。
 *
 * 🔴 **v1.39.2 语义变更（S142 §0r，所有者 2026-09-17 令：「希望 send message 时不排队，
 * 可以直接作为提示词即时注入进去」）**：
 * 旧实现一律 `followup`（宿主注释：*Queue an ordinary follow-up turn*）⇒ 目标**正在跑轮次**时
 * 消息**排在轮次边界**（即旧文案的"不打断当前轮"）。现按宿主 `agent.status` 分流：
 *   · `status === 'idle'` ⇒ `followup`（宿主**同步**把 status 置 running ⇒ **立即起轮**，本就不排队）
 *   · 否则（在跑）      ⇒ **`steer`** —— **当场注入当前轮**，这才是"不排队"的关键路径
 * ⚠️ **fail-safe**：`steer` 抛错 ⇒ **退回 `followup`**：**宁可排队，不可静默丢消息**。
 * ⚠️ **只改 `send-now`**：`send-later`（{@link deliverWake}）**保持 `followup`** ——
 * 预约的本职是"到点唤起"，且在跑时排队不打断是它被实证验收过的行为，不顺手动它。
 *
 * **归属**：本函数放在调度器侧而非工具侧 —— "怎么把一句话送到一条轨迹"是**调度器的知识**，
 * 工具只该知道"有这个动作"。这样 `cognitive-trajectory.ts` 完全不碰调度器内部（v1.35.0 硬约束①：
 * `send-later` 链路**一行为不动**，本次改动 = **纯新增**）。
 *
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param target `S###` 或 AGENT_SESSIONS 目录名
 * @param message 递送正文
 * @param sender 发起者轨迹标识
 * @returns 投递结果（**同步**返回给调用方）
 */
export async function sendToCognitiveTrajectory(
  ctx: unknown,
  root: string,
  target: string,
  message: string,
  sender: string,
): Promise<WakeDeliveryResult> {
  const t = resolveWakeTarget(root, target)
  if (!t) return { ok: false, detail: `目标认知轨迹未命中（${target}）` }
  let acquired = await acquireWakeAgent(ctx, root, t.dirName)
  let createdNote = ''
  if ('error' in acquired) {
    // 🆕 2026-10-16（owner 令，S142）：「目标没有活跃 dsh 会话 ⇒ 直接创建并注入」。
    //
    // 🔴 **为什么只给 `send-now` 开这条路（`send-later` 不开）**：
    //   两者的**语义不同**，因而对"目标不存在"的正当反应也不同 ——
    //   · `send-now` 是**主动递话**：发起者此刻就想让这条轨迹动起来。若目标从未被 `use` 过
    //     （`.bindings.json` 里一条记录都没有），**没有载体**正是它的常态，而不是错误。
    //     此时"建一条再投"是**完成用户意图**；报错等于把"你得先手动 use"的负担丢回发起者。
    //   · `send-later` 是**预约**：预约的语义前提是"那条轨迹**已经**存在且会被唤醒"。
    //     给一条**从未存在过**的轨迹预约定时消息，通常意味着**写错了名字** ——
    //     此时创建载体反而**掩盖**这个错误（用户以为排上了，其实指向一条空轨迹）。
    //     ⇒ ⛔ **本路径刻意不接进 `deliverWake`**（那是 `send-later` 的通路）。
    //
    // ⚠️ **本路径只在"无绑定记录"这一种情形下启用**：其余 error（含 `notReady` 环境未就绪、
    //    冷载入失败）**一律照原样返回** —— 那些不是"没载体"，而是"载体此刻取不到"，
    //    建新载体既解决不了问题、还会**制造第二条**（与"只留一条"冲突）。
    if (!acquired.notReady && acquired.noBinding === true) {
      // 🔴 **第 2 条守卫（owner 2026-10-20）**：**这条轨迹曾经有过载体 ⇒ 禁止再建新的**。
      //
      // 为什么不能只看 `noBinding`：它的判据是"绑定表里有没有**未退**条目"，
      // 而"条目被退掉"与"从未有过会话"在读数上完全一样 ⇒ 于是一条轨迹的载体退役后
      // 又长出一个新的（实测：S196 在同一分钟内出现第二个载体）。
      //
      // 新判据 = **轨迹目录里有没有交代**（`carrierState`）：
      //  · `never`    ⇒ 从未有过 ⇒ 允许自建（owner 认这是正当用例）
      //  · `occupied` ⇒ 有过，但那个会话现在不在 ⇒ **禁止自建**，如实报错
      //  · `live`     ⇒ 此刻有效（`acqired.noBinding` 与它矛盾 = 读数打架，同样不建）
      const carrier = carrierState(root, t.dirName, hostAliveProbe(ctx))
      if (carrier.state !== 'never') {
        const why =
          carrier.state === 'occupied'
            ? `该轨迹曾经由会话 ${carrier.sessionId} 承载，而它此刻不在了`
            : `该轨迹当前由会话 ${carrier.sessionId} 承载`
        return {
          ok: false,
          detail:
            `${t.dirName}：${why} ⇒ **拒绝自动新建载体**（一条轨迹至多一个载体）。\n` +
            `  · 要让它重新跑起来：把那个会话恢复，或用 cognitive_trajectory rebuild 换代（显式 takeover）。\n` +
            `  · 不明所以就先 cognitive_trajectory show ${t.dirName} 看它的交代文件。`,
        }
      }
      acquired = await createAndBindTarget(ctx, root, t.dirName)
      if ('error' in acquired) return { ok: false, detail: acquired.error }
      createdNote = `；目标原本无活跃 dsh 会话 ⇒ **已自动创建并绑定**一条（${acquired.how}）`
    } else {
      return { ok: false, detail: acquired.error }
    }
  }
  const agent = acquired.agent
  // 🔴 **DII M2 · 注入点 #4**（2026-11-04）：改走声明层。
  //    ⚠️⚠️ **本处是 I3 最真实的形态**：同一个 `delivery:'wake-now'` 意图，
  //    在**不同上下文**落不同通道（idle ⇒ followup，在跑 ⇒ steer，steer 失败退回 followup）。
  //    这正是「delivery 是意图、通道是实现」的教科书实例 —— 通道选择在下面逐分支进行，
  //    而**声明（六条轴）只有一份**。
  //    ⛔ 不要把它改成一个 `deliver()` 调用：`deliver` 只认单一通道，而本处**必须**逐分支试。
  const make = (): UserMessage =>
    toMessage(
      makeInjection({
        origin: 'acc',
        form: 'notice',
        summary: `即时消息（来自 ${sender ?? '未知'}）`,
        text: buildSendText(t, message, sender),
        delivery: 'wake-now',
      }),
    )
  // 🔴 v1.39.2（S142 §0r，所有者令「不排队、直接即时注入」）：见函数头部的语义变更说明。
  // 判据 = 宿主 agent 的 `status`（`trajectory/carrier.ts` 同款读法：`followup`/`steer` 会**同步**置 running）。
  //
  // 🔴🔴 **2026-10-21（owner 报「first-anchor 注入顺序倒了」，A96）：判据必须用「载体交到手上时」的状态，
  //    而不是「我们投完开场白之后」的状态。**
  //
  // 缺陷事实（两个独立会话实测一致）：真任务在 **turn 1** 就跑完了，而第二条 anchor 在 turn 2、
  // 开场白在 turn 3 才到 ⇒ 模型"先干活、后收到协作声明、再被要求重新锚定从头做"。
  //
  // 根因（确定性，不是竞态）：
  //   · `followup` 落 `next-turn`，**每个 turn 只认领 1 条**；
  //   · `steer` 落 `next-step`，**每个 step 边界整队认领**，而宿主 `claim()` **先取 next-step**；
  //   · 而本函数在自动建载体那条路上，**③b 已经投过开场白（followup ⇒ 同步置 running）**，
  //     ④ 才读 `agent.status` ⇒ 必然读到 running ⇒ 任务走 `steer` ⇒ 插到 anchor **前面**。
  //
  // ⇒ 修法：`createdNote !== ''` 就说明这条载体是**本次刚建出来的**（它是自动建分支唯一的赋值点）。
  //   对一条刚建出来的载体，`steer` 的语义前提（"目标在跑，把话插进当前轮"）**根本不成立** ——
  //   那个 running 只是开场白刚排队造成的假象。⇒ 一律走 `followup`，让 anchor 排在任务之前。
  //
  // ⚠️ **代价（明示，不隐瞒）**：任务从 turn 1 推到 turn 4（假① 短路 → 假② 短路 → 开场白 → 任务）。
  //   两个 turn 是短路（零 token），一个是开场白那次轻量调用。**这是"锚定先于干活"的对价。**
  const freshCarrier = createdNote !== ''
  const idle = freshCarrier || (agent as { status?: string }).status === 'idle'
  if (idle) {
    try {
      agent.followup(make())
    } catch (err) {
      return { ok: false, detail: `投递失败（${acquired.how}）: ${String((err as Error)?.message ?? err)}` }
    }
    return {
      ok: true,
      detail: `已即时投递 ${t.dirName}（${acquired.how}；${freshCarrier ? '刚建的载体 ⇒ followup 排队，锚定先于任务' : '目标空闲 ⇒ followup 立即起轮'}）${createdNote}`,
    }
  }
  try {
    agent.steer(make())
    return { ok: true, detail: `已即时注入 ${t.dirName}（${acquired.how}；目标在跑 ⇒ steer 当场注入当前轮）${createdNote}` }
  } catch (err) {
    // fail-safe：宁可排队，不可静默丢消息
    try {
      agent.followup(make())
    } catch (err2) {
      return {
        ok: false,
        detail: `投递失败（${acquired.how}）: steer 与 followup 均失败: ${String((err as Error)?.message ?? err)} / ${String((err2 as Error)?.message ?? err2)}`,
      }
    }
    return {
      ok: true,
      detail: `已投递 ${t.dirName}（${acquired.how}；steer 不可用 ⇒ 退回 followup）: ${String((err as Error)?.message ?? err)}${createdNote}`,
    }
  }
}

/**
 * 🆕 **给一条「从未被激活过」的轨迹就地建一条 dsh 会话并绑定它**（2026-10-16 owner 令，S142）。
 *
 * 何时用：**只有** `send-now` 在 `acquireWakeAgent` 报「无绑定会话记录」时（见该处的判据说明）。
 *
 * ## 🔴 2026-10-18 根治：改成**和用户操作完全同一个调用形态**
 *
 * owner 原话：「应当和用户操作唤起的会话完全一样才行」。
 *
 * 上一版（v1.62.1）传的是 `{ cwd: root }`，然后**事后补** `attachSession()` 去挂工作区。
 * 那是**补救**，不是"一样" —— 宿主里那条路径（`sessionController.create` 的
 * `if (workspace !== void 0) await workspace.attachSession(sessionId)`）**只在 `workspaceId` 分支执行**：
 *
 *   ```js
 *   if (request.workspaceId !== void 0) workspace = registry.get(request.workspaceId)
 *   const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
 *   ...
 *   if (workspace !== void 0) await workspace.attachSession(sessionId)   // ← 只有这条分支
 *   ```
 *
 * 而**用户在 UI 里新建会话传的正是 `workspaceId`**（见 `client/sessions/service.d.ts` 的
 * `create({ workspaceId?, cwd?, ... })`）⇒ 用户那条路天然会走到 `attachSession`。
 *
 * ⇒ 现在与用户**同一条分支**：先由 CCC 根查出 `workspaceId`，再用 `{ workspaceId }` 建。
 *   **`attachToWorkspace` 降级为兜底**（只在"该目录还没有工作区登记"时才会用上），
 *   不再是主路径 —— 因为主路径已经由宿主自己做完。
 *
 * ## 三步（顺序不可换）
 *   ① `sessionController.create({ workspaceId })` —— 与用户同一形态；宿主替我们挂工作区。
 *      **idempotently adopt** ⇒ 重复调用不会建出第二条（不必自造"先查再建"的竞态窗口）。
 *   ② `resolveAgent(sessionId)` —— 拿到**真 agent**。`create` 只返回 id，不给 agent。
 *   ③ `appendBound(...)` —— 落绑定。**必须由本函数写**：`listBoundSessionIds` 是
 *      `acquireWakeAgent` 的唯一选人依据，不写绑定则下一条消息**还是**找不到它
 *      （那就成了"建了但永远用不上"，比不建更坏）。
 *
 * 🔴 **为什么定位到 CCC 根这一级、不是轨迹目录**：会话的 cwd 决定它落在哪个 CCC
 *    （`cccRootForCwd` 上溯 `.serenity`）。目标轨迹本就住在该 CCC 的 `AGENT_SESSIONS/` 下
 *    ⇒ 落到 CCC 根才让它**进同一个 CCC**；落到轨迹目录会让它变成一个**不同 CCC**的会话。
 *
 * @returns 命中返回 agent 与取得方式；任一步失败返回**带原因**的 error（不静默、不误报成功）
 */
export async function createAndBindTarget(
  ctx: unknown,
  root: string,
  dirName: string,
  /**
   * 🆕 `reconstruct` 换代用（2026-11-06）：**允许顶掉该轨迹此刻仍在位的旧载体**。
   *
   * 为什么必须显式传：`claimBinding` 的「轨迹唯一」判据在旧载体**还活着**时会把无 takeover 的
   * 写入判成 `TRAJECTORY_OCCUPIED`。而 `send-now` 那条路的语义恰恰是"只在**从未有过**载体时自建"
   * （`carrierState !== 'never'` 就拒）⇒ 它**永远**不会走到"顶掉活载体"这一格，
   * 故缺省 `false` 是它的正确取值，不受影响。
   *
   * ⚠️ `reconstruct` 与 `rebuild` 是**唯二**该传 `true` 的调用方：它们都是"载体换代"这个
   * 显式声明的动作。静默换代正是"一条轨迹长出两个载体"的成因（见 `bind-file.ts` 头注）。
   */
  opts: { takeover?: boolean } = {},
): Promise<{ agent: Agent; how: string } | { error: string; notReady?: boolean }> {
  const sc = hostService<HostSessionController>(ctx, 'sessionController')
  const create = sc?.create
  if (typeof create !== 'function') {
    return {
      error:
        `目标无活跃 dsh 会话，且 sessionController.create 不可用（绑定 id: 无）` +
        `——无法就地创建载体；请先对该轨迹执行一次 cognitive_trajectory use`,
      notReady: true,
    }
  }
  // 🔴 **与用户同一条分支**：能查到工作区 id 就传 workspaceId（宿主自己挂），查不到才退回 cwd。
  const ws = findWorkspaceByPath(listWorkspaces(ctx) ?? [], root)
  const workspaceId = typeof ws?.id === 'string' && ws.id !== '' ? ws.id : undefined
  let sessionId = ''
  try {
    const out = await create.call(sc, workspaceId !== undefined ? { workspaceId } : { cwd: root })
    sessionId = String(out?.sessionId ?? '')
  } catch (err) {
    return { error: `就地创建会话失败（${dirName}）: ${String((err as Error)?.message ?? err)}` }
  }
  if (!sessionId) return { error: `就地创建会话未返回 sessionId（${dirName}）` }
  // ② 取 agent（create 只给 id；真 agent 要再解析一次，与冷载入同一条通路）
  const resolved = sc?.resolveAgent
  if (typeof resolved !== 'function') {
    return { error: `会话已建（${sessionId}）但 sessionController.resolveAgent 不可用`, notReady: true }
  }
  let agent: Agent | undefined
  try {
    const out = await resolved.call(sc, sessionId)
    agent = out?.agent
    if (!agent) return { error: `会话已建（${sessionId}）但 resolveAgent 未返回 agent: ${String(out?.error ?? '未知原因')}` }
  } catch (err) {
    return { error: `会话已建（${sessionId}）但载入失败: ${String((err as Error)?.message ?? err)}` }
  }
  // ③ 落绑定（`appendBound` 需要 `header.id` + `header.cwd`，故此处构造同形对象）
  const bound = appendBound(
    { header: { id: sessionId, cwd: root } },
    'activate',
    {
      dirName,
      mdPath: join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'),
      note: 'auto-created by send-now',
      // 🔴 布尔事实：这条载体是 ACC 以"用户开场白"形态建的（D171）。
      //    不从 `note` 文案推 —— 文案会改，判据不能长在文案上（D151 同族）。
      createdAsUser: true,
      // reconstruct 换代：顶掉仍在位的旧载体（缺省 false ⇒ send-now 语义一字不变）
      ...(opts.takeover === true ? { takeover: true } : {}),
      // 🔴 **必须传宿主存活探针**：不传 ⇒ `claimBinding` 沿用"文件在就算占用"的旧语义
      //    （保守拒绝）⇒ 换代在旧载体仍活着时**必然**被判 `TRAJECTORY_OCCUPIED`
      //    ⇒ 新会话建出来了却没绑上，而回执只显示一句 `⚠️ 绑定写入失败`。
      alive: hostAliveProbe(ctx),
    },
  )
  // ③b 🔴 **投一条"用户形态"开场白**（D171 / owner 裁 B）。
  //
  // 为什么必须做：宿主的自动命名与 `titleInput` 投影只认 `source.kind === 'user'`。
  // 不投这条 ⇒ 建出来的会话在宿主眼里**从来没有真人说过话** ⇒ 标题恒 null、
  // `titleInput.count` 恒 0（实测：用户建的 6，我们建的 0）。
  //
  // ⚠️ 顺序：必须在 `resolveAgent` 之后、**真正的那条消息之前**投。
  //    agent 此刻是新建的、没有历史 ⇒ 宿主 `agent/inbox/inserted` 会先注入假首轮，
  //    再把这条开场白排在其后（prepend 语义）⇒ 两者都成立。
  //
  // ⚠️ 失败不阻断投递：开场白是"让投影一致"的增强，拿不到就把原因写进回执，
  //    不许因此把一条能送达的消息判成失败。
  const opening = deliverCarrierOpening(
    agent as unknown as { followup?: (msg: unknown) => void },
    buildCarrierOpening(parseTrajectoryCode(dirName) ?? dirName, trajectoryDescOf(dirName)),
  )
  const openingNote = opening ? ', opening-as-user' : ', ⚠️ 开场白未投递'
  // ③c 🔴 **把标题钉成与 `use` 完全同一形态**（2026-10-21，owner 报「send-now 建的会话标题不规范」）。
  //
  // ## 为什么必须有这一步（不是锦上添花）
  //
  // ③b 投开场白**解决了"没有标题"**，却顺手制造了**"标题难看"**：
  // 宿主的自动取名器只拿到那一条开场白当素材（`messageSeqs:[465]`），
  // 于是开场白那句「`[ACC 代用户开场] 激活认知轨迹 <编码>（<职能>），接着它 SESSION.md 里的工作往下做。`」
  // 被切成 **`激活 <职能>会话`** —— 既没有轨迹编码，也没有真正的职能描述。
  // ⇒ **投开场白是"让会话有标题"的手段，而它成了唯一的取名素材**。修 bug 的动作制造了新 bug。
  //
  // ## 修法：用宿主自己的 `sessionTitle.rename`，而不是去调开场白的措辞
  //
  // 为什么不改开场白文案：那条正文有**三个用途**（人工可辨／语料排除判据／单测反向钉住，
  // 见 `user-carrier.ts` 的 `CARRIER_OPENING_MARK` 注释），为了标题去改它，
  // 会把一个**机器判据**（语料排除）绑上排版考虑 —— 判据不该长在措辞上。
  //
  // 为什么 `rename` 就够（宿主源码取证，`dsh-session-title/lib/index.js`）：
  // - `rename()` 追加 `session/title` 且 `source:{kind:'user'}`；
  // - 它先 `supersede(state, …)` ⇒ **abort 在飞的自动生成并 `delete state.pending`**；
  // - 且 `onUserMessage` 首句 `if (this.get(session)?.source.kind === "user") return`
  //   ⇒ 此后**同样不再**排自动取名。
  // ⇒ 一次 `rename` = 钉住标题，自动取名器不再改它。
  //
  // ## 🔴 标题必须与 `use` 派生的一致（D182 的判据）
  //
  // owner 的原话是「设定不应根据入口不同而有变化」⇒ **一条轨迹的标题不该因为
  // "它是被 send-now 建起来的"而与被 `use` 激活时不同**。⇒ 复用同一个纯函数
  // `namingTitleFor`（`trajectory/core.ts`），不另造第二套命名规则。
  //
  // ⚠️ 失败不阻断投递：标题是观感，把一条能送达的消息判成失败是本末倒置。
  const titleNote = renameCarrierTitle(ctx, agent, root, dirName)
  // ④ **兜底**：只在"查不到工作区 id、退回 cwd 建会话"时，才由我们自己补挂。
  //    走 `workspaceId` 分支时宿主已经挂好了（= 用户那条路），这里只是幂等确认、不产生写。
  const wsNote = workspaceId !== undefined ? '' : await attachToWorkspace(ctx, root, sessionId)
  const viaNote = workspaceId !== undefined ? ', via-workspaceId(=用户同一形态)' : ', via-cwd+attach'
  const how = `auto-create(${sessionId}${bound.ok ? ', bound' : `, ⚠️ 绑定写入失败（${bound.code}）`}${viaNote}${openingNote}${titleNote}${wsNote})`
  return { agent, how }
}

/**
 * 把刚建的载体会话标题**钉成与 `use` 同一形态**（2026-10-21，owner 报「标题不规范」）。
 *
 * ## 为什么单独成函数
 *
 * 它是**全仓第二个**写会话标题的点（第一个是 `use`/`rebuild` 的 `renameDshSessionOnUse`）。
 * 集中在一处，将来若要改命名规则，判据仍在 `namingTitleFor` 一个地方。
 *
 * ## 三者顺序不可换
 *
 * 必须在 ③b（投开场白）**之后**调用：
 * - 开场白让 `titleInput.count` > 0，是标题得以成立的前提；
 * - 放在之后还有**降级好处**：万一 `rename` 失败，宿主自己的 fallback 标题仍在
 *   （难看但存在），而不是两者皆无。
 *
 * @returns 回执片段（成功 `, titled` ／ 失败 `, ⚠️ 标题未写（原因）`）—— **必须出声**，
 *   否则"标题没写"会表现成"这条轨迹就是这名字"（D186：守卫可以拒绝，但不许不出声）。
 */
function renameCarrierTitle(
  ctx: unknown,
  agent: Agent,
  root: string,
  dirName: string,
): string {
  try {
    // 🔴 传**整个服务对象**、以方法形态调用 `titles.rename(...)`。
    //    ⛔ 绝不 `const { rename } = titles`：解构丢 `this` 是本仓踩过的坑（v1.23.2），
    //    宿主方法内部要 `this.ctx.sessions.get(...)` 校验会话是否 live。
    const titles = hostService<{ rename?: (session: unknown, title: string) => unknown }>(ctx, 'sessionTitle')
    if (!titles || typeof titles.rename !== 'function') return ', ⚠️ 标题未写（sessionTitle 不可用）'
    const session = (agent as { session?: unknown }).session
    if (!session || typeof session !== 'object') return ', ⚠️ 标题未写（无 session）'
    // 与 `use` 完全同一条派生路径（含 S### 的「编号-日期」与目录名回退）。
    const title = namingTitleFor({
      sessionId: parseTrajectoryCode(dirName) ?? dirName,
      dirName,
      mdPath: join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'),
    })
    titles.rename(session, title)
    return ', titled'
  } catch (err) {
    // 不抛：标题失败不该让一条能送达的消息判成失败。
    return `, ⚠️ 标题未写（${String((err as Error)?.message ?? err)}）`
  }
}

/**
 * 把刚建的会话挂进 **cwd 所属的那个工作区**（2026-10-17 缺陷修复）。
 *
 * 🔴 **为什么必须我们自己做（宿主源码取证，不是推断）**：
 *   `sessionController.create()` 里 `attachSession` **只在 `workspaceId` 分支执行** ——
 *   `dsh-api-session-controller/lib/index.js` 的 `create()`：
 *     ```
 *     if (request.workspaceId !== void 0) workspace = registry.get(request.workspaceId)
 *     const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
 *     ...
 *     if (workspace !== void 0) await workspace.attachSession(sessionId)   // ← 只有这条分支挂工作区
 *     ```
 *   我们传的是 `{ cwd }`（**必须如此**：`workspaceId` 与 `cwd` 互斥，而工作区 id 是宿主的内部 uuid，
 *   我们又得按"这条轨迹住在哪个 CCC"来建会话）⇒ **建出来的会话从不登记进任何工作区**。
 *
 * 🔴 **症状（现场实证，本机真实数据）**：`send-now` 自动建出的那条会话
 *   （`note` = `auto-created by send-now`）header `cwd` 确实是某个 CCC 根，
 *   **却不在**该工作区的 `sessionIds` 里
 *   （同一个 CCC 的另外两条会话都在）⇒ WebUI 里它不属于那个工作区。
 *
 * 🔴 **为什么按 `path` 找而不是"拿第一个"**：多个 CCC 并存（本机实有 5 个工作区）
 *   ⇒ 拿第一个必然挂错。判据 = `workspace.path === root`（宿主 `Workspace.path` 是
 *   **realpath 规范化**后的规范路径；`root` 已是 `cccRootForCwd` 上溯出来的真实目录，
 *   两侧同一来源，故可直接比）。
 *
 * ⚠️ **失败不阻断投递**：工作区归属影响的是"在 WebUI 里归哪个工作区"，
 *   而消息投递已经完成 ⇒ 把原因**如实写进回执**，不吞、也不把成功改成失败。
 *
 * @param ctx 插件上下文
 * @param root CCC 根（= 该会话的 cwd）
 * @param sessionId 刚建出来的会话 id
 * @returns 追加到回执里的短注记（成功/跳过为空串，失败带原因）
 */
async function attachToWorkspace(ctx: unknown, root: string, sessionId: string): Promise<string> {
  const workspaces = listWorkspaces(ctx)
  if (workspaces === undefined) return ', ⚠️ 工作区未挂载（workspaceRegistry 不可用）'
  const match = findWorkspaceByPath(workspaces, root)
  // 没有登记该目录的工作区是**正常状态**（宿主只为见过的目录建工作区）⇒ 不是错误
  if (match === undefined) return ''
  if (typeof match.attachSession !== 'function') return ', ⚠️ 工作区未挂载（attachSession 不可用）'
  // 幂等：已经在册 ⇒ 不必再写（宿主 attachSession 本身也幂等，这里只是省一次写）
  if (Array.isArray(match.sessionIds) && match.sessionIds.includes(sessionId)) return ''
  try {
    await match.attachSession(sessionId)
    return ', workspace-attached'
  } catch (err) {
    // 🔴 不吞：回执里如实报出（现场缺陷正是"静默不挂"）
    return `, ⚠️ 工作区挂载失败: ${String((err as Error)?.message ?? err)}`
  }
}

/** `workspaceRegistry.list()` 的读取收口（不可用返回 `undefined`，**与"空列表"区分**） */
function listWorkspaces(ctx: unknown): WorkspaceLike[] | undefined {
  const reg = hostService<{ list?: () => WorkspaceLike[] }>(ctx, 'workspaceRegistry')
  if (typeof reg?.list !== 'function') return undefined
  try {
    return reg.list() ?? []
  } catch {
    return undefined
  }
}

/**
 * 在 `workspaceRegistry.list()` 里找 **path 等于该 CCC 根** 的那一个。
 *
 * 🔴 **为什么要 realpath 归一（不是画蛇添足）**：宿主的 `Workspace.path` 是
 *   **`fs.realpath` 规范化**过的（`entity.d.ts` 逐字：*"Canonical directory path: the
 *   `fs.realpath` of the path given at create time (trailing slashes, `..`, and symlinks
 *   all resolved)"*）。而 `root` 来自 `cccRootForCwd` 的上溯——**上溯用的是字面路径**。
 *   ⇒ 当 CCC 根是一个**符号链接**（部署上常见：家目录/项目目录被链到别处），
 *   两侧**逐字不等**，只比字符串会**挂错或挂不上**。
 *
 * ⚠️ 归一失败（路径不存在等）时**回落字面比较** —— 不改既有语义，只是多给一次机会。
 *
 * @param workspaces registry.list() 的返回
 * @param root CCC 根
 * @returns 命中的工作区，无则 undefined
 */
function findWorkspaceByPath<T extends { path?: string }>(workspaces: readonly T[], root: string): T | undefined {
  const direct = workspaces.find((ws) => ws?.path === root)
  if (direct !== undefined) return direct
  const canonical = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const want = canonical(root)
  return workspaces.find((ws) => typeof ws?.path === 'string' && canonical(ws.path) === want)
}

/**
 * 本 tick 要扫的 CCC 根集合（**并集**）。
 *
 * C2（S142 2026-09-15 Q5）：原实现是 `collectLiveCccs`——**只认 live 会话** ⇒
 * "完全冷掉的 CCC 不能自唤醒自己"（已知边界）。现改为 `ccc-roots.listCccs` 的并集枚举
 * （工作区注册表 ∪ 持久化会话 ∪ live 会话）：**没有 live 会话的 CCC 也会被扫到**。
 *
 * ⚠️ 边界（本步**只**改"枚举哪些 CCC"，**不改**"怎么找到要交付的 agent"）：
 * 把 message 交给某条认知轨迹仍必须靠 **live 会话**解析（见本文件
 * `acquireWakeAgent`）；无 live 会话时该 CCC 只是**被扫到、
 * 无交付对象** ⇒ `deliverWake` 返回 `无绑定会话记录…`，条目回 `pending` 并留痕。
 * 因此本函数**不得**让 tick 抛错（异常一律由调用方 tick 兜住，见 `runWakeTick` 的 try）。
 * @param ctx 插件上下文
 * @returns CCC 根列表（无任何来源 → `[]`）
 */
async function collectWakeCccs(ctx: unknown): Promise<string[]> {
  return (await listCccs(ctx)).map((e) => e.root)
}

// ── CRO（Continuous Re-Occurrence · 持续再发生；设计 `docs/cro-design.md`，S142 §7.8）──
//
// 归属（所有者 2026-09-19 定）：**机制属 ACC，程序属 CCC**。本文件持有"调度"那一面：
// 每 tick 对**每条启用了 CRO 的轨迹**跑它自带的 `continuous-re-occurrence.ts`，
// 按它的判定投递。**ACC 只 spawn，从不 import** 用户的 TS（设计 §2.3 B 案）。

/**
 * CRO 唤起消息正文（**刻意不复用** {@link buildWakeText} / {@link buildSendText}）。
 *
 * 三种唤起各有自己的**事实**；混用 = 注入一条假陈述（本容器栽过：`buildSendText` 里
 * 那句"消息已入队"就是一条假陈述，见该函数注释）：
 * · `buildWakeText` —— 「**到点**了」（登记过的未来时刻，人/agent 算好的）
 * · `buildSendText` —— 「**有人此刻给我发了一条消息**」
 * · 本函数         —— 「**我自己的程序**看情况判定该叫我了」（**没有到点、也没有人发消息**）
 *
 * 🔴 `reason` 的呈现（设计 §4.2）：**程序没写就明说没写**，不留空白 ——
 * 改成程序判定后，"当时为什么叫了"**不再能从时间表重建**（原因在程序肚子里）；
 * 留空白 = 连"丢在哪一环"都看不出来。写明"未提供"至少把缺口标出来了（CCE：重建 > 保存）。
 * @param dirName 目标轨迹目录名
 * @param mdPath 目标 SESSION.md 绝对路径
 * @param prompt 程序给的唤起提示词
 * @param reason 程序给的判定理由（可为 null）
 * @returns 投递正文
 */
export function buildCroWakeText(dirName: string, mdPath: string, prompt: string, reason: string | null): string {
  /**
   * 🔴 2026-11-02 §D3（owner Q3「全砍」）：**430 → 130 码点（−70%）**。
   *
   * 砍掉的三类：
   * ① **程序文件名**（`continuous-re-occurrence.ts`）—— 目标不需要知道是哪个文件判的；
   * ② **身份锚定整句**（同 §D1）；
   * ③ 末尾`说明：这是由本轨迹自己的 CRO 程序…（不是定时唤醒，也不是别人发的消息）`——
   *    该**区分**已由 `[CRO 唤起]` **标记承担**，再用一整句解释是同一事实的第二份表述。
   *
   * 🔴🔴 **`[CRO 唤起]` 标记与"区分三种来源"不可砍**：specs 仓已把这句标记写进契约
   *    （`serenity-acc-specs` 的 CHANGELOG v3.0.0 段 ＋ 其 induction 章节），明文要求
   *    **不得与另两种措辞混用**，否则就是注入一条**假陈述**。可砍的只是标记**之后**的解释。
   *    ⚠️ 这里刻意**不写 `docs/xxx.md` 形态的路径**：本仓的 `docs-ref-gate` 会把 src 注释里
   *    任何 `docs/*.md` 当成**本仓**的文档去核存在性，而那份契约在上游 specs 仓。
   *
   * ⚠️ `dirName` / `mdPath` 参数保留（调用方按位置传，且测试要能钉住"不冒充其他来源"），
   *    但它们**不再进正文**。
   */
  void dirName
  void mdPath
  return [
    `[CRO 唤起] 本轨迹自带的 CRO 程序判定：现在该唤起。当前时间：${localHuman()}（当地时区）。`,
    '',
    `判定理由：${reason ?? '（程序未提供 reason —— 见 CRO 编写指南 §7 坑 3）'}`,
    '',
    prompt,
  ].join('\n')
}

/**
 * 投递一条 CRO 唤起（**fire-and-forget**，与 {@link deliverWake} 同层）。
 *
 * · **取用通路复用** {@link acquireWakeAgent}（live 优先 → 冷载入）：这是调度器侧唯一的
 *   "怎么把一句话送到一条轨迹"的知识 ⇒ 不另立第二条（设计 §9-2 的倾向：复用投递面）。
 * · 🔴 **不落唤醒表**（设计 §6.3）：CRO 是"**持续判定**"，不是"**某个未来时刻**"。
 *   落表会给 §0Q（投递即删、表只保在办）**增加一个新的写入源**。
 * · 用 `followup`（不用 `steer`）：CRO 由**调度器**发起，与 `send-later` 同层；
 *   `steer`（当场注入当前轮）是 `send-now` 的语义 —— 那是人类/agent 的**即时动作**。
 * · 🔴 **失败不回滚、不重试**（与条目投递不同）：下一 tick 会**重新判定**——
 *   CRO 的判据是"情况"，不是"这条消息还没送出去" ⇒ 自愈来自**重判**，不来自重投。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param dirName 目标轨迹目录名（= CRO 只能唤起**自己**，设计 §9-8 的倾向）
 * @param prompt 唤起提示词
 * @param reason 判定理由
 * @returns 投递结果（进 tick 日志；**不写注册表**）
 */
async function deliverCroWake(
  ctx: unknown,
  root: string,
  dirName: string,
  prompt: string,
  reason: string | null,
): Promise<WakeDeliveryResult> {
  const mdPath = join(sessionsRoot(root), dirName, 'SESSION.md')
  let acquired = await acquireWakeAgent(ctx, root, dirName)

  /**
   * 🔴 **载体自举（2026-10-23，guard 实测报障后补）**
   *
   * ## 缺陷（真实代价）
   *
   * 一条「**生来就是为了被自己的 CRO 叫醒**」的轨迹，**第一次自唤醒在物理上不可能**：
   * 它是程序化 `create` 出来的 ⇒ 没有载体 ⇒ `noBinding` ⇒ 投递被拒
   * ⇒ **恰恰在最需要被叫醒的那一刻没有载体可注入**。实测证据：
   * `cro-wake-log.log` 首行 `fail ... 无绑定会话记录`，而**那一轮的 CRO 判定完全正确**。
   *
   * ## 为什么可以自举，以及它与 `send-now` 的分支差在哪
   *
   * `send-now` 的自举理由是「完成一次**人/agent 的**意图」；CRO 是**每 5min 自动重判**，
   * 若照搬会有「**载体爆炸**」风险。故本路径**多一道闸**：
   *
   * - 只认 `carrierState === 'never'`（**从未有过载体**）⇒ 建一次；
   * - `occupied`（有过但那个会话不在了）⇒ **一律不建**，如实报错。
   *
   * ⇒ 自举**至多发生一次**（建完就有 `current.dsh_session_bind`，此后 `carrierState` 不再是 `never`）。
   * 这正是 `carrierState` 那道守卫的语义，与 `send-now` 共用同一条判据（不另立）。
   *
   * ⚠️ 只处理 `noBinding`；`notReady`（启动窗口）与冷载入失败**照原样返回** ——
   * 那些不是"没载体"，建新载体解决不了且可能制造第二条。
   */
  if ('error' in acquired && acquired.noBinding === true) {
    const carrier = carrierState(root, dirName, hostAliveProbe(ctx))
    if (carrier.state === 'never') {
      const created = await createAndBindTarget(ctx, root, dirName)
      if (!('error' in created)) {
        acquired = created
        console.log(
          `[serenity-hooks] CRO 载体自举：${dirName} 从未有过载体 ⇒ 已自动创建并绑定（${created.how}）`,
        )
      }
    } else {
      /**
       * 🔴 **拒绝自举时必须指名是哪一半**（D186：守卫可以拒绝，但不许不出声）。
       *
       * 若照原样把 `acquireWakeAgent` 的 `noBinding` 文案透传出去，`cro-wake-log` 里
       * 「`current.dsh_session_bind` 不存在或无有效会话」**两种状态长得一模一样**：
       *   · `never` —— 那条轨迹**生来就没有载体**（本次已自举，不会走到这里）；
       *   · `occupied` —— **有过载体、那个会话现在不在了**（本分支拒绝自建）。
       * ⇒ 读日志的人分不出"该去救那个会话"还是"该去查为什么没建起来"，
       *   而这正是本仓反复付代价的那类缺陷（D131：不靠一句话给状态命名，但**状态不同必须说出来**）。
       */
      acquired = {
        error:
          carrier.state === 'occupied'
            ? `CRO 唤起未投递：${dirName} 曾经由会话 ${carrier.sessionId} 承载，而它此刻不在了` +
              ` ⇒ **拒绝自动新建载体**（一条轨迹至多一个载体，而 CRO 每 5min 重判一次，自建会让载体反复膨胀）。\n` +
              `  · 要恢复：把那个会话救回来，或用 cognitive_trajectory rebuild 显式换代（takeover）。`
            : `CRO 唤起未投递：${dirName} 的载体声明指向会话 ${carrier.sessionId}，` +
              `它按探针**仍可用**，而选人路径却报"无绑定" ⇒ **两处读数打架，不新建载体**（先查绑定文件与归档集）。`,
      }
    }
  }

  if ('error' in acquired) return { ok: false, detail: acquired.error, notReady: acquired.notReady === true }
  try {
    // 🔴 **DII M2 · 注入点 #5**（2026-11-04）：改走 `deliver()`。
    //    `delivery:'next-turn'` ⇒ 通道由 deliver 选（followup），行为零变更。
    deliver(
      makeInjection({
        origin: 'acc',
        form: 'notice',
        summary: `CRO 唤起（${dirName}）`,
        text: buildCroWakeText(dirName, mdPath, prompt, reason),
        delivery: 'next-turn',
      }),
      acquired.agent,
    )
  } catch (err) {
    return { ok: false, detail: `CRO 投递失败（${acquired.how}）: ${String((err as Error)?.message ?? err)}` }
  }
  return { ok: true, detail: `已投递（${acquired.how}）` }
}

/**
 * CRO 阶段**受控并发**上限（2026-11-02 owner 令「整体节律 60 秒」的准入条件）。
 *
 * 🔴 为什么必须并发：CRO 每条 **spawn 一个子进程**，单条硬超时 60s（`cro/core.ts:68`）。
 *    修前 `for … await` 串行 ⇒ 最坏一拍 = N × 60s。实测 N ≥ 8（本机各 CCC 的并集，
 *    枚举走全机 CCC 并集）⇒ **最坏 480s**。
 *    节拍降到 60s 后，480s 一拍 = 积 8 拍，而拍子**排队不丢只积** ⇒ 调度器**静默永久追不上**。
 *    并发化把墙上时间从 `Σ` 降到 `max`（≈60s）。
 *
 * 🔴 为什么**不设成 8（全并发）**：
 *   · 每条是完整 `bun`/`node` 运行时（实测 `bun` 二进制 92 MB）⇒ 8 条同时起是几百 MB 尖峰；
 *   · 更危险的是**行为挤兑**：网络一恢复，8 条可能**同时**判 `wake` ⇒ 同时唤醒 8 条轨迹
 *     ⇒ 挤兑宿主模型配额。上限 4 把两者压住，仍足以把 480s 压到 2 轮 ≈120s。
 *
 * ⚠️ 调此值的判据：**保持 `ceil(N / 上限) × 单条超时 < 节拍`** 才叫"跑得完"。
 *    60s 节拍、N=8、上限 4 ⇒ 2 × 60 = 120s **仍大于 60s** ⇒ ⛔ 别以为并发调大就不需要跳拍。
 */
const CRO_CONCURRENCY = 4

/**
 * 受控并发跑一组异步任务（极小实现，**不引入依赖**）。
 *
 * 语义对齐 `Promise.allSettled`：**永不抛**，单条失败不影响其余（CRO 旁路容忍铁律）。
 * ⚠️ 结果按**原索引**回填 ⇒ 调用方按 `dirs` 顺序读时不会错配。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      results[i] = await worker(items[i]!, i)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 单条轨迹在 CRO 阶段的结局标记（**并发体内只许返回标记，不许累加计数**）。
 *
 * · `host-skip` — 机器绑定未通过（**与"跳过"分开**：它不是异常，是本机不该跑它）
 * · `wake`      — 判定唤起且已尝试投递（投递成败另记流水，见 `appendCroWakeLog`）
 * · `quiet`     — 判定不唤起（`no-wake`）
 * · `skip`      — `skipped` ／ `disabled` 竞态 ／ 内部异常
 *
 * 🔴 为什么是标记而不是计数：并发体的累加会因交错而丢／重（JS 单线程不保证回调之间不穿插），
 *    事后统一 `filter` 统计才是可复算的。这是本阶段从串行改并发时唯一必须改的语义。
 */
type CroOneOutcome = 'host-skip' | 'wake' | 'quiet' | 'skip'

/**
 * CRO 阶段：本 tick 对**每条启用了 CRO 的轨迹**跑一次它自带的程序，按判定投递。
 *
 * ## 为什么放在既有投递**之后**（R↓）
 * · 既有条目（`send-later`）**有到点承诺** ⇒ 优先级天然更高；
 * · CRO 是"看着情况叫"，**晚一拍无成本**（tick 粒度本就是 5min）；
 * · ⇒ 铁律（设计 §5）：**CRO 的任何失败都不影响既有链路** —— 整段由调用方兜住，
 *   且**每条轨迹各自 try/catch**（一条坏程序不得连累同 tick 的其它轨迹）。
 *
 * ## 日志口径（刻意与既有投递不同）
 * "每 tick × 每条轨迹"都写一行 ⇒ 对"**常态是不唤起**"的 CRO 就是刷屏。
 * ⇒ 逐条只记 **唤起**（`reason` 进日志 —— 设计 §4.2 要求可重建）与 **跳过**（异常，必须看见）；
 *   **不唤起只进汇总行**（`唤起 x，不唤起 y，跳过 z`）。
 * ⚠️ **诚实标注**：因此"某条轨迹当轮**为何没叫**"**不进 tick 日志**（它在程序肚子里）。
 *    要完整的逐次判定审计，须**程序自己**写状态文件（设计 §3.3）——ACC 给不了。
 * @param ctx 插件上下文
 * @param root CCC 根
 * @param registry 本 tick 已载入的唤醒注册表条目（供快照的 `pendingWakes`；读坏时传 `[]`）
 * @param log 本 tick 的人读摘要（就地追加）
 */
async function runCroPhase(ctx: unknown, root: string, registry: WakeEntry[], log: string[]): Promise<void> {
  // 🔴 CRO 闸（2026-09-21 所有者令新增，缺省**开**）：关掉只影响**本阶段** ——
  //    `send-later` / `send-now` / 唤醒表投递**照常**（`cro/core.ts` 头注的承诺）。
  //    跳过**记一行**（否则"关掉 CRO 后轨迹不再被自编程唤起"这件事在 tick 日志里不可见 —— 同族缺口：
  //    "为什么这轮没唤起"必须可答）。
  if (readSimpleSettings().croEnabled === false) {
    log.push('CRO 阶段：已关闭（croEnabled=false）——既有唤醒投递不受影响')
    return
  }
  let dirs: string[]
  try {
    dirs = listCroCognitiveTrajectories(root)
  } catch {
    return // 扫描失败 ⇒ 静默跳过本 tick 的 CRO（不影响既有链路）
  }
  if (dirs.length === 0) return // 常态（还没有轨迹写 CRO 程序）：代价 = 一次 readdir
  const nowMs = Date.now()
  const s = wakeSchedulerState()
  const scheduler = { armed: s.armed, enabled: s.enabled, ticks: s.ticks, lastSkipReason: s.lastSkipReason }
  const agents = hostAgents(ctx)
  // 🔴 机器绑定（所有者令 2026-10-15「**CRO 必须指定绑定机器，否则不运行，唤醒器 检查这个**」）
  //    语义 = **只许这一台（白名单）＋ fail-closed**；键 = **机器名**（owner 裁「用 hostname 吧」）。
  //    取值**一次**（非每轨迹一次）—— 本进程的机器名在本次 tick 内不会变，且 `hostname()` 有系统调用成本。
  //    ⚠️ 判定本身在 `resolveCroHostBinding`；此处只负责取本机名与计数。
  const selfHost = safeHostname()
  // 🔴 2026-11-02（owner 令「整体节律 60 秒」）：**串行 → 受控并发**。
  //    计数器**不在并发体里累加**（那会因交错而丢/重）⇒ 每层返回一个标记，事后统一统计。
  const outcomes = await mapWithConcurrency(dirs, CRO_CONCURRENCY, async (dirName): Promise<CroOneOutcome> => {
    try {
      // 🔴 绑定门**在一切读数之前**：不是本机的轨迹，连快照都不必装配
      //    （既省掉 O(N) 次 stat，也避免"读了一堆再用不上"的浪费）。
      const verdict = resolveCroHostBinding(root, dirName, selfHost)
      if (!verdict.allowed) {
        // 🔴 逐条必须留痕，且**"没绑"与"绑给别人"文案必须分开** ——
        //    2026-10-15 的 `send-now` 事故就是"文案相同、原因不同"害排查指错方向
        //    （S142 §日志 续 129 / D134）。绑定这一层不许再造同一个坑。
        log.push(`· ${root}: ${dirName}: CRO 机器绑定未通过（${verdict.code}）：${verdict.detail}`)
        return 'host-skip'
      }
      // 🔴 2026-10-20（owner 裁决）：CRO 快照同样**必须**带探针 —— 否则已归档会话
      //    会作为候选载体进 `boundSessionIds`，CRO 的"有载体在跑"判断随之失真。
      const bound = listBoundSessionIds(root, dirName, hostAliveProbe(ctx))
      // 🔴 `running ≠ live`（设计 §3.2）：running 来自 `cro-turns` 的事件夹取 + TTL 兜底
      const running = runningCarriersOf(bound, nowMs)
      const live = bound.filter((id) => Boolean(agents?.get?.(id)))
      // 本轨迹在办的唤醒条目 —— **只给摘要**（id/at/createdAt/createdBy），
      // **不给 message 正文**（设计 §9-7 的有界空间倾向：一条轨迹不该能读遍全容器）
      const pendingWakes = registry
        .filter((e) => e.state === 'pending' && resolveWakeTarget(root, e.target)?.dirName === dirName)
        .map((e) => ({ id: e.id, at: e.at, createdAt: e.createdAt, createdBy: e.createdBy }))
      const input = readCroSnapshotInput(root, dirName, nowMs, {
        boundSessionIds: bound,
        liveSessionIds: live,
        runningSessionIds: running,
        pendingWakes,
        scheduler,
      })
      const outcome = await evaluateCro(root, dirName, input)
      if (outcome.status === 'wake') {
        const res = await deliverCroWake(ctx, root, dirName, outcome.prompt, outcome.decision.reason)
        log.push(`· ${root}: ${renderCroOutcome(dirName, outcome)} → ${res.ok ? '已投递' : `投递未成功：${res.detail}`}`)
        // 🔴 ACC 侧流水（所有者令 2026-09-20「ACC 有必要进行 CRO 唤醒的日志记录」「失败成功都记录」）：
        // 落点 = **该轨迹目录**下的固定名文件（`cro/log.ts`），只留两日、写入时按窗裁剪。
        //
        // 🔴🔴 **2026-10-23 改判：`notReady` 从此也落盘**（guard 实测报障，owner 认这是最痛的点）。
        //
        // 旧注释写「`notReady` 不记（记了就是假失败）」，那半句**是对的**——
        // 它确实不是失败，**所以不能记成 `fail`**。但旧实现把"不能记成 fail"执行成了"整条不记"，
        // 于是得到的是**第三种更坏的东西：静默**。实测（guard 轨迹，真机日志）：
        //   · CRO 判定正确、`wake:true` 也发了；
        //   · 投递因 `sessionController` 未就绪而 `notReady`；
        //   · `cro-wake-log.log` **一个字都没有**（累计仍只有 1 行，来自更早的 noBinding）。
        // ⇒ 所有人看到的都是「CRO 没工作」，而真相是「CRO 工作了、投递被挡住」。
        //    **失败不可见比失败本身更坏**（D186：可以拒绝，但不许不出声）。
        //
        // ⇒ 修法 = **三态**：`ok` ／ `fail` ／ `not-ready`（`ok:false` + `notReady:true`）。
        //   不折成 `ok:true`（假成功），也不折成 `fail`（假失败）—— 这正是 `:171` 语义要的。
        // ⚠️ 另一条硬约束不变：**写流水失败绝不影响投递与既有链路**（设计 §5 铁律）。
        {
          const rec = appendCroWakeLog(
            root,
            dirName,
            {
              ok: res.ok,
              ...(res.notReady === true ? { notReady: true as const } : {}),
              detail: res.detail,
              tick: s.ticks,
              reason: outcome.decision.reason ?? null,
              prompt: outcome.prompt,
            },
            nowMs,
          )
          if (!rec.ok) {
            log.push(`· ${root}: ${dirName}: CRO 流水写入失败（已忽略，不影响投递）: ${rec.error}`)
          }
        }
        return 'wake'
      } else if (outcome.status === 'skipped') {
        log.push(`· ${root}: ${renderCroOutcome(dirName, outcome)}`)
        return 'skip'
      } else if (outcome.status === 'no-wake') {
        /**
         * 🔴 **2026-10-23（A102）：`no-wake` 也落盘。**
         *
         * 修前这里**只累加计数**、一个字都不写该轨迹的流水 ⇒ 流水**永久停在上一次真唤起处**。
         * 实测后果（guard 轨迹，真机）：它的 `cro-wake-log.log` 停在 `01:40:55`，
         * owner 据此认为"守卫从那以后就没工作过"——而真相是它**此后每个 tick 都在被评估**，
         * 只是判定为"不打扰"。⇒ **「我判了、只是不叫」与「我根本没被评估」在读数上完全一样。**
         *
         * 判据同 D209：**可以不出声地判"不打扰"，但"判过"本身要留痕**。
         * 四态：`ok` ／ `fail` ／ `not-ready` ／ `no-wake`。
         *
         * ⚠️ 与 `wake` 分支同一条硬约束：**写流水失败绝不影响投递与既有链路**（设计 §5 铁律）。
         */
        {
          const rec = appendCroWakeLog(
            root,
            dirName,
            {
              ok: false,
              noWake: true,
              detail: outcome.detail,
              tick: s.ticks,
              reason: outcome.decision.reason ?? null,
            },
            nowMs,
          )
          if (!rec.ok) {
            log.push(`· ${root}: ${dirName}: CRO 流水写入失败（已忽略，不影响既有链路）: ${rec.error}`)
          }
        }
        return 'quiet'
      }
      // `disabled`：本不该出现（`dirs` 已按"文件在"筛过）⇒ 只可能是扫描后被删的竞态 ⇒ 静默
      return 'skip'
    } catch (err) {
      log.push(`· ${root}: ${dirName}: CRO 内部异常（已忽略，不影响既有链路）: ${String((err as Error)?.message ?? err)}`)
      return 'skip'
    }
  })
  // 🔴 统计在**并发结束之后**做（并发体内累加会因交错而丢/重，见上方注释）
  const hostSkips = outcomes.filter((o) => o === 'host-skip').length
  const wakes = outcomes.filter((o) => o === 'wake').length
  const quiet = outcomes.filter((o) => o === 'quiet').length
  const skips = outcomes.filter((o) => o === 'skip').length
  log.push(
    `· ${root}: CRO 评估 ${dirs.length} 条（唤起 ${wakes}，不唤起 ${quiet}，跳过 ${skips}` +
      `${hostSkips > 0 ? `，非本机绑定 ${hostSkips}` : ''}；并发上限 ${CRO_CONCURRENCY}）`,
  )
}

/**
 * 取本机机器名（**永不抛**）。
 *
 * `os.hostname()` 理论上可能抛（极少数环境）⇒ 这里兜底成空串。
 * ⚠️ **空串的后果是"全部不通过"**（`bound === self` 永不成立）⇒ 即 **fail-closed**，
 * 与所有者裁定同向（宁可都不跑，也不会"名字取不到就随便跑"）。
 * @returns 本机机器名；取不到 ⇒ `''`
 */
function safeHostname(): string {
  try {
    return hostname()
  } catch {
    return ''
  }
}

/** 一次调度 tick：遍历已知 CCC → 到期项串行投递 / 超窗项置 missed；返回人读摘要 */
async function runWakeTick(ctx: unknown): Promise<string[]> {
  const log: string[] = []
  // 无 CCC 可扫：廉价空转（**不**改变"全局闸开即武装"的语义：武装在 startTimer，
  // 与有无 CCC 无关；此处只是本 tick 无事可做）
  const roots = await collectWakeCccs(ctx).catch((): string[] => [])
  if (roots.length === 0) {
    clock.noteSkipReason('无已知 CCC 可扫（等某个会话/工作区出现）')
    return log
  }
  clock.noteSkipReason(null)
  for (const root of roots) {
    // 🔴 存量清理（owner 2026-09-19 裁「直接删」，S142 §0Q 甲案）：
    //   本版上线前表里积压了 143+ 条**终态**记录（308 KB）。只改行为不清存量 ⇒ 文件不再涨但仍臃肿。
    //   **幂等**（无终态时空转不写盘）⇒ 放在每 tick 开头，天然自愈；不依赖"跑一次迁移"。
    const purged = purgeFinalizedWakes(root)
    if (purged.ok && purged.purged > 0) {
      log.push(`· ${root}: 清除 ${purged.purged} 条已结案记录（存量首清）`)
    }
    const { registry, error } = loadWakeRegistry(root)
    if (error) {
      log.push(`✗ ${root}: ${error}`)
      // 🔴 注册表读坏**不连带停掉 CRO**（两者是**并列**的唤起来源，设计 §6.2）：
      //   以空表（= "无在办条目"）继续 CRO 阶段，否则一个坏 JSON 会让 CRO 也一起静默。
      await runCroPhase(ctx, root, [], log)
      continue
    }
    const { due, expired } = splitDueWakes(registry, Date.now(), WAKE_CATCH_UP_MS)
    for (const e of expired) {
      // 🔴 owner 2026-09-19 裁「直接删」（S142 §0Q 甲案）：超窗 = 已结案 ⇒ **写终态后同一笔事务删掉**
      //    （原实现只置 `missed` 而**永不删** ⇒ 本表只增到 308 KB）。
      finalizeWake(root, e.id, 'missed', `超过补跑窗口（${WAKE_CATCH_UP_MS / 3_600_000}h）未投递`)
      log.push(`· ${root}: ${e.id} → missed（超补跑窗口，已清除）`)
    }
    // 串行投递：同 tick 多目标依次进行（防模型并发挤兑）——fire-and-forget 指不等结果，不是并行
    for (const e of due) {
      const res = await deliverWake(ctx, root, e)
      // 🔴 环境未就绪（`notReady`）**不计入条目**（2026-09-17 实测缺陷修复，S142 §0t）：
      //   不改 state、不动 attempts、**不写 lastResult**——因为这条"结果"不是投递的结果，
      //   而是"这次没轮到投递"。典型场景：`dsh web` 刚重启，启动那一拍跑在懒服务
      //   `sessionController` 就绪**之前** ⇒ 旧实现每次重启都给"到点条目"盖一条假失败，
      //   制造假告警（消息其实一个都没丢，下个 tick 就投成功了）。
      //   代价 = 该条目在本 tick 无痕迹；但**不丢信息**：真正超窗的条目仍由上面的
      //   `expired` 分支落 `missed` 留痕（那是**时间**判据，与「试过几次」无关）。
      if (res.notReady) {
        log.push(`· ${root}: ${e.id} → 跳过（宿主服务未就绪，下个 tick 再试；不计失败）`)
        continue
      }
      if (res.ok) {
        // 🔴 owner 2026-09-19 裁「直接删」：投递成功 = 结案 ⇒ 同一笔事务写终态 + 移除。
        //    审计由 SESSION.md / 工具输出承担（`wake/registry.ts` 既有注释承诺，本次做实）。
        finalizeWake(root, e.id, 'delivered', res.detail)
        log.push(`· ${root}: ${e.id} → delivered（已清除）`)
      } else {
        // 失败 ⇒ **仍在办**：保留行、记 attempts 与原因（不能删——否则等于静默丢唤醒）
        updateWake(root, e.id, { state: 'pending', attempts: e.attempts + 1, lastResult: res.detail })
        log.push(`· ${root}: ${e.id} → 重试（${res.detail}）`)
      }
    }
    // CRO 阶段（设计 §6.1：执行者 = 本调度器）：既有投递**之后**（见 `runCroPhase` 的排序理由）
    await runCroPhase(ctx, root, registry.entries, log)
    // 🔴 A104-C′：容器级中断兜底（**在所有轨迹级唤起来源之后**跑）
    //    —— 这样"某条轨迹已经叫过并恢复了"的会话，在扫描时已带 `turn/start` ⇒ 天然不重复。
    await runInterruptedSafetyNet(ctx, root, log)
  }
  return log
}

/**
 * 🔴🔴 **A104-C′（2026-10-23，owner 点头）：容器级「被重启打断的会话」兜底 —— 每 tick 扫一次并注入。**
 *
 * ## 为什么必须做（不是"多一层保险"，是**已有实测盲窗**）
 *
 * 2026-10-23 实测：`08:02` 一次 `restart-web` 打断了一个会话，此后 **13 分钟无人拉起**。
 * 用真回放（把日志截到争议时刻 ＋ 重压 zstd 帧 ＋ 同一份实现）验证：
 *  - 截到 `08:07:30`／`08:12:40` ⇒ **两次都能判出该会话 `turn/end[interrupted]` 且其后无新 `turn/start`**
 *  - 而那两个 tick **实际都没有叫** ⇒ **判据没错，是"没有被跑起来"**
 *
 * ⇒ 结论：**「守护程序自己修好」≠「一定有人拉起」**。任何单条 CRO 轨迹都可能因为
 *    自身在跑、绑定缺失、阈值保护、程序 bug 而漏掉 —— 而被打断的会话**不会自己恢复**。
 * ⇒ 兜底必须放在**容器自己**身上，且必须**自己完成"发现 + 注入"**（只扫不动没有用）。
 *
 * ## 边界（写在这里免得后人扩大它）
 *
 * - ⚠️ **这会真的起 agent、真烧算力** —— owner 已被告知并点头（2026-10-23）。
 * - 🔴 **必须排除 live 会话**：正在跑的会话不该被再注入一次（否则重复投递）。
 * - 🔴 **与 CRO 并存、不替代**：CRO 是**轨迹自己的策略**（何时该叫由它判），
 *   本兜底只覆盖「**无论谁都没叫**」这一格。两者重复命中时，靠 `live` 排除天然去重。
 * - ⚠️ **本函数任何失败都不得连累既有链路**（设计 §5 铁律）：整体 try/catch 吞掉并留一行日志。
 */
async function runInterruptedSafetyNet(ctx: unknown, root: string, log: string[]): Promise<void> {
  // 🔴 **A106：本拍编号 —— 必须先取，且要分清是哪一种拍**
  //
  // `wakeSchedulerState().ticks` = **已完成**拍数（工厂在 body 之后记账）⇒ 此刻是第 `ticks+1` 拍。
  // ⚠️ 这与 guard 程序自己记的 `tick`（当前拍，1-based）**是同一个口径**，别混：
  //    ACC 的 `cro-wake-log.log` 里 `tick=` 记的是 `ticks`（0-based 已完成数），
  //    于是**同一事件在两处差 1** —— 这是历史事实（见 D226 的配套），本次不改格式，
  //    只在兜底的日志里**把两者都写出来**（`tick=N(当前第 N+1 拍)`），让读的人不必自己换算。
  const s0 = wakeSchedulerState()
  const tickNow = s0.ticks + 1
  // "刚启动窗口"= 第 2~3 拍（与 CRO 触发器同口径）；用来标注这行日志属于哪一种拍。
  const phase = tickNow <= 1 ? '启动首拍' : tickNow <= 3 ? '刚启动窗口' : '常规 tick'
  const tickTag = `tick=${s0.ticks}(当前第${tickNow}拍·${phase})`

  try {
    const agents = hostAgents(ctx) as { get?: (id: string) => unknown } | undefined
    const sc = hostService<{
      resolveAgent?: (id: string) => Promise<{ agent?: unknown; error?: string }>
    }>(ctx, 'sessionController')

    /**
     * 🔴 **A105：live 排除的粒度 =「此刻有没有在跑」，不是「宿主认不认识它」。**
     *
     * 修前：`collectLiveSessionIdsForSafetyNet` 取的是 `hostSessions(ctx).list()`
     * ⇒ 那是**载入状态**（会话对象在本进程里），**不是**轮次状态 ⇒
     * 一条「已载入、但上一轮被重启打断」的会话会被**误排除**，
     * 而那恰恰是**最该被接走**的一类（2026-10-23 实测：这正是那次 13 分钟盲窗的形状）。
     *
     * ⇒ 现在与权威 `interrupted` 动作**用同一个取数口**（`listRunningSessionIds`），
     *   两处对"在跑"的认知**不可能再不一致**（A105 的全部目的就是这一条）。
     */
    const liveIds = new Set<string>(listRunningSessionIds(Date.now()))

    const projectDir = `${sessionsRootDir()}/${projectDirNameForCwd(root)}`
    const scan = scanInterruptedSessions(projectDir, { liveIds })

    /**
     * 🔴 **A106：无命中也要出声**（`ok`/`fail`/`not-ready`/`no-wake` 之后缺的第五格）。
     *
     * 修前这里 `return`，**一行都不写** ⇒ 宿主日志里没有任何「中断兜底」字样 ⇒
     * **「我扫了、没东西」与「我没被跑」在读数上完全一样**（D216 同族第四次）。
     * ⇒ 判据同 A102：**可以不出声地判"没事"，但"判过"本身要留痕**。
     * ⚠️ 密度很低（每 tick 一行，5min 一次），且**必须带拍号与扫描读数**，
     *   否则又是一堆分不清是哪一拍的日志行（guard 明确要求）。
     */
    if (scan.sessions.length === 0) {
      log.push(
        `· ${root}: 中断兜底 ${tickTag} → 扫 ${scan.scanned} 个 · 命中 0` +
          ` · 排除在跑 ${liveIds.size} 个 · 跳过 ${scan.skipped} ⇒ 无需注入`,
      )
      return
    }

    const resumeOne = createResumeOne({
      agents,
      sessionController: sc,
      // 🔴 **DII M2 · 注入点 #14**（2026-11-04）：工厂里改走 `toMessage(makeInjection(...))`。
      //    ⚠️ **通道不在这里选** —— 本工厂只负责"造消息"，真正选 steer/followup 的是
      //    `createResumeOne` 内部（它有"steer 优先、失败退回 followup"的逻辑）。
      //    ⇒ 这正是 I3 的实例：同一个 `delivery` 意图在不同分支落不同通道。
      makeMessage: (text) =>
        toMessage(
          makeInjection({
            origin: 'acc',
            form: 'notice',
            summary: '中断兜底继续',
            text,
            delivery: 'wake-now',
          }),
        ),
    })

    log.push(
      `· ${root}: 中断兜底 ${tickTag} → 扫 ${scan.scanned} 个 · 命中 ${scan.sessions.length}` +
        ` · 排除在跑 ${liveIds.size} 个`,
    )
    for (const hit of scan.sessions) {
      try {
        const out = await resumeOne(hit)
        log.push(
          `· ${root}: 中断兜底 ${hit.sessionId}（turn ${hit.turn ?? '?'}）→ ` +
            (out.ok ? `已注入（${out.how ?? '?'}）` : `未注入：${out.error ?? '未知'}`),
        )
      } catch (err) {
        log.push(`· ${root}: 中断兜底 ${hit.sessionId} 注入抛错（已忽略）：${String((err as Error)?.message ?? err)}`)
      }
    }
  } catch (err) {
    log.push(`· ${root}: 中断兜底 ${tickTag} 整体失败（已忽略，不影响既有链路）：${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * ⚠️ **2026-10-23 A105 已删除 `collectLiveSessionIdsForSafetyNet`。**
 *
 * 它取的是 `hostSessions(ctx).list()` =「宿主认不认识」，而 A105 的结论是
 * 判据必须是「**此刻有没有在跑**」。现在两处（本兜底与权威 `interrupted` 动作）
 * 都走 `listRunningSessionIds()` —— **同一张表、同一个口径**，不可能再打架。
 *
 * 🔴 后人若要"把 live 表也加回来做双保险"：**不要** ——
 *    `live ∧ ¬running` 恰是「已载入、但上一轮被打断」那一类，**它最该被接走**；
 *    加回来就是把最该救的那一格重新排除掉。
 */

/**
 * 装配调度器（index.ts apply 调用）：5min tick + 生命周期 disposer +
 * 会话出现/settings 变化时热启动（与 autopilot 同款触发面，互不干扰）。
 * @param ctx 插件上下文
 */
export function registerWakeScheduler(ctx: unknown): void {
  // ⚠️ 此处**不得**再判"有无 live CCC"（F 段缺陷修复，2026-09-14）：
  //   CCC 根当时**只能从 live 会话的 cwd 反推**（collectLiveCccs），而宿主刚重启时 live 会话
  //   必然为空（浏览器尚未重连）；更关键的是——**"恢复旧会话"不触发 `session/created`**
  //   （只有**新建**会话才触发），所以启动瞬间的这一次判定一旦落空，时钟就**永久不武装**，
  //   要等人类**新建**一个会话才恢复。
  //   实测证据（2026-09-14）：16:30Z 重启 → 次日 23:13Z 查得注册表条目超窗 6.6h 仍为
  //   `pending` / `attempts=0`（真跑过 tick 的条目必为 delivered 或 missed）⇒ 6.6h 零 tick。
  //   现改为「**全局闸开即武装**」：定时器恒在，每 tick 自行判定（无可扫 CCC 时廉价跳过）。
  //   代价 = 一个 unref 的 5min 空检查，远小于"时钟静默"的代价。
  //   🔒 C2（2026-09-15）**不许回退**这一条：源侧的"无 live 会话"已由并集枚举（ccc-roots）
  //   消掉一部分，但**武装门本身必须继续只判全局闸**——否则"恢复旧会话不触发事件"那条
  //   路径会再次让时钟永不武装。武装与"本次有无目标"是两件事，不得耦合。
  //   🔒 C6b（2026-09-15）该门已收进 `clock-runtime.createClock` 的 `start()`（硬约束二）。
  //   🔴 2026-09-21 更新：本钟**已不传 `gate`** —— `wakeSchedulerEnabled` 被砍 ⇒ **无闸恒武装**；
  //      上面那条"武装门只判全局闸"的原则因此**自动满足**（没有闸可判），但**理由不变**：
  //      武装**不得**与"本次有无目标"耦合。⚠️ CRO 的 `croEnabled` 是**另一层**（在 `runCroPhase`
  //      入口，不在时钟武装门）——**不得**混进本门。
  //   ⚠️ 同一条链上的另一条约束：tick **不预判"有无 CCC"**（C2 起 CCC 枚举为**并集**），
  //      "无 CCC 可扫"的廉价跳过下沉到 runWakeTick 内部并写 lastSkipReason 供 acc-diag 判读。
  clockOpts.ctx = ctx
  clock.start()
  registerDisposer(ctx, '认知轨迹唤醒调度器', () => clock.dispose())
}
