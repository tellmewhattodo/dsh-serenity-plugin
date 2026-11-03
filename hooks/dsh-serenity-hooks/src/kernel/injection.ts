/**
 * kernel/injection.ts — 动态提示词注入架构（DII）· 声明层
 *
 * ## 为什么有这个文件（问题陈述）
 *
 * 全仓有 **14 处**把消息注入进模型的调用点。它们共享同一个动作
 * `createUserMessage({ source: PLUGIN_SOURCE })`，却在 **6 条互不相干的属性轴上各自取值**，
 * 而这些取值**只存在于各处的注释与代码里** —— 没有任何数据结构能回答「这条消息是什么」。
 *
 * 两个已发生的真实故障，都是这条缺失的直接后果：
 *   ① **subagent 任务书被当成用户发言**（v1.113.2 修）—— 当时判据只有 `kind === 'user'`，
 *      而「谁产生的」没有别的地方记着；
 *   ② **两个生产者刻意冒充 `kind:'user'`**（载体开场白 / rebuild 锚点）—— 没有「声明我是谁」
 *      的正规通道 ⇒ 只能改 `kind` 这个**共享字段**去蹭宿主行为。
 *
 * ⇒ 本文件把 6 条轴变成**一等字段**。**M1 阶段零接线**：这里定义形状与声明表，
 *   但**没有任何调用点**改用它 ⇒ 行为零变更（可回滚 = 删掉本文件）。
 *
 * ## 🔴 两条落地约束（不是设计选择，是宿主类型的硬事实，均经探针实测）
 *
 * **① `kind:'user'` 装不下 `form`。** 宿主 `MessageSourceMap` 的 `user` 支逐字就是
 * `{ kind: 'user' }`（无 `& ContextFormed`）⇒ `{kind:'user', form:'relay'}` 会被 tsc 拒
 * （`TS2353: 'form' does not exist in type '{ kind: "user"; }'`）。故 {@link Injection.form}
 * **不是无条件必填**：`origin === 'user'` 时它必须缺席。
 *
 * **② 宿主对「另一个 agent 的消息」用专用 kind，不蹭 `kind:'user'`。**
 * `dsh-subagent` 给相邻 agent 的消息用 `kind:'agent-message'` ＋ `form:'relay'`。
 * 我们对应地让 `origin:'agent'` 落在**我们自有**的 `plugin:dsh-serenity-hooks` 上
 * （它**带了** `& ContextFormed`，见 `kernel/message-source.ts`）＋ `form:'relay'`。
 *
 * ⚠️ **刻意不新造 kind**（曾考虑 `plugin:dsh-serenity-hooks:agent-relay`）：新 kind 会让
 * 「subagent 消息」在界面里**从用户气泡变成注入行**（宿主 UI 按 `kind !== 'user'` 分流），
 * 那是行为可见变化而收益为零 —— 判据（`origin`）已经在 `Injection` 里了，不需要再动宿主身份。
 *
 * ## 🔴 一个必须记下的类型洞（对 M1 的写法有直接影响）
 *
 * 同一句 `{kind:'user', form:'relay'}`：
 *   · 作 `const x: MessageSource = …` ⇒ **红**（excess property check 生效）
 *   · 作 `createUserMessage({…, source: {…}})` 的内联实参 ⇒ **绿**（泛型参数位不触发该检查）
 * ⇒ 我们 14 处注入点**全都走后者**。所以「类型系统替我守住 form」在现状下**是假的**。
 * ⇒ 本文件的 {@link deliver} **接收/返回 `MessageSource` 注解类型**，⛔ 不许内联字面量 ——
 *   否则这个洞会原封不动地传下去。
 *
 * @see references/dii-injection-architecture-proposal.md（§3.5 两条纠正的取证全文）
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextForm, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { ACC_MESSAGE_KIND, PLUGIN_SOURCE } from './message-source.js'

/** 六条属性轴里「来源」那一轴的三档取值。 */
export type InjectionOrigin = 'user' | 'acc' | 'agent'

/**
 * 投递意图（**意图不是通道** —— 这是 I3）。
 *
 * 同一个意图在不同上下文可落不同通道：`wake-now` 在活会话走 `steer`、在冷会话走 `followup`。
 * 通道的选择只发生在 {@link deliver} 里，⛔ 调用点不许自己挑通道。
 */
export type InjectionDelivery =
  /** 当场进当前轮（模型同一次生成里就看到）。对应宿主 `agent.steer`。 */
  | 'wake-now'
  /** 起新的一轮（排队等本轮结束）。对应宿主 `agent.followup`。 */
  | 'next-turn'
  /** 挂到本步、**不唤醒**。对应 `additionalContexts`。 */
  | 'this-step'
  /** 改会话面本身（rebuild 专用）。对应直写 session event。 */
  | 'face-replace'

