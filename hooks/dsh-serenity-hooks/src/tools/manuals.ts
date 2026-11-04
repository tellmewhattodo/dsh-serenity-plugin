/**
 * tools/manuals.ts — **面向 CCC 的统一手册体系**（2026-11-04，owner 令）
 *
 * ## owner 原话（本文件存在的全部理由，逐字）
 *
 * > 「我们 ACC 提供给 CCC 的手册好久没更新了，手册架构也不好，导致你老是忘更新，
 * >   本次也强化一下吧，建立统一的面向 CCC 的手册体系」
 *
 * ## 诊断（这就是"老是忘"的结构性成因，⛔ 不是记性问题）
 *
 * 改造前实测：容器里共有 **8 份手册正文**，而总索引 `config docs` 只覆盖 **5 份**。
 * 另外 3 份（MSM 开发手册 ／ CRO 编写指南 ／ skill 编写方法）**各自住在自己工具的
 * 某个 action 后面**，从总索引完全看不见。任何一个 agent 想问"这容器有哪些手册"，
 * 没有任何一个地方能回答。
 *
 * 更贵的是**加一章的成本**：写 const → 加 import → 改 `DOCS_CHAPTERS` 手写表
 * → 改测试里 `toEqual([...])` 的精确断言，**四处，且没有一处会提醒你漏了哪一处**。
 * ⇒ 手册与代码的分叉不是"忘了"，是**架构让它容易忘**。
 *
 * ## 改法：目录由**登记**生成，⛔ 不是手写表
 *
 * 本文件是**全部手册的唯一登记处**。加一份手册 = **在这里加一项**（一处），
 * 索引与"列出全部章节"都由它自动派生。
 *
 * ## 🔴 两种手册形态必须分开表达（这是本设计的核心判据）
 *
 * | 形态 | 含义 | `render()` 返回什么 |
 * |---|---|---|
 * | **local** | 正文就住在 ACC 里（我们自己的常量） | **正文本身** |
 * | **native** | 正文住在**另一个工具的入口后面**（不是 `config docs` 能给的） | **指针**（告诉你去哪取） |
 *
 * 为什么不能让 native 那三份也 `render()` 返回正文：v1.75.0 已裁「**一个内容一个正文入口**」，
 * 而 `MSM_GUIDE` 的正文入口是 `container_admin msm guide` —— 若 `config docs msm` 也返回
 * 同一份常量，就等于又造了第二个正文入口（正是那次裁决要消灭的形态）。
 * ⇒ **native 形态的章返回指针，⛔ 不复制正文。**
 *
 * ⚠️ 这与「发现」不冲突：目录里**仍然列着**它（读者知道有这么一份手册、写给谁、何时该读），
 * 只是取正文时多一跳。**可发现 ≠ 可复制。**
 */

import { MSM_GUIDE, CCC_CONFIG_REFERENCE, ACC_CATALOG } from './msm/service.js'
import { CRO_GUIDE } from '../cro/guide.js'
import { SKILL_CREATOR_GUIDE } from './skill-creator.js'
import { TRAJECTORY_SELF_GUIDE } from './trajectory-self-docs.js'
import { TRAJECTORY_CONSTRAINT_GUIDE } from './trajectory-constraint-admin.js'
import { IM_BRIDGE_GUIDE } from './im-docs.js'

/** 手册正文的存放形态（见文件头 §两种形态） */
export type ManualCarrier =
  /** 正文住在 ACC 里 —— `render()` 直接给全文 */
  | { kind: 'local'; render: () => string }
  /** 正文住在别的工具入口后 —— `render()` 只给指针，⛔ 不复制 */
  | { kind: 'native'; entry: string; render?: never }

