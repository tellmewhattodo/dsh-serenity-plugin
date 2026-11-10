/**
 * browser-slot-service.test.ts — 槽位编排（acquire/release/list/nudge/doctor）
 *
 * 🔴 本文件最重要的不是"函数能跑"，而是 owner 要的那条**闭环**：
 *    槽位异常（长期不动 / CPU 过高）⇒ **反过来向占用它的会话注入一条消息**。
 *    ⇒ `nudgeStaleSlots` 的注入器是**可注入依赖**，这里用一个记录器替身验证：
 *      ① 该提醒的槽位**都**被提醒了；② 不该提醒的**一条都没**；③ 提醒文本带具体动作；
 *      ④ 提醒后记账（冷却生效，不会每 tick 刷屏）。
 *
 * ⚠️ **本文件会真起 Chrome**（`acquireSlot` 不 mock）—— 旧注释写的是"⛔ 不起真 Chrome"，
 * 那是**假的**，而正是这条错注释让 `afterEach` 只删目录不杀进程（详见下方 afterEach 的判据）。
 *
 * 🔴 v1.129.0：台账与 profile **全局化**（owner 令：20 个槽位所有 CCC 共用）。
 *    ⇒ 本文件用 `SERENITY_BROWSER_SLOTS_DIR` 把整个槽位家目录指到临时目录。
 *    ⚠️ 这不再是"可选隔离"，而是**唯一**隔离手段 —— 跑测试时绝不能碰真实的 `~/.dsh/serenity-browser-slots/`。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireSlot,
  assertSlotOwned,
  doctorSlots,
  listSlots,
  nudgeStaleSlots,
  reapSlot,
  releaseSlot,
  slotStatus,
  touchSlot,
} from '../src/browser/service.js'
import {
  clearSlotIdentity,
  destroySlot,
  findPidsByProfile,
  readSlotIdentity,
  slotPaths,
  writeSlotIdentity,
} from '../src/browser/process.js'
import { SLOTS_DIR_ENV } from '../src/browser/home.js'
import { readLedger, withLedger } from '../src/browser/ledger.js'
import { DEFAULT_POLICY, type SlotLease, type SlotPolicy } from '../src/browser/state.js'
import { slotPort } from '../src/browser/state.js'

/** 测试用的"CCC 根"：两个不同的值用来验跨 CCC 共享同一份台账 */
let root = ''
let home = ''
const savedEnv = process.env[SLOTS_DIR_ENV]
const SESS = 'sess-me'
const TRAJ = '2026-01-01--S999--demo'

/**
 * 🔴🔴 **本文件的 `afterEach` 曾经只删目录、不回收进程** —— 而那正是本机制要防的事。
 *
 * 2026-11-09 实测取证：跑完测试后 `ss -ltnp` 上留着一个 `chrome --user-data-dir=/tmp/slot-svc-xxx/…`
 * 监听 9304 达 3 分 27 秒。成因 = `acquireSlot` 是**真** spawn（本文件不 mock），
 * 而 `rmSync(root)` 只抹掉了台账和 profile 目录，**进程照样在跑**。
 *
 * 判据（这正是本次事故的核心）：**删掉记录 ≠ 杀掉进程**。归属消失之后，
 * 那个进程就再也没有任何东西能指向它 —— 于是无人能回收，也无人知道该回收。
 * ⇒ 收尾必须**先按 profile 认领真进程并杀掉，再删目录**；顺序反了就永久泄漏。
 */
const created: number[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slot-svc-root-'))
  home = mkdtempSync(join(tmpdir(), 'slot-svc-home-'))
  process.env[SLOTS_DIR_ENV] = home
})
afterEach(() => {
  // ① 先杀进程（按全局家下每个槽位的 profile 认领）
  for (const n of created.splice(0)) {
    destroySlot(n)
  }
  // ② 再删目录
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env[SLOTS_DIR_ENV]
  else process.env[SLOTS_DIR_ENV] = savedEnv
})

/** 直接往台账里塞一条占用（绕过 acquire，因为这里不 spawn Chrome） */
function seed(slot: number, over: Partial<SlotLease> = {}): void {
  withLedger((lg) => {
    lg.leases[String(slot)] = {
      slot,
      cccRoot: over.cccRoot ?? root,
      sessionId: over.sessionId ?? SESS,
      trajectory: over.trajectory ?? TRAJ,
      leasedAt: over.leasedAt ?? Date.now(),
      lastActionAt: over.lastActionAt ?? Date.now(),
      nudges: over.nudges ?? 0,
      lastNudgeAt: over.lastNudgeAt ?? 0,
      pid: over.pid ?? 0,
    }
    return { ledger: lg, result: null }
  })
}

