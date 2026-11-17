/**
 * reconstruct.test.ts — 载体换代（v1.121.0，owner 2026-11-06 令）
 *
 * 判据的重点不在"函数能跑"，而在**三个会静默失效的地方**：
 *  ① 累计口径（四桶全加 vs 只读 `uncachedInputTokens`）—— 后者差 37 倍，
 *     会让阈值 10 亿**永远不触发**，而两个读数在代码里长得一样；
 *  ② `when` 回调**绝不抛**（宿主契约：rejection fails step preparation）；
 *  ③ 未达阈值时**不放出**（fail-closed）。
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  RECONSTRUCT_TOKEN_THRESHOLD,
  readTokenTotals,
  cumulativeTokens,
  shouldOfferReconstruct,
  makeReconstructWhen,
  queueReconstruct,
  registerReconstructTurnHook,
  pendingReconstructSnapshot,
  reconstructDiagSnapshot,
  __resetReconstructDiagForTest,
  __resetPendingReconstructForTest,
  type TokenTotals,
} from '../src/trajectory/reconstruct.js'
// 🔴 1.A（owner 2026-11-17）：交接提醒的唯一实现住在 keeper 那一侧，
//    `reconstruct` 侧不再有自己的注入文案（原 `reconstructReminderText` 已删）。
import { handoverReminderText } from '../src/seams/cognitive-trajectory-lifecycle.js'

/** 造一个只有 `sessionProjections` 的 ctx */
function ctxWithTotals(totals: Partial<TokenTotals> | null | undefined): unknown {
  if (totals === null || totals === undefined) {
    return { get: () => undefined }
  }
  return {
    get: (name: string) => name === 'sessionProjections'
      ? { snapshot: () => ({ values: { tokenUsage: totals } }) }
      : undefined,
  }
}

const SAMPLE: TokenTotals = {
  uncachedInputTokens: 37_032_940,
  outputTokens: 3_010_946,
  cacheReadTokens: 1_351_161_984,
  cacheWriteTokens: 0,
}

afterEach(() => {
  __resetReconstructDiagForTest()
  __resetPendingReconstructForTest()
})

describe('reconstruct: 累计口径（这是本功能最容易判错的一格）', () => {
  it('cumulativeTokens = 四桶全加（2026-11-06 本机会话实测 1391 M 级）', () => {
    // 读数出处：`~/.dsh/storages/session_projcache/sessions/session-afc28ede…json`
    // 的 `tokenUsage.totals`（宿主自己维护的那一份，⛔ 不是我的探针构造的）
    expect(cumulativeTokens(SAMPLE)).toBe(1_391_205_870)
  })

  it('🔴 变异靶子：只读 uncachedInputTokens 必须**远小于**四桶（差 37 倍）', () => {
    // 这条判据的存在理由：若实现退化成"只读未命中缓存的那一格"，
    // 阈值 1e9 对这条会话**永远不触发**，而单测若只断言"能读到数"依然全绿。
    const four = cumulativeTokens(SAMPLE)
    expect(SAMPLE.uncachedInputTokens).toBeLessThan(four / 30)
    // 四桶口径下这条会话**已过阈值**（这正是 owner 说"我这有好几个十亿的"那条会话）
    expect(four).toBeGreaterThan(RECONSTRUCT_TOKEN_THRESHOLD)
    // 只读 buckets 的话**远不到** ⇒ 两种口径给出相反的结论
    expect(SAMPLE.uncachedInputTokens).toBeLessThan(RECONSTRUCT_TOKEN_THRESHOLD)
  })

  it('四桶全加口径 = 宿主界面 pill 的口径（三桶输入 + 输出）', () => {
    // 宿主 `dsh-client-ui-chat` 的 `billedInputTokens = uncachedInput + cacheRead + cacheWrite`，
    // pill 显示 `billedInputTokens + outputTokens` —— 本函数必须与它逐字同口径。
    const billedInput = SAMPLE.uncachedInputTokens + SAMPLE.cacheReadTokens + SAMPLE.cacheWriteTokens
    expect(cumulativeTokens(SAMPLE)).toBe(billedInput + SAMPLE.outputTokens)
  })
})

