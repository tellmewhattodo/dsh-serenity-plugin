/**
 * kernel/ccc.ts — CCC 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * 职责：CCC 根检测（P1）、git 检测（P2）、serenity.json 配置读取（.opencode 规范位置，.dsh 回退）、
 * 路径守卫（P3 语义）、安全模式黑名单匹配。
 *
 * 由 tools/ 与 seams/ 复用；逻辑移植自 dsh-serenity-plugin v0.1-v0.2
 * runner（本项目自有代码，非 opencode-serenity-plugin 源码）。
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── P1 有根 ──

export function findSerenityRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const marker = resolve(current, '.serenity');
    if (existsSync(marker) && statSync(marker).isFile()) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── P2 git 管 ──

export function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── P3 路径二分 ──

type PathClass = 'inside' | 'outside' | 'same';

/**
 * 前缀判定：abs 是否位于 rootAbs 之内。
 * caseInsensitive（Windows 盘符/路径大小写不敏感）由调用方按平台传入；
 * 边界必须是路径分隔符（`\` 或 `/` 任一）——不依赖平台 sep，跨平台语义一致：
 *   - 跨盘符绝对路径（root 在 D:\、target 在 C:\）前缀不匹配 → outside
 *   - 兄弟目录前缀陷阱（home vs home2）边界非分隔符 → outside
 * （旧实现用 path.relative().startsWith('..')——跨盘时 relative 返回绝对路径原文，
 *   不以 `..` 开头 → 漏判放行，见 Windows 兼容审计问题 1。）
 */
export function pathInside(rootAbs: string, abs: string, caseInsensitive = process.platform === 'win32'): boolean {
  const r = caseInsensitive ? rootAbs.toLowerCase() : rootAbs;
  const a = caseInsensitive ? abs.toLowerCase() : abs;
  if (a === r) return true;
  if (!a.startsWith(r)) return false;
  const next = a[r.length];
  return next === '\\' || next === '/';
}

export function classifyPath(p: string, root: string): PathClass {
  const rootAbs = resolve(root);
  const abs = resolve(p);
  const ci = process.platform === 'win32';
  if (ci ? abs.toLowerCase() === rootAbs.toLowerCase() : abs === rootAbs) return 'same';
  return pathInside(rootAbs, abs, ci) ? 'inside' : 'outside';
}

