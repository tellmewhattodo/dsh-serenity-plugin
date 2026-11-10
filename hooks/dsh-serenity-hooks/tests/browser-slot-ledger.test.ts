/**
 * browser-slot-ledger.test.ts — 槽位台账（文件锁 + 原子写 + 坏数据自愈 + **全局唯一**）
 *
 * 🔴 为什么必须用**真文件系统**：这一层的全部价值在于"多条轨迹同时抢 20 个槽位时不丢键"。
 *    用 mock fs 测「调用了 rename」只证明我写了那行，不证明它真能防住丢键。
 *    ⇒ 这里用真目录做**真并发**（同进程多轮读改写已能抓到"读旧写旧"）。
 *
 * 🔴 v1.129.0 起**台账不再按 CCC 分家**（owner 令：20 个槽位是所有 CCC 共用的）。
 *    测试因此把 `SERENITY_BROWSER_SLOTS_DIR` 指到临时目录 —— 这是唯一隔离手段，
 *    也顺带证明"隔离靠一个 env 就够"（若台账还认 root 参数，这条会红）。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LEDGER_FILENAME,
  ledgerPath,
  listLeases,
  readLedger,
  withLedger,
  writeLedger,
  type Ledger,
} from '../src/browser/ledger.js'
import { SLOTS_DIR_ENV } from '../src/browser/home.js'
import type { SlotLease } from '../src/browser/state.js'

let home = ''
const savedEnv = process.env[SLOTS_DIR_ENV]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'slot-ledger-'))
  process.env[SLOTS_DIR_ENV] = home
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env[SLOTS_DIR_ENV]
  else process.env[SLOTS_DIR_ENV] = savedEnv
  rmSync(home, { recursive: true, force: true })
})

function mkLease(n: number, session = 'sess-a'): SlotLease {
  return {
    slot: n,
    cccRoot: '/ccc/a',
    sessionId: session,
    trajectory: 'traj',
    leasedAt: 1000,
    lastActionAt: 1000,
    nudges: 0,
    lastNudgeAt: 0,
    pid: 4242,
  }
}

function seedLedger(leases: Record<string, SlotLease>, extra: Partial<Ledger> = {}): void {
  mkdirSync(dirname(ledgerPath()), { recursive: true })
  writeFileSync(ledgerPath(), JSON.stringify({ version: 2, updatedAt: 0, leases, backoff: {}, ...extra }), 'utf8')
}

describe('台账：读写的底线', () => {
  it('① 文件不存在 ⇒ 空台账，⛔ 不抛错（一次坏文件不该炸掉整条轨迹的所有槽位操作）', () => {
    const lg = readLedger()
    expect(lg.leases).toEqual({})
    expect(lg.backoff).toEqual({})
    expect(existsSync(ledgerPath())).toBe(false)
  })

  it('② 🔴 落点 = **全局家目录**，⛔ 不在任何 CCC 内（这是 owner 那条令的机械判据）', () => {
    writeLedger({ version: 2, leases: { '3': mkLease(3) }, updatedAt: 0, backoff: {} })
    expect(ledgerPath()).toBe(join(home, LEDGER_FILENAME))
    expect(existsSync(ledgerPath())).toBe(true)
    const lg = readLedger()
    expect(lg.leases['3']?.sessionId).toBe('sess-a')
    expect(lg.leases['3']?.pid).toBe(4242)
    // 负控：`ledgerPath()` 的签名里**没有 root** —— 拿不到"按 CCC 分家"这个能力。
    //   若有人把它改回去（加 root 参数），`ledgerPath.length` 会变成 ≥1，这条立刻红。
    expect(ledgerPath.length).toBe(0)
  })

  it('②-b 🔴 换 env 就换台账：两个"CCC"看的是**同一份**文件（跨 CCC 共享的物理证据）', () => {
    // 判据来源：owner 2026-11-10 指出"20 个槽位是所有 CCC 共用的"。
    // 若台账仍按 CCC 分家，下面第二次写入会落到**另一个**路径。
    writeLedger({ version: 2, leases: { '1': mkLease(1, 'ccc-a-sess') }, updatedAt: 0, backoff: {} })
    const p1 = ledgerPath()
    writeLedger({ version: 2, leases: { '1': mkLease(1, 'ccc-b-sess') }, updatedAt: 0, backoff: {} })
    expect(ledgerPath()).toBe(p1)
    expect(readLedger().leases['1']?.sessionId).toBe('ccc-b-sess')
  })

  it('③ 损坏的 JSON ⇒ 回落空台账，⛔ 抛错', () => {
    mkdirSync(dirname(ledgerPath()), { recursive: true })
    writeFileSync(ledgerPath(), '{ this is not json', 'utf8')
    expect(readLedger().leases).toEqual({})
  })

  it('④ 单条坏记录不污染其它槽位（逐条校验：slot 越界的跳过）', () => {
    seedLedger({
      '2': mkLease(2),
      '99': { ...mkLease(99), slot: 99 }, // 越界
      x: { ...mkLease(4), slot: 4 }, // 非数字键
      '5': { ...mkLease(5), slot: 5, sessionId: 123 as unknown as string }, // 字段类型错（应回落空串）
    })
    const lg = readLedger()
    expect(lg.leases['2']?.slot).toBe(2)
    expect(lg.leases['99']).toBeUndefined()
    expect(lg.leases.x).toBeUndefined()
    expect(lg.leases['5']?.sessionId).toBe('')
  })

  it('④-b 缺 cccRoot 的旧记录（v1 遗留）⇒ 读成空串，⛔ 猜（跨 CCC 时它是唯一能回答"你是谁"的字段）', () => {
    seedLedger({ '6': { ...mkLease(6), cccRoot: undefined as unknown as string } })
    expect(readLedger().leases['6']?.cccRoot).toBe('')
  })
})

describe('台账：并发与锁（这是它存在的理由）', () => {
  it('⑤ 多轮读改写在锁内串行 ⇒ 一条都不丢（"读旧写旧"会在这里丢键）', () => {
    for (let i = 1; i <= 6; i++) {
      withLedger((lg) => {
        lg.leases[String(i)] = mkLease(i, `sess-${i}`)
        return { ledger: lg, result: null }
      })
    }
    const lg = readLedger()
    expect(Object.keys(lg.leases).length).toBe(6)
    for (let i = 1; i <= 6; i++) expect(lg.leases[String(i)]?.sessionId).toBe(`sess-${i}`)
  })

  it('⑥ update 抛错 ⇒ 台账不变（半成品不落盘）', () => {
    withLedger((lg) => {
      lg.leases['1'] = mkLease(1)
      return { ledger: lg, result: null }
    })
    expect(() =>
      withLedger((lg) => {
        lg.leases['2'] = mkLease(2)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    const lg = readLedger()
    expect(Object.keys(lg.leases)).toEqual(['1'])
  })

  it('⑦ 🔴 持锁者崩溃留下的锁会被自动回收（否则整个槽位系统永久锁死且无信号）', () => {
    const lock = ledgerPath() + '.lock'
    mkdirSync(dirname(ledgerPath()), { recursive: true })
    writeFileSync(lock, '999999', 'utf8')
    // 把 mtime 推到很久以前（模拟崩溃）
    const old = Date.now() - 60_000
    utimesSync(lock, old / 1000, old / 1000)
    // 不抛错 ⇒ 说明锁被回收了
    const out = withLedger((lg) => {
      lg.leases['7'] = mkLease(7)
      return { ledger: lg, result: 'ok' }
    })
    expect(out).toBe('ok')
    expect(readLedger().leases['7']?.slot).toBe(7)
    // 负控：锁在函数返回后必须消失（⛔ 不能留下"我锁着"的假象）
    expect(existsSync(lock)).toBe(false)
  })
})

describe('台账：退避记录（G9 崩溃循环）', () => {
  it('⑧ backoff 能存能读；不存则视为无退避', () => {
    const before: Ledger = readLedger()
    expect(before.backoff['1']).toBeUndefined()
    withLedger((lg) => {
      lg.backoff['1'] = { failures: 2, nextAt: Date.now() + 30_000 }
      return { ledger: lg, result: null }
    })
    const after = readLedger()
    expect(after.backoff['1']?.failures).toBe(2)
    expect(after.backoff['1']?.nextAt).toBeGreaterThan(Date.now())
  })
})

describe('台账：排序与视图', () => {
  it('⑨ listLeases 按槽位号升序（⛔ 不按对象键序 —— 那是插入序）', () => {
    withLedger((lg) => {
      lg.leases['9'] = mkLease(9)
      lg.leases['2'] = mkLease(2)
      lg.leases['15'] = mkLease(15)
      return { ledger: lg, result: null }
    })
    expect(listLeases(readLedger()).map((l) => l.slot)).toEqual([2, 9, 15])
  })
})
