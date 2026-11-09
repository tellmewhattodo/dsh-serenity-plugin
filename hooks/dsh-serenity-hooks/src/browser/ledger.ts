/**
 * browser/ledger.ts — 槽位台账（**唯一**真相源：谁租了哪个槽）
 *
 * 落点：`<CCC>/.opencode/browser-slots.json`
 *
 * 🔴 为什么放进 `.opencode/` 而不是 `_tmp/`：`_tmp/` 的语义是"随时可丢"，
 *    而**一个正在被占用的槽位记录不是可丢的东西** —— 丢了之后占用者再也无法 release
 *    （它找不到自己的条目），槽位就永久泄漏。台账必须比它的进程活得久。
 *
 * 🔴 🔴 **并发**：20 个槽位会被**多条轨迹同时**争抢（本容器 29 条活跃轨迹）。
 *    整文件读改写会**静默丢键**（仓里 `localstore.json` 已为同一个病付过一次代价）。
 *    ⇒ 这里用 `O_EXCL` 排他锁 + temp→rename 原子替换，并带**持锁者崩溃自动回收**。
 *
 * ⚠️ 已知边界（如实登记）：锁是**单机文件锁**，只在同一台机器、同一个文件系统上成立。
 *    本容器的槽位天然只属于本机（Chrome 是本地进程），故够用；⛔ 不要据此推断它支持多机。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SlotLease } from './state.js'

/** 台账在 CCC 内的相对位置 */
export const LEDGER_REL = join('.opencode', 'browser-slots.json')

/** 锁文件后缀 */
const LOCK_SUFFIX = '.lock'

/** 锁的存活上限：超过即视为持锁者已崩溃（必须是"远大于一次读改写的耗时"） */
const LOCK_STALE_MS = 10_000

/** 持锁自旋：最多等这么久（超过即放弃并报错，⛔ 不无限等） */
const LOCK_WAIT_MS = 8_000

export interface Ledger {
  version: number
  /** 按槽位号索引的占用事实；⛔ 不存"状态"（状态永远现算） */
  leases: Record<string, SlotLease>
  /** 台账最后写入时刻（ms），用于诊断"这份台账多旧" */
  updatedAt: number
  /**
   * 启动失败退避（G9：崩溃循环）。
   *
   * 🔴 为什么必须有：一个"必死的配置"（例如 Chrome 路径错、缺 `--no-sandbox`）会让
   *    每次 acquire 都白跑一次**完整复检**（就绪轮询 + 2.5s 稳定性复检 ≈ 数秒）。
   *    若看守或人反复重试，就是纯粹的浪费，而且**读数上完全看不出来**（每次都是"启动失败"，
   *    与"第一次就失败"长得一模一样）。
   *    判据：失败要计入，连续失败要**按指数推迟下一次尝试**。
   *    槽位号 → { 连续失败次数, 下次允许尝试的时刻 }
   */
  backoff: Record<string, { failures: number; nextAt: number }>
}

const EMPTY: Ledger = { version: 1, leases: {}, updatedAt: 0, backoff: {} }

export function ledgerPath(root: string): string {
  return join(root, LEDGER_REL)
}

