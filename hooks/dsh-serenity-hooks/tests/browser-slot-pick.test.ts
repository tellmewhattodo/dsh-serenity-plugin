/**
 * browser-slot-pick.test.ts — 「选谁」的**纯判定**（选 tab ／ 选可点元素）。
 *
 * 🔴 为什么这两条判定必须单测、且必须钉「拒绝」而不是「选得对」：
 *    · 选错 **tab** ⇒ 产出一张**看起来对、内容却属于别人**的图（零报错）。
 *    · 点错**元素** ⇒ **已经发生的事**，不会自己撤销；而"点了没反应"与"没点"
 *      在下一次读数里**长得一样** —— 那正是最难查的一种错。
 *
 * ⇒ 每条判据的靶心都是「**不猜**」，而不是「猜得准」。
 */

import { describe, expect, it } from 'vitest'
import { pickTarget, renderHits, type PickableTarget } from '../src/browser/target-pick.js'
import { pickClickable, renderClickables, type Clickable } from '../src/browser/click-target.js'

function t(id: string, type: string, title: string, url: string): PickableTarget {
  return { id, type, title, url }
}

function el(over: Partial<Clickable> = {}): Clickable {
  return {
    tag: 'button',
    type: '',
    text: '登录',
    role: '',
    x: 10,
    y: 20,
    w: 80,
    h: 30,
    disabled: false,
    pointerNone: false,
    download: false,
    ...over,
  }
}

// ══════════════════════════════════════════════════════════════════
// ① 选 tab
// ══════════════════════════════════════════════════════════════════
describe('pickTarget: 选 tab', () => {
  const pages = [
    t('A', 'page', 'Example Domain', 'https://example.com/'),
    t('B', 'page', 'Dashboard - Acme', 'https://app.acme.test/dashboard'),
    t('C', 'iframe', 'ad frame', 'https://ads.example/'),
  ]

  it('id 直通，且⛔ 不参与子串匹配', () => {
    const r = pickTarget(pages, { id: 'B' })
    expect(r.ok && r.target.id).toBe('B')
    // 打错的 id ⛔ 不许回落到"恰好相符的另一个页面"
    const bad = pickTarget(pages, { id: 'acme' })
    expect(bad).toEqual({ ok: false, reason: 'not-found', hits: [] })
  })

  it('URL 子串命中唯一 ⇒ 选中', () => {
    const r = pickTarget(pages, { match: 'acme' })
    expect(r.ok && r.target.id).toBe('B')
    expect(r.ok && r.by).toBe('match')
  })

  it('标题子串也算（大小写不敏感）', () => {
    const r = pickTarget(pages, { match: 'EXAMPLE domain' })
    expect(r.ok && r.target.id).toBe('A')
  })

  it('⛔ 只认 page 类型：iframe 有 id 但不能截图/导航', () => {
    const r = pickTarget(pages, { match: 'ads.example' })
    expect(r).toEqual({ ok: false, reason: 'not-found', hits: [] })
  })

  it('0 命中 ⇒ 拒绝（⛔ 不回落"唯一那个 tab"）', () => {
    const single = [t('A', 'page', 'x', 'https://a/')]
    expect(pickTarget(single, { match: 'zzz' })).toEqual({ ok: false, reason: 'not-found', hits: [] })
  })

  it('多命中 ⇒ 拒绝，且候选列全', () => {
    const many = [
      t('A', 'page', 'x', 'https://app/a'),
      t('B', 'page', 'y', 'https://app/b'),
    ]
    const r = pickTarget(many, { match: 'app' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('ambiguous')
    expect(!r.ok && r.hits.length).toBe(2)
  })

  it('match 为空 ⇒ 拒绝（⛔ 不许空串匹配到全部）', () => {
    expect(pickTarget(pages, { match: '   ' })).toEqual({ ok: false, reason: 'empty', hits: [] })
  })

  it('id 优先于 match：两者都给时只认 id', () => {
    // 若实现是"match 先命中 B 再校验 id"或反之，这里会露出来
    const r = pickTarget(pages, { id: 'A', match: 'acme' })
    expect(r.ok && r.target.id).toBe('A')
    expect(r.ok && r.by).toBe('id')
  })

  it('renderHits 把候选渲染成人能照着改的几行', () => {
    const s = renderHits([t('A', 'page', 'x', 'https://a/')])
    expect(s).toContain('A')
    expect(s).toContain('https://a/')
  })
})

// ══════════════════════════════════════════════════════════════════
// ② 选可点元素（判据比选 tab 严 —— 点下去就发生了）
// ══════════════════════════════════════════════════════════════════
describe('pickClickable: 点之前先拒绝', () => {
  it('唯一命中且可点 ⇒ 选中', () => {
    const r = pickClickable([el()], { text: '登' })
    expect(r.ok && r.el.x).toBe(10)
    expect(r.ok && r.by).toBe('text')
  })

  it('⛔ 多命中一律拒绝（⛔ 不选第一个/最像的）', () => {
    const r = pickClickable([el(), el({ x: 200 })], { text: '登录' })
    expect(!r.ok && r.reason).toBe('ambiguous')
    expect(!r.ok && r.hits.length).toBe(2)
  })

  it('⛔ disabled ⇒ 拒绝，并说清是哪一条', () => {
    const r = pickClickable([el({ disabled: true })], { text: '登录' })
    expect(!r.ok && r.reason).toBe('not-clickable')
    expect(!r.ok && r.why).toContain('disabled')
  })

  it('⛔ pointer-events:none ⇒ 拒绝（点击会穿透到下面的元素）', () => {
    const r = pickClickable([el({ pointerNone: true })], { text: '登录' })
    expect(!r.ok && r.reason).toBe('not-clickable')
    expect(!r.ok && r.why).toContain('pointer-events')
  })

  it('⛔ download 链接 ⇒ 拒绝（会产生不追踪的落盘）', () => {
    const r = pickClickable([el({ download: true })], { text: '登录' })
    expect(!r.ok && r.reason).toBe('not-clickable')
  })

  it('⛔ 零尺寸元素不参与匹配（不在屏幕上）', () => {
    const r = pickClickable([el({ w: 0, h: 0 })], { text: '登录' })
    expect(r).toEqual({ ok: false, reason: 'not-found', hits: [] })
  })

  it('0 命中 ⇒ 拒绝', () => {
    expect(pickClickable([el()], { text: '注册' })).toEqual({ ok: false, reason: 'not-found', hits: [] })
  })

  it('文本子串大小写不敏感', () => {
    const r = pickClickable([el({ text: 'Sign In' })], { text: 'sign in' })
    expect(r.ok).toBe(true)
  })

  it('xy 直通 ⇒ 不做文本校验、不查列表（调用方已经量过了）', () => {
    const r = pickClickable([], { xy: { x: 100, y: 200 } })
    expect(r.ok && r.by).toBe('xy')
    expect(r.ok && r.el.x).toBe(100)
  })

  it('text 为空 ⇒ 拒绝（⛔ 不许空串匹配到全部）', () => {
    expect(pickClickable([el()], { text: '  ' })).toEqual({ ok: false, reason: 'no-candidate', hits: [] })
  })

  it('renderClickables 给出坐标与禁用标记', () => {
    const s = renderClickables([el({ disabled: true })])
    expect(s).toContain('@10,20')
    expect(s).toContain('[disabled]')
  })
})
