/**
 * tests/trajectory/interrupted.test.ts — 「以 interrupted 结尾」的会话发现
 *
 * 钉四件事（每条都是真日志形态，不用替身）：
 * ① **只有末条 = end-seed 且其前 turn/end 是 interrupted** 才命中；
 * ② **"曾经中断过"不算** —— 后面已有新事件的会话必须**不命中**（这是最危险的误报面）；
 * ③ **多帧 zstd 能正确回扫**（DSH 日志就是多帧追加；只解第一帧会漏）；
 * ④ **回看窗口**真的过滤（窗口外的不扫，`scanned` 不涨）。
 *
 * 🔴 ③ 是本文件的核心：宿主按帧追加写，单会话实测 2.4 万帧。若实现只解第一帧，
 * 所有用例都会"通过"（因为夹具小），但真机上永远读不到末事件 —— 正是那种
 * "跑绿也照样炸"的形态。故夹具**必须多帧**。
 *
 * 🔴🔴 **2026-11-04 新增第 ⑤ 条（它改变了本文件的写法）**：
 * **夹具的事件形状必须逐字取自真机日志**，⛔ 不许按"我以为的形状"构造。
 * 代价实证：`tool/result` 的 callId 在 `data.message` 里，而实现与夹具**一起**按
 * 虚构的 `data.callId` 写 ⇒ 两边同时错、同时绿 ⇒ owner 看到约 150 项乱清单才暴露。
 * ⇒ 真机形状一律用 `msm dsh-session corpus raw --session <id> --match <事件类型>` 取。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as nodeZlib from 'node:zlib'
import { randomBytes } from 'node:crypto'

import {
  buildContinueText,
  createResumeOne,
  detectInterruptedEnd,
  detectUnclosedTurn,
  formatPendingTools,
  innerAbortCauseOf,
  isUserIntentStop,
  projectDirNameForCwd,
  scanInterruptedSessions,
} from '../../src/trajectory/interrupted.js'

const zstdCompressSync: ((buf: Buffer) => Buffer) | undefined = (
  nodeZlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }
).zstdCompressSync

let dir: string

/** 把一组事件写成 DSH 形态：**每帧一个事件 + 换行**（真机就是多帧追加） */
function writeSession(sessionId: string, events: Array<Record<string, unknown>>): string {
  const sessionDir = join(dir, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  if (zstdCompressSync === undefined) throw new Error('本机 Node 无 zstdCompressSync，无法构造夹具')
  const frames = events.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return sessionDir
}

/** 一次"正常完成"的轮次 */
function turnEvents(turn: number, kind: string): Array<Record<string, unknown>> {
  return [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn } },
    { type: 'step/start', seq: 2, time: 1001, data: { turn, step: 1 } },
    { type: 'turn/end', seq: 3, time: 1002, data: { turn, reason: { kind } } },
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'interrupted-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('detectInterruptedEnd（纯判定）', () => {
  it('末条 end-seed + 其前 turn/end=interrupted ⇒ 命中', () => {
    const events = [
      ...turnEvents(7, 'interrupted'),
      { type: 'step/end', data: { turn: 7, step: 1 } },
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)).toEqual({ turn: 7, pendingTools: [] })
  })

  it('🔴 末条 end-seed 但其前 turn/end=completed ⇒ 不命中（正常结束）', () => {
    const events = [
      ...turnEvents(7, 'completed'),
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  /**
   * 🔴🔴 **2026-10-24（owner 报障：「有的会话在重启时不是崩溃的就扫不到，还是没修好」）**
   *
   * 宿主对「这一轮没跑完」有**两种**写法，`kind` **不是同一个词**：
   * · 崩溃后被 resume 补收尾 → `interrupted`（`interruptedTurnClosers`）
   * · 被正常终止（重启／销毁／用户中断）→ `aborted`（驱动 catch 里 `abortedCancelCause`）
   *
   * 修前只认前者 ⇒ **发布重启这一类整批漏扫** —— 而那正是最常见的形态。
   * ⇒ 下面这是一条**正控**：`aborted` 必须命中。它红 = 判据又窄回去了。
   */
  it('🔴 末轮 aborted（被正常终止：重启／销毁／用户中断）⇒ **必须命中**', () => {
    const events = [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 12 } },
      {
        type: 'turn/end', seq: 2, time: 1002,
        // 宿主真实形状：外层 aborted，内层是谁取消的（那是另一个问题，判据不看它）
        data: { turn: 12, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
      },
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)).toEqual({ turn: 12, pendingTools: [] })
  })

  /**
   * 🔴🔴 **2026-11-04（owner 令）：「用户手工停止」必须排除 —— 本条取代了旧的正控。**
   *
   * 旧用例原话是「内层 user／parent／hook 的 aborted 都算（判据只看外层，不看谁取消的）」，
   * 那条**当时是对的**，但它成立于一个后来被事实推翻的前提：**没有人会手工停止**。
   * 实测它不成立 —— 外部用户报了「我没配任何监控，它自己跑起来了，我手工点的停止」。
   * ⇒ 兜底把人主动终止的轮次当成"该被接走" ⇒ **人越喊停它越来**。
   *
   * 现判据（**只加一格例外**，见 `isUserIntentStop`）：
   * · 内层 `user` ⇒ **不命中**（人的意图优先）
   * · 内层 `parent`／`disposed`／`hook`／**缺失** ⇒ **仍命中**（不是人对本会话做的决定）
   *
   * 🔴 **为什么 `disposed` 必须留下**：2026-10-23 那个 13 分钟盲窗正是重启打断造成的
   * （`runInterruptedSafetyNet` 头注有实测读数）。把它一起排除 = 修掉一个打扰，
   * 却复活一个已知事故 —— owner 2026-11-04 明令「重启后应当自动续跑」。
   */
  it('🔴 内层 parent／disposed／hook 的 aborted 仍算命中（重启保护不得丢）', () => {
    for (const inner of ['parent', 'disposed', 'hook']) {
      const events = [
        { type: 'turn/start', data: { turn: 3 } },
        { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: inner } } } },
      ]
      expect(detectInterruptedEnd(events), `内层=${inner} 应仍命中`).toEqual({ turn: 3, pendingTools: [] })
    }
  })

  it('🔴🔴 内层 user（用户手工停止）⇒ **不命中**（否则人越喊停它越来）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 3 } },
      // ⚠️ 真实形状：reason 里套着 reason。取错层不会报错，只会静默判错
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
    // 同时把两个导出的读数钉住（它们本身也是别的调用方的判据面）
    expect(isUserIntentStop(events)).toBe(true)
    expect(innerAbortCauseOf(events)).toBe('user')
  })

  it('🔴 内层缺失的 aborted ⇒ 仍命中（缺省方向 = 救，不是弃）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'turn/end', data: { turn: 5, reason: { kind: 'aborted' } } },
    ]
    expect(detectInterruptedEnd(events)).toEqual({ turn: 5, pendingTools: [] })
    expect(isUserIntentStop(events)).toBe(false)
  })

  it('🔴 真日志样本逐字回归（2026-11-04 本机 turn 67 实录）', () => {
    // 这一条刻意用**原始事件形状**，⛔ 不是手写"我以为的样子"：
    // 夹具与真物形状不一致时，再多用例也拦不住（判据纪律 #59）
    const real = {
      type: 'turn/end',
      seq: 14538,
      time: 1793533743937,
      data: { turn: 67, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    }
    const events = [{ type: 'turn/start', seq: 14530, time: 1793533700000, data: { turn: 67 } }, real]
    expect(detectInterruptedEnd(events), '用户手工停止的真实轮次不该被自动续跑').toBeNull()
  })

  /**
   * ⛔ 反向钉（与上面的正控**成对**，缺一不可）：
   * 「放宽」不能放到 `completed` 也命中 —— 那会把健康会话全部当成待续（灾难）。
   */
  it('🔴 反向钉：completed ⇒ 不命中（放宽不得放到"已完成"上）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', data: {} },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('🔴 反向钉：error ⇒ 不命中（错误轮次**有**收尾，不是"停在这里等人续"）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'turn/end', data: { turn: 4, reason: { kind: 'error', error: { message: 'x' } } } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('🔴 反向钉：aborted 之后又有新 turn/start ⇒ 不命中（已被接续）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 8 } },
      { type: 'turn/end', data: { turn: 8, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      { type: 'turn/start', data: { turn: 9 } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  /**
   * ⚠️ **已知边界（刻意不纳入 `detectInterruptedEnd`，写成用例以免后人"顺手补进去"）**：
   * 末条是 `turn/start` 后再无 `turn/end` 的"开轮未闭合"形态，
   * **在纯判定层不命中** —— 因为它与「进程正活着、这一轮正在跑」在日志读数上**不可分**。
   * ⇒ 它由 `detectUnclosedTurn` 负责（扫描层已用 `liveIds` 排除了在跑的会话）。
   */
  it('⚠️ `detectInterruptedEnd` 对"开了没收"不命中（该形态归 `detectUnclosedTurn`）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 30 } },
      { type: 'step/start', data: { turn: 30, step: 1 } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  /**
   * 🔴🔴 **2026-10-24 owner 报障的正解：`detectUnclosedTurn`（形态 B）**
   *
   * owner 原话：「我要求你抓到非工具调用的中断，现在什么都抓不到了」。
   * 真因：进程在**轮内任意位置**死掉 ⇒ 宿主**永远没机会写 `turn/end`**
   * ⇒ 日志停在 `tool/call` / `step/start` / `assistant/message` 上 ⇒ 修前整类被判成"没中断"。
   *
   * 实测（本机 10 个窗口内会话）：**4 条**只能由本形态抓到
   * （末条分别为 tool/call、step/start、tool/call、agent/inbox/spliced）。
   */
  it('🔴 `detectUnclosedTurn`：turn/start 后无 turn/end ⇒ 命中（轮内被打断）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 56 } },
      { type: 'step/start', data: { turn: 56, step: 1 } },
      { type: 'tool/call', data: { turn: 56, callId: 'c1', name: 'edit' } },
    ]
    expect(detectUnclosedTurn(events)).toEqual({ turn: 56, pendingTools: ['edit'] })
  })

  it('🔴 `detectUnclosedTurn`：末条是 tool/call（真日志最常见的形态）⇒ 命中', () => {
    // 与 session-99009627 实测尾部逐字同形
    const events = [
      { type: 'turn/start', data: { turn: 192 } },
      { type: 'assistant/message', data: { turn: 192, step: 3 } },
      { type: 'tool/call', data: { turn: 192, callId: 'c9', name: 'read' } },
    ]
    expect(detectUnclosedTurn(events)).toEqual({ turn: 192, pendingTools: ['read'] })
  })

  it('🔴 `detectUnclosedTurn` 反向钉：turn/end 在 turn/start **之后** ⇒ 不命中（已收尾）', () => {
    const events = [
      { type: 'turn/start', data: { turn: 7 } },
      { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } },
    ]
    expect(detectUnclosedTurn(events)).toBeNull()
  })

  it('🔴 `detectUnclosedTurn` 反向钉：没有 turn/start ⇒ 不命中（空会话不算中断）', () => {
    expect(detectUnclosedTurn([{ type: 'system/message', data: {} }])).toBeNull()
    expect(detectUnclosedTurn([])).toBeNull()
  })

  it('🔴 曾经 interrupted 但之后又有新事件 ⇒ 不命中（已恢复，不得当待续）', () => {
    const events = [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
      { type: 'turn/start', data: { turn: 6 } },
      { type: 'user/message', data: { content: 'later work' } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  /**
   * 🔴🔴 **D210 命中格（2026-10-23 从 `interrupted-cross-check.test.ts` 迁入）**
   *
   * 为什么迁到这里：那条判据**归 ACC**，它就该由 ACC 自己的用例钉住。
   * 原先它只活在"交叉校验"文件里 ⇒ 一旦那个文件因职责重组而改动，**这根唯一的钉就丢了**。
   * （guard 实测 grep 过全仓：只有那个文件提 `spliced`。）
   *
   * 形态（真机实测 26 条里漏掉的 2 条就是它）：
   * `turn/end[interrupted] -> session/end-seed -> agent/inbox/spliced -> agent/inbox/spliced`
   * ⇒ 重启后宿主把**待办消息重新塞进收件箱**，追加在 end-seed 之后
   * ⇒ 旧判据「末条必须 end-seed」在这之后**恒不成立** ⇒ 恰恰对「反复被打断者」失明。
   */
  it('🔴 D210：末轮 interrupted ＋ 之后仅非轮次事件（end-seed / inbox/spliced）⇒ **仍命中**', () => {
    const events = [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
      { type: 'agent/inbox/spliced', data: { target: 'main', start: 0, inserted: [] } },
      { type: 'agent/inbox/spliced', data: { target: 'main', start: 0, inserted: [] } },
    ]
    expect(detectInterruptedEnd(events), '非轮次事件不得让"停在这里"变成"已接续"').not.toBeNull()
  })

  /** 🔴 D210 的**反向钉**：放宽没把误报放进来 —— 中断之后真的又开了新轮 ⇒ 不命中 */
  it('🔴 D210 反向钉：interrupted ＋ inbox/spliced 之后**又有 turn/start** ⇒ 不命中', () => {
    const events = [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
      { type: 'agent/inbox/spliced', data: { target: 'main', start: 0, inserted: [] } },
      { type: 'turn/start', data: { turn: 6 } },
    ]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('末条不是 end-seed（会话仍在写）⇒ 不命中', () => {
    const events = [{ type: 'turn/start', data: { turn: 9 } }]
    expect(detectInterruptedEnd(events)).toBeNull()
  })

  it('空事件 ⇒ 不命中（不抛错）', () => {
    expect(detectInterruptedEnd([])).toBeNull()
  })

  /**
   * 🔴🔴 **2026-11-04 owner 报障的正解：`tool/result` 的 callId 在 `data.message` 里。**
   *
   * owner 贴屏：`[中断续跑]` 的「有调用无结果的工具」约 **150 项、大量重复**。
   * 真因见 `findPendingTools` 头注：修前读 `data.callId`（不存在）⇒ `resolved` 恒空集
   * ⇒ 清单退化成「这一轮的全部调用」。
   *
   * 🔴🔴 **本用例的构造形状逐字取自真机日志**（`dsh-session corpus raw` 读出，
   * ⛔ 不是按我的假设写的）—— 这正是它能抓出该 bug 的**唯一**原因：
   * 旧夹具也按虚构的 `data.callId` 构造 ⇒ 与实现一起错、一起绿（D275 同族）。
   *
   * ```jsonc
   * {"type":"tool/result","data":{"turn":3,"step":1,
   *   "message":{"role":"tool","source":{"kind":"tool","callId":"…"},"toolCallId":"…"}}}
   * ```
   *
   * 断言两件事，缺一不可（D254：变异正控 ＋ 反向钉）：
   * ① 有 result 的调用**不得**出现在清单里（这是 bug 的那一半）；
   * ② 真·无结果的调用**必须仍在**清单里（别把判据修成"永远空"）。
   */
  it('🔴🔴 tool/result 的 callId 在 data.message ⇒ 已完成的调用不得进清单（真机形状）', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 3 } },
      // 真机形状：callId 在 data 层
      { type: 'tool/call', data: { turn: 3, step: 1, callId: 'call_done', name: 'edit' } },
      // 真机形状：callId 在 data.message.toolCallId（＋ source.callId）
      {
        type: 'tool/result',
        data: {
          turn: 3,
          step: 1,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'call_done' },
            toolCallId: 'call_done',
            content: [{ type: 'text', text: 'ok' }],
          },
        },
      },
      { type: 'tool/call', data: { turn: 3, step: 2, callId: 'call_pending', name: 'im-bridge' } },
      { type: 'turn/end', time: 2, data: { turn: 3, reason: { kind: 'interrupted' } } },
      { type: 'session/end-seed', data: {} },
    ]
    // ① 已完成的 edit 不得出现；② 真·无结果的 im-bridge 必须仍在
    expect(detectInterruptedEnd(events)?.pendingTools).toEqual(['im-bridge'])
  })

  /**
   * 反向钉（D254）：**只读 `data.message.source.callId` 也必须能配上**。
   * 真机两处同时在场且相等，但那是**当前实现的属性**，不是协议保证 ⇒
   * 任一处在场都要能排除。本用例把 `toolCallId` **拿掉**，只留 `source.callId`。
   */
  it('🔴 callId 只在 data.message.source.callId 里（无 toolCallId）⇒ 同样能排除', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 4 } },
      { type: 'tool/call', data: { turn: 4, callId: 'c_a', name: 'read' } },
      {
        type: 'tool/result',
        data: { turn: 4, message: { role: 'tool', source: { kind: 'tool', callId: 'c_a' } } },
      },
      { type: 'turn/end', time: 2, data: { turn: 4, reason: { kind: 'aborted' } } },
    ]
    expect(detectInterruptedEnd(events)?.pendingTools).toEqual([])
  })

  /**
   * 🔴 **归零反面的守卫**：两处都没 callId 的 `tool/result` → **不参与排除**。
   * 判据取向 = 宁可多报一个"可能未完成"，也**不假报"全都完成了"**
   * （假报"都完成"会让模型跳过副作用核对 ⇒ 重复执行 ⇒ 比多列一项贵得多）。
   */
  it('🔴 结果事件两处都没有 callId ⇒ 不参与排除（宁多报不假清）', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 5 } },
      { type: 'tool/call', data: { turn: 5, callId: 'c_x', name: 'write' } },
      { type: 'tool/result', data: { turn: 5, message: { role: 'tool' } } },
      { type: 'turn/end', time: 2, data: { turn: 5, reason: { kind: 'interrupted' } } },
    ]
    expect(detectInterruptedEnd(events)?.pendingTools).toEqual(['write'])
  })
})

