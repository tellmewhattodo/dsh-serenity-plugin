/**
 * trajectory/subscriptions.ts — 轨迹消息订阅（v1.107.0，owner 2026-11-01 令）
 *
 * ## 这是什么（一句话）
 *
 * **观察者盯一组成员；任一成员「一轮结束」，观察者被唤醒并收到一条通知。**
 *
 * 🔴 **它是通知，不是控制**（owner 原话「loose notification, not control」）：
 * 观察者收到的是「某人刚干完一轮活儿」，**不带他干了什么**（owner：「不需要带它做了什么」），
 * 也不赋予它任何指挥权。要不要看、看了做什么，全由观察者自己决定。
 *
 * ## 与既有机制的关系（⛔ 别混）
 *
 * | 机制 | 主语 | 判据 |
 * |---|---|---|
 * | **CRO** | **自己**决定把自己叫起来（自编程） | `continuous-re-occurrence.ts` 文件存在 |
 * | **本模块** | **别人**干完活了，通知我（互观察） | CCC 配置 `trajectorySubscriptions` |
 * | `send-later` | 我预约未来的某一刻 | `wake-registry.json` 的 `at` |
 *
 * 三者都走唤醒链路，但**主语与判据都不同**。⛔ 本模块**不写 `wake-registry.json`** ——
 * 那会制造第二真相源：订阅是"事件驱动的即时通知"，注册表是"时刻驱动的预约"，
 * 混在一张表里，"这条条目为什么在等"就再也分不出来了。
 *
 * ## 🔴 「一轮结束」的判据——复用，不新造
 *
 * **`agent.status` 由 running → idle**，且这是**唯一权威**。判据已在 `cro/turns.ts` 的
 * D243/D244 两段付过代价定死：
 * · `agent/created` 证明「载体被发布」，不是「有轮次在跑」（重启会把它打成假在跑）；
 * · `agent/turn-stopping` 是「轮末**暂停点**」不是「轮结束」——监听者在里面 `steer` 会让同轮继续跑，
 *   实测导致一条轮连跑 9 分钟而这期间表是空的。
 * ⇒ **本模块直接订阅 `agent/status`**，⛔ 不另立判据（两个判据并存会立刻分叉）。
 *
 * 频率**不设上限**（owner：「不设定上限，结束了就通知」）。之所以不需要额外防抖：
 * `agent/status` **只在真实状态跃迁时发**（宿主 `AgentLoop.setPhase`）。
 *
 * ## 三个失败面（**一个都不许静默**）
 *
 * | # | 失败面 | 形态 | 处置 |
 * |---|---|---|---|
 * | ① | 成员解析不出轨迹 | 会话没绑任何轨迹 / 轨迹编解码不出 | 跳过（**这不是错误**：没绑定的会话不归任何轨迹，它"一轮结束"与订阅无关） |
 * | ② | 观察者唤不醒 | 无载体 / 载体起不来 | **响亮日志**（`console.warn`）——否则"订阅配了但从不生效"与"没人干活"同形 |
 * | ③ | 投递失败 | `sendToCognitiveTrajectory` 返回 `ok:false` | **响亮日志** ＋ 计数（供 `dashboard diag` 后续读） |
 *
 * 🔴 **为什么 ① 不算失败**：一条 CCC 里绝大多数会话**没有**绑轨迹（临时会话、别的 agent 的会话）。
 * 把它们当失败会每天刷出上百条噪声，反而**淹没**②③那种真失败（穷举噪声 = 另一种静默）。
 * ⇒ 判据：**"解析不出"不是错误，"解析出了但送不到"才是**。
 *
 * ## 清理（本容器栽过 5 次"只增不清"）
 *
 * 本模块**不持有跨事件的状态表** —— 每次事件现读配置、现解析、现投递，投递完即忘。
 * ⇒ 结构上不可能"只增不清"。⚠️ 唯一的进程态是**投递计数**（诊断用，固定几条键），
 * 它有上界（键 = 订阅数），且随插件卸载清空（{@link registerTrajectorySubscriptions} 的拆卸）。
 */

