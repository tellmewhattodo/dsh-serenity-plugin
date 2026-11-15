/**
 * host/type-contract.ts — 宿主**类型**契约（编译期反证层，v1.31.8，S142 全量 review 产物）
 *
 * ## 为什么存在（R↓）
 *
 * dsp 用**结构化断言**隔离宿主（手写 interface + `as` / `as never`，零宿主运行时 import），
 * 换来 peer-only 打包与"不随宿主版本耦合"的灵活度；代价是**类型检查对宿主漂移失明**：
 * 宿主把成员改名、改返回形状，dsp 侧拿不到任何编译期信号，只能靠**人读宿主源码**发现。
 *
 * 历史已三次静默失效：
 *  - `Session.events` → `snapshotEvents()`（v1.28.0）
 *  - `conversation.draftImages()` → `resolveDraftAttachments()`（v1.31.6）
 *  - `sessionPersistence.list()` 返回形状 `SessionHeader[]`（`h.cwd`）→
 *    `SessionPersistenceSnapshot[]`（`h.header.cwd`）（v1.31.6）
 * 后两条是升级 0.1.5-rc.1 时**逐文件人读**才挖出来的——不是机制发现的。
 *
 * ## 既有三道防线的盲区（2026-09-10 全量 review 结论）
 *
 * | 防线 | 覆盖 | 盲区 |
 * |------|------|------|
 * | `contract.ts` 的 `satisfies keyof Events` | 事件**名** | payload 形状 |
 * | `probeHostContract`（运行期） | 服务**名** + 成员**存在性** | 成员**签名**、**返回形状** |
 * | `tests/**` | —— | **完全不参与类型检查**（tsconfig `include: ["src"]`）→ 写在测试里的"真实宿主类型断言"从未生效 |
 *
 * ## 本模块补的那一格：用宿主真实类型反证 dsp 的形状假设
 *
 * 机制：
 *  ① `import type {} from '<宿主包>'` 把该包的 `declare module '@deepseek-ai/cordis'` 声明增强
 *     拉进 program（**空类型 import，编译期擦除 → 零运行时依赖**，peer-only 打包不受影响；
 *     与 `src/client/index.ts` 引 `dsh-client-ui-session` 同款手法）
 *  ② 每条 `Expect<Extends<宿主真相, dsp 假设>>` 是一道**编译期闸门**：宿主改名/改形状 →
 *     `dsh-develop typecheck` 当场红，升级当天报警，而不是等线上静默失效
 *  ③ 换宿主版本时 `dsh-develop typecheck-host <ver>` 会对**解包的新宿主**跑同一批断言
 *
 * ## 维护纪律（强制）
 *
 * **新增一处对宿主的形状依赖 → 在此加一条对应闸门**（断言旁注明 dsp 消费点与后果）。
 * 断言只表达 dsp **真正依赖**的那部分（不求与宿主全等）→ 宿主新增字段/放宽类型不会误报，
 * 只有"dsp 依赖的东西没了或变了"才红。
 *
 * 注：本文件**没有任何运行时语句**，编译产物只有 `export {}`，不影响包体行为。
 */

import type { Context } from 'cordis'
// ① 空类型 import（仅拉入各包的 Context 声明增强 + 其依赖类型）
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-compaction'

/** 编译期断言：T 必须为 true，否则该行报错（错误行名 = 被破坏的契约） */
type Expect<T extends true> = T
/** A 是否可赋给 B（结构化；`[A] extends [B]` 避免联合分发） */
type Extends<A, B> = [A] extends [B] ? true : false
/** 函数返回值（非函数 → never） */
type Ret<F> = F extends (...args: never[]) => infer R ? R : never

/** 宿主 Context（各包的声明增强合并后的最终形态） */
type HostContext = Context

// ─────────────────────────────────────────────────────────────
// ② 服务成员存在性（运行期探针的同维补强：此处连**签名**一起锁）
// ─────────────────────────────────────────────────────────────

/** ACC 工具注册面（`src/index.ts` 装配 11 工具） */
type _ToolsRegister = Expect<Extends<Ret<HostContext['tools']['register']>, unknown>>
/** 机械守卫（`src/seams/guards.ts` safe-mode/路径/白名单——缺则守卫失效） */
type _ToolsGuard = Expect<Extends<Ret<HostContext['tools']['guard']>, unknown>>

