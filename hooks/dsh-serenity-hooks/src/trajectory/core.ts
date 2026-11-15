/**
 * trajectory/core.ts — 轨迹工具纯操作层（零 DSH 依赖，可独立单测）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/session/lib.ts）——osp 是 ACC 工具 spec。
 *
 * v1.33 收敛（S142 §32）：本文件只服务 `cognitive_trajectory` 的动作面
 * （现行 **8 个**：list / show / create / use / rebuild / **send-now** / **send-later** / **cro-guide**）。旧 `logbook` 面里
 * **close / archive / health / qa 四个动作已删**（用户裁决「功能上废弃，实际上没用」），
 * 其函数（closeSession / archiveSessions / healthCheck / qaCheck）**同批删除**——
 * 保留下来的只有：create（--desc / --issue 二选一、dry-run 预览）、
 * list（含 summarize 仪表盘）、show、use（激活 + 绑定）、以及供 list 用的 summarize。
 *
 * ## 🔴 2026-10-18（owner 令）：**认知轨迹没有生命周期**
 *
 * owner 原话要点：*"我需要允许永存的认知轨迹……我希望该生命周期足够简单，即没有生命周期，
 * 但允许轨迹本身被操作为归档"*。据此**删除**了以下全部"生命周期"语义：
 *
 * | 被删的 | 为什么它属于生命周期 |
 * |---|---|
 * | `completed` 解析（SESSION.md 里的方括号小写 x） | "完成"是一个**终态**；没有生命周期就没有终态 |
 * | `summarize` 的 Active / Completed / Stale / Ghost 四项计数 | 四项全部在给轨迹分"阶段" |
 * | `advisoryHint` 的「N 天未更新」告警 | 老化告警的前提是"旧轨迹该退休了"——现在**旧不是问题** |
 * | `findLatestActiveSessionMd`（**全仓零消费者**，纯死代码） | 它的语义是"最新的**未完成**轨迹"，前提已不存在 |
 *
 * **保留**：SESSION.md 头部的状态行**照旧生成**（`- 状态: [ ] 进行中`），但**不再被任何代码解析**。
 * 理由（owner 裁决）：格式最小变动、老文件完全不用改。⇒ 它从"机器契约"降为**惰性文本**，
 * 且"进行中"对永存轨迹**恒为真**，因此不构成谎言。
 *
 * **新增唯一的操作**：`archiveSession()` —— 单向移入 `_archived/`。
 * 归档是**唯一的"变化"**，且它不属于轨迹自身：轨迹本体（目录 ＋ SESSION.md）**永不被改**，
 * 只是**换了个存放位置**、从清单里消失。恢复 = 手工 `container_fs mv` 移回（owner 裁决：不设 unarchive）。
 *
 * ⚠️ 由此产生一条**必须成立**的配套：`readAllSessions` **跳过 `_` 前缀目录**。
 * 否则归档后的轨迹会继续出现在清单里，"归档"就不是归档了（历史 bug：`_weixin-logs` /
 * `_轨迹约束-logs` / `_corpus` 曾被当成轨迹列出来）。
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { localDate, localDateTimeMinutes } from '../kernel/time.js'
import { readTrajectoryFile } from './policy/files.js'

/**
 * `cognitive_trajectory` 工具的动作集合（v1.33，S142 §32 用户裁决后的收敛结果）。
 *
 * 为什么收敛到这 8 个（R↓；v1.33 收敛时为 **6 个** —— 其后追加 `send-now`（09-16）
 * 与 `cro-guide`（09-20），🔴 2026-09-25 更正计数，勿再写成"6 个"）：旧面是 `logbook`（11）+ `trajectory`（12）两个工具，用户裁决
 * 「都合并成 trajectory，废除 logbook 这个词」并逐条删并 ——
 * summary 并进 list｜health/qa 淘汰（判据＝旧模板，EAP 已取代；仅"空壳/长期无活动"并入 use）｜
 * close/archive 删（completed 由 SESSION.md 的 `[x]` 推导；归档走 container_fs mv）｜
 * hook-develop-guide 并进 container_admin msm guide｜autopilot 面归 container_admin 的 autopilot 域
 * （该域 2026-09-15 随 ACC 侧 autopilot 退场删除）｜
 * wake-add/list/rm 收敛为 wake-later（**2026-09-17 更名 `send-later`**）。
 * 2026-09-16（所有者裁决）：新增 **send-message**（**2026-09-17 更名 `send-now`**）—— 即时投递
 *   （与 wake-later 共用取用通路，差别只在时刻"现在 vs 未来"与回执"有 vs 无"）。
 *   设计稿 docs/cognitive-trajectory-send-message-design.md。
 * 2026-09-17（所有者裁决 · 命名 A 案）：**两个投递动作更名** —— `wake-later` → **`send-later`**、
 *   `send-message` → **`send-now`**。判据（R↓）：两者是**同一条投递通路**（同取用机制 / 同载荷 /
 *   同落点语义），只差**时刻**；而「唤醒（冷载入）」是**两条路径共有**的属性，不配做区分
 *   ⇒ 族名取共享词干 **`send-`**、轴取 **`-now` / `-later`**（同构）。**硬切无别名**；
 *   机制层词汇（`wake-registry.json` / `w-*` id / `WakeEntry` / 调度器名）**一律不动**（分层命名）。
 * 2026-09-20（CRO 落地，owner 令「搞定了发一版」）：新增 **`cro-guide`** —— CRO
 *   （Continuous Re-Occurrence，`docs/cro-design.md`）的**编写指南**出口。
 *   判据（R↓，为何挂在本工具而不新增域）：CRO 程序**放在轨迹自己的目录里**
 *   （`<轨迹目录>/continuous-re-occurrence.ts`）⇒ 「怎么写它」是**逐轨迹**的知识，
 *   而**管轨迹的人正是用本工具的人**；挂这儿 = 设计 §9-5 的"**既有 guide 位置、不新增域**"。
 *   ⚠️ 本动作**纯读**（输出指南正文，不碰 fs、不碰注册表）。
 * 2026-10-20（D173 兑现，owner 令）：「常驻」= 轨迹的**自我声明**，落地为 **`resident`** 只读动作。
 *   判据：它管的是**被找到**，不是**不被销毁** ⇒ 纯读、不碰生命周期、不进系统提示词。
 *   ⚠️ 这也修正了 v1.77.1 的一处说明面失真（手册曾描述一个**不存在**的动作，D179(a)）。
 * 2026-10-22（owner 令「在 trajectory 加上触发入口即可，剩下的 CCC 搞定」）：新增
 *   **`interrupted`** —— 列出**末轮未跑完**的 dsh 会话（进程在轮次完成前退出）。
 *   判据（R↓，为何 ACC 只出**入口**不管周期）：**周期性归属调用方的认知轨迹**，
 *   ACC 只回答"此刻哪些会话的最后一轮没跑完"这一个问题。⇒ 本动作**纯读**、
 *   **不判周期、不自动续跑、不改任何会话日志**（是否续、续谁、几点续 = CCC 的事）。
 *   ⚠️ 判据的锋利处：**只认"末轮未跑完"**，不认"曾经中断过"—— 长会话历史上
 *   可中断几十次（实测单会话 33 次），按"曾经"判会把早已恢复的会话全部当成待续。
 *   🔴 **2026-10-24（owner 报障「不是崩溃的就扫不到」）**："未跑完"有两种宿主写法 ——
 *   `interrupted`（崩溃后 resume 补收尾）与 `aborted`（被正常终止：重启／销毁／用户中断）。
 *   修前只认前者 ⇒ **发布重启这一类整批漏扫**。取值域只在 `trajectory/interrupted.ts` 一处定义。
 *
 * 🔴🔴 **2026-11-15（owner 令）：`interrupted` 与 `continue-all-interrupted` 两个动作已从工具面移除。**
 *
 * **移除的理由（这是判据，不是"收拾东西"）**：
 *   ACC 的**自动兜底**（`wake/scheduler.ts` 的 60s tick）已经**过于可靠**——它每拍自己扫、
 *   自己注入，不需要任何调用方。⇒ 工具上再挂一份**同样能起 agent、同样烧算力**的入口，
 *   只增加"两条路都能做同一件事"的第二真相源，而**它的失效形态比沉默更坏**：
 *   调用方以为自己必须记得调它，于是**把一件已经自动化的事重新变成人的义务**。
 *
 * **删的只是"工具面那两个动作"，底层函数一个都没删** ——
 * `scanInterruptedSessions` / `createResumeOne` / `buildContinueText` **仍被 scheduler 使用**，
 * 那是自动兜底的唯一实现。⇒ 判据：**删入口 ≠ 删能力**；能力归自动兜底，入口不必重复。
 *
 * ⚠️ **恢复这两个动作的方式**（若哪天自动兜底不够用）：把 `'interrupted'` / `'continue-all-interrupted'`
 *   加回本数组 ＋ 加回 `tools/cognitive-trajectory.ts` 的 `switch`（那两个 case 的正文当时整段删除，
 *   重建时照 `trajectory/interrupted.ts` 的现有导出写即可——它从没动过）。
 */
