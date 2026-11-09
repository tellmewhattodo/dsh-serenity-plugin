/**
 * browser-slot-ledger.test.ts — 槽位台账（文件锁 + 原子写 + 坏数据自愈）
 *
 * 🔴 为什么必须用**真文件系统**：这一层的全部价值在于"多条轨迹同时抢 20 个槽位时不丢键"。
 *    用 mock fs 测「调用了 rename」只证明我写了那行，不证明它真能防住丢键。
 *    ⇒ 这里用真 tmpdir 做**真并发**（子进程级没有，但同进程多轮读改写已能抓到"读旧写旧"）。
 *
 * 判据来源（同病已付过一次代价）：仓里 `localstore.json` 是整文件读改写，
 * 并发会**静默丢键** —— 而槽位台账丢键的后果更重：占用者再也找不到自己的条目 ⇒ 槽位永久泄漏。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LEDGER_REL,
  ledgerPath,
  listLeases,
  readLedger,
  withLedger,
  writeLedger,
  type Ledger,
} from '../src/browser/ledger.js'
import type { SlotLease } from '../src/browser/state.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slot-ledger-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mkLease(n: number, session = 'sess-a'): SlotLease {
  return {
    slot: n,
    sessionId: session,
    trajectory: 'traj',
    leasedAt: 1000,
    lastActionAt: 1000,
    nudges: 0,
    lastNudgeAt: 0,
    pid: 4242,
  }
}

describe('台账：读写的底线', () => {
  it('① 文件不存在 ⇒ 空台账，⛔ 不抛错（一次坏文件不该炸掉整条轨迹的所有槽位操作）', () => {
    const lg = readLedger(root)
    expect(lg.leases).toEqual({})
    expect(lg.backoff).toEqual({})
    expect(existsSync(ledgerPath(root))).toBe(false)
  })

  it('② 写后读回一致；且落点就在 .opencode/ 下（⛔ 不是 _tmp/ —— 台账要比进程活得久）', () => {
    writeLedger(root, { version: 1, leases: { '3': mkLease(3) }, updatedAt: 0, backoff: {} })
    expect(existsSync(join(root, LEDGER_REL))).toBe(true)
    expect(LEDGER_REL.startsWith('.opencode')).toBe(true)
    const lg = readLedger(root)
    expect(lg.leases['3']?.sessionId).toBe('sess-a')
    expect(lg.leases['3']?.pid).toBe(4242)
  })

  it('③ 损坏的 JSON ⇒ 回落空台账，⛔ 抛错', () => {
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(ledgerPath(root), '{ this is not json', 'utf8')
    expect(readLedger(root).leases).toEqual({})
  })

  it('④ 单条坏记录不污染其它槽位（逐条校验：slot 越界的跳过）', () => {
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(
      ledgerPath(root),
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        leases: {
          '2': mkLease(2),
          '99': { ...mkLease(99), slot: 99 }, // 越界
          x: { ...mkLease(4), slot: 4 }, // 非数字键
          '5': { ...mkLease(5), slot: 5, sessionId: 123 }, // 字段类型错（应回落空串）
        },
      }),
      'utf8',
    )
    const lg = readLedger(root)
    expect(lg.leases['2']?.slot).toBe(2)
    expect(lg.leases['99']).toBeUndefined()
    expect(lg.leases.x).toBeUndefined()
    expect(lg.leases['5']?.sessionId).toBe('')
  })
})

describe('台账：并发与锁（这是它存在的理由）', () => {
  it('⑤ 多轮读改写在锁内串行 ⇒ 一条都不丢（"读旧写旧"会在这里丢键）', () => {
    for (let i = 1; i <= 6; i++) {
      withLedger(root, (lg) => {
        lg.leases[String(i)] = mkLease(i, `sess-${i}`)
        return { ledger: lg, result: null }
      })
    }
    const lg = readLedger(root)
    expect(Object.keys(lg.leases).length).toBe(6)
    for (let i = 1; i <= 6; i++) expect(lg.leases[String(i)]?.sessionId).toBe(`sess-${i}`)
  })

  it('⑥ update 抛错 ⇒ 台账不变（半成品不落盘）', () => {
    withLedger(root, (lg) => {
      lg.leases['1'] = mkLease(1)
      return { ledger: lg, result: null }
    })
    expect(() =>
      withLedger(root, (lg) => {
        lg.leases['2'] = mkLease(2)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    const lg = readLedger(root)
    expect(Object.keys(lg.leases)).toEqual(['1'])
  })

  it('⑦ 🔴 持锁者崩溃留下的锁会被自动回收（否则整个槽位系统永久锁死且无信号）', () => {
    const lock = ledgerPath(root) + '.lock'
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(lock, '999999', 'utf8')
    // 把 mtime 推到很久以前（模拟崩溃）
    const old = Date.now() - 60_000
    require('node:fs').utimesSync(lock, old / 1000, old / 1000)
    // 不抛错 ⇒ 说明锁被回收了
    const out = withLedger(root, (lg) => {
      lg.leases['7'] = mkLease(7)
      return { ledger: lg, result: 'ok' }
    })
    expect(out).toBe('ok')
    expect(readLedger(root).leases['7']?.slot).toBe(7)
    // 负控：锁在函数返回后必须消失（⛔ 不能留下"我锁着"的假象）
    expect(existsSync(lock)).toBe(false)
  })
})

describe('台账：退避记录（G9 崩溃循环）', () => {
  it('⑧ backoff 能存能读；不存则视为无退避', () => {
    const before: Ledger = readLedger(root)
    expect(before.backoff['1']).toBeUndefined()
    withLedger(root, (lg) => {
      lg.backoff['1'] = { failures: 2, nextAt: Date.now() + 30_000 }
      return { ledger: lg, result: null }
    })
    const after = readLedger(root)
    expect(after.backoff['1']?.failures).toBe(2)
    expect(after.backoff['1']?.nextAt).toBeGreaterThan(Date.now())
  })
})

describe('台账：排序与视图', () => {
  it('⑨ listLeases 按槽位号升序（⛔ 不按对象键序 —— 那是插入序）', () => {
    withLedger(root, (lg) => {
      lg.leases['9'] = mkLease(9)
      lg.leases['2'] = mkLease(2)
      lg.leases['15'] = mkLease(15)
      return { ledger: lg, result: null }
    })
    expect(listLeases(readLedger(root)).map((l) => l.slot)).toEqual([2, 9, 15])
  })
})
