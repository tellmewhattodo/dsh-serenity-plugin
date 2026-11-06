/**
 * kernel/invariant.ts — 包级不变量伴生（dsh-my-rsi creating-a-plugin 规范）
 *
 * 检查：dsh.plugin.json 的 contributes.tools 与代码实际注册的工具一致。
 * 挂载时 plugin-local 会校验清单；本不变量让仓库内 `verify-package-invariants`
 * 类门禁也可直接调用。
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

interface PluginManifest {
  id: string
  version?: string
  main?: string
  description?: string
  engines?: { dsh?: string }
  contributes?: { tools?: string[]; skills?: string[] }
}

/** 读取插件清单；缺失/非法返回 null */
function readPluginManifest(manifestPath: string): PluginManifest | null {
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
  } catch {
    return null
  }
}

/**
 * 校验清单声明的工具与代码注册的工具一致。
 * 返回不一致项列表（空 = 通过）。
 */
export function verifyToolConsistency(manifestPath: string, registeredTools: readonly string[]): string[] {
  const manifest = readPluginManifest(manifestPath)
  if (!manifest) return [`manifest not found or invalid: ${manifestPath}`]
  const declared = manifest.contributes?.tools ?? []
  const missing = declared.filter((t) => !registeredTools.includes(t))
  const undeclared = registeredTools.filter((t) => !declared.includes(t))
  const issues: string[] = []
  if (missing.length) issues.push(`manifest declares tools not registered: ${missing.join(', ')}`)
  if (undeclared.length) issues.push(`registered tools not declared in manifest: ${undeclared.join(', ')}`)
  return issues
}

/**
 * 把「声明面散文」钉成可判（v1.56.2，2026-10-12）。
 *
 * 🔴 **为什么需要它**：同一形状的漏改本仓已经犯过**三次** ——
 *  - v1.31.0 加 `im-bridge`：两个包的 `description` 仍写「10 个工具」且不含它；
 *  - v1.52.0 加 `ontology`：`package.json` 的 description 仍写「12 个工具」、`dsh.plugin.json`
 *    的收尾用**位置指代**（"后三个按条件出现"）而被追加项**当场改指**、`README.md` 缺行；
 *  - **v1.54.0 加 `serenity-skill-creator`**：`package.json` 的 description 仍写「13 个工具」
 *    （且清单里没有它）、**两份 `README.md` 的 §3.1 标题**仍写「十二个工具」。
 * v1.52.1 当时写下的判据是「后三处只能靠纪律」—— **本版起改为机械钉**：纪律已被三次证伪。
 *
 * 被判的三处（都是**装包的人最先看到的**，也都没有别的钉子）：
 *  ① `contributes.tools.length === REGISTERED_TOOLS.length`；
 *  ② **两份** `description` 都含正确的**总数**（`N 个工具`）—— 防"数错"；
 *  ③ **两份** `description` 都含**每一个**工具名 —— 防"数对了、名单漏了"（v1.54.0 的形态）。
 * ⚠️ 判据刻意**不要求**工具名出现在特定的逗号分隔段里（散文的排布是人的事，一钉就碎）；
 *    「后三个按条件出现」这句话由 `CONDITIONAL_TOOL_COUNT` ＋ **顺序约定**保证**永远为真**
 *    （见 `REGISTERED_TOOLS` 的注释），**不需要**逐句解析。
 *
 * @param manifestPath dsh.plugin.json 路径
 * @param readmePaths   需要一并被判的 README 路径（仓库根 ＋ 包内两份；缺文件即报）
 */