type CognitiveTrajectoryAction = 'list' | 'show' | 'create' | 'use' | 'rebuild' | 'archive' | 'uid' | 'send-now' | 'send-later' | 'cro-guide' | 'resident'

export const COGNITIVE_TRAJECTORY_ACTIONS: readonly CognitiveTrajectoryAction[] = [
  'list', 'show', 'create', 'use', 'rebuild', 'archive', 'uid', 'send-now', 'send-later', 'cro-guide', 'resident',
]

/**
 * 读取 Session 事件序列（v1.28.1 适配 0.1.2-rc.1 补齐）：rc.1 起官方 Session 类
 * 移除 `.events` 属性 → `snapshotEvents()` 方法（dsh-session/src/session.ts：
 * `snapshotEvents(fromSeq, toSeqExclusive)`）。插件早期代码多处裸读 `.events`
 * （经 `as unknown as { events? }` 断言绕过 typecheck），运行时静默 undefined——
 * 造成 fake-initial-turns 每轮重插 / SESSION 激活恢复失效 / rebuild 定位错乱。
 * 统一收敛到本 helper：snapshotEvents() 优先（rc.1 真实形态），`.events` 兜底
 * （测试替身/旧运行时）。所有消费方一律经此读取，禁止再裸读 `.events`。
 * 泛型 T：调用方按需声明事件形状（如 `SessionEvent`），unknown 默认。
 */
export function sessionEvents<T = unknown>(session: unknown): readonly T[] {
  const s = session as { snapshotEvents?: () => readonly T[] | readonly unknown[]; events?: readonly T[] } | null | undefined
  if (!s) return []
  if (typeof s.snapshotEvents === 'function') {
    try {
      const snap = s.snapshotEvents()
      return (snap ?? []) as readonly T[]
    } catch {
      /* snapshot 失败退 events 兜底 */
    }
  }
  return (s.events ?? []) as readonly T[]
}

const SESSION_MD = 'SESSION.md'
const DAY = 86_400_000

/** 归档区目录名（`_` 前缀 ⇒ 不是轨迹，见 readAllSessions 的跳过判据） */
export const ARCHIVED_DIR = '_archived'

export function sessionsRoot(root: string): string {
  return join(root, 'AGENT_SESSIONS')
}

/** 归档区绝对路径（`<CCC>/AGENT_SESSIONS/_archived`） */
export function archivedSessionsDir(sessionsDir: string): string {
  return join(sessionsDir, ARCHIVED_DIR)
}

/**
 * **编码是否已被占用**（活跃区 ＋ 归档区，**全仓**）。
 *
 * 🔴 为什么必须扫归档区（2026-10-20，S222 报告 / owner 转 S142 处置）：
 * 编码是**终身身份**（AXIOM 3），而归档只改位置、不改身份 ⇒
 * 若分配器只看活跃区，归档过的码会被**重新发出**，于是同一个身份挂在两个载体上
 * （实测：`S222` 活跃＋归档并存；更早 `S140` 被两条轨迹共用，08-27 就登记过、一直没判据）。
 * 一个可复用的身份码会让历史 `send-now` / 唤醒条目 / 文档引用**静默指向另一个对象**。
 *
 * ⚠️ 与 `readAllSessions` 的分工：那个函数回答"**眼下有哪些活跃轨迹**"（该跳 `_` 前缀），
 *    本函数回答"**这个码有没有人用过**"（必须看全仓）。**两个问题，两个扫描域** ——
 *    把它们合并成一个才是错的。
 *
 * @returns 撞车时返回**占用者的完整路径**（活跃区优先说明）；无冲突 ⇒ `null`
 */
export function findCodeCollision(sessionsDir: string, code: string): string | null {
  for (const dir of [sessionsDir, archivedSessionsDir(sessionsDir)]) {
    const hit = readAllSessions(dir).find((s) => parseTrajectoryCode(s.dirName) === code)
    if (hit) return hit.path
  }
  return null
}

// ── 会话条目与状态（对齐 osp readAllSessions/parseSessionMd）──

/**
 * 轨迹的**存在形态**（🔴 **2026-10-18 起不再是"生命周期"**）。
 *
 * `hasSessionMd` 是唯一的判据，而且它**不是阶段**：它只说"这个目录里有没有正文"。
 * 旧字段 `completed` 已删除（见文件头「认知轨迹没有生命周期」）。
 */
interface SessionStatus {
  hasSessionMd: boolean
}

interface SessionEntry {
  dirName: string
  path: string
  mtime: Date
  status: SessionStatus
}

/**
 * 解析 SESSION.md 存在性。
 *
 * 🔴 **2026-10-18：不再解析"完成"**。旧实现 `completed: /\[\s*x\s*\]/i.test(content)` 已删——
 * 轨迹永存 ⇒ 没有终态，而这个字段的所有消费者（排序 / 标记 / 计数）也同批删掉了。
 * ⚠️ **副作用（有意接受）**：`[x]` 不再有机器含义 ⇒ 正文里出现它**不会再**把轨迹判成任何东西。
 * 那条"正文绝不能用方括号小写 x"的老纪律随之解除（但它仍是无害的好习惯）。
 */
function parseSessionMd(filePath: string): SessionStatus {
  try {
    readFileSync(filePath, 'utf-8')
    return { hasSessionMd: true }
  } catch {
    return { hasSessionMd: false }
  }
}

function readSessionEntry(dirPath: string): SessionEntry | null {
  try {
    const st = statSync(dirPath)
    if (!st.isDirectory()) return null
    const dirName = basename(dirPath)
    const mdPath = join(dirPath, SESSION_MD)
    const status = existsSync(mdPath) ? parseSessionMd(mdPath) : { hasSessionMd: false }
    return { dirName, path: dirPath, mtime: st.mtime, status }
  } catch {
    return null
  }
}

/**
 * 读取 AGENT_SESSIONS 中所有**活跃**轨迹，按 mtime 降序。
 *
 * 🔴 **跳过 `_` 前缀目录**（2026-10-18 新增，与归档配套）：
 * `_archived` 是归档区，`_轨迹约束-logs` / `_weixin-logs` / `_corpus` 是**日志与数据区**——
 * 它们**都不是轨迹**。旧实现会把它们当轨迹列出来（历史 bug）。
 * 没有这条，归档后的轨迹仍会出现在清单里 ⇒ **"归档"名不副实**。
 *
 * ⚠️ 排序判据已变：旧实现是「未完成优先，再 mtime 降序」，现在**只有 mtime 降序**
 * （没有"未完成"这个概念了）。
 */
function readAllSessions(sessionsDir: string): SessionEntry[] {
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => readSessionEntry(join(sessionsDir, e.name)))
      .filter((s): s is SessionEntry => s !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  } catch {
    return []
  }
}

