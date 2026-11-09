/**
 * browser-slot-service.test.ts — 槽位编排（acquire/release/list/nudge/doctor）
 *
 * 🔴 本文件最重要的不是"函数能跑"，而是 owner 要的那条**闭环**：
 *    槽位异常（长期不动 / CPU 过高）⇒ **反过来向占用它的会话注入一条消息**。
 *    ⇒ `nudgeStaleSlots` 的注入器是**可注入依赖**，这里用一个记录器替身验证：
 *      ① 该提醒的槽位**都**被提醒了；② 不该提醒的**一条都没**；③ 提醒文本带具体动作；
 *      ④ 提醒后记账（冷却生效，不会每 tick 刷屏）。
 *
 * ⛔ 不起真 Chrome：`acquire` 在找不到浏览器时会失败并**回滚台账**，那本身也是一条要验的行为。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireSlot,
  doctorSlots,
  listSlots,
  nudgeStaleSlots,
  reapSlot,
  releaseSlot,
  slotStatus,
  touchSlot,
} from '../src/browser/service.js'
import { readLedger, withLedger } from '../src/browser/ledger.js'
import { DEFAULT_POLICY, type SlotLease, type SlotPolicy } from '../src/browser/state.js'

let root = ''
const SESS = 'sess-me'
const TRAJ = '2026-01-01--S999--demo'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slot-svc-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 直接往台账里塞一条占用（绕过 acquire，因为这里不 spawn Chrome） */
function seed(slot: number, over: Partial<SlotLease> = {}): void {
  withLedger(root, (lg) => {
    lg.leases[String(slot)] = {
      slot,
      sessionId: over.sessionId ?? SESS,
      trajectory: over.trajectory ?? TRAJ,
      leasedAt: over.leasedAt ?? Date.now(),
      lastActionAt: over.lastActionAt ?? Date.now(),
      nudges: over.nudges ?? 0,
      lastNudgeAt: over.lastNudgeAt ?? 0,
      pid: over.pid ?? 0,
    }
    return { ledger: lg, result: null }
  })
}

describe('acquire：同会话复用，⛔ 不租第二个', () => {
  it('① 已有占用 ⇒ reused=true 且槽位号不变（这条防的是"租了忘退"的静默泄漏）', async () => {
    seed(4, { sessionId: SESS })
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ })
    expect(res.reused).toBe(true)
    expect(res.slot).toBe(4)
    // 负控：台账里仍然只有这一个槽位（没有新增第二个）
    expect(Object.keys(readLedger(root).leases)).toEqual(['4'])
  })

  it('② 指定一个已被别人占用的槽位 ⇒ 拒绝，⛔ 抢占', async () => {
    seed(2, { sessionId: 'other-session' })
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ, want: 2 })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('已被占用')
    // 台账未变：占着的人还是别人
    expect(readLedger(root).leases['2']?.sessionId).toBe('other-session')
  })

  it('③ 20 个槽位全满 ⇒ 拒绝，且**指出该查什么**（idleMin 最大的那一行）', async () => {
    for (let i = 1; i <= 20; i++) seed(i, { sessionId: `s${i}` })
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('20 个槽位已全部占用')
    expect(res.detail).toContain('release')
  })
})

describe('release：只许释放自己的', () => {
  it('④ 释放别人的槽位 ⇒ 拒绝，且台账不变（否则"互相踩"会变成合法动作）', () => {
    seed(3, { sessionId: 'other-session' })
    const r = releaseSlot(root, SESS, 3)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('不属于你')
    expect(readLedger(root).leases['3']?.sessionId).toBe('other-session')
  })

  it('⑤ 释放自己的 ⇒ 记录消失', () => {
    seed(3, { sessionId: SESS })
    const r = releaseSlot(root, SESS, 3)
    expect(r.ok).toBe(true)
    expect(readLedger(root).leases['3']).toBeUndefined()
  })

  it('⑥ 释放一个本就空的槽位 ⇒ 视为成功且说明原因（⛔ 报错 —— 那不是错误）', () => {
    const r = releaseSlot(root, SESS, 7)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('本就无人占用')
  })
})

describe('reap：兜底回收（与 release 的区别 = 须记原因）', () => {
  it('⑦ 能回收别人占的槽位（这是兜底的意义），且台账清空', () => {
    seed(5, { sessionId: 'gone-session' })
    const r = reapSlot(root, 5, '占用者已不在')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('占用者已不在')
    expect(readLedger(root).leases['5']).toBeUndefined()
  })
})

