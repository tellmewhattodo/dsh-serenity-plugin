/**
 * dsh-serenity-hooks — 宁静号 ACC harness（Native Cordis 插件，DSH 运行时）
 *
 * 形态（DSH 官方 native hook 约定）：name / inject / Config / apply，无 default export。
 *
 * 能力：
 *   1. 真实 DSH 工具注册：container_fs（文件系统 15 子命令，含 reveal）、cognitive_trajectory（轨迹生命周期 + 一次性安排，含 rebuild）
 *   2. 拦截缝机械约束：tools/pre-execute + ctx.tools.guard（安全模式/黑名单/路径守卫）
 *
 * 加载：~/.dsh/config.yaml 加 insert 行（免改 DSH 源码），插件包装入 DSH node_modules。
 *
 * 配置：进程级 Config（cordis.yml 提供）+ 运行时读取 CCC 的 .opencode/serenity.json（规范位置，.dsh 回退）。
 */

import type { Context, Volatile } from 'cordis'
import z from '@deepseek-ai/schemastery'
import { ccFsTool } from './tools/fs/index.js'
import { createKitTool } from './tools/kit/index.js'
import { gitTool } from './tools/git/index.js'
import { msmTool } from './tools/msm/index.js'
import { praxisTool } from './tools/praxis.js'
import { createOntologyTool } from './tools/ontology-eng.js'
import { createSkillCreatorTool } from './tools/skill-creator.js'
import { createCognitiveTrajectoryTool } from './tools/cognitive-trajectory.js'
import { localstoreTool } from './tools/localstore/index.js'
import { createContainerAdminTool } from './tools/container-admin.js'
import { registerGuards } from './seams/guards.js'
import { registerBootstrap } from './seams/bootstrap.js'
import { registerKeeper } from './seams/keeper.js'
import { registerContext } from './seams/context.js'
import { registerEntrySkillSectionGlobal } from './seams/system-prompt.js'
import { registerCompactRetention } from './seams/compact.js'
import { registerStatusApi, resolveWorkspace } from './surface/http.js'
import { registerVoyageApi } from './surface/voyage/page.js'
import { registerEnv } from './seams/env.js'
import { registerOpencodeSkills } from './seams/opencode-skills.js'
import { DEFAULT_SERENITY_CONFIG_PATHS } from './kernel/ccc.js'
import { cccRootForCwd } from './kernel/ccc-roots.js'
// C4 块 B：端口只从集中端口表取（默认值不再散写）。
// ⚠️ 2026-10-19：本文件**不再直接引用任何端口常量** —— 两个消费方都随 轨迹约束调试面（3099）退役：
// `MAIN_WEB_PORT`（原 `readWebPort()` 的回退值）与 `RETIRED_SK_DEBUG_PORT`（原调试面默认端口）。
// 端口表本身仍保留，`surface/` 各处照旧从 `kernel/ports.ts` 派生。
import { hostContractReport, summarizeHostContract } from './host/contract.js'
import { readDshVersion } from './surface/status.js'
import { registerSettingsSection, readSimpleSettings, SERENITY_SETTINGS_NS } from './surface/settings.js'
import { registerGateway } from './gateway/server.js'
import { registerRebuildTurnHook } from './trajectory/rebuild.js'
import { registerReconstructTurnHook, makeReconstructWhen, supportsActivation } from './trajectory/reconstruct.js'
import { createReconstructTool } from './tools/reconstruct.js'
import { registerOutputGuardHook } from './guard/seam.js'
import { migrateLegacyLocalstore, globalConfigPath } from './kernel/config.js'
import { registerWakeScheduler } from './wake/scheduler.js'
import { registerCroTurnTracking } from './cro/turns.js'
import { registerTrajectorySubscriptions, defaultSubscriptionDeps } from './trajectory/subscriptions.js'
import { registerWeixinBridge } from './im/bridge.js'
import { registerWeixinSendApi } from './im/send.js'
import { registerWeixinOutputGuard } from './im/guard.js'
import { registerLifecycle } from './seams/lifecycle.js'
import { registerWebFetchProvider } from './patches/web-fetch.js'
import { registerOpencodeAutoConfig } from './patches/opencode-provider.js'
import { registerDeepseekVisionPatch } from './patches/deepseek-vision.js'
import { registerImChannel } from './im/channels.js'
import { weixinChannel } from './im/weixin-channel.js'
import { feishuChannel } from './im/feishu-channel.js'
import { createImBridgeTool } from './tools/im-bridge.js'
import { createDiagramTool } from './tools/diagram.js'
// v1.128.0（owner 2026-11-09 令）：ACC 级浏览器槽位管理器。**放在 ACC 而不是某个 skill 里**，
// 因为"浏览器进程属于谁 / 哪个会话忘了关"是跨 CCC 的问题 —— 而忘了关浏览器的代价
// （整机功耗异常、风扇长转）是**容器级**的，不是某条轨迹的。
import { createBrowserSlotTool, registerSlotWatchman } from './tools/browser-slot/index.js'
// §0L（S142 2026-09-19）：绑定载体迁到宿主存储域——装载期开域 + 注入句柄 + 一次性迁移
import { openBindingDomain, bindingStore } from './host/storage-domain.js'
import { setBindingStore } from './trajectory/bound.js'
// （C4 块 A 顺带清理：`registerDisposer` 的 import 自 C2 删掉 轨迹约束 root 重试定时器后已无使用点）

export const name = 'dsh-serenity-hooks'

/** 主动调用的服务；其余（agent 事件）随 harness 装配必然存在
 *  （v1.28.0 适配 0.1.2-rc.1：+ 'settings'——B4 settings 服务由 provider 插件加载后才有） */
export const inject = ['tools', 'webServer', 'sessions', 'shellEnv', 'skills', 'agentLoop', 'agents', 'systemPrompt', 'sessionProjections', 'settings', 'web']

/**
 * human-channel（人机信道）的**机器级**配置形状（2026-09-26 owner 定案 ⇒ 实现方案 §2.2）。
 *
 * ## 为什么落在这里
 * **插件 Config 本身就是机器级的**（宿主 `serenity-hooks` 命名空间，一个 dsh 进程一份），
 * 而 human-channel 的三张表（账号 ／ 订阅 ／ 主控）天然是**跨 CCC** 的 ⇒ 不必新造文件。
 *
 * ## 为什么只有一种拼写（与 `gatewayEnabled` ／ `gateway.enabled` 那对刻意不同）
 * 那一对是「面板层扁平键」与「部署层嵌套段」的分工；human-channel 是**结构化表**，
 * 面板整块读写它 ⇒ **多一种拼写就多一个会漂的真相源**。
 *
 * ## 各字段为什么一律不 `.required()`
 * schemastery 的「不 `.required()` 即可选」⇒ 手写 Config ／ 部署 bundle 里可以整段不给。
 * 🔴 **实测更正（2026-09-26，真 schemastery）**：经宿主 Loader 解析后**本段恒存在** ——
 *    `Config({}).humanChannel` = `{accounts:[],subscriptions:[],relay:{},sending:{allow:['*']}}`
 *    （子段对象被**物化**、数组取各自缺省）。⇒ 「没设过」在**解析面上不可观测**；那与
 *    「面板层扁平键刻意无缺省」（`gatewayEnabled` 那一类，为的是让位给部署层）是**两回事**。
 * ⇒ 由此两条纪律：① 缺省值**只在 schema 写一次**（读取面的缺省与它同值，不各写一套）；
 *    ② 读取面仍要能处理「整段不存在」（手写 Config ／ 未走宿主解析的调用方）。
 *    ⚠️ 另实测：显式 `sending.allow: []` **穿过解析仍为 `[]`**（`.default()` 不吞显式空数组）——
 *    这是「谁都不许」语义的地基。
 *
 * 🔴 **`relay.ccc` = 唯一主控**：人设（机器级），**CCC 不得自声明**（自声明 = 自己给自己发通行证）。
 * 🔴 **`sending.allow` 缺省 `['*']`** = 所有 CCC 都能发给人（owner Q7 裁决）；显式 `[]` = 谁都不许
 *    （**不是**"回退到 `*`" —— 见投影的 `??` 语义）。
 */
