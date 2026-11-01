/**
 * guards.ts — 拦截缝：安全模式 + 路径守卫（P3 语义的机械层）
 *
 * 纯决策逻辑（decideGuard）与 DSH 注册（registerGuards）分离：
 * 前者零 DSH 依赖可单测，后者把决策接到 tools/pre-execute 瀑布 + ctx.tools.guard 终局。
 *
 * 对应 opencode-serenity-plugin 的 tool.execute.before 路径守卫 + bash 开关 + 黑名单。
 */

import { resolve, relative } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type { Context } from 'cordis'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  isSafeModeOn,
  matchBlacklist,
  readBlacklist,
  pathInside,
  readCccName,
  readSafeModeHiddenTools,
  type BlacklistRule,
} from '../kernel/ccc.js'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { trajectoryConstraintForSession, trajectoryCodeForSession, type TrajectoryConstraint } from '../trajectory/policy/profile.js'
import { profileToolWhitelist, profileWriteWhitelist } from '../trajectory/policy/rules.js'
import { isImWiredTrajectory } from '../im/channels.js'
import { REGISTERED_TOOLS, CONDITIONAL_TOOL_COUNT } from '../kernel/invariant.js'
import { isoLocal } from '../kernel/time.js'
import {
  applyVisibilityDecision,
  collectVisibilityDecision,
  getToolVisibilityDiagnostics,
  type VisibilitySource,
} from './tool-visibility.js'

// ── 纯决策（可单测）──

export interface GuardInput {
  root: string
  toolName: string
  safeModeOn: boolean
  blacklist: BlacklistRule[]
  /** 工具参数中可能携带的路径（write/edit 等）；无则 undefined */
  pathArg?: string
  /** container_fs 等复合工具的子命令 action（只读子命令不查黑名单） */
  action?: string
  /**
   * 该会话的 轨迹约束面（`null`/`undefined` = 不是 轨迹约束会话 ⇒ 不判定）。
   *
   * 🔴 2026-10-19 起传**已解析好的约束面**，不传 sessionId：解判据（"这条轨迹有没有
   * `trajectory-constraint.json`"）留在唯一入口 `profile.ts`，守卫只消费结果 ⇒ 纯函数里不再做 IO，
   * 也不可能出现"守卫的判据与 schema 收窄的判据不一致"。
   */
  trajectoryConstraint?: TrajectoryConstraint | null
}

/** 写类工具名（黑名单/治理文件只拦这些；读工具只做路径越界检查——对齐 osp） */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'container_fs', 'bash', 'touch'])

/** container_fs 的写类子命令（mkdir/rm/mv/cp/touch）；其余 9 子命令（root/resolve/exists/
 *  list/tree/relative/reveal/info/find）为只读——只读子命令不查黑名单（同 read 语义）
 *  🔴 `append` 已于 v1.101.0 退役（owner 2026-10-26），故不在此集合。 */
const CC_FS_WRITE_ACTIONS = new Set(['mkdir', 'rm', 'mv', 'cp', 'touch'])

/**
 * 凭据文件硬名单（数据面守卫，v1.26.3，S142 用户：localstore.json 需要在 read 工具的黑名单里）：
 * **任何工具**（含 read/grep/glob/container_fs 只读子命令）命中这些相对 CCC 根的路径 → deny。
 *
 * 与 safeMode.blacklist（写黑名单，v1.18.5 决策只拦写）语义独立：
 * - 黑名单 = 用户可配置的写保护（REPOSITORIES/ 等只读参考源不误伤读）
 * - 凭据硬名单 = **结构性数据面边界**（不依赖 safe-mode 开关，凭据文件任何时候不可读）——
 *   对齐 CCE Bounded Space + wardn "structural guarantee, not policy"：localstore.json
 *   含 API keys/tokens/SSH 密码，即使 prompt 纪律失败也无值可吐（机械保证）。
 */
const SENSITIVE_CREDENTIAL_FILES = new Set(['localstore.json'])

/**
 * MSM 注册表写保护（需求⑤b S142 用户拍板："msm注册的文件需要写保护起来，避免CCC意外写坏搞崩自己"）：
 * mech-registry.json 是 CCC 执行层地基（坏 → loadMsmEntries 抛 → container_admin/output-guard 全崩，
 * register 也崩 → 自锁）。**写 deny、读 allow**（与 localstore 读 deny 语义区分 R6——注册表是
 * 结构核心不是秘密，需被 output-guard/trajectory-constraint-admin 读取建 MSM 词表）。
 *
 * 单级化（需求⑤a）后**唯一合法注册表 = cccName 聚合档**
 * `.opencode/skills/<cccName>/references/mech-registry.json`（cccName = .serenity 首行）。
 * 历史 root 级 `mech-registry.json` 与各 skill 分散注册表已废弃：**不再保护**
 * （review P1：保护一个永不被读的文件 = 死锁——MSM 既不可见又不可删/迁移）。
 * 写工具命中聚合档 → deny（唯一合法写通道 = container_admin msm register/deregister
 * 内部 writeRegistry，走工具实现不经 pre-execute → 天然豁免）；读工具放行。
 */
