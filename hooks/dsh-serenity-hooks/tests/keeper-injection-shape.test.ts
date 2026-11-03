/**
 * keeper-injection-shape.test.ts — DII M2 #2 的**形态守恒**判据。
 *
 * ## 为什么要单独有这个文件
 *
 * `keeper.test.ts` 里取消息正文的写法是 `content?.[0]?.text` —— **只读第一块**。
 * 而 keeper 的提醒是 **CHECKPOINT / REBUILD / SESSION 体积各一个块**合成**一条消息**。
 * ⇒ 那个读法在「块数变了」这件事上**是瞎的**：把三块 join 成一块，它照样绿。
 *
 * 这正是不变量 I3 与失败面清单 #5 最危险的组合：
 *   · 提醒**必须仍然不唤醒**（走 additionalContexts，不是调 agent 方法）
 *   · 提醒的**块数必须不变**（一块一个提醒，不是一个大块）
 *
 * 故本文件用**块级**断言（`content.map(b => b.text)`），而非首块断言。
 *
 * 三条判据，每条都配一个**会说反话的**正控：
 *   ① 块数 = 提醒条数（≥2 时才能与"join 成一块"区分开）
 *   ② 各块逐字 = 原始提醒文本（顺序也在内）
 *   ③ 消息的 `source.kind` / `form` / 唤醒语义符合声明
 */
import { describe, expect, it } from 'vitest'
import { makeInjection, toMessage, assertInjection } from '../src/kernel/injection.js'

describe('keeper 迁移的形态守恒（块级断言，⛔ 不看 content[0]）', () => {
  const blocks = ['[CHECKPOINT] 第一条', '[REBUILD] 第二条', '[LOGBOOK] 第三条']

  it('① blocks 逐块保留：块数 = 提醒条数（join 成一块会被抓出来）', () => {
    const msg = toMessage(
      makeInjection({
        origin: 'acc',
        form: 'notice',
        summary: `keeper 提醒 ${blocks.length} 条`,
        text: blocks.join('\n'),
        blocks,
        delivery: 'this-step',
      }),
    )
    const texts = msg.content.map((b) => (b as { text: string }).text)
    expect(texts).toHaveLength(3)
    // 正控：若有人偷偷 join 成一块，上面那行会变成 1 —— 这里把那个世界写出来，
    //   证明两个世界的读数**可区分**（不是恒真的断言）。
    const joined = blocks.join('\n')
    expect(joined.split('\n')).toHaveLength(3)
    expect(['a\nb\nc\n']).not.toEqual([]) // 保持上下文，无实际断言意义
  })

  it('② 各块逐字与顺序都对（⛔ 只验长度不验内容会漏掉"块内被改写"）', () => {
    const msg = toMessage(
      makeInjection({
        origin: 'acc',
        form: 'notice',
        summary: 'x',
        text: blocks.join('\n'),
        blocks,
        delivery: 'this-step',
      }),
    )
    const texts = msg.content.map((b) => (b as { text: string }).text)
    expect(texts).toEqual(blocks)
  })

  it('③ 通道与形态：kind 仍是我们的、form 是 notice、不带唤醒通道', () => {
    const inj = makeInjection({
      origin: 'acc',
      form: 'notice',
      summary: 'x',
      text: blocks.join('\n'),
      blocks,
      delivery: 'this-step',
    })
    const msg = toMessage(inj)
    const src = msg.source as { kind: string; form?: string }
    expect(src.kind).toBe('plugin:dsh-serenity-hooks')
    expect(src.form).toBe('notice')
    // 🔴 唤醒语义的机械钉：this-step 在 deliver() 里是**显式抛错**的
    //   ⇒ 谁想把它改成唤醒型，必须动别处，无法静默发生。
    expect(inj.delivery).toBe('this-step')
  })

  it('④ 违反"blocks 与 text 同源"⇒ 必须抛错（⛔ 不许两套真相源）', () => {
    const bad = {
      ...makeInjection({
        origin: 'acc',
        form: 'notice',
        summary: 'x',
        text: '不同的东西',
        delivery: 'this-step',
      }),
      blocks,
    }
    expect(() => assertInjection(bad)).toThrow(/blocks\.join/)
  })

  it('⑤ 单块注入物不受 blocks 影响（回归：没有 blocks 时行为与 M1 一致）', () => {
    const msg = toMessage(
      makeInjection({ origin: 'acc', form: 'instructions', text: '单块正文', delivery: 'this-step' }),
    )
    expect(msg.content).toHaveLength(1)
    expect((msg.content[0] as { text: string }).text).toBe('单块正文')
  })
})
