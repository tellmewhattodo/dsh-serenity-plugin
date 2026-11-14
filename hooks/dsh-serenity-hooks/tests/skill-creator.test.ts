/**
 * skill-creator.test.ts — **P3：`serenity-skill-creator` 工具**（设计 §4.3／§5／§6 J9、J10）
 *
 * 本件钉三件事：
 *   ① **六个子命令都真的可达**（可达性自证 —— 否则下面全是"测空气"）；
 *   ② 🔴 **`create` 出来的骨架必须 `check` 全绿**（脚手架不能生成一个当场就不合格的 skill）；
 *   ③ **J9：普通 skill 全程无声**（任何子命令都不许把"未建模"渲染成错误或告警）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkillCreatorTool } from '../src/tools/skill-creator.js'
import { REGISTERED_TOOLS } from '../src/kernel/invariant.js'

interface ExecutableTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 真值形态的 `exec`：`cccRootForExec` 读 `agent.session.header.cwd` */
function execIn(cwd: string): unknown {
  return { agent: { session: { header: { cwd } } } }
}

const tool = createSkillCreatorTool() as unknown as ExecutableTool

let root: string
let skillsRoot: string

/** 造一条最小基础链（skill.ttl 的 owl:imports 目标；**`create` 只会算出路径，不造它**） */
function mkBaseChain(): void {
  const dir = join(skillsRoot, 'home-serenity', 'references')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'serenity-skills-ontology.ttl'),
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sr: <http://home-serenity/ontology#> .
@prefix : <http://example.org/onto#> .

:onto a owl:Ontology ; sr:name "base" ; owl:versionInfo "0.0.1" .

:Skill a owl:Class ; rdfs:label "Skill" ; sr:rigidity sr:rigid .
`,
    'utf-8',
  )
}

/** 造一个普通 skill（无 skill.ttl） */
function mkPlainSkill(name: string): void {
  const dir = join(skillsRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`, 'utf-8')
}

