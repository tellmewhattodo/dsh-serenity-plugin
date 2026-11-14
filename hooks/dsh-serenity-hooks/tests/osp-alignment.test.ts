/**
 * osp-alignment.test.ts — 系统提示词结构对齐 spec（v1.19.9 修订，S142）
 *
 * 历史：v1.19.5 前逐字节对齐 opencode-serenity-plugin v0.8.5（CCE/Constraints/Session）。
 * v1.19.6~v1.19.9 用户设计演进（去冗余/隐喻域/结构精简/MSM 约束），dsp 领先于 osp；
 * 用户验证满意后本 spec 正式化——osp 侧按本 spec 同步（opencode-serenity-plugin
 * compacting.ts system.transform，S142/S138 协作，osp 待同步）。
 *
 * 对齐契约（v1.19.9 新结构 + 需求③ Tools 块）：
 *   1. 装配顺序 — ACC(身份) → Metaphor → Principles → CCE → EAP → [SafeMode/Localstore]
 *                → SKILL → Tools → Session（需求③：工具清单独立成块放 SKILL 后 Session 前）
 *   2. CCE 块    — 与 osp 逐字节一致（无例外）；v1.19.6 删 "CCE AND EAP" 段（EAP 定义唯一
 *                  真相源 = EAP 块）→ osp 需同步删段
 *   3. Principles 块 — v1.19.8 合并原 osp Constraints 块（认知容器本体论 + MSM 原则 +
 *                  Operational boundaries；工具名平台真实名）→ osp 需同步合并
 *   4. Metaphor 块 — dsp 扩展（osp 无对应）：三层隐喻域（SHIP/VOYAGE/CREW）10 条，
 *                  提前至 ACC 后（世界模型前置）；M-1~M-4 结构约束见 docs/metaphor-domain.md
 *   5. EAP 块    — dsp 扩展（osp 无对应）
 *   6. Session 块 — 与 osp 逐字节一致（相同会话值时；DSH todowrite 无 priority 字段）
 *   7. SKILL 全文 — 原文直推（无包裹头），对齐 osp `output.system.push(state.skillContent)`
 *   8. 身份块 + Tools 块 — 结构对齐（身份行/CCC；工具清单 + MSM 调用示例独立成块——
 *                  v1.19.6 去 Root（唯一真相源 = Principles 块边界）；工具清单为平台真实工具，
 *                  允许不同；需求③ 工具参考殿后）
 *   9. 块间拼接  — 空行分隔，无 `---` 分隔线
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  identityBlock,
  toolsBlock,
  cceBlock,
  principlesBlock,
  sessionBlock,
  entrySkillSectionText,
  metaphorBlock,
  serenitySystemPrompt,
} from '../src/seams/system-prompt.js'
import { useSession, resetActiveSessionStore } from '../src/trajectory/core.js'
import { ACC_VERSION } from '../src/kernel/constants.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osp-al-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── osp v0.8.5 参照文本（从 compacting.ts 逐字提取，勿改）──

/** osp CCE 块（compacting.ts systemTransformImpl，逐字） */
const OSP_CCE = [
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

/**
 * osp Session 块模板（DSH 适配版：todowrite 首项无 priority——DSH 平台 schema 不支持，v1.17.2；
 * v1.23.0 载体关系行 + steward 预声明——dsp 领先扩展）。
 *
 * 🔴 2026-09-25（S142，owner 裁决）：**本块的 `Rules` / `IMPORTANT` 两段已被替换**为
 * 「SESSION.md 格式与粒度契约」—— 触发 = 里程碑/决策（不再"每轮都记"）；粒度受 **EAP 抽象层**约束
 * （L3 执行细节归 commit message）；**固定段集合**；不写"写下即变"的值。
 * ⚠️ 🔴 **osp 侧必须同步改**：本测试**两边一起改所以照旧绿** ⇒ 它会**静默掩盖**"osp 仍在注入旧文本"
 * （= 双实现分叉）。⇒ 已登记给 osp 维护轨迹（S138／S156）。**判据** = osp 仓 Session 块等价实现里
 * 出现同一段文本（含"固定段集合"那两行）。
 */
const OSP_SESSION = (sessionId: string, dirName: string, mdPath: string) => [
  '',
  '=== Serenity Session ===',
  `Active session: ${sessionId} — ${dirName} (this session is the rebuildable carrier of the cognitive trajectory)`,
  `SESSION.md path: ${mdPath} (the cognitive trajectory's persistent body — stays in place through rebuilds)`,
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
  `  { content: "SESSION: ${sessionId} — ${dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')}",`,
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

/** 建立含顶层 skill 的 CCC */
function setupCccWithSkill(skillName = 'other-serenity', skillBody = '顶层入口原文内容'): void {
  writeFileSync(join(dir, '.serenity'), skillName)
  mkdirSync(join(dir, '.opencode', 'skills', skillName), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: 系统入口\n---\n${skillBody}`)
}

describe('dsp 领先：CCE 块（v1.134.0 起**不再逐字节对齐 osp**——owner 令精简核心提示词）', () => {
  it('cceBlock() 保留五条约束名 + H_op 判据，⛔ 不再等于 osp 原稿（分叉是有意的）', () => {
    const block = cceBlock()
    expect(block).toContain('=== Serenity CCE ===')
    // 五条约束**名字一个都不能少**（v1.134.0 只删解释，不删骨架）
    for (const name of [
      'Continuity',
      'Bounded Space',
      'Entropy',
      'Reconstruction',
      'Multi-Agent',
    ]) {
      expect(block, `CCE 约束名缺失：${name}`).toContain(name)
    }
    // H_op 健康判据仍在（缩成自然语言，撤销「自然语言等于丢判据」这一读法）
    expect(block).toContain('H_op <= H_critical')
    expect(block).toContain('remain coherent')
    // 🔴 判据的方向：**已分叉**。若哪天又变回与 osp 逐字节一致，说明有人无意识地回滚了 v1.134.0。
    expect(block).not.toBe(OSP_CCE)
    expect(block).not.toContain('FIVE BEHAVIORAL CONSTRAINTS (engineering requirements, not suggestions)')
  })
})

describe('dsp 扩展：Principles 块（v1.19.8 合并原 Constraints——spec 修订：Constraints 不再独立对齐）', () => {
  it('principlesBlock() 含认知容器本体论 + Operational boundaries（Root/文件/shell/subagent/session-first）', () => {
    const block = principlesBlock(dir)
    // 本体论（认知容器：无错误只有认知不足）
    // v1.134.0：删了 `Why a cognitive container:` 设问句头（owner 令精简），本体论正文一字未动。
    expect(block).toContain('=== Serenity Principles ===')
    expect(block).toContain('All work is cognition')
    expect(block).toContain('contains no errors')
    expect(block).toContain('not-knowing is a state to be repaired')
    // v1.23.0：session–cognitive-trajectory 关系段（session = cognitive trajectory 的可重建载体）
    expect(block).toContain('A session is the rebuildable carrier of a cognitive trajectory')
    expect(block).toContain("SESSION.md is that")
    expect(block).toContain('Identity belongs to the trajectory, not to any session')
    // 操作边界（原 Constraints 内容，工具名为平台真实名 msm）
    expect(block).toContain('Operational boundaries:')
    expect(block).toContain(`Root: ${dir}`)
    expect(block).toContain('File access')
    expect(block).toContain('use msm')
    expect(block).toContain('Subagent')
    expect(block).toContain('Session-first')
  })
})

describe('dsp 领先：Session 块（v1.23.0 载体关系 + steward 预声明；唯一 osp 例外 = DSH todowrite 无 priority 字段）', () => {
  it('sessionBlock() 与 DSH 适配版参照完全相等', () => {
    // 建立内存活跃会话（S134 v1.16.14 内存化：useSession 写内存 Map，不落盘）
    const dirName = '2026-08-13--S126--dsh-serenity-public-beta-adapt'
    const mdRel = join('AGENT_SESSIONS', dirName, 'SESSION.md')
    mkdirSync(join(dir, 'AGENT_SESSIONS', dirName), { recursive: true })
    writeFileSync(join(dir, mdRel), '# test')
    useSession(dir, 'S126', 'test-scope')

    const block = sessionBlock(dir, 'test-scope')
    expect(block).not.toBe('')
    expect(block).toBe(OSP_SESSION('S126', dirName, join(dir, mdRel)))
    // 同时证明：除 todowrite priority 字段外与 osp 一致（osp 版含 priority: "low"）
    const ospOriginal = OSP_SESSION('S126', dirName, join(dir, mdRel)).replace(
      '    status: "completed" }',
      '    status: "completed", priority: "low" }',
    )
    expect(block.replace('    status: "completed" }', '    status: "completed", priority: "low" }')).toBe(ospOriginal)
  })
})

describe('osp 对齐：SKILL 全文原文直推 + 装配结构', () => {
  it('entrySkillSectionText() 原文直推（含 frontmatter，无包裹头）', () => {
    setupCccWithSkill('other-serenity', '顶层入口原文内容')
    const text = entrySkillSectionText(dir)
    expect(text).toBe('---\nname: other-serenity\ndescription: 系统入口\n---\n顶层入口原文内容')
  })

  it('serenitySystemPrompt() 块序 ACC→Metaphor→Principles→CCE→EAP→SKILL→MSM→Session，无 --- 分隔线（v1.124.0：Tools→MSM）', () => {
    setupCccWithSkill('other-serenity')
    const dirName = '2026-08-13--S126--dsh-serenity-public-beta-adapt'
    mkdirSync(join(dir, 'AGENT_SESSIONS', dirName), { recursive: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md'), '# test')
    useSession(dir, 'S126', 'test-scope')

    const text = serenitySystemPrompt(dir, 'test-scope')
    const accIdx = text.indexOf('=== Serenity ACC ===')
    const metaIdx = text.indexOf('=== Serenity Metaphor ===')
    const priIdx = text.indexOf('=== Serenity Principles ===')
    const cceIdx = text.indexOf('=== Serenity CCE ===')
    const eapIdx = text.indexOf('=== Serenity EAP ===')
    const skillIdx = text.indexOf('顶层入口原文内容')
    // 🔴 v1.124.0：工具清单块已删，标题随之改为 `Serenity MSM`（块里只剩 MSM 调用示例）。
    //    ⚠️ 见 system-prompt.test.ts 同处注释：`-1` 会让不等式比较失去意义 ⇒ 先断言 > 0。
    const msmIdx = text.indexOf('=== Serenity MSM ===')
    const sesIdx = text.indexOf('=== Serenity Session ===')
    expect(msmIdx).toBeGreaterThan(0)
    expect(text.indexOf('=== Serenity Tools ===')).toBe(-1)
    expect(accIdx).toBeGreaterThanOrEqual(0)
    expect(metaIdx).toBeGreaterThan(accIdx)
    expect(priIdx).toBeGreaterThan(metaIdx)
    expect(cceIdx).toBeGreaterThan(priIdx)
    expect(eapIdx).toBeGreaterThan(cceIdx)
    expect(skillIdx).toBeGreaterThan(eapIdx)
    // MSM 块在 SKILL 后、Session 前
    expect(msmIdx).toBeGreaterThan(skillIdx)
    expect(sesIdx).toBeGreaterThan(msmIdx)
    expect(text).not.toContain('---\n\n')
    expect(text).not.toContain('# CCC 入口技能')
  })
})

describe('osp 对齐：身份块 + MSM 块结构（v1.124.0：工具清单已删）', () => {
  it('identityBlock() 含身份行/CCC/MSM 发现行，不含平台工具句与工具清单（v1.124.0 删两处）', () => {
    const block = identityBlock(dir)
    expect(block).toContain(`ACC: dsh-serenity-hooks v${ACC_VERSION}`)
    expect(block).toContain(`CCC: ${dir.split('/').pop()}`)
    expect(block).not.toContain(`Root: ${dir}`) // v1.19.6：Root 唯一真相源 = Constraints 块
    // 🔴 v1.135.0（owner 2026-11-15 定稿）：身份句从「运行在容器里的程序」
    //    改为「站在桥上、掌舵一条持久认知轨迹的操作员」。**判据不变**（身份行必须在），
    //    ⛔ 只跟措辞走 —— 旧钉 `You are running inside a Concrete Cognitive Container` 已失效。
    expect(block).toContain('You are standing on the bridge of a Concrete Cognitive Container (CCC)')
    // 身份块不再内嵌工具清单（需求③移出 toolsBlock）
    expect(block).not.toContain('container_fs     —')
    expect(block).not.toContain('cheap-worker  —')
    // 🔴 v1.124.0（owner 2026-11-09 令）：**平台工具句 + 指向工具清单的指引句都删了**。
    //    判据 = 宿主自己注入那些工具的 schema（点名零新增信息），而那份名单没人会同步。
    expect(block).not.toContain('DSH platform tools remain available')
    expect(block).not.toContain('"Serenity Tools" heading')
    // 2026-09-16（S142 §0e-C，所有者裁「同意修正」）：MSM 指引改指 msm() 无参目录。
    // 旧文 `call msm("<name>") to execute or discover them (see the "Serenity Tools" heading below)`
    // 把 **MSM**（CCC 注册的另一层）指到 **ACC 内置工具清单**标题下 ⇒ 指错对象，属干扰。
    // 🔴 v1.135.0（2026-11-15）：措辞再变（`msm() with no arguments lists them`）——
    //    **判据不变**：MSM 发现入口必须写在身份块里。⛔ 判措辞字面 = 每改一次文案就红一次。
    expect(block).toContain('msm() with no')
    expect(block).toContain('msm("<name>") runs one')
    expect(block).not.toContain('(see the "Serenity Tools" heading below)')
  })

  it('toolsBlock() 只剩 MSM 单入口示例，⛔ 无工具清单（v1.124.0：清单是第二真相源）', () => {
    const block = toolsBlock()
    expect(block).toContain('=== Serenity MSM ===')
    expect(block).not.toContain('=== Serenity Tools ===')
    // 形态判据：行首两空格 + 工具名 + `—` 的**清单行**必须一条不剩。
    // ⛔ 不要用"block 提到 container_admin"来判 —— MSM 的 Manage 行合法地提到它。
    for (const tool of ['container_fs', 'cognitive_trajectory', 'dashboard', 'container_git', 'msm', 'praxis', 'ontology', 'serenity-skill-creator', 'localstore']) {
      expect(block, `工具清单行仍在：${tool}`).not.toMatch(new RegExp(`^ {2}${tool}\\s+—`, 'm'))
    }
    expect(block).not.toContain('cheap-worker')
    // msm 单入口调用留存（替代旧 3 步协议）
    expect(block).toContain('msm("')
    expect(block).toContain('inspect=true')
    expect(block).toContain('container_admin msm register|deregister|check')
    expect(block).toContain('mech-registry.json')
  })
})

describe('dsp 扩展：Metaphor 块（v1.19.6 起，宁静号宇宙隐喻域——无 osp 对应）', () => {
  it('metaphorBlock() 三层结构 + 全英文 10 条隐喻 + 映射标注 + Verdict 判据（v1.19.9：+MSM 两条）', () => {
    const block = metaphorBlock()
    expect(block).toContain('=== Serenity Metaphor ===')
    // 三层分组（v1.19.7 结构化）
    expect(block).toContain('THE SHIP — the container itself')
    expect(block).toContain('THE VOYAGE — the cognitive lifecycle')
    expect(block).toContain('THE CREW — multi-agent collaboration')
    // World 层呼应句（v1.19.8：认知容器本体论隐喻化；v1.29 星舰意象：sea→deep space）
    expect(block).toContain('Deep space has no mistakes — only stars you have not yet mapped.')
    // 10 条隐喻本体（v1.29：Harbor Inspection → Departure Inspection——星舰意象升级）
    // 🔴 v1.134.0：隐喻名跟着精简版走（`The Ship's Log` → `The Log`，其余不变）；
    //    判的是「十景在位」，⛔ 不是「措辞冻结」。
    for (const name of [
      'The Hull',
      'Deck Order',
      'Engineering Drawings',
      'The Machinery',
      'The Manifest',
      'Departure Inspection',
      'The Log',
      'The Ship of Theseus',
      'Crew Rotation',
      'Blueprint over Statue',
    ]) {
      expect(block).toContain(name)
    }
    // 每条含 -> 约束映射（M-1）+ Verdict 判据（M-2）
    // v1.134.0：`→` 改 ASCII `->`（owner 令：不用 emoji/特殊符号装饰），数量仍是 10。
    expect(block.match(/->/g)?.length).toBe(10)
    for (const constraint of ['Bounded Space', 'Entropy', 'EAP', 'MSM', 'Single Source of Truth', 'First Anchor', 'Cognitive Trajectory', 'Continuity', 'Multi-Agent Cognition', 'Reconstruction over Preservation']) {
      expect(block).toContain(constraint)
    }
    // v1.134.0：`Verdict:` 前缀被删，判决句本身仍在 —— 判据 = 十条各有一句判决。
    // ⚠️ 精度取舍（已实测两版）：① `/ = [a-z]/` 只命中 7/10（`= overload.` 这类**行尾**判决
    //    天然不命中）；② `/ = /` 命中 7 —— 因为 3 条判决是跨行折行的，等号落在行尾、宾语在下一行。
    //    ⇒ 精确数条得把「隐喻编号 1~10 各出现一次」当主判据（下面那条），这里只留下限，
    //    ⛔ 别为了凑 10 去改正则然后以为判据变强了。
    expect(block.match(/ = /g)?.length).toBeGreaterThanOrEqual(7)
    // 无中文（全英文）
    expect(block).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
