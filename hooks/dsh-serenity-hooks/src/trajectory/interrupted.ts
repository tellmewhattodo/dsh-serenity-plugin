/**
 * 中断轮次发现（`interrupted` 会话扫描）
 *
 * ## 这个模块解决什么
 *
 * DSH 的会话日志里，**进程在某一轮完成前退出**（被 kill／崩溃／关机超时）时，
 * 宿主重放时会为该轮补上收尾事件：
 *
 * ```jsonl
 * turn/end {"turn":66,"reason":{"kind":"interrupted"}}
 * step/end {"turn":66,"step":85}
 * session/end-seed {}
 * ```
 *
 * 宿主**只补收尾，不续跑** —— 那一轮的工作就此停在那里。本模块负责把这些会话找出来，
 * 交给上层（认知轨迹）决定要不要续。
 *
 * ## 判据（三条同时成立，缺一不可）
 *
 * 1. 日志里**最后一条 `turn/end`** 的 `reason.kind` ∈ {@link UNFINISHED_KINDS}
 *    （= `interrupted` 崩溃补收尾 ／ `aborted` 正常终止，两者都是"这一轮没收完"）；
 * 2. 该 `turn/end` **之后没有新的 `turn/start`**（否则已被后续轮次接续）；
 * 3. ⛔ **不要求**末条是 `session/end-seed`（2026-10-23 放宽，原因见 {@link detectInterruptedEnd}）。
 *
 * 🔴 **2026-10-24 补入 `aborted`**：修前只认 `interrupted` ⇒「被正常终止」整类漏扫
 * （发布重启／换宿主最常见的形态）。判据问的是「这一轮收完了吗」，**不是"进程死得惨不惨"**。
 *
 * ⚠️ **为什么不能只看"存在过 interrupted"**：一个长会话历史上可能中断几十次
 * （本容器实测单会话 33 次）。只看"曾经中断"会把早已恢复的会话全部当成待续 ⇒ 灾难。
 *
 * 🔴 **为什么原判据要求"末条 = end-seed"是错的**（实测 26 条里漏 2 条）：
 * 重启后宿主会在 end-seed **之后**追加 `agent/inbox/spliced`（把待办消息重新塞进收件箱）
 * ⇒ "末条必须 end-seed"**在恢复动作发生之后就恒不成立**，
 * 而"被恢复过又再次被打断"恰恰是守护最该覆盖的形态。
 *
 * ## 为什么不整文件解压
 *
 * DSH 日志是 **zstd 多帧追加**（实测单会话 24705 帧 / 47 MB）。原生
 * `zlib.zstdDecompressSync` 只解**第一帧**，对多帧直接报 `Unknown frame descriptor`。
 * ⇒ 采用**尾部窗口 + 倒序逐帧解压**：只读文件末尾 N 字节，从后往前找帧魔数，
 *    解到凑够所需事件数即停。实测 8h 窗口 6 个会话 **20 ms**。
 *
 * ## 世代识别复用 `cleanup.ts`
 *
 * 日志文件名有多个世代（`session.jsonl` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`…），
 * 宿主按世代写且**迁移保留源文件**。⇒ 本模块**不硬编码文件名**，走
 * {@link findSessionLog}（与清理／体积统计同一判据），避免"新世代对本模块不可见"。
 *
 * ## 边界
 *
 * - **只读**：不改任何会话日志。
 * - **不判周期**：何时扫、扫完做什么归调用方（CCC 的认知轨迹）。本模块只回答
 *   「此刻哪些会话以 interrupted 结尾」。
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as nodeZlib from 'node:zlib'
import { findSessionLog } from './cleanup.js'

/**
 * zstd 解压（**运行时有、类型声明没有**）。
 *
 * 🔴 为什么不能用 `import { zstdDecompressSync } from 'node:zlib'`：
 * 本仓 `@types/node@^20` 的声明里**没有** zstd 系列（Node 22.15+ 才进声明）。
 * 而运行时本机 v22.22.1 **确实有**（实测 `typeof require('zlib').zstdDecompressSync === 'function'`）。
 * ⇒ 用命名空间导入 + 局部断言，并**在运行时校验**；缺失时走明确降级（返回空，不静默瞎猜）。
 */
const zstdDecompressSync: ((buf: Buffer) => Buffer) | undefined = (
  nodeZlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }
).zstdDecompressSync

/** zstd 是否可用（不可用时扫描会返回"读不到事件"，而不是假装成功） */
export const ZSTD_AVAILABLE = typeof zstdDecompressSync === 'function'

/** zstd 帧魔数（小端 `28 B5 2F FD`） */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 默认回看窗口：8 小时（owner 2026-10-22 定） */
export const DEFAULT_LOOKBACK_MS = 8 * 60 * 60 * 1000

/**
 * 尾部读取的**渐进块**（从小到大，够用就停）。
 *
 * 🔴🔴 **2026-10-24 A108：从"一次读满 8 MiB"改成"渐进扩块、见到证据就停"。**
 *
 * 修前：不管需要多少，**先 `readSync` 读满 8 MiB**，再线性扫一遍帧魔数（O(8 MiB)），
 * 然后解压到**攒够 400 条事件**为止 —— 而 400 只是一个**猜的数**：
 * 实测最长单轮 482 行、某会话 `turn/start` 落在 400 条之外 **83 行** ⇒ **证据被截断**，
 * 于是「这一轮没跑完」被读成「这一轮早就干净收尾了」⇒ **漏唤醒**。这就是 A108。
 *
 * ⇒ 现在的判据换成**「要的是证据，不是条数」**：从尾部往前，**一旦同时见到
 *   `turn/start` 与 `turn/end` 就停**（那两条就是判定所需的全部证据）。
 *
 * 💰 实测代价（本机 13 个窗口内会话，中位 3 次）：
 *    · 单会话 **0.2 ~ 54 ms**（多数 1~9 ms）｜13 个合计 **132 ms**；
 *    · 实际读取量多数 **64 KiB**（最多的一个才 4 MiB）—— **远小于修前的恒定 8 MiB**。
 * ⇒ 所以这既是**修正确性**，也是**省开销**（不是"用性能换正确"）。
 */
const TAIL_CHUNKS = [64 << 10, 256 << 10, 1 << 20, 4 << 20, 8 << 20] as const

/**
 * 尾部读取的**硬上限**（渐进块的最大一档）。
 *
 * ⚠️ 它仍然存在，因为"扫到边界为止"在病态日志上可能无界（一整轮几十万条事件）。
 * 与修前的区别：修前它是**起点**（无条件读满），现在它是**兜底**（扩到这里还没有证据才算不可判定）。
 */
const TAIL_WINDOW_BYTES = 8 << 20 // 8 MiB

