/**
 * trajectory/carrier-log.ts — **LOG 式交接记忆的机械轮转**（v1.136.0，owner 2026-11-15 令）
 *
 * ## owner 令（逐字）
 *
 * > 「LOG 式的轨迹交接记忆设定 在我们轨迹验证了效果不错，需要升级到 ACC 层 代替老方案」
 *
 * ## 它替代的是哪一个"老方案"（必须写清，否则下一个人不知道删什么）
 *
 * 老方案 = **SESSION.md 单文件承担两种颗粒度** ⇒ 它必然膨胀 ⇒ 必须不断"压缩"
 * （逐字搬 → 守恒核验 → 切正文 → 换索引 → 量字节，五步）。压缩是本载体维护中最贵的动作，
 * 而它之所以存在，**只是因为高低两层颗粒度挤在同一个文件里**。
 *
 * 新方案 = **两层分离**：
 *   · `SESSION.md`  —— 高策展（身份／决策／里程碑一行＋证据指针／当前状态／待裁）
 *   · `LOG/LOG.md`  —— 低策展（怎么试、错了什么、读了什么；**可丢**）
 * ⇒ 收益不是"文件变小"，是**「压缩」这个动作不再需要被做**：出槽那一代整份 `mv` 走，零内容风险。
 *
 * ## 🔴 这一版与原型（S142 轨迹自测）的差别 = 谁来轮转
 *
 * S142 的设计件 §5.2 明写：原型用「PROMPT.md 纪律」（soft），
 * 而「把它升级成 A（ACC 机制）是另一个裁决」（要 owner 定，并需处理 D23 边界）。
 * **owner 2026-11-15 给了这个裁决** ⇒ 本文件就是那个 A。
 *
 * 🔴 **原型的失效形态正因为是 soft 才发生**：忘了轮转 ⇒ LOG 无限长、代数不增、**且无信号**。
 *    本文件把它变成 rebuild 路径上的**机械动作** ⇒ agent 忘不忘都不影响。
 *
 * ## D23 边界（ACC 管机制 / CCC 管措辞）—— 判据
 *
 * 本文件**只做机械动作**：判空／定时／定名／rename／回读校验／写出生头。
 * ⛔ 它**不规定** SESSION.md 写什么、不规定 LOG 里写什么、不定义章节名 —— 那些是 CCC 的措辞，
 *    由各轨迹自己的 PROMPT.md 声明。⇒ 不越界。
 *
 * ## 🔴🔴 铁律：轮转**永不覆盖**（两个入口，不是一个）
 *
 * `renameSync(src, dst)` 在 POSIX 上**目标存在就静默覆盖**。若两次 rebuild 落在同一分钟
 * （崩溃重启循环 / 连点重建 / 时钟回拨），上一代日志无声消失。
 * 2026-11-04 实测踩过**第二个入口**：对非空 `LOG.md` 直接 `write` ≡ 销毁这一代，**同样不报错**。
 * ⇒ 三条硬判据（顺序不可换）：
 *   ① 目标名已存在 ⇒ 换名（`-2`、`-3`…），⛔ 不覆盖；
 *   ② 只有**确认目标不存在**才 rename；
 *   ③ 轮转后**回读校验**：目标存在 且 字节数 == 源文件轮转前字节数。
 *
 * ## 空／缺失的处置（垃圾归档会让"代数"不可信）
 *
 * | 情形 | 动作 |
 * |---|---|
 * | 目录里没有 `LOG.md` | **不轮转**，直接开新代（这一代还没开始，没有可冻结的） |
 * | `LOG.md` 存在但**只有出生头/空** | **不轮转**，原地重用（⛔ 不产生空归档） |
 * | 轮转后 | 新建 `LOG.md` 并写出生头 |
 */

import { existsSync, readFileSync, writeFileSync, renameSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HANDOVER_NOTE_HEADING } from './assistant.js'

/** 日志目录名（相对轨迹目录）。owner 2026-11-04 令：日志家族住 `LOG/`，⛔ 不与 `references/` 混放。 */
export const LOG_DIR = 'LOG'
/** 当前代的固定文件名。**名字即指针** —— 改成 A/B 双槽会引入"谁是当前"这个外部事实。 */
export const LOG_FILE = 'LOG.md'

/** 一句话概括一个轨迹目录的日志状态（诊断用，不参与判定）。 */
export interface CarrierLogState {
  /** `LOG/` 绝对路径 */
  dir: string
  /** 当前代是否存在且非空 */
  hasLive: boolean
  /** 当前代字节数（不存在 = 0） */
  liveBytes: number
  /** 已冻结代数（`LOG-*.md` 个数） */
  frozenCount: number
  /** 最新一代冻结文件名（按名字字典序取最大；无则 null） */
  newestFrozen: string | null
}

