/**
 * system-prompt.ts — Induction（成员装配机制，specs v1.5.0 命名）装配文本构造
 *
 * 机制：把新实例（新会话 / rebuild 重建 / 新 agent）引入为轨迹成员的装配机制——本文件装配的文本
 * 即 Induction 骨架（8 块五层，specs README §5）：A 主体定义（ACC/Principles/CCE）→ B 质量规范（EAP）
 * → C 状态调节（状态块）→ D 工作供给（SKILL/Tools）→ E 任务指示（Session），稳定→易变装配序；
 * Metaphor 为 A 层世界模型记忆钩渲染层（不计入 8 块骨架）。
 *
 * **完全对齐 opencode-serenity-plugin 的 system.transform 注入内容**（compacting.ts）：
 * 结构（v1.19.8 精简，S142 重建视角 R↓）：
 *   1. `=== Serenity ACC ===`        — 身份（ACC/CCC 模型 ＋ 路径约定；**v1.124.0 起不含工具清单**）
 *   2. `=== Serenity Metaphor ===`   — 世界模型（三层隐喻域：船/航行/船员）
 *   3. `=== Serenity Principles ===` — 信念/边界（认知容器本体论 + 操作边界，v1.19.8 合并原 Constraints）
 *   4. `=== Serenity CCE ===`        — 时间约束（5 行为约束 + H_op，逐字对齐 osp）
 *   5. `=== Serenity EAP ===`        — 质量（E↑ R↓ S↑ 自检）
 *   6. 状态块（条件）                — Safe Mode / Localstore
 *   7. SKILL.md 全文                 — 该 CCC 顶层入口 skill 全量原文（不截断）
 *   7b. `=== Serenity Tools ===`     — **只剩 MSM 调用示例**（v1.124.0：工具清单已删，见 toolsBlock 注释）
 *   8. `=== Serenity Session ===`    — 活跃会话（id + dirName + mdPath + todowrite 首位约定）
 *
 * 注册：**全局** ctx `systemPrompt.section`（对齐 plan-mode 官方惯例），text 回调按
 * `context.agent` 的 cwd 动态解析 CCC 根 → 返回完整注入文本；非 CCC/无 agent 返回空。
 * 任何会话（主 agent / subagent / 后台 agent）装配系统提示词时自动获得。
 *
 * order = -50：位于 harness 身份（-100）之后、部署 persona（0）之前。
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from 'cordis'
// 类型引用：拉入 system-prompt 包的 cordis 声明增强（ctx.systemPrompt）+ agent 对 AssembleContext 的合并
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isSafeModeOn, readBlacklist, readCognitiveTrajectorySkills } from '../kernel/ccc.js'
import { agentCwdFor, cccRootForCwd } from '../kernel/ccc-roots.js'
import { ACC_VERSION } from '../kernel/constants.js'
import { findEntrySkills } from '../skills/discovery.js'
import { buildResourceIndex } from '../skills/resource-index.js'
import { readActiveSessionMd, DEFAULT_SESSION_SCOPE, sessionsRoot } from '../trajectory/core.js'
import { readLastBound } from '../trajectory/bound.js'
import {
  buildCognitiveTrajectorySkillsSection,
  hasCognitiveTrajectorySkillsDeclaration,
  COGNITIVE_TRAJECTORY_SKILLS_MAX_CHARS,
} from '../trajectory/skills.js'
import { recordSkillInjections } from '../surface/usage.js'
import { localstorePath, readGitTrack } from '../tools/localstore/service.js'
import { readAdvancedSettings } from '../kernel/config.js'
import { humorBlock } from './humor.js'
import { workRegisterBlock } from './work-register.js'
import { isTrajectoryConstrained, readTrajectoryConstraintAt } from '../trajectory/policy/profile.js'
import { createTrajectoryPromptReader, trajectoryPromptBlock } from '../trajectory/prompt.js'
import { planPromptInjection, type RawPromptInjection } from '../trajectory/prompt-injection.js'

/** 读取 persona 彩蛋配置（plugin 全局；未配置 → mode='' 彩蛋关闭） */
function readPersonaSettings(): { mode: string; overrideText: string } {
  try {
    const s = readAdvancedSettings()
    return { mode: s.persona.mode ?? '', overrideText: s.persona.overrideText ?? '' }
  } catch {
    return { mode: '', overrideText: '' }
  }
}

/** 读取脱口秀片段配置（D287；读取失败 ⇒ 视为关闭，不阻断装配） */
function readHumorSettings(): { enabled: boolean; bits: string[] } {
  try {
    const s = readAdvancedSettings()
    return { enabled: s.humor.enabled === true, bits: s.humor.bits ?? [] }
  } catch {
    return { enabled: false, bits: [] }
  }
}

/**
 * 读取工作语域配置（2026-11-05；读取失败 ⇒ 视为**开**——它是效率项，缺省即生效）
 * 🔴 注意与 humor 的缺省相反：humor 是装饰（缺省关），本项是效率（缺省开）。
 */
function readWorkRegisterSettings(): { enabled: boolean } {
  try {
    const s = readAdvancedSettings()
    return { enabled: s.workRegister.enabled !== false }
  } catch {
    return { enabled: true }
  }
}

/** 过滤掉对 agent 隐藏的内容（safe-mode 是用户能力，不对 agent 提及）。无 g flag：`.test()` 须逐行独立无状态，避免 lastIndex 游移漏滤（问题A） */
const HIDDEN_LINES = /安全模式|safe-mode|\.serenity-safe-on/

function sanitizeSkillContent(content: string): string {
  return content
    .split('\n')
    .filter((line) => !HIDDEN_LINES.test(line))
    .join('\n')
}

// ── Induction 装配块（8 块骨架五层 + Metaphor 渲染层；逐字对齐 opencode-serenity-plugin compacting.ts system.transform）──

/**
 * 1) 身份块：ACC 身份 + CCC 名（需求③ S142：工具清单移出为独立 toolsBlock 放装配末尾——身份先行、工具参考殿后）
 *
 * 🔴 **v1.124.0（owner 2026-11-09 令）��「删掉与宿主重复的工具面叙述」** —— 两处删除，判据同一条：
 * **工具面在宿主 schema 与 `REGISTERED_TOOLS` 里各有一份权威，提示词里再抄一份 → 工具退役时会静默撒谎**（D151 同族）。
 *  - 删 `The DSH platform tools remain available too (read/write/…/goal and more) — …` 整句：
 *    宿主自己注入这些工具的 schema，点名它们**零新增信息**；且这份名单**没人会在工具增减时同步**。
 *  - 删 `The complete built-in tool list is at the end of this prompt under the "Serenity Tools" heading — read it before using any ACC tool.`
 *    指向的那块清单已同批删除 ⇒ 留着就是**指向空处的指针**（比没有更坏：模型会去找）。
 * ⛔ **保留**：ACC/CCC 两行（身份）、CCC 名与路径约定行、`Additional MSMs registered by this CCC …` 一行
 * （MSM 是 CCC 注册的**另一层**，宿主 schema 里没有它，故它不重复）。
 */
