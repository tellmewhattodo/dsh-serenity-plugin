/**
 * host/contract.ts — 宿主契约声明 + 运行时探针（S142 review F-05/F-06）
 *
 * 为什么存在（R↓）：dsp 与宿主（DeepSeek Harness）的契约此前以**散落的类型断言**
 * 表达——37 个文件里 80 处 `as unknown as`，类型检查被断言抹掉、运行时无校验，
 * 于是宿主改名/移除成员时 dsp **静默失效**：v1.30.5 的错误码漂移
 * （`attachment-error` → `session/attachment-invalid`）与更早的 `Session.events`
 * → `snapshotEvents()` 都是这一类。
 *
 * 本模块把契约集中声明为**数据**（单一真相源），并提供纯函数探针
 * `probeHostContract(ctx)`：在插件装载时与 `dashboard health` 中核对
 * "运行中的宿主是否仍满足 dsp 依赖的服务与成员"。
 *
 * 设计约束：
 *  - **零宿主 import**：只用结构化读取（`ctx.get` / 属性），因此 peer-only 打包
 *    （宿主依赖不进 dsp 的 node_modules）下也成立。
 *  - **事件名不在运行时探**：宿主事件是字符串键，`ctx.on` 对未知名不报错——
 *    事件名的正确性由**编译期契约测试**保证（tests/host-contract.test.ts 用真实
 *    宿主类型断言），此处只登记清单供文档/测试共用。
 *  - **缺失分级**：`required` = 缺失即 ACC 核心能力失效；否则为可降级能力。
 */

import type { Events } from 'cordis'
import { hostInjected, hostService } from './access.js'

type HostAccess = 'injected' | 'lazy'

interface HostMember {
  name: string
  kind: 'function' | 'value'
  /**
   * 成员所属的「互斥族」标签（可选）。**同族成员满足任一即可**。
   *
   * 🔴 为什么需要（v1.61，S151 2026-10-17 报告）：
   *   宿主会**给同一个能力改名**并保留旧名作回退。`subagents` 就是实例：
   *   `0.2.1-rc.*+` 的正门叫 `startActivation`，`start` 仅作旧宿主回退。
   *   （原双路消费者 `tools/cheap-worker.ts` 的 `resolveSubagentStarter()` 已随
   *     cheap-worker 下线删除 —— **知识留在这里，代码不留**；将来再有委派需求照此双路写。）
   *   若契约把某一个具体名字钉成"必须有"，宿主改名后 ⇒ **探针报假故障，而功能是好的**。
   *   ⇒ 判据必须是「**这一族里至少有一个能用**」，不是「这个名字必须在」。
   */
  anyOf?: string
}

interface HostServiceContract {
  /** 稳定标识（报告用） */
  id: string
  /** 服务名（`ctx.get(name)` 或 `ctx.<name>`） */
  name: string
  /** injected = cordis inject 保证存在；lazy = 运行期按需取（可能 undefined） */
  access: HostAccess
  /** 依赖的成员（空 = 只要求服务存在） */
  members: readonly HostMember[]
  /** 缺失时的后果（人读，进 health 报告） */
  impact: string
  /** 缺失是否致命 */
  required: boolean
}

