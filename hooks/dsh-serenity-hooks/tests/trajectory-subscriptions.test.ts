/**
 * trajectory-subscriptions.test.ts — 轨迹消息订阅（v1.107.0，owner 2026-11-01 令）
 *
 * ## 本文件钉的三件事（按重要性排序）
 *
 * 1. 🔴 **方向不能反**：`watcher` 是**收**通知的，`members` 是**被盯**的。
 *    写反了照样能跑、只是通知发给错的人 —— 没有机械信号。故有一组专门钉方向。
 * 2. 🔴 **只有 running → idle 才算「一轮结束」**。宿主进程刚起时直接收到 `idle`
 *    （载体被载入即 idle）**不是**一轮结束 —— 那条钉子在 `registerTrajectorySubscriptions` 组。
 * 3. 🔴 **三个失败面各自显形**：没绑轨迹的会话（跳过、不报错）／ 观察者唤不醒（响亮）／
 *    投递返回失败（响亮＋计数）。
 *
 * ## 为什么用假 deps 而不是真宿主
 *
 * 本模块的设计就是「业务处理」与「事件适配」分离（见源文件文件头）。业务那一半
 * **完全不需要宿主**，喂 sessionId 即可 ⇒ 用假 deps 测它，测的是真逻辑而不是替身。
 * 事件适配那一半（`registerTrajectorySubscriptions`）用一个极小的假 ctx（只需 `on`）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  pickSubscriptionsFor,
  buildSubscriptionText,
  onTurnFinished,
  registerTrajectorySubscriptions,
  subscriptionStats,
  subscriptionEval,
  __resetSubscriptionStatsForTest,
  __resetSubscriptionEvalForTest,
  type SubscriptionDeps,
} from '../src/trajectory/subscriptions.js'
import { readTrajectorySubscriptions, type TrajectorySubscription } from '../src/kernel/ccc.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subs-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  __resetSubscriptionStatsForTest()
  __resetSubscriptionEvalForTest()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeCccConfig(value: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(value))
}

/** 假 deps：三个失败面都能单独造出来 */
function deps(over: Partial<SubscriptionDeps> = {}): SubscriptionDeps {
  return {
    rootForSession: () => '/ccc',
    readSubs: () => ({ subs: [], problems: [] }),
    dirForSession: () => null,
    deliver: async () => ({ ok: true }),
    iso: (ms) => `T${ms}`,
    warn: () => {},
    ...over,
  }
}

const SUB: TrajectorySubscription = { watcher: 'W', members: ['A', 'B'], enabled: true }

describe('trajectory-subscriptions: 读配置（判据 + 坏项逐条显形）', () => {
  it('合法配置原样读出', () => {
    writeCccConfig({ trajectorySubscriptions: [{ watcher: 'W', members: ['A', 'B'] }] })
    const { subs, problems } = readTrajectorySubscriptions(dir)
    expect(problems).toEqual([])
    expect(subs).toHaveLength(1)
    expect(subs[0]!.watcher).toBe('W')
    expect(subs[0]!.members).toEqual(['A', 'B'])
  })

  it('🔴 坏项**不许静默**：写法不成立的条目进 problems（写了但不生效 = 静默失效）', () => {
    writeCccConfig({
      trajectorySubscriptions: [
        { watcher: '', members: ['A'] }, // watcher 空
        { members: ['A'] }, // 缺 watcher
        { watcher: 'W' }, // 缺 members
        { watcher: 'W', members: [] }, // members 空
        { watcher: 'W', members: ['A'] }, // ✅ 唯一合法的
      ],
    })
    const { subs, problems } = readTrajectorySubscriptions(dir)
    expect(subs).toHaveLength(1)
    expect(problems).toHaveLength(4) // 四个坏项各自一条
  })

  it('🔴 members 含 watcher 自己 ⇒ 剔掉并报告（否则自激：自己每轮结束通知自己）', () => {
    writeCccConfig({ trajectorySubscriptions: [{ watcher: 'W', members: ['W', 'A'] }] })
    const { subs, problems } = readTrajectorySubscriptions(dir)
    expect(subs[0]!.members).toEqual(['A'])
    expect(problems.some((p) => p.includes('自激'))).toBe(true)
  })

  it('只含 watcher 自己 ⇒ 整条不生效（合法结论：它没有实际要盯的东西）', () => {
    writeCccConfig({ trajectorySubscriptions: [{ watcher: 'W', members: ['W'] }] })
    const { subs, problems } = readTrajectorySubscriptions(dir)
    expect(subs).toHaveLength(0)
    expect(problems.some((p) => p.includes('自激'))).toBe(true)
  })

  it('enabled:false ⇒ 不生效', () => {
    writeCccConfig({ trajectorySubscriptions: [{ watcher: 'W', members: ['A'], enabled: false }] })
    expect(readTrajectorySubscriptions(dir).subs).toHaveLength(0)
  })

  it('缺省（无该键）⇒ 空表且零坏项（fail-open：不订阅 ≠ 危险）', () => {
    writeCccConfig({})
    expect(readTrajectorySubscriptions(dir)).toEqual({ subs: [], problems: [] })
  })
})

