/**
 * trajectory-constraint-admin.ts — 轨迹约束面逻辑层（公开入口 = `container_admin` 的 `role` 域）
 *
 * 三动作分工（用户拍板 2026-08-28，2026-10-19 重做后语义不变）：guide 定义教程 ／
 * validate 校验 ／ list 摘要 ／ apply 显式应用确认。
 *
 * ## 🔴 2026-10-19 重做后，本文件的**数据源变了**
 *
 * 旧：读 `.opencode/serenity.json` 的 `轨迹约束.roles`（容器级配置表）。
 * 新：读**轨迹目录里的 `trajectory-constraint.json`**（owner：「目录下拥有 `trajectory-constraint.json` 的认知轨迹自动是一个 轨迹约束」）。
 * ⇒ `constraintCount` 的语义 = **本 CCC 有几条 轨迹约束轨迹**；"角色名"这个概念没有了，只有**轨迹编码**。
 *
 * 归属（D23）不变：ACC 提供机制（教程 + 校验 + 列表），**约束内容归 CCC**（写进 `trajectory-constraint.json`）。
 */

import type { JsonValue } from '../kernel/json.js'
import { resolveInside } from '../kernel/ccc.js'
import { constraintSystemPromptSource, constraintCognitiveTrajectory, resolveConstraintSystemPrompt, TRAJECTORY_CONSTRAINT_HINT } from '../trajectory/policy/rules.js'
import { listTrajectoryConstraints, TRAJECTORY_CONSTRAINT_FILENAME } from '../trajectory/policy/profile.js'
import { TRAJECTORY_FILENAME, TRAJECTORY_LEGACY_FILENAMES } from '../trajectory/policy/files.js'
import { hasTrajectoryPrompt, TRAJECTORY_PROMPT_FILENAME } from '../trajectory/prompt.js'
import { loadMsmEntries } from './msm/service.js'

/**
 * 轨迹约束 定义教程：**只讲「限制面」**（约束面 / 双白名单 / 纪律参与项 / 路由）。
 *
 * 🔴 2026-10-20 拆分（owner 裁 Q2）：本章原先同时承载「描述自己」与「限制自己」。
 * 两者读者与前提不同 —— **描述自己是所有轨迹的常态，限制自己才是特例** ——
 * 故「章程 / 常驻 / 三个载体」已移入 `config docs trajectory-self`。
 * ⛔ **本文件不再重复那份内容**（一个内容一个正文入口，v1.75.0 指针纪律）。
 */
