/**
 * lifecycle-branches.test.ts — `seams/lifecycle.ts` 的**吞异常分支面**（⑤ 第 45 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `seams/lifecycle.ts` = 分支 **71.42%（20/28）**，是 `src/**` 中**最低的未被做过**的文件
 * （`diag-ops` 43 件、`compact` 44 件已做完）。语句 87.2%（109/125）。
 *
 * ── 🔴 为何这 8 处从未被走过（本件的核心发现）──────────────────────────────
 * 未覆盖的 8 处**全是 `catch` 块**，而本模块的**设计约束原文**是：
 *
 *   > 清理与拆卸**一律吞掉异常**——生命周期回调里抛错会影响宿主的销毁流程
 *   > （`src/seams/lifecycle.ts` 文件头 :17-18）
 *
 * ⇒ **这条被写进文件头、当作设计承诺的约束，从来没有被执行过。**
 *   若其中任何一处写坏（例如误改成 `throw`、或吞掉了却漏掉后续清理），
 *   **没有任何测试会红** —— 这正是"声明—现实一致"（I7）意义上的静默缺口。
 *
 * 逐处清单（源码行 = 本件写作时的锚）：
 *   L1 :45  `unregisterTrajectorySession` 抛
 *   L2 :50  `clearActiveSessionInfo` 抛
 *   L3 :56  `forgetManualOutputSession` 抛
 *   L4 :62  `forgetImBridgeVisibility` 抛
 *   L5 :68  `forgetExclusiveToolsVisibility` 抛
 *   L6 :74  `forgetLogbookCompactionState` 抛
 *   L9 :111 `stopAllFaces` 抛（**且 `stopAllBridges` 仍须执行**）
 *   L10 :117 `stopAllBridges` 抛
 *   （L7/L8 = `ctx.on` 抛 —— 既有 `lifecycle.test.ts:137` 已覆盖，本件不重复）
 *
 * ── 本件测的不是"没抛"，而是**两条更强的语义**──────────────────────────────
 *   ① **独立性**：`cleanupSessionState` 的六步清理中**任一步抛错，其余各步仍须全部执行**
 *      （这是"吞异常"的真实价值——不是"别崩"，而是"别互相拖累"）。
 *   ② **同理性**：`disposeAll` 里 `stopAllFaces` 抛错时，`stopAllBridges` **仍须被调用**
 *      （端口漏关比"少关一个轮询器"严重，但两者都不该因对方失败而丧失）。
 *   ⇒ 只断言"不抛"的测试是**弱**的：它无法区分"吞掉后继续"与"吞掉后中断"。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：本文件第一条即"六步全成功"的 happy path，
 *    证明 mock 装配不瞎，之后"抛错时其它步仍跑"才有意义。
 *  · **真故障形态注入**：让被调方**真抛**（不用 spy 空转）。
 *  · `it()` 标题内不用直引号（用「」）。
 *  · 红色即停：先分诊"被测对象失败 vs 脚手架失败"，**不要顺着假设改测试**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 与既有 lifecycle.test.ts 同款 mock（依赖链经 trajectory-session 引宿主 peerDep）
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})

// ── 🔴 把六个被调方换成"可注入抛错"的桩 ──────────────────────────────────────
// 用 importActual 保留其余真实实现，只替换这六个 —— 这样被测模块 lifecycle.ts
// 的**真实代码路径**仍在跑（不是把 lifecycle 整体 mock 掉）。
const calls: string[] = []
const throwSet = new Set<string>()

vi.mock('../../src/trajectory/session.js', async (orig) => {
  const actual = await orig<typeof import('../../src/trajectory/session.js')>()
  return {
    ...actual,
    unregisterTrajectorySession: (id: string) => {
      calls.push('unregisterTrajectorySession')
      if (throwSet.has('unregisterTrajectorySession')) throw new Error('boom: 轨迹约束')
      return actual.unregisterTrajectorySession(id)
    },
  }
})

vi.mock('../../src/trajectory/core.js', async (orig) => {
  const actual = await orig<typeof import('../../src/trajectory/core.js')>()
  return {
    ...actual,
    clearActiveSessionInfo: (id: string) => {
      calls.push('clearActiveSessionInfo')
      if (throwSet.has('clearActiveSessionInfo')) throw new Error('boom: active')
      return actual.clearActiveSessionInfo(id)
    },
  }
})

vi.mock('../../src/im/guard.js', async (orig) => {
  const actual = await orig<typeof import('../../src/im/guard.js')>()
  return {
    ...actual,
    forgetManualOutputSession: (id: string) => {
      calls.push('forgetManualOutputSession')
      if (throwSet.has('forgetManualOutputSession')) throw new Error('boom: manual-output')
      return actual.forgetManualOutputSession(id)
    },
  }
})

vi.mock('../../src/seams/guards.js', async (orig) => {
  const actual = await orig<typeof import('../../src/seams/guards.js')>()
  return {
    ...actual,
    forgetImBridgeVisibility: (id: string) => {
      calls.push('forgetImBridgeVisibility')
      if (throwSet.has('forgetImBridgeVisibility')) throw new Error('boom: im-bridge')
      return actual.forgetImBridgeVisibility(id)
    },
    forgetExclusiveToolsVisibility: (id: string) => {
      calls.push('forgetExclusiveToolsVisibility')
      if (throwSet.has('forgetExclusiveToolsVisibility')) throw new Error('boom: exclusive')
      return actual.forgetExclusiveToolsVisibility(id)
    },
  }
})

vi.mock('../../src/seams/cognitive-trajectory-lifecycle.js', async (orig) => {
  const actual = await orig<typeof import('../../src/seams/cognitive-trajectory-lifecycle.js')>()
  return {
    ...actual,
    forgetLogbookCompactionState: (id: string) => {
      calls.push('forgetLogbookCompactionState')
      if (throwSet.has('forgetLogbookCompactionState')) throw new Error('boom: keeper')
      return actual.forgetLogbookCompactionState(id)
    },
  }
})

vi.mock('../../src/surface/faces.js', async (orig) => {
  const actual = await orig<typeof import('../../src/surface/faces.js')>()
  return {
    ...actual,
    stopAllFaces: () => {
      calls.push('stopAllFaces')
      if (throwSet.has('stopAllFaces')) throw new Error('boom: faces')
      return actual.stopAllFaces()
    },
  }
})

vi.mock('../../src/im/bridge.js', async (orig) => {
  const actual = await orig<typeof import('../../src/im/bridge.js')>()
  return {
    ...actual,
    stopAllBridges: () => {
      calls.push('stopAllBridges')
      if (throwSet.has('stopAllBridges')) throw new Error('boom: bridges')
      return actual.stopAllBridges()
    },
  }
})

import { cleanupSessionState } from '../../src/seams/lifecycle.js'
import { registerLifecycle } from '../../src/seams/lifecycle.js'

/** 六步清理的名字（顺序与源码一致；本件用它做"全部执行"的判据） */
const SIX_STEPS = [
  'unregisterTrajectorySession',
  'clearActiveSessionInfo',
  'forgetManualOutputSession',
  'forgetImBridgeVisibility',
  'forgetExclusiveToolsVisibility',
  'forgetLogbookCompactionState',
] as const