/**
 * human-channel **账号表的一行**（机器级）。
 * 🔴 声明成 `type` 而**不是** `interface`：`type` 的对象字面量形态带**隐式索引签名**
 * ⇒ 才满足 schemastery 内部 `ObjectS<X extends Dict>` 对 `Dict` 的约束（`interface` 不带）。
 */
export type HumanChannelAccountConfig = {
  /** 账号 id（机器内唯一；订阅表按它引用） */
  id?: string
  /** 渠道实现名（注册表里的 id；`weixin` ／ 将来的 `feishu` ／ `mail`） */
  channel?: string
  /** 该账号轮询开关（缺省 true —— 投影归一为定值布尔） */
  enabled?: boolean
  /** 凭据（owner Q3：落插件 Config，机器级；面板可编辑） */
  token?: string
  /** 渠道侧的用户标识（iLink 的 `ilink_user_id`） */
  userId?: string
}

/** human-channel **订阅表的一行**：`(账号, 用户) → (CCC, 角色)`（声明为 `type` 的理由同上） */
export type HumanChannelSubscriptionConfig = {
  /** 账号 id（∈ `accounts[].id`） */
  account?: string
  /** 渠道侧的用户标识（如 `userA@im.wechat`；`*` = 通配兜底） */
  user?: string
  /** 目标 CCC（别名） */
  ccc?: string
  /** 目标 轨迹约束角色名（∈ 该 CCC 的 `轨迹约束.roles`） */
  role?: string
}

export interface HumanChannelConfig {
  /** 账号表（`id` 是订阅表引用它的键；`channel` 是渠道实现名，如 `weixin`） */
  accounts?: HumanChannelAccountConfig[]
  /**
   * 订阅表：`(账号, 用户) → (CCC, 角色)` —— **收到**谁的消息。
   * 🔴 机器级**显式表**，**不得**由"该 CCC 有没有 轨迹约束角色"推断（owner 2026-09-26 更正）：
   * 轨迹约束 用途很多（传话员只是其一），推断会让**为别的目的建的 轨迹约束 被静默误接上微信**。
   */
  subscriptions?: HumanChannelSubscriptionConfig[]
  /** 主控（relay）：**唯一**可做跨 CCC 动作的 CCC */
  relay?: {
    /** CCC 别名（空白 ／ 缺省 ⇒ 无主控，投影归一为 `null`） */
    ccc?: string
  }
  /** 出站（CCC → 人）：谁能给人发消息 */
  sending?: {
    /** 白名单（`*` = 全体；缺省 `['*']`）；显式 `[]` = 谁都不许 */
    allow?: string[]
  }
}

/** 插件配置（cordis.yml 提供；进程级） */
export interface Config {
  /** CCC 配置相对路径（运行时从根读取）；缺省 .opencode/serenity.json（规范）+ .dsh/serenity.json（回退） */
  serenityConfigPaths?: string[]
  /** 注册真实工具 */
  tools?: boolean
  /** 注册拦截缝守卫 */
  guards?: boolean
  /** 注册 session-keeper DCP 提醒 */
  keeper?: boolean
  /** keeper 缺省阈值 */
  keeperThreshold?: number
  /** 注册 ACC 上下文注入（session-start + prompt-submit） */
  context?: boolean
  /** 注册压缩保留（compaction/end 后重注入 ACC 身份） */
  compactRetention?: boolean
  /** 注册 HTTP 状态接口（WebUI 停靠栏） */
  api?: boolean
  /** 身份注入时并入 CCC 入口 skill 内容（0 = 不注入） */
  entrySkillMaxChars?: number
  /** 注册 shell.env（DSH_SERENITY_* 环境事实） */
  env?: boolean
  /** 兼容 opencode skill 标准（provider：.opencode/skills 扫描注册） */
  opencodeSkills?: boolean
  /** F1 双端口网关（简单配置；entry 默认值，运行时经 DSH settings） */
  gateway?: { enabled?: boolean }
  /** F2 超限重建（entry 默认值，运行时经 DSH settings） */
  rebuild?: { enabled?: boolean; thresholdK?: number }
  /** F4 轨迹约束（实验性）：调试服务启停（entry 默认值，运行时经 DSH settings） */
  轨迹约束?: { enabled?: boolean; debugPort?: number }
  /** v1.30.12 web_fetch provider 接管（fake-ip / TUN 网络：宿主内置 provider 判「非公网」恒拒） */
  webFetch?: { enabled?: boolean }
  /**
   * v1.31.7 opencode 路由自动配置（plugin 全局；S142 用户"省得用户配"）：
   * 补 `llm-pi-ai.providers.<opencode 路由>.headers` 的路由头；环境有 OPENCODE_API_KEY 时建路由。
   * 缺省开（`!== false` 判定）；关闭后一切回到"用户手抄"。
   */
  opencodeProvider?: { autoConfigure?: boolean }
  /**
   * v1.40.x DeepSeek 多模态临时补丁（plugin 全局；S142 owner 2026-09-19 令）：
   * 给 id 含 `deepseek` 的模型补 `input: [...,"image"]`——因为 DSH 里"模型能否收图"靠**声明**，
   * 而**不在内置目录里**的模型走 `DEFAULT_INPUT = ["text"]` 兜底 ⇒ 明明支持图片却被当成只能收文字。
   * 缺省开（`!== false` 判定）。🔴 **临时功能**：owner「以后 dsh 做得更完善了我们这个功能再下掉」
   * ⇒ 关闭 = 停止再补；**不回滚已写入的值**（写的是"该模型支持图片"这个**事实**，不是偏好）。
   */
  visionPatch?: { enabled?: boolean }
  /**
   * diagram 工具（实验性 demo；2026-09-29 owner 具名令 **D104**）：标签格式源码 → 进程内
   * 光栅化成 PNG（**不借浏览器**）。缺省关；部署层同义键 = 面板层 `diagramEnabled`。
   */
  diagram?: { enabled?: boolean }
  /** human-channel（人机信道；**机器级**；2026-09-26 owner 定案）—— 见 `HumanChannelConfig` */
  humanChannel?: HumanChannelConfig
  // ── 设置面板层（扁平键）────────────────────────────────────────────────
  // 🔴 这些键是**旧 `settings.yaml` 的段名/字段名，故意原样保留**（v1.47 A 案）：
  //    0.1.7 起设置页由「profile 条目 Config」投影而来，而本插件条目 id 逐字 = `serenity-hooks`
  //    （= 旧 settings.yaml 的段名）⇒ 宿主的 `importLegacyDocument()` 会把旧值导入同一命名空间，
  //    声明了这些键 ⇒ **旧值零迁移自动生效**（schemastery 非 strict 会保留未声明键，但读取需要声明）。
  //    ⚠️ **一律不带 `.default()`**：带上就永远非 undefined，部署层（`gateway.enabled` 等）
  //    会被无声压死。读取优先级见 `surface/settings.ts`：面板层 > 部署层 > 内建缺省。
  /** F1 双端口网关总开关（面板层；部署层同义键 = `gateway.enabled`） */
  gatewayEnabled?: Volatile<boolean | undefined>
  // 🔴 v1.49.0（owner 2026-09-26 裁决）：`rebuildEnabled` 的**声明也删掉**（不只删 schema）——
  //    该键已退役、**无任何读取方**；留着声明只会让"旧值仍被导入"看起来像还有这个功能。
  //    旧配置残留该键 ⇒ 静默忽略（schemastery 非 strict ⇒ 未声明键不会让旧文档被拒）。
  /** F2 触发阈值（K token；面板层；部署层同义键 = `rebuild.thresholdK`） */
  rebuildThresholdK?: Volatile<number | undefined>
  // ⛔ 2026-10-19：`轨迹约束Enabled` / `轨迹约束DebugPort` **已删除**（轨迹约束调试面 3099 整条退役）。
  //    旧配置残留这两个键 ⇒ 静默忽略（schemastery 非 strict），同上面 `rebuildEnabled` 的处置。
  //    🔴 注意区分：退役的是**调试面**；`trajectory-constraint.json` 的**轨迹约束面机制**仍在用
  //    （判据 = `trajectory/policy/profile.ts`），只是它本来就不经这两个键。
  /** CRO（轨迹自编程唤起）总闸（面板层；无部署层同义键；缺省开） */
  croEnabled?: Volatile<boolean | undefined>
  // 🔴 v1.63.3（owner 2026-10-18 裁「砍掉无人值守功能，整个砍掉，已经证实没意义了」）：
  //    `unattendedEnabled` 的**声明也删掉**（不只删 schema）—— 该功能已整条退役、**无任何读取方**。
  //    旧配置残留该键 ⇒ **静默忽略**（schemastery 非 strict，同 `rebuildEnabled` / `wakeSchedulerEnabled` 的处置）。
  /** **diagram 工具总闸**（面板层；部署层同义键 = `diagram.enabled`；缺省关；D104） */
  diagramEnabled?: Volatile<boolean | undefined>
}

