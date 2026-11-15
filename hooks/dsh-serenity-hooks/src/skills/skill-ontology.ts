/**
 * skill-ontology.ts — **本体预留口**的发现与检查（纯逻辑，零 DSH 依赖）
 *
 * 设计真相源：`docs/serenity-skill-design.md` §4.1（四个动作）／§5.1-5.2（固定名与骨架）／§6（J1~J3）。
 * 一句话：**一个 skill 若完成了本体建模，就在自己目录放固定名 `skill.ttl`**；
 * 本模块回答三件事：**有没有**（发现）／**合不合法**（A 档）／**引用能不能兑现**（B 档）。
 *
 * 🔴 只认**固定名** `<skillDir>/skill.ttl`（owner 裁决 Q6：静默、CCC 自行修正）：
 *   `references/*-domain.ttl` 这类**旧名一律当普通参考件** —— 不特殊对待、**不告警**、**不代读**。
 * 🔴 「无 `skill.ttl`」**不是错误也不是告警**（裁决 Q6 ／ 判据 J9）：
 *   那是**普通 skill**，全程无声 —— 增强必须对普通 skill 完全向后兼容。
 *
 * ── 两档判据（**两档都锚在引擎自己的输出上**，我们不另写一遍 Turtle 解析）──────────
 *   **A1 结构合法**：`check --level strict` exit 0（引擎的 M1–M10）
 *   **A2 链上基础链**：`explain` exit 0 **且**报告里有 `Imports:` 行
 *
 * 🔴 **为什么必须有 A2（这是本模块存在的理由，且是实测逼出来的）**：
 *   **A1 绿 ≠ 链上了**。实测对照（同一天、同一引擎）：
 *     · `home-rhetoric/references/home-rhetoric-domain.ttl`（写的是 `sr:imports`）
 *       ⇒ `check --level strict` = **✓ exit 0 · All checks passed**，而 `explain` **没有 `Imports:` 行**；
 *     · 注册表（写的是 `owl:imports`）⇒ `explain` **打印 `Imports: ccc-ontology.ttl`**（探针不瞎）。
 *   ⇒ **「检查全绿」与「链上了」是两件事**；只看 A1 就会把 14 份没链上的本体判成合格。
 *
 * 🟢 **A3（引用可兑现）**：**本模块刻意不做** —— 引擎已经做了，而且是**响亮的**。实测两条：
 *     · `check`：import 目标不存在 ⇒ **`ERR [M10] Ontology file not found: <abs>`**、**exit 1**；
 *     · `explain`：同一个文件 ⇒ **exit 2 · `ONTO_FILE_NOT_FOUND`**。
 *   ⇒ 再写一遍就是**同一件事的第二实现**（本仓的老账："先问谁已经做了"）。
 *   🔴 但**起因值得记**：我原本以为引擎对缺失 import 是**静默**的（照源码 1687 行那句 "Fall back to
 *   loading just this file (no imports)" 推断）—— **实测把这条推断打假了**（两条路都响亮报错）。
 *   ⇒ 又一次「**照源码的意图抄 ≠ 引擎实际怎么行为**」（D119 同族）。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runOntologyCli } from '../ontology/engine.js'
import { SKILL_ONTOLOGY_FILE } from './resource-index.js'

/** 三态（**互可分辨**是硬要求，判据 J3） */
export type SkillOntologyState = 'none' | 'ok' | 'error'

export interface SkillOntologyCheck {
  id: 'A1' | 'A2'
  ok: boolean
  detail: string
}

export interface SkillOntologyInspection {
  state: SkillOntologyState
  /** 容器内相对路径（未建模 ⇒ ''）；调用方负责把 root 去掉 */
  rel: string
  modeled: boolean
  checks: SkillOntologyCheck[]
  /** A2/A3 用：引擎报告的 import 目标（原样，未解析） */
  imports: string[]
}

export interface InspectOptions {
  /** CCC 根（引擎的解析基准） */
  root: string
}

/** 从引擎 `explain` 的报告里取 `Imports:` 行（**锚在引擎自己的输出上**，见文件头 A2 注） */
function parseImports(explainStdout: string): string[] {
  const out: string[] = []
  for (const line of explainStdout.split('\n')) {
    const m = /^Imports:\s*(.+)$/.exec(line.trim())
    if (!m) continue
    for (const part of (m[1] ?? '').split(',')) {
      const t = part.trim()
      if (t !== '') out.push(t)
    }
  }
  return out
}

/**
 * 从引擎输出里抽出 `ERR [...]` 行（**读引擎自己的正文，不重造措辞**）。
 *
 * 🔴 为什么必须有这个（2026-11-15 butler 现场报障，已由我复现）：
 *   A1 失败时回执原先只有一句「结构校验未通过（引擎 ERR 行见报告）」——
 *   **而"报告"根本不是一个可指的东西**：`check` 不落盘、不回传，操作者拿到的就是那一句。
 *   同一份内容交给 `ontology check` 会打印 `ERR [M8] Axiom #1 tokenization error: …` 等逐条错误。
 *   ⇒ 信息一直在 `runOntologyCli` 的返回值里，是这一行把它丢了。
 *
 * ⚠️ 判据 = **引擎的原文**，⛔ 不是我重新写一句摘要（重写会漂，且丢掉 `[M8]` 这类可检索编号）。
 * @param out 引擎 stdout ＋ stderr 的合并文本
 * @param max 最多带出几条（防一份烂文件把回执撑爆）
 */
