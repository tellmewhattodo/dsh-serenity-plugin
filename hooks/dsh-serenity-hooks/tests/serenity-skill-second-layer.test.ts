/**
 * serenity-skill-second-layer.test.ts — **P1b：三个消费点同源**（设计 §6 判据 J7 ＋ J4/J9）
 *
 * 为什么单独一件（EAP S↑）：三条注入通路（入口段 order −50 ／ 轨迹段 order −45 ／ 目录 provider
 * 的 `provider.get()`）**彼此独立实现**，任何一条漏接线，"两层披露树"就只在部分路径上成立 ——
 * 而那种漏**不会有任何失败信号**。本件把三条通路各钉一次，并断言三处拿到的是**同一份**索引文本。
 *
 * 判据与理由：设计 `docs/serenity-skill-design.md` §4.2（六条硬性规则）／§6（J4、J7、J9）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { entrySkillSectionText } from '../src/seams/system-prompt.js'
import { buildCognitiveTrajectorySkillsSection } from '../src/trajectory/skills.js'
import { registerOpencodeSkills } from '../src/seams/opencode-skills.js'
import { buildResourceIndex } from '../src/skills/resource-index.js'

/** 参考文件正文哨兵：索引里**绝不允许**出现它（判据 J4） */
const BODY_SENTINEL = 'REFERENCE-BODY-MUST-NOT-LEAK-9c1f'

/** 索引块的标题行（三处都应含它；普通 skill 应全无） */
const INDEX_HEADING = '### Reference files for this skill (second layer — read on demand)'

let root: string

/** 设置该 CCC 的入口 skill 名（`.serenity` 记号文件 = 最高优先来源） */
function setEntry(name: string): void {
  writeFileSync(join(root, '.serenity'), name)
}

