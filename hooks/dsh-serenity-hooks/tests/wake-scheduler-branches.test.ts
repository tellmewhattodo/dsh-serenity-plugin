/**
 * wake-scheduler-branches.test.ts — `wake/scheduler.ts` 的**降级/兜底/容错面**（⑤ 第 48 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `wake/scheduler.ts` = 分支 **75.86%（22/29）**，是 `src/**` 中**最低的未被做过**的文件
 * （43 `diag-ops` ／ 44 `compact` ／ 45 `lifecycle` ／ 46 `seams/context` ／ 47 `weixin-hook` 已做完）。
 * 语句 95.13%（254/267）。
 *
 * 🔵 **本件的额外价值（为何值得优先做）**：`wake/scheduler.ts` 是 ④ I2 收敛后
 * **仍列在 L1 违反清单上的 3 个文件之一**（`trajectory/rebuild.ts` 7 ／ **本文件 2** ／ `trajectory/carrier.ts` 1）
 * —— 它是**宿主接触面**（`Agent.followup`/`steer` 真被调用）。objective 的要害正是
 * 「**尤其管好与 DSH 的衔接面**」⇒ 把它的**降级路径**钉牢，比再补一个普通业务模块更贴目标。
 *
 * ── 🔴 为何这些分支从未被走过（本件的核心发现）──────────────────────────────
 * 未覆盖的分支**全部落在两类**上，而既有 `wake-registry.test.ts` 虽大（1042 行、覆盖
 * 注册表与投递主干），**这两类都不是它的对象**：
 *
 *  **(甲) 即时投递的「空闲分支」**（`:1780`）：既有用例测 `sendToCognitiveTrajectory` 时，
 *        `agent` 是**没有 `status` 字段**的普通对象 ⇒ `status === 'idle'` **恒 false**
 *        ⇒ 代码**永远走 `steer` 路径**。⇒ 🔴 也就是说：
 *        **`send-now` 投给一个「空闲」目标**（宿主 `agent.status === 'idle'`）这条**正常路径**
 *        **从来没有被执行过** —— 而它恰恰是**最常见的形态**（目标空闲时给它发消息）。
 *        把 `idle` 判反（或漏写 `followup` 直接 `steer` 一个 idle agent）**没有任何测试会红**。
 *
 *  **(乙) 整条链的「容错兜底」**（`:1934`~`:2063`）：CRO 关闸、CRO 扫描失败、
 *        CRO 内部异常、流水写入失败、存量清理、**注册表读坏**、投递失败退回 pending。
 *        这些分支的**共同设计承诺**是「**任何一环失败都不影响既有链路**」
 *        （设计 §5 铁律；文件头多处逐字写明）—— 而这条承诺**从未被机械验证过**。
 *        ⇒ 若有人把 `catch` 误改成 `throw`、或让"读坏注册表"连带跳过 CRO，
 *        **既有测试全绿**（它们只测 happy path 与单点失败）。
 *
 * 逐处清单（源码行 = 本件写作时的锚；**行号只作"某版本的实测读数"**）：
 *   A 类（即时投递分流）
 *     A1 :1780 `idle === true` ⇒ `followup`（**空闲目标走立即起轮**这条正常路径）
 *     A2 :1784 `idle` 路径上 `followup` 抛 ⇒ ok:false（不静默吞）
 *     A3 :1798 `steer` 与 `followup` **均失败** ⇒ 两个原因都进 detail（不许只报一个）
 *     A4 :1803 `steer` 抛但 `followup` 成功 ⇒ **退回排队**并留原因（负控：不许报成"已注入"）
 *     A5 :1713 / :1665 `sender` / `createdBy` 为**空串** ⇒ 回退文案（`||` 真侧）
 *   B 类（容错兜底 —— 本件主靶）
 *     B1 :1934 `croEnabled === false` ⇒ 记一行 & 本阶段 return（**既有链路不受影响**）
 *     B2 :1941 `listCroCognitiveTrajectories` 抛 ⇒ **静默跳过 CRO**，但既有投递照常
 *     B3 :1987 CRO 流水写入失败 ⇒ 只记一行，**不影响投递结论**
 *     B4 :1998 单条轨迹 CRO 内部异常 ⇒ 计入 skips，**同 tick 其它轨迹不受连累**
 *     B5 :2022 存量清理真清到东西 ⇒ 记「存量首清」一行
 *     B6 :2026 **注册表读坏 ⇒ 以空表继续 CRO 阶段**（不连带停掉 CRO，设计 §6.2）
 *     B7 :2059 投递失败 ⇒ 条目**退回 pending** ＋ attempts+1 ＋ 留原因（不删 = 不静默丢唤醒）
 *
 * ── 本件测的是什么（不是"覆盖率数字"）──────────────────────────────────────
 *   ① **分流正确性**：idle ⇒ `followup`、running ⇒ `steer` —— 两个方向都要钉
 *      （只测一边 = 判反了也绿；与第 46／47 件同族的"弱断言"）。
 *   ② **兜底的独立性**：任一环失败，**其余各环仍须全部执行** ——
 *      这是"不影响既有链路"的真实含义（不是"别崩"，而是"别互相拖累"）。
 *   ③ **失败不许被报成成功**：退回 followup 成功时要**明说是退回**（A4）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：A 类先证明"不注入 status 时走 steer"，
 *    再证明"status=idle 时走 followup" —— 否则无法区分"分流生效"与"夹具坏了"。
 *  · **失败路径用真故障形态注入**：真抛（不用空转 spy）、真坏 JSON、真占位目录。
 *  · **每处注入前先确认会落到源码哪一行**（累积纪律 14，第 47 件的教训）。
 *  · `it()` 标题内不用直引号（用「」）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 🔴 只替换被调方，被测模块 `wake/scheduler.ts` **真跑** ──────────────────
// 用 importActual 保留真实实现，只换掉下面这几个"可注入失败"与"可观测"的点。
const croState = {
  enabled: true,
  /** listCroCognitiveTrajectories 是否真抛（B2） */
  listThrows: false,
  /** 本 tick 会被扫描到的轨迹目录（B3/B4） */
  dirs: [] as string[],
  /** evaluateCro 的行为：wake / no-wake / skipped / throw（B4） */
  behavior: 'no-wake' as 'wake' | 'no-wake' | 'skipped' | 'throw',
  /** evaluateCro 的人为耗时（ms）—— 只有 §A1 并发用例需要它（其余用例恒 0，不拖慢套件） */
  delayMs: 0,
  /**
   * 每次 evaluateCro 的进出时刻（§A1 用例用来量**真实并发跨度**）。
   *
   * 🔴 为什么不用"跑 tick 之后等 N×delay×2 再量总耗时"：那样量到的是**我自己那个 sleep**，
   * 不是 CRO 阶段的跨度 —— 读数器与被测对象不匹配（D252），它会恒红且红得毫无信息。
   * ⇒ 只认这条：`max(出) − min(进)` = 该阶段真实的墙上跨度。
   */
  spans: [] as Array<{ in: number; out: number }>,
}
const logState = { appendOk: true }