// ── 轨迹编码（code）：目录名固定位置的唯一标识 ──────────────────────────────
//
// 🔴 owner 2026-10-19（轨迹约束 重做令，逐字）：「**认知轨迹固定唯一标识规则，固定为目录中的固定位置编码**；
// 然后，**认知轨迹允许用户指定这个编码**（在约束范围内，不得包含中文）」。
//
// 旧模型是**二元**的：`S###`（自动递增、不可指定）＋ `TRAJECTORY-UID`（可选小文件，理由 = "命名会变"）。
// owner 2026-10-19 追加令裁 **B 案**：**取消二元性** —— 编码就是唯一标识，可直接指定；
// UID 的"独立于命名"那个理由被"编码本身稳定且可指定"覆盖 ⇒ **写入侧退役，读取侧保留**（存量仍可指认）。
//
// ## 形态：目录名 = `YYYY-MM-DD--<code>[--<desc>]`
// 这就是"目录中的固定位置"：剥掉日期前缀后的**第一段**。issue 目录 `YYYY-MM-DD--<ticket>` 的 code 即 ticket。
//
// ⚠️ **编码内不得含 `--`**：它是本解析的分隔符 —— 含它就等于把"固定位置"这个前提破坏掉
// （与"不得含中文"同一条理由：编码必须是**结构安全**的，不是"看起来像名字"）。

/** 目录名的日期前缀（`createSession` 恒写；`isSessionDirName` 同源判据） */
const DIR_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}--/

/** 合法编码：`[A-Za-z0-9]` 开头，其后 `[A-Za-z0-9._-]`，≤64，**不含 `--`** */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 校验轨迹编码形态。**这是写入侧（create --id）与外部输入的唯一闸门。**
 *
 * 判据三条（R↓）：
 * ① `CODE_PATTERN` —— 只允许交流安全字符：编码会被逐字打在命令、消息、日志里，
 *    含空格/引号/中文会在 shell、JSON、markdown 各需一套转义（旧 UID 的同一条理由，D158）；
 * ② **不得含 `--`** —— 目录名解析用它当分隔符（见上）；
 * ③ 长度上限 64（同旧 UID；够长以致不会撞名，够短以致能打出来）。
 *
 * ⚠️ 大小写**敏感**：`S142` 与 `s142` 是两个不同编码（编码不是近似匹配语义）。
 */
export function isValidTrajectoryCode(code: string): boolean {
  return CODE_PATTERN.test(code) && !code.includes('--')
}

/**
 * 从目录名解析轨迹编码（固定位置 = 剥掉日期前缀后的第一段）。
 *
 * @returns 编码；目录名不带日期前缀（非本工具建的 / 损坏）→ `null`
 */
export function parseTrajectoryCode(dirName: string): string | null {
  if (!DIR_DATE_PREFIX_RE.test(dirName)) return null
  const rest = dirName.replace(DIR_DATE_PREFIX_RE, '')
  const sep = rest.indexOf('--')
  const code = sep === -1 ? rest : rest.slice(0, sep)
  return code === '' ? null : code
}

/**
 * 从目录名取**可读描述**（编码之后那一段；没有就返回空串）。
 *
 * 用途：给"模拟用户开场白"当标签（D171）。判据 = 与 {@link parseTrajectoryCode} **互逆、同源**：
 * 剥日期前缀 → 第一段是编码 → 其后（去掉前导 `--`）全是描述。
 * ⚠️ 描述里**可以**含 `--`（只有编码不许）⇒ 这里必须取"第一段之后整串"，不能 split 再取第二段。
 */
export function trajectoryDescOf(dirName: string): string {
  if (!DIR_DATE_PREFIX_RE.test(dirName)) return ''
  const rest = dirName.replace(DIR_DATE_PREFIX_RE, '')
  const sep = rest.indexOf('--')
  return sep === -1 ? '' : rest.slice(sep + 2).trim()
}


/**
 * 展示用会话 ID（`list` 面板 / 绑定记录的 `sessionId` 字段）。
 *
 * 🔴 2026-10-19 起**编码即 ID**，不再只认 `S###` —— 旧实现只匹配 `--S(\d{3,})--`，
 * 自定义编码（owner 令允许的那类）会全被渲染成空串。无编码 → `''`（不是目录名：调用方各有回退）。
 */
function extractSessionId(dirName: string): string {
  return parseTrajectoryCode(dirName) ?? ''
}

// ── 唯一标识符（UID）——🔴 2026-10-19 起**只读兼容**（写入侧退役，见文件上方 owner 令）──

/**
 * UID 的声明文件名（**固定名、住在轨迹目录内**）。
 *
 * 🔴 owner 2026-10-18 需求原话：*"认知轨迹编号和命名问题，命名很可能由于变化而变化，
 * 所以我们需要让认知轨迹支持一种用于交流的唯一标识符，它不同于编码和命名，而是单独设定的
 * （也可以不设定，不设定就还是用编码），所有可以用编码操作的能力，都同样支持唯一标识符，
 * 唯一标识符用文件形式声明在认知轨迹目录中"*。
 *
 * ## 为什么是「一个文件」而不是 frontmatter 里一行
 * | 形 | 问题 |
 * |---|---|
 * | 写进 `SESSION.md` frontmatter | SESSION.md 是**轨迹的身体**（会被重写、被 rebuild 锚点反复读）⇒ 标识符住在会变的东西里 |
 * | 写进目录名 | 改名即变 —— 而这正是要解决的问题（owner：命名会变） |
 * | **独立小文件**（选定） | 与目录名、SESSION.md **都解耦**；改标识符不动正文、不动目录名；删文件即"回到用编码" |
 *
 * ## 语义边界（R↓）
 * - **可选**：文件不存在 ⇒ 用编码，**不是错误**。
 * - **只用于"被指认"**：它是 `findSession` 的一个**解析分支**，不参与排序、不参与展示优先级、
 *   **不改变**目录名与 SESSION.md 一个字节（与 `archive` 同一条纪律：只换指认方式，不动本体）。
 *
 * ## 🔴 2026-10-19：**写入侧退役，读取侧保留**
 *
 * owner 追加令裁 B 案：「取消 `S###` 与 UID 的二元性 —— 编码就是唯一标识，用户可指定」。
 * UID 当初存在的**唯一理由**是「命名很可能由于变化而变化」（D158），而现在的编码
 * **本身就稳定且可指定**（`create --id`）⇒ 该理由被覆盖 ⇒ **二元性取消**。
 *
 * 处置（**不对称，刻意**）：
 * - **写**：`setTrajectoryUid()` **已删除**（`uid` 动作改为报"已退役"并指向 `create --id`）；
 * - **读**：本文件与 `findSession` 的 UID 分支**保留** —— 存量文件（本仓 = S142 的
 *   `serenity-acc-maintainer`）仍能按它指认，**不因退役而失去能力**。
 *
 * ⚠️ **为什么不物理删除那些文件**：删了就丢掉一个仍在被读的指认通道（能力倒退），
 * 而保留的成本是零（文件不存在 ⇒ `readFileSync` 失败 ⇒ null）。
 * 判据：**退役的是"产生新标识"这种能力，不是"旧标识还在被用"这个事实。**
 */
export const UID_FILENAME = 'TRAJECTORY-UID'

/** UID 合法形态（**只读兼容用**；新编码的形态校验见 `isValidTrajectoryCode`） */
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 校验 UID 形态（**只读兼容路径** —— 写入侧已退役，见 `UID_FILENAME` 的 R↓ 段）。
 *
 * 为什么保守：UID 是**给人和 agent 在对话里互相指认用的**（owner：「用于交流」）⇒
 * 它必须能**逐字打出来**。含空格/引号/中文的 UID 会在 shell、JSON、markdown 里各自需要一套转义
 * ⇒ "用于交流"这个目的当场失败。⇒ 限定 `[A-Za-z0-9._-]`，首字符必须字母数字，上限 64。
 *
 * ⚠️ 大小写**敏感**：`S142` 与 `s142` 是两个不同 UID（判据：唯一标识符不是给人近似匹配用的；
 * 要模糊匹配请用目录名/编码那条既有分支）。
 */
export function isValidUid(uid: string): boolean {
  return UID_PATTERN.test(uid)
}