import { readTrajectorySubscriptions, type TrajectorySubscription } from '../kernel/ccc.js'
import { findTrajectoryHolding } from './bind-file.js'
import { registerDisposer } from '../host/effect.js'
import { localHuman } from '../kernel/time.js'
import { cccRootForCwd } from '../kernel/ccc-roots.js'

/** 投递计数（诊断用；键 = `watcher←member`，上界 = 订阅数 × 成员数） */
interface DeliveryStat {
  /** 成功投递次数 */
  ok: number
  /** 失败次数（② 唤不醒 / ③ 投递返回 false 都记这里） */
  failed: number
  /** 最后一次失败的说明（成功时不清空 —— 保留最近一次失败证据） */
  lastError: string | null
  /** 最后一次投递尝试的时刻 */
  lastAt: number | null
}

const stats = new Map<string, DeliveryStat>()

/**
 * 评估计数（**"这个机制到底有没有在跑"的唯一读数**，v1.108.0）。
 *
 * 🔴 **为什么必须有它**（我自己在第一版里漏掉了）：只有 `stats`（投递计数）时，
 * **「机制没装配」与「装配了但从未命中」在面板上完全同形** —— 两者都是空表。
 * 而那正是本文件头批评过的失败形态（"配了但不生效"与"没人干活"分不开）。
 * ⇒ 本计数把**事件流**也记下来：收到多少 `agent/status`、认出多少次 running→idle、
 * 每次因何跳过。有它才能回答「它在跑吗」，而不只是「它送出过东西吗」。
 *
 * ⚠️ 上界：固定字段（不是无界 Map）⇒ 结构上不可能"只增不清"。
 */
export interface EvalStats {
  /** 收到的 `agent/status` 事件数（含非 running/idle 的） */
  statusEvents: number
  /** 其中被认成 running 的 */
  runningSeen: number
  /** 其中被认成 idle 的 */
  idleSeen: number
  /** 真被判成「一轮结束」（= 有前置 running 的 idle）的次数 */
  turnFinished: number
  /** 跳过原因计数（键 = `no-ccc` / `no-subscriptions` / `unbound-member`） */
  skips: Record<string, number>
}

const evalStats: EvalStats = { statusEvents: 0, runningSeen: 0, idleSeen: 0, turnFinished: 0, skips: {} }

/** 评估计数快照（诊断/面板读） */
export function subscriptionEval(): EvalStats {
  return { ...evalStats, skips: { ...evalStats.skips } }
}

function bump(key: 'statusEvents' | 'runningSeen' | 'idleSeen' | 'turnFinished'): void {
  evalStats[key] += 1
}

function bumpSkip(reason: string): void {
  evalStats.skips[reason] = (evalStats.skips[reason] ?? 0) + 1
}

/** 测试用：评估计数复位 */
export function __resetSubscriptionEvalForTest(): void {
  evalStats.statusEvents = 0
  evalStats.runningSeen = 0
  evalStats.idleSeen = 0
  evalStats.turnFinished = 0
  evalStats.skips = {}
}

function statOf(key: string): DeliveryStat {
  const cur = stats.get(key)
  if (cur) return cur
  const fresh: DeliveryStat = { ok: 0, failed: 0, lastError: null, lastAt: null }
  stats.set(key, fresh)
  return fresh
}

/** 投递统计快照（`dashboard diag` 与测试读；空 = 从未有投递尝试） */
export function subscriptionStats(): Array<{ key: string } & DeliveryStat> {
  return [...stats].map(([key, v]) => ({ key, ...v }))
}

/** 测试用：复位（避免用例间串味） */
export function __resetSubscriptionStatsForTest(): void {
  stats.clear()
}

/**
 * 从一条「成员一轮结束」事件里，找出**该通知谁**。
 *
 * 纯函数（不读盘、不投递）—— 便于单测"谁该被通知"这件事本身。
 *
 * @param subs 订阅表
 * @param memberDir 刚结束一轮的成员（轨迹**目录名**，非编码）
 * @returns 需要通知的订阅（同一个 watcher 的多条订阅**各自保留**：`note` 不同）
 */
