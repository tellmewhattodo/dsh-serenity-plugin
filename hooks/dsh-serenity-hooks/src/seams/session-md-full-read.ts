/**
 * seams/session-md-full-read.ts — **读 SESSION.md 一次给全文**（owner 2026-11-20 令）
 *
 * ## owner 要的是什么（原话）
 *
 * > 「由于 SESSION.md 的本质，所以无论多大都需要一次全读，故节约的是调用次数」
 * > 「请你照顾你自己的习惯，习惯的东西不应当改变，只是机械层面我们让它直接出全文就好，
 * >  也就是说只要读的是 SESSION.md；无视参数；直接全文；这就照顾到了每一个轨迹的成本」
 *
 * 拆成三条可判定的约束：
 * | # | 约束 | 落地 |
 * |---|---|---|
 * | 1 | **只认 SESSION.md** | 文件名精确 `SESSION.md`（⛔ 不是"含 SESSION 的路径"） |
 * | 2 | **无视参数** | 传 `limit`/`offset` 一律不管，恒从第 1 行给到末行 |
 * | 3 | **模型看到的是全文** | 替换**模型读的那一面**（content），⛔ 不动结构化 value |
 *
 * ## 🔴 为什么不能"放大 limit"就完事（本模块存在的真正理由）
 *
 * 宿主 `read` 有三道上限，**行数不是卡住我们的那道**：
 * | 配置 | 默认 | 实测后果 |
 * |---|---|---|
 * | 一次最多行数 | 2000 | 我们这份 500 余行 ⇒ **没撞到它** |
 * | **一次最多字节数** | **51200 B** | **实测截断点就在这**：66,881 B 的文件停在第 360 行 |
 * | 单行最长 | 2000 字符 | 与本模块无关 |
 * ⇒ 传多大的 `limit` 都过不了字节这道闸；而且 `limit` 一旦超过上限，宿主**直接抛错**。
 * ⇒ 唯一可行的机械手段 = **在结果返回后重写模型看到的那一面**。
 *
 * ## 🔴 为什么不自己拼整份文本（本模块最容易写错的一处）
 *
 * 第一版我打算「读文件 → 自己编号 → 整份塞进去」。**那是复刻宿主的渲染语义**，
 * 而本仓已为这件事付过代价（自写探针复刻 `foldSurface`，复刻错就得到相反结论）。
 * ⇒ 改为**就地接续**：取宿主**真实产出**的前缀（含它自己的编号样式与信封），
 *   只把**剩余行**按同样样式接上，再接回宿主自己的结尾。格式的定义权仍归宿主。
 *
 * ## 🔴 失败一律原样放行
 *
 * 识别不出格式 / 读不到文件 / 拼接后不合法 ⇒ **一个字节都不改**，退回分次读。
 * **残缺的长文档比短的完整文档危险得多** —— 它不报错。
 *
 * ## ⚠️ 已知边界（如实登记）
 *
 * · 只在本进程能读到该文件时生效；读不到就放行。
 * · 只接管 `read` 这一个工具名，其余工具零干预（见测试的对照验证）。
 * · ⛔ **不设体量上限**：owner 明确「阈值 100 KB，实际最大就在这附近」⇒
 *   在 100 KB 量级设上限属于伪需求。但这条依赖「SESSION.md 有体积告示」这个既有机制，
 *   若那个机制被拆掉，本模块会让一次读取无界 ⇒ 登记为耦合项。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** 只接管这**一个**文件名（精确匹配，⛔ 不是后缀/包含匹配） */
const SESSION_MD_BASENAME = 'SESSION.md'

/** 宿主 read 产出的信封形态（逐字对读过宿主 `formatReadOutput`） */
const ENVELOPE_RE = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/

/** 行号前缀 `NNN: ` —— 编号样式由宿主决定，这里只**识别**，不发明 */
const LINE_RE = /^(\d+): ([\s\S]*)$/

/** 宿主三种结尾（capped / 还有更多 / 读到末尾） */
const FOOTER_CAPPED_RE = /^\(Output capped\. Showing lines (\d+)-(\d+)\. Use offset=(\d+) to continue\.\)$/
const FOOTER_MORE_RE = /^\(Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to continue\.\)$/
const FOOTER_END_RE = /^\(End of file - total (\d+) lines\)$/

export interface FullReadOutcome {
  /** 改写后的 content；`null` = 不接管（调用方必须原样放行） */
  text: string | null
  /** 为什么没接管（诊断用；`null` = 已接管） */
  reason: string | null
}

/**
 * 判「这次 read 是不是在读 SESSION.md」。
 *
 * ⚠️ 用 `basename` 精确比，⛔ 不用 `includes('SESSION')`：
 * 后者会把 `SESSION-archive-2026-11-20.md`（几百 KB 的归档）也一起接管，
 * 那是**本模块最危险的一种误判** —— 归档本来就该分次读。
 */
export function isSessionMdRead(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  return basename(filePath) === SESSION_MD_BASENAME
}

/**
 * 把宿主产出的「前 N 行」接续成全文。
 *
 * @param content  宿主给模型看的文本（单个 text 块的内容）
 * @param absolutePath 真实文件路径（用于读全文；读不到就放行）
 * @returns `text=null` 表示不接管
 */
