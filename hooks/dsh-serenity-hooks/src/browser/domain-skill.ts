/**
 * browser/domain-skill.ts —— 浏览器扩展 skill（域名强相关）：加载 ＋ 注入 ＋ 访问台账
 *
 * 设计稿：`AGENT_SESSIONS/…S142…/proposals/browser-domain-skill-design.md`
 * owner 原话（2026-11-23）：「在宁静号根目录设定 BROWSER 目录，内部按域名建立文件夹，
 * 每个文件夹下设 SKILL.md … 我们浏览器工具在打开某个域名的时候自动按目录找到 SKILL.md
 * 并全文注入。」
 *
 * ## 三条设计判据（都是裁过的，⛔ 别在这里重新发明）
 *
 * 1. **注入附着在 `open`/`goto` 的**回执**上**（owner 裁「同意」）——
 *    ⛔ 不新增注入点、⛔ 不唤醒会话。理由：模型刚打开这个站、正要操作它，
 *    时机比任何注入点都准；而新开注入点要回答"它唤醒吗"这一轴。
 *
 * 2. **未命中 ⇒ 回执一字不变**。绝大多数站不会有说明书，给它们留一句
 *    "本站无说明书"是纯噪声（每天几十次那种噪声会把真信号埋掉）。
 *
 * 3. **截断必须可见**。超限时给前 8 KB ＋ 记号 ＋ 完整路径。
 *    静默截断比不注入更坏 —— 读者会以为那就是全部（1.137.15 的教训）。
 *
 * ## 与既有体系的关系（⛔ 不造第二真相源）
 *
 * - `.opencode/skills/` 是**能力**（怎么做一类事）；这里是**单个站点的经验**。平行、不重叠。
 * - `browser/ledger.ts` 是**槽位租约**台账；这里是**域名访问**台账。两个文件、互不引用，
 *   只借它的锁实现（`O_EXCL` ＋ temp→rename），⛔ 不借语义。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeDomain } from './domain.js'

/** 单个 SKILL.md 进注入的体量上限（设计 §4.3）。超出则截断 ＋ 可见记号。 */
export const DOMAIN_SKILL_MAX_BYTES = 8 * 1024

/** 台账文件名（在 `BROWSER/` 下） */
export const VISIT_LEDGER_FILENAME = '_index.json'

/** BROWSER 根目录 */
export function browserRoot(cccRoot: string): string {
  return join(cccRoot, 'BROWSER')
}

/** 某个域名的目录（不可用时返回 null） */
export function domainDir(cccRoot: string, urlOrHost: string): string | null {
  const ref = normalizeDomain(urlOrHost)
  // 已是裸域名（没有 scheme）时，`new URL` 会失败 ⇒ 补一个再归一化，
  // 这样调用方既能传完整 URL 也能传 host（台账键就是 host）。
  const dirName = ref?.dirName ?? normalizeDomain(`https://${urlOrHost}`)?.dirName ?? null
  return dirName ? join(browserRoot(cccRoot), dirName) : null
}

/** SKILL.md 的绝对路径（**不判存在**，只要路径） */
export function domainSkillPath(cccRoot: string, urlOrHost: string): string | null {
  const d = domainDir(cccRoot, urlOrHost)
  return d ? join(d, 'SKILL.md') : null
}

/** 该域名是否已有说明书（**永远现算**，⛔ 不缓存进台账 —— 设计 §5.3） */
export function hasDomainSkill(cccRoot: string, urlOrHost: string): boolean {
  const p = domainSkillPath(cccRoot, urlOrHost)
  return !!p && existsSync(p)
}

// ───────────────────────── 可复用片段（供 eval） ─────────────────────────

/** 单个片段的体量上限（设计 §改动 3：⛔ 防止有人把整个库塞进来，那等于绕过 skill 体系） */
export const SNIPPET_MAX_BYTES = 16 * 1024

/** 片段目录名（站点目录下） */
export const SNIPPET_DIR = 'snippets'

export interface DomainSnippet {
  /** 文件名（含扩展名） */
  name: string
  /** 绝对路径 */
  path: string
  /** 字节数 */
  bytes: number
}

/** 片段目录（站点目录下） */
export function snippetDir(cccRoot: string, urlOrHost: string): string | null {
  const d = domainDir(cccRoot, urlOrHost)
  return d ? join(d, SNIPPET_DIR) : null
}