export function resolveInside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: "${p}" resolves outside "${root}"`);
  }
  return abs;
}

// ── CCC 名（.serenity 标记内容）──

/**
 * CCC 名：从 .serenity 标记解析——**跳过 # 注释与空行的首个非空行**。
 * 注册表聚合档路径（.opencode/skills/<cccName>/references/mech-registry.json）以此为准，
 * 是 guards/fs-ops/msm-ops/kit-ops 四处解析的唯一真相源（review P2-2 收口，09-05：
 * 原四处分叉——msm-ops/kit-ops 取严格首行、guards/fs-ops 跳注释——首行为注释/空行时
 * register 目标路径与保护路径分叉，潜在隐患）。
 * @returns CCC 名；无标记/读失败/全注释空行 → null
 */
export function readCccName(root: string): string | null {
  try {
    const marker = resolve(root, '.serenity');
    if (!existsSync(marker)) return null;
    const content = readFileSync(marker, 'utf-8');
    const line = content.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'));
    return line && line !== '' ? line : null;
  } catch {
    return null;
  }
}

// ── 配置（.opencode/serenity.json 规范位置 / .dsh/serenity.json 回退）──

interface SerenityConfig {
  // 🔴 2026-10-28（owner 令「下线 cheap-worker，完全删掉」）：
  //   `cheap-worker` 与它的旧键 `handyman` **两个配置段都已整段删除** ——
  //   工具退役后不再有消费者（配置读取、模型白名单校验、面板回显三处全部同步移除）。
  //   存量 CCC 里残留这两段 ⇒ **静默忽略**（schemastery 非 strict，不报错、也不生效）。
  //   ⚠️ 这正是 D151 警告的形态：留着会让下一个 agent 以为它们还在起作用。
  sessionKeeper?: {
    /** 计分提醒阈值（缺省 150） */
    threshold?: number;
    /**
     * 活跃 SESSION.md 体积上限（KB，缺省 200——v1.31.1 新增，v1.31.2 缺省 100→200）。
     *
     * 超过 → trajectory-assistant 注入 LOGBOOK COMPACTION 提醒（暂停工作 → 加载 eap →
     * 按 EAP 分层骨架重写 SESSION.md；内容可外移到 references 文件、可整合不重要事项、
     * 自主裁量权充分允许）。设 0 = 关闭该提醒。
     */
    sessionMdMaxKB?: number;
  };
  safeMode?: {
    blacklist?: string[];
    /**
     * **安全模式开启期间**额外从模型工具清单隐藏的工具（v1.51.4，owner 2026-10-09 令）。
     *
     * 语义（与 `exclusiveTools` 的区别，判据是"条件"）：本键不是无条件的可见性白名单，
     * 而是**条件屏蔽**——`\.serenity-safe-on` 标记存在时才隐藏，标记消失即**全部恢复**
     * （基础表恒隐 `bash` 不受影响）。机制在 ACC、声明在 CCC（D23）：
     * ACC 代码里不出现任何具体工具名。
     */
    hiddenTools?: string[];
  };
  /** localstore git 提交策略（S134 重设计）：allow 可提交 / deny 禁提交（缺省 deny） */
  localstore?: { gitTrack?: 'allow' | 'deny' };
  // 注意：bootstrap 配置段已于 v1.19.5 移除（S142 用户原则——fake-initial-turns 属
  // ACC 协议层，任何 CCC 抽象层都是宁静号/ACC，机制与内容零配置面，代码固化）。
  hooks?: {
    enabled?: boolean;
    injectAccContext?: boolean;
    enforceSafeMode?: boolean;
    sessionKeeper?: boolean;
    /** 重启自动恢复最近激活的宁静号会话（session-start 时，根会话且无自身标记 → 回退最近 use 的标记） */
    autoRestoreSession?: boolean;
  };
  /**
   * 🔴 **`轨迹约束` 段已于 2026-10-19 退役**（owner 重做令）。
   *
   * 轨迹约束 不再是 `serenity.json` 里的一组角色定义，而是**带 `trajectory-constraint.json` 的认知轨迹**
   * （约束面住在轨迹目录里）。⇒ 本段**不再被读取**：存量配置里残留的 `轨迹约束.roles` ⇒
   * **静默忽略**（schemastery 非 strict，不报错；也不会被误当成"没有 轨迹约束"）。
   *
   * 迁移路径 = 把 `轨迹约束.roles.<name>` 的内容原样搬进对应轨迹目录的声明文件
   * （判据与步骤见 `trajectory/policy/profile.ts` 头注释）。
   * 🔴 2026-10-19：声明文件已收拢为 **`trajectory.json`**（旧名仍在**读取族**里，写只写新名）。
   */
  /**
   * 认知轨迹族配置（D58，S142 2026-09-13；2026-10-18 更名 `cognitiveTrajectory`）。
   *
   * 🔴 **2026-10-18（owner 令）：autopilot 配置面整体删除** —— ACC 侧 autopilot 机制
   *    早在 v1.35.0 就整段退场（周期性自主巡航已由 CRO 取代）。当时的处置只删了实现，
   *    把配置读取面留了下来，成为"读到也无人消费"的死键。owner 2026-10-18 明示
   *    「autopilot 整体已经废弃，可以删除的」⇒ 本次一并移除：
   *    `cognitiveTrajectory.autopilot` ／ 旧键 `autopilotTrajectory` ／ 更旧键 `autotrajectory`
   *    ／ 类型 `AutopilotTrajectorySettings`。
   *    ⇒ 存量 CCC 里这段配置**不再被读取**（静默忽略；无迁移必要 —— 它已无消费者）。
   */
  cognitiveTrajectory?: {
    /**
     * **CCC 级 skill 供给**（v1.44.0；owner 令 2026-09-20：「要求实现我的诉求……轨迹约束也支持」）。
     *
     * 语义：**本 CCC 的每条轨迹都带这些 skill**——声明的 skill 全文在该轨迹**被绑定期间**
     * 动态注入系统提示词（每请求重新求值，不缓存）。与轨迹自己在 `SESSION.md` frontmatter
     * 里的 `skills:` 是**并集**（CCC 级在前、轨迹级追加、同名去重）⇒ 容器给底座、
     * 单条轨迹仍可加自己的额外项（这正是 C1 设计当初否决"纯 CCC 全局"的理由所在：
     * 全局化会**丢掉 per-trajectory**；并集把它保住）。
     *
     * 归属（D23）：**机制在 ACC**（读取 + 合并 + 注入 + 守卫），**声明在 CCC**（本键）——
     * ACC 代码里不出现任何具体 CCC 或具体 skill 名。
     *
     * 失败语义：未配置 / 字段缺失 / 配置损坏 ⇒ **空数组**（= 没有 CCC 级供给；轨迹级声明照旧生效）。
     * 配置损坏本身已由 `loadSerenityConfig` 响亮告警（不静默）。
     *
     * ⚠️ 与 `create` 的关系：**不触发**——`create` 刻意不夺绑定（U6），注入的门是"存在绑定"。
     * ⚠️ 作用面：**含 轨迹约束角色会话**（它们同样绑定工作台轨迹）。
     */
    skills?: string[];
  };
  /**
   * 微信桥（F4c-3，v1.27.0 实验性）：**CCC 级**配置——dsh 一个进程含多个 CCC，
   * 每个 CCC 独立对接微信桥（S142 用户拍板：ACC 不绑定 role，配置归 CCC，手工）。
   * 结构/路由/开关在此文件（git 管可重建）；**bot_token 凭据在 CCC localstore**
   * （weixin.accounts.<accountId>.token/.baseUrl/.userId——扫码后自动写入，安全纪律）。
   * 未配置或 enabled=false → 该 CCC 桥完全不启动（零资源占用）。
   */
  weixin?: WeixinSettings;
  /**
   * 🔴 **统一 IM 配置（2026-10-19，owner 定向）**：微信与飞书**只是账号实现不同**，
   * 配置整合到这一段。存在且 `accounts` 是数组 ⇒ 优先于旧 `weixin` 段。
   * 见 `ImSettings` 的注释（含"为什么判据不是'段存在'"的坑）。
   */
  im?: ImSettings;
  // ⚠️ `im?: ImSettings`（IM 通道选择，v1.59.0）**已删除** —— 随面 E（官方 ACP）整面退役，
  //    IM 入站只剩微信一种实现，"选通道"失去意义。旧配置残留 ⇒ 静默忽略。
  // ⚠️ `exclusiveTools?: string[]`（专属工具声明，v1.33）**已于 v1.106.0 删除**
  //    （owner 2026-11-01 裁「机制整体删」）——那张表永远只有一个成员 `acc-diag`，
  //    而它已并入常驻的 `dashboard diag`。表空之后机制静默空转且**不可证伪**，
  //    留着只会提供"这里还有一层保护"的错觉。
  //    旧配置残留 ⇒ schemastery 非 strict ⇒ **静默忽略**，不影响加载（与上面几处退役同规格）。
  /**
   * 轨迹消息订阅（v1.107.0，owner 2026-11-01 令）：
   * **观察者盯一组成员，任一成员「一轮结束」就通知观察者**。
   *
   * 🔴 **这是通知，不是控制**（owner 原话「loose notification, not control」）：
   * 观察者收到的是「某人刚干完一轮活儿」，**不带他干了什么**（owner：「不需要带它做了什么」），
   * 也不赋予它任何指挥权。要不要看、看了做什么，全由观察者自己决定。
   *
   * ## 三件必须固定的语义
   *
   * 1. **「一轮结束」的判据 = `agent.status` 由 running → idle**（`cro/turns.ts` D244 已定死：
   *    `agent/turn-stopping` 是**暂停点**不是轮结束，⛔ 不得用它）。因此本机制**复用**那条事件，
   *    不新造判据 —— 两个判据并存会立刻分叉。
   * 2. **频率不设上限**：结束了就通知（owner：「不设定上限，结束了就通知」）。
   *    ⚠️ 但**不额外防抖**是有依据的：`agent/status` 只在**真实状态跃迁**时发
   *    （宿主 `AgentLoop.setPhase`，见 `cro/turns.ts` 文件头），所以"抖动"不会发生。
   * 3. **目标的三种失败面各自显形**（见 `trajectory/subscriptions.ts` 文件头的失败面表）：
   *    成员解析不出轨迹 / 观察者唤不醒 / 投递失败 —— ⛔ 一个都不许静默。
   *
   * ⚠️ **与 CRO 的区别**（别混）：CRO 是「**自己**决定要不要把自己叫起来」（自编程）；
   * 本节是「**别人**干完活了，告诉我一声」（互观察）。两者都走唤醒链路，但**主语相反**。
   */
  trajectorySubscriptions?: TrajectorySubscription[];
}

/**
 * 一条轨迹消息订阅：`watcher` 观察 `members`。
 *
 * 🔴 **方向性是本结构唯一容易写反的地方**：`watcher` 是**收通知的那个**，
 * `members` 是**被盯的那组**。写反了照样能跑、只是通知发给了错误的人 —— 没有机械信号，
 * 所以字段名取"谁看/看谁"而不是"a/b"（D150 同族：字面要能自证方向）。
 */
export interface TrajectorySubscription {
  /** 收通知的轨迹（`S###` 或 AGENT_SESSIONS 目录名） */
  watcher: string;
  /** 被观察的轨迹清单（同上格式） */
  members: string[];
  /** 这条订阅是否生效（缺省 true —— 写了就是要用） */
  enabled?: boolean;
  /** 通知正文里对这个订阅的一句话说明（可选；用于让观察者分辨是哪条订阅触发的） */
  note?: string;
}