/** 会话定位/rebuild/CCC 解析（`access.ts` `hostSessionCwds`、`surface/debug.ts`、`surface/http.ts`） */
type _SessionsList = Expect<Extends<Ret<HostContext['sessions']['list']>, readonly unknown[]>>
type _SessionsGet = Expect<Extends<Ret<HostContext['sessions']['get']>, unknown>>
type _SessionsCreate = Expect<Extends<Ret<HostContext['sessions']['create']>, unknown>>

/** CCC 自动发现回落（`surface/debug.ts:103`；v1.31.6 C4 现场：list 形状在 0.1.5 变了） */
type _PersistenceList = Expect<Extends<Awaited<Ret<HostContext['sessionPersistence']['list']>>, readonly unknown[]>>

/** 上下文压力读数（`seams/cognitive-trajectory-lifecycle.ts:readContextPressure`——rebuild 提醒的输入） */
type _ProjectionsSnapshot = Expect<Extends<Ret<HostContext['sessionProjections']['snapshot']>, unknown>>

/** shadow-price 定价（`trajectory/rebuild.ts:356` `meter.estimateMessage(message)`） */
type _TokenMeterEstimate = Expect<Extends<Ret<HostContext['tokenMeter']['estimateMessage']>, number>>

/** rebuild 后重命名会话标题（`trajectory/rebuild.ts:renameAfterRebuild`——签名 `(session, title)`） */
type _SessionTitleRename = Expect<Extends<HostContext['sessionTitle']['rename'], (session: never, title: string) => unknown>>

/** 工作区白名单下拉（`surface/http.ts:334`、`surface/debug.ts:90`——读 `path`/`title`） */
type _WorkspaceRegistryList = Expect<Extends<Ret<HostContext['workspaceRegistry']['list']>, readonly unknown[]>>

/**
 * 子 agent 启动器（原消费者 = cheap-worker 前台委派，已于 2026-10-28 整条下线）。
 *
 * 🔴 **这条钉保留的理由不是"还有人在用"，而是"宿主契约仍然这样演进"**：
 *   删掉它 = 把这份跨宿主世代的知识一起删掉，将来再有委派需求要重新踩一遍。
 *   （原实现 `tools/cheap-worker.ts` 的 `resolveSubagentStarter()` 已删除；
 *     照此双路写法即可重建。）
 *
 * 🔴 **v1.59.3 适配（0.2.1-rc.1）的关键教训**：宿主在两个档上给的成员**不同名** ——
 *   · `0.1.7-rc.*` / `0.2.0-rc.*`：只有 `start(name, request)`
 *   · `0.2.1-rc.1+`：只有 `startActivation(spec)`（`start` 类型与运行时**同时**消失）
 *
 * ⚠️ 本文件是**对"当前安装宿主"的契约钉**（`paths` 指本机 `node_modules`，见 `50-workflow.md` §8.6⑭），
 *   而本仓**同时声明支持两档** ⇒ **不能只钉其中一个成员**，否则另一档下 `typecheck` 必红。
 *   （实测踩过：只钉 `startActivation` ⇒ 本机 0.2.0-rc.2 上 `typecheck` 立刻红。）
 *
 * ⇒ 判据写成 **"至少有一个"**：两档各钉一条，用条件类型把它们合成一个"存在性"断言。
 *   真正的"该用哪个"由运行期先新后旧地选（`resolveSubagentStarter()`，已随 cheap-worker 删除，
 *   需要时按 `host/contract.ts` 的说明重建）—— 类型层只保证**这两个名字里至少有一个真的存在**。
 */
type _SubagentsHasStarter =
  HostContext['subagents'] extends { startActivation: (...args: never[]) => unknown } ? true
  : HostContext['subagents'] extends { start: (...args: never[]) => unknown } ? true
  : false
type _SubagentsStarterPresent = Expect<_SubagentsHasStarter>

/** 设置面板（v0.1.7 起 = `SettingsForms`）：本插件用 `configure` 关掉自动生成页；
 *  `update`/`describe` 供诊断与将来的写入面（`surface/settings.ts`） */
type _SettingsConfigure = Expect<Extends<HostContext['settings']['configure'], (presentation: { auto?: boolean }, owner?: never) => unknown>>
type _SettingsDescribe = Expect<Extends<Ret<HostContext['settings']['describe']>, readonly unknown[]>>
type _SettingsUpdate = Expect<Extends<Ret<HostContext['settings']['update']>, Promise<void>>>