export function pickSubscriptionsFor(subs: readonly TrajectorySubscription[], memberDir: string): TrajectorySubscription[] {
  return subs.filter((s) => s.members.some((m) => m === memberDir))
}

/**
 * 通知正文。
 *
 * 🔴 **刻意不带"它干了什么"**（owner：「不需要带它做了什么」）。带上就得先解析对方的产出，
 * 那会让"通知"变成"代它说话"——而本机制明确只是通知。
 * ⚠️ 但**必须**带够定位信息：谁说的、什么时候、是哪条订阅触发的（否则观察者拿到一句话无从查起）。
 *
 * @param memberDir 刚结束一轮的成员目录名
 * @param sub 命中的订阅（用它的 `note` 区分是哪条订阅）
 * @param atMs 事件时刻
 * @param iso 时刻格式化函数（注入便于测试固定时刻）
 */
export function buildSubscriptionText(
  memberDir: string,
  sub: TrajectorySubscription,
  atMs: number,
  iso: (ms: number) => string,
): string {
  const lines = [
    `〔轨迹订阅〕${memberDir} 刚完成一轮工作（${iso(atMs)}）。`,
    `这不是指令，只是通知 —— 要不要看、看了做什么，由你决定。`,
  ]
  if (sub.note) lines.push(`订阅说明：${sub.note}`)
  lines.push(`（订阅配置来自 .opencode/serenity.json 的 trajectorySubscriptions；本通知不含它做了什么）`)
  return lines.join('\n')
}

/** 装配依赖（注入便于单测；生产由 `defaultSubscriptionDeps` 填真实现） */
export interface SubscriptionDeps {
  /**
   * 某会话所属的 CCC 根（解析不出 ⇒ null）。
   *
   * 🔴 **为什么不固定传一个 root**：一个宿主进程可能同时服务**多个 CCC**
   * （本机实测 ≥2 个不同的根本同时活跃）。装配期只能拿得到一个根，
   * 拿它去服务全部会话 ⇒ 别的 CCC 的成员永远命中不了自己的订阅表。
   * ⇒ 根必须**按事件发生的那条会话**解析。
   */
  rootForSession: (sessionId: string) => string | null
  /** 读订阅表（含坏项） */
  readSubs: (root: string) => { subs: TrajectorySubscription[]; problems: string[] }
  /**
   * 会话 id → 该会话所承载的轨迹**目录名**（解析不出 ⇒ null）。
   * ⚠️ 返回目录名而不是编码：配置里写的是 `S###` **或目录名**，统一到目录名再比，
   * 否则「配置写 S142、实际解析出 2026-08-24--S142--xxx」这种就会永远不命中。
   */
  dirForSession: (root: string, sessionId: string) => string | null
  /** 即时投递（`sendToCognitiveTrajectory`） */
  deliver: (root: string, target: string, message: string) => Promise<{ ok: boolean; detail?: string }>
  /** 时刻格式化 */
  iso: (ms: number) => string
  /** 日志（注入便于断言"响亮"确实发生） */
  warn: (msg: string) => void
}

/**
 * 处理一次「某会话一轮结束」。
 *
 * 这是本模块**唯一的业务入口**（事件适配在 {@link registerTrajectorySubscriptions} 里）。
 * 分成"事件适配"与"业务处理"两半，是为了让后者**完全可单测**：
 * 不需要真宿主、不需要真 agent，只要喂一个 `sessionId`。
 *
 * @param deps 注入的依赖
 * @param sessionId 刚结束一轮的会话 id
 * @param nowMs 事件时刻
 * @returns 本次处理的结果摘要（**只用于测试与诊断**，生产调用方忽略）
 */
