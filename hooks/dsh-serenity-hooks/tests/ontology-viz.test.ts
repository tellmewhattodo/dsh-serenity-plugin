/**
 * ontology-viz.test.ts — `fromEngine` 桥接（viz 搬进 ACC，2026-10-13 S142）
 *
 * 🔴 **本件要钉的正是"搬家为什么值得"**：原 viz 自带的手写解析器有三类错，
 *    每一类在这里都配一条用例。判据 = **探针基线件**（同目录 SESSION 记录的
 *    `2026-10-13T0751-a3f1-viz-parser-baseline.md`：8/16 文件公理数归零、18 处 identity 假阳）。
 *
 *  ① **公理主语两种写法**：引擎两种都收，原 viz 只认具名式（`:ax… a sr:Axiom`）
 *     ⇒ 匿名式（`:onto sr:axiom [ … ]`）的文件**公理数静默归零**。
 *  ② **关系/类描述**：原 viz 与引擎对 `rdfs:label`/`rdfs:comment` 的处置不同。
 *  ③ **公理 id 唯一性**：渲染器拿 `ax:${id}` 当节点键，id 不唯一 ⇒ **所有公理塌成一个节点**。
 *
 * ⚠️ 本件**不测渲染像素** —— 渲染器是从 CCC 逐字搬来的，它的视觉由 owner 验收，
 *    不是单测能替代的（测了也只是把当前实现抄一遍）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fromEngine } from '../src/ontology/viz.js'

const TMP = join(tmpdir(), 'viz-test-' + Date.now())
let file = ''

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  file = join(TMP, 'probe.ttl')
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function write(ttl: string): void {
  writeFileSync(file, ttl, 'utf-8')
}

const HEAD = [
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix sr: <http://home-serenity/ontology#> .',
  '@prefix : <http://example.org/viz#> .',
  '',
  ':onto a owl:Ontology ; sr:name "viz-probe" .',
  ':Thing a owl:Class ; rdfs:label "Thing" .',
  ':Other a owl:Class ; rdfs:label "Other" .',
  ':rel a owl:ObjectProperty ; rdfs:domain :Thing ; rdfs:range :Other .',
  '',
].join('\n')

describe('fromEngine：公理主语两种写法**都要收**（原 viz 只认具名式 ⇒ 8/16 文件归零）', () => {
  it('🔴 匿名式 `:onto sr:axiom [ … ]` ⇒ 公理数**不得为 0**（这正是基线件里的病灶）', () => {
    write(HEAD + '\n:onto sr:axiom [ sr:description "约束一" ; sr:axiomType "state" ] .\n')
    const m = fromEngine(file, file)
    expect(m.axioms.length, '匿名式公理必须被收').toBe(1)
    // 正文回落：匿名式只有 `sr:description`（没有 `sr:axiomRule`）⇒ 必须兜到它
    expect(m.axioms[0]!.rule).toBe('约束一')
    expect(m.axioms[0]!.type).toBe('state')
  })

  it('具名式 `:ax a sr:Axiom` 同样收（两种写法并存是容器的实测事实）', () => {
    write(
      HEAD +
        '\n:ax-one a sr:Axiom ; sr:axiomRule "forall t in Thing: t.ok == true" ; sr:axiomType "constraint" .\n',
    )
    const m = fromEngine(file, file)
    expect(m.axioms.length).toBe(1)
    expect(m.axioms[0]!.rule).toContain('forall t in Thing')
  })

  it('🔴 两种写法**混在同一文件** ⇒ 都要在（原 viz 会只认其中一种）', () => {
    write(
      HEAD +
        '\n:onto sr:axiom [ sr:description "匿名那条" ] .\n' +
        ':ax-two a sr:Axiom ; sr:axiomRule "具名那条" ; sr:axiomType "state" .\n',
    )
    const m = fromEngine(file, file)
    expect(m.axioms.length, '两种写法混排必须都收').toBe(2)
  })

  it('🔴 公理 id **逐条唯一**（渲染器拿 `ax:${id}` 当节点键；不唯一 ⇒ 全塌成一个方块）', () => {
    write(
      HEAD +
        '\n:onto sr:axiom [ sr:description "a" ] .\n' +
        ':onto sr:axiom [ sr:description "b" ] .\n' +
        ':onto sr:axiom [ sr:description "c" ] .\n',
    )
    const m = fromEngine(file, file)
    const ids = m.axioms.map((a) => a.id)
    expect(ids.length).toBe(3)
    expect(new Set(ids).size, `公理 id 有重复：${ids.join(', ')}`).toBe(3)
  })
})

describe('fromEngine：类／关系／实例的桥接', () => {
  it('类带上 label 与 comment（引擎 v1.56.2 起两者分开）', () => {
    write(HEAD.replace(':Thing a owl:Class ; rdfs:label "Thing" .', ':Thing a owl:Class ; rdfs:label "短标签" ; rdfs:comment "长注释" .'))
    const m = fromEngine(file, file)
    const t = m.classes.find((c) => c.id === 'Thing')!
    expect(t.label, '图上的节点名取 label').toBe('短标签')
    expect(t.comment, '侧栏详情取 comment').toBe('长注释')
  })

  it('🔴 刚性两种写法都归一（**这是 v1.56.3 发出去的那个崩溃**，必须钉死）', () => {
    // 实测：容器里两种写法并存 ——
    //   `sr:rigidity "rigid"`  （字面量；ccc-ontology.ttl 等基础链全用这种）
    //   `sr:rigidity sr:rigid` （带前缀的项；home-mail / home-gpu 等领域本体用这种）
    // 引擎按原文存 ⇒ 后者带 `sr:`。不归一 ⇒ 渲染器的颜色表查不到 ⇒ **渲染当场抛
    // `Cannot read properties of undefined (reading 'class')`**（v1.56.3 的实况）。
    write(
      HEAD.replace(
        ':Thing a owl:Class ; rdfs:label "Thing" .',
        ':Thing a owl:Class ; rdfs:label "Thing" ; sr:rigidity sr:rigid .',
      ).concat(':Lit a owl:Class ; rdfs:label "Lit" ; sr:rigidity "anti-rigid" .\n'),
    )
    const m = fromEngine(file, file)
    expect(m.classes.find((c) => c.id === 'Thing')!.rigidity, '带前缀项要归一成裸值').toBe('rigid')
    expect(m.classes.find((c) => c.id === 'Lit')!.rigidity, '字面量形态照旧').toBe('anti-rigid')
  })

  it('🔴 未知/异常的刚性值归 null（**不得**留下会让查表炸掉的值）', () => {
    write(HEAD.replace(':Thing a owl:Class ; rdfs:label "Thing" .', ':Thing a owl:Class ; rdfs:label "Thing" ; sr:rigidity "weird-value" .'))
    const m = fromEngine(file, file)
    expect(m.classes.find((c) => c.id === 'Thing')!.rigidity).toBeNull()
  })

  it('关系带上 domain/range', () => {
    write(HEAD)
    const m = fromEngine(file, file)
    const r = m.relations.find((x) => x.id === 'rel')!
    expect(r.domain).toBe('Thing')
    expect(r.range).toBe('Other')
  })

  it('实例进模型，且 `a` 指向未声明的类**不算个体**（负控）', () => {
    write(HEAD + '\n:i1 a :Thing ; rdfs:label "实例一" .\n:i2 a :NotDeclared ; rdfs:label "不该来" .\n')
    const m = fromEngine(file, file)
    const ids = m.instances.map((i) => i.id)
    expect(ids).toContain('i1')
    expect(ids, '未声明的类不得当个体').not.toContain('i2')
  })

  it('公理 → 它提到的类（`mentions`）：**裸名**可认，**带前缀的 `:Local` 认不出**（登记为已知缺口）', () => {
    // 🔴 本用例首版写"两种写法都要认"，**那是错的**（我自己搞错了事实，当场改）：
    //    渲染器的 `mentions` 判据是把**类 id 的裸名**拿去正则匹配规则文本，
    //    而本桥接给 `class.id` 的是**无前缀**形式（`Thing`）⇒ 规则里写 `:Other` 时
    //    **匹配不到**（规则文本里的 `:Other` 与裸名 `Other` 不同形）。
    //    ⇒ 实测事实：**裸名（home-rhetoric 那种）能认，带前缀的认不出** —— 一律记在这里。
    //    （原 viz 靠 `shortName` 把类 id 连前缀一起留（`sr:Skill`），所以两边各认一半。）
    write(HEAD + '\n:onto sr:axiom [ sr:description "裸名" ; sr:rule "forall t in Thing: t.ok == true" ] .\n')
    const naked = fromEngine(file, file)
    expect(naked.axioms[0]!.mentions, '裸名 `Thing` 必须认出来').toContain('Thing')

    write(HEAD + '\n:onto sr:axiom [ sr:description "带前缀" ; sr:rule "forall t in :Other: t.ok == true" ] .\n')
    const prefixed = fromEngine(file, file)
    // ⚠️ 已知缺口，**不是**本桥接能修的（属渲染器判据）⇒ 断言如实钉住现状
    expect(prefixed.axioms[0]!.mentions, '带前缀形态当前认不出（已知缺口，见上）').toEqual([])
  })
})