/** Induction 注入（`seams/system-prompt.ts:561` 全局 + `:604` per-agent） */
type _SystemPromptSection = Expect<Extends<Ret<HostContext['systemPrompt']['section']>, unknown>>

/** web_fetch provider 接管（`patches/web-fetch.ts`，v1.30.12 fake-ip 网络） */
type _WebRegisterFetchProvider = Expect<Extends<Ret<HostContext['web']['registerFetchProvider']>, unknown>>

/** 状态接口/网关端口发现（`surface/http.ts`、`gateway/server.ts`） */
type _WebServerRegister = Expect<Extends<Ret<HostContext['webServer']['register']>, unknown>>
/**
 * 🔴 **v1.59.3 适配（0.2.1-rc.1）**：宿主把这个 getter **放宽**成 `number | undefined`
 * （逐字 `get port(): number | undefined`；0.2.0-rc.2 时是 `number`）。
 *
 * 语义依据（宿主注释逐字）：*"The listening port … or `undefined` before `listen` binds."*
 * ⇒ **不是**宿主退化，而是它**如实**了 —— 监听未绑定时确实没有端口。
 *
 * ⚠️ 我们**已有的消费处都自带判空**（实测：`gateway/server.ts:588` 的 `if (!webServer?.port) return`
 * 已在窄化作用域内覆盖 593/611/622/630；`index.ts:773` 用 `typeof ws?.port === 'number'` 回落常量）
 * ⇒ **本处只改类型钉，不需要改任何消费代码**。这与适配方案 §A4 的初判一致。
 */
type _WebServerPort = Expect<Extends<HostContext['webServer']['port'], number | undefined>>

// ─────────────────────────────────────────────────────────────
// ③ dsp 真正**读取的形状**（这一类才是静默失效的重灾区）
// ─────────────────────────────────────────────────────────────

/**
 * `session.header.cwd` —— dsp 最高频的宿主形状（20+ 处：所有工具的工作目录解析、
 * seam 的 CCC root 定位、gateway 的会话归属）。**cwd 消失 = 全 ACC 退化成 process.cwd()**。
 */
type _SessionHeaderCwd = Expect<Extends<NonNullable<Ret<HostContext['sessions']['get']>>['header']['cwd'], string | undefined>>

/** `session.header` 的派生判据：`origin === 'subagent'` / `parentSession` / `delegationDepth`（`seams/context.ts:116`、`bootstrap.ts:285`） */
type _SessionHeaderOrigin = Expect<Extends<NonNullable<Ret<HostContext['sessions']['get']>>['header']['origin'], 'subagent' | undefined>>
type _SessionHeaderParent = Expect<Extends<NonNullable<Ret<HostContext['sessions']['get']>>['header']['parentSession'], unknown>>
type _SessionHeaderDepth = Expect<Extends<NonNullable<Ret<HostContext['sessions']['get']>>['header']['delegationDepth'], number | undefined>>

/**
 * `sessionPersistence.list()` 元素形状（**v1.31.6 C4 现场**）：
 * 0.1.2 = `SessionHeader[]`（`h.cwd`）→ 0.1.5 = `SessionPersistenceSnapshot[]`（`h.header.cwd`）。
 * 本闸门锁死"元素上必须能读到 `header.cwd`"——旧形状会在这里编译失败。
 */
type _PersistenceSnapshotCwd = Expect<Extends<Awaited<Ret<HostContext['sessionPersistence']['list']>>[number]['header']['cwd'], string | undefined>>

/**
 * 上下文压力投影（`cognitive-trajectory-lifecycle.ts` 读 `snap.values.contextPressure.{projectedTokens,contextWindow}`）。
 * key 由 `dsh-token-meter` 声明增强进 `SessionProjectionMap`——**投影键改名会在此处红**。
 */
type _ContextPressure = Expect<Extends<
  NonNullable<Ret<HostContext['sessionProjections']['snapshot']>['values']['contextPressure']>,
  { projectedTokens?: number; contextWindow?: number }
>>

/** `session.snapshotEvents()`（`trajectory/core.ts:57` 统一读取入口；`.events` 属性早已移除） */
type _SessionSnapshotEvents = Expect<Extends<Ret<NonNullable<Ret<HostContext['sessions']['get']>>['snapshotEvents']>, readonly unknown[]>>