export function extractEngineErrors(out: string, max = 5): string[] {
  const hits: string[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    // 引擎的错误行形如 `ERR [M8] …` / `ERR [M10] …`（M 编号是它的判据号，必须原样保留）
    if (!/^ERR\s*\[M\d+\]/.test(t)) continue
    hits.push(t)
    if (hits.length >= max) break
  }
  return hits
}

/**
 * 检查一个 skill 的预留口。
 *
 * @param skillDir skill 目录（绝对路径）
 * @param opts.root CCC 根（引擎基准；**必须是 CCC 根**，否则引擎找不到容器级资产）
 * @returns 三态 ＋ 逐档判据
 */
export function inspectSkillOntology(skillDir: string, opts: InspectOptions): SkillOntologyInspection {
  const abs = resolve(skillDir, SKILL_ONTOLOGY_FILE)

  // ── 发现：无 ⇒ 普通 skill（**无声**，J9）──────────────────────────────
  if (!existsSync(abs)) {
    return { state: 'none', rel: '', modeled: false, checks: [], imports: [] }
  }

  const relOf = (p: string): string =>
    p.startsWith(opts.root) ? p.slice(opts.root.length).replace(/^[/\\]/, '') : p
  const rel = relOf(abs)

  const checks: SkillOntologyCheck[] = []

  // ── A1：结构合法（check --level strict）───────────────────────────────
  const c1 = runOntologyCli(['check', abs, '--level', 'strict'], { cwd: opts.root })
  /**
   * 🔴 **失败必须把引擎的 ERR 行带出来**（2026-11-15 butler 报障 ＋ 我复现）。
   *
   * 修前：`code === 1` ⇒ 只写「引擎 ERR 行见报告」。而 `check` 不落盘、不回传任何路径
   * ⇒ **"报告"在构造上不存在**，操作者被迫再跑一个工具（`ontology check`）才看得到
   * 「第几条公理、什么错」。同族判据：**报错要指路**（D262）—— 指一条不存在的路更坏。
   *
   * 这里的 ERR 行取自 `stdout ＋ stderr`：引擎把校验错误打在 stdout 正文里、
   * 把 `[ONTO_VALIDATION_FAILED]` 的代码块打在 stderr，两者都要看。
   */
  const engineErrors = extractEngineErrors(`${c1.stdout}\n${c1.stderr}`)
  const errLine = engineErrors.length > 0
    ? `\n       ${engineErrors.join('\n       ')}`
    : ''
  checks.push({
    id: 'A1',
    ok: c1.code === 0,
    detail:
      c1.code === 0
        ? 'strict 结构校验通过'
        : c1.code === 1
          ? `结构校验未通过（引擎 ${engineErrors.length} 条 ERR）：${errLine}`
          : c1.code === 2
            ? `解析失败／读不到文件（code 2）${c1.stderr.trim() !== '' ? `：${c1.stderr.trim().split('\n')[0]}` : ''}`
            : `引擎内部错误（code ${c1.code}）`,
  })

  // ── A2：链上基础链（引擎只认 owl:imports）────────────────────────────
  //   🔴 三种形态**必须分开说**（否则就重犯"检查没跑成"说成"检查不通过"的老病）：
  //     ① 引擎跑不成（exit≠0）⇒ 说"探测失败 ＋ 引擎给的原因"
  //     ② 引擎跑通、报告里没有 Imports 行 ⇒ 说"**未声明 owl:imports**（真缺陷形态）"
  //     ③ 有 Imports 行 ⇒ 说"已链上：<目标>"
  const e1 = runOntologyCli(['explain', abs], { cwd: opts.root })
  const imports = e1.code === 0 ? parseImports(e1.stdout) : []
  const explainFirstErr = e1.stderr.trim().split('\n').find((l) => l.trim() !== '') ?? ''
  checks.push({
    id: 'A2',
    ok: e1.code === 0 && imports.length > 0,
    detail:
      e1.code !== 0
        ? `**探测没跑成**（引擎 explain exit ${e1.code}）—— ${explainFirstErr !== '' ? explainFirstErr : '引擎未给原因'}`
        : imports.length > 0
          ? `已链上基础链：${imports.join(', ')}`
          : '**未声明 `owl:imports`** —— 与基础链**没链上**（引擎只解析 `owl:imports`；写 `sr:imports` 不会被读 —— 这是实测过的静默形态，且 `check` 对它会**照样报全绿**）',
  })

  const ok = checks.every((c) => c.ok)
  return { state: ok ? 'ok' : 'error', rel, modeled: true, checks, imports }
}

/**
 * 渲染三态报告（**三态必须互可分辨** —— 判据 J3；措辞刻意不许糊）。
 *
 * 为什么单独一个函数：`check` 的呈现（P3 的工具）与测试看的是**同一段文本**，
 * 两处各写一遍必然漂移（本仓"路径写两遍必漂"的既有教训）。
 */
export function formatSkillOntologyInspection(skillName: string, insp: SkillOntologyInspection): string {
  const head =
    insp.state === 'ok'
      ? `✅ ${skillName}：**已建模且全部通过**`
      : insp.state === 'none'
        ? `⬜ ${skillName}：**普通 skill（未建模）**—— 无 \`${SKILL_ONTOLOGY_FILE}\``
        : `❌ ${skillName}：**建模了但检查没跑成**`
  const lines = [head]
  if (insp.state === 'none') {
    lines.push(
      '   （**这不是"检查通过"，是"没有这项检查"**；也不是异常 —— 增强对普通 skill 完全向后兼容。）',
    )
    return lines.join('\n')
  }
  lines.push(`   ${insp.rel}`)
  for (const c of insp.checks) {
    lines.push(`   ${c.ok ? '✅' : '❌'} ${c.id} ${c.detail}`)
  }
  return lines.join('\n')
}