export async function onTurnFinished(
  deps: SubscriptionDeps,
  sessionId: string,
  nowMs: number,
): Promise<{ skipped: 'no-ccc' | 'no-subscriptions' | 'unbound-member' | null; delivered: number; failed: number }> {
  // 先解析根：解析不出 = 这条会话不在任何 CCC 内 ⇒ 与本机制无关（不是错误）
  const root = deps.rootForSession(sessionId)
  if (root === null) {
    bumpSkip('no-ccc')
    return { skipped: 'no-ccc', delivered: 0, failed: 0 }
  }

  const { subs, problems } = deps.readSubs(root)

  // 坏项**每次都报**（不只在启动时报一次）：配置可能热改，且"配了但不生效"必须在
  // 触发时刻就被人看见 —— 否则用户以为它在工作。（与 fail-open 的整体方向不冲突。）
  for (const p of problems) deps.warn(`[serenity-hooks] ✗ 轨迹订阅配置有坏项（${root}）：${p}`)

  if (subs.length === 0) {
    bumpSkip('no-subscriptions')
    return { skipped: 'no-subscriptions', delivered: 0, failed: 0 }
  }

  // ① 这个会话归哪条轨迹？（解析不出 ⇒ 跳过，**这不是错误**，见文件头失败面 ①）
  const memberDir = deps.dirForSession(root, sessionId)
  if (memberDir === null) {
    bumpSkip('unbound-member')
    return { skipped: 'unbound-member', delivered: 0, failed: 0 }
  }

  const hits = pickSubscriptionsFor(subs, memberDir)
  if (hits.length === 0) {
    bumpSkip('not-in-any-members')
    return { skipped: 'unbound-member', delivered: 0, failed: 0 }
  }

  let delivered = 0
  let failed = 0
  for (const sub of hits) {
    // 同一个 watcher 有两条订阅同时命中 ⇒ 两条都发（`note` 不同，用户配了两条就该收到两条）
    const key = `${sub.watcher}←${memberDir}`
    const st = statOf(key)
    st.lastAt = nowMs
    const text = buildSubscriptionText(memberDir, sub, nowMs, deps.iso)
    let res: { ok: boolean; detail?: string }
    try {
      res = await deps.deliver(root, sub.watcher, text)
    } catch (err) {
      // ② / ③ 失败面：**响亮**。投递层抛错等同于唤不醒，一并计入失败。
      res = { ok: false, detail: String((err as Error)?.message ?? err) }
    }
    if (res.ok) {
      st.ok += 1
      delivered += 1
    } else {
      st.failed += 1
      st.lastError = res.detail ?? '（无说明）'
      failed += 1
      deps.warn(
        `[serenity-hooks] ✗ 轨迹订阅投递失败：${memberDir} 一轮结束，但通知不到观察者「${sub.watcher}」` +
          `：${st.lastError}（订阅配置见 ${root}/.opencode/serenity.json 的 trajectorySubscriptions）`,
      )
    }
  }
  return { skipped: null, delivered, failed }
}

/**
 * 装配：订阅 `agent/status`，把「running → idle」翻译成一次 {@link onTurnFinished}。
 *
 * 🔴 **只认 `agent/status`**（理由见文件头「一轮结束的判据」）。具体是：
 * 记住上一次观察到的状态，**只在 running → idle 这一次跃迁**上报。
 * ⚠️ 为什么要自己记上一次状态：宿主虽然在**状态变化时**才发事件，但多条订阅/多条轨迹会
 * 各自收到同一事件；更要紧的是**进程刚启动时**可能直接收到 `idle`（载体被载入即 idle），
 * 那不是"一轮结束"，那是"它一直闲着"。⇒ **没有前置 running 就不算结束**。
 *
 * @param ctx 插件上下文（结构化访问 `on`）
 * @param deps 依赖（生产实现在 {@link defaultSubscriptionDeps}）
 */