describe('trajectory-subscriptions: 🔴 方向不能反（watcher 收，members 被盯）', () => {
  it('成员命中 ⇒ 通知 watcher；**非成员不触发**', () => {
    expect(pickSubscriptionsFor([SUB], 'A')).toEqual([SUB])
    expect(pickSubscriptionsFor([SUB], 'Z')).toEqual([]) // Z 不在 members 里
  })

  it('🔴 watcher 自己一轮结束**不触发**自己的订阅（它不是自己的成员）', () => {
    // 这是"方向写反"最典型的后果：若把 watcher 当成员，自己的轮次会触发自己
    expect(pickSubscriptionsFor([SUB], 'W')).toEqual([])
  })

  it('同一 watcher 的两条订阅都命中 ⇒ 两条都返回（note 不同，用户配两条就该收两条）', () => {
    const a: TrajectorySubscription = { watcher: 'W', members: ['A'], note: '一' }
    const b: TrajectorySubscription = { watcher: 'W', members: ['A'], note: '二' }
    expect(pickSubscriptionsFor([a, b], 'A')).toHaveLength(2)
  })
})

describe('trajectory-subscriptions: 通知正文', () => {
  it('🔴 带定位信息，但**不带"它做了什么"**（owner：不需要带它做了什么）', () => {
    const text = buildSubscriptionText('2026-01-01--S1--x', SUB, 1000, (ms) => `T${ms}`)
    expect(text).toContain('2026-01-01--S1--x') // 谁
    expect(text).toContain('T1000') // 什么时候
    expect(text).toContain('不是指令') // 性质：通知不是控制
    // ⛔ 不得出现对"它干了什么"的描述（本机制刻意不解析对方产出）
    expect(text).not.toContain('SESSION.md')
    expect(text).not.toContain('产出')
  })

  it('有 note 时带上（让观察者分辨是哪条订阅触发的）', () => {
    const withNote: TrajectorySubscription = { ...SUB, note: '盯部署' }
    expect(buildSubscriptionText('m', withNote, 0, (ms) => `T${ms}`)).toContain('盯部署')
    expect(buildSubscriptionText('m', SUB, 0, (ms) => `T${ms}`)).not.toContain('订阅说明')
  })
})