function isProtectedRegistryRel(root: string, rel: string): boolean {
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const relCi = lower(rel)
  // cccName 聚合档：.opencode/skills/<cccName>/references/mech-registry.json
  // 注：大小写比较按平台（win32 不敏感 / posix 敏感）——review P2-1：Linux 大写 CCC 名不得误放行
  // cccName 解析统一走 kernel/ccc.ts readCccName（review P2-2：跳过 # 注释/空行首非空行，四处单源）
  try {
    const marker = resolve(root, '.serenity')
    if (existsSync(marker)) {
      const line = readCccName(root)
      if (line) {
        const aggregate = `.opencode/skills/${line}/references/mech-registry.json`
        const aggregateCi = lower(aggregate)
        if (relCi === aggregateCi) return true
        // review P2-2：精确文件保护可被 `rm -r references/`（删父目录）绕过——
        // **references/ 目录本身**纳入保护（rm -r references/ 即毁注册表）。
        // review P1-1（复验收窄）：只保护 references/ **目录节点本身**（rm -r / mv 目录 deny），
        // **不含子树前缀**——references/ 内与 mech-registry.json 并置的合法知识文档
        // （msm-writing-standards.md 等，home-serenity 实测 8 个）必须可正常维护。
        // 防绕过语义 = 目录节点相等已足够（删目录 rm -r/mv 目标恰是 references/ 自身）；
        // 前缀会把"删目录"放大成"子树内任何写"= 过保护（复验 P1-1，09-05）。
        const refsDir = `.opencode/skills/${line}/references`
        if (relCi === lower(refsDir)) return true
      }
    }
  } catch {
    /* 读标记失败 → 无法定位聚合档 → 不保护（保守放行删除，避免死锁） */
  }
  // root 级 + 其他 skill 目录分散注册表 = 废弃形态：不保护（允许删除/迁移）
  return false
}

/** 判定工具是否为写类：普通工具按名；container_fs 复合工具按子命令 action */
function isWriteTool(toolName: string, action?: string): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false
  if (toolName === 'container_fs') return action !== undefined && CC_FS_WRITE_ACTIONS.has(action)
  return true
}

interface GuardDecisionResult {
  deny?: string
  kind: 'allow' | 'deny'
}

/**
 * 安全模式 + 黑名单 + P3 路径守卫的纯决策。
 * 对齐 opencode-serenity-plugin 标准：安全模式 = **bash 禁用** + 写入黑名单；
 * write/edit 等工具仅受路径逃逸与黑名单约束（不整体禁用）。
 * 优先级：safe-mode bash > 路径越界 > 黑名单命中。
 */
