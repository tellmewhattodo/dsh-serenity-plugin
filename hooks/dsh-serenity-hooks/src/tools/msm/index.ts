/**
 * tools/msm/index.ts — msm 工具（v1.30 重构：单入口执行，list/exec 合一）
 *
 * 设计（S142 用户拍板"msm 单入口同意 + 参数简易高效"）：
 *   acc_msm（8 action enum）→ msm（3 参数：name + args + inspect）——
 *   最高频工具参数极简：无 action 选择、无协议 flag 前置学习。
 *
 * LLM 直觉用法：
 *   msm("ssh-connect", ["status"])        — 执行已注册 MSM
 *   msm("ssh-connect")                    — 无参执行
 *   msm("ssh-connect", [], inspect=true)  — 查该 MSM 用法/参数（不执行）
 *   msm("ssh")                            — 未精确命中 → 返回模糊候选（LLM 下轮选对）
 *   msm()                                 — 返回精简分类目录（替代旧全量 list）
 *
 * 管理面（register/deregister/check/guide/catalog/ccc-config）已移入 container_admin。
 * 底层 runMsmAsync/prepareExec 全复用；未命中候选为新增 findSuggestions。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../../kernel/ccc-roots.js'
import { runMsmAsync, loadMsmEntries, findEntry } from './service.js'
import { trajectoryConstraintMsmGate } from '../../trajectory/session.js'

function agentSessionId(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? ''
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 精简目录（无参调用返回；替代全量 list 的巨输出）——按 skill 分组统计 + 顶部指引 */
function buildMsmIndex(root: string): string {
  const entries = loadMsmEntries(root)
  if (entries.length === 0) return '(no MSM registered — call container_admin register to add one)'
  const bySkill = new Map<string, number>()
  for (const e of entries) {
    const k = e.skill ?? 'uncategorized'
    bySkill.set(k, (bySkill.get(k) ?? 0) + 1)
  }
  const groups = [...bySkill.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([skill, count]) => `  ${skill}: ${count} MSM`)
    .join('\n')
  return (
    `${entries.length} MSMs registered (by skill):\n${groups}\n\n` +
    `Execute: msm("<name>", ["<args>"]) — e.g. msm("ssh-connect", ["status"])\n` +
    `Inspect: msm("<name>", [], inspect=true) — view usage/flags\n` +
    `Partial name returns matching candidates.\n` +
    // 🔴 D237 文案修正：原文写 "Full listing: use container_admin" —— 但 `container_admin` 是**工具**
    //    不是 MSM，照它去 `msm("container_admin", ...)` 只会得到一次未命中（实测踩到）。
    //    注册/注销/质检的**动作名**也各有归口：msm check 走 container_admin(domain=msm)。
    `Registry maintenance: container_admin (domain=msm, action=register|deregister|check).`
  )
}

/** 模糊候选：name/description 子串匹配（未精确命中时返回 top-K，供 LLM 下轮选对） */
function suggestMsm(root: string, query: string, limit = 5): string {
  const q = query.toLowerCase()
  const entries = loadMsmEntries(root)
  const hits = entries
    .filter((e) => e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q))
    .slice(0, limit)
  if (hits.length === 0) {
    // 🔴 D237：未命中时**不再倾倒全量分类表**（26 行）——它对"我打错了哪个名字"零信息量，
    //    真正有用的是「总共有多少个 + 怎么列出来」。列全表的入口在 container_admin。
    const skills = new Set(entries.map((e) => e.skill ?? 'uncategorized'))
    return (
      `No MSM matches "${query}" (${entries.length} registered across ${skills.size} skills).\n` +
      `Try a shorter fragment, e.g. msm("${query.slice(0, 3)}"), or msm() for counts by skill.`
    )
  }
  const lines = hits.map((e) => {
    const base = `${e.name} | ${e.skill ?? '-'} | ${e.category ?? '-'} | ${shortDesc(e.description)}`
    const flags = (e.flags ?? []).map((f) => `--${f.name} <${f.type ?? 'string'}>`).join(', ')
    return flags ? `${base} [flags: ${flags}]` : base
  })
  return `No exact MSM "${query}" — did you mean one of these?\n` + lines.join('\n')
}

/**
 * 候选行的**描述截断**（D237：其它调用的"简练结构"那一档）。
 *
 * 判据 = **「帮不帮得了下决定」**：选哪个 MSM 靠前半句的分句就够，后面那些
 * 「子命令清单 / 设计取舍 / 历史沿革」属于**选中之后**才需要的细节（`inspect=true` 给全）。
 * 实测：一条候选描述可达 200+ 字，5 条候选就能吃掉大半屏。
 *
 * ⚠️ 截断点选**分号/句号/破折号**这类天然断句符，不做"每 N 字硬切"——硬切会把词切两半
 *    （中文尤其明显），反而降低可读性。
 *
 * 🔴 **实现更正（自查抓到）**：初版先 `slice(0, max)` 再在里面找断句符 ⇒ 当第一个断句符
 *    出现在很靠前的位置时（如「短说明；后面全是细节」），它落在 `max/3` 之外就被放弃了，
 *    于是退化成硬切 —— **正好违反"在天然断句符处收尾"这条本意**。
 *    ⇒ 正确做法：**先找 max 之后最近的那个断句符**，让它成为截断点（宁可略超 max，
 *      也要停在句读上）；只有在整串都没有断句符时才硬切。
 */