/**
 * 读一条轨迹的 UID（文件不存在 / 读失败 / 形态非法 ⇒ `null` = "没设定"）。
 *
 * 🔴 **形态非法的文件按"没设定"处理，而不是报错**：解析侧出现在**每一次** `findSession` 里
 * （show/use/archive/send-now/send-later 全走它），在那里抛错会让一个坏文件**炸掉整条轨迹的所有操作**
 * —— 惩罚远大于问题本身。而写入侧已退役 ⇒ 坏文件只可能来自外部手改，更不该连坐。
 *
 * ## 🆕 2026-10-19 owner 裁 Q2：**声明文件里的 `uid` 优先，独立文件回落**
 *
 * 收拢后这个旧标识住在 `<轨迹目录>/trajectory.json` 的 `uid` 字段里（它属"声明"，
 * 与约束面/机器绑定同源）。判据（**两代并读，不硬切**）：
 * **声明面里有合法 `uid` ⇒ 用它；否则回落 `TRAJECTORY-UID` 文件**。
 *
 * ⚠️ **为什么字段名是 `uid` 而不是方案书里写的 `code`**：`code` 在本仓已有一个**更窄的含义**
 * —— 目录名里那个固定位置的轨迹编码（`parseTrajectoryCode`）。同一个词在一个 JSON 里表示两件事，
 * 正是本轨反复抓的那类"名字会撒谎"。⇒ 旧标识就叫 `uid`（它本来就是 UID，见 `UID_FILENAME`）。
 */
export function readTrajectoryUid(sessionPath: string): string | null {
  // ① 声明文件（新形态）：`trajectory.json` 族的 `uid` 字段
  try {
    const decl = readTrajectoryFile(sessionPath)
    const fromJson = decl?.data?.['uid']
    if (typeof fromJson === 'string') {
      const trimmed = fromJson.trim()
      if (isValidUid(trimmed)) return trimmed
    }
  } catch {
    /* 声明面读不动 ⇒ 回落独立文件（不抛：本函数在每一次 findSession 里） */
  }
  // ② 独立小文件（旧形态，只读兼容）
  try {
    const raw = readFileSync(join(sessionPath, UID_FILENAME), 'utf-8').trim()
    return isValidUid(raw) ? raw : null
  } catch {
    return null // 无该文件 = 未设定（常态，不是错误）
  }
}

/**
 * 根据 key 查找轨迹。
 *
 * 解析顺序（**越精确越靠前**，且**前三级都不做模糊**）：
 * ① 目录名精确 ／ ② **编码精确** ／ ③ **UID 精确（只读兼容）** ／ ④ 唯一模糊子串（多个则报错）
 *
 * 🔴 **2026-10-19 起编码排在 UID 之前**（旧顺序相反）：编码现在是**一等标识**
 * （owner：「固定为目录中的固定位置编码」＋「允许用户指定」），而 UID 已退役为兼容层。
 * 顺序对结果无实质影响（两者都属精确匹配、形态互斥 —— 编码不含 `--`），
 * 但把顺序写死，避免后来者以为"编码是模糊匹配的一种"或"UID 优先"。
 *
 * 🔵 `S31` → `S031` 的**数字补零**兼容保留（存量用户习惯）；它现在只是编码匹配的一个特例：
 * 编码恰为 `S###` 形态时允许省前导零。
 */
export function findSession(sessionsDir: string, key: string): SessionEntry | null {
  const all = readAllSessions(sessionsDir)
  const byName = all.find((s) => s.dirName === key)
  if (byName) return byName
  // ② 编码精确命中
  //
  // 🔴🔴 **2026-10-21（A95 ①，owner 批「①②」）：命中多条时**响亮报歧义**，不再静默取首命中。**
  //
  // 改之前是 `all.find(...)` ⇒ 重码时按目录扫描顺序取第一个，**既不报歧义也不告警**。
  // 而编码是**终身身份**（AXIOM 3）⇒ 静默取其一 = 把命令投到**另一条轨迹**上，且盘上没有任何信号
  // （同族 D186：可以拒绝，但不许不出声）。
  //
  // ⚠️ **重码从哪来**：分配侧早已有闸（`findCodeCollision` 扫活跃＋归档），自动分配走 `maxId+1`
  // 且扫描域含归档区 ⇒ **按构造不撞车**。盘古/天工那些重码是**闸装上之前的存量**
  // ⇒ 本条修的不是"新重码"，而是"**存量重码被静默消费**"。
  //
  // ⚠️ **为什么抛错而不是返回 null**：返回 null 会让调用方把"identity 有歧义"读成"没有这条"，
  // 转而自己造一个新的 —— 那正是"重码继续繁殖"的写法。
  const byCodeHits = all.filter((s) => parseTrajectoryCode(s.dirName) === key)
  if (byCodeHits.length > 1) {
    throw new Error(
      `编码「${key}」在本 CCC 有 ${byCodeHits.length} 条轨迹同时占用，无法确定要操作哪一条：\n` +
      byCodeHits.map((s) => `  · ${s.dirName}`).join('\n') +
      '\n认知轨迹的编码是**终身身份**（AXIOM 3），重码意味着历史存量有问题 —— ⛔ 不会替你任选其一。\n' +
      '⇒ 改用**完整目录名**指定（上列任一）。',
    )
  }
  const byCode = byCodeHits[0]
  if (byCode) return byCode
  // ②b 补零兼容（`S31` → `S031`）
  const padded = key.match(/^S(\d{1,})$/)
  if (padded) {
    const want = `S${padded[1]!.padStart(3, '0')}`
    const byPaddedHits = all.filter((s) => parseTrajectoryCode(s.dirName) === want)
    if (byPaddedHits.length > 1) {
      throw new Error(
        `编码「${want}」（由「${key}」补零而来）有 ${byPaddedHits.length} 条轨迹同时占用，无法确定：\n` +
        byPaddedHits.map((s) => `  · ${s.dirName}`).join('\n') +
        '\n⇒ 改用**完整目录名**指定。',
      )
    }
    const byPadded = byPaddedHits[0]
    if (byPadded) return byPadded
  }
  // ③ UID 精确命中（只读兼容，大小写敏感）
  const byUid = all.find((s) => readTrajectoryUid(s.path) === key)
  if (byUid) return byUid
  // 🔴 **归档区故意不参与解析**（2026-10-20 复核后确认：这条既有裁决要保留）。
  //
  // 我一度在这里加了"活跃区零命中就回落归档区"，被 `trajectory-tool.test.ts` 的
  // 判据④「归档后 `use` 不再找得到它」当场打红 —— **那条用例是对的**：
  // 归档的语义就是"退出日常解析域"（要找它得用完整目录名／`container_fs`）。
  // ⇒ S222 报的"传 S222 有歧义"**不是解析歧义**（活跃区唯一命中），而是**身份重复**：
  //    两个载体都自称 S222。修法在**分配侧拒绝重复**（`findCodeCollision`），
  //    ⛔ 不是把解析域扩大 —— 扩大只会把"身份重复"变成"每次都要人工挑一个"。
  const lower = key.toLowerCase()
  const fuzzy = all.filter((s) => s.dirName.toLowerCase().includes(lower))
  if (fuzzy.length === 1) return fuzzy[0] ?? null
  if (fuzzy.length > 1) {
    throw new Error(
      `Found ${fuzzy.length} sessions matching "${key}": ` +
      fuzzy.map((s) => s.dirName).join(', ') +
      '. Use a more specific query.',
    )
  }
  return null
}

// ── list ──

/** list 子命令（对齐 osp listSessions 文本格式 + active 标记） */
export function listSessions(root: string, activeId?: string): string {
  const sessions = readAllSessions(sessionsRoot(root))
  if (sessions.length === 0) return '(no sessions in AGENT_SESSIONS/)'
  const lines = sessions.map((s) => {
    const age = Math.floor((Date.now() - s.mtime.getTime()) / DAY)
    const sessionId = extractSessionId(s.dirName)
    const isActive = activeId !== undefined && sessionId !== '' && sessionId === activeId
    // 🔴 2026-10-18：只剩两态（active ● / 普通 ○）。旧的三态里 `✓` = "已完成"，随生命周期一起删。
    const status = isActive ? '●' : '○'
    // UID 设定过就同时印出来（owner：它是"用于交流的唯一标识符"）——
    // ⚠️ 未设定时**不印占位符**：没有 UID 是常态，印一个空括号只会制造噪声。
    const uid = readTrajectoryUid(s.path)
    const uidTag = uid === null ? '' : ` [${uid}]`
    return `${status} ${s.dirName} (${age}d ago)${uidTag}`
  })
  return `AGENT_SESSIONS/ (${sessions.length} active)\n` + lines.join('\n')
}