export function decideGuard(input: GuardInput): GuardDecisionResult {
  const { root, toolName, safeModeOn, blacklist, pathArg, action } = input

  // 0) 轨迹约束 约束（2026-10-19 重做）：会话绑定的轨迹有 `trajectory-constraint.json` ⇒ 工具必须 ∈ 白名单。
  //
  // 判据（D23 归属）：**机制在 ACC**（怎么判、怎么拒），**内容在 CCC**（`trajectory-constraint.json` 的白名单）。
  // 🔴 判据从旧版的「sessionId 前缀 `轨迹约束-`」换成「绑定轨迹有 `trajectory-constraint.json`」——
  //    前缀在新模型下会漏掉不带前缀的 轨迹约束会话，且会把**普通会话误判成 轨迹约束**
  //    （只要 id 恰好以 `轨迹约束-` 开头）。两种误判都是权限面问题，故判据必须打在轨迹上。
  // 由调用方（evaluate）传入 trajectoryConstraint；纯函数内通过 GuardInput 支持单测。
  // v1.25.3：skill 加载对 轨迹约束恒可用（S142 用户——skill 不设白名单；读知识面，无写能力）
  if (input.trajectoryConstraint !== undefined && input.trajectoryConstraint !== null) {
    const profile = input.trajectoryConstraint
    if (toolName === 'skill') return { kind: 'allow' }
    // v1.30.2（S142 用户 bug）：模型把 MSM 名（如 memory-tool）当**直接工具**调 →
    // 旧泛化 deny "tool not allowed" 误导成"没权限"。区分：
    // 工具名命中 msms 清单 = 已授权的 MSM 但调用格式错 → 明确提示经 msm() 单入口。
    // 安全：提示不泄漏白名单外的东西（只说"它是 MSM，请走 msm"）。
    // ⚠️ `msms` 现在可能是 `undefined`（D181：字段缺省 = 不收窄）⇒ 必须先兜空
    if ((profile.msms ?? []).includes(toolName)) {
      return {
        deny: `"${toolName}" is a registered MSM, not a direct tool in this trajectory — call it through the msm tool: msm("${toolName}", ["<args>"]) (pass "--help" or inspect=true for usage)`,
        kind: 'deny',
      }
    }
    // 🔴 D181（owner 2026-10-20 裁「不写当然不收窄」）：`null` = 这条轨迹没限制工具面
    //    ⇒ **不进入白名单判定**（继续走后面的 safe-mode / 路径 / 黑名单检查）。
    //    ⛔ 这里若把 `null` 当空集，会重演 S196 被静默锁死的形态（D179(b)）。
    const whitelist = profileToolWhitelist(profile)
    if (whitelist !== null && !whitelist.has(toolName)) {
      return { deny: 'tool not allowed in this 轨迹约束 trajectory', kind: 'deny' }
    }
    // 🔴 写路径白名单（owner 2026-10-20 令「轨迹设定自己的写白名单」）：
    //    给了 `write` **不等于**放开整个容器 —— `tools` 只管工具名，管不了"写到哪儿"。
    //    判据同 D181：**字段在不在**。缺省 ⇒ 不收窄（`profileWriteWhitelist` 返回 `null`）；
    //    `[]` ⇒ 一个写都落不下（显式意图）。
    //    只判**写类工具**且**带路径参数**的那一半：无路径的写（如 `bash`）由后面的守卫管。
    const writeScopes = profileWriteWhitelist(profile)
    if (writeScopes !== null && pathArg !== undefined && isWriteTool(toolName, action)) {
      const abs = resolve(root, pathArg)
      const inside = writeScopes.some((scope) => pathInside(resolve(root, scope), abs))
      if (!inside) {
        // 出声必须指名缺哪一条（D186/D190 同族）：只报"越界"会让人以为 CCC 根不对
        return {
          deny:
            `${toolName}: write outside this trajectory's declared write scope`
            + ` (allowed: ${writeScopes.length > 0 ? writeScopes.join(' / ') : '(none — "writes" is an empty array)'})`
            + `; target: ${pathArg}`
            + ' — add the prefix to this trajectory\'s trajectory.json "writes" if the write is intended',
          kind: 'deny',
        }
      }
    }
  }

  // 1) 安全模式：bash 一律禁用（标准语义）
  // 提示不泄露 safe-mode 机制（safe-mode 对 agent 不可见）：模型视角 = bash 工具不存在
  if (safeModeOn && toolName === 'bash') {
    return { deny: `bash: no such tool`, kind: 'deny' }
  }

  // 2) 携带路径参数：先查越界（读写都拦——安全），再查治理文件/黑名单（仅写类工具，对齐 osp）
  if (pathArg !== undefined) {
    const abs = resolve(root, pathArg)
    // pathInside 前缀+sep 边界+跨盘安全（Windows 兼容：跨盘 relative 返回绝对路径原文，
    // 旧 relative().startsWith('..') 漏判，见 Windows 审计问题 6）
    if (!pathInside(resolve(root), abs)) {
      return { deny: `path escape blocked: "${pathArg}" escapes the CCC root`, kind: 'deny' }
    }
    // 归一化反斜杠（Windows）：凭据文件硬名单与黑名单前缀匹配用正斜杠 rel
    const rel = relative(root, abs).split('\\').join('/')
    // 2a) 凭据文件硬名单（数据面守卫，v1.26.3）：**任何工具**命中 localstore.json →
    //     deny（不依赖 safe-mode 开关、不看工具读写性——凭据文件不可读是结构边界；
    //     read/grep/glob/container_fs 只读子命令与写工具一视同仁，防凭据值进上下文）
    if (SENSITIVE_CREDENTIAL_FILES.has(rel)) {
      return { deny: `access blocked: "${pathArg}" is a sensitive credential file (${rel})`, kind: 'deny' }
    }
    // 读操作（read/glob/grep 等）不查黑名单/治理文件——对齐 osp（permission-guards 只在
    // write/edit 时查黑名单）；否则 REPOSITORIES/ 这类"只读参考源"黑名单会误伤读操作
    // （用户实测：读 REPOSITORIES/ 下 repo 被拦，见 v1.18.5；container_fs 只读子命令同语义）
    if (isWriteTool(toolName, action)) {
      // CCC 治理文件永远拒绝写入（safe-mode 是用户能力，agent 不能自行开关/篡改）
      if (rel === '.serenity-safe-on' || rel === '.serenity' || rel.startsWith('.serenity-safe-on/') || rel.startsWith('.serenity/')) {
        return { deny: `CCC governance file "${rel}" is reserved for the user — agent must not write`, kind: 'deny' }
      }
      // 需求⑤b：MSM 注册表写保护（写 deny 读 allow）——container_admin msm register/deregister 是唯一合法写通道
      // review P2-2：保护范围含聚合档祖先目录（rm -r references/ / mv references/ 同拦）
      if (isProtectedRegistryRel(root, rel)) {
        const isFile = rel.endsWith('/mech-registry.json')
        return {
          deny: isFile
            ? `mech-registry.json is ACC-managed (${rel}) — use container_admin msm register/deregister instead of writing it directly`
            : `"${rel}" is an ancestor of the ACC-managed mech-registry.json — removing/moving it would destroy the registry; the registry is managed by container_admin msm register/deregister`,
          kind: 'deny',
        }
      }
      const hit = matchBlacklist(rel, blacklist)
      if (hit) {
        // 对象条目支持自定义提示（对齐 osp：{ pattern, message } → message ?? 默认）
        return { deny: hit.message ?? `blacklist blocked: "${pathArg}" matches rule "${hit.pattern}"`, kind: 'deny' }
      }
    }
  }

  return { kind: 'allow' }
}