export function identityBlock(root: string): string {
  const cccName = basename(root)
  return [
    '',
    '=== Serenity ACC ===',
    `ACC: dsh-serenity-hooks v${ACC_VERSION}`,
    `CCC: ${cccName}`,
    '',
    'You are running inside a Concrete Cognitive Container (CCC) —',
    'the runtime instance of an Abstract Cognitive Container (ACC).',
    'The ACC (this plugin) is a cognitive container harness: it provides',
    'deterministic tools, mechanical constraints, and session continuity.',
    '',
    '  ℹ️ Use relative paths from the CCC root for CCC-internal file operations (read/write/edit/glob/grep etc.), e.g. AGENT_SESSIONS/2026-08-14--S134--x/SESSION.md; Root / absolute SESSION.md paths are identifiers only, not tool arguments',
    '',
    'Additional MSMs registered by this CCC are available — call msm() with no arguments to list them, or msm("<name>") to execute one.',
    '',
  ].join('\n')
}

/**
 * 工具块（需求③ S142 用户拍板：工具列表移装配末尾 + MSM 调用示例）：
 * 原 accBlock 内嵌 13 行工具清单 → 独立成块放装配末尾（SKILL 后、Session 前）。
 * 身份先行（认知轨迹开头不被清单干扰）、工具参考殿后（需要时再看）。
 *
 * 🔴🔴 **v1.124.0（owner 2026-11-09 令「dsh 自身的提示词能不能不要注入了，省点空间」）：
 * 10 行工具清单整块删除，只留 MSM 调用示例。** 判据三条，都是可复算的：
 *  1. **它是第二真相源**：工具面已有两份权威 —— 宿主注入的工具 schema、`kernel/invariant.ts`
 *     的 `REGISTERED_TOOLS`。清单是第三份抄本 ⇒ 工具改名/退役时**没人会记得改这里**，
 *     于是它对模型**静默撒谎**（D151 同族：错的指引比没有指引更坏）。
 *  2. **它提供不了 schema 提供不了的信息**：`msm`、`container_fs` 等每一行的内容
 *     （子命令、flag、返回形态）都在 schema 与 `--help` 里，且那里才是可执行的真身。
 *  3. **实测体量**：本块 3,451 chars（2026-11-09 本机称重，含 10 行清单）。
 * 📌 **如实登记代价（D255：条件与保证同句说）**：删掉清单后，模型失去"一眼看到全部 ACC 工具名"的入口。
 * 但那个入口**本来就不可靠**（清单长期滞后：`ontology` / `serenity-skill-creator` / `reconstruct`
 * 三者的增减史里，本块都曾落后于 `REGISTERED_TOOLS`）。可靠的替代路径 = 宿主工具 schema（每轮都在），
 * 且 `msm()` 无参仍给出 CCC 层目录。
 *
 * ⚠️ **标题从 `=== Serenity Tools ===` 改为 `=== Serenity MSM ===`**：块里已经没有工具清单了，
 * 仍叫 "Tools" 会让模型按"工具总表"来读这段（E↑：标题是这段文字的唯一预告）。
 * 牵连的读数器（`tests/system-prompt.test.ts` / `tests/osp-alignment.test.ts` /
 * `tests/trajectory-prompt-injection.test.ts` / `bench/trajectory-prompt-probe.mjs`）**同批改** ——
 * 漏改一个就会得到一个**永远找不到该标题**的探针（`indexOf === -1`）。
 */
export function toolsBlock(): string {
  return [
    '',
    '=== Serenity MSM ===',
    'MSM call (registered CCC MSMs — a layer of their own, not covered by the platform tool schema):',
    '  Execute:       msm("<name>", ["<arg1>", "<arg2>"])   — run a registered MSM directly (partial name returns matching candidates)',
    '  Inspect:       msm("<name>", [], inspect=true)       — view that MSM\'s usage/flags without running',
    '  Index:         msm()                                 — summary of registered MSMs by skill',
    '  Manage:        container_admin msm register|deregister|check (registry is ACC-managed — never edit mech-registry.json directly)',
    '',
  ].join('\n')
}

/** 2) CCE 块：逐字对齐 osp（CCE 5 行为约束 + H_op 操作熵） */
export function cceBlock(): string {
  return [
    '',
    '=== Serenity CCE ===',
    '',
    'You are operating inside a Cognitive Container governed by Cognitive Continuity',
    'Engineering (CCE) — the engineering discipline of maintaining identity, accessibility,',
    'and evolution of a cognitive entity through time under bounded resources.',
    '',
    'CCE does not optimize cognition. It preserves the conditions under which cognition',
    'can continue.',
    '',
    'FIVE BEHAVIORAL CONSTRAINTS (engineering requirements, not suggestions):',
    '',
    '1. Continuity — every interaction modifies the container\'s future state. Before',
    '   acting, consult what came before — prior decisions, abstractions, constraints.',
    '   You are part of a cognitive trajectory, not a fresh start.',
    '',
    '2. Bounded Space — the container has boundaries. Respect them. Do not assume',
    '   knowledge that has not been accumulated within this container.',
    '',
    '3. Entropy is Intrinsic — every cognitive system accumulates entropy (duplication,',
    '   obsolescence, conflict, fragmentation, drift). When you produce output, consider',
    '   whether you are adding entropy or reducing it. Favor entropy-reducing actions —',
    '   organizing, deduplicating, cross-referencing, abstracting.',
    '',
    '4. Reconstruction > Preservation — stored artifacts have value only insofar as',
    '   they enable future cognition to recover the reasoning that produced them. When',
    '   recording decisions, ensure reconstruction is possible — not just conclusions,',
    '   but rationale, alternatives considered, and constraints that shaped the choice.',
    '',
    '5. Multi-Agent Cognition — the container is shared. Continuity belongs to the',
    '   container, not to any individual agent. Write for future agents who will enter',
    '   after you leave. They should be able to pick up where you left off.',
    '',
    'OPERATIONAL ENTROPY: The container\'s health metric is operational cognitive entropy',
    '(H_op) — the excess cognitive cost for agents to complete tasks due to disorder.',
    'The container is healthy when H_op ≤ H_critical (agents can still function). The',
    'continuity condition: organization must at minimum match accumulation (ΔH_org ≥ ΔH_in).',
    'Your actions affect H_op — unorganized output increases it, organization decreases it.',
    '',
    'THIS IS PERSISTENCE ENGINEERING: The goal is not to become greater. The goal is to',
    'remain coherent. CCE has no terminal KPI — continuity is maintained while the entity',
    'exists, not optimized toward an endpoint.',
    '',
  ].join('\n')
}

