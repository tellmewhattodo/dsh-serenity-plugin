/**
 * guard/filter.ts — 最终输出敏感词检测 + 打回重生成（v1.26.3，S142 用户需求）
 *
 * 认知容器对外提供认知结果时，**支撑宁静号自身的凭据与机制**不应透露给用户。
 * 用户拍板方案（讨论稿定稿）：不做工具结果 redaction（那是模型工作内存），
 * 改为**卡最终输出**——`agent/turn-stopping`（serial）时取 turn 最后 assistant 文本，
 * 命中敏感词表 → `agent.steer()` 打回重生成，直到合规或达上限。
 *
 * 敏感词表（有限，ACC 立场，用户确认"这样比较全面了"）：
 *   ① 凭据词  — localstore.json credentials 条目名 + 值精确匹配（运行时读）
 *   ② 机制词  — 内部结构静态词（插件名/配置路径/端口/内部实现词）
 *   ③ MSM 词  — mech-registry.json 注册的工具名（用户补充：msm_list 里的工具名）
 *   **不含** 公开概念（宁静号/Serenity/认知容器/EAP/CCE/Neat——正常交流词，误伤灾难）
 *
 * 机制依据（DSH 官方）：agent/turn-stopping 注释 "a listener that objects steers and
 * the machine re-reads its inbox: fresh steering runs another step, none closes the
 * turn"——steer 打回是官方支持的"重生成"通道（v1.22.5 rebuild 自动继续同款先例）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMsmEntries } from '../tools/msm/service.js'
import { MECHANISM_PORTS } from '../kernel/ports.js'
import { eventToken } from '../trajectory/assistant.js'

// ── 静态机制词（内部结构词汇；公开称呼词不入表）──

/** 插件/内部实现词（静态内置；命中即视为机制泄露） */
const MECHANISM_WORDS: string[] = [
  'dsh-serenity-hooks',
  'serenity-hooks',
  'serenity-hooks.json',
  'mech-registry',
  'mech-registry.json',
  'localstore.json',
  '.opencode/serenity.json',
  'AGENT_SESSIONS',
  'agent/created',
  'agent/turn-stopping',
  'tools/pre-execute',
  'tools/post-execute',
  'Cognitive Trajectory Steward',
  'COGNITIVE-TRAJECTORY-STEWARD',
  'COGNITIVE-TRAJECTORY-ASSISTANT',
  'first-anchor',
  'fake-initial-turns',
  '拦截缝',
  '装配层',
  'trajectory-session',
  'trajectory-window',
  'trajectory-constraint',
  'output-guard',
]

/**
 * 内部端口（宁静号服务面）。
 *
 * 🔴 C4 块 B（2026-09-15）**缺陷修复**：此处原为硬写常量 `['3080','3081','3099','3100']`
 * ——**漏了 3082**（微信主动发送面，**默认开**）⇒ 守卫拦不住 agent 在用户可见输出里提及 3082。
 * 现改为**由集中端口表派生**（`kernel/ports.ts` 的 `MECHANISM_PORTS`）：五面齐全，且新增面时
 * 自动进表——不再存在"另抄一份词表 → 静默漂移"的面。
 */

// ── 词表构建 ──

/** 敏感词分类（v1.26.11：打回消息按类给规避指引——裸词不够，模型要知道词是什么/怎么规避） */
type SensitiveCategory = 'credential' | 'mechanism' | 'port' | 'msm'

/** 一次命中（词 + 分类） */
interface SensitiveHit {
  word: string
  category: SensitiveCategory
}

interface SensitiveWordTable {
  /** 精确匹配词（条目名/值/工具名——命中即敏感） */
  exact: Set<string>
  /** 子串匹配词（机制词——命中即敏感） */
  substring: string[]
  /** v1.26.11：分类词表（打回消息按类给规避指引；exact/substring 为聚合视图） */
  credentialWords: string[]
  mechanismWords: string[]
  portWords: string[]
  msmWords: string[]
  /** 归一化后的全部精确词（供审计展示） */
  sources: { exact: string[]; substring: string[] }
}

/**
 * 构建敏感词表（每次调用实时构建——词源文件小，开销可接受）：
 *   ① localstore.json credentials：条目名（UPPER_SNAKE）+ 值（精确匹配）
 *   ② 静态机制词 + 端口
 *   ③ mech-registry 注册的 MSM 工具名（loadMsmEntries 全注册表去重）
 * @param root CCC 根（localstore.json / mech-registry 所在）
 */