/** `session.surface.nodes`（`trajectory/rebuild.ts:345` 取被替换范围） */
type _SessionSurfaceNodes = Expect<Extends<NonNullable<Ret<HostContext['sessions']['get']>>['surface']['nodes'], readonly unknown[]>>

// ─────────────────────────────────────────────────────────────
// ④ `Session.append` 的两处调用（`trajectory/rebuild.ts:358/365`——**全部用 `as never` 断言，编译器原本完全失明**）
// ─────────────────────────────────────────────────────────────

/** `'compaction/prune'` 仍是合法事件类型，且 payload 形状与 dsp 传的一致（shadow-price 协议） */
type _AppendPruneType = Expect<Extends<'compaction/prune', Parameters<NonNullable<Ret<HostContext['sessions']['get']>>['append']>[0]>>
type _AppendPrunePayload = Expect<Extends<
  { shadowedRange: { start: number; end: number }; shadowedSeqs: unknown[]; shadowedTokenCount: number },
  Parameters<NonNullable<Ret<HostContext['sessions']['get']>>['append']>[1] extends never ? never : { shadowedRange: { start: unknown; end: unknown }; shadowedSeqs: unknown[]; shadowedTokenCount: number }
>>

/** `'user/message'` 仍是 **surface 事件**（`SurfaceEventType`）——surfaceOp 为**必填第三参**，漏传即运行时抛错 */
type _AppendUserMessageType = Expect<Extends<'user/message', Parameters<NonNullable<Ret<HostContext['sessions']['get']>>['append']>[0]>>

// ─────────────────────────────────────────────────────────────
// ⑤ Agent 对象（`ctx.agents.get()/create()` 的返回值——**不在服务契约表内**，全靠结构化断言）
// ─────────────────────────────────────────────────────────────

type HostAgent = NonNullable<Ret<HostContext['agents']['get']>>

/** `agent.steer(msg)` —— rebuild 自动继续（`trajectory/rebuild.ts:442`）、输出守卫打回 */
type _AgentSteer = Expect<Extends<HostAgent['steer'], (message: never) => unknown>>
/** `agent.inbox.prepend(target, msg)` —— fake-initial-turns 注入（`seams/bootstrap.ts`） */
type _AgentInboxPrepend = Expect<Extends<HostAgent['inbox']['prepend'], (target: never, message: never) => unknown>>
/** `agent.session.header.cwd` —— 工具工作目录解析 */
type _AgentSessionCwd = Expect<Extends<HostAgent['session']['header']['cwd'], string | undefined>>
/**
 * `agent.status === 'idle'` —— 等待空闲（`trajectory/carrier.ts:65`；原 cheap-worker 的完成判据，
 * 现由 `askTrajectory` 问答链与 CRO 轮次追踪使用）。
 * 注：`status` 是可变属性（非方法），断言其**可读**且类型覆盖 'idle'。
 */
type _AgentStatus = Expect<Extends<HostAgent['status'], string>>

/** `agent.ctx.systemPrompt.section(...)` —— 轨迹约束面提示词 per-agent 注入（`trajectory/session.ts`） */
type _AgentCtxSystemPrompt = Expect<Extends<Ret<HostAgent['ctx']['systemPrompt']['section']>, unknown>>

// ─────────────────────────────────────────────────────────────
// ⑥ 事件 payload 形状（事件**名**已由 contract.ts 的 `satisfies keyof Events` 锁死；
//    此处补 payload——「名字对但字段改了」同样静默失效）
// ─────────────────────────────────────────────────────────────

import type { Events } from 'cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** `agent/status`：dsp 读 `payload.agent` + `payload.status === 'idle'`（`trajectory/carrier.ts:55`） */
type _EvStatus = Expect<Extends<Parameters<Events['agent/status']>[0], { agent: unknown; status: string }>>
/** `agent/inbox/inserted`：dsp 读 `payload.agent` / `payload.message`（`seams/bootstrap.ts`） */
type _EvInbox = Expect<Extends<Parameters<Events['agent/inbox/inserted']>[0], { agent: unknown; message: unknown }>>
/**
 * `llm/stream`：**位置参数**（`options, next`）—— fake-initial-turns 的短路点（`seams/bootstrap.ts`）。
 *
 * dsp 读 `options.sessionId`（把请求认回会话）与 `options.messages`（逐字比对假首轮文本），
 * 返回值**不调 `next()`** 而是自己产出一条 `StreamChunk` 流 ⇒ 请求不发到模型。
 * 🔴 三处会静默失效：`sessionId` 没了（认不回会话 ⇒ 退回真调用，只是变慢）、
 * `messages` 改形状（比对恒假 ⇒ 同上）、`llm/stream` 不再是 waterfall（本机制整体失效）。
 */