// 🔴 **刻意不写 `z<Config>` 标注**（v1.47.2 起）：volatile 键的**输入形状**（裸 `boolean`）与
// **解析后形状**（`Volatile<boolean | undefined>`）**必然不同**，而 `z<Config>` 只用**一个**
// 类型参数同时充当两侧 ⇒ 一加 `.volatile()` 就是 TS2322（实测：`required().default` 两侧互不兼容）。
// 与宿主自己的做法一致：`dsh-agent-default-model` 也是「`Config` 声明解析后形状（带 `Volatile`）
// ＋ `static Config: z<ObjectS<…>, ObjectT<…>, 'plain'>` 走推导」，**不手写 `z<Config>`**。
// ⇒ **schema ↔ 解析后接口的对账改由机械 pin 承担** = `tests/config-volatile.test.ts`。
// 🔴 **human-channel 的行 schema 必须「具名 ＋ 显式类型标注」**（2026-09-26 实测，别改回去）：
//    `Config` 是 `declaration: true` 下的**导出常量**，其**推导类型**里只要出现
//    `z.array(z.object({…}))`，tsc 就**无法命名**该类型 —— 报
//    `TS2742: The inferred type of 'Config' cannot be named without a reference to …cosmokit`。
//    根因在 schemastery 的类型面：`array<X>` 展开成 `Schema<TypeS<X>[], …>`，而
//    `TypeS<X>` 落到 `ObjectS<X> = {…} & Dict`，`Dict` 来自 cosmokit，**schemastery 的公开
//    类型面没有按名再导出它**（`ObjectS` 在全局命名空间里，`Dict` 不在）。
//    ⇒ 标注成 `Schemastery.Schema<…>`（**全局命名空间**里的名字 ⇒ 可命名）。
//    ⚠️ 实测**不**可行的写法（别重试）：① 内联 `z.array(z.object({…}))` ② 具名但不标注
//       ③ 把常量 `export` 出去 ④ `Schemastery.Schema<…>` / `Schemastery.Schemastery<…>`
//       （命名空间里没有这两个名字）。可用的名字 = **全局接口 `Schemastery<S,T>`**
//       （它在 `declare global` 里与同名命名空间并存）⇒ 本文件起别名 `SchemaOf`。
/** schemastery 的 schema 类型（别名只为可读；**名字取自全局命名空间**，见上方 TS2742 说明） */
type SchemaOf<S, T = S> = Schemastery<S, T>
/** human-channel 账号行 schema（行形状 = `HumanChannelAccountConfig`） */
export const humanChannelAccountSchema: SchemaOf<HumanChannelAccountConfig> = z.object({
  id: z.string(),
  channel: z.string(),
  enabled: z.boolean().default(true),
  token: z.string(),
  userId: z.string(),
})
/** human-channel 订阅行 schema：`(账号, 用户) → (CCC, 角色)` */
export const humanChannelSubscriptionSchema: SchemaOf<HumanChannelSubscriptionConfig> = z.object({
  account: z.string(),
  user: z.string(),
  ccc: z.string(),
  role: z.string(),
})

