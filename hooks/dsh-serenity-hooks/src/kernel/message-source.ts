/**
 * kernel/message-source.ts — ACC 注入消息的来源标识（**单一真相源**，v1.47.0 / DSH 0.1.7-rc.1 适配）
 *
 * **为什么有这个文件**：DSH 0.1.7-rc.1（session format v3→v4）把消息来源从
 * 「`kind: 'plugin'` ＋ `plugin` 字段」改成**每个生产者声明自己的 kind** ——
 * `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 逐字写着：
 * *"each producer declares its own `kind` in its own module; there is no shared
 * catch-all `plugin` kind"*。⇒ 旧写法 `{ kind: 'plugin', plugin: 'dsh-serenity-hooks' }`
 * **在类型层不再合法**（合并和类型里没有 `plugin` 这一支），必须用**模块声明合并**
 * 补上自己的 kind（宿主 `dsh-session-title-llm` 与 `dsh-compaction` 都用此法）。
 *
 * **为什么取字面量 `plugin:dsh-serenity-hooks`**：v3→v4 迁移的 `producerKind()`
 * （`session-format-v3-to-v4/src/sources.ts`）把**第一方之外**的旧生产者一律写为
 * `plugin:${旧 plugin 字段}` ⇒ **存量会话升级后就是这个字面量**。新代码沿用同一字面量，
 * 使同一生产者在旧数据与新数据里**只有一个 kind**（否则下游与我方读取面都要处理两种）。
 */

import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'

/**
 * ACC 注入消息在 `source` 上额外携带的字段 —— **DII M3 的落点**（2026-11-04）。
 *
 * ## 为什么必须把 `origin` 投影进 `source`（而不是只留在内存的 Injection 里）
 *
 * `Injection` 是**投递那一刻**的声明对象；而所有消费方（语料、用户语录、面板读数）
 * 读的是**落盘后的会话日志**，那里只有 `source`。⇒ 声明若不落到 `source` 上，
 * 消费方就永远看不见它，M3 也就无从"改读字段、删黑名单"。
 *
 * ## 宿主允许吗（**实测，非推断**）
 *
 * ① `createMessage` 走 `structuredClone(input)` ⇒ 自定义字段被原样保留；
 * ② 落盘校验 `assertMessageEventShape`（`dsh-session/lib/types/index.js:266-271`）
 *    只要求 `source.kind` 是**非空字符串**，**不排斥额外字段**。
 * ⇒ 已用临时探针实测三点：`createUserMessage` 后存活 ／ 冻结后仍可读 ／ JSON 往返后仍在。
 *
 * ## 与 `kind` 的关系（I1）
 *
 * `kind` 回答"落点是谁"，`origin` 回答"真正的生产者是谁"——**两者刻意可以不等**：
 * 载体开场白与 rebuild 锚点被宿主强制 `kind:'user'`，但它们的 `origin` 是 `'acc'`。
 * 那正是这两个生产者长期"冒充真人"的根源；有了 `origin`，消费方终于能分辨。
 */
export interface AccOriginField {
  /** 真正的生产者：真人 ／ ACC ／ 另一个 agent。 */
  readonly origin?: 'user' | 'acc' | 'agent'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-serenity-hooks': { kind: 'plugin:dsh-serenity-hooks' } & ContextFormed & AccOriginField
  }
}

/** ACC 注入消息的 kind —— 唤醒 / 打回 / keeper 提醒 / 锚定轮 / rebuild 交接等一律同值。 */
export const ACC_MESSAGE_KIND = 'plugin:dsh-serenity-hooks' as const

/** ACC 注入消息的统一来源值（各缝共用；需要 `form` 时按 `ContextFormed` 另加字段）。 */
export const PLUGIN_SOURCE: MessageSource = { kind: ACC_MESSAGE_KIND }
