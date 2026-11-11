/*
 * browser-slot-scroll-contract.test.ts — 「回落必须可见」这条契约的机械守卫。
 *
 * 真机实测（2026-11-11）：Wayland headed Chrome 上 Input.dispatchMouseEvent{mouseWheel}
 * 会永久挂住（30s 超时），而同一台机器的 --headless=new 实例立刻返回。
 * 于是 scrollAt 加了「短超时 → 回落 JS 滚动」的降级。
 *
 * 🔴 这条降级最危险的地方不是它不完美，而是**它可能被写成静默的**：
 * JS 滚动不产生 wheel 事件 ⇒ 靠 wheel 的懒加载不会启动，而 scrollY 照样变了。
 * 两个读数（scrollY 变了 / 内容加载了）都「看起来正常」。
 * ⇒ 这里钉住三件事：源码里必须有 via 字段、超时必须是短的、回执必须说出走了哪条路。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const cdp = readFileSync(join(SRC, 'browser', 'cdp.ts'), 'utf8')
const tool = readFileSync(join(SRC, 'tools', 'browser-slot', 'index.ts'), 'utf8')

describe('scroll 的 wheel 降级必须可见（S1~S4）', () => {
  it('S0 正控：两个文件都读到了内容（否则下面三条会假绿）', () => {
    expect(cdp.length).toBeGreaterThan(1000)
    expect(tool.length).toBeGreaterThan(1000)
  })

  it('S1 scrollAt 有两条路，且返回值带 via', () => {
    const i = cdp.indexOf('export async function scrollAt(')
    expect(i).toBeGreaterThan(-1)
    const body = cdp.slice(i, cdp.indexOf('\n}\n', i))
    expect(body).toContain("via: 'wheel'")
    expect(body).toContain("via: 'js-fallback'")
  })

  it('S2 wheel 的超时必须是**短的**（等 30s 等于把「滚不动」变成「卡死半分钟」）', () => {
    const i = cdp.indexOf('export async function scrollAt(')
    const body = cdp.slice(i, cdp.indexOf('\n}\n', i))
    const m = /send\('Input\.dispatchMouseEvent', wheel, (\d+)\)/.exec(body)
    expect(m, 'wheel 调用的超时参数没找到 —— 抽取器锚变了').not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(5000)
  })

  it('S3 工具回执必须把 via 说出来（⛔ 不许静默替代）', () => {
    expect(tool).toContain('via === ' + "'wheel'")
    expect(tool).toContain('回落 JS 滚动')
    // 反向：回执里不能只报 scrolledY 而不提走了哪条路
    expect(tool).not.toMatch(/scroll → scrollY 变化 \$\{scrolledY[^`]*`$/m)
  })
})
