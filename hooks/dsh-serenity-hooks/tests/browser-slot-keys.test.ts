/**
 * browser-slot-keys.test.ts — 键盘解析的判据（`browser/keys.ts`）。
 *
 * 🔴 为什么要这么细：**发错的按键不报错**。
 *    页面只是「没反应」，而那与「按对了但没效果」在读数上完全一样。
 *    所以每一条「拒绝」都要有用例钉住 —— 拒绝条件一旦松掉，坏掉的是静默那一侧。
 */

import { describe, expect, it } from 'vitest'
import { listNamedKeys, parseKeyStroke } from '../src/browser/keys.js'

describe('parseKeyStroke: 能解析的形态', () => {
  it('K1 命名键：Enter ⇒ code=Enter 且带 VK（没有 VK 不触发默认行为）', () => {
    const s = parseKeyStroke('Enter')
    expect(s).not.toBeNull()
    expect(s!.code).toBe('Enter')
    expect(s!.windowsVirtualKeyCode).toBe(13)
    expect(s!.modifiers).toBe(0)
  });

  it('K2 命名键大小写不敏感（enter / ENTER / Enter 同解）', () => {
    const a = parseKeyStroke('enter')
    const b = parseKeyStroke('ENTER')
    const c = parseKeyStroke('Enter')
    expect(a).toEqual(c)
    expect(b).toEqual(c)
  });

  it('K3 快捷键：Meta+A ⇒ modifiers=4 且 code=KeyA（大小写由修饰位表达）', () => {
    const s = parseKeyStroke('Meta+A')
    expect(s).not.toBeNull()
    expect(s!.modifiers).toBe(4)
    expect(s!.code).toBe('KeyA')
    expect(s!.key).toBe('A');
  });

  it('K4 多修饰位可叠加：Control+Shift+Enter ⇒ 2|8=10', () => {
    const s = parseKeyStroke('Control+Shift+Enter')
    expect(s!.modifiers).toBe(10)
    expect(s!.code).toBe('Enter')
  });

  it('K5 数字：7 ⇒ code=Digit7', () => {
    expect(parseKeyStroke('7')!.code).toBe('Digit7')
  });

  it('K6 小写单字符映射到同一个物理键（KeyA），⛔ 不是小写变体键', () => {
    expect(parseKeyStroke('a')!.code).toBe('KeyA')
  });
});

describe('parseKeyStroke: 必须拒绝的形态（拒绝松掉 = 静默点错/打错）', () => {
  it('K7 别名一律拒绝（Cmd / Ctrl —— 猜错会让 Cmd+A 变成无修饰 A：全选变打字）', () => {
    expect(parseKeyStroke('Cmd+A')).toBeNull()
    expect(parseKeyStroke('Ctrl+A')).toBeNull()
  });

  it('K8 中文/emoji/标点单字符拒绝（键位表里没有的东西，「按」它只是碰运气）', () => {
    expect(parseKeyStroke('中')).toBeNull()
    expect(parseKeyStroke('😀')).toBeNull()
    expect(parseKeyStroke(',')).toBeNull()
  });

  it('K9 未知键名拒绝（⛔ 不回落成「key 直接用原始串」）', () => {
    expect(parseKeyStroke('F13')).toBeNull()
    expect(parseKeyStroke('Hyper+A')).toBeNull()
  });

  it('K10 空串 / 只有修饰 / 只有加号 ⇒ 拒绝', () => {
    expect(parseKeyStroke('')).toBeNull()
    expect(parseKeyStroke('   ')).toBeNull()
    expect(parseKeyStroke('+')).toBeNull()
    expect(parseKeyStroke('Control+')).toBeNull()
  });
});

describe('listNamedKeys: 拒绝时列给调用方的清单', () => {
  it('K11 非空、去重、含几个一定会有的键', () => {
    const keys = listNamedKeys()
    expect(keys.length).toBeGreaterThan(8)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('Enter')
    expect(keys).toContain('Escape')
  });
});
