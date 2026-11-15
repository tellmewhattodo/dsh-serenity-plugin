/**
 * skill-ontology.test.ts — **P2：本体预留口的发现与检查**（设计 §6 判据 J1/J2/J3 ＋ §4.1 的 A1~A3）
 *
 * 每条判据都要**正控 ＋ 负控**（"检查没跑＝检查通过"是本仓两天内撞见四次的族）。
 * 🔴 **J2 是本设计的回归钉**：它钉的是一条**实测过的真缺陷** —— CCC 侧 14 份领域本体写的是
 * `sr:imports`，而引擎只解析 `owl:imports`，于是"链上基础链"这件事**从来没成立过且无信号**。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  inspectSkillOntology,
  formatSkillOntologyInspection,
  extractEngineErrors,
  type SkillOntologyInspection,
} from '../src/skills/skill-ontology.js'

let root: string
let skillDir: string

/** 一个能过 `check --level strict` 的最小本体（形状照引擎自带测试的 MINI_TTL） */
function miniTtl(opts: { imports?: string; extra?: string } = {}): string {
  const imp = opts.imports === undefined ? '' : `    owl:imports <${opts.imports}> ;\n`
  return `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sr: <http://home-serenity/ontology#> .
@prefix : <http://example.org/onto#> .

:onto a owl:Ontology ;
    sr:name "mini" ;
    owl:versionInfo "0.1.0" ;
${imp}    rdfs:comment "minimal" .

:Thing a owl:Class ;
    rdfs:label "Thing" ;
    sr:rigidity sr:rigid .
${opts.extra ?? ''}
`
}