vi.mock('../src/cro/core.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/cro/core.js')>()
  return {
    ...actual,
    listCroCognitiveTrajectories: (root: string) => {
      if (croState.listThrows) throw new Error('listCroCognitiveTrajectories boom (injected)')
      return croState.dirs.length > 0 ? croState.dirs : actual.listCroCognitiveTrajectories(root)
    },
    evaluateCro: async (root: string, dirName: string, input: unknown) => {
      // §A1 并发用例的耗时与进出时刻（其余用例 delayMs=0 ⇒ 不拖慢、不记录）
      if (croState.delayMs > 0) {
        const tIn = Date.now()
        await new Promise((r) => setTimeout(r, croState.delayMs))
        croState.spans.push({ in: tIn, out: Date.now() })
      }
      if (croState.behavior === 'throw') throw new Error('evaluateCro boom (injected)')
      if (croState.behavior === 'wake') {
        return {
          status: 'wake' as const,
          prompt: 'CRO 提示词（注入）',
          decision: { wake: true as const, prompt: 'CRO 提示词（注入）', reason: '注入的判定理由' },
        }
      }
      if (croState.behavior === 'skipped') {
        return { status: 'skipped' as const, error: '程序退出码 3（注入）', detail: 'injected skip' }
      }
      // no-wake：走真实现，保证形状与真实一致
      return actual.evaluateCro(root, dirName, input as never)
    },
  }
})