/** dsp 依赖的宿主服务与成员（对照 `_tmp/host-0.1.5-rc.1/`（`dsh-develop host-fetch` 产物）逐一核对） */
export const HOST_SERVICES: readonly HostServiceContract[] = [
  {
    id: 'tools',
    name: 'tools',
    access: 'injected',
    members: [{ name: 'register', kind: 'function' }, { name: 'guard', kind: 'function' }],
    impact: '10 个 ACC 工具无法注册 / 机械守卫失效',
    required: true,
  },
  {
    id: 'sessions',
    name: 'sessions',
    access: 'injected',
    members: [
      { name: 'list', kind: 'function' },
      { name: 'get', kind: 'function' },
      { name: 'create', kind: 'function' },
    ],
    impact: '会话定位/rebuild/CCC 解析失效',
    required: true,
  },
  {
    id: 'agents',
    name: 'agents',
    access: 'injected',
    members: [{ name: 'create', kind: 'function' }, { name: 'get', kind: 'function' }],
    impact: '轨迹约束无法创建或复用 agent',
    required: true,
  },
  {
    id: 'webServer',
    name: 'webServer',
    access: 'injected',
    members: [{ name: 'register', kind: 'function' }, { name: 'port', kind: 'value' }],
    impact: '状态接口/网关端口发现失效',
    required: true,
  },
  {
    id: 'settings',
    name: 'settings',
    access: 'injected',
    members: [
      // 🔴 0.1.7 硬切：`installSection` 与 `get` **已被宿主删除**（`SettingsProvider` → `SettingsForms`）。
      //   本表只列**两个宿主世代都提供**的成员 —— 这一条是**跨版本纪律**，理由见下。
      //   · 读面 = `describe`（按**条目 id** 取表单，其 `value` 为已解析配置）；
      //     它在 **0.1.5 就存在**（`SettingsProvider.describe`）⇒ 换过去是**共同面**，不是新能力。
      //   · 写面 = `update`（两代同名同形）。
      // ⚠️ 2026-09-23 实测教训（**本表漏改的代价**）：漏改 ⇒ 契约恒报 `BROKEN (2 required)`
      //   ⇒ `hostService(ctx,'settings')` 判"不可用" ⇒ opencode 自动配置与多模态补丁**双双静默跳过**
      //   （不崩、不报错，只是什么都不做）。🔴 **typecheck 看不见它**（成员名是运行时字符串），
      //   只有**真机上跑一次**才看得见 —— 这正是 Docker 测试台存在的理由（bench V6）。
      // 🔴🔴 **2026-09-24 修正（我上一版自己引入的回归）**：本表**曾**把 `configure` 也列为 required。
      //   实测（`sys curl file://…/@deepseek-ai/dsh-settings/lib/index.js`，本机装机 = 0.1.5-rc.2）：
      //   **`configure` 根本不存在于 `SettingsProvider`**（它是 0.1.7 的 `SettingsForms` 才有的**页策略**）
      //   ⇒ 若把它算 required，则**在仍然在跑的老宿主上**，`settings` 会被判"不可用"，
      //   两条功能**又**变成静默跳过 —— 即：**修好了新宿主，却弄坏了老宿主**。
      //   ⇒ 判据（本条的一般化）：**`required` 成员必须是"两代都提供"的交集**；
      //     只在某一代存在的成员，**不得**进 required（它若真的必需，应由调用点自己守卫）。
      //   · `configure` 的调用点 = `surface/settings.ts`，**本就写成 `settings?.configure?.({auto:false})`**
      //     （可选链 + try/catch）⇒ **不要求它，零损失**：老宿主上只是多出一张宿主自动生成的设置页。
      { name: 'describe', kind: 'function' },
      { name: 'update', kind: 'function' },
    ],
    impact: '设置面板不装配 → 所有开关静默 no-op；opencode 路由自动配置与多模态补丁失效',
    required: true,
  },
  {
    // v1.30.12：web_fetch provider 接管（fake-ip 网络下宿主内置 provider 恒拒）
    id: 'web',
    name: 'web',
    access: 'injected',
    members: [{ name: 'registerFetchProvider', kind: 'function' }],
    impact: 'web_fetch provider 无法注册 → fake-ip 网络下 web_fetch 不可用',
    required: false,
  },
  {
    id: 'systemPrompt',
    name: 'systemPrompt',
    access: 'injected',
    members: [],
    impact: 'Induction（入口 skill 段）注入失效',
    required: true,
  },
  {
    id: 'sessionProjections',
    name: 'sessionProjections',
    access: 'injected',
    members: [{ name: 'snapshot', kind: 'function' }],
    impact: '上下文压力读数失效 → rebuild 提醒不再触发',
    required: false,
  },
  {
    id: 'skills',
    name: 'skills',
    access: 'injected',
    members: [],
    impact: 'opencode skill 兼容层（.opencode/skills 注册）失效',
    required: false,
  },
  {
    id: 'shellEnv',
    name: 'shellEnv',
    access: 'injected',
    members: [],
    impact: 'DSH_SERENITY_* 环境事实注入失效',
    required: false,
  },
  {
    id: 'agentLoop',
    name: 'agentLoop',
    access: 'injected',
    members: [],
    impact: '子 agent 无法装配 preset（轨迹载体创建会退到全局工具层）',
    required: false,
  },
  {
    id: 'subagents',
    name: 'subagents',
    access: 'lazy',
    // 🔴 v1.61（S151 2026-10-17 报告 + 本轨复核）：**两个名字是同一能力的双路实现**。
    //   宿主 `0.2.1-rc.*+`：正门 = `startActivation(spec)`；`start(name, request)` 只在
    //   旧宿主（`0.1.7-rc.*` / `0.2.0-rc.*`）存在。产品侧 `resolveSubagentStarter()`
    //   本来就是"先新后旧"选路 ⇒ **只要有一个在，委派就能用**。
    //   ⚠️ 此前只钉 `start` ⇒ 每次 health 都印一句**具体但虚假**的
    //   「委派不可用」，而实测委派真跑正常。
    //   ⇒ 具体 ≠ 准确：过期探针的误导性正来自它"说得太像真的"。
    members: [
      { name: 'startActivation', kind: 'function', anyOf: 'spawn-starter' },
      { name: 'start', kind: 'function', anyOf: 'spawn-starter' },
    ],
    impact: '子 agent 委派不可用（cheap-worker 已下线 ⇒ 现无消费者，仅备将来）',
    required: false,
  },
  {
    id: 'sessionTitle',
    name: 'sessionTitle',
    access: 'lazy',
    members: [{ name: 'rename', kind: 'function' }],
    impact: '会话命名 / rebuild 后重命名跳过（仅告警）',
    required: false,
  },
  {
    id: 'tokenMeter',
    name: 'tokenMeter',
    access: 'lazy',
    members: [{ name: 'estimateMessage', kind: 'function' }],
    impact: 'rebuild shadow-price 定价失效（计量不准）',
    required: false,
  },
  {
    id: 'workspaceRegistry',
    name: 'workspaceRegistry',
    access: 'lazy',
    // 🔴 2026-10-20（owner 裁决「死必须包含归档判断」）：`archivedSessionIds` 从
    //    "可选增强"升为**判活判据的一半**。宿主 `dsh-workspace` 的归档只往该集合加 id、
    //    **日志逐字节不动** ⇒ 只问"日志在不在"的实现在归档上必然判错。
    //    ⚠️ 它是 **getter**（`get archivedSessionIds()`），故 kind 记 `value`：
    //    探针读的是属性，不是调用。
    members: [
      { name: 'list', kind: 'function' },
      { name: 'archivedSessionIds', kind: 'value' },
    ],
    impact: 'CCC 自动发现回落失效 ＋ **归档状态不可知**（已归档会话会被误判成活载体）',
    required: false,
  },
  {
    id: 'sessionPersistence',
    name: 'sessionPersistence',
    access: 'lazy',
    members: [{ name: 'list', kind: 'function' }],
    impact: 'CCC 自动发现回落失效（诊断面受限）',
    required: false,
  },
  {
    id: 'sessionController',
    name: 'sessionController',
    access: 'lazy',
    members: [{ name: 'resolveAgent', kind: 'function' }],
    impact: 'cognitive trajectory 冷会话唤醒不可用（只能唤醒已加载的 live 会话）——唤醒注册表投递降级',
    required: false,
  },
  {
    id: 'connection',
    name: 'connection',
    access: 'lazy',
    members: [
      { name: 'authenticatedUrl', kind: 'function' },
      { name: 'authorizeIndex', kind: 'function' },
    ],
    impact: '双端口网关无法换取 dsh cookie → 外部反代 401',
    required: false,
  },
  {
    // §0L（S142 2026-09-19）：「会话 ↔ 轨迹」绑定的宿主侧载体。
    //
    // 为什么登记（R↓）：§0L 实施后，**轨迹身份映射改存宿主的存储域**
    // （`~/.dsh/storages/`，与宿主自己的 `workspace.json` 同处同类），
    // 不再放 CCC 的 `.bindings.json`（owner 裁「放 CCC 不合适」）。
    // ⇒ storageDomain 由**可选**变为**真实依赖**，故与 tools/sessions 同级进表：
    //   将来宿主改名/移除时，`dashboard health` 与装载期告警会**响亮报出**，
    //   而不是让绑定读写静默失效。
    //
    // access 取 `lazy` 的依据（实测，非推测）：dsp 的 `inject` 列表
    // （src/index.ts L68）**不含** storageDomain ⇒ 属性直读 `ctx.storageDomain`
    // 在真实 cordis 下会**抛错** `cannot get property ... without inject`
    // （同 v1.31.4 的 subagents 陷阱）；产品侧必须走 `hostService`（= `ctx.get`）。
    // 实测（`tests/host/storage-domain.test.ts`，真实 cordis **兄弟 fiber** 拓扑）：
    // `hostService(ctx,'storageDomain')` 取到 `DomainFacility`。
    // 🔴 **引用更正（2026-09-25）**：原文写 `storage-domain-probe.test.ts` —— 那是**一次性探针**，
    //    已于 2026-09-19 **转化**为长期契约用例 `storage-domain.test.ts`（该文件头部第 10 行自述此事）
    //    ⇒ 原引用指向**已不存在的对象**。本处**只修引用**，结论与语义逐字未动。
    //
    // 域名约束（实测，实施时勿违）：`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
    // ⇒ 域名为 `serenity_bindings`（**下划线**；连字符 `serenity-bindings` 非法）。
    id: 'storageDomain',
    name: 'storageDomain',
    access: 'lazy',
    members: [{ name: 'open', kind: 'function' }],
    impact: '轨迹绑定无处可存 → §0L 整体不可用（须退回"写会话日志"备选方案）',
    required: false,
  },
] as const