export const Config = z.object({
  serenityConfigPaths: z.array(z.string()).default([...DEFAULT_SERENITY_CONFIG_PATHS]),
  tools: z.boolean().default(true),
  guards: z.boolean().default(true),
  keeper: z.boolean().default(true),
  keeperThreshold: z.number().default(150),
  context: z.boolean().default(true),
  compactRetention: z.boolean().default(true),
  api: z.boolean().default(true),
  entrySkillMaxChars: z.number().default(30000),
  env: z.boolean().default(true),
  opencodeSkills: z.boolean().default(true),
  // v1.21 简单配置 entry 默认（schemastery：字段不 required 即可选）
  gateway: z.object({ enabled: z.boolean().default(false) }),
  // v1.49.0（owner 2026-09-26 裁决）：「超限重建总开关」`rebuild.enabled` **已砍掉** ——
  // 长期验证下超限重建已能很好地代替上下文压缩 ⇒ 不再需要"整体关掉"这个逃生门。
  // 同族先例 = `wakeSchedulerEnabled`（2026-09-21 砍掉，旧键静默忽略）。
  rebuild: z.object({ thresholdK: z.number().min(50).max(4000).default(400) }),
  // ⛔ 部署层的 `轨迹约束: { enabled, debugPort }` 段已删（轨迹约束调试面 3099 整条退役，2026-10-19）。
  //    两个字段都只喂那个面；旧文档（cordis.yml / profile）里残留该段 ⇒ 静默忽略。
  //    🔴 与 **`轨迹约束.roles` 不是一个东西**：那段更早（v1.71.0 重做）就已退役，
  //    而**轨迹约束面**现在住 `<轨迹目录>/trajectory-constraint.json`，与这里无关。
  webFetch: z.object({ enabled: z.boolean().default(true) }),
  opencodeProvider: z.object({ autoConfigure: z.boolean().default(true) }),
  visionPatch: z.object({ enabled: z.boolean().default(true) }),
  // diagram（实验性 demo；D104）：部署层缺省关（面板层同义键 = `diagramEnabled`，两者取或见 settings-section）
  diagram: z.object({ enabled: z.boolean().default(false) }),
  // ⚠️ 面 E（官方 ACP）的部署段 `acpFace` **已删除**（owner 2026-10-19 裁整面移除）。
  //    旧配置残留该键 ⇒ 静默忽略（schemastery 非 strict）。
  // ── human-channel（人机信道；**机器级**；2026-09-26 owner 定案 ⇒ 方案 §2.2）──────────
  // 🔴 **机器级**：一个 dsh 进程一份（插件 Config），**不是每 CCC 一份** —— 因为它的三张表
  //    （账号 ／ 订阅 ／ 主控）天然跨 CCC；CCC 侧原 `weixin.*` 随之退役（见方案 §2.4：
  //    **"家搬了"必须出声** ⇒ 启动警告，不静默；那一步在 P0-4，本版只立机器级 schema）。
  // 🔴 **不得标 `.volatile()`**：`volatile` 是**面板层布尔/数值开关**的约定（0.1.7 的
  //    `volatileForm` 硬要求），本键是**结构化表**；标了会让 `config-volatile.test.ts`
  //    的"volatile 字段集恰等于九个面板键"这条 pin 变红（那是**有意**的护栏，不是要绕过的）。
  // 🔴 **不得出现 `weixin` 兼容键**（硬切无别名，同 D61 先例）：旧 CCC 侧 `weixin.*` 既不上移
  //    也不做机器级别名 —— 回归钉见 `tests/human-channel-config.test.ts`。
  humanChannel: z.object({
    // 账号表：id 是订阅表引用它的键；channel = 渠道实现名；凭据落这里（owner Q3）
    accounts: z.array(humanChannelAccountSchema).default([]),
    // 订阅表：机器级**显式**表 (账号, 用户) → (CCC, 角色)；不得由"有没有 轨迹约束角色"推断
    subscriptions: z.array(humanChannelSubscriptionSchema).default([]),
    relay: z.object({ ccc: z.string() }),
    sending: z.object({ allow: z.array(z.string()).default(['*']) }),
  }),
  // ── 设置面板层（v1.47 A 案；**v1.47.2 起补 `.volatile()`**）：旧 `settings.yaml` 的扁平键，**刻意无默认值** ──
  // 无默认 ⇒ "用户没设过"在**语义上**是 `undefined` ⇒ 部署层（嵌套段）才有机会生效。
  // 🔴 **必须标 `.volatile()`**（0.1.7 设置面硬约定）：宿主 `settings.describe()` 只收录
  //    `volatileForm(schema) !== undefined` 的条目，而 `volatileForm` **只认 `meta.volatile`**
  //    ⇒ 一个 volatile 字段都没有 ⇒ **本插件命名空间整个不进 describe** ⇒ 设置面板那一节消失
  //    （实证 = 0.1.7-rc.1 真机 `namespaces` 16 条里没有 `serenity-hooks`）。
  // ⚠️ **读取面必须配合**：运行期 volatile 字段是 `Volatile<T>` **恒真包装**（缺省时 `.get()`
  //    返回 `undefined`），**不是** `undefined` ⇒ 一律经 `surface/settings.ts` 的 `unwrapVolatile()`。
  // 约束（min/max）与旧 settings schema 逐字一致，保证面板输入仍被宿主校验。
  gatewayEnabled: z.boolean().volatile(),
  // 🔴 v1.49.0（owner 2026-09-26 裁决）：`rebuildEnabled` **已砍掉**（超限重建恒开、无闸）。
  // 旧配置里若残留该键 ⇒ **静默忽略**（同 `wakeSchedulerEnabled` 的处置）。
  rebuildThresholdK: z.number().min(50).max(4000).volatile(),
  // ⛔ `轨迹约束Enabled` / `轨迹约束DebugPort` 已删（轨迹约束调试面 3099 退役，2026-10-19）。
  //    旧配置残留 ⇒ 静默忽略；**不写迁移代码**（与 `rebuildEnabled` 同款处置）。
  croEnabled: z.boolean().volatile(),
  // 🔴 v1.63.3：`unattendedEnabled` **已砍掉**（无人值守功能整条退役；owner 判「已经证实没意义」）。
  // 旧配置残留该键 ⇒ 静默忽略（同 `rebuildEnabled` / `wakeSchedulerEnabled` 的处置）。
  // D104（2026-09-29 owner 具名令）：diagram 工具总闸（面板层；**缺省关**）。第十号面板键——
  // 与 `config-volatile.test.ts` 的 PANEL_KEYS / DEPLOY_KEYS 两张表**必须同步**（少一处那条 pin 就红）。
  diagramEnabled: z.boolean().volatile(),
  // ⚠️ 面 E（官方 ACP）的两个面板键 `acpFaceEnabled` / `acpFacePort` **已删除**
  //    （owner 2026-10-19 裁整面移除）。旧配置残留 ⇒ 静默忽略。
})