describe('acquire：同会话复用，⛔ 不租第二个', () => {
  it('① 已有占用 ⇒ reused=true 且槽位号不变（这条防的是"租了忘退"的静默泄漏）', async () => {
    seed(4, { sessionId: SESS })
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ })
    // 🔴 复用路径也会 ensureRunning（真 spawn / 或复用已在跑的）⇒ 必须登记进回收清单
    if (res.ok) created.push(res.slot)
    expect(res.reused).toBe(true)
    expect(res.slot).toBe(4)
    // 负控：台账里仍然只有这一个槽位（没有新增第二个）
    expect(Object.keys(readLedger().leases)).toEqual(['4'])
  })

  it('② 指定一个已被别人占用的槽位 ⇒ 拒绝，⛔ 抢占', async () => {
    seed(2, { sessionId: 'other-session' })
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ, want: 2 })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('已被占用')
    // 台账未变：占着的人还是别人
    expect(readLedger().leases['2']?.sessionId).toBe('other-session')
  })

  it('③ 20 个槽位全满 ⇒ 拒绝，且**指出该查什么**（idleMin 最大的那一行）', async () => {
    for (let i = 1; i <= 20; i++) seed(i, { sessionId: `s${i}` })
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('20 个槽位已全部占用')
    expect(res.detail).toContain('release')
  })
})

describe('🔴 归属：台账 + identity.json 两处（owner 令「profile 里加点标识」）', () => {
  it('⑰ acquire 落账时**同时**写下 identity.json，内容与台账一致（不是"写了函数没接上"）', async () => {
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ })
    if (!res.ok) {
      // 环境无 Chrome ⇒ 这一格无从验，如实跳过而非假装通过
      expect(res.detail.length).toBeGreaterThan(0)
      return
    }
    created.push(res.slot)
    const ident = readSlotIdentity(res.slot)
    expect(ident).not.toBeNull()
    // 🔴 钉**赋值式**而不是"存在性"（D275）：字段逐个对读台账
    const lease = readLedger().leases[String(res.slot)]!
    expect(ident!.slot).toBe(res.slot)
    expect(ident!.label).toBe(`b${res.slot}`)
    expect(ident!.port).toBe(slotPort(res.slot))
    expect(ident!.cccRoot).toBe(lease.cccRoot)
    expect(ident!.sessionId).toBe(SESS)
    expect(ident!.trajectory).toBe(TRAJ)
    expect(ident!.writtenAt).toBeGreaterThan(0)
    // 负控：identity 必须落在**槽位目录内**（profile 侧），⛔ 不在 CCC 里
    expect(slotPaths(res.slot).identity.startsWith(home)).toBe(true)
  })

  it('⑱ release 后 identity 必须一起消失（留着会让"这个 profile 还有主"在读数上成立）', () => {
    seed(3, { sessionId: SESS })
    const identPath = slotPaths(3).identity
    // 🔴 **必须先真写一份 identity**：本格第一版跳过了这一步，于是"release 后文件不存在"
    //    对「根本没写过」也成立 ⇒ 变异检验（去掉 release 里的 clearSlotIdentity）
    //    **照样全绿**。这正是本仓反复踩的那一类（D254 同族：判据没有判别力）。
    //    ⇒ 判据必须从**非空初态**出发，且正控里先断言它真存在。
    writeSlotIdentity({
      slot: 3,
      label: 'b3',
      port: slotPort(3),
      cccRoot: root,
      sessionId: SESS,
      trajectory: TRAJ,
      leasedAt: Date.now(),
      writtenAt: 0,
    })
    expect(existsSync(identPath)).toBe(true) // 正控：起点非空

    const r = releaseSlot(root, SESS, 3)
    expect(r.ok).toBe(true)
    expect(readLedger().leases['3']).toBeUndefined()
    // 判据 = 副作用：identity 文件真没了（⛔ 只看返回值）
    expect(existsSync(identPath)).toBe(false)
  })

  it('⑲ reap 后 identity 同样消失（兜底回收也要收干净）', () => {
    seed(5, { sessionId: 'gone-session' })
    const identPath = slotPaths(5).identity
    writeSlotIdentity({
      slot: 5,
      label: 'b5',
      port: slotPort(5),
      cccRoot: root,
      sessionId: 'gone-session',
      trajectory: 'gone-traj',
      leasedAt: Date.now(),
      writtenAt: 0,
    })
    expect(existsSync(identPath)).toBe(true) // 正控：起点非空
    reapSlot(root, 5, '占用者已不在')
    expect(existsSync(identPath)).toBe(false)
  })

  it('⑳ doctor 把 identity 缺失**报出来**（恒空的读数器会与"一切正常"同形）', () => {
    seed(2, { sessionId: 'x', pid: 0 })
    const d = doctorSlots(root) as Record<string, unknown>
    const drift = d.identityDrift as string[]
    expect(drift.length).toBe(1)
    expect(drift[0]).toContain('identity.json 缺失')
    expect(d.verdict).toBe('drift')
    // 正控：补上 identity 之后必须回到 clean（证明上面那条不是恒红）
    const ident = {
      slot: 2,
      label: 'b2',
      port: slotPort(2),
      cccRoot: root,
      sessionId: 'x',
      trajectory: TRAJ,
      leasedAt: Date.now(),
      writtenAt: 0,
    }
    // 走生产写入口（⛔ 不手写文件 —— 手写会绕开原子写，测的就不是同一条路径）
    writeSlotIdentity(ident)
    expect((doctorSlots(root) as Record<string, unknown>).identityDrift).toEqual([])
    expect((doctorSlots(root) as Record<string, unknown>).verdict).toBe('clean')
  })
})