/**
 * 列出该站可用的片段（**只读目录，不读内容**）。
 *
 * ## 只收 `.js`（owner 2026-11-24 裁「就是供 eval 用的 js 片段」）
 *
 * 🔴 **其它后缀一律不列** —— 不是说"跳过"，是**结构性不认**：
 * 设计稿那条裁决把"操作序列文档"整类删掉了 ⇒ 若这里放行 `.md`／`.txt`，
 * 那类东西会借片段目录复活。
 *
 * ## 超限的不列，并**单独报出来**
 *
 * 一个 200 KB 的片段不该静默消失 —— 那与"我忘了写"在读数上同形。
 * ⇒ 返回 `oversize` 列表，由调用方在回执里点名（⛔ 静默丢）。
 *
 * ⚠️ 排序：按文件名，稳定（⛔ 按 mtime —— 那会让回执在两次调用间变化而无语义）。
 */
export function listSnippets(
  cccRoot: string,
  urlOrHost: string,
): { items: DomainSnippet[]; oversize: DomainSnippet[] } {
  const dir = snippetDir(cccRoot, urlOrHost)
  if (!dir || !existsSync(dir)) return { items: [], oversize: [] }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { items: [], oversize: [] }
  }
  const items: DomainSnippet[] = []
  const oversize: DomainSnippet[] = []
  for (const name of names.sort()) {
    // 只认小写 `.js` 结尾；目录、隐藏文件、其它后缀一律不认
    if (!name.endsWith('.js')) continue
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    let bytes: number
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      bytes = st.size
    } catch {
      continue
    }
    const rec: DomainSnippet = { name, path: p, bytes }
    if (bytes > SNIPPET_MAX_BYTES) oversize.push(rec)
    else items.push(rec)
  }
  return { items, oversize }
}

/** 读一个片段（供参考；**⛔ 本模块不执行它** —— 执行永远走既有的 `eval` 动作） */
export function loadSnippet(cccRoot: string, urlOrHost: string, name: string): string | null {
  const dir = snippetDir(cccRoot, urlOrHost)
  if (!dir) return null
  // 🔴 路径逃逸守卫：只接受**裸文件名**。`--name` 若含 `/`、`\` 或 `..` 一律拒 ——
  //    否则 `../../localstore.json` 就能借"读片段"读任意文件。
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  if (!name.endsWith('.js')) return null
  const p = join(dir, name)
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size > SNIPPET_MAX_BYTES) return null
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export interface DomainSkillHit {
  /** 要追加到回执里的整段文本（含抬头与可能的截断记号） */
  text: string
  /** SKILL.md 的绝对路径（给用户看"完整内容在哪"） */
  path: string
  truncated: boolean
}

/**
 * 读该域名的说明书；未命中 ⇒ `null`（调用方**原样返回**回执，⛔ 不加任何噪声）。
 *
 * 读失败（权限、半写状态）也返回 `null` —— 打开页面的主流程**不因说明书而失败**。
 */
export function loadDomainSkill(cccRoot: string, urlOrHost: string): DomainSkillHit | null {
  const p = domainSkillPath(cccRoot, urlOrHost)
  if (!p) return null
  let raw: string
  try {
    if (!existsSync(p)) return null
    raw = readFileSync(p, 'utf8')
  } catch {
    return null
  }
  // 按**字节**判体量（设计写的是 8 KB），但裁在字符边界上避免把多字节字符切坏。
  const truncated = Buffer.byteLength(raw, 'utf8') > DOMAIN_SKILL_MAX_BYTES
  let body = raw
  if (truncated) {
    body = raw.slice(0, DOMAIN_SKILL_MAX_BYTES)
    // ⚠️ 记号必须含「完整内容在哪」—— 否则读者只知道"被截了"却不知道去哪看
    body +=
      `\n\n──── ⚠️ 说明书已截断（只显示前 ${DOMAIN_SKILL_MAX_BYTES} 字节）────\n` +
      `完整内容：${p}\n` +
      `⛔ 不要以为上面就是全部 —— 缺的那部分可能正是你要找的坑。\n`
  }
  const head = `\n\n──── 本站说明书（BROWSER/${normalizeDomain(urlOrHost)?.dirName ?? urlOrHost}/SKILL.md）────\n`
  return { text: head + body, path: p, truncated }
}