describe('scanInterruptedSessions（真日志 + 多帧）', () => {
  it('🔴 多帧 zstd 里能读到末事件（只解第一帧的实现会在这里红）', () => {
    writeSession('session-ok', [
      ...turnEvents(1, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-ok'])
    expect(r.sessions[0]?.turn).toBe(1)
  })

  it('完成的不命中，进 skipped 而不是 sessions', () => {
    writeSession('session-done', [
      ...turnEvents(2, 'completed'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions).toEqual([])
    expect(r.scanned).toBe(1)
    expect(r.skipped).toBe(1)
  })

  /**
   * 🔴 端到端（真 zstd 多帧 ⇒ 走 `readTailEvents` 真解析路径）：
   * `aborted` 形态必须被扫出来。这条与纯判定层的正控**分工不同** ——
   * 纯判定层证明"算对了"，这条证明"真的从盘上读到了"。
   */
  it('🔴 aborted 结尾的会话（重启打断）能被扫出，且带出轮次号', () => {
    writeSession('session-aborted', [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 54 } },
      {
        type: 'turn/end', seq: 2, time: 1002,
        data: { turn: 54, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
      },
      { type: 'session/end-seed', seq: 3, time: 1003, data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-aborted'])
    expect(r.sessions[0]?.turn).toBe(54)
  })

  it('无日志文件的目录被忽略（不算 scanned）', () => {
    mkdirSync(join(dir, 'empty-dir'), { recursive: true })
    const r = scanInterruptedSessions(dir)
    expect(r.scanned).toBe(0)
    expect(r.sessions).toEqual([])
  })

  /**
   * 🔴🔴 **端到端：形态 B（轮内被打断，日志里没有 `turn/end`）必须被扫出来。**
   *
   * 这是 owner 报障「不是崩溃的就扫不到」／「我要求你抓到非工具调用的中断」的**验收格**。
   * 修前这条必然红（`detectInterruptedEnd` 找不到 turn/end 就返回 null）。
   * ⚠️ 与纯判定层用例分工：那条证明 `detectUnclosedTurn` 算对了；
   *    这条证明**扫描层真的把它接进去了**（接线，不是算法）。
   */
  it('🔴 形态 B：日志停在 tool/call（轮内被打断，无 turn/end）⇒ 必须被扫出', () => {
    writeSession('session-unclosed', [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 192 } },
      { type: 'step/start', seq: 2, time: 1001, data: { turn: 192, step: 1 } },
      { type: 'assistant/message', seq: 3, time: 1002, data: { turn: 192, step: 1 } },
      { type: 'tool/call', seq: 4, time: 1003, data: { turn: 192, callId: 'c1', name: 'edit' } },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-unclosed'])
    expect(r.sessions[0]?.turn).toBe(192)
    expect(r.sessions[0]?.pendingTools).toEqual(['edit'])
  })

  it('🔴 形态 B 接线反向钉：已收尾（有 turn/end）的会话不得因接线而误报', () => {
    writeSession('session-closed', [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 5 } },
      { type: 'turn/end', seq: 2, time: 1002, data: { turn: 5, reason: { kind: 'completed' } } },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions).toEqual([])
    expect(r.skipped).toBe(1)
  })

  /**
   * 🔴🔴 **A108：`turn/start` 被推出窗口时，必须报「不可判定」，⛔ 不许塌成「没中断」。**
   *
   * **修前的形态**：窗口硬停在 400 条事件 ⇒ 一整轮超过 400 条时，它的 `turn/start`
   * 落在窗口外 ⇒ 判据函数看到"没有 turn/start"⇒ **判"没开轮"** ⇒ 报「没中断」。
   * 而那与"这轮早就干净收尾了"**返回值一模一样** ⇒ **"不知道"被塌成"没事"**。
   *
   * **怎么构造**：造一个**又长又碎**的轮（大量 `tool/result` 把 `turn/start` 推到窗口外），
   * 再在末尾放 `turn/end[completed]`。体积必须超过 8 MiB 硬上限才会走到 `exhausted`
   * ⇒ 用大块的 `tool/result` 把帧撑大（不靠条数，靠字节）。
   *
   * ⚠️ 这条钉的是**"不许沉默"**：只要 `undecidable` 里有它，就算合格；
   *   `sessions`（命中）**必须为空** —— 因为真正的答案确实是"不知道"。
   */
  it('🔴🔴 A108：turn/start 被推出 8 MiB 硬上限 ⇒ 落 `undecidable`，不得静默算"没事"', () => {
    // 🔴 必须用**真正不可压缩**的数据：全 'x' 被压到近零；**我自造的"伪随机"也被压到 16 KB**
    //    （它的周期太短）—— 两次都栽在这 ⇒ 改用 `randomBytes`，它压不动。
    const events: Array<Record<string, unknown>> = [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 7 } },
    ]
    for (let i = 0; i < 16; i++) {
      events.push({
        type: 'tool/result',
        seq: 2 + i,
        time: 1001 + i,
        // 形状同真机（callId 在 data.message 里）；本用例只靠体积，形状只为一致
        data: {
          turn: 7,
          message: { role: 'tool', toolCallId: `c${i}`, content: [{ type: 'text', text: randomBytes(600_000).toString('base64') }] },
        },
      })
    }
    events.push({ type: 'turn/end', seq: 9999, time: 9000, data: { turn: 7, reason: { kind: 'completed' } } })
    const sessionDir = writeSession('session-huge-turn', events)

    // 前提自证（D-族：用例要自证前提，否则红的是用例不是实现）
    const logBytes = statSync(join(sessionDir, 'session.v4.jsonl.zstd')).size
    expect(logBytes, '构造的日志必须真的超过 8 MiB 硬上限，否则走不到 exhausted 那一格').toBeGreaterThan(8 << 20)

    const r = scanInterruptedSessions(dir)
    // 🔴 核心断言：它必须出现在 `undecidable`，而不是被静默算成"跳过/没事"
    expect(
      r.undecidable.map((u) => u.sessionId),
      'turn/start 被挤出 8 MiB ⇒ 这一格不可判定；若这里为空，说明"不知道"被塌成了"没中断"（A108 复发）',
    ).toEqual(['session-huge-turn'])
    // 反向钉：它**不该**被当成命中（真正的答案就是"不知道"，不是"命中了"）
    expect(r.sessions).toEqual([])
    // 反向钉：也**不该**混进 skipped 里（skipped 的语义是"看过、判定没事"）
    expect(r.skipped).toBe(0)
  })

  it('🔴 A108 反向钉：正常长度的轮（turn/start 在窗口内）**不得**被判成不可判定', () => {
    writeSession('session-normal', [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 3 } },
      { type: 'tool/call', seq: 2, time: 1001, data: { turn: 3, callId: 'c1', name: 'read' } },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.undecidable).toEqual([])
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-normal'])
  })

  it('🔴 A108 反向钉：空会话（从没有过轮）⇒ 不得判成不可判定', () => {
    writeSession('session-empty', [{ type: 'session/header', seq: 0, time: 1000, data: {} }])
    const r = scanInterruptedSessions(dir)
    // "从来没有过轮"是**确定的**，不是"不知道" ⇒ 必须落 skipped，不许进 undecidable
    expect(r.undecidable).toEqual([])
    expect(r.sessions).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('🔴 形态 B 接线反向钉 · 第二个：已收尾的会话同样不得误报', () => {
    writeSession('session-closed2', [
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 5 } },
      { type: 'turn/end', seq: 2, time: 1002, data: { turn: 5, reason: { kind: 'completed' } } },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('🔴 回看窗口生效：窗口外的会话不被检查', () => {
    const sessionDir = writeSession('session-old', [
      ...turnEvents(4, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000)
    utimesSync(logPath, longAgo, longAgo)

    const r = scanInterruptedSessions(dir, { lookbackMs: 8 * 3600 * 1000 })
    expect(r.scanned).toBe(0)
    expect(r.sessions).toEqual([])
  })

  it('liveIds 的会话被跳过（正在跑的不算待续）', () => {
    writeSession('session-live', [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir, { liveIds: new Set(['session-live']) })
    expect(r.scanned).toBe(0)
    expect(r.sessions).toEqual([])
  })

  /**
   * 🔴🔴 **D245 反向钉：排除必须登记，不许静默吞掉。**
   *
   * **原形态**（修前）：`if (liveIds.has(sessionId)) continue` —— 既不计数也不报告。
   * 真机代价：同一次扫描出现**两个互不兼容的读数** ——
   * 生产 tick 日志写「扫 11 · 排除在跑 4」，而工具输出（guard 查的那个）写
   * 「检查 7 · 命中 0 · 跳过 7」⇒ guard 判「没事」⇒ **该救的 4 个无人过问**。
   *
   * ⇒ 判据：`excluded` 必须列出被排除的会话，且 `scanned + excluded.length` = 窗口内总数。
   */
  it('🔴🔴 D245：被 liveIds 排除的会话必须出现在 `excluded` 里（不许静默吞掉）', () => {
    writeSession('session-live', [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    writeSession('session-dead', [
      ...turnEvents(6, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    const r = scanInterruptedSessions(dir, { liveIds: new Set(['session-live']) })
    // 被排除的那个**必须**登记（这是本条的全部意义）
    expect(r.excluded, '排除集为空 ⇒ 读者会以为"窗口内就这么点会话"').toEqual(['session-live'])
    // 窗口内总数 = 检查 + 排除（两个数必须自洽）
    expect(r.scanned + r.excluded.length).toBe(2)
    // 反向钉：另一个仍被正常检查到（排除没有波及无关会话）
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-dead'])
  })

  it('🔴 D245 反向钉：排除数不能把「窗口外」的会话算进来', () => {
    writeSession('session-live-old', [
      ...turnEvents(5, 'interrupted'),
      { type: 'session/end-seed', data: {} },
    ])
    // 把 mtime 推到 48h 前 ⇒ 它在回看窗口**之外**
    const logPath = join(dir, 'session-live-old', 'session.v4.jsonl.zstd')
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000)
    utimesSync(logPath, longAgo, longAgo)

    const r = scanInterruptedSessions(dir, {
      lookbackMs: 8 * 3600 * 1000,
      liveIds: new Set(['session-live-old']),
    })
    // 窗口外的会话不该被算进「窗口内被排除 N 个」—— 否则那个读数会失真
    expect(r.excluded).toEqual([])
  })

  it('不存在的根目录 ⇒ 空结果（非错误）', () => {
    const r = scanInterruptedSessions(join(dir, 'does-not-exist'))
    expect(r.sessions).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('多条命中按时间倒序（最新在前）', () => {
    writeSession('session-a', [
      ...turnEvents(1, 'interrupted'),
      { type: 'session/end-seed', time: 5_000, data: {} },
    ])
    writeSession('session-b', [
      ...turnEvents(2, 'interrupted'),
      { type: 'session/end-seed', time: 9_000, data: {} },
    ])
    const r = scanInterruptedSessions(dir)
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['session-b', 'session-a'])
  })
})

describe('projectDirNameForCwd（宿主目录名规则）', () => {
  // ⚠️ 用中性路径做夹具：真实家目录路径会被 privacy-scan 拦下（D145 —— 写进 tests/ 的
  //    注释与字面量**同样过隐私门**）。此处只验"规则"，不验"某个具体机器"。
  it('绝对路径 → --a-b-c-- 形态', () => {
    expect(projectDirNameForCwd('/srv/example/workspace')).toBe('--srv-example-workspace--')
  })

  it('尾部斜杠被忽略（两种写法得到同一个目录名）', () => {
    expect(projectDirNameForCwd('/srv/example/workspace/')).toBe('--srv-example-workspace--')
  })

  it('单层路径也能正确成型', () => {
    expect(projectDirNameForCwd('/workspace')).toBe('--workspace--')
  })
})

/**
 * 🔴 `formatPendingTools` 的**契约单测**（折叠的唯一实现点）。
 *
 * 三个渲染面（进提示词的 `buildContinueText` ＋ 两个界面渲染函数）都调它 ——
 * 所以它的边界必须在**它自己这一层**钉死，而不是靠三个调用方各自断言（D274：钉本意）。
 */
describe('formatPendingTools（清单折叠）', () => {
  it('空清单 ⇒ 空串（调用方据此决定要不要印这一行）', () => {
    expect(formatPendingTools([])).toBe('')
  })

  it('未超上限 ⇒ 逐项全列，无计数尾巴', () => {
    expect(formatPendingTools(['a', 'b', 'c'])).toBe('a, b, c')
  })

  it('恰好等于上限 ⇒ 不折叠（边界是 ≤，⛔ 不是 <）', () => {
    const eight = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']
    expect(formatPendingTools(eight)).toBe(eight.join(', '))
    expect(formatPendingTools(eight)).not.toContain('等共')
  })

  it('超上限 1 项 ⇒ 就折叠，且总数（不是剩余数）可见', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`)
    const out = formatPendingTools(nine)
    expect(out).toContain('等共 9 项')
    expect(out).toContain('t7')
    expect(out).not.toContain('t8')
  })

  it('🔴 重复项**不在这里去重** —— 同一工具被调用多次且都无结果，那是真实信息', () => {
    const dup = ['edit', 'edit', 'edit']
    expect(formatPendingTools(dup)).toBe('edit, edit, edit')
  })
})

describe('buildContinueText（续跑正文）', () => {
  /**
   * 🔴🔴 **2026-11-04（owner 报障）：正文必须自报身份 —— 这不是人安排的。**
   *
   * 实测代价：外部用户收到续跑消息后问「这个续跑的消息你知道来源哪里吗」，
   * 并且**用了一整轮**去查 live 会话／唤醒表／CRO 才确认是系统自己发的。
   * 根因：修前正文只有一句祈使句「请接着完成该轮未完成的工作」，
   * **完全看不出是谁在说话** ⇒ 人默认以为有人在派活。
   *
   * ⚠️ 本条是**补的**：改文案时原有用例全绿（它们只钉了"含 session id / turn / 副作用警告"），
   * 说明**没有任何用例钉住"首行说了什么"** —— 那正是最容易退化的一格。
   */
  it('🔴🔴 首行必须自报「这是 ACC 自动发的」（否则人以为是有人派活）', () => {
    const t = buildContinueText('session-a', 1, [])
    const firstLine = t.split('\n')[0]
    expect(firstLine, '首行必须标明自动身份').toContain('ACC 自动')
    expect(firstLine, '首行必须说明不是人安排的').toMatch(/不是你安排的/)
  })

  it('🔴 必须说明「手工停止的轮次不会被续跑」（给读者一个可行动的事实）', () => {
    const t = buildContinueText('session-b', 1, [])
    expect(t).toMatch(/手工点过.*停止.*不会/)
  })

  it('无未完成调用 ⇒ 不提副作用核对（不制造无谓警告）', () => {
    const t = buildContinueText('session-x', 7, [])
    expect(t).toContain('session-x')
    expect(t).toContain('turn 7')
    expect(t).not.toContain('副作用未知')
  })

  it('🔴 有未完成调用 ⇒ 必须警告"副作用未知≠没执行"并禁止整段重放', () => {
    const t = buildContinueText('session-y', 3, ['edit', 'im-bridge'])
    expect(t).toContain('edit, im-bridge')
    expect(t).toContain('副作用未知')
    expect(t).toContain('可能已经执行')
    expect(t).toContain('不要把被中断的那一轮整段重放')
  })

  it('🔴 正文不含版本号（D159：唤醒文本不得写死版本）', () => {
    const t = buildContinueText('session-z', 1, [])
    expect(t).not.toMatch(/v?\d+\.\d+\.\d+/)
  })

  /**
   * 🔴🔴 **折叠判据（owner 报障的另一半）：注入正文不许被上百个名字撑爆。**
   *
   * 真机代价：一次误判 ⇒ 约 150 项名字进正文 ⇒ **每一轮的 token 成本**
   * （正文是注入进提示词的，不是界面日志）。
   *
   * 断言三件事：
   * ① 总数字必须仍然可见（D276：难看 ≠ 可以丢信息）；
   * ② 名字个数不得超过显示上限（否则折叠没生效）；
   * ③ **未折叠时不得出现计数**（反向钉：别让小清单也挂个尾巴）。
   */
  it('🔴 清单超上限 ⇒ 折叠成计数，但总数仍可见', () => {
    const many = Array.from({ length: 150 }, (_, i) => `tool_${i}`)
    const t = buildContinueText('session-big', 9, many)
    expect(t, '总数必须仍可见（折叠≠丢信息）').toContain('等共 150 项')
    // 折叠后实际列出的名字个数 = 显示上限（前 8 项）
    expect(t).toContain('tool_0')
    expect(t).toContain('tool_7')
    expect(t, '第 9 项起应被折叠掉').not.toContain('tool_8')
    // 有效载荷不许随清单线性膨胀
    expect(t.length).toBeLessThan(1000)
  })

  it('🔴 折叠反向钉：未超上限 ⇒ 原样全列，不得出现计数尾巴', () => {
    const t = buildContinueText('session-s', 2, ['read', 'edit', 'write'])
    expect(t).toContain('read, edit, write')
    expect(t).not.toContain('等共')
  })

  it('🔴 折叠边界：恰好等于上限 ⇒ 不折叠（≤ 而非 <）', () => {
    const exact = Array.from({ length: 8 }, (_, i) => `t${i}`)
    const t = buildContinueText('session-e', 1, exact)
    expect(t).toContain('t7')
    expect(t).not.toContain('等共')
  })
})

describe('createResumeOne（逐条注入）', () => {
  function fakeAgent(behaviour: { steerThrows?: boolean; status?: string } = {}) {
    const calls: string[] = []
    return {
      calls,
      agent: {
        status: behaviour.status ?? 'idle',
        steer: (m: unknown) => {
          calls.push(`steer:${JSON.stringify(m)}`)
          if (behaviour.steerThrows) throw new Error('steer boom')
        },
        followup: (m: unknown) => {
          calls.push(`followup:${JSON.stringify(m)}`)
        },
      },
    }
  }

  it('live 会话且空闲 ⇒ followup', async () => {
    const { agent, calls } = fakeAgent({ status: 'idle' })
    const one = createResumeOne({
      agents: { get: () => agent },
      sessionController: undefined,
      makeMessage: (text) => ({ text }),
    })
    const out = await one({ sessionId: 's1', turn: 1, pendingTools: [] })
    expect(out.ok).toBe(true)
    expect(out.how).toBe('live+followup')
    expect(calls[0]).toContain('followup')
  })

  it('live 会话且在跑 ⇒ steer（当场注入当前轮）', async () => {
    const { agent, calls } = fakeAgent({ status: 'running' })
    const one = createResumeOne({
      agents: { get: () => agent },
      sessionController: undefined,
      makeMessage: (text) => ({ text }),
    })
    const out = await one({ sessionId: 's2', turn: 2, pendingTools: [] })
    expect(out.how).toBe('live+steer')
    expect(calls[0]).toContain('steer')
  })

  it('🔴 steer 抛错 ⇒ 退回 followup（宁可排队，不可静默丢）', async () => {
    const { agent, calls } = fakeAgent({ status: 'running', steerThrows: true })
    const one = createResumeOne({
      agents: { get: () => agent },
      sessionController: undefined,
      makeMessage: (text) => ({ text }),
    })
    const out = await one({ sessionId: 's3', turn: 3, pendingTools: [] })
    expect(out.ok).toBe(true)
    expect(out.how).toContain('followup')
    expect(calls.some((c) => c.includes('followup'))).toBe(true)
  })

  it('冷会话 ⇒ 走 sessionController.resolveAgent', async () => {
    const { agent, calls } = fakeAgent({ status: 'idle' })
    let asked: string | null = null
    const one = createResumeOne({
      agents: { get: () => undefined },
      sessionController: {
        resolveAgent: async (id: string) => {
          asked = id
          return { agent }
        },
      },
      makeMessage: (text) => ({ text }),
    })
    const out = await one({ sessionId: 'cold-1', turn: 4, pendingTools: [] })
    expect(asked).toBe('cold-1')
    expect(out.ok).toBe(true)
    expect(out.how).toBe('cold-resume+followup')
    expect(calls.length).toBe(1)
  })

  it('sessionController 缺失 ⇒ 明确报"不可用"（不静默）', async () => {
    const one = createResumeOne({
      agents: { get: () => undefined },
      sessionController: undefined,
      makeMessage: (text) => ({ text }),
    })
    const out = await one({ sessionId: 'cold-2', turn: 5, pendingTools: [] })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('sessionController')
  })

  it('冷载入报错 ⇒ 把原因带出来（不吞）', async () => {
    const one = createResumeOne({
      agents: { get: () => undefined },
      sessionController: { resolveAgent: async () => ({ error: 'not found' }) },
      makeMessage: (text) => ({ text }),
    })
    const out = await one({ sessionId: 'cold-3', turn: 6, pendingTools: [] })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('not found')
  })
})
