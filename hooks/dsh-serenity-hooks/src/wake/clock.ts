/**
 * wake/clock.ts — **时钟运行时工厂**（S142 §38 复审候选 C6b，路径 **P2**）
 *
 * 🔴 2026-09-25（S142 分批清死代码·第 1 批）**更正**：本文件当初是为**两条**独立 5min 时钟抽出的公共引擎：
 *   · 唤醒调度器（`wake/scheduler.ts`，一次性唤醒，D58）—— **现存**
 *   · autopilot 时钟（`autopilot-trajectory.ts`，周期自唤醒，D59）—— 🔴 **已随 v1.35.0 整段退场**
 * 二者的**业务判据完全不同**（谁来扫 / 扫什么 / 投递给谁 / 按什么周期），但**引擎骨架逐字同形**
 * ——进程态 + 快照 + 复位 + `startTimer` + tick 外壳 + 事件接线 + disposer + `timer.unref()`。
 * 本条把**引擎**抽到本工厂，**各钟仍各持自己的定时器与自己的串行链**（现存的那一钟 = 唤醒调度器）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 🔴 硬约束一：**两条时钟绝不可共用"排队执行"的链**（这是 P2 与 P1 的分界判据）
 *
 * autopilot 每轮要跑该 CCC 的**偏见脚本**（`fetchBiasContent`，超时 60s），可能阻塞数十秒；
 * 若与唤醒调度器共用一条串行链，会把另一条一起**卡住**（一次性唤醒被无关的偏见脚本拖住）。
 * ⇒ 本工厂把 `chain` 作为**每实例私有状态**：`createClock()` 调用一次 = 一条独立的串行域。
 *    实例之间**零共享**（无模块级单例、无共享 Promise、无共享 map）。
 * ⚠️ 若日后有人把 `chain` 提到模块级"省一次分配"，**两条时钟的隔离即刻失效**——不许。
 *
 * 🔴 硬约束二：**武装门只判全局闸**（`gate()`），**不判"本次有无目标"**
 *
 * 2026-09-14 F 段实测缺陷：旧实现把"有 live CCC"当**武装前置条件**，而宿主刚重启时 live 会话
 * 必为空，且**"恢复旧会话"不触发 `session/created`**（只有新建会）⇒ 启动瞬间判定落空 =
 * **时钟永久不武装**（实测 6.6h 零 tick）。⇒ 现在「**全局闸开即武装**」，"有无目标"降级为
 * tick 内的廉价判定。**武装与"本次有无目标"是两件事，本工厂不得把二者耦合。**
 *
 * 🔴 硬约束三：**闸是可选能力，工厂不得替调用方假设"必须有闸"**（v1.34 S-1 解耦 → 2026-09-21 收窄）
 *
 * 🔴 2026-09-25（S142 分批清死代码·第 1 批）**更正：当前零条闸在用** —— 现存唯一那一钟
 * （唤醒调度器）本已无闸，而"曾只余的那一条" `autopilotWakeEnabled` 已随 **v1.35.0 autopilot
 * 整段退场**一并消失 ⇒ `gate` **缺省即常态，不是特例**。**唤醒调度器已无闸**
 * （原 `wakeSchedulerEnabled` 于 2026-09-21 所有者令砍掉 ⇒ 调用方**不传** `gate`
 * ＝ 恒武装、永不因闸跳过、`enabled` 恒 `true`）。工厂取 `gate` **回调**（每次现读），
 * **不做**任何合并或缓存；**缺省无闸是合法形态，不是漏配**。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 两条时钟**逐项语义差**（`ClockOptions` 的每个可配项都对应下表一行，不是随意的灵活性）：
 *
 * | 项 | 唤醒调度器 | autopilot | 工厂表达 |
 * |----|-----------|-----------|---------|
 * | `chain` | 有（全局串行） | 有（全局串行） | **总是私有**（硬约束一） |
 * | `lastTickLog` | 有（逐行摘要） | **无** | `logFrom` 不给 = 不记 |
 * | `ticks` 记账 | 工厂在 body **完成后**记 | **本钟**在同步段记 | `bodyCountsTick` + `begin` |
 * | body 返回类型 | `string[]`（人读摘要） | `void` | 泛型 `T` |
 * | 启动日志 | 固定串 | 含启用 CCC 计数 | `startLog: () => string` |
 * | body 异常兜底 | 留痕 + `console.warn` | 同 | 工厂统一（**吞异常不改语义**） |
 *
 * ───────────────────────────────────────────────────────────────────────────
 * **本工厂是"加法式"重构**（P2 的性质）：不新增任何判定逻辑，只把同形骨架收成一份代码；
 * 两个模块仍各自导出 `wakeSchedulerState()` / `autopilotClockState()` 与各自的
 * `__reset…ForTest()`，**对外可观测面（字段名与语义）零变化**——`acc-diag` ①b 段、
 * `surface/observation.ts:containerClocks()` 与面板都在读它们（见该文件 :225–250 的设计红线）。
 *
 * 为什么**不**取 P1（真合并成一个 `setInterval` + 两条策略）——2026-09-15 所有者裁决：
 * P1 只多省 ~20 行，却要把 `armed` 拆成"宿主 + 每策略"两层、并强行分开串行域，
 * 即**动两条正在跑的时钟的骨架**；**不值当**（裁决原文见 SESSION §12.8②）。
 */