/** 造一个 skill（可选带 references/ 与固定名本体） */
function mkSkill(name: string, opts: { refs?: string[]; ontology?: boolean } = {}): string {
  const dir = join(root, '.opencode', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n# ${name} 正文\n`)
  if (opts.refs) {
    mkdirSync(join(dir, 'references'), { recursive: true })
    for (const f of opts.refs) {
      writeFileSync(join(dir, 'references', f), `# ${f} 标题\n\n${BODY_SENTINEL}\n`)
    }
  }
  if (opts.ontology) writeFileSync(join(dir, 'skill.ttl'), '@prefix sr: <x> .\n')
  return dir
}

/** 造一个可被轨迹段读取的 SESSION.md（无 frontmatter ⇒ 声明只来自 cccSkills 参数） */
function mkSessionMd(name: string): string {
  const p = join(root, 'AGENT_SESSIONS', name, 'SESSION.md')
  mkdirSync(join(root, 'AGENT_SESSIONS', name), { recursive: true })
  writeFileSync(p, '# SESSION\n（无 frontmatter —— 声明由 cccSkills 参数给出）\n')
  return p
}

/** 假的 ctx：捕获 provider 工厂，供通路 C 使用 */
function captureProvider(): () => { list: (o: { cwd?: string }) => Promise<{ candidates: unknown[] }>; get: (c: unknown) => Promise<unknown> } {
  let captured: unknown = null
  registerOpencodeSkills({
    skills: { registerProvider: (fn: () => unknown) => { captured = fn() } },
  } as never)
  return captured as ReturnType<typeof captureProvider>
}

/** 取出一段文本里的索引块（自标题行起到文末） */
function indexBlock(text: string): string {
  const at = text.indexOf(INDEX_HEADING)
  return at < 0 ? '' : text.slice(at)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ss-layer2-'))
  setEntry('entry-skill')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P1b · 三个消费点都带第二层（J7）', () => {
  it('通路 A（入口段 order −50）：含参考件清单 ＋ 🧬 ＋ 不含正文', () => {
    setEntry('entry-skill')
    mkSkill('entry-skill', { refs: ['00-a.md', '20-b.md'], ontology: true })
    const text = entrySkillSectionText(root)
    expect(text).toContain('# entry-skill 正文') // 第一层（SKILL.md 全文）照旧
    expect(text).toContain(INDEX_HEADING)
    expect(text).toContain('references/00-a.md')
    expect(text).toContain('references/20-b.md')
    expect(text).toContain('🧬')
    expect(text).toContain('This skill is modeled')
    // 🔴 J4：参考件**正文一个字都不许漏进注入**
    expect(text).not.toContain(BODY_SENTINEL)
  })

  it('通路 B（轨迹段 order −45）：含参考件清单，且不含正文', () => {
    mkSkill('declared-skill', { refs: ['10-x.md'] })
    const text = buildCognitiveTrajectorySkillsSection(root, mkSessionMd('s1'), undefined, ['declared-skill'])
    expect(text).toContain('=== skill: declared-skill ===')
    expect(text).toContain(INDEX_HEADING)
    expect(text).toContain('references/10-x.md')
    expect(text).not.toContain(BODY_SENTINEL)
  })

  it('通路 C（目录 provider 的 get()）：`skill` 工具路径也含参考件清单，且不含正文', async () => {
    mkSkill('prov-skill', { refs: ['30-z.md'] })
    const provider = captureProvider()
    const cand = ((await provider.list({ cwd: root })).candidates as { name: string }[]).find((c) => c.name === 'prov-skill')
    expect(cand).toBeDefined()
    const def = (await provider.get(cand)) as { content: string }
    expect(def.content).toContain(INDEX_HEADING)
    expect(def.content).toContain('references/30-z.md')
    expect(def.content).not.toContain(BODY_SENTINEL)
  })

  it('🔴 同源证据：三条通路对**同一个 skill** 给出**逐字相同**的索引块', async () => {
    setEntry('shared-skill')
    const dir = mkSkill('shared-skill', { refs: ['00-a.md', '50-c.md'], ontology: true })

    const a = indexBlock(entrySkillSectionText(root))
    const b = indexBlock(
      buildCognitiveTrajectorySkillsSection(root, mkSessionMd('s2'), undefined, ['shared-skill']),
    )
    const provider = captureProvider()
    const cand = ((await provider.list({ cwd: root })).candidates as { name: string }[]).find((c) => c.name === 'shared-skill')
    const c = indexBlock(((await provider.get(cand)) as { content: string }).content)

    expect(a).not.toBe('')
    expect(a).toBe(b) // 入口段 ＝ 轨迹段
    expect(b).toBe(c) // 轨迹段 ＝ 目录 provider
    expect(a).toBe(buildResourceIndex(dir)) // 三处都 ＝ 生成器直接产出（一个来源，不是各写一遍）
  })

  it('🔴 J9：**普通 skill**（无 references/ 且无 skill.ttl）⇒ 不产出该块、零告警（增强向后兼容）', async () => {
    setEntry('plain-entry')
    const dir = mkSkill('plain-entry')
    expect(buildResourceIndex(dir)).toBe('')
    // A：入口段照常注入 SKILL.md 全文，只是**没有**索引块
    const a = entrySkillSectionText(root)
    expect(a).toContain('# plain-entry 正文')
    expect(a).not.toContain(INDEX_HEADING)
    // B：轨迹段同样
    const b = buildCognitiveTrajectorySkillsSection(root, mkSessionMd('s3'), undefined, ['plain-entry'])
    expect(b).toContain('# plain-entry 正文')
    expect(b).not.toContain(INDEX_HEADING)
    // C：provider 同样
    const provider = captureProvider()
    const cand = ((await provider.list({ cwd: root })).candidates as { name: string }[]).find((c) => c.name === 'plain-entry')
    const def = (await provider.get(cand)) as { content: string }
    expect(def.content).toContain('# plain-entry 正文')
    expect(def.content).not.toContain(INDEX_HEADING)
  })

  it('🔴 第四处落点 = 目录面（O2）：`list()` 的 description 带参考件**名字**；普通 skill 一字不改', async () => {
    mkSkill('cat-skill', { refs: ['00-a.md', '10-b.md'], ontology: true })
    mkSkill('cat-plain')
    const provider = captureProvider()
    const cands = (await provider.list({ cwd: root })).candidates as { name: string; description: string }[]

    const cat = cands.find((c) => c.name === 'cat-skill')
    expect(cat).toBeDefined()
    // 正控：名字在（**只有名字** —— 目录面不重复载入面那份"名字 ＋ 首标题 ＋ 字节"的索引）
    expect(cat?.description).toContain('00-a.md')
    expect(cat?.description).toContain('10-b.md')
    expect(cat?.description).toContain('skill.ttl')
    expect(cat?.description).toContain('参考件')
    // 负控：索引块的形态**一个都不许**漏进目录面；正文更不许
    expect(cat?.description).not.toContain(INDEX_HEADING)
    expect(cat?.description).not.toContain(BODY_SENTINEL)
    // J9：普通 skill（无 references/ 且无 skill.ttl）的 description **逐字不变**（零噪声）
    expect(cands.find((c) => c.name === 'cat-plain')?.description).toBe('cat-plain 的说明')
  })
})