// ── show ──

/** show 子命令（对齐 osp showSession：`# dirName\n\n` + SESSION.md 内容） */
export function showSession(root: string, key: string): string {
  const sessionsDir = sessionsRoot(root)
  const session = findSession(sessionsDir, key)
  if (!session) {
    throw new Error(`Session not found: "${key}". Use "list" to see available sessions.`)
  }
  const mdPath = join(session.path, SESSION_MD)
  if (!existsSync(mdPath)) {
    return `Session ${session.dirName} (no SESSION.md — directory exists but is empty)`
  }
  const content = readFileSync(mdPath, 'utf-8')
  return `# ${session.dirName}\n\n${content}`
}

// ── create ──

interface CreateSessionOptions {
  root: string
  /** --desc 模式的描述（与 issue 互斥） */
  desc?: string
  /** --issue 模式的工单号（与 desc 互斥） */
  issue?: string
  /**
   * 显式指定的**轨迹编码**（owner 2026-10-19 令：「允许用户指定这个编码」）。
   *
   * - 不给 ⇒ 沿用既有行为：自增 `S###`（desc 模式）／ 工单号即编码（issue 模式）。
   * - 给了 ⇒ **它就是目录名的 code 段**，并且是这条轨迹**唯一的**稳定标识。
   *
   * 形态由 `isValidTrajectoryCode` 把关（不得含中文/`--`），唯一性由本函数把关（重复即拒）。
   */
  id?: string
  goal?: string
  dryRun: boolean
}

export interface CreateSessionResult {
  message: string
  dirName: string
  sessionPath: string
  sessionId: string
}

/**
 * 生成 SESSION.md 模板（固定格式，owner 2026-09-25 裁决；时间戳 YYYY-MM-DD HH:mm）。
 *
 * 🔴 **2026-10-18：状态行不再是机器契约**（owner 裁决：轨迹永存，没有生命周期）。
 * 它**照旧生成** `- 状态: [ ] 进行中`，但**没有任何代码解析它** —— 从"被解析的机器契约"
 * 降为**惰性文本**。保留的两个理由：
 *   ① 格式最小变动、老文件完全不用改；
 *   ② 对永存轨迹来说"进行中"**恒为真**，所以它不是谎言，只是冗余。
 * ⚠️ 仍然**不得**把任何一段固定 7 段的段名与顺序动掉（契约钉在 `tests/trajectory-ops.test.ts`）。
 */
function sessionMdTemplate(title: string, id: string, goal: string | undefined, now: Date): string {
  const ts = localDateTimeMinutes(now)
  return (
    `# SESSION: ${title}\n- ID: ${id}\n- 状态: [ ] 进行中\n\n` +
    `## 身份与边界\n${goal ?? '（待补充）'}\n\n` +
    `## 权威锚点\n- （指针：仓库 / 工具 / 单一真相源位置）\n\n` +
    `## 工作纪律\n- （只放本轨迹特有的；通用项外推到 skill）\n\n` +
    `## 决策\n| # | 决策 | 理由 / 否决项 |\n|---|------|------|\n| 1 | | |\n\n` +
    `## 日志\n- ${ts} — 创建（里程碑 ＋ 证据指针；执行细节归 commit message）\n\n` +
    `## 当前状态\n- 在办：\n- 断点：\n\n` +
    `## 待 owner 裁决\n- \n`
  )
}

/** create 子命令（对齐 osp createSession：--desc/--issue 二选一 + dry-run + 长度限制） */
/** 目录名脱敏（Windows 审计问题 10）：非法字符 → '-', 去尾点/空格, 保留名（CON/NUL 等）加前缀 */
function sanitizeDirName(s: string): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[ .]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `_${cleaned}`
  }
  return cleaned
}

export function createSession(opts: CreateSessionOptions): CreateSessionResult {
  const { root, desc, issue, goal, dryRun } = opts
  const sessionsDir = sessionsRoot(root)
  const now = new Date()
  const datePrefix = localDate(now)

  if (!desc && !issue) {
    throw new Error('create requires either --desc or --issue')
  }
  if (desc && issue) {
    throw new Error('--desc and --issue are mutually exclusive')
  }

  // 🔴 owner 2026-10-19 令：「认知轨迹允许用户指定这个编码（在约束范围内，不得包含中文）」。
  //    这里同时承担**两个守卫**（都在写入侧 —— 读取侧无法消解歧义）：
  //    ① **形态**：`isValidTrajectoryCode`（不含中文/不含 `--`/字符集保守）；
  //    ② **唯一性**：编码当前是否已被某条活跃轨迹占用。
  //    ⚠️ 唯一性**只在活跃轨迹里判**（`readAllSessions` 已跳过 `_` 前缀 = 归档区）：
  //       归档轨迹不再参与指认（`findSession` 也查不到它）⇒ 允许复用其编码是**一致的**，
  //       否则会出现"看得见的编码用不了、又查不到是谁占着"的死角。
  const requestedId = opts.id?.trim()
  if (requestedId !== undefined && requestedId !== '') {
    if (!isValidTrajectoryCode(requestedId)) {
      throw new Error(
        `Invalid trajectory code: "${requestedId}". ` +
        `允许 [A-Za-z0-9._-]、首字符须字母或数字、长度 ≤64，且**不得含中文与 "--"**` +
        `（"--" 是目录名分隔符，含它就把"固定位置编码"这个前提破坏掉）`,
      )
    }
    const clash = readAllSessions(sessionsDir).find((s) => parseTrajectoryCode(s.dirName) === requestedId)
    if (clash) {
      throw new Error(
        `Trajectory code "${requestedId}" is already in use by ${clash.dirName}. ` +
        `Codes are the trajectory's unique identity — pick another, or operate on the existing one by that code.`,
      )
    }
  }

  if (issue) {
    if (issue.length > 100) {
      throw new Error(`issue too long: ${issue.length} chars (max 100)`)
    }
    // 🔴🔴 **2026-10-21（A94，owner 批「补」）：`--issue` 也要过码的两道闸。**
    //
    // 改之前：目录名直接取 `sanitizeDirName(issue)`，**既不校验形态、也不查占用**
    // ⇒ `create --issue S142` 会造出一个**自称 S142** 的目录（`parseTrajectoryCode` 把
    // 剥掉日期前缀后的第一段当编码）⇒ 一个**全新的重码**，且分配侧的闸完全没经过。
    // ⇒ 那正是「存量重码被静默消费」（A95 ①）之外**唯一还能继续生产重码的口子**。
    //
    // ⚠️ 作用面要看清：`issue` 同时承担**两个角色** —— 目录名的可读段 **和** 轨迹编码。
    //    工单号（`apaas-26116`、`TEST-1`）本来就落在 `CODE_PATTERN` 的字符集内，照常通过；
    //    这条闸真正挡的是 ① 含空格/中文/`--` 的串 ② **已被别人占用的串**（含归档区）。
    const issueCode = sanitizeDirName(issue)
    if (!isValidTrajectoryCode(issueCode)) {
      throw new Error(
        `issue「${issue}」会被当成本轨迹的**编码**（目录名 = 日期--<编码>），但它不是合法编码：` +
        `允许 [A-Za-z0-9._-]、首字符须字母或数字、长度 ≤64，且不得含中文与 "--"。`,
      )
    }
    const issueDup = findCodeCollision(sessionsDir, issueCode)
    if (issueDup !== null) {
      throw new Error(
        `issue「${issue}」会被当成本轨迹的**编码**，而它已被占用：${issueDup}\n` +
        '认知轨迹的编码是**终身身份**（AXIOM 3），归档不会释放它。\n' +
        '⇒ 换一个工单号，或用 `create --desc … --id <新码>` 显式指定。',
      )
    }
    const dirName = `${datePrefix}--${issueCode}`
    const sessionPath = join(sessionsDir, dirName)
    if (!dryRun && existsSync(sessionPath)) {
      throw new Error(`Session directory already exists: "${dirName}"`)
    }
    if (dryRun) {
      return { message: `[dry-run] Would create: ${dirName}/`, dirName, sessionPath, sessionId: issue }
    }
    mkdirSync(sessionPath, { recursive: true })
    writeFileSync(join(sessionPath, SESSION_MD), sessionMdTemplate(issue, issue, goal, now), 'utf-8')
    return { message: `Created: ${dirName}/`, dirName, sessionPath, sessionId: issue }
  }

  // --desc 模式
  if (!desc || desc.length === 0) {
    throw new Error('description cannot be empty')
  }
  if (desc.length > 200) {
    throw new Error(`description too long: ${desc.length} chars (max 200)`)
  }
  const sessions = readAllSessions(sessionsDir)
  // 给定的编码直接用；没给才自增（**只在 `S###` 形态的编码里**取 max —— 自定义编码不参与编号）
  let code: string
  if (requestedId !== undefined && requestedId !== '') {
    code = requestedId
    // 🔴 **2026-10-20（S222 报告，owner 转 S142 处置）：编码终身唯一 —— 归档不释放代码。**
    //
    // 修之前：分配器只扫 `readAllSessions()`（= **活跃区**），而归档不动目录名 ⇒
    // 归档把代码"带走"了，于是 `S222` 又被发了一次（活跃区的 S222 与
    // `_archived/2026-10-19--S222--…` 并存）。实测更早还有 `S140` 被两条轨迹共用
    // （`2026-08-20--S140--skill-msm-impl` 与 `2026-08-20--S140--loop-agents-dcp-layer-fix`），
    // 2026-08-27 就被 S144 记为待办，**一直没有机械判据**。
    //
    // 立场（本仓裁决）：**AXIOM 3 说 identity = 编码，那它就必须全仓唯一** ——
    // 一个"退役后可被复用"的身份码会让历史 `send-now` / 唤醒条目 / 文档引用
    // **静默指向另一个对象**（同族：改名两代并存，D167）。归档改的是位置，不是身份。
    // ⇒ 分配与显式指定**都要扫归档区**。
    const dup = findCodeCollision(sessionsDir, code)
    if (dup !== null) {
      throw new Error(
        `编码「${code}」已被占用：${dup}\n` +
        '认知轨迹的编码是**终身身份**（AXIOM 3：identity = 编码），归档不会释放它 —— ' +
        '归档只改位置，不改身份。\n' +
        '⇒ 换一个编码（`create --id <新码>`），或用 `create` 的自动分配（会跳过全部已用码）。',
      )
    }
  } else {
    let maxId = 0
    // 🔴 取 max 的扫描域必须**含归档区**，否则归档过的最高码会被重新发出（本函数修的正是这个）
    for (const s of [...sessions, ...readAllSessions(archivedSessionsDir(sessionsDir))]) {
      const m = parseTrajectoryCode(s.dirName)?.match(/^S(\d{3,})$/)
      if (m) {
        const num = parseInt(m[1]!, 10)
        if (num > maxId) maxId = num
      }
    }
    code = `S${String(maxId + 1).padStart(3, '0')}`
  }
  const dirName = `${datePrefix}--${code}--${sanitizeDirName(desc)}`
  const sessionPath = join(sessionsDir, dirName)
  if (!dryRun && existsSync(sessionPath)) {
    throw new Error(`Session directory already exists: "${dirName}"`)
  }
  if (dryRun) {
    return {
      message: `[dry-run] Would create: ${dirName}/\n  code=${code}\n  goal=${goal ?? '(none)'}`,
      dirName,
      sessionPath,
      sessionId: code,
    }
  }
  mkdirSync(sessionPath, { recursive: true })
  writeFileSync(join(sessionPath, SESSION_MD), sessionMdTemplate(desc, code, goal, now), 'utf-8')
  return { message: `Created: ${dirName}/ (${code})`, dirName, sessionPath, sessionId: code }
}

