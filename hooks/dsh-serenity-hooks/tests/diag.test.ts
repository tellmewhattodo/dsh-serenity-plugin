/**
 * diag.test.ts — 运行态诊断（原专属工具 `acc-diag`；v1.106.0 并入 `dashboard diag`）
 *
 * 覆盖两层：
 *  ① 装配：`runDiag`（live 运行态 + 唤醒时钟 + **CRO 已启用** + 唤醒注册表**未来/已过期分列**；失败不吞）
 *  ② 渲染：`renderDiag`（四段齐、空段显式说明"无"、已退场段落不得复活）
 *
 * 可见性（`tools.restrict`）不在本文件覆盖——它属拦截缝，见 `guards.test.ts`。
 *
 * ── v1.106.0 变更（owner 2026-11-01 裁「方案 C」＋「exclusive 机制整体删」）──────────
 * · **删除**：`readExclusiveTools` 判据组（机制已不存在）、工具面组（`createAccDiagTool` 已删）。
 *   ⚠️ 这两组**整组删除，不改为 skip** —— 判据消灭了，留着 skip 会让下一个人以为"以后要补上"。
 * · **新增**：CRO 段（owner 要"看见哪些轨迹挂了 CRO"）与唤醒注册表两分组
 *   （过去的不看 ⇒ `at > now` 单独成组；**已过期但仍在办**另列一组，两者的病情不同）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))

import { runDiag, renderDiag } from '../src/tools/diag/service.js'
import { CRO_FILENAME } from '../src/cro/core.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diag-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 最小 fake ctx：live 会话清单 + 无 agent（诊断必须容得下"定位不到"） */
function fakeCtx(liveSessions: Array<{ id: string; cwd: string | null }> = []): unknown {
  return {
    get: () => undefined,
    sessions: {
      list: () => liveSessions.map((s) => ({ id: s.id, header: { cwd: s.cwd }, events: [] })),
    },
  }
}

/** 写一条唤醒注册表（条目形状照 `wake/registry.ts` 的 `WakeEntry`） */
function writeWakes(entries: unknown[]): void {
  writeFileSync(
    join(dir, 'AGENT_SESSIONS', 'wake-registry.json'),
    JSON.stringify({ version: 1, entries }),
  )
}

function wake(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'w-x',
    target: 'S142',
    at: '2026-09-14T10:00:00Z',
    message: 'm',
    state: 'pending',
    createdBy: 'S142',
    createdAt: '2026-09-14T09:00:00Z',
    attempts: 0,
    ...over,
  }
}