export const TRAJECTORY_CONSTRAINT_GUIDE = `═══ 轨迹约束 Guide（限制面；2026-10-20 split）═══

**A 轨迹约束 IS a cognitive trajectory — the one whose directory contains \`${TRAJECTORY_CONSTRAINT_FILENAME}\`.**
That is the whole rule. No role table, no name registry: put the file there and the trajectory
becomes a 轨迹约束; delete it and it goes back to being an ordinary trajectory (takes effect at once).

⚠️ **本章只讲"限制自己"。** 想写章程（PROMPT.md）或声明常驻（resident）?
   → \`container_admin config docs trajectory-self\`（那是**所有轨迹**都用得上的自述手册）。

  AGENT_SESSIONS/<YYYY-MM-DD--<code>--<desc>>/
    ├─ SESSION.md      ← its persistent body (this IS the workspace — nothing is auto-created)
    ├─ PROMPT.md       ← its charter (see trajectory-self; NOT copied here)
    ├─ ${TRAJECTORY_CONSTRAINT_FILENAME}          ← its declaration (this file is what makes it a 轨迹约束)
    └─ continuous-re-occurrence.ts  ← optional CRO program (spawned, never imported)

  The older names ${TRAJECTORY_LEGACY_FILENAMES.map((n) => `\`${n}\``).join(' / ')} are still READ
  (the family is checked in that order) — writing goes to \`${TRAJECTORY_FILENAME}\` only.

── ${TRAJECTORY_CONSTRAINT_FILENAME} schema（限制面部分）──
  {
    "model": "provider/model",          // optional; **不写 = 用会话当前模型**（不会回退到任何别处；每轮生效）
    "tools": ["read","grep","msm",...], // optional; **不写 = 不收窄**。显式 [] = 全隐藏（除 skill）
    "msms":  ["msm-a","msm-b"],         // optional; **不写 = 不收窄**。显式 [] 或非空 = register/deregister 拒
    "writes": ["AGENT_SESSIONS/<我的目录>/"], // optional; **不写 = 不收窄**。显式 [] = 一个写都落不下
    "cognitiveTrajectory": { "session": true, "keeper": true, "rebuild": true },  // 缺省 TRUE（见下）
    "resident": { "serves": "..." },    // optional; 对外用途自述（见 trajectory-self 章）
    "cro": { "host": "<machine name>" },// optional: which machine may run this trajectory's CRO program
    "prompt": { "injection": "replace", "replaces": ["metaphor","cce"] } // optional; 注入面（见下）
  }

  🔴 **\`prompt\` 是「替换面」，不属于上面的限制面**（2026-11-17 补写，此前只在代码里存在）：
     它决定**哪些 ACC 注入块被本轨迹自己的 PROMPT.md 取代**。
     · \`injection\`：\`"replace"\` = 用 PROMPT.md 整体取代 \`replaces\` 列出的那些块；
     · \`replaces\`：块名列表（例 \`["metaphor","cce"]\`）。
     🔴 **身份块（\`=== Serenity ACC ===\`）刻意不可替换** —— 那是容器的身份，换掉它就不再是同一个容器。
     判据与允许清单的唯一真相源 = \`trajectory/prompt-injection.ts\`（此处不重复抄）。

  🔴 **所有 key 都是可选的：不写 = 不设定 = 不影响默认行为**（owner 2026-10-20 裁决）。
     ⛔ **"没写" ≠ "写了空数组"**：\`"tools": []\` 是"我一个都不给"（除 \`skill\` 外全隐藏）；
        **不写 \`tools\`** 是"不收窄"。这两者在旧版被混成同一个意思，害人把自己锁死过。

  ⚠️ 提示词**不在这里**（新形态）：写 \`PROMPT.md\` 即可，**所有轨迹**都适用。
     旧字段 \`systemPromptFile\` / \`systemPrompt\` 属**兼容期**形态，仍在读、但不再推荐；
     两者同时存在时 \`PROMPT.md\` 让位规则见 \`trajectory/prompt.ts\`（此处不重复）。

  ⚠️ **只想声明常驻、不想限制自己**：只写 \`"resident"\` 字段，**tools/msms 一个都不要写**。
     ⇒ 不收窄任何工具面（见下方"两个默认"）。⛔ **不要**为了"空着"而写 \`"tools": []\` —— 那是全隐藏。

  🔴🔴 **register/deregister 按 \`msms\` 判，不按"文件在不在"判**（2026-11-19 修正，此前是实现与文档不符）：
     · **没写 \`msms\`** ⇒ 不收窄 ⇒ **\`container_admin msm register/deregister\` 放行**
       （此前它对**任何**带该文件的轨迹恒拒 —— 于是"只写 resident"这个本文件推荐的写法，
        静默附带了『注册权没了』这个代价，而文档一个字没提。butler 三次实测报出来的。）
     · **写了 \`msms\`（含显式 \`[]\`）** ⇒ 那条轨迹的 MSM 能力面已被声明收窄 ⇒ **拒**（原语义保留）。
     ⚠️ **反对面**：注册表是容器级共享结构，写坏会影响全体。但"恒拒"拦不住真正危险的写入
        （那条轨迹只要还有 \`write\` 就能直接改注册表文件），它只拦住了一个**正常且被文档推荐**的动作，
        且**没有任何读数**说出这件事。⇒ 判据：**收窄必须发生在被声明的维度上，⛔ 不能是"写了文件"的副作用。**

── Two whitelists: UNSET means unrestricted, EMPTY means nothing ──
  - **字段缺省（没写）** = **不收窄**（这条轨迹只放别的设定，比如只写 resident）
  - \`"tools": []\`（显式空数组）= **全隐藏**，除恒可用的 \`skill\`
  - \`tools\` + non-empty \`msms\` = pure-MSM trajectory (the usual knowledge-QA shape)
  - non-empty \`msms\` ⇒ the \`msm\` tool is added automatically (the only entry point for MSMs)
  - anything outside a **declared** whitelist is invisible in the schema, not merely rejected at call time
  🔴 判据是**字段在不在**，不是**数组空不空**（D181）。旧版把两者混成"空 = 全拒"，
     于是「只想声明常驻」的人被静默锁死 —— 那是本仓实测踩过的坑（D179(b)）。

  🔴🔴 **管辖范围（2026-11-17 限定，此前这句话说得太满）**：
     \`tools\` 只管辖**本插件（ACC）贡献的工具**（当前 13 个：
     \`container_fs\`/\`container_git\`/\`container_admin\`/\`cognitive_trajectory\`/\`dashboard\`/\`msm\`/
     \`praxis\`/\`ontology\`/\`serenity-skill-creator\`/\`localstore\`/\`browser_slot\`/\`im-bridge\`/\`diagram\`）。
     **宿主平台自带的工具恒可用、不受这份声明约束** —— 例：\`read\`/\`write\`/\`grep\`/\`glob\` 这类基础工具、
     \`todo_write\`、目标类（\`create_goal\`/\`get_goal\`/\`update_goal\`）、\`present\`、
     子代理类（\`subagent\`/\`subagent_fork\`/\`list_agents\`/\`interrupt_agent\`/\`send_message\`）、
     \`list_subagent_models\`。
     ⚠️ **不要把它读成"白名单外一切不可见"** —— 那句话只对 ACC 工具成立。
     ⇒ 要判"某个平台工具能不能给某条轨迹"，那是**宿主的能力面**，不是本文件的管辖面；
        真正的收紧办法是不给那条轨迹 \`subagent\` 之类的**宿主级配置**（属另一层裁决）。

── \`writes\`: the THIRD whitelist — the PATH dimension（owner 2026-10-20 令）──
  \`tools\` 管的是**工具名**，管不了"这个工具能写哪儿"：给了 \`write\` 之后，路径守卫只拦
  「逃出 CCC」与黑名单，**拦不住它去写别人的轨迹或 docs/**。\`writes\` 补的正是这一维。

  - **不写** ⇒ 不收窄（写权限 = 路径守卫那几条，与之前完全一致）
  - \`"writes": []\` ⇒ **一个写都落不下**（显式意图；只影响写，不影响读）
  - \`"writes": ["AGENT_SESSIONS/<我的目录>/", "_tmp/"]\` ⇒ 写类工具的**目标路径**必须落在这些前缀内
  - 条目可以是**相对 CCC 根**的路径，也可以是绝对路径；判定按"目标在这个目录之内（含自身）"
  - 只管**写类**工具（\`write\` / \`edit\` / \`container_fs\` 的写动作 / \`append\` / \`touch\`），**读不受影响**
  - 越界拒绝时**会指名允许的前缀与当前目标**（D186：不许不出声；出声必须指对路）

  ⇒ 典型用法（两条 IM 轨迹）：给 \`write\`/\`edit\` 写自己的身体，同时把写面收窄到自己那一格：
     \`"tools": ["read","write","edit",...], "writes": ["AGENT_SESSIONS/<code 目录>/"]\`

── cognitiveTrajectory: why the defaults are TRUE ──
  The workspace of a 轨迹约束 is its own SESSION.md. Setting these to false would cut it off from
  its own body, so \`session\`/\`keeper\`/\`rebuild\` all default to true. Set false explicitly only
  when you deliberately want that participation off.

── IM routing: user → trajectory code（微信 / 飞书同一张表）──
  \`im.routes\`: \`[{ "user": "<channel user id or *>", "trajectory": "<code>" }]\`
  A route pointing at a code with no such trajectory is a hard error (the message is NOT delivered).
  A trajectory WITHOUT \`${TRAJECTORY_CONSTRAINT_FILENAME}\` is still a legal target — it is just an ordinary trajectory.

── Operating it ──
  Everything is read live: saving \`${TRAJECTORY_CONSTRAINT_FILENAME}\` takes effect on the next turn, no restart.
    (The prompt FILE hot-reloads by mtime; the JSON itself is re-read every turn.)
  After editing, run container_admin config apply for an explicit validation + confirmation pass.
  Skill loading is always available to 轨迹约束 sessions (skills are not whitelisted — they are read-only knowledge).

  写完之后怎么验 → container_admin config docs trajectory-self 的「写完之后怎么验」段（同一套判据，不复制）。`