/**
 * tick 周期（**60 秒**）。
 *
 * 🔴 2026-11-02 owner 令：「整体都是 60 秒…**能不做轮询就不做，如果做，就一定要少，
 *    所以 ACC 全局提供一个轮询，60 秒一次**」⇒ 由 `5 * 60 * 1000` 改为 `60 * 1000`。
 *
 * **为什么可以降到 60s（本批的硬前提，⛔ 不是顺手的调参）**：
 *   降频到 60s 意味着 CRO 进程量涨约 5 倍，而 CRO **每条 spawn 一个子进程、单条硬超时 60s**。
 *   若阶段仍串行，一拍就 > 60s ⇒ 拍子排队只积不丢 ⇒ **调度器静默永久追不上**。
 *   ⇒ 必须先有 `wake/scheduler.ts` 的**受控并发**（上限 4）与 `tick()` 的**跳拍而非排队**。
 *   这两件在 `续 373` 已落地并做了双变异检验（M1/M2 都能真红），故此处才允许改这个值。
 *
 * **owner 的架构原则一并记在这里**：**全局只允许一条轮询**。
 *   实测 `createClock()` 全仓只有一处调用（`wake/scheduler.ts`），autopilot 钟已于
 *   2026-09-15 整体删除 ⇒ 现状本来就只有一条。⇒ 本批**不新增任何定时器、不新增"每 N 拍"开关**。
 *
 * ⚠️ 语义不得变：该值同时是**报告文案的来源**（"等下个 Nmin tick"）—— 文案已随 60s 改为分钟/秒自适应，
 * 历史上曾因文案写死 10min 与实现 5min 不符而误导排查（§12.7 文案纠错）。
 */
const TICK_MS = 60 * 1000

/**
 * 时钟**进程态**（诊断用，模块级 = 进程级，正是诊断对象）。
 *
 * 字段名与语义是**对外契约**（`acc-diag` / `containerClocks` 在读），不得因本重构改名或改义。
 * `lastTickLog` 只有唤醒调度器消费（autopilot 无对应字段），故这里是**可选**。
 */
export interface ClockRuntime {
  /** 定时器是否在跑（start 成功 → true；disposer 拆卸 → false） */
  armed: boolean
  /** 武装时刻（ms；null = 从未） */
  armedAt: number | null
  /** 上次真正执行 tick 的时刻（ms；null = 从未——被闸跳过的 tick 不刷新它） */
  lastTickAt: number | null
  /** 真正执行过多少次 tick */
  ticks: number
  /** 上次被跳过 / 异常的原因（null = 上次正常执行） */
  lastSkipReason: string | null
  /** 上次 tick 的逐行摘要（**可选**：只有给了 `render` 的钟才有此字段） */
  lastTickLog?: string[]
}

/**
 * 一个钟实例（= 一个定时器 + 一条**私有**串行链 + 一份进程态）
 */