/**
 * 🔵 **`TAIL_EVENT_TARGET`（原值 400）已于 2026-10-24 A108 删除** —— 它是**猜的数**，
 * 而猜错的代价是**漏唤醒**：实测最长单轮 482 行，某会话的 `turn/start` 落在 400 条之外
 * **83 行** ⇒ 证据被截断 ⇒「没跑完」被读成「早就干净收尾」。
 *
 * ## 换成什么了
 * 停止条件改成**「见到证据就停」**（同时见到 `turn/start` 与 `turn/end`），见
 * {@link readTailEvents} 与 {@link TAIL_CHUNKS}。
 *
 * 🔴 **宿主自己的权威判据也不数条数**：`@deepseek-ai/dsh-session` 的 `openTurnClosers`
 * **遍历全量事件**、只维护一个 `openTurn` 状态（`turn/start` 置、`turn/end` 清），
 * 扫完 `openTurn !== null` 即"这一轮没收"。它**没有窗口**。
 * ⚠️ 我们不照搬它，是因为它要读**全量**日志（崩溃恢复只在载入时做一次，负担得起），
 * 而本扫描**每 5min × 全部会话** —— 照搬会烧穿。⇒ 我们取它的**结论形态**（要证据、要能说"不知道"），
 * 不取它的**读法**（全量）。
 */

/** 日志里被我们识别的事件形状（只取用得到的字段） */
interface SessionEvent {
  type?: string
  time?: number
  data?: {
    turn?: number
    step?: number
    /**
     * `turn/end` 的收尾原因。
     *
     * 🔴 **2026-11-04：补上内层 `reason`** —— 真机形状是 **`reason` 里套着 `reason`**：
     * `{"turn":67,"reason":{"kind":"aborted","reason":{"kind":"user"}}}`
     * （本机 session-afc28ede turn 67 逐字实录）。
     * 外层回答"收完了吗"，内层回答"谁让它停的" —— 后者用于排除**用户手工停止**，
     * 见 `isUserIntentStop`。⚠️ `tsc` 会抓这个字段：缺了它 TypeScript 报 TS2339
     * （而**单测照样绿** —— 单测不走类型检查。所以「测试绿」不能代替 `typecheck`/`build`）。
     */
    reason?: { kind?: string; reason?: { kind?: string } }
    /** `tool/call` 的字段（callId 与 name 都在 data 这一层） */
    callId?: string
    name?: string
    /**
     * 🔴🔴 `tool/result` 的字段 —— **callId 藏在这里，不在 `data.callId`**。
     * 真机逐字形状见 {@link findPendingTools} 的头注（那是本文件最贵的一条取证）。
     */
    message?: { toolCallId?: string; source?: { callId?: string } }
  }
}

/** 一个"以 interrupted 结尾"的会话 */
export interface InterruptedSession {
  /** 会话目录名（= dsh 会话 id） */
  sessionId: string
  /** 日志绝对路径（当前世代） */
  logPath: string
  /** 被中断的轮次号 */
  turn: number | null
  /** 日志最后一条事件的时间（epoch ms，取不到则 null） */
  lastEventAt: number | null
  /** 日志文件 mtime（epoch ms） */
  mtimeMs: number
  /** 该轮里"有 call 无 result"的工具名（**尽力而为**，可能因尾部窗口截断而不全） */
  pendingTools: string[]
  /**
   * 🔴 **命中形态**（D244 输出面，guard 2026-10-24 要的判别式 Y 的一半）。
   *
   * | 值 | 含义 | 末条 `turn/end` |
   * |---|---|---|
   * | `interrupted-end` | 形态 A：日志**有** `turn/end`，其 `reason.kind ∈ {interrupted, aborted}` | 存在，见 {@link lastTurnEndKind} |
   * | `unclosed` | 形态 B：**开了没收** —— 窗口内最后一条 `turn/start` 之后没有 `turn/end` | **可能不存在** |
   *
   * 🔴 **为什么必须暴露它**：调用方（如 guard 的守护程序）要能自己判「该不该注入」，
   * 而这两种形态的**可用判据完全不同** —— 形态 B 连"末条 turn/end 的 kind"都不存在。
   * 把决定权留在 ACC 里 = 让调用方没法自己躲开误注入（D237 同族：读数要能改变下一步）。
   */
  form: 'interrupted-end' | 'unclosed'
  /**
   * 形态 A：末条 `turn/end` 的 `reason.kind`；形态 B：**恒为 `null`**（那时没有末条 turn/end）。
   * ⚠️ `null` 在这里**承载语义**（"该格不存在"），不是"没读到"（D233 同族）——
   * 两种成因在读数上不同：形态 B 的 `form` 会是 `unclosed`。
   */
  lastTurnEndKind: string | null
  /**
   * 日志尾部窗口里**最后一条 `turn/start` 的轮号**；窗口内没有则 `null`。
   * 与 {@link turn} 对照可看出「窗口是否把这一轮的起点挤出去了」（A108 的现场判据）。
   */
  lastTurnStartTurn: number | null
}

/** 扫描结果 */
export interface ScanResult {
  /** 以 interrupted 结尾的会话（最新在前） */
  sessions: InterruptedSession[]
  /** 窗口内实际检查的会话数 */
  scanned: number
  /** 窗口内但未命中（含正常结束）的会话数 */
  skipped: number
  /** 读取失败条目（诊断用，不阻断） */
  errors: Array<{ sessionId: string; message: string }>
  /** 扫描耗时（ms） */
  elapsedMs: number
  /**
   * 🔴🔴 **D245（2026-10-24）：被"在跑"排除掉的会话 id** —— 必须报告，不能静默跳过。
   *
   * **为什么这个字段是必需的**（真机实测，owner 报障「唤起了没有成功恢复」）：
   * 修前 `if (liveIds.has(sessionId)) continue` 是**静默**跳过 —— 既不计数也不报告。
   * 于是同一次扫描出现两个读数：
   * - 生产 tick 日志：`扫 11 个 · 排除在跑 4 个`（**知道**有 4 个被藏起来）
   * - 工具输出（guard 查的那个）：`检查 7 个 · 命中 0 · 跳过 7`（**完全看不到**那 4 个）
   * ⇒ guard 判「没事」⇒ 该救的没人救。
   *
   * ⇒ **判据（D237 同族）**：`scanned + excluded.size` 才是**窗口内总数**；
   *   只报 `scanned` 会让读者以为"就这么点会话"。
   * ⚠️ 这不是"多给一个诊断字段"——**它是"排除"这个动作的可见性**：
   *   任何"我替你把某些东西藏起来"的实现，都必须报告藏了几个、藏了谁。
   */
  excluded: string[]
  /**
   * 🔴🔴 **A108 第二半（2026-10-24）：判不出来的那些。**
   *
   * **为什么必须单开一桶**：修前「扩到上限仍见不到轮次边界」与「确实没有未完成轮次」
   * **返回值一模一样**（都是"没命中"）⇒ **"不知道"被塌成"没中断"** ⇒ 漏唤醒。
   *
   * 判据：`exhausted` ＝ 扩到 {@link TAIL_WINDOW_BYTES} 硬上限仍**没能同时见到**
   * `turn/start` 与 `turn/end`。典型成因：**一整轮长到 8 MiB 都装不下**。
   *
   * ⚠️ **这两条口径不许合并**（与 `excluded` 同理，D245 同族）：
   * - `skipped` ＝ **看过了，判定是"没事"**；
   * - `undecidable` ＝ **没看到足够的东西，不敢判**。
   * ⇒ 调用方拿到 `undecidable` 非空时**必须自己决定**（本仓纪律：宁可多醒不可漏）。
   */
  undecidable: Array<{
    sessionId: string
    logPath: string
    mtimeMs: number
    lastEventAt: number | null
    reason: string
  }>
}