describe('release：只许释放自己的', () => {
  it('④ 释放别人的槽位 ⇒ 拒绝，且台账不变（否则"互相踩"会变成合法动作）', () => {
    seed(3, { sessionId: 'other-session' })
    const r = releaseSlot(root, SESS, 3)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('不属于你')
    expect(readLedger().leases['3']?.sessionId).toBe('other-session')
  })

  it('⑤ 释放自己的 ⇒ 记录消失', () => {
    seed(3, { sessionId: SESS })
    const r = releaseSlot(root, SESS, 3)
    expect(r.ok).toBe(true)
    expect(readLedger().leases['3']).toBeUndefined()
  })

  it('⑥ 释放一个本就空的槽位 ⇒ 视为成功且说明原因（⛔ 报错 —— 那不是错误）', () => {
    const r = releaseSlot(root, SESS, 7)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('本就无人占用')
  })
})

describe('reap：兜底回收（与 release 的区别 = 须记原因）', () => {
  it('⑦ 能回收别人占的槽位（这是兜底的意义），且台账清空', () => {
    seed(5, { sessionId: 'gone-session' })
    const r = reapSlot(root, 5, '占用者已不在')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('占用者已不在')
    expect(readLedger().leases['5']).toBeUndefined()
  })
})

describe('list / status：占用归属可读', () => {
  it('⑧ list 返回全部 20 个槽位（含空槽），占用者信息在位', () => {
    seed(9, { sessionId: 'abc', trajectory: 'traj-9' })
    const { views } = listSlots(root)
    expect(views.length).toBe(20)
    const v9 = views.find((v) => v.slot === 9)!
    expect(v9.state).not.toBe('free')
    expect(v9.sessionId).toBe('abc')
    expect(v9.trajectory).toBe('traj-9')
    // 负控：其它槽位必须是 free
    expect(views.filter((v) => v.state === 'free').length).toBe(19)
  })

  it('⑨ status 越界返回 null（⛔ 抛错）', () => {
    expect(slotStatus(root, 0)).toBeNull()
    expect(slotStatus(root, 21)).toBeNull()
    expect(slotStatus(root, 1)?.slot).toBe(1)
  })
})

