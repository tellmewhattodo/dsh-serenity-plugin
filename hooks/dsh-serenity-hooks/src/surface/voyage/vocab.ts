/**
 * surface/voyage/vocab.ts — 航行页词表改为**按当前 CCC 运行时注入**（纯逻辑，零 DSH 依赖）
 *
 * ## 为什么需要它（owner 2026-10-18 报的缺陷）
 * 资产 `assets/serenity-voyage.html` 的词表是**构建期扫描容器写死的常量**：
 *   `var VOCAB = {"skills":[...],"msms":[...],"zh":[...],"onto":[...],"counts":{...}}`
 * v2 改版把"写死名单"改成"构建期扫描"是为防名单漂移——方向对，但代价是：
 * **一份静态资产只能属于一个 CCC**。于是任何别的 CCC 打开动画，看到的都是
 * **构建它的那个 CCC** 的技能/工具/本体名字与计数。owner 原话：
 * 「为什么我在别的 CCC 点开显示的还是我们 home-serenity 的信息」「动画也有这个毛病」。
 *
 * ## 修法（owner 裁决：运行时按当前 CCC 注入）
 * 资产**保持静态**（一份文件服务所有 CCC，永不漂）；由它的**服务端路由**在返回前
 * 把 `var VOCAB = {...};` 那一行替换成从该请求所属 CCC 实况读出的词表。
 *
 * 三条判据（R↓）：
 *  ① **只替换那一行**（锚 = 行首 `var VOCAB = ` 到行尾 `;`）—— 资产里其余 3000+ 行
 *    three.js / 渲染代码**一个字节都不动**。
 *  ② **读不出来就走原样**：锚认不出、或原 VOCAB 解析失败 ⇒ **返回入参本身**，不报错。
 *    航行页是**装饰**，不该因为某个 CCC 缺目录、或资产结构变了就打不开（旁路容忍铁律）。
 *  ③ **`zh` 不来自容器**：中文隐喻词是作品的语汇装饰，属资产自身 ⇒ 注入时**保留原值**。
 *    实现上不"重建"整个对象，而是**在原对象上覆盖**四个实况键 —— 未列出的键自动保留。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 从 CCC 实况读出的词表（只含**会变**的四个键；`zh` 与其它装饰键不在其中） */
export interface VoyageLiveVocab {
  skills: string[]
  msms: string[]
  onto: string[]
  counts: Record<string, number>
}

/** 资产里那一行的锚 —— `var VOCAB = {...};`（`.*?` 非贪婪 + 行尾分号） */
const VOCAB_LINE_RE = /^var VOCAB = (\{.*\});[ \t]*$/m

/**
 * 扫描一个 CCC 的实况词表。**每一项独立容错**：任一来源缺失/读坏 ⇒ 该项为空，其余照常。
 *
 * | 字段 | 来源 | 为什么是它 |
 * |---|---|---|
 * | `skills` | `.opencode/skills/` 下含 `SKILL.md` 的目录名 | 与状态面板同一条判据 |
 * | `msms` | `mech-registry.json` 的注册名 | **MSM 的唯一真相源** |
 * | `onto` | `.opencode/skills/` 下含 `skill.ttl` 的目录名 | 增强型（建模过）的 skill |
 * | `counts` | 上述长度 ＋ 轨迹数 | 计数与词表同源，否则 HUD 与星场对不上 |
 *
 * @param root CCC 根
 */
export function scanVoyageLiveVocab(root: string): VoyageLiveVocab {
  const skills = scanSkillDirs(root, 'SKILL.md')
  const onto = scanSkillDirs(root, 'skill.ttl')
  const msms = scanMsmNames(root)
  return {
    skills,
    msms,
    onto,
    counts: { skill: skills.length, msm: msms.length, onto: onto.length, session: scanTrajectoryCount(root) },
  }
}

/** 技能名：`.opencode/skills/<name>/<marker>` 存在的目录名（marker = `SKILL.md` 或 `skill.ttl`） */
function scanSkillDirs(root: string, marker: string): string[] {
  const dir = join(root, '.opencode', 'skills')
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(dir, e.name, marker)))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * MSM 名：读注册表的**条目名**。
 *
 * 🔴 **为什么不扫 `scripts/`**：注册表是 MSM 的**唯一真相源**；扫目录会把共享库
 * （`dev-kit/`、`lib/*`）也算成 MSM —— 本仓对"入口判据"已翻车多次。
 * ⚠️ 注册表若换了位置 ⇒ **静默降级为空**（装饰页不该因此打不开）。
 *
 * 顶层键 **必须认 `entries`**（v1 包装形），详见下面的实测缺陷注释。
 */
