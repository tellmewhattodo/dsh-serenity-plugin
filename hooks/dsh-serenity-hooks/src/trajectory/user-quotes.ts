/**
 * trajectory/user-quotes.ts — 用户语录台账（owner 2026-11-02 需求）
 *
 * ## owner 原话（逐字，来源 = 2026-11-02 会话内用户输入）
 *
 * 「我需要一个可开启关闭的功能，就是记录用户直接对谁说过什么，对谁是指对具体的某个轨迹，
 *   本质上这是个用户语录功能，这个功能如果开启，则默认写到一个指定目录内，按天进行记录。
 *   这个功能是用于 具体的宁静号CCC反向来分析用户的」
 *
 * ## owner 三答（已锁定；⛔ 不要再问）
 *
 * | # | 问题 | 答 |
 * |---|---|---|
 * | Q1 | 「对谁」怎么算 | **按轨迹**（不是按会话） |
 * | Q2 | 开关放哪层 | **CCC 配置面**（`.opencode/serenity.json`，改它不发版 —— D23） |
 * | Q3 | 记录粒度 | **全文**（一字不改，不做摘要） |
 *
 * ## 本模块是什么 / 不是什么
 *
 * - **是**：`agent/pre-step` 那一刻「用户直接说的话」的**实时**落盘（按天一行一条 JSONL）。
 * - **不是**：`dsh-session corpus` 的替代品。那个是**事后扫描**，判据是 20+ 条**措辞黑名单**
 *   （`INJECTION_MARKERS`/`INJECTION_PATTERNS`），它的 `heads` 子命令本身就是"量漏网家族"的取证工具
 *   ⇒ **判据天生不完备**。本模块改用**结构性判据**（`source.kind`），不猜措辞。
 * - **不是**：`_im-logs/` 的替代品。那份记的是**IM 渠道双向原文**；本模块记的是**所有渠道**的用户发言。
 *
 * ## 采集点为什么是 `agent/pre-step`
 *
 * 宿主 `dsh-agent/lib/types/runtime-types.d.ts` 逐字：
 * `'agent/pre-step'(payload: { agent; messages: UserMessage[]; turn; step; signal }, next)`，
 * 其中 `messages` = **本 step 从 inbox 取出、即将进入本步的消息**，每条都是**完整 `UserMessage`，自带 `source`**。
 * ⇒ 这是"用户直接说的话"**最接近源头**的位置（再往下就混进模型输出与工具结果了）。
 *
 * ## 判别面 = `source.kind`（结构性，⛔ 不靠措辞）
 *
 * 宿主 `dsh-llm/lib/types/message.d.ts` 逐字：*"user messages carry **any** producer's kind,
 * and consumers fall through unknown kinds."* ⇒ 同一个 `role:'user'` 位置上，**不同生产者各有自己的 kind**。
 *
 * 实测三条（`dsh-session corpus raw` 真读出来的，⛔ 不是推演）：
 *
 * | 来源 | `source` 实际值 |
 * |---|---|
 * | **界面真发言** | `{"kind":"user","rpcId":"…","clientTimeZone":"Asia/Shanghai"}` |
 * | ACC 注入（唤醒/开场白/提醒/打回） | `{"kind":"plugin:dsh-serenity-hooks", form?, summary?}` |
 * | **IM 入站（微信/飞书）** | `{"kind":"plugin:dsh-serenity-hooks"}` ← 🔴 **见下** |
 *
 * ⇒ **主判据 = `source.kind === 'user'`**（`ACC_MESSAGE_KIND` 是 ACC 侧的单一真相源）。
 *
 * ## 🔴🔴 IM 渠道那一格（2026-11-02 取证结案，⛔ 别再当成未决项）
 *
 * 本模块立项时留过一个开放项：「IM 消息是否也走 `agent/pre-step`、是否同为 `kind:'user'`，
 * 会与界面直话混在一起」。**已取证，答案是不会混** —— 因为 IM 入站**根本不是** `kind:'user'`：
 *
 * - 代码面：**两个 IM 渠道共用一个入站投递出口** `deliverToTrajectory`
 *   （`trajectory/session.ts:655`）—— 微信从 `im/bridge.ts` 进来、飞书从 `im/feishu-account.ts` 进来，
 *   两者各自造"中立事件"后**都调到同一个** `handleInboundEvent`。该出口构造消息用的是
 *   `createUserMessage({ …, source: PLUGIN_SOURCE })` ⇒ **`kind:'plugin:dsh-serenity-hooks'`**。
 *   🔴 判据落在**那个共用的投递函数**上，**不在渠道上** ⇒ 微信与飞书同结论，不是只讲微信。
 * - 日志面（`dsh-session corpus raw --session skiff-weixin-…`，同一会话两种并存真读）：
 *   微信那条 = `{"kind":"plugin:dsh-serenity-hooks",…}`，正文含 `[serenity:weixin-manual-output]` 标记；
 *   界面那条 = `{"kind":"user","rpcId":…,"clientTimeZone":…}`。
 *
 * ⇒ **按 `kind === 'user'` 过滤，天然只收界面直话，IM（微信／飞书）一条都进不来。**
 * ⚠️ **两条边界，别替本模块说满**：
 *   ① 这是**当前实现的属性，不是协议保证**——宿主只承诺"user 位置上可有任意生产者的 kind"，
 *      没有任何东西保证 IM 永远是 `plugin:…`。若哪天 IM 改回 `kind:'user'`，本模块会**开始**收录它；
 *      那时 `channel` 判别需 owner 重新裁决（那是 Q1 的范围问题，⛔ 不由本函数自己猜）。
 *   ② **`_im-logs/<channel>/` 仍是 IM 原话的唯一真相源**。本台账不收录 IM ≠ 那些话丢了。
 *
 * ## 🔴 两个「冒充 user」的生产者（结构性分不开，只能靠标记排除）
 *
 * | 生产者 | 位置 | 标记 | 为什么冒充 |
 * |---|---|---|---|
 * | 载体开场白 | `trajectory/user-carrier.ts:117` | `CARRIER_OPENING_MARK` | 让宿主自动命名生效 |
 * | rebuild 锚点 | `trajectory/rebuild.ts:419` | 正文以 `[COGNITIVE-TRAJECTORY-ASSISTANT` 开头 | 宿主校验强制要 `kind:'user'` |
 *
 * ⚠️ 这两条是**本方案唯一的不完美点**，如实登记于此。判据不是"看起来像注入"（那是措辞黑名单，
 * 正是 corpus 那条不完备的路），而是**这两个生产者自己声明的标记**——它们本来就是为了
 * "让将来翻日志的人一眼看出这不是真主说的"而存在的（见 `CARRIER_OPENING_MARK` 注释的用途 ②）。
 *
 * ## 为什么按轨迹、以及"对谁"怎么取
 *
 * Q1 = **按轨迹**。唯一权威入口 = `findTrajectoryOfSession`（`trajectory/bound.ts`，
 * 内部即 `findTrajectoryHolding`）—— 给会话 id，返回持有它的轨迹目录名。
 * ⛔ **不要自己扫目录**：绑定真相源只有一个（`current.dsh_session_bind`），扫描会造出第二份判据。
 *
 * 未绑定的会话（纯探索/临时问答）⇒ `trajectory` 字段写 `null`，**照常入账**。
 * 理由：owner 要的是"用户说过什么"；丢掉未绑定的会话会让台账**有系统性空洞**（且空洞不可见）。
 * 读侧按 `trajectory === null` 就能把它们分出来。
 *
 * ## 落盘形态
 *
 * ```
 * AGENT_SESSIONS/_user-quotes/<YYYY-MM-DD>.jsonl      ← 按天，一行一条
 * ```
 * ```json
 * {"ts":"2026-11-02T21:42:37+08:00","trajectory":"2026-08-24--S142--…","sessionId":"session-…","messageId":"…","text":"（原话，一字不改）","chars":88}
 * ```
 *
 * **为什么 JSONL 而不是每日 md**：① 与 `_im-logs/` 同族形态 ② **追加原子**、写不坏
 * ③ 按字段过滤（`trajectory` / 日期）比正则快。
 *
 * ## 失败语义：**响亮降级，绝不阻断 step**（与其他缝同规格）
 *
 * 采集失败（目录只读 / 磁盘满 / 配置坏）⇒ `console.warn` 一次并**放行**。
 * 🔴 判据：**台账是旁路观测，不是被观测对象的组成部分** —— 它坏了不该让宿主的一步跑不动
 * （对照：`output-guard` 打回是**阻断式**的，因为它守的是"别把敏感词说出去"，性质不同）。
 * ⚠️ 但**不许静默**：warn 里带路径与原因，否则"没记上"和"没人说过话"在读数上长得一样（D253 同族）。
 *
 * ## 去重（同一句被重复投递）
 *
 * inbox splice / 重试 / 冷载入都可能让**同一条消息**（同一个 `message.id`）在同一进程里
 * 被 `pre-step` 看到多遍。⇒ 进程内按 `messageId` 去重（有界 LRU，避免无限增长）。
 * ⚠️ **只去重"同一条消息"**，不按文本去重 —— 用户真的重复说同一句话是**合法事实**，
 *    按文本去重会把它吞掉（那是"用去重制造假数据"）。
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ACC_MESSAGE_KIND } from '../kernel/message-source.js'
import { findTrajectoryOfSession } from './bound.js'
import { CARRIER_OPENING_MARK } from './user-carrier.js'
import { ASSISTANT_PREFIX } from './assistant.js'

/** 台账目录（CCC 根相对）—— 与 `_im-logs/` 同族：`_` 前缀 = 非内容目录。 */
export const USER_QUOTES_DIR = 'AGENT_SESSIONS/_user-quotes'