export function assertManifestProse(
  manifestPath: string,
  readmePaths: readonly string[],
): string[] {
  const manifest = readPluginManifest(manifestPath)
  if (!manifest) return [`manifest not found or invalid: ${manifestPath}`]
  const tools = manifest.contributes?.tools ?? []
  const n = tools.length
  const issues: string[] = []

  if (n !== REGISTERED_TOOLS.length) {
    issues.push(
      `contributes.tools 有 ${n} 项，而 REGISTERED_TOOLS 有 ${REGISTERED_TOOLS.length} 项（两侧必须同长）`,
    )
  }

  // ① 包内 package.json 的 description（⚠️ 与 dsh.plugin.json **同目录**，不是上一级 ——
  //    `resolve(manifestPath, '..', '..')` 会指到 `hooks/`，正控当场抓到过这个错）
  const pkgPath = resolve(dirname(manifestPath), 'package.json')
  const surfaces: { where: string; text: string }[] = []
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { description?: string }
      surfaces.push({ where: 'package.json description', text: pkg.description ?? '' })
    } catch {
      issues.push(`package.json 无法解析：${pkgPath}`)
    }
  } else {
    issues.push(`package.json 不存在：${pkgPath}`)
  }
  surfaces.push({ where: 'dsh.plugin.json description', text: manifest.description ?? '' })

  for (const s of surfaces) {
    if (!s.text.includes(`${n} 个工具`)) {
      issues.push(`${s.where} 未声明工具总数「${n} 个工具」（防"数错"）`)
    }
    const absent = tools.filter((t) => !s.text.includes(t))
    if (absent.length) {
      issues.push(`${s.where} 的名单缺 ${absent.length} 项：${absent.join(', ')}（防"数对了、名单漏了"）`)
    }
  }

  // ② 两份 README 的 §3.1 标题（防"表体更新了、标题里的数字没更新"）
  const countCn = cnNumberOf(n)
  // 🔴 条件数也用同一套中文数字（此前 README 标题里的"两个"是**写死**的 ⇒ 条件数一变就漏）。
  //    ⚠️ 必须经函数调用而不是就地三元 —— `CONDITIONAL_TOOL_COUNT` 是**字面量类型**（`3`），
  //    就地判 `<= 10` 之后 TS 会把后续分支缩窄成 `never`，于是 `=== 20` 报"无重叠"（不是逻辑错，是窄化）。
  const condCn = cnNumberOf(CONDITIONAL_TOOL_COUNT)
  for (const p of readmePaths) {
    if (!existsSync(p)) {
      issues.push(`README 不存在：${p}`)
      continue
    }
    const text = readFileSync(p, 'utf-8')
    const m = text.match(/^###\s*3\.1\s*(\S+?)个工具(?:（其中(\S+?)个按条件出现）)?/m)
    if (!m) {
      issues.push(`${p} 里找不到 §3.1 的「…个工具」标题（形态已变 ⇒ 钉子也要跟着改）`)
      continue
    }
    if (m[1] !== countCn) {
      issues.push(`${p} 的 §3.1 标题写「${m[1]}个工具」，应为「${countCn}个工具」（工具数已 ${n}）`)
    }
    // 🔴 「其中 N 个按条件出现」也要判：那个数字一变，标题照样在撒谎，而旧钉子只看总数。
    if (m[2] !== undefined && m[2] !== condCn) {
      issues.push(`${p} 的 §3.1 标题写「其中${m[2]}个按条件出现」，应为「其中${condCn}个按条件出现」（条件工具数已 ${CONDITIONAL_TOOL_COUNT}）`)
    }
  }
  return issues
}

/**
 * 阿拉伯数字 → 中文数字（README §3.1 标题用；只覆盖到 29，够 README 用）。
 *
 * 🔴 抽成函数是**必须**的，不是洁癖：`CONDITIONAL_TOOL_COUNT` 是**字面量类型**，
 * 就地写三元时 TS 会在第一个分支之后把类型缩窄成 `never` ⇒ `=== 20` 处报
 * "types '3' and '20' have no overlap"（TS2367）。那**不是逻辑错**，是窄化造成的假报，
 * 而"给假报让路"最简单的做法就是放宽类型 —— ⛔ 那会连带丢掉真正的越界保护。
 * 走函数调用 ⇒ 入参类型是 `number`，窄化不发生，判据与顺序都不变。
 */