/**
 * Principles 块（v1.19.8 合并，S142）：认知容器本体论（why）+ 操作边界（operational
 * boundaries）。原独立 Principles 与 Constraints 合并——同属容器约束体系，先原则
 * 后边界（从抽象到具体，重建视角 R↓）。**注意：Constraints 不再作为独立对齐块存在
 * （spec 修订：同步 osp compacting.ts——Constraints 内容并入本块，工具名仍为平台真实名）。**
 *
 * v1.23.1 persona：`omitMsmPrinciples=true` 时剥离 MSM 原则段（彩蛋替换面）——
 * 用户 persona 文本承接"指令遵循风格"，本体论/关系段/操作边界（安全硬约束）永远保留。
 */
export function principlesBlock(root: string, omitMsmPrinciples = false): string {
  const lines = [
    '',
    '=== Serenity Principles ===',
    'Why a cognitive container: all work is cognition — every artifact, decision,',
    'and line of code is a product of thought; and from cognition, any work can',
    'be built. In this frame, the world contains no errors — only insufficient',
    'cognition. A setback is a gap to be filled (read, ask, research), not a',
    'fault to be hidden. Never disguise or excuse what you do not know;',
    'not-knowing is a state to be repaired, and reporting it is the first repair.',
    '',
    'The session–cognitive-trajectory relation: a session is the rebuildable carrier of a',
    'cognitive trajectory. SESSION.md is the cognitive trajectory\'s persistent body — it never moves;',
    'the current conversation is a temporary work copy that may be discarded and',
    'rebuilt (cognitive_trajectory rebuild). Identity belongs to the cognitive trajectory, not to any',
    'session.',
    '',
  ]
  if (!omitMsmPrinciples) {
    lines.push(
      'MSM principles — machinery before improvisation:',
      '- Determinism first: use a registered Mech before hand-rolling; reserve',
      '  Semi-Mech for genuine judgment points.',
      '- Single source of truth: an MSM is the only decoder of its own usage',
      '  (--help/--schema); documents must not duplicate it.',
      '- Registered to act: no tool exists unless it is on the manifest.',
      '',
    )
  }
  lines.push(
    'Operational boundaries:',
    `Root: ${root}`,
    '  • File access — read/edit/write/grep/glob are confined to Root; paths outside Root are rejected (RR5)',
    '  • Shell — use msm by default. Note: bash may be disabled',
    '  • Subagent — copies ALL parent constraints: file boundary, shell rules, session rules (no bypass)',
    '  • Session-first — before starting multi-step work, propose an existing or new AGENT_SESSIONS entry; wait for user "use" or "使用" to confirm',
    '',
  )
  return lines.join('\n')
}

/**
 * 彩蛋 persona 块（v1.23.1，S142 用户需求）：
 * 用户配置的替换文本替代 EAP 块 + MSM 原则段（输出约束/指令遵循约束）。
 * 独立标记头 `=== Serenity Persona ===`（幂等检测兼容）；装配位置 = EAP 原位。
 * mode 空 = 彩蛋关闭 → 返回空串（装配层回退默认 EAP + 完整 Principles）。
 */
export function personaBlock(mode: string, overrideText: string): string {
  if (mode === '' || overrideText.trim() === '') return ''
  return [
    '',
    '=== Serenity Persona ===',
    overrideText.trimEnd(),
    '',
  ].join('\n')
}

/**
 * EAP 自检提示块（DSH 扩展，无 osp 对应——osp 无此块）。
 * 每次输出前的机械自检清单，强化 EAP 表现（E↑ 显式/R↓ 可重建/S↑ 稳定）。
 * 独立块而非塞进 CCE/Constraints：后两者受 osp-alignment 逐字节断言约束。
 */
export function eapBlock(): string {
  return [
    '',
    '=== Serenity EAP ===',
    'Self-check before every output (Explicit Abstraction Principle: the functional',
    'value of a thought equals its external reconstructability):',
    '  • E↑ Explicit — variables/entities clearly defined, relationships with',
    '    direction/cardinality, boundaries drawn; avoid ambiguous words ("handle",',
    '    "optimize" → be specific)',
    '  • R↓ Reconstructable — key decisions record rationale and alternatives;',
    '    no level-skipping (align the upper layer before descending)',
    '  • S↑ Stable — structures regenerate repeatably, no reliance on implicit',
    '    context',
    '',
  ].join('\n')
}

/**
 * Metaphor 强化块（v1.19.6，S142；v1.29 星舰意象升级，S142 用户拍板）：
 * 宁静号宇宙隐喻域（星舰/深空/航程/船员）。海船→星舰意象：one starship, one voyage；
 * deep space / launch / docking clamp；Departure Inspection（原 Harbor Inspection）。
 * 隐喻是记忆钩子——形象唤起约束，前述块保持规则精确。每条隐喻 = 一个不可违背的
 * 物理事实 + 行为判据（verdict）。全英文（与 CCE/Constraints 一致）；独立块可
 * 回退；无 osp 对应（dsp 扩展，不进对齐断言参照）。
 * 结构约束（docs/metaphor-domain.md M-1~M-4）：三层骨架不变 + 每条映射约束不变。
 */