// ── 工具可见性：六源汇一（方案 C，owner 2026-10-22 裁）────────────────────────────

/**
 * 🔴 **工具可见性的唯一发射入口**（方案 C 的落地）。
 *
 * ## 它取代了什么
 *
 * 改之前有六条独立 sync，每条在自己的 per-会话 Map 里放一个 `restrict` disposer，
 * 且都由 `pre-step`（每步）与 `seed`（冷载入）各自调用 ⇒ 一次交互里可能发出多次
 * `tools.restrict` ⇒ 宿主每次发 `tools/change` ⇒ 模型侧看到工具清单**先进后出**
 * （实测症状：`新增 7 个` 紧跟 `移除 7 个`）。
 *
 * ## 为什么合并是对的（不是简化）
 *
 * 宿主 `ToolRuntime.restrict` 契约逐字：**Restrictions intersect**。
 * ⇒ N 次 `deny: Dᵢ` 的净效果 = `⋃Dᵢ`。先求并集只发一次，**结果相同**、只触发一次 `tools/change`。
 * 前提 = **只用 `deny`**（`allow` 的"交集"不满足并集律）；本仓 18 处 restrict 全部只发 `deny`。
 *
 * ## 正确性怎么保住（这是本设计被质疑的那一点）
 *
 * 六源**各自独立**算自己的 deny 并**各自 catch**：某一个来源读配置抛错 ⇒ 它返回
 * `ok:false`（不贡献 deny），**其余五源照常生效**。⇒ 合并**不会**把一格的失败放大成六格。
 * 全量计算见 {@link computeVisibilitySources}（纯函数）。
 *
 * @param agent 目标会话
 * @param root  CCC 根；`null` ⇒ 不在 CCC 内 ⇒ 隐藏**全部** ACC 工具
 */
export function syncToolVisibility(agent: Agent, root: string | null): void {
  const sessionId = (agent.session as { id?: string }).id ?? 'global'
  const sources = computeVisibilitySources(sessionId, root)
  const decision = collectVisibilityDecision(sources)

  if (root !== null && decision.hasError) {
    // 只在 CCC 内报（非 CCC 的"根缺失"是常态，不是错误）
    const bad = sources.filter((s) => s.error !== undefined)
    for (const s of bad) {
      console.error(`[serenity-hooks] 工具可见性来源「${s.id}」判据失败（其余来源照常生效）: ${s.error ?? ''}`)
    }
  }

  const r = applyVisibilityDecision(agent, sessionId, decision)
  if (r.status === 'failed') {
    console.error(`[serenity-hooks] 工具可见性发射失败 (session=${sessionId}): ${r.error ?? ''}`)
  } else if (r.dropped.length > 0) {
    // 剔掉的是"本 CCC 没注册的名字"（典型：diagram 关着 / 宿主没装 schedule 包）——常态，不刷 error
    console.log(
      `[serenity-hooks] 工具可见性：跳过 ${r.dropped.length} 个未注册名（${r.dropped.join(', ')}）`,
    )
  }
}

/**
 * 六源 → 各自的 deny 集合（**纯函数：只读配置、不碰宿主**）。
 *
 * 每条来源**自己负责自己的失败**：抛错就 catch 在这里，转成 `ok:false + error`。
 * ⛔ 绝不让一个来源的异常冒泡 —— 那会让另外五源一起失效（正是合并最容易犯的错）。
 */