interface HostEventContract {
  name: HostEventName
  /** 订阅方（文件） */
  site: string
  impact: string
  required: boolean
}

/**
 * **编译期契约**：事件名必须存在于宿主合并后的 `Events` 映射。
 *
 * 这是运行时无法验证的那一半——宿主事件是字符串键，`ctx.on('typo')` 不会报错，
 * 只会静默不订阅。`satisfies readonly (keyof Events)[]` 让 `dsh-develop typecheck`
 * 在名字写错/宿主改名时**编译失败**（v1.30.7，review F-04/F-05）。
 * 该 import 为 type-only，编译期擦除，不产生运行时依赖。
 */
export const HOST_EVENT_NAMES = [
  'agent/created',
  'agent/pre-step',
  'agent/turn-stopping',
  'agent/status',
  'agent/inbox/inserted',
  // 🔴 v1.63.3：`agent/inbox/claimed` 已移出 —— 唯一订阅方（`unattended-seam.ts`）随无人值守功能
  // 整条退役。⚠️ **不是"该事件不存在了"**：宿主照常发它，只是 dsp 不再关心（本清单 = *我们订阅的*，
  // 不是宿主的全量事件表）。将来谁要再订阅，须同批加回这里 ＋ HOST_EVENTS ＋ type-contract 的字段钉。
  'agent/disposed',
  'session/event',
  'session/created',
  'session/disposed',
  'settings/document-updated',
  'tools/pre-execute',
  'tools/post-execute',
  'system-prompt/assemble',
] as const satisfies readonly (keyof Events)[]

