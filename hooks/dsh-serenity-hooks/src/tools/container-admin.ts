/**
 * container-admin.ts — container_admin（v1.30：机务舱——容器管理面统一入口）
 *
 * ## 域结构（2026-10-19 owner 两条令后：**两域**）
 *
 * | 域 | 管什么 |
 * |---|---|
 * | `config` | **本 CCC 的全部配置面**：说明目录/按章详情 ＋ 轨迹约束（原 `role` 域，已并入） |
 * | `msm`    | MSM 注册表管理 ＋ 手册（register/deregister/check/guide/catalog/ccc-config） |
 *
 * 🔴 **`role` 域已并入 `config`**（owner 2026-10-19 裁「1 并入」）。为什么不是三个平行域：
 * `role` 管的本来就是"某条轨迹的约束面"——**一组配置**，与 `config` 是同一抽象层的两半。
 * 分着放的代价是：用户在 `config` 里看不到"轨迹怎么约束"，得先知道 `role` 这个词存在。
 * ⚠️ **旧 `role` 域仍被接受**（过渡别名，指向同一实现）——存量 CCC 的文档/脚本里到处是
 * `container_admin role validate`（实测本仓 30 处），硬切会让它们全部变成"未知域"。
 * 别名**只保留读取路径**：schema 的 `enum` 只列新名，文案只教新名。
 *
 * ## 三个动作名为什么是这三个（P3 的实现形态）
 * - `config docs`（无参）→ **使用说明目录**（第一层；只索引不复制）
 * - `config docs <chapter>` → **使用说明详情**（第二层；按章获得）
 * - `config view` → 配置**现值**（原来是唯一动作；现在是"看当前填了什么"）
 *
 * 归属（D23）：**机制在 ACC**（有哪几章、怎么路由、怎么校验），**内容在 CCC**（填什么）。
 * 语义（用户拍板"轨迹约束_admin 及系列 admin 合并成 container_admin"）：
 *   container = CCC（具体认知容器）；admin = 管理操作。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import type { JsonValue } from '../kernel/json.js'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../kernel/ccc-roots.js'
import { runMsm, MSM_ACTIONS, CCC_CONFIG_REFERENCE, ACC_CATALOG } from './msm/service.js'
import { trajectoryConstraintMsmGate } from '../trajectory/session.js'
import { validateTrajectoryConstraint, applyTrajectoryConstraint, listTrajectoryConstraintSummary, TRAJECTORY_CONSTRAINT_GUIDE } from './trajectory-constraint-admin.js'
import { TRAJECTORY_SELF_GUIDE } from './trajectory-self-docs.js'
import { IM_BRIDGE_GUIDE } from './im-docs.js'
import { renderDocsIndex, findDocsChapter, docsPointer, type DocsChapter } from './config-docs.js'
import { loadSerenityConfig } from '../kernel/ccc.js'

function agentSessionId(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? ''
}

/**
 * `config view` 的**现值摘要**（v1.75.0 起：不再回整份说明正文）。
 *
 * 语义边界（这正是它和 `docs config` 的分工）：
 * - 本函数回答「**你这个 CCC 现在填了什么**」⇒ 只报有值的键，且值超长截断。
 * - 它回答不了「**这个键该怎么填**」⇒ 那是 `docs config` 那一章。
 *
 * 🔴 为什么必须截断：现值里可能有很长的字段（`topPrompt` 实测数百字符）。
 * 不截断会让 "看现值" 退化成 "又返回一坨正文" —— 那就回到了统一前的问题。
 *
 * ⚠️ 返回类型是 `JsonValue`（工具 output schema 的契约）⇒ 必须**转成纯 JSON 可表达形态**，
 * 不能直接把 `Record<string, unknown>` 塞回去（`unknown` 里可能有函数/undefined，
 * 那会让序列化层行为不确定）。
 */