/**
 * 冒充 `kind:'user'` 的两个生产者所打的标记。
 *
 * 🔴 判据来自**生产者自己**（它们本就为了让读者能分辨才打这个标记），
 * ⛔ 不是"我猜这些词像注入" —— 后者是措辞黑名单，会随措辞漂移而静默失效。
 */
export const USER_QUOTE_FAKE_MARKERS: readonly string[] = [
  CARRIER_OPENING_MARK,
  ASSISTANT_PREFIX,
]

/** 一条语录（落盘即此形状，字段顺序即 JSON 输出顺序） */
export interface UserQuote {
  /** 本地时区 ISO8601（全 ACC 统一当地时区，D66） */
  ts: string
  /** 持有该会话的轨迹目录名；未绑定 ⇒ `null` */
  trajectory: string | null
  /** dsh 会话 id */
  sessionId: string
  /** 宿主消息 id（去重键） */
  messageId: string
  /** 原话，**一字不改**（Q3） */
  text: string
  /** text 的码点数（读侧免 repeat 计算；⛔ 不是字节数） */
  chars: number
}

/** 落盘结果（供调用方与测试判定；退出码无关） */
export interface UserQuoteWriteResult {
  /** 实际写了几条（0 = 没有可写的真发言） */
  written: number
  /** 因冒充标记被排除几条 */
  excludedFake: number
  /**
   * ⚠️ **DII M3 后它只在"旧形态日志"上非零**（2026-11-04）：
   * 新代码产的消息都带 `source.origin`，冒充者由结构判据排除（并入 `not-user`）；
   * 只有**升级前落盘的旧消息**（没有 origin 字段）才会走到标记兜底并计入这里。
   * 🔴 **所以它是个迁移进度读数**：>0 ⇒ 还有旧形态在场；=0 ⇒ 新判据已全覆盖。
   */
  /** 因重复 id 被跳过几条 */
  skippedDuplicate: number
  /** 台账日期文件绝对路径（written > 0 时才有意义） */
  file: string
  /** 写失败原因（成功为 undefined） */
  error?: string
}