export function metaphorBlock(): string {
  return [
    '',
    '=== Serenity Metaphor ===',
    'The Serenity Universe — one starship, one voyage. Metaphors are memory hooks:',
    'they make constraints vivid, while the rules above stay precise. Each',
    'metaphor is an unbreakable physical fact; violating one is a behavioral',
    'violation. The universe is structured in three layers — the Ship (the',
    'container itself), the Voyage (the cognitive lifecycle), the Crew',
    '(multi-agent collaboration); every metaphor maps to one protocol',
    'constraint. Deep space has no mistakes — only stars you have not yet mapped.',
    '',
    'THE SHIP — the container itself',
    '',
    '1. The Hull → Bounded Space. You exist only inside this ship. Cargo',
    '   outside the hull (knowledge the container has not accumulated) does',
    '   not exist; do not assume it. Verdict: citing facts absent from the',
    '   container = overload.',
    '',
    '2. Deck Order → Entropy (H_op). Clutter on deck raises the cost of',
    '   finding things. H_op ≤ H_critical = the ship stays flight-worthy.',
    '   Verdict: disorganized output = debris in the hold.',
    '',
    '3. Engineering Drawings → EAP. Every part dimensioned (E↑), the',
    '   drawings rebuild the whole machine (R↓), the drawings are reusable',
    '   (S↑). Verdict: an undimensioned part = unassemblable.',
    '',
    '4. The Machinery → MSM (Mech & Semi-Mech). The ship\'s equipment is',
    '   machinery: registered, deterministic, self-describing. Turn the',
    '   crank of a Mech and the action is exact; the wheel with a helmsman',
    '   (Semi-Mech) steers where judgment is needed. Verdict: hand-rolling',
    '   what a machine already does = wasting the crew.',
    '',
    '5. The Manifest → Single Source of Truth. Every tool exists only if it',
    '   is on the manifest (mech-registry); there is exactly one manifest.',
    '   An MSM self-describes (--help/--schema) — the manifest is the only',
    '   key. Verdict: duplicating a tool\'s usage in documents = two',
    '   contradictory star charts.',
    '',
    'THE VOYAGE — the cognitive lifecycle',
    '',
    '6. Departure Inspection → First Anchor. The departure inspection = pre-',
    '   launch checklist: confirm identity (ACC manifesto), the ship\'s log (SESSION),',
    '   ballast (constraints) before setting course. Verdict: skipping the',
    '   inspection and launching directly = flying uninspected.',
    '',
    '7. The Ship\'s Log → Cognitive Trajectory Tracking. SESSION.md is the',
    '   cognitive trajectory\'s log —',
    '   the persistent body of the voyage; sessions are rebuildable carriers of',
    '   the cognitive trajectory. Discard the carrier, keep the log. Unrecorded =',
    '   unvoyaged. Verdict: finishing multi-step work without a progress record',
    '   = a missing page.',
    '',
    '8. The Ship of Theseus → Continuity. Planks may be replaced; the ship',
    '   remains the same. The container can be rebuilt; identity persists.',
    '   You are part of a cognitive trajectory, not a new ship. Verdict: acting',
    '   without consulting precedent = a different ship.',
    '',
    'THE CREW — multi-agent collaboration',
    '',
    '9. Crew Rotation → Multi-Agent Cognition. Other crew members will come',
    '   after you. When you leave, leave a handover they can pick up',
    '   (SESSION closed, open problems listed). Verdict: leaving without',
    '   handover = abandoning ship.',
    '',
    '10. Blueprint over Statue → Reconstruction > Preservation. Keep the',
    '   blueprint, not the statue. Recording only conclusions without',
    '   rationale = a statue with no blueprint, unreconstructable.',
    '   Verdict: a decision record without reasons or alternatives =',
    '   cannot be rebuilt.',
    '',
  ].join('\n')
}

/**
 * 运行时状态块 1) safe-mode（S134 v1.16.12）：ON 时告知 agent。
 * v1.19.8 结构重排（S142 用户设计思路）：语义（为什么——无人值守自由）→
 * 机制（什么被禁用）→ 约束（不可做什么）。文案与实现逐项对应（guards.ts）：
 * bash 禁用（restrict deny + decideGuard）、黑名单路径拦截、CCC 治理文件保护；
 * write/edit 等其余工具保留（受路径逃逸/黑名单约束）。
 */
export function safeModeBlock(root: string): string {
  if (!isSafeModeOn(root)) return ''
  const blacklist = readBlacklist(root)
  const blacklistNote =
    blacklist.length > 0
      ? `\nActive blacklist rules: ${blacklist.map((b) => b.message ?? b.pattern).join(', ')}`
      : ''
  return [
    '',
    '=== Serenity Safe Mode ===',
    'Safe mode is ON (enabled by the user). It makes the vessel unattended-capable —',
    'the hull holds its course without a watch on deck: you may work with fuller',
    'freedom, pushing work forward autonomously without pausing for approval at',
    'every step. The guards are not chains; they are the ballast that lets you',
    'sail unaccompanied.',
    '',
    'Operational details:',
    '- bash is disabled (hidden and blocked)',
    '- blacklist rules apply to file paths',
    '- CCC governance files (.serenity, .serenity-safe-on) are protected from agent writes',
    '- other read/write tools remain available, subject to path-escape and blacklist guards',
    blacklistNote,
    '',
    'Behavior constraints: do not attempt to bypass restrictions; do not write to',
    'blacklisted paths or governance files.',
    '',
  ].join('\n')
}

/**
 * 运行时状态块 2) localstore git 策略（S134 v1.16.12）：localstore.json 存在时按 gitTrack
 * 提示敏感行为约束。deny（缺省）= 本地私有不提交；allow = 进 git（个人私有仓）但敏感数据
 * 只限于该文件内（不外泄到其他文件/对话/日志）。
 */
export function localstoreBlock(root: string): string {
  if (!existsSync(localstorePath(root))) return ''
  const lines =
    readGitTrack(root) === 'allow'
      ? [
          '',
          '=== Serenity Localstore ===',
          'localstore.json is committed to git (gitTrack=allow — personal private repository).',
          'Sensitive data may live in this file, but ONLY in this file: keep credentials and',
          'secret values confined to localstore.json — never leak them into other files,',
          'conversation, or logs.',
          '',
        ]
      : [
          '',
          '=== Serenity Localstore ===',
          'localstore.json is a local private file (gitTrack=deny — not committed to git,',
          '.gitignore enforced). Credentials/config live only on this machine: do not write',
          'them into conversation or logs; do not attempt to commit this file (container_git will refuse).',
          '',
        ]
  return lines.join('\n')
}

/** 4) SKILL.md 全文：该 CCC 顶层入口 skill 原文（对齐 osp：原文直推，无包裹头；仅过滤治理内容）
 *  ＋ 🆕 **第二层披露树**（serenity-skill P1，设计 §4.2）：每个入口 skill 后附**参考件清单**
 *  （只有文件名与一行标题，**不含正文** —— 正文留给模型按需 `read`）。
 *  索引为空（该 skill 无 `references/` 也无 `skill.ttl`）⇒ **不产出该块**（空标题是噪声）。 */