/** 校验当前 CCC 的 轨迹约束面：msms 均已注册 ／ 提示词非空 */
export function validateTrajectoryConstraint(root: string): JsonValue {
  const profiles = listTrajectoryConstraints(root)
  const issues: string[] = []
  if (profiles.length === 0) {
    return {
      ok: true,
      issues: [],
      constraintCount: 0,
      note: `no 轨迹约束 trajectories in this CCC (no trajectory has ${TRAJECTORY_CONSTRAINT_FILENAME} — zero impact)`,
    }
  }
  const registered = new Set(loadMsmEntries(root).map((e) => e.name))
  for (const p of profiles) {
    // 提示词来源解析——**两条来源，任一非空即可**（v1.72.0 起）：
    //   ① 轨迹目录的 `PROMPT.md`（**新形态**：轨迹提示词，所有轨迹都适用）
    //   ② trajectory-constraint.json 的 `systemPromptFile` / `systemPrompt`（**兼容期**旧形态）
    //
    // 🔴 2026-10-19 修（T4）：旧判据只看② ⇒ 只写 `PROMPT.md` 的轨迹会被误报
    //    "system prompt is empty"。那是**读数器过时**，不是配置缺失。
    const hasTrajectoryPromptOrLegacy = hasTrajectoryPrompt(root, p.dirName) || (() => {
      try {
        return resolveConstraintSystemPrompt(root, p).trim() !== ''
      } catch (err) {
        issues.push(`trajectory "${p.code}": ${String((err as Error)?.message ?? err)}`)
        return true // 已在上面报过，不再叠一条"empty"
      }
    })()
    if (!hasTrajectoryPromptOrLegacy) {
      issues.push(`trajectory "${p.code}": no trajectory prompt (add ${TRAJECTORY_PROMPT_FILENAME} in the trajectory dir — recommended — or the legacy systemPromptFile/systemPrompt)`)
    }
    for (const m of p.msms ?? []) {
      if (!registered.has(m)) issues.push(`trajectory "${p.code}": msms "${m}" is not registered in mech-registry.json`)
    }
    // 写路径白名单：条目写成绝对路径且**逃出 CCC** ⇒ 那多半是抄了别人的机器路径（永远匹配不上），
    // 静默不生效比报错更坏 ⇒ 这里点名（不判对错：它是配置，不是攻击面 —— 逃逸的写本来就被路径守卫拦）。
    for (const w of p.writes ?? []) {
      try {
        resolveInside(root, w)
      } catch (err) {
        issues.push(
          `trajectory "${p.code}": writes "${w}" is outside the CCC root (${String((err as Error)?.message ?? err)})`
          + ' — a write prefix outside the container can never match; use a path relative to the CCC root',
        )
      }
    }
    // 🔴 2026-10-28（cheap-worker 下线）：此处原有「`p.model` 必须在 `cheap-worker.models` 白名单内」
    //   一条校验 —— 白名单随工具一起删除 ⇒ **它失去了判据来源**。
    //   而模型合法性有更权威的判据（`trajectory/model-runtime.ts`：宿主报非法模型 ⇒ 不切＋响亮告警）
    //   ⇒ 删掉它**不是丢保护，是去掉与权威判据并行的第二真相源**（D131 同族）。
  }
  return { ok: issues.length === 0, issues, constraintCount: profiles.length }
}

