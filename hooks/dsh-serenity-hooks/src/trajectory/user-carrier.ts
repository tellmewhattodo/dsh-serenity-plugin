/**
 * trajectory/user-carrier.ts — **造一条与"用户人工创建"基本一致的 dsh 会话载体**（判决 D171，owner 2026-10-20 裁 B）
 *
 * ## 这个文件解决什么（白话）
 *
 * `send-now` 在目标没有活跃会话时会**就地建一条**。它一直能建、也能挂工作区，
 * 但建出来的东西与用户在 UI 里新建的那条**在宿主眼里不是同一种东西**：
 *
 * | 宿主投影 | 用户建 | 我们自建（修前实测） |
 * |---|---|---|
 * | `title` | 自动生成 | **永远 `null`** |
 * | `titleInput.count` | ≥1 | **0** |
 * | 假首轮（对齐声明 ＋ EAP） | 注入 | **被自家递归守卫挡掉** |
 *
 * ## 🔴 根因（读宿主源码，不是推断）
 *
 * `dsh-session-title` 的 `sessionTitleUserMessageOf()` **第一行**就是：
 *
 * ```js
 * if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0
 * ```
 *
 * 而 ACC 投递的消息一律是 `{ kind: 'plugin:dsh-serenity-hooks' }`（`kernel/message-source.ts`）
 * ⇒ **宿主从头到尾不把它当"有真人说过话"的会话** ⇒ 自动命名不触发、`titleInput` 恒 0。
 *
 * ## owner 的裁决 = B：**模拟一个用户开场白**
 *
 * `MessageSourceMap` 里 `user: { kind: 'user' }`，而 `UserMessage.source` 是**任意**
 * `MessageSource` ⇒ `createUserMessage({ content, source: { kind: 'user' } })` **类型合法、
 * 零改 DSH**（D4 仍成立）。
 *
 * ## 🔴 这是一次**明知故犯的伪造**，代价写在这里，不许悄悄付
 *
 * 1. **伪造用户身份**：与 D160「不再造历史」方向相反。范围**仅限**"载体开场白"这一条消息，
 *    且正文**逐字自证**是模拟的（{@link CARRIER_OPENING_MARK}）⇒ 将来翻日志的人一眼能看出。
 * 2. **污染所有者语料**：`session-corpus` 的"所有者发言"判据**必须**排除这条
 *    （判据 = 正文含 {@link CARRIER_OPENING_MARK}）⇒ 否则统计"owner 说过什么"会算进一句
 *    机器写的开场白。**这一条是同批改动，不是待办。**
 * 3. **与假首轮的先后**：开场白必须让假首轮先注入（同一次 `agent/inbox/inserted` 里
 *    prepend 天然排在真实消息之前），否则 `hasUserMessageHistory` 会把假首轮挡掉。
 *    ⇒ 单测钉死顺序，不靠"应该会"。
 *
 * ## 归属（D23）
 * 机制在 ACC（怎么建、建什么形状）；**内容归 CCC**（开场白正文由调用方给）。
 *
 * ## 与 `trajectory/carrier.ts` 的关系
 * 🔴 **两个文件、两件事**，名字刻意区分：`carrier.ts` 回答"**这条载体跑完没有**"（等待空闲／销毁竞速）；
 * 本文件回答"**怎么造一条载体**"。合在一起会让两条互不相关的依赖链卷成一团。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { assertInjection, makeInjection } from '../kernel/injection.js'

/**
 * 载体开场白的宿主 `source` —— **`kind:'user'` 是硬要求**（宿主 `dsh-session-title` 的
 * `sessionTitleUserMessageOf()` 第一行就把非 `'user'` 的 source 排除，见文件头注）。
 *
 * 🔴 与 `Injection` 的关系（DII M2 #11）：它是**声明 `origin:'acc'` 但落点强制 `'user'`**
 * 的唯一一处 —— `origin` 与宿主 `kind` 在此**刻意不相等**（I1：「映射，不是同义词」）。
 * ⛔ 不要为了"统一"而把它改成 `sourceOf()` 的产出：那会让宿主不再自动命名，
 * 而"让宿主自动命名"正是本文件存在的全部理由（owner 裁决 B）。
 */
const CARRIER_OPENING_SOURCE: MessageSource = { kind: 'user' }

/**
 * 模拟开场白的**自证标记**（逐字）。
 *
 * 🔴 三个用途，缺一不可：
 * ① 人类翻日志时能一眼看出"这不是真主说的"；
 * ② `session-corpus` 用它**排除**语料（不污染"所有者发言"）；
 * ③ 单测反向钉住：真实用户发言里**不会**出现这串 ⇒ 断言"语料里 0 条含它"才有意义。
 */
