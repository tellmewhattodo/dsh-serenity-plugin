/**
 * msm-bun-path.test.ts —— **非 Windows 平台必须解析出 bun 的绝对路径**（2026-11-22 缺陷回归钉）
 *
 * ## 缺陷形态（owner 截图逼出）
 *
 * 每一次 MSM 调用都落进 `npx tsx` 兜底，于是：
 * ① 每个 MSM 调用多起 **4 层进程**（`npm exec tsx` → `sh -c 'tsx'` → `node tsx` → `node loader`）；
 * ② npm 每次往 **stderr** 打两行 `npm warn Unknown user config "always-auth"`，
 *    而 stderr 在**失败路径**上是要被模型读的（`msmExecResult` 把它原样放进回执）
 *    ⇒ 每一份失败回执前面都挂着这两行**纯噪声进上下文**。
 *
 * 根因一行：`bunExecutablePath()` 里 `if (platform !== 'win32') return 'bun'` ——
 * 返回**裸名**，而宿主进程的 PATH 里没有 `~/.bun/bin` ⇒ `spawn ENOENT` ⇒ 落进 npx。
 *
 * ## 为什么这条判据必须长成这样
 *
 * 🔴 **回执上完全看不出来**：走 npx 兜底时 MSM 照样正常返回结果。
 * 我是靠**进程树**（`ps` 里看到 `npm exec tsx …`）才发现"走的不是那条路"的。
 * ⇒ 判据只能**直接读那个函数**；⛔ 不能读某次调用的回执，⛔ 不能在测试里复刻探测逻辑
 * （复刻 = 测我自己的假设，不是测实现）。
 *
 * ⚠️ **一条诚实边界**：本机是 Linux，故 `bunExecutablePath()` 在 Windows 上的行为
 * **本用例证明不了**。它证明的是"非 Windows 分支现在会真的去探测绝对路径"。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { bunExecutablePath } from '../src/tools/msm/service.js'

describe('bunExecutablePath：⛔ 不许在非 Windows 上返回裸名', () => {
  it('🔴 返回值要么是 null，要么是**绝对路径** —— 绝不是裸名 `bun`', () => {
    const p = bunExecutablePath()
    // 这正是本缺陷的形态：旧实现恒返回裸名 'bun'
    expect(p, '返回裸名 "bun" ⇒ 宿主 PATH 里通常没有它 ⇒ 每次都落进 npx 兜底').not.toBe('bun')
    if (p !== null) {
      expect(p.startsWith('/'), `非绝对路径：${p}`).toBe(true)
      expect(existsSync(p), `解析出的路径不存在：${p}`).toBe(true)
    }
  })

  /**
   * 正控：**本机确实装了 bun**（`~/.bun/bin/bun` 实测存在）。
   * 若这条红 ⇒ 说明是"这台机器没有 bun"，那么上一条的 `null` 是环境所致，
   * ⛔ 不能据此说"探测逻辑对" —— 两种红必须分得开。
   */
  it('正控：本机装了 bun ⇒ 上面那条不该靠 null 蒙过去', () => {
    const p = bunExecutablePath()
    expect(p, '本机实测装了 bun（~/.bun/bin/bun），而探测返回 null ⇒ 探测候选集没覆盖真正的落点').not.toBeNull()
  })

  /**
   * 缓存语义：同一个值反复调用必须一致（这是 memo，不是"每次重算"）。
   * ⚠️ 判据是"两次相等"，⛔ 不是"等于某个写死的路径"（那会把用例焊死在本机布局上）。
   */
  it('memo 语义：连续两次调用返回同一结果', () => {
    expect(bunExecutablePath()).toBe(bunExecutablePath())
  })
})