describe('🔴 反向注入闭环（owner 要的那条）', () => {
  const fast: SlotPolicy = { ...DEFAULT_POLICY, idleMs: 60_000, nudgeCooldownMs: 60_000 }

  it('⑩ 闲置超阈值 ⇒ **向占用它的轨迹**注入一条提醒，文本写明具体动作', async () => {
    seed(1, { lastActionAt: Date.now() - 5 * 60_000, trajectory: TRAJ })
    const calls: Array<{ target: string; msg: string }> = []
    const out = await nudgeStaleSlots(
      root,
      async (_r, target, msg) => {
        calls.push({ target, msg })
        return { ok: true, detail: 'injected' }
      },
      fast,
    )
    expect(out.nudged.length).toBe(1)
    expect(calls.length).toBe(1)
    // 注入目标 = 占用者的轨迹（⛔ 不是"所有人"）
    expect(calls[0]!.target).toBe(TRAJ)
    // 文本必须带**可执行动作**，⛔ 只说"你的槽位异常了"
    expect(calls[0]!.msg).toContain('b1')
    expect(calls[0]!.msg).toContain('release')
    // 文本必须给出阈值（收到的人要知道自己越了哪条线）
    expect(calls[0]!.msg).toContain('CPU')
  })

  it('⑪ 状态正常 ⇒ 一条都不注入（负控：证明上面的命中不是恒真）', async () => {
    seed(1, { lastActionAt: Date.now() })
    const calls: string[] = []
    const out = await nudgeStaleSlots(
      root,
      async (_r, target) => {
        calls.push(target)
        return { ok: true, detail: 'ok' }
      },
      fast,
    )
    expect(out.nudged.length).toBe(0)
    expect(calls.length).toBe(0)
  })

  it('⑫ 提醒后记账 ⇒ 冷却期内不再重复注入（否则每 tick 叫一次，占用者会被淹没）', async () => {
    seed(1, { lastActionAt: Date.now() - 5 * 60_000, trajectory: TRAJ })
    let n = 0
    const inj = async (): Promise<{ ok: boolean; detail: string }> => {
      n += 1
      return { ok: true, detail: 'ok' }
    }
    await nudgeStaleSlots(root, inj, fast)
    expect(n).toBe(1)
    // 立刻再跑一轮 —— 冷却未过 ⇒ 不该再注入
    await nudgeStaleSlots(root, inj, fast)
    expect(n).toBe(1)
    expect(readLedger().leases['1']?.nudges).toBe(1)
  })

  it('⑬ 无归属的槽位 ⇒ 如实报"无法注入"，⛔ 静默跳过', async () => {
    seed(6, { lastActionAt: Date.now() - 5 * 60_000, sessionId: '', trajectory: '' })
    const out = await nudgeStaleSlots(root, async () => ({ ok: true, detail: 'ok' }), fast)
    expect(out.nudged.length).toBe(1)
    expect(out.nudged[0]!.delivered).toBe(false)
    expect(out.nudged[0]!.detail).toContain('无法注入')
  })
})

describe('页面层归属守卫（déjà vu：以前"给个端口就能操作"）', () => {
  it('㉑ 别人的槽位 ⇒ 硬拒（变异：去掉 assertSlotOwned ⇒ 这条必须红）', () => {
    seed(4, { sessionId: 'other-session' })
    expect(() => assertSlotOwned(root, 4, SESS)).toThrow('不是你租的')
    // 正控：自己的槽位不抛
    expect(() => assertSlotOwned(root, 4, 'other-session')).not.toThrow()
  })

  it('㉒ 空 sessionId ⇒ 同样拒绝（⛔ 有"信任本地"的放宽 —— 一放宽归属就退回成习惯）', () => {
    seed(4, { sessionId: 'other-session' })
    expect(() => assertSlotOwned(root, 4, '')).toThrow()
  })

  it('㉓ 无人占用的槽位 ⇒ 报"先 acquire"，且⛔ 自动替你租', () => {
    expect(() => assertSlotOwned(root, 8, SESS)).toThrow('无人占用')
    // 判据 = 副作用：台账里没有多出 b8
    expect(readLedger().leases['8']).toBeUndefined()
  })
})

describe('touchSlot 与 doctor', () => {
  it('⑭ touch 推进 lastActionAt（这是"是否长期不动作"的唯一判据来源）', () => {
    const old = Date.now() - 10 * 60_000
    seed(8, { lastActionAt: old })
    touchSlot(root, 8)
    expect(readLedger().leases['8']!.lastActionAt).toBeGreaterThan(old)
  })

  it('⑮ doctor 只读：不改任何台账，且 verdict 是 clean 或 drift 之一', () => {
    seed(2, { sessionId: 'x', pid: 0 })
    const before = JSON.stringify(readLedger().leases)
    const d = doctorSlots(root) as Record<string, unknown>
    expect(JSON.stringify(readLedger().leases)).toBe(before)
    expect(['clean', 'drift']).toContain(d.verdict as string)
    expect(d.ledger).toBeTruthy()
  })
})