export interface Clock {
  /** 幂等启动：已武装则原样返回；`gate()` 为假则不武装（零资源占用）；成功则立即跑一次 tick */
  start: () => void
  /** 拆卸：清定时器 + 复位 armed/armedAt + 跑 `onDispose` */
  dispose: () => void
  /** 进程态快照（只读；`enabled` = `gate()` 的**当前**值，便于区分"未武装"与"闸关"） */
  snapshot: () => ClockRuntime & { enabled: boolean }
  /**
   * body 内部留痕"本次跳过原因"（`null` = 本次正常执行）。
   *
   * 为什么需要它：**"没有可扫目标"是 body 才知道的事**（autopilot 的 `无 live+enabled CCC…`
   * 与唤醒调度器的 `无已知 CCC 可扫…` 判定都在 body 内），但该字段是进程态的一部分 ⇒
   * 由 body 经本方法写回，工厂不再替 body 猜。**只有 body 能调**（引擎自身走 `gateOffReason`）。
   */
  noteSkipReason: (reason: string | null) => void
  /**
   * 把一段**在飞工作**排到**本钟私有**串行链的尾部（不经 tick 包装：不记账、不写 lastTickLog、不吞异常）。
   *
   * 何时用它：body 在一次 tick 里为**多个目标**各派一件活儿，这些活儿要**依次**跑（防模型并发挤兑），
   * 而它们在**本次 tick 返回之后**仍在飞（autopilot 即此：同 tick 多 CCC 依次唤起）。
   * 若 body 自己另起一条链，就是**第二条串行域**——本钟的"串行"会有两处真相。
   *
   * ⚠️ **风险由调用方担**：本方法**不** try/catch（与 `body` 相反）。调用方必须自带兜底
   * （autopilot 的每件活儿都有自己的 try/catch/finally）——否则一个异常会**毒化整条链**，
   * 该钟此后的 `enqueue` 与 tick 都会静默不执行。
   */
  enqueue: (work: () => Promise<void> | void) => void
  /**
   * 记一次 tick（`ticks += 1` + `lastTickAt = now`）。
   *
   * **只有 `bodyCountsTick: true` 时才由 body 调用**（autopilot）；缺省时工厂在 body 完成后
   * 自动调用，body 不该再调（会重复计数）。见 {@link ClockOptions.bodyCountsTick}。
   */
  countTick: () => void
  /** 测试用：复位进程态（避免用例间串味） */
  reset: () => void
}

