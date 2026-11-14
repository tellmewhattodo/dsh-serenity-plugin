/**
 * resource-index.ts — **两层披露树的第二层**：skill 参考件索引（纯逻辑，零 DSH 依赖）
 *
 * 设计真相源：`docs/serenity-skill-design.md` §4.2（六条硬性规则）＋ §5.1（目录布局）。
 * 一句话：**把 skill 的参考件"有什么"告诉模型，但不把"是什么"塞进去** ——
 * 正文留给第三层（模型按需 `read`）。
 *
 * 为什么由我们生成（R↓，读宿主取证）：宿主 `@deepseek-ai/dsh-skill` 的 `renderSkillContent()`
 * （`lib/index.js` L57-81）**已经**产出 `<skill_resources>` 块，并逐字写着
 * "Load referenced resources only as needed." ⇒ **两层模型是宿主自己给的**；而
 * `SkillSummary` / `SkillDefinition` **没有任何列举子文件的位**（只有 `resourceBase` 一个基址）
 * ⇒ 宿主刻意留给 provider 的正是**这一半：枚举**。
 *
 * 六条硬性规则（逐条对应设计 §4.2，改这里先改那里）：
 *   ① **只枚举，不注入正文** —— 索引里**绝不**出现任何参考文件的正文；
 *   ② **确定性排序** = 相对路径的 **UTF-8 字节序**（🔴 **不用 mtime**：mtime 随检出漂移，
 *      会让每请求的注入文本抖动；对照 `src/cro/core.ts:101` 那份**落盘快照**用 {name,bytes,mtime} ——
 *      **同一件事两处的取舍相反，那个差异是判据不是巧合**）；
 *   ③ **有界 ＋ 响亮** —— 条数/字符各有上限，超出**必须显式写出还剩多少项**，**绝不静默截断**；
 *   ④ **摘要可复现** —— 取该文件首个 `#` 标题（剥 markdown 记号）；取不到 ⇒ 留空，**不编**；
 *   ⑤ **本体文件特殊标注** —— `skill.ttl` 存在 ⇒ 该行标 🧬 ＋ 顶部加一句"已建模"；
 *   ⑥ **范围 = `references/` 一级条目 ＋ `skill.ttl`** —— 子目录**给名字 ＋ 计数、不展开、不读正文**
 *      （🆕 2026-10-11 由**真实输入**逼出的修订：原写"不进子目录"，实测 `references/` 下确实有内容目录，
 *      只报"有 N 个子目录"不给名字 = **不可行动**；折中仍在裁决 Q2「只披露名字、不注入正文」的意图内）。
 *
 * 🔴 本文件**只认 `<skillDir>/skill.ttl`**（owner 裁决 Q6：静默、只认固定名）。
 *    `references/*-domain.ttl`（旧名）一律当**普通参考件**：不特殊对待、不告警 —— 那 14 份由 CCC 自行改名。
 * 🔴 「未建模」不是异常（裁决 Q6 ／ 判据 J9）：无 `skill.ttl` 的**普通 skill** 照常产出索引，
 *    **零告警、零误差** —— 增强必须对普通 skill 完全向后兼容。
 *
 * 🔴 **两个面，两个入口**（2026-10-12 增；owner 裁决 O2）—— 同源、但成本形态不同：
 *    · **载入面** `buildResourceIndex()` —— 完整索引（名字 ＋ 首标题 ＋ 字节），带 `.md` 文件头读取；
 *      在三条路径上各附一次：入口段（`system-prompt.ts` order −50）／轨迹段（`trajectory/skills.ts`
 *      order −45）／目录 provider 的 `get()`（`opencode-skills.ts`）。
 *    · **目录面** `buildResourceNameSuffix()` —— **只有名字**，**不读任何正文**；只挂一处：
 *      目录 provider 的 `list()`（`available_skills` 的 `SkillSummary.description`）。
 *      🔴 为什么目录面在这里：`SkillSummary` 契约里**没有列资源的位**（只有 name/description/whenToUse）
 *      ⇒ `description` 是唯一位置，且必须**自动生成**。
 *    ⇒ 两个面**共用** `collectEntries()`（范围 = 规则⑥只写一遍）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

/** 第二层占位口：本 skill 的本体约束文件（固定名，设计 §5.1） */
export const SKILL_ONTOLOGY_FILE = 'skill.ttl'