export function entrySkillSectionText(root: string): string {
  const skills = findEntrySkills(root)
  if (skills.length === 0) return ''
  // 对齐 opencode-serenity-plugin：注入 state.skillContent 原文（不截断）。
  // 多入口（DSH 超集，osp 仅单入口）时以空行分隔。
  return skills
    .map((s) => {
      const body = sanitizeSkillContent(s.content)
      if (body.length === 0) return ''
      const index = buildResourceIndex(s.dir)
      return index ? `${body}\n\n${index}` : body
    })
    .filter((c) => c.length > 0)
    .join('\n\n')
}

/** 活跃会话解析：按 dsh 会话 scope 读标记（隔离；不回退旧全局标记） */
function resolveActiveSessionInfo(root: string, scope: string): { sessionId: string; dirName: string; mdPath: string } | null {
  try {
    const abs = readActiveSessionMd(root, scope)
    if (!abs) return null
    // 标记内容 = SESSION.md 路径 → 会话目录名 = 其父目录 basename
    const dirName = basename(dirname(abs))
    const idMatch = dirName.match(/S(\d{3,})/)
    return { sessionId: idMatch ? `S${idMatch[1]}` : dirName, dirName, mdPath: abs }
  } catch {
    return null
  }
}

/**
 * 5) Session 块：对齐 osp（活跃会话 + todowrite 首位约定）；scope = dsh 会话维度。
 * **平台适配（v1.17.2）**：osp 的 todowrite 首项含 `priority: "low"`（opencode todo 支持），
 * 但 DSH 平台 todowrite schema 无 priority（additionalProperties: false 拒绝）→ agent 照做报
 * `todos[0].priority is not a declared property`。DSH 版去掉 priority 字段（其余逐字对齐 osp）。
 */
export function sessionBlock(root: string, scope: string = DEFAULT_SESSION_SCOPE): string {
  const active = resolveActiveSessionInfo(root, scope)
  if (!active) return ''
  return [
    '',
    '=== Serenity Session ===',
    `Active session: ${active.sessionId} — ${active.dirName} (this session is the rebuildable carrier of the cognitive trajectory)`,
    `SESSION.md path: ${active.mdPath} (the cognitive trajectory's persistent body — stays in place through rebuilds)`,
    '',
    'Rules (SESSION.md is the cognitive trajectory log — keep its format & granularity fixed):',
    '  • Write only when a MILESTONE landed or a DECISION was made — not every round',
    '  • One entry = one abstraction level, at the highest one that can express it:',
    '    identity/anchors (rare) › decision (one line + rationale/rejected) › milestone',
    '    (one line + an evidence pointer, e.g. a commit id). Execution detail — test',
    '    counts, coverage decimals, per-file readings, step narration — belongs in the',
    '    COMMIT MESSAGE, not here',
    '  • Never write a value that changes by the act of writing it (file size; the hash',
    '    of the commit containing this edit)',
    '  • Fixed sections, in this order: 身份与边界 / 权威锚点 / 工作纪律 / 决策 / 日志 /',
    '    当前状态 / 待 owner 裁决.  The 日志 section appends only; 当前状态 and',
    '    待 owner 裁决 are OVERWRITTEN each round',
    '  • Reference this session in all subsequent messages',
    '',
    'IMPORTANT: Read SESSION.md now to RESUME — not to audit. Sync the todo list from',
    'the 当前状态 and 待 owner 裁决 sections only.',
    '',
    'CRITICAL: When calling todowrite, the first item in the todos array MUST',
    'always be:',
    `  { content: "SESSION: ${active.sessionId} — ${active.dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')}",`,
    '    status: "completed" }',
    'This preserves the session context across todo updates.',
    'Do NOT remove or reorder this item — keep it at position 0.',
    '',
    'COGNITIVE-TRAJECTORY-ASSISTANT: a background tracker scores your tool use (write/edit=3,',
    'task=10, read/grep/glob/msm=1, +1 per minute) and reminds you with a',
    '[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT] message when the threshold is reached. On every such',
    'reminder you MUST reply with the exact ACK code:',
    '  [COGNITIVE-TRAJECTORY-ASSISTANT-recorded-{code}]  — if you recorded progress to SESSION.md',
    '  [COGNITIVE-TRAJECTORY-ASSISTANT-skipped-{code}]  — if nothing to record this round',
    'Do not ignore the reminder; do not stop ongoing work. Codes are single-use;',
    'never reuse a prior code.',
    '',
  ].join('\n')
}

/**
 * 完整系统提示词注入文本（v1.19.8 结构精简，S142 重建视角 R↓）：
 * 身份（ACC）→ 世界模型（Metaphor）→ 信念/边界（Principles）→ 时间约束（CCE）
 * → 质量（EAP）→ 状态（SafeMode/Localstore）→ CCC 上下文（SKILL）→ 工具参考（Tools）→ 会话（Session）。
 * 认知展开顺序：我是谁 → 我所在的世界 → 为什么 → 如何一致 → 产物标准 → 当前状态 → 上下文 → 工具参考 → 会话。
 *
 * 需求③（S142 用户拍板）：工具清单从 accBlock 移出为独立 toolsBlock，
 * 放 SKILL 后 Session 前（工具参考殿后，身份先行不被清单干扰）。
 * 🔴 **v1.124.0**：那块清单**已被 owner 令删掉**（判据见 `toolsBlock` 头部），
 * 现在该位置只剩 MSM 调用示例（标题也改成 `=== Serenity MSM ===`）。
 *
 * v1.23.1 persona（彩蛋）：persona.mode 配置 → EAP 块替换为 Persona 块（输出约束），
 * Principles 剥离 MSM 原则段（指令遵循约束）——用户文本承接两处风格；本体论/关系段/
 * 操作边界（安全硬约束）永远保留。未配置 → 与 v1.23.0 逐字节一致（零影响）。
 */