export function extendToWholeFile(content: string, absolutePath: string): FullReadOutcome {
  const m = ENVELOPE_RE.exec(content)
  if (!m) return { text: null, reason: 'envelope-unrecognized' }

  const body = m[2]!
  // 末尾空行 + footer：宿主在正文与 footer 之间恒有一个空行
  const split = body.lastIndexOf('\n\n')
  if (split < 0) return { text: null, reason: 'no-footer-separator' }
  const bodyLinesText = body.slice(0, split)
  const footer = body.slice(split + 2)

  const isCapped = FOOTER_CAPPED_RE.test(footer)
  const isMore = FOOTER_MORE_RE.test(footer)
  const isEnd = FOOTER_END_RE.test(footer)
  if (!isCapped && !isMore && !isEnd) return { text: null, reason: 'footer-unrecognized' }

  // 已经读到末尾 ⇒ 本来就是全文，不必动
  if (isEnd) return { text: null, reason: 'already-complete' }

  // 取宿主真实产出的行（保序、保编号样式）
  const given: { number: number; text: string }[] = []
  for (const line of bodyLinesText.split('\n')) {
    const lm = LINE_RE.exec(line)
    if (!lm) return { text: null, reason: 'body-line-unrecognized' }
    given.push({ number: Number(lm[1]), text: lm[2]! })
  }
  if (given.length === 0) return { text: null, reason: 'body-empty' }

  // 读全文（失败 ⇒ 放行；⛔ 不抛）
  let all: string[]
  try {
    all = readFileSync(absolutePath, 'utf-8').split('\n')
  } catch {
    return { text: null, reason: 'file-unreadable' }
  }
  // 末元素若是空串（文件以换行结尾），它不是一行内容
  if (all.length > 0 && all[all.length - 1] === '') all.pop()

  const lastGiven = given[given.length - 1]!
  if (all.length <= lastGiven.number) {
    // 宿主已经给到末尾之后，或文件在读取窗口内被改小了 ⇒ 放行，⛔ 不猜
    return { text: null, reason: 'nothing-left-to-extend' }
  }
  // 🔴 身份核验：宿主给的最后一行必须与磁盘上同编号那一行逐字相同。
  //    不一致 ⇒ 文件在两次读之间被改过 ⇒ **放行**（拼接会产生一份"看起来连续、实则错位"的文本）
  if (all[lastGiven.number - 1] !== lastGiven.text) {
    return { text: null, reason: 'file-changed-since-read' }
  }

  const rest = all.slice(lastGiven.number).map((t, i) => `${lastGiven.number + 1 + i}: ${t}`)
  const extendedBody = [...bodyLinesText.split('\n'), ...rest].join('\n')
  const totalLines = all.length
  // 结尾用宿主的结尾形态（⛔ 不自造第 4 种）
  const newFooter = `(End of file - total ${totalLines} lines)`

  return {
    text: `<path>${m[1]}</path>\n<type>file</type>\n<content>\n${extendedBody}\n\n${newFooter}\n</content>`,
    reason: null,
  }
}

/**
 * 从一次成功 read 的 content 里取**单个 text 块**的正文。
 * 非单块 / 非 text ⇒ `null`（放行）。
 */
export function singleTextOf(content: unknown): string | null {
  if (!Array.isArray(content) || content.length !== 1) return null
  const only = content[0] as { type?: unknown; text?: unknown } | undefined
  if (!only || only.type !== 'text' || typeof only.text !== 'string') return null
  return only.text
}

/**
 * 注册读全文接管（`index.ts` 的 apply 调用）。
 *
 * ## 🔴 三处必须守住的边界
 *
 * ① **只改 `content`，⛔ 绝不动 `value`** —— 宿主源码对此有硬断言：
 *    同时给两者会 `throw TypeError("cannot replace both value and content")`。
 *    落到实处：`surface/usage.ts` 读的是 `value`，动它就会**打断用量统计**。
 * ② **`isError` 一律放行** —— 失败的读取没有正文可接续。
 * ③ **本钩子永不抛** —— 它挂在每轮都跑的返回路径上；抛一次等于用一次优化打断会话。
 *    `try/catch` 兜底后返回 `next()`（下游其他人的决策照旧）。
 *
 * ## 与既有 `tools/post-execute` 消费者的关系
 *
 * 本仓另有一处同钩子（keeper 计分／提醒／体积告示）。两者在**不同文件里各注册一次**，
 * 宿主按 waterfall 串联 ⇒ 谁先谁后不影响正确性：本钩子只碰 `content`，
 * 那一处只碰 `additionalContexts`。**这里刻意不合并**，因为合并会让
 * 「一次读文件」和「每轮计分」产生编译期耦合。
 */
export function registerSessionMdFullRead(ctx: unknown): void {
  const on = (ctx as {
    on?: (name: string, fn: (...a: never[]) => unknown) => void
  }).on
  if (typeof on !== 'function') return

  on.call(ctx, 'tools/post-execute', async (
    exec: {
      name?: string
      arguments?: { file_path?: unknown }
    },
    result: {
      isError?: boolean
      content?: unknown
      additionalContexts?: unknown[]
    },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const downstream = await next()
    try {
      // ① 只认 `read`
      if (exec?.name !== 'read') return downstream
      // ② 只认 SESSION.md（精确文件名）
      const argPath = exec.arguments?.file_path
      if (!isSessionMdRead(argPath)) return downstream
      // ③ 失败结果放行
      if (result?.isError === true) return downstream
      // ④ 下游若已把结果改成 block，就没有 content 可改 —— 放行
      const ds = downstream as { kind?: string; content?: unknown }
      if (ds?.kind === 'block') return downstream

      const text = singleTextOf(result.content)
      if (text === null) return downstream

      // 若下游（别的监听器）已替换过 content，就在**它的**结果上接续
      const baseText = singleTextOf(ds.content) ?? text
      const outcome = extendToWholeFile(baseText, String(argPath))
      if (outcome.text === null) return downstream

      return { ...ds, content: [{ type: 'text', text: outcome.text }] }
    } catch {
      /* 绝不抛：本钩子挂在每轮返回路径上 */
      return downstream
    }
  })
}