/** 一份手册 = 目录里的一行 ＋ 可选的正文 */
export interface ManualEntry {
  /** 稳定 id（`config docs <id>`；英文短名，便于逐字敲） */
  id: string
  /** 人读的标题（目录里显示；比 id 更可读，且允许中文） */
  title: string
  /**
   * **读者是谁** —— 面向 CCC 的关键字段。
   * 旧目录只有"这一章讲什么"，读者得先通读才知道跟自己有没有关系。
   */
  audience: string
  /**
   * 🔴 **什么时候该读它** —— 本体系最重要的一栏。
   *
   * 判据：手册的价值不在"存在"，在**在需要它的那一刻能被想起来**。
   * 只写"这是什么"（summary）回答不了"我现在该不该读"。
   */
  when: string
  /** 一句话摘要（目录行的主体；⛔ 不要在这里写正文） */
  summary: string
  carrier: ManualCarrier
}

/**
 * **全部手册的登记表**（唯一真相处）。
 *
 * 🔴 加手册 = 加一项。⛔ 不要再改动别处来让它出现（那正是改造前的老毛病）。
 * 🔴 章节顺序 = 下面的书写顺序（**刻意按"新读者最可能先需要哪个"排**，不是字母序）。
 */
export const MANUALS: readonly ManualEntry[] = [
  {
    id: 'catalog',
    title: 'ACC 能力总目录',
    audience: '任何刚进入本容器、想知道"这里能做什么"的 agent',
    when: '不知道某个能力有没有、该去哪个工具时；或要判断"这件事 ACC 支不支持"时',
    summary: '7 个能力分区，每区一句话 ＋ 去哪个子命令看详情',
    carrier: { kind: 'local', render: () => ACC_CATALOG },
  },
  {
    id: 'config',
    title: 'CCC 配置全表',
    audience: '要改 `.opencode/serenity.json` 的 agent／人',
    when: '要新增或调整某个配置段、或某配置"填了没生效"想确认它到底该填什么时',
    summary: '10 段各是什么、怎么填、填错会怎样',
    carrier: { kind: 'local', render: () => CCC_CONFIG_REFERENCE },
  },
  {
    id: 'trajectory-self',
    title: '一条轨迹怎么描述自己',
    audience: '要写自己的 PROMPT.md ／ 声明常驻 ／ 给自己设限制的轨迹',
    when: '新建一条轨迹、要改自己的章程与常驻声明、或要给自己设工具／模型白名时',
    summary: '章程 PROMPT.md ／ 常驻声明（resident.serves）／ 三个载体的分工 ＋ 写完怎么验',
    carrier: { kind: 'local', render: () => TRAJECTORY_SELF_GUIDE },
  },
  {
    id: 'trajectory-constraint',
    title: '轨迹约束（只讲限制面）',
    audience: '要限制某条轨迹能做什么的管理者／轨迹本身',
    when: '要给某条轨迹设工具白名单、限模型、或配 IM 路由时',
    summary: 'trajectory.json 的双白名单 ／ 模型 ／ 纪律参与项 ／ IM 路由',
    carrier: { kind: 'local', render: () => TRAJECTORY_CONSTRAINT_GUIDE },
  },
  {
    id: 'im-bridge',
    title: 'IM 桥：怎么用、怎么配路由',
    audience: '要让某条轨迹收发微信／飞书消息的 agent',
    when: '要给某个家庭成员接一条消息路由、或消息"发不出去／收不到"要排查时',
    summary: 'send/send-file/users/status/contacts 五个动作 ＋ 路由三步法（contacts → 写 → status 自检）',
    carrier: { kind: 'local', render: () => IM_BRIDGE_GUIDE },
  },
  {
    id: 'msm',
    title: 'MSM 开发手册',
    audience: '要写一个新 MSM（Mech / Semi-Mech）或维护既有 MSM 的人',
    when: '要新增一个 MSM 脚本、或某个 MSM 的行为／参数／退出码该怎么定的时候',
    summary: 'Mech 与 Semi-Mech 的分层 ／ 注册与写保护 ／ 参数与退出码约定 ／ 什么时候不该做成 MSM',
    carrier: { kind: 'native', entry: 'container_admin msm guide' },
  },
  {
    id: 'cro',
    title: 'CRO 编写指南',
    audience: '要给自己写 CRO 程序（决定什么时候该被唤醒）的轨迹',
    when: '要让某条轨迹定时自查、或要改已存在的 `continuous-re-occurrence.ts` 时',
    summary: 'CRO 程序的结构 ／ 快照里给了什么 ／ 什么算"该唤起" ／ 写好怎么验',
    carrier: { kind: 'native', entry: 'cognitive_trajectory cro-guide' },
  },
  {
    id: 'skill-authoring',
    title: 'serenity-skill 编写与优化方法',
    audience: '要新建或重构一个 skill 的 agent',
    when: '要写 skill、或某个 skill「看着乱／模型老不用它」要重构时',
    summary: 'skill 目录结构 ／ ontology 建模 ／ 分层与质量门 ／ 优化回路',
    carrier: { kind: 'native', entry: 'serenity-skill-creator guide' },
  },
]

