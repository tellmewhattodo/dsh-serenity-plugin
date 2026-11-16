/**
 * fake-initial-turns.test.ts — 假首轮（fake-initial-turns）机制的判据
 *
 * ## 它回答两个问题
 *
 *   S1 **拦截判据**：`isFakeInitialTurn()` 在什么情况下判"这是假首轮"？
 *      —— 双条件：登记在册 ＋ **最近一条"人写的话"** 逐字吻合。
 *   S2 **短路流形状**：`fakeTurnAckStream()` 产出的 chunk 序列符合宿主 `StreamChunk` 契约吗？
 *
 * ## 🔴 为什么"误拦"必须被钉死（本文件最重要的一格）
 *
 * 代价不对称：漏拦 = 老老实实发一次真调用（慢一点，无害）；
 * **误拦 = 把一条真实的用户请求吞掉，模型永远不回答**（用户眼里是"卡死"）。
 * ⇒ 所以负控写满：文本不符 / 未登记 / 登记已清零 / 更晚的真人消息在后面 —— 每一条都必须放行。
 *
 * ## 为什么不再有"宿主校验器"那一层
 *
 * v1.69.4 的判据是"我造的事件能不能过宿主校验" —— 那是**打错维度**：格式层全绿照样
 * 把会话写坏（结算事件的形状另有四个校验器把关）。
 * ⇒ 现在**一个会话事件都不写**（事件全由宿主据我们这条流自己结算）
 * ⇒ 本文件不再需要读宿主校验器，判据落在"我们只产出一条流"上。
 *
 * ## 隐私门（D145）
 *
 * 本文件不写真实家目录 / 私有 CCC 名。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FAKE_INITIAL_MESSAGES,
  FAKE_TURN_ACK_TEXT,
  FAKE_TURN_SUMMARY,
  isFakeInitialTurn,
  fakeTurnAckStream,
  type PendingFakeTurn,
} from '../src/seams/bootstrap.js'
// 不硬编码字面量：插件来源 kind 的**单一真相源**在 kernel/message-source.ts
import { ACC_MESSAGE_KIND } from '../src/kernel/message-source.js'

/** 默认登记（= 刚注入完全部假首轮） */
function pending(remaining = DEFAULT_FAKE_INITIAL_MESSAGES.length): PendingFakeTurn {
  return { remaining, texts: [...DEFAULT_FAKE_INITIAL_MESSAGES] }
}

/**
 * 取**最后一轮**假首轮的正文。
 * 🔴 2026-11-16：原先硬取 `[1]`，而 `DEFAULT_FAKE_INITIAL_MESSAGES` 已由两条合并为一条
 * ⇒ `[1]` 是 `undefined` ⇒ 判据拿 undefined 比对，恒 false。改取末尾一条与条数**解耦**。
 */
const LAST = DEFAULT_FAKE_INITIAL_MESSAGES[DEFAULT_FAKE_INITIAL_MESSAGES.length - 1]!

/** 造一条消息（文本块数组形态，与宿主一致） */
function message(text: string, kind?: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    ...(kind === undefined ? {} : { source: { kind } }),
  }
}

/** 造一条模型请求：`tail` 是最后一条消息之后的追加（前面的历史固定含两条假首轮） */
function request(messages: Array<Record<string, unknown>>, sessionId: unknown = 's-1'): Record<string, unknown> {
  return { sessionId, messages }
}

/** 把流抽干 */
async function drain(stream: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of stream) out.push(chunk as Record<string, unknown>)
  return out
}