/**
 * 片段的注入尾巴（设计 §改动 3）—— **只列清单，⛔ 不注入内容、⛔ 不执行**。
 *
 * ## 为什么只给清单而不给内容
 *
 * owner 裁决原话：「就是供 eval 用的 js 片段」。片段的价值是**可复用的认知**
 * （下次不用重新摸索选择器），而它的用法是：模型读了说明书 → 看到这里有几支片段 →
 * **自己决定**要不要 `eval` 其中一支。
 *
 * 🔴 若把内容也注进去，回执体量会失控（一支片段可达 16 KB），
 * 而且**等于替它做了"要不要用"的决定** —— 那不该由注入层替它做。
 *
 * ## 为什么超限的要单独点名
 *
 * 一支 200 KB 的片段若静默消失，与「我忘了写」在读数上同形。
 * ⇒ 明确告诉它"有这么个文件，但它太大没被采用"，并给路径。
 *
 * @returns 追加文本；无片段 ⇒ **空串**（未命中零噪声，与说明书同一口径）
 */
export function snippetTail(cccRoot: string, urlOrHost: string): string {
  try {
    const { items, oversize } = listSnippets(cccRoot, urlOrHost)
    if (items.length === 0 && oversize.length === 0) return ''
    const lines: string[] = [`\n──── 本站可用片段（snippets/，供 eval 用）────`]
    for (const it of items) {
      lines.push(`  · ${it.name}　${(it.bytes / 1024).toFixed(1)} KB　→ ${it.path}`)
    }
    for (const it of oversize) {
      lines.push(
        `  ⚠️ ${it.name}　${(it.bytes / 1024).toFixed(0)} KB —— 超过 ${SNIPPET_MAX_BYTES / 1024} KB 上限，**未采用**（⛔ 不是不存在）`,
      )
    }
    lines.push(
      `  用法：读一份说明书里对它的说明，再自己决定要不要 \`browser_slot eval --js "<片段内容>"\`。\n` +
        `  ⛔ 片段**不会自动执行** —— 它只是文本。`,
    )
    return lines.join('\n') + '\n'
  } catch {
    return ''
  }
}

// ───────────────────────────── 访问台账 ─────────────────────────────

export interface DomainVisit {
  /** 累计打开次数 */
  opens: number
  /** 最后一次打开时刻（ms） */
  lastAt: number
  /** 最后一次来自哪条会话（回答"谁在用这个站"） */
  lastSession: string
  /** 最后一次用的哪个槽位 */
  lastSlot: number
}

export interface VisitLedger {
  version: number
  domains: Record<string, DomainVisit>
  updatedAt: number
}

export function visitLedgerPath(cccRoot: string): string {
  return join(browserRoot(cccRoot), VISIT_LEDGER_FILENAME)
}

function readVisitLedger(cccRoot: string): VisitLedger {
  const empty: VisitLedger = { version: 1, domains: {}, updatedAt: 0 }
  try {
    const raw = JSON.parse(readFileSync(visitLedgerPath(cccRoot), 'utf8')) as Partial<VisitLedger>
    const domains: Record<string, DomainVisit> = {}
    for (const [k, v] of Object.entries(raw?.domains ?? {})) {
      const d = v as Partial<DomainVisit>
      // 坏条目逐条剔除（与 ledger.ts 同口径）——⛔ 不让一条坏记录带走整份台账
      if (typeof k !== 'string' || !k) continue
      domains[k] = {
        opens: Number(d?.opens) || 0,
        lastAt: Number(d?.lastAt) || 0,
        lastSession: typeof d?.lastSession === 'string' ? d.lastSession : '',
        lastSlot: Number(d?.lastSlot) || 0,
      }
    }
    return { version: Number(raw?.version) || 1, domains, updatedAt: Number(raw?.updatedAt) || 0 }
  } catch {
    return empty
  }
}

function writeVisitLedger(cccRoot: string, ledger: VisitLedger): void {
  const p = visitLedgerPath(cccRoot)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify({ ...ledger, updatedAt: Date.now() }, null, 2), 'utf8')
  renameSync(tmp, p)
}

/**
 * 在锁内做「读 → 改 → 写」。
 *
 * 🔴 为什么连锁的实现也要抄 `ledger.ts` 那套而不另造：本机 13+ 个 live 会话会**并发**打开页面，
 *    整文件读改写会**静默丢键**（`localstore.json` 已为这个病付过代价）。
 *    ⚠️ 但这是**另一个文件、另一把锁**（`_index.json.lock`）——⛔ 不与槽位台账共用锁，
 *    否则一次域名记账会阻塞整个槽位系统。
 */