type HostEventName = (typeof HOST_EVENT_NAMES)[number]

/**
 * dsp 订阅的宿主事件清单（与 HOST_EVENT_NAMES 同源；impact/site 供 health 报告与文档）。
 */
export const HOST_EVENTS: readonly HostEventContract[] = [
  { name: 'agent/created', site: 'seams/context.ts, gateway.ts, index.ts', impact: 'ACC 身份播种失效（identity + 工具可见性/restrict 不播种）', required: true },
  { name: 'agent/pre-step', site: 'seams/context.ts, seams/bootstrap.ts', impact: '上下文注入/首轮锚定失效', required: true },
  { name: 'agent/turn-stopping', site: 'rebuild.ts, output-guard-seam.ts', impact: 'rebuild 不执行 / 输出守卫失效', required: true },
  { name: 'agent/status', site: 'trajectory-session.ts, cro-turns.ts', impact: '等待空闲逻辑失效 / CRO「在跑」表恒空', required: false },
  { name: 'agent/inbox/inserted', site: 'seams/bootstrap.ts', impact: 'fake-initial-turns 注入失效', required: false },
  { name: 'agent/disposed', site: 'seams/lifecycle.ts', impact: 'per-会话内存态不清理（长跑泄漏）', required: false },
  { name: 'session/event', site: 'seams/compact.ts, seams/bootstrap.ts', impact: '压缩后重注入/晋升状态失效', required: false },
  { name: 'session/created', site: 'weixin-bridge.ts', impact: '定时器/桥同步失效', required: false },
  { name: 'session/disposed', site: 'seams/lifecycle.ts', impact: 'per-会话内存态不清理（长跑泄漏）', required: false },
  { name: 'settings/document-updated', site: 'opencode-provider.ts, deepseek-vision-patch.ts（ns 过滤复评）', impact: 'opencode 路由 / 多模态补丁热改不再自愈（自动配置仍覆盖首次）', required: false },
  { name: 'tools/pre-execute', site: 'seams/guards.ts', impact: '机械守卫（safe-mode/路径/白名单）失效', required: true },
  { name: 'tools/post-execute', site: 'seams/cognitive-trajectory-lifecycle.ts', impact: 'cognitive-trajectory-assistant 计分失效', required: false },
  { name: 'system-prompt/assemble', site: 'seams/bootstrap.ts', impact: '工具目录两阶段装配失效', required: false },
] as const