export function computeVisibilitySources(sessionId: string, root: string | null): VisibilitySource[] {
  const out: VisibilitySource[] = []

  // ① 非 CCC ⇒ 隐藏全部 ACC 工具（两档：含条件工具 / 只常驻段）
  out.push(
    sourceOf('nonCcc', () => {
      if (root !== null) return { deny: [] }
      // 两档是历史原因（`diagram` 等条件工具可能未注册）——合并发射层已统一探活，
      // 这里直接用全表即可；保留条件工具会让探活把它们剔掉，效果相同。
      return { deny: [...REGISTERED_TOOLS] }
    }),
  )

  // 非 CCC 时其余五源都没有意义（没有 CCC 就没有配置可读）⇒ 显式记空
  if (root === null) {
    for (const id of ['safeMode', 'imBridge', 'hostSchedule', 'trajectoryConstraint'] as const) {
      out.push({ id, deny: [], ok: false })
    }
    return out
  }

  // ② 安全模式：基础表 ∪ CCC 声明的 hiddenTools（**只在安全模式开启时**贡献）
  out.push(
    sourceOf('safeMode', () => {
      if (!isSafeModeOn(root)) return { deny: [] }
      let declared: string[] = []
      try {
        declared = readSafeModeHiddenTools(root)
      } catch (e) {
        // 声明读不到 ≠ 安全模式不生效：基础表仍必须藏（退化为只藏基础表）
        return { deny: [...SAFE_MODE_DENY_TOOLS], error: (e as Error).message }
      }
      return { deny: [...new Set([...SAFE_MODE_DENY_TOOLS, ...declared])] }
    }),
  )

  // ③ im-bridge：**轨迹级**判据（2026-10-23 owner 令）
  //
  // owner 原话（**去标识改写**：原文含私有角色名，按 D145 不入仓库）：
  // 「很多轨迹发消息给我，但是我没空回，它们就会等待我，其实并不是，我希望他们继续工作；
  //   所以只有 IM 桥绑定了任意账户的认知轨迹才拥有 im-bridge 这个 tool，
  //   这样可以确保只有一个接线角色和我联系，其它轨迹和它联系即可，它会自行回复它们的」
  //
  // **旧判据 = CCC 级**（`hasEnabledImChannel(root)`：本 CCC 有任一启用账号 ⇒ **全体可见**）。
  // 后果不是"少一个工具"，而是**一条错误的工作流**：每条轨迹都以为自己该直接对 owner 说话
  // ⇒ 发完就**停下来等人回**，而 owner 根本没空逐条回。**工具在，就把"等待"也一起给了。**
  //
  // **新判据 = 轨迹级**：本会话所属轨迹出现在 IM 路由表（`routes[].trajectory`）里才可见。
  // ⚠️ **取不到轨迹编码 ⇒ 不可见**（fail-closed，与 `exclusive` 同向）：
  //    反向放行会让"绑定坏了"表现成"工具还在"，而那正是本判据要防的形态（D179）。
  out.push(
    sourceOf('imBridge', () =>
      isImWiredTrajectory(root, trajectoryCodeForSession(root, sessionId))
        ? { deny: [] }
        : { deny: [IM_BRIDGE_TOOL_NAME] },
    ),
  )

  // ④ （原「专属工具」源已于 v1.106.0 删除 —— owner 2026-11-01 裁「机制整体删」）
  //    原语义：`EXCLUSIVE_TOOL_NAMES` 里的名字要 CCC 在 `exclusiveTools` 点名才可见（fail-closed）。
  //    删除理由（刻意的，不是顺手）：那张表**永远只有一个成员** `acc-diag`，而它已并入常驻的
  //    `dashboard`。表空之后 `filter` 恒回 `[]` ⇒ 机制**静默空转、且任何测试都证伪不了它**
  //    （一个验不出死活的机制比没有它更坏：它提供"这里还有一层保护"的错觉）。
  //    ⚠️ 连带：CCC 配置键 `exclusiveTools` 同批删除（见 `kernel/ccc.ts`）。
  //    ⛔ 别为了"将来可能还要专属工具"把它留下 —— 将来再加时重建的成本低于长期养死代码。

  // ⑤ 宿主定时器工具：CCC 内一律屏蔽（owner 2026-10-17 令：与 CRO 冲突）
  out.push(sourceOf('hostSchedule', () => ({ deny: [...HOST_SCHEDULE_TOOL_NAMES] })))

  // ⑥ 轨迹约束白名单：deny = 我们注册的工具 − 白名单
  out.push(
    sourceOf('trajectoryConstraint', () => {
      const profile = trajectoryConstraintForSession(root, sessionId)
      if (profile === null) return { deny: [] }
      const allowed = profileToolWhitelist(profile)
      // 🔴 D181：`null` = 字段缺省 = 不收窄（不是"全禁止"）
      if (allowed === null) return { deny: [] }
      return { deny: REGISTERED_TOOLS.filter((n) => !allowed.has(n)) }
    }),
  )

  // ⑦ 常驻拒绝表：与安全模式**无关**，任何 CCC、任何时刻都藏（v1.106.0）
  //    ⚠️ 放在 exclusive 之后、其余之后都行——本模块只做并集，顺序不影响结果；
  //    放在这里是为了让"常驻项"与"条件项"在源码上仍读得出来是两回事。
  out.push(sourceOf('alwaysDeny', () => ({ deny: [...ALWAYS_DENY_TOOLS] })))

  return out
}

/**
 * 把一个"可能抛错的 denies 计算"包成来源（**统一在这里 catch**）。
 * 失败 ⇒ `ok:false`：本来源不贡献 deny，**其余来源不受影响**。
 */
function sourceOf(id: string, fn: () => { deny: readonly string[]; error?: string }): VisibilitySource {
  try {
    const r = fn()
    return { id, deny: r.deny, ok: true, ...(r.error !== undefined ? { error: r.error } : {}) }
  } catch (e) {
    return { id, deny: [], ok: false, error: (e as Error).message }
  }
}

// ── 安全模式基础表（下方 syncSafeModeRestriction 保留为**兼容入口**）──


/** 从 exec 提取 agent 会话 cwd（CCC 根检测基准）；无则回退进程 cwd */
function resolveAgentCwd(exec: ToolExecution): string {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent
  return agent?.session?.header?.cwd ?? process.cwd()
}

