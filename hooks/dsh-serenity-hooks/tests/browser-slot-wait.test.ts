/*
 * browser-slot-wait.test.ts — 等待条件解析的判据（browser/wait-spec.ts）。
 *
 * 重点钉两条：
 *   W1 裸值必须拒绝（无前缀有歧义 ⇒ 猜错会等一个永不到来的条件，而超时不告诉你是猜错了）
 *   W2 调用方原文必须经过 JSON.stringify 变成字面量（否则一个引号就能改掉整段注入的 JS）
 */

import { describe, expect, it } from 'vitest'
import { explainWaitTimeout, parseWaitSpec, WAIT_FORMS } from '../src/browser/wait-spec.js'

describe('parseWaitSpec: 五形态', () => {
  it('W0 selector / text / url / gone / js 都能解，且 kind 正确', () => {
    expect(parseWaitSpec('selector:#app')!.kind).toBe('selector')
    expect(parseWaitSpec('text:加载完成')!.kind).toBe('text')
    expect(parseWaitSpec('url:/dashboard')!.kind).toBe('url')
    expect(parseWaitSpec('gone:.mask')!.kind).toBe('gone')
    expect(parseWaitSpec('js:window.ready === true')!.kind).toBe('js')
  })

  it('W1 裸值必须拒绝（无前缀 = 形态不明 = 会等到永不到来的条件）', () => {
    expect(parseWaitSpec('#app')).toBeNull()
    expect(parseWaitSpec('.loading')).toBeNull()
    expect(parseWaitSpec('加载完成')).toBeNull()
  })

  it('W2 未知前缀拒绝，且空参数拒绝', () => {
    expect(parseWaitSpec('css:#app')).toBeNull()
    expect(parseWaitSpec('selector:')).toBeNull()
    expect(parseWaitSpec('')).toBeNull()
    expect(parseWaitSpec('   ')).toBeNull()
  })
})

describe('parseWaitSpec: 注入面', () => {
  it('W3 选择器里的引号/反斜杠被 JSON.stringify 成字面量（不会逃出字符串）', () => {
    const spec = parseWaitSpec(`selector:div[title="a'b"]`)!
    expect(spec.expression).toContain('document.querySelector(')
    // 原文的引号绝不能裸露地出现两次以上（那意味着拼接了原文）
    const inner = spec.expression.slice(spec.expression.indexOf('(') + 1, spec.expression.indexOf(')'))
    expect(() => JSON.parse(inner)).not.toThrow()
    expect(JSON.parse(inner)).toBe(`div[title="a'b"]`)
  })

  it('W4 text 形态会把正文里的引号安全化', () => {
    const spec = parseWaitSpec('text:他说"好"')!
    expect(spec.expression).toContain('includes(')
    expect(() => JSON.parse(spec.expression.slice(spec.expression.indexOf('includes(') + 9, spec.expression.lastIndexOf(')')))).not.toThrow()
  })

  it('W5 js: 形态照原样拼（唯一接受任意代码的一档，调用方已明确要执行代码）', () => {
    const spec = parseWaitSpec('js:document.readyState === "complete"')!
    expect(spec.expression).toBe('(document.readyState === "complete")')
  })
})

describe('explainWaitTimeout: 超时必须说清等的是什么', () => {
  it('W6 含条件形态与参数', () => {
    const spec = parseWaitSpec('selector:.done')!
    const msg = explainWaitTimeout(spec, 5000, null)
    expect(msg).toContain('.done')
    expect(msg).toContain('5s')
  })

  it('W7 含最后一次读数（没有它无法区分「选择器写错」与「条件在往别处走」）', () => {
    const spec = parseWaitSpec('js:x > 3')!
    const msg = explainWaitTimeout(spec, 1200, { v: 2 })
    expect(msg).toContain('最后一次读数')
    expect(msg).toContain('2')
  })

  it('W8 last=null 时明说「什么都没读到」', () => {
    const msg = explainWaitTimeout(parseWaitSpec('selector:#a')!, 1000, null)
    expect(msg).toContain('什么都没读到')
  })
})

describe('WAIT_FORMS', () => {
  it('W9 拒绝时列的形态清单非空且覆盖五种', () => {
    expect(WAIT_FORMS.length).toBe(5)
    for (const p of ['selector:', 'text:', 'url:', 'gone:', 'js:']) {
      expect(WAIT_FORMS.some((f) => f.startsWith(p))).toBe(true)
    }
  })
})