/**
 * dsp **被验证过的宿主版本档**（单一真相源）—— 每档 = 一个半开区间 `[floor, ceiling)`。
 *
 * 🔴 为什么是"档"而不是一条 caret 范围（R↓：2026-09-28 0.2.0-rc.1 适配轮实测得出）：
 *  - **宿主门的判据是真 semver**（`@deepseek-ai/dsh-app-boot:evaluatePluginCompatibility`
 *    = `semver.satisfies(runtime, range, { includePrerelease: true })`）⇒ **它支持 `||` 联合范围**；
 *  - 而 **dsp 这边是手写比较器**（{@link compareSemver}），**不实现 semver 的 range 语义**：
 *    旧写法"用正则从 `REQUIRED_HOST_RANGE` 剥前缀取 floor"在**联合范围上会取到垃圾**
 *    （`^0.1.7-rc.1 || ^0.2.0-rc.1` 的预发布捕获组 `(.*)` 会**吞掉 `||` 之后整段**）
 *    ⇒ 判定**变瞎**（既非"通过"也非"低于下限"，而是不可解释的值）。
 *  ⇒ 故**档表是唯一被验证的真相**：`REQUIRED_HOST_RANGE`（给宿主门看的串）与
 *    `checkHostVersion`（给自己的手写比较器）**都从它派生**，两者不可能互相漂移。
 *
 * 🔴 两档的由来（**实测，非推断**；判据表见插件仓 `docs/dsh-0.2.0-rc.1-adaptation-plan.md` §7.4）：
 *  - `^0.1.7-rc.1` 在 `0.2.0-rc.1` 上被宿主**整包拒绝 ＋ 回滚**
 *    （逐字 `installation rejected: … incompatible with dsh 0.2.0-rc.1` ＋ `restored package.json, …`）；
 *  - 单档 `^0.2.0-rc.1` 会**同样硬拒本机正在跑的 `0.1.7-rc.2`**
 *    ⇒ 发布后 deploy 必须先升宿主，**而升级会打断本容器**；
 *  - ⇒ 双档是**唯一不把本机宿主堵死的写法**（两档在真 semver 下均 PASS）。
 * 档上界取 `<0.2.0` / `<0.3.0`（即 `^0.2.0-rc.1` 的 caret 上界）：第二档同时覆盖
 * `0.2.0` 正式版与后续 `0.2.0-rc.N`。
 *
 * 🆕 **第三档 `^0.2.1-rc.1`（v1.59.3 适配，2026-10-17）** —— 为什么非加不可：
 *  - npm 的 `^0.2.0-rc.1` 对**预发布**只放行**同一 `major.minor.patch`** 的 prerelease
 *    ⇒ **`0.2.1-rc.1` 不满足它**（patch 位不同）⇒ 宿主门会**整包拒绝安装**（D98 同族）。
 *  - 而第二档的 `ceiling: '0.3.0'` 本来就"包含" 0.2.1 —— 那是**我们自己的手写比较器**的语义；
 *    两个判据（真 semver 门 vs 手写区间）在这里**给出相反答案**，故必须把第三档显式写出来，
 *    让**派生串**（{@link REQUIRED_HOST_RANGE}）里真的出现 `^0.2.1-rc.1`。
 *  ⚠️ **加档不是收窄**：前两档原样保留（0.1.7 / 0.2.0 两代仍被声明支持）。
 */
