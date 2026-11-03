/**
 * user-quotes-subagent.test.ts — 🔴 **subagent 子会话不得进语录**（v1.113.2）
 *
 * owner 原话（2026-11-03）：「subagent 任务书记录到用户语录是不对的，这个需要修掉」。
 *
 * ## 判据是缺陷，不是规格取舍
 *
 * subagent 的父 agent 用 `createUserMessage(...)` 下发任务书，而宿主
 * `agent.followup/steer` **只接受 user 消息** ⇒ 任务书的 `source.kind` **确实是 `'user'`**。
 * ⇒ 「`kind === 'user'`」在 subagent 形态下**分不开「真人」与「另一个 agent」**。
 * 实测污染：v1.113.0/1 上线当天，42 条真实记录里 **2 条**是 subagent 任务书。
 *
 * ## 🔴 本文件测的是**真对象**，不是复刻
 *
 * 初版我写了个 `shouldRecord()` 把判据**抄一份**再测它 —— **那是假绿**：
 * `seams/context.ts` 改错了它照样绿（D275 同族：「定义了却没接上」）。
 * 现在改成 import 真实导出 {@link isSubagentSession}，并由 `context.ts` 也调它
 * ⇒ **判据只有一份，改了这里必红**。
 *
 * ## 钉三件事
 *
 * 1. **两条结构判据各自独立生效**（`origin==='subagent'` ／ `delegationDepth>0`）。
 * 2. **变异检验**：不施加排除 ⇒ 任务书**必须**被记进来（证明排除真的在起作用）。
 * 3. **正控**：主会话照常采集（⛔ 否则"排除一切"也能让上面通过）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  recordUserQuotes,
  isSubagentSession,
  userQuoteFileName,
  USER_QUOTES_DIR,
  __resetUserQuoteDedupeForTest,
} from '../src/trajectory/user-quotes.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uq-sub-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
  __resetUserQuoteDedupeForTest()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FIXED_MS = Date.parse('2026-11-03T22:50:00+08:00')

/** subagent 任务书的真实形状（父 agent 用 createUserMessage 下发 ⇒ kind 确实是 'user'） */
function taskBrief(id: string, text: string) {
  return {
    id,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const, rpcId: `rpc-${id}`, clientTimeZone: 'Asia/Shanghai' },
  }
}

const briefRow = () =>
  join(dir, USER_QUOTES_DIR, userQuoteFileName(FIXED_MS))

describe('isSubagentSession：两条结构判据各自独立生效', () => {
  it('origin === "subagent" ⇒ 是 subagent', () => {
    expect(isSubagentSession({ header: { origin: 'subagent' } })).toBe(true)
  })

  it('delegationDepth > 0 ⇒ 是 subagent（即使 origin 没写）', () => {
    expect(isSubagentSession({ header: { delegationDepth: 1 } })).toBe(true)
    expect(isSubagentSession({ header: { delegationDepth: 3 } })).toBe(true)
  })

  it('两条同时在场 ⇒ 是 subagent', () => {
    expect(isSubagentSession({ header: { origin: 'subagent', delegationDepth: 2 } })).toBe(true)
  })

  it('正控：主会话形态一律**不是** subagent', () => {
    expect(isSubagentSession(undefined)).toBe(false)
    expect(isSubagentSession({})).toBe(false)
    expect(isSubagentSession({ header: {} })).toBe(false)
    expect(isSubagentSession({ header: { origin: 'startup' } })).toBe(false)
    expect(isSubagentSession({ header: { delegationDepth: 0 } })).toBe(false)
    expect(isSubagentSession({ header: null })).toBe(false)
  })

  it('类型稳健：delegationDepth 非数字时不崩、也不算 subagent', () => {
    expect(isSubagentSession({ header: { delegationDepth: '2' as never } })).toBe(false)
    expect(isSubagentSession({ header: { delegationDepth: null as never } })).toBe(false)
  })
})

describe('🔴 变异检验：排除去掉后，任务书真的会被记进来', () => {
  /**
   * 对照组 = **修之前的行为**。它证明下面那些"不写"的断言不是恒真：
   * `recordUserQuotes` 本身只看 `kind==='user'`，so 它照单全收。
   */
  it('对照组：不施加排除 ⇒ 任务书被入账（= 修之前的污染形态）', () => {
    const brief = taskBrief('m1', '你在宁静号 CCC（认知容器）里做一次只读的历史调研。')
    const r = recordUserQuotes(dir, 'subagent-session', [brief], FIXED_MS)
    expect(r.written).toBe(1) // ← 修之前就是这样污染的
    const rows = readFileSync(briefRow(), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { text: string })
    expect(rows[0]!.text).toContain('做一次只读的历史调研')
  })

  it('施加排除后：同样的任务书**一条都不写**（文件根本不出现）', () => {
    const session = { header: { origin: 'subagent', delegationDepth: 1 } }
    if (!isSubagentSession(session)) {
      recordUserQuotes(dir, 'subagent-session', [taskBrief('m1', '你做一次调研')], FIXED_MS)
    }
    expect(existsSync(briefRow())).toBe(false)
  })

  it('只带 delegationDepth（origin 缺失）也必须排除', () => {
    const session = { header: { delegationDepth: 1 } }
    if (!isSubagentSession(session)) {
      recordUserQuotes(dir, 'subagent-session', [taskBrief('m2', '你做一次调研')], FIXED_MS)
    }
    expect(existsSync(briefRow())).toBe(false)
  })

  it('正控：主会话的真发言在同样路径下照常落盘（排除没有误伤）', () => {
    const session = { header: {} }
    if (!isSubagentSession(session)) {
      recordUserQuotes(dir, 'main-session', [taskBrief('m3', '我们开始做点事情吧')], FIXED_MS)
    }
    const rows = readFileSync(briefRow(), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!) as { text: string }).toMatchObject({ text: '我们开始做点事情吧' })
  })
})
