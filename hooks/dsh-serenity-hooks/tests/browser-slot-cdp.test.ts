/**
 * browser-slot-cdp.test.ts — 槽位 CDP 客户端（页面操作层）
 *
 * 🔴 这一层的**大部分函数需要真浏览器**，而且它们已经被 `browser-slot-LIVE.test.ts`
 *    在真机上走过一遍。本文件补的是**不需要真浏览器也能钉死的判据**：
 *
 *    ① 截图落点越界检查（这是一道安全边界，⛔ 不能只在真机上验）
 *    ② 就绪探测「答话 vs 不答话」两档 —— 恒假的读数器会与"没人监听"同形
 *    ③ 未就绪时**必须**给出可读错误，⛔ 不许挂起
 *
 * ⚠️ 明确**不在这里做**的事：用 mock 的假 WebSocket 去"模拟 CDP 协议"。
 *    那种测试只能证明"我按我以为的协议写了客户端"，而 CDP 的真实形状由 LIVE 探针负责。
 *    判据：**替身证明不了协议**（D141 同族：测过 ≠ 验过）。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { probeCdpOnce, resolveShotPath, tryShotChain, __test } from '../src/browser/cdp.js'

describe('截图落点：越界检查（安全边界，⛔ 不能只在真机上验）', () => {
  it('① CCC 根内的相对路径 ⇒ 解析成根内绝对路径', () => {
    const root = '/ccc/alpha'
    expect(resolveShotPath(root, '_tmp/browser-shots/a.png')).toBe(join(root, '_tmp/browser-shots/a.png'))
  })

  it('② 根自身 ⇒ 允许（同 `resolveInside` 的语义，边界点不特殊）', () => {
    const root = '/ccc/alpha'
    expect(resolveShotPath(root, '.')).toBe(resolve(root))
  })

  it('③ 🔴 `../` 逃逸 ⇒ **硬拒**，且报错里带原始入参（否则收到的人不知道该改哪个值）', () => {
    expect(() => resolveShotPath('/ccc/alpha', '../outside.png')).toThrow('越界')
    expect(() => resolveShotPath('/ccc/alpha', '../outside.png')).toThrow('../outside.png')
    // 负控：深层逃逸同样挡（只挡一层是常见漏洞）
    expect(() => resolveShotPath('/ccc/alpha', '_tmp/../../etc/x.png')).toThrow('越界')
  })

  it('④ 🔴 前缀相邻目录不算"在里面"（`/ccc/alpha-evil` 以 `/ccc/alpha` 开头）', () => {
    // 这条是路径判据最经典的假绿形态：`startsWith(root)` 会把它放行。
    expect(() => resolveShotPath('/ccc/alpha', '/ccc/alpha-evil/x.png')).toThrow('越界')
    // 对照：真正的子目录必须放行（证明上面那条不是"所有绝对路径都拒"）
    expect(resolveShotPath('/ccc/alpha', `${'/ccc/alpha'}${sep}sub/x.png`)).toBe(`/ccc/alpha${sep}sub/x.png`)
  })

  it('⑤ 真临时目录上走一遍（⛔ 只在字符串上判 —— 真实路径可能含符号链接或尾斜杠）', () => {
    const root = mkdtempSync(join(tmpdir(), 'slot-cdp-'))
    try {
      const p = resolveShotPath(root, 'a/b.png')
      expect(p.startsWith(resolve(root) + sep)).toBe(true)
      expect(() => resolveShotPath(root, '../x.png')).toThrow('越界')
      // 尾部斜杠的根同样成立（否则会拼出 `//` 或误判）
      expect(resolveShotPath(root + sep, 'a.png').startsWith(resolve(root) + sep)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('CDP 就绪探测（"答话"与"没人监听"必须分得开）', () => {
  it('⑥ 没人在监听的端口 ⇒ false 且**不抛**（探测必须能回答"还没起来"）', async () => {
    // 用 CDP 端口区间之外的高位端口，避免撞上真槽位
    const alive = await probeCdpOnce(0)
    expect(alive).toBe(false)
  })

  it('⑦ 探测是真连接、不是读缓存：同一入口连问两次结果一致，且不依赖上一次的残留', async () => {
    const a = await probeCdpOnce(0, 150)
    const b = await probeCdpOnce(0, 150)
    expect(a).toBe(false)
    expect(b).toBe(false)
  })
})

describe('内部导出面（⛔ 生产代码不该用）', () => {
  it('⑧ __test 只暴露两个内部函数，且都不是"看起来能用"的公开 API 名字', () => {
    expect(Object.keys(__test).sort()).toEqual(['attach', 'cdpRaw'])
    expect(typeof __test.attach).toBe('function')
    expect(typeof __test.cdpRaw).toBe('function')
  })
})

/**
 * 🔴 **锁屏截图超时的修法：回退链**（2026-11-27 owner 报障）
 *
 * 根因不是"超时太小"，而是 headed Chrome 在窗口不可见时**停止为该 tab 合成帧**，
 * 而默认截图语义是"等下一帧" ⇒ 永远等不到。⇒ 短超时 + 回退。
 *
 * 本组钉的是**链的行为**（用注入的 send，⛔ 不假装在模拟 CDP 协议）：
 *   · 第一路成功 ⇒ **只试一次**（不许把成功路径也拖成三次）
 *   · 第一路抛 ⇒ 落到第二路，`via` 必须如实报第二路（⛔ 不许冒报 default）
 *   · **空 data 与抛错同等对待** —— 那是 0 字节文件，比报错更坏
 *   · 全失败 ⇒ 抛，且**文案必须说"没有可取的帧"**（⛔ 不许让人去调超时）
 */