describe('fake-initial-turns: isFakeInitialTurn —— 拦截判据', () => {
  it('登记在册 ＋ 末条是我们的假首轮 ⇒ true', () => {
    expect(isFakeInitialTurn(request([message(DEFAULT_FAKE_INITIAL_MESSAGES[0]!, ACC_MESSAGE_KIND)]), pending())).toBe(true)
  })

  it('🔴 真人说了别的 ⇒ false（不许吞真实请求）', () => {
    expect(isFakeInitialTurn(request([message('please fix the bug', 'user')]), pending())).toBe(false)
  })

  it('🔴 没有 source 的末条按"真人说的"处理 ⇒ 文本不符即 false', () => {
    expect(isFakeInitialTurn(request([message('hello')]), pending())).toBe(false)
  })

  it('🔴 未登记 / 登记已清零 ⇒ 一律 false', () => {
    const tail = [message(DEFAULT_FAKE_INITIAL_MESSAGES[0]!, ACC_MESSAGE_KIND)]
    expect(isFakeInitialTurn(request(tail), undefined)).toBe(false)
    expect(isFakeInitialTurn(request(tail), pending(0))).toBe(false)
  })

  it('🔴 历史里**含**假首轮但末条是真人的话 ⇒ false（这是最容易写错的一种）', () => {
    const options = request([
      message(DEFAULT_FAKE_INITIAL_MESSAGES[0]!, ACC_MESSAGE_KIND),
      { role: 'assistant', content: [{ type: 'text', text: FAKE_TURN_ACK_TEXT }] },
      message(LAST, ACC_MESSAGE_KIND),
      { role: 'assistant', content: [{ type: 'text', text: FAKE_TURN_ACK_TEXT }] },
      message('现在开始干活吧', 'user'),
    ])
    // ⛔ 若判据写成"请求里任意一条等于假首轮文本"，这里会误拦 ⇒ 真实请求被吞掉
    expect(isFakeInitialTurn(options, pending())).toBe(false)
  })

  it('末条是宿主注入的上下文（非人、非我们）⇒ 跳过它往前找，仍能认出假首轮', () => {
    const options = request([
      message(LAST, ACC_MESSAGE_KIND),
      message('context injected by host', 'runtime-context'),
    ])
    expect(isFakeInitialTurn(options, pending())).toBe(true)
  })

  it('退化输入 ⇒ false（不抛）', () => {
    expect(isFakeInitialTurn(undefined, pending())).toBe(false)
    expect(isFakeInitialTurn({}, pending())).toBe(false)
    expect(isFakeInitialTurn({ sessionId: 's-1' }, pending())).toBe(false)
    expect(isFakeInitialTurn({ sessionId: 's-1', messages: [] }, pending())).toBe(false)
    expect(isFakeInitialTurn({ sessionId: 's-1', messages: [{ role: 'assistant' }] }, pending())).toBe(false)
  })

  it('content 不是块数组 ⇒ 判不出文本 ⇒ false（宁可不拦）', () => {
    expect(isFakeInitialTurn(request([{ role: 'user', content: 'raw string' }]), pending())).toBe(false)
  })
})

describe('fake-initial-turns: fakeTurnAckStream —— 短路流形状', () => {
  it('序列 = block-start → text-delta → block-end → usage → finish', async () => {
    const chunks = await drain(fakeTurnAckStream())
    expect(chunks.map((c) => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('文本块装配成 acknowledge（block-end 必须带**装配好的块**）', async () => {
    const chunks = await drain(fakeTurnAckStream())
    expect(chunks[0]).toMatchObject({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toMatchObject({ type: 'text-delta', index: 0, text: FAKE_TURN_ACK_TEXT })
    expect(chunks[2]).toMatchObject({ type: 'block-end', index: 0, block: { type: 'text', text: FAKE_TURN_ACK_TEXT } })
  })

  it('🔴 计量全零（没有真的模型调用，不许算进账）', async () => {
    const chunks = await drain(fakeTurnAckStream())
    const usage = chunks.find((c) => c.type === 'usage') as { usage?: Record<string, number> } | undefined
    expect(usage?.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('🔴 `usage` 在 `finish` **之前**，`finish` 是最后一条（宿主契约：终结之后什么都没有）', async () => {
    const chunks = await drain(fakeTurnAckStream())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.findIndex((c) => c.type === 'usage')).toBeLessThan(chunks.length - 1)
  })

  it('记号常量与文档同源：`FAKE_TURN_SUMMARY` 是注入侧写的那个串', () => {
    expect(FAKE_TURN_SUMMARY).toBe('fake initial turn')
  })
})
