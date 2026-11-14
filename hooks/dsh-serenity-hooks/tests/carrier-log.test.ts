/**
 * carrier-log.test.ts — LOG 式交接记忆的**机械轮转**（v1.136.0，owner 2026-11-15 令）
 *
 * ## 这份测试钉的是哪一件事（不是"函数跑通了"）
 *
 * 原型（S142 轨迹的 `PROMPT.md` 纪律）**验证过效果**，但它的失效形态是
 * 「agent 忘了轮转 ⇒ LOG 无限长、代数不增、**且无信号**」。升级到 ACC 层的全部意义在于
 * **把"别忘了"换成"忘不忘都一样"**。⇒ 断言必须落在**盘上事实**（哪个文件存在、字节数多少），
 * ⛔ 不落在"函数返回了 rotated=true"。
 *
 * ## 🔴 两个入口都能丢一代，这里各钉一条
 *
 * | 入口 | 失效形态 | 本文件的用例 |
 * |---|---|---|
 * | `renameSync(src, dst)` | POSIX 下**目标存在就静默覆盖** | L4 / L4b（同分钟连跑两次） |
 * | 对非空文件 `write` | 整文件替换 ≡ 销毁这一代（D287，2026-11-04 实测踩过） | E2（空/只含出生头 ⇒ **不轮转**，从源头消灭"空归档"）＋ L4 的"第一份仍在" |
 *
 * ## ⛔ 故意不测什么
 *
 * `carrier-log.ts` 里的措辞（出生头的每一句话）**归 CCC**，各轨迹可以在自己的 PROMPT.md 里
 * 换掉 ⇒ 断言只钉**结构**（有出生头、非空、世代号递增），⛔ 不钉文案（钉文案 = 把 ACC 的
 * 默认措辞变成不可改的契约，越过了 D23 的边界）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  LOG_DIR,
  LOG_FILE,
  frozenLogName,
  isEffectivelyEmpty,
  birthHeader,
  readCarrierLogState,
  rotateCarrierLog,
} from '../src/trajectory/carrier-log.js'

let traj: string
let logDir: string
let live: string

beforeEach(() => {
  traj = mkdtempSync(join(tmpdir(), 'carrier-log-'))
  logDir = join(traj, LOG_DIR)
  live = join(logDir, LOG_FILE)
})

afterEach(() => {
  rmSync(traj, { recursive: true, force: true })
})

/** 直接落一代 LOG（⛔ 不经过被测函数 —— 夹具不能借用被测对象的行为） */
function writeLive(text: string): void {
  mkdirSync(logDir, { recursive: true })
  writeFileSync(live, text, 'utf-8')
}

/** 新一代的空白板（轮转会把当前代整份移走 ⇒ 夹具必须先把 `LOG.md` 造回来） */
function newGen(): void {
  writeLive(`${birthHeader(1, T0, null)}- placeholder\n`)
}

/**
 * 盘上的日志文件，**当前代排最后**（其余按名字升序 = 时间升序）。
 *
 * 🔴 为什么不能直接 `.sort()`：`LOG.md` 与 `LOG-2026-…md` 比字典序时，第 4 个字符
 * `'.'`(0x2E) < `'-'`(0x2D)？—— 实测是 `-`(0x2D) **小于** `.`(0x2E) ⇒ `LOG-*.md` 全部排在
 * `LOG.md` **前面**。这不是被测对象的行为，是**排序字符集**的事实 ⇒ 断言若依赖裸 `.sort()`
 * 就在钉一个偶然，而不是钉"一代归档 ＋ 一份当前"。此处显式编码语义顺序。
 */
function listLogs(): string[] {
  if (!existsSync(logDir)) return []
  const all = readdirSync(logDir)
  return [...all.filter((n) => n !== LOG_FILE).sort(), ...all.filter((n) => n === LOG_FILE)]
}

/** 一个固定的"现在"（重名用例靠它把两次轮转压进同一分钟） */
const T0 = new Date(2026, 10, 15, 14, 30, 0) // 2026-11-15T14:30 本地时区

// ── 判空（决定了会不会产生垃圾归档） ────────────────────────────────────────────