/**
 * 安全模式开启时从模型工具列表隐藏的工具 —— **基础表**（只隐藏 bash；write/edit 保留）。
 * 它**恒隐**、与 CCC 配置无关；CCC 声明的 `safeMode.hiddenTools` 是**附加**项（见下）。
 */
const SAFE_MODE_DENY_TOOLS = ['bash']

/**
 * **常驻拒绝表** —— 与安全模式**无关**，任何 CCC、任何时刻都隐藏（v1.106.0，owner 2026-11-01 令）。
 *
 * 为什么与 `SAFE_MODE_DENY_TOOLS` 分开成两张表（而不是往那张里加一项）：
 * 那张表的**名字即语义**——"安全模式期间的附加拒绝"。把常驻项塞进去会让"名字与行为不符"，
 * 而这类错位**没有机械信号**（D151：退役/错位的开关零信号）。⇒ 两张表、两条来源，各说各的。
 *
 * ## 首个条目：`ask_user_question`
 *
 * owner 原话（2026-11-01）：**「宁静号追求更高程度的自动化和轨迹协作，这种阻塞性的东西会降低效率」**
 * ⇒ 它会让一轮停下来等人回答，与"轨迹自驱 + 轨迹间协作"直接冲突。
 *
 * ⚠️ **边界（诚实标注，D255）**：
 *  - 本表是**藏**（`tools.restrict({deny})` 让模型看不见），**不是禁** —— 它不阻止经别的路径调用。
 *    要真禁得住需在 tool-call 层拦截，那是另一件事，不在本次范围。
 *  - 它**不依赖** `.serenity-safe-on`：安全模式关着也照样藏。
 *  - 宿主若不认识某个名字，`applyVisibilityDecision` 会从它的错误里解析并只剔掉那几个
 *    （⇒ 本表写错一个名字**不会**连累其它来源，也不会静默冻结）。
 */
const ALWAYS_DENY_TOOLS = ['ask_user_question'] as const

/**
 * agent key → 安全模式下的隐藏状态（v1.51.4：由"一次性 disposer"升级为"签名 ＋ 实际 deny ＋ disposer"）。
 *
 * 为什么记签名：CCC 的 `safeMode.hiddenTools` 可被改（配置热更新是既有语义）⇒ 每步必须能判
 * "清单变没变"——变了就重算（解除旧的、应用新的），没变则**一次 restrict 调用都不多发**。
 */
interface SafeModeRestriction {
  /** 本次**期望**的 deny 清单签名（退化时仍记期望值 ⇒ 不每步重试刷屏） */
  signature: string
  /** **实际生效**的 deny 清单（诊断用；退化时 = 基础表） */
  deny: string[]
  dispose: () => void
}

const safeModeRestrictions = new Map<string, SafeModeRestriction>()

/** restrict 诊断状态（status API 暴露；排查 restrict 未生效问题） */
interface RestrictDiagnostics {
  lastKey: string | null
  lastAttemptAt: string | null
  lastSuccess: boolean | null
  lastError: string | null
  activeKeys: string[]
  /** v1.51.4：每个 key **实际生效**的 deny 清单（排查"某工具为什么／为什么没被隐藏"） */
  denyByKey: Record<string, string[]>
}

const restrictDiag: RestrictDiagnostics = {
  lastKey: null,
  lastAttemptAt: null,
  lastSuccess: null,
  lastError: null,
  activeKeys: [],
  denyByKey: {},
}

export function getRestrictDiagnostics(): RestrictDiagnostics {
  return {
    ...restrictDiag,
    activeKeys: [...safeModeRestrictions.keys()],
    denyByKey: Object.fromEntries([...safeModeRestrictions].map(([k, v]) => [k, v.deny])),
  }
}

/** 诊断落盘：AGENT_SESSIONS/.restrict-diag.json（文件通道，避免 HTTP 自锁） */
function writeRestrictDiag(root: string): void {
  try {
    const dir = resolve(root, 'AGENT_SESSIONS')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, '.restrict-diag.json'),
      JSON.stringify({ ...getRestrictDiagnostics(), cccRoot: root }, null, 2) + '\n',
      'utf-8',
    )
  } catch {
    /* 诊断写盘失败忽略 */
  }
}


// ── im-bridge 条件可见（v1.31.0）──

/** 条件可见的 IM 工具名（与 tools/im/channels.ts 的注册名一致） */
const IM_BRIDGE_TOOL_NAME = 'im-bridge'

/** agent key → restrict disposer（im-bridge 隐藏状态；key 同安全模式 = 会话 id） */
const imBridgeRestrictions = new Map<string, () => void>()

/**
 * im-bridge 隐藏诊断（排查"工具为什么不在清单里"）。
 *
 * 🔴 方案 C 之后**唯一真相源**是 `seams/tool-visibility.ts` 的全局表。
 * 本函数只**读**它并回答"该会话当前是否隐藏了 im-bridge" ——
 * 不再自己维护第二份状态（那会让诊断与实现各说一套，D164 同族）。
 */