/**
 * 一条注入消息的**完整声明**。六个字段 = 六条轴。
 *
 * 不变量（由 {@link assertInjection} 机械检查）：
 *  - **I1** `origin` 与宿主 `kind` 是映射，不是同义词（见 {@link sourceOf}）。
 *  - **I2** `corpus` / `userQuote` 由 `origin` 推导，⛔ 不许调用点各自决定。
 *  - **I3** `delivery` 是意图，通道是实现（见 {@link deliver}）。
 */
export interface Injection {
  /** A 来源：谁产生的。**替代「靠 `kind` 猜」**。 */
  readonly origin: InjectionOrigin
  /**
   * B 形态：宿主 `ContextForm` 六选一。
   * 🔴 **`origin:'user'` 时必须缺席**（宿主 `user` 支装不下 form，见文件头注 ①）。
   */
  readonly form?: ContextForm
  /** `form:'notice'` 时**必须**给：一句话说明发生了什么（宿主的构成要件，非装饰）。 */
  readonly summary?: string
  /** 正文（由各注入物自己的构造器产出，含各自契约标记）。 */
  readonly text: string
  /** C+D 投递意图：唤醒语义**显式**，不再隐含在通道里。 */
  readonly delivery: InjectionDelivery
  /** E 归属：算不算语料。（由 {@link corpusOf} 从 `origin` 推导） */
  readonly corpus: boolean
  /** F 归属：算不算用户语录。（由 {@link userQuoteOf} 从 `origin` 推导） */
  readonly userQuote: boolean
  /** 去重键（**可选**；异步 MSM 结果**必须**带，⛔ 不许用正文哈希）。 */
  readonly dedupeKey?: string
}

// ── I2：两个归属字段由 origin 推导（单一真相源）────────────────────────────

/**
 * 语料归属：真人说的话与宿主/ACC 注入算语料；**另一个 agent 的话不算**
 * （这是 v1.113.2 那次污染的判据，只是从「事后排除」变成「出生即分格」）。
 */
export function corpusOf(origin: InjectionOrigin): boolean {
  return origin !== 'agent'
}

/**
 * 用户语录归属：**只有真人直说**才算。
 *
 * 🔴 这条正是 `_user-quotes` 那条链上两次缺陷的共同根：
 *   · subagent 任务书混入（v1.113.2）—— 它 `origin:'agent'` ⇒ 此处自动 false；
 *   · 载体开场白 / rebuild 锚点冒充 `kind:'user'` —— 它们 `origin:'acc'` ⇒ 此处自动 false。
 * ⇒ M3 阶段这两个调用点就能把各自的排除表/标记删掉。
 */
export function userQuoteOf(origin: InjectionOrigin): boolean {
  return origin === 'user'
}

// ── I1：origin ⇒ 宿主 source 的映射（唯一一处）──────────────────────────────

/**
 * 把 `origin`（＋`form`）映射成宿主的 `MessageSource`。
 *
 * 🔴 **返回类型显式标注为 `MessageSource`** —— 这是本文件躲开「泛型内联不检查」那个洞的唯一办法。
 *
 * | origin | 宿主 kind | form |
 * |---|---|---|
 * | `user` | `'user'`（宿主那一支，**无 form**） | ⛔ 必须缺席 |
 * | `acc`  | `plugin:dsh-serenity-hooks` | 可选 |
 * | `agent`| `plugin:dsh-serenity-hooks` ＋ `form:'relay'` | **re​lay（强制）** |
 */
export function sourceOf(inj: Injection): MessageSource {
  if (inj.origin === 'user') {
    if (inj.form !== undefined) {
      throw new Error(
        `Injection: origin:'user' 不允许带 form（宿主 MessageSourceMap 的 user 支装不下 ContextFormed）。` +
          `收到 form='${inj.form}'。`,
      )
    }
    return { kind: 'user' } satisfies MessageSource
  }  // acc / agent 都落在我们自有的 kind 上 —— 它**带了** & ContextFormed，装得下 form。
  if (inj.origin === 'agent') {
    const relayed: MessageSource = { kind: ACC_MESSAGE_KIND, form: 'relay' }
    return relayed
  }
  const notice: MessageSource =
    inj.form === undefined
      ? PLUGIN_SOURCE
      : inj.form === 'notice'
        ? { kind: ACC_MESSAGE_KIND, form: 'notice', summary: inj.summary ?? '' }
        : inj.form === 'snapshot'
          ? { kind: ACC_MESSAGE_KIND, form: 'snapshot', sections: [{ name: 'acc', text: inj.text }] }
          : { kind: ACC_MESSAGE_KIND, form: inj.form }
  return notice
}

// ── 不变量检查（机械可验，供单测与 M2 逐处迁移时自检）─────────────────────

