/**
 * trajectory/policy/profile.ts — **轨迹约束的唯一判据**：目录下有 `trajectory-constraint.json` 的认知轨迹（零 DSH 依赖，可独立单测）
 *
 * ## 🔴 owner 2026-10-19 重做令（逐字，本文件存在的全部理由）
 *
 * > 「轨迹约束 复杂的约束和提示词体系都干掉，改为这样的实现：
 * > **轨迹约束本身是认知轨迹的一个特殊情况，即目录下拥有 `trajectory-constraint.json` 的认知轨迹自动是一个 轨迹约束**
 * > （json 里配置上个版本就有的各种约束），**会话跑在认知轨迹上且发现 `trajectory-constraint.json`，则运行时实现各类约束**」
 *
 * ## 旧模型 → 新模型（**一条判据取代四条**）
 *
 * | 项 | 旧 | 新 |
 * |---|---|---|
 * | 轨迹约束是什么 | `serenity.json` 的 `轨迹约束.roles.<name>` 一条配置 | **轨迹目录里有 `trajectory-constraint.json`** |
 * | 怎么认出 轨迹约束会话 | dsh sessionId 前缀 `轨迹约束-` | **它绑定的轨迹有 `trajectory-constraint.json`** |
 * | 工作台从哪来 | `ensureTrajectorySession` 另建一个 SESSION | **就是该轨迹自己的 SESSION.md** |
 * | 身份 | 角色名 | **轨迹编码**（`trajectory/core.ts` 的 `parseTrajectoryCode`） |
 *
 * ⇒ 收益（owner：「理解难度大幅下降」的实际内容）：四个各自会漂的机制收敛为**一条文件存在性判据**。
 * 删掉 `trajectory-constraint.json` ⇒ 该轨迹**当场**退化为普通轨迹（工具面、提示词、keeper 全部恢复默认）。
 *
 * ## 归属（D23）
 * **机制在 ACC**（文件叫什么、怎么读、怎么判、缺省值、如何施加约束）；
 * **内容在 CCC**（`trajectory-constraint.json` 里填什么：模型、白名单、提示词路径）。
 * ⇒ ACC 代码里**不出现任何具体角色名**，也不读 `serenity.json` 的 轨迹约束段（该段已退役）。
 *
 * ## S12（2026-10-19，轨迹中心重构）：此前位于 `role/轨迹约束/` 下（该目录已随本重构消失）
 *
 * 落点 = `trajectory/policy/`。判据（判读表 §3.1）：本文件判的是**某条轨迹的约束面**，
 * 主语是轨迹 ⇒ 它一直就是轨迹切面，只是旧目录把它挂在"角色"这个**平行概念**下。
 * ⚠️ **文件名 `profile` 与 `trajectory-constraint.json` / `TrajectoryConstraint` 等符号名一律不动**：
 * 那是有具体指称的东西（一个固定文件名 ＋ 它的解析结果），不是组织单位。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readUtf8, resolveInside } from '../../kernel/ccc.js'
import { parseTrajectoryCode, sessionsRoot } from '../core.js'
import { listBindDeclarations } from '../bind-file.js'
import { trajectoryDirNameForSession } from './window.js'
import type { RawPromptInjection } from '../prompt-injection.js'
import {
  findTrajectoryFile,
  readTrajectoryFile,
  TRAJECTORY_FILENAME,
  TRAJECTORY_FILENAME_FAMILY,
} from './files.js'

/**
 * 🆕 **声明文件的文件名**（2026-10-19 owner 裁 Q2：短名 `trajectory.json`）。
 *
 * ⚠️ **判据不是"这个名字在不在"**，而是**族内任一存在**（`TRAJECTORY_FILENAME_FAMILY`）。
 * 这个名字只是**写入目标**与**提示文案里该印的那个**。
 */
export const TRAJECTORY_CONSTRAINT_FILENAME = TRAJECTORY_FILENAME