/** 列出当前 CCC 的轨迹约束（编码 ／ 模型 ／ msms ／ tools ／ 纪律摘要 ／ 提示词来源） */
export function listTrajectoryConstraintSummary(root: string): JsonValue {
  const profiles = listTrajectoryConstraints(root)
  if (profiles.length === 0) {
    return { roles: [], note: `no 轨迹约束 trajectories in this CCC (no trajectory has ${TRAJECTORY_CONSTRAINT_FILENAME})` }
  }
  const items = profiles.map((p) => {
    /**
     * 🔴 三个字段的读数必须**如实表达三态**（D179(c)＋D181，S196 就是被这里的旧读数误导的）。
     *
     * | 文件里 | 打印 | 为什么不能印别的 |
     * |---|---|---|
     * | 没写 `model` | `'(unchanged)'` | 旧文案印 `'(cheap-worker default)'` ⇒ **暗示会回退到杂工模型**，而实际是**不动**。那是一次**空头承诺**：用户以为要被换模型，其实是误解 |
     * | 没写 `tools`/`msms` | `'(unrestricted)'` | 缺省 = **不收窄**（D181）。印 `[]` 会让人以为"我被全隐藏了" |
     * | 写了 `[]` | `'[]'` | 显式空数组 = **全隐藏**，与上一行**恰好相反**，必须能一眼分辨 |
     */
    const wl = (v: string[] | undefined, whenUnset: string): JsonValue => (v === undefined ? whenUnset : v)
    return {
      // ⚠️ 键名沿用 `name`（面板/工具回执形状不变），值 = **轨迹编码**（新模型里的身份）
      name: p.code,
      dirName: p.dirName,
      model: p.model ?? '(unchanged)',
      msms: wl(p.msms, '(unrestricted)'),
      tools: wl(p.tools, '(unrestricted)'),
      // 写路径白名单（owner 2026-10-20 令）：三态同上 —— 没写 = 不收窄、写了 [] = 一个都写不了
      writes: wl(p.writes, '(unrestricted)'),
      // 常驻自述（D173）：没写就不出现 —— 它是"我欢迎被找到"的声明，不是状态位
      ...(p.resident !== undefined ? { resident: p.resident.serves !== undefined ? p.resident.serves : '(no serves)' } : {}),
      cognitiveTrajectory: constraintCognitiveTrajectory(p) satisfies Record<string, boolean>,
      // 🔴 两条来源都要报（v1.72.0 起 `PROMPT.md` 是新形态且优先）：只报旧形态会让
      //    "只写了 PROMPT.md 的轨迹"显示成 `none` —— 那是读数器过时，不是配置缺失。
      promptSource: constraintSystemPromptSource(p, hasTrajectoryPrompt(root, p.dirName)),
      ...(p.systemPromptFile ? { systemPromptFile: p.systemPromptFile } : {}),
    }
  })
  return { roles: items, count: items.length }
}