function scanMsmNames(root: string): string[] {
  const candidates = [
    join(root, '.opencode', 'skills', 'home-serenity', 'references', 'mech-registry.json'),
    join(root, '.opencode', 'references', 'mech-registry.json'),
  ]
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as {
        entries?: Array<{ name?: unknown }>
        msms?: Array<{ name?: unknown }>
      }
      // 🔴🔴 2026-11-09 实测缺陷（v1.127.0 真机首读抓到）：这里原本只读 `raw.msms`，
      // 而**真实文件的顶层键是 `entries`**（`{version, description, entries:[…]}`，
      // 见 `tools/msm/service.ts` 的 `parseRegistry`）⇒ `raw.msms` 恒 `undefined`
      // ⇒ `msms` 恒空、`counts.msm` 恒 **0**。
      // 后果不是崩溃，是**图上写了个假数字**：真机蓝图标题栏显示 `SN-42-00` /
      // `42 技能 / 0 工具`，而同一份资产 `file://` 直开（走构建期常量）显示 `SN-38-100`。
      // ⇒ 正是本层最怕的形态：**标注层的每个数字都必须是真的**，而它是 0 也不报错。
      // ⚠️ 同一仓库里**已经犯过一次**（`ontology/engine.ts` 的 `readMechRegistry`，
      // 那里注释写着「顶层键找错 ⇒ entries = raw」）⇒ 抄同一判据，两个键都认。
      const list = Array.isArray(raw.entries) ? raw.entries : Array.isArray(raw.msms) ? raw.msms : []
      const names = list.map((m) => (typeof m?.name === 'string' ? m.name : '')).filter((n) => n !== '')
      if (names.length > 0) return [...new Set(names)].sort()
    } catch {
      /* 坏 JSON / 读不到 ⇒ 试下一个候选，最后空 */
    }
  }
  return []
}

/** 轨迹数：`AGENT_SESSIONS/` 下非 `_` / `.` 前缀的目录（与轨迹层"活跃"判据一致） */
function scanTrajectoryCount(root: string): number {
  const dir = join(root, 'AGENT_SESSIONS')
  try {
    if (!existsSync(dir)) return 0
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('_') && !e.name.startsWith('.'))
      .length
  } catch {
    return 0
  }
}

/**
 * 把实况词表注入资产 HTML。
 *
 * 做法 = **在原 VOCAB 对象上覆盖**四个实况键（不重建整个对象）⇒ `zh` 等装饰键自动保留。
 * 任一环节不成立就**原样返回**（见文件头判据②），因此：
 * @returns 注入后的 HTML；未注入时**与入参逐字节相同**
 */
export function injectVoyageVocab(html: string, live: VoyageLiveVocab | null): string {
  if (live === null) return html
  const m = VOCAB_LINE_RE.exec(html)
  if (!m) return html // 锚认不出 ⇒ 不注入（资产结构变了，静默退化而非报错）
  let base: Record<string, unknown>
  try {
    base = JSON.parse(m[1] as string) as Record<string, unknown>
  } catch {
    return html // 原 VOCAB 不是合法 JSON ⇒ 不动它
  }
  // 覆盖而非重建：未列出的键（zh 等）原样保留
  const merged = {
    ...base,
    skills: live.skills,
    msms: live.msms,
    onto: live.onto,
    counts: { ...(typeof base.counts === 'object' && base.counts !== null ? base.counts : {}), ...live.counts },
  }
  // 用函数式 replace 避免 `$&`/`$1` 之类的替换串语义（payload 里可能有 `$`）
  return html.replace(VOCAB_LINE_RE, () => `var VOCAB = ${JSON.stringify(merged)};`)
}

/** 资产里版本占位符的锚（`<meta name="serenity-acc-version" content="…">`） */
const VERSION_META_RE = /(<meta name="serenity-acc-version" content=")[^"]*(")/

/**
 * 把 ACC 版本号注入资产 HTML（v1.127.0）。
 *
 * 🔴 **为什么版本要注入、而不是让资产自己读**：资产是**静态单文件**，它对
 * `package.json` 一无所知；而蓝图标注层的标题栏要写"这张图是哪一版"。
 * 唯一可信来源 = 服务端进程里的 `ACC_VERSION`（它自己也是从 `package.json` 读的）。
 *
 * 判据与 `injectVoyageVocab` 同一条：**认不出锚就原样返回**，⛔ 不报错
 * （装饰页不该因为资产结构变了一行就打不开）。
 *
 * ⚠️ 与词表注入**互相独立**：词表注入失败不影响版本注入，反之亦然 ——
 * 它们服务两个不同的标注，任一缺失只少了那一条信息。
 *
 * @returns 注入后的 HTML；未命中锚时**与入参逐字节相同**
 */
export function injectVoyageVersion(html: string, version: string): string {
  if (!version) return html
  if (!VERSION_META_RE.test(html)) return html
  return html.replace(VERSION_META_RE, (_all, head: string, tail: string) => `${head}${version}${tail}`)
}