export function apply(ctx: Context, config: Config): void {
  // review F-05（v1.30.7）：装载时核对宿主契约（服务/成员/宿主版本）——把"静默漂移"
  // 变成启动可见信号。探针自身永不抛错：宿主对插件 apply 抛错会导致整个 dsh 启动失败
  // （app-boot 的 "plugin(s) failed to load" 语义），探针不能成为新的单点。
  try {
    // C5（2026-09-15）：宿主契约走统一取数口 `hostContractReport`——**每次现探，不缓存答案**。
    // v1.34.2 纠正：装载瞬间 `lazy` 服务尚未实例化，把这次观测缓存下来会让 `dashboard health`
    // 长期渲染假阴性（实测：快照报 workspaceRegistry 缺失，而 /serenity/cccs 同时正常返回 4 个工作区）。
    const report = hostContractReport(ctx, readDshVersion())
    if (report !== null && report.issues.length > 0) console.warn(`[serenity-hooks] ${summarizeHostContract(report)}`)
  } catch {
    /* 探针失败不阻断插件装载 */
  }
  // v1.31.0（S142 用户洞察「微信桥是 ACC 提供的，发送能力也应是 ACC 的工具」）：
  // IM 通道注册必须发生在工具装配**之前**——`im-bridge` 的 description 读通道枚举
  // （imChannelIds）。可见性不在这里判定：未配置通道的 CCC 由 guards 逐 agent
  // `tools.restrict({deny:['im-bridge']})` 从清单中移除（未配置 = 模型看不到）。
  registerImChannel(weixinChannel)
  // 2026-10-20（Q4，owner「补」）：飞书**出站**通道 —— 此前注册表只有 `weixin` 一个条目，
  // 于是 `im-bridge({channel:"feishu"})` 恒返回 CHANNEL_UNKNOWN，尽管飞书的发消息协议
  // 在 `feishu-account.ts` 里早已实现（入站回复在用）。两个半件接上即成。
  registerImChannel(feishuChannel)
  // §0L（S142 2026-09-19，owner「同意，开工吧，注意向前兼容」）：把「会话 ↔ 轨迹」绑定的
  // 载体从 CCC 内 `.bindings.json` 迁到**宿主自己的存储域**（`~/.dsh/storages/`）。
  // 形态 = **域优先 + 文件兜底 + 双写**（向前兼容：域不可用/未迁移时行为与升级前逐字一致）。
  // 全程 **fire-and-forget + 永不抛错**：装载期开域失败不得成为启动单点（同契约探针口径）。
  //
  // ⚠️ **迁移不在这里做**（实测修正，R↓）：dsh 服务进程的 cwd 是**用户家目录**，**不是 CCC 根**
  // （`acc-diag` 实测：`进程 cwd: <家目录> ｜ 进程 CCC: （无）`）⇒ 装载期按 cwd 迁移会读到
  // 一个不存在的文件、静默迁移 0 条（首版发布的实测症状）。迁移改由
  // `bindingsPathFor` 惰性触发（`ensureBindingsMigrated`）——那里才稳定拿得到 CCC 根。
  void (async () => {
    try {
      const domain = await openBindingDomain(ctx)
      setBindingStore(bindingStore(domain))
      if (!domain) {
        console.log('[serenity-hooks] §0L 存储域不可用 → 绑定继续走 CCC 内 .bindings.json（向前兼容回落）')
      }
    } catch {
      /* 开域失败静默：旧文件路径仍然完整可用 */
      setBindingStore(null)
    }
  })()
  if (config.tools) {
    ctx.tools.register(ccFsTool) // container_fs
    // v1.33（S142 §32）：`logbook` 更名并收敛为 `trajectory`（原 autopilot 工具的动作 v1.33 归
    // container_admin 的 autopilot 域——该域 2026-09-15 随之退场；投递动作并入本工具）
    ctx.tools.register(createCognitiveTrajectoryTool(ctx)) // cognitive_trajectory（含 rebuild + send-now / send-later）
    ctx.tools.register(createKitTool(ctx)) // dashboard
    ctx.tools.register(gitTool) // container_git
    ctx.tools.register(msmTool) // msm（单入口执行 + 发现）
    ctx.tools.register(praxisTool) // praxis（eap/neat/cce/ontology 四合一）
    // v1.52（D121）：本体工程**引擎**（原 CCC 的 MSM `ontology-engineering` 逐字搬进 ACC）。
    // 与 praxis ontology 的分工：那个是**方法文本**，这个是**可执行的那个**（13）。
    ctx.tools.register(createOntologyTool())
    // v1.54.0（serenity-skill P3，owner 令）：增强型 skill 标准（serenity-skill）的 **creator** ——
    // 方法文本（guide）＋ 机械档（check：调 P2 的 A1/A2）＋ 语义档（review：调引擎 compliance）
    // ＋ 第二层预览（index：调 P1 的生成器）＋ 全容器一览（status）＋ 脚手架（create）。工具面 13→14。
    ctx.tools.register(createSkillCreatorTool())
    ctx.tools.register(localstoreTool)
    // container_admin（role + msm 管理 + config——v1.33 起机务舱；v1.34.1 起为工厂形态：
    // 原为 autopilot 域传进程内运行态事实，该域已于 2026-09-15 退场，ctx 现无消费者）
    ctx.tools.register(createContainerAdminTool(ctx))
    // v1.31.0：IM 消息发送（条件可见——本 CCC 未配置任何 IM 通道时由 guards 移除）
    ctx.tools.register(createImBridgeTool())
    // v1.128.0：浏览器槽位管理器（owner 2026-11-09 令，见该文件头部原话）
    ctx.tools.register(createBrowserSlotTool(ctx))
    // ⚠️ v1.106.0：原 `acc-diag`（专属工具）**已整体并入 `dashboard` 的 `diag` 动作**
    // （owner 2026-11-01 裁「方案 C」）——连 `exclusiveTools` 机制一起删除。
    // ⇒ 这里**不再注册**任何诊断工具；`dashboard` 是常驻的，诊断入口随之对所有轨迹可见。
  }
  if (config.guards) {
    registerGuards(ctx, { configPaths: config.serenityConfigPaths })
  }
  if (config.keeper) {
    registerKeeper(ctx, { configPaths: config.serenityConfigPaths, defaultThreshold: config.keeperThreshold })
  }
  if (config.context) {
    registerContext(ctx, { configPaths: config.serenityConfigPaths, entrySkillMaxChars: config.entrySkillMaxChars })
  }
  // 全局注册入口 skill 系统提示词 section（任何会话自动获得 xx-serenity 全文）
  registerEntrySkillSectionGlobal(ctx)
  if (config.compactRetention) {
    registerCompactRetention(ctx, { configPaths: config.serenityConfigPaths, entrySkillMaxChars: config.entrySkillMaxChars })
  }
  if (config.api) {
    registerStatusApi(ctx, { configPaths: config.serenityConfigPaths })
    // S142 §12.44：宁静号航行动画（ACC 层静态资产）——
    // /serenity/voyage 发 assets/serenity-voyage.html（无参=全屏版 / ?card=1=卡片模式），
    // 供会话头部状态胶囊展开卡片（SafeModePanel 的 sp-pop）当背景层用。
    // 🔴 2026-10-18：词表按**请求所属 CCC** 运行时注入（owner 报「别的 CCC 也显示 home-serenity」）。
    //   根解析**复用 surface/http.ts 的 resolveWorkspace** —— 与状态面板同一套判据（单一真相源），
    //   ⛔ 不在这里另写一份"找 CCC"的逻辑（那会长出第二份会漂的实现）。
    registerVoyageApi(ctx, {
      resolveRoot: (req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const ws = resolveWorkspace(ctx, {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          workspace: url.searchParams.get('workspace') ?? undefined,
        })
        return cccRootForCwd(ws)
      },
    })
  }
  // v1.21 分层：简单配置（开关/阈值）注册到 dsh 原生设置面板（零改 DSH；
  // 旧 RC 白名单存在时 client 侧自动降级，账号复杂配置走宁静号面板不受影响）
  registerSettingsSection(ctx, config)
  // D104（2026-09-29 owner 具名令）：diagram 工具 —— agent 给一段标签格式源码，进程内光栅化成
  // PNG（**不借浏览器**）并让图进对话。实验性 demo ⇒ **缺省关**；关时**不注册**
  // （工具不进模型工具清单 ⇒ 零 token、不会被误调），同 轨迹约束的"未开启零资源占用"口径。
  // 🔴 **本行必须在 `registerSettingsSection` 之后**：开关经 `readSimpleSettings()` 读（唯一读取入口），
  //    而那个源是在 registerSettingsSection 里才接上的（早读 = 恒读到内建缺省 = 开关永远无效）。
  // 🔴 面板拨开关**无需**额外热同步订阅：宿主 `fiber.update()` 的语义 = 校验新 config 后 **restart 本插件**
  //    （cordis `Fiber.update` 文档）⇒ apply 重跑、这一行自然重新判一次。
  if (config.tools) registerDiagramTool(ctx)
  // 🆕 v1.121.0（owner 2026-11-06 令）：`reconstruct` —— 会话累计用量过大时**换代**。
  // 🔴 **唯一一个用 `register(def, { when })` 的工具**：平时不进模型声明、也不进派发
  //    （宿主契约逐字 "False excludes it from both declarations and dispatch"），达阈值才出现。
  //    ⛔ 不要"顺手"改成 `restrict({deny})` —— restrict 只能 deny，做不到"达阈值再放出来"。
  // ⚠️ 低档宿主（< 0.2.2-rc.1）没有 `register` 的第二参数 ⇒ 多传的实参被静默忽略
  //    ⇒ 那个档位上它**常驻可见**（降级，不是缺陷；`supportsActivation()` 会把这个读数落进诊断）。
  //
  // 🔴 **门在 `config.tools` 上**（与上面所有 tool 注册同门）：`tools:false` 是全关，
  //    漏了这一处会让"关掉工具面"仍然多出一个工具（且它带着 `when`，看起来像"只有它有特权"）。
  if (config.tools) registerReconstructTool(ctx)
  // v1.21 F1：双端口网关（第二监听器 + 登录 + 反代；v1.22 起 plugin 全局——
  // enabled 读 DSH settings 开关，host/port/accounts 读全局文件，不依赖具体 CCC；
  // 旧 CCC localstore 配置在首个 agent/session-start 时一次性迁移）
  registerGateway(ctx)
  // v1.22.4 定稿：cognitive_trajectory rebuild（原 session_rebuild）排队 → agent/turn-stopping 时执行真正清空（复用旧会话原地重来）
  registerRebuildTurnHook(ctx)
  // 🆕 v1.121.0：reconstruct 的换代执行点（与 rebuild 同形：**无 pending 零开销**）
  registerReconstructTurnHook(ctx)
  // v1.26.3 输出守卫：最终输出敏感词检测 + steer 打回重生成（凭据/机制/MSM 名不泄露给用户）
  registerOutputGuardHook(ctx)
  // v1.21 F3：use 激活宁静号会话时同步重命名当前 dsh 会话（在 createCognitiveTrajectoryTool 内实现，
  // naming.enabled 简单配置门控；sessionTitle 可选服务守卫）
  if (config.env) {
    registerEnv(ctx)
  }
  if (config.opencodeSkills) {
    registerOpencodeSkills(ctx)
  }
  // Anchored Standard 两阶段工具目录（S137，移植 xiaobright/dsh-anchored-standard）：
  // 协议固有（S142 用户原则：任何 CCC 抽象层都是宁静号/ACC）——默认开启不可关、
  // 零配置面，锚定消息与机制参数全部代码固化（旧 serenity.json bootstrap 段 v1.19.5 起忽略）
  registerBootstrap(ctx)
  // ⛔ F4 轨迹约束调试面（v1.25.0 实验性，端口 3099）**已于 2026-10-19 整条退役** ——
  // owner 令「面板里 轨迹约束的内容不要了，下掉吧，功能也检查下，应该下掉了」。
  // 墓碑与完整边界说明见**本文件最末尾**那一段（删了什么／没删什么／旧配置残留怎么处置）。
  // F4c ACP / F4d 建议问答页（v1.26.0 实验性，**2026-10-15 owner 裁「砍掉外部问答」⇒ 整面退役**）：
  // `acp-core.ts` / `acp-http.ts` / `PublicAskEditor.tsx` 连同本处装配、面板键与配置链**一并删除**。
  // 旧配置里若残留 `acpEnabled`/`acpHttpPort`/`publicAskEnabled`/`acp.*`/`publicAsk.*`
  // ⇒ **静默忽略**（同 `rebuildEnabled`／`wakeSchedulerEnabled` 的处置；schemastery 非 strict）。
  // 🔴 退役理由与替代路径：本仓"ACP"当年是**自造 HTTP＋HTML**（无官方 SDK、无生态），而官方
  // `@deepseek-ai/dsh-acp` 现已发布且与本机宿主同档 ⇒ 外部接入改走**官方 ACP ＋ 现成客户端**。
  // 判据与代价（失去"按角色提问"）见 S142 `2026-10-14T2255-…-external-ask-retirement-and-acp-research.md`。
  // Autopilot Trajectory（ACC 周期自唤醒，v1.26.12 实验 → v1.27.4 正式化）已于 2026-09-15
  // 整段退场（所有者裁决 (a)）——ACC 不再提供周期自唤醒：机制/时钟/`container_admin autopilot`
  // 域/面板区块全部删除。CCC 侧的自主巡航改走 `msm autopilot-round`（S151 自管理链，
  // 真相源 = S151 SESSION.md §1/§1b/§1c）。此处**不得**再注册任何周期时钟。
  // CRO（Continuous Re-Occurrence，S142 §7.8 / `docs/cro-design.md`；owner 2026-09-19
  // 令「在 dsp 做一版实现」）：让一条轨迹**自带一段程序**，由调度器每 tick 跑它、由其判定
  // 该不该唤起。归属 = **机制属 ACC / 程序属 CCC**；运行契约 = **只 spawn，从不 import**
  // （设计 §2.3 B 案：进程边界同时挡掉"ACC 依赖 CCC 源码路径"与"用户程序语法错放倒 ACC"）。
  // 🔴 本行**必须在 `registerWakeScheduler` 之前**：后者会立刻跑第一次 tick，而 CRO 快照的
  // `binding.runningSessionIds` 唯一数据源就是这张表（晚装 = 首拍读到空表 = 谎报"没在跑"）。
  // 评估与投递面在 tick 内（`wake/scheduler.ts` 的 `runCroPhase`），本行只装"是否正在跑轮次"。
  registerCroTurnTracking(ctx)
  // cognitive trajectory 唤醒注册表（D58，v1.32.0）：中心调度器——5min tick 投递「未来时刻 + 一条
  // message」的一次性唤醒（可自唤醒、可跨 cognitive trajectory）。冷会话经 ctx.sessionController
  // 载入后投递。🔴 **本钟无闸**（2026-09-21 所有者令砍掉 `wakeSchedulerEnabled`）⇒ **恒武装**、
  // 永不因闸跳过；tick 内**另一层**总闸是 CRO 阶段的 `croEnabled`（只停 CRO，**不影响**本注册表
  // 投递）。这是 ACC 唯一的轨迹调度机制。
  registerWakeScheduler(ctx)
  // 🆕 v1.107.0 轨迹消息订阅（owner 2026-11-01 令）：观察者盯一组轨迹，
  // **任一成员「一轮结束」就通知观察者**。⚠️ 它是**通知不是控制** —— 不带"它做了什么"，
  // 也不赋予指挥权。判据复用 `agent/status` running→idle（D244 已定死：turn-stopping 不是轮结束），
  // ⛔ 不另立判据。配置 = `.opencode/serenity.json` 的 `trajectorySubscriptions`。
  // 🔴 放在 `registerWakeScheduler` **之后**：订阅的投递走调度器的 `sendToCognitiveTrajectory`，
  //    时钟先武装再挂订阅，避免"事件来了但投递通道还没起"的窗口。
  // ⚠️ **root 不在装配期固定**：一个宿主进程可能服务多个 CCC（实测 3 个），
  //    装配期只拿得到一个根 ⇒ 必然错。⇒ 每次事件按**该会话自己的 cwd** 解析根
  //    （注入 `rootForSession`，见下方 `defaultSubscriptionDeps`）。
  registerTrajectorySubscriptions(ctx, defaultSubscriptionDeps(ctx))
  // 🆕 v1.128.0 浏览器槽位看守（owner 2026-11-09 令）：5min 一拍，找"长期不动 / CPU 过高 /
  // 占用超时 / 进程已死"的槽位，**反向向占用它的轨迹注入一条提醒**。
  // 🔴 它只提醒、**不代为释放** —— 只有占用者知道那个浏览器还有没有用。
  // 🔴🔴 **v1.128.2：这里原先是 `cccRootForCwd(process.cwd())`，那是个静默失效** ——
  //    宿主进程 cwd 是**用户家目录**（不在任何 CCC 内）⇒ 恒返回 null ⇒ tick 第一行就 return
  //    ⇒ **看守一次都没工作过**，且没有任何日志。现在改为由看守自己在每拍用
  //    `listCccs(ctx)` 枚举全部 CCC 根（那是"本机有哪些 CCC"的唯一权威枚举）。
  //    ⚠️ 不在这里固定根：一个宿主服务多个 CCC（实测 3 个），装配期定一个必然是错的。
  registerSlotWatchman(ctx)
  // F4c-3 微信桥（v1.27.0 实验性）：CCC 级配置（serenity.json weixin + localstore 凭据）→
  // 多账号 iLink 轮询 + 消息路由到 轨迹约束 role。enabled=false 未配置 → 零资源占用。
  registerWeixinBridge(ctx)
  // v1.30.9（S142 用户需求"微信桥支持被调用发消息给指定用户"）：主动发送入口——
  // 只绑 127.0.0.1 的独立监听器（默认 3082；plugin 全局配置 weixinApi），供**非 agent 调用者**
  // （外部脚本/集成）使用。v1.31.0 起 agent 侧统一走 im-bridge 工具（进程内直调 + 记录），
  // 旧 CCC MSM weixin-send 已退役；此 HTTP 入口保留（发送与记录都经桥，outgoing hook source=proactive）。
  registerWeixinSendApi(ctx)
  // 🔴 面 E（官方 ACP）**已整面删除**（owner 2026-10-19 裁「完整删除整个 ACP 的实现」）。
  // 退役理由（实测，非口味）：`dsh-acp` 无 `session/load` 且 `session/resume` **不回放历史**
  // ⇒ ACP 客户端每次连上只能**新建会话**，看不到既有对话；上游 discussion #6324 同证。
  // 对一个"长期轨迹"系统，这个客户端体验无法接受 ⇒ 整面移除，IM 通道只剩微信。
  // ⚠️ 旧配置残留 `acpFace*` / `im.*` ⇒ **静默忽略**（schemastery 非 strict，同既有退役键处置）。
  // v1.30.16（S142 用户"约束不够，LLM 不听"）：手动输出模式机械闸门——turn-stopping 检查
  // 本轮是否真的成功调用过输出工具（im-bridge，v1.30.x 为 weixin-send），未发送则 steer 打回
  // （≤2 次）。**措辞归 CCC 角色提示词**（本闸门只给机制事实 + 已填参数标记），与"ACC 管机制 /
  // CCC 管内容"边界一致。
  registerWeixinOutputGuard(ctx)
  // review F-08（v1.30.8）：生命周期——agent/session 销毁清理 per-会话状态 +
  // 插件卸载/HMR 停掉自起资源（轨迹约束调试页/微信桥；否则端口占用与重复轮询）
  registerLifecycle(ctx)
  // v1.30.12（S142 用户拍板 L3）：web_fetch provider 接管——fake-ip 网络下宿主内置
  // provider（web-fetch-http）把 198.18.0.0/15 判为「非公网」恒拒；本插件用同一
  // HttpFetchProvider 实现 + 放宽后的地址判据注册同 id（宿主内置由本包 bundle patch
  // `disabled: true` 关闭，避免 WEB_DUPLICATE_PROVIDER）。
  if (config.webFetch?.enabled !== false) {
    void registerWebFetchProvider(ctx)
  }
  // v1.31.7（S142 用户"dsp 装好就自动配上，省得用户配"）：opencode zen/go 路由头自动配置——
  // DSH 用的 pi-ai **库**本身不发 opencode 路由头（pi CLI 是应用层自己加的），
  // 缺 `x-opencode-session` 时 /zen/go 直接 400。本步经官方 settings 面补齐头；
  // 环境有 OPENCODE_API_KEY 时自动建 opencode-go 路由。缺省开，缺省值以下才跳过。
  if (config.opencodeProvider?.autoConfigure !== false) {
    registerOpencodeAutoConfig(ctx)
  }
  // v1.40.x（S142 §26 §0x-9，owner 2026-09-19 令「临时的我允许」）：DeepSeek 多模态补丁——
  // 给 id 含 `deepseek` 的模型补 `input` 的 `image`，因为"模型能否收图"在 DSH 里靠**声明**
  // （`declaredInput(entry.input) ?? base?.input ?? [...defaultInput]`），而**不在内置目录**的模型
  // 走 `DEFAULT_INPUT = ["text"]` 兜底 ⇒ 支持图片的模型被当成只能收文字。
  // 与上一条同款通道（`settings.update` 写 `llm-pi-ai`）、同款"永不抛错"纪律。
  // 🔴 临时功能，缺省开；`visionPatch.enabled=false` 停止再补（不回滚已写入的值）。
  if (config.visionPatch?.enabled !== false) {
    registerDeepseekVisionPatch(ctx, true)
  }
}

