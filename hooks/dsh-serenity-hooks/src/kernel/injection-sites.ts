/**
 * kernel/injection-sites.ts — DII 的 **14 处注入点声明表**（M1 交付物，**零接线**）
 *
 * ## 这个文件是什么
 *
 * 一张**静态的**登记表：全仓每一处「把消息注入进模型」的地方，在 6 条轴上各取什么值。
 * 它**不执行任何东西**，也没有调用点读它（M1 零接线）。
 *
 * ## 为什么它比类型定义更值钱
 *
 * `injection.ts` 定的是**形状**；本文件定的是**现状的取值**。两者合起来才回答那句核心问题：
 * **「这条注入消息到底是什么」** —— 而这正是当初两个故障缺失的那一格里装着的东西
 * （subagent 任务书被当成真人发言 / 两个生产者冒充 `kind:'user'`）。
 *
 * 它同时是 **M2 的施工清单**：逐处迁移时，从这里取那一行的六轴取值，改成 `makeInjection(...)`
 * ＋ `deliver(...)`，迁完把该行 `migrated` 打勾。**一张表驱动 14 次独立提交**。
 *
 * ## 判据（M2 完成后必须成立，可机械验）
 *
 * - `grep -rn "createUserMessage" src/` 应**只剩 `kernel/injection.ts` 里那一处**
 *   （本文件与 `trajectory/user-carrier.ts` 的 `kind:'user'` 特例见下注）。
 * - 本表 14 行的 `migrated` 全为 `true`。
 *
 * ## ⚠️ 三处**不受本表管辖**的例外（如实标注，⛔ 不是漏登记）
 *
 * 1. **`trajectory/user-carrier.ts:112` 的载体开场白** —— 它就是上表 #11，但它的
 *    `kind:'user'` 是 **owner 裁决（方案 B）** 直接要求的（让宿主自动命名生效），
 *    **不是本架构能改的**。⇒ 迁移时它只能改「声明」，`kind` 必须仍是 `user`。
 * 2. **`trajectory/rebuild.ts:419` 直写会话面** —— 宿主校验强制要求 `kind:'user'`，同上。
 * 3. `seams/context.ts` 的 `accMessage` 走 waterfall 返回，不是 `createUserMessage` 的普通投递。
 *
 * @see references/dii-injection-architecture-proposal.md §二（逐条盘点的取证）
 */

import type { InjectionDelivery, InjectionOrigin } from './injection.js'
import type { ContextForm } from '@deepseek-ai/dsh-llm'

/**
 * 一处注入点的登记项。
 *
 * ⚠️ 与 {@link import('./injection.js').Injection} 的区别：`Injection` 是**一次投递**的完整声明；
 * 本项是**一个代码位置的静态属性**（它可能每次投递时取值不同，故 `text` 不在此，`,
 * 而以 `textFrom` 记「正文由哪个构造器产出」）。
 */
export interface InjectionSite {
  /** 与提案 §2.1 的编号一致（1~14），供 M2 逐条对照。 */
  readonly id: number
  /** 人类可读的名字。 */
  readonly name: string
  /** 代码位置（`文件:行`，**行号是某版本的实测读数**，M2 迁移后以符号为准）。 */
  readonly at: string
  /** 正文由哪个构造器产出（`null` = 就地拼字符串）。 */
  readonly textFrom: string | null
  /** A 轴：来源。 */
  readonly origin: InjectionOrigin
  /** B 轴：形态。`undefined` = 现状未声明（这正是要补的）。 */
  readonly form: ContextForm | undefined
  /** C+D 轴：投递意图。 */
  readonly delivery: InjectionDelivery
  /** 现状用的**通道**（实现），用于 M2 对比「意图 vs 实现」有没有错配。 */
  readonly channel: 'followup' | 'steer' | 'additionalContexts' | 'waterfall' | 'session-event'
  /** 现状是否**唤醒**（M2 必须逐个对比，⛔ 尤其不能把「不唤醒」改成「唤醒」）。 */
  readonly wakes: boolean
  /** 现状的宿主 `kind`。 */
  readonly kind: string
  /** M2 是否已迁移。⛔ 只在**真机验过**之后才置 true。 */
  readonly migrated: boolean
}

/**
 * 14 处注入点（与提案 §2.1 逐条对应）。
 *
 * 🔴 **读法**：`form: undefined` 的行 = 现状**没有声明形态**，这是 DII 要补的第一件事；
 * `channel` 与 `delivery` 不一致的行，就是 M2 里最需要盯的（D 轴与 C 轴耦合的地方）。
 */