// ── S134 活跃会话（内存 Map + events 恢复；对齐 osp active-state 的内存模型）──

/**
 * 活动会话跟踪（S134 v1.16.14 内存化，对齐 osp active-state）：
 * **不落盘**——活跃会话状态在内存 Map（key = scope = dsh 会话 id），避免落盘标记
 * 文件累积与跨会话串台（落盘版 `.dsh/active-sessions/<scope>` 已被此方案取代）。
 * 进程重启恢复：从**当前会话历史（events）**解析 `[SESSION CONTEXT]` 标记（use 时注入），
 * 只扫自己会话——无全局扫描、无跨会话污染。
 */
export const DEFAULT_SESSION_SCOPE = 'default'

/** [SESSION CONTEXT] 恢复标记（use 时注入 events 历史；进程重启后从 events 解析） */
export const SESSION_CONTEXT_MARKER = '[SESSION CONTEXT] Activated:'

export interface ActiveSessionInfo {
  sessionId: string
  dirName: string
  mdPath: string
}

// ── 会话命名（F3/v1.22.9 格式 + 需求② 概括）────────────────────────────────
// 🔴 2026-09-25（S142 工程化程序第 ④ 项·第 1 步）**从 `tools/cognitive-trajectory.ts` 下沉至此**。
// 为何在 L1：`trajectory/rebuild.ts`（L1）原**静态** import `tools/cognitive-trajectory.ts`（L3）**只为取 `namingTitleFor`**
// ⇒ 既是 L1→L3 上行边，又与 `tools/cognitive-trajectory.ts` 里 `await import('../rebuild.js')` 的合法下行边
// **成环**（证据＝模块图 §3-6）。两个纯函数（**零 DSH 依赖**）下沉到本模块后，两侧各自向下依赖，环解开。
// 🔵 为何 `sanitizeSessionSummary` 必须**同批**下沉：它是 `namingTitleFor` 的私有助手，若留在 L3
// 就会被 L1 反向 import ⇒ 只是把那条坏边挪个名字。**功能无影响的判据** = 输入输出与全部调用点不变 ＋ 全量测试绿。

/**
 * 概括清洗（标题用；需求② S142 用户拍板：编号日期后加 ≤20 字内容概括）。
 * 规则（服务端统一，不信任 LLM 输入）：
 *   - 去控制字符/换行/回车/制表（防标题注入/多行污染）
 *   - trim（去首尾空白）
 *   - 截断 ≤20 字符（按 Unicode 码点——中英混排统一；emoji 等代理对按码点保留）
 *   - 去 `/`（防标题被误读为路径分隔）
 * @returns 清洗后的概括（空输入 → 空串；调用方决定是否允许空）
 */
export function sanitizeSessionSummary(summary: string): string {
  const cleaned = summary
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\//g, '')
    .trim()
  return [...cleaned].slice(0, 20).join('')
}

/**
 * 从激活会话派生命名标题（v1.22.9 格式修正 + 需求② 概括）：
 * F3 原始需求是 **`S###-日期`**（如 `S143-2026-08-26`）——从 `sessionId` 派生，
 * 而非完整目录名（`2026-08-24--S142--...` 超长 + 中文，不符合用户拍板格式）。
 * 需求②（S142 用户拍板）：编号日期后加 ≤20 字内容概括 → `S###-YYYY-MM-DD-<概括>`
 * ——概括来自显式 summary 参数（服务端截断/清洗，可靠不靠猜）；编号日期仍固定派生。
 * 无 S### 编号（issue 会话等）→ 回退目录名。
 * @param active 激活会话信息（sessionId + dirName）
 * @param summary 内容概括（≤20 字，服务端清洗截断；空 → 不带概括的 `S###-日期`）
 * @returns `S143-2026-08-26-概括` / `S143-2026-08-26` / 原目录名
 */
export function namingTitleFor(active: ActiveSessionInfo, summary?: string): string {
  const sid = active.sessionId
  if (typeof sid === 'string' && /^S\d+$/.test(sid)) {
    const date = active.dirName.match(/^(\d{4}-\d{2}-\d{2})--/)?.[1] ?? ''
    const cleaned = summary ? sanitizeSessionSummary(summary) : ''
    const base = date ? `${sid}-${date}` : sid
    return cleaned ? `${base}-${cleaned}` : base
  }
  return active.dirName
}