/**
 * 一个 轨迹约束轨迹的**完整约束面**（= 旧 `轨迹约束.roles.<name>` 那套，整体搬进轨迹目录）。
 *
 * ⚠️ 与旧配置的**一处有意语义翻转**（R↓，别当成"顺手改默认值"）：
 * `cognitiveTrajectory.*` 在旧模型里**缺省全 false**（"轨迹约束 完全独立"），理由是
 * **它的工作台是外挂的**（`ensureTrajectorySession` 另建一个 SESSION，不由轨迹承载）。
 * 新模型里**工作台就是它自己的 SESSION.md** ⇒ 全 false 会让它拿不到自己的身体
 * ⇒ **缺省翻成 true**。这不是偏好问题，是两个模型的结构差。
 */
export interface TrajectoryConstraint {
  /** 该约束面所属轨迹的目录名（`YYYY-MM-DD--<code>[--<desc>]`） */
  dirName: string
  /** 轨迹编码（= 唯一标识；见 `parseTrajectoryCode`） */
  code: string
  /** `trajectory-constraint.json` 的绝对路径 */
  path: string
  /** 模型（`provider/model`）；缺省 ⇒ 不改变会话当前模型（**不**回退到任何别处），见 D181 */
  model?: string
  /**
   * 非 MSM 工具白名单。
   *
   * 🔴 **D181（owner 2026-10-20 裁「不写当然不收窄」）：
   * `undefined` = 字段缺省 ⇒ **不收窄**；`[]` = 显式空数组 ⇒ **全隐藏**（除恒可用的 `skill`）。**
   * 两者是**不同的意图**，故类型必须是 `string[] | undefined`，不能归一成 `[]`。
   */
  tools?: string[]
  /** MSM 白名单；缺省/空数组语义同 `tools`（D181） */
  msms?: string[]
  /**
   * **写路径白名单**（owner 2026-10-20 令：「ACC 如果支持轨迹设定自己的写白名单就好了」）。
   *
   * `tools` 只管**工具名**，管不了"这个工具能写哪儿"——一旦给了 `write`，路径守卫只拦
   * "逃出 CCC"与黑名单，**拦不住它去写别人的轨迹或 `docs/`**。本字段补的就是这一维。
   *
   * 🔴 判据与 D181 同一条：**字段在不在，不是数组空不空**。
   * - 缺省（`undefined`）⇒ **不收窄**（写权限 = 路径守卫那几条）；
   * - `[]` ⇒ **一个写都落不下**（显式意图，不告警）；
   * - 非空 ⇒ 写类工具的**目标路径**必须落在这些前缀内（相对 CCC 根，或其绝对路径）。
   *
   * 只约束**写类**工具（`write`/`edit`/`container_fs` 写动作/`append`/`touch`）；读不受影响。
   */
  writes?: string[]
  /** 轨迹纪律参与项（**缺省全 true**，见上方 R↓） */
  cognitiveTrajectory: { session: boolean; keeper: boolean; rebuild: boolean }
  /** 内嵌提示词（`systemPromptFile` 为空时用） */
  systemPrompt?: string
  /** 提示词文件（相对 CCC 根；**优先于** `systemPrompt`） */
  systemPromptFile?: string
  /**
   * 常驻自述（D173）：我对**自己用途**的公开声明。
   *
   * 🔴 它**不是**资源状态（不是"永不休眠"），**不碰**载体生命周期，
   * **不进系统提示词**（不占每轮 token）—— 只被 `cognitive_trajectory` 的
   * `resident` 只读动作按需查出。两句判据：管的是**被找到**，不是**不被销毁**。
   */
  resident?: { serves?: string }
  /**
   * **提示词注入模式**（owner 2026-10-20 令）—— 轨迹提示词**怎么**进入系统提示词。
   *
   * - 缺省（字段不写）⇒ `append`：容器与质量各块照常注入，轨迹提示词追加在第 ⑧ 位。
   * - `{ "injection": "replace", "replaces": [...] }` ⇒ 轨迹提示词**取代**指定的约束块
   *   （`metaphor` / `principles` / `cce` / `eap`；缺省全换），并站到它们的原位上。
   *   **身份块（`=== Serenity ACC ===`）刻意不可替换** —— 判据见 `trajectory/prompt-injection.ts`。
   *
   * ⚠️ 本字段**只搬运值**，合法性与降级判决在 `planPromptInjection()`（纯函数、可单测）；
   * 两份实现会让"文件里写的"与"实际生效的"分叉。
   */
  prompt?: RawPromptInjection
}

