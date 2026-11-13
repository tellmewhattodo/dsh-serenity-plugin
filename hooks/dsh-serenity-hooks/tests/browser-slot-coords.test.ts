/*
 * browser-slot-coords.test.ts — 坐标解析的判据（browser/coords.ts）。
 *
 * 事故来源（owner 2026-11-13 截图）：模型调 click 时把坐标写成 {"xy": 1428,76} —— 裸两个数字。
 * 宿主在**参数 JSON 解析阶段**就拒了（MALFORMED_RESPONSE），我们的工具一次都没执行。
 * 根因不在点击逻辑里，而在 schema 只收 string 把那种写法挤了出去。
 *
 * 判据：**收得宽 ≠ 判得松**。三种形态都收，但「解析成功」的门槛一条没降。
 */

import { describe, expect, it } from 'vitest'
import { parseXY, xyFormHint } from '../src/browser/coords.js'

describe('parseXY: 三种形态都收（C1~C4）', () => {
  it('C1 字符串 x,y（逗号）', () => {
    expect(parseXY('1428,76')).toEqual({ x: 1428, y: 76 })
  })

  it('C2 字符串 x y（空白分隔，也是老写法）', () => {
    expect(parseXY('1428 76')).toEqual({ x: 1428, y: 76 })
  })

  it('C3 数组 [x,y]（事故里模型想写的形态）', () => {
    expect(parseXY([1428, 76])).toEqual({ x: 1428, y: 76 })
  })

  it('C4 对象 {x,y}', () => {
    expect(parseXY({ x: 1428, y: 76 })).toEqual({ x: 1428, y: 76 })
  })
})

describe('parseXY: 必须拒绝（拒绝松掉会让点击落到别处）', () => {
  it('C5 分量个数不对：1 个 ／ 3 个都拒绝（不取前两个）', () => {
    expect(parseXY('1428')).toBeUndefined()
    expect(parseXY('1,2,3')).toBeUndefined()
    expect(parseXY([1])).toBeUndefined()
    expect(parseXY([1, 2, 3])).toBeUndefined()
  })

  it('C6 非有限数拒绝（NaN ／ Infinity ／ 非数字串）', () => {
    expect(parseXY('a,b')).toBeUndefined()
    expect(parseXY([Number.NaN, 1])).toBeUndefined()
    expect(parseXY([1, Number.POSITIVE_INFINITY])).toBeUndefined()
  })

  it('C7 负数拒绝（会让点击落到别处或直接被 CDP 丢弃）', () => {
    expect(parseXY('-1,5')).toBeUndefined()
    expect(parseXY([-1, 5])).toBeUndefined()
    expect(parseXY({ x: -1, y: 5 })).toBeUndefined()
  })

  it('C8 对象缺分量 ／ 裸值拒绝', () => {
    expect(parseXY({ x: 1 })).toBeUndefined()
    expect(parseXY({})).toBeUndefined()
    expect(parseXY(42 as never)).toBeUndefined()
    expect(parseXY(true as never)).toBeUndefined()
  })

  it('C9 null ／ undefined ／ 空串 ⇒ undefined（= 没给，不是 0,0）', () => {
    expect(parseXY(null)).toBeUndefined()
    expect(parseXY(undefined)).toBeUndefined()
    expect(parseXY('')).toBeUndefined()
  })

  it('C10 零坐标是合法的（0,0 是真实视口点，别当没给）', () => {
    expect(parseXY('0,0')).toEqual({ x: 0, y: 0 })
    expect(parseXY([0, 0])).toEqual({ x: 0, y: 0 })
  })
})

describe('xyFormHint: 拒绝时不能只列一种形态', () => {
  it('C11 三种形态都列出（只列一种等于又把口子收窄回去）', () => {
    const h = xyFormHint('xy')
    expect(h).toContain('--xy=1428,76')
    expect(h).toContain('[1428,76]')
    expect(h).toContain('{x:1428,y:76}')
  })
})
