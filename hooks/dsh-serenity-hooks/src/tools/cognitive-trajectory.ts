/**
 * trajectory.ts — `cognitive_trajectory` 真实 DSH 工具定义（defineTool）
 *
 * v1.33（S142 §32 用户裁决）：由 `logbook` **更名并收敛为 `trajectory`**（v1.34：工具名再硬切为
 * `container_trajectory`，无别名）——cognitive trajectory 是一等概念
 * （SESSION.md 是它的持久身体），本工具管它的**载体生命周期 + 一次性时间安排**。
 * 动作面现行 **8 个**：list / show / create / use / rebuild / **`send-now`** / **`send-later`** / **`cro-guide`**。
 * 🔴 2026-09-16（所有者裁决）：**第 7 个动作 `send-message`（即时投递）**
 *    ——与 `wake-later` 共用取用通路，差别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）；
 *    实现落在 `wake/scheduler.ts` 的 `sendToTrajectory()`（"怎么把一句话送到一条轨迹"是调度器的知识）。
 *    设计稿 = `docs/cognitive-trajectory-send-message-design.md`（v0.2 定稿）。
 * 🔴 2026-09-17（所有者裁决 · **命名 A 案**）：**两个投递动作更名** —— `wake-later` → **`send-later`**、
 *    `send-message` → **`send-now`**。判据（R↓）：两者本是**同一条投递通路**（同取用机制 / 同载荷 /
 *    同落点语义），只差**时刻**；而「唤醒（冷载入）」是**两条路径共有**的属性，不配做区分
 *    ⇒ 族名取共享词干 **`send-`**、轴取 **`-now` / `-later`**（同构）。**硬切无别名**（D46/D61 先例）；
 *    机制层词汇（`wake-registry.json` / `w-*` id / `WakeEntry` / 调度器名 / 配置键 `wakeSchedulerEnabled`）
 *    **一律不动** —— 接受"机制叫 wake、动作叫 send-later"的**分层命名**（二者本是两层）。
 *    🔴 **2026-09-21 补注（不改写历史，只标失效时点）**：上句里那个**配置键 `wakeSchedulerEnabled`
 *    已随后续所有者令被砍**（唤醒调度器无闸、恒武装）⇒ 该词从"机制层词汇"里**自然减员**；
 *    现行总闸键是 CRO 阶段的 **`croEnabled`**。
 *
 * 与旧面（logbook 11 动作 + trajectory 12 动作）的对应（用户逐条裁决，R↓）：
 *   · `summary` → 并入 `list`（全库统计随清单一起给）
 *   · `health`/`qa` → **淘汰**：其判据是"旧六节模板合规"，而 ACC 层的编写标准已升级为 EAP
 *     ⇒ 只把**不依赖模板**的两项并入 `use`：空壳 / 长期无活动（**提示，不阻断**）
 *   · `close`/`archive` → 删：`completed` 本就由 SESSION.md 的 `[x]` 推导（不靠 close 写）；
 *     归档能力由 `container_fs mv → _archived/` 承担
 *   · `hook-develop-guide` → **淘汰**（v1.34.1：SEP 整体废除——「能落 harness 已有原语，
 *     就不要自造协议 + 脚本管道」；轨迹挂哪些 skill 改由 SESSION.md frontmatter 声明 +
 *     `systemPrompt.section` 注入，见 `docs/cognitive-trajectory-skill-injection.md`）
 *   · autopilot 面（all/init/random/diag/doc/check/status/guide）→ `container_admin` 的 autopilot 域
 *   · `wake-add`/`wake-list`/`wake-rm` → **`wake-later`**（v1.33 收敛；**2026-09-17 更名 `send-later`**）
 *   · 2026-09-20（CRO 落地）：新增 **`cro-guide`** —— CRO 编写指南的出口（纯读）。
 *     判据（R↓，为何在此而不新增域）：CRO 程序放在**轨迹自己的目录**里 ⇒ "怎么写它"是
 *     **逐轨迹**的知识，而管轨迹的人正是用本工具的人（设计 §9-5「既有 guide 位置，不新增域」）。
 *
 * 保留 osp 对齐语义的部分：create 的 `--desc`/`--issue` 二选一、use 激活即重命名 dsh 会话标题（F3）。
 * 活跃会话跟踪：内存 Map（按 dsh 会话 id 隔离）+ 从 events 恢复（S134）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { hostService } from '../host/access.js'
import type { JsonValue } from '../kernel/json.js'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { findSerenityRoot } from '../kernel/ccc.js'
import { agentCwdFor, cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../kernel/ccc-roots.js'
import { appendBound, readLastBound, resolveSessionCognitiveTrajectoryLabel, type BindWriteResult } from '../trajectory/bound.js'
import { addWake, WAKE_CATCH_UP_MS, type WakeEntry } from '../wake/registry.js'
import { sendToCognitiveTrajectory } from '../wake/scheduler.js'
import { CRO_GUIDE } from '../cro/guide.js'
import {
  listSessions,
  showSession,
  createSession,
  useSession,
  findSession,
  archiveSession,
  parseTrajectoryCode,
  readTrajectoryUid,
  UID_FILENAME,
  COGNITIVE_TRAJECTORY_ACTIONS,
  DEFAULT_SESSION_SCOPE,
  getActiveSessionInfo,
  namingTitleFor,
  summarize,
  type ActiveSessionInfo,
  type CreateSessionResult,
} from '../trajectory/core.js'
import { listResident } from '../trajectory/resident.js'
import { listRunningSessionIds } from '../cro/turns.js'
import { sessionsRootDir } from '../trajectory/cleanup.js'
import { hostAgents } from '../host/access.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toMessage, makeInjection } from '../kernel/injection.js'
import {
  DEFAULT_LOOKBACK_MS,
  projectDirNameForCwd,
  scanInterruptedSessions,
  createResumeOne,
  formatPendingTools,
  type ScanResult,
  type ResumeOutcome,
} from '../trajectory/interrupted.js'

/**
 * 当前**正在跑轮次**的 dsh 会话 id（用于把 live 会话排除出"待续"名单）。
 *
 * 🔴 **为什么必须排除**：一个正在跑的会话，其日志末条**不是** `session/end-seed`
 * （它还在写），所以按判据本来也不会命中；但排除是**双保险** ——
 * 万一某轮刚被中断、宿主还没来得及继续，把 live 会话当"待续"会导致**重复投递**。
 *
 * ── 🔴🔴 2026-10-23 A105：**从「live 表」改为「在跑表」，且从 `ctx` 取数** ──────────
 *
 * **修前有两个缺陷，叠在一起让这段排除在生产上形同虚设：**
 *
 * ① **`ctx` 传的是 `undefined`** ⇒ `listLiveSessions(undefined)` ⇒ `hostSessions(undefined)`
 *    ⇒ 取不到宿主 ⇒ **live 表恒空** ⇒ `scanInterruptedSessions` 的 `liveIds` 是空集。
 *    ⚠️ 原注释写「ctx 在 execute 里拿不到（本工具只拿到 exec）」，**那句是错的**：
 *    本工具的工厂 `createCognitiveTrajectoryTool(ctx)` **闭包捕获了真 ctx**，
 *    且同文件的 `continue-all-interrupted` 分支早就靠它取 `hostAgents(ctx)` / `hostService(ctx,…)`
 *    —— 见那一支的注释「**必须用工厂参数 `ctx`，不能用 `exec`**」。**同一份源码里，
 *    一处说"拿不到"、另一处说"必须用它"**，这正是两个读数打架的典型形态。
 *
 * ② **粒度错了：`live ≠ 在跑`。** `listLiveSessions` 答的是「宿主认不认识这个会话」
 *    （会话对象已载入本进程），**不是**「它此刻有没有轮次在跑」。
 *    ⇒ 一条**已载入但空闲**的会话会被误排除 ⇒ **它恰恰是"上一轮被重启打断、最该被接走"的那一类**。
 *    2026-10-23 实测：同一时刻 `acc-diag` 把一条会话列为 live，而本动作把它当命中扫出 ⇒
 *    两个口径两个答案；随后真机证明那条会话当时**确实该被接走**。
 *
 * ⇒ **现在答的是「此刻有没有在跑」**，取数口 = `listRunningSessionIds(nowMs)`（`cro/turns.ts`）：
 *   由 `agent/status=running` 置位、`idle` 清位，`TURN_TTL_MS` 兜底。
 *
 * 🔴 **不要再改回「宿主认不认识它」** —— 这是本函数最容易被"改得更省事"而改回去的地方。
 *    「宿主认识」是**载入状态**，「在跑」是**轮次状态**，两者互不蕴含：
 *    载入而空闲（该接走）、在跑但刚被中断（该接走）、在跑且健康（才该排除）。
 *    只有第三格该排除 ⇒ 判据必须是轮次状态。
 *
 * 拿不到 running 表时退化为空集（不阻断扫描，只少一层保护）—— 与修前同口径。
 */