/**
 * 🔴 **统一 IM 配置（2026-10-19 owner 定向：「飞书和微信一样，只不过是 account 方实现不同。
 * 要整合到统一的配置中」）。**
 *
 * ## 为什么是"账号"这一层，不是"通道"这一层
 *
 * 微信与飞书的差别**只在账号侧**：怎么连、怎么收、怎么发。而它们的**身份、路由、会话**
 * 从来就是通道无关的（`routes: user → 轨迹编码`；会话 id 由轨迹编码派生）。
 * ⇒ 抽象点是 `account.channel`（这个字段本来就有，装配处也早写着"等第二个实现"），
 * 不是新造一个平行的"通道接口"。
 *
 * ## 与旧 `weixin` 段的关系（向后兼容是硬要求）
 *
 * - `im` 段**存在且 `accounts` 是数组** ⇒ 用它；
 * - 否则 ⇒ **回退读旧 `weixin` 段**（存量 CCC 零迁移，行为逐字不变）。
 * - 旧段**不删不改**：回滚 = 删掉 `im` 段即可。
 *
 * 🔴 **为什么判据是「`accounts` 是数组」而不是「有没有 im 段」**：
 * 本 CCC 的配置里**曾经**有过一个 `im` 段（退役的 ACP：`{channel:"acp", acp:{…}}`）。
 * 若只判"段存在"，那份残留会被当成新配置读 ⇒ **读到一个没有 accounts 的对象** ⇒
 * 表现为"配置没生效"且**不报错**。⇒ 形状判据必须能区分这两种 `im`。
 */