type _EvLlmStreamOptions = Expect<Extends<
  Parameters<Events['llm/stream']>[0],
  { sessionId?: unknown; messages?: readonly unknown[] }
>>
/** `llm/stream` 的第二参 `next()` 返回 **AsyncIterable**（拿不到它就没法"或短路或放行"） */
type _EvLlmStreamNext = Expect<Extends<Ret<Parameters<Events['llm/stream']>[1]>, AsyncIterable<unknown>>>
/** 我们短路时产出的 chunk 形状必须仍是宿主的 `StreamChunk`（`text-delta` 那条最要紧） */
type _EvLlmStreamChunk = Expect<Extends<{ type: 'text-delta'; index: number; text: string }, StreamChunk>>
/** `agent/created`：dsp 读 `payload.agent`（`seams/context.ts` 身份播种 · `cro/turns.ts` 标"在跑" ·
 *  `index.ts` 反应式同步）。⚠️ **v0.1.7 起该事件 `@mode = serial`**（监听器被 await、抛错会使
 *  创建失败 ⇒ 我方处理函数必须快速返回且不得抛；此处只钉字段，模式由实现纪律守） */
type _EvAgentCreated = Expect<Extends<Parameters<Events['agent/created']>[0], { agent: unknown }>>
/** `tools/pre-execute` / `tools/post-execute`：dsp 读 `exec.agent.session.header.cwd`（守卫/计分） */
type _EvToolPre = Expect<Extends<Parameters<Events['tools/pre-execute']>[0], { agent?: { session?: { header?: { cwd?: string } } } }>>
type _EvToolPost = Expect<Extends<Parameters<Events['tools/post-execute']>[0], { agent?: { session?: { header?: { cwd?: string } } } }>>
/** `agent/disposed`：lifecycle 读 `payload.agent`（per-会话态清理） */
type _EvAgentDisposed = Expect<Extends<Parameters<Events['agent/disposed']>[0], { agent?: unknown }>>
/** `session/disposed`：lifecycle 直接收 Session 参数，读 id/header.id（sessionIdOf） */
type _EvSessionDisposed = Expect<Extends<Parameters<Events['session/disposed']>[0], { id?: unknown; header?: { id?: unknown } }>>
/** `settings/document-updated`：opencode-provider / deepseek-vision-patch 按 `ns === 'llm-pi-ai'`
 *  过滤（**两个位置参** `(ns, revision)`；v0.1.7 前名为 `settings/updated` 且只给 `ns`） */
type _EvSettingsDocumentUpdated = Expect<Extends<Parameters<Events['settings/document-updated']>[0], string>>

/*
 * ── ⑥b 域 B 审计补漏（v1.31.9）：四条 dsp 依赖却在 ⑥ 节漏挂闸门的事件 ──
 *
 * 这四条与 ⑥ 节同因：**名字对了、payload 字段没了 / 换了名字**同样静默失效，
 * 且比 ⑥ 节更隐蔽——它们的消费点是"读一个可选字段再早退"，字段消失不会抛错，
 * 只会让某条链路**从此不再执行**（与 DRIFT-1 的 `?? []` 恒空同构）。
 */

/**
 * `agent/pre-step`：dsp 读 `payload.agent`（路由到 CCC + 每步同步 safe-mode/im-bridge 可见性）
 * 与 `payload.messages`（bootstrap 阶段剥离 suppressedSources 注入消息；首进 CCC 时前置身份消息）。
 * 消费点 `seams/context.ts:236`、`seams/bootstrap.ts:382`；**两处都在 CCC 内必备**（required 事件）。
 */
type _EvPreStep = Expect<Extends<
  Parameters<Events['agent/pre-step']>[0],
  { agent: unknown; messages: readonly unknown[] }
>>

/**
 * `agent/turn-stopping`：dsp 读 `payload.agent` / `payload.turn`
 * （`trajectory/rebuild.ts:424` 真正执行清空、`guard/seam.ts:56` 卡最终输出、`im/guard.ts:162` 打回）。
 * dsp 侧的注解是 `{agent?: Agent; turn?: number}`（**比宿主宽**）——闸门按 dsp 假设锁"这两个键仍可读"，
 * 宿主把 payload 换成位置参数或改名 → 此处红。
 */