/**
 * diagram 工具装配（**D104**，2026-09-29 owner 具名令）：**默认关**的实验性工具 ⇒ 关时**不注册**。
 *
 * 归属与边界（E↑）：**机制归 ACC**（工具面 ＋ 开关 ＋ 光栅化），**图的语义归调用方**
 * （标签语法与四项体检在 `src/diagram/`，权威设计 = 插件仓 `docs/diagram-tool-feasibility.md`）。
 *
 * 🔴 **v1.51.1 修的真缺陷（owner 实测：「我把开关开了，工具没出来」）**：
 * 面板拨开关**只改配置、不重跑 `apply`**（铁证 = 插件重启才刷新"武装于"；`cordis.patch.yml` 里
 * `diagramEnabled: true` 已落盘而工具没注册）⇒ 旧实现"apply 时判一次"等于**开关要重启才生效**。
 * ⇒ 现在改成**反应式**：
 *   ① 听宿主的**真事件** `settings/document-updated`（ns = 我们那张设置页）——顺带说明为什么不用
 *      我们自己的 `serenity/settings-changed`：那个事件**全仓没有任何 `emit` 点**（只有 `ctx.on` 侧
 *      在用）＝**死通道**，照着它接线等于接了个永远不响的铃；
 *   ② 兜底再挂 `agent/created` ／ `session/created`（与 轨迹约束 同款做法，那两条在实测里确实会 fire）
 *      —— 宿主事件面若换名，至少还有这一条能自愈；
 *   ③ 启动时同步一次（apply 时按当前配置定初始态）。
 * 🔴 **关的时候要注销**（不是"留着但不响应"）：与"关时不注册"同一口径 —— 工具不出现在模型清单里。
 * @param ctx - 插件上下文
 */