/** 内存活跃会话：scope（dsh 会话 id）→ 会话信息（不落盘；并行多会话各自 key 隔离） */
const activeStore = new Map<string, ActiveSessionInfo>()
/** 全局最近活跃（对齐 osp lastActive；供无 scope 上下文使用） */
let lastActive: ActiveSessionInfo | null = null

export function getActiveSessionInfo(scope: string): ActiveSessionInfo | null {
  return activeStore.get(scope) ?? null
}

export function getLastActiveSessionInfo(): ActiveSessionInfo | null {
  return lastActive
}

export function setActiveSessionInfo(scope: string, info: ActiveSessionInfo): void {
  activeStore.set(scope, info)
  lastActive = info
}

export function clearActiveSessionInfo(scope: string): void {
  activeStore.delete(scope)
  if (lastActive && ![...activeStore.values()].some((v) => v === lastActive)) lastActive = null
}

/** 重置内存活跃会话（测试用；进程重启即天然清空） */
export function resetActiveSessionStore(): void {
  activeStore.clear()
  lastActive = null
}

/** 当前 scope 的活跃会话 SESSION.md 绝对路径；无激活返回 null（读内存，不落盘） */
export function readActiveSessionMd(_root: string, scope = DEFAULT_SESSION_SCOPE): string | null {
  return getActiveSessionInfo(scope)?.mdPath ?? null
}

/**
 * use 子命令：激活会话（写内存 Map）+ 返回对齐 osp 的输出文本
 * （含 [SESSION CONTEXT] 标记 + todowrite 指令；标记随工具结果进 events 历史，
 *  进程重启后从当前会话 events 解析恢复）。
 */
export function useSession(root: string, key: string, scope = DEFAULT_SESSION_SCOPE): { dir: string; mdPath: string; context: string } {
  const sessionsDir = sessionsRoot(root)
  const session = findSession(sessionsDir, key)
  if (!session) {
    throw new Error(`Session not found: "${key}". Use "list" to see available sessions.`)
  }
  const mdPath = join(session.path, SESSION_MD)
  if (!existsSync(mdPath)) {
    throw new Error(`Session "${session.dirName}" has no SESSION.md — nothing to load.`)
  }
  const sessionId = extractSessionId(session.dirName) || basename(session.dirName)
  const dirName = session.dirName
  const shortName = dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')
  setActiveSessionInfo(scope, { sessionId, dirName, mdPath })
  const context = [
    `───────────────────────────────────────────────────────────────`,
    `${SESSION_CONTEXT_MARKER} ${dirName}`,
    `───────────────────────────────────────────────────────────────`,
    `Use "session show ${sessionId}" to view session details.`,
    `SESSION.md path: ${mdPath}`,
    ``,
    `→ All subsequent work should refer back to this session.`,
    `  Use "session show ${sessionId}" to check current progress.`,
    `  When a milestone lands or a decision is made: overwrite "当前状态" and append ONE`,
    `  milestone line to "日志" (one line + an evidence pointer — details go to the commit message).`,
    ``,
    `→ BEFORE responding to the user, you MUST call todowrite immediately`,
    `  with the session todo list. The first item MUST be:`,
    `    content: "SESSION: ${sessionId} — ${shortName}"`,
    `    status: "completed", priority: "low"`,
    `  Follow with any tasks parsed from SESSION.md.`,
    `───────────────────────────────────────────────────────────────`,
  ].join('\n')
  return { dir: dirName, mdPath, context }
}

/**
 * 从会话历史（events）解析会话身份（进程重启恢复；只扫**当前会话**自己的历史——无跨会话串台）。
 *
 * v1.24.11 稳固化（S142 用户需求：重建后新会话必须准确知道从哪个 SESSION 恢复）：
 * **路径规范行即可，不再要求 [SESSION CONTEXT] 标记**——`session use` 上下文与重建锚点
 * （buildRebuildAnchor 的 `- Persistent trajectory — SESSION.md path: <rel>` 行）同格式，
 * 因此**仅靠重建锚点的会话（从未显式 use）同样可恢复**。从**尾到头**扫描，最后一条
 * 合法路径胜出（时间序最新）；会话目录名/ID 从路径本身派生（单一真相源，不猜）。
 * 路径可为相对（重建锚点存 rel）——绝对化与存在性校验在调用方（知道 root）执行。
 */
export function parseSessionContextFromEvents(events: readonly unknown[]): ActiveSessionInfo | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const strs: string[] = []
    collectStrings(events[i], strs)
    for (const s of strs) {
      const md = extractSessionMdPathFromText(s)
      if (!md) continue
      // 兼容两种路径形态并归一为文件路径：`.../<session-dir>/SESSION.md`（真实契约）
      // 或 `.../<session-dir>`（旧写，目录形态）→ 补 /SESSION.md
      let dirName: string
      let filePath: string
      if (basename(md) === SESSION_MD) {
        dirName = basename(dirname(md))
        filePath = md
      } else if (isSessionDirName(basename(md))) {
        dirName = basename(md)
        filePath = join(md, SESSION_MD)
      } else {
        continue
      }
      if (!isSessionDirName(dirName)) continue
      // 🔴 2026-10-19：编码即 ID（自定义编码同样要能从这里恢复；旧实现只认 `S###` ⇒ 自定义编码会话
      //    重启后 sessionId 退化成整条目录名）。
      return {
        sessionId: parseTrajectoryCode(dirName) ?? dirName,
        dirName,
        mdPath: filePath,
      }
    }
  }
  return null
}

/** 递归收集对象/数组/字符串中的全部字符串（保留原文，无 JSON 转义） */
function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    out.push(v)
    return
  }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) collectStrings(val, out)
  }
}

// ── v1.24.11 稳固化：SESSION.md 路径规范行（use 上下文与重建锚点同格式）──

/** 规范行正则：`SESSION.md path: <路径>`（路径可含空格 → [^\r\n]+ 整行匹配） */
const SESSION_MD_PATH_RE = /SESSION\.md path:\s*([^\r\n]+)/

/** 从文本提取 SESSION.md 路径（use 上下文 / 重建锚点规范行通用；无匹配返回 null）。
 *  同行已知尾注（如系统提示词 Session 块的 persistent-body 注释）剥除——规范行只取路径本体。 */