/** 冻结日志的命名：`LOG-<YYYY-MM-DDTHHmm>.md`（**本地时区，分钟级**）。 */
export function frozenLogName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `LOG-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}.md`
}

/**
 * 判断一份日志内容是否"实质上为空"。
 *
 * 判据：去掉空行与**标题行**（`# …`）与引用块（`> …`）之后，还剩不剩字符。
 * 🔴 为什么剔除标题与引用：出生头本身就是"标题 ＋ 两行引用说明"，
 *    若按裸字节判非空，**刚开的新代立刻会被判为"有内容可冻结"** ⇒ 产生一堆只有出生头的垃圾归档。
 */
export function isEffectivelyEmpty(text: string): boolean {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    if (t.startsWith('#')) continue
    if (t.startsWith('>')) continue
    return false
  }
  return true
}

/** 列出已冻结的日志文件名（`LOG-*.md`），按名字升序（= 时间升序）。 */
function listFrozen(dir: string): string[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  // 时间戳命名 ⇒ 字典序即时间序（不需要读 mtime，也不需要指针）
  return names.filter((n) => n.startsWith('LOG-') && n.endsWith('.md')).sort()
}

/**
 * 从一份 LOG 正文里抽出 `## Handover note` 整节（含标题，到下一个同级或更高级标题为止）。
 *
 * 🔴 **为什么不抽就轮转 = 交接断开**：轮转把整份 `LOG.md` `mv` 成冻结代，新代是空白的。
 * 若在办状态写在旧代里，新会话读新代 ⇒ **读不到** ⇒ 交接失败，且**没有任何报错**。
 * 这与"便签必须被交接后的会话完整读到"是同一条判据（2026-11-16 owner 裁定）。
 *
 * @returns 该节全文（含标题、去掉尾部空行）；没有该节 ⇒ `null`
 */
export function extractHandoverNote(text: string): string | null {
  const notes = extractAllHandoverNotes(text)
  return notes.length > 0 ? notes[0]! : null
}

/**
 * 抽出**全部** `## Handover note` 节（保持原序）。
 *
 * 🔴🔴 **2026-11-17 真机缺陷（管家报「74 秒连出 7 代，手写交接详节从 gen 6 起整段消失」）**：
 *
 * 旧实现是 `lines.findIndex(...)` —— **只取第一条**。而真实文件里出现过**两个**交接节：
 * 模板短节在前（由上一次轮转搬运而来）、人写详节在后（本轮真正想交代的内容）。
 * ⇒ 搬运只取第一条 ⇒ **人写的那一节被静默丢弃**，而它恰好是**模板没覆盖、只有人写得出来**的增量
 *   （该现场丢的是四条「别重做」＋一条容器级发现）。
 *
 * ⚠️ **为什么当时没有报错**：轮转的 `verified` 只校验**字节数**（rename 搬全了没有），
 *   **从不校验"该搬的搬全了没有"**。⇒ 这是「判据量错了对象」的形态（D252 同族）。
 *
 * ⇒ 判据：**搬运必须取全部，不允许"取第一条就够了"**。多节并存本身合法
 *   （人可能续写、模板可能先占位），所以正确做法是**全搬**，不是"规定只能有一个"。
 */
export function extractAllHandoverNotes(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.trim() !== HANDOVER_NOTE_HEADING) {
      i++
      continue
    }
    const head = i
    // 节止于下一个 `## ` 或更高级标题（`# `/`### ` 之下仍属本节 ⇒ 只有 `## ` 与 `# ` 才算边界）
    let end = lines.length
    for (let j = head + 1; j < lines.length; j++) {
      const t = lines[j]!.trim()
      if (t.startsWith('## ') || t.startsWith('# ')) {
        end = j
        break
      }
    }
    const section = lines.slice(head, end)
    while (section.length > 0 && section[section.length - 1]!.trim() === '') section.pop()
    out.push(section.join('\n'))
    i = end
  }
  return out
}

/** 读一个轨迹目录的日志状态（只读，不改任何东西）。 */
export function readCarrierLogState(trajectoryDir: string): CarrierLogState {
  const dir = join(trajectoryDir, LOG_DIR)
  const live = join(dir, LOG_FILE)
  const hasLiveFile = existsSync(live)
  const liveBytes = hasLiveFile ? statSync(live).size : 0
  const frozen = listFrozen(dir)
  return {
    dir,
    hasLive: hasLiveFile && liveBytes > 0,
    liveBytes,
    frozenCount: frozen.length,
    newestFrozen: frozen.length > 0 ? frozen[frozen.length - 1]! : null,
  }
}