/** 按 id 查找（大小写不敏感；不存在返回 null，由调用方给带候选的拒绝） */
export function findManual(id: string): ManualEntry | null {
  const want = id.trim().toLowerCase()
  if (want === '') return null
  return MANUALS.find((m) => m.id.toLowerCase() === want) ?? null
}

/** 取一份手册的正文或指针（native 形态返回指针，⛔ 不返回被复制过来的正文） */
export function renderManual(m: ManualEntry): string {
  if (m.carrier.kind === 'local') return m.carrier.render()
  return [
    `═══ ${m.title} — 正文不在本节 ═══`,
    '',
    `这份手册的正文入口是：**${m.carrier.entry}**`,
    '',
    '为什么这样分（v1.75.0 owner 裁「一个内容一个正文入口」）：',
    '它原本就住在那个工具里，如果这里也返回一份正文，同一份内容就会有两个真相源，',
    '必然各自漂移。⇒ **本节只负责让你找到它**（谁该读、什么时候读），正文仍只有一份。',
    '',
    `摘要：${m.summary}`,
    '',
    '还想知道容器里有哪些别的说明：container_admin config docs',
  ].join('\n')
}

/**
 * 渲染**目录**（第一层）。
 *
 * 🔴 **只读元数据，绝不调 `render()`** —— 目录若触发正文，两层菜单就退化成一坨长文。
 * 这条不是性能优化，是判据：**目录大小与章数成正比，与正文长度无关**。
 *
 * 🔴 每章给三件（旧的只给两件）：**它是谁（title）／写给谁（audience）／何时读（when）**。
 * 旧目录只给 id ＋ summary ⇒ 读者得先通读简介才知道跟自己有没有关系，
 * 而"我现在该不该读这一章"正是**手册能不能被用起来**的那一格（owner 说"老是忘更新"，
 * 根因与此同族：**没人按需想起它**）。
 */
export function renderManualsIndex(entries: readonly ManualEntry[] = MANUALS): string {
  const lines = [
    '═══ CCC 手册目录 · 全部说明的唯一入口 ═══',
    '',
    '说明类内容已超过单次返回的合适篇幅 ⇒ 先读目录，再按章取详情。',
    '',
    '用法：container_admin config docs <章节id>',
    '',
  ]
  for (const m of entries) {
    // 标记 native 形态：读者一眼看出"正文在别处"，⛔ 不会以为本命令能直接给他
    const mark = m.carrier.kind === 'native' ? '↗' : ' '
    lines.push(`${mark} ${m.id.padEnd(21)}${m.title}`)
    lines.push(`  ${''.padEnd(21)}写给：${m.audience}`)
    lines.push(`  ${''.padEnd(21)}何时读：${m.when}`)
    lines.push(`  ${''.padEnd(21)}${m.summary}`)
    lines.push('')
  }
  lines.push('↗ = 正文住在别的工具入口后（本节给指针，不复制正文）。')
  return lines.join('\n')
}