/**
 * 已告警过的坏 `trajectory-constraint.json`（进程级去重：同一坏文件不刷屏，但**绝不静默**）。
 *
 * 🔴 为什么必须响亮（同源先例 = `loadSerenityConfig` 的 F-07）：一份坏 JSON 会让
 * **工具白名单静默失效**——而白名单正是 轨迹约束的权限边界 ⇒ 静默 = 权限面悄悄放开或收死，
 * 两种都查不到原因。
 */
const warnedBrokenProfiles = new Set<string>()

/** 活跃轨迹目录名（跳过 `_`/`.` 前缀 —— 归档区与日志区不是轨迹；判据同 `readAllSessions`） */
function activeTrajectoryDirNames(root: string): string[] {
  try {
    return readdirSync(sessionsRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return [] // 没有 AGENT_SESSIONS/ = 没有轨迹（常态，不是错误）
  }
}

/**
 * 读一个目录下的 `trajectory-constraint.json`（**纯读，不施加约束**）。
 *
 * @param trajectoryDir 轨迹目录绝对路径
 * @param root CCC 根（仅用于 `systemPromptFile` 的逃逸拒绝）
 * @returns 归一后的约束面；**无该文件 → `null`（= 这不是 轨迹约束，常态，不是错误）**
 *
 * ⚠️ **形态容错**：数组元素非字符串 → 丢弃该项（不整份作废）；`cognitiveTrajectory`
 * 缺项 → 各自取 **true**（见 R↓）；`model` 空白 → undefined（回退缺省）。
 * 坏 JSON ⇒ 告警 + `null`（**按"不是 轨迹约束"处理**：宁可让它退回普通轨迹，也不要带着
 * 半份读不懂的权限面运行）。
 */
export function readTrajectoryConstraintAt(trajectoryDir: string, root: string): TrajectoryConstraint | null {
  const dirName = trajectoryDir.split('/').filter(Boolean).pop() ?? ''
  const code = parseTrajectoryCode(dirName)
  if (code === null) return null
  // 🔴 认**族**（`trajectory.json` → `trajectory-constraint.json` → `skiff.json`），不认单点文件名。
  const found = findTrajectoryFile(trajectoryDir)
  if (found === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(readUtf8(found))
  } catch (err) {
    if (!warnedBrokenProfiles.has(found)) {
      warnedBrokenProfiles.add(found)
      console.warn(
        `[serenity-hooks] ✗ ${TRAJECTORY_FILENAME} 解析失败 ⇒ 该轨迹**按普通轨迹处理**（工具白名单与提示词约束全部不施加）。请修 JSON: ${found} — ${String((err as Error)?.message ?? err)}`,
      )
    }
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (!warnedBrokenProfiles.has(found)) {
      warnedBrokenProfiles.add(found)
      console.warn(`[serenity-hooks] ✗ ${TRAJECTORY_FILENAME} 顶层不是对象 ⇒ 按普通轨迹处理: ${found}`)
    }
    return null
  }
  const obj = raw as Record<string, unknown>
  const file = found
  /**
   * 白名单字段的**两态**读取（D181，owner 2026-10-20 裁「不写当然不收窄」）：
   *
   * | 文件里 | 返回 | 语义 |
   * |---|---|---|
   * | 字段**不存在** | `undefined` | **不收窄**（这条轨迹要的是别的设定，比如只写 `resident`） |
   * | `[]`（显式空数组） | `[]` | **全隐藏**（除恒可用的 `skill`）—— 用户明说了"我一个都不给" |
   * | `["a","b"]` | `["a","b"]` | 只给这些 |
   *
   * 🔴 **为什么不能归一成 `[]`**：那会把"我没提这件事"读成"我要禁止一切"，
   * 于是「只想声明常驻」的人会被静默锁死（S196 实测踩到，见 D179(b)）。
   * 判据是**字段在不在**，不是数组空不空。
   */
  const strListMaybe = (v: unknown): string[] | undefined =>
    v === undefined
      ? undefined
      : Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
        : undefined // 不是数组 ⇒ 当作没写（宽松，不整份作废）
  /** 布尔缺省 **true**（R↓ 见接口：工作台就是这条轨迹自己的身体） */
  const boolOrTrue = (v: unknown): boolean => (typeof v === 'boolean' ? v : true)
  const ct = (obj.cognitiveTrajectory && typeof obj.cognitiveTrajectory === 'object')
    ? obj.cognitiveTrajectory as Record<string, unknown>
    : {}
  const model = typeof obj.model === 'string' && obj.model.trim() !== '' ? obj.model.trim() : undefined
  const systemPrompt = typeof obj.systemPrompt === 'string' ? obj.systemPrompt : undefined
  const rawFile = typeof obj.systemPromptFile === 'string' ? obj.systemPromptFile.trim() : ''
  // `systemPromptFile` **只做逃逸拒绝**（不在这里读文件：读取有它自己的 mtime 缓存与热重载路径）。
  // 逃逸 ⇒ 当作没配（告警），而不是让一个越界路径把整个会话的提示词弄空。
  let systemPromptFile: string | undefined
  if (rawFile !== '') {
    try {
      resolveInside(root, rawFile) // 逃逸 → throw
      systemPromptFile = rawFile
    } catch (err) {
      console.warn(
        `[serenity-hooks] ✗ ${TRAJECTORY_CONSTRAINT_FILENAME} 的 systemPromptFile 越界，已忽略（其余约束仍生效）: ${file} — ${String((err as Error)?.message ?? err)}`,
      )
    }
  }
  // 常驻自述（D173）：`serves` 非空才算"可被判断"（见 `trajectory-self-docs.ts` 的两门槛）
  const residentRaw = obj.resident
  let resident: { serves?: string } | undefined
  if (residentRaw && typeof residentRaw === 'object' && !Array.isArray(residentRaw)) {
    const serves = (residentRaw as Record<string, unknown>).serves
    resident = typeof serves === 'string' && serves.trim() !== '' ? { serves: serves.trim() } : {}
  }
  const tools = strListMaybe(obj.tools)
  const msms = strListMaybe(obj.msms)
  const writes = strListMaybe(obj.writes)
  /**
   * 提示词注入模式（owner 2026-10-20）：只搬运，不判决。
   *
   * 🔴 判决在 `planPromptInjection()` —— 那里有唯一的合法性表与降级规则。
   * 这里若也判一次（比如把未知值归一成 append），就会有两处真相：
   * 一处静默改值、一处告警，读数是矛盾的（D151 同族）。
   */
  const promptRaw = obj.prompt
  const prompt: RawPromptInjection | undefined =
    promptRaw !== null && typeof promptRaw === 'object' && !Array.isArray(promptRaw)
      ? {
          ...(typeof (promptRaw as Record<string, unknown>).injection === 'string'
            ? { injection: (promptRaw as Record<string, unknown>).injection as string }
            : {}),
          ...(strListMaybe((promptRaw as Record<string, unknown>).replaces) !== undefined
            ? { replaces: strListMaybe((promptRaw as Record<string, unknown>).replaces) }
            : {}),
        }
      : undefined
  return {
    dirName,
    code,
    path: file,
    ...(model !== undefined ? { model } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(msms !== undefined ? { msms } : {}),
    ...(writes !== undefined ? { writes } : {}),
    ...(resident !== undefined ? { resident } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    cognitiveTrajectory: {
      session: boolOrTrue(ct.session),
      keeper: boolOrTrue(ct.keeper),
      rebuild: boolOrTrue(ct.rebuild),
    },
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
  }
}

/**
 * 按**轨迹编码**解析 轨迹约束面（`list`/`admin`/调试页/路由解析用）。
 *
 * @returns 约束面；轨迹不存在 ／ 无 `trajectory-constraint.json` → `null`
 */
export function readTrajectoryConstraintByCode(root: string, code: string): TrajectoryConstraint | null {
  const dirName = findDirNameByCode(root, code)
  if (dirName === null) return null
  return readTrajectoryConstraintAt(join(sessionsRoot(root), dirName), root)
}

/** 扫全部活跃轨迹，返回全部 轨迹约束。**顺序按目录名**（确定性，便于对读）。 */
export function listTrajectoryConstraints(root: string): TrajectoryConstraint[] {
  const out: TrajectoryConstraint[] = []
  for (const name of activeTrajectoryDirNames(root)) {
    const p = readTrajectoryConstraintAt(join(sessionsRoot(root), name), root)
    if (p) out.push(p)
  }
  return out
}

/**
 * 编码 → 轨迹目录名（活跃轨迹内）。找不到 → `null`。
 *
 * ⚠️ 与 `findSession` 的分工：这里**只按编码精确**匹配（不做模糊），
 * 因为它的调用方（路由 / 约束施加）要的是**确定性**，模糊匹配会把"手抖打错的名字"
 * 静默投到一条相近的轨迹上——那正是最难查的一类串味。
 */
export function findDirNameByCode(root: string, code: string): string | null {
  const hits: string[] = []
  for (const name of activeTrajectoryDirNames(root)) {
    if (parseTrajectoryCode(name) === code) hits.push(name)
  }
  // 🔴🔴 **2026-10-21（A95 ①）：命中多条时响亮报歧义，不再 `return` 第一个。**
  // 与 `core.ts` 的 `findSession` 同一判据 —— 两个解析面必须同族（D167 的教训：
  // 只修一处 ⇒ 另一处继续静默，而症状与真因在读数上完全不像）。
  // 这条路径的调用方是**路由 / 约束施加**，静默投到另一条轨迹上最难查（见上方注释）。
  if (hits.length > 1) {
    throw new Error(
      `编码「${code}」在本 CCC 有 ${hits.length} 条轨迹同时占用，无法确定要施加到哪一条：\n` +
      hits.map((n) => `  · ${n}`).join('\n') +
      '\n编码是终身身份（AXIOM 3）⇒ 不替你任选其一。改用**完整目录名**指定。',
    )
  }
  return hits[0] ?? null
}

/**
 * **会话级**判据（J2）：这个 dsh 会话是不是 轨迹约束会话 —— 唯一入口。
 *
 * 判据 = **它绑定的轨迹有 `trajectory-constraint.json`**（不是 sessionId 前缀，也不是配置里有没有角色）。
 *
 * ## 为什么"绑定的轨迹"从两个来源取（R↓，一个失败模式）
 * ① **持久绑定**（`readLastBound`，宿主存储域/`.bindings.json`）—— 权威，跨重启成立；
 * ② **内存注册表**（`trajectory/policy/window`）—— 覆盖绑定的**窗口期**（轨迹刚定、bound 还没落盘）。
 * ⇒ 只取 ① 会在建会话的第一轮判成"不是 轨迹约束"（工具面不收窄，模型看见不该有的工具）；
 *    只取 ② 会在进程重启后全判成"不是"（轨迹约束 失去约束，**权限面静默放开**）。
 * ⇒ **两来源并取**，都不中才 `null`。
 *
 * @param root CCC 根
 * @param sessionId dsh 会话 id
 * @param boundDirName 调用方已解析的绑定目录名（可选；给了就省一次读绑定）
 * @returns 约束面；不是 轨迹约束会话 → `null`
 */
export function trajectoryConstraintForSession(
  root: string,
  sessionId: string | undefined,
  boundDirName?: string | null,
): TrajectoryConstraint | null {
  const dirName = boundDirName ?? resolveDirNameForSession(root, sessionId)
  if (dirName === null || dirName === '') return null
  return readTrajectoryConstraintAt(join(sessionsRoot(root), dirName), root)
}

/**
 * **会话 → 轨迹目录名**（两来源并取，本文件内唯一入口）。
 *
 * 🔴🔴 **2026-11-17 真机缺陷（某条长期存活轨迹拿到白名单外的工具）—— 这一格曾经只取 ①**：
 *
 * 旧实现是 `boundDirName ?? registeredDirName(sessionId)` —— **只读进程内内存表**
 * （`policy/window.ts` 的 `trajectorySessions`）。而 `window.ts` 的文件头**逐字承诺**
 * 「两个来源并取，都不中才判不是」，`trajectoryCodeForSession` 也是照那条承诺写的
 * ⇒ **只有本函数漏了 ②**。后果不是"少一条兜底"，是**权限面静默松开**：
 *
 * | 步 | 发生什么 |
 * |---|---|
 * | 1 | 宿主进程重启（每次发版装机会发生）⇒ 内存 Map 清空 |
 * | 2 | `registerTrajectorySession` 全仓**只有一处调用**（`trajectory/session.ts:374`，建/恢复轨迹会话时） |
 * | 3 | **长期存活**的载体会话没有任何路径重新登记它 |
 * | 4 | 本函数返回 `null` ⇒ `computeVisibilitySources` 第 ⑥ 源贡献 `deny: []` |
 * | 5 | **工具白名单整个不生效**，模型看得到全部工具 |
 *
 * 而这一点在当时**没有任何读数信号**：诊断 Map 也是空的，配置读起来完全正确。
 * ⇒ 判据：**任何"内存 + 持久"双来源的设计，两处都必须真的取两个**；
 * 只写在一处的注释不能替代另一处的实现（D151 同族：文档承诺与实现脱节）。
 *
 * @returns 轨迹目录名；两来源都不中 ⇒ `null`（= 这条会话不属任何轨迹）
 */
function resolveDirNameForSession(root: string, sessionId: string | undefined): string | null {
  // ① 内存注册表（快）—— 覆盖「轨迹已定、绑定还没落盘」的窗口期
  const fromMemory = registeredDirName(sessionId)
  if (fromMemory !== null && fromMemory !== '') return fromMemory
  // ② 持久绑定（权威，跨重启成立）——按 sessionId 反查哪个轨迹目录的交代指向它。
  //    ⚠️ 这一步是**必需**的，不是"兜底"：重启后内存必空，只有它能认出老会话的归属。
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    for (const { dirName, decl } of listBindDeclarations(sessionsRoot(root))) {
      if (decl.sessionId === sessionId) return dirName
    }
  } catch {
    /* 读盘失败 ⇒ 当作"解析不到"（与 `trajectoryCodeForSession` 同口径，由调用方决定方向） */
  }
  return null
}

/** 内存登记的轨迹目录名（注册表单一真相源在 `./registry.ts`；此处只做一次转发） */
function registeredDirName(sessionId: string | undefined): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  return trajectoryDirNameForSession(sessionId)
}

/**
 * **会话 → 认知轨迹编码**（供工具可见性这类"只有 sessionId、没有 agent 对象"的调用方用）。
 *
 * ## 为什么需要它（而不是复用 `trajectoryConstraintForSession`）
 *
 * 那条路的判据是"**绑定的轨迹有 `trajectory-constraint.json`**"——它回答的是
 * 「这条会话是不是一条**约束会话**」。而工具可见性问的是另一个问题：
 * 「这条会话属于**哪条**轨迹」。前者对**普通轨迹**恒返回 `null`（它们没有约束文件），
 * ⇒ 拿它去判 IM 接线，会把所有普通轨迹一律判成"无归属"。
 *
 * ## 两个来源并取（与 `trajectoryConstraintForSession` 同一条纪律）
 *
 * ① **内存注册表**（`window.ts`）——覆盖"刚 `use`、绑定还没落盘"的窗口期；
 * ② **持久绑定**（`listBindDeclarations` 扫 `current.dsh_session_bind`）——跨重启成立。
 *
 * ⇒ 只取 ① 会在重启后全判成"没归属"（工具**静默消失**）；
 *    只取 ② 会在建会话的第一轮判成"没归属"（同样是静默）。
 * 🔴 **这条纪律不是新发明的**：`trajectoryConstraintForSession` 的注释里已经付过一次代价。
 *
 * @param root CCC 根
 * @param sessionId dsh 会话 id
 * @returns 轨迹编码（`S###` 或自定义码）；解析不到 ⇒ `null`
 */
export function trajectoryCodeForSession(root: string, sessionId: string | undefined): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  // ① 内存注册表（快）
  const fromMemory = registeredDirName(sessionId)
  if (fromMemory !== null && fromMemory !== '') return parseTrajectoryCode(fromMemory) ?? fromMemory
  // ② 持久绑定（权威）——按 sessionId 反查哪个轨迹目录的交代指向它
  try {
    for (const { dirName, decl } of listBindDeclarations(sessionsRoot(root))) {
      if (decl.sessionId !== sessionId) continue
      // 编码可能取不到（非 S### 的自定义目录名）⇒ 回退整名，与 `cognitiveTrajectoryLabel` 同口径
      return parseTrajectoryCode(dirName) ?? dirName
    }
  } catch {
    /* 读盘失败 ⇒ 当作"解析不到"，由调用方 fail-closed */
  }
  return null
}

