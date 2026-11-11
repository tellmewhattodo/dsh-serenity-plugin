/*
 * browser-slot-dialog-auto.test.ts — 「原生弹窗不许阻断流程」这条契约的机械守卫。
 *
 * 背景（owner 2026-11-11 现场截图）：点一个会 confirm() 的按钮 ⇒ 弹窗留在屏幕上，
 * click 30s 超时，之后该 tab 所有 CDP 调用全超时 ⇒ 整条自动化被原地卡死。
 *
 * 修法 = 在**同一条连接**上先 Page.enable 收事件，事件一到就由浏览器进程 dismiss。
 * 这条修法有三处一旦松掉就会退回原状，而**测试之外没有任何信号**：
 *   D1 clickAt 必须把 autoDialog 挂上（否则弹窗没人管）
 *   D2 事件回调里必须**不 await**（await 会堵消息循环 ⇒ 所有调用一起超时）
 *   D3 处理结果必须能报出去（静默替你点「取消」是另一种欺骗）
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const cdp = readFileSync(join(SRC, 'browser', 'cdp.ts'), 'utf8')
const tool = readFileSync(join(SRC, 'tools', 'browser-slot', 'index.ts'), 'utf8')

const fnBody = (name: string): string => {
  const i = cdp.indexOf(name)
  expect(i, `找不到 ${name}`).toBeGreaterThan(-1)
  const j = cdp.indexOf('\n}\n', i)
  return cdp.slice(i, j > 0 ? j : undefined)
}

describe('原生弹窗自动处理（D1~D4）', () => {
  it('D0 正控：三个文件都读到了内容（否则下面几条会假绿）', () => {
    expect(cdp.length).toBeGreaterThan(1000)
    expect(tool.length).toBeGreaterThan(1000)
  })

  it('D1 clickAt 必须挂 autoDialog（不然弹窗没人管，页面卡死）', () => {
    const body = fnBody('export async function clickAt(')
    expect(body).toContain('autoDialog')
    expect(body).toMatch(/mode: 'dismiss'/)
  })

  it('D2 withPage 的默认策略是 dismiss（不是 none —— none 等于把卡死还回去）', () => {
    const body = fnBody('export async function withPage<T>(')
    expect(body).toContain("opts.autoDialog ?? { mode: 'dismiss'")
  })

  it('D3 事件回调里必须 fire-and-forget（await 会堵消息循环 ⇒ 所有调用一起超时）', () => {
    const i = cdp.indexOf('function attachAutoDialog(')
    expect(i).toBeGreaterThan(-1)
    const body = cdp.slice(i, cdp.indexOf('\n}\n', i))
    expect(body).toContain('void send(')
    expect(body).not.toMatch(/await send\('Page\.handleJavaScriptDialog'/)
  })

  it('D4 工具回执必须报出自动处理掉的弹窗（静默点「取消」是另一种欺骗）', () => {
    expect(tool).toContain('自动处理弹窗')
    expect(tool).toContain('dialogs.length === 0')
  })

  it('D5 dismiss 与 accept 的默认值判据：默认必须是取消那一侧（D318）', () => {
    const i = cdp.indexOf('export interface AutoDialog')
    const body = cdp.slice(i, cdp.indexOf('\n}\n', i))
    expect(body).toMatch(/dismiss.*默认/)
  })
})