export const INJECTION_SITES: readonly InjectionSite[] = [
  {
    id: 1,
    name: 'ACC 身份锚定',
    at: 'seams/context.ts:143 accMessage',
    textFrom: 'accIdentityText',
    origin: 'acc',
    form: 'instructions',
    delivery: 'this-step',
    channel: 'waterfall',
    wakes: false,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 2,
    name: 'keeper 提醒（CHECKPOINT/LIMIT/COMPACTION/SCRATCH PRUNE）',
    at: 'seams/keeper.ts:581',
    textFrom: 'keeper 提示构造',
    origin: 'acc',
    form: 'notice',
    delivery: 'this-step',
    channel: 'additionalContexts',
    // 🔴 这一行是 M2 最危险的一处：它**必须**仍然不唤醒（失败面清单 #5）。
    wakes: false,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 3,
    name: '唤醒 tick（send-later 到点）',
    at: 'wake/scheduler.ts:322',
    textFrom: 'buildWakeText',
    origin: 'acc',
    form: 'notice',
    delivery: 'next-turn',
    channel: 'followup',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 4,
    name: 'send-now（即时消息）',
    at: 'wake/scheduler.ts:462 make()',
    textFrom: 'buildSendText',
    origin: 'acc',
    form: 'notice',
    // ⚠️ 意图随目标 status 变（idle⇒next-turn / running⇒wake-now），这正是 I3 的动机。
    delivery: 'wake-now',
    channel: 'steer',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 5,
    name: 'CRO 唤起（程序判定的自我唤醒）',
    at: 'wake/scheduler.ts:966',
    textFrom: 'buildCroWakeText',
    origin: 'acc',
    form: 'notice',
    delivery: 'next-turn',
    channel: 'followup',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 6,
    name: '轨迹订阅通知',
    at: 'trajectory/subscriptions.ts → makeMessage',
    textFrom: 'subscriptions makeMessage',
    origin: 'acc',
    form: 'notice',
    delivery: 'next-turn',
    channel: 'followup',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 7,
    name: '输出守卫打回（敏感词）',
    at: 'guard/seam.ts:124',
    textFrom: 'buildRebuke',
    origin: 'acc',
    form: 'notice',
    delivery: 'wake-now',
    channel: 'steer',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 8,
    name: 'IM 出站守卫打回（没发消息）',
    at: 'im/guard.ts:327',
    textFrom: 'im guard rebuke',
    origin: 'acc',
    form: 'notice',
    delivery: 'wake-now',
    channel: 'steer',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 9,
    name: 'rebuild 锚点（重建交接，steer 那一半）',
    at: 'trajectory/rebuild.ts:492',
    textFrom: 'buildRebuildAnchor',
    origin: 'acc',
    form: 'instructions',
    delivery: 'wake-now',
    channel: 'steer',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 10,
    name: 'rebuild 锚点（写入会话面那一半）',
    at: 'trajectory/rebuild.ts:419',
    textFrom: 'buildRebuildAnchor',
    // 🔴 宿主校验强制 `kind:'user'` ⇒ 这一格**必须**是 user，且因此**不能带 form**（见文件头注）。
    origin: 'user',
    form: undefined,
    delivery: 'face-replace',
    channel: 'session-event',
    wakes: false,
    kind: 'user',
    migrated: false,
  },
  {
    id: 11,
    name: '载体开场白（模拟开场）',
    at: 'trajectory/user-carrier.ts:113',
    textFrom: 'buildCarrierOpening',
    // 🔴 owner 裁决（方案 B）要求 `kind:'user'`，为让宿主自动命名生效。
    //    ⇒ `origin` 记 **acc**（它其实是 ACC 产的），但**宿主 kind 仍是 user** ——
    //    这正是 I1「origin 与 kind 是映射不是同义词」最需要被看见的一格。
    origin: 'acc',
    form: undefined,
    delivery: 'next-turn',
    channel: 'followup',
    wakes: true,
    kind: 'user',
    migrated: false,
  },
  {
    id: 12,
    name: 'IM 入站投递',
    at: 'trajectory/session.ts:661 deliverToTrajectory',
    textFrom: null,
    origin: 'acc',
    form: 'notice',
    delivery: 'next-turn',
    channel: 'followup',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 13,
    name: 'askTrajectory（问一句等答案）',
    at: 'trajectory/session.ts:698',
    textFrom: null,
    origin: 'acc',
    form: 'notice',
    delivery: 'next-turn',
    channel: 'followup',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
  {
    id: 14,
    name: '中断兜底 continue',
    at: 'wake/scheduler.ts:1368 makeMessage',
    textFrom: 'buildContinueText',
    origin: 'acc',
    form: 'notice',
    delivery: 'wake-now',
    channel: 'steer',
    wakes: true,
    kind: 'plugin:dsh-serenity-hooks',
    migrated: false,
  },
] as const

/**
 * M2 施工顺序（**由风险从低到高**，⛔ 不是按编号）。
 *
 * 理由：先迁「行为无差别、无外部观察者」的那些，把 `deliver()` 的形状压稳，
 * 再动「一旦错就打断正在跑的会话」的那些。
 */
export const MIGRATION_ORDER: readonly number[] = [
  // ① 无唤醒、无外部观察者、纯附加上下文 —— 错了也只是少一段提示
  1, 2,
  // ② 出站打回类：有观察者（日志里能看到），但不改会话结构
  7, 8,
  // ③ 唤醒类：会**起新一轮**，错了会被看见但不破坏状态
  3, 5, 6, 13, 14,
  // ④ 即时消息类：影响正在跑的会话
  4, 12,
  // ⑤ rebuild 两半：**最后做**，它动会话面本身
  9, 10,
  // ⑥ 载体开场白：有 owner 裁决约束的 kind，**单独做、单独真机看屏**
  11,
]