/** `createClock` 的可配项（每一项都对应文件头语义差表的一行；**没有"顺手加"的开关**） */
export interface ClockOptions<T> {
  /** 本钟的**唯一**诊断名（进异常日志，用于人读定位） */
  label: string
  /**
   * 宿主上下文（**只读它的 `on`**）。装配时赋值（`register*` 的第一件事），
   * `body` / `startLog` / 热启动接线都从**这一个格子**读——避免"三处各存一份 ctx"。
   * 装配前为 `undefined`：那时也没有定时器（tick 无从发起），故不会被读到。
   *
   * 类型取**结构最小面**（不是 `cordis.Context`）：本工厂不该依赖宿主的强类型事件表
   * （`on` 在 cordis 上是泛型重载，比 `(name: string, fn) => void` **更窄** ⇒ 直接传 Context
   * 反而不兼容）。装配点传 `ctx` 即可。
   */
  ctx: unknown
  /** 热启动触发面事件名（回调恒为 `() => start()`——两条钟的触发面同形，不开放自定义回调） */
  events?: string[]
  /**
   * 闸（**可选**）：**每次现读**（不缓存——面板改开关后要能立刻反映）+ 武装门**只**判它。
   *
   * ⚠️ **2026-09-21（所有者令）起可为缺省**：唤醒调度器的闸已被**砍掉**（原话「send-later 的开关
   * 不再重要了，砍掉」）⇒ 「**本钟没有闸**」必须能被表达。**缺省 = 无闸**：恒武装、永不因闸跳过、
   * `snapshot().enabled` 恒 `true`。（工厂**能力**保留——将来任何钟仍可自带闸。）
   */
  gate?: () => boolean
  /** body 被**闸**跳过时写入 `lastSkipReason` 的文案（文案归各钟，工厂不编；**无闸时无意义**） */
  gateOffReason?: string
  /**
   * **同步前置阶段**（在 body 被调用**之前**、同一个 tick 内同步执行）。
   *
   * 存在的理由不是"方便"，而是**既有行为要求**（实测被两条回归钉守住）：
   * autopilot 的 `ticks` / `lastSkipReason` 是在 tick **同步段**里定下来的——
   *   · 枚举到 live+enabled CCC ⇒ 立刻 `countTick()`（早于任何 `await`）；
   *   · 枚举为空 ⇒ 立刻 `noteSkipReason('无 live+enabled CCC…')` 并**不计 tick**。
   * 若把这些挪进 body（async），观测面会在"启动即 tick"的那一瞬间读到**旧值**
   * （`ticks` 停留在 0、`lastSkipReason` 仍是上一拍的）——诊断面说了假话。
   *
   * 唤醒调度器**不用**本项（它的 `ticks` 在 body 完成后由工厂记，见 `bodyCountsTick`）。
   */
  begin?: () => void
  /**
   * 一次 tick 的**业务体**（引擎不关心里面做什么；返回值交给 `logFrom`）
   */
  body: () => Promise<T> | T
  /**
   * `ticks` / `lastTickAt` 的**记账时机**（两条钟真的不同，见文件头语义差表）：
   *
   * `false`（缺省）= **工厂在 body 完成后**记账 —— 唤醒调度器语义：
   *   "tick 数 = 真执行**并完成**过的 tick"。但 `body` 提前返回（"无 CCC 可扫"）时也照样记账
   *   （wake 的既有行为就是如此：`ticks` ≠ "真投递过的 tick"）。
   *
   * `true` = **body 自己调 {@link Clock.countTick} 记账** —— autopilot 语义：
   *   `ticks`/`lastTickAt` 在**枚举到 live+enabled CCC 之后、任何 await 之前**同步记账；
   *   "无 CCC 可扫" 的那一拍**不计**（既有行为：`ticks` 停在 0 直到真有 CCC 可唤起）。
   *   若把它交给工厂"body 前同步记账"，就会**在闸之后无条件 +1**——那会把
   *   "无 CCC 可扫时不计数"这条既有语义改掉（🔴 **回归钉在 `clock-runtime.test.ts`**：
   *   『`bodyCountsTick=true` → 工厂不记账，由 body 决定（autopilot 语义：无目标则不计）』
   *   ＋『body 调 `countTick` 才计，且可在 await 之前同步计』—— 原文曾指向
   *   `autopilot-trajectory.test.ts`，**该文件已随 v1.35.0 退场、全仓不存在**
   *   ⇒ 2026-09-25 **只修引用**，语义与断言逐字未动）。
   *
   * ⚠️ 故本项**不是**"记账早晚"的风格开关，而是"**谁**知道该不该记"的归属划分：
   *   知道"有没有目标"的只有 body ⇒ 由 body 决定何时记账。
   */
  bodyCountsTick?: boolean
  /**
   * 本钟是否记 tick 日志（`lastTickLog`）。
   * 给了 `logFrom` **才**有此字段与逐行打印——autopilot **没有** `lastTickLog`（现状稿 §2.4），
   * 故它不传本项（情形分布不同：autopilot 的结果进 `wakeHistory` 审计 ring，不走 tick 日志）。
   */
  logFrom?: { prefix: string; lines: (value: T) => string[] }
  /** 启动成功的日志行（autopilot 需在里面报启用 CCC 计数，故做成回调） */
  startLog: () => string
  /** 启动时是否立刻跑一次 tick（两条钟皆为 true；留成显式项以免日后被默默改掉）@default true */
  immediate?: boolean
  /** 拆卸回调（工厂负责清定时器与复位进程态；本项是**额外**清理，如 autopilot 的 `runningByRoot`） */
  onDispose?: () => void
  /** 测试复位回调（如 autopilot 顺带 `runningByRoot.clear()`） */
  onReset?: () => void
}

/** 时钟的**私有**运行态（每实例一份——见文件头硬约束一；`runtime` 与快照是**同一对象**） */
interface InstanceState<T> {
  timer: ReturnType<typeof setInterval> | null
  /** 🔴 **本钟自己的**串行链：同一时刻只跑一次 tick。**绝不**与另一条钟共享 */
  chain: Promise<void>
  runtime: ClockRuntime
  /** 事件是否已挂（只挂一次——`start()` 会被反复调用） */
  wired: boolean
  /**
   * 是否有一拍 tick **已排队或正在执行**（2026-11-02 §A3「跳拍而非排队」的判据位）。
   *
   * 语义 = "本钟这条串行链上最多只允许**一拍** tick 待跑"。缺它就是旧的**排队**语义：
   * 节拍 60s 而一拍要跑 120s 时，积压**只增不减**，且积压本身**零信号**（看上去一切正常，
   * 只是投递越来越晚）—— 那正是本批要消灭的静默失效形态。
   */
  tickPending: boolean
  /** 在飞那一拍的开始时刻（ms；null = 无在飞）。跳拍日志要报"它已经跑了多久"才有诊断价值 */
  tickStartedAt: number | null
  opts: ClockOptions<T>
}