function cnNumberOf(n: number): string {
  const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  if (n <= 10) return cn[n] ?? String(n)
  if (n < 20) return `十${cn[n - 10] ?? ''}`
  return `二十${n === 20 ? '' : (cn[n - 20] ?? '')}`
}

/**
 * 包级不变量：本插件注册的工具集合（与 dsh.plugin.json contributes.tools 一致）。
 *
 * v1.31.1 修正：v1.31.0 新增 `im-bridge`（条件可见）时**漏改此处与清单**——两侧同错 →
 * `verifyToolConsistency` 零问题（**陈旧的双侧一致 = 静默通过**），而代码实际注册 11 个。
 * 教训：工具面变更必须同时改三处（tools/*.ts 注册 / 本常量 / dsh.plugin.json）。
 *
 * v1.33：`logbook` 并入 `trajectory`（10），随后新增 **专属工具 `acc-diag`**（默认对所有
 * CCC 隐藏，只有声明 `exclusiveTools` 的 CCC 可见）⇒ 11。**条件可见不改变"注册"这一事实**：
 * 本常量与清单都列它（与 im-bridge 同规格）。
 *
 * v1.51（**D104**）：新增 **`diagram`**（标签源码 → 进程内光栅化成 PNG；**缺省关**，
 * 关时连 `ctx.tools.register` 都不调用）⇒ **12**。同规格：开关关着**不影响这里列它** ——
 * 本常量描述的是"插件**具备**的工具面"，不是"此刻注册了几个"。
 *
 * v1.52（**D121**，owner 2026-10-11 裁「引擎搬进 ACC」）：新增 **`ontology`** —— 本体工程
 * **引擎**（原为 CCC 的 MSM `ontology-engineering`，逐字搬迁；见 `src/ontology/engine.ts` 文件头
 * 的三处改写）。它与 `praxis ontology`（**方法文本**）是**同一领域的两个面**：一个说、一个跑 ⇒ **13**。
 *
 * v1.54（**serenity-skill P3**，owner 2026-10-11 令「要一个 serenity-skill-creator 的 tool」）：
 * 新增 **`serenity-skill-creator`** —— 增强型 skill 标准（serenity-skill）的 creator：
 * `guide`（方法文本）／`create`（脚手架；**基础链的相对路径由它算**）／`check`（调 P2 的 A1/A2）／
 * `review`（C 档，调引擎 `compliance`）／`index`（调 P1 的生成器）／`status` ⇒ **14**。
 * 同规格：**条件可见与否不影响这里列它**（本常量 = "插件**具备**的工具面"）。
 */
export const REGISTERED_TOOLS = [
  // ⚠️ **顺序有意义**：**常驻在前、条件在后**（条件者 = `im-bridge` / `diagram` / `reconstruct`）。
  //   它被 `assertManifestProse`（本文件）用来把"后几个按条件出现"这类句子**钉成可判**——
  //   所以**别按字母序重排**，加工具时**加在对应段的末尾**（常驻加在 `serenity-skill-creator` 之后、
  //   条件加在末位），否则那条钉子会对**正确的文字**报假错。
  'container_fs', 'cognitive_trajectory', 'dashboard', 'container_git', 'msm', 'praxis', 'ontology',
  'serenity-skill-creator', 'localstore', 'container_admin',
  // ↓ 条件出现的三个（按注册期的条件钩子判可见性，见各自 `src/tools/*.ts`）
  //   ⚠️ v1.106.0：原第三个 `acc-diag` **已并入 `dashboard diag`** ⇒ 13 项，条件 2 项。
  //   ⚠️ v1.121.0：新增 `reconstruct`（条件 = **累计 token 达阈值**，走 `register(def,{when})`
  //      而不是其他工具用的 `restrict({deny})`）⇒ 13 项，条件 3 项。
  'im-bridge', 'diagram', 'reconstruct',
] as const

/** 条件出现的工具数（`REGISTERED_TOOLS` 的**末段**；`assertManifestProse` 用） */
export const CONDITIONAL_TOOL_COUNT = 3
