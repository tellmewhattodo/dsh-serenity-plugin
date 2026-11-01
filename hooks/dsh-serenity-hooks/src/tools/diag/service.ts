/**
 * tools/diag/service.ts — 运行态诊断报告装配（原 `acc-diag` 工具；v1.106.0 并入 `dashboard diag`）
 *
 * ## 为什么并进 dashboard（owner 2026-11-01 裁「方案 C」）
 *
 * 原 `acc-diag` 是**专属工具**（要 CCC 在 `exclusiveTools` 里逐字点名才可见）。
 * owner 要的是「诊断入口随时可用」，而专属机制让入口本身成了特权的副产品：
 * 换个 CCC 就看不见，且"看不见"与"坏了"在现象上同形。⇒ 并入常驻的 `dashboard`，
 * 并**整体删除 `exclusiveTools` 机制**（那一版永远只有一个成员，机制成本高于收益）。
 *
 * ⚠️ **代价（owner 已知并确认）**：`dashboard` 常驻 ⇒ 本节对**所有轨迹**可见，
 * 而 ① 段的 live 会话清单是**全部 CCC** 的（跨容器）。这是方案 C 的既定后果，不是缺陷。
 *
 * 为什么单独成模块（R↓）：工具面（`tools/kit/index.ts`）只做"取 CCC 根 + 渲染"，
 * 装配逻辑放这里 ⇒ 纯函数可单测、不依赖 DSH 工具注册。
 *
 * 四段内容（数据来源各自单一真相源，本模块只聚合不复制语义）：
 *   ①  live 运行态 —— 插件进程内 `diagLive(ctx)`（进程 cwd/CCC + live 会话清单）
 *       ——**独立进程看不到运行时**，这正是本段存在的理由
 *   ①b 唤醒时钟 —— `containerClocks().wake`（唤醒调度器进程内快照：武装态/计数/上次跳过原因）
 *   ②  CRO 已注册清单 —— `listCroCognitiveTrajectories(root)`（v1.106.0 新增，owner 要求）
 *       **CRO 没有注册表**（见 `cro/core.ts` 文件头）：`continuous-re-occurrence.ts` 文件存在即启用
 *       ⇒ 本段是那个"隐式事实"的**唯一可见出口**。运维看不到它，就只能靠翻目录猜。
 *   ③  唤醒注册表 —— `wake-registry.json` 的**在办条目** ＋ **未来与已过期分开列**（v1.106.0）
 *       🔴 2026-09-19 §0Q 甲案：终态条目**结案即清除** ⇒ 本段只列在办项，不再是"历史全量"。
 *       🔴 v1.106.0 补一条判据（owner 2026-11-01 要"看未来会被唤起的"）：
 *          **过去的不看** ⇒ `at > now` 单独成组；**已过期但仍在办**的另列一组。
 *          两者必须分开，因为它们的**病情不同**：未来项 = 正常排队；过期项 = 补跑窗口里卡着
 *          （调度器没跑 / 目标不可解析），混在一起读会以为"排了好多活儿"。
 *
 * ── 2026-09-15：段数由四降为三（S142「ACC 侧 autopilot 退场」§1 二阶裁定）─────────────
 * ACC 侧 autopilot 整段退场后，报告里两段的**主语消失**，故删除（不是"暂时关掉"）：
 *   · 原 ② 面板解析 —— `diagLive.panelResolved` 的来源是"哪个 CCC 配了 autopilot"，
 *     面板区块同批删除 ⇒ 主语不存在。
 *   · 原 ④ 唤起条件链 —— 整段都是 ACC autopilot 的唤起条件（`buildWakeChain` +
 *     `autopilotRuntimeFacts`），实现模块已删 ⇒ 不留第二份条件链、也不留半死的手写版。
 *   · 原 ① 段的 autopilot CCC 渲染（逐 CCC 目标命中 / agent 定位）同批删除。
 *
 * 🔴 **已知缺口（登记，不静默丢弃）**：④「为什么这轮没唤起」的诊断在 **CCC 自管理链**上归零。
 * 新链的失败形态是"S151 漏了自排下一轮"或"调度器闸关/未 tick"，而删掉 ④ 后这两种病因都不可见。
 * 按所有者裁决本次**不补**（一句话可补，代价 = 一条新条件链：调度器 armed / 闸 / tick 在跑 /
 * 条目到期 / 补跑窗口 / 目标可解析 / CCC 闸）。**不得**以"顺手保留 ④"的方式把它偷偷带回。
 * ⚠️ v1.106.0 的 ③ 两分组**不是**这条缺口的补丁：分组只把"已过期在办"显形，
 * 没有回答"为什么没 tick"——那是 ①b 的 lastSkipReason 与 tick 次数的事，别混为一谈。
 *
 * C5「观察面归一」（2026-09-15）：① 走 `diagLive`（那是**live 运行态**的独有取数，没有第二个
 * 来源）；①b 时钟与 ③ 注册表经 `surface/observation.ts` 取（唯一取数出口）——**投影仍在本文件**
 * （诊断段不含 `message`，面板含；这是渲染差异，不是取数差异）。
 */