beforeEach(() => {
  calls.length = 0
  throwSet.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lifecycle 吞异常面: cleanupSessionState 的六步（L1~L6）', () => {
  // ── 🔵 夹具正控（累积纪律 10）───────────────────────────────────────────
  it('【夹具正控】六步全成功 ⇒ 六个被调方**都被调到**（证明 mock 装配不瞎）', () => {
    cleanupSessionState('s-ok')
    expect(calls).toEqual([...SIX_STEPS])
  })

  // ── 逐处：某一步抛 ⇒ 吞掉，且**其余各步仍全部执行** ──────────────────────

  it('L1 `unregisterTrajectorySession` 抛 ⇒ 吞掉，其余五步仍全跑', () => {
    throwSet.add('unregisterTrajectorySession')
    expect(() => cleanupSessionState('s-l1')).not.toThrow()
    expect(calls).toEqual([...SIX_STEPS])
  })

  it('L2 `clearActiveSessionInfo` 抛 ⇒ 吞掉，其余五步仍全跑', () => {
    throwSet.add('clearActiveSessionInfo')
    expect(() => cleanupSessionState('s-l2')).not.toThrow()
    expect(calls).toEqual([...SIX_STEPS])
  })

  it('L3 `forgetManualOutputSession` 抛 ⇒ 吞掉，其余五步仍全跑', () => {
    throwSet.add('forgetManualOutputSession')
    expect(() => cleanupSessionState('s-l3')).not.toThrow()
    expect(calls).toEqual([...SIX_STEPS])
  })

  it('L4 `forgetImBridgeVisibility` 抛 ⇒ 吞掉，其余五步仍全跑', () => {
    throwSet.add('forgetImBridgeVisibility')
    expect(() => cleanupSessionState('s-l4')).not.toThrow()
    expect(calls).toEqual([...SIX_STEPS])
  })

  it('L5 `forgetExclusiveToolsVisibility` 抛 ⇒ 吞掉，其余五步仍全跑', () => {
    throwSet.add('forgetExclusiveToolsVisibility')
    expect(() => cleanupSessionState('s-l5')).not.toThrow()
    expect(calls).toEqual([...SIX_STEPS])
  })

  it('L6 `forgetLogbookCompactionState` 抛 ⇒ 吞掉（**它是最后一步**，无后续可验）', () => {
    throwSet.add('forgetLogbookCompactionState')
    expect(() => cleanupSessionState('s-l6')).not.toThrow()
    expect(calls).toEqual([...SIX_STEPS])
  })

  it('🔴 六步**同时**抛 ⇒ 仍然六步全被调到（独立性最强的形态）', () => {
    for (const s of SIX_STEPS) throwSet.add(s)
    expect(() => cleanupSessionState('s-all-throw')).not.toThrow()
    // 判据 = 六步都进过；若某步吞掉了却**中断**了后续，这里会短
    expect(calls).toEqual([...SIX_STEPS])
  })
})