/** 参考件根（一级；不进子目录） */
export const REFERENCE_DIR = 'references'

/** 条数上限（超出 ⇒ 写"还有 N 项未列出"） */
export const RESOURCE_INDEX_MAX_ITEMS = 40

/** 字符上限（超出 ⇒ 尾部响亮标记；宿主侧另有更外层的预算） */
export const RESOURCE_INDEX_MAX_CHARS = 4 * 1024

/** 摘要长度上限（防单行超长标题把表格撑坏） */
const EXCERPT_MAX_CHARS = 60

/** 读文件头部字节数上限：摘标题只值读这么些（不为一行标题读整个大文件） */
const HEAD_BYTES = 4 * 1024

export interface ResourceIndexOptions {
  maxItems?: number
  maxChars?: number
}

interface ResourceItem {
  /** 相对 skill 目录的路径（如 `references/00-x.md` ／ `skill.ttl`）—— 模型据此 `read` */
  rel: string
  kind: 'file' | 'dir'
  /** 文件字节；目录 = 其下文件的总字节 */
  bytes: number
  /** 首个 `#` 标题（仅 `.md` 尝试；取不到 ⇒ ''）；目录 ⇒ 摘要写"子目录 · N 个文件" */
  excerpt: string
  /** 本体文件（固定名命中） */
  ontology: boolean
  /** 排序键：相对路径的 UTF-8 字节 */
  key: Buffer
}

/** 目录计数上限：防病态大树把一次注入拖慢（超出 ⇒ 报 `≥N`，仍然响亮） */
const DIR_SCAN_MAX_FILES = 1000

/**
 * 递归统计目录下的文件数与总字节（**只统计，不读内容**）。
 * 为什么递归：设计原写"不进子目录"，而**真实输入**显示 `references/` 下确有内容目录
 * （`home-rhetoric/references/corpus-subject-own`／`family-profiles/references/baby-handlebook`／
 * `home-serenity/references/diagram-lab`）⇒ 只报"有 N 个子目录"而**不给名字**是不可行动的。
 * 折中：**给名字 ＋ 计数，仍不展开、仍不读正文**（= 裁决 Q2「只披露名字、不注入正文」的意图内）。
 */
function scanDirStats(dir: string): { files: number; bytes: number; capped: boolean } {
  let files = 0
  let bytes = 0
  let capped = false
  const walk = (d: string): void => {
    if (capped || files >= DIR_SCAN_MAX_FILES) {
      capped = true
      return
    }
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (files >= DIR_SCAN_MAX_FILES) {
        capped = true
        return
      }
      const abs = join(d, name)
      let isDir = false
      let size = 0
      try {
        const st = statSync(abs)
        isDir = st.isDirectory()
        size = st.size
      } catch {
        continue
      }
      if (isDir) walk(abs)
      else {
        files++
        bytes += size
      }
    }
  }
  walk(dir)
  return { files, bytes, capped }
}

/** 按 UTF-8 **字节序**比较两个相对路径（规则②；不是 locale 比较、不是 mtime）。
 *  参数放宽到 `{ key }`：**未加水**的条目与**已加水**的条目共用同一个比较器 ⇒ 排序规则只写一遍。 */
function byByteOrder(a: { key: Buffer }, b: { key: Buffer }): number {
  return Buffer.compare(a.key, b.key)
}

/**
 * 千分位分组（规则②的延伸：**不依赖 locale**）。
 * 为什么不用 `toLocaleString()`：它随宿主 locale 变 ⇒ 同一目录在不同机器上产出**不同的注入文本**
 * （本仓已有一条「locale 稳健性」的挂账，不再添一处）。
 */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 取 markdown 首个 `#` 标题作摘要（规则④）。
 *
 * 细节（都由"可复现"推导）：
 *   · **跳过 YAML frontmatter**（`---` 开头到下一 `---`）—— 否则题名行会被当成正文标题；
 *   · 只读文件**头部** `HEAD_BYTES`（一行标题不值得读整个大文件）；
 *   · 剥掉行内记号（`*` `` ` `` `_` `#`）与首尾空白，压平内部连续空白；
 *   · 取不到 ⇒ `''`（**留空，不编** —— 编一个摘要等于让索引说假话）；
 *   · 超长截断时**留省略号**（与规则③同一精神：截断要看得见）。
 */