function withVisitLedger<T>(cccRoot: string, update: (l: VisitLedger) => T): T {
  const p = visitLedgerPath(cccRoot)
  mkdirSync(dirname(p), { recursive: true })
  const lock = p + '.lock'
  const deadline = Date.now() + 3000
  let acquired = false
  while (Date.now() < deadline) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      acquired = true
      break
    } catch {
      // 持锁者崩溃的回收：锁 mtime 过老即视为废弃
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true })
      } catch {
        /* 锁已被别人清掉 */
      }
      const until = Date.now() + 20
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  // ⚠️ 拿不到锁就**放弃记账**，⛔ 不抛错：打不开台账不该让"打开网页"失败。
  if (!acquired) return undefined as unknown as T
  try {
    const cur = readVisitLedger(cccRoot)
    const result = update(cur)
    writeVisitLedger(cccRoot, cur)
    return result
  } finally {
    rmSync(lock, { force: true })
  }
}

/**
 * 记一次访问（`open`/`goto` 当场调用）。
 *
 * 🔴 **必须在打开页面时就记，⛔ 不能等 release**：
 *    释放会销毁进程、删 identity、清采样缓存 —— "用过哪些站"那一刻就没了。
 *
 * 任何异常都吞掉：记账是**旁路**，⛔ 不许让打开页面失败。
 */
export function recordVisit(cccRoot: string, url: string, sessionId: string, slot: number): void {
  const ref = normalizeDomain(url)
  if (!ref) return
  try {
    withVisitLedger(cccRoot, (lg) => {
      const prev = lg.domains[ref.host]
      lg.domains[ref.host] = {
        opens: (prev?.opens ?? 0) + 1,
        lastAt: Date.now(),
        lastSession: sessionId || prev?.lastSession || '',
        lastSlot: slot || prev?.lastSlot || 0,
      }
    })
  } catch {
    /* 记账失败不影响打开 */
  }
}

/** 读整份访问台账（给 `diag`／`list` 与释放提示用） */
export function readVisits(cccRoot: string): VisitLedger {
  return readVisitLedger(cccRoot)
}

/**
 * 释放成功后的「写说明书」提示（设计 §5.4，owner 裁「跨会话累计」）。
 *
 * ## 为什么只有这一条通道
 *
 * owner 的触发点裁决是**浏览器主动释放**（⛔ 不是 ACC 发版、⛔ 不是定时器）：
 * 释放本来就是工作的自然终点，且 `releaseSlot()` 天然拿得到"谁用了哪个槽"。
 *
 * ## 降噪硬判据（照本仓既有教训，⛔ 每条都有代价）
 *
 * - **只在真的释放成功时**调用本函数（`released === true`）；"本就无人占用"不提示 ——
 *   什么都没发生，提示它等于凭空催人写文档。
 * - **单次最多列 3 个**（按 opens 降序），其余折叠成一句"另有 N 个"。
 *   ⛔ 不列全：一次列出 10 个站，模型只会看一眼就跳过，等于没提示。
 * - **必须带确切路径** —— ⛔ "你可以写一份"这种无法执行的话。
 * - **每个站必须写清"用过几次"** —— 那是它值不值得写的唯一依据。
 *
 * @returns 追加到 release 回执后的文本；无值得提示的站 ⇒ 空串（回执保持原样）
 */
export function domainSkillPrompt(cccRoot: string): string {
  try {
    const ledger = readVisitLedger(cccRoot)
    const entries = Object.entries(ledger.domains)
    // 只提示**还没有说明书**的站：已有说明书的站不需要再被催（owner 要的是"补上缺的"）
    const missing = entries.filter(([host]) => !hasDomainSkill(cccRoot, host))
    if (missing.length === 0) return ''

    // 按 opens 降序（用得最多的最值得写）；同次数按最近使用
    missing.sort((a, b) => b[1].opens - a[1].opens || b[1].lastAt - a[1].lastAt)
    const shown = missing.slice(0, 3)
    const rest = missing.length - shown.length

    const lines = shown.map(([host, v]) => {
      const p = domainSkillPath(cccRoot, host)
      return `  · ${host}　${v.opens} open(s)　⛔ no notes yet\n      → ${p}`
    })
    if (rest > 0) lines.push(`  · 另有 ${rest} 个站用过但没有说明书（这张表在 BROWSER/_index.json）`)

    return (
      `\n──── BROWSER 域名台账（有站还没写说明书）────\n` +
      lines.join('\n') +
      `\n\n想让下次省一轮摸索，就把这次的经验按四段写进去：\n` +
      `  这站的特殊之处 ／ 已知坑 ／ 有效操作序列 ／ 失效记录\n` +
      `⚠️ 每条坑都要写「怎么发现的」—— 只有"有效操作"不成，后人重建不出来。\n`
    )
  } catch {
    // 🔴 拼提示失败绝不许影响释放（设计判据 7）
    return ''
  }
}