/**
 * 挂事件 → 触发 `start()`（**每个事件一次 try/catch 吞异常**：事件通道缺失不阻断时钟）。
 *
 * 为什么吞异常：宿主（headless profile 等）可能没有事件通道；**启动时已 `start()` 过一次**，
 * 事件只是"跟上面板开关 / 新会话"的热启动补丁，缺它不该让整个装配抛错。
 * @param on 宿主的 `on`（可能不存在）
 * @param ctx `on` 的 `this`（宿主 API 常要求绑定）
 * @param clock 目标时钟
 * @param events 事件名列表（回调恒为 `() => clock.start()`）
 */
function attachClockEvents(
  ctx: unknown,
  clock: Clock,
  events: string[],
): void {
  const on = (ctx as { on?: (name: string, fn: () => void) => void } | undefined)?.on
  if (typeof on !== 'function') return
  for (const name of events) {
    try {
      on.call(ctx, name, () => clock.start())
    } catch {
      /* 事件通道缺失不阻断（启动时已尝试一次 start()） */
    }
  }
}

/**
 * 建一条时钟（**每钟各调一次**——本工厂**不是**单例，调用次数 = 时钟条数）。
 *
 * 顺序忠实于既有实现：`start()` 先武装并立即跑一次 tick → 再挂事件。
 * 拆卸由调用方经 `registerDisposer(ctx, label, clock.dispose)` 落到宿主的 `ctx.effect`。
 * @param opts 见 {@link ClockOptions}（每项对应一条既有的语义差）
 * @returns 该钟的 `{start, dispose, snapshot, reset}`
 */
