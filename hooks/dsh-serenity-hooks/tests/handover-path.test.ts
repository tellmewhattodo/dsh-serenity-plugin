/**
 * handover-path.test.ts — **机械选路**（2026-11-16 owner 裁定 1）
 *
 * ## 它守的是什么
 * `rebuild` 与 `reconstruct` 对**会话本身**是同一件事（把它换掉），对**轨迹**也是同一件事
 * （判断不动、只换讲者）。差别只在机械后果。⇒ 走哪条路是**机械的账**，
 * 会话不参与、不感知、注入文案也**不许提**（断言见 keeper.test.ts 的 HANDOVER 组）。
 *
 * ## 判据（顺序不可换）
 *   累计用量超限 ⇒ `new-log`（原地清空**不会让累计量回落** —— 换讲者不解决日志太大）
 *   仅上下文超限 ⇒ `in-place`（更便宜：不新建会话、不归档、id 不变）
 *   **同时触发 ⇒ `new-log`**（裁定 1：反正迟早要超，一次做到位少一次中断）
 */
import { describe, it, expect } from 'vitest'
import { selectHandoverPath } from '../src/trajectory/reconstruct.js'

describe('selectHandoverPath：机械选路', () => {
  it('两个量都没超 ⇒ null（不需要交接）', () => {
    expect(selectHandoverPath({ contextOver: false, totalOver: false })).toBeNull()
  })

  it('仅上下文超限 ⇒ in-place（更便宜：id 不变、不归档）', () => {
    expect(selectHandoverPath({ contextOver: true, totalOver: false })).toBe('in-place')
  })

  it('🔴 仅累计用量超限 ⇒ new-log（原地清空不会让累计量回落）', () => {
    expect(selectHandoverPath({ contextOver: false, totalOver: true })).toBe('new-log')
  })

  it('🔴 两个同时触发 ⇒ new-log（owner 裁定 1：一次做到位）', () => {
    expect(selectHandoverPath({ contextOver: true, totalOver: true })).toBe('new-log')
  })

  /**
   * 🔴 变异靶子：把「同时触发」判成分支顺序相反（先判 contextOver）⇒ 本用例精确红，
   *    而其余三条仍绿 —— 证明本用例**只**守这一条裁定，不与其它三条互相掩护。
   */
  it('🔴 反向钉：同时触发**不得**降级为 in-place', () => {
    expect(selectHandoverPath({ contextOver: true, totalOver: true })).not.toBe('in-place')
  })
})