describe('trajectory-subscriptions: onTurnFinished 三个失败面', () => {
  it('① 会话不在任何 CCC ⇒ skipped=no-ccc，且**不报警**（这不是错误）', async () => {
    const warn = vi.fn()
    const r = await onTurnFinished(deps({ rootForSession: () => null, warn }), 's1', 0)
    expect(r.skipped).toBe('no-ccc')
    expect(warn).not.toHaveBeenCalled()
  })

  it('① 没有订阅 ⇒ skipped=no-subscriptions（零成本路径）', async () => {
    const r = await onTurnFinished(deps({ readSubs: () => ({ subs: [], problems: [] }) }), 's1', 0)
    expect(r.skipped).toBe('no-subscriptions')
  })

  it('🔴 ① 会话没绑轨迹 ⇒ skipped=unbound-member，且**不报警**（穷举噪声会淹没真失败）', async () => {
    const warn = vi.fn()
    const r = await onTurnFinished(
      deps({ readSubs: () => ({ subs: [SUB], problems: [] }), dirForSession: () => null, warn }),
      's1',
      0,
    )
    expect(r.skipped).toBe('unbound-member')
    expect(warn).not.toHaveBeenCalled()
  })

  it('绑了轨迹但不在任何订阅的 members 里 ⇒ 也算 unbound-member（不报警）', async () => {
    const warn = vi.fn()
    const r = await onTurnFinished(
      deps({ readSubs: () => ({ subs: [SUB], problems: [] }), dirForSession: () => 'Z', warn }),
      's1',
      0,
    )
    expect(r.skipped).toBe('unbound-member')
    expect(warn).not.toHaveBeenCalled()
  })

  it('🟢 命中 ⇒ 投递给 watcher，正文含成员名', async () => {
    const delivered: Array<{ root: string; target: string; message: string }> = []
    const r = await onTurnFinished(
      deps({
        readSubs: () => ({ subs: [SUB], problems: [] }),
        dirForSession: () => 'A',
        deliver: async (root, target, message) => {
          delivered.push({ root, target, message })
          return { ok: true }
        },
      }),
      's1',
      42,
    )
    expect(r).toMatchObject({ skipped: null, delivered: 1, failed: 0 })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.target).toBe('W') // 🔴 发给 watcher，不是发给成员
    expect(delivered[0]!.message).toContain('A')
    expect(delivered[0]!.root).toBe('/ccc') // 根来自会话解析，不是装配期固定
  })

  it('🔴 ②/③ 投递返回失败 ⇒ 计数 + **响亮告警**（"配了但从不生效"必须能被看见）', async () => {
    const warn = vi.fn()
    const r = await onTurnFinished(
      deps({
        readSubs: () => ({ subs: [SUB], problems: [] }),
        dirForSession: () => 'A',
        deliver: async () => ({ ok: false, detail: '观察者没有活跃会话' }),
        warn,
      }),
      's1',
      0,
    )
    expect(r).toMatchObject({ delivered: 0, failed: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('观察者没有活跃会话')
    expect(warn.mock.calls[0]![0]).toContain('W')
  })

  it('🔴 投递层**抛错**也算失败（不当成崩溃，但同样响亮）', async () => {
    const warn = vi.fn()
    const r = await onTurnFinished(
      deps({
        readSubs: () => ({ subs: [SUB], problems: [] }),
        dirForSession: () => 'A',
        deliver: async () => {
          throw new Error('boom')
        },
        warn,
      }),
      's1',
      0,
    )
    expect(r.failed).toBe(1)
    expect(warn.mock.calls[0]![0]).toContain('boom')
  })

  it('坏项在**触发时**也报（不只在启动时报一次）', async () => {
    const warn = vi.fn()
    await onTurnFinished(
      deps({ readSubs: () => ({ subs: [], problems: ['members 为空'] }), warn }),
      's1',
      0,
    )
    expect(warn.mock.calls.some((c) => String(c[0]).includes('members 为空'))).toBe(true)
  })

  it('投递计数可读（供 dashboard diag 后续读）', async () => {
    const d = deps({
      readSubs: () => ({ subs: [SUB], problems: [] }),
      dirForSession: () => 'A',
      deliver: async () => ({ ok: true }),
    })
    await onTurnFinished(d, 's1', 10)
    await onTurnFinished(d, 's1', 20)
    const stats = subscriptionStats()
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({ key: 'W←A', ok: 2, failed: 0, lastAt: 20 })
  })
})

describe('trajectory-subscriptions: 🔴 评估计数（判"机制在跑吗"的唯一读数）', () => {
  // 这一组防的是我自己第一版的缺陷：只有投递计数时，
  // **「机制没装配」与「装配了但从未命中」在面板上完全同形**（都是空表）。
  function fakeCtx(): { ctx: unknown; emit: (e: string, p: unknown) => void } {
    const handlers = new Map<string, (p: unknown) => void>()
    return {
      ctx: {
        on: (e: string, h: (p: unknown) => void) => {
          handlers.set(e, h)
        },
        effect: () => {},
      },
      emit: (e, p) => handlers.get(e)?.(p),
    }
  }

  it('🔴 收到事件本身就要计数（即便没有任何投递 —— 那是"在跑但没命中"的证据）', async () => {
    __resetSubscriptionEvalForTest()
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({ rootForSession: () => '/ccc', readSubs: () => ({ subs: [], problems: [] }) }),
    )
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'running' })
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'idle' })
    await new Promise((r) => setTimeout(r, 10))
    const e = subscriptionEval()
    expect(e.statusEvents).toBe(2)
    expect(e.runningSeen).toBe(1)
    expect(e.idleSeen).toBe(1)
    expect(e.turnFinished).toBe(1)
    // 没有订阅 ⇒ 跳过原因被记下来（这才能区分"没配"与"没跑"）
    expect(e.skips['no-subscriptions']).toBe(1)
  })

  it('🔴 没见 running 的 idle 记为独立原因（⛔ 不与"真一轮结束"混计）', async () => {
    __resetSubscriptionEvalForTest()
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(ctx, deps({ readSubs: () => ({ subs: [], problems: [] }) }))
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'idle' })
    await new Promise((r) => setTimeout(r, 10))
    const e = subscriptionEval()
    expect(e.turnFinished).toBe(0) // ⛔ 不得算成一轮结束
    expect(e.skips['idle-without-running']).toBe(1)
  })

  it('会话不在任何 CCC ⇒ 记 no-ccc 跳过（可与"没配订阅"区分开）', async () => {
    __resetSubscriptionEvalForTest()
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(ctx, deps({ rootForSession: () => null }))
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'running' })
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'idle' })
    await new Promise((r) => setTimeout(r, 10))
    expect(subscriptionEval().skips['no-ccc']).toBe(1)
  })

  it('绑了轨迹但不在任何 members 里 ⇒ 记 not-in-any-members（与"没绑轨迹"分开）', async () => {
    __resetSubscriptionEvalForTest()
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({
        rootForSession: () => '/ccc',
        readSubs: () => ({ subs: [SUB], problems: [] }),
        dirForSession: () => 'Z',
      }),
    )
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'running' })
    emit('agent/status', { agent: { session: { id: 's1' } }, status: 'idle' })
    await new Promise((r) => setTimeout(r, 10))
    expect(subscriptionEval().skips['not-in-any-members']).toBe(1)
  })
})