export function createClock<T>(opts: ClockOptions<T>): Clock {
  const runtime: ClockRuntime = { armed: false, armedAt: null, lastTickAt: null, ticks: 0, lastSkipReason: null }
  if (opts.logFrom) runtime.lastTickLog = []
  const st: InstanceState<T> = { timer: null, chain: Promise.resolve(), runtime, wired: false, tickPending: false, tickStartedAt: null, opts }

  /** 记一次 tick（工厂内部与 body 共用同一实现——只有一处会计逻辑） */
  const countTick = (): void => {
    runtime.lastTickAt = Date.now()
    runtime.ticks += 1
  }

  /**
   * 本钟累计跳过几拍（§A3）。
   *
   * ⚠️ **刻意不进 `ClockRuntime`**：`ClockRuntime` 的字段是**对外契约**
   * （`acc-diag` / `containerClocks()` / 面板在读，见文件头"对外可观测面零变化"），
   * 加字段等于改契约。跳过次数目前只出现在**日志行**里 —— 那已经够判"这个钟在追赶还是空转"。
   * 若日后要进诊断面，须按改契约走（同批改消费方），⛔ 不许顺手塞。
   */
  let skipCount = 0

  /** 逐行打印（`logFrom` 缺省 ⇒ 本钟无 tick 日志，整段为死代码路径） */
  const emit = (lines: string[]): void => {
    if (!opts.logFrom) return
    for (const line of lines) console.log(`${opts.logFrom.prefix}${line}`)
  }

  /**
   * 跳拍判定（2026-11-02 §A3）：上一拍**还没跑完** ⇒ 本拍**直接丢弃**，不入链。
   *
   * 🔴 为什么必须跳、不能排队（owner 令「整体节律 60 秒」的硬前提）：
   *   · 排队语义下，一拍耗时 > 节拍 ⇒ 积压**只增不减**，且呈现为"投递越来越晚"而非任何报错；
   *   · CRO 每拍要 spawn N 条子进程（单条硬超时 60s），N ≥ 8 时最坏 480s ⇒ 60s 节拍下
   *     必然积压 ⇒ **调度器静默永久追不上**；
   *   · 而"跳掉一拍"的代价是**迟一拍拍到**，与"排队后跑到 8 拍之前的内容"相比，
   *     后者的输出在语义上已经过期（唤醒"看着情况叫"，看的是**当时**的情况）。
   *   ⇒ 跳拍是**正确性**要求，不是性能优化。
   *
   * 🔴 跳拍**不记账**（不调 `countTick`）：`ticks` 是**所有 CRO 判据的时间基准**
   *   （`cro/core.ts` 快照里就是 `scheduler.ticks`，`guard` 的"刚启动窗口 = 第 2~3 拍"直接依赖它）
   *   ⇒ 跳掉的那一拍**不是一拍已完成的钟**，给它 +1 会**静默改变所有下游的时间语义**。
   *
   * 🔴 跳拍**必须出声**（D186/D209：可以拒绝，但不许不出声）：写一行带读数的 warn ——
   *   "跳了几拍、在飞的那拍已经跑了多久"。否则"钟在跑但什么都没发生"与"钟根本没跑"
   *   在读数上不可分（A106 同族）。
   */
  const skipOrRun = (): void => {
    if (st.tickPending) {
      const runningFor = st.tickStartedAt === null ? 0 : Date.now() - st.tickStartedAt
      skipCount += 1
      const msg =
        `⏭ 跳拍（上一拍仍在飞，已跑 ${Math.round(runningFor / 1000)}s；` +
        `本钟累计跳过 ${skipCount} 拍，节拍 ${Math.round(TICK_MS / 1000)}s）`
      runtime.lastSkipReason = msg
      if (opts.logFrom) runtime.lastTickLog = [msg]
      console.warn(`[serenity-hooks] ${msg}（${opts.label}）`)
      return
    }
    runTick()
  }

  /**
   * 跑一拍（进入本钟私有串行链）。
   *
   * ⚠️ `tickPending` 在**入链之前**置位、在 body 完成（或异常）后的 `finally` 里清位 ——
   *    置位必须同步、早于 `st.chain = st.chain.then(...)` 真正执行回调，
   *    否则同一 tick 周期内的两次调用会都判"无在飞"而双双入队。
   */
  const runTick = (): void => {
    if (opts.gate !== undefined && !opts.gate()) {
      runtime.lastSkipReason = opts.gateOffReason ?? null
      return
    }
    // 同步前置阶段（见 ClockOptions.begin）：tick 的"这一拍算不算数"必须**同步**定下来，
    // 否则观测面在"启动即 tick"的瞬间会读到上一拍的旧值（autopilot 的既有行为要求）。
    // 与 body 同等兜底：一个坏的 begin 不得杀掉时钟所在进程；本拍**作废**（不投递）。
    if (opts.begin) {
      try {
        opts.begin()
      } catch (err) {
        console.warn(`[serenity-hooks] ✗ tick 前置异常: ${String((err as Error)?.message ?? err)}（${opts.label}）`)
        return
      }
    }
    st.tickPending = true
    st.tickStartedAt = Date.now()
    // 🔴 接到**本钟私有**的串行链尾（硬约束一）
    st.chain = st.chain.then(async () => {
      try {
        const value = await opts.body()
        // 缺省此处记账（唤醒调度器语义）；`bodyCountsTick` 时改由 begin/body 自己记
        if (!opts.bodyCountsTick) countTick()
        if (opts.logFrom) {
          // 每 tick 用**本 tick 的新数组**替换（既有 wake 语义：lastTickLog = "上次 tick 的摘要"）
          runtime.lastTickLog = opts.logFrom.lines(value)
          emit(runtime.lastTickLog)
        }
      } catch (err) {
        const msg = `✗ tick 异常: ${String((err as Error)?.message ?? err)}`
        // 异常路径**留痕且不抛出**：一个坏 tick 不得杀掉时钟所在进程（既有两条钟的语义）
        if (opts.logFrom) runtime.lastTickLog = [msg]
        console.warn(`[serenity-hooks] ${msg}（${opts.label}）`)
      } finally {
        // 🔴 必须清位：否则"跳过一拍"会退化成"从此永久跳拍"（一次慢拍把钟**永久停掉**——
        //    那是比积压更坏的静默失效，且它与"钟没武装"读数相同）。
        st.tickPending = false
        st.tickStartedAt = null
      }
    })
  }

  /**
   * 幂等启动 + 武装门：**已武装 → 原样返回**（防重复起定时器）；
   * **闸关 → 不武装**（零资源占用）；闸开则**无条件**武装（硬约束二：不判"有无目标"）。
   */
  const start = (): void => {
    if (st.timer) return
    // 事件接线必须**早于**闸判定（否则会永久失联）：
    //   旧实现把「挂事件」放在函数末尾 ⇒ 启动时闸关 ⇒ 根本走不到那一步 ⇒ **事件从未挂上**；
    //   此后人类在面板把闸打开 → `serenity/settings-changed` 无人监听 → **热启动失效**
    //   （🔴 **回归钉在 `clock-runtime.test.ts`**：『闸关时 start ⇒ 事件仍必须挂上（否则面板开闸后
    //    热启动永久失联）』＋『闸先关后开 → 事件/再次调用 start() 可补武装（热启动路径）』——
    //    原文曾指向 `autopilot-trajectory.test.ts`，**该文件已随 v1.35.0 退场、全仓不存在**
    //    ⇒ 2026-09-25 **只修引用**，语义与断言逐字未动）。
    //   事件是"唤醒这条钟"的唯一入口，它的存在**不该依赖某一刻的闸值**。
    //   只挂一次（`wired` 守卫）：`start()` 会被反复调用（每次事件 + 组装点），不能重复注册监听器。
    if (opts.events && !st.wired) {
      st.wired = true
      attachClockEvents(opts.ctx, api, opts.events)
    }
    if (opts.gate !== undefined && !opts.gate()) return
    st.timer = setInterval(skipOrRun, TICK_MS)
    // unref：进程存活时定时器照常触发；进程退出（插件卸载 / 服务器停止）不阻塞退出
    st.timer.unref()
    runtime.armed = true
    runtime.armedAt = Date.now()
    console.log(opts.startLog())
    // 启动时立即跑一次（插件重启后恢复节律，无需等首个 5min）
    if (opts.immediate !== false) skipOrRun()
  }

  const dispose = (): void => {
    if (st.timer) {
      clearInterval(st.timer)
      st.timer = null
    }
    runtime.armed = false
    runtime.armedAt = null
    opts.onDispose?.()
  }

  const api: Clock = {
    start,
    dispose,
    snapshot: () => ({
      enabled: opts.gate === undefined ? true : opts.gate(),
      ...runtime,
      ...(runtime.lastTickLog ? { lastTickLog: [...runtime.lastTickLog] } : {}),
    }),
    noteSkipReason: (reason) => {
      runtime.lastSkipReason = reason
    },
    countTick,
    enqueue: (work) => {
      // `work()` 同步抛错也变 rejection（`.then` 的语义）⇒ 链上每个环节都能写完整的两分支
      st.chain = st.chain.then(work, () => undefined).then(
        () => undefined,
        (err: unknown) => {
          // enqueue 的本职是排队；异常归属是**调用方**的事（见接口注释）。此处只保证
          // **链不被毒化**——否则一个坏任务会让本钟此后再也不排队。
          console.warn(`[serenity-hooks] ✗ 串行任务异常（${opts.label}）: ${String((err as Error)?.message ?? err)}`)
        },
      )
    },
    reset: () => {
      // ⚠️ 必须**同时清定时器**（不只是复位字段）：本实例是模块级常量，进程内 `start()` 可能
      // 被调用多次（旧实现的 `register*` 每次调用都新建一份闭包态，天然不受影响；收进工厂后
      // 若只复位字段，"已武装 ⇒ 早退"会让后续 `start()` 全部**静默失效**）。生产只装配一次，
      // 故这条主要护测试；但它同时是"重置 = 回到未武装"这个语义的**正确**表达。
      if (st.timer) {
        clearInterval(st.timer)
        st.timer = null
      }
      runtime.armed = false
      runtime.armedAt = null
      runtime.lastTickAt = null
      runtime.ticks = 0
      runtime.lastSkipReason = null
      if (opts.logFrom) runtime.lastTickLog = []
      // `wired` 一并复位：重置 = 回到"未武装且未接线"的初始态。否则进程内第二次
      // `register*`（测试；或理论上 HMR 重装配）会因旧实例已置位而**不再挂事件** ⇒ 热启动失联。
      st.wired = false
      // 🔴 §A3 的两个新字段同样必须复位：`tickPending` 若残留 true，重置后的钟会**永远跳拍**
      //    （看上去"已武装"、`ticks` 却再也不涨 —— 与"钟没起来"读数相同，零信号）。
      st.tickPending = false
      st.tickStartedAt = null
      skipCount = 0
      opts.onReset?.()
    },
  }
  return api
}