export const VERIFIED_HOST_BANDS: readonly { floor: string; ceiling: string }[] = [
  { floor: '0.1.7-rc.1', ceiling: '0.2.0' },
  { floor: '0.2.0-rc.1', ceiling: '0.3.0' },
  { floor: '0.2.1-rc.1', ceiling: '0.3.0' },
]

/**
 * 与 `package.json` 的 `peerDependencies` **逐字同串**的宿主版本范围（由 {@link VERIFIED_HOST_BANDS} 派生）。
 *
 * 🔴 这个字符串**就是**宿主门（`evaluatePluginCompatibility`）拿去跑 `semver.satisfies` 的那个串
 * ⇒ 它与档表**必须一致**（"声明 union、判定单档"是一种自相矛盾）。
 * 一致性由 `tests/host-contract.test.ts` 的**跨文件对账用例**钉住（读 package.json 逐字比对）。
 */
export const REQUIRED_HOST_RANGE = VERIFIED_HOST_BANDS.map((b) => `^${b.floor}`).join(' || ')

interface HostContractIssue {
  id: string
  kind: 'service' | 'member' | 'version'
  detail: string
  impact: string
  required: boolean
}

export interface HostContractReport {
  ok: boolean
  checked: number
  hostVersion: string | null
  versionOk: boolean
  issues: HostContractIssue[]
}

/** 最小 semver 比较（无依赖）：返回 -1 / 0 / 1；解析失败返回 null */
export function compareSemver(a: string, b: string): number | null {
  const parse = (v: string): [number, number, number, string] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(v.trim())
    if (!m) return null
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? '']
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) < (pb[i] as number) ? -1 : 1
  }
  // 预发布版本低于同版本正式版
  const ra = pa[3]
  const rb = pb[3]
  if (ra === rb) return 0
  if (ra === '') return 1
  if (rb === '') return -1
  return ra < rb ? -1 : 1
}