describe('diag: runDiag 装配 + 渲染', () => {
  it('注册表条目被聚合（state / at / target / lastResult / createdBy / attempts）', async () => {
    writeWakes([
      wake({ id: 'w-1', target: 'S142', at: '2026-09-14T10:00:00Z', state: 'pending' }),
      wake({
        id: 'w-2',
        target: 'S151',
        at: '2026-09-14T09:00:00Z',
        state: 'delivered',
        createdBy: 'S112',
        attempts: 1,
        lastResult: '已投递 S151（live(bound session-x)）',
      }),
    ])
    // nowMs 钉在两条之间 ⇒ w-1 属"未来"、w-2 属"已过期"（这正是两分组要分开的东西）
    const now = Date.parse('2026-09-14T09:30:00Z')
    const r = await runDiag(fakeCtx() as never, dir, now)
    expect(r.ccc).toBe(dir)
    expect(r.wakes.error).toBeNull()
    expect(r.wakes.pending).toBe(1)
    expect(r.wakes.future.map((e) => e.id)).toEqual(['w-1'])
    expect(r.wakes.overdue.map((e) => e.id)).toEqual(['w-2'])
    expect(r.wakes.overdue[0]!.lastResult).toContain('live(bound')

    const text = renderDiag(r)
    expect(text).toContain('ACC 运行态诊断')
    expect(text).toContain('① live 运行态')
    expect(text).toContain('③ 唤醒注册表')
    expect(text).toContain('w-1 [pending]')
    expect(text).toContain('补跑窗口 2h')
    // 🔒 已退场的两段不得复活：② 面板解析 / ④ 唤起条件链（主语随 ACC autopilot 消失）
    expect(text).not.toContain('② 面板解析')
    expect(text).not.toContain('④ 唤起条件链')
    expect(text).not.toContain('自主轨迹唤起诊断')
  })

  it('无 live 会话 / 无在办条目：空段显式说明"无"（不得让人误读为"沉默 = 一切正常"）', async () => {
    const r = await runDiag(fakeCtx([]) as never, dir)
    const text = renderDiag(r)
    expect(text).toContain('live 会话: 0 个')
    // 🔴 2026-09-19（§0Q 甲案）：③ 段只列**在办项**（终态结案即清除）
    expect(text).toContain('── ③ 唤醒注册表')
    expect(text).toContain('已结案条目即时清除')
    // v1.106.0：两个分组各自的"无"都要出现（不能只写一个"无"让人以为两组都空）
    expect(text).toContain('（无）')
  })

  it('live 会话列出 id / cwd / CCC 归属', async () => {
    const r = await runDiag(fakeCtx([{ id: 'session-a', cwd: dir }]) as never, dir)
    expect(r.live.liveSessions).toHaveLength(1)
    expect(renderDiag(r)).toContain('session-a')
  })

  it('①b 段报告唤醒时钟的武装状态（"为何没有 tick" 的第一手判据）', async () => {
    const r = await runDiag(fakeCtx() as never, dir)
    const text = renderDiag(r)
    expect(r.clocks.wake).toHaveProperty('armed')
    expect(r.clocks.wake).toHaveProperty('enabled')
    expect(text).toContain('唤醒调度器（wake-registry tick）')
    expect(text).toContain('armed=')
    expect(text).toContain('上次 tick=')
    // 🔒 autopilot 时钟已随机制退场（回归钉：报告里不得再有第二座钟）
    expect(Object.keys(r.clocks)).toEqual(['wake'])
    expect(text).not.toContain('autopilot 时钟')
  })
})

describe('diag: ② CRO 已启用轨迹（owner 2026-11-01 要求）', () => {
  it('目录里有 continuous-re-occurrence.ts ⇒ 列出该轨迹', async () => {
    const traj = join(dir, 'AGENT_SESSIONS', '2026-01-01--S900--cro')
    mkdirSync(traj, { recursive: true })
    writeFileSync(join(traj, CRO_FILENAME), '// cro')
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.cro).toEqual(['2026-01-01--S900--cro'])
    expect(renderDiag(r)).toContain('2026-01-01--S900--cro')
    expect(renderDiag(r)).toContain('② CRO 已启用轨迹')
  })

  it('无 CRO ⇒ 空数组，且渲染显式说明"无"（不是沉默）', async () => {
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.cro).toEqual([])
    expect(renderDiag(r)).toContain('没有轨迹启用 CRO')
  })

  it('🔴 `_` / `.` 前缀目录不算轨迹（系统与日志目录不得混进 CRO 清单）', async () => {
    // 正控：同一个文件放在正经轨迹名下**能**被列出（否则本用例可能只是"文件没写进去"）
    const real = join(dir, 'AGENT_SESSIONS', '2026-01-01--S901--real')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, CRO_FILENAME), '// cro')
    // 三个不该被算进去的
    for (const name of ['_archived', '_shared-knowledge', '.hidden']) {
      const d = join(dir, 'AGENT_SESSIONS', name)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, CRO_FILENAME), '// cro')
    }
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.cro).toEqual(['2026-01-01--S901--real'])
  })
})