function writeSkillTtl(content: string): void {
  writeFileSync(join(skillDir, 'skill.ttl'), content, 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sk-onto-'))
  skillDir = join(root, '.opencode', 'skills', 'demo-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\n# demo\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P2 · 本体预留口', () => {
  // ── J9：普通 skill 全程无声（不是错误、不是告警）──────────────────────
  it('🔴 J9：无 skill.ttl ⇒ state=none、无 checks、**零告警**（普通 skill 向后兼容）', () => {
    const insp = inspectSkillOntology(skillDir, { root })
    expect(insp.state).toBe('none')
    expect(insp.modeled).toBe(false)
    expect(insp.checks).toEqual([])
    expect(insp.rel).toBe('')
  })

  // ── J1：固定名才算预留口（正控／负控成对）──────────────────────────────
  it('J1 正控：`skill.ttl` 在 skill 根 ⇒ 被发现', () => {
    writeSkillTtl(miniTtl({ imports: 'base.ttl' }))
    writeFileSync(join(skillDir, 'base.ttl'), miniTtl(), 'utf-8')
    expect(inspectSkillOntology(skillDir, { root }).modeled).toBe(true)
  })

  it('🔴 J1 负控：**旧名**（`demo-skill-domain.ttl`）与任意 `foo.ttl` ⇒ **不**被当预留口', () => {
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(join(skillDir, 'references', 'demo-skill-domain.ttl'), miniTtl(), 'utf-8')
    writeFileSync(join(skillDir, 'foo.ttl'), miniTtl(), 'utf-8')
    const insp = inspectSkillOntology(skillDir, { root })
    expect(insp.state).toBe('none') // 裁决 Q6：旧名当普通参考件，不特殊对待
    expect(insp.modeled).toBe(false)
  })

  // ── A1：结构合法 ────────────────────────────────────────────────────
  it('A1：写坏（Turtle 语法错）⇒ A1 红 ＋ state=error', () => {
    writeSkillTtl('这不是 Turtle @@@ 坏文件')
    const insp = inspectSkillOntology(skillDir, { root })
    expect(insp.state).toBe('error')
    expect(insp.checks.find((c) => c.id === 'A1')!.ok).toBe(false)
  })

  // ── J2：链上基础链（**本设计的回归钉**）────────────────────────────────
  it('🔴 J2 正控：正确写 `owl:imports <base.ttl>`（目标真实存在）⇒ A1+A2 全绿、state=ok', () => {
    writeFileSync(join(skillDir, 'base.ttl'), miniTtl(), 'utf-8')
    writeSkillTtl(miniTtl({ imports: 'base.ttl' }))
    const insp = inspectSkillOntology(skillDir, { root })
    expect(insp.checks.map((c) => [c.id, c.ok])).toEqual([['A1', true], ['A2', true]])
    expect(insp.imports).toEqual(['base.ttl'])
    expect(insp.state).toBe('ok')
  })

  it('🔴 J2 负控（**本模块存在的理由**）：写 `sr:imports true` ⇒ **A1 照样全绿**、但 **A2 红** ⇒ state=error', () => {
    writeSkillTtl(
      `@prefix sr: <http://home-serenity/ontology#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix : <http://example.org/onto#> .

<http://home-serenity/ontology/serenity-skills.ttl> sr:imports true .

:onto a owl:Ontology ; sr:name "demo" ; owl:versionInfo "0.1.0" .

:Thing a owl:Class ; rdfs:label "Thing" ; sr:rigidity sr:rigid .
`,
    )
    const insp = inspectSkillOntology(skillDir, { root })
    // 🔴 这一条是本回归钉的**全部价值**：`check` 对它报**全绿**（这就是"检查通过≠链上了"），
    //    只有 A2 能把它抓出来 —— CCC 侧 14 份领域本体正是这个形态。
    expect(insp.checks.find((c) => c.id === 'A1')).toMatchObject({ ok: true })
    expect(insp.checks.find((c) => c.id === 'A2')).toMatchObject({ ok: false })
    expect(insp.checks.find((c) => c.id === 'A2')!.detail).toContain('未声明')
    expect(insp.imports).toEqual([])
    expect(insp.state).toBe('error')
  })

  // ── 第三形态：**探测本身跑不成**时必须说"跑了没成"，不许说成"没声明" ──────
  it('🔴 形态分诊：import 指向**不存在的文件** ⇒ A1 红（引擎 M10）＋ A2 说"探测没跑成"，**不许说成"未声明"**', () => {
    writeSkillTtl(miniTtl({ imports: 'no-such-base.ttl' }))
    const insp = inspectSkillOntology(skillDir, { root })
    const a1 = insp.checks.find((c) => c.id === 'A1')!
    const a2 = insp.checks.find((c) => c.id === 'A2')!
    expect(a1.ok).toBe(false)
    expect(a2.ok).toBe(false)
    // 引擎自己是**响亮**的（实测：check = ERR [M10] ／ explain = exit 2 · ONTO_FILE_NOT_FOUND）
    expect(a2.detail).toContain('探测没跑成')
    expect(a2.detail).not.toContain('未声明')
    expect(insp.state).toBe('error')
  })

  /**
   * 🔴🔴 **2026-11-15 butler 现场报障（我已复现）**：A1 失败时回执只有「引擎 ERR 行见报告」，
   *    而 `check` **不落盘、不回传任何路径** ⇒ "报告"在构造上不存在，操作者被迫再跑一次
   *    `ontology check` 才看得到「第几条公理、什么错」。
   *
   * 判据（同族 = D262 报错要指路）：**指一条不存在的路，比不指更坏**。
   * 这两条用例钉的就是"引擎的 ERR 行必须出现在 A1 的 detail 里"，且**保留 `[M8]`/`[M9]` 编号**
   * （编号是引擎的判据号，是可检索的锚，⛔ 不能被我改写成散文）。
   */
  it('🔴 A1 失败必须**带出引擎的 ERR 行**（中文散文规则 ⇒ M8 tokenization error）', () => {
    writeSkillTtl(miniTtl({
      extra: `
:onto sr:axiom [
    sr:description "中文散文规则" ;
    sr:rule "每一个 物件 都 必须 有 名字"
] .
`,
    }))
    const a1 = inspectSkillOntology(skillDir, { root }).checks.find((c) => c.id === 'A1')!
    expect(a1.ok).toBe(false)
    expect(a1.detail).toContain('ERR [M8]')
    expect(a1.detail).toContain('tokenization error')
    // ⛔ 回执里不该再出现那句"见报告"（它指不到任何东西）
    expect(a1.detail).not.toContain('见报告')
  })

  it('🔴 A1 失败必须带出 ERR 行（引用不存在的类型 ⇒ M9）', () => {
    writeSkillTtl(miniTtl({
      extra: `
:onto sr:axiom [
    sr:description "引用不存在的类型" ;
    sr:rule "forall q in NoSuchType: q.x == 1"
] .
`,
    }))
    const a1 = inspectSkillOntology(skillDir, { root }).checks.find((c) => c.id === 'A1')!
    expect(a1.ok).toBe(false)
    expect(a1.detail).toContain('ERR [M9]')
    expect(a1.detail).toContain('NoSuchType')
  })

  it('extractEngineErrors：只认 `ERR [M<数字>]` 行，且**上限生效**（防烂文件撑爆回执）', () => {
    const out = [
      'Ontology Validation: demo',
      '---',
      '  WRN [M4] Type "X" is rigid but has no identity criteria',
      '  ERR [M8] Axiom #1 tokenization error: Unexpected character: 每',
      '  ERR [M9] Axiom #2 quantifier references unknown type "NoSuchType"',
      'random line mentioning ERR but not the shape',
      '  ERR [M10] Ontology file not found: /x',
    ].join('\n')
    const got = extractEngineErrors(out)
    // WRN 不算 ERR；散文里的 "ERR" 也不算
    expect(got).toEqual([
      'ERR [M8] Axiom #1 tokenization error: Unexpected character: 每',
      'ERR [M9] Axiom #2 quantifier references unknown type "NoSuchType"',
      'ERR [M10] Ontology file not found: /x',
    ])
    expect(extractEngineErrors(out, 1)).toHaveLength(1)
    expect(extractEngineErrors('no errors here')).toEqual([])
  })

  // ── J3：三态**互可分辨** ────────────────────────────────────────────
  it('🔴 J3：三态的渲染文本**两两不同**，且"未建模"那句明说自己不是"通过"', () => {
    const none: SkillOntologyInspection = { state: 'none', rel: '', modeled: false, checks: [], imports: [] }
    writeFileSync(join(skillDir, 'base.ttl'), miniTtl(), 'utf-8')
    writeSkillTtl(miniTtl({ imports: 'base.ttl' }))
    const ok = inspectSkillOntology(skillDir, { root })
    writeSkillTtl(miniTtl({ imports: 'gone.ttl' }))
    const bad = inspectSkillOntology(skillDir, { root })

    const tNone = formatSkillOntologyInspection('demo-skill', none)
    const tOk = formatSkillOntologyInspection('demo-skill', ok)
    const tBad = formatSkillOntologyInspection('demo-skill', bad)

    expect(new Set([tNone, tOk, tBad]).size).toBe(3)
    expect(tNone).toContain('这不是"检查通过"')
    expect(tOk).toContain('已建模且全部通过')
    expect(tBad).toContain('检查没跑成')
    // 三态各自的记号也必须不同（人一眼能分）
    expect(tOk.startsWith('✅')).toBe(true)
    expect(tNone.startsWith('⬜')).toBe(true)
    expect(tBad.startsWith('❌')).toBe(true)
  })
})
