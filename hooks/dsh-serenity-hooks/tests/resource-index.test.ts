/**
 * resource-index.test.ts — serenity-skill **第二层披露树**的判据（设计 §6 J4/J5/J6 ＋ 裁决 Q6）
 *
 * 判据取自 `docs/serenity-skill-design.md`；每条都配**正控 ＋ 负控**（"检查没跑＝检查通过"是本仓
 * 两天内撞见四次的族，故这里的否定性断言一律自带对照）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildResourceIndex,
  firstHeading,
  hasSkillOntology,
  SKILL_ONTOLOGY_FILE,
  REFERENCE_DIR,
} from '../src/skills/resource-index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'res-idx-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个参考件 */
function ref(name: string, body: string): void {
  mkdirSync(join(dir, REFERENCE_DIR), { recursive: true })
  writeFileSync(join(dir, REFERENCE_DIR, name), body)
}

describe('两层披露树 · 第二层索引', () => {
  // ── 规则⑥（一般化）：无可列项 ⇒ 整块不产出 ────────────────────────────────
  it('无 references/ 且无 skill.ttl ⇒ 空串（不产出空标题噪声）', () => {
    expect(buildResourceIndex(dir)).toBe('')
  })

  it('只有 skill.ttl（无 references/）⇒ 仍产出，且只有本体那一行', () => {
    writeFileSync(join(dir, SKILL_ONTOLOGY_FILE), '@prefix sr: <x> .\n')
    const out = buildResourceIndex(dir)
    expect(out).not.toBe('')
    expect(out).toContain(SKILL_ONTOLOGY_FILE)
    expect(out).not.toContain(REFERENCE_DIR + '/')
  })

  // ── 规则①：只枚举，**不注入正文**（J4）──────────────────────────────────
  it('🔴 规则①：索引含文件名，但**绝不含**参考文件的正文（J4）', () => {
    const SECRET = 'REFERENCE-BODY-SENTINEL-7f3a'
    ref('00-alpha.md', `# Alpha 标题\n\n${SECRET}\n`)
    const out = buildResourceIndex(dir)
    // 正控：文件名在
    expect(out).toContain('references/00-alpha.md')
    // 负控：正文不在
    expect(out).not.toContain(SECRET)
  })

  // ── 规则④：摘要 = 首个 `#` 标题；取不到留空不编 ──────────────────────────
  it('规则④：摘要取首个 `#` 标题（剥记号）；无标题 ⇒ 留空', () => {
    ref('a.md', '# 丘吉尔方法：主轴\n正文\n')
    ref('b.md', '没有标题的正文\n')
    const out = buildResourceIndex(dir)
    expect(out).toContain('| references/a.md | 丘吉尔方法：主轴 |')
    expect(out).toContain('| references/b.md |  |')
  })

  it('规则④：跳过 frontmatter（否则题名行会被误当标题）', () => {
    ref('c.md', '---\nname: x\n---\n\n# 真正的标题\n')
    expect(firstHeading(join(dir, REFERENCE_DIR, 'c.md'))).toBe('真正的标题')
  })

  it('规则④：超长标题截断并留省略号（截断要看得见）', () => {
    ref('d.md', `# ${'长'.repeat(200)}\n`)
    const h = firstHeading(join(dir, REFERENCE_DIR, 'd.md'))
    expect(h.endsWith('…')).toBe(true)
    expect(h.length).toBeLessThanOrEqual(60)
  })

  it('非 .md 文件：只给名，不给摘要（不读它）', () => {
    mkdirSync(join(dir, REFERENCE_DIR), { recursive: true })
    writeFileSync(join(dir, REFERENCE_DIR, 'data.json'), '{"#": "不是标题"}')
    const out = buildResourceIndex(dir)
    expect(out).toContain('| references/data.json |  |')
  })

  // ── 规则⑤：固定名本体 ⇒ 🧬 ＋ "已建模" ─────────────────────────────────
  it('规则⑤：skill.ttl 存在 ⇒ 标 🧬 ＋ 顶部"已建模"句（正控／负控成对）', () => {
    ref('a.md', '# A\n')
    const withoutOnto = buildResourceIndex(dir)
    expect(withoutOnto).not.toContain('🧬')
    expect(withoutOnto).not.toContain('This skill is modeled')

    writeFileSync(join(dir, SKILL_ONTOLOGY_FILE), '@prefix sr: <x> .\n')
    expect(hasSkillOntology(dir)).toBe(true)
    const withOnto = buildResourceIndex(dir)
    expect(withOnto).toContain('This skill is modeled')
    expect(withOnto).toContain("🧬 This skill's ontology constraints")
  })

  // ── 裁决 Q6：旧名 ttl 当**普通参考件**（不特殊对待、不告警）──────────────
  it('🔴 裁决 Q6：`references/*-domain.ttl` 是普通参考件 —— 不标 🧬、不触发"已建模"', () => {
    ref('home-x-domain.ttl', '@prefix sr: <x> .\n')
    const out = buildResourceIndex(dir)
    expect(out).toContain('references/home-x-domain.ttl')
    expect(out).not.toContain('🧬')
    expect(out).not.toContain('This skill is modeled')
    // 固定名才是本体：**只有 skill.ttl 命中**
    expect(hasSkillOntology(dir)).toBe(false)
  })

  // ── 规则②：字节序排序 ＋ 确定性（J5）────────────────────────────────────
  it('规则②：按相对路径**字节序**排序（乱序写入亦然）', () => {
    ref('30-c.md', '# C\n')
    ref('00-a.md', '# A\n')
    ref('20-b.md', '# B\n')
    const rows = buildResourceIndex(dir)
      .split('\n')
      .filter((l) => l.startsWith('| references/'))
      .map((l) => l.split('|')[1]!.trim())
    expect(rows).toEqual(['references/00-a.md', 'references/20-b.md', 'references/30-c.md'])
  })

  it('🔴 规则②：同目录跑两次逐字相同（J5 正控）', () => {
    ref('00-a.md', '# A\n')
    writeFileSync(join(dir, SKILL_ONTOLOGY_FILE), 'x')
    expect(buildResourceIndex(dir)).toBe(buildResourceIndex(dir))
  })

  it('🔴 规则②：改 mtime **不改变**输出（J5 负控 —— 这条把"别用 mtime"钉住）', () => {
    // 🔴 用**三个**文件：单文件时"按 mtime 排序"与"按路径排序"产出相同 ⇒ 那个断言是**瞎的**
    //    （"读数器本身要先证明不瞎"）。三个文件才让两种排序**可分**：把**字节序第一**的文件
    //    改成**最新** —— 若实现用 mtime 排序，它会被挪到最后，输出必变。
    ref('00-a.md', '# A\n')
    ref('20-b.md', '# B\n')
    ref('30-c.md', '# C\n')
    const before = buildResourceIndex(dir)
    expect(before.indexOf('references/00-a.md')).toBeLessThan(before.indexOf('references/30-c.md'))

    const f = join(dir, REFERENCE_DIR, '00-a.md')
    const old = statSync(f).mtime
    utimesSync(f, old, new Date(old.getTime() + 86_400_000))

    const after = buildResourceIndex(dir)
    expect(after).toBe(before)
    // 且顺序仍是路径序（新 mtime **没有**把它挪走）
    expect(after.indexOf('references/00-a.md')).toBeLessThan(after.indexOf('references/30-c.md'))
  })

  // ── 规则③：有界 ＋ **响亮**（J6）────────────────────────────────────────
  it('🔴 规则③：超条数上限 ⇒ **响亮**写出还剩多少项（J6 正控）', () => {
    for (let i = 0; i < 5; i++) ref(`${i}0-f.md`, `# F${i}\n`)
    const out = buildResourceIndex(dir, { maxItems: 2 })
    expect(out).toContain('**3 more item(s) not listed**')
  })

  it('🔴 规则③：未超限 ⇒ **不得**出现"未列出"那句（J6 负控 —— 否则"响亮"退化成噪声）', () => {
    ref('00-a.md', '# A\n')
    expect(buildResourceIndex(dir)).not.toContain('未列出')
  })

  it('规则③：超字符上限 ⇒ 截断可见（含"已按 … 上限截断"）', () => {
    for (let i = 0; i < 20; i++) ref(`${i}0-f.md`, `# 标题${i}\n`)
    const out = buildResourceIndex(dir, { maxChars: 300 })
    expect(out).toContain('second-layer index truncated at the')
  })

  // ── 规则⑥：子目录**给名字＋计数，但不展开**（真实输入逼出的修订）──────────
  it('规则⑥：子目录列一行（名字 ＋ 文件数），**不展开其内容**', () => {
    mkdirSync(join(dir, REFERENCE_DIR, 'sub'), { recursive: true })
    writeFileSync(join(dir, REFERENCE_DIR, 'sub', 'inner-one.md'), '# 内层一\n')
    writeFileSync(join(dir, REFERENCE_DIR, 'sub', 'inner-two.md'), '# 内层二\n')
    ref('00-a.md', '# A\n')
    const out = buildResourceIndex(dir)
    // 正控：子目录被列出来（**可行动** —— 模型据此可去 read 里面）
    expect(out).toContain('| references/sub/ | subdirectory · 2 file(s) |')
    expect(out).toContain('references/00-a.md')
    // 负控：内层文件**不**被展开（本层仍不是递归列表）
    expect(out).not.toContain('inner-one.md')
    expect(out).not.toContain('inner-two.md')
  })

  it('规则⑥：子目录的字节数 = 其下文件总和（仍不读内容）', () => {
    mkdirSync(join(dir, REFERENCE_DIR, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(dir, REFERENCE_DIR, 'sub', 'deeper', 'x.md'), 'x'.repeat(1000))
    const out = buildResourceIndex(dir)
    expect(out).toContain('| references/sub/ | subdirectory · 1 file(s) | 1,000 |')
  })

  // ── 字节列的千分位**不依赖 locale** ─────────────────────────────────────
  it('字节列用千分位分组，且**不依赖 locale**（同一目录跨机器产出相同文本）', () => {
    ref('big.md', 'x'.repeat(12345))
    expect(buildResourceIndex(dir)).toContain('| 12,345 |')
  })
})
