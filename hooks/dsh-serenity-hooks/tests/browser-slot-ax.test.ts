/*
 * browser-slot-ax.test.ts — AX 剪枝与 ref 解析的判据（browser/ax.ts）。
 *
 * 重点钉的是一条会指错元素的错：ref 若按遍历顺序编号，
 * 快照一变它就指向别人 —— 而那次点错没有任何信号。
 */

import { describe, expect, it } from 'vitest'
import { INTERACTIVE_ROLES, pruneAx, refToBackendId, renderAx, type AxNode } from '../src/browser/ax.js'

const n = (o: Partial<AxNode>): AxNode =>
  ({
    ignored: false,
    role: { type: 'role', value: 'button' },
    name: { type: 'computedString', value: 'OK' },
    ...o,
  }) as AxNode

describe('pruneAx: 留下什么', () => {
  it('A1 可交互 + 有 backendDOMNodeId ⇒ 保留，ref = e<backendNodeId>', () => {
    const out = pruneAx([n({ backendDOMNodeId: 4242 })])
    expect(out).toHaveLength(1)
    expect(out[0]!.ref).toBe('e4242')
    expect(out[0]!.role).toBe('button')
    expect(out[0]!.name).toBe('OK')
  })

  it('A2 ref 必须是 backendNodeId，不是顺序编号（顺序编号换快照就指向别人）', () => {
    const out = pruneAx([
      n({ backendDOMNodeId: 99 }),
      n({ backendDOMNodeId: 7, name: { type: 'computedString', value: 'two' } }),
    ])
    expect(out.map((x) => x.ref)).toEqual(['e99', 'e7'])
  })

  it('A3 图标按钮（name 空但有 description）⇒ 保留，description 进名字（带括号）', () => {
    const out = pruneAx([
      n({ backendDOMNodeId: 5, name: { type: 'computedString', value: '' }, description: { type: 'computedString', value: '关闭' } }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('(关闭)')
  })

  it('A4 无 backendDOMNodeId ⇒ 丢掉（没有它就点不到，留着只会让人以为能点）', () => {
    expect(pruneAx([n({})])).toHaveLength(0)
  })
})

describe('pruneAx: 必须丢掉的', () => {
  it('A5 ignored=true ⇒ 丢掉（aria-hidden / inert / 视觉隐藏都在这一档）', () => {
    expect(pruneAx([n({ backendDOMNodeId: 1, ignored: true })])).toHaveLength(0)
  })

  it('A6 非白名单角色 ⇒ 丢掉（白名单而非黑名单：黑名单会静默漏掉新角色）', () => {
    const out = pruneAx([n({ backendDOMNodeId: 1, role: { type: 'role', value: 'paragraph' } })])
    expect(out).toHaveLength(0)
  })

  it('A7 limit 生效（截断）', () => {
    const many = Array.from({ length: 30 }, (_, i) => n({ backendDOMNodeId: i + 1 }))
    expect(pruneAx(many, 5)).toHaveLength(5)
  })
})

describe('pruneAx: 状态读数', () => {
  it('A8 disabled 取 AX 属性（浏览器算的），不是读 aria-disabled', () => {
    const out = pruneAx([
      n({ backendDOMNodeId: 3, properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }] }),
    ])
    expect(out[0]!.disabled).toBe(true)
  })

  it('A9 flags 只收真值（false 不占位置）', () => {
    const out = pruneAx([
      n({
        backendDOMNodeId: 3,
        properties: [
          { name: 'checked', value: { type: 'boolean', value: true } },
          { name: 'expanded', value: { type: 'boolean', value: false } },
        ],
      }),
    ])
    expect(out[0]!.flags).toEqual(['checked=true'])
  })
})

describe('refToBackendId: ref 是身份', () => {
  it('A10 正常 ref ⇒ 数字', () => {
    expect(refToBackendId('e12345')).toBe(12345)
  })

  it('A11 拒绝顺序编号 e0 / e01 / e-1 / eabc / 裸数字 / CSS 选择器', () => {
    expect(refToBackendId('e0')).toBeNull()
    expect(refToBackendId('e01')).toBeNull()
    expect(refToBackendId('e-1')).toBeNull()
    expect(refToBackendId('eabc')).toBeNull()
    expect(refToBackendId('12345')).toBeNull()
    expect(refToBackendId('#submit')).toBeNull()
    expect(refToBackendId('button.ok')).toBeNull()
  })

  it('A12 空白会被剥掉（粘贴形态）', () => {
    expect(refToBackendId('  e7  ')).toBe(7)
  })
})

describe('renderAx / 白名单', () => {
  it('A13 渲染含 ref、role、名字；超出时明说另有几个', () => {
    const lines = [
      { ref: 'e1', role: 'button', name: '登录', value: '', disabled: false, flags: [] },
      { ref: 'e2', role: 'textbox', name: '手机号', value: '138', disabled: true, flags: ['required=true'] },
    ]
    const s = renderAx(lines, 5)
    expect(s).toContain('e1')
    expect(s).toContain('登录')
    expect(s).toContain('required=true')
    expect(s).toContain('[disabled]')
    expect(s).toContain('另有 3 个')
  })

  it('A14 白名单非空且含最基本几个角色（空清单会让快照永远为空）', () => {
    expect(INTERACTIVE_ROLES.length).toBeGreaterThan(15)
    for (const r of ['button', 'link', 'textbox', 'checkbox', 'tab']) expect(INTERACTIVE_ROLES).toContain(r)
  })
})