export interface ImSettings {
  /** 总开关（缺省 false——未开零资源占用） */
  enabled?: boolean;
  /** 账号表：**每条账号自带 `channel`**（`weixin` / `feishu`），凭据在 localstore */
  accounts?: ImAccountConfig[];
  /** 消息路由：**通道用户 id → 认知轨迹编码**（通道无关；`*` 通配兜底） */
  routes?: ImRouteConfig[];
  /** 用户别名表：`{ "<别名>": "<localstore 凭据键>" }` */
  aliases?: Record<string, string>;
  /** 消息记录 hook（相对 CCC 根的脚本路径） */
  hook?: string;
  // 🔴🔴 2026-10-24（owner 令，D238）：`autoReplyWithLastMessage` 与 `fallbackOnNoSend`
  // **字段整条删除**（不是"保留但忽略"）——出站只剩一条路：agent 自己调 `im-bridge`。
  // 旧配置里残留这两个键 ⇒ schemastery 非 strict ⇒ **静默忽略**，不影响加载。
  // 退役理由（owner 原话）：「autoReply 并不合适，主动性的 imBridge 仍然是更好的」。
  /** iLink 专属：bot_type 取码参数（飞书账号忽略它） */
  botType?: string;
}

/** 统一账号配置：**`channel` 决定用哪个实现**；其余字段各实现自查 */
export interface ImAccountConfig {
  /** 本地唯一键（如 wechat-1 / feishu-1） */
  accountId: string;
  /**
   * 账号实现（缺省 `weixin`——旧配置平移到 `im` 段时不必补这个字段）。
   * 未实现的 channel ⇒ **出声但不静默跳过**（装配处已有该分支）。
   */
  channel?: string;
  /** 展示名（可选） */
  name?: string;
  /** 该账号开关（缺省 true） */
  enabled?: boolean;
}

/**
 * 统一路由配置：**通道用户 id → 认知轨迹编码**。
 *
 * 与旧 `WeixinRouteConfig` 语义完全相同（那是它的超集形态）；保留别名仅为读侧兼容。
 */
export interface ImRouteConfig {
  /** 通道用户 id（微信 `xxx@im.wechat` / 飞书 `open_id`）；`*` = 通配兜底 */
  user: string;
  /** 目标认知轨迹编码 */
  trajectory: string;
  /** @deprecated 过渡别名（语义等同 `trajectory`） */
  role?: string;
}

/**
 * 微信桥配置（CCC 级；S142 用户拍板）：
 * - 结构/路由/开关在 .opencode/serenity.json（git 管可重建）
 * - **bot_token 凭据在 CCC localstore**（weixin.accounts.<accountId>.token/.baseUrl/.userId）——
 *   扫码登录后插件自动写入（面板只显示"已绑定"），永不进 git 明文面
 * - 路由 user → role：exact 匹配优先，通配 `*` 兜底；role 必须是该 CCC 轨迹约束.roles 之一
 * - 多账号：accounts[] 每项 { accountId, name?, enabled }（本地唯一键，如 wechat-1）
 *
 * 🔴 2026-10-19：**本段已被统一 `im` 段取代**（见上方 `ImSettings`）。此处保留是因为
 * 存量 CCC 的配置里写的就是它——读侧继续认，**不强制迁移**。
 */