/**
 * 当前进程内已入账的 message id（有界 LRU）。
 *
 * ⚠️ **只在进程内有效**：跨重启的去重靠"日志里已经有这一行"——但那需要读全文件，
 * 而 `pre-step` 是每步都跑的热路径 ⇒ 不为它加一次全文件扫描。
 * 跨重启的重复投递**实际不会发生**（重启后 inbox 是空的，宿主不会重放已落盘的 user/message）。
 */
const seenMessageIds = new Set<string>()
const SEEN_MAX = 4096

function rememberMessageId(id: string): void {
  if (seenMessageIds.has(id)) return
  seenMessageIds.add(id)
  if (seenMessageIds.size > SEEN_MAX) {
    // Set 的迭代顺序 = 插入顺序 ⇒ 删最旧的那个（近似 LRU 足够：我们只需要"近期不重复写"）
    const oldest = seenMessageIds.values().next().value
    if (oldest !== undefined) seenMessageIds.delete(oldest)
  }
}

/** 仅测试用：清空去重记忆（⛔ 生产代码不许调） */
export function __resetUserQuoteDedupeForTest(): void {
  seenMessageIds.clear()
}

/**
 * 🔴🔴 **该会话是不是 subagent 子会话**（v1.113.2，owner 2026-11-03 裁：
 * 「subagent 任务书记录到用户语录是不对的，这个需要修掉」）。
 *
 * ## 为什么必须排除（判据缺陷，不是规格取舍）
 *
 * subagent 的父 agent 用 `createUserMessage(...)` 下发任务书，而宿主 `agent.followup/steer`
 * **只接受 user 消息** ⇒ 任务书的 `source.kind` **确实是 `'user'`**。
 * ⇒ 「`kind === 'user'`」这个判据**分不开「真人说的话」与「另一个 agent 说的话」**。
 *
 * 实测污染（v1.113.0/1 上线当天，42 条真实记录里 **2 条**）：
 * 正文是"你在宁静号 CCC 做一次只读的历史调研…"、`trajectory: null`。
 *
 * ## 判据为什么是两条（⛔ 只判一条会漏）
 *
 * | 字段 | 出处 | 谁在用同款判据 |
 * |---|---|---|
 * | `header.origin === 'subagent'` | DSH 路由语义（`agent-lookup.ts`） | `seams/context.ts` 的 `shouldAutoRestore` |
 * | `header.delegationDepth > 0` | 宿主委派深度 | `seams/bootstrap.ts` 的目录窄化 |
 *
 * ⇒ **两条都判**：实测两者通常同时在场，但**任一条单独在场时也必须排除**；
 * 被 resume 的旧持久化 subagent 会话不一定带全两个字段 —— 这正是要双判的理由。
 *
 * 🔴 **本函数是判据的单一真相源**：`seams/context.ts` 调它，测试也测它。
 * ⛔ 不要在两处各写一份 `origin === 'subagent' || depth > 0` —— 那是两份会漂的判据（D230）。
 *
 * ⚠️ **边界**：这是"结构性排除整个子会话"。若将来要让 subagent 也进台账，
 * 那要**换判据**（例如按 `parentSession` 溯源到真主），⛔ 不是在这里放宽 —— 那是另一个裁决。
 *
 * @param session 宿主 session（只需 `header`）
 * @returns 是 subagent ⇒ `true`（调用方应当**不采集**）
 */