/** 一次尾部读取的结果（**带上"够不够判"这件事本身**，见 {@link readTailEvents}） */
interface TailRead {
  /** 拿到的事件（时间正序；**可能不完整**，见 `exhausted`） */
  events: SessionEvent[]
  /**
   * 🔴 **是否"扩到硬上限仍没见到判定所需的两条证据"**。
   *
   * 为 `true` ⇒ **这一格不可判定**（不是"没中断"）：
   * 可能是一整轮太长、8 MiB 里都凑不齐 `turn/start` + `turn/end`。
   * ⇒ 调用方**必须**把它与"确实没有未完成轮次"分开报（A108 的第二半）。
   */
  exhausted: boolean
}

/**
 * 从文件尾部**渐进扩块**倒序解压，**见到判定所需的证据就停**。
 *
 * ## 与修前的两点不同（都对 A108 负责）
 *
 * 1. **不再一次读满 8 MiB**：按 {@link TAIL_CHUNKS} 从 64 KiB 起扩，够用就停。
 *    实测多数会话 64 KiB 就够（见 `TAIL_CHUNKS` 的代价段落）。
 * 2. **停止条件从"攒够 N 条"改成"见到证据"**。⛔ 不要再退回"攒够 400 条" ——
 *    那个数**必然**在长轮次上截断（实测被挤出 83 行）。
 *
 * ## 🔴 什么是「证据」（这里踩过一次，写清楚免得后人重犯）
 *
 * **必需证据 = 见到一条 `turn/start`**。理由：
 * - 判定形态 B（轮内死掉）只需"最后一条 `turn/start` 之后没有 `turn/end`"——
 *   而**进程死在轮内时，宿主根本没机会写 `turn/end`** ⇒ 若要求"必须见到 turn/end"，
 *   **这一整类会被判成"不可判定"**（我第一版就是这么写的，被 `形态 B` 用例当场打红）。
 * - `turn/end` 是**可选证据**：见到它能让形态 A（收尾原因）也成立，但它**不是判定的前提**。
 *
 * ⇒ 停止条件：**见到 `turn/start` 即可停**（`turn/end` 顺手见到更好）。
 * ⇒ 只有**连一条 `turn/start` 都见不到**才报 `exhausted`（那才是真的"不知道"）——
 *   典型成因：一整轮长到 8 MiB 都装不下它的起点。
 *
 * ⚠️ 另一种"见不到 turn/start"的合法情况：**日志里从来没有过轮**（空会话／只有 header）。
 *   ⇒ 那种情况扩到**全文**（`winBytes >= st.size`）仍见不到 ⇒ 判 `exhausted: false`
 *   （**"没有轮"是确定的，不是不知道**），由判据函数返回 null ⇒ 进 `skipped`。
 */
function readTailEvents(logPath: string): TailRead {
  if (zstdDecompressSync === undefined) return { events: [], exhausted: false } // 无 zstd ⇒ 见 ZSTD_AVAILABLE
  const st = statSync(logPath)
  if (st.size < 8) return { events: [], exhausted: false }
  const fd = openSync(logPath, 'r')
  try {
    for (const chunk of TAIL_CHUNKS) {
      const winBytes = Math.min(chunk, st.size)
      const buf = Buffer.alloc(winBytes)
      readSync(fd, buf, 0, winBytes, st.size - winBytes)

      const offsets: number[] = []
      for (let i = 0; i <= winBytes - ZSTD_MAGIC.length; i++) {
        if (
          buf[i] === ZSTD_MAGIC[0] &&
          buf[i + 1] === ZSTD_MAGIC[1] &&
          buf[i + 2] === ZSTD_MAGIC[2] &&
          buf[i + 3] === ZSTD_MAGIC[3]
        ) {
          offsets.push(i)
        }
      }

      const events: SessionEvent[] = []
      let sawStart = false
      for (let k = offsets.length - 1; k >= 0; k--) {
        const start = offsets[k]
        const end = k + 1 < offsets.length ? offsets[k + 1] : winBytes
        let text: string
        try {
          text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
        } catch {
          break // 帧不完整／损坏 ⇒ 停止回扫；已拿到的仍是更新的
        }
        const batch: SessionEvent[] = []
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as SessionEvent
            batch.push(ev)
            if (ev.type === 'turn/start') sawStart = true
          } catch {
            /* 单行坏了不该让整个扫描失败 */
          }
        }
        events.unshift(...batch)
        // 🔴 必需证据到手 ⇒ 立刻停（不再为"条数"多解压一帧）
        if (sawStart) return { events, exhausted: false }
      }

      // 这一档没见到 turn/start ⇒ 若已读到全文 ⇒ 「没有轮」是确定的（非不可判定）
      if (winBytes >= st.size) return { events, exhausted: false }
      // 若已扩到硬上限（但还没读完全文）⇒ 这一格真的不可判定
      if (winBytes >= TAIL_WINDOW_BYTES) return { events, exhausted: true }
      // 否则继续扩下一档（丢掉这档结果，下一档会读到更多事件）
    }
    // 理论上不可达（TAIL_CHUNKS 最后一档 == TAIL_WINDOW_BYTES）
    return { events: [], exhausted: true }
  } finally {
    closeSync(fd)
  }
}