vi.mock('../src/cro/log.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/cro/log.js')>()
  return {
    ...actual,
    appendCroWakeLog: (...args: Parameters<typeof actual.appendCroWakeLog>) => {
      if (!logState.appendOk) return { ok: false, error: '流水写入失败（注入）' }
      return actual.appendCroWakeLog(...args)
    },
  }
})

import {
  deliverWake,
  registerWakeScheduler,
  sendToCognitiveTrajectory,
  wakeSchedulerState,
  __resetWakeSchedulerStateForTest,
} from '../src/wake/scheduler.js'
import {
  addWake,
  listWakes,
  wakeRegistryPath,
} from '../src/wake/registry.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'
import { hostname } from 'node:os'
import { CRO_HOST_FILENAME } from '../src/cro/core.js'

const DIR_NAME = '2026-09-13--S999--sched-target--auto'
const BOUND_ID = 'sess-sched-1'

let root: string

function writeSessionDir(dirName = DIR_NAME): string {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# SESSION\n', 'utf-8')
  return dir
}

/** 写一条归属（D172：写进轨迹目录的 `current.dsh_session_bind`；单槽位，重复调用即覆盖） */
function writeBinding(sessionId: string, dirName = DIR_NAME, at = Date.now()): void {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'current.dsh_session_bind'),
    JSON.stringify({ sessionId, at, action: 'activate' }),
    'utf-8',
  )
}

/**
 * 写 CRO **机器绑定**声明（所有者令 2026-10-15，D135）。
 *
 * ⚠️ **默认值 = 本机真机器名**：这些用例测的是**别的分支**（流水写入失败 / 内部异常…），
 * 必须让机器绑定门**通过**才能走到靶子 —— 否则测的就变成门本身了
 * （那会让"门挡住了"与"靶子坏了"看起来一样，是典型的假红）。
 * 要测门本身的用例，传 `host` 显式覆盖。
 */
function writeCroHostBinding(host: string = hostname(), dirName = DIR_NAME): void {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, CRO_HOST_FILENAME), `${host}\n`, 'utf-8')
}

/** 造一个可观测 agent：记录 followup / steer 各被调了几次 */
function makeAgent(status?: string) {
  const calls = { followup: 0, steer: 0 }
  const agent: Record<string, unknown> = {
    followup: () => { calls.followup += 1 },
    steer: () => { calls.steer += 1 },
  }
  if (status !== undefined) agent.status = status
  return { agent, calls }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsp-sched-br-'))
  croState.enabled = true
  croState.listThrows = false
  croState.dirs = []
  croState.behavior = 'no-wake'
  croState.delayMs = 0
  croState.spans = []
  logState.appendOk = true
  __setSimpleSourceForTest(() => defaultSimpleSettings())
})