export function firstHeading(file: string): string {
  let head: string
  try {
    head = readFileSync(file, 'utf-8').slice(0, HEAD_BYTES)
  } catch {
    return ''
  }
  const lines = head.split(/\r?\n/)
  let start = 0
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        start = i + 1
        break
      }
    }
  }
  for (let i = start; i < lines.length; i++) {
    const m = /^#{1,6}\s+(.*)$/.exec(lines[i] ?? '')
    if (!m) continue
    const clean = (m[1] ?? '')
      .replace(/[*`_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean === '') continue
    return clean.length > EXCERPT_MAX_CHARS ? `${clean.slice(0, EXCERPT_MAX_CHARS - 1)}…` : clean
  }
  return ''
}

/** 第二层的一个**条目**（未"加水"：字节与摘要都要读盘，故分开 —— 见 `collectEntries`） */
interface ResourceEntry {
  /** 相对 skill 目录的路径（如 `references/00-x.md` ／ `skill.ttl`） */
  rel: string
  kind: 'file' | 'dir'
  /** 绝对路径（给"加水"阶段用；**名字清单不碰它**） */
  abs: string
  /** 本体文件（固定名命中） */
  ontology: boolean
  /** 排序键：相对路径的 UTF-8 字节 */
  key: Buffer
}

/**
 * 收集第二层的**条目**（范围 = 规则⑥：`references/` 一级条目 ＋ 固定名本体）。
 *
 * 🔴 **只做 `readdir` / `stat`，不读任何文件正文** —— 两个消费者（第二层索引 ／ 目录面的名字清单）
 *    **共用这一份范围定义**：规则⑥只该有一个家，各写一遍必然漂移。
 * 🔴 返回已按**字节序**排好（规则②：确定性，不用 mtime）。
 */
function collectEntries(skillDir: string): ResourceEntry[] {
  const entries: ResourceEntry[] = []

  const refDir = join(skillDir, REFERENCE_DIR)
  if (existsSync(refDir)) {
    let names: string[] = []
    try {
      names = readdirSync(refDir).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      const abs = join(refDir, name)
      let isDir = false
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        continue
      }
      const rel = `${REFERENCE_DIR}/${name}`
      entries.push({ rel, kind: isDir ? 'dir' : 'file', abs, ontology: false, key: Buffer.from(rel, 'utf-8') })
    }
  }

  const ontoAbs = join(skillDir, SKILL_ONTOLOGY_FILE)
  if (existsSync(ontoAbs)) {
    entries.push({
      rel: SKILL_ONTOLOGY_FILE,
      kind: 'file',
      abs: ontoAbs,
      ontology: true,
      key: Buffer.from(SKILL_ONTOLOGY_FILE, 'utf-8'),
    })
  }

  entries.sort(byByteOrder)
  return entries
}

/**
 * 给条目**加水**（字节 ＋ 摘要）—— 这两项都要读盘，因此与"有哪些条目"分开。
 * 读不到 ⇒ `null`（宁可少列，也不列出读不到的项）。
 */
function hydrate(entry: ResourceEntry): ResourceItem | null {
  if (entry.kind === 'dir') {
    // 子目录：**给名字 ＋ 计数，不展开内容**（见 scanDirStats 的理由）
    const { files, bytes, capped } = scanDirStats(entry.abs)
    return {
      rel: entry.rel,
      kind: 'dir',
      bytes,
      excerpt: `subdirectory · ${capped ? `≥${groupThousands(files)}` : groupThousands(files)} file(s)`,
      ontology: false,
      key: entry.key,
    }
  }
  let bytes: number
  try {
    bytes = statSync(entry.abs).size
  } catch {
    return null
  }
  return {
    rel: entry.rel,
    kind: 'file',
    bytes,
    excerpt: entry.rel.endsWith('.md') ? firstHeading(entry.abs) : '',
    ontology: entry.ontology,
    key: entry.key,
  }
}

/** 收集候选（`references/` 一级条目 ＋ 固定名本体），加好水并按字节序排好 */
function collectItems(skillDir: string): ResourceItem[] {
  const items: ResourceItem[] = []
  for (const entry of collectEntries(skillDir)) {
    const item = hydrate(entry)
    if (item !== null) items.push(item)
  }
  return items
}

/** 该 skill 是否已建模（只有固定名算 —— 裁决 Q6） */
export function hasSkillOntology(skillDir: string): boolean {
  return existsSync(join(skillDir, SKILL_ONTOLOGY_FILE))
}

/**
 * 生成第二层索引正文。
 *
 * @param skillDir skill 目录绝对路径
 * @param options 上限覆盖（缺省用本模块常量）
 * @returns 索引正文；**无可列项 ⇒ `''`**（规则⑥的一般化：`references/` 与 `skill.ttl` 都没有
 *          ⇒ 整块不产出 —— 空标题是噪声）。调用方按"空串不产出该块"处理。
 */
export function buildResourceIndex(skillDir: string, options: ResourceIndexOptions = {}): string {
  const maxItems = options.maxItems ?? RESOURCE_INDEX_MAX_ITEMS
  const maxChars = options.maxChars ?? RESOURCE_INDEX_MAX_CHARS

  const items = collectItems(skillDir)
  if (items.length === 0) return ''

  const modeled = items.some((i) => i.ontology)
  const shown = items.slice(0, maxItems)
  const hidden = items.length - shown.length

  const lines: string[] = [
    '### Reference files for this skill (second layer — read on demand)',
    '> Listing only, no bodies: `read` a path below (relative to this skill directory) when you need it.',
  ]
  if (modeled) lines.push('> 🧬 **This skill is modeled**: the wording is governed by `skill.ttl`.')
  lines.push('', '| File | Summary | Bytes |', '|---|---|---|')
  for (const item of shown) {
    const label = item.kind === 'dir' ? `${item.rel}/` : item.rel
    const excerpt = item.ontology ? '🧬 This skill\'s ontology constraints (modeled)' : item.excerpt
    lines.push(`| ${label} | ${excerpt} | ${groupThousands(item.bytes)} |`)
  }
  if (hidden > 0) {
    // 规则③：**响亮** —— 必须说清还剩多少项，绝不静默截断
    lines.push('', `…**${hidden} more item(s) not listed** (this layer's per-call cap is ${maxItems}).`)
  }

  const body = lines.join('\n')
  if (body.length <= maxChars) return body
  // 字符上限：**照样响亮**（截断可见，且不改排序/条目内容）
  return `${body.slice(0, maxChars)}\n…(second-layer index truncated at the ${groupThousands(maxChars)}-character cap; full text is ${groupThousands(body.length)} characters)`
}

/** 目录面（`SkillSummary.description`）用的名字清单 —— **只有名字**，无摘要、无字节 */
export interface ResourceNameList {
  /** 条目的**基名**（目录带尾 `/`；本体文件就是 `skill.ttl`），按字节序 */
  names: string[]
  /** 因条数上限**没列出**的条数（`> 0` ⇒ 调用方必须**响亮**写出，规则③） */
  hidden: number
}

/**
 * 收集**只有名字**的第二层清单（目录面专用）。
 *
 * 为什么单独一个入口（而不是复用 `buildResourceIndex`）：**成本形态不同** ——
 * 索引要给每个 `.md` 读文件头取摘要（规则④），而目录面是**每请求 × 每个 skill** 都要算的
 * ⇒ 这条路径**一个字节正文都不读**（只 `readdir`/`stat`）。
 * 范围仍与索引**同源**（共用 `collectEntries` ⇒ 规则⑥只有一个家）。
 */
export function buildResourceNames(skillDir: string, options: ResourceIndexOptions = {}): ResourceNameList {
  const maxItems = options.maxItems ?? RESOURCE_INDEX_MAX_ITEMS
  const entries = collectEntries(skillDir)
  const shown = entries.slice(0, maxItems)
  return {
    names: shown.map((e) => (e.kind === 'dir' ? `${basename(e.rel)}/` : basename(e.rel))),
    hidden: entries.length - shown.length,
  }
}

/**
 * 目录面后缀：把名字清单拼成**可直接接在 `description` 后面**的一段文本。
 *
 * 🔴 **自动生成，绝不手写**（手写必与文件树漂）；无可列项 ⇒ `''`（**普通 skill 零噪声** —— 判据 J9）。
 * 🔴 **有界 ＋ 响亮**（规则③）：超上限时写出"另有 N 项"，**绝不静默截断**。
 */
export function buildResourceNameSuffix(skillDir: string, options: ResourceIndexOptions = {}): string {
  const { names, hidden } = buildResourceNames(skillDir, options)
  if (names.length === 0) return ''
  const tail = hidden > 0 ? ` …另有 ${hidden} 项` : ''
  return `（参考件：${names.join(' / ')}${tail}）`
}