/**
 * 判定一组尾部事件是否「以未完成的轮次结尾」。
 * 不命中 → null。
 *
 * ## 🔴🔴 2026-10-24 判据放宽（owner 报障：「有的会话在重启时不是崩溃的就扫不到，还是没修好」）
 *
 * ### 漏的是什么（宿主源码实读，非推测）
 *
 * 宿主只有**两条**会写出「轮次没收完」的 `turn/end`，而它们的 `kind` **不是同一个词**：
 *
 * | 形态 | 写谁 | `reason.kind` | 修前是否命中 |
 * |---|---|---|---|
 * | 进程**崩溃**／被强杀，下一轮 resume 时补收尾 | `interruptedTurnClosers()` → `openTurnClosers(events,{kind:'interrupted'})` | **`interrupted`** | ✅ |
 * | 进程**正常退出**（`restart-web` 的 SIGTERM、`agent/disposed`、用户中断） | 驱动 catch 里 `abortedCancelCause(signal)` | **`aborted`** ＋ 内层 `reason:{kind:'user'\|'parent'\|'disposed'\|'hook'}` | ❌ **漏** |
 *
 * ⇒ 修前只认 `interrupted` ⇒ **「被正常终止」这一大类全部漏掉**，而它恰恰是
 * **发布重启／换宿主** 最常见的形态（比崩溃常见得多）。
 *
 * 🔴 **这两条是同一个状态的两种成因，不是"一个对一个不对"**：
 * 判据问的是「**这一轮有没有收完**」，不是「进程死得惨不惨」。
 * 拿死法当判据 ⇒ 换一种死法就漏一批（这正是 owner 反复看到的"还是没修好"）。
 *
 * ### 为什么不能只加 `aborted` 就完事
 * `aborted.reason.kind` 里还可能有 `hook`（宿主主动 hook 取消）——它同属"没跑完"。
 * ⇒ 本判据**只看外层 `kind`**，理由：外层已经回答了"这一轮收完了吗"，
 *   内层回答的是"谁让它停的"，**那是另一个问题**，混进来会让判据随"谁取消的"漂移。
 *
 * ## 🔴🔴 2026-11-04 修正（owner 令）：**用户手工停止必须排除** —— 上述「只看外层」被推翻
 *
 * ### 原前提被谁取代
 * 上面那句「内层混进来会让判据漂移」成立于一个**当时没成立的前提**：
 * **没有人会手工停止**。实测它不成立 —— 外部用户报了「我根本没配任何监控，
 * 它自己跑起来了，我是手工点的停止」。⇒ 兜底把人**主动终止**的轮次当成"该被接走"，
 * 于是**人越喊停，它越来**。这不是判据漂移，是**判据答错了问题**。
 *
 * ### 新判据（**只加一格例外，不动其余**）
 * `aborted` **且** `reason.reason.kind === 'user'` ⇒ **不算"没跑完"**（用户已明确表达意图）。
 *
 * | 内层 kind | 谁让它停的 | 是否续跑 | 理由 |
 * |---|---|---|---|
 * | **`user`** | **人手工点的停止** | ⛔ **不** | 人的意图优先；反复拉起等于与用户对抗 |
 * | `disposed` | 宿主重启／销毁 | ✅ **是** | owner 2026-11-04 明令「重启后应当自动续跑」 |
 * | `parent` | 父轮终止 | ✅ 是 | 不是人对着本会话做的决定 |
 * | `hook` | 宿主 hook 取消 | ✅ 是 | 同属"没跑完" |
 * | 缺失/未知 | — | ✅ 是 | **缺省续跑**：这是兜底机制，保守方向是"救"而不是"弃" |
 *
 * 🔴 **为什么 `disposed` 必须留着**：2026-10-23 那个 **13 分钟盲窗**正是重启打断造成的
 * （实测读数见 `runInterruptedSafetyNet` 头注）。把 `disposed` 一起排除，等于
 * 用"修一个打扰"换来"复活一个已知事故"——**owner 已明确不换**。
 *
 * ⚠️ **形状陷阱（写代码与写夹具时都必须注意）**：真实事件是
 * `reason: { kind: 'aborted', reason: { kind: 'user' } }` —— **`reason` 里套着 `reason`**。
 * 取错层不会报错，只会**静默判错**。⇒ 夹具必须用**真日志样本**，⛔ 不许手写"我以为的样子"。
 *
 * ### ⛔ 刻意**不**纳入的形态（保守边界，写明理由）
 * - `error`：本轮**收完了**（宿主记了错误收尾），它不是"停在这里等人续"；
 * - 完全没有 `turn/end` 的开轮（例如日志末尾是 `turn/start` 后再无事件）：
 *   那**也可能是"进程正活着、这一轮正在跑"**，与真中断在读数上不可分
 *   ⇒ 纳入会误唤醒在跑的会话。⚠️ 这是**已知边界**，不是遗漏。
 *
 * ### 为什么不会误报"曾经中断但已恢复"
 * 恢复一定伴随 `turn/start`（新一轮）或新的 `turn/end`（`completed` 等）⇒ 判据 1／2 各自挡住。
 */
/**
 * 「这一轮没跑完」的 `turn/end.reason.kind` 取值域。
 *
 * 🔴🔴 **2026-10-24（owner 报障）**：原判据只认 `'interrupted'` 一个词 ⇒
 * **「被正常终止」整类漏扫**。两个值对应的形态见 {@link detectInterruptedEnd} 的头注。
 *
 * ⚠️ **这是判据的唯一取值点** —— 别在别处再写一份字面量（两份会漂）。
 */
const UNFINISHED_KINDS: ReadonlySet<string> = new Set(['interrupted', 'aborted'])

/**
 * 🔴 **2026-11-04（owner 令）：`aborted` 的内层成因里，哪一种是「人明确说了别跑」。**
 *
 * 只有 `user` —— 人手工点的停止。其余（`disposed` 重启／`parent`／`hook`／缺失）
 * 都不是"人对本会话表达过意图"，仍按"没跑完"处理。
 *
 * ⚠️ **为什么只列 user 而不列"要续跑的名单"**：形态会变（将来可能多出新 kind）。
 * 列"不续跑"的白名单 ⇒ 新形态缺省表现为**续跑**（保守方向 = 救而不是弃）；
 * 列"要续跑"的白名单 ⇒ 新形态缺省表现为**不救**，会静默丢保护。
 */
const USER_INTENT_STOP_KINDS: ReadonlySet<string> = new Set(['user'])

/**
 * 读 `turn/end` 的内层成因（`reason.reason.kind`）。
 *
 * 🔴 **形状陷阱**：真实事件是 `reason: { kind: 'aborted', reason: { kind: 'user' } }`
 * —— **`reason` 里套着 `reason`**。取错层不报错，只会静默判错。
 * 实测样本（2026-11-04，本机 session-afc28ede turn 67 逐字）：
 * `{"type":"turn/end","data":{"turn":67,"reason":{"kind":"aborted","reason":{"kind":"user"}}}}`
 *
 * @returns 内层 kind；缺失或非串 ⇒ `null`（**缺省续跑**，见 USER_INTENT_STOP_KINDS 的注释）
 */
export function innerAbortCauseOf(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type !== 'turn/end') continue
    const inner = events[i]?.data?.reason?.reason?.kind
    return typeof inner === 'string' ? inner : null
  }
  return null
}