/**
 * 注册 `reconstruct` 工具（v1.121.0，owner 2026-11-06 令）。
 *
 * ## 与其它条件工具的区别（这一格是本仓唯一）
 *
 * `im-bridge` / `diagram` 的条件都靠 `seams/guards.ts` 的 `restrict({ deny })` 施加。
 * 而宿主 `restrict` **只能 deny，不能 allow** ⇒ 那套机制只能"平时藏起来"，
 * 做不到"达阈值再放出来"。`reconstruct` 要的正是后者 ⇒ 走 `register(def, { when })`：
 * 宿主每步 `resolve()` 时问一次，`false` 时**既不进模型声明，也不进派发**。
 *
 * ⚠️ **档位降级（如实登记）**：第二参数只在宿主 `≥0.2.2-rc.1` 存在。
 * 低档下多传的实参被 JS 静默忽略 ⇒ 那个档位上 `reconstruct` **常驻可见**。
 * 这是"宿主没这个能力"的降级，不是缺陷；`supportsActivation()` 把它落进
 * `AGENT_SESSIONS/.reconstruct-diag.json`，让读数面能区分"没出现"与"出现了但藏不住"。
 *
 * @param ctx - 插件上下文（`when` 要读 `sessionProjections`）
 */
function registerReconstructTool(ctx: Context): void {
  try {
    const when = makeReconstructWhen(ctx)
    const tools = ctx.tools as unknown as {
      register: (def: unknown, options?: { when?: (c: { agent?: unknown }) => boolean }) => () => void
    }
    if (supportsActivation()) {
      // ⚠️ `when` 的参数类型按宿主契约收窄（`ToolActivationContext.agent: Agent`），
      //    而上面那个 `register` 断言用的是 `unknown` —— 两者不兼容是**断言写法**造成的，
      //    不是真类型冲突。⇒ 这里在断言面上再放宽一次（⛔ 不改 `makeReconstructWhen` 的签名：
      //    它自己要与宿主契约逐字对齐，不该为了迁就一处断言而退化成 unknown）。
      tools.register(createReconstructTool(ctx), {
        when: when as unknown as (c: { agent?: unknown }) => boolean,
      })
    } else {
      // 低档宿主：不传第二参数（传了也被忽略，但显式分开写能让源码读者看出这条降级）
      tools.register(createReconstructTool(ctx))
      console.log(
        '[serenity-hooks] reconstruct：当前宿主不支持工具准入条件 ⇒ 该工具常驻可见（降级，非缺陷）',
      )
    }
  } catch (err) {
    // 注册失败不得成为启动单点；但要响亮（"阈值到了工具没出现"看起来会像阈值坏了）
    console.error(`[serenity-hooks] ✗ reconstruct 工具注册失败: ${String((err as Error)?.message ?? err)}`)
  }
}