export function isSubagentSession(session: unknown): boolean {
  const header = (session as { header?: { origin?: unknown; delegationDepth?: unknown } } | null | undefined)?.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * 一条消息的正文文本（只取 `text` 块，按出现顺序以 `\n` 相连）。
 *
 * 判据与 `session.ts:496` / `guard/seam.ts:70` 同款 —— 不另造一套取文法（否则同一条消息
 * 在不同缝里"说了什么"会不一样）。图片等非文本块**不参与**：Q3 要的是"用户说过什么"，
 * 图片没有可记录的文字面（媒体路径另有 `_im-logs/.../media/` 承载）。
 */
export function messageText(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * 一条消息**是不是用户直接说的话**（结构性判据 + 冒充标记排除）。
 *
 * ## 🔴 DII M3（2026-11-04）：判据升级为**读 `source.origin`**
 *
 * 修前：`kind === 'user'` ＋ **正文标记黑名单**（`CARRIER_OPENING_MARK` / `ASSISTANT_PREFIX`）。
 * 那是"事后辨认"——它不完备：`corpus` 那条链的 20+ 条措辞黑名单就是同一个病（`heads` 子命令
 * 因此成了"量漏网家族"的工具）。
 *
 * 修后：**先读 `source.origin`**（DII 把它投影进 source，见 `kernel/message-source.ts`）：
 * | `origin` | 含义 | 结论 |
 * |---|---|---|
 * | 缺席 ＋ `kind==='user'` | **真人直说**（ACC 的 `sourceOf` 对 origin:'user' **刻意不写该字段**） | `quote` |
 * | `'acc'` | ACC 产的（唤醒/提醒/开场白/rebuild 锚点…） | `not-user` |
 * | `'agent'` | 另一个 agent 产的（subagent 任务书等） | `not-user` |
 *
 * ⇒ **两个长期"冒充真人"的生产者（载体开场白／rebuild 锚点）现在出生即分格**，
 * 不再需要正文标记参与判定。见下方 `USER_QUOTE_FAKE_MARKERS` 的处置说明。
 *
 * @returns `'quote'` 收录 ／ `'not-user'` 不是用户发言（ACC 注入等）／
 *          `'fake-user'` **未带 origin 的旧日志里**靠正文标记认出是冒充者（过渡期兜底）
 */
export function classifyUserMessage(source: unknown, text: string): 'quote' | 'not-user' | 'fake-user' {
  const src = source as { kind?: unknown; origin?: unknown } | null | undefined
  const kind = src?.kind
  // ① 主判据：ACC/agent 产的 ⇒ 一律不是真人（**结构性，不靠措辞**）
  if (src?.origin === 'acc' || src?.origin === 'agent') return 'not-user'
  // ② 真人直说：kind==='user' 且**没有** origin 字段（宿主 user 支装不下它，故缺席=真人）
  if (kind !== 'user') return 'not-user'
  // ③ 兼容未迁移的旧日志：那时 ACC 的 kind:'user' 冒充者还没有 origin 字段，
  //    只能靠正文标记排除。⚠️ **过渡期兜底，且被单独计数**（`excludedFake`）——
  //    计数不是装饰：它 >0 说明**还有旧形态的冒充者在场**，是可观测的迁移进度读数。
  for (const marker of USER_QUOTE_FAKE_MARKERS) {
    if (text.startsWith(marker)) return 'fake-user'
  }
  return 'quote'
}

/** 本地时区 ISO8601（与 `cro/log.ts` 等处同款口径：不引第三方库，用 Date 的本地字段） */
export function localIso(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  )
}

/** 台账文件名（按天，本地时区） */
export function userQuoteFileName(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
}

/**
 * 把本 step 的 `messages` 里的**用户真发言**追加进当日台账。
 *
 * @param root CCC 根
 * @param sessionId 当前会话 id
 * @param messages `agent/pre-step` 的 `payload.messages`
 * @param nowMs 时间戳（测试注入；缺省 `Date.now()`）
 * @returns 落盘结果（**永不抛** —— 采集失败只 warn）
 */
export function recordUserQuotes(
  root: string,
  sessionId: string,
  messages: readonly { id?: string; source?: unknown; content?: readonly ContentBlock[] }[] | undefined,
  nowMs: number = Date.now(),
): UserQuoteWriteResult {
  const file = join(root, USER_QUOTES_DIR, userQuoteFileName(nowMs))
  const out: UserQuoteWriteResult = { written: 0, excludedFake: 0, skippedDuplicate: 0, file }
  if (!Array.isArray(messages) || messages.length === 0) return out

  const quotes: UserQuote[] = []
  for (const m of messages) {
    const text = messageText(m?.content)
    if (text.trim() === '') continue
    const cls = classifyUserMessage(m?.source, text)
    if (cls === 'not-user') continue
    if (cls === 'fake-user') { out.excludedFake++; continue }
    const id = typeof m?.id === 'string' ? m.id : ''
    if (id !== '' && seenMessageIds.has(id)) { out.skippedDuplicate++; continue }
    quotes.push({
      ts: localIso(nowMs),
      // 「对谁」= 按轨迹（Q1）。未绑定 ⇒ null（照常记，不制造系统性空洞）。
      trajectory: safeFindTrajectory(root, sessionId),
      sessionId,
      messageId: id,
      text, // Q3：一字不改
      chars: [...text].length, // 码点数（⛔ 不是 .length，那是 UTF-16 单元数）
    })
  }
  if (quotes.length === 0) return out

  try {
    mkdirSync(join(root, USER_QUOTES_DIR), { recursive: true })
    // 追加一整块（多条在同一批里一次 write）：`appendFileSync` 对同一 fd 的写入是原子的，
    // 且远比逐条 open/close 便宜 —— 这是每步都跑的热路径。
    appendFileSync(file, quotes.map((q) => `${JSON.stringify(q)}\n`).join(''), { encoding: 'utf8', flag: 'a' })
  } catch (e) {
    out.error = String((e as Error)?.message ?? e)
    console.warn(`[serenity-hooks] user-quotes 写入失败（不影响本步）：${file} — ${out.error}`)
    return out
  }
  // 🔴 只有**写成功之后**才记住 id：否则写失败的这批会被当成"已入账"而永久漏记。
  for (const q of quotes) if (q.messageId !== '') rememberMessageId(q.messageId)
  out.written = quotes.length
  return out
}

/** 查这次会话属于哪条轨迹；查不到/抛错 ⇒ `null`（⛔ 不让"查不到归属"毁掉整条录入） */
function safeFindTrajectory(root: string, sessionId: string): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    return findTrajectoryOfSession(root, sessionId)
  } catch {
    return null
  }
}

/** 台账目录是否已存在（诊断面用：区分"功能关着"与"开着但还没人说过话"） */
export function userQuotesDirExists(root: string): boolean {
  return existsSync(join(root, USER_QUOTES_DIR))
}