import { WAKE_CATCH_UP_MS } from '../../wake/registry.js'
import { diagLive, type DiagLiveReport } from '../../trajectory/live.js'
import { containerClocks, containerWakes, type ClockSnapshot } from '../../surface/observation.js'
import { listCroCognitiveTrajectories } from '../../cro/core.js'
import { subscriptionStats, subscriptionEval } from '../../trajectory/subscriptions.js'
import { readTrajectorySubscriptions } from '../../kernel/ccc.js'
import type { Context } from 'cordis'
import { isoLocal } from '../../kernel/time.js'
import { readSimpleSettings } from '../../surface/settings.js'

/** 进程内时钟状态（唤醒调度器；判据单一真相源 = `wake/scheduler.ts`） */
type ClockState = ClockSnapshot

/** 人读渲染一行时钟状态（"为何没有 tick" 的第一手判据） */
function renderClock(label: string, s: ClockState): string {
  const ts = (ms: number | null): string => (ms === null ? '（从未）' : isoLocal(ms))
  const parts = [
    `armed=${s.armed}`,
    // 🔴 2026-09-21 替换：原 `全局闸=${s.enabled}` —— 调度器的闸已砍掉（恒开，该字段失去信息量），
    //    改报**CRO 闸**（本容器唯一还存在的"会拦住某阶段"的开关）。它回答的是
    //    "这轮为什么没有自编程唤起"——与 armed / lastSkipReason 同属"为何没动"的第一手判据。
    `CRO 闸=${readSimpleSettings().croEnabled !== false}`,
    // 🔴 v1.63.3：原「无人值守闸=」一行已随该功能整条退役删除（owner 2026-10-18 裁「已经证实没意义」）。
    //    它当时的用途 = 回答"为什么会话停下后没人接着推"；该机制不存在了，这个判据也就不再有信息量。
    `tick 次数=${s.ticks}`,
    `上次 tick=${ts(s.lastTickAt)}`,
  ]
  if (s.armedAt !== null) parts.push(`武装于=${ts(s.armedAt)}`)
  if (s.lastSkipReason) parts.push(`上次跳过: ${s.lastSkipReason}`)
  return `${label}: ${parts.join(' ｜ ')}`
}

/** 唤醒注册表条目（诊断投影：**不含 `message`**，与面板的投影不同） */
interface DiagWakeEntry {
  id: string
  target: string
  at: string
  state: string
  createdBy: string
  attempts: number
  lastResult: string | null
}

export interface DiagReport {
  /** 调用方会话所属 CCC 根（过程内诊断的目标） */
  ccc: string
  live: DiagLiveReport
  /**
   * 唤醒调度器的进程内武装状态（2026-09-14 F 段缺陷**新暴露面**）。
   * 为什么必须有（R↓）：此前"条目为何滞留在 pending"无法从报告回答。有了它，
   * "时钟根本没在跑"这一类故障一眼可判——这是 ACC 现存的**唯一**轨迹调度时钟。
   */
  clocks: {
    wake: ClockState
  }
  /** 启用了 CRO 的轨迹目录名（`continuous-re-occurrence.ts` 存在即启用；CRO 无注册表） */
  cro: string[]
  wakes: {
    /** 注册表文件路径问题（读不到时非空——不得静默） */
    error: string | null
    /**
     * 未来条目（`at > now`）—— owner 要看的"接下来会被唤起的"。
     * 按 `at` 升序（`listWakes` 已排序）。
     */
    future: DiagWakeEntry[]
    /**
     * 已过期但仍在办（`at <= now`）——**另有病情的**那批：在补跑窗口里卡着。
     * 与 `future` 分开是刻意的：混在一起会被读成"排了很多活儿"。
     */
    overdue: DiagWakeEntry[]
    /** 在办（`state === 'pending'`）条目数，两组合计 */
    pending: number
  }
  /** 报告生成时刻（epoch ms）—— 分组的判据基准，必须与读数一致才可复算 */
  nowMs: number
  /**
   * 轨迹消息订阅的**投递读数**（v1.107.0）：谁在盯谁、成功/失败各几次。
   *
   * 🔴 **只列"发生过投递尝试"的键**（`watcher←member`），不是配置全表 ——
   * 配置全表看 `.opencode/serenity.json` 即可；这里回答的是另一个问题：
   * **「配了的那些订阅，实际上有没有在投？」**
   * 一个**不出现**的键 = 还没触发过；出现且 `failed>0` 的键 = 触发了但送不到（那是要修的）。
   * 两者形态不同，混成一句话就分不出来了。
   */
  subscriptions: Array<{ key: string; ok: number; failed: number; lastError: string | null; lastAt: number | null }>
  /** 订阅配置本身的**坏项**（配了但不生效的条目 —— 必须显形，否则用户以为它在工作） */
  subscriptionProblems: string[]
  /**
   * 订阅机制的**评估计数**（v1.108.0）：收到多少 `agent/status`、认出多少次一轮结束、各因何跳过。
   * 🔴 它回答的是「**机制在跑吗**」—— 与「送出过东西吗」是两个问题；缺了它两者同形（都是空）。
   */
  subscriptionEval: {
    statusEvents: number
    runningSeen: number
    idleSeen: number
    turnFinished: number
    skips: Record<string, number>
  }
}

