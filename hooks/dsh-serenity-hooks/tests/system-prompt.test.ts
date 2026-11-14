import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  entrySkillSectionText,
  registerEntrySkillSectionGlobal,
  registerEntrySkillSection,
  serenitySystemPrompt,
  identityBlock,
  creedBlock,
  toolsBlock,
  cceBlock,
  principlesBlock,
  eapBlock,
  safeModeBlock,
  localstoreBlock,
  codeModeAdaptationLine,
} from '../src/seams/system-prompt.js'
import { ACC_VERSION } from '../src/kernel/constants.js'
import { make轨迹约束Session } from './helpers/trajectory-constraint-fixture.js'

let dir: string

/** 建立 CCC：.serenity 记号 = other-serenity（仿其他 *-serenity 实例），含顶层 skill */
function setupCccWithSkill(skillName = 'other-serenity', skillBody = '顶层入口原文内容'): void {
  writeFileSync(join(dir, '.serenity'), skillName)
  mkdirSync(join(dir, '.opencode', 'skills', skillName), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: 系统入口\n---\n${skillBody}`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('system-prompt: 入口 skill 发现（.serenity 记号 = 顶层入口名）', () => {
  it('无入口返回空', () => {
    expect(entrySkillSectionText(dir)).toBe('')
  })

  it('按 .serenity 记号内容发现顶层 skill（other-serenity）', () => {
    setupCccWithSkill('other-serenity')
    const text = entrySkillSectionText(dir)
    // 对齐 osp：注入 SKILL.md 原文（含 frontmatter），无包裹头
    expect(text).toContain('顶层入口原文内容')
    expect(text).toContain('---\nname: other-serenity')
    expect(text).not.toContain('# CCC 入口技能')
  })

  it('自动扫描 .opencode/skills/*-serenity 兜底（记号无匹配 skill 时）', () => {
    // .serenity 内容不是合法 skill 名（找不到对应 SKILL.md）→ 走扫描兜底
    writeFileSync(join(dir, '.serenity'), 'no-such-skill')
    mkdirSync(join(dir, '.opencode', 'skills', 'home-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'home-serenity', 'SKILL.md'), '---\nname: home-serenity\ndescription: 系统入口\n---\n系统入口原文内容')
    const text = entrySkillSectionText(dir)
    expect(text).toContain('系统入口原文内容')
    expect(text).not.toContain('# CCC 入口技能')
  })
})

describe('system-prompt: 结构注入（需求③：ACC身份→Metaphor→Principles→CCE→EAP→SKILL→Tools→Session）', () => {
  it('serenitySystemPrompt 含 ACC/Metaphor/Principles/CCE/EAP/SKILL 全文', () => {
    setupCccWithSkill('other-serenity')
    const text = serenitySystemPrompt(dir)
    expect(text).toContain('=== Serenity ACC ===')
    expect(text).toContain('=== Serenity Metaphor ===')
    expect(text).toContain('=== Serenity Principles ===')
    expect(text).toContain('=== Serenity CCE ===')
    expect(text).toContain('=== Serenity EAP ===')
    expect(text).toContain('顶层入口原文内容')
    // v1.19.8：独立 Constraints 块已并入 Principles（不再单独存在）
    expect(text).not.toContain('=== Serenity Constraints ===')
  })

  it('身份块：只有 ACC/CCC 身份 + 路径约定 + MSM 指引（v1.124.0：删掉与宿主 schema 重复的平台工具句）', () => {
    const block = identityBlock(dir)
    expect(block).toContain(`ACC: dsh-serenity-hooks v${ACC_VERSION}`)
    expect(block).toContain(`CCC: sp-`)
    expect(block).not.toContain(`Root: ${dir}`) // v1.19.6：Root 唯一真相源 = Constraints 块
    // 需求③：身份块不再内嵌工具清单
    for (const tool of ['container_fs', 'cognitive_trajectory', 'dashboard', 'container_git', 'msm', 'praxis', 'localstore', 'container_admin']) {
      expect(block).not.toMatch(new RegExp(`^  ${tool} `, 'm'))
    }
    // 🔴 v1.124.0（owner 2026-11-09 令「省点空间」）：**平台工具那句整句删除**。
    //    判据 = 宿主自己注入这些工具的 schema ⇒ 点名它们零新增信息，且这份名单
    //    没人会在工具增减时同步（D151 同族：错的指引比没有指引更坏）。
    //    ⚠️ 这条钉的是"删掉了"，故必须是 not.toContain —— 与旧钉方向**相反**，
    //    旧钉（`toContain('DSH platform tools remain available')`）随本次改动作废。
    expect(block).not.toContain('DSH platform tools remain available')
    expect(block).not.toContain('read/write/edit/glob/grep)')
    // 🔴 同上：指向文末工具清单的指引句也删了 —— 那块清单已不存在，
    //    留着就是**指向空处的指针**（模型会去找一个不存在的标题）。
    expect(block).not.toContain('"Serenity Tools" heading')
    // 2026-09-16（S142 §0e-C，所有者裁「同意修正」）：MSM 一行的指引**不得**再指向
    // "Serenity Tools" 标题——那里列的是 **ACC 内置工具**，而 MSM 是 CCC 注册的**另一层**
    // （两者不是一回事）；指错对象 = 对 LLM 的干扰。改指 msm() 无参目录。
    expect(block).not.toContain('(see the "Serenity Tools" heading below)')
    // 🔴 v1.135.0（2026-11-15）：MSM 指引措辞随身份块重写而变，
    //    钉的是「**发现入口必须写在身份块里**」这条判据，⛔ 不是某个冻结措辞。
    //    旧钉 `msm() lists them` 已随本次改写失效（同族：判据不变、措辞可变）。
    expect(block).toContain('msm() with no')
    expect(block).toContain('msm("<name>") runs one')
  })

  it('身份块：v1.135.0 起是"操作员"身份（桥上/掌舵人），⛔ 不再是"运行在容器里的程序"', () => {
    const block = identityBlock(dir)
    // 承重句（owner 2026-11-15 定稿）：身份 = 掌舵人，不是程序
    expect(block).toContain('You are standing on the bridge')
    expect(block).toContain('You are the Operator of Serenity')
    expect(block).toContain('persistent Cognitive Trajectory across time')
    // 「载体可弃、身体长存」这一条必须在（这是 CCE 的连续性判据在身份层的落点）
    expect(block).toContain('but the ship and the trajectory')
    // 🔴 三条负向否定必须在（「不是话本/回声筒/官僚旁观者」= 本块的气质来源）
    expect(block).toContain('not a disposable')
    expect(block).toContain('not a passive echo chamber')
    expect(block).toContain('bureaucratic bystander')
    // 🔴 owner 2026-11-14 令：⛔ 不用 emoji 装饰。旧草稿里的 `ℹ️` 已删 —— 反向钉住。
    expect(block).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    // 路径例子会过期（S134 目录名将来会变）⇒ 判据是"相对路径"这件事，不是那个例子
    expect(block).not.toContain('AGENT_SESSIONS/2026-08-14--S134')
  })

  it('creedBlock：标题 + 三段承重句 + 五条品质 + 收束句（v1.135.0）', () => {
    const block = creedBlock()
    expect(block).toContain('=== Serenity Operator Creed ===')
    // ① 三段承重句：主语必须是**会承担后果的人**，⛔ 不是系统自身
    expect(block).toContain('Not a tool that answers — a mind that judges')
    expect(block).toContain('read by someone who cannot check it')
    expect(block).toContain('A family member will live with the consequence')
    expect(block).toContain('Neither can audit the work')
    expect(block).toContain('So we begin from the person, not from the task')
    // ② 过渡行：把"义务"焊到"五条"上（没有它，五条会被读成另一段清单）
    //    🔴 形态判据：⛔ 不能用 `---` 包起来 —— 装配层有一条机器契约
    //    「提示词里不得出现 `---\n\n`」（那是 YAML frontmatter 分隔线的形状）。
    //    我的第一版写成 `--- What that obliges ---` 正好撞上它，已改冒号式。
    expect(block).toContain('What that obliges:')
    expect(block).not.toContain('---\n\n')
    // ③ 五条品质：编号连续 1~5（机械判据：漏一条就断号）
    for (const n of [1, 2, 3, 4, 5]) {
      expect(block, `第 ${n} 条缺失`).toContain(`\n${n}. `)
    }
    // ④ 每条的关键判据必须在（判据不在 = 退回"五条箴言"）
    expect(block).toContain('at most five numbered questions')
    expect(block).toContain('bulkheaded corridor')
    expect(block).toContain('skip abstraction levels')
    expect(block).toContain('preserve the blueprint over the statue')
    expect(block).toContain('enforce machinery before')
    // ⑤ 收束句
    expect(block).toContain('Not this, but that')
    // ⛔ emoji 禁令同样适用于本块
    expect(block).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    // ⛔ 中文四字锚点**不进**装配缝（纯装饰，与 emoji 同族；它在 docs/operator-charter.md 里）
    expect(block).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('creedBlock 在装配里：紧随身份块，且在一切可替换块之前', () => {
    setupCccWithSkill('other-serenity')
    const text = serenitySystemPrompt(dir)
    const iAcc = text.indexOf('=== Serenity ACC ===')
    const iCreed = text.indexOf('=== Serenity Operator Creed ===')
    const iMeta = text.indexOf('=== Serenity Metaphor ===')
    expect(iAcc).toBeGreaterThan(-1)
    expect(iCreed).toBeGreaterThan(iAcc)
    expect(iMeta).toBeGreaterThan(iCreed)
    // 判据：宪章的**标题**必须在 EAP 之前（EAP 是它的下层判据，不是它的后置）
    expect(text.indexOf('=== Serenity EAP ===')).toBeGreaterThan(iCreed)
  })

  it('toolsBlock：只剩 MSM 调用示例，⛔ 不含工具清单（v1.124.0：清单是第二真相源，已删）', () => {
    const block = toolsBlock()
    // 标题随内容改（块里已无工具清单，仍叫 Tools 会让模型按"工具总表"来读）
    expect(block).toContain('=== Serenity MSM ===')
    expect(block).not.toContain('=== Serenity Tools ===')
    expect(block).not.toContain('The ACC (this plugin) provides the following built-in tools')
    // 🔴 判据本体：**逐行清单形态**必须消失。用"行首两个空格 + 工具名 + 空格/破折号"
    // 这个形态判，⛔ 不用"block 里出现了 container_fs 这个词"——因为 MSM 那几行
    // 合法地提到 `container_admin`（Manage 行）。形态判据才是"清单走了"的证据。
    for (const tool of ['container_fs', 'cognitive_trajectory', 'dashboard', 'container_git', 'msm', 'praxis', 'ontology', 'serenity-skill-creator', 'localstore']) {
      expect(block, `工具清单行仍在：${tool}`).not.toMatch(new RegExp(`^ {2}${tool}\\s+—`, 'm'))
    }
    expect(block).not.toContain('cheap-worker')
    // MSM 单入口调用留存（当年真机踩出来的，不是清单的一部分）
    expect(block).toContain('msm("')
    expect(block).toContain('inspect=true')
    expect(block).toContain('container_admin msm register|deregister|check')
    expect(block).toContain('never edit mech-registry.json directly')
  })

  it('CCE 块：5 行为约束 + H_op（逐字对齐 osp）', () => {
    const block = cceBlock()
    expect(block).toContain('Cognitive Continuity Engineering')
    expect(block).toContain('1. Continuity')
    expect(block).toContain('2. Bounded Space')
    expect(block).toContain('3. Entropy')
    expect(block).toContain('4. Reconstruction')
    expect(block).toContain('5. Multi-Agent')
    expect(block).toContain('H_op <= H_critical')
    expect(block).toContain('H_op')
    expect(block).toContain('Organization must at least match')
  })

  it('Principles 块（v1.19.8 合并 Constraints）：本体论 + MSM 原则 + Root/文件/shell/subagent/session-first', () => {
    const block = principlesBlock(dir)
    // 认知容器本体论
    expect(block).toContain('All work is cognition')
    expect(block).toContain('contains no errors')
    // MSM 原则（v1.19.9）
    expect(block).toContain('Machinery before improvisation')
    expect(block).toContain('registered Mech before hand-rolling')
    expect(block).toContain('only decoder of its own usage')
    expect(block).toContain('no tool exists unless it is on the manifest')
    // 操作边界（原 Constraints 内容）
    expect(block).toContain(`Root: ${dir}`)
    expect(block).toContain('File access')
    expect(block).toContain('Shell — use msm by default')
    expect(block).toContain('Subagent — copies ALL parent constraints')
    expect(block).toContain('Session-first')
    expect(block).toContain('wait for user "use" or "使用" to confirm')
  })
})

describe('system-prompt: 全局 section 注册（任何会话自动注入）', () => {
  it('全局注册：text 回调按 context.agent 的 cwd 解析 CCC → 返回完整注入文本', () => {
    let captured: { name: string; order: number; text: unknown } | null = null
    const fakeCtx = {
      systemPrompt: {
        section: (section: { name: string; order: number; text: unknown }) => {
          captured = section
        },
      },
    }
    registerEntrySkillSectionGlobal(fakeCtx as never)

    expect(captured).not.toBeNull()
    expect(captured!.name).toBe('serenity-entry')
    expect(captured!.order).toBe(-50)

    // 非 CCC cwd → 空
    const ctxNoCcc = { agent: { session: { header: { cwd: '/tmp' } } } }
    expect((captured!.text as (c: unknown) => string)(ctxNoCcc)).toBe('')

    // CCC cwd → 完整注入（ACC + CCE + Constraints + skill 全文）
    setupCccWithSkill('other-serenity')
    const ctxCcc = { agent: { session: { header: { cwd: join(dir, 'sub') } } } }
    const text = (captured!.text as (c: unknown) => string)(ctxCcc)
    expect(text).toContain('=== Serenity ACC ===')
    expect(text).toContain('顶层入口原文内容')

    // 无 agent → 空
    expect((captured!.text as (c: unknown) => string)({})).toBe('')
  })

  it('🔴 T2 翻转：轨迹约束会话**不再旁路** —— 与普通会话走同一条装配（旁路已删除）', () => {
    let captured: { name: string; order: number; text: unknown } | null = null
    const fakeCtx = {
      systemPrompt: {
        section: (section: { name: string; order: number; text: unknown }) => {
          captured = section
        },
      },
    }
    registerEntrySkillSectionGlobal(fakeCtx as never)
    setupCccWithSkill('other-serenity')
    // 🔴 2026-10-19 T2：旧语义是「轨迹约束会话 ⇒ 空（CCC 提示词全替换）」。
    //    现在**删掉了那条旁路**：所有轨迹走同一条装配，轨迹约束的差异只剩能力约束面。
    //    ⚠️ 配对负控（上一版是正控，这里必须反过来）：普通会话**同样**注入 —— 若哪天
    //    "注入"变成恒真（比如函数直接 return 常量），这条就不再承重，故两条一起看。
    const SESSION = '轨迹约束-qa-readonly-uuid'
    make轨迹约束Session(dir, SESSION, 'qa-readonly')
    const ctx轨迹约束 = { agent: { session: { id: SESSION, header: { cwd: dir } } } }
    const 轨迹约束Text = (captured!.text as (c: unknown) => string)(ctx轨迹约束)
    expect(轨迹约束Text).toContain('=== Serenity ACC ===')
    // 对照：普通会话仍是同一套容器层（两者在**容器层**上已无差别）
    const ctxNormal = { agent: { session: { id: 'main-1', header: { cwd: dir } } } }
    expect((captured!.text as (c: unknown) => string)(ctxNormal)).toContain('=== Serenity ACC ===')
  })

  it('🔴 负控：仅有 `轨迹约束-` 前缀、但轨迹没有 trajectory-constraint.json ⇒ **仍注入**（前缀不再是判据）', () => {
    let captured: { name: string; order: number; text: unknown } | null = null
    const fakeCtx = {
      systemPrompt: {
        section: (section: { name: string; order: number; text: unknown }) => {
          captured = section
        },
      },
    }
    registerEntrySkillSectionGlobal(fakeCtx as never)
    setupCccWithSkill('other-serenity')
    // 前缀在、轨迹无 ⇒ 这是"普通认知轨迹"，必须照常拿到 ACC 身份
    const ctx = { agent: { session: { id: '轨迹约束-prefix-only-no-profile', header: { cwd: dir } } } }
    expect((captured!.text as (c: unknown) => string)(ctx)).toContain('=== Serenity ACC ===')
  })

  it('全局注册失败（重复 section 名）不抛错（try/catch 吞掉）', () => {
    const fakeCtx = {
      systemPrompt: {
        section: () => {
          throw new Error('duplicate section')
        },
      },
    }
    expect(() => registerEntrySkillSectionGlobal(fakeCtx as never)).not.toThrow()
  })
})

/**
 * ⑤ 第 36 件：**scoped 注册变体** `registerEntrySkillSection`（agent 级 section）
 *
 * 🔴 **为什么它此前零行为证据**：全局变体（`...Global`）有 3 条用例，而**本变体一条也没有**
 * —— 覆盖率报告把它整段标成 `fstat-no` ＋ 6 行 `cstat-no`（函数体连同语句一起没进过）。
 * 🔴 **可达性已取证**（挑靶四条，动手前）：`src/seams/context.ts` 两处调用它
 * （`agent/created` 播种 与 会话恢复路径），`src/trajectory/session.ts` 另有一处同族调用 ⇒ **是活路径不是死代码**。
 *
 * **它与全局变体的三处语义差异**（本组逐条钉住，这才是它的价值所在）：
 *   ① **`sectionedAgents` 幂等闸**（模块级 Set，key = dsh 会话 id）⇒ 同会话第二次调用返回 `false` 且**不重复注册**
 *   ② **`scope` 来自 `agent.session.id`**（缺省回落 `DEFAULT_SESSION_SCOPE`）—— 全局变体是从 **context** 取
 *   ③ **`codeModeAdaptationLine` 吃 `agent.ctx`**（不是全局变体的插件 ctx）
 * ⚠️ `sectionedAgents` 是**模块级状态** ⇒ 用例间必须用**各自唯一的 session id**，否则会互相污染（幂等闸误伤）。
 */
describe('system-prompt: scoped 注册变体 registerEntrySkillSection（⑤ 第 36 件）', () => {
  /** 假 agent：捕获 section 注册；ctx 供 code-mode 判定（无 tools ⇒ 不加适配行） */
  function fakeAgent(sessionId: string, root: string): {
    agent: { session: { id: string; header: { cwd: string } }; ctx: unknown }
    captured: () => { name: string; order: number; text: (c: unknown) => string } | null
  } {
    let captured: { name: string; order: number; text: (c: unknown) => string } | null = null
    const agent = {
      session: { id: sessionId, header: { cwd: root } },
      ctx: {
        systemPrompt: {
          section: (s: { name: string; order: number; text: (c: unknown) => string }) => {
            captured = s
          },
        },
        tools: undefined,
      },
    }
    return { agent, captured: () => captured }
  }

  it('注册形态：section 名 serenity-entry / order -50 / 首次返回 true', () => {
    setupCccWithSkill('other-serenity')
    const { agent, captured } = fakeAgent('sp-scoped-form-1', dir)
    const ok = registerEntrySkillSection(agent as never, dir)
    expect(ok).toBe(true)
    expect(captured()).not.toBeNull()
    expect(captured()!.name).toBe('serenity-entry')
    expect(captured()!.order).toBe(-50)
  })

  it('🔴 幂等闸（本变体独有）：同 session id 第二次调用 ⇒ false，且**不重复注册**', () => {
    setupCccWithSkill('other-serenity')
    const first = fakeAgent('sp-scoped-idem-2', dir)
    expect(registerEntrySkillSection(first.agent as never, dir)).toBe(true)
    const callsAfterFirst = first.captured()

    // 同一 session id，换一个新 agent 对象（模拟同会话被再次播种）
    const second = fakeAgent('sp-scoped-idem-2', dir)
    expect(registerEntrySkillSection(second.agent as never, dir)).toBe(false)
    // 判据 = **没有发生第二次 section 注册**（而不是仅仅返回 false）
    expect(second.captured()).toBeNull()
    // 正控：第一次确实注册过（避免"两边都是 null 也算过"的假绿）
    expect(callsAfterFirst).not.toBeNull()
  })

  it('text 回调：CCC cwd ⇒ 完整注入；非 CCC ⇒ 空（scoped 版闭包持有 root，不读 context.agent.cwd）', () => {
    setupCccWithSkill('other-serenity')
    const { agent, captured } = fakeAgent('sp-scoped-text-3', dir)
    registerEntrySkillSection(agent as never, dir)
    const text = captured()!.text

    // 闭包持有 root ⇒ 即便 context 里给别的 agent/cwd，正文仍是本 CCC 的
    const out = text({ agent: { session: { id: 'someone-else', header: { cwd: '/tmp' } } } })
    expect(out).toContain('=== Serenity ACC ===')
    expect(out).toContain('顶层入口原文内容')
    // 全局变体在非 CCC cwd 时返回空；scoped 变体**不按 context 判定** —— 这条差异是刻意的
    expect(out).not.toBe('')
  })

  it('🔴 T2 翻转：scoped 版**也删掉了 轨迹约束旁路** —— 兜底闸不再按 轨迹约束 返回空', () => {
    setupCccWithSkill('other-serenity')
    // 🔴 2026-10-19 T2：旧语义是「scope 绑定的轨迹有 trajectory-constraint.json ⇒ 空」。
    //    现在不是了：装配只剩一条路径（旁路在全局版与 scoped 版**同时删除**）。
    make轨迹约束Session(dir, '轨迹约束-qa-readonly-probe-4', 'qa-readonly', undefined, 'probe')
    const { agent, captured } = fakeAgent('轨迹约束-qa-readonly-probe-4', dir)
    registerEntrySkillSection(agent as never, dir)
    expect(captured()!.text({})).toContain('=== Serenity ACC ===')
  })

  it('注册失败（section 抛错）⇒ 返回 false 且不抛（apply 不可成为启动单点）', () => {
    const agent = {
      session: { id: 'sp-scoped-throw-5', header: { cwd: dir } },
      ctx: {
        systemPrompt: {
          section: () => {
            throw new Error('duplicate section')
          },
        },
      },
    }
    expect(() => registerEntrySkillSection(agent as never, dir)).not.toThrow()
    expect(registerEntrySkillSection(agent as never, dir)).toBe(false)
  })
})

describe('system-prompt: EAP 块（S131 P1-6 扩展）', () => {
  it('eapBlock 含 E↑/R↓/S↑ 自检三行（v1.23.0 英化）', () => {
    const block = eapBlock()
    expect(block).toContain('=== Serenity EAP ===')
    expect(block).toContain('E↑ Explicit')
    expect(block).toContain('R↓ Reconstructable')
    expect(block).toContain('S↑ Stable')
    expect(block).toContain('external reconstructability')
  })

  it('serenitySystemPrompt 块序 ACC→Metaphor→Principles→CCE→EAP→SKILL→MSM→Session（v1.124.0：Tools→MSM）', () => {
    setupCccWithSkill('other-serenity')
    const text = serenitySystemPrompt(dir)
    const acc = text.indexOf('=== Serenity ACC ===')
    const meta = text.indexOf('=== Serenity Metaphor ===')
    const pri = text.indexOf('=== Serenity Principles ===')
    const cce = text.indexOf('=== Serenity CCE ===')
    const eap = text.indexOf('=== Serenity EAP ===')
    const skill = text.indexOf('顶层入口原文内容')
    // 🔴 v1.124.0：该块标题从 `Serenity Tools` 改为 `Serenity MSM`（块里已无工具清单）。
    //    ⚠️ 这里必须断言 **> 0** 而不是只比大小：`indexOf === -1` 会让后面所有
    //    `toBeLessThan/toBeGreaterThan` 的**不等式比较意义**——旧标题的 -1 恰好"小于一切"
    //    （若它被当成"块在此处"就会得到一串假绿）。
    const msmIdx = text.indexOf('=== Serenity MSM ===')
    expect(msmIdx).toBeGreaterThan(0)
    expect(text.indexOf('=== Serenity Tools ===')).toBe(-1)
    expect(acc).toBeGreaterThanOrEqual(0)
    expect(acc).toBeLessThan(meta)
    expect(meta).toBeLessThan(pri)
    expect(pri).toBeLessThan(cce)
    expect(cce).toBeLessThan(eap)
    expect(eap).toBeLessThan(skill)
    // 需求③：MSM 块在 SKILL 后（无 Session 时它接近文末）
    expect(msmIdx).toBeGreaterThan(skill)
  })
})

describe('system-prompt: Code Mode 适配行（S131 P0-2）', () => {
  it('run_code 可见（code|both）→ 返回引导块', () => {
    const fakeCtx = {
      tools: {
        get: (name: string) => name === 'run_code' ? { name: 'run_code' } : undefined,
      },
    }
    const line = codeModeAdaptationLine(fakeCtx as never)
    expect(line).toContain('=== Serenity Code Mode ===')
    expect(line).toContain('await tools.container_fs')
  })

  it('native（run_code 不可见）→ 空串', () => {
    const fakeCtx = {
      tools: {
        get: () => undefined,
      },
    }
    expect(codeModeAdaptationLine(fakeCtx as never)).toBe('')
  })

  it('无 tools 服务 → 空串（try/catch 吞掉）', () => {
    expect(codeModeAdaptationLine({} as never)).toBe('')
  })
})

describe('system-prompt: 运行时状态动态块（S134 v1.16.12）', () => {
  it('safeModeBlock：ON 注入（英文，与实现对应：bash disabled / blacklist / governance files）/ OFF 空', () => {
    expect(safeModeBlock(dir)).toBe('')
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    const b = safeModeBlock(dir)
    expect(b).toContain('=== Serenity Safe Mode ===')
    expect(b).toContain('bash is disabled')
    expect(b).toContain('blacklist rules apply')
    expect(b).toContain('governance files')
    expect(b).toContain('do not attempt to bypass')
    // write/edit 保留的表述（与 guards.ts SAFE_MODE_DENY_TOOLS 只含 bash 一致；v1.19.8 重排为 Operational details）
    expect(b).toContain('other read/write tools remain available')
    expect(b).toContain('remain available')
  })

  it('safeModeBlock：黑名单规则动态列出', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ safeMode: { blacklist: ['.secrets/'] } }))
    expect(safeModeBlock(dir)).toContain('.secrets/')
  })

  it('localstoreBlock：无文件空 / deny 私有提示（缺省）', () => {
    expect(localstoreBlock(dir)).toBe('')
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const b = localstoreBlock(dir)
    expect(b).toContain('=== Serenity Localstore ===')
    expect(b).toContain('local private file')
    expect(b).toContain('gitTrack=deny')
    expect(b).toContain('not committed to git')
    expect(b).toContain('do not write')
  })

  it('localstoreBlock：allow → 进 git 但敏感数据只限该文件（英文）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const b = localstoreBlock(dir)
    expect(b).toContain('committed to git')
    expect(b).toContain('gitTrack=allow')
    expect(b).toContain('ONLY in this file')
    expect(b).toContain('never leak them into other files')
  })

  it('serenitySystemPrompt 装配顺序：EAP → 状态块（ON + localstore 时）→ SKILL（v1.19.8）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const text = serenitySystemPrompt(dir)
    expect(text.indexOf('=== Serenity EAP ===')).toBeLessThan(text.indexOf('=== Serenity Safe Mode ==='))
    expect(text.indexOf('=== Serenity Safe Mode ===')).toBeLessThan(text.indexOf('=== Serenity Localstore ==='))
  })
})

describe('v1.23.1 persona 彩蛋（装配替换，SERENITY_HOOKS_CONFIG 注入全局文件）', () => {
  let cfgPath: string
  let oldEnv: string | undefined

  beforeEach(() => {
    cfgPath = join(dir, 'serenity-hooks.json')
    oldEnv = process.env.SERENITY_HOOKS_CONFIG
    process.env.SERENITY_HOOKS_CONFIG = cfgPath
  })

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
    else process.env.SERENITY_HOOKS_CONFIG = oldEnv
  })

  it('personaBlock：mode+文本齐 → Persona 块；mode 空 → 空串', async () => {
    const { personaBlock } = await import('../src/seams/system-prompt.js')
    const on = personaBlock('大肥鱼', 'You are a big fat fish.\nLazy but correct.')
    expect(on).toContain('=== Serenity Persona ===')
    expect(on).toContain('big fat fish')
    // ⚠️ T3：personaBlock 自己**从不**产出/吞掉 EAP 块（它只管表达层）——
    //    旧断言 `not.toContain('=== Serenity EAP ===')` 测的是装配层的置换行为，已随 T3 移走；
    //    这里保留"它自己不含 EAP"这一层窄语义（它确实不含）。
    expect(on).not.toContain('=== Serenity EAP ===')
    expect(personaBlock('', 'text')).toBe('')
    expect(personaBlock('mode', '   ')).toBe('')
  })

  it('未配置 → 与默认逐字节一致（零影响）：含 EAP 块 + MSM 原则段', async () => {
    const { serenitySystemPrompt } = await import('../src/seams/system-prompt.js')
    const text = serenitySystemPrompt(dir)
    expect(text).toContain('=== Serenity EAP ===')
    expect(text).toContain('E↑ Explicit')
    expect(text).toContain('Machinery before improvisation')
    expect(text).toContain('registered Mech')
    expect(text).not.toContain('=== Serenity Persona ===')
  })

  it('配置 → Persona 块**追加**为表达层，EAP 质量层仍在（T3 修正：不再置换）', async () => {
    writeFileSync(cfgPath, JSON.stringify({ persona: { mode: '大肥鱼', overrideText: 'You are a big fat fish.' } }))
    const { serenitySystemPrompt } = await import('../src/seams/system-prompt.js')
    const text = serenitySystemPrompt(dir)
    // 🔴 2026-10-19 T3：旧语义是「persona **替换** EAP 块」——那正是 review F-05/R-14
    //    那个悬置冲突（违反 I5：Induction 内容必须匹配标准，EAP 属于 layer B）。
    //    新语义：**两层都注入**，persona 只能收窄表达，不能取消"输出前自检"这件事本身。
    expect(text).toContain('=== Serenity Persona ===')
    expect(text).toContain('big fat fish')
    expect(text).toContain('=== Serenity EAP ===')
    expect(text).toContain('E↑ Explicit')
    // 表达层紧跟在质量层之后（先立标准，再谈表达）
    expect(text.indexOf('=== Serenity EAP ===')).toBeLessThan(text.indexOf('=== Serenity Persona ==='))
    // MSM 原则段剥离（指令遵循约束被 persona 承接）——这一条**不变**
    expect(text).not.toContain('Machinery before improvisation')
    expect(text).not.toContain('registered Mech before hand-rolling')
    // 安全硬约束永远保留：本体论 / 关系段 / 操作边界 / CCE
    expect(text).toContain('All work is cognition')
    expect(text).toContain('rebuildable carrier of a cognitive trajectory')
    expect(text).toContain('Operational boundaries:')
    expect(text).toContain('File access')
    expect(text).toContain('=== Serenity CCE ===')
    // 装配位置：Persona 在 CCE 之后（EAP 原位）
    expect(text.indexOf('=== Serenity CCE ===')).toBeLessThan(text.indexOf('=== Serenity Persona ==='))
  })

  it('principlesBlock(omitMsmPrinciples) 纯函数：剥离 MSM 段但保留其余', async () => {
    const { principlesBlock } = await import('../src/seams/system-prompt.js')
    const full = principlesBlock(dir, false)
    const omitted = principlesBlock(dir, true)
    expect(full).toContain('Machinery before improvisation')
    expect(omitted).not.toContain('Machinery before improvisation')
    expect(omitted).toContain('All work is cognition')
    expect(omitted).toContain('Operational boundaries:')
    expect(omitted).toContain('Session-first')
  })
})