function collectRunningSessionIds(nowMs: number): Set<string> {
  const out = new Set<string>()
  try {
    for (const id of listRunningSessionIds(nowMs)) {
      if (typeof id === 'string' && id) out.add(id)
    }
  } catch {
    /* running 表不可用 → 退化为空集 */
  }
  return out
}

/**
 * 渲染 `interrupted` 扫描结果（人读）。
 *
 * 显示口径：**先给"有没有"，再给每一条的定位信息，最后给边界说明**。
 * ⚠️ 明确写出"这些会话是否续跑由调用方决定" —— 否则读者会以为本动作已经处理了。
 */
function renderInterruptedScan(input: {
  projectDir: string
  lookbackHours: number
  scan: ScanResult
}): string {
  const { projectDir, lookbackHours, scan } = input
  const lines: string[] = []
  const excludedCount = scan.excluded.length
  const undecidableCount = scan.undecidable.length
  lines.push(`═══ 末轮未跑完的 dsh 会话（回看 ${lookbackHours}h）═══`)
  lines.push(`  扫描域: ${projectDir}`)
  // 🔴🔴 D245：**窗口内总数 = 检查 + 排除**，两个数必须同屏。
  //    修前只报「检查 N」⇒ 读者以为"就这么点会话"，而实际上被排除的那批**看不见**
  //    （真机实测：guard 看到「检查 7 · 命中 0」判「没事」，而同一刻生产日志写着
  //     「排除在跑 4 个」—— 该救的 4 个就此无人过问）。
  lines.push(
    `  检查 ${scan.scanned} 个 · 命中 ${scan.sessions.length} · 跳过 ${scan.skipped}` +
      (excludedCount > 0 ? ` · 排除在跑 ${excludedCount} 个` : '') +
      ` · 不可判定 ${undecidableCount} 个` +
      ` · 耗时 ${scan.elapsedMs}ms${scan.errors.length > 0 ? ` · 读取失败 ${scan.errors.length}` : ''}`,
  )
  if (excludedCount > 0) {
    lines.push(
      `  ⓘ 窗口内共 ${scan.scanned + excludedCount} 个会话，其中 ${excludedCount} 个**此刻有轮次在跑**，` +
        `按「正在跑的不该被判为待续」的纪律被排除：`,
    )
    for (const id of scan.excluded) lines.push(`      - ${id}`)
    lines.push('    ⚠️ 这些**没有**被检查过。若你认为其中某个其实已死（进程重启后残留的"在跑"标记），')
    lines.push('      请告知 ACC 维护方 —— 那是「在跑」表的判据问题，不是扫描的问题。')
  }
  // 🔴🔴 A108：「不可判定」单开一桶 —— ⛔ 不许把它与「跳过（看过、判定没事）」混为一谈。
  if (undecidableCount > 0) {
    lines.push('')
    lines.push(`  ⚠️ **不可判定 ${undecidableCount} 个** —— 这些**既不是"命中"也不是"没事"**，是"判不出来"：`)
    for (const u of scan.undecidable) {
      const at = u.lastEventAt !== null ? new Date(u.lastEventAt).toISOString() : '(时间未知)'
      lines.push(`      - ${u.sessionId}（末事件 ${at}）`)
      lines.push(`        ${u.reason}`)
    }
    lines.push('    ⇒ 成因通常是：**一整轮长到 8 MiB 都装不下它的起点**（`turn/start` 在窗口之外）。')
    lines.push('    🔴 **是否处理由你决定**（ACC 不代判）。本仓纪律：**宁可多醒不可漏** ⇒ 倾向按"该接走"处理。')
  }

  if (scan.sessions.length === 0) {
    lines.push('')
    const tails: string[] = []
    if (excludedCount > 0) tails.push(`另有 ${excludedCount} 个在跑，未检查`)
    if (undecidableCount > 0) tails.push(`另有 ${undecidableCount} 个**不可判定**`)
    lines.push(
      tails.length > 0
        ? `✓ 被检查的 ${scan.scanned} 个里没有末轮未跑完的 —— ${tails.join('；')}（见上）。`
        : '✓ 没有末轮未跑完的会话 —— 无需处理。',
    )
    return lines.join('\n')
  }

  lines.push('')
  for (const s of scan.sessions) {
    const at = s.lastEventAt !== null ? new Date(s.lastEventAt).toISOString() : '(时间未知)'
    lines.push(`  · ${s.sessionId}`)
    // 🔴 D244：**形态 ＋ 窗口读数一并给人** —— 调用方要能自己判"该不该注入"。
    //    ⚠️ `lastTurnEndKind` 为 null 是**语义**（形态 B 没有末条 turn/end），不是"没读到"。
    const formText = s.form === 'unclosed' ? '未收尾（窗口内无 turn/end）' : '有收尾（reason.kind 命中）'
    lines.push(`      轮次 turn=${s.turn ?? '?'} · 末事件 ${at}`)
    lines.push(
      `      形态 ${s.form} = ${formText}` +
        ` · 末条 turn/end.kind=${s.lastTurnEndKind ?? 'null'}` +
        ` · 窗口内最后 turn/start=${s.lastTurnStartTurn ?? 'null'}`,
    )
    if (s.pendingTools.length > 0) {
      lines.push(`      ⚠️ 有调用无结果的工具（副作用未知）: ${formatPendingTools(s.pendingTools)}`)
    }
  }

  lines.push('')
  lines.push('判据（两种形态，任一命中即收）:')
  lines.push('  A `interrupted-end`: 末条 `turn/end.reason.kind` ∈ {interrupted, aborted}，且其后没有新的 turn/start。')
  lines.push('      interrupted = 进程崩溃后被 resume 补收尾 ／ aborted = 被正常终止（重启、销毁、用户中断）。')
  lines.push('  B `unclosed`: 窗口内最后一条 `turn/start` 之后没有 `turn/end`（进程在轮内任意位置死掉，宿主来不及写收尾）。')
  lines.push('🔴 **怎么用「形态」判该不该续**（调用方口径，ACC 不代判）:')
  lines.push('  · 投递方式 `cold-resume` ⇒ 该会话**未被载入本进程**（死着）⇒ 真需要接走；')
  lines.push('  · 投递方式 `live+steer` ⇒ 它在进程里 ⇒ ⚠️ **「载入」≠「空闲」**：')
  lines.push('      `form=unclosed` 且 `窗口内最后 turn/start` == 命中 turn ⇒ 可能**那一轮正在跑** ⇒ 先核再注入。')
  lines.push('🔴 本动作**只读** —— 是否续跑、续哪条、几点续，由调用方（你的认知轨迹）决定。')
  lines.push('⚠️ 未完成的工具调用「副作用未知」≠「没执行」：它们可能已写文件 / 已发消息。')
  lines.push('   续跑前应先核对副作用，而不是把那一轮整段重放。')

  if (scan.errors.length > 0) {
    lines.push('')
    lines.push('读取失败（诊断）:')
    for (const e of scan.errors.slice(0, 10)) lines.push(`  · ${e.sessionId}: ${e.message}`)
  }
  return lines.join('\n')
}

/**
 * 渲染 `continue-all-interrupted` 的结果（人读）。
 *
 * 三种形态必须能一眼分清：**dryRun（只预告）** ／ **有命中且全成功** ／ **有失败**。
 * ⚠️ 明确写出"已注入 ≠ 已跑完" —— 与 `send-now` 的回执口径一致（D-族：回执只到注入）。
 */
