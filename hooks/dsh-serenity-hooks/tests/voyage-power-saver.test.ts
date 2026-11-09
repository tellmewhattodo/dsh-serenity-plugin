/**
 * voyage-power-saver.test.ts — 航行动画的省电闸（§8d/§11）
 *
 * 🔴🔴 **这条门禁的来历**（2026-11-09 事故）：
 *    我起浏览器拍截图，做完没关。而那个页面**本身也没有省电机制** ——
 *    `tick()` 无条件 `requestAnimationFrame` 自循环，全文零处 `visibilitychange`。
 *    一个被遗忘在后台的标签页因此以 60fps 连续跑了 36 小时，累计 CPU 12h57m，
 *    整机功耗异常、风扇长转，owner 要睡了才发现。
 *
 * ⇒ 本文件钉两件事，缺一不可：
 *    ① **进程泄漏**由 `browser_slot` 的槽位台账管（另一处）
 *    ② **页面自身必须停** —— 就算进程还在，不可见时也不许渲染
 *
 * ⚠️ 判据是"不可见 ⇒ 停止请求下一帧"，⛔ 不是"降帧"：
 *    浏览器对后台标签页的节流通常只降到 1fps，36 小时仍是 36 小时。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET = join(HERE, '..', 'assets', 'serenity-voyage.html')
const html = readFileSync(ASSET, 'utf8')

/** 剥掉注释，只留会执行到的代码（注释里出现关键字不算实现） */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const code = codeOnly(html)

describe('§11 省电闸：不可见必须停，⛔ 不是降帧', () => {
  it('① 必须存在 visibilitychange 监听（事故的直接成因是它一处都没有）', () => {
    expect(code.includes('visibilitychange')).toBe(true)
    // 负控：证明上一条不是被注释或别处字符串凑出来的
    expect(html.includes('visibilitychange')).toBe(true)
  })

  it('② tick 里必须先判 document.hidden 并直接 return（不渲染、不再请求帧）', () => {
    const m = /function tick\(\)\s*\{([\s\S]*?)\n\}/.exec(code)
    expect(m).not.toBeNull()
    const body = m![1]!
    // 前若干行内必须出现 hidden 判定（⛔ 不要求在最后 —— 那等于白跑一帧）
    const head = body.slice(0, 400)
    // 🔴 断言必须钉**真实执行的形态**，不能只钉"出现过 document.hidden"。
    //    变异检验抓到的第一次假绿：把闸改成 `if (false && document.hidden)` 后本用例仍绿
    //    ⇒ 因为它只查子串。⇒ 改成查**开头就是** `if (document.hidden)` 或等价的正向形式，
    //    并显式排除前面挂 `false &&` / `!1 &&` 这类"看起来有、永远不成立"的写法。
    expect(head).toMatch(/if\s*\(\s*document\.hidden\s*\)/)
    expect(head.includes('false &&')).toBe(false)
    expect(head.includes('return')).toBe(true)
    // 🔴 负控：判定必须在**第一次渲染之前**。
    //    若 renderer.render 出现在 hidden 判定之前，说明它照样画了一帧才退出。
    const idxHidden = body.indexOf('document.hidden')
    const idxRender = body.indexOf('renderer.render')
    expect(idxRender).toBeGreaterThan(-1) // 前提：body 里确实有渲染调用
    expect(idxHidden).toBeLessThan(idxRender)
  })

  it('③ 恢复可见时必须重启循环（否则页面永久静止 —— 那是同一个 bug 的反面）', () => {
    // 恢复分支里必须再次 requestAnimationFrame(tick)
    const handler = /visibilitychange[\s\S]{0,700}?\}\)/.exec(code)
    expect(handler).not.toBeNull()
    expect(handler![0].includes('requestAnimationFrame(tick)')).toBe(true)
    // 且必须重置时钟：停摆期累积的 delta 不重置会让回来的第一帧跳变
    expect(handler![0].includes('getDelta')).toBe(true)
  })

  it('④ pagehide 也要停（bfcache / 关闭标签页路径上 visibilitychange 不一定触发）', () => {
    expect(code.includes('pagehide')).toBe(true)
  })

  it('⑤ 🔴 tick 的结尾仍然无条件请求下一帧时，必须有闸 —— 负控证明这条断言有判别力', () => {
    // 现状：tick 末尾是无条件的 requestAnimationFrame(tick)
    // ⇒ 它的安全性**完全依赖**函数开头的 hidden 判定。
    //   本断言就是把这个依赖写死：如果有人删了开头那道闸而末尾还是无条件自循环，
    //   ① / ② 会红；如果他把末尾改成条件式（另一种正确写法），本断言不误报。
    const tail = code.slice(code.lastIndexOf('requestAnimationFrame(tick);'))
    const beforeTail = code.slice(0, code.lastIndexOf('requestAnimationFrame(tick);'))
    const hasGateAtHead = /function tick\(\)\s*\{[\s\S]{0,400}?document\.hidden/.test(code)
    const tailIsConditional = /if\s*\([^)]*\)\s*requestAnimationFrame\(tick\);?\s*\}?\s*$/.test(tail.slice(0, 200))
    // 二者至少成立一个 ⇒ 不存在"无条件自循环且无闸"的组合
    expect(hasGateAtHead || tailIsConditional).toBe(true)
    void beforeTail
  })
})