describe('🔴 跨 CCC：20 个槽位共用一份台账（owner 2026-11-10 令）', () => {
  it('㉔ 两个不同 cccRoot 看到的是**同一批**租约（原实现每个 CCC 各一份 ⇒ 抢同一端口且无读数）', () => {
    const rootA = '/ccc/alpha'
    const rootB = '/ccc/beta'
    seed(1, { cccRoot: rootA, sessionId: 'sessA', trajectory: 'trajA' })
    // B 读到的 b1 必须**已被占**（不是空闲）
    const vB = slotStatus(rootB, 1)!
    expect(vB.state).not.toBe('free')
    expect(vB.sessionId).toBe('sessA')
    // 且 B 也租不到 b1
    const viewsB = listSlots(rootB).views
    expect(viewsB.filter((v) => v.state === 'free').length).toBe(19)
    // 🔴 正控（这条是判别力来源）：`root` 参数**确实传进了函数**，但它**不参与寻址**。
    //    变异方向 = 把 ledgerPath 改回 `join(root, …)` ⇒ 上面三条会立刻红。
    //    ⚠️ 单靠"两个 root 读到同一份"还不够：若实现把 root 整个忽略掉、永远读同一个路径，
    //      那也是"同一份"—— 所以必须再钉"写进去的 root 被如实记下来"。
    expect(readLedger().leases['1']?.cccRoot).toBe(rootA)
  })
})

/**
 * 🔴🔴 `⑯` 是本文件**唯一一条专门防"测试自己泄漏浏览器"**的判据。
 *
 * 为什么必须单独立一条：2026-11-09 实测，跑完本文件后 `ss -ltnp` 上留着一个
 * `chrome --user-data-dir=/tmp/slot-svc-xxx/…` 监听 9304 达 **3 分 27 秒**。
 * 成因不是"忘记写 afterEach"，而是 afterEach **写错了**——它只 `rmSync(root)` 删目录。
 *
 * 判据（本次事故的核心一句）：**删掉记录 ≠ 杀掉进程**。
 * 归属一消失，那个进程就再没有任何东西指向它 ⇒ 无人能回收、也无人知道该回收。
 * 这正是 owner 报的那件事的**同一个形状**，只是发生在测试里。
 *
 * ⚠️ 这条若写成"afterEach 里有 destroySlot 字样"就是**假绿**（D254：目录里有字 ≠ 它真的跑）。
 * 因此这里钉的是**副作用**：真起一个 → 真销毁 → **真去 `/proc` 查它不在了**。
 */
describe('🔴 测试自身的进程卫生（这条防的是本机制自己踩过的坑）', () => {
  it('⑯ destroySlot 之后，按 profile 认领**必须**一个 pid 都找不到（删记录 ≠ 杀进程）', async () => {
    const res = await acquireSlot({ root, sessionId: SESS, trajectory: TRAJ })
    // 没起得来（环境无 Chrome）⇒ 这一格无从验，如实跳过而非假装通过
    if (!res.ok) {
      expect(res.detail.length).toBeGreaterThan(0)
      return
    }
    const paths = slotPaths(res.slot)

    /**
     * 正控：起来之后按 profile 认领**必须**能抓到至少一个 pid。
     *
     * 🔴 这里原本是**一次性断言，会间歇假红**（2026-11-09 在 `coverage` 全量里实测：
     *    `expected 0 to be greater than 0`）。成因不是实现坏了，而是**时序**：
     *    `acquireSlot` 返回时只保证"spawn 已发起"，子进程的 `/proc/<pid>/cmdline`
     *    可能还没写全（或 exec 还没完成）⇒ 那一瞬间按 cmdline 认领**本来就可能扫不到**。
     *
     *    判据（比修法值钱）：**"扫不到进程"有两种成因，处置方向相反** ——
     *      · 还没启动（要等）  vs  · 已经死了（要清理）
     *    一次性读数是分不开这两者的 ⇒ 必须**轮询到一个稳定窗口**再下结论。
     *    ⚠️ 这恰好也是本机制对真实用户的同一条判据（`pid=0` 时不许判 orphaned）。
     */
    const deadline = Date.now() + 5_000
    let before: number[] = []
    while (Date.now() < deadline) {
      before = findPidsByProfile(paths.profile)
      if (before.length > 0) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(before.length).toBeGreaterThan(0)

    destroySlot(res.slot)

    // 判据 = 副作用（⛔ 不看返回值）：去 /proc 真查
    const after = findPidsByProfile(paths.profile)
    expect(after).toEqual([])
    // 且 pid 文件也清了（否则下一个 acquire 会拿一个死 pid 去判"已经死了"）
    expect(existsSync(paths.pidFile)).toBe(false)
    // profile 目录**保留**（登录态是槽位的资产，回收不丢登录态）
    expect(existsSync(paths.profile)).toBe(true)
    // 清账：identity 也不该留（这条与 ⑱ 互为独立读数）
    clearSlotIdentity(res.slot)
  })
})