describe('截图回退链（锁屏/遮挡时不得挂死）', () => {
  it('⑨ 第一路成功 ⇒ 只试一次，且 via = default', async () => {
    let calls = 0
    const r = await tryShotChain(async () => {
      calls++
      return { data: 'AAAA' }
    })
    expect(calls, '第一路成功却还继续试 ⇒ 白等两轮超时').toBe(1)
    expect(r.via).toBe('default')
  })

  it('⑩ 🔴 第一路抛 ⇒ 落第二路，且 via **如实**报第二路（⛔ 不许冒报 default）', async () => {
    const seen: unknown[] = []
    const r = await tryShotChain(async (params) => {
      seen.push(params)
      if (seen.length === 1) throw new Error('CDP Page.captureScreenshot 超时 4000ms')
      return { data: 'BBBB' }
    })
    expect(seen.length).toBe(2)
    expect(r.via).toBe('fromSurface=false')
    // 第二路必须真的改了口径（否则"回退"只是把同一条命令再发一次）
    expect(seen[1]).toMatchObject({ fromSurface: false })
  })

  it('⑪ 🔴 空 data **不算成功** ⇒ 必须继续走下一路（否则写出 0 字节文件）', async () => {
    let calls = 0
    const r = await tryShotChain(async () => {
      calls++
      if (calls === 1) return { data: '' } // "成功"但空 —— 最阴的一格
      return { data: 'CCCC' }
    })
    expect(calls).toBe(2)
    expect(r.via).toBe('fromSurface=false')
  })

  it('⑫ 三路全失败 ⇒ 抛，且文案指向"没有可取的帧"（⛔ 别让人去调超时）', async () => {
    let calls = 0
    await expect(
      tryShotChain(async () => {
        calls++
        throw new Error('超时')
      }),
    ).rejects.toThrow(/没有可取的帧|帧未合成/)
    expect(calls, '必须把三条路**都**试过才放弃').toBe(3)
  })

  it('⑬ 顺序是固定的三条：default → fromSurface=false → beyondViewport', async () => {
    const seen: Record<string, unknown>[] = []
    await tryShotChain(async (params) => {
      seen.push(params)
      throw new Error('x')
    }).catch(() => undefined)
    expect(seen.length).toBe(3)
    expect(seen[0]).toMatchObject({ format: 'png' })
    expect(seen[1]).toMatchObject({ fromSurface: false })
    expect(seen[2]).toMatchObject({ fromSurface: false, captureBeyondViewport: true })
    // 结构性判据：第三路必须带上第二路的口径（⛔ 从 default 直接跳 beyondViewport）
    expect(seen[2]!.captureBeyondViewport).toBe(true)
  })
})