export const CARRIER_OPENING_MARK = '[ACC 代用户开场]'

/**
 * 构造模拟开场白的正文。
 *
 * ⚠️ **不含版本号／日期／模型名**（D159：任务书里不得写死版本号 ⇒ 写与版本无关的判据）。
 * 正文只描述"这是谁、要接着做什么"，不描述"哪一版干的"。
 *
 * @param code 轨迹编码（`S###` 或自定义）
 * @param desc 轨迹目录名里那段可读描述（**人起的**，不另造第二真相源）
 * @returns 一条自证是模拟的开场白正文
 */
export function buildCarrierOpening(code: string, desc: string): string {
  const label = desc.trim() === '' ? code : `${code}（${desc}）`
  /**
   * 🔴 2026-11-02 §D5（owner Q3「全砍」）：**166 → 93 码点（−44%）**。
   *
   * 砍掉的只有一句：`之所以代发，是为了让程序性会话与人工会话在宿主侧具有相同投影
   * （有标题、有首轮对齐声明）` —— 那是**设计理由**，读者（这条轨迹自己）既无法据此行动、
   * 也无法据此判断任何事。
   *
   * 🔴 **首句一字不动**：它是**身份与动作声明**（我是谁、我要接着做什么），砍了目标就不知道
   *    自己该干嘛。⇒ 这也是本项只降 44%、降不到 70% 的**诚实原因**（不吹大）。
   *
   * 🔴🔴 **`CARRIER_OPENING_MARK` 一字不动** —— 它是 `session-corpus` **排除语料**的判据
   *    （动了它 ⇒ 假开场白会被当成所有者发言，污染全部语料统计）。
   * ⚠️ **"它不是任何人的发言"这句必须留**：否则这条假开场白会被当成人类指令执行。
   */
  return [
    `${CARRIER_OPENING_MARK} 激活认知轨迹 ${label}，接着它 SESSION.md 里的工作往下做。`,
    '',
    '（这条开场白由 ACC 代为发出，它不是任何人的发言。）',
  ].join('\n')
}

/**
 * 投一条"用户形态"的消息进目标 agent（**B 的核心动作**）。
 *
 * 🔴 为什么单独成函数而不是就地写：这是**全仓唯一**允许 `kind:'user'` 的地方。
 * 集中在一处，将来若要收紧（或 owner 改主意回 A），只有一个点要改。
 *
 * @param agent 目标 agent（须有 `followup`）
 * @param text 开场白正文（**必须**由 {@link buildCarrierOpening} 产出，以带上自证标记）
 * @returns 投递是否成功（失败返回 false，由调用方决定降级 —— 不抛）
 */
export function deliverCarrierOpening(
  agent: { followup?: (msg: unknown) => void },
  text: string,
): boolean {
  if (typeof agent.followup !== 'function') return false
  try {
    // 🔴 **DII M2 · 注入点 #11**（2026-11-04）：这一处**刻意不写成一次 deliver()**。
    //
    //    原因：本处的 `kind:'user'` 是 **owner 裁决（方案 B）** 直接要求的（让宿主自动命名生效，
    //    见本文件头注）。而 `Injection` 的 `origin:'user'` 会**强制不带 form**（宿主 user 支装不下
    //    ContextFormed，见 kernel/injection.ts 头注 ①）。⇒ 若把本处声明成 `origin:'user'`，
    //    就等于**承认它是真人说的**——那正是 subagent 污染那类缺陷的同一根。
    //
    //    ⇒ 正确写法：**`origin:'acc'`（它确实是 ACC 产的）＋ 手动落 `{kind:'user'}`**
    //      （宿主强制要求的那个落点）。`origin` 与宿主 `kind` 因此不相等——
    //      这不是 bug，正是 I1 要表达的东西：「origin 与 kind 是映射，不是同义词」。
    //      语料/语录一侧（M3）就能按 `origin:'acc'` 排除它，**不必再靠 CARRIER_OPENING_MARK 猜**。
    //
    //    ⚠️ **校验一次再投**：这里仍走 `assertInjection`（六条轴自洽），但不用 `deliver()`
    //      —— 因为 deliver 会用 `sourceOf()` 产出 `kind:'plugin:dsh-serenity-hooks'`，
    //      而那会让宿主**不再自动命名**（本文件的全部存在意义就是让它命名）。
    assertInjection(
      makeInjection({ origin: 'acc', text, delivery: 'next-turn' }),
    )
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        // 🔴 与全仓其它注入**相反**：这里刻意声明成 `user`。
        //    理由见本文件头注「owner 的裁决 = B」。改这一行等于改判决，不要在别处改。
        source: CARRIER_OPENING_SOURCE,
      }),
    )
    return true
  } catch {
    return false
  }
}