export function serenitySystemPrompt(
  root: string,
  scope: string = DEFAULT_SESSION_SCOPE,
  /** 活跃轨迹目录名（给了才有第 ⑧ 段；未绑定轨迹 ⇒ undefined，不注入） */
  dirName?: string,
  /**
   * 会话 id —— **脱口秀块（D287）的随机种子**。
   *
   * 🔴 为什么必须是会话 id 而不是每次现抽：本函数**每次请求都重新求值**，
   * 现抽会让系统提示词每轮都变（刷新页面都可能换段），且**无法解释为什么变了**。
   * ⇒ 同一条会话永远是同一段（owner 要的"会话进行中不变动"），换会话才换。
   * 未传（如某些冷路径）⇒ 不注入该块（`''`），行为等于该功能没开。
   */
  sessionId?: string,
): string {
  const persona = readPersonaSettings()
  const personaOn = persona.mode !== '' && persona.overrideText.trim() !== ''
  // ⑧ 轨迹提示词（T1/T2，2026-10-19）：**这条轨迹是谁、按什么章程工作**。
  //
  // 🔴 2026-10-20（owner 令）：它的**注入模式**由 `trajectory.json` 的 `prompt` 段决定 ——
  //    · 缺省 `append` ⇒ 追加（原行为，不变）
  //    · `replace`   ⇒ 取代 `replaces` 里点名的**约束块**，并站到它们的原位上
  //    判决是纯函数（`planPromptInjection`），**每次装配重新读盘** ⇒ 改设定即下一轮生效。
  const trajReader = dirName === undefined ? null : createTrajectoryPromptReader(root, dirName)
  const trajPrompt = trajReader === null ? '' : trajectoryPromptBlock(trajReader())
  const plan = planInjectionFor(root, dirName, trajPrompt !== '')
  // 🔴 身份块**无条件注入**：它不在可替换集里（`REPLACEABLE_PROMPT_BLOCKS`），
  //    所以这里没有 `if (!plan.replaces.has('identity'))` 的分支 —— 那不是漏写。
  //    若哪天要开放身份块替换（标准级决定），**两处必须同批改**：词表 ＋ 本行。
  const parts: string[] = [identityBlock(root)]
  // 表达层（replace 模式下紧随被取代块之后：先立"我的章法"，再谈表达）
  if (plan.promptPosition === 'constraint' && trajPrompt !== '') parts.push(trajPrompt)
  if (!plan.replaces.has('metaphor')) parts.push(metaphorBlock())
  if (!plan.replaces.has('principles')) parts.push(principlesBlock(root, personaOn))
  if (!plan.replaces.has('cce')) parts.push(cceBlock())
  // 🔴 T3（2026-10-19）：「人格」收敛为**表达层**，不再置换 EAP。
  //    旧行为 = `personaOn ? personaBlock(...) : eapBlock()` ⇒ 开 persona 就**丢掉质量层**，
  //    即 review F-05/R-14 那个悬置冲突。⇒ 现在两层**都注入**：persona 只能收窄表达，
  //    不能取消「输出前自检」这件事本身（EAP 是容器纪律，不是风格）。
  if (!plan.replaces.has('eap')) parts.push(eapBlock())
  /**
   * 🔴 **D287 脱口秀块（2026-11-04 owner 想法）** —— 纯装饰，不进任何判据路径。
   *
   * 位置：**质量层（EAP）之后、表达层（persona）之前** —— 先立标准，再路过一段闲笔，
   * 最后才谈表达风格（persona 才是真正改风格的那一层）。
   *
   * ⚠️ **关闭 / 池空 / 无 sessionId ⇒ `humorBlock` 返回 `''`，不 push**
   * ⇒ 装配结果**逐字节等于没有本功能**。这条由测试钉住（装饰品不许偷偷改变提示词）。
   */
  if (sessionId !== undefined && sessionId !== '') {
    const hum = readHumorSettings()
    const bit = humorBlock(sessionId, hum.bits, hum.enabled)
    if (bit !== '') parts.push(bit)
  }
  // 表达层（可选，紧跟质量层之后：先立标准，再谈表达）
  if (personaOn) {
    const expr = personaBlock(persona.mode, persona.overrideText)
    if (expr !== '') parts.push(expr)
  }
  /**
   * 🔴 **工作语域块（2026-11-05 owner 令）** —— 压开场/声明/重复要许可的摩擦。
   *
   * 位置：**persona 之后、运行时状态之前**。理由：它约束的是"怎么开口"，
   * 必须排在**所有风格层之后**才不会被 persona 覆盖，又要在状态块之前
   * （状态块讲的是当前事实，属于最贴近执行的上下文）。
   *
   * ⚠️ **关闭 ⇒ `workRegisterBlock` 返回 `''`，不 push** ⇒ 装配结果**逐字节等于没有本功能**。
   */
  const wr = readWorkRegisterSettings()
  const wrBlock = workRegisterBlock(wr.enabled)
  if (wrBlock !== '') parts.push(wrBlock)
  // S134 v1.16.12：运行时状态动态块（safe-mode / localstore）——利用系统提示词约束 agent 行为；
  // 按当前状态条件生成（开关/策略变更每轮装配即时生效）
  const state = [safeModeBlock(root), localstoreBlock(root)].filter((b) => b !== '').join('\n')
  if (state) parts.push(state)
  const skill = entrySkillSectionText(root)
  if (skill) parts.push(skill)
  // 追加形态：位置刻意在容器上下文（⑦）之后、轨迹方法论（§serenity-trajectory-skills，order -45）之前：
  // 先知道容器与语境，再说"我是谁、怎么做"，最后才是方法论与工具细节。
  if (plan.promptPosition === 'late' && trajPrompt !== '') parts.push(trajPrompt)
  // 需求③：工具参考块殿后（SKILL 后、Session 前）——身份先行、工具清单独立成块
  parts.push(toolsBlock())
  const session = sessionBlock(root, scope)
  if (session) parts.push(session)
  // 对齐 osp：块间以空行分隔（osp 逐项 push output.system，host 以换行拼接；不加 `---` 分隔线）
  return parts.join('\n\n')
}

/**
 * 解析该轨迹的**注入判决**（每次装配现读；坏设定只告警一次，不阻断装配）。
 *
 * 🔴 为什么热路径可以读盘：`trajectory.json` 是**每轮都要读**的本来就有的东西
 * （工具白名单 / model / resident 都走同一条读取路径），多读一次不会改变复杂度量级；
 * 而**缓存**会让"改了设定但没生效"重新变成一个只能靠重启解释的现象 ——
 * owner 这次的原话里明确要求「对提示词和设定的修改可以热生效」。
 *
 * @param root CCC 根
 * @param dirName 绑定的轨迹目录名（`undefined` ⇒ 追加模式，无轨迹上下文）
 * @param hasTrajectoryPrompt 该轨迹目录里是否真有 `PROMPT.md`（`replace` 的前提）
 */