describe('carrier-log：什么算"实质为空"', () => {
  it('E1 空串 / 只有空行 / 只有标题与引用 ⇒ 都算空', () => {
    expect(isEffectivelyEmpty('')).toBe(true)
    expect(isEffectivelyEmpty('\n\n\n')).toBe(true)
    expect(isEffectivelyEmpty('# LOG — generation 2\n\n> note\n> more\n')).toBe(true)
  })

  it('E2 只要有一行真内容 ⇒ 不算空（出生头 ＋ 一条内容）', () => {
    const text = `${birthHeader(2, T0, 'LOG-2026-11-15T1200.md')}- 试了 A，炸了。\n`
    expect(isEffectivelyEmpty(text)).toBe(false)
  })

  it('E3 冻结名的形状：`LOG-<YYYY-MM-DDTHHmm>.md`，且**字典序即时间序**', () => {
    expect(frozenLogName(T0)).toBe('LOG-2026-11-15T1430.md')
    const sorted = [new Date(2026, 10, 15, 9, 5), new Date(2026, 10, 15, 14, 30), new Date(2026, 10, 1, 8, 0)]
      .map(frozenLogName)
      .sort()
    expect(sorted).toEqual(['LOG-2026-11-01T0800.md', 'LOG-2026-11-15T0905.md', 'LOG-2026-11-15T1430.md'])
  })
})

// ── 不轮转的三态（少轮转一次只是少一份归档；多轮转一次会毁掉"代数"这个事实） ─────

describe('carrier-log：三种情况**不**轮转', () => {
  it('N1 目录与文件都不存在 ⇒ 不轮转，但**保证新代存在且非空**（第一代）', () => {
    const r = rotateCarrierLog(traj, T0)
    expect(r.rotated).toBe(false)
    expect(r.frozenAs).toBeNull()
    expect(existsSync(live)).toBe(true)
    expect(isEffectivelyEmpty(readFileSync(live, 'utf-8'))).toBe(true) // 出生头 = 空（结构上）
    expect(statSync(live).size).toBeGreaterThan(0) // 但**文件非空**（下一个人打开不是白板）
    expect(listLogs()).toEqual([LOG_FILE]) // 零归档
  })

  it('N2 存在但只有出生头 ⇒ **不轮转**，原地重用（⛔ 不产生"只有出生头"的垃圾归档）', () => {
    const text = birthHeader(1, T0, null)
    writeLive(text)
    const before = statSync(live).size

    const r = rotateCarrierLog(traj, T0)
    expect(r.rotated).toBe(false)
    expect(listLogs()).toEqual([LOG_FILE]) // 没有多出任何 LOG-*.md
    expect(statSync(live).size).toBe(before) // 内容一字未动
  })

  it('N3 存在且只有一行真内容 ⇒ 轮转（判空不能把"薄"当成"空"）', () => {
    writeLive(`${birthHeader(1, T0, null)}- x\n`)
    const r = rotateCarrierLog(traj, T0)
    expect(r.rotated).toBe(true)
  })
})

// ── 正常轮转（盘上事实，不是回执） ─────────────────────────────────────────────

describe('carrier-log：轮转的盘上事实', () => {
  it('L1 有内容 ⇒ 冻结成本分钟名 ＋ 开新代；**字节守恒**（verified 且盘上真相等）', () => {
    const body = `${birthHeader(1, T0, null)}- 怎么试的：A 失败，改 B。\n- 读了：某文件。\n`
    writeLive(body)
    const bytesBefore = Buffer.byteLength(body, 'utf-8')

    const r = rotateCarrierLog(traj, T0)
    expect(r.rotated).toBe(true)
    expect(r.frozenAs).toBe('LOG-2026-11-15T1430.md')
    expect(r.bytesBefore).toBe(bytesBefore)
    expect(r.verified).toBe(true)
    expect(r.renamedFrom).toBeNull()

    // ① 归档件：内容逐字相等（⛔ 不是"大约相等"）
    const frozenPath = join(logDir, r.frozenAs!)
    expect(readFileSync(frozenPath, 'utf-8')).toBe(body)
    expect(statSync(frozenPath).size).toBe(bytesBefore)

    // ② 新代：存在、非空、且**不是上一代的内容**
    expect(existsSync(live)).toBe(true)
    expect(statSync(live).size).toBeGreaterThan(0)
    expect(readFileSync(live, 'utf-8')).not.toContain('怎么试的：A 失败')

    // ③ 盘上就是"一代归档 ＋ 一份当前"
    expect(listLogs()).toEqual(['LOG-2026-11-15T1430.md', LOG_FILE])
  })

  it('L2 新代的出生头**指回**刚冻结的那一代（指针靠文件内容，不靠额外状态）', () => {
    writeLive(`${birthHeader(1, T0, null)}- 内容\n`)
    const r = rotateCarrierLog(traj, T0)
    expect(readFileSync(live, 'utf-8')).toContain(r.frozenAs!)
  })

  it('L3 连续两代 ⇒ 冻结件按名字升序 = 时间升序，当前代只有一个', () => {
    writeLive(`${birthHeader(1, T0, null)}- 第一代内容\n`)
    rotateCarrierLog(traj, new Date(2026, 10, 15, 9, 5))
    newGen()
    writeFileSync(live, `${birthHeader(2, T0, null)}- 第二代内容\n`, 'utf-8')
    rotateCarrierLog(traj, new Date(2026, 10, 15, 14, 30))

    expect(listLogs()).toEqual(['LOG-2026-11-15T0905.md', 'LOG-2026-11-15T1430.md', LOG_FILE])
    const st = readCarrierLogState(traj)
    expect(st.frozenCount).toBe(2)
    expect(st.newestFrozen).toBe('LOG-2026-11-15T1430.md')
    expect(st.hasLive).toBe(true)
  })
})

