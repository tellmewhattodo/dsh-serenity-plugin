/**
 * user-quotes.test.ts — 用户语录台账（v1.113.0，owner 2026-11-02 需求）
 *
 * ## 本文件钉的四件事
 *
 * 1. 🔴🔴 **两条变异检验**（这是本批的验收核心，D229：变异检验防退化）：
 *    - **变体 A**：`source.kind === 'plugin:dsh-serenity-hooks'` 的注入消息 ⇒ **必须不入账**
 *    - **变体 B**：`source.kind === 'user'` 的真发言 ⇒ **必须入账**
 *    ⚠️ 两条必须**同时**在，且都配正控：只做 A ⇒ "什么都不写"也能通过；
 *       只做 B ⇒ "什么都写"也能通过。**只有一对同时钉住，才排除了这两种平凡实现。**
 * 2. **两个冒充者必须被排除**（载体开场白 / rebuild 锚点）—— 它们也声明 `kind:'user'`。
 *    ⚠️ 且**必须配正控**：真发言的正文里若恰好含无关文字，不能被误排除。
 * 3. **Q1「按轨迹」**：入账行的 `trajectory` 来自绑定真相源；未绑定 ⇒ `null` 但**照常入账**。
 * 4. **Q3「全文」**：`text` 一字不改（含换行/空白/标点），`chars` 是**码点数**不是 UTF-16 单元数。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  recordUserQuotes,
  classifyUserMessage,
  messageText,
  userQuoteFileName,
  localIso,
  USER_QUOTES_DIR,
  __resetUserQuoteDedupeForTest,
  type UserQuote,
} from '../src/trajectory/user-quotes.js'
import { readUserQuotesEnabled } from '../src/kernel/ccc.js'
import { CARRIER_OPENING_MARK } from '../src/trajectory/user-carrier.js'
import { ASSISTANT_PREFIX } from '../src/trajectory/assistant.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uq-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
  __resetUserQuoteDedupeForTest()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeCccConfig(value: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(value))
}

/** 真用户的发言形状（宿主实测：`{"kind":"user","rpcId":…,"clientTimeZone":…}`） */
function realUserMessage(id: string, text: string) {
  return {
    id,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user', rpcId: `rpc-${id}`, clientTimeZone: 'Asia/Shanghai' },
  }
}

/** ACC 注入的形状（唤醒/提醒/打回：`{"kind":"plugin:dsh-serenity-hooks"}`） */
function accInjectedMessage(id: string, text: string) {
  return {
    id,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin:dsh-serenity-hooks' },
  }
}

function readFile(name: string): UserQuote[] {
  const p = join(dir, USER_QUOTES_DIR, name)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as UserQuote)
}

/** 固定时点，让"按天分文件"成为可断言的确定值 */
const FIXED_MS = Date.parse('2026-11-02T21:42:37+08:00')

// ────────────────────────────────────────────────────────────────────────────
// 一、两条变异检验（本批验收核心）
// ────────────────────────────────────────────────────────────────────────────

describe('变异检验 A：ACC 注入（kind=plugin:…）必须不入账', () => {
  it('只有注入消息时，台账文件根本不出现', () => {
    const r = recordUserQuotes(dir, 'session-x', [accInjectedMessage('m1', '[认知轨迹唤醒] 到点')], FIXED_MS)
    expect(r.written).toBe(0)
    // 🔴 断言"文件不存在"，比断言"文件里 0 行"更强：连空文件都不该造出来。
    expect(existsSync(join(dir, USER_QUOTES_DIR, userQuoteFileName(FIXED_MS)))).toBe(false)
  })

  it('同时有注入与真发言时，只写进真那条（注入被丢掉）', () => {
    const r = recordUserQuotes(dir, 'session-x', [
      accInjectedMessage('m1', '[认知轨迹唤醒] 到点'),
      realUserMessage('m2', '把那段代码删掉'),
    ], FIXED_MS)
    expect(r.written).toBe(1)
    const rows = readFile(userQuoteFileName(FIXED_MS))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('把那段代码删掉')
    expect(rows[0]!.messageId).toBe('m2')
  })
})