afterEach(() => {
  __setSimpleSourceForTest(null)
  __resetWakeSchedulerStateForTest()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// A 类 — 即时投递的分流（:1780 起）
// ─────────────────────────────────────────────────────────────────────────────
describe('wake-scheduler 分支面: A 即时投递的 status 分流', () => {
  it('正控：agent **无 status** ⇒ 走 steer（既有用例的形态；证明夹具不瞎）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const { agent, calls } = makeAgent() // 无 status
    const ctx = { agents: { get: () => agent }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx, root, DIR_NAME, '你好', 'S142')
    expect(res.ok).toBe(true)
    // 🔴 正控先行：证明本组夹具能把消息送到 agent。若这条红了，
    //    下面"idle ⇒ followup"的断言就无法区分"分流生效"与"夹具坏了"。
    expect(calls.steer).toBe(1)
    expect(calls.followup).toBe(0)
  })

  it('🔴 A1：agent.status = idle ⇒ 走 followup（**空闲目标的正常路径**）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const { agent, calls } = makeAgent('idle')
    const ctx = { agents: { get: () => agent }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx, root, DIR_NAME, '你好', 'S142')
    expect(res.ok).toBe(true)
    // 🔴 这条钉的是"分流两个方向都成立"。只钉 steer 侧 = 判反了也绿。
    expect(calls.followup).toBe(1)
    expect(calls.steer).toBe(0)
  })

  it('A2：idle 路径上 followup 抛 ⇒ ok:false 且留原因（不静默吞）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const agent = {
      status: 'idle',
      followup: () => { throw new Error('followup boom (injected)') },
      steer: () => {},
    }
    const ctx = { agents: { get: () => agent }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx, root, DIR_NAME, '你好', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('followup boom (injected)')
  })

  it('🔴 A4：steer 抛但 followup 成功 ⇒ **退回排队**，且**明说是退回**（负控：不许报成"已注入"）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    let followups = 0
    const agent = {
      status: 'running',
      steer: () => { throw new Error('steer boom (injected)') },
      followup: () => { followups += 1 },
    }
    const ctx = { agents: { get: () => agent }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx, root, DIR_NAME, '你好', 'S142')
    // 🔴 语义：宁可不即时、不可丢消息。**且 detail 必须说"退回"** ——
    //    若这里报成"已即时注入"，就是**一条假陈述**（目标会误判看到它的时机）。
    expect(res.ok).toBe(true)
    expect(followups).toBe(1)
    expect(res.detail).toContain('退回')
    expect(res.detail).not.toContain('已即时注入')
  })

  it('🔴 A3：steer 与 followup **均失败** ⇒ 两个原因**都**进 detail（不许只报一个）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const agent = {
      status: 'running',
      steer: () => { throw new Error('steer boom (injected)') },
      followup: () => { throw new Error('followup boom (injected)') },
    }
    const ctx = { agents: { get: () => agent }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx, root, DIR_NAME, '你好', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('steer boom (injected)')
    expect(res.detail).toContain('followup boom (injected)')
  })

  it('A5：sender 为空串 ⇒ 回退「未知轨迹」（`||` 真侧）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const seen: string[] = []
    const agent = {
      status: 'idle',
      followup: (m: { content: Array<{ text: string }> }) => { seen.push(m.content[0].text) },
      steer: () => {},
    }
    const ctx = { agents: { get: () => agent }, get: () => undefined }
    await sendToCognitiveTrajectory(ctx, root, DIR_NAME, '正文', '')
    expect(seen[0]).toContain('来自 未知轨迹')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B 类 — 容错兜底（本件主靶：设计 §5 铁律「任何一环失败都不影响既有链路」）
// ─────────────────────────────────────────────────────────────────────────────
describe('wake-scheduler 分支面: B CRO 与容错兜底', () => {
  let listeners: Record<string, Array<() => void>>
  let disposers: Array<() => void>
  let timer: { fn: () => void } | null

  beforeEach(() => {
    listeners = {}
    disposers = []
    timer = null
    __resetWakeSchedulerStateForTest()
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void) => {
      timer = { fn }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => { timer = null })
  })

  function makeCtx(agentsGet?: (id: string) => unknown): unknown {
    return {
      // 🔴 CCC 根**必须**能从这个 ctx 枚举出来，否则 tick 在 collectWakeCccs 就提前 return
      //    （`roots.length === 0` ⇒ 写 skip 原因后返回空 log）—— 那样下面的断言全都会
      //    看到空日志。两件事缺一不可：① 根下有 `.serenity`（CCC 判据）② 会话带 `header.cwd`。
      sessions: { list: () => [{ id: BOUND_ID, header: { cwd: root } }] },
      agents: { get: agentsGet ?? (() => undefined) },
      get: () => undefined,
      on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) },
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  /** 跑一拍 tick 并返回时钟记录的 tick 日志。
   *  🔴 前置：根下**必须有 `.serenity`**，否则 `listCccs` 枚举不到任何 CCC ⇒
   *  `runWakeTick` 在开头就写 skip 原因并返回**空 log**（本件首跑即栽在这里：
   *  7 条 B 类全看到空日志）。⇒ 夹具先行条件写进 helper，避免每处重复踩。 */
  async function runOneTick(ctx: unknown): Promise<string[]> {
    writeFileSync(join(root, '.serenity'), '')
    registerWakeScheduler(ctx as never)
    // `runWakeTick` 为 async（并集枚举含 await）⇒ 必须**等一拍**再读（累积纪律 9）
    await new Promise((r) => setTimeout(r, 30))
    return wakeSchedulerState().lastTickLog
  }

  it('🔴 M1（§A1 并发）：N 条轨迹的 CRO **并发跑** ⇒ 总墙上时间 ≈ ceil(N/上限) × 单条，不是 N × 单条', async () => {
    // 🔴 本用例是 owner 令「整体节律 60 秒」的**准入判据**（执行清单 §A5）：
    //    串行语义下 N=8、单条 100ms ⇒ 墙上 ≈800ms；并发上限 4 ⇒ ≈200ms。
    //    60s 节拍下若仍是串行，真实单条最坏 60s ⇒ 一拍 480s ⇒ **静默永久追不上**。
    // ⚠️ 变异检验口径（A5）：把 `CRO_CONCURRENCY` 改回 1（或把 mapWithConcurrency 换成
    //    `for … await`）⇒ 本断言**必须红**。它红了才证明这层护栏真在起作用。
    const N = 8
    const PER_ITEM_MS = 100
    const dirs: string[] = []
    for (let i = 0; i < N; i++) {
      const d = `2026-09-13--S99${i}--sched-target--auto`
      writeSessionDir(d)
      writeCroHostBinding(hostname(), d) // 过机器绑定门，才真走到 evaluateCro
      dirs.push(d)
    }
    croState.dirs = dirs
    croState.behavior = 'no-wake'
    croState.delayMs = PER_ITEM_MS // 只在 evaluateCro 里睡，不睡投递面

    writeFileSync(join(root, '.serenity'), '')
    registerWakeScheduler(makeCtx() as never)
    // 等到 8 条都真被评估过（正控：先证明活了，再证明快）
    const deadline = Date.now() + 10_000
    while (croState.spans.length < N && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const text = wakeSchedulerState().lastTickLog.join('\n')
    // 正控先行：8 条**都真被评估了** —— 否则"跑得快"可能只是"根本没跑"
    // （D205 同族：快得不合理即可疑，先证明活了再证明快）。
    expect(text).toContain(`CRO 评估 ${N} 条`)
    expect(croState.spans).toHaveLength(N)

    // 🔴 判据 = CRO 阶段**真实墙上跨度** `max(出) − min(进)`：
    //    串行 ⇒ ≈N×delay = 800ms；并发上限 4 ⇒ ≈2×delay = 200ms。
    //    取串行下界的一半作阈：既吸收抖动，又不会被"稍微快一点"蒙混。
    const spans = croState.spans
    const span = Math.max(...spans.map((s) => s.out)) - Math.min(...spans.map((s) => s.in))
    const serialFloor = N * PER_ITEM_MS
    expect(span).toBeLessThan(serialFloor * 0.5)
    // 并发上限必须**自报**（否则这层能力在日志里不存在）。⛔ 不写死数值（D257）：只证明它在。
    expect(text).toMatch(/并发上限 \d+/)
  })

  it('🔴 B1：croEnabled=false ⇒ 记一行且**既有投递照常**（闸只关 CRO 本阶段）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const { agent, calls } = makeAgent(BOUND_ID)
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), croEnabled: false }))
    // 同时放一条到期条目 —— 证明"CRO 被关"**不**影响既有链路（这是该闸的承诺）
    addWake(root, { target: DIR_NAME, at: new Date(Date.now() - 1000).toISOString(), message: 'x', createdBy: 'test' })
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    expect(log.join('\n')).toContain('CRO 阶段：已关闭')
    expect(calls.followup).toBe(1) // 既有投递**没被连带关掉**
    expect(listWakes(root).entries.filter((e) => e.state === 'pending')).toHaveLength(0)
  })

  it('🔴 B2：listCroCognitiveTrajectories 真抛 ⇒ 静默跳过 CRO，但**既有投递照常**', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const { agent, calls } = makeAgent(BOUND_ID)
    croState.listThrows = true
    addWake(root, { target: DIR_NAME, at: new Date(Date.now() - 1000).toISOString(), message: 'x', createdBy: 'test' })
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    // 🔴 铁律：CRO 扫描失败**不得**上抛、也**不得**影响既有投递
    expect(calls.followup).toBe(1)
    expect(log.join('\n')).not.toContain('CRO boom')
  })

  it('🔴 B6：**注册表读坏 ⇒ 以空表继续 CRO 阶段**（不连带停掉 CRO，设计 §6.2）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    writeCroHostBinding() // 让本用例真走到 CRO 阶段（而不是停在绑定门）
    const { agent } = makeAgent(BOUND_ID)
    // 真故障形态：把注册表文件写成**非法 JSON**
    mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
    writeFileSync(wakeRegistryPath(root), '{ 这不是合法 JSON', 'utf-8')
    croState.dirs = [DIR_NAME]
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    // 🔴 两个断言都要：① 读坏的**痕迹在**（不静默）② CRO 阶段**仍然跑到了**
    //    若有人改成 `return`/`break`，CRO 那行就没了 —— 那正是"一个坏 JSON 让 CRO 一起静默"的缺陷复现。
    expect(text).toContain('✗')
    expect(text).toContain('CRO 评估')
  })

  it('🔴 B3：CRO 流水写入失败 ⇒ 只记一行，**投递结论不受影响**', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    writeCroHostBinding() // 🔴 必须先过机器绑定门，否则测的是门不是靶子
    const { agent } = makeAgent(BOUND_ID)
    croState.dirs = [DIR_NAME]
    croState.behavior = 'wake'
    logState.appendOk = false
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    expect(text).toContain('CRO 流水写入失败')
    // 投递本身仍被记为成功（写流水是旁路，不是投递的一部分）
    expect(text).toContain('已投递')
  })

  it('🔴 B4：单条轨迹 CRO 内部异常 ⇒ 计入跳过，**不影响既有链路**', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    writeCroHostBinding() // 🔴 同上：靶子是"内部异常"，不是"门"
    const { agent } = makeAgent(BOUND_ID)
    croState.dirs = [DIR_NAME]
    croState.behavior = 'throw'
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    // 🔴 语义：异常被**逐条**兜住并留痕（不能连累同 tick 其它轨迹，也不能上抛）
    expect(text).toContain('CRO 内部异常')
    expect(text).toContain('CRO 评估 1 条')
  })

  it('🔴 B8（机器绑定）：**没绑 ⇒ 不跑**，且逐条留痕、既有投递照常', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    // ⛔ 刻意**不写**绑定文件 —— 这正是"必须指定"的负控
    const { agent, calls } = makeAgent(BOUND_ID)
    croState.dirs = [DIR_NAME]
    croState.behavior = 'wake' // 若门失效，本 tick 会真的唤起
    // 放一条真到期的唤醒条目 ⇒ 用来证明"门只管 CRO，不管投递面"这条边界
    addWake(root, { target: DIR_NAME, at: new Date(Date.now() - 1000).toISOString(), message: 'x', createdBy: 'test' })
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    expect(text).toContain('CRO 机器绑定未通过')
    expect(text).toContain('not-bound') // 🔴 稳定码，供机械比对
    expect(text).toContain('非本机绑定 1')
    // ① 没有 CRO 唤起（门挡住了）——⚠️ tick 日志不渲染 prompt，故断言"唤起"这一事件本身
    expect(text).not.toContain('CRO 唤起')
    // ② 但**既有链路不受影响**：机器绑定只管 CRO，不管投递面（设计边界）
    expect(calls.followup).toBe(1)
  })

  it('🔴 B9（机器绑定）：**绑给别的机器 ⇒ 本机不跑**（这正是 owner 要的效果）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    writeCroHostBinding('some-other-machine') // 明确绑给别人
    const { agent, calls } = makeAgent(BOUND_ID)
    croState.dirs = [DIR_NAME]
    croState.behavior = 'wake'
    addWake(root, { target: DIR_NAME, at: new Date(Date.now() - 1000).toISOString(), message: 'x', createdBy: 'test' })
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    expect(text).toContain('CRO 机器绑定未通过')
    expect(text).toContain('bound-to-other')
    // 🔴 两个名字都印出来 ⇒ 排查时一眼看出"绑给了谁、我是谁"
    expect(text).toContain('some-other-machine')
    expect(text).not.toContain('CRO 唤起')
    expect(calls.followup).toBe(1)
  })

  it('🔴 B10（机器绑定）：**绑给本机 ⇒ 照常唤起**（正控：门不是"一律挡住"）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    writeCroHostBinding() // 本机真名
    const { agent } = makeAgent(BOUND_ID)
    croState.dirs = [DIR_NAME]
    croState.behavior = 'wake'
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    // 🔴 正控的必要性：只有负控会掩盖"门把一切都挡了"这种过宽缺陷
    expect(text).toContain('CRO 唤起')
    expect(text).toContain('已投递')
    expect(text).not.toContain('CRO 机器绑定未通过')
  })

  it('🆕 B11（机器绑定）：门在**装配快照之前** ⇒ 非本机轨迹不产生评估计数', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    writeCroHostBinding('another-machine')
    const { agent } = makeAgent(BOUND_ID)
    croState.dirs = [DIR_NAME]
    croState.behavior = 'no-wake'
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    const text = log.join('\n')
    // 计数口径：该条算进"非本机绑定"，**不算**进"跳过"（跳过 = 异常那一档）
    //
    // 🔴 2026-11-02（CRO 串行 → 受控并发）：本断言原先**逐字钉死整句**，而并发化在句末
    //   追加了 `；并发上限 4` ⇒ 逐字钉会让**一条不相关的改动**把人引到"计数错了"这个错方向。
    //   ⇒ 改钉**本用例真正守护的那一维**（三档计数各为几），并把句末那半句单独钉住
    //   —— 后半句是**新增的可见性**（"并发上限"一旦不报，本次并发化就失去了它的日志面）。
    //   边界用例（1 条轨迹时它恒等于 4）已在此句的尾段被顺带覆盖。
    expect(text).toContain('CRO 评估 1 条（唤起 0，不唤起 0，跳过 0，非本机绑定 1')
    // ⚠️ **不写死 4**（D257 同族：正控里出现"随被测对象变化的量"就不能硬编码）——
    //    并发上限是 scheduler 的实现常量，调它不该让**这条计数用例**变红。
    //    这里只钉"这一层在日志里自报了一个数"；具体值由 M1 那条用例负责。
    expect(text).toMatch(/；并发上限 \d+/)
  })

  it('🔴 B7：投递**真失败** ⇒ 条目退回 pending ＋ attempts+1 ＋ 留原因（不删 = 不静默丢唤醒）', async () => {    writeSessionDir()
    writeBinding(BOUND_ID)
    // ⚠️ 真故障形态要选**对**：本用例第一版只给"有绑定 + 无 live + 无 sessionController"，
    //    那命中的是 **notReady（环境未就绪）** 那条分支（`:629`），它**正确地**不计失败 ——
    //    于是断言"重试"红。⇒ 要走到 `:638` 的**真失败**分支，必须让 sessionController
    //    **在场但 resolveAgent 真抛**（"服务在、载入失败" ≠ "服务还没起来"）。
    addWake(root, { target: DIR_NAME, at: new Date(Date.now() - 1000).toISOString(), message: 'x', createdBy: 'test' })
    const ctx = {
      sessions: { list: () => [{ id: BOUND_ID, header: { cwd: root } }] },
      agents: { get: () => undefined }, // 无 live ⇒ 走 sessionController 冷载入
      get: (name: string) =>
        name === 'sessionController'
          ? { resolveAgent: async () => { throw new Error('resolveAgent boom (injected)') } }
          : undefined,
      on: () => {},
      effect: (cb: () => () => void) => { cb() },
    }
    const log = await runOneTick(ctx)
    const text = log.join('\n')
    expect(text).toContain('重试')
    const e = listWakes(root).entries.find((x) => x.target === DIR_NAME)
    // 🔴 三条一起钉：**行还在**（没被删）、**attempts 涨了**、**原因留下了**
    expect(e).toBeDefined()
    expect(e?.state).toBe('pending')
    expect(e?.attempts).toBe(1)
    expect(e?.lastResult ?? '').not.toBe('')
  })

  it('🔴 B5：存量清理真清到东西 ⇒ 记「存量首清」一行（幂等清理的可观测面）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    // ⚠️ 真故障形态要选**对**：本用例第一版用 `finalizeWake` 造存量 —— 但**它本身就是"写终态 + 删除"**
    //    （owner 2026-09-19 裁「直接删」）⇒ 盘上什么都没留下，purge 自然无事可清。
    //    要造出"本版上线前的积压形态"（终态行**留在盘上**），必须**手写注册表 JSON**。
    mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
    writeFileSync(
      wakeRegistryPath(root),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'w-legacy-0001',
            target: DIR_NAME,
            at: new Date(Date.now() + 3600_000).toISOString(),
            message: '旧积压',
            createdAt: new Date().toISOString(),
            createdBy: 'legacy',
            state: 'delivered',
            attempts: 1,
            lastResult: '结案（造存量：直接写盘，绕过 finalizeWake 的删除）',
          },
        ],
      }),
      'utf-8',
    )
    const { agent } = makeAgent(BOUND_ID)
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    expect(log.join('\n')).toContain('已结案记录')
    // 幂等佐证：清完之后盘上不再有终态行
    expect(listWakes(root).entries.filter((e) => e.state !== 'pending')).toHaveLength(0)
  })

  it('B 类正控：无任何故障 + 无 CRO 轨迹 ⇒ CRO 阶段廉价空转（不写多余行）', async () => {
    writeSessionDir()
    writeBinding(BOUND_ID)
    const { agent } = makeAgent(BOUND_ID)
    const log = await runOneTick(makeCtx((id) => (id === BOUND_ID ? agent : undefined)))
    // 🔴 正控：证明"没有 CRO 轨迹"是**安静**的（常态代价 = 一次 readdir，不刷屏）
    expect(log.join('\n')).not.toContain('CRO 评估')
  })
})
