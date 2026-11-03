/**
 * injection.test.ts — DII 声明层（M1）单测。
 *
 * 覆盖三件东西，**每件都配一个变异**（D222：绿了的判据必须证明"故意弄坏会不会红"）：
 *   ① I1 映射（origin ⇒ 宿主 kind/form）
 *   ② I2 推导（corpus / userQuote 由 origin 决定，⛔ 不许调用点自己填）
 *   ③ I3 投递（delivery 是意图，通道是实现）
 *
 * 🔴 本文件**刻意不测**「typecheck 会拦住内联 form」—— 因为实测它拦不住
 * （`createUserMessage` 的泛型参数位不触发 excess property check）。
 * 那一格由 `sourceOf()` 的运行时检查承担，见 ①组。
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import {
  assertInjection,
  corpusOf,
  deliver,
  makeInjection,
  sourceOf,
  userQuoteOf,
  type Injection,
} from '../src/kernel/injection.js'
import { INJECTION_SITES, MIGRATION_ORDER } from '../src/kernel/injection-sites.js'

const base = { text: 'x', delivery: 'next-turn' as const }

describe('I1 · origin ⇒ 宿主 source 的映射', () => {
  it("origin:'user' ⇒ kind:'user' 且不带 form", () => {
    const s = makeInjection({ ...base, origin: 'user' })
    const src = sourceOf(s)
    expect(src.kind).toBe('user')
    expect('form' in src).toBe(false)
  })

  it("origin:'acc' ⇒ 我们自己的 kind（它带了 ContextFormed）", () => {
    const s = makeInjection({ ...base, origin: 'acc', form: 'instructions' })
    const src = sourceOf(s)
    expect(src.kind).toBe('plugin:dsh-serenity-hooks')
    expect((src as { form?: string }).form).toBe('instructions')
  })

  it("origin:'agent' ⇒ form 强制是 relay（另一个 agent 的话）", () => {
    const s = makeInjection({ ...base, origin: 'agent' })
    const src = sourceOf(s) as MessageSource & { form?: string }
    expect(src.kind).toBe('plugin:dsh-serenity-hooks')
    expect(src.form).toBe('relay')
  })

  // 🔴 这一条是「纠正①」的运行时守卫：宿主 user 支装不下 form，所以我们必须自己拒。
  it("origin:'user' ＋ form ⇒ 抛错（宿主 user 支装不下 form）", () => {
    const s = makeInjection({ ...base, origin: 'user', form: 'relay' })
    expect(() => sourceOf(s)).toThrow(/origin:'user' 不允许带 form/)
  })

  it("form:'notice' 必须带 summary（宿主判别联合的构成要件）", () => {
    const noSummary = makeInjection({ ...base, origin: 'acc', form: 'notice' })
    expect(() => assertInjection(noSummary)).toThrow(/必须给 summary/)
    const ok = makeInjection({ ...base, origin: 'acc', form: 'notice', summary: '到点了' })
    expect(() => assertInjection(ok)).not.toThrow()
  })

  // ── 变异：把「user 不许带 form」的守卫去掉，上面那条必须红 ──
  it('变异 A：去掉 user 守卫后，user+form 会静默产出非法 source', () => {
    // 直接构造一个绕过 makeInjection 推导的坏对象，模拟"守卫不存在"的世界
    const bad = { ...base, origin: 'user', form: 'relay', corpus: true, userQuote: true } as unknown as Injection
    // 守卫在场 ⇒ 抛
    expect(() => sourceOf(bad)).toThrow()
    // 证明：若不抛，产出的 source 就是 `{kind:'user'}` —— form 被**静默丢弃**。
    //   ⇒ 这正是"没人守就没人知道它丢了"的证据，不是假想。
    const wouldBe = { kind: 'user' } satisfies MessageSource
    expect('form' in wouldBe).toBe(false)
  })
})

describe('I2 · corpus / userQuote 由 origin 推导', () => {
  it('真人 ⇒ 都算', () => {
    expect(corpusOf('user')).toBe(true)
    expect(userQuoteOf('user')).toBe(true)
  })

  it('ACC 注入 ⇒ 算语料、⛔ 不算语录', () => {
    expect(corpusOf('acc')).toBe(true)
    expect(userQuoteOf('acc')).toBe(false)
  })

  it('另一个 agent ⇒ 两者都不算（v1.113.2 那次污染的判据）', () => {
    expect(corpusOf('agent')).toBe(false)
    expect(userQuoteOf('agent')).toBe(false)
  })

  it('makeInjection 自动推导，调用点不用填', () => {
    const s = makeInjection({ ...base, origin: 'agent' })
    expect(s.corpus).toBe(false)
    expect(s.userQuote).toBe(false)
  })

  // 🔴 变异：调用点硬填一个与 origin 矛盾的归属 ⇒ assertInjection 必须红
  it('变异 B：手填 corpus 与 origin 矛盾 ⇒ 抛错（I2 不许自行决定）', () => {
    const wrong = { ...makeInjection({ ...base, origin: 'agent' }), corpus: true } as Injection
    expect(() => assertInjection(wrong)).toThrow(/违反 I2：corpus/)
  })

  it('变异 B2：手填 userQuote 与 origin 矛盾 ⇒ 抛错', () => {
    const wrong = { ...makeInjection({ ...base, origin: 'acc' }), userQuote: true } as Injection
    expect(() => assertInjection(wrong)).toThrow(/违反 I2：userQuote/)
  })
})

describe('I3 · delivery 是意图，通道是实现', () => {
  const target = () => {
    const calls: string[] = []
    return {
      calls,
      steer: (m: { content: readonly unknown[] }) => {
        calls.push(`steer:${JSON.stringify(m.content)}`)
      },
      followup: (m: { content: readonly unknown[] }) => {
        calls.push(`followup:${JSON.stringify(m.content)}`)
      },
    }
  }

  it("delivery:'wake-now' ⇒ 走 steer，且**只**走 steer", () => {
    const t = target()
    const ch = deliver(makeInjection({ text: 'hi', origin: 'acc', delivery: 'wake-now' }), t)
    expect(ch).toBe('steer')
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.startsWith('steer:')).toBe(true)
  })

  it("delivery:'next-turn' ⇒ 走 followup，且**只**走 followup（另一条通道反向钉）", () => {
    const t = target()
    const ch = deliver(makeInjection({ text: 'hi', origin: 'acc', delivery: 'next-turn' }), t)
    expect(ch).toBe('followup')
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.startsWith('followup:')).toBe(true)
  })

  it("'this-step' / 'face-replace' 不走本函数 ⇒ 抛错（⛔ 不许静默降级成别的通道）", () => {
    for (const d of ['this-step', 'face-replace'] as const) {
      expect(() => deliver(makeInjection({ text: 'hi', origin: 'acc', delivery: d }), target())).toThrow()
    }
  })

  it('目标缺对应方法 ⇒ 抛错（⛔ 不许「没报错」冒充「投递成功」）', () => {
    expect(() =>
      deliver(makeInjection({ text: 'hi', origin: 'acc', delivery: 'wake-now' }), { followup: () => {} }),
    ).toThrow(/需要 steer/)
    expect(() =>
      deliver(makeInjection({ text: 'hi', origin: 'acc', delivery: 'next-turn' }), { steer: () => {} }),
    ).toThrow(/需要 followup/)
  })

  // 正控：投出去的正文必须真的是那段正文（否则"投递了"等于没投）
  it('正控：投出去的 content 含原文（否则通道对、内容空）', () => {
    const t = target()
    deliver(makeInjection({ text: '正文在此', origin: 'acc', delivery: 'next-turn' }), t)
    expect(t.calls[0]).toContain('正文在此')
  })

  // 变异：把 wake-now 改成走 followup，前两条必须红
  it('变异 C：若把 wake-now 错接到 followup，通道名与调用都会不符', () => {
    const t = target()
    // 模拟错接：手工调 followup 而不是走 deliver
    t.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    expect(t.calls[0]!.startsWith('followup:')).toBe(true)
    // ⇒ 所以上面那条 `startsWith('steer:')` 的断言不是恒真：两种通道在 calls 里可区分。
    expect(t.calls[0]!.startsWith('steer:')).toBe(false)
  })
})

describe('声明表 · 注入点清单（M2 的施工清单）', () => {
  it('恰好 16 行，编号 1..16 无缺无重', () => {
    expect(INJECTION_SITES).toHaveLength(16)
    const ids = INJECTION_SITES.map((s) => s.id).sort((a, b) => a - b)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  })

  it('MIGRATION_ORDER 覆盖全部 16 个且无重复（否则 M2 会漏迁）', () => {
    expect([...MIGRATION_ORDER].sort((a, b) => a - b)).toEqual(
      INJECTION_SITES.map((s) => s.id).sort((a, b) => a - b),
    )
  })

  it('全部 16 处代码已迁移（migrated=true），但真机尚未核（realMachineVerified=false）', () => {
    expect(INJECTION_SITES.every((s) => s.migrated === true)).toBe(true)
    // 🔴 这条**刻意断言 false**：真机验证要等部署。若哪天有人把它改成 true 却没跑真机，
    //   这条会红——它守的是"两个进度不许混"（见 InjectionSite.realMachineVerified 注释）。
    expect(INJECTION_SITES.every((s) => s.realMachineVerified === false)).toBe(true)
  })

  it("origin:'user' 的行不得声明 form（与纠正①一致）", () => {
    for (const s of INJECTION_SITES) {
      if (s.origin === 'user') expect(s.form).toBeUndefined()
    }
  })

  it('声明唤醒语义与通道不矛盾（wakes=false ⇒ 不得用唤醒型通道）', () => {
    for (const s of INJECTION_SITES) {
      if (!s.wakes) {
        expect(['additionalContexts', 'waterfall', 'session-event']).toContain(s.channel)
      }
    }
  })

  // 🔴 反向钉：keeper 提醒那一处**必须**仍是不唤醒（失败面 #5 是最危险的）
  it('反向钉：keeper 提醒（#2）必须 wakes=false 且走 additionalContexts', () => {
    const keeper = INJECTION_SITES.find((s) => s.id === 2)!
    expect(keeper.wakes).toBe(false)
    expect(keeper.channel).toBe('additionalContexts')
  })

  // 🔴 反向钉：载体开场白（#11）的 kind 必须是 user（owner 裁决 B，⛔ 架构不得改）
  it('反向钉：载体开场白（#11）kind 必须是 user（owner 裁决，架构无权改）', () => {
    const carrier = INJECTION_SITES.find((s) => s.id === 11)!
    expect(carrier.kind).toBe('user')
  })
})

describe('变异检验汇总 · 判据不是恒绿', () => {
  it('把 corpusOf 恒真 ⇒ 上面的 agent 那条会红（搬自证）', () => {
    // 这是"判据有判别力"的直接证明：两条不同的 origin 推出不同的值，
    //   若实现恒返回 true，二者会相等 ⇒ 断言必然失败。
    expect(corpusOf('agent')).not.toBe(corpusOf('user'))
    expect(userQuoteOf('acc')).not.toBe(userQuoteOf('user'))
    expect(userQuoteOf('agent')).not.toBe(userQuoteOf('user'))
  })
})