export interface WeixinSettings {
  /** 总开关（缺省 false——默认关，未开零资源占用） */
  enabled?: boolean;
  /** bot_type（iLink 取码参数；实证 3 可用，留配置项应对未来语义变化） */
  botType?: string;
  /** 账号表（本地键 accountId；凭据在 localstore） */
  accounts?: WeixinAccountConfig[];
  /** 消息路由：微信用户 → 该 CCC 的 轨迹约束 role（不绑定具体 role——用户自选） */
  routes?: WeixinRouteConfig[];
  /**
   * 用户别名表（v1.56.10）：`{ "<别名>": "<localstore 凭据键>" }`。
   *
   * 🔴 **为什么搬到这里**（2026-10-14 隐私核查）：别名（家人称呼）**是 CCC 的数据，不是 ACC 的机制**
   * ——按 D23 归属判据「改它要不要发版」：加一个家人别名**不该**要动插件源码并发版。
   * 此前别名硬编码在 ACC 源码里，导致**家人称呼随 npm 包公开发布**。
   * 归位后 ACC 不认识任何具体人名；别名由各 CCC 自配（留空 = 只用裸 iLink 用户 id）。
   */
  aliases?: Record<string, string>;
  /**
   * 消息记录 hook（v1.27.13，用户"微信桥所有消息记录，支持 hook，CCC 自写持久性保存"）：
   * 相对 CCC 根的脚本路径——微信桥每收/发一条消息触发一次（事件 JSON 经 stdin 传入，
   * 脚本自行持久化：写文件/入库/推远端全归 CCC）。未配置 → 零变化（不触发）。
   * 执行语义：旁路 fire-and-forget + 超时 + 失败仅日志（微信桥可靠性不受 hook 影响）。
   */
  hook?: string;
  // 🔴🔴 2026-10-24（owner 令，D238）：`autoReplyWithLastMessage` 与 `fallbackOnNoSend`
  // **已整条退役**（字段删除）。出站只剩一条路：agent 自己调 `im-bridge`。
  //
  // 历史留档（R↓，被否的两条设计）：
  //  - `autoReplyWithLastMessage`（v1.30.10）：桥替 agent 说最后一句。**被否理由**：owner
  //    「autoReply 并不合适，主动性的 imBridge 仍然是更好的」——自动回发让 agent 无法决定
  //    "说几条/什么时候说/要不要不说"，而这正是主动发送要解决的问题。
  //  - `fallbackOnNoSend`（v1.30.17）：手动模式下 agent 一次没发成功时桥兜底转发。
  //    **随之失效** —— 它只在 `autoReplyWithLastMessage=false` 时才有意义，而后者已不存在。
  //    ⚠️ 它的移除意味着：**agent 不发 ⇒ 用户确实收不到**。这是有意的取舍（输出权完全归 agent），
  //    代价由 D234 的修法承担：guard 打回前必须确认 `im-bridge` 对该轨迹**可见**，
  //    否则"没权发"会被误读成"忘了发"。
}

// ⚠️ `ImSettings` / `ImAcpSettings` / `ImAcpAccount` **已删除**
//    （owner 2026-10-19 裁「完整删除整个 ACP 的实现」，见 `2026-10-19 ACP 整面退役`）。
//    IM 入站通道只剩微信一种实现 ⇒ "选通道"这个选择器本身失去意义，一并移除。
//    旧配置里残留的 `im: { channel: "acp", acp: {…} }` ⇒ **静默忽略**（schemastery 非 strict）。

/** 微信桥账号配置（serenity.json 内；凭据部分在 localstore） */
export interface WeixinAccountConfig {
  /** 本地唯一键（如 wechat-1；localstore 凭据键 weixin.accounts.<accountId>.*） */
  accountId: string;
  /** 展示名（可选；如"家庭助手"） */
  name?: string;
  /** 该账号轮询开关（缺省 true） */
  enabled?: boolean;
}

/**
 * 微信桥路由配置：微信用户 → 该 CCC 的**认知轨迹编码**
 *
 * 🔴 2026-10-19（owner 重做令）：「微信桥的路由表修改为 **user → 认知轨迹的映射**」。
 * 旧形态指向 `轨迹约束.roles` 里的**角色名**；新形态直接指向**轨迹编码**
 * （= 目录名固定位置那一段；该轨迹目录里有 `trajectory-constraint.json` 时它就是 轨迹约束）。
 */
export interface WeixinRouteConfig {
  /** 微信用户标识（from_user_id，形如 userA@im.wechat）；`*` = 通配兜底 */
  user: string;
  /**
   * 目标**认知轨迹编码**（必须是该 CCC 内一条活跃轨迹的编码；ACC 不绑定——用户自选）。
   * ⚠️ 存量配置里的 `role` 字段仍被读取作**过渡别名**（读侧 `routeTarget` 统一解析），
   * 但**新写法是 `trajectory`**，且两者都给时 `trajectory` 优先。
   */
  trajectory: string;
  /** @deprecated 过渡别名：语义已等同于 `trajectory`（见上）。新配置不要写它。 */
  role?: string;
}