export function registerTrajectorySubscriptions(ctx: unknown, deps: SubscriptionDeps): void {
  /** 会话 id → 上一次观察到的状态（只有 `running` 才需要记，idle/未知一律清） */
  const lastStatus = new Map<string, string>()

  try {
    ;(ctx as { on: (e: string, h: (p: unknown) => void) => void }).on('agent/status', (payload) => {
      bump('statusEvents') // 🔴 先记"事件来了" —— 这是"机制在跑吗"的最低证据
      const p = payload as { agent?: unknown; status?: unknown }
      const sessionId = (p?.agent as { session?: { id?: unknown } } | undefined)?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      const status = typeof p.status === 'string' ? p.status : ''
      if (status === 'running') {
        bump('runningSeen')
        lastStatus.set(sessionId, 'running')
        return
      }
      if (status !== 'idle') {
        lastStatus.delete(sessionId)
        return
      }
      bump('idleSeen')
      // 到这里 = idle。**只有前一刻是 running 才算"一轮结束"**（见上方注释）
      const prev = lastStatus.get(sessionId)
      lastStatus.delete(sessionId)
      if (prev !== 'running') {
        // 🔴 单独记：**没见 running 的 idle** 与**见了 running 的 idle** 意义完全不同
        //    （前者是宿主刚载入载体，后者才是真的一轮结束）。合成一个数就分不出来了。
        bumpSkip('idle-without-running')
        return
      }
      bump('turnFinished')
      // ⚠️ 不 await（事件处理器不该阻塞宿主），但**必须挂 catch**：
      //    否则 Promise 拒绝会成为 unhandledRejection（本容器栽过同类）。
      void onTurnFinished(deps, sessionId, Date.now()).catch((err) => {
        deps.warn(`[serenity-hooks] ✗ 轨迹订阅处理异常（会话 ${sessionId}）：${String((err as Error)?.message ?? err)}`)
      })
    })
  } catch (err) {
    // 失败不抛（apply 不可成为启动单点，与既有装配同款纪律）
    deps.warn(`[serenity-hooks] ✗ 轨迹消息订阅未装配（agent/status 不可用）：${String((err as Error)?.message ?? err)}`)
  }

  registerDisposer(ctx, 'trajectory subscriptions', () => {
    lastStatus.clear()
    stats.clear()
    __resetSubscriptionEvalForTest()
  })
}

/**
 * 生产依赖：把注入面接到真实现。
 *
 * ⚠️ **动态 import**：本模块被 `index.ts` 静态引入，而 `deliver` 需要调度器
 * （`wake/scheduler.ts` 静态链很重）⇒ 放到调用时再取，避免装配期把整条调度器链路拖进来。
 *
 * 🔴 **根按会话解析**（不是装配期固定）：见 {@link SubscriptionDeps.rootForSession} 的理由。
 * 取 cwd 的方式与 `trajectory/live.ts` 同源（`ctx.sessions.list()` 的 `header.cwd`）
 * —— ⛔ 不另写一份"找会话 cwd"的逻辑（会漂）。
 *
 * @param ctx 插件上下文（投递与读会话都用它）
 */
export function defaultSubscriptionDeps(ctx: unknown): SubscriptionDeps {
  /** 会话 id → cwd（取不到 ⇒ null）。每次现查，不缓存（缓存会引入"会话关了但缓存还在"）。 */
  const cwdOfSession = (sessionId: string): string | null => {
    try {
      const sessions = (ctx as { sessions?: { list?: () => unknown[] } } | undefined)?.sessions
      const list = sessions?.list?.()
      if (!Array.isArray(list)) return null
      for (const s of list) {
        const rec = s as { id?: unknown; header?: { cwd?: unknown } }
        if (rec?.id === sessionId) {
          const cwd = rec.header?.cwd
          return typeof cwd === 'string' && cwd !== '' ? cwd : null
        }
      }
      return null
    } catch {
      return null
    }
  }

  return {
    rootForSession: (sessionId) => {
      const cwd = cwdOfSession(sessionId)
      if (cwd === null) return null
      return cccRootForCwd(cwd)
    },
    readSubs: (root) => readTrajectorySubscriptions(root),
    dirForSession: (root, sessionId) => findTrajectoryHolding(`${root}/AGENT_SESSIONS`, sessionId),
    deliver: async (root, target, message) => {
      const { sendToCognitiveTrajectory } = await import('../wake/scheduler.js')
      // 发起者标记为「订阅」而非某条轨迹：观察者据此能分辨"这是系统通知，不是某人找我"
      const res = await sendToCognitiveTrajectory(ctx, root, target, message, 'trajectory-subscription')
      return { ok: res.ok, detail: res.detail }
    },
    iso: (ms) => localHuman(ms),
    warn: (msg) => console.warn(msg),
  }
}