/**
 * 应用当前 轨迹约束 配置（S142 用户：改了 json 应该有个生效机制）。
 *
 * 语义：约束面是**每轮实时读取**的 ⇒ apply 不是"推送"，而是**显式校验 + 应用确认**：
 * ① 校验合法（复用 validate：msms 注册 / model 白名单 / 提示词非空）
 * ② 非法 → 报告问题清单，不应用（提示修复后重跑 apply）
 * ③ 合法 → 应用确认：绑定 CCC + 轨迹清单 + 说明（下一轮即生效）
 */
export function applyTrajectoryConstraint(root: string): JsonValue {
  const validation = validateTrajectoryConstraint(root) as { ok: boolean; issues: string[]; constraintCount: number }
  const profiles = listTrajectoryConstraints(root)
  if (!validation.ok) {
    return {
      applied: false,
      cccRoot: root,
      constraintCount: profiles.length,
      issues: validation.issues,
      hint: 'fix the issues above, then run container_admin config apply again',
    }
  }
  return {
    applied: true,
    cccRoot: root,
    constraintCount: profiles.length,
    roles: profiles.map((p) => p.code),
    note: `constraints are read live from each trajectory's ${TRAJECTORY_CONSTRAINT_FILENAME} — they take effect on the next turn (no restart); ${TRAJECTORY_CONSTRAINT_HINT}`,
  }
}