describe('变异检验 B：真发言（kind=user）必须入账', () => {
  it('用户真说一句 ⇒ 当天文件里出现一行，内容逐字相同', () => {
    const r = recordUserQuotes(dir, 'session-x', [realUserMessage('m9', '这个功能什么时候能用')], FIXED_MS)
    expect(r.written).toBe(1)
    const rows = readFile(userQuoteFileName(FIXED_MS))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('这个功能什么时候能用')
  })

  /**
   * 🔴 判别力证明：把主判据弄坏（改判另一端）⇒ 上两条必须变红。
   * 这里用**纯函数**直接钉：`classifyUserMessage` 对两种 kind 给出相反的答案。
   * 若哪天有人把 `!== 'user'` 写成 `=== 'user'`，本用例立刻红。
   */
  it('classifyUserMessage 对两种 kind 给出相反答案（判别力自证）', () => {
    expect(classifyUserMessage({ kind: 'user' }, '普通发言')).toBe('quote')
    expect(classifyUserMessage({ kind: 'plugin:dsh-serenity-hooks' }, '注入')).toBe('not-user')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 二、两个冒充者（也声明 kind:'user'）
// ────────────────────────────────────────────────────────────────────────────

describe('冒充者排除（载体开场白 / rebuild 锚点）', () => {
  it('载体开场白不入账，且被计入 excludedFake', () => {
    const text = `${CARRIER_OPENING_MARK} 激活认知轨迹 S142（dsh 维护），接着它 SESSION.md 里的工作往下做。`
    const r = recordUserQuotes(dir, 'session-x', [realUserMessage('m1', text)], FIXED_MS)
    expect(r.written).toBe(0)
    expect(r.excludedFake).toBe(1)
  })

  it('rebuild 锚点不入账', () => {
    const text = `${ASSISTANT_PREFIX} · REBUILD] The conversation has been cleared and rebuilt…`
    const r = recordUserQuotes(dir, 'session-x', [realUserMessage('m1', text)], FIXED_MS)
    expect(r.written).toBe(0)
    expect(r.excludedFake).toBe(1)
  })

  /**
   * 🔴 正控（D222）：反向钉必须配正控，否则"把一切排除掉"也能让上面两条通过。
   * 判据 = 真发言**正文中间**提到这些词不算冒充（只有**开头**才是冒充者的形态）。
   */
  it('正控：真发言正文中间出现这些词 ⇒ 照常入账', () => {
    const text = `你看 ${CARRIER_OPENING_MARK} 这段标记是什么意思？后面还有 ${ASSISTANT_PREFIX} 这个词`
    const r = recordUserQuotes(dir, 'session-x', [realUserMessage('m1', text)], FIXED_MS)
    expect(r.written).toBe(1)
    expect(r.excludedFake).toBe(0)
    expect(readFile(userQuoteFileName(FIXED_MS))[0]!.text).toBe(text)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 三、Q1「按轨迹」
// ────────────────────────────────────────────────────────────────────────────

describe('Q1：按轨迹归集', () => {
  it('已绑定的会话 ⇒ trajectory 记录持有它的轨迹目录名', () => {
    const traj = '2026-08-24--S142--dsh-serenity-plugin 长期维护'
    mkdirSync(join(dir, 'AGENT_SESSIONS', traj), { recursive: true })
    // 绑定真相源 = current.dsh_session_bind（单文件单槽）
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', traj, 'current.dsh_session_bind'),
      JSON.stringify({ sessionId: 'session-bound' }),
    )
    const r = recordUserQuotes(dir, 'session-bound', [realUserMessage('m1', '继续干活')], FIXED_MS)
    expect(r.written).toBe(1)
    expect(readFile(userQuoteFileName(FIXED_MS))[0]!.trajectory).toBe(traj)
  })

  it('未绑定的会话 ⇒ trajectory 为 null，但**照常入账**（不制造系统性空洞）', () => {
    const r = recordUserQuotes(dir, 'session-orphan', [realUserMessage('m1', '随便问问')], FIXED_MS)
    expect(r.written).toBe(1)
    const row = readFile(userQuoteFileName(FIXED_MS))[0]!
    expect(row.trajectory).toBeNull()
    expect(row.sessionId).toBe('session-orphan')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 四、Q3「全文」与按天分文件
// ────────────────────────────────────────────────────────────────────────────

describe('Q3：全文，一字不改', () => {
  it('换行/缩进/标点全部保留（不做 trim、不做摘要）', () => {
    const text = '第一行\n  缩进两格\n\n末尾有空格   '
    recordUserQuotes(dir, 's', [realUserMessage('m1', text)], FIXED_MS)
    expect(readFile(userQuoteFileName(FIXED_MS))[0]!.text).toBe(text)
  })

  it('chars 是码点数（emoji 算 1），不是 UTF-16 单元数', () => {
    const text = '😀好' // 码点 2；UTF-16 length 3
    recordUserQuotes(dir, 's', [realUserMessage('m1', text)], FIXED_MS)
    const row = readFile(userQuoteFileName(FIXED_MS))[0]!
    expect(text.length).toBe(3) // 前提：.length 确实不是 2
    expect(row.chars).toBe(2)
  })

  it('按天分文件：不同日期落不同文件', () => {
    const day1 = Date.parse('2026-11-02T23:59:00+08:00')
    const day2 = Date.parse('2026-11-03T00:01:00+08:00')
    recordUserQuotes(dir, 's', [realUserMessage('m1', '前一天')], day1)
    recordUserQuotes(dir, 's', [realUserMessage('m2', '后一天')], day2)
    expect(readFile(userQuoteFileName(day1)).map((r) => r.text)).toEqual(['前一天'])
    expect(readFile(userQuoteFileName(day2)).map((r) => r.text)).toEqual(['后一天'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 五、去重（只按 messageId，不按文本）
// ────────────────────────────────────────────────────────────────────────────

describe('去重', () => {
  it('同一条消息被 pre-step 看到两遍 ⇒ 只记一次', () => {
    const m = realUserMessage('dup-1', '说一遍')
    recordUserQuotes(dir, 's', [m], FIXED_MS)
    const second = recordUserQuotes(dir, 's', [m], FIXED_MS)
    expect(second.written).toBe(0)
    expect(second.skippedDuplicate).toBe(1)
    expect(readFile(userQuoteFileName(FIXED_MS))).toHaveLength(1)
  })

  /**
   * 🔴 用户真的重复说同一句话是**合法事实**，⛔ 不许按文本去重把它吞掉
   * （那会"用去重制造假数据"）。
   */
  it('不同 messageId 但文本相同 ⇒ 两条都记（重复是真事实）', () => {
    recordUserQuotes(dir, 's', [realUserMessage('a', '嗯')], FIXED_MS)
    recordUserQuotes(dir, 's', [realUserMessage('b', '嗯')], FIXED_MS)
    expect(readFile(userQuoteFileName(FIXED_MS))).toHaveLength(2)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 六、开关与健壮性
// ────────────────────────────────────────────────────────────────────────────

describe('CCC 开关（Q2）', () => {
  it('缺省（没有配置文件）⇒ 关', () => {
    expect(readUserQuotesEnabled(dir)).toBe(false)
  })

  it('enabled: true ⇒ 开', () => {
    writeCccConfig({ userQuotes: { enabled: true } })
    expect(readUserQuotesEnabled(dir)).toBe(true)
  })

  /**
   * 🔴 判据是 `=== true`：含糊的配置必须落到"不写"那一侧（fail-closed）。
   * 这里的危险方向是**多写**（长期留存用户原话），与订阅表的 fail-open 相反。
   */
  it('含糊值一律当关（"true" 字符串 / 1 / 空对象 / false）', () => {
    for (const cfg of [
      { userQuotes: { enabled: 'true' } },
      { userQuotes: { enabled: 1 } },
      { userQuotes: {} },
      { userQuotes: { enabled: false } },
      { userQuotes: null },
      {},
    ]) {
      writeCccConfig(cfg)
      expect(readUserQuotesEnabled(dir), JSON.stringify(cfg)).toBe(false)
    }
  })

  it('配置 JSON 坏掉 ⇒ 当关（不抛）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), '{ 这不是 JSON')
    expect(readUserQuotesEnabled(dir)).toBe(false)
  })
})

describe('健壮性：台账失败不抛给调用方', () => {
  it('空 messages / 非数组 ⇒ written 0，不抛', () => {
    expect(recordUserQuotes(dir, 's', [], FIXED_MS).written).toBe(0)
    expect(recordUserQuotes(dir, 's', undefined, FIXED_MS).written).toBe(0)
  })

  it('纯空白正文不入账（没有可记录的文字面）', () => {
    const r = recordUserQuotes(dir, 's', [realUserMessage('m1', '   \n  ')], FIXED_MS)
    expect(r.written).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 七、纯函数
// ────────────────────────────────────────────────────────────────────────────

describe('纯函数', () => {
  it('messageText 只取 text 块并按顺序以换行相连', () => {
    expect(
      messageText([
        { type: 'text', text: 'a' },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'x' } } as never,
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
  })

  it('localIso 带本地时区偏移（不是 UTC 的 Z）', () => {
    const s = localIso(FIXED_MS)
    expect(s).toMatch(/^2026-11-02T21:42:37[+-]\d{2}:\d{2}$/)
  })

  it('userQuoteFileName 是 YYYY-MM-DD.jsonl', () => {
    expect(userQuoteFileName(FIXED_MS)).toBe('2026-11-02.jsonl')
  })
})