function viewConfigSummary(root: string): JsonValue {
  let cfg: Record<string, unknown>
  try {
    cfg = loadSerenityConfig(root) as unknown as Record<string, unknown>
  } catch (err) {
    return { error: `配置读取失败：${String((err as Error)?.message ?? err)}` }
  }
  const MAX_STR = 120
  const MAX_ARRAY = 12
  const MAX_KEYS = 12

  /** 递归转成纯 JSON 可表达值（超长按上限截断，并标注原始规模） */
  const toJson = (v: unknown): JsonValue => {
    if (v === null || v === undefined) return null
    if (typeof v === 'string') {
      return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…（共 ${v.length} 字符）` : v
    }
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
    if (typeof v === 'boolean') return v
    if (Array.isArray(v)) {
      const head = v.slice(0, MAX_ARRAY).map(toJson)
      return v.length > MAX_ARRAY ? [...head, `…（共 ${v.length} 项）`] : head
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj)
      const out: Record<string, JsonValue> = {}
      for (const k of keys.slice(0, MAX_KEYS)) out[k] = toJson(obj[k])
      if (keys.length > MAX_KEYS) out['…'] = `另有 ${keys.length - MAX_KEYS} 个键`
      return out
    }
    return String(v) // function / symbol 等：转为可读串（配置里本不该有，但不静默丢）
  }

  return {
    cccRoot: root,
    sections: Object.keys(cfg),
    values: toJson(cfg),
    note: '这是**现值摘要**（只报有值的键、超长已截断）。每段怎么填、填错会怎样 ⇒ container_admin config docs config',
  }
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 管理域（container_admin 一级参数）。`role` 是**过渡别名**，不在 enum 里。 */
type AdminDomain = 'config' | 'msm'

/** 过渡别名表：旧域 → 新域（只读兼容；文案不教它） */
const DOMAIN_ALIASES: Record<string, AdminDomain> = {
  role: 'config',
}

const DOMAIN_INTRO: Record<AdminDomain, string> = {
  config:
    'CCC configuration: docs (usage-manual index) / docs <chapter> (one chapter in full) / view (current values) ' +
    '+ 轨迹约束 (guide/validate/apply/list — the old role domain, merged here)',
  msm: 'MSM registry management: register / deregister / check (DC-M1~M4 quality) / guide (dev manual) / catalog (ACC capability directory) / ccc-config (CCC config reference)',
}

/** 管理面动作映射：domain → 可执行 action（转发到底层 runMsm / 轨迹约束 逻辑） */
const ADMIN_ACTIONS: Record<AdminDomain, readonly string[]> = {
  // 轨迹约束 四动作（原 role 域）＋ 说明两层菜单 ＋ 现值
  config: ['docs', 'view', 'guide', 'validate', 'apply', 'list'],
  msm: ['register', 'deregister', 'check', 'guide', 'catalog', 'ccc-config'],
}

/** 合法 domain 名（拒绝文案与 schema enum 同源——不得各写一份） */
const DOMAIN_NAMES = Object.keys(ADMIN_ACTIONS) as AdminDomain[]

/**
 * 说明目录的章节（**说明类内容的唯一注册处**）。
 *
 * 🔴 两条纪律：
 * ① **加一章 = 在这里加一项**（`render` 惰性求值）——说明类内容增长时**不新增工具/子命令**。
 * ② **正文不复制**：每章的真相源就在它自己的函数里（`CCC_CONFIG_REFERENCE` /
 *    `TRAJECTORY_CONSTRAINT_GUIDE` / `ACC_CATALOG`）——本表只做**切分与路由**。
 *
 * ## 🔴 2026-10-19 v1.75.0：说明面统一（owner 裁 Q3 = 指针）
 *
 * 统一前有 **5 个并列入口**，其中两组返回**同一份正文**：
 * `docs config` ≡ `msm ccc-config`｜`docs trajectory-constraint` ≡ `config guide`｜
 * `msm catalog`（域挂错了：它描述整个 ACC，却挂在 MSM 注册表下）。
 *
 * ⇒ 统一后的分工（**一个内容一个正文入口**）：
 * - **`config docs <chapter>`** = 唯一正文入口
 * - `msm ccc-config` / `config guide` = **指针**（指向对应 chapter，不再返回正文）
 * - `msm catalog` = **指针**（指向 `catalog` 章）
 *
 * 判据依据：`praxis` 已经做对了这件事 —— `praxis eap` 返回正文、`praxis` 无参返回目录，
 * **没有第二个入口读同一份 EAP**。本表把同一形态搬到 config 域。
 */
const DOCS_CHAPTERS: readonly DocsChapter[] = [
  {
    id: 'catalog',
    summary: 'ACC 能力总目录——7 个能力分区，每区一句话 ＋ 去哪个子命令看详情',
    render: () => ACC_CATALOG,
  },
  {
    id: 'config',
    summary: 'CCC 配置全表——10 段各是什么、怎么填、填错会怎样（.opencode/serenity.json）',
    render: () => CCC_CONFIG_REFERENCE,
  },
  {
    id: 'trajectory-self',
    summary: '一条轨迹怎么描述自己——章程 PROMPT.md ／ 常驻声明（resident.serves）／ 三个载体的分工 ＋ 写完怎么验',
    render: () => TRAJECTORY_SELF_GUIDE,
  },
  {
    id: 'trajectory-constraint',
    summary: '轨迹约束（只讲限制面）：trajectory.json 的双白名单 ／ 模型 ／ 纪律参与项 ／ IM 路由',
    render: () => TRAJECTORY_CONSTRAINT_GUIDE,
  },
  {
    id: 'im-bridge',
    // 🔴 2026-10-22（owner：「ACC 没提供 IM 桥使用说明和账户查询方法，导致 CCC 没办法自己配路由」）：
    //    这一章补的就是那个缺口。读者是 **CCC 的 agent**，所以指针必须也从 `im-bridge`
    //    工具描述发出（D178：指针要从"使用者实际打开的那个工具"发出）——两处都已加。
    summary: 'IM 桥怎么用、怎么配路由、怎么查对方 id —— send/send-file/users/status/contacts 五个动作 ＋ 路由三步法（contacts → 写 → status 自检）',
    render: () => IM_BRIDGE_GUIDE,
  },
]

/**
 * 指针与章目的关系（v1.75.0）：
 * 被降级的旧入口（`msm catalog` / `msm ccc-config` / `config guide`）统一走
 * `config-docs.ts` 的 `docsPointer()` —— **只有一处实现**，避免两域各写一份文案而漂移。
 */

export function createContainerAdminTool(ctx: Context) {
  return defineTool({
    name: 'container_admin',
    description:
      'Container administration (the ship\'s maintenance bay — one entry for managing the CCC): ' +
      'config — CCC configuration: docs (usage-manual index) / docs <chapter> (one chapter in full) / view (current values) ' +
      '+ 轨迹约束 (guide/validate/apply/list); ' +
      'msm — MSM registry management (register/deregister/check quality DC-M1~M4) + manuals (guide dev manual / catalog ACC capability directory / ccc-config CCC configuration reference). ' +
      // 🔴 2026-10-20：把两个"轨迹自己的手册"提到顶层描述里。
      //    为什么必须在这里（R↓）：此前「怎么写章程／怎么声明常驻」藏在 config docs 的第二章，
      //    而**该读它的人（写自我声明的轨迹）用的是 cognitive_trajectory，不是本工具**
      //    ⇒ 两级指针都没指到，手册在事实上不可发现。
      'TRAJECTORY SELF-DOCS: a cognitive trajectory describing ITSELF — charter (PROMPT.md) / resident declaration / ' +
      'self-restriction (whitelists) ⇒ config docs trajectory-self; the restriction side only ⇒ config docs trajectory-constraint. ' +
      // 🔴 2026-10-22：同一条判据（D178）的第二个落点。IM 桥这一章读者是 **CCC 的 agent**，
      //    而 agent 发现"怎么配路由"的入口既可能是本工具（找手册），也可能是 `im-bridge`（干活）
      //    ⇒ 两端都要有指针；只从一端发，从另一端进来的人照样看不到。
      'IM BRIDGE: how to send / configure routes / look up the other party\'s channel user id — ' +
      'send / send-file / users / status / contacts + the three-step route recipe ⇒ config docs im-bridge. ' +
      'Execution of registered MSMs belongs to the msm tool; this tool manages the container.',
    parameters: {
      domain: {
        type: 'string',
        enum: DOMAIN_NAMES,
        required: true,
        description: 'Management domain: config (CCC configuration + 轨迹约束) / msm (MSM registry + manuals)',
      },
      action: {
        type: 'string',
        description:
          'Domain subcommand. config: docs / view / guide / validate / apply / list; ' +
          'msm: register / deregister / check / guide / catalog / ccc-config',
      },
      /** 第二层菜单参数：`config docs <chapter>`（缺省 = 目录） */
      chapter: {
        type: 'string',
        description: 'config docs only: chapter id (omit for the index; e.g. config / trajectory-constraint)',
      },
      // register 参数（msm 域）
      name: { type: 'string', description: 'MSM name (register/deregister)' },
      path: { type: 'string', description: 'register: script relative path inside root' },
      category: { type: 'string', description: 'register: mech | semi-mech' },
      description: { type: 'string', description: 'register: one-line description' },
      skill: { type: 'string', description: 'register: owning skill' },
      flags: { type: 'string', description: 'register: flags JSON string (e.g. [{"name":"x","type":"string"}] — type:"path" enables escape guard)' },
      usage: { type: 'string', description: 'register: custom usage (auto-generated by default)' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
      const sessionId = agentSessionId(exec)
      const rawDomain = String(args.domain ?? '')
      // 过渡别名：`role` → `config`（只读兼容，见文件头）
      const domain = (DOMAIN_ALIASES[rawDomain] ?? rawDomain) as AdminDomain
      const action = (args.action as string | undefined) ?? ''

      if (!DOMAIN_NAMES.includes(domain)) {
        // 拒绝文案只列新名：别名能用，但不教
        throw new Error(`container_admin requires domain: ${DOMAIN_NAMES.join(' | ')}`)
      }

      // 轨迹约束会话安全：config validate/apply/list/guide/docs/view 只读放行；
      // msm register/deregister 必拒
      if (domain === 'msm' && (action === 'register' || action === 'deregister')) {
        const gate = trajectoryConstraintMsmGate(root, sessionId, action, args.name as string | undefined)
        if (gate.reject) throw new Error(gate.reject)
      }

      // ── config 域 ──────────────────────────────────────────────────────
      if (domain === 'config') {
        switch (action) {
          // ── P3：两层菜单 ──
          case 'docs': {
            const chapter = (args.chapter as string | undefined)?.trim() ?? ''
            // 第一层：目录（**不触发任何正文**）
            if (chapter === '') return { docs: renderDocsIndex(DOCS_CHAPTERS), chapters: DOCS_CHAPTERS.map((c) => c.id) }
            // 第二层：按章详情
            const found = findDocsChapter(DOCS_CHAPTERS, chapter)
            if (found === null) {
              throw new Error(
                `container_admin config docs: unknown chapter "${chapter}". ` +
                  `Available: ${DOCS_CHAPTERS.map((c) => c.id).join(' | ')} (omit the chapter for the index)`,
              )
            }
            return { chapter: found.id, docs: found.render() }
          }
          // ── 现值（原 config 域的唯一动作） ──
          //
          // 🔴 2026-10-19 v1.75.0：`view` 曾转发 `msm ccc-config`（**返回整份配置全表正文**），
          //    而 `docs config` 返回的是**同一个常量** ⇒ 两个正文入口。现在 `view` 只回
          //    **现值摘要 ＋ 指针**：它这一格的语义本来就是"**看当前填了什么**"，
          //    而"这个键该怎么填"是 `docs config` 的事 —— 两件事本来就不该共用一个动作。
          case 'view':
          case '': {
            return {
              config: viewConfigSummary(root),
              docs: '完整配置说明（每段怎么填、填错会怎样）→ container_admin config docs config',
            }
          }
          // ── 原 role 域四动作（并入本域） ──
          // `guide` 降为指针（v1.75.0，owner 裁 Q3）：正文唯一入口 = `docs trajectory-constraint`
          case 'guide': return { guide: docsPointer('trajectory-constraint', '轨迹约束教程') }
          case 'validate': return validateTrajectoryConstraint(root)
          case 'apply': return applyTrajectoryConstraint(root)
          case 'list': return listTrajectoryConstraintSummary(root)
          default:
            throw new Error(`container_admin config requires action: docs | view | guide | validate | apply | list`)
        }
      }

      // ── msm 域 → 原 acc_msm 管理 action（exec 不在此——exec 走 msm 工具） ──
      if (domain === 'msm') {
        const mgmtActions: string[] = ['register', 'deregister', 'check', 'guide', 'catalog', 'ccc-config']
        if (!mgmtActions.includes(action)) {
          throw new Error(`container_admin msm requires action: ${mgmtActions.join(' | ')} (execution goes through the msm tool)`)
        }
        // 同步执行（register/deregister 走 git 精提交；check/guide/catalog/ccc-config 纯读）
        const out = runMsm(root, {
          action: action as (typeof MSM_ACTIONS)[number],
          name: args.name as string | undefined,
          skill: args.skill as string | undefined,
          path: args.path as string | undefined,
          category: args.category as string | undefined,
          description: args.description as string | undefined,
          flags: args.flags as string | undefined,
          usage: args.usage as string | undefined,
        })
        // v1.34.1：原 SEP（Session Extension Protocol）章节已随 SEP 废除一并移除
        // （所有者裁决「能落 harness 已有原语，就不要自造协议 + 脚本管道」）——手册只留 MSM 通用内容。
        // 轨迹挂 skill 的扩展面见 docs/cognitive-trajectory-skill-injection.md（SESSION.md frontmatter + section）。
        return out
      }

      throw new Error(`container_admin requires domain: ${DOMAIN_NAMES.join(' | ')}`)
    },
  })
}