/**
 * 🔴 **`TrajectoryConstraintConfig` 已于 2026-10-19 退役**（owner 重做令）。
 *
 * 它的语义整体搬进**轨迹目录下的 `trajectory-constraint.json`**，类型现在是
 * `trajectory/policy/profile.ts` 的 `TrajectoryConstraint`（在那里还多了 `code`/`dirName`/`path`
 * 三个与轨迹身份相关的字段）。
 *
 * 退役理由（一句话）：轨迹约束的约束面是**某一条轨迹的属性**，不是容器级配置表里的一个 entry。
 * 放进 `serenity.json` 会让"这条轨迹是不是 轨迹约束"分散在**两个文件**里，而 owner 要的是
 * 一条判据（「目录下拥有 `trajectory-constraint.json` 的认知轨迹自动是一个 轨迹约束」）。
 *
 * ⚠️ 旧字段里 `kind: temporary|persistent` **整件无对应物**：它区分"有没有工作台"，
 * 而新模型里 轨迹约束恒等于一条轨迹 ⇒ 恒有 SESSION.md ⇒ 该区分没有指称对象（静默忽略）。
 */

/**
 * 🔴 **`readCheapWorkerConfig` / `pickModelSection` 已于 2026-10-28 删除**
 * （owner 令「下线 cheap-worker，完全删掉」）。
 *
 * 它们原本有三个消费者，三个都已同步处置：
 * | 消费者 | 处置 |
 * |---|---|
 * | `tools/cheap-worker.ts`（模型白名单校验） | 文件整体删除 |
 * | `surface/status.ts` 的 `cheapWorkerModel`（面板回显） | 字段删除（面板同步） |
 * | `tools/trajectory-constraint-admin.ts` 的 `model ∈ cheap-worker.models` 校验 | **校验整条移除** |
 *
 * ⚠️ 最后一条要说清（R↓）：那条校验原本是「轨迹约束声明的 model 必须在 CCC 白名单里」。
 * 白名单随 cheap-worker 一起消失 ⇒ **它失去了判据来源**。而模型合法性本来就有
 * **更权威的判据**（`trajectory/model-runtime.ts`：宿主报非法模型 ⇒ 不切＋响亮告警）
 * ⇒ 删掉它**不是丢了一个保护，而是去掉一份与权威判据并行的第二真相源**（D131 同族）。
 */

/**
 * ACC 依赖的 CCC 配置路径（S134 修正：兼容历史——历史在 .opencode，规范位置 = .opencode；
 * .dsh 仅作 dsh 运行时回退，不优先）。
 */
export const DEFAULT_SERENITY_CONFIG_PATHS = ['.opencode/serenity.json', '.dsh/serenity.json'];

/**
 * 读取 UTF-8 文件并剥离 BOM（Windows 审计问题 16）：PowerShell/Windows 编辑器
 * 写出的 BOM（\uFEFF）会让 JSON.parse 抛错（配置静默变空）或 frontmatter 检测失败（技能被丢弃）。
 */
export function readUtf8(path: string): string {
  return readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
}

/**
 * 已告警过的损坏配置路径（进程级去重：同一坏文件不刷屏，但绝不静默）。
 * S142 review F-07：此前损坏 → 静默返回 `{}`——安全模式黑名单/轨迹约束角色
 * 全部**无声失效**（用户以为配了，实际没配）。守卫的输入失败必须响亮。
 */
const warnedBrokenConfigs = new Set<string>()

/**
 * 读取 CCC 配置（第一个存在且可解析的候选路径）。
 *
 * 失败语义（F-07）：文件存在但**解析失败** → 记录响亮告警（含路径与原因，每路径一次）
 * 并返回 `{}`。选择 fail-open 而非抛错的理由：apply 期抛错 = 整个 dsh 启动失败
 * （app-boot "plugin(s) failed to load"），而单个 CCC 配置损坏只应影响该 CCC 的功能降级；
 * 告警 + `dashboard health` 让损坏可见可修。
 * @param root CCC 根
 * @param paths 候选相对路径（按序取第一个存在的）
 * @returns 解析后的配置；无文件/损坏 → `{}`
 */
export function loadSerenityConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): SerenityConfig {
  for (const candidate of paths) {
    const p = resolve(root, candidate);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readUtf8(p)) as SerenityConfig;
    } catch (err) {
      if (!warnedBrokenConfigs.has(p)) {
        warnedBrokenConfigs.add(p);
        console.warn(
          `[serenity-hooks] ✗ CCC 配置解析失败，已按空配置继续（该 CCC 的安全模式黑名单/轨迹约束角色等全部失效，请修 JSON）: ${p} — ${String((err as Error)?.message ?? err)}`,
        );
      }
      return {};
    }
  }
  return {};
}

