/**
 * browser-slot-state.test.ts — 槽位状态机（纯逻辑）判据
 *
 * 🔴 为什么要单独测这一层：三种异常（长期不动 / CPU 过高 / 占用超时）**都导致同一个后果**
 *    —— 反向注入一条消息去打断一个正在干活的 agent。这个后果有代价，故判定必须能
 *    在**没有 Chrome、没有时钟、没有文件系统**的情况下被逐边界验到。
 *
 * 每条断言都配**负控**（把条件改成"不该触发"的那一侧），否则它只证明"函数能跑"。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY,
  MAX_SLOTS,
  SLOT_RESOLUTION,
  deriveSlotState,
  findLeaseBySession,
  nudgeText,
  pickFreeSlot,
  shouldNudge,
  slotLabel,
  slotNumber,
  slotPort,
  type SlotLease,
  type SlotPolicy,
} from '../src/browser/state.js'

const P: SlotPolicy = { ...DEFAULT_POLICY, idleMs: 15 * 60_000, leaseMaxMs: 2 * 60 * 60_000 }
const NOW = 1_000_000_000_000

function lease(over: Partial<SlotLease> = {}): SlotLease {
  return {
    slot: 1,
    sessionId: 'sess-a',
    trajectory: 'traj-a',
    leasedAt: NOW - 60_000,
    lastActionAt: NOW - 60_000,
    nudges: 0,
    lastNudgeAt: 0,
    pid: 1234,
    ...over,
  }
}

describe('槽位编号与端点（字面量钉死，防漂）', () => {  it('① 最多 20 个槽位，端口 9301 起（避开既有 browser MSM 的 9222..9299）', () => {
    expect(MAX_SLOTS).toBe(20)
    expect(slotPort(1)).toBe(9301)
    expect(slotPort(20)).toBe(9320)
    // 负控：不能落进 9222..9299 那一段（那里是既有实现的地盘，撞了会互相杀进程）
    expect(slotPort(1)).toBeGreaterThan(9299)
  })

  it('② 标号解析：b1 / 1 / B1 都认，越界与垃圾串返回 0', () => {
    expect(slotNumber('b1')).toBe(1)
    expect(slotNumber('b20')).toBe(20)
    expect(slotNumber('b21')).toBe(0)
    expect(slotNumber('b0')).toBe(0)
    expect(slotNumber('')).toBe(0)
    expect(slotNumber('abc')).toBe(0)
    expect(slotLabel(7)).toBe('b7')
  })

  it('③ 固定分辨率：同一槽位恒定，b1-b10 与 b11-b20 分档', () => {
    expect(SLOT_RESOLUTION(1)).toEqual({ width: 1600, height: 1000 })
    expect(SLOT_RESOLUTION(10)).toEqual({ width: 1600, height: 1000 })
    expect(SLOT_RESOLUTION(11)).toEqual({ width: 420, height: 900 })
    // 同一槽位调两次必须一致（这就是"固定"的定义）
    expect(SLOT_RESOLUTION(3)).toEqual(SLOT_RESOLUTION(3))
  })
})

describe('槽位状态判定（四种状态互相穷尽）', () => {
  it('④ 无占用者 ⇒ free（与进程死活无关）', () => {
    const r = deriveSlotState(null, { alive: true, cpuPct: 99, rssMb: 9000, at: NOW }, NOW, P)
    expect(r.state).toBe('free')
    expect(r.reasons).toEqual([])
  })

  it('⑤ 刚租下、有进程、无异常 ⇒ leased', () => {
    const r = deriveSlotState(lease(), { alive: true, cpuPct: 5, rssMb: 300, at: NOW }, NOW, P)
    expect(r.state).toBe('leased')
    expect(r.reasons).toEqual([])
  })

  it('⑥ 进程已死 ⇒ orphaned，且**优先于** stale（判定顺序不可换）', () => {
    // 同时满足"闲置过久"与"进程已死" ⇒ 必须报 orphaned
    const l = lease({ lastActionAt: NOW - 60 * 60_000 })
    const r = deriveSlotState(l, { alive: false, cpuPct: 0, rssMb: 0, at: NOW }, NOW, P)
    expect(r.state).toBe('orphaned')
    // 负控：进程活着时，同一份事实必须是 stale（证明上面的 orphaned 来自 alive=false）
    const alive = deriveSlotState(l, { alive: true, cpuPct: 5, rssMb: 300, at: NOW }, NOW, P)
    expect(alive.state).toBe('stale')
  })

  it('⑦ 闲置超过阈值 ⇒ stale，且 reasons 说明**闲置了多久**', () => {
    const l = lease({ lastActionAt: NOW - 16 * 60_000 })
    const r = deriveSlotState(l, { alive: true, cpuPct: 5, rssMb: 300, at: NOW }, NOW, P)
    expect(r.state).toBe('stale')
    expect(r.reasons.some((x) => x.includes('无动作'))).toBe(true)
    // 负控：少 1 分钟就还不该触发
    const ok = deriveSlotState(lease({ lastActionAt: NOW - 14 * 60_000 }), { alive: true, cpuPct: 5, rssMb: 300, at: NOW }, NOW, P)
    expect(ok.state).toBe('leased')
  })

  it('⑧ CPU 超阈值 ⇒ stale（这是 owner 点名的第二种异常）', () => {
    const r = deriveSlotState(lease(), { alive: true, cpuPct: 92, rssMb: 800, at: NOW }, NOW, P)
    expect(r.state).toBe('stale')
    expect(r.reasons.some((x) => x.includes('CPU'))).toBe(true)
    // 负控：刚好等于阈值不应触发（>= 才触发 —— 钉住边界的方向）
    const edge = deriveSlotState(lease(), { alive: true, cpuPct: P.cpuPct, rssMb: 800, at: NOW }, NOW, P)
    expect(edge.state).toBe('stale')
    const below = deriveSlotState(lease(), { alive: true, cpuPct: P.cpuPct - 1, rssMb: 800, at: NOW }, NOW, P)
    expect(below.state).toBe('leased')
  })

  it('⑨ 内存超阈值 ⇒ stale', () => {
    const r = deriveSlotState(lease(), { alive: true, cpuPct: 1, rssMb: P.rssMb + 100, at: NOW }, NOW, P)
    expect(r.state).toBe('stale')
    expect(r.reasons.some((x) => x.includes('内存'))).toBe(true)
  })

  it('⑩ 占用超时 ⇒ stale（兜底：一直有小动作也不能永远占着）', () => {
    const l = lease({ leasedAt: NOW - 3 * 60 * 60_000, lastActionAt: NOW - 1000 })
    const r = deriveSlotState(l, { alive: true, cpuPct: 5, rssMb: 300, at: NOW }, NOW, P)
    expect(r.state).toBe('stale')
    expect(r.reasons.some((x) => x.includes('上限'))).toBe(true)
  })

  it('⑪ proc 为 null（还没采样）时不因进程原因误判', () => {
    const r = deriveSlotState(lease(), null, NOW, P)
    expect(r.state).toBe('leased')
  })
})

describe('提醒时机与文本（同值歧义：四成因必须四种动作）', () => {
  it('⑫ leased / free 不提醒；stale / orphaned 提醒', () => {
    expect(shouldNudge(lease(), 'leased', NOW, P)).toBe(false)
    expect(shouldNudge(lease(), 'free', NOW, P)).toBe(false)
    expect(shouldNudge(lease(), 'stale', NOW, P)).toBe(true)
    expect(shouldNudge(lease(), 'orphaned', NOW, P)).toBe(true)
  })

  it('⑬ 冷却：刚提醒过就不再说（否则每 tick 叫一次，占用者只会被淹没）', () => {
    const l = lease({ lastNudgeAt: NOW - 60_000, nudges: 1 })
    expect(shouldNudge(l, 'stale', NOW, P)).toBe(false)
    // 负控：过了冷却就再提
    const old = lease({ lastNudgeAt: NOW - P.nudgeCooldownMs - 1, nudges: 1 })
    expect(shouldNudge(old, 'stale', NOW, P)).toBe(true)
  })

  it('⑭ 🔴 orphaned 与 stale 的文本**不同**，且都写明具体动作', () => {
    const a = nudgeText(1, 'orphaned', ['进程已退出'], P)
    const b = nudgeText(1, 'stale', ['已 20 分钟无动作'], P)
    expect(a).not.toEqual(b)
    // orphaned 的正确动作是"重新租一个"，不是"管好你的浏览器"
    expect(a).toContain('release')
    expect(a).toContain('acquire')
    // stale 的文本必须带阈值，否则收到的人不知道自己越了哪条线
    expect(b).toContain('15') // idleMs = 15 分钟
    expect(b).toContain('80') // cpuPct
    // 两者都必须给出 release 这个最省事的出口
    expect(b).toContain('release')
    // 负控：文本里必须出现**具体槽位标号**，否则占用者不知道是哪一个
    expect(a).toContain('b1')
    expect(b).toContain('b1')
  })
})

describe('选址与复用（这次事故的形状：租了不还）', () => {
  it('⑮ 空槽优先填最小的号', () => {
    expect(pickFreeSlot([])).toBe(1)
    expect(pickFreeSlot([lease({ slot: 1 })])).toBe(2)
    expect(pickFreeSlot([lease({ slot: 1 }), lease({ slot: 2 })])).toBe(3)
  })

  it('⑯ 满 20 个返回 0（不是 21）', () => {
    const all = Array.from({ length: MAX_SLOTS }, (_, i) => lease({ slot: i + 1 }))
    expect(pickFreeSlot(all)).toBe(0)
    // 负控：少一个就还能挑
    expect(pickFreeSlot(all.slice(0, MAX_SLOTS - 1))).toBe(MAX_SLOTS)
  })

  it('⑰ 同会话已有占用 ⇒ 复用，不再租第二个', () => {
    const leases = [lease({ slot: 3, sessionId: 'sess-a' }), lease({ slot: 5, sessionId: 'sess-b' })]
    expect(findLeaseBySession(leases, 'sess-a')?.slot).toBe(3)
    expect(findLeaseBySession(leases, 'sess-zzz')).toBeNull()
    // 负控：空 sessionId 不得匹配到任何占用（否则"无归属"会被当成"占着槽"）
    expect(findLeaseBySession(leases, '')).toBeNull()
  })
})