/**
 * 「用户手工停止过」——**兜底机制的排除判据**。
 *
 * 判据 = 末条 `turn/end` 外层是 `aborted` **且** 内层成因命中 {@link USER_INTENT_STOP_KINDS}。
 * 只有这两个同时成立才排除；`interrupted`（崩溃）永不被它命中。
 */
export function isUserIntentStop(events: SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type !== 'turn/end') continue
    const outer = events[i]?.data?.reason?.kind
    const inner = events[i]?.data?.reason?.reason?.kind
    return outer === 'aborted' && typeof inner === 'string' && USER_INTENT_STOP_KINDS.has(inner)
  }
  return false
}

/**
 * 尾部窗口里**最后一条 `turn/start` 的轮号**（D244 输出面，给调用方做 A108 的现场判断）。
 *
 * ⚠️ 与 {@link detectUnclosedTurn} 不同：**它不判"是否未收尾"**，只**如实报告窗口里有什么**。
 * 分开的理由：前者是判据（会 deciding 命中），后者是读数（零判据风险）——
 * 把读数塞进判据函数，调用方就没法在"判据因为窗口截断而沉默"时看出**为什么**沉默。
 *
 * @returns 轮号；窗口内没有 `turn/start` 或轮号缺失 ⇒ `null`
 */
export function lastTurnStartTurnOf(events: SessionEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      const t = events[i]?.data?.turn
      return typeof t === 'number' ? t : null
    }
  }
  return null
}

/**
 * 尾部窗口里**最后一条 `turn/end` 的 `reason.kind`**（同上：读数，不是判据）。
 * @returns kind；窗口内没有 `turn/end`（形态 B 的典型）或 kind 缺失 ⇒ `null`
 */
export function lastTurnEndKindOf(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      const k = events[i]?.data?.reason?.kind
      return typeof k === 'string' ? k : null
    }
  }
  return null
}

/**
 * 命中判定（**形态 A：靠 `turn/end.reason.kind`**）。
 *
 * ⚠️ **本函数刻意不判「开了没收」** —— 那种形态与「此刻正在跑」在日志读数上**不可分**，
 * 只有扫描层手里有 `liveIds`（正在跑的会话 id）才判得准。
 * ⇒ 分工：**本函数判"收尾原因"，`scanInterruptedSessions` 判"开了没收"**（见 `detectUnclosedTurn`）。
 * ⛔ 不要把这些情形塞进本函数 —— 会让它同时依赖"日志形态"与"进程状态"，那种判据无法单独证伪。
 *
 * @returns 命中时给出被中断的轮次与"可能有副作用"的工具名；不命中 null
 */
export function detectInterruptedEnd(events: SessionEvent[]): { turn: number | null; pendingTools: string[] } | null {
  if (events.length === 0) return null

  // 判据 1／2：找**最后一条** turn/end，要求它属于「没跑完」的取值域，且其后没有新的 turn/start。
  //    ⛔ 不要退回"末条必须 end-seed"：那是载体形态判据，被恢复动作打破（见上方缺陷说明）。
  let idx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      idx = i
      break
    }
  }
  if (idx < 0) return null
  const turnEnd = events[idx]
  const kind = turnEnd?.data?.reason?.kind
  if (typeof kind !== 'string' || !UNFINISHED_KINDS.has(kind)) return null
  /**
   * 🔴 **2026-11-04（owner 令）：用户手工停止的轮次**不续跑**。
   *
   * 判据放在"命中没跑完"之后、"确认其后无新轮"之前 —— 语义上它属于
   * 「这一轮确实没收完，但**不该被接走**」，与"收完了"是两件事，⛔ 不要合并成一个 return。
   * 理由与取舍见文件头 §2026-11-04 修正（含 disposed 为何必须留着）。
   */
  if (isUserIntentStop(events)) return null
  // 之后若又开了新轮 ⇒ 旧轮已封口、且新一轮由 `detectUnclosedTurn` 负责判
  for (let i = idx + 1; i < events.length; i++) {
    if (events[i]?.type === 'turn/start') return null
  }

  const turn = typeof turnEnd?.data?.turn === 'number' ? turnEnd.data.turn : null
  return { turn, pendingTools: findPendingTools(events, turn) }
}

/**
 * 命中判定（**形态 B：一轮开了却没收**）—— 🔴🔴 **2026-10-24 owner 报障的正解**。
 *
 * ## 为什么这一格以前整类漏掉
 *
 * 进程在**轮内任意位置**死掉时，宿主**永远没机会写 `turn/end`**
 * ⇒ 日志就停在 `tool/call` ／ `step/start` ／ `assistant/message` 上。
 * 修前 `detectInterruptedEnd` 首行是 `if (idx < 0) return null`（找不到 turn/end 就放弃）
 * ⇒ **这一整类被判成"没中断"**。
 *
 * ## 判据
 * **最后一条 `turn/start` 之后没有 `turn/end`** ⇒ 那一轮开了没收。
 *
 * ## 为什么必须由**扫描层**调用（而不是并进 `detectInterruptedEnd`）
 * 「开了没收」与「此刻正在跑」在**日志读数上完全一样**。
 * 唯一能分开它们的东西是 `liveIds`（宿主报的"此刻在跑的会话"）——
 * 而那是**扫描层**的参数，不是日志的属性。
 * ⇒ 本函数只回答"日志形态是不是开了没收"，**由调用方保证已排除在跑的会话**。
 * ⚠️ 判据纪律：两个不同的问题（日志形态 ／ 进程状态）**不许塞进同一个函数**，
 *    否则那个函数无法被单独证伪（改任一侧都可能让测试红，而说不清是哪侧错了）。
 *
 * @param events 尾部事件
 * @returns 命中时给出未收尾的轮次与"可能有副作用"的工具名；没有未收尾的轮次 ⇒ null
 */
export function detectUnclosedTurn(events: SessionEvent[]): { turn: number | null; pendingTools: string[] } | null {
  if (events.length === 0) return null

  let lastEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      lastEnd = i
      break
    }
  }
  // 最后一条 turn/start 必须晚于最后一条 turn/end
  let startIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  if (startIdx < 0 || startIdx < lastEnd) return null

  /**
   * ⚠️ **不要拿 `session/end-seed` 当"已封口"判据**（我第一版这样写，当场被真机用例打红）。
   *
   * 真实日志里最常见的恢复形态就是
   *   `turn/end[interrupted] → session/end-seed → turn/start(新轮)`
   * —— `end-seed` 是**上一轮**的收尾标记，**不是新一轮的**。
   * 拿它判"新一轮已封口" ⇒ 会把「新一轮开了就死」误判成"已接续" ⇒ **又回到"啥都扫不到"**。
   *
   * ⇒ 判据保持最简：**最后一条 `turn/start` 是否晚于最后一条 `turn/end`**。
   *   "会不会重复拉起正在跑的会话"由 `liveIds` 负责（扫描层），不是本函数的事。
   */
  const t = events[startIdx]?.data?.turn
  const turn = typeof t === 'number' ? t : null
  return { turn, pendingTools: findPendingTools(events, turn) }
}