function planInjectionFor(root: string, dirName: string | undefined, hasTrajectoryPrompt: boolean) {
  if (dirName === undefined) return planPromptInjection(undefined, false)
  let raw: RawPromptInjection | undefined
  try {
    raw = readTrajectoryConstraintAt(join(sessionsRoot(root), dirName), root)?.prompt
  } catch {
    raw = undefined // 读不到 ⇒ 缺省追加（不阻断装配；坏 JSON 已在 profile 层告警过）
  }
  const plan = planPromptInjection(raw, hasTrajectoryPrompt)
  for (const p of plan.problems) {
    const key = `${root}\u0000${dirName}\u0000${p}`
    if (!warnedPromptInjection.has(key)) {
      warnedPromptInjection.add(key)
      console.warn(`[serenity-hooks] ✗ 轨迹提示词注入设定（${dirName}）：${p}`)
    }
  }
  return plan
}

/** 同一（CCC × 轨迹 × 原因）只告警一次：每轮装配都执行，不去重会刷屏（但**不静默**） */
const warnedPromptInjection = new Set<string>()

/**
 * Code Mode 适配行：当前 scope 以 Code Mode 呈现工具时（run_code 可见），
 * ACC 块按 native 语义指引"直接调用工具"会与"只有 run_code 可直接调用"的执行
 * 塌缩冲突（模型直呼工具名 → UNKNOWN_TOOL，拒绝信息误导）。追加一行说明，
 * 引导经 run_code 程序内 tools.* 调用。both 模式不塌缩，该行不误导（程序内
 * 调用同样合法），故按 run_code 可见性（code|both）统一附加。
 * @param ctx - 插件 ctx（读 tools 注册表）。
 * @param scope - 装配 scope（agent）；无则按全局视图判断。
 * @returns 适配行（含换行前缀）；非 code/both 返回空串。
 */
export function codeModeAdaptationLine(ctx: Context, scope?: unknown): string {
  try {
    const codeVisible = ctx.tools.get('run_code', scope as never) !== undefined
    if (!codeVisible) return ''
  } catch {
    return ''
  }
  return [
    '',
    '=== Serenity Code Mode ===',
    'This session renders tools in Code Mode: direct calls to ACC tool names (container_fs/msm etc.) are rejected (UNKNOWN_TOOL).',
    'Call them inside a single run_code program via the generated SDK bindings: `await tools.container_fs(...)`, `await tools.msm(...)`.',
    'The program only returns what you print/return — curate your output.',
    '',
  ].join('\n')
}

/** 从 assembly context 解析 agent cwd（subagent/后台 agent 同样带 agent）；
 *  无 agent → undefined（不注入）；有 agent 但无 header.cwd（workflow subagent 等）
 *  回退 process.cwd()——**cwd 回落语义取自 `ccc-roots.agentCwdFor`（C2 归一）**，否则这些
 *  agent 系统提示词注入为空（v1.18.6：workflow subagent 无宁静号上下文 bug）。
 *  ⚠️ 本函数比 `agentCwdFor` 多一道「**无 agent ⇒ undefined**」——那是 section 的
 *  "不注入" 语义（`agentCwdFor` 对无 agent 会回落到 process.cwd()），故不能直接替换。 */
function agentCwd(context: AssembleContext): string | undefined {
  const agent = context.agent
  if (!agent) return undefined
  return agentCwdFor(agent as { session?: { header?: { cwd?: string } } })
}

/** 从 assembly context 解析 dsh 会话 id（Session 块按会话隔离的 scope） */
function agentScope(context: AssembleContext): string {
  return (context.agent?.session as { id?: string } | undefined)?.id ?? DEFAULT_SESSION_SCOPE
}

/**
 * 该会话**绑定的轨迹目录名**（有 ⇒ 注入第 ⑧ 段「轨迹提示词」；无 ⇒ `undefined`，不注入）。
 *
 * 🔴 为什么用**目录名**而不是编码或 label：`PROMPT.md` 的落盘位置是目录，
 * 而编码只是目录名里的一段。用 label 拼路径 = 把模糊匹配当精确匹配用（本轨已踩过）。
 *
 * ⚠️ 每次装配都重读绑定（**不缓存**）：绑定切换后提示词必须立刻跟上，
 * 这与 `serenity-trajectory-skills` section 的口径一致（动态注入，owner 令 2026-09-20）。
 */
function boundDirNameFor(session: unknown): string | undefined {
  try {
    const rec = readLastBound(session)
    const name = rec?.dirName
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined // 绑定读取失败 ⇒ 不注入第 ⑧ 段（不阻断装配）
  }
}

/**
 * 全局注册系统提示词 section（osp system.transform 的 DSH 等价）。
 * text 回调按 context.agent 的 cwd 上溯 .serenity → 返回该 CCC 的完整注入文本；
 * 非 CCC / 无 agent 返回空（不注入）。
 */
export function registerEntrySkillSectionGlobal(ctx: Context): void {
  try {
    ctx.systemPrompt.section({
      name: 'serenity-entry',
      order: -50,
      text: (context) => {
        const cwd = agentCwd(context)
        if (!cwd) return ''
        const root = cccRootForCwd(cwd)
        if (!root) return ''
        const scope = agentScope(context)
        // 🔴 T2（2026-10-19）**删掉了 轨迹约束旁路**。
        //
        // 旧行为：`if (isTrajectoryConstrained(root, scope)) return ''` —— 轨迹约束会话**整段不注入 ACC**，
        // 由 `trajectory/session.ts` 的另一条路径用 CCC 文件"立人格"。
        // 后果：同一个概念（"这条轨迹是谁、按什么章程工作"）由**两套互不知道的机制**拼装。
        //
        // 现在：所有轨迹走**同一条装配**；轨迹约束的差异只剩「能力约束面」（`trajectory-constraint.json`），
        // 而它的"章程"由 `PROMPT.md`（轨迹提示词）承载 —— 与普通轨迹**同一机制**。
        // ⇒ 轨迹约束从"另一套机制"降级为"同一条装配 + 一个可选约束面"。
        //
        // ⚠️ 兼容期：`PROMPT.md` 不存在时，轨迹约束的旧 `systemPromptFile` 仍由
        // `trajectory/session.ts` 自己的 section 追加（见那里的说明）——存量 CCC 不会静默失去章程。
        const base = serenitySystemPrompt(
          root,
          scope,
          boundDirNameFor(context.agent?.session),
          // D287 脱口秀块的随机种子 —— 用会话 id ⇒ 同会话永远同段、换会话才换
          (context.agent?.session as { id?: string } | undefined)?.id,
        )
        const codeLine = codeModeAdaptationLine(ctx, context.scope)
        return codeLine ? `${base}\n${codeLine}` : base
      },
    })
    console.log('[serenity-hooks] ✓ 全局入口 skill section 已注册（systemPrompt 就绪）')
  } catch (err) {
    // 注册失败：显式告警（不再静默）——系统提示词注入是关键能力
    console.error(`[serenity-hooks] ✗ 全局入口 skill section 注册失败: ${(err as Error).message}（检查 inject 是否含 systemPrompt）`)
  }
}