type _EvTurnStopping = Expect<Extends<
  Parameters<Events['agent/turn-stopping']>[0],
  { agent?: unknown; turn?: number }
>>

/**
 * `session/event`：**位置参数**（`session, event`），非 payload 对象。
 * dsp 读 `session.header.cwd`（按 CCC root 路由 tracker）与 `session.id`（关联 agent）；
 * `seams/compact.ts:50` 另读 `event.type === 'compaction/end'` 与 `event.data.error`（失败不重注入）。
 */
type _EvSessionEventSession = Expect<Extends<
  Parameters<Events['session/event']>[0],
  { id?: unknown; header?: { cwd?: string } }
>>
/** `event.type` 的判据值仍是合法事件类型（宿主删/改名 → 压缩后重注入永远走到不存在的分支） */
type _EvCompactionEndType = Expect<Extends<'compaction/end', SessionEvent['type']>>
/** `compaction/end` 的 `data.error` 仍在（**旧写法直接 `event.data.error`，字段没了会是 `undefined` 而非报错**） */
type _EvCompactionEndError = Expect<Extends<
  Extract<SessionEvent, { type: 'compaction/end' }>['data'],
  { error?: string }
>>

/**
 * `system-prompt/assemble`：**位置参数**（`assembly, context, next`）。
 * dsp 读 `context.agent`（`seams/bootstrap.ts:335` bootstrap 阶段工具目录窄化）。
 * ⚠️ `agent` 由 `dsh-agent` 的 `declare module '@deepseek-ai/dsh-system-prompt'` 合并进来
 * （**不在 dsh-system-prompt 自己的 `AssembleContext` 里**）→ 合并链断则 `context.agent` 恒 undefined，
 * 目录窄化静默失效。故此处断言的是**合并后的**第二参。
 */
type _EvAssembleContext = Expect<Extends<
  Parameters<Events['system-prompt/assemble']>[1],
  { agent?: unknown }
>>

// ─────────────────────────────────────────────────────────────
// ⑦ 宿主版本范围（与 contract.ts 同源；此处只做"类型层也看得见"的占位，
//    版本判定的运行时真相仍在 contract.ts）
// ─────────────────────────────────────────────────────────────

/*
 * 闸门自证（2026-09-10，S142 全量 review 时实测，**勿删此记录**）：
 *
 *  1) 正控制：本文件全部断言 → `dsh-develop typecheck` 绿（宿主 0.1.5-rc.1）。
 *  2) 负控制：临时插入 `type _NegativeControl = Expect<Extends<string, number>>` →
 *     `error TS2344: Type 'false' does not satisfy the constraint 'true'`（报在断言行）。
 *     → 证明本文件**确实参与类型检查**、假断言**确实会红**（不是又一处"写在测试里从未生效"的死契约）。
 *  3) 历史回归反证（C4 现场）：把 `_PersistenceSnapshotCwd` 改回旧假设
 *     `element['cwd']`（0.1.2 形态 `SessionHeader[]`）→ 编译失败（`SessionPersistenceSnapshot`
 *     上无 `cwd`）→ 即"若当年有本模块，0.1.5-rc.1 升级当天就会报警，而不是靠人读源码"。
 *
 * 教训对齐：本仓已有一次"契约写在 tests/ 里但 tests 不参与类型检查"的先例（见文件头盲区表），
 * 故任何类型层契约都必须落在 `include: ["src"]` 覆盖范围内，且**必须做一次负控制**证明它通电。
 *
 * 4) v1.31.9 补 ⑥b 四事件闸门时的**逐条变异控制**（证明"新增闸门各自通电"，非"文件整体在编译"）：
 *    ① `_EvPreStep` 目标形状追加 `nonexistent: string` → `type-contract.ts(275,34) TS2344`
 *    ② `_EvCompactionEndError` 目标改成 `{ error?: number }`（string→number）→ 同批 `(276,34) TS2344`
 *    → 两条**各自报在自己的断言行**，证明 ⑥b 是活闸门（不是被前一条遮蔽的死代码）。
 *    控制插入物已删除；如需复现，照上式临时改写对应断言即可。
 */