export function getImBridgeVisibilityDiagnostics(): { hiddenKeys: string[] } {
  const vis = getToolVisibilityDiagnostics()
  return { hiddenKeys: vis.keys.filter((k) => (vis.denyByKey[k] ?? []).includes(IM_BRIDGE_TOOL_NAME)) }
}

/**
 * 会话销毁清理（lifecycle 调用）。
 *
 * ⚠️ 方案 C 后撤销动作**只在** `forgetToolVisibility` 里做一次（那一次合并 restrict）。
 * 本函数保留为语义占位：重复撤销同一条 restrict 会抛错，故这里刻意不做动作。
 */
export function forgetImBridgeVisibility(_sessionId: string): void {
  /* 实际撤销见 forgetToolVisibility（lifecycle 已单独调用） */
}

// ── 🆕 宿主自带「定时器」工具在 CCC 内屏蔽（v1.59.5，owner 令 2026-10-17）──

const hostScheduleRestrictions = new Map<string, () => void>()

/** 诊断面：本会话已屏蔽的宿主定时器工具（排查"工具为什么不见了"） */
export function getHostScheduleHiddenDiagnostics(): { hidden: string[] } {
  return { hidden: [...hostScheduleRestrictions.keys()] }
}


/** 会话销毁清理（lifecycle 调用）——方案 C 后由统一清理撤销，这里保留语义占位。 */
export function forgetHostScheduleToolHiding(_sessionId: string): void {
  /* 实际撤销见 forgetToolVisibility */
}

// ── 专属工具条件可见（v1.33，S142 §32.11）──

/**
 * 宿主 `dsh-tool-schedule` 注册的 4 个模型可见工具名（**逐字**）。
 *
 * 🔴 **为什么要在 CCC 内屏蔽**（owner 原话：「这和 CRO 冲突，要求在宁静号激活情况下屏蔽掉」）：
 * 宁静号的唤醒/巡航走 `cognitive_trajectory send-later` → `AGENT_SESSIONS/wake-registry.json`
 * → 中心调度器 5min tick（D58）。宿主这套定时器是**另一个**真相源 ⇒ 两处记账、
 * CRO 判据失真、且模型可能顺手排一个"不在任何账本里"的唤醒。
 * ⚠️ 本清单**合并发射时不做探活**。⚠️ 现状缺口（v1.87.1 如实登记）：宿主**没装**
 *    `dsh-tool-schedule` 时，这 4 个名字会把整次 restrict 拒掉，而退档只保留 ACC 自己的名字
 *    ⇒ 这一格的屏蔽**不生效**（旧实现同样不生效，**未回归**；但"顺带修好了"这句是假的，已删）。
 */
const HOST_SCHEDULE_TOOL_NAMES = [
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
] as const

/**
 * （已删除）原「专属工具」表 `EXCLUSIVE_TOOL_NAMES` 与 `exclusiveRestrictions` / 
 * `getExclusiveToolsDiagnostics` —— v1.106.0 随 `exclusiveTools` 机制整体删除。
 * 删除理由见 {@link computeVisibilitySources} ④ 处的注释（空表不可证伪）。
 */

// ── 轨迹约束工具面：可见性同步（owner 2026-10-19 令「工具清单也要热加载」）──

/**
 * `sessionId` → { signature, dispose }（角色工具面 restrict 状态）
 *
 * `signature` = 本轮实际发出的 deny 清单（排序后 join）。用它做**幂等判据**：
 * 每次 pre-step 都重算白名单，只有**算出来的结果变了**才重新发 restrict
 * —— 配置不变就不重复发（restrict 会重建 schema，没必要每步都做）。
 */
const trajectoryConstraintRestrictions = new Map<string, { signature: string; deny: string[]; dispose: () => void }>()

/** 轨迹约束工具面诊断（排查"某工具为什么不在 轨迹约束的清单里"） */
export function getTrajectoryConstraintVisibilityDiagnostics(): { keys: string[]; denyByKey: Record<string, string[]> } {
  return {
    keys: [...trajectoryConstraintRestrictions.keys()],
    denyByKey: Object.fromEntries([...trajectoryConstraintRestrictions].map(([k, v]) => [k, v.deny])),
  }
}


/** 会话销毁清理（lifecycle 调用）。
 * ⚠️ 方案 C 后撤销只在 `forgetToolVisibility` 做一次；本函数保留语义占位。
 * 留着它的价值：lifecycle 的调用点表达"这条会话有轨迹约束可见性状态要清"，
 * 删掉调用点会让那件事**从代码里消失**（将来有人重加机制时找不到插点）。 */
export function forgetTrajectoryConstraintToolVisibility(_sessionId: string): void {
  /* 见 forgetToolVisibility */
}


/** 会话销毁清理（lifecycle 调用）——同上，语义占位。 */
export function forgetExclusiveToolsVisibility(_sessionId: string): void {
  /* 见 forgetToolVisibility */
}

// ── 🔴 非 CCC 会话：**全工具面隐藏**（v1.56.6，owner 2026-10-13 报缺陷）──