describe('diag: ③ 唤醒注册表 —— 未来 / 已过期分列（owner「过去的不看」）', () => {
  it('🔴 两组的判据是 `at` 与报告时刻的比较，不是条目顺序', async () => {
    writeWakes([
      wake({ id: 'past-1', at: '2026-09-14T08:00:00Z' }),
      wake({ id: 'future-1', at: '2026-09-14T12:00:00Z' }),
      wake({ id: 'past-2', at: '2026-09-14T09:00:00Z' }),
    ])
    const now = Date.parse('2026-09-14T10:00:00Z')
    const r = await runDiag(fakeCtx() as never, dir, now)
    expect(r.wakes.future.map((e) => e.id)).toEqual(['future-1'])
    expect(r.wakes.overdue.map((e) => e.id).sort()).toEqual(['past-1', 'past-2'])
    const text = renderDiag(r)
    expect(text).toContain('未来（at > 报告时刻')
    expect(text).toContain('已过期但仍在办')
  })

  it('🔴 `at` 恰好等于报告时刻 ⇒ 归入"已过期"（不归"未来"：它已经该跑了）', async () => {
    writeWakes([wake({ id: 'edge', at: '2026-09-14T10:00:00Z' })])
    const now = Date.parse('2026-09-14T10:00:00Z')
    const r = await runDiag(fakeCtx() as never, dir, now)
    expect(r.wakes.future).toHaveLength(0)
    expect(r.wakes.overdue.map((e) => e.id)).toEqual(['edge'])
  })

  it('🔴 `at` 解析不出来（坏数据）⇒ 归入"已过期"，⛔ 不归"未来"', async () => {
    // 判据：坏数据归"该看的那组"比归"未来"安全 —— 后者会让人以为一切按计划
    writeWakes([wake({ id: 'bad', at: 'not-a-timestamp' })])
    const r = await runDiag(fakeCtx() as never, dir, Date.parse('2026-09-14T10:00:00Z'))
    expect(r.wakes.future).toHaveLength(0)
    expect(r.wakes.overdue.map((e) => e.id)).toEqual(['bad'])
  })

  it('🔴 注册表真写坏 ⇒ 显式告警，⛔ 不静默当作"无在办条目"', async () => {
    writeFileSync(join(dir, 'AGENT_SESSIONS', 'wake-registry.json'), '{ broken')
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.wakes.error).not.toBeNull()
    expect(renderDiag(r)).toContain('注册表读取问题')
  })

  it('注册表正常时不得出现该告警（防"永远告警"假绿）', async () => {
    writeWakes([])
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.wakes.error).toBeNull()
    expect(renderDiag(r)).not.toContain('注册表读取问题')
  })

  it('条目**缺** attempts 字段 ⇒ 报 0 而不是 undefined', async () => {
    // 原 diag-ops-branches B4；v1.106.0 并入本文件（判据不变，入口换成 runDiag）
    const e = wake({ id: 'w-noattempts', at: '2026-09-14T12:00:00Z' })
    delete e.attempts
    writeWakes([e])
    const r = await runDiag(fakeCtx() as never, dir, Date.parse('2026-09-14T10:00:00Z'))
    expect(r.wakes.future[0]!.attempts).toBe(0)
  })

  it('条目缺 lastResult ⇒ 为 null，且渲染不追加 lastResult 行', async () => {
    writeWakes([wake({ id: 'w-noresult', at: '2026-09-14T12:00:00Z' })])
    const r = await runDiag(fakeCtx() as never, dir, Date.parse('2026-09-14T10:00:00Z'))
    expect(r.wakes.future[0]!.lastResult).toBeNull()
    expect(renderDiag(r)).not.toContain('lastResult:')
  })
})

describe('diag: ⑤ 轨迹消息订阅读数（v1.107.0）', () => {
  it('从未发生投递 ⇒ 显式说明"还没有任何订阅投递发生"（⛔ 不是沉默）', async () => {
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.subscriptions).toEqual([])
    expect(renderDiag(r)).toContain('还没有任何订阅投递发生')
  })

  it('🔴 配置坏项必须显形（"配了但不生效"最容易被当成在工作）', async () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ trajectorySubscriptions: [{ watcher: '', members: ['A'] }] }),
    )
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.subscriptionProblems.length).toBeGreaterThan(0)
    const text = renderDiag(r)
    expect(text).toContain('配置坏项')
    expect(text).toContain('配了但不生效')
  })

  it('配置全好 ⇒ 不出现坏项段（防"永远告警"假绿）', async () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ trajectorySubscriptions: [{ watcher: 'W', members: ['A'] }] }),
    )
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.subscriptionProblems).toEqual([])
    expect(renderDiag(r)).not.toContain('配置坏项')
  })
})

