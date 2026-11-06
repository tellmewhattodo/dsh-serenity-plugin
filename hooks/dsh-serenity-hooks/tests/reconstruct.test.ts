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
  reconstructReminderText,
  makeReconstructWhen,
  queueReconstruct,
  registerReconstructTurnHook,
  pendingReconstructSnapshot,
  reconstructDiagSnapshot,
  __resetReconstructDiagForTest,
  __resetPendingReconstructForTest,
  type TokenTotals,
} from '../src/trajectory/reconstruct.js'

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

describe('reconstruct: 注入文案', () => {
  it('含会话 id ＋ 动作名 ＋ "过于庞大"语义 ＋ 与 rebuild 的区别；不含 token 数值（D64）', () => {
    const t = reconstructReminderText('session-abc123')
    expect(t).toContain('session-abc123')
    expect(t).toContain('reconstruct')
    expect(t).toContain('too large')
    expect(t).toContain('rebuild')
    // D64：不透露上下文消耗/阈值数值
    expect(t).not.toMatch(/\b1000000000\b/)
    expect(t).not.toMatch(/\b1e9\b/)
    expect(t).not.toContain('1391')
  })

  it('是单一事件 token（[RECONSTRUCT]），与 keeper 的其他提醒可区分', () => {
    expect(reconstructReminderText('s')).toContain('[RECONSTRUCT]')
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
