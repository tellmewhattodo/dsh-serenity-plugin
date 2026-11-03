/**
 * user-quotes-origin.test.ts — DII M3 的判据：**冒充者由结构排除，不再靠措辞**
 *
 * ## 这份文件要证明什么
 *
 * 修前：`kind==='user'` ＋ **正文标记黑名单**（`CARRIER_OPENING_MARK` / `ASSISTANT_PREFIX`）。
 * 那是"事后辨认"——判据不完备（corpus 的 20+ 条措辞黑名单就是同一个病）。
 *
 * 修后：**`source.origin` 是主判据**。本文件钉的就是这个升级：
 *   ① 带 `origin:'acc'` 的消息 —— **哪怕正文里没有任何标记**，也必须不入账
 *   ② 带 `origin:'agent'` 的消息（subagent 任务书）—— 同上
 *   ③ 真人（`kind:'user'` 且**无 origin 字段**）—— 必须入账
 *
 * 🔴 **①是关键**：它证明新判据**不依赖措辞**。修前那条世界（只认标记）在 ① 上会**误收**。
 * ⇒ 这组断言把"措辞黑名单"与"结构判据"的差别**机械地摆出来**，而不是靠注释声称。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyUserMessage,
  recordUserQuotes,
  userQuoteFileName,
  __resetUserQuoteDedupeForTest,
} from '../src/trajectory/user-quotes.js'
import { ACC_MESSAGE_KIND } from '../src/kernel/message-source.js'

const FIXED_MS = 1_800_000_000_000
let dir = ''

function msg(id: string, text: string, source: unknown): { id: string; source: unknown; content: unknown } {
  return { id, source, content: [{ type: 'text', text }] }
}

beforeEach(() => {
  __resetUserQuoteDedupeForTest()
  dir = mkdtempSync(join(tmpdir(), 'uq-origin-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('结构判据：origin 说话，措辞不参与', () => {
  /**
   * 🔴 **本条的构造很关键，改坏了它就变成假绿（我第一版正是）**：
   * 消息的 `kind` 必须是 `'user'`（而不是我们自己的 kind），这样**只有 `origin` 能排除它**。
   * 第一版让 kind 也是 `ACC_MESSAGE_KIND` ⇒ 把 origin 判据**整条删掉**它照样红不了，
   * 因为第二道守卫（kind !== 'user'）兜住了 ⇒ 变异检验抓出这是假绿。
   * ⇒ 判据只能有一份守它：**origin**。这正是 M3 要证明的东西。
   */
  it("① origin:'acc' ＋ kind:'user' ＋ 正文毫无标记 ⇒ 不入账（只有 origin 能排除它）", () => {
    const src = { kind: 'user', origin: 'acc' }
    expect(classifyUserMessage(src, '这是一句完全正常的话，没有任何标记')).toBe('not-user')
    const r = recordUserQuotes(dir, 'S1', [msg('m1', '这是一句完全正常的话', src)], FIXED_MS)
    expect(r.written).toBe(0)
    expect(existsSync(join(dir, 'AGENT_SESSIONS/_user-quotes', userQuoteFileName(FIXED_MS)))).toBe(false)
  })

  it("② origin:'agent'（subagent 任务书）＋ kind:'user' ⇒ 不入账", () => {
    // ⚠️ 同上：kind 必须是 'user'，否则这条也只测到第二道守卫。
    const src = { kind: 'user', origin: 'agent' }
    expect(classifyUserMessage(src, '你在宁静号 CCC 做一次调研…')).toBe('not-user')
    const r = recordUserQuotes(dir, 'S1', [msg('m1', '你在宁静号 CCC 做一次调研…', src)], FIXED_MS)
    expect(r.written).toBe(0)
  })

  it('③ 真人（kind:user 且无 origin 字段）⇒ 必须入账（正控：别把一切排除掉）', () => {
    const src = { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' }
    expect(classifyUserMessage(src, '我说一句真话')).toBe('quote')
    const r = recordUserQuotes(dir, 'S1', [msg('m1', '我说一句真话', src)], FIXED_MS)
    expect(r.written).toBe(1)
  })

  // ── 变异检验：把 origin 判据去掉，①② 必须变红（它们现在**只**靠 origin） ──
  it('变异 A：去掉 origin 后，① 会被误收 ⇒ 证明①的判别力来自 origin 而非 kind', () => {
    // 旧世界：只有 kind:'user'（充认者没有 origin 字段）⇒ 收
    expect(classifyUserMessage({ kind: 'user' }, '这是一句完全正常的话，没有任何标记')).toBe('quote')
    // 新世界：同一句话但带 origin:'acc' ⇒ 不收
    expect(classifyUserMessage({ kind: 'user', origin: 'acc' }, '这是一句完全正常的话，没有任何标记')).toBe(
      'not-user',
    )
    // ⇒ 两个世界读数不同 ⇒ 断言有判别力，不是恒真
  })

  it('变异 B：真实宿主 kind（plugin:…）即使没有 origin 也判 not-user（双保险）', () => {
    expect(classifyUserMessage({ kind: ACC_MESSAGE_KIND }, 'x')).toBe('not-user')
  })
})

describe('过渡期兜底：旧形态日志（无 origin）仍靠标记排除，且被单独计数', () => {
  it('无 origin 的旧载体开场白 ⇒ fake-user，并计入 excludedFake（迁移进度读数）', () => {
    const src = { kind: 'user' } // 旧形态：冒充者还没有 origin 字段
    const text = '[ACC 代用户开场] 激活认知轨迹 S142，接着它 SESSION.md 里的工作往下做。'
    expect(classifyUserMessage(src, text)).toBe('fake-user')
    const r = recordUserQuotes(dir, 'S1', [msg('m1', text, src)], FIXED_MS)
    expect(r.written).toBe(0)
    expect(r.excludedFake).toBe(1)
  })

  it('新形态（带 origin）**不会**再走标记兜底 ⇒ excludedFake 不增长', () => {
    const src = { kind: ACC_MESSAGE_KIND, origin: 'acc' }
    const text = '[ACC 代用户开场] 同样的话，但现在带 origin'
    expect(classifyUserMessage(src, text)).toBe('not-user') // 不是 fake-user
    const r = recordUserQuotes(dir, 'S1', [msg('m1', text, src)], FIXED_MS)
    expect(r.written).toBe(0)
    expect(r.excludedFake).toBe(0) // ← 这个 0 是"新判据已接管"的读数
  })
})

describe('落盘内容：origin 不出现在台账里（台账只有原话）', () => {
  it('真人那一条的落盘 JSON 只有约定字段，没有 source/origin 泄漏', () => {
    recordUserQuotes(dir, 'S1', [msg('m1', '真话', { kind: 'user', rpcId: 'r' })], FIXED_MS)
    const p = join(dir, 'AGENT_SESSIONS/_user-quotes', userQuoteFileName(FIXED_MS))
    const line = JSON.parse(readFileSync(p, 'utf8').trim()) as Record<string, unknown>
    expect(Object.keys(line).sort()).toEqual(['chars', 'messageId', 'sessionId', 'text', 'trajectory', 'ts'])
    expect(JSON.stringify(line)).not.toContain('origin')
  })
})