/**
 * 装配报告（一次调用即全报告）。
 * @param ctx 插件上下文（进程内读 sessions/agents）
 * @param root 调用方 CCC 根（唤醒注册表取数目标）
 * @param nowMs 判"未来 / 已过期"的基准时刻（可注入 ⇒ 可单测，不依赖挂钟）
 * @returns 结构化报告（渲染由 {@link renderDiag} 负责）
 */
export async function runDiag(ctx: Context, root: string, nowMs: number = Date.now()): Promise<DiagReport> {
  const live = diagLive(ctx)
  // C5：时钟与唤醒注册表经 container-status 取数（与本文件其余段落同一取数出口）
  const clocks = containerClocks()
  const wakes = containerWakes(root)
  const project = (e: (typeof wakes.entries)[number]): DiagWakeEntry => ({
    id: e.id,
    target: e.target,
    at: e.at,
    state: e.state,
    createdBy: e.createdBy,
    attempts: e.attempts ?? 0,
    lastResult: e.lastResult ?? null,
  })
  // 🔴 分组判据：`at` 与 `nowMs` 的可比性由 `Date.parse` 保证（`isoLocal` 带时区偏移）。
  //    `at` 解析不出来（坏数据）⇒ 归入 overdue（它在等，但我们不知道等到什么时候，
  //    归入"该看的那组"比归入"未来"更安全 —— 后者会让人以为一切按计划）。
  const future: DiagWakeEntry[] = []
  const overdue: DiagWakeEntry[] = []
  for (const e of wakes.entries) {
    const at = Date.parse(e.at)
    if (Number.isFinite(at) && at > nowMs) future.push(project(e))
    else overdue.push(project(e))
  }
  return {
    ccc: root,
    live,
    clocks: {
      wake: clocks.wake,
    },
    cro: listCroCognitiveTrajectories(root),
    wakes: {
      error: wakes.error,
      future,
      overdue,
      pending: wakes.pending,
    },
    nowMs,
    // 订阅读数：投递计数（进程内，重启清零）＋ 配置坏项（现读配置，热改即时反映）
    subscriptions: subscriptionStats(),
    subscriptionProblems: readTrajectorySubscriptions(root).problems,
    subscriptionEval: subscriptionEval(),
  }
}

/** 人读渲染一行唤醒条目 */
function renderWake(w: DiagWakeEntry): string {
  return `  · ${w.id} [${w.state}] at=${w.at} → ${w.target} by=${w.createdBy} attempts=${w.attempts}`
}