/**
 * 宿主版本是否落在 dsp **被验证过的档**（{@link VERIFIED_HOST_BANDS}）之内。
 * 无版本信息 → 视为未知（ok=false，detail 说明），不猜测。
 *
 * 🔴 **逐档判**（v1.50.x，0.2.0-rc.1 适配轮）：判据 = "∃ 档：`version >= floor ∧ version < ceiling`"。
 * 曾经的做法是"从 `REQUIRED_HOST_RANGE` 剥前缀取一个 floor ＋ 一个显式 ceiling"——
 * **单档假设一旦不成立（改联合范围），那个正则就会取到垃圾**（详见 {@link VERIFIED_HOST_BANDS}
 * 的注释）⇒ 故本函数**只读档表**，不再从范围串反推。
 * ⚠️ 手写比较器**不实现 semver 的 range 语义**（本条只做"区间内/外"），这也是必须逐档判的原因。
 */
export function checkHostVersion(version: string | null): { ok: boolean; detail: string } {
  if (version === null) return { ok: false, detail: `host version unknown (required ${REQUIRED_HOST_RANGE})` }
  let matched = false
  let belowEveryFloor = true
  let unparseable = false
  for (const band of VERIFIED_HOST_BANDS) {
    const floor = compareSemver(version, band.floor)
    const ceiling = compareSemver(version, band.ceiling)
    if (floor === null || ceiling === null) {
      unparseable = true
      break
    }
    if (floor >= 0) {
      belowEveryFloor = false
      if (ceiling < 0) {
        matched = true
        break
      }
    }
  }
  if (unparseable) {
    return { ok: false, detail: `host version "${version}" not parseable (required ${REQUIRED_HOST_RANGE})` }
  }
  if (matched) return { ok: true, detail: `host ${version} within ${REQUIRED_HOST_RANGE}` }
  // 连**最低一档的下限**都没够到 ⇒ 用 "below the verified floor"（这是最老的宿主形态）
  if (belowEveryFloor) return { ok: false, detail: `host ${version} is below the verified floor (required ${REQUIRED_HOST_RANGE})` }
  // 够到了某档下限、但不落在任何档内（如高于最高档的 ceiling）
  return { ok: false, detail: `host ${version} is outside the verified range (required ${REQUIRED_HOST_RANGE})` }
}

/** 结构化读取宿主服务（lazy → ctx.get；injected → 直接属性，属性缺失再试 ctx.get） */
function readService(ctx: unknown, name: string, access: HostAccess): unknown {
  return access === 'lazy' ? hostService(ctx, name) : hostInjected(ctx, name)
}

/**
 * 探针：核对运行中的宿主是否仍满足 dsp 依赖的服务与成员。
 *
 * @param ctx 宿主插件上下文（真实 cordis Context；测试可传结构化替身）
 * @param hostVersion 运行中宿主版本（`readDshVersion()` 结果；null = 未知）
 * @returns 报告（`ok:false` 时 `issues` 逐条给出缺失项与后果）
 */