/** 读台账。文件缺失/损坏 ⇒ 返回空台账（⛔ 不抛错：一次坏文件不该炸掉整条轨迹的所有槽位操作） */
export function readLedger(root: string): Ledger {
  const p = ledgerPath(root)
  if (!existsSync(p)) return { ...EMPTY, leases: {} }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Ledger>
    const leases: Record<string, SlotLease> = {}
    const src = raw && typeof raw.leases === 'object' && raw.leases ? raw.leases : {}
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const l = v as Partial<SlotLease>
      const n = Number(l?.slot)
      // 逐条校验：一条坏记录不该污染其它槽位
      if (!Number.isInteger(n) || n < 1 || n > 20) continue
      leases[String(n)] = {
        slot: n,
        sessionId: typeof l.sessionId === 'string' ? l.sessionId : '',
        trajectory: typeof l.trajectory === 'string' ? l.trajectory : '',
        leasedAt: Number(l.leasedAt) || 0,
        lastActionAt: Number(l.lastActionAt) || Number(l.leasedAt) || 0,
        nudges: Number(l.nudges) || 0,
        lastNudgeAt: Number(l.lastNudgeAt) || 0,
        pid: Number(l.pid) || 0,
      }
    }
    const backoff: Ledger['backoff'] = {}
    const bsrc = raw && typeof raw.backoff === 'object' && raw.backoff ? raw.backoff : {}
    for (const [k, v] of Object.entries(bsrc as Record<string, unknown>)) {
      const b = v as { failures?: unknown; nextAt?: unknown }
      const n = Number(k)
      if (!Number.isInteger(n) || n < 1 || n > 20) continue
      backoff[String(n)] = { failures: Number(b?.failures) || 0, nextAt: Number(b?.nextAt) || 0 }
    }
    return { version: Number(raw.version) || 1, leases, updatedAt: Number(raw.updatedAt) || 0, backoff }
  } catch {
    return { ...EMPTY, leases: {} }
  }
}

/** 原子写：temp → rename（rename 在同文件系统内是原子的） */
export function writeLedger(root: string, ledger: Ledger): void {
  const p = ledgerPath(root)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  const body = JSON.stringify({ ...ledger, updatedAt: Date.now() }, null, 2)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, p)
}

/** 把持锁者崩溃留下的锁回收（判据 = 锁文件 mtime 过老） */
function tryBreakStaleLock(lock: string): void {
  try {
    const st = statSync(lock)
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true })
  } catch {
    /* 锁已被别人清掉 ⇒ 无事可做 */
  }
}

/**
 * 在锁内做一次「读 → 改 → 写」。
 * 返回 `update` 的返回值；`update` 抛错时不写盘（保持台账不变）。
 *
 * 🔴 为什么把整个读改写放进一个函数而不是暴露 `lock()/unlock()`：
 *    调用方忘记 unlock（或在中途抛错）会**永久锁死**整个槽位系统，而这**没有任何信号**。
 *    把锁的生命周期绑在一个同步函数的执行期上，是唯一不依赖调用方纪律的做法。
 */
export function withLedger<T>(root: string, update: (ledger: Ledger) => { ledger: Ledger; result: T }): T {
  const p = ledgerPath(root)
  mkdirSync(dirname(p), { recursive: true })
  const lock = p + LOCK_SUFFIX
  const deadline = Date.now() + LOCK_WAIT_MS
  let acquired = false
  while (Date.now() < deadline) {
    try {
      // wx = O_CREAT|O_EXCL|O_WRONLY：已存在即失败（这是排他锁的全部机制）
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      acquired = true
      break
    } catch {
      tryBreakStaleLock(lock)
      // 自旋一小会儿（同步 sleep：本函数是同步契约，不引入 async 传染）
      const until = Date.now() + 25
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  if (!acquired) {
    throw new Error(
      `槽位台账被占用超过 ${LOCK_WAIT_MS}ms，放弃本次操作（锁文件：${lock}）。\n` +
        `  判据：持锁者若已崩溃，锁会在 ${LOCK_STALE_MS}ms 后自动回收；请稍后重试。\n` +
        `  ⛔ 不要手工删锁 —— 那可能与一个正在写的进程撞车。`,
    )
  }
  try {
    const current = readLedger(root)
    const { ledger, result } = update(current)
    writeLedger(root, ledger)
    return result
  } finally {
    rmSync(lock, { force: true })
  }
}

/** 台账内所有占用（按槽位号升序） */
export function listLeases(ledger: Ledger): SlotLease[] {
  return Object.values(ledger.leases).sort((a, b) => a.slot - b.slot)
}