function registerDiagramTool(ctx: Context): void {
  /** 当前注册的 disposer（`null` = 未注册）。宿主 `ctx.tools.register` **返回注销器**。 */
  let dispose: (() => void) | null = null

  const sync = (): void => {
    const on = readSimpleSettings().diagramEnabled
    if (on && dispose === null) {
      try {
        dispose = ctx.tools.register(createDiagramTool(ctx))
      } catch (err) {
        // 注册失败**不得**成为启动单点；但要**响亮**——静默失败会让"拨了开关没反应"看起来像开关坏了
        console.error(`[serenity-hooks] ✗ diagram 工具注册失败: ${String((err as Error)?.message ?? err)}`)
      }
      return
    }
    if (!on && dispose !== null) {
      try {
        dispose()
      } catch {
        /* 注销失败不阻断（插件重启会收） */
      }
      dispose = null
    }
  }

  try {
    ctx.on('settings/document-updated', (ns: unknown) => {
      if (String(ns) === SERENITY_SETTINGS_NS) sync()
    })
  } catch {
    /* 事件通道缺失不阻断（下面还有兜底与启动那次） */
  }
  for (const eventName of ['agent/created', 'session/created'] as const) {
    try {
      ctx.on(eventName, () => { sync() })
    } catch {
      /* 同上 */
    }
  }
  sync()
}

// ⛔ 【2026-10-19 整条退役】F4 轨迹约束调试服务（面 D / 端口 3099）已删除。
//
// owner 令（逐字）：「面板里 轨迹约束的内容不要了，下掉吧，功能也检查下，应该下掉了」
//
// ── 删了什么 ────────────────────────────────────────────────────────────────
//   · 装配：`registerTrajectoryDebug()`（连同它依赖的 `resolveTrajectoryRoot` 与 `readWebPort`，两者只为它服务）
//   · 面本体：`surface/debug.ts` 整文件（原 `role/轨迹约束/debug.ts`，S11 搬来）：listener/路由/HTML
//   · 配置键：`轨迹约束Enabled` / `轨迹约束DebugPort`（provenance 见 `surface/settings.ts`）
//   · 界面：设置面板「轨迹约束调试」行（`client/SettingsSection.tsx`）
//
// ── ⚠️ 没有删什么（这个区分是本次最重要的一条）─────────────────────────────────
//   `trajectory-constraint.json` 那套**轨迹约束面机制**（工具白名单 / 模型 / 纪律参与项）**仍在用**：
//     · 判据与读盘 = `trajectory/policy/profile.ts`（`trajectoryConstraintForSession`）
//     · 施加点     = `seams/guards.ts`（工具面收窄）、`seams/keeper.ts`（纪律）
//   ⇒ 退役的是"一个调试 HTTP 面"，**不是**"轨迹约束 这个约束面"。
//   两者同名不是同一件事：面是给人手工问答用的窗口，约束面是轨迹自己的能力边界。
//
// ── 旧配置残留 ──────────────────────────────────────────────────────────────
//   `轨迹约束Enabled` / `轨迹约束DebugPort` 写了也不认（schemastery 非 strict ⇒ 静默忽略），
//   与 `rebuildEnabled` / `wakeSchedulerEnabled` / `acpEnabled` 同款处置，**不写迁移代码**。
//
// ── 为什么整段删而不是留空壳 ────────────────────────────────────────────────
//   留壳会让下一个人以为"开关还在、只是没接"，而它其实**已经没有实现面**了。
//   本轨判据：**留死行比删更坏**（它会在下次出现同名模块时静默豁免）。
//
// ── 历史（供追溯，不再是活文档）──────────────────────────────────────────────
//   该面曾解决两个真缺陷：v1.30.13「CCC root 解析失败永不重试」与
//   v1.30.14「同拍双次 start → EADDRINUSE」。两个缺陷的修法形态（反应式再触发 /
//   在飞标志 / 持久来源兜底）随面退役而**失效**，教训已登记在维护 skill 的
//   `references/55-criteria-discipline.md`。