describe('trajectory-subscriptions: 🔴 registerTrajectorySubscriptions 只认 running→idle', () => {
  /** 极小假 ctx：只需要 `on` 与 `effect`（拆卸） */
  function fakeCtx(): { ctx: unknown; emit: (event: string, payload: unknown) => void; onCount: () => number } {
    const handlers = new Map<string, (p: unknown) => void>()
    return {
      ctx: {
        on: (e: string, h: (p: unknown) => void) => {
          handlers.set(e, h)
        },
        effect: () => {},
      },
      emit: (e, p) => handlers.get(e)?.(p),
      onCount: () => handlers.size,
    }
  }

  function payload(id: string, status: string): unknown {
    return { agent: { session: { id } }, status }
  }

  it('running → idle ⇒ 触发一次（deps 收到该会话）', async () => {
    const seen: string[] = []
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({ rootForSession: (id) => (seen.push(id), '/ccc'), readSubs: () => ({ subs: [], problems: [] }) }),
    )
    emit('agent/status', payload('s1', 'running'))
    emit('agent/status', payload('s1', 'idle'))
    // 等一拍（onTurnFinished 是异步的且刻意不 await）
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual(['s1'])
  })

  it('🔴 **没见过 running 的 idle 不算一轮结束**（进程刚起时载体载入即 idle）', async () => {
    const seen: string[] = []
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({ rootForSession: (id) => (seen.push(id), '/ccc'), readSubs: () => ({ subs: [], problems: [] }) }),
    )
    emit('agent/status', payload('s1', 'idle')) // 没有前置 running
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual([]) // ⛔ 不得触发
  })

  it('🔴 连续两次 idle ⇒ 只触发一次（状态跃迁只发生了一次）', async () => {
    const seen: string[] = []
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({ rootForSession: (id) => (seen.push(id), '/ccc'), readSubs: () => ({ subs: [], problems: [] }) }),
    )
    emit('agent/status', payload('s1', 'running'))
    emit('agent/status', payload('s1', 'idle'))
    emit('agent/status', payload('s1', 'idle'))
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual(['s1'])
  })

  it('两轮（running→idle→running→idle）⇒ 触发两次（不设频率上限）', async () => {
    const seen: string[] = []
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({ rootForSession: (id) => (seen.push(id), '/ccc'), readSubs: () => ({ subs: [], problems: [] }) }),
    )
    emit('agent/status', payload('s1', 'running'))
    emit('agent/status', payload('s1', 'idle'))
    emit('agent/status', payload('s1', 'running'))
    emit('agent/status', payload('s1', 'idle'))
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual(['s1', 's1'])
  })

  it('两个会话互不干扰（各自的 running/idle 独立记账）', async () => {
    const seen: string[] = []
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({ rootForSession: (id) => (seen.push(id), '/ccc'), readSubs: () => ({ subs: [], problems: [] }) }),
    )
    emit('agent/status', payload('a', 'running'))
    emit('agent/status', payload('b', 'idle')) // b 没有前置 running ⇒ 不触发
    emit('agent/status', payload('a', 'idle')) // a 触发
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual(['a'])
  })

  it('🔴 处理过程中的异常被捕获并告警（不留 unhandledRejection）', async () => {
    const warn = vi.fn()
    const { ctx, emit } = fakeCtx()
    registerTrajectorySubscriptions(
      ctx,
      deps({
        rootForSession: () => {
          throw new Error('root boom')
        },
        warn,
      }),
    )
    emit('agent/status', payload('s1', 'running'))
    emit('agent/status', payload('s1', 'idle'))
    await new Promise((r) => setTimeout(r, 10))
    expect(warn.mock.calls.some((c) => String(c[0]).includes('root boom'))).toBe(true)
  })

  it('🔴 宿主没有 agent/status 通道 ⇒ 响亮降级、不抛（apply 不可成为启动单点）', () => {
    const warn = vi.fn()
    const brokenCtx = {
      on: () => {
        throw new Error('no such event')
      },
      effect: () => {},
    }
    expect(() => registerTrajectorySubscriptions(brokenCtx, deps({ warn }))).not.toThrow()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('未装配'))).toBe(true)
  })
})
