/**
 * clock-runtime.test.ts — 时钟运行时工厂（C6b / 路径 P2）
 *
 * 本文件是 `src/wake/clock.ts` 的**镜像测试**（coverage-gate.test.ts 的 P2-2 门禁要求
 * 每个 src 业务模块都有测试覆盖），同时承载 C6b 的**分界判据**：
 *
 * 🔴 最重要的是「**串行域独立**」那一条（{@link describe} 最后一组）——它是 **P2 与 P1 的分界**：
 *    · P2（已取）：两条时钟共用**一份代码**、各持**自己的定时器与自己的串行链**；
 *    · P1（已否）：真合并成一个循环，只多省 ~20 行却要动两条正在跑的时钟的骨架。
 *    若工厂误把 `chain` 提到模块级，本组用例会红——**它是防止有人"顺手优化"的钉子**。
 *
 * 另三组对应用户指令的其余要求：闸开即武装（含**零 live 会话**）、幂等、tick 异常不杀进程且留痕、
 * 拆卸（清定时器 + 在飞 tick 不再投递）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClock, type ClockOptions } from '../src/wake/clock.js'

/** 受控计时器（拦下 setInterval，使我们能手动"走一拍"） */
interface FakeTimer {
  fn: () => void
  ms: number
}

describe('createClock（时钟运行时工厂，C6b/P2）', () => {
  let timer: FakeTimer | null
  let gate: boolean

  beforeEach(() => {
    timer = null
    gate = true
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      timer = { fn, ms }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => {
      timer = null
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 造一个最小可用时钟（`body` 默认空转；调用方可覆盖任意项） */
  function makeClock(over: Partial<ClockOptions<string[]>> = {}) {
    const opts: ClockOptions<string[]> = {
      label: 'test-clock',
      ctx: undefined,
      gate: () => gate,
      gateOffReason: '闸关（测试）',
      body: () => [],
      startLog: () => 'started',
      ...over,
    }
    return { clock: createClock(opts), opts }
  }

  /** 等一拍微任务（链是 `.then(...)` 驱动的） */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }

  describe('武装门：全局闸开即武装（**不判有无目标**——F 段缺陷禁回退）', () => {
    it('闸开 + **零目标** → 仍武装（旧缺陷：把"有目标"当武装前置 ⇒ 启动瞬间落空即永久不武装）', async () => {
      // body 立刻返回"无目标"（模拟 autopilot 的 `无 live+enabled CCC` / wake 的 `无 CCC 可扫`）
      const { clock } = makeClock({ body: () => [] })
      clock.start()
      // 🔴 关键：武装与"body 报无目标"无关——定时器必须已起
      expect(timer).not.toBeNull()
      const st = clock.snapshot()
      expect(st.armed).toBe(true)
      expect(st.armedAt).not.toBeNull()
      expect(st.enabled).toBe(true)
      await settle()
      clock.dispose()
    })

    it('闸关 → 不武装（零资源占用语义保留），快照如实报告 enabled=false', () => {
      gate = false
      const { clock } = makeClock()
      clock.start()
      expect(timer).toBeNull()
      const st = clock.snapshot()
      expect(st.armed).toBe(false)
      expect(st.enabled).toBe(false)
      expect(st.armedAt).toBeNull()
    })

    it('闸先关后开 → 事件/再次调用 start() 可补武装（热启动路径）', () => {
      gate = false
      const { clock } = makeClock()
      clock.start()
      expect(timer).toBeNull()
      gate = true
      clock.start()
      expect(timer).not.toBeNull()
      expect(clock.snapshot().armed).toBe(true)
    })

    it('闸在两次 tick 之间被关掉 → 该 tick 记 skipReason 且**不跑 body**（中途关闭即停）', async () => {
      let bodies = 0
      const { clock } = makeClock({ body: () => { bodies += 1; return [] } })
      clock.start() // 启动即 tick 一次
      await settle()
      expect(bodies).toBe(1)
      gate = false
      timer!.fn() // 手动走一拍
      await settle()
      expect(bodies).toBe(1) // 没跑 body
      expect(clock.snapshot().lastSkipReason).toBe('闸关（测试）')
    })
  })

  describe('幂等：重复 start 只有一个定时器', () => {
    it('连续 start() 三次 → setInterval 只被调用一次，armedAt 不被刷新', () => {
      const spy = vi.mocked(global.setInterval)
      const { clock } = makeClock()
      clock.start()
      const armedAt = clock.snapshot().armedAt
      clock.start()
      clock.start()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(clock.snapshot().armedAt).toBe(armedAt)
    })

    it('定时器用 TICK_MS（60s，2026-11-02 owner 令）注册，且 unref 过的句柄被持有', () => {
      const { clock } = makeClock()
      clock.start()
      // 🔴 这个数**必须写死**（不是"D257 那类随被测对象变化的量"）：它钉的正是
      //    owner 明令的那个数（「整体都是 60 秒」）。若某天有人把它调回 5min，
      //    本断言必须红 —— 那是一次**需要 owner 知晓**的行为变更，不是调参。
      expect(timer!.ms).toBe(60 * 1000)
    })
  })

  describe('tick 异常：留痕、不杀进程、不毒化链', () => {
    it('body 抛错 → lastTickLog 留痕 + warn，**不抛出**；下一次 tick 照常执行', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let calls = 0
      const { clock } = makeClock({
        logFrom: { prefix: '', lines: (v) => v },
        body: () => {
          calls += 1
          if (calls === 1) throw new Error('炸了')
          return ['ok']
        },
      })
      clock.start() // 第一次：抛错
      await settle()
      expect(clock.snapshot().lastTickLog?.[0]).toContain('tick 异常')
      expect(warn).toHaveBeenCalled()
      // 坏的 tick 没把时钟带下去：下一拍照跑
      timer!.fn()
      await settle()
      expect(calls).toBe(2)
      expect(clock.snapshot().lastTickLog).toEqual(['ok'])
    })

    it('body 返回 rejected Promise → 同上（异步异常同路径）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { clock } = makeClock({
        logFrom: { prefix: '', lines: (v) => v },
        body: () => Promise.reject(new Error('异步炸了')),
      })
      clock.start()
      await settle()
      expect(clock.snapshot().lastTickLog?.[0]).toContain('tick 异常')
      expect(warn).toHaveBeenCalled()
    })
  })

  describe('记账归属：bodyCountsTick 决定"谁来记 tick"（**既有语义差**，不是风格开关）', () => {
    it('缺省（false）→ 工厂在 body **完成后**记账（唤醒调度器语义）', async () => {
      let release: (() => void) | null = null
      const { clock } = makeClock({
        body: () => new Promise<string[]>((res) => { release = () => res(['done']) }),
      })
      clock.start()
      await settle()
      // body 还挂着 ⇒ 未完成 ⇒ 不计
      expect(clock.snapshot().ticks).toBe(0)
      release!()
      await settle()
      expect(clock.snapshot().ticks).toBe(1)
      expect(clock.snapshot().lastTickAt).not.toBeNull()
    })

    it('缺省（false）→ body 提前返回（"无目标可扫"）**也**照样记账（wake 既有行为）', async () => {
      const { clock } = makeClock({ body: () => [] })
      clock.start()
      await settle()
      expect(clock.snapshot().ticks).toBe(1)
    })

    it('bodyCountsTick=true → **工厂不记账**，由 body 决定（autopilot 语义：无目标则不计）', async () => {
      const { clock } = makeClock({
        bodyCountsTick: true,
        body: () => { /* body 故意不调 countTick：模拟"无 CCC 可扫" */ },
      })
      clock.start()
      await settle()
      expect(clock.snapshot().ticks).toBe(0) // 工厂没有擅自 +1
      expect(clock.snapshot().lastTickAt).toBeNull()
    })

    it('bodyCountsTick=true → body 调 countTick 才计，且可在 await 之前同步计（autopilot 的真实用法）', async () => {      let release: (() => void) | null = null
      const { clock } = makeClock({
        bodyCountsTick: true,
        body: () => {
          clock.countTick() // 枚举到目标之后、await 之前
          return new Promise<void>((res) => { release = () => res() })
        },
      })
      clock.start()
      await settle()
      expect(clock.snapshot().ticks).toBe(1) // body 未完成但已记账
      expect(clock.snapshot().lastTickAt).not.toBeNull()
      expect(release).not.toBeNull()
      release!()
      await settle()
      clock.dispose()
    })
  })

  describe('串行域独立 🔴（P2 与 P1 的**分界判据**）', () => {
    it('时钟 A 的 tick 长时间阻塞时，时钟 B 的 tick **仍按期推进**', async () => {
      // A：body 挂在一个永不自动 resolve 的 promise 上（模拟 autopilot 跑偏见脚本阻塞数十秒）
      let releaseA: (() => void) | null = null
      let aBodies = 0
      const a = createClock<void>({
        label: 'A（模拟 autopilot：慢）',
        ctx: undefined,
        gate: () => true,
        gateOffReason: 'x',
        countBeforeBody: true,
        body: () => {
          aBodies += 1
          return new Promise<void>((res) => { releaseA = () => res() })
        },
        startLog: () => 'A start',
      })
      // B：body 立即完成（模拟唤醒调度器：分钟级投递）
      let bBodies = 0
      const b = createClock<void>({
        label: 'B（模拟唤醒调度器：快）',
        ctx: undefined,
        gate: () => true,
        gateOffReason: 'x',
        body: () => { bBodies += 1 },
        startLog: () => 'B start',
      })

      // 各自武装（`setInterval` 被 mock；此处各自立即跑一次 tick ⇒ 两条链各挂一个在飞 body）
      a.start()
      b.start()
      await settle()
      expect(aBodies).toBe(1)
      expect(bBodies).toBe(1)

      // A 再排一拍 —— 它会被自己的在飞 body 挡住（**本钟串行**：这是 P2 仍保留的性质）
      const timerSpy = vi.mocked(global.setInterval)
      expect(timerSpy).toHaveBeenCalledTimes(2)
      // 从 mock 里拿回两条回调：最近一次是 B，上一次是 A
      // （断言顺序仅用于取回调；真正要证的是下面 B 的推进）
      const calls = timerSpy.mock.calls
      const fnA = calls[calls.length - 2]![0] as () => void
      const fnB = calls[calls.length - 1]![0] as () => void

      fnA() // A 的下一拍：被在飞 body 挡住 ⇒ aBodies 不变
      await settle()
      expect(aBodies).toBe(1) // 🔴 本钟串行：A 的第二拍确实被挡住了

      fnB() // 🔴 B 的下一拍：**不受 A 阻塞影响** ⇒ 照常推进
      await settle()
      expect(bBodies).toBe(2)

      // 收尾：放行 A，证明它之后恢复正常
      releaseA!()
      await settle()
      fnA()
      await settle()
      expect(aBodies).toBe(2)
    })

    it('两条时钟的实例状态零共享：复位 A 不影响 B', () => {
      const a = createClock({ label: 'A', ctx: undefined, gate: () => true, gateOffReason: 'x', body: () => [], startLog: () => '' })
      const b = createClock({ label: 'B', ctx: undefined, gate: () => true, gateOffReason: 'x', body: () => [], startLog: () => '' })
      a.start()
      b.start()
      expect(a.snapshot().armed).toBe(true)
      expect(b.snapshot().armed).toBe(true)
      a.reset()
      expect(a.snapshot().armed).toBe(false)
      expect(b.snapshot().armed).toBe(true) // 另一条不受影响
      b.reset()
    })
  })

  describe('拆卸：清定时器 + 复位进程态', () => {
    it('dispose() → clearInterval 被调用、armed/armedAt 复位', () => {
      const clear = vi.mocked(global.clearInterval)
      const { clock } = makeClock()
      clock.start()
      const armedAt = clock.snapshot().armedAt
      clock.dispose()
      expect(clear).toHaveBeenCalled()
      expect(timer).toBeNull()
      const st = clock.snapshot()
      expect(st.armed).toBe(false)
      expect(st.armedAt).toBeNull()
      expect(armedAt).not.toBeNull() // 拆卸前确实武装过（不是"从未武装"）
    })

    it('拆卸后再 start() 可重新武装（HMR / profile 重载路径）', () => {
      const { clock } = makeClock()
      clock.start()
      clock.dispose()
      clock.start()
      expect(clock.snapshot().armed).toBe(true)
      expect(timer).not.toBeNull()
      clock.dispose()
    })

    it('拆卸后在飞的 tick 不再投递（body 不再被跑）', async () => {
      let bodies = 0
      const { clock } = makeClock({ body: () => { bodies += 1 } })
      clock.start()
      await settle()
      expect(bodies).toBe(1)
      clock.dispose()
      // 陈旧引用（模拟已清掉但回调曾被捕获的路径）——拆卸后不该再跑业务
      expect(timer).toBeNull()
      expect(bodies).toBe(1)
    })

    it('dispose 会跑 onDispose（额外清理钩子，如 autopilot 的 per-CCC 守卫）', () => {
      let disposed = 0
      const { clock } = makeClock({ onDispose: () => { disposed += 1 } })
      clock.start()
      clock.dispose()
      expect(disposed).toBe(1)
    })

    it('reset 同时清定时器（否则重复 start() 会静默失效）', () => {
      const { clock } = makeClock()
      clock.start()
      expect(timer).not.toBeNull()
      clock.reset()
      expect(timer).toBeNull()
      expect(clock.snapshot().armed).toBe(false)
      clock.start() // 复位后必须能重新武装
      expect(timer).not.toBeNull()
      expect(clock.snapshot().armed).toBe(true)
      clock.dispose()
    })
  })

  describe('enqueue：在飞工作排到**本钟私有**链尾，且不毒化链', () => {
    it('多次 enqueue 按**入队顺序**依次执行（不是并发）', async () => {
      const order: number[] = []
      let release: (() => void) | null = null
      const { clock } = makeClock({ immediate: false })
      clock.enqueue(async () => {
        await new Promise<void>((res) => { release = () => res() })
        order.push(1)
      })
      clock.enqueue(() => { order.push(2) })
      await settle()
      expect(order).toEqual([]) // 第一件还挂着，第二件不得抢跑
      release!()
      await settle()
      expect(order).toEqual([1, 2])
    })

    it('某件工作抛错 → 记 warn 但不毒化链（后续 enqueue 照常执行）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const order: number[] = []
      const { clock } = makeClock({ immediate: false })
      clock.enqueue(() => { throw new Error('坏任务') })
      clock.enqueue(() => { order.push(2) })
      await settle()
      expect(warn).toHaveBeenCalled()
      expect(order).toEqual([2])
    })

    it('enqueue 与 tick 共用同一条链（body 的在飞工作也挡住 enqueue）', async () => {
      const order: string[] = []
      let releaseTick: (() => void) | null = null
      const { clock } = makeClock({
        body: () => new Promise<string[]>((res) => {
          order.push('tick')
          releaseTick = () => res([])
        }),
      })
      clock.start() // 启动即 tick ⇒ 链上挂了在飞的 body
      await settle()
      clock.enqueue(() => { order.push('work') })
      await settle()
      expect(order).toEqual(['tick']) // work 排在 tick 之后
      releaseTick!()
      await settle()
      expect(order).toEqual(['tick', 'work'])
      clock.dispose()
    })
  })

  describe('事件接线：热启动触发面', () => {
    it('挂上两个事件；事件触发 start（幂等，不重复起定时器）', () => {
      const listeners: Record<string, Array<() => void>> = {}
      const spy = vi.mocked(global.setInterval)
      const { clock } = makeClock({
        ctx: { on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) } },
        events: ['session/created', 'serenity/settings-changed'],
      })
      clock.start()
      expect(Object.keys(listeners)).toEqual(['session/created', 'serenity/settings-changed'])
      expect(spy).toHaveBeenCalledTimes(1)
      for (const fn of listeners['session/created']!) fn()
      for (const fn of listeners['serenity/settings-changed']!) fn()
      expect(spy).toHaveBeenCalledTimes(1) // 幂等
      clock.dispose()
    })

    it('🔴 闸关时 start ⇒ **事件仍必须挂上**（否则面板开闸后热启动永久失联）', () => {
      gate = false
      const listeners: Record<string, Array<() => void>> = {}
      const { clock } = makeClock({
        ctx: { on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) } },
        events: ['session/created', 'serenity/settings-changed'],
      })
      clock.start() // 闸关 ⇒ 不武装
      expect(timer).toBeNull()
      // 🔴 关键：事件**已经挂上**了（旧实现把它放在函数末尾 ⇒ 闸关时走不到 ⇒ 永久失联）
      expect(Object.keys(listeners).sort()).toEqual(['serenity/settings-changed', 'session/created'])
      // 面板把闸打开 → 事件到达 → 热启动成功
      gate = true
      for (const fn of listeners['serenity/settings-changed']!) fn()
      expect(timer).not.toBeNull()
      expect(clock.snapshot().armed).toBe(true)
      clock.dispose()
    })

    it('事件只挂一次（start 被反复调用不重复注册监听器）', () => {
      const listeners: Record<string, Array<() => void>> = {}
      const { clock } = makeClock({
        ctx: { on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) } },
        events: ['session/created'],
      })
      clock.start()
      clock.start()
      for (const fn of listeners['session/created']!) fn()
      expect(listeners['session/created']).toHaveLength(1)
      clock.dispose()
    })

    it('宿主无 `on`（headless）→ 不抛错（启动时已 start 过一次）', () => {
      const { clock } = makeClock({ ctx: {}, events: ['session/created'] })
      expect(() => clock.start()).not.toThrow()
      expect(clock.snapshot().armed).toBe(true)
      clock.dispose()
    })

    it('闸关时 start 不武装 ⇒ 定时器不起（零资源占用）', () => {
      gate = false
      const { clock } = makeClock()
      clock.start()
      expect(timer).toBeNull()
      expect(clock.snapshot().armed).toBe(false)
    })
  })

  describe('同步前置阶段 begin（autopilot 的"ticks 必须同步定下来"）', () => {
    it('begin 在 tick 内**同步**执行：start() 返回时已记账，无需等 body/microtask', () => {
      const { clock } = makeClock({
        bodyCountsTick: true,
        begin: () => clock.countTick(),
        body: () => new Promise<void>(() => { /* 永不 resolve：模拟偏见脚本阻塞 */ }),
      })
      clock.start()
      // 🔴 关键：没有 await，断言此刻就读得到（旧 autopilot 正是这个语义）
      expect(clock.snapshot().ticks).toBe(1)
      expect(clock.snapshot().lastTickAt).not.toBeNull()
    })

    it('begin 可以只留痕不计数（"无目标"那一拍：ticks 不动 + skipReason 立刻可读）', () => {
      const { clock } = makeClock({
        bodyCountsTick: true,
        begin: () => clock.noteSkipReason('无目标（begin 判定）'),
        body: () => undefined,
      })
      clock.start()
      expect(clock.snapshot().ticks).toBe(0) // 未计数
      expect(clock.snapshot().lastSkipReason).toBe('无目标（begin 判定）') // 同步可读
    })

    it('闸关时 begin **不**执行（闸是引擎的责任，早于一切业务）', () => {
      gate = false
      let begun = 0
      const { clock } = makeClock({
        begin: () => { begun += 1 },
      })
      clock.start()
      expect(begun).toBe(0)
    })

    it('begin 抛错**不杀进程**（与 body 同等兜底）：记 warn + 本拍作废，时钟继续在跑', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let bodies = 0
      const { clock } = makeClock({
        begin: () => { throw new Error('begin 炸了') },
        body: () => { bodies += 1 },
      })
      expect(() => clock.start()).not.toThrow()
      expect(warn).toHaveBeenCalled()
      expect(bodies).toBe(0) // 本拍作废：不投递
      expect(clock.snapshot().armed).toBe(true) // 但时钟仍在跑
      // 下一拍可选：把 begin 换成正常的再走一拍，证明链没断
      await settle()
      clock.dispose()
    })
  })

  describe('日志与跳过留痕', () => {
    it('logFrom 缺省 ⇒ 无 lastTickLog 字段（autopilot 无此字段）', () => {
      const { clock } = makeClock({ body: () => [] })
      expect('lastTickLog' in clock.snapshot()).toBe(false)
    })

    it('logFrom 给了 ⇒ 每 tick 用**本 tick 的新数组替换**（不是追加）', async () => {
      let n = 0
      const { clock } = makeClock({
        logFrom: { prefix: '', lines: () => [`第${++n}拍`] },
        body: () => [],
      })
      clock.start()
      await settle()
      expect(clock.snapshot().lastTickLog).toEqual(['第1拍'])
      timer!.fn()
      await settle()
      expect(clock.snapshot().lastTickLog).toEqual(['第2拍']) // 替换而非 ['第1拍','第2拍']
    })

    it('noteSkipReason 由 body 写回（"没有可扫目标"是 body 才知道的事）', async () => {
      const { clock } = makeClock({ body: () => { clock.noteSkipReason('无目标可扫（测试）'); return [] } })
      clock.start()
      await settle()
      expect(clock.snapshot().lastSkipReason).toBe('无目标可扫（测试）')
      // 引擎自己的闸文案与 body 的文案互不覆盖（各写各的路径）
      gate = false
      timer!.fn()
      expect(clock.snapshot().lastSkipReason).toBe('闸关（测试）')
    })
  })

  /**
   * 🔴 2026-11-02 §A3「**跳拍而非排队**」——**节律 60s 的硬前提**（owner 令，见执行清单 §A）。
   *
   * 这三个用例合起来才构成判据：**M2 变异红（跳拍确实在跳）＋ A4 不记账（跳拍不污染时间基准）
   * ＋ 正控（不弄坏时照常跑）**。只做前两个会漏掉"钟被自己的跳拍逻辑永久停掉"这种形态。
   */
  describe('§A3 跳拍而非排队（上一拍在飞 ⇒ 本拍直接丢，不入链）', () => {
    /** 造一个"卡住直到手动放行"的 body，并暴露放行句柄 */
    function makeBlockingClock(over: Partial<ClockOptions<string[]>> = {}) {
      let release: (() => void) | null = null
      let bodies = 0
      const { clock } = makeClock({
        body: () => {
          bodies += 1
          return new Promise<string[]>((res) => {
            release = () => res([])
          })
        },
        ...over,
      })
      return { clock, release: () => release?.(), bodies: () => bodies }
    }

    it('🔴 M2 判据：上拍在飞时走一拍 ⇒ 那一拍**被丢弃**（放行后 body 不会补跑）', async () => {
      const { clock, release, bodies } = makeBlockingClock({ logFrom: { prefix: '', lines: () => [] } })
      clock.start()
      await settle()
      expect(bodies()).toBe(1) // 启动即跑了一拍，正卡着

      timer!.fn() // 节拍到点，但上一拍还没完
      await settle()
      // ⚠️ 此处**不可**断言 bodies()===1 —— 排队语义下那一拍也只是"还没轮到自己"，
      //    两种语义在这一刻**读数相同**（这正是我第一版变异检验漏掉的那一格：
      //    它两种语义下都绿 ⇒ 没有判别力，D222 同族的假正控）。
      // ⇒ 判别点必须在**放行之后**：排队的那一拍此时才轮到它。
      release()
      await settle()
      // 🔴 跳拍 ⇒ 被丢的那一拍**永远不补跑**（bodies 停在 1）；
      //    排队 ⇒ 放行后立刻补跑（bodies = 2）。这一格才分得开两种语义。
      expect(bodies()).toBe(1)
    })

    it('🔴 A4 判据：跳拍**不调用 countTick** ⇒ `ticks` 不涨（它是所有 CRO 判据的时间基准）', async () => {
      const { clock, release } = makeBlockingClock({ logFrom: { prefix: '', lines: () => [] } })
      clock.start()
      await settle()
      const ticksWhileRunning = clock.snapshot().ticks
      expect(ticksWhileRunning).toBe(0) // 第一拍还没完，未记账

      timer!.fn() // 跳掉
      timer!.fn() // 再跳掉
      await settle()
      // 🔴 若跳拍走了 countTick，这里会虚高 ⇒ `guard` 的"刚启动窗口=第2~3拍"会被静默改语义
      expect(clock.snapshot().ticks).toBe(ticksWhileRunning)

      // 放行后紧接着的一拍**照常记账**（不是"永远不记"）
      release()
      await settle()
      expect(clock.snapshot().ticks).toBe(1)
    })

    it('🔴 正控：**不弄坏则照常跑** —— 每拍都短时，连续三拍 body 各被调用一次、ticks=3', async () => {
      const { clock } = makeClock({ body: () => [], logFrom: { prefix: '', lines: () => [] } })
      clock.start()
      await settle()
      timer!.fn()
      await settle()
      timer!.fn()
      await settle()
      // 正控的意义：证明"跳拍"没有把正常路径也一起跳掉（过宽缺陷）
      expect(clock.snapshot().ticks).toBe(3)
    })

    it('🔴 跳拍必须**出声**：写一行带读数（在飞时长 ＋ 累计跳过拍数），且清位后恢复', async () => {
      const { clock, release, bodies } = makeBlockingClock()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      clock.start()
      await settle()
      timer!.fn()
      await settle()
      const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes('跳拍'))
      expect(line).toBeDefined()
      // 带读数：只说"跳了一拍"无法区分"钟在追"与"钟卡死了"
      expect(line).toContain('累计跳过 1 拍')
      expect(line).toContain('已跑')
      release()
      await settle()
      // 🔴 清位生效的判据 = **body 又被调用了**（不是 ticks 涨 —— 本钟 body 每一次都阻塞，
      //    ticks 只在 body resolve 后记，用 ticks 判"恢复了"会把两种事混成一件）。
      expect(bodies()).toBe(1)
      const before = warn.mock.calls.length
      timer!.fn()
      await settle()
      expect(bodies()).toBe(2) // 不再是跳拍
      expect(warn.mock.calls.length).toBe(before) // 也没有新增的跳拍行
      release()
      await settle()
      expect(clock.snapshot().ticks).toBe(2) // 两拍都真跑完了
    })

    it('🔴 reset 清掉在飞标记 ⇒ 重置后不会**永久跳拍**（与"钟没起来"同读数的静默失效）', async () => {
      const { clock, release, bodies } = makeBlockingClock()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      clock.start()
      await settle()
      expect(bodies()).toBe(1) // 在飞
      clock.reset() // 在飞时重置 ⇒ 若无清位，此后每拍都会被判"上一拍仍在飞"而永久跳掉
      release() // 放行重置前那一拍，让本钟私有的链排空
      await settle()
      clock.start() // 复位后重新武装（reset 已清定时器）
      await settle()
      // 🔴 判据 = body 又被调用（= 没在跳拍）。若 tickPending 残留，这里是 1 且 ticks 恒 0
      expect(bodies()).toBe(2)
      const skipLines = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('跳拍'))
      expect(skipLines).toHaveLength(0)
      release()
      await settle()
      expect(clock.snapshot().ticks).toBeGreaterThan(0)
      clock.dispose()
    })
  })
})