/**
 * 非 CCC 会话的工具隐藏状态（sessionId → restrict disposer）。
 *
 * 🔴 **为什么需要它（缺陷根因）**：工具是 `apply()` 里 `ctx.tools.register(...)` 注册到**宿主级**的
 * ⇒ 它们出现在**每一个**会话的工具清单里，**与会话 cwd 无关**。其余各缝（身份注入 ／ guards ／
 * keeper ／ output-guard ／ bootstrap）都已有 `if (!root) return` 这道门，
 * **唯独"工具可见性"这一层没有** ⇒ 在非 CCC 目录开会话时，模型仍看得见这 14 个工具，
 * 于是会去调 —— 调了才抛 `No CCC found`。**那是运行时报错，不是事先不可见**。
 *
 * 判据（owner 原话：「宁静号所有功能在非宁静号目录不生效」）：
 * - **在 CCC 内** → 解除隐藏（本机制**一次 restrict 都不发**，既有行为零改变）
 * - **不在 CCC 内** → `restrict({ deny: [...REGISTERED_TOOLS] })` ⇒ 从模型工具清单移除
 *
 * ⚠️ **与 `syncExclusiveToolsVisibility` 的分工**：那个管"CCC 内哪个工具可见"（按 CCC 配置判）；
 * 本函数管"**这个会话配不配看到任何 ACC 工具**"（按"在不在 CCC 内"判）。二者独立、可叠加。
 *
 * ⚠️ **必须逐个名字显式列出**：宿主的 `restrict` 对**未注册的工具名**会让**整次调用失败**
 * （`dsh-tools` 契约逐字："Empty filters, unknown names … fail"）⇒ 不能写通配。
 * 但 `REGISTERED_TOOLS` 是"插件**具备**的工具面"，其中 **`diagram` 是按开关注册的**
 * （缺省关 ⇒ 缺省**并不在册**）⇒ 直接拿全表去 deny **可能整次失败**，那样就会
 * **静默退回"工具照样可见"**＝缺陷没修好。故此处走**两档尝试**（见 `hideAllFor`）。
 */
const nonCccRestrictions = new Map<string, () => void>()

/** 非 CCC 隐藏诊断（排查"工具为什么不见了"） */
export function getNonCccHiddenDiagnostics(): { hidden: string[] } {
  return { hidden: [...nonCccRestrictions.keys()] }
}



/** 会话销毁清理（lifecycle 调用；防 per-会话 Map 无界增长） */
export function forgetNonCccToolVisibility(sessionId: string): void {
  const existing = nonCccRestrictions.get(sessionId)
  if (!existing) return
  try {
    existing()
  } catch {
    /* disposer 已失效 */
  }
  nonCccRestrictions.delete(sessionId)
}

/**
 * 从 exec 参数中提取常见路径字段（write/edit 工具）；宽松读取。
 * container_fs 复合工具：path（单路径）/ paths（数组）/ src / dst——取第一个命中（越界检查
 * 逐路径由 decideGuard 单 pathArg 覆盖；多路径字段取首个，避免漏检主体路径）。
 */
function extractPathArg(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'target', 'src', 'dst']) {
    const v = a[key]
    if (typeof v === 'string') return v
  }
  const paths = a['paths']
  if (Array.isArray(paths) && paths.length > 0 && typeof paths[0] === 'string') return paths[0]
  return undefined
}

/** 从 exec 参数提取 container_fs 子命令 action；无则 undefined */
function extractAction(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  return typeof a.action === 'string' ? a.action : undefined
}

interface GuardRegistration {
  /** 配置路径；缺省用 DEFAULT_SERENITY_CONFIG_PATHS */
  configPaths?: string[]
}

/**
 * 注册守卫：tools/pre-execute 瀑布 + ctx.tools.guard 终局。
 * 两者都从 CCC 根实时读取配置（无状态、无缓存）。
 */
export function registerGuards(ctx: Context, opts: GuardRegistration = {}): void {
  const configPaths = opts.configPaths

  const evaluate = (exec: ToolExecution): GuardDecisionResult => {
    const cwd = resolveAgentCwd(exec)
    const root = cccRootForCwd(cwd)
    if (!root) return { kind: 'allow' } // 非 CCC，不干预

    const safeModeOn = isSafeModeOn(root)
    const blacklist = readBlacklist(root, configPaths)
    const pathArg = extractPathArg(exec)
    const action = extractAction(exec)
    const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id
    // 轨迹约束面（**判据的唯一入口**在 profile.ts；此处只消费结果）
    const trajectoryConstraint = trajectoryConstraintForSession(root, sessionId)
    return decideGuard({ root, toolName: exec.name, safeModeOn, blacklist, pathArg, action, trajectoryConstraint })
  }

  // 瀑布：deny 短路执行
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const d = evaluate(exec)
    if (d.deny) return { kind: 'deny', reason: d.deny }
    return next()
  })

  // 终局 guard：只 deny，不可 allow（顺序无关的终局不变式）
  ctx.tools.guard((exec) => {
    const d = evaluate(exec)
    return d.deny
  })
}