function renderContinueResult(input: {
  projectDir: string
  lookbackHours: number
  scan: ScanResult
  outcomes: ResumeOutcome[] | null
  dryRun: boolean
}): string {
  const { projectDir, lookbackHours, scan, outcomes, dryRun } = input
  const lines: string[] = []
  const excludedCount = scan.excluded.length
  const undecidableCount = scan.undecidable.length
  const head = dryRun ? '续跑预告（dryRun，未注入任何消息）' : '中断续跑结果'
  lines.push(`═══ ${head}（回看 ${lookbackHours}h）═══`)
  lines.push(`  扫描域: ${projectDir}`)
  // 🔴🔴 D245：与 `renderInterruptedScan` 同口径 —— 排除数必须同屏（理由见那里的注释）。
  lines.push(
    `  检查 ${scan.scanned} 个 · 命中 ${scan.sessions.length} · 跳过 ${scan.skipped}` +
      (excludedCount > 0 ? ` · 排除在跑 ${excludedCount} 个` : '') +
      ` · 不可判定 ${undecidableCount} 个` +
      ` · 耗时 ${scan.elapsedMs}ms`,
  )
  if (excludedCount > 0) {
    lines.push(`  ⓘ 另有 ${excludedCount} 个会话**此刻有轮次在跑**，未检查：${scan.excluded.join('、')}`)
  }
  if (undecidableCount > 0) {
    lines.push(
      `  ⚠️ 另有 ${undecidableCount} 个**不可判定**（既非同中、也非没事），**未处理**：` +
        scan.undecidable.map((u) => u.sessionId).join('、'),
    )
    lines.push('    ⇒ 若要处理它们，须人工/调用方判断（ACC 不代判）。')
  }

  if (scan.sessions.length === 0) {
    lines.push('')
    const tails: string[] = []
    if (excludedCount > 0) tails.push(`另有 ${excludedCount} 个在跑，未续`)
    if (undecidableCount > 0) tails.push(`另有 ${undecidableCount} 个不可判定`)
    lines.push(
      tails.length > 0
        ? `✓ 被检查的 ${scan.scanned} 个里没有末轮未跑完的 —— ${tails.join('；')}（见上）。`
        : '✓ 没有末轮未跑完的会话 —— 无需续跑。',
    )
    return lines.join('\n')
  }

  lines.push('')
  if (dryRun) {
    lines.push('将对这些会话注入续跑消息:')
    for (const s of scan.sessions) {
      const at = s.lastEventAt !== null ? new Date(s.lastEventAt).toISOString() : '(时间未知)'
      lines.push(`  · ${s.sessionId}  turn=${s.turn ?? '?'}  末事件 ${at}`)
      if (s.pendingTools.length > 0) lines.push(`      副作用未知: ${formatPendingTools(s.pendingTools)}`)
    }
    lines.push('')
    lines.push('要真的执行，去掉 dryRun 再调用一次。')
    return lines.join('\n')
  }

  const okCount = (outcomes ?? []).filter((o) => o.ok).length
  const failCount = (outcomes ?? []).length - okCount
  lines.push(`结果：已注入 ${okCount} ／ 失败 ${failCount}`)
  lines.push('')
  for (const o of outcomes ?? []) {
    lines.push(o.ok ? `  ✓ ${o.sessionId}  (${o.how ?? '已注入'})` : `  ✗ ${o.sessionId}  ${o.error ?? '未知原因'}`)
  }
  lines.push('')
  lines.push('⚠️ 回执只到「消息已注入」——**不表示**目标已经跑完或已答复。')
  lines.push('   要确认它真的动了，去看该会话的日志 / 它自己的 SESSION.md。')
  if (scan.errors.length > 0) {
    lines.push('')
    lines.push('扫描期读取失败（诊断）:')
    for (const e of scan.errors.slice(0, 10)) lines.push(`  · ${e.sessionId}: ${e.message}`)
  }
  return lines.join('\n')
}
/** 当前 dsh 会话 id（use/close 按会话隔离的 scope） */
function agentScope(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? DEFAULT_SESSION_SCOPE
}

/**
 * 当前 dsh 会话对象（绑定的读写都要用它）；无 `append` → null。
 *
 * 🔴 **2026-09-21 修 F3（原实现是 F1 的上游成因）**：本函数原先把会话**削成只带 `append` 的包装对象**。
 * 但 `appendBound` / `readLastBound` 定位"这是哪条会话、哪个 CCC 根"靠的是
 * `session.header.id` 与 `session.header.cwd`（见 `trajectory-bound.ts` 的 `sessionHeader`）——
 * **包装对象没有 header** ⇒ ① `appendBound` **在读 id 处直接 `return false`**（静默 no-op）
 * ⇒ **`use` 这条路从来不写当前载体的绑定**（实证吻合：S142 §7.4 记录"当前载体的绑定**直到
 * 17:05 那次 rebuild 才写入**"）② `readLastBound` 同样恒 null ⇒ G1 切换守卫只能靠内存回退。
 * ⇒ 改为**返回原会话对象**（只增字段、不削字段）：只用 `append` 的调用点行为不变，
 *   而绑定读写从此拿得到 header。
 */
function agentDshSession(
  exec: { agent?: { session?: unknown } },
): { append: (type: unknown, data: unknown) => unknown; header?: unknown } | null {
  const s = exec.agent?.session as { append?: unknown } | undefined
  return s && typeof s.append === 'function'
    ? (s as { append: (type: unknown, data: unknown) => unknown })
    : null
}

/**
 * 当前绑定的权威 dirName（优先持久化 bound——防内存被误 use 污染；无 bound 回退内存 active）。
 * 供 G1 守卫对比目标会话是否切换。
 */
function currentBoundDirName(exec: { agent?: { session?: unknown } }, scope: string): string | null {
  const dsh = agentDshSession(exec)
  const bound = dsh ? readLastBound(dsh) : null
  if (bound) return bound.dirName
  return getActiveSessionInfo(scope)?.dirName ?? null
}

// ── v1.21 F3：use 后重命名当前 dsh 会话（纯逻辑，可单测）──
// v1.27.1：**永远开启**（S142 用户拍板"开关下掉，永远开启"）——命名是固定行为，
// 移除 naming.enabled 简单配置开关；仅剩 sessionTitle 服务可用性守卫。

interface RenameOnUseDeps {
  /** sessionTitle 服务可用性 */
  sessionTitleAvailable: boolean
}

// 🔴 2026-09-25（S142 工程化程序第 ④ 项·第 1 步）：`sanitizeSessionSummary` 与 `namingTitleFor`
// **已下沉到 L1 的 `trajectory-ops.ts`** —— 解 L1→L3 上行边 ＋ `trajectory/rebuild.ts` ⇄ 本文件的依赖环
// （证据＝模块图 §3-6）。此处只保留**用**它们的门面（`renameDshSessionOnUse` 等）。

/**
 * use 激活宁静号会话后，把当前 dsh 会话重命名为命名标题（`S###-日期[-概括]`）。
 * v1.27.1：**永远开启**（不再有 naming.enabled 门控）——仅 sessionTitle 服务
 * 存在性守卫；失败不静默——返回结果对象而非 null（v1.22.9），调用方决定可见性。
 *
 * 需求②（S142 用户拍板）：summary 参数（≤20 字概括）→ 标题带概括；编号日期固定派生。
 *
 * v1.23.2 修复（this 绑定）：第三参从**解构的裸 rename 函数**改为**整个
 * sessionTitle 服务对象**——内部以 `titles.rename(session, title)` **方法调用**
 * （this = titles 服务实例）。旧实现调用点 `const rename = titles.rename` 解构
 * 后传入，方法内部读 `this.assertServiceActive` → this=undefined 抛错
 * （日志实证：`Cannot read properties of undefined (reading 'assertServiceActive')`；
 * 与 v1.20.2/1.20.3 图片落盘同款解构丢 this bug）。
 * @returns { title, ok } 或 { ok:false, reason }（未执行/失败均返回对象）
 */
export function renameDshSessionOnUse(
  deps: RenameOnUseDeps,
  session: unknown,
  titles: { rename: (session: unknown, title: string) => unknown } | undefined,
  active: ActiveSessionInfo,
  summary?: string,
): { ok: true; title: string } | { ok: false; reason: string } {
  if (!deps.sessionTitleAvailable) return { ok: false, reason: 'sessionTitle service unavailable' }
  if (!titles || typeof titles.rename !== 'function') return { ok: false, reason: 'sessionTitle service unavailable' }
  const title = namingTitleFor(active, summary)
  try {
    titles.rename(session, title)
    return { ok: true, title }
  } catch (error) {
    return { ok: false, reason: `rename threw: ${String((error as Error)?.message ?? error)}` }
  }
}

/**
 * 从 create 结果构造命名用 ActiveSessionInfo（v1.25.11，S142 用户：create 也要命名）：
 * createSession 返回的 result 已含 sessionId（S###/issue）与 dirName——无需等待 use 激活，
 * 直接构造（mdPath = sessionPath/SESSION.md，与 use 时一致）即可驱动 renameDshSessionOnUse。
 */