describe('list / status：占用归属可读', () => {
  it('⑧ list 返回全部 20 个槽位（含空槽），占用者信息在位', () => {
    seed(9, { sessionId: 'abc', trajectory: 'traj-9' })
    const { views } = listSlots(root)
    expect(views.length).toBe(20)
    const v9 = views.find((v) => v.slot === 9)!
    expect(v9.state).not.toBe('free')
    expect(v9.sessionId).toBe('abc')
    expect(v9.trajectory).toBe('traj-9')
    // 负控：其它槽位必须是 free
    expect(views.filter((v) => v.state === 'free').length).toBe(19)
  })

  it('⑨ status 越界返回 null（⛔ 抛错）', () => {
    expect(slotStatus(root, 0)).toBeNull()
    expect(slotStatus(root, 21)).toBeNull()
    expect(slotStatus(root, 1)?.slot).toBe(1)
  })
})

describe('🔴 反向注入闭环（owner 要的那条）', () => {
  const fast: SlotPolicy = { ...DEFAULT_POLICY, idleMs: 60_000, nudgeCooldownMs: 60_000 }

  it('⑩ 闲置超阈值 ⇒ **向占用它的轨迹**注入一条提醒，文本写明具体动作', async () => {
    seed(1, { lastActionAt: Date.now() - 5 * 60_000, trajectory: TRAJ })
    const calls: Array<{ target: string; msg: string }> = []
    const out = await nudgeStaleSlots(
      root,
      async (_r, target, msg) => {
        calls.push({ target, msg })
        return { ok: true, detail: 'injected' }
      },
      fast,
    )
    expect(out.nudged.length).toBe(1)
    expect(calls.length).toBe(1)
    // 注入目标 = 占用者的轨迹（⛔ 不是"所有人"）
    expect(calls[0]!.target).toBe(TRAJ)
    // 文本必须带**可执行动作**，⛔ 只说"你的槽位异常了"
    expect(calls[0]!.msg).toContain('b1')
    expect(calls[0]!.msg).toContain('release')
    // 文本必须给出阈值（收到的人要知道自己越了哪条线）
    expect(calls[0]!.msg).toContain('CPU')
  })

  it('⑪ 状态正常 ⇒ 一条都不注入（负控：证明上面的命中不是恒真）', async () => {
    seed(1, { lastActionAt: Date.now() })
    const calls: string[] = []
    const out = await nudgeStaleSlots(
      root,
      async (_r, target) => {
        calls.push(target)
        return { ok: true, detail: 'ok' }
      },
      fast,
    )
    expect(out.nudged.length).toBe(0)
    expect(calls.length).toBe(0)
  })

  it('⑫ 提醒后记账 ⇒ 冷却期内不再重复注入（否则每 tick 叫一次，占用者会被淹没）', async () => {
    seed(1, { lastActionAt: Date.now() - 5 * 60_000, trajectory: TRAJ })
    let n = 0
    const inj = async () => {
      n += 1
      return { ok: true, detail: 'ok' }
    }
    await nudgeStaleSlots(root, inj, fast)
    expect(n).toBe(1)
    // 立刻再跑一轮 —— 冷却未过 ⇒ 不该再注入
    await nudgeStaleSlots(root, inj, fast)
    expect(n).toBe(1)
    expect(readLedger(root).leases['1']?.nudges).toBe(1)
  })

  it('⑬ 无归属的槽位 ⇒ 如实报"无法注入"，⛔ 静默跳过', async () => {
    seed(6, { lastActionAt: Date.now() - 5 * 60_000, sessionId: '', trajectory: '' })
    const out = await nudgeStaleSlots(root, async () => ({ ok: true, detail: 'ok' }), fast)
    expect(out.nudged.length).toBe(1)
    expect(out.nudged[0]!.delivered).toBe(false)
    expect(out.nudged[0]!.detail).toContain('无法注入')
  })
})

describe('touchSlot 与 doctor', () => {
  it('⑭ touch 推进 lastActionAt（这是"是否长期不动作"的唯一判据来源）', () => {
    const old = Date.now() - 10 * 60_000
    seed(8, { lastActionAt: old })
    touchSlot(root, 8)
    expect(readLedger(root).leases['8']!.lastActionAt).toBeGreaterThan(old)
  })

  it('⑮ doctor 只读：不改任何台账，且 verdict 是 clean 或 drift 之一', () => {
    seed(2, { sessionId: 'x', pid: 0 })
    const before = JSON.stringify(readLedger(root).leases)
    const d = doctorSlots(root) as Record<string, unknown>
    expect(JSON.stringify(readLedger(root).leases)).toBe(before)
    expect(['clean', 'drift']).toContain(d.verdict as string)
    expect(d.ledger).toBeTruthy()
  })
})