/**
 * 该 dsh 会话**是不是** 轨迹约束会话（布尔形态的 `trajectoryConstraintForSession`）。
 *
 * 存在的理由：调用点很多只要一个"是/不是"（seams 的旁路判定），
 * 让它们各自写 `!== null` 会把判据散开；**判据只能有一个入口**。
 *
 * 🔴 **D183（owner 2026-10-20）：这里的 `true` 只表示"有声明"，不再等于"该旁路默认行为"。**
 * 要判断后者请用 `replacesDefaultIdentity()` —— 两者**刻意分开**，因为：
 * 「我声明过」与「我声明了什么」是两件事，而旁路 ACC 身份只需要后者成立。
 */
export function isTrajectoryConstrained(root: string, sessionId: string | undefined): boolean {
  return trajectoryConstraintForSession(root, sessionId) !== null
}

/**
 * 这条声明**是否真的取代了该轨迹的默认身份**（= 该不该旁路 ACC 身份/首轮/恢复等默认行为）。
 *
 * ## 为什么需要它（D183，owner 2026-10-20 逐字）
 *
 * > 「这个 `trajectory.json` 中**所有 key 都是可选的；不写就是不设定 不应影响默认行为**」
 *
 * 旧判据是**文件存在** ⇒ 只写一句 `resident`（对外用途自述）就会连带丢掉
 * ACC 身份播种、首轮锚定、自动恢复、compact 重注入 —— **完全超出用户预期**。
 *
 * ## 判据（哪些 key 真的改"这条轨迹是谁"）
 *
 * | key | 取代默认身份？ | 理由 |
 * |---|---|---|
 * | `tools` / `msms` | **否** | 它们收窄**能力**，但"我是谁、我按什么章程工作"没变 ⇒ 仍该拿 ACC 身份 |
 * | `model` | **否** | 换的只是**执行的模型**，不是身份 |
 * | `resident` | **否** | 纯对外自述，D173 明说"不碰任何默认行为" |
 * | `cro.host` | **否** | 管"哪台机器跑 CRO 程序"，与身份无关 |
 * | `cognitiveTrajectory` | **否** | 管"参与哪些纪律"，纪律是叠加不是取代 |
 * | `systemPromptFile` / `systemPrompt` | **是** | 它自带**章程** ⇒ 用户的提示词整段取代 ACC 的 |
 * | `PROMPT.md`（目录里） | **否** | 它**追加**在 ACC 身份之外（v1.72.0 起的机制），不取代 |
 *
 * @returns `true` ⇒ 该轨迹自带章程，应旁路 ACC 身份类默认行为；否则 `false`
 */
export function replacesDefaultIdentity(profile: TrajectoryConstraint | null | undefined): boolean {
  if (!profile) return false
  const hasFile = (profile.systemPromptFile ?? '').trim() !== ''
  const hasInline = (profile.systemPrompt ?? '').trim() !== ''
  return hasFile || hasInline
}