// ── 🔴 铁律：轮转永不覆盖（本条是变异靶 —— 去掉避让这段，本组必须红） ────────────

describe('carrier-log：重名避让（⛔ 覆盖 = 静默丢一代）', () => {
  it('L4 同一分钟连跑两次 ⇒ 第二次得到 `-2`，且**第一份仍在、内容未被改写**', () => {
    writeLive(`${birthHeader(1, T0, null)}- 第一次的内容\n`)
    const r1 = rotateCarrierLog(traj, T0)
    expect(r1.frozenAs).toBe('LOG-2026-11-15T1430.md')
    const firstBytes = readFileSync(join(logDir, 'LOG-2026-11-15T1430.md'), 'utf-8')

    writeFileSync(live, `${birthHeader(2, T0, null)}- 第二次的内容\n`, 'utf-8')
    const r2 = rotateCarrierLog(traj, T0)

    expect(r2.rotated).toBe(true)
    expect(r2.frozenAs).toBe('LOG-2026-11-15T1430-2.md')
    expect(r2.renamedFrom).toBe('LOG-2026-11-15T1430.md') // 回执如实说是"原定名撞了"
    expect(r2.verified).toBe(true)

    // 🔴 关键：第一代**一个字节都没变**
    expect(readFileSync(join(logDir, 'LOG-2026-11-15T1430.md'), 'utf-8')).toBe(firstBytes)
    expect(readFileSync(join(logDir, 'LOG-2026-11-15T1430-2.md'), 'utf-8')).toContain('第二次的内容')
    expect(listLogs()).toEqual(['LOG-2026-11-15T1430-2.md', 'LOG-2026-11-15T1430.md', LOG_FILE])
  })

  it('L4b 第三次 ⇒ `-3`（避让是**循环取下一个空位**，不是只加一次后缀）', () => {
    const tags = ['一', '二', '三']
    for (const tag of tags) {
      writeLive(`${birthHeader(1, T0, null)}- ${tag}\n`)
      rotateCarrierLog(traj, T0)
    }
    expect(listLogs()).toEqual([
      'LOG-2026-11-15T1430-2.md',
      'LOG-2026-11-15T1430-3.md',
      'LOG-2026-11-15T1430.md',
      LOG_FILE,
    ])
    // 三代内容各自独立（没有互相覆盖）
    expect(readFileSync(join(logDir, 'LOG-2026-11-15T1430-3.md'), 'utf-8')).toContain('三')
    expect(readFileSync(join(logDir, 'LOG-2026-11-15T1430-2.md'), 'utf-8')).toContain('二')
    expect(readFileSync(join(logDir, 'LOG-2026-11-15T1430.md'), 'utf-8')).toContain('一')
  })

  it('L5 只读诊断不产生任何写（`readCarrierLogState` 是纯查询）', () => {
    writeLive(`${birthHeader(1, T0, null)}- 内容\n`)
    const before = listLogs()
    const size = statSync(live).size
    const st = readCarrierLogState(traj)
    expect(st.hasLive).toBe(true)
    expect(st.liveBytes).toBe(size)
    expect(st.frozenCount).toBe(0)
    expect(st.newestFrozen).toBeNull()
    expect(listLogs()).toEqual(before)
    expect(statSync(live).size).toBe(size)
  })
})

// ── 与 rebuild 的接线：**失败不阻断主流程**（判据在 queueRebuild 一侧） ──────────

describe('carrier-log：接线口径（rotate 的可失败性）', () => {
  it('W1 轨迹目录不可写 ⇒ 轮转**抛错**（由调用方 catch，⛔ 不是静默返回 false）', () => {
    // 让 LOG 变成一个**文件**而不是目录 ⇒ mkdirSync 必抛 ENOTDIR =>
    // 证明"失败是抛出来的"，而不是被吞成一个看起来正常的 skipped 回执。
    writeFileSync(join(traj, LOG_DIR), 'not a directory', 'utf-8')
    expect(() => rotateCarrierLog(traj, T0)).toThrow()
  })
})
