/**
 * browser-idle-kill.test.ts —— **闲置强关**（owner 2026-11-24 令）
 *
 * > 「闲置n分钟需要增强下 目前浏览器一直不关的现象严重，增加限制超过30分钟强行关闭
 * >  并注入提示申请的轨迹 这个行为」
 *
 * ## 这条需求的机制真相（我核代码核出来的，写在这里防止下一个人误读）
 *
 * 在此之前**不是没有闲置机制** —— 有闲置判定（15 min）、有提醒（冷却 20 min）、有升级文案。
 * 缺的是**后果**：`nudgeStaleSlots()` 的头注逐字写着「提醒**不代它释放**」。
 * ⇒ 所以"一直不关"是**设计上只劝不关**，⛔ 不是"忘性大"。
 *
 * ## 本组用例守的三道闸
 *
 * | # | 闸 | 少它会怎样 |
 * |---|---|---|
 * | ① | 闲置 ≥ `idleKillMs`（默认 30 min） | 阈值没生效 ⇒ 提前杀 |
 * | ② | 进程仍活着 | 把 orphaned 也当强关处理 ⇒ 两条处置路径打架 |
 * | ③ | **`nudges ≥ 1`（先提醒后强关）** | 🔴 **不公平**：刚拍到闲置就杀，而它可能一直在跑长任务没回来看 |
 *
 * 另两道：`idleKillMs = 0` ⇒ 永不强关；`holdUntil > now` ⇒ 保活期内不动。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_POLICY,
  shouldForceReap,
  forceReapText,
  HOLD_MAX_MINUTES,
  type SlotLease,
  type SlotProcReading,
} from '../src/browser/state.js'
import { createBrowserSlotTool } from '../src/tools/browser-slot/index.js'

const MIN = 60_000
const NOW = 1_700_000_000_000

function lease(over: Partial<SlotLease> = {}): SlotLease {
  return {
    slot: 3,
    sessionId: 'sess-1',
    trajectory: 'traj-a',
    cccRoot: '/ccc',
    leasedAt: NOW - 60 * MIN,
    lastActionAt: NOW - 20 * MIN,
    nudges: 1,
    lastNudgeAt: NOW - 10 * MIN,
    pid: 12345,
    holdUntil: 0,
    ...over,
  }
}

const ALIVE: SlotProcReading = { alive: true, cpuPct: 1, rssMb: 100 }
const DEAD: SlotProcReading = { alive: false, cpuPct: 0, rssMb: 0 }

describe('shouldForceReap：五道闸逐条', () => {
  it('① 闲置 25 分钟（< 30）⇒ **不杀**', () => {
    expect(shouldForceReap(lease({ lastActionAt: NOW - 25 * MIN }), ALIVE, NOW)).toBeNull()
  })

  it('① 闲置 35 分钟 ⇒ **杀**，并报出闲置分钟数', () => {
    const v = shouldForceReap(lease({ lastActionAt: NOW - 35 * MIN }), ALIVE, NOW)
    expect(v).not.toBeNull()
    expect(v!.idleMin).toBe(35)
  })

  /**
   * 🔴 **本组最重要的一条**：先提醒、后强关。
   * 没有这道闸，一个正在跑 40 分钟长任务的会话会被"刚判到闲置就杀掉"。
   */
  it('③ `nudges = 0`（从未提醒过）⇒ 即使闲置 40 分钟也**不杀**', () => {
    expect(shouldForceReap(lease({ lastActionAt: NOW - 40 * MIN, nudges: 0 }), ALIVE, NOW)).toBeNull()
  })

  it('③ `nudges = 1` ⇒ 同条件下**杀**（证明红的是这道闸，不是别的）', () => {
    expect(shouldForceReap(lease({ lastActionAt: NOW - 40 * MIN, nudges: 1 }), ALIVE, NOW)).not.toBeNull()
  })

  it('② 进程已死（orphaned）⇒ **不走强关**（走既有 orphaned 处置）', () => {
    expect(shouldForceReap(lease({ lastActionAt: NOW - 40 * MIN }), DEAD, NOW)).toBeNull()
  })

  it('闸门：`idleKillMs = 0` ⇒ **永不强关**（owner 可整体关闭）', () => {
    const p = { ...DEFAULT_POLICY, idleKillMs: 0 }
    expect(shouldForceReap(lease({ lastActionAt: NOW - 999 * MIN }), ALIVE, NOW, p)).toBeNull()
  })

  it('闸门：保活期内（holdUntil 在未来）⇒ **不动**，但过期后立刻恢复判闲置', () => {
    const held = lease({ lastActionAt: NOW - 90 * MIN, holdUntil: NOW + 10 * MIN })
    expect(shouldForceReap(held, ALIVE, NOW)).toBeNull()
    // ✓ 正控：同一个租约，一旦 hold 过期 ⇒ 立刻该杀
    expect(shouldForceReap(held, ALIVE, NOW + 20 * MIN)).not.toBeNull()
  })

  it('无租约 ⇒ null（空槽没什么可杀）', () => {
    expect(shouldForceReap(null, ALIVE, NOW)).toBeNull()
  })

  /**
   * 🔴 策略可配：owner 裁的是 30 分钟，但阈值必须能调（不同机器 / 不同用法）。
   * 断言"改了阈值就按新阈值判"，⛔ 不是断言"等于 30"（那会把用例焊死在默认值上）。
   */
  it('阈值可配：`idleKillMs = 60min` ⇒ 闲置 40 分钟不杀、70 分钟才杀', () => {
    const p = { ...DEFAULT_POLICY, idleKillMs: 60 * MIN }
    expect(shouldForceReap(lease({ lastActionAt: NOW - 40 * MIN }), ALIVE, NOW, p)).toBeNull()
    expect(shouldForceReap(lease({ lastActionAt: NOW - 70 * MIN }), ALIVE, NOW, p)).not.toBeNull()
  })
})

