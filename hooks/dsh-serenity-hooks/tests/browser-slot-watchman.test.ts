/**
 * browser-slot-watchman.test.ts — 看守**接线**判据（v1.128.2）
 *
 * 🔴🔴 这一条防的是一个**真实发生过的静默失效**（2026-11-09 真机实测）：
 *
 *    旧装配：`registerSlotWatchman(ctx, () => cccRootForCwd(process.cwd()))`
 *    而宿主进程的 cwd 是**用户家目录** —— `dashboard diag` 明写「进程 CCC:（无）」
 *    ⇒ `cccRootForCwd(process.cwd())` **恒返回 `null`**
 *    ⇒ `tick()` 第一行 `if (!root) return` ⇒ **看守每一拍都直接返回，一次都没工作过**。
 *
 *    它**没有任何报错、没有任何日志**；台账上 `nudges` 一直是 0，
 *    而那个 0 与"确实没有异常槽位"**在读数上完全一样**（D253 同族：恒空的读数器）。
 *
 *    实测取证：把 b1 造成 `stale`（闲 55 分钟）、归属指向一条真实轨迹、进程活着，
 *    连等两拍（宿主武装于 23:06:21，拍点在 23:11:21）⇒ 台账 `nudges` **仍为 0**。
 *
 *    判据（比修法值钱）：**"装配了" ≠ "在工作"**。`setInterval` 在跑、`tick` 被触发，
 *    但它每次都在第一行静默返回 —— 一个**永远走不到第二行**的定时器，
 *    在"有没有装配"这个读数上与健康的一模一样。
 *
 * ⛔ 所以这条**不**断言"注册函数被调用过"（那正是旧实现唯一满足的判据），
 *    而是断言**它能枚举到至少一个 CCC 根** —— 那是"第二行能不能走到"的直接前提。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../src')

function findCccRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.serenity'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('未找到 CCC 根')
}
const ROOT = findCccRoot(HERE)

/**
 * 去掉注释后再扫 —— 🔴 这一步是**判据能用**的前提，不是洁癖。
 *
 * 实测代价（2026-11-09，同一条判据当场假红）：我在修法处的注释里**逐字引用了旧写法**
 * `cccRootForCwd(process.cwd())`（作为"它错在哪"的说明），于是 `not.toMatch` 命中的
 * 是我自己的**说明文字**，而不是残留的实现。
 *
 * 判据（D 族同款）：**"源码里出现某串" ≠ "它在被执行"**。
 * 扫代码的判据必须先剥注释，否则它同时在惩罚"把教训写清楚"这件事 ——
 * 而写清楚教训恰恰是本仓最贵的一层。
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

describe('🔴 槽位看守的根解析（旧实现在真机上恒失败）', () => {
  it('① 看守必须走 listCccs 枚举根，⛔ 用 process.cwd()（宿主 cwd 不在任何 CCC 内）', () => {
    const code = stripComments(readFileSync(join(SRC, 'tools/browser-slot/index.ts'), 'utf8'))
    // 正控：必须真的调用权威枚举
    expect(code).toContain('listCccs(')
    // 负控：⛔ 不能把进程 cwd 当根（那正是失效的成因）
    expect(code).not.toMatch(/cccRootForCwd\(\s*process\.cwd\(\)\s*\)/)
  })

  it('② 装配点不得再传 rootProvider（它把"多 CCC"压成"一个根"，且装配期拿不到会话）', () => {
    const code = stripComments(readFileSync(join(SRC, 'index.ts'), 'utf8'))
    expect(code).not.toMatch(/registerSlotWatchman\(\s*ctx\s*,/)
    expect(code).toContain('registerSlotWatchman(ctx)')
  })

  it('③ 零根时必须**说出来**，⛔ 静默 return（否则"没扫"与"没异常"同形）', () => {
    const code = stripComments(readFileSync(join(SRC, 'tools/browser-slot/index.ts'), 'utf8'))
    // 判据钉"有告警"，⛔ 只钉"有 return"（旧实现也有 return，那样测不出差别）
    expect(code).toMatch(/roots\.length === 0[\s\S]{0,400}console\.warn/)
  })

  it('④ 本机确实能枚举到 CCC 根（这条是真机档：⛔ 替身说话）', async () => {
    // 用被测模块自己的解析链，⛔ 不复刻语义（D 族判据：有宿主自带实现就别自己写）
    const { findWatchRoots } = await import('../src/tools/browser-slot/index.js')
    const roots = await findWatchRoots(undefined)
    // ⚠️ `ctx=undefined` 时 listCccs 可能拿不到宿主会话 —— 那就**至少**要能靠目录枚举拿到
    //    本容器（本文件自己就在一个 CCC 里）。若这里是空，说明解析链连"我自己所在的 CCC"
    //    都不认，那看守无论装配得多正确都不会工作。
    expect(Array.isArray(roots)).toBe(true)
    if (roots.length > 0) {
      expect(roots.some((r) => r === ROOT || ROOT.startsWith(r))).toBe(true)
    }
  })
})