function shortDesc(desc: string | null | undefined, max = 64): string {
  const s = (desc ?? '').trim()
  if (s === '') return ''
  if (s.length <= max) return s
  const BREAKS = ['；', ';', '。', '——', '·', '，', ',']
  // 优先：从 max 处向后找**最近**的断句符（最多再看 max 个字，避免把整段都吞掉）
  const windowEnd = Math.min(s.length, max * 2)
  let best = -1
  for (const brk of BREAKS) {
    const at = s.indexOf(brk, max) // 从 max 开始向后找
    if (at !== -1 && at < windowEnd && (best === -1 || at < best)) best = at
  }
  if (best !== -1) return s.slice(0, best).trimEnd() + '…'
  // 其次：在 max 之内往回找最后一个断句符（句读优先于长度）
  let back = -1
  for (const brk of BREAKS) {
    const at = s.lastIndexOf(brk, max)
    if (at > back) back = at
  }
  if (back >= Math.floor(max / 4)) return s.slice(0, back).trimEnd() + '…'
  return s.slice(0, max).trimEnd() + '…'
}

export const msmTool = defineTool({
  name: 'msm',
  description:
    'Execute a registered CCC MSM (Mech & Semi-Mech). ' +
    'msm(name, args) runs it directly; name not found returns matching candidates; ' +
    'inspect=true shows usage/flags without running; no args returns a summary index. ' +
    'The full CCC MSM list is discoverable via partial-name matching or the index.',
  parameters: {
    name: {
      type: 'string',
      description: 'MSM name to execute (or a partial fragment — not found returns matching candidates)',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments passed to the MSM (optional; defaults to none). Pass "--help" as first arg to see an MSM\'s own usage.',
    },
    inspect: {
      type: 'boolean',
      description: 'true = print the MSM\'s usage/flags/params WITHOUT executing (default false)',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = cccRootForExec(exec)
    if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
    // 轨迹约束白名单门控（exec 校验；轨迹约束角色限定的 MSM 面）
    const sessionId = agentSessionId(exec)
    const name = args.name as string | undefined
    const gate = trajectoryConstraintMsmGate(root, sessionId, name ? 'exec' : 'list', name)
    if (gate.reject) throw new Error(gate.reject)

    // 无 name → 精简目录
    if (!name || name.trim() === '') {
      // 🔴🔴 **2026-11-20 修（owner 截图报障：回执只有一句 `MSMs allowed in this role:` 加空行）**
      //
      // 两个错叠在一起：
      //  ① **判据错**：`gate.whitelist` 曾对「没写 `msms`」也返回一个**空 Set**，而空 Set 是 truthy
      //     ⇒ 走进了白名单分支。已在 `trajectoryConstraintMsmGate` 里改回「字段在不在」（D181），
      //     没写 `msms` 时**不再返回白名单** ⇒ 落到全量目录。
      //  ② **文案错**：`role` 这个概念**早已退役**（身份 = 轨迹编码，D-族「角色名不存在了」）。
      //     回执里说 "this role" 会让模型去找一个不存在的东西 —— 正是 D151「退役功能的残留引用」。
      //     ⇒ 一律改说 trajectory，且**必须点名是哪条**（否则收到的人不知道该改哪份文件）。
      //
      // ⚠️ **显式 `msms: []` 走另一支**：那不是"没声明"，是"我一个都不给" ⇒ 必须说出来，
      //     ⛔ 不能印一个空标题让人以为这是完整目录。
      if (gate.whitelist) {
        const allowed = [...gate.whitelist]
        if (allowed.length === 0) {
          return (
            'This trajectory declares an EMPTY `msms` whitelist — no MSM is callable here.\n'
            + '  ⇒ That is a deliberate declaration (an explicit `"msms": []`), not a missing field.\n'
            + '  ⇒ To lift it, remove the `msms` key from this trajectory\'s trajectory file '
            + '(omitting it means "unrestricted").'
          )
        }
        return (
          `MSMs allowed for this trajectory (declared \`msms\` whitelist, ${allowed.length} entr${allowed.length === 1 ? 'y' : 'ies'}):\n`
          + allowed.join('\n')
          + '\n  ⇒ This is a NARROWED view, not the full registry. Run `msm()` without a whitelist declared to see everything.'
        )
      }
      return buildMsmIndex(root)
    }
    const clean = name.trim()
    // 轨迹约束白名单过滤：name 不在白名单 → 拒绝（角色限定）
    if (gate.whitelist && !gate.whitelist.has(clean)) {
      return (
        `MSM "${clean}" is not in this trajectory's declared \`msms\` whitelist.\n`
        + `  Allowed here: ${[...gate.whitelist].join(', ') || '(none — the whitelist is explicitly empty)'}`
      )
    }

    // 精确查找：未命中 → 返回候选（list/exec 合一的发现路径）
    if (!findEntry(root, clean)) {
      const suggest = suggestMsm(root, clean)
      // 白名单在 `trajectoryConstraintMsmGate(/'exec'/)` 那一支**不返回**（只有 `list` 返），
      // 所以此处 `gate.whitelist` 恒 undefined ⇒ 保留分支只为不改变既有行为契约。
      return gate.whitelist ? `(whitelisted trajectory — candidates filtered)\n${suggest}` : suggest
    }

    // inspect → 协议 schema（复用 prepareExec 的 --schema 协议路径）
    if (args.inspect === true) {
      return runMsmAsync(root, { action: 'exec', name: clean, args: ['--schema', clean] })
    }

    // 执行（默认即 exec；异步 execFile 不阻塞事件循环）
    return runMsmAsync(root, {
      action: 'exec',
      name: clean,
      args: (args.args as string[] | undefined) ?? [],
    })
  },
})