/**
 * agent 级 scoped 注册（P0-1：抗 preset/动态插件同名 shadow）。
 *
 * 为什么 scoped：DSH 的 systemPrompt section 支持 scoped 层同名 shadow 全局
 * （agent.ctx.systemPrompt.section），且 scope 链最近层胜出。若 ACC 只注册全局
 * section，preset 或动态 Cordis 插件可在 scoped 层注册同名 `serenity-entry`
 * 遮蔽 ACC 身份。scoped 注册在 agent 自身层 = 最近层，任何外部组合无法覆盖。
 * 全局注册保留为 fallback（未走 session-start 的 agent / 冷恢复路径）。
 *
 * text 回调闭包持有 root 与 agent：content 固定（该 agent 的 CCC 身份），
 * code-mode 适配按装配 context.scope 判断（与全局版一致）。
 */
const sectionedAgents = new Set<string>()

export function registerEntrySkillSection(agent: Agent, root: string): boolean {
  const key = (agent.session as { id?: string }).id ?? 'global'
  if (sectionedAgents.has(key)) return false
  try {
    const scope = (agent.session as { id?: string }).id ?? DEFAULT_SESSION_SCOPE
    agent.ctx.systemPrompt.section({
      name: 'serenity-entry',
      order: -50,
      text: (context) => {
        // 🔴 T2（2026-10-19）：这里原先也有 `if (isTrajectoryConstrained(...)) return ''` 的防御性旁路，
        // 与全局版一起**删除** —— 装配只剩一条路径（理由见全局版的同段注释）。
        const base = serenitySystemPrompt(
          root,
          scope,
          boundDirNameFor(agent.session),
          // D287 脱口秀块的随机种子（同上：会话 id）
          (agent.session as { id?: string }).id,
        )
        const codeLine = codeModeAdaptationLine(agent.ctx, context.scope)
        return codeLine ? `${base}\n${codeLine}` : base
      },
    })
    sectionedAgents.add(key)
    return true
  } catch {
    return false
  }
}

/**
 * 轨迹 skill 注入 section（规格 `docs/cognitive-trajectory-skill-injection.md` §3，v1.34.1）。
 *
 * **声明来源（两条，并集）**：
 *   · **CCC 级**（v1.44.0，owner 令）= `.opencode/serenity.json` 的 `cognitiveTrajectory.skills`
 *     ——**本 CCC 的每条轨迹都带**（含 轨迹约束角色会话），是容器给的底座；
 *   · **轨迹级** = 该会话绑定的轨迹（`readLastBound(session).mdPath` = 它的 `SESSION.md`）
 *     顶部 frontmatter 的 `skills:`——这条轨迹额外的。
 *   合并规则与顺序见 `cognitive-trajectory-skills.mergeSkillNames`（CCC 级在前，同名去重）。
 *   正文 = 合并清单里各 skill 的 `SKILL.md` 全文（本模块只注册，装配在 `trajectory/skills.ts`）。
 *
 * 为什么是 **per-agent scoped section**（与 `registerEntrySkillSection` 同形）：注入必须
 * **绑定期间持续存在**（a2）——一次性注入会随对话压缩消失，而 section 每次装配重新求值。
 *
 * 为什么**门在注册时、内容在求值时**（R↓，两个失败模式各治一个）：
 *   · 注册门（**无绑定 / 两条来源皆无** ⇒ 不注册）：满足"零配置面不产生空 section、不产生噪声"；
 *   · 求值回调**每请求重读 `readLastBound` + 文件 + CCC 配置**：绑定切换 / 声明或配置被编辑后
 *     自动跟上（**动态注入，不缓存**），且绑定消失时返回 `''`
 *     （宿主 renderSections **丢弃空 section**，不残留噪声）。
 *
 * ⚠️ 路径取自绑定的 `mdPath`（权威记录），**不用** `resolveSessionCognitiveTrajectoryLabel` 的显示 label
 * 去拼路径——label 是模糊匹配的展示码，拼路径即模糊匹配当精确匹配用。
 *
 * @param agent 目标 agent（其 `session` 需有 `header.id` + `header.cwd`）
 * @param root 该 agent 的 CCC 根
 * @returns 是否**本次**完成注册（已注册过 / 门未过 → false）
 */
const cognitiveTrajectorySkillAgents = new Set<string>()

export function registerCognitiveTrajectorySkillSection(agent: Agent, root: string): boolean {
  const session = agent.session
  const key = (session as { id?: string }).id ?? 'global'
  if (cognitiveTrajectorySkillAgents.has(key)) return false
  const bound = readLastBound(session)
  if (!bound) return false
  // 门（v1.44.0 放宽）：**CCC 有声明 ∨ 该轨迹有声明** ⇒ 注册。
  // 轨迹级那条老规则不变（无绑定 / 两条来源皆无 ⇒ 不注册，不产生空 section、不产生噪声）。
  if (readCognitiveTrajectorySkills(root).length === 0 && !hasCognitiveTrajectorySkillsDeclaration(root, bound.mdPath)) return false
  try {
    agent.ctx.systemPrompt.section({
      name: 'serenity-trajectory-skills',
      // 排在入口身份块（-50）之后、部署 persona（0）之前：身份先立，工作供给（skill 全文）随后
      order: -45,
      text: () => {
        const current = readLastBound(session)
        if (!current) return ''
        // 🔴 动态注入（owner 令 2026-09-20：「注入是动态注入就行」）：CCC 配置与轨迹 frontmatter
        // **每请求重读**——改配置/改 frontmatter 都即时生效，无需重新 use、无需重启，故不缓存。
        return buildCognitiveTrajectorySkillsSection(
          root,
          current.mdPath,
          COGNITIVE_TRAJECTORY_SKILLS_MAX_CHARS,
          readCognitiveTrajectorySkills(root),
          // 🆕 用量统计（owner 令 2026-09-22）：记一笔 `skill.injections`（与 `skill.loads` 分字段）。
          // 🔴 纯观测 —— 回调**只在真的带上了非空 skill 清单**时被调用（见该函数内注释）。
          (names) => recordSkillInjections(root, names),
        )
      },
    })
    cognitiveTrajectorySkillAgents.add(key)
    return true
  } catch {
    return false
  }
}