/** 轮转结果（**回执只说明"我做了什么"，不说明"效果达成了"**）。 */
export interface RotateResult {
  /** 是否真的轮转了（false = 判空跳过） */
  rotated: boolean
  /** 冻结成的文件名（未轮转 = null） */
  frozenAs: string | null
  /** 轮转前当前代的字节数（未轮转 = 0） */
  bytesBefore: number
  /** 回读校验是否通过（**只有 rotated=true 时才有意义**） */
  verified: boolean
  /** 若因目标重名而改名，这里是原定的名字 */
  renamedFrom: string | null
}

/**
 * 生成新一代 `LOG.md` 的出生头。
 *
 * ⚠️ **措辞归 CCC**：这里只给一个**可替换的默认模板**，各轨迹可以在自己的 PROMPT.md 里
 *    声明别的写法（ACC 不解析它，只保证"新代存在且非空"）。
 *
 * @param generation 代数（1 起）
 * @param now 出生时刻
 * @param previousFrozen 上一代冻结文件名（无则 null）
 */
export function birthHeader(generation: number, now: Date, previousFrozen: string | null): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`
  return [
    `# LOG — generation ${generation} (born ${stamp})`,
    '',
    previousFrozen === null
      ? '> First generation for this trajectory.'
      : `> Previous generation frozen as: \`${LOG_DIR}/${previousFrozen}\``,
    '> This file holds fine-grained process (how we tried, what broke, what we read).',
    '> High-level abstraction lives in SESSION.md. The boundary is declared in PROMPT.md.',
    '',
  ].join('\n')
}

/**
 * 轮转当前代 → 冻结，并开新代。
 *
 * 🔴 **顺序不可换**（每一步都防一个具体的静默失败）：
 *   ① 判空：实质为空 ⇒ 不轮转（否则产生垃圾归档，代数不可信）
 *   ② 定名：目标已存在 ⇒ 加 `-2`/`-3`…（⛔ 覆盖 = 静默丢一代）
 *   ③ rename **之后**回读校验：字节数必须与轮转前相同
 *   ④ 开新代：新建空文件 → 写出生头
 *
 * @returns 轮转回执。**调用方必须检查 `verified`** —— rename 成功不等于目标对。
 */
export function rotateCarrierLog(trajectoryDir: string, now: Date = new Date()): RotateResult {
  const dir = join(trajectoryDir, LOG_DIR)
  const live = join(dir, LOG_FILE)
  const skipped: RotateResult = { rotated: false, frozenAs: null, bytesBefore: 0, verified: false, renamedFrom: null }

  // ① 判空（缺失 / 实质为空 ⇒ 不轮转，直接保证新代存在）
  if (!existsSync(live)) {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(live)) writeFileSync(live, birthHeader(1, now, null), 'utf-8')
    return skipped
  }
  const text = readFileSync(live, 'utf-8')
  if (isEffectivelyEmpty(text)) return skipped

  mkdirSync(dir, { recursive: true })
  const bytesBefore = Buffer.byteLength(text, 'utf-8')

  // ② 定名（⛔ 永不覆盖）
  const base = frozenLogName(now).replace(/\.md$/, '')
  let target = `${base}.md`
  let renamedFrom: string | null = null
  if (existsSync(join(dir, target))) {
    renamedFrom = target
    let n = 2
    while (existsSync(join(dir, `${base}-${n}.md`))) n++
    target = `${base}-${n}.md`
  }
  const dst = join(dir, target)
  if (existsSync(dst)) {
    // 兜底：走到这里说明上面两个循环都失手了 —— 宁可**不轮转**也不覆盖
    return skipped
  }

  // ③ 原子移（用 rename：同目录内原子；跨设备才不原子，这里必然同目录）
  renameSync(live, dst)

  // 回读校验：目标在，且字节数 == 轮转前
  const verified = existsSync(dst) && statSync(dst).size === bytesBefore

  // ④ 开新代（**并搬运交接便签** —— 这一步是"交接后能读到"的机械保证）
  if (!existsSync(live)) {
    const frozen = listFrozen(dir)
    let header = birthHeader(frozen.length + 1, now, target)
    // 🔴 搬运 **全部** `## Handover note` 节（2026-11-17 修正：旧实现只搬第一条 ⇒ 人写的第二节被静默丢弃）。
    //    顺序不可换：必须在 rename **之后**从冻结代读（轮转前读也一样，但从 dst 读最贴近真相）。
    const notes = extractAllHandoverNotes(readFileSync(dst, 'utf-8'))
    if (notes.length > 0) {
      header += `${notes.join('\n\n')}\n\n`
    }
    writeFileSync(live, header, 'utf-8')
  }

  return { rotated: true, frozenAs: target, bytesBefore, verified, renamedFrom }
}