describe('lifecycle 吞异常面: disposeAll 的两个停止（L9/L10）', () => {
  /** 取 `registerLifecycle` 登记的那个 disposer（经 `ctx.effect` 回调） */
  function disposerOf(): () => void {
    let disposer: (() => void) | null = null
    const ctx = {
      on: () => () => {},
      effect: (cb: () => () => void) => {
        disposer = cb()
      },
    }
    registerLifecycle(ctx as never)
    if (!disposer) throw new Error('未能取到 disposer（装配未发生）')
    return disposer
  }

  it('【夹具正控】两个停止函数**都**被调到（证明 disposer 取用正确）', () => {
    disposerOf()()
    expect(calls).toEqual(['stopAllFaces', 'stopAllBridges'])
  })

  it('L9 `stopAllFaces` 抛 ⇒ 吞掉，但 `stopAllBridges` **仍被执行**', () => {
    throwSet.add('stopAllFaces')
    const d = disposerOf()
    expect(() => d()).not.toThrow()
    // 🔴 本用例的真正判据：端口面失败**不得**拖累轮询器面的清理
    expect(calls).toContain('stopAllBridges')
    expect(calls).toEqual(['stopAllFaces', 'stopAllBridges'])
  })

  it('L10 `stopAllBridges` 抛 ⇒ 吞掉，且 `stopAllFaces` 早已执行', () => {
    throwSet.add('stopAllBridges')
    const d = disposerOf()
    expect(() => d()).not.toThrow()
    expect(calls).toEqual(['stopAllFaces', 'stopAllBridges'])
  })

  it('🔴 两个都抛 ⇒ 不冒泡到调用方（宿主销毁流程不受影响）', () => {
    throwSet.add('stopAllFaces')
    throwSet.add('stopAllBridges')
    const d = disposerOf()
    expect(() => d()).not.toThrow()
    expect(calls).toEqual(['stopAllFaces', 'stopAllBridges'])
  })
})