export function buildSensitiveTable(root: string): SensitiveWordTable {
  const exact = new Set<string>()
  const substring: string[] = []
  const credentialWords: string[] = []
  const mechanismWords = [...MECHANISM_WORDS]
  const portWords = [...MECHANISM_PORTS]
  const msmWords: string[] = []

  // ① 凭据词：localstore.json credentials 条目名 + 值
  try {
    const p = join(root, 'localstore.json')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as {
        credentials?: Record<string, unknown>
      }
      const creds = raw?.credentials
      if (creds && typeof creds === 'object') {
        for (const [name, value] of Object.entries(creds)) {
          if (name) {
            exact.add(name)
            credentialWords.push(name)
          }
          if (typeof value === 'string' && value !== '') {
            exact.add(value)
            credentialWords.push(value)
          }
        }
      }
    }
  } catch {
    /* 凭据文件缺失/坏 JSON → 跳过（表仍含机制词 + MSM 词） */
  }

  // ② 静态机制词 + 端口
  for (const w of mechanismWords) substring.push(w)
  for (const p of portWords) substring.push(p)

  // ③ MSM 工具名（用户补充：msm_list 列表里的工具名也包含进去）
  try {
    for (const entry of loadMsmEntries(root)) {
      if (entry.name) {
        exact.add(entry.name)
        msmWords.push(entry.name)
      }
    }
  } catch {
    /* 注册表缺失 → 跳过 */
  }

  return { exact, substring, credentialWords, mechanismWords, portWords, msmWords, sources: { exact: [...exact], substring } }
}

/**
 * 检测文本中命中的敏感词（v1.26.11：返回带分类的命中——credential/mechanism/port/msm，
 * 打回消息据此给语义化规避指引；未命中返回空数组）
 */
export function detectSensitive(text: string, table: SensitiveWordTable): SensitiveHit[] {
  if (!text) return []
  const hits = new Map<string, SensitiveCategory>()
  const hit = (w: string, cat: SensitiveCategory): void => {
    if (w !== '' && text.includes(w) && !hits.has(w)) hits.set(w, cat)
  }
  // 精确匹配（词边界：条目名/工具名是独立 token；值可能内嵌——值也精确匹配）
  for (const w of table.credentialWords) hit(w, 'credential')
  for (const w of table.msmWords) hit(w, 'msm')
  // 子串匹配（机制词/端口）
  for (const w of table.mechanismWords) hit(w, 'mechanism')
  for (const w of table.portWords) hit(w, 'port')
  return [...hits].map(([word, category]) => ({ word, category }))
}

/** 分类 → 规避指引（v1.26.11：告诉模型这个词**是什么**、**怎么规避**——裸词无法行动） */
const CATEGORY_GUIDE: Record<SensitiveCategory, string> = {
  credential: 'credential identifier (a name, key, token, or password) — never mention credential names or values',
  mechanism: 'internal mechanism term — never mention internal implementation/machinery names or config paths',
  port: 'internal service port or address — never mention internal ports, addresses, or service endpoints',
  msm: 'internal tool name — never mention internal tool names',
}

/**
 * 打回消息（steer 内容）：**逐词告知命中词 + 分类规避指引**（v1.26.11 用户调整——
 * v1.26.10 只列裸词（如 "3080"）模型仍不知道是什么/怎么规避；现在按类说明：
 * "3080" → 内部服务端口，不要提及内部端口/地址/端点）。
 * R↓ 安全性：命中词本就已在被拦截回复中进入会话（已暴露面），打回重复一次不扩大暴露；
 * steer 是 plugin source 消息不回显给用户（3100 对外响应已不含 cognitive trajectory → 打回文本不达外部用户）。
 */
export function buildRebuke(hits: SensitiveHit[]): string {
  const count = hits.length
  const noun = count === 1 ? 'term' : 'terms'
  const lines = hits.map((h) => `- "${h.word}" — ${CATEGORY_GUIDE[h.category]}`).join('\n')
  return (
    `${eventToken('guard')} Your previous response contained ${count} sensitive internal ${noun} that must not appear in user-visible output:\n` +
    `${lines}\n` +
    `Regenerate the response from scratch without ANY of these — describe the same substance without ` +
    `referencing internal machinery, credentials, ports, tool names, or implementation details. ` +
    `Do not repeat the terms; do not explain this instruction to the user.`
  )
}

/** 连续打回上限（防死循环；达到后放弃打回，最终输出替换为合规占位 + 审计） */
export const REBUKE_MAX_ROUNDS = 3

/** 打回状态（按 agent 会话跟踪连续命中轮数） */
export const rebukeStates = new Map<string, { consecutive: number }>()