/**
 * 找出末轮里发起了但没有结果的工具调用名。
 *
 * ⚠️ **尽力而为**，非权威：尾部窗口可能截断更早的调用。上层应把它当
 * "**可能**未完成的副作用"清单，而不是"确定未完成"。
 *
 * ## 🔴🔴 2026-11-04：两个事件的 callId 在**不同的位置**（这是本文件的头号取证）
 *
 * owner 报障：`[中断续跑]` 的「有调用无结果的工具」约 **150 项、大量重复**，
 * 还混着更早轮次的 `get_goal` / `create_goal`。
 *
 * **真机逐字形状**（`dsh-session corpus raw` 从本容器活日志读出，⛔ 不是推断）：
 *
 * ```jsonc
 * // tool/call —— callId 在 data 这一层
 * {"type":"tool/call","data":{"turn":3,"step":1,
 *   "callId":"call_00_ET_…","name":"cognitive_trajectory","arguments":"…"}}
 *
 * // tool/result —— ⛔ callId 这一层**不存在**，它在 data.message 里
 * {"type":"tool/result","data":{"turn":3,"step":1,
 *   "message":{"role":"tool","source":{"kind":"tool","callId":"call_00_ET_…"},
 *              "toolCallId":"call_00_ET_…","content":[…]}}}
 * ```
 *
 * ⇒ 修前读 `data.callId` 恒 `undefined` ⇒ `resolved` **永远是空集**
 *   ⇒ 该轮**每一条** `tool/call` 都被判成"无结果"⇒ 清单退化成「这一轮的全部调用」。
 *
 * ## 🔴 它为什么能活这么久（这条比 bug 本身值得记）
 * **测试与实现用了同一个错误假设** —— 夹具也按虚构的 `data.callId` 构造 `tool/result`，
 * 于是两边一起错、一起绿（D275 同族：「定义了却没接上」）。
 * ⇒ 立判据：**测试的输入形状必须来自真机日志，⛔ 不是来自我的假设。**
 *
 * ## 两个位置都读（为什么不是二选一）
 * 真机两处**同时在场且相等**（`toolCallId` ≡ `source.callId`），但那是**当前实现的属性**，
 * 不是协议保证。⇒ 取 `toolCallId ?? source.callId`：任一处缺失仍能配对上；
 * 两处都没有 ⇒ 该结果**不参与排除**（宁可多报一个"可能未完成"，也不假报"全都完成了"）。
 *
 * @param events 尾部事件
 * @param turn 目标轮次；`null` ⇒ 不判（返回空清单）
 */
function findPendingTools(events: SessionEvent[], turn: number | null): string[] {
  if (turn === null) return []
  const called = new Map<string, string>()
  const resolved = new Set<string>()

  for (const e of events) {
    const data = e.data
    if (!data || data.turn !== turn) continue
    if (e.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      called.set(data.callId, data.name)
    } else if (e.type === 'tool/result') {
      // 🔴 callId 在 data.message 里（见头注）—— ⛔ 别再退回 data.callId
      const m = data.message
      const cid = m?.toolCallId ?? m?.source?.callId
      if (typeof cid === 'string') resolved.add(cid)
    }
  }
  return [...called].filter(([callId]) => !resolved.has(callId)).map(([, name]) => name)
}

/**
 * 待核工具清单的**显示上限**：超过这么多条就折叠成计数。
 *
 * ## 为什么必须有上限（owner 报障的另一半）
 * 这个清单会**原样注入进提示词**（`buildContinueText`）与界面。
 * 实测一次误判就能产出**约 150 项、大量重复**的名字 ⇒ 那是**每一轮的 token 成本**，
 * 而它对读者的信息量在 8 项之后已经趋零（人的核对动作是"抽查"，不是"逐条读"）。
 *
 * ⚠️ **折叠 ≠ 丢弃**：计数里保留**总数**，读者仍知道"还有多少没看"（D276：难看 ≠ 可以丢信息）。
 * ⇒ 前 {@link PENDING_TOOLS_DISPLAY_MAX} 项给出名字，其余折成「等共 N 项」。
 */
const PENDING_TOOLS_DISPLAY_MAX = 8

/**
 * 把待核工具清单渲染成**有上限**的一行。
 *
 * 🔴 **唯一实现点**：`buildContinueText`（进提示词）、`renderInterruptedScan` 与
 * `renderContinueResult`（进界面）三处都调它 —— ⛔ 别在别处再写一份 `join(', ')`，
 * 三份会漂（本轨迹已因"同一事实存多份"付过多次代价）。
 *
 * @param tools 工具名清单（**可能含重复**：同一工具在一轮里被调用多次且都无结果时，
 *              每一条 `tool/call` 各占一项 —— 那是真实信息，不在这里去重）
 * @returns 空清单 ⇒ 空串（调用方据此判"要不要印这一行"）
 */
export function formatPendingTools(tools: string[]): string {
  if (tools.length <= PENDING_TOOLS_DISPLAY_MAX) return tools.join(', ')
  const head = tools.slice(0, PENDING_TOOLS_DISPLAY_MAX).join(', ')
  return `${head} … 等共 ${tools.length} 项`
}

/**
 * 扫描一个 **project 目录**（形如 `<sessions-root>/--home-yh-home-home-serenity--/`）。
 *
 * @param projectDir DSH 项目目录（其下每个子目录是一个会话）
 * @param options.lookbackMs 回看窗口（缺省 8h）
 * @param options.now 注入"当前时刻"（测试用）
 * @param options.liveIds 需要跳过的会话 id（正在跑的会话不该被判为待续）
 */