/**
 * （已删除）`readExclusiveTools` —— v1.106.0 随 `exclusiveTools` 机制整体删除。
 * 原语义：读 CCC 声明的专属工具清单，fail-closed（读不到 ⇒ 空数组 ⇒ 专属工具保持隐藏）。
 * 删除理由见 `SerenityConfig.exclusiveTools` 处的注释（表空 ⇒ 不可证伪）。
 */

/**
 * 读取 CCC 声明的轨迹消息订阅表（`trajectorySubscriptions`，v1.107.0）。
 *
 * ## 失败方向 = **fail-open，但坏项逐条报告**（与另外两处刻意不同）
 *
 * 不订阅 ≠ 危险动作：它只是"没有通知"，不会藏掉任何能力（对比 `safeMode.hiddenTools`
 * 是 fail-open 因为**隐藏**才是危险方向）。⇒ 整体读不到 ⇒ 空表。
 *
 * 🔴 **但"坏项"不能一起吞掉**：配置里写了这一条、却因为成员名写错而**永远不触发**，
 * 是与 `safeMode.hiddenTools` 写错工具名**同族的静默失效**（写了但不生效，且没人知道）。
 * ⇒ 本函数返回 `{ subs, problems }`：合法项照常生效，坏项进 `problems` 供调用方响亮告警。
 * ⚠️ 这与"整表读不到就空表"并不矛盾：前者是**文件级**失败（无法解析），
 * 后者是**条目级**失败（能解析但内容不成立）—— **两个粒度、两种处置**（D233 同族）。
 *
 * @param root CCC 根
 * @param paths 候选配置相对路径
 * @returns `subs` = 干净的订阅表；`problems` = 逐条可读的坏项说明（空数组 = 全好）
 */
export function readTrajectorySubscriptions(
  root: string,
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): { subs: TrajectorySubscription[]; problems: string[] } {
  const raw = loadSerenityConfig(root, paths).trajectorySubscriptions;
  if (!Array.isArray(raw)) return { subs: [], problems: [] };
  const subs: TrajectorySubscription[] = []
  const problems: string[] = []
  raw.forEach((item, i) => {
    const at = `trajectorySubscriptions[${i}]`
    if (typeof item !== 'object' || item === null) {
      problems.push(`${at}: 不是对象（应为 { watcher, members }）`)
      return
    }
    const rec = item as unknown as Record<string, unknown>
    const watcher = typeof rec.watcher === 'string' ? rec.watcher.trim() : ''
    if (watcher === '') {
      problems.push(`${at}: watcher 缺失或为空（必须指定谁来收通知）`)
      return
    }
    const membersRaw = Array.isArray(rec.members) ? rec.members : null
    if (membersRaw === null) {
      problems.push(`${at}（watcher=${watcher}）: members 不是数组`)
      return
    }
    const members = membersRaw
      .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      .map((m) => m.trim())
    if (members.length === 0) {
      problems.push(`${at}（watcher=${watcher}）: members 为空 ⇒ 这条订阅永远不会触发`)
      return
    }
    // 🔴 观察自己：语法上合法但语义上是自噪声（自己每轮结束都通知自己一次 ⇒ 自激）
    if (members.some((m) => m === watcher)) {
      problems.push(`${at}（watcher=${watcher}）: members 含 watcher 自己 ⇒ 会形成自激通知，已剔除该项`)
    }
    const cleaned = members.filter((m) => m !== watcher)
    if (cleaned.length === 0) return // 剔完就空了 ⇒ 整条不生效（已在上句报告）
    subs.push({
      watcher,
      members: cleaned,
      enabled: rec.enabled === false ? false : true,
      ...(typeof rec.note === 'string' && rec.note.trim() !== '' ? { note: rec.note.trim() } : {}),
    })
  })
  return { subs: subs.filter((s) => s.enabled !== false), problems }
}

