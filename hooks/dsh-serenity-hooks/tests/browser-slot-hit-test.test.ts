/*
 * browser-slot-hit-test.test.ts —— 「这一下会点到谁」的判定（`hit-test.ts`，B 项）。
 *
 * 🔴 这条要防的是**最贵的一种静默失效**：CDP 对「点在视口外」「点在被盖住的元素上」**一行都不报**，
 *    回执照样写着 `clicked @x,y` —— 于是"点了没点到"与"点到了"在读数上完全一样。
 *
 * ⚠️ 本文件只测**纯判定**（取数在 cdp.ts、需要真 Chrome）。取数那一段的判据在真机验收里做：
 *    测试替身造不出"合成器命中了另一个元素"这件事（同族：**测过 ≠ 验过**，D141）。
 */

import { describe, expect, it } from 'vitest'
import { judgeHit, renderHit, type HitProbe } from '../src/browser/hit-test.js'

const VP = { w: 1600, h: 1000 }
const node = (id: number, name = 'button', domId = '') => ({ backendNodeId: id, nodeName: name, ...(domId ? { id: domId } : {}) })

describe('judgeHit：视口外必须先判（否则空读数会被读成"留白"）', () => {
  it('H1 坐标越界 ⇒ offscreen（哪怕那里真的有节点）', () => {
    const probe: HitProbe = { inViewport: false, viewport: VP, node: node(7) }
    expect(judgeHit(probe).kind).toBe('offscreen')
  })

  it('H2 offscreen 的回执必须给出去路（先 scroll），⛔ 不说"试试看"', () => {
    const s = renderHit(judgeHit({ inViewport: false, viewport: { w: 800, h: 600 } }))
    expect(s).toContain('800')
    expect(s).toContain('scroll')
  })

  it('H3 视口量不出来（w/h 缺）也按 offscreen 处理 —— 保守方向是"先别点"', () => {
    expect(judgeHit({ inViewport: false }).kind).toBe('offscreen')
  })
})

describe('judgeHit：三种"其实没点到目标"的形态各自说得清', () => {
  it('H4 那里没有节点 ⇒ blank', () => {
    expect(judgeHit({ inViewport: true, viewport: VP }).kind).toBe('blank')
    expect(judgeHit({ inViewport: true, viewport: VP, node: node(0) }).kind).toBe('blank')
  })

  it('H5 命中别的元素 ⇒ blocked，且说清是谁（tag + id）', () => {
    const v = judgeHit({ inViewport: true, viewport: VP, node: node(42, 'div', 'mask') }, { backendNodeId: 7 })
    expect(v.kind).toBe('blocked')
    if (v.kind === 'blocked') {
      const s = renderHit(v)
      expect(s).toContain('div')
      expect(s).toContain('mask')
      expect(s).toContain('42')
    }
  })

  it('H6 命中期望的元素 ⇒ ok（**按 backendNodeId 比身份**，⛔ 不比 tag/文字）', () => {
    const v = judgeHit({ inViewport: true, viewport: VP, node: node(7, 'button') }, { backendNodeId: 7 })
    expect(v.kind).toBe('ok')
    // 同名不同 id ⇒ 仍然是 blocked（这正是"点到了旁边的那个按钮"那个事故形态）
    expect(judgeHit({ inViewport: true, viewport: VP, node: node(8, 'button') }, { backendNodeId: 7 }).kind).toBe('blocked')
  })

  it('H7 没给 expect ⇒ 永不 blocked（调用方没说要打谁，就没有"打错了"这回事）', () => {
    expect(judgeHit({ inViewport: true, viewport: VP, node: node(999) }).kind).toBe('ok')
  })

  it('H8 blank 的回执要指出两个可能（留白 / 坐标算错），⛔ 不说"点击成功"', () => {
    const s = renderHit(judgeHit({ inViewport: true, viewport: VP }))
    expect(s).toContain('没有元素')
    expect(s).not.toContain('成功')
  })
})