async function run(args: Record<string, unknown>): Promise<string> {
  return (await tool.execute(args, execIn(root))) as string
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sk-creator-'))
  writeFileSync(join(root, '.serenity'), 'home-serenity') // 顶层 skill 名（create 靠它算相对路径）
  skillsRoot = join(root, '.opencode', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P3 · serenity-skill-creator', () => {
  it('可达性自证：暴露 execute（本件全部断言的前提）', () => {
    expect(typeof tool.execute).toBe('function')
    expect(tool.name).toBe('serenity-skill-creator')
  })

  it('guide：返回方法文本（含三个动作与优化回路）', async () => {
    const t = await run({ action: 'guide' })
    expect(t).toContain('何时该建模')
    expect(t).toContain('owl:imports')
    expect(t).toContain('两层披露树')
    expect(t).toContain('优化回路')
    // 与 praxis ontology 的分工必须写在里面（不重复它的正文）
    expect(t).toContain('praxis ontology')
  })

  it('🔴 create：骨架三件齐 ＋ **基础链相对路径由工具算**（不靠人肉推）', async () => {
    const t = await run({ action: 'create', name: 'demo-skill' })
    const dir = join(skillsRoot, 'demo-skill')
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'skill.ttl'))).toBe(true)
    expect(existsSync(join(dir, 'references'))).toBe(true)
    const ttl = readFileSync(join(dir, 'skill.ttl'), 'utf-8')
    expect(ttl).toContain('owl:imports <../home-serenity/references/serenity-skills-ontology.ttl>')
    expect(t).toContain('已生成 skill 脚手架')
  })

  it('🔴 create 出的骨架**当场 `check` 必须全绿**（脚手架不许生成一个不合格的 skill）', async () => {
    mkBaseChain()
    await run({ action: 'create', name: 'fresh-skill' })
    const t = await run({ action: 'check', name: 'fresh-skill' })
    expect(t).toContain('已建模且全部通过')
    expect(t).toContain('✅ A1')
    expect(t).toContain('✅ A2')
  })

  it('🔴 create 负控：目标目录**已存在** ⇒ 拒绝覆盖（不许静默盖掉别人的东西）', async () => {
    mkPlainSkill('taken')
    await expect(tool.execute({ action: 'create', name: 'taken' }, execIn(root))).rejects.toThrow(/拒绝覆盖/)
  })

  it('create 负控：非法名（含路径分隔/穿越）⇒ 拒', async () => {
    await expect(tool.execute({ action: 'create', name: '../evil' }, execIn(root))).rejects.toThrow(/非法 skill 名/)
    await expect(tool.execute({ action: 'create', name: 'a/b' }, execIn(root))).rejects.toThrow(/非法 skill 名/)
  })

  it('缺 name 的守卫：check/review/index/create 都要 name', async () => {
    await expect(tool.execute({ action: 'check' }, execIn(root))).rejects.toThrow(/`name` is required/)
  })

  // ── J9：普通 skill 全程无声（**只关于"没建模"这件事**；A3 分层是另一条轴）──
  /** 顶层合规的 SKILL.md：够厚 ＋ 不自称导航 ＋ 点名各子树（A3 三判据都过） */
  function writeCompliantTop(name: string): void {
    const dir = join(skillsRoot, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n\n## 1. 身份与边界\n\n本 skill 管 ${name}。\n\n`
        + `${'顶层陈述：这是什么、边界在哪、哪些约束永远成立。'.repeat(80)}\n`,
      'utf-8',
    )
  }

  it('🔴 J9：普通 skill（顶层合规）⇒ check 说"未建模"并**明说这不是通过**，且**不含**错误记号', async () => {
    mkPlainSkill('plain')
    writeCompliantTop('plain')
    const t = await run({ action: 'check', name: 'plain' })
    expect(t).toContain('普通 skill（未建模）')
    expect(t).toContain('这不是"检查通过"')
    expect(t).toContain('✅ A3 分层档')
    expect(t).not.toContain('❌')
  })

  it('🔴 A3 是**另一条轴**：顶层是桩 ⇒ 报分层红（带 A3 码），而"未建模"仍不算错误', async () => {
    mkPlainSkill('stub')
    const t = await run({ action: 'check', name: 'stub' })
    expect(t).toContain('❌ A3 分层档')
    expect(t).toContain('[A3-1]')
    expect(t).toContain('这不是异常（J9）')
    expect(t).toContain('普通 skill（未建模）')
  })

  it('🔴 J9-review：普通 skill 跑 review ⇒ **不是错误**，只说明没有可审的模型', async () => {
    mkPlainSkill('plain')
    const t = await run({ action: 'review', name: 'plain' })
    expect(t).toContain('普通 skill（未建模）')
    expect(t).toContain('这不是错误')
  })

  // ── index：第二层预览（调 P1 的生成器）────────────────────────────────
  it('index：有 references/ ⇒ 打出模型真正会看到的清单；无 ⇒ 明说"不产出该块"', async () => {
    mkPlainSkill('withrefs')
    mkdirSync(join(skillsRoot, 'withrefs', 'references'), { recursive: true })
    writeFileSync(join(skillsRoot, 'withrefs', 'references', '10-a.md'), '# 甲\n', 'utf-8')
    const t = await run({ action: 'index', name: 'withrefs' })
    expect(t).toContain('### Reference files for this skill')
    expect(t).toContain('references/10-a.md')
    expect(t).toContain('甲')

    mkPlainSkill('norefs')
    expect(await run({ action: 'index', name: 'norefs' })).toContain('无参考件可列')
  })

  // ── status：全容器一览（J9 在这里同样成立）──────────────────────────
  it('🔴 status：分列"已建模/普通"，且**明说未建模不是异常**', async () => {
    mkBaseChain()
    mkPlainSkill('p1')
    mkPlainSkill('p2')
    await run({ action: 'create', name: 'm1' })
    const t = await run({ action: 'status' })
    expect(t).toContain('已建模且通过** 1 个')
    expect(t).toContain('**普通 skill（未建模）** 2 个')
    expect(t).toContain('**不是异常**')
  })

  it('J10：工具面清单含本工具（与 manifest 的一致性另有 invariant 件专钉）', () => {
    expect(REGISTERED_TOOLS).toContain('serenity-skill-creator')
  })
})
