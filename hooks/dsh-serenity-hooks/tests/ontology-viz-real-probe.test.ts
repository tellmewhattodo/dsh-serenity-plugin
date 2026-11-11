/**
 * 一次性探针（S142，2026-10-13）：验证 viz 桥接在**真文件**上不再抛
 * `Cannot read properties of undefined (reading 'class')`（v1.56.3 的实况崩溃）。
 *
 * 这是**手工探针**，不是常驻测试（常驻测试在 ontology-viz.test.ts）。
 * 用法：msm("dsh-develop", ["test", "--filter", "viz-real-file-probe"])
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fromEngine, layout, toSvg, toHtml } from '../src/ontology/viz.js'

function findCccRoot(start: string): string | undefined {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.opencode', 'skills'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const ROOT = findCccRoot(__dirname)
const HAS = ROOT !== undefined && existsSync(join(ROOT, '.opencode', 'skills', 'home-mail', 'skill.ttl'))

describe.skipIf(!HAS)('viz 真文件探针（v1.56.3 崩溃回归）', () => {
  // 领域本体（`sr:rigidity sr:rigid` 带前缀项形态）—— 这正是崩溃的触发形态
  // ⚠️ 2026-11-12：`home-browser` 已归档（.opencode 下不存在了）⇒ 换成同在册、同形态的 `home-esp32`。
  //    判据：这条探针要的是「领域本体 + 带前缀 rigidity」这个**形态**，不是那个具体 skill。
  for (const rel of [
    '.opencode/skills/home-mail/skill.ttl',
    '.opencode/skills/home-esp32/skill.ttl',
    '.opencode/skills/home-gpu/skill.ttl',
    '.opencode/skills/dsh-serenity-plugin-development/skill.ttl',
    // 基础链（`sr:rigidity "rigid"` 字面量形态）—— 对照
    '.opencode/skills/home-serenity/references/ccc-ontology.ttl',
    '.opencode/skills/home-serenity/references/serenity-skills-ontology.ttl',
  ]) {
    it(`🔴 ${rel} ⇒ 真能画出 svg/html（不抛）`, () => {
      const abs = join(ROOT!, rel)
      expect(existsSync(abs), `夹具不在：${abs}`).toBe(true)
      const m = fromEngine(rel, abs)
      // ① 渲染绝不抛（这就是崩溃的判据）
      const L = layout(m, { axioms: false, instances: true, imports: true })
      const svg = toSvg(m, L, { axioms: false })
      const html = toHtml(m, L, svg)
      expect(svg).toContain('<svg')
      expect(html).toContain('<svg')
      // ② 每个类都必须拿到**可查表**的刚性值（null 是合法的"未声明"，但绝不许是垃圾串）
      for (const c of m.classes) {
        expect(
          c.rigidity === null || ['rigid', 'anti-rigid', 'semi-rigid'].includes(c.rigidity),
          `${rel} 的 ${c.id} 刚性值异常：${String(c.rigidity)}`,
        ).toBe(true)
      }
    })
  }
})