export function extractSessionMdPathFromText(text: string): string | null {
  const m = text.match(SESSION_MD_PATH_RE)
  if (!m) return null
  let p = m[1]!.trim()
  // 🔴 本正则必须与**两个发射点逐字同步**：`seams/system-prompt.ts` 的 Session 块
  //    与 `trajectory/rebuild.ts` 的重建锚点规范行。改一侧不改另一侧 ⇒ 静默剥不掉尾注 ⇒
  //    解析出的路径带上注释文字 ⇒ 会话恢复断链，且 **typecheck 抓不到**（正则字面量无类型）。
  //    （2026-10-18 更名时由三个 worker 独立报出同一处，见 D156。）
  const suffix = p.search(/ \(the cognitive trajectory's persistent body/)
  if (suffix > 0) p = p.slice(0, suffix).trim()
  return p
}

/** 会话目录名形态校验（createSession 恒带日期前缀 `YYYY-MM-DD--`） */
function isSessionDirName(dirName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}--/.test(dirName) && dirName.length > 11
}

/**
 * 从 dsh 会话标题解析 SESSION 目录（编码无关 best-match，U3/U4）——
 * 标题不假设 S### 前缀（CCC 可自定义编码：apaas-xxx / P### / 完整目录名等）。
 * 匹配优先级（全部对 AGENT_SESSIONS 现有目录 best-match，不猜）：
 *   ① 标题即完整目录名（含日期前缀 `YYYY-MM-DD--`）→ 精确命中
 *   ② 标题含 `--<code>--` 段（如完整目录名被截断为 `<code>-日期-概括` 前段）→
 *      按 code 段匹配：取标题首 token（`-` 前），与各目录 `--<code>--`/`--<code>` 尾段比对
 *   ③ 唯一模糊子串匹配（多个则返回 null 防误猜）
 * @param title dsh 会话标题（如 `S142-2026-08-24-概括` / `apaas-26116-…` / 完整目录名）
 * @param sessionsDir AGENT_SESSIONS 绝对路径
 * @returns 命中目录的绝对路径（SESSION.md）；无/歧义返回 null
 */
export function resolveSessionByTitle(title: string, sessionsDir: string): string | null {
  const t = (title ?? '').trim()
  if (!t) return null
  const all = readAllSessions(sessionsDir)
  if (all.length === 0) return null

  // ① 完整目录名精确命中（标题可能直接就是目录名）
  if (isSessionDirName(t)) {
    const exact = all.find((s) => s.dirName === t)
    if (exact) return join(exact.path, SESSION_MD)
  }

  // ② code 段匹配：标题首 token（'-' 前）作为候选 code（S142 / apaas-26116 / P31…）
  const codeToken = t.split('-')[0]?.trim() ?? ''
  if (codeToken) {
    const byCode = all.filter((s) => {
      // desc 目录 `--<code>--` 段 或 issue 目录 `--<code>` 尾段
      const m = s.dirName.match(/--([^--]+)--/)
      const code = m ? m[1] : null
      const tailMatch = s.dirName.match(/--([^--]+)$/)
      const tailCode = tailMatch && !s.dirName.includes('--', s.dirName.lastIndexOf('--') + 3) ? tailMatch[1] : null
      return code === codeToken || tailCode === codeToken || s.dirName === codeToken || s.dirName.includes(`--${codeToken}`)
    })
    if (byCode.length === 1) return join(byCode[0]!.path, SESSION_MD)
    if (byCode.length > 1) return null // 歧义不猜
  }

  // ③ 唯一模糊子串（标题概括片段可能含目录描述）
  const fuzzy = all.filter((s) => s.dirName.toLowerCase().includes(t.toLowerCase()))
  if (fuzzy.length === 1) return join(fuzzy[0]!.path, SESSION_MD)
  return null
}

// ── summary ──

/**
 * summary 仪表盘（供 `list` 动作拼接；v1.33 起独立 `summary` 动作已撤，并入 list）。
 *
 * 🔴 **2026-10-18：四项生命周期计数已删**（Active / Completed / Stale / Ghost）。
 * 它们全都在给轨迹**分阶段**，而 owner 裁决「没有生命周期」⇒ 唯一有意义的总数是 `Total`。
 * ⚠️ **`Ghost` 也被删了**（"目录在但没 SESSION.md"）—— 它不是阶段而是**损坏**，但：
 *   · 真出现时 `use` 会在 `advisoryHint` 里**当场说清**（用到才发现，比长期挂一个计数更有效）；
 *   · 挂一个恒 0 的计数只会钝化注意力。
 * `Total` 现在 = **活跃轨迹数**（`_` 前缀的归档区与日志区已不在域内）。
 */
export function summarize(root: string): string {
  const sessions = readAllSessions(sessionsRoot(root))
  if (sessions.length === 0) return 'AGENT_SESSIONS/ is empty.'
  const now = Date.now()
  const recent = sessions.slice(0, 5)
  const lines: string[] = [
    `AGENT_SESSIONS Summary`,
    `────────────────────────`,
    `Active (not archived): ${sessions.length}`,
    ``,
    `Recent activity (top 5):`,
    ...recent.map((s) => {
      const age = Math.floor((now - s.mtime.getTime()) / DAY)
      return `  ○ ${s.dirName} (${age}d ago)`
    }),
  ]
  return lines.join('\n')
}

// ── archive（🔴 2026-10-18 新增：唯一的"状态变化"，单向）──

/**
 * 活跃轨迹的**结构化**清单（面板消费；owner 2026-10-18 需求二）。
 *
 * 🔴 为什么不在面板侧重新扫目录：**"哪些轨迹是活跃的"只有一个判据源** =
 * `readAllSessions`（它已经实现 `_` 前缀跳过 = 归档区不在域内）。面板若自己扫一遍
 * `AGENT_SESSIONS/`，就会长出**第二份会漂的实现** —— 归档之后面板仍会列出它，
 * 而这种不一致**没有任何机械信号**（两边各自都"跑成功了"）。
 *
 * 字段都取自**文件系统事实**，不做任何推断：
 * `dirName` / `sessionId`（S### ，无则 ''）/ `ageDays`（目录 mtime 距今天数）/ `hasSessionMd`。
 * ⚠️ **没有 `completed`** —— 轨迹没有生命周期（见文件头）。
 *
 * @param root CCC 根
 * @returns 按 mtime 降序的活跃轨迹（已排除 `_` 前缀目录）
 */
export interface TrajectorySummary {
  dirName: string
  sessionId: string
  /**
   * 唯一标识符（未设定 ⇒ `null`）。面板与 `list` 同源显示 ——
   * 它是"用于交流"的标识，人类在面板上看到它才能直接拿去用。
   */
  uid: string | null
  ageDays: number
  hasSessionMd: boolean
}

export function listActiveTrajectories(root: string): TrajectorySummary[] {
  const now = Date.now()
  return readAllSessions(sessionsRoot(root)).map((s) => ({
    dirName: s.dirName,
    sessionId: extractSessionId(s.dirName),
    uid: readTrajectoryUid(s.path),
    ageDays: Math.floor((now - s.mtime.getTime()) / DAY),
    hasSessionMd: s.status.hasSessionMd,
  }))
}

export interface ArchiveResult {
  message: string
  dirName: string
  from: string
  to: string
  dryRun: boolean
}

/**
 * 把一条轨迹**单向**归档到 `AGENT_SESSIONS/_archived/`（owner 2026-10-18 裁决）。
 *
 * ## 为什么这是"唯一"的状态变化
 * 轨迹没有生命周期 ⇒ 它**不完成、不关闭、不衰老**。它只会**换个存放位置**：
 * 从活跃区移到归档区。目录与 SESSION.md **逐字节不动**（纯 rename）——
 * 「归档」在此**不是删除，也不是收尾**，只是"不再列在活跃清单里"。
 *
 * ## 判据（R↓）
 * ① **单向**：owner 裁决不设 unarchive。恢复 = 手工 `container_fs mv` 移回。
 *    ⇒ 不提供反向动作，避免"两个方向各自实现一遍、语义各自漂移"。
 * ② **绝不覆盖**：目标已存在 ⇒ 报错，**不合并、不重命名、不删除**。归档是不可逆动作，
 *    静默覆盖会**毁掉**先前那条轨迹（它的 SESSION.md 是唯一副本）。
 * ③ **归档区不建在别处**：落点恒为 `<CCC>/AGENT_SESSIONS/_archived/`，
 *    与 `readAllSessions` 的 `_` 跳过判据**成对**（换一处就要同时改两处 ⇒ 不换）。
 * ④ `dryRun` 只报路径、不落盘。
 *
 * @param root CCC 根
 * @param key 目录名 / S### / 唯一模糊串（同 findSession）
 * @param dryRun 预览
 */
export function archiveSession(root: string, key: string, dryRun = false): ArchiveResult {
  const sessionsDir = sessionsRoot(root)
  const target = findSession(sessionsDir, key)
  if (!target) {
    throw new Error(`Trajectory not found: "${key}". Use "list" to see available trajectories.`)
  }
  const archiveRoot = join(sessionsDir, ARCHIVED_DIR)
  const dest = join(archiveRoot, target.dirName)
  // 判据②：目标已存在 ⇒ 响亮失败（绝不覆盖）
  if (existsSync(dest)) {
    throw new Error(
      `Cannot archive: "${target.dirName}" already exists in ${ARCHIVED_DIR}/. ` +
      `归档不会覆盖既有轨迹（那是不可逆的丢失）。请先人工处理 ${dest}`,
    )
  }
  if (dryRun) {
    return {
      message: `[dry-run] Would archive: ${target.dirName} → ${ARCHIVED_DIR}/`,
      dirName: target.dirName,
      from: target.path,
      to: dest,
      dryRun: true,
    }
  }
  mkdirSync(archiveRoot, { recursive: true })
  renameSync(target.path, dest)
  return {
    message: `Archived: ${target.dirName} → ${ARCHIVED_DIR}/`,
    dirName: target.dirName,
    from: target.path,
    to: dest,
    dryRun: false,
  }
}