/** 检查一条 `Injection` 是否自洽。不合则抛 —— ⛔ 不用「返回 false 让人忘查」。 */
export function assertInjection(inj: Injection): void {
  if (inj.text.trim() === '') {
    throw new Error('Injection: text 不能为空（空注入没有接收者）')
  }
  // I1 的第一半：origin:'user' 不得带 form
  if (inj.origin === 'user' && inj.form !== undefined) {
    throw new Error(`Injection: origin:'user' 不允许带 form（收到 '${inj.form}'）`)
  }
  // 宿主判别联合的构成要件：notice 必须带 summary
  if (inj.form === 'notice' && (inj.summary === undefined || inj.summary.trim() === '')) {
    throw new Error(`Injection: form:'notice' 必须给 summary（宿主 ContextFormed 的构成要件）`)
  }
  // I2：两个归属字段必须与 origin 推导值一致（⛔ 不许调用点自行决定）
  if (inj.corpus !== corpusOf(inj.origin)) {
    throw new Error(`Injection 违反 I2：corpus=${inj.corpus} 与 origin='${inj.origin}' 的推导值不符`)
  }
  if (inj.userQuote !== userQuoteOf(inj.origin)) {
    throw new Error(`Injection 违反 I2：userQuote=${inj.userQuote} 与 origin='${inj.origin}' 的推导值不符`)
  }
}

/** 构造一条 `Injection`，**归属字段自动推导**（调用点只需给 origin/text/delivery/form）。 */
export function makeInjection(
  spec: Omit<Injection, 'corpus' | 'userQuote'> & Partial<Pick<Injection, 'corpus' | 'userQuote'>>,
): Injection {
  const inj: Injection = {
    ...spec,
    corpus: spec.corpus ?? corpusOf(spec.origin),
    userQuote: spec.userQuote ?? userQuoteOf(spec.origin),
  }
  return inj
}

// ── 投递层（I3：唯一知道「哪个通道」的地方）────────────────────────────────

/** `deliver` 需要的最小 agent 形状（只取用到的两个方法，便于单测替身）。 */
export interface DeliverTarget {
  steer?: (msg: UserMessage) => void
  followup?: (msg: UserMessage) => void
}

/**
 * 把一条 `Injection` 变成**宿主消息对象**，但不投递。
 *
 * 🔴 为什么必须单独有它（而不是让 `deliver` 包办全部 5 种通道）：
 * 有三种通道**根本不能由「调一个方法」完成** ——
 *   · `waterfall`：要**返回** `{kind:'enter', messages:[…]}` 给宿主；
 *   · `additionalContexts`：要**返回**一个数组给下游；
 *   · 直写 session event：要 append 一条事件。
 * 这三处的调用方**必须拿到消息对象**。若 `deliver` 把它们也吃掉，就只能靠"回调"骗禁用名，
 * 反而比现在更难读。⇒ **`toMessage` 管"造"，`deliver` 管"投"**，两者都过同一个
 * `assertInjection` + `sourceOf`，所以六条轴的取值仍然只有一处定义。
 */
export function toMessage(inj: Injection): UserMessage {
  assertInjection(inj)
  return createUserMessage({
    content: [{ type: 'text', text: inj.text }],
    source: sourceOf(inj),
  })
}

/**
 * 把一条 `Injection` 投给目标 agent。
 *
 * ⚠️ 只处理**能由「调一个方法」完成**的两种通道（`wake-now`→`steer`、`next-turn`→`followup`）。
 * 另外三种（`this-step` / `face-replace` / waterfall）用 {@link toMessage} 由调用方自己接 ——
 * 它们要么要返回值、要么要 append 事件，硬塞进本函数只会得到更难读的回调。
 * 传进来这两种会**显式抛错**，⛔ 不静默降级成别的通道（失败面清单 #2）。
 *
 * @returns 实际走的通道名
 */
export function deliver(inj: Injection, target: DeliverTarget): 'steer' | 'followup' {
  assertInjection(inj)
  if (inj.delivery === 'wake-now') {
    if (typeof target.steer !== 'function') {
      throw new Error(`deliver: delivery='wake-now' 需要 steer，但目标没有该方法`)
    }
    target.steer(toMessageUnchecked(inj))
    return 'steer'
  }
  if (inj.delivery === 'next-turn') {
    if (typeof target.followup !== 'function') {
      throw new Error(`deliver: delivery='next-turn' 需要 followup，但目标没有该方法`)
    }
    target.followup(toMessageUnchecked(inj))
    return 'followup'
  }
  throw new Error(
    `deliver: delivery='${inj.delivery}' 不走本函数 —— ` +
      `'this-step' 是 waterfall 的 additionalContexts、'face-replace' 是直写 session event，` +
      `两者用 toMessage() 由调用方接（它们需要返回值或 append 事件，不是调方法）。`,
  )
}

/** 内部：已经 assert 过的路径复用，避免 `deliver` 里二次校验（保持一次来源）。 */
function toMessageUnchecked(inj: Injection): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: inj.text }],
    source: sourceOf(inj),
  })
}