describe('forceReapText：告知必须能让人行动', () => {
  it('三件事都得在：发生了什么／损失了什么／下次怎么办', () => {
    const t = forceReapText(3, 34, 1)
    expect(t).toContain('force-reclaimed')
    expect(t).toContain('34m')
    // ② 没损失什么 —— 这条最容易被漏，而它决定对方要不要重登
    expect(t).toContain('profile dir is kept')
    expect(t).toContain('without re-login')
    // ③ 下次怎么避免
    expect(t).toContain('browser_slot hold')
    // ③ 怎么继续
    expect(t).toContain('acquire')
  })

  it('🔴 不出现"槽位异常了"这类无法行动的话（异常 ≠ 可行动的指令）', () => {
    expect(forceReapText(3, 34, 1)).not.toContain('异常')
  })
})

describe('hold 上限', () => {
  it(`单次上限是 ${HOLD_MAX_MINUTES} 分钟（⛔ 不设成永久豁免，那会把强关架空）`, () => {
    expect(HOLD_MAX_MINUTES).toBe(240)
  })
})

describe('🔴 schema 层的键名冲突（本版真实翻过车）', () => {
  /**
   * 2026-11-24 实况：`hold` 初版把保活分钟数声明成 `for`，而 `wait` 早就占用了 `for`
   * （前缀字符串）。同一个 schema 对象里**两次声明同名键 ⇒ 后者覆盖前者** ⇒
   * `hold --for 60` 实际拿到的是 wait 的字符串 schema，数字被判非法。
   *
   * ⚠️ 为什么上面那些用例一条都没抓到：它们全是**纯函数**用例，从不构造工具。
   * 这正是本仓那条旧判据的现场 —— 「`defineTool` 创建即编译 ⇒ 必须有一条能构造出来的用例」。
   */
  function props(): Record<string, { type?: string }> {
    const tool = createBrowserSlotTool({} as never) as unknown as {
      parameters: { properties?: Record<string, { type?: string }> }
    }
    return tool.parameters.properties ?? {}
  }

  it('保活键名是 `holdFor`（number），而 `for` 仍属 wait（string）', () => {
    const p = props()
    expect(Object.keys(p)).toContain('holdFor')
    expect(p.holdFor?.type).toBe('number')
    // `for` 必须还在（wait 用它），且只能是字符串那一支
    expect(p.for?.type).toBe('string')
  })

  it('告知文案教的旗标必须是真能用的那个（⛔ 不教 `--for`）', () => {
    const t = forceReapText(3, 34, 1)
    expect(t).toContain('--holdFor')
    expect(t).not.toMatch(/--for\s*<分钟>/)
  })
})