/**
 * 读取 CCC 声明的「安全模式期间隐藏的工具」清单（`safeMode.hiddenTools`，v1.51.4）。
 *
 * 语义（R↓）：**标记文件存在 ⇒ 才生效**。deny = `['bash', ...本清单]`（并集去重）；
 * 标记消失 ⇒ 连同 `bash` 一起解除（调用点在 `syncSafeModeRestriction`，与基础表同一处）。
 *
 * 失败方向 = **fail-open**（与已删除的 `exclusiveTools` 的 fail-closed 相反，理由不同）：
 * 未配置 / 字段缺失 / 配置损坏 ⇒ **空数组** = 只隐藏基础表。本键是**附加**屏蔽，
 * 读不到声明就等于"没有证据要求多藏"；且**隐藏是危险方向**（藏掉 agent 真正要用的工具
 * 会静默损害能力），而配置损坏本身已有 `loadSerenityConfig` 的响亮告警（不静默）。
 *
 * 🔴 名字在此**不做**校验——未注册的名字会被 DSH `restrict` 拒绝（宿主契约逐字：
 * "Empty filters, unknown names, scope-local names, and reserved transport names **fail**"）
 * ⇒ **调用方必须按"失败退化为基础表"处理**（见 `syncSafeModeRestriction`），
 * 否则 CCC 写错一个名字会连 `bash` 的隐藏一起丢掉。
 *
 * @param root CCC 根
 * @param paths 候选配置相对路径
 * @returns 去空白后的工具名列表（非字符串/空白项被丢弃）
 */
export function readSafeModeHiddenTools(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string[] {
  const list = loadSerenityConfig(root, paths).safeMode?.hiddenTools;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
}

/**
 * 读取 CCC 声明的「轨迹默认 skill」清单（`trajectory.skills`，v1.44.0）。
 *
 * 语义与失败方向（R↓）：
 *   · 有声明 ⇒ 该 CCC **每条被绑定的轨迹**都注入这些 skill（与轨迹自己的声明**并集**）；
 *   · 未配置 / 字段缺失 / 配置损坏 ⇒ **空数组** = 无 CCC 级供给（**轨迹级声明不受影响**）。
 *     这里不必像 `exclusiveTools` 那样强调 fail-closed：本键的默认态本就是"无供给"
 *     （空数组即该默认态），且配置损坏已有 `loadSerenityConfig` 的响亮告警兜住。
 *
 * 🟢 **名字**在此**不做**安全过滤——那是装配层的职责（`trajectory-skills.ts` 走 `isSafeSkillName`
 * 后才拼路径）。本函数只做"取字符串、去空白、丢非字符串"，**保持书写顺序**（注入顺序 = 书写顺序）。
 *
 * @param root CCC 根
 * @param paths 候选配置相对路径
 * @returns 去空白后的 skill 名列表（非字符串/空白项被丢弃）
 */
export function readCognitiveTrajectorySkills(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string[] {
  const list = loadSerenityConfig(root, paths).cognitiveTrajectory?.skills;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
}

// ── 安全模式 ──
export const SAFE_MODE_MARKER = '.serenity-safe-on';

export function isSafeModeOn(root: string): boolean {
  return existsSync(resolve(root, SAFE_MODE_MARKER));
}

/** 黑名单条目（对齐 osp BlacklistEntry）：pattern + 可选自定义拦截提示 message */
export interface BlacklistRule {
  pattern: string;
  message?: string;
}

/**
 * 读取黑名单（对齐 osp readBlacklist）：支持两种条目格式——
 *   string：".secrets/" 或 "regex:^..."（前缀 / 正则）
 *   object：{ "pattern": ".secrets/", "message": "自定义提示" }
 * dsp v1.17.4 前只支持 string（对象会被 String() 成 "[object Object]" → 规则失效，不拦截）。
 */
export function readBlacklist(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): BlacklistRule[] {
  const cfg = loadSerenityConfig(root, paths);
  const rules = cfg.safeMode?.blacklist;
  if (!Array.isArray(rules)) return [];
  const out: BlacklistRule[] = [];
  for (const item of rules) {
    if (typeof item === 'string') {
      if (item) out.push({ pattern: item });
    } else if (item && typeof item === 'object' && typeof (item as { pattern?: unknown }).pattern === 'string') {
      const obj = item as { pattern: string; message?: unknown };
      const p = obj.pattern;
      if (p) out.push({ pattern: p, message: typeof obj.message === 'string' ? obj.message : undefined });
    }
    /* 非法条目跳过 */
  }
  return out;
}

/** 匹配黑名单规则；命中返回条目，未命中返回 null。前缀匹配 / regex: 前缀（对齐 osp）。Windows：规则反斜杠归一化为正斜杠与 rel 对齐 */
export function matchBlacklist(relPath: string, rules: BlacklistRule[]): BlacklistRule | null {
  for (const rule of rules) {
    if (rule.pattern.startsWith('regex:')) {
      try {
        if (new RegExp(rule.pattern.slice(6)).test(relPath)) return rule;
      } catch {
        /* 非法正则跳过 */
      }
    } else {
      const pat = rule.pattern.split('\\').join('/')
      if (relPath.startsWith(pat)) return rule;
    }
  }
  return null;
}

/** 写类工具名（safe-mode 下禁止） */
const WRITE_TOOLS = new Set(['bash', 'write', 'edit', 'str_replace_editor', 'container_fs']);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}