describe('diag: 时钟渲染的三个可选段 + 归属缺失的回退文案', () => {
  // 原 diag-ops-branches B1/B2/B3/B5/B6；v1.106.0 并入本文件（判据不变，入口换成 runDiag）
  it('时钟从未武装 / 从未 tick ⇒ 渲染「（从未）」而不是崩溃或留空（B1）', async () => {
    // 本进程内调度器**未武装**（测试进程不 apply 插件）⇒ armedAt/lastTickAt 皆 null
    const r = await runDiag(fakeCtx() as never, dir)
    expect(r.clocks.wake.armedAt).toBeNull()
    const text = renderDiag(r)
    expect(text).toContain('（从未）')
  })

  it('未武装时不得出现「武装于=」，且「上次跳过」只在真有原因时出现（B2/B3 反侧）', async () => {
    const r = await runDiag(fakeCtx() as never, dir)
    const text = renderDiag(r)
    expect(text).not.toContain('武装于=')
    if (!r.clocks.wake.lastSkipReason) expect(text).not.toContain('上次跳过')
  })

  it('🔴 时钟**真武装**后 ⇒ 渲染出「武装于=」与「上次跳过:」（B2/B3 正侧）', async () => {
    // 正控：不真武装就没测到 B2/B3 —— 故这里真启动一次调度器（并确保拆卸）
    // `registerWakeScheduler(ctx)` 返回 void，拆卸经 `ctx.effect` 注册 ⇒ 假 ctx 自己收 disposer
    const { registerWakeScheduler, __resetWakeSchedulerStateForTest } = await import('../src/wake/scheduler.js')
    let cleanup: (() => void) | undefined
    const fakeHostCtx = {
      effect(fn: () => () => void) {
        cleanup = fn()
      },
    }
    try {
      registerWakeScheduler(fakeHostCtx)
      await new Promise((r) => setTimeout(r, 20))
      const r = await runDiag(fakeCtx() as never, dir)
      expect(r.clocks.wake.armedAt).not.toBeNull()
      const text = renderDiag(r)
      expect(text).toContain('武装于=')
      if (r.clocks.wake.lastSkipReason) expect(text).toContain('上次跳过:')
    } finally {
      cleanup?.()
      __resetWakeSchedulerStateForTest()
    }
  })

  it('会话 cwd 不在任何 CCC 内 ⇒ 渲染回退文案（B6）', async () => {
    const nonCcc = mkdtempSync(join(tmpdir(), 'not-a-ccc-'))
    try {
      const r = await runDiag(fakeCtx([{ id: 's-orphan', cwd: nonCcc }]) as never, dir)
      const s = r.live.liveSessions[0]!
      // 前置（正控）：确认确实处于"归属缺失"态，否则本用例没测到 B6
      expect(s.cccRoot ?? null).toBeNull()
      expect(renderDiag(r)).toContain('(非 CCC)')
    } finally {
      rmSync(nonCcc, { recursive: true, force: true })
    }
  })

  it('会话 cwd 为 null ⇒ cwd 回退为「(无)」（B6 的另一侧）', async () => {
    const r = await runDiag(fakeCtx([{ id: 's-nocwd', cwd: null }]) as never, dir)
    expect(r.live.liveSessions[0]!.cwd).toBeNull()
    expect(renderDiag(r)).toContain('cwd=(无)')
  })

  it('进程 CCC 行必须存在且可读（B5：要么是路径、要么那句显式文案）', async () => {
    // 🔴 这一行来自**进程真实 cwd**（`diagLive`），与传入的 `root` 无关 ⇒
    //    ⛔ 不能钉成 `dir`（测试进程的 cwd 是仓库，不是临时目录）。只能钉"语法两态皆可读"。
    const r = await runDiag(fakeCtx() as never, dir)
    const line = renderDiag(r).split('\n').find((l) => l.startsWith('进程 CCC:'))
    expect(line).toBeDefined()
    const value = line!.slice('进程 CCC:'.length).trim()
    expect(value.length).toBeGreaterThan(0)
    expect(value.includes('不在任何 CCC 内') || value.startsWith('/')).toBe(true)
  })
})
