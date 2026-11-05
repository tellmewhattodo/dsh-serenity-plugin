/**
 * humor.test.ts — 脱口秀片段注入（D287）的判据
 *
 * ## 这份测试钉的是什么
 *
 * owner 的原话是「这个不会改变什么行为，但是会让过程变得有趣」。⇒ 它必须是**无害**的：
 * 关闭时**一个字节都不许多**、开启时**不改变任何判据路径**。
 * 装饰品偷偷改变提示词，是这里最贵的失效形态（没人会去看）。
 *
 * 🔴 三条判据分别对应三种"会静默出错"的方式：
 * ① **关闭 ⇒ 空串**（不是"差不多"，是逐字节没有）
 * ② **同种子 ⇒ 同段**（否则会话进行中会变，owner 明确不要）
 * ③ **池空/未启用 ⇒ 空串**（面板显示"已启用"但池是空的，不该注入半个块）
 */
import { describe, it, expect } from 'vitest'
import { humorBlock, pickHumor } from '../src/seams/humor.js'

const POOL = ['第一段：铺垫。转折。', '第二段：又是铺垫。又是转折。', '第三段：短。']

describe('humorBlock：装饰品不许偷偷改变提示词', () => {
  it('🔴 ① 关闭 ⇒ 返回空串（逐字节没有，不是"差不多"）', () => {
    expect(humorBlock('session-x', POOL, false)).toBe('')
  })

  it('🔴 ② 池空 ⇒ 返回空串（即便 enabled=true —— 面板可能显示"已启用"但还没填）', () => {
    expect(humorBlock('session-x', [], true)).toBe('')
  })

  it('开启且池非空 ⇒ 一个完整块，含 owner 指定的诚恳开场', () => {
    const b = humorBlock('session-x', POOL, true)
    expect(b).toContain('先来看看这段脱口秀片段再继续阅读吧')
    // 标记头（与 persona/EAP 同构，便于从装配结果里确认它是否在）
    expect(b).toContain('=== Serenity Humor ===')
    // 🔴 必须自述"不影响判断" —— 否则可能被读成行为约束
    expect(b).toContain('不影响任何判断')
  })

  it('注入的必须是**完整一段**（不截断、不拼接）', () => {
    const b = humorBlock('session-x', POOL, true)
    const hit = POOL.filter((p) => b.includes(p))
    expect(hit.length, '必须恰好完整包含一段').toBe(1)
  })
})

describe('pickHumor：同会话稳定（owner：「会话进行中不变动」）', () => {
  it('🔴 同种子 ⇒ 永远同一段（纯函数，可重放）', () => {
    const a = pickHumor('session-abc', POOL)
    for (let i = 0; i < 50; i++) {
      expect(pickHumor('session-abc', POOL)).toBe(a)
    }
  })

  it('不同种子能取到不同段（否则"随机"名不副实）', () => {
    const seen = new Set<string | null>()
    for (let i = 0; i < 200; i++) seen.add(pickHumor(`session-${i}`, POOL))
    expect(seen.size, '200 个会话应当覆盖到池里全部段').toBe(POOL.length)
  })

  it('分布不退化到单一值（粗检：每段至少被选中一次）', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 600; i++) {
      const p = pickHumor(`s-${i}`, POOL)
      if (p !== null) counts.set(p, (counts.get(p) ?? 0) + 1)
    }
    expect(counts.size).toBe(POOL.length)
    for (const [, c] of counts) expect(c).toBeGreaterThan(0)
  })

  it('空池 ⇒ null（不抛错）', () => {
    expect(pickHumor('x', [])).toBeNull()
  })

  it('单段池 ⇒ 永远那一段（边界）', () => {
    expect(pickHumor('anything', ['唯一的一段'])).toBe('唯一的一段')
  })
})