/** 人读渲染（四段；空段也要显式说明"无"，避免"沉默 = 一切正常"的误读） */
export function renderDiag(r: DiagReport): string {
  const lines: string[] = []
  lines.push(`═══ ACC 运行态诊断（dashboard diag）═══`)
  lines.push(`调用方 CCC: ${r.ccc}`)
  lines.push(`报告时刻: ${isoLocal(r.nowMs)}`)
  lines.push('')

  // ① live 运行态
  lines.push(`── ① live 运行态（插件进程内）──`)
  lines.push(`进程 cwd: ${r.live.processCwd}`)
  lines.push(`进程 CCC: ${r.live.processCcc ?? '（无——进程 cwd 不在任何 CCC 内）'}`)
  lines.push(`live 会话: ${r.live.liveSessions.length} 个`)
  for (const s of r.live.liveSessions) {
    lines.push(`  · ${s.id}${s.title ? `「${s.title}」` : ''} — ccc=${s.cccRoot ?? '(非 CCC)'} cwd=${s.cwd ?? '(无)'}`)
  }
  lines.push('')

  // ①b 进程内时钟（**先看这一行**：时钟没武装时，注册表条目再就绪也不会被投递）
  lines.push(renderClock('唤醒调度器（wake-registry tick）', r.clocks.wake))
  lines.push('')

  // ② CRO 已注册（owner 2026-11-01：要看见哪些轨迹挂了 CRO）
  //    🔴 措辞用"已启用"而非"已注册"——CRO **没有注册表**，启用判据 = 目录下有那个文件。
  //       写成"注册"会让下一个人去搜索一个不存在的注册表。
  lines.push(`── ② CRO 已启用轨迹（判据：目录下有 continuous-re-occurrence.ts；无注册表）──`)
  if (r.cro.length === 0) lines.push('（无——本 CCC 没有轨迹启用 CRO）')
  else {
    lines.push(`共 ${r.cro.length} 条:`)
    for (const d of r.cro) lines.push(`  · ${d}`)
  }
  lines.push('')

  // ③ 唤醒注册表：未来 / 已过期 两分组（owner 2026-11-01「过去的不看」）
  lines.push(`── ③ 唤醒注册表（在办项；已结案条目即时清除，历史见 SESSION.md）──`)
  lines.push(`  （${r.ccc}/AGENT_SESSIONS/wake-registry.json）`)
  if (r.wakes.error) lines.push(`⚠ 注册表读取问题: ${r.wakes.error}`)
  lines.push(
    `在办 ${r.wakes.pending} 条 = 未来 ${r.wakes.future.length} + 已过期 ${r.wakes.overdue.length}｜补跑窗口 ${WAKE_CATCH_UP_MS / 3600_000}h`,
  )

  lines.push(`· 未来（at > 报告时刻；正常排队）: ${r.wakes.future.length} 条`)
  if (r.wakes.future.length === 0) lines.push('  （无）')
  for (const w of r.wakes.future) {
    lines.push(renderWake(w))
    if (w.lastResult) lines.push(`      lastResult: ${w.lastResult}`)
  }

  // 🔴 已过期在办 ≠ 未来的活儿：它们在补跑窗口里，通常意味着调度器没 tick 或目标不可解析。
  //    这一组**必须**另列并写明含义，否则会被读成"排了很多活儿"。
  lines.push(`· 已过期但仍在办（at ≤ 报告时刻；卡在补跑窗口，多半是调度器没 tick 或目标不可解析）: ${r.wakes.overdue.length} 条`)
  if (r.wakes.overdue.length === 0) lines.push('  （无）')
  for (const w of r.wakes.overdue) {
    lines.push(renderWake(w))
    if (w.lastResult) lines.push(`      lastResult: ${w.lastResult}`)
  }

  // ⑤ 轨迹消息订阅（v1.107.0）
  // 🔴 措辞要能分清两种形态：**没出现过**=还没触发过；**出现且失败**=触发了但送不到。
  lines.push('')
  lines.push(`── ⑤ 轨迹消息订阅（投递读数；只列发生过的投递，配置全表见 serenity.json）──`)
  // 🔴 评估计数**先于**投递读数：它回答"机制在跑吗"，而投递读数只回答"送出过吗"。
  //    没有它，"没装配"与"装配了但从未命中"同形（都是空）——那正是本段要防的误读。
  {
    const e = r.subscriptionEval
    const skipText =
      Object.keys(e.skips).length === 0
        ? '无'
        : Object.entries(e.skips)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ／ ')
    lines.push(
      `机制计数: 收到 agent/status ${e.statusEvents} 次｜running ${e.runningSeen}｜idle ${e.idleSeen}` +
        `｜判成一轮结束 ${e.turnFinished}｜跳过: ${skipText}`,
    )
    if (e.statusEvents === 0) {
      lines.push('  ⚠ 一次 agent/status 都没收到 ⇒ 要么此刻真的没人在跑轮次，要么订阅未装配。')
      lines.push('    两者在读数上同形 —— 判"未装配"要看宿主日志里有没有「轨迹消息订阅未装配」。')
    }
  }
  if (r.subscriptionProblems.length > 0) {
    lines.push(`⚠ 配置坏项 ${r.subscriptionProblems.length} 条（**配了但不生效**）：`)
    for (const p of r.subscriptionProblems) lines.push(`  · ${p}`)
  }
  if (r.subscriptions.length === 0) {
    lines.push('（本进程内还没有任何订阅投递发生）')
  } else {
    for (const s of r.subscriptions) {
      const tail =
        s.failed > 0
          ? `  ⚠ 最近失败：${s.lastError ?? '（无说明）'}`
          : ''
      lines.push(`  · ${s.key} 成功 ${s.ok} ／ 失败 ${s.failed}${s.lastAt ? ` ｜ 最后 ${isoLocal(s.lastAt)}` : ''}${tail}`)
    }
  }
  return lines.join('\n')
}