export function scanInterruptedSessions(
  projectDir: string,
  options: { lookbackMs?: number; now?: number; liveIds?: ReadonlySet<string> } = {},
): ScanResult {
  const t0 = Date.now()
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS
  const now = options.now ?? Date.now()
  const cutoff = now - lookbackMs
  const liveIds = options.liveIds ?? new Set<string>()

  const result: ScanResult = { sessions: [], scanned: 0, skipped: 0, errors: [], elapsedMs: 0, excluded: [], undecidable: [] }

  if (!existsSync(projectDir)) {
    result.elapsedMs = Date.now() - t0
    return result
  }

  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch (err) {
    result.errors.push({ sessionId: '*', message: err instanceof Error ? err.message : String(err) })
    result.elapsedMs = Date.now() - t0
    return result
  }

  for (const sessionId of entries) {
    // 🔴🔴 D245：排除**必须登记**，不能静默 continue（见 `ScanResult.excluded` 的注释）。
    //    ⚠️ 只登记**落在回看窗口内**的那些 —— 窗口外的会话本来就不在该关心，
    //    把它们也算进 excluded 会让「窗口内总数」这个读数失真。
    if (liveIds.has(sessionId)) {
      const lp = findSessionLog(join(projectDir, sessionId))
      if (lp !== null) {
        try {
          if (statSync(lp).mtimeMs >= cutoff) result.excluded.push(sessionId)
        } catch {
          /* 读不到 mtime ⇒ 不登记（它连"是不是窗口内"都判不了） */
        }
      }
      continue
    }

    const dirPath = join(projectDir, sessionId)
    // 世代识别复用 cleanup 的判据（不硬编码文件名）
    const logPath = findSessionLog(dirPath)
    if (logPath === null) continue

    let mtimeMs: number
    try {
      mtimeMs = statSync(logPath).mtimeMs
    } catch (err) {
      result.errors.push({ sessionId, message: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (mtimeMs < cutoff) continue // 回看窗口

    result.scanned++
    try {
      const tail = readTailEvents(logPath)
      const events = tail.events
      /**
       * 🔴🔴 **A108：拿不到判定所需证据时，报「不可判定」，⛔ 不许塌成「没中断」。**
       *
       * `tail.exhausted` 的判据 = 扩到 8 MiB 硬上限仍**没能同时见到** `turn/start` 与 `turn/end`。
       * 那时两个判据函数都会返回 null（它们只看「见到的那些事件」）——
       * 而「没证据」与「证据说没事」在返回值上长得一样，**这正是 A108 的漏**。
       * ⇒ 所以这一格必须**在调用它们之前**分流。
       */
      if (tail.exhausted) {
        result.undecidable.push({
          sessionId,
          logPath,
          mtimeMs,
          lastEventAt: typeof events[events.length - 1]?.time === 'number' ? (events[events.length - 1]!.time as number) : null,
          reason: `扩到 ${Math.round(TAIL_WINDOW_BYTES / 1048576)} MiB 硬上限仍未同时见到 turn/start 与 turn/end`,
        })
        continue
      }
      /**
       * 🔴🔴 **两种形态都要接**（2026-10-24 owner 报障：「我要求你抓到非工具调用的中断，
       * 现在什么都抓不到了」）。
       *
       * - 形态 A `detectInterruptedEnd`：日志里有 `turn/end`，且它的 `reason.kind` 是
       *   `interrupted`（崩溃后被 resume 补收尾）／`aborted`（被正常终止）。
       * - 形态 B `detectUnclosedTurn`：**日志里压根没有 `turn/end`** —— 进程在轮内任意位置死掉，
       *   宿主没机会写收尾 ⇒ 日志停在 `tool/call` / `step/start` / `assistant/message`。
       *   ⚠️ **这一格必须靠"已排除在跑的会话"才成立**，而 `liveIds` 恰好在本函数手里
       *   （循环开头 `if (liveIds.has(sessionId)) continue`）⇒ 这就是它该待在这里、而不是
       *   并进 `detectInterruptedEnd` 的原因。
       *
       * 实测（本机 10 个窗口内会话）：**4 条**只能由形态 B 抓到（末条 `tool/call` / `step/start`），
       * 修前全落到 `skipped`。
       */
      const formA = detectInterruptedEnd(events)
      const formB = formA === null ? detectUnclosedTurn(events) : null
      const hit = formA ?? formB
      if (!hit) {
        result.skipped++
        continue
      }
      const tailTime = events[events.length - 1]?.time
      result.sessions.push({
        sessionId,
        logPath,
        turn: hit.turn,
        lastEventAt: typeof tailTime === 'number' ? tailTime : null,
        mtimeMs,
        pendingTools: hit.pendingTools,
        // 🔴 D244 输出面（guard 判别式 Y）：把「哪一形态」与「窗口里到底有什么」如实交出去，
        //   让调用方能自己判该不该注入 —— 而不是把这层判断藏在 ACC 里。
        form: formA !== null ? 'interrupted-end' : 'unclosed',
        lastTurnEndKind: lastTurnEndKindOf(events),
        lastTurnStartTurn: lastTurnStartTurnOf(events),
      })
    } catch (err) {
      result.errors.push({ sessionId, message: err instanceof Error ? err.message : String(err) })
    }
  }

  result.sessions.sort((a, b) => (b.lastEventAt ?? b.mtimeMs) - (a.lastEventAt ?? a.mtimeMs))
  result.elapsedMs = Date.now() - t0
  return result
}

/**
 * 由 CCC 根推导它的 DSH 项目目录名（`--home-yh-home-home-serenity--`）。
 *
 * 规则取自宿主：把绝对路径的 `/` 换成 `-`，并在前后各加 `--`。
 * ⚠️ 这是**推导**，不是真相源 —— 实际目录名以磁盘为准；调用方应在不存在时
 * 回退到"扫整个 sessions root"或直接报未找到。
 */
export function projectDirNameForCwd(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '')
  return `--${normalized.split('/').filter(Boolean).join('-')}--`
}

// ── 续跑（continue-all-interrupted）────────────────────────────────────────

/** 单条续跑结果 */
export interface ResumeOutcome {
  sessionId: string
  /** 是否已把消息投进该会话 */
  ok: boolean
  /** 投递路径：live = 已在跑（直接注入）｜cold-resume = 冷载入后注入 */
  how?: string
  /** 失败原因 */
  error?: string
}

/**
 * 续跑正文（**简单、稳定、不含版本号**）。
 *
 * 判据（为什么这么短）：本动作的用途是**把被打断的会话推回工作状态**，
 * 不是替它重述任务 —— 被打断那一轮的上下文就在它自己的日志里。
 * ⇒ 正文只做三件事：① 说明发生了什么；② 提示**先核对副作用**；③ 让它接着做。
 *
 * 🔴 **为什么要写"先核对副作用"**：中断时可能有「有 call 无 result」的工具调用，
 * 它们的副作用**未知**（可能已写文件 / 已发消息）。若模型把那一轮整段重放，
 * 会**重复执行**。这句话是给模型的护栏，不是客套。
 *
 * 🔴 **本正文会被注入进提示词** ⇒ `pendingTools` 一律经 {@link formatPendingTools} 折叠，
 * ⛔ 不许裸 `join(', ')`（那样一个乱轮就能塞进上百个名字）。
 */
export function buildContinueText(sessionId: string, turn: number | null, pendingTools: string[]): string {
  const lines: string[] = []
  /**
   * 🔴🔴 **2026-11-04（owner 报障）：首行必须自报身份 —— 这是 ACC 自动发的，不是人安排的。**
   *
   * 修前首行是「上一条进程在本轮完成前退出，该轮已被中止。现在继续。」——
   * **完全看不出是谁在说话**。实测代价：外部用户收到它后问「这个续跑的消息你知道来源哪里吗」,
   * 并且**用了一整轮去反查**（查 live 会话、查唤醒表、查 CRO 才确认是 harness 自己发的）。
   *
   * ⇒ 判据：**自动行为必须能被一眼认出是自动的**。人在看到一个祈使句（"请接着完成…"）时
   *   默认会以为**有人**在安排工作；不写清来源，就是在制造"我以为有人在派活"。
   *   这是 D262 的同族：报错／通知要能指回"谁触发的、怎么关"。
   */
  lines.push('[ACC 自动 · 中断续跑] 下面这件事不是你安排的，是系统在自动恢复。')
  lines.push('')
  lines.push('上一条进程在本轮完成前退出，该轮已被中止。现在继续。')
  lines.push('')
  lines.push(`会话: ${sessionId}${turn === null ? '' : ` ／ 被中断的轮次: turn ${turn}`}`)
  if (pendingTools.length > 0) {
    lines.push('')
    lines.push(
      `⚠️ 中断时这些工具「有调用、无结果」（副作用未知，**可能已经执行**）: ${formatPendingTools(pendingTools)}`,
    )
    lines.push('   ⇒ 先核对它们是否已生效（文件是否已写、消息是否已发），再决定要不要重做。')
    lines.push('   ⛔ 不要把被中断的那一轮整段重放。')
  }
  lines.push('')
  /**
   * 🔴🔴 **2026-11-10（owner 报障，platform-9047 现场）：这句话必须显式区分两种"没跑完"。**
   *
   * 修前只有一句「请接着完成该轮未完成的工作」。实测代价（owner 截图）：
   * 那一轮其实是**正常结束、在等 owner 拍两个问题**（删测试行 ／ 要不要现在发 develop），
   * 宿主重启把它记成 `turn/end{reason:{kind:'interrupted'}}` —— 与「干到一半被掐」
   * **在读数上完全同形**。于是模型把「等授权」读成「有活没干完」，并自行推理出
   * 「owner 之前说过要发 develop」⇒ **差点自己授权了一次对外发布**。
   *
   * 判据：**兜底能证明的只有「这一轮没收完」，它证明不了「这一轮该由我继续做」。**
   * 「等人拍板」的轮次同样是「没收完」⇒ 必须由读的人自己分辨，⛔ 不能由这一段文字默认放行。
   */
  lines.push('请接着完成该轮未完成的工作；完成后把进展写入本轨迹的 SESSION.md。')
  lines.push('')
  lines.push('🔴 但请先自己判断这一轮是哪种"没跑完"：')
  lines.push('   · 如果它是在**干到一半被掐断** ⇒ 接着做。')
  lines.push('   · 如果它其实是**正常结束、在等 owner 拍板**（提问、给选项、等一句"发/不发"）'
    + ' ⇒ ⛔ 那不是未完成的工作。**本条消息不构成任何授权**：')
  lines.push('     不要因为"系统让我继续"就去执行正在等待的那个动作，也不要翻历史找一句旧授权来顶替。')
  lines.push('     把待拍板的问题重新摆出来等回答即可。')
  lines.push('')
  lines.push('（说明：这是 ACC 的「中断兜底」，每 5 分钟检查一次被中断的会话并继续。')
  lines.push('  你手工点过"停止"的轮次**不会**被它续跑。）')
  return lines.join('\n')
}

/**
 * 把一个 agent 唤醒（注入一条续跑消息）。
 *
 * 两条路径（与 `wake/scheduler.ts` 的 `sendToCognitiveTrajectory` 同源判据）：
 * - **live**：`agents.get(id)` 拿得到 ⇒ 目标在跑（或被加载）⇒ `steer` 当场注入当前轮；
 *   `steer` 不可用则退回 `followup`（宁可排队，不可静默丢）。
 * - **cold-resume**：`sessionController.resolveAgent(id)` 冷载入后同样注入。
 *
 * ⚠️ 冷会话载入**会真起一个 agent**（消耗真实算力）⇒ 调用方必须自己决定要不要，
 * 本函数不做数量限制（那是策略，归调用者）。
 */
export function createResumeOne(deps: {
  agents: { get?: (id: string) => unknown } | undefined
  sessionController: { resolveAgent?: (id: string) => Promise<{ agent?: unknown; error?: string }> } | undefined
  makeMessage: (text: string) => unknown
}): (hit: { sessionId: string; turn: number | null; pendingTools: string[] }) => Promise<ResumeOutcome> {
  return async (hit) => {
    const { sessionId } = hit
    const text = buildContinueText(sessionId, hit.turn, hit.pendingTools)

    let agent: unknown
    let how: string

    // ① live 优先
    const live = deps.agents?.get?.(sessionId)
    if (live) {
      agent = live
      how = 'live'
    } else {
      // ② 冷恢复
      const sc = deps.sessionController
      const resolve = sc?.resolveAgent
      if (typeof resolve !== 'function' || sc === undefined) {
        return { sessionId, ok: false, error: '宿主 sessionController 不可用（重启启动窗口？）—— 稍后重试' }
      }
      try {
        const out = await resolve.call(sc, sessionId)
        if (!out?.agent) {
          return { sessionId, ok: false, error: `冷载入未返回 agent: ${String(out?.error ?? '未知原因')}` }
        }
        agent = out.agent
        how = 'cold-resume'
      } catch (err) {
        return { sessionId, ok: false, error: `冷载入失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    // ③ 注入：steer 优先（当场进当前轮），失败退回 followup（排队，不丢）
    const a = agent as { steer?: (m: unknown) => void; followup?: (m: unknown) => void; status?: string }
    try {
      if (typeof a.steer === 'function' && a.status === 'running') {
        a.steer(deps.makeMessage(text))
        return { sessionId, ok: true, how: `${how}+steer` }
      }
      if (typeof a.followup === 'function') {
        a.followup(deps.makeMessage(text))
        return { sessionId, ok: true, how: `${how}+followup` }
      }
      if (typeof a.steer === 'function') {
        a.steer(deps.makeMessage(text))
        return { sessionId, ok: true, how: `${how}+steer` }
      }
      return { sessionId, ok: false, how, error: 'agent 既无 steer 也无 followup（宿主契约漂移）' }
    } catch (err) {
      // steer 抛错 → 退 followup
      if (typeof a.followup === 'function') {
        try {
          a.followup(deps.makeMessage(text))
          return { sessionId, ok: true, how: `${how}+followup(steer 失败后退回)` }
        } catch (err2) {
          return { sessionId, ok: false, error: `steer 与 followup 均失败: ${String((err2 as Error)?.message ?? err2)}` }
        }
      }
      return { sessionId, ok: false, error: `注入失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