describe('reconstruct: readTokenTotals（投影读取）', () => {
  it('sessionProjections 未装配 → null（⛔ 不回报 0：0 会让"读不到"与"真的是 0"同形）', () => {
    expect(readTokenTotals({ get: () => undefined } as never, { id: 's' })).toBeNull()
  })

  it('投影里没有 tokenUsage 这一格 → null', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: {} }) }
        : undefined,
    } as never
    expect(readTokenTotals(ctx, { id: 's' })).toBeNull()
  })

  it('装配时读到四桶原值', () => {
    expect(readTokenTotals(ctxWithTotals(SAMPLE), { id: 's' })).toEqual(SAMPLE)
  })

  it('缺字段按 0 补（字段名与日志里的 usage 不同：inputTokens → uncachedInputTokens）', () => {
    const r = readTokenTotals(ctxWithTotals({ uncachedInputTokens: 5 }), { id: 's' })
    expect(r).toEqual({
      uncachedInputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('投影读取抛错 → null（不炸穿调用方，尤其不能炸穿 `when`）', () => {
    const ctx = {
      get: () => ({ snapshot: () => { throw new Error('boom') } }),
    } as never
    expect(readTokenTotals(ctx, { id: 's' })).toBeNull()
  })
})

describe('reconstruct: 阈值判定', () => {
  it('恰好等于阈值 ⇒ 满足（≥，不是 >）', () => {
    const totals: TokenTotals = {
      uncachedInputTokens: RECONSTRUCT_TOKEN_THRESHOLD,
      outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    expect(shouldOfferReconstruct(ctxWithTotals(totals), { id: 's' })).toBe(true)
  })

  it('差 1 ⇒ 不满足', () => {
    const totals: TokenTotals = {
      uncachedInputTokens: RECONSTRUCT_TOKEN_THRESHOLD - 1,
      outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    expect(shouldOfferReconstruct(ctxWithTotals(totals), { id: 's' })).toBe(false)
  })

  it('读不到投影 ⇒ 不满足（fail-closed，与其余可见性判据同向）', () => {
    expect(shouldOfferReconstruct({ get: () => undefined } as never, { id: 's' })).toBe(false)
  })

  it('阈值是 10 亿（owner 2026-11-06 裁；⛔ 不要改成 100 万）', () => {
    // 判据：同机另一条会话（platform-9063）实测 322 M ⇒ 100 万对它是**恒真**
    // ⇒ 一旦改成 100 万，"达阈值才出现"这个机制等于不存在（而它看起来完全正常）
    expect(RECONSTRUCT_TOKEN_THRESHOLD).toBe(1_000_000_000)
    expect(RECONSTRUCT_TOKEN_THRESHOLD).toBeGreaterThan(322_000_000)
  })
})

/**
 * 🔴 **2026-11-17 owner 裁定 1.A：交接提醒只指名 `rebuild`，⛔ 绝不出现 `reconstruct`。**
 *
 * 这一组替代原先「reconstruct 注入文案」的两条用例 —— 那个函数
 * （`reconstructReminderText`）**自 v1.121.0 起从未接线**（全仓零调用点，只有测试在调），
 * 已随本版删除。留着它 = 第二真相源（D151：有函数、有测试、没有接线）。
 *
 * 新判据的承重点不是"文案好读"，而是**注入面与实际执行面不能脱节**：
 * 模型只该知道**一个**动作名；"走哪条路"由 `case 'rebuild'` 的机械改道算，
 * 不由模型猜。⇒ 断言必须是**双向**的（正向有 rebuild ＋ 反向无 reconstruct），
 * 只断正向的话，把两个名字都塞进去照样绿。
 */
describe('交接提醒（1.A：只指名 rebuild，机械层负责改道）', () => {
  it('🔴 正向：指名 `cognitive_trajectory rebuild`（模型只需这一个动作名）', () => {
    expect(handoverReminderText()).toContain('cognitive_trajectory rebuild')
    expect(handoverReminderText(true)).toContain('cognitive_trajectory rebuild')
  })

  it('🔴 反向：**绝不出现 `reconstruct`** —— 那是机械改道的事，不该让模型去选', () => {
    // 逐字钉：一旦有人把 reconstruct 塞回注入文案，这条立刻红
    expect(handoverReminderText()).not.toContain('reconstruct')
    expect(handoverReminderText(true)).not.toContain('reconstruct')
  })

  it('D64：不透露 token 数值（模型无法据以行动，且占用注意力）', () => {
    const t = handoverReminderText()
    expect(t).not.toMatch(/\b1000000000\b/)
    expect(t).not.toMatch(/\b1e9\b/)
    expect(t).not.toContain('1391')
  })

  it('升级态与常规态都指向 `LOG/LOG.md` 的交接便签（落点是同一块地）', () => {
    expect(handoverReminderText()).toContain('LOG/LOG.md')
    expect(handoverReminderText(true)).toContain('LOG/LOG.md')
  })
})

describe('reconstruct: makeReconstructWhen（宿主契约要求"绝不抛"）', () => {
  it('未达阈值 → false', () => {
    const when = makeReconstructWhen(ctxWithTotals({ uncachedInputTokens: 1 }))
    expect(when({ agent: { session: { id: 's', header: { cwd: '/nonexistent' } } } as never })).toBe(false)
  })

  it('达阈值 → true', () => {
    const when = makeReconstructWhen(ctxWithTotals(SAMPLE))
    expect(when({ agent: { session: { id: 's', header: { cwd: '/nonexistent' } } } as never })).toBe(true)
  })

  it('没有 agent / 没有 session → false，不抛', () => {
    const when = makeReconstructWhen(ctxWithTotals(SAMPLE))
    expect(when({})).toBe(false)
    expect(when({ agent: {} as never })).toBe(false)
  })

  it('🔴 投影读取抛错时**绝不抛出**（宿主：rejection fails step preparation）', () => {
    const ctx = { get: () => ({ snapshot: () => { throw new Error('boom') } }) } as never
    const when = makeReconstructWhen(ctx)
    expect(() => when({ agent: { session: { id: 's' } } as never })).not.toThrow()
    expect(when({ agent: { session: { id: 's' } } as never })).toBe(false)
  })

  it('session 缺 header.cwd 也绝不抛（cccRootForCwd 拿到 undefined 的路径）', () => {
    const when = makeReconstructWhen(ctxWithTotals(SAMPLE))
    expect(() => when({ agent: { session: { id: 's' } } as never })).not.toThrow()
  })
})

describe('reconstruct: 排队（与 rebuild 同语义：turn 结束时才执行）', () => {
  it('定位不到 dsh 会话 ⇒ 抛（响亮失败，⛔ 不静默排队）', () => {
    const ctx = { sessions: { get: () => undefined } } as never
    expect(() => queueReconstruct(ctx, {
      root: '/tmp/none', summary: 'x', dshSessionId: 'session-x',
    })).toThrow(/Unable to locate dsh session/)
  })

  it('会话在但定位不到活跃 SESSION.md ⇒ 抛，且报出查过哪几面', () => {
    const ctx = { sessions: { get: () => ({ id: 'session-x', surface: { nodes: [] } }) } } as never
    let msg = ''
    try {
      queueReconstruct(ctx, { root: '/tmp/definitely-not-a-ccc', summary: 'x', dshSessionId: 'session-x' })
    } catch (e) {
      msg = String((e as Error).message)
    }
    expect(msg).toContain('Unable to determine the active SESSION.md')
    expect(msg).toContain('.dsh_session_bind')
    expect(msg).toContain('cognitive_trajectory use')
  })
})

describe('reconstruct: turn-stopping 钩子（无 pending 零开销）', () => {
  it('没有排队条目 ⇒ 什么都不做（不抛、不写诊断）', () => {
    const listeners: Array<(p: { agent?: unknown }) => void> = []
    const ctx = { on: (name: string, fn: (p: { agent?: unknown }) => void) => {
      if (name === 'agent/turn-stopping') listeners.push(fn)
    } } as never
    registerReconstructTurnHook(ctx)
    expect(listeners).toHaveLength(1)
    expect(() => listeners[0]!({ agent: { id: 'nobody', session: {} } })).not.toThrow()
    expect(pendingReconstructSnapshot().size).toBe(0)
    expect(reconstructDiagSnapshot().queuedCount).toBe(0)
  })

  it('ctx 没有 `on` ⇒ 静默跳过（不炸启动）', () => {
    expect(() => registerReconstructTurnHook({} as never)).not.toThrow()
  })
})