export function activeInfoFromCreate(result: CreateSessionResult): ActiveSessionInfo {
  return {
    sessionId: result.sessionId,
    dirName: result.dirName,
    mdPath: join(result.sessionPath, 'SESSION.md'),
  }
}

/**
 * 把当前 dsh 会话重命名为指定 SESSION 的命名标题（use/create 共用；v1.25.11）。
 * 需求②：summary 参数（≤20 字概括）透传——标题带概括（编号日期固定派生）。
 * 门控/失败可见性与 renameDshSessionOnUse 一致（不静默：成功 log / 失败 warn）。
 * 调用点（use 分支原内联逻辑提取，create 分支复用）：
 *   - use：激活后从 activeStore 取 info
 *   - create：createSession 结果经 activeInfoFromCreate 构造 info
 */
export function renameDshSessionForActive(
  ctx: Context,
  exec: { agent?: { session?: unknown } },
  info: ActiveSessionInfo,
  summary?: string,
): void {
  try {
    // v1.23.2：传整个 sessionTitle 服务对象（不解构 rename 函数）——
    // 旧实现 `titles.rename` 解构后传裸函数，方法内部 this=undefined 抛错
    const titles = hostService(ctx, 'sessionTitle')
    const dshSession = exec.agent?.session
    if (!dshSession) {
      console.warn(`[serenity-hooks] dsh 会话重命名未执行: 缺少 agent session（info: ${info.sessionId}）`)
      return
    }
    const result = renameDshSessionOnUse(
      { sessionTitleAvailable: true },
      dshSession,
      titles as { rename: (session: unknown, title: string) => unknown } | undefined,
      info,
      summary,
    )
    if (result.ok) {
      console.log(`[serenity-hooks] dsh 会话已重命名: ${String((dshSession as { id?: string }).id ?? '?')} → ${result.title}`)
    } else {
      console.warn(`[serenity-hooks] dsh 会话重命名未执行: ${result.reason}`)
    }
  } catch (err) {
    // 主流程仍完成（create/use 已执行）；仅重命名失败需要可见
    console.warn(`[serenity-hooks] dsh 会话重命名异常: ${String((err as Error)?.message ?? err)}`)
  }
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

// ── v1.34.1：SEP（Session Extension Protocol）整体废除 ──
// 原「CCC 注册 session-tool MSM → ACC 在生命周期点 spawn 它」的协议 + 脚本管道已删除
// （所有者裁决「能落 harness 已有原语，就不要自造协议 + 脚本管道」）。扩展面改为：
//   · 轨迹挂哪些 skill → SESSION.md frontmatter 声明 + systemPrompt.section（docs/cognitive-trajectory-skill-injection.md）
//   · 其余扩展 → harness 已有原语（工具/section/配置），不再经 ACC 的钩子通道。

/**
 * 创建 cognitive trajectory 工具（原 logbook；v1.33 S142 §32 更名 + 动作收敛）。
 * 闭包捕获插件 ctx → use 后可调 ctx.sessionTitle.rename。
 */
export function createCognitiveTrajectoryTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
  name: 'cognitive_trajectory',
  // 🔴 本描述按 **EAP 五层压缩层级**组织（owner 令 2026-10-16；2026-10-20 二次重写；
  //    2026-10-24 三次重写 = owner 令「用符合 EAP 的自然语言」）。
  //    用**数组 join** 而非一长串 `+`：每个元素 = 一段，段的边界在源码里可见。
  //    ⚠️ 相邻字符串字面量在 JS 里**不会**自动拼接（那不是 JS 语法）——必须显式 join 或 `+`。
  //    🔴 第三版的关键改动是**行文形态**：前两版用全大写 + 斜杠枚举 + ⇒ 箭头做压缩标记，
  //       那**把重建成本推给读者**（EAP 反对的形态）。本版全部改为自然英语散文，
  //       句子自己承担结构；段落顺序仍对应五层（公理/本体/拓扑/动力学/表面）。
  //    🔴 join 分隔符是 `\n\n` 而非空格：自然语言靠**段落**分段，粘成一行会毁掉这一点。
  //    🔴 判据守恒：66 条语义逐条仍在（校验件 = AGENT_SESSIONS/S142 的 prompt-cost11.dev.test.ts）。
  description: [
    'A cognitive trajectory is a durable body — its SESSION.md — that outlives every conversation carrying it.',
    'Three axioms hold. The trajectory is the subject and the conversation is only its carrier, so rebuilding the carrier leaves SESSION.md byte for byte identical. A trajectory has no lifecycle: it never completes, closes, or expires, and its age never counts against it — only where it is stored changes, so archiving removes it from the active list without touching its directory. And identity is the code, the fixed `YYYY-MM-DD--<code>[--<desc>]` segment of the directory name, never the summary or the title; create --id chooses it.',
    'What this tool never does: it never deletes a trajectory, never edits the content of SESSION.md, and never schedules recurring work, because that belongs to cro-guide.',
    'A trajectory is a directory under AGENT_SESSIONS/ holding a SESSION.md, a carrier is a dsh session bound to one, and the binding declaration is the file current.dsh_session_bind inside the trajectory: one file per trajectory, a single slot, never a table.',
    'Three rules are immutable. A session belongs to at most one trajectory for its whole life, so use refuses a session already carrying another, and there is no --force override — that flag was retired on 2026-10-20 and now only explains why; to give another trajectory a carrier, open a new session. A trajectory has at most one current carrier, and the binding declaration is the only truth about which, so other open sessions are simply unbound; never infer a binding from a session looking active. A declaration whose session no longer exists counts as unbound, and no cleanup is required, because a stale declaration deliberately records who carried the trajectory last.',
    'Actions are grouped by effect, and the grouping answers one question: would this change what I am bound to? The lifecycle group does change this conversation\'s binding — list, show, create, use, rebuild, and archive, where archiving is one-way, never overwrites, and leaves content untouched. The delivery group sends one message to another trajectory and leaves your own binding alone — send-now and send-later. One action is a reference rather than an operation: cro-guide explains how to give a trajectory its own program deciding when it should be woken. The inspection action is read-only: interrupted returns the dsh sessions whose last turn did not finish. A turn is unfinished when its reason.kind is "interrupted", meaning the process died, or "aborted", meaning it ended normally through a restart, a dispose, or a cancel; both mean the turn did not complete, so taking only one would miss a whole class. It schedules nothing, continues nothing, and mutates no log — deciding whether and when to resume belongs to the caller. The criterion is exactly "the last turn did not finish", never "was ever interrupted", since one long session may have been interrupted dozens of times and already recovered. Each hit also names the turn number and the tools that made a call without a result, but those side effects are unknown, so do not re-run them blindly.',
    'Choose by rule, not by guess. Not yet bound and starting new work: create, which activates itself at once when there is no prior binding. Already bound and recording a separate future line: also create, since that leaves your binding intact and you can activate it later with send-now. Want this conversation to move: use, and treat its refusal — when the session already carries another trajectory — as the design rather than an error to work around. Want another trajectory to act: send-now, whose target needs no prior setup, since a live session is created, bound, and injected when none exists.',
    'Read a receipt for no more than it says. send-now returns a synchronous receipt meaning the message was injected and the turn started; it never means the target ran or replied, and to prove the target moved you must read its SESSION.md. send-now never queues behind the current turn — a busy target is steered mid-turn while an idle one starts at once. send-later is fire-and-forget by design, with no receipt and no recall.',
    'The asymmetry is deliberate: send-now may create a missing carrier, send-later never does, because scheduling work for a trajectory that never existed is almost always a mistyped name. A carrier guard applies to send-now: it creates a carrier automatically only for a trajectory that has never had one, and otherwise refuses, either because a declaration exists but its session is gone or because the declared session cannot be resolved at all — one trajectory keeps one carrier.',
    'For parameters: create needs --desc with optional --id and --goal, or --issue instead, exactly one of those two forms, plus --summary of at most 20 characters. use needs --name and --summary. rebuild needs --summary naming the next phase in at most 20 characters, plus an optional --note of at most 200 characters stating the task focus for the rebuilt self. send-now needs a target and a message; send-later needs a target, an instant as RFC 3339 with a timezone or a relative form like +30m or +2h, and a message. A target or name may be a code such as S### or a custom one, a full AGENT_SESSIONS directory name, or a fuzzy keyword. --force is still accepted but always refused, being retired and existing only to explain why. uid reads a legacy TRAJECTORY-UID only, since setting one is retired and the code is now the identity. summary is appended to the dsh session title alongside the code and date, which stay server-derived unless you pass --id.',
    'Two rules of conduct, not operations. create and send-now both cost real work and must serve a human intent, so call create only when the user asked for a new line of work or confirmed one — never to tidy up and never to pre-provision what nobody requested; when in doubt, ask. That is etiquette with a cost rather than a mechanical gate. And to describe yourself rather than operate: your own charter in PROMPT.md, a resident declaration through resident.serves in trajectory.json, and self-restriction by tool and model whitelists all live in container_admin config docs trajectory-self — read that chapter before changing any file in your own directory.',
  ].join('\n\n'),
  parameters: {
    action: {
      type: 'string',
      enum: [...COGNITIVE_TRAJECTORY_ACTIONS],
      required: true,
      description: [
        'Subcommand — grouped by effect (see Tier 3 of the description).',
        'LIFECYCLE (changes THIS conversation\'s binding):',
        'list (inventory + stats) / show (a code, dir name, or fuzzy keyword) /',
        'create (new trajectory; --id sets its code. Activates itself when you have no binding, otherwise leaves your binding untouched and tells you how to activate it) /',
        'use (activate context for THIS conversation; refuses if this session already carries another trajectory — no override) /',
        'rebuild (clear-and-rebuild current conversation — requires --summary + optional --note) /',
        'archive (move a trajectory to the archived area; one-way, refuses to overwrite, content untouched — --dryRun previews).',
        'DELIVERY (sends one message to ANOTHER cognitive trajectory; your binding is unchanged):',
        'send-now (deliver RIGHT NOW; the target needs no prior setup — if it has no live session, one is created and bound automatically) /',
        'send-later (one future instant + one message; fire-and-forget, and it does NOT auto-create a target).',
        'REFERENCE: cro-guide (no parameters: prints the CRO programming guide, including a ready-to-use sample snapshot) /',
        'resident (READ-ONLY: the roster of trajectories that declared themselves RESIDENT — "I am here, this is what I am good at, come bother me". It lists each code with its own `serves` sentence, plus any code that wrote `resident` without `serves` (half a declaration is worse than none: people ask, then find they asked the wrong one). ⚠️ Residency is NOT a resource state — it does not mean "never sleeps" or "never destroyed"; a trajectory permanently exists either way. It governs BEING FOUND, not being kept alive, and it never touches the scheduler).',
        'INSPECTION: interrupted (READ-ONLY: dsh sessions whose LAST turn ended with reason "interrupted" — the process died mid-turn. Accepts an optional lookbackHours (default 8). Deciding whether/when to resume is YOUR job — this action only answers "which sessions are in that state right now") /',
        'continue-all-interrupted (ACTION: same detection as above, but it then INJECTS a short continue message into every hit, waking them. Serial delivery. Supports dryRun to preview without injecting. ⚠️ This really starts agents and spends real compute — use dryRun first if unsure. The receipt means "injected", NOT "the target finished or replied").',
      ].join(' '),
    },
    name: { type: 'string', description: 'show/use/archive/uid identifier — a trajectory code (S### or a custom code) / dir name / legacy UID / fuzzy keyword' },
    uid: { type: 'string', description: `uid: READ-ONLY legacy field. Omit to read a trajectory's legacy ${UID_FILENAME}. Passing any value is REJECTED — setting a UID is retired (2026-10-19); a trajectory's code is its unique identity now, and you choose it at creation with create --id <code>.` },
    note: { type: 'string', description: 'rebuild: task focus ≤200 chars for the rebuilt self — what to work on next (short, no history; SESSION.md holds the full history). Injected as "- Task focus: …" into the rebuild anchor.' },
    desc: { type: 'string', description: 'create: short description (any language, ≤5 words; mutually exclusive with issue). 🔴 AUTHORIZATION: create is user-intent-driven — do not create a trajectory the user did not ask for (see the tool description).' },
    id: { type: 'string', description: 'create: the trajectory CODE to assign (its stable unique identity — this is what you later pass as name/target). Omit to auto-assign S###. Allowed [A-Za-z0-9._-], starts alphanumeric, ≤64, must NOT contain Chinese or "--" (that is the dir-name separator); must not collide with an active trajectory code.' },
    issue: { type: 'string', description: 'create: ticket number (e.g. apaas-26116; dir named YYYY-MM-DD--<issue>; mutually exclusive with desc)' },
    goal: { type: 'string', description: 'create: one-sentence goal (optional)' },
    summary: { type: 'string', description: 'content summary ≤20 chars (REQUIRED for use and create — create exempts --dry-run preview and --issue sessions) — appended to the dsh session title as S###-YYYY-MM-DD-<summary>; the S### id and date stay server-derived; sanitized/truncated server-side' },
    force: { type: 'boolean', description: 'use: RETIRED (2026-10-20) — one session belongs to one cognitive trajectory for life, so switching is refused unconditionally. The flag is still ACCEPTED so that an old call gets an explanation instead of an "unknown argument" error; it never overrides the guard.' },
    dryRun: { type: 'boolean', description: 'create: preview mode (no actual changes). continue-all-interrupted: preview which sessions WOULD be resumed, injecting nothing.' },
    target: { type: 'string', description: 'send-later/send-now: target cognitive trajectory (S### or AGENT_SESSIONS directory name)' },
    at: { type: 'string', description: 'send-later: future instant (RFC3339 with timezone, or relative +30m / +2h)' },
    message: { type: 'string', description: 'send-later/send-now: the single message delivered to the target cognitive trajectory. send-now may create and bind a carrier ONLY when the target has never had one — acceptable only for a delivery the user actually wants made (user-intent-driven), never for speculatively starting work.' },
    lookbackHours: { type: 'number', description: 'interrupted / continue-all-interrupted: how far back to look, in hours (default 8). Sessions whose current-generation log was last written earlier than this are not examined at all.' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = cccRootForExec(exec)
    if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)

    switch (args.action) {
      case 'list': {
        // v1.33：原 `summary` 动作并入 list（用户裁决）——清单 + 全库统计一次给全
        return listSessions(root) + '\n' + summarize(root)
      }
      case 'show': {
        if (!args.name) throw new Error('show requires name (S### or directory name)')
        return showSession(root, args.name)
      }
      case 'create': {
        // 需求②：create 也加 summary（用户拍板"create 也带概括"）——必填（编号日期固定派生，概括由调用方显式给）
        // P3-① review：dry-run 豁免（未真实创建无命名对象）+ issue 会话豁免（issue 无概括语义，标题回退目录名）
        const isDryRun = args.dryRun ?? false
        const isIssueSession = typeof args.issue === 'string' && args.issue !== ''
        if (!isDryRun && !isIssueSession && (!args.summary || args.summary.trim() === '')) {
          throw new Error('create requires --summary <content summary ≤20 chars> (appended to the dsh session title; the S### id and date stay server-derived)')
        }
        // 对齐 osp：desc/issue 二选一（缺省/互斥均在 createSession 内报错）
        const result = createSession({
          root,
          desc: args.desc,
          issue: args.issue,
          id: args.id,
          goal: args.goal,
          dryRun: isDryRun,
        })
        const message = result.message
        if (isDryRun) return message

        // 🆕 2026-10-16（owner 令，S142）：**create 的分支语义由"有无绑定"决定**。
        //
        // 🔴 **为什么必须分开**（这是两条不同的意图，此前被同一个动作混在一起）：
        //   · **无绑定** ⇒ 调用方开着一条尚未归属任何轨迹的会话，`create` 的意图**就是**"从这里开始"。
        //     若仍只建不绑，调用方**必须再敲一次 `use`**，否则新轨迹没有任何载体
        //     ⇒ 后续 `send-now`/唤醒全部报"无绑定会话记录"（本仓已实测过同族形态）。
        //   · **已有绑定** ⇒ 调用方**正在**某条轨迹上工作，`create` 多半是"顺手记一件将来的事"。
        //     此时若夺走绑定，**当前轨迹被静默抛弃**（v1.25.11 旧行为正是如此，故 U6 收回）。
        //
        // ⇒ 判据 = `currentBoundDirName`（**持久化 bound 优先**，无则回落内存 active）。
        const scope = agentScope(exec)
        const priorBound = currentBoundDirName(exec, scope)

        if (priorBound === null) {
          // ── 路径①：无绑定 ⇒ 直接激活（等价于紧接着调了一次 `use`）──
          // 复用 `useSession` 而非自己写绑定：它同时做三件必须一起做的事
          //   （写内存激活态 / 产出 SESSION CONTEXT 文本 / 给出 dirName+mdPath），
          // 自己拼一遍就是**第二份会漂的实现**（单真相源纪律）。
          const active = useSession(root, result.dirName, scope)
          const info = getActiveSessionInfo(scope)
          if (info) renameDshSessionForActive(ctx, exec, info, args.summary)
          const dsh = agentDshSession(exec)
          if (dsh && info) {
            appendBound(dsh, 'activate', {
              dirName: info.dirName,
              mdPath: info.mdPath,
              sessionId: info.sessionId,
              note: 'auto-activated on create (no prior binding)',
            })
          }
          return [
            message,
            `✓ 已自动激活（此前**无绑定**）：${active.dir} —— 后续工作写回该轨迹的 SESSION.md。`,
            `  （判据：create 前无任何绑定 ⇒ 激活；有绑定则只建不夺，见下。）`,
          ].join('\n')
        }

        // ── 路径②：已有绑定 ⇒ 只建不夺 ＋ 显式告知"怎么激活它"──
        return [
          message,
          `⚠ 本轨迹【未】被激活 —— 当前已绑定 ${priorBound}，保绑定优先（不夺走你正在用的轨迹）。`,
          `  要激活它（并在它名下开一条会话）：用 cognitive_trajectory send-now 向 ${result.dirName} 投一条消息 ——`,
          `  目标若没有活跃 dsh 会话，会自动创建一条并把「使用提示词 ＋ 你的消息」一并注入。`,
        ].join('\n')
      }
      case 'use': {
        if (!args.name) throw new Error('use requires name (S### or directory name)')
        // 需求②：use 加 summary 必填（用户拍板"做成必填，但只影响那个概括，编号和日期还是固定的"）
        if (!args.summary || args.summary.trim() === '') {
          throw new Error('use requires --summary <content summary ≤20 chars> (appended to the dsh session title as S###-YYYY-MM-DD-<summary>; id and date stay server-derived)')
        }
        const scope = agentScope(exec)
        // 目标目录名：findSession 定位（精确/编码/模糊——编码无关）
        const targetEntry = findSession(join(root, 'AGENT_SESSIONS'), args.name)
        if (!targetEntry) throw new Error(`Session not found: "${args.name}". Use "list" to see available sessions.`)
        const targetDirName = targetEntry.dirName
        // 🔴 G1 硬守卫（D172，owner 2026-10-20 裁「use 直接报错」）：**不许原地改宗**。
        //
        // 旧实现留了 `--force` 后门，于是"一条会话先后属于两条轨迹"在事实上可能发生。
        // owner 的要求是一条会话**终身**只属于一条轨迹 ⇒ 后门整条退役。
        //
        // ⚠️ `--force` 参数**保留解析**（不报 unknown-arg）：老调用会命中这里并拿到
        // **说明为何退役**的文案 —— 静默忽略比报错更坏（本仓 D131：错误文案不是机制的证据）。
        const currentDir = currentBoundDirName(exec, scope)
        if (currentDir !== null && targetDirName !== currentDir) {
          throw new Error(
            `这个会话已经承载认知轨迹「${currentDir}」，不能改宗到「${targetDirName}」。\n` +
            `一个会话终身只属于一条认知轨迹（2026-10-20 裁决，--force 已退役）。\n` +
            `要继续用「${currentDir}」⇒ 不用任何操作；要给「${targetDirName}」开一个载体 ⇒ 新建一条会话再 use。`,
          )
        }
        const active = useSession(root, args.name, scope)
        // v1.21 F3：激活后重命名 dsh 会话标题（S###-日期-概括）
        const info = getActiveSessionInfo(scope)
        if (info) renameDshSessionForActive(ctx, exec, info, args.summary)
        // 持久化归属（D172）：写**轨迹目录里的自我交代**。
        //
        // 生命周期（`trajectory/bind-file.ts` 头注）：走到这里只有两种迁移 ——
        //  · 该会话此前无归属 ⇒ **acquire**
        //  · 已归属**同一条**轨迹 ⇒ **幂等重入**（不产生第二次写语义）
        // ⛔ `switch` 已由上面的硬守卫挡掉；`takeover` 只属于 rebuild 路径。
        const dsh = agentDshSession(exec)
        // 🔴 **写入结果必须进回执**（2026-10-20，由 S196 的实测逼出）：
        //    `use` 的回执此前只说"已激活"，而绑定写没写成**完全看不出来** ⇒
        //    实测里出现了「回执成功、标题已改、绑定文件逐字节未变」这种组合，
        //    使用者只能靠事后比对 mtime 才发现 ⇒ 那是把"真相源没更新"伪装成成功。
        //    ⚠️ 标题改名走的是另一条通路（它有日志），所以"标题变了"**不能**当绑定成功的证据。
        let bound: BindWriteResult | null = null
        if (dsh && info) {
          // 🔴 **`use` 无条件覆盖绑定**（owner 2026-10-20 裁决，原话：
          //    「use 只要被调用了，可以无条件覆盖绑定到当前会话（这说明当前会话肯定活着啊）」）。
          //
          // 🔴🔴 **2026-10-20 晚些时候的自我更正（由一条 skiff 轨迹的真机实测逼出）**：
          //    上一版**收窄了这条裁决** —— 传 `alive` 探针，让"活的旧载体"仍然拒绝
          //    （当时我写的理由是"那是 IMMUTABLE 2 的真实冲突"）。**那个理由是错的**：
          //    IMMUTABLE 2 要求"一条轨迹至多一个当前载体"，而**单槽位文件**在结构上已经保证
          //    了这一点 —— 覆盖后旧载体只是**不再是载体**，不变量并没有被违反。
          //
          //    收窄的真实代价（现场）：`send-now` 给一条轨迹自动建了载体（它必须写绑定，
          //    否则唤醒路径找不到载体 —— 见 `createAndBindTarget` ③），而**人**那条会话
          //    （微信 route）随后 `use` 时，被这个机器建来的活载体挡住 ⇒ 表现为
          //    「同一条轨迹的绑定反复被顶掉 / use 一直 not-written」，只能干等它退场。
          //    ⇒ 回到裁决原文：`use` 拿来的是**调用者自己的会话**，它此刻活着本身就是证明。
          //
          // ⚠️ **仍然会出声**：被顶掉的载体 id 进回执的 `bindingReplaced`
          //    （D186 同族：可以覆盖，但不许静默覆盖）。
          bound = appendBound(dsh, 'activate', {
            dirName: info.dirName,
            mdPath: info.mdPath,
            sessionId: info.sessionId,
            takeover: true,
          })
        }
        // 内联完整性检查（v1.33）：原 health/qa 因"判据＝旧模板"被淘汰，这里只留不依赖模板的两项
        // —— **提示，不阻断**（用户裁决原话："通过就静默，不通过就提示，注意不是报错"）
        const advisory = advisoryHint(targetEntry.dirName, join(targetEntry.path, 'SESSION.md'))
        const out: Record<string, JsonValue> = { dir: active.dir, mdPath: active.mdPath, context: active.context }
        if (advisory) out.advisory = advisory
        // 🔴 绑定结果**显式**回报（三态，缺一不可）：
        //  · `written`     —— 真相源已改写，`use` 真的落地了（若顶掉了旧载体 ⇒ 带出 `bindingReplaced`）
        //  · `not-written` —— 写没成 ⇒ 契约下**仍是未绑定**（绝不谎报"已激活"就是绑定完成）
        //  · 缺省不出现   —— 只在真的没走到写入分支时才没有这一格
        //
        // 🔴 **`bindingHint` 必须指名是哪一半失败**（2026-10-20；两条失败路径的读数是不同的：
        //    header 取不到 vs 槽位被别人占着。此前一律印 header 文案，把实测者带偏过一轮）。
        if (bound !== null && bound.ok) {
          out.binding = 'written'
          if (bound.replaced !== undefined) {
            out.bindingReplaced = bound.replaced
            out.bindingHint =
              `已顶掉原载体 ${bound.replaced}（owner 裁决：use 无条件覆盖到当前会话）。`
              + `若那条会话还活着，它此刻**不再**承载「${info?.dirName ?? targetEntry.dirName}」——`
              + '这是单槽位的必然结果，不是错误；需要它继续承载就再对它 `use` 一次。'
          }
        } else if (bound !== null) {
          out.binding = 'not-written'
          out.bindingCode = bound.code
          out.bindingHint =
            `绑定未写入（${bound.code}）：${bound.detail}`
            + ` ⇒ 按契约「绑定声明是唯一真相」，「${info?.dirName ?? targetEntry.dirName}」此刻仍是**未绑定**。`
            + ' 会话标题变了**不能**当作绑定成功的证据（改名走的是另一条通路）。'
        }
        // (b)(c) 已退役（D172）：
        //  · "只留一条"不再需要 —— 轨迹的槽位是**一个文件**，写入即覆盖，没有可以退的第二条；
        //  · "悬空清理"不再需要 —— owner：「sessionId 不存在 ⇒ 视同没绑定」，过期文件自动失效。
        return out
      }
      case 'rebuild': {
        // v1.30：rebuild 并入 logbook（原独立 session_rebuild 工具）——超限重建：
        // 复用旧 dsh 会话原地清空重来（Ship of Theseus），turn-stopping 时执行真正 replace
        if (!args.summary || args.summary.trim() === '') {
          throw new Error('rebuild requires --summary <content summary ≤20 chars> (the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild)')
        }
        const dshSessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? ''
        if (!dshSessionId) throw new Error('Unable to determine the current dsh session id')
        const { queueRebuild } = await import('../trajectory/rebuild.js')
        const result = await queueRebuild(ctx, {
          root,
          note: args.note as string | undefined,
          summary: args.summary as string,
          agentCwd: agentCwdFor(exec),
          dshSessionId,
        })
        return {
          ok: true,
          queued: result.queued,
          anchor: result.anchor,
          sessionMdPath: result.sessionMdPath,
          instruction: 'Queued clear-and-rebuild: when this turn ends, the same conversation will be cleared and injected with the "continue the work" anchor (fake-initial-turns protocol body included), then auto-continue — no manual input needed; resume from SESSION.md at that point.',
        }
      }
      case 'archive': {
        // 🔴 2026-10-18（owner 令）：**认知轨迹没有生命周期**，唯一的"变化"就是归档。
        // 单向（owner 裁决 A2）：不设 unarchive；恢复 = 手工 container_fs mv 移回。
        // 判据：不覆盖既有、纯 rename（目录与 SESSION.md 逐字节不动）——见 archiveSession 的注释。
        if (!args.name) throw new Error('archive requires name (S### or directory name)')
        const res = archiveSession(root, args.name, args.dryRun ?? false)
        return {
          ok: true,
          dirName: res.dirName,
          from: res.from,
          to: res.to,
          message: res.message,
          note: res.dryRun
            ? '预览：未落盘。'
            : '已从活跃清单移出（目录与 SESSION.md 逐字节未改）。恢复方式：container_fs mv 移回 AGENT_SESSIONS/。',
        }
      }
      case 'uid': {
        // 🔴 2026-10-19（owner 追加令裁 B 案）：**UID 写入已退役，读取保留**。
        //
        // 为什么退役（R↓）：UID 当初存在的唯一理由是「命名很可能由于变化而变化」——
        // 而现在的**编码本身就稳定且可指定**（`create --id <code>`）⇒ 二元性取消
        // （owner：「取消 `S###` 与 UID 的二元性 —— 编码就是唯一标识，用户可指定」）。
        //
        // 为什么**读取**仍留着：存量文件里已有设定（本仓 = S142 的 `serenity-acc-maintainer`），
        // 删掉读取侧就等于把一个仍在用的指认通道作废（能力倒退，且没有任何收益）。
        // ⇒ 本动作用来**查看**现状并指引新路径；**任何写入尝试都响亮报错**。
        if (!args.name) throw new Error('uid requires name (code / S### / dir name / existing UID)')
        const entry = findSession(join(root, 'AGENT_SESSIONS'), args.name)
        if (!entry) throw new Error(`Trajectory not found: "${args.name}"`)
        const cur = readTrajectoryUid(entry.path)
        if (args.uid !== undefined) {
          throw new Error(
            'Setting a trajectory UID has been retired (2026-10-19). ' +
            'A trajectory\'s code IS its unique identity now, and you can choose it at creation time: ' +
            'cognitive_trajectory create --id <code> --desc <desc> --summary <summary>. ' +
            'Existing TRAJECTORY-UID files are still READ (so old handles keep resolving) — they are just never written.',
          )
        }
        return {
          ok: true,
          dirName: entry.dirName,
          code: parseTrajectoryCode(entry.dirName),
          uid: cur,
          retired: true,
          note: cur === null
            ? `未设定遗留 UID ⇒ 用编码指认（${parseTrajectoryCode(entry.dirName) ?? '无编码'}）。` +
              `UID 写入已退役；要一条可指定的标识，请用 create --id 起新轨迹。`
            : `遗留 UID = ${cur}（文件 ${UID_FILENAME}，只读兼容）——仍可用它指认本条轨迹。` +
              `⚠️ 写入已退役：新轨迹用 create --id 指定编码。`,
        }
      }
      case 'send-later': {
        // v1.33：原 `wake-add` 并入本工具；**2026-09-17 由 `wake-later` 更名 `send-later`**（命名 A 案）。
        // 语义 = 一条「未来时刻 + 一条 message」；fire-and-forget：**无回执、不可回收、无面板**（用户明示接受）。
        if (!args.target || !args.at || !args.message) {
          throw new Error('send-later requires target (S### or dir name) + at (RFC3339 or +30m/+2h) + message')
        }
        const wakeScope = agentScope(exec)
        const res = addWake(root, {
          target: args.target,
          at: args.at,
          message: args.message,
          // 发起者 = **调用方自身**所属 cognitive trajectory（`resolveSessionCognitiveTrajectoryLabel` 的三级归属）
          createdBy: resolveSessionCognitiveTrajectoryLabel(exec.agent?.session, wakeScope === DEFAULT_SESSION_SCOPE ? '' : wakeScope),
          nowMs: Date.now(),
        })
        if (!res.ok) return { ok: false, error: res.error }
        return { ok: true, output: `✓ 已登记唤醒\n${renderWakeEntry(res.entry)}` }
      }
      case 'send-now': {
        // 即时投递（2026-09-16 所有者裁决；**2026-09-17 由 `send-message` 更名 `send-now`**，命名 A 案）。
        // 与 send-later **共用取用通路**（live 优先 → 冷载入），区别只在：
        //   · 时刻：**现在**（不是未来；`addWake` 硬拒 at ≤ now ⇒ 本动作**不落注册表**）
        //   · 回执：**有**（同步返回；send-later 是 fire-and-forget）
        if (!args.target || !args.message) {
          throw new Error('send-now requires target (S### or dir name) + message')
        }
        const sendScope = agentScope(exec)
        const res = await sendToCognitiveTrajectory(
          ctx,
          root,
          args.target,
          args.message,
          resolveSessionCognitiveTrajectoryLabel(exec.agent?.session, sendScope === DEFAULT_SESSION_SCOPE ? '' : sendScope),
        )
        if (!res.ok) return { ok: false, error: res.detail }
        return {
          ok: true,
          output: [
            '✓ 已即时投递',
            `  · ${res.detail}`,
            '  · 语义：**不排队** —— 目标正在跑轮次则**当场注入当前轮**（steer），空闲则立即起一轮（followup）。',
            '  · ⚠️ 回执只到「已注入 / 已起轮」——**不表示**目标已执行或已答复。判"目标真的动了"须看它自己的 SESSION.md（文件级判据）。',
          ].join('\n'),
        }
      }
      case 'cro-guide': {
        // CRO 编写指南（2026-09-20；owner 令「机制属 ACC / 程序属 CCC」+「指南 ACC 内置，guide 老套路」）。
        // 纯读：只是把 `cro/guide.ts` 的正文吐出来（正文含**由装配器实时生成**的样例快照，
        // 故**永不与 schema 漂移** —— 见该文件头的单真相源纪律）。
        // 为什么挂在本工具：CRO 程序放在**轨迹自己的目录**里 ⇒ 这是"逐轨迹"的知识，
        // 而管轨迹的人正是用本工具的人（设计 §9-5：既有 guide 位置，不新增域）。
        return CRO_GUIDE
      }
      case 'resident': {
        /**
         * 常驻名单（D173 兑现，owner 2026-10-20）。
         *
         * 🔴 **这个动作的存在本身就是一条判据**：v1.77.1 的手册曾承诺"通过本工具的
         * 常驻名单动作按需查询"，而**那个动作当时并不存在**（D179(a)，S196 踩到）。
         * ⇒ 现在它真的存在了。
         *
         * 🔴 **纯读**（不碰 fs 写、不碰注册表、不碰调度器）：D173 的判据是
         * 「常驻」管的是**被找到**，不是**不被销毁** —— 两件事混为一谈就会去动
         * `wake/scheduler.ts` 的载体生命周期，那正是本轨反复踩的"名字撒谎"。
         *
         * 🔴 **不进系统提示词**（owner 裁决 Q2：说明类信息按需取，不占每轮 token）。
         */
        return listResident(root)
      }
      case 'interrupted': {
        /**
         * 以未完成轮次结尾的 dsh 会话（owner 2026-10-22 令：**只出入口**）。
         *
         * 🔴 **边界（owner 原话：「我们 ACC 不关心周期」）**：本动作**只回答**"此刻哪些会话
         * 的最后一轮没跑完"，**不判周期、不自动续跑、不改日志**。
         * 何时扫、续谁、怎么续 = 调用方（CCC 的认知轨迹）的事。
         *
         * 🔴 **为什么不是"曾经中断过"**：长会话历史上可中断几十次（实测单会话 33 次）；
         * 按"曾经"判会把早已恢复的会话全部当成待续 ⇒ 灾难。
         * 🔴 **判据只在一处**：`trajectory/interrupted.ts` 的 `detectInterruptedEnd`
         * （⛔ 别在此处复述取值域 —— 2026-10-24 就是这份复述漏掉了 `aborted`）。
         *
         * 🔴 **正在跑的会话要排除**：live 会话不该被判成"待续"（它正在跑，不是中断）。
         */
        const lookbackHours = typeof args.lookbackHours === 'number' && args.lookbackHours > 0
          ? args.lookbackHours
          : DEFAULT_LOOKBACK_MS / 3_600_000

        const sessionsRootPath = sessionsRootDir()
        // 当前 dsh 会话的 cwd 决定项目目录名（宿主 `--<path-with-dashes>--` 规则）
        const cwd = exec.agent?.session?.header?.cwd ?? root
        const projectDir = join(sessionsRootPath, projectDirNameForCwd(cwd))

        const scan = scanInterruptedSessions(projectDir, {
          lookbackMs: lookbackHours * 3_600_000,
          // 🔴 A105：排除「此刻在跑轮次」的会话（不是「宿主认识的」）。见 `collectRunningSessionIds` 的注释。
          liveIds: collectRunningSessionIds(Date.now()),
        })

        return renderInterruptedScan({ projectDir, lookbackHours, scan })
      }
      case 'continue-all-interrupted': {
        /**
         * 扫 + 逐条注入续跑消息（owner 2026-10-22 追加令：
         * 「我希望实现的是 continue-all-interrupted 方法，调用后自动找到 8h 内所有 dsh 会话
         *   注入简单的 continue 进行唤醒，这样 CCC 就不用动脑子了」）。
         *
         * 🔴 **与 `interrupted` 分立而不合并**：前者是**观察**（只读、零副作用），
         * 后者是**动作**（会真起 agent、真烧算力）。想看一眼清单却误触发全量续跑
         * 是不可接受的 ⇒ 两个动作各自可调用。
         *
         * 🔴 **边界仍是"不判周期"**：何时调用归调用方（CCC 的定时轨迹）。
         * 本动作只保证"**调用一次就把该做的做完**"。
         */
        const lookbackHours = typeof args.lookbackHours === 'number' && args.lookbackHours > 0
          ? args.lookbackHours
          : DEFAULT_LOOKBACK_MS / 3_600_000

        // dryRun：只报"会续哪些"，一条都不注入（给调用方一次确认机会）
        const dryRun = args.dryRun === true

        const sessionsRootPath = sessionsRootDir()
        const cwdRead = exec.agent?.session?.header?.cwd ?? root
        const projectDir = join(sessionsRootPath, projectDirNameForCwd(cwdRead))

        const scan = scanInterruptedSessions(projectDir, {
          lookbackMs: lookbackHours * 3_600_000,
          // 🔴 A105：同 `interrupted`，排除「此刻在跑轮次」的会话。
          liveIds: collectRunningSessionIds(Date.now()),
        })

        if (dryRun) {
          return renderContinueResult({ projectDir, lookbackHours, scan, outcomes: null, dryRun: true })
        }

        // 逐条注入（**串行**：冷载入开销大，并发起多个 agent 会互相抢算力）
        //
        // 🔴 **必须用工厂参数 `ctx`，不能用 `exec`**（2026-10-22 真机实测踩到）：
        //    `execute(args, exec)` 的第二参是宿主 `ToolRunContext`（= ToolExecution + deferContext…），
        //    **不含 cordis 服务**。拿它去 `hostAgents()` / `hostService()` 一律 undefined
        //    ⇒ 症状是「sessionController 不可用」—— 而那个会话其实**就在 live 列表里**。
        //    ⇒ 这与 F3「包装对象没有 header」是同一族错误：**服务要从真 ctx 取，不能从别的东西冒充。**
        const agents = hostAgents(ctx) as { get?: (id: string) => unknown } | undefined
        const sc = hostService<{
          resolveAgent?: (id: string) => Promise<{ agent?: unknown; error?: string }>
        }>(ctx, 'sessionController')
        const resumeOne = createResumeOne({
          agents,
          sessionController: sc,
          // 🔴 **DII M2 · 注入点 #15**（2026-11-04）：工厂里改走声明层。
          //    ⚠️ **通道不在这里选** —— 选 steer/followup 的是 `createResumeOne`（含退回逻辑）。
          //    本工厂只负责"造消息"，这正是 I3：意图定死、通道由上下文落。
          makeMessage: (text) =>
            toMessage(
              makeInjection({
                origin: 'acc',
                form: 'notice',
                summary: '中断兜底继续（工具面）',
                text,
                delivery: 'wake-now',
              }),
            ),
        })

        const outcomes: ResumeOutcome[] = []
        for (const hit of scan.sessions) {
          try {
            outcomes.push(await resumeOne(hit))
          } catch (err) {
            outcomes.push({
              sessionId: hit.sessionId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        return renderContinueResult({ projectDir, lookbackHours, scan, outcomes, dryRun: false })
      }
      default:
        throw new Error(`Unknown action: ${args.action as string}`)
    }
  },
  })
}

/**
 * 渲染一条唤醒条目（人读；`send-later` 的登记回执）。
 * 显式写明"不可回收"，因为这是用户明示接受的语义（D60 调整后：无 list/rm、无面板）。
 * @param e 刚登记的条目
 */
function renderWakeEntry(e: WakeEntry): string {
  return [
    '═══ cognitive trajectory 唤醒（1 条）═══',
    `  · ${e.id}  [${e.state}]  at=${e.at}  target=${e.target}  by=${e.createdBy || '?'}`,
    `      message: ${e.message.length > 120 ? `${e.message.slice(0, 120)}…` : e.message}`,
    '',
    `补跑窗口 ${WAKE_CATCH_UP_MS / 3_600_000}h：停机期间到期且迟到未超窗 → 补投；超窗 → missed 留痕。`,
    '⚠ fire-and-forget：无回执、不可回收、无面板。',
  ].join('\n')
}

/**
 * `use` 的内联检查（v1.33；🔴 **2026-10-18 起只剩一条**）。
 *
 * 为什么只剩"空壳"这一条（R↓）：另一条是「SESSION.md 已 N 天未更新」的老化告警，
 * 而 **owner 2026-10-18 裁决「认知轨迹没有生命周期」** ⇒ "旧轨迹该退休了"这个前提消失：
 * **旧不是问题**，激活一条 300 天前的轨迹与激活昨天的是同一件事。
 * ⇒ 老化告警不是在提示风险，它是在**暗示一个已不存在的规矩**，故删除。
 *
 * 剩下的这条**与模板、与年龄都无关**，它是纯粹的**事实缺失**：
 * 目录在但没有 SESSION.md ⇒ 激活必然失败（`useSession` 会阻断），提前说清比让人撞墙好。
 *
 * @param dirName 目标轨迹目录名
 * @param mdPath 目标 SESSION.md 绝对路径
 * @returns 提示文本；无异常 → null（**通过就静默**）
 */
function advisoryHint(dirName: string, mdPath: string): string | null {
  if (!existsSync(mdPath)) return `⚠ ${dirName}: 目录存在但没有 SESSION.md（空壳）——本次激活会失败，先补正文或改用 create`
  return null
}