export function probeHostContract(ctx: unknown, hostVersion: string | null = null): HostContractReport {
  const issues: HostContractIssue[] = []
  let checked = 0
  for (const svc of HOST_SERVICES) {
    checked += 1
    let value: unknown
    try {
      value = readService(ctx, svc.name, svc.access)
    } catch {
      value = undefined
    }
    if (value === undefined || value === null) {
      issues.push({
        id: svc.id,
        kind: 'service',
        detail: `service "${svc.name}" not available (${svc.access})`,
        impact: svc.impact,
        required: svc.required,
      })
      continue
    }
    for (const member of svc.members) {
      checked += 1
      const actual = (value as Record<string, unknown>)[member.name]
      const ok = member.kind === 'function' ? typeof actual === 'function' : actual !== undefined
      if (!ok) {
        // 🔴 `anyOf` 族：**同族任一可用即算通过**（宿主改名的双路实现，见 HostMember.anyOf）
        if (member.anyOf !== undefined) {
          const siblings = svc.members.filter((m) => m.anyOf === member.anyOf)
          const anyOk = siblings.some((m) => {
            const v = (value as Record<string, unknown>)[m.name]
            return m.kind === 'function' ? typeof v === 'function' : v !== undefined
          })
          if (anyOk) continue
          issues.push({
            id: `${svc.id}.${member.anyOf}`,
            kind: 'member',
            detail: `service "${svc.name}" is missing every ${member.kind} of "${member.anyOf}" `
              + `(${siblings.map((m) => m.name).join(' | ')})`,
            impact: svc.impact,
            required: svc.required,
          })
          continue
        }
        issues.push({
          id: `${svc.id}.${member.name}`,
          kind: 'member',
          detail: `service "${svc.name}" is missing ${member.kind} "${member.name}"`,
          impact: svc.impact,
          required: svc.required,
        })
      }
    }
  }
  const version = checkHostVersion(hostVersion)
  if (!version.ok) {
    issues.push({ id: 'host.version', kind: 'version', detail: version.detail, impact: '契约未经该宿主版本验证（漂移风险）', required: false })
  }
  const ok = issues.every((i) => !i.required)
  return { ok, checked, hostVersion, versionOk: version.ok, issues }
}

// ── 宿主契约的统一取数口（C5「观察面归一」，S142 2026-09-15；v1.34.2 纠正其缓存设计）──

/**
 * 取宿主契约报告——**每次调用现探**（`ctx` 决定"问谁"，**不缓存"答案"**）。
 *
 * 为什么**不缓存**（R↓：一个被实测推翻的设计，留档以免重犯）：
 * v1.34.1 曾把 `apply()` 时的探针结果存为模块级快照，理由是"两者对**同一个已装载的宿主**
 * 问同一个问题，第二次计算的答案**不可能不同**，成本却是一次全服务遍历"。
 * **该前提被实测证伪**（本机 2026-09-15，v1.34.1 部署后）：
 *  - `apply()` 跑在装载早期，表中 `access:'lazy'` 的服务**尚未实例化**（`ctx.get` 返回 undefined）
 *    ⇒ 启动探针把它们记为 `not available (lazy)`；
 *  - 到 `dashboard health` 被调用时它们早已可用 ⇒ **现探给的是相反结论**。
 *  - 实测差异：快照 = `checked 36 / issues 3`（含 `workspaceRegistry not available` ＋ 后果
 *    "工作区白名单下拉为空"），而**同一时刻** `GET /serenity/cccs` 正常返回 **4 个工作区**
 *    （含 3 个无 live 会话的冷 CCC）⇒ 快照渲染出的是**假阴性**。
 * ⇒ 「两次探针」**不是重复计算，问的是两个时刻**；缓存答案 = 把装载瞬间的观测冒充运行态事实。
 *
 * 保留统一入口的收益（这才是 C5 的正确部分）：取数口唯一——`container-status` / `kit-ops`
 * 只问这一个函数；将来若要"筛掉装载期噪声"，只需改这一处。
 *
 * @param ctx 宿主上下文；**未给** ⇒ 返回 `null`（不猜、不暗跑探针）
 * @param hostVersion 运行中宿主版本（`readDshVersion()`；null = 未知）
 */
export function hostContractReport(ctx?: unknown, hostVersion: string | null = null): HostContractReport | null {
  if (ctx === undefined) return null
  return probeHostContract(ctx, hostVersion)
}

/** 单行摘要（启动告警用） */
export function summarizeHostContract(report: HostContractReport): string {
  if (report.ok && report.issues.length === 0) {
    return `host contract ok (${report.checked} checks, host ${report.hostVersion ?? 'unknown'})`
  }
  const required = report.issues.filter((i) => i.required)
  const optional = report.issues.filter((i) => !i.required)
  const head = required.length > 0 ? `host contract BROKEN (${required.length} required)` : `host contract degraded (${optional.length} optional)`
  return `${head}: ${report.issues.map((i) => i.detail).join('; ')}`
}
