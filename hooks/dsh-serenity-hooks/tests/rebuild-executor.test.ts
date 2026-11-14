/**
 * rebuild-executor.test.ts — 超限重建的**执行面与失败面**（⑤ 第 22 件）
 *
 * 挑靶依据 = **分支覆盖率**（`trajectory/rebuild.ts` 68.75%，已退役/已满的靶之外最低）。
 * 靶的性质 = **破坏性能力**（清空对话历史 ＋ 自动继续）⇒ 本件刻意只测**失败与边界**，
 * 而既有 `tests/rebuild.test.ts` 已覆盖顺利路径（排队 → replace → steer 自动继续）。
 *
 * 🔴 **本件补的正是"出错时用户看到什么"**：
 *   · `queueRebuild` 的两道门 ⇒ **会话定位失败**（可能已关闭）＋（v1.49.0 起）**已退役的总闸残留值不得再拦**
 *   · 会话名的**回落派生**（无内存活跃信息 ⇒ 由 mdPath 目录名派生）＋ 非 `S###` 目录名 ⇒ 绑定行**不编造 S 号**
 *   · turn 钩子：**无 agent** ／ **陈旧队列超 TTL**（丢弃 ＋ 记 `ttl-dropped`）／
 *     **meter 三态**（缺失退化 ／ 有 `estimateMessage` ⇒ 真走 shadow-price 包装 ／ 有服务但无该方法 ⇒ 同样退化）
 *   · **surface 空 / 只剩系统提示节点**（⇒ 记 `empty-surface`，不 replace）
 *   · **宿主拒绝 replace**（⇒ 记 `failed` ＋ warn，**不打断 turn**）
 *   · **诊断写盘失败**（⇒ 吞掉，**rebuild 主流程照跑**）
 *   · **重建后重命名三态**（成功 ／ 服务不可用 ⇒ 跳过 ／ 抛错 ⇒ warn 不阻断）
 *   · **诊断根回落**（agent 无 `header.cwd` ⇒ `?? process.cwd()`；⚠️ 用 spy 钉住，绝不写进真仓库）
 *
 * 🔵 **纪律**：① 断言取**诊断文件的内容**（`.rebuild-diag.json`）＝ 用户/agent 能看到的那一面，
 * 而不是"函数返回了什么"；② 破坏性动作的判据是**盘上／队列状态**；③ 时间敏感用例用
 * `vi.useFakeTimers()` ＋ `setSystemTime`（TTL 是 10 分钟，不能真等）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
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
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import { queueRebuild, registerRebuildTurnHook, pendingRebuildSnapshot, buildRebuildAnchor, performRebuild, resolveSessionMdPath } from '../src/trajectory/rebuild.js'
import { readLastBound, appendBound } from '../src/trajectory/bound.js'
import { resetActiveSessionStore, setActiveSessionInfo } from '../src/trajectory/core.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'

let dir: string
let altRoot: string | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-rebuildexec-'))
  altRoot = null
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
  __setSimpleSourceForTest(null) // 恢复默认源（v1.49.0 起超限重建无总闸，默认即"恒开"）
})

afterEach(() => {
  __setSimpleSourceForTest(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetActiveSessionStore()
  rmSync(dir, { recursive: true, force: true })
  if (altRoot) {
    rmSync(altRoot, { recursive: true, force: true })
    altRoot = null
  }
})

// ── 夹具（与 tests/rebuild.test.ts 同形状；此处按需加"可注入故障"） ────────────────

/**
 * 🔴 D172（2026-10-20）：**每条夹具会话必须有唯一 id**。
 *
 * 旧写法所有实例都硬编码 `header.id = 'session-x'`，而新不变量是
 * 「一个会话终身只属于一条认知轨迹」（`claimBinding` 的 `SESSION_TAKEN`）⇒
 * 同一用例里第二个 `queueFor` 的绑定会被**正当地拒绝**，随后 `resolveSessionMdPath`
 * 回落到第一个目录 ⇒ 症状是「rename 拿到了别人的目录名」。
 *
 * ⚠️ 这不是夹具"抄错了"，而是**夹具不像真实会话**：真实 dsh 会话 id 天然互不相同。
 * 🔵 判据：凡"一个会话只能绑一条轨迹"这类**跨实例**不变量，夹具必须让实例真的可区分，
 *    否则不变量要么测不到、要么以别的形态炸在远处。
 */
let fakeSessionSeq = 0
function fakeSession(nodes: number[], opts: { appendThrows?: boolean; events?: unknown[] } = {}) {
  const calls: Array<{ type: string; data: unknown; opts: unknown }> = []
  fakeSessionSeq += 1
  return {
    header: { id: `session-x-${fakeSessionSeq}`, cwd: dir },
    surface: { nodes, replaceGeneration: 0 },
    ...(opts.events ? { events: opts.events } : {}),
    append: (type: string, data: unknown, o?: unknown) => {
      if (opts.appendThrows === true) throw new Error('surface replace rejected by host')
      calls.push({ type, data, opts: o })
      return { type, data, opts: o }
    },
    _calls: calls,
  }
}

/** `withCwd:false` ⇒ session 无 header ⇒ 覆盖诊断根的 `?? process.cwd()` 回落 */
function fakeAgent(id: string, session: { header?: unknown } & Record<string, unknown>, opts: { withCwd?: boolean } = {}) {
  const steers: unknown[] = []
  const s = opts.withCwd === false ? { ...session, header: undefined } : session
  return {
    id,
    session: s,
    steer: (m: unknown) => { steers.push(m) },
    _steers: steers,
  }
}

function mkSessionDir(dirName: string): string {
  const md = join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md')
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, `# SESSION ${dirName}`)
  return md
}

function bindSession(session: unknown, mdPath: string): void {
  appendBound(session, 'activate', { dirName: basename(dirname(mdPath)), mdPath })
}

function qctx(session: unknown): never {
  return { sessions: { get: () => session } } as never
}

/** 只提供 `on` 与 `get`（`hostService` 走 `ctx.get` ⇒ 服务有无由 services 决定） */
function hookCtx(services: Record<string, unknown> = {}) {
  const listeners: Array<(p: unknown) => void> = []
  const ctx = {
    on: (name: string, fn: (p: unknown) => void) => {
      if (name === 'agent/turn-stopping') listeners.push(fn)
    },
    get: (name: string) => services[name],
  }
  registerRebuildTurnHook(ctx as never)
  return { listeners, fire: (p: unknown) => listeners[0]!(p), ctx }
}

function readDiag(root = dir): { lastEvent: string; lastSessionId: string; queueCount: number; rebuiltCount: number; droppedCount: number; failedCount: number; detail?: string } {
  return JSON.parse(readFileSync(join(root, 'AGENT_SESSIONS', '.rebuild-diag.json'), 'utf-8'))
}

/** 标准排队（绑定 ⇒ 可解析 SESSION） */
async function queueFor(session: unknown, o: { summary?: string; dirName?: string } = {}): Promise<void> {
  const md = mkSessionDir(o.dirName ?? '2026-08-28--S200--exec')
  bindSession(session, md)
  await queueRebuild(qctx(session), { root: dir, summary: o.summary ?? 'exec 重建', agentCwd: dir, dshSessionId: 's1' })
}

// ── queueRebuild 的两道门 ＋ 会话名回落 ─────────────────────────────────────────

describe('rebuild-executor：queueRebuild 的门与回落', () => {
  it('🔴 v1.49.0 砍闸回归钉：旧配置残留 `rebuildEnabled=false` ⇒ **照样排队**（该键已砍、静默忽略）', async () => {
    // owner 2026-09-26 裁决：超限重建总开关已砍掉 ⇒ 旧配置里的残留值**不得再拦下 rebuild**。
    // 同族先例 = `wakeSchedulerEnabled`（2026-09-21 砍掉，旧键静默忽略）。
    const staleSource = (): ReturnType<typeof defaultSimpleSettings> =>
      ({ ...defaultSimpleSettings(), rebuildEnabled: false }) as unknown as ReturnType<typeof defaultSimpleSettings>
    __setSimpleSourceForTest(staleSource)
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-08-28--S200-retired-switch')
    bindSession(session, md)

    await queueRebuild(qctx(session), { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 's1' })
    expect(pendingRebuildSnapshot().size).toBe(1) // 队列被写入 —— 不再有"总闸"这一道门
  })

  it('会话定位失败（可能已关闭）⇒ 抛错说明是哪个 id，不静默', async () => {
    await expect(
      queueRebuild({ sessions: { get: () => undefined } } as never, { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 'gone-1' }),
    ).rejects.toThrow(/Unable to locate dsh session gone-1/)
  })

  it('会话名的两态：**无**内存活跃信息 ⇒ 由目录名派生（非 `S###` 则不编造编号）；**有** ⇒ 直接用活跃会话名', async () => {
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-08-28--no-id-here')
    bindSession(session, md)
    const r = await queueRebuild(qctx(session), { root: dir, summary: '匿名轨迹', agentCwd: dir, dshSessionId: 's1' })

    expect(r.queued).toBe(true)
    expect(r.sessionMdPath).toBe(md)
    const bound = readLastBound(session)
    expect(bound?.action).toBe('rebuild')
    // 🔴 D172：`sessionId` 现在是 **dsh 会话 id**（硬锚，必有）；展示码搬到了 `sessionId2`。
    // 旧断言 `sessionId` 未定义，测的是"目录名不含 S### ⇒ 不编造展示码"——
    // 那条语义仍然成立，但**落点变了**：判据在 `sessionId2` 上。
    expect(bound?.sessionId).toBe(session.header.id) // 硬锚 = 会话 id，不是展示码
    // 展示码 = `parseTrajectoryCode` 的产物（剥掉日期前缀后的首段，无 `--` 则取整段剩余）
    // ⇒ `2026-08-28--no-id-here` → `no-id-here`。**这套派生与编号编造无关**：它只是"能从目录名读到什么"。
    expect(bound?.sessionId2).toBe('no-id-here')
    expect(bound?.note).toBe('rebuild queued')

    // ② 有内存活跃信息 ⇒ 走 `?.sessionId` 的**左侧**（生产常态：`cognitive_trajectory use` 之后重启重建）
    setActiveSessionInfo('s1', { sessionId: 'S777', dirName: '2026-08-28--no-id-here', mdPath: md })
    const r2 = await queueRebuild(qctx(session), { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 's1' })
    expect(r2.queued).toBe(true)
    expect(r2.anchor).toContain('S777') // 锚点里的会话名来自活跃存储，不是目录名
    // 🔴 D172 **一处真实的语义变化**（不是凑数）：绑定记录里的展示码现在**由目录名派生**
    // （`toRecord` → `cognitiveTrajectoryLabel(dirName)`），**不再取自内存活跃存储**。
    //
    // 为什么可以且更对：展示码是**目录名的结构**（D165：「`code` 留给结构」）⇒ 从目录派生 = 单真相源；
    // 而本用例的 `S777` 与目录名 `2026-08-28--no-id-here` **本来就是矛盾的**（夹具刻意造的错配，
    // 生产里 `use` 写活跃存储的 `sessionId` 正是 `extractSessionId(dirName)`，两者天然一致）。
    // ⇒ 错配时以**目录**为准；锚点仍用活跃存储（那是"这次重建叫它什么"的运行时事实，两件事分开）。
    expect(readLastBound(session)?.sessionId2).toBe('no-id-here')
  })
})

// ── v1.136.0：LOG 轮转挂在 rebuild 路径上（owner 2026-11-15 令） ─────────────────
//
// 判据的来源：原型（S142 的 PROMPT.md 纪律）**验证过效果**，但它是 soft 的 ⇒
// 失效形态 = 「agent 忘了轮转、LOG 无限长、代数不增、**且无信号**」。
// 升级到 ACC 层的全部意义 = **忘不忘都一样** ⇒ 本组钉的正是"从 rebuild 走一遍就会轮转"。
//
// 🔴 另一条判据（D23 同族：失败不构成阻断）：
// 轮转失败**不得**让 rebuild 不排队 —— 用秩序换可用性是反方向。

describe('rebuild-executor：LOG 轮转的接线（v1.136.0）', () => {
  function writeLog(mdPath: string, text: string): void {
    const d = join(dirname(mdPath), 'LOG')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'LOG.md'), text, 'utf-8')
  }

  function frozenLogs(mdPath: string): string[] {
    const d = join(dirname(mdPath), 'LOG')
    // ⚠️ `existsSync` 对"是个文件"也返回 true ⇒ 必须真 catch（W3 的夹具刻意让 LOG 是文件）
    try {
      return readdirSync(d).filter((n) => n.startsWith('LOG-')).sort()
    } catch {
      return []
    }
  }

  it('W1 rebuild 排队 ⇒ 当前代被冻结、新代出生（**走 queueRebuild，不是直接调 rotate**）', async () => {
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-11-15--S200--log-rotate')
    writeLog(md, '# LOG — generation 1\n\n- 有真内容\n')
    bindSession(session, md)

    await queueRebuild(qctx(session), { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 's1' })

    const frozen = frozenLogs(md)
    expect(frozen).toHaveLength(1) // 轮转真的发生了
    expect(frozen[0]).toMatch(/^LOG-\d{4}-\d{2}-\d{2}T\d{4}\.md$/)
    // 新代存在且**非空**（下一个人打开不是白板）
    const live = join(dirname(md), 'LOG', 'LOG.md')
    expect(existsSync(live)).toBe(true)
    expect(statSync(live).size).toBeGreaterThan(0)
    // 归档件保留原内容（⛔ 不是被"新代"顶掉）
    expect(readFileSync(join(dirname(md), 'LOG', frozen[0]!), 'utf-8')).toContain('有真内容')
  })

  it('W2 没有 LOG 目录 ⇒ 轮转是空操作，**rebuild 照常排队**（⛔ 不为没有日志的轨迹造假归档）', async () => {
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-11-15--S200--no-log')
    bindSession(session, md)

    const r = await queueRebuild(qctx(session), { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 's1' })
    expect(r.queued).toBe(true)
    expect(pendingRebuildSnapshot().has('s1')).toBe(true)
    expect(frozenLogs(md)).toHaveLength(0)
  })

  it('🔴 W3 轮转失败（LOG 位置被一个文件占住）⇒ **rebuild 不被阻断**，队列照写、绑定照记', async () => {
    const session = fakeSession([10, 11])
    const md = mkSessionDir('2026-11-15--S200--log-broken')
    // 让 `LOG` 是个**文件**而不是目录 ⇒ rotateCarrierLog 必抛 ENOTDIR
    writeFileSync(join(dirname(md), 'LOG'), 'not a directory', 'utf-8')
    bindSession(session, md)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = await queueRebuild(qctx(session), { root: dir, summary: 'x', agentCwd: dir, dshSessionId: 's1' })

    // 判据：主流程（排队 ＋ 绑定）一切正常 —— 这是 D157 的"只有成功才会产生的副作用"那一侧
    expect(r.queued).toBe(true)
    expect(pendingRebuildSnapshot().has('s1')).toBe(true)
    expect(r.sessionMdPath).toBe(md)

    // 🔴 且失败**被说出来**（⛔ 不静默）—— 静默的失败等于"看起来像没轮转"，下一个人无从发现
    expect(warn.mock.calls.some((c) => String(c[0]).includes('LOG 轮转未执行'))).toBe(true)
    // 仍然没有归档产物（不是"轮转成了"）
    expect(frozenLogs(md)).toHaveLength(0)
  })
})

// ── turn 钩子：入口守卫 ／ TTL ／ meter 三态 ─────────────────────────────────────

describe('rebuild-executor：turn-stopping 的守卫与 meter 三态', () => {
  it('payload 无 agent ⇒ 直接 return（不抛、不动队列）', async () => {
    const session = fakeSession([10, 11])
    await queueFor(session)
    const { fire } = hookCtx()
    expect(() => fire({})).not.toThrow()
    expect(pendingRebuildSnapshot().has('s1')).toBe(true) // 队列原样保留
    expect(session._calls).toHaveLength(0)
  })

  it('🔴 陈旧队列（超 10min TTL）⇒ 丢弃 ＋ 记 ttl-dropped ＋ **不 replace**', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T00:00:00+08:00'))
    const session = fakeSession([10, 11])
    await queueFor(session, { summary: 'ttl' })
    const { fire } = hookCtx()

    vi.setSystemTime(new Date('2026-09-25T00:20:00+08:00')) // +20min > TTL
    const before = readDiag() // 计数是进程级的 ⇒ 断言"增量"而不是绝对值（免用例顺序耦合）
    fire({ agent: fakeAgent('s1', session), turn: 1 })

    expect(session._calls).toHaveLength(0) // 绝不误清空
    expect(pendingRebuildSnapshot().has('s1')).toBe(false) // 队列已清（不留悬挂）
    const diag = readDiag()
    expect(diag.lastEvent).toBe('ttl-dropped')
    expect(diag.droppedCount).toBe(before.droppedCount + 1)
    expect(diag.detail).toContain('TTL')
  })

  it('meter 三态：无服务 ⇒ 退化（只 replace）／有 estimateMessage ⇒ **真走包装**（先 prune 定价）／有服务但无该方法 ⇒ 同样退化', async () => {
    const EVENTS = [
      undefined, undefined, undefined, undefined, undefined, // 0-4
      undefined, undefined, undefined, undefined, undefined, // 5-9
      undefined, // 10（node 0..10 无事件；node 11 才有被替换的消息）
      { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } } },
    ]
    // ① 无 tokenMeter
    const s1 = fakeSession([10, 11], { events: EVENTS })
    await queueFor(s1, { dirName: '2026-08-28--S201--meter-a' })
    hookCtx().fire({ agent: fakeAgent('s1', s1), turn: 1 })
    expect(s1._calls.map((c) => c.type)).toEqual(['user/message'])

    // ② 有 estimateMessage ⇒ 覆盖钩子里那个包装箭头（fstat-no）＋ shadow-price 真定价
    const s2 = fakeSession([10, 11], { events: EVENTS })
    await queueFor(s2, { dirName: '2026-08-28--S202--meter-b' })
    const estimate = vi.fn(() => 7)
    hookCtx({ tokenMeter: { estimateMessage: estimate } }).fire({ agent: fakeAgent('s1', s2), turn: 2 })
    expect(s2._calls.map((c) => c.type)).toEqual(['compaction/prune', 'user/message'])
    expect(estimate).toHaveBeenCalledTimes(1)
    expect((s2._calls[0]!.data as { shadowedTokenCount: number }).shadowedTokenCount).toBe(7)

    // ③ 有 tokenMeter 但 estimateMessage 不是函数 ⇒ 退化（不炸、不 append prune）
    const s3 = fakeSession([10, 11], { events: EVENTS })
    await queueFor(s3, { dirName: '2026-08-28--S203--meter-c' })
    hookCtx({ tokenMeter: { estimateMessage: 'nope' } }).fire({ agent: fakeAgent('s1', s3), turn: 3 })
    expect(s3._calls.map((c) => c.type)).toEqual(['user/message'])
  })
})

// ── surface 空 ／ 宿主拒绝 ／ 诊断写盘失败 ──────────────────────────────────────

describe('rebuild-executor：surface 与失败的诊断面', () => {
  it('surface 空 或**只剩系统提示节点** ⇒ 不 replace ＋ 记 empty-surface（两种形态）', async () => {
    // ① 完全空
    const empty = fakeSession([])
    await queueFor(empty, { dirName: '2026-08-28--S210--empty' })
    hookCtx().fire({ agent: fakeAgent('s1', empty), turn: 1 })
    expect(empty._calls).toHaveLength(0)
    expect(readDiag().lastEvent).toBe('empty-surface')

    // ② 只剩 node 0（系统提示，宿主保护 ⇒ 无历史可清）
    const onlySystem = fakeSession([10])
    await queueFor(onlySystem, { dirName: '2026-08-28--S211--onlysys' })
    hookCtx().fire({ agent: fakeAgent('s1', onlySystem), turn: 1 })
    expect(onlySystem._calls).toHaveLength(0)
    expect(readDiag().lastEvent).toBe('empty-surface')
  })

  it('🔴 宿主拒绝 replace（append 抛错）⇒ 记 failed ＋ warn ＋ **不打断 turn**；队列已清不留悬挂', async () => {
    const session = fakeSession([10, 11], { appendThrows: true })
    await queueFor(session, { dirName: '2026-08-28--S212--hostreject' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const before = readDiag() // 增量断言（计数进程级）
      expect(() => hookCtx().fire({ agent: fakeAgent('s1', session), turn: 1 })).not.toThrow()
      const diag = readDiag()
      expect(diag.lastEvent).toBe('failed')
      expect(diag.failedCount).toBe(before.failedCount + 1)
      expect(diag.detail).toContain('surface replace rejected')
      expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('cognitive_trajectory rebuild failed')
      expect(pendingRebuildSnapshot().has('s1')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('诊断**写盘失败** ⇒ 吞掉且 **rebuild 主流程照跑**（先排队 → 再破坏 AGENT_SESSIONS 目录）', async () => {
    const session = fakeSession([10, 11])
    await queueFor(session, { dirName: '2026-08-28--S213--diagfail' })
    // 真实故障形态：把 AGENT_SESSIONS 从目录换成**同名文件** ⇒ writeRebuildDiag 的 mkdirSync 必抛
    rmSync(join(dir, 'AGENT_SESSIONS'), { recursive: true, force: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS'), 'not a directory')

    const agent = fakeAgent('s1', session)
    expect(() => hookCtx().fire({ agent, turn: 1 })).not.toThrow()
    expect(session._calls.map((c) => c.type)).toEqual(['user/message']) // replace 照做
    expect(agent._steers).toHaveLength(1) // 自动继续照发
  })
})

// ── 重建后重命名三态 ─────────────────────────────────────────────────────────

describe('rebuild-executor：重建后重命名（三态，均不阻断重建）', () => {
  it('sessionTitle 可用 ⇒ rename 收到 (session, S###-日期-概括)；不可用 ⇒ 跳过；抛错 ⇒ warn 不阻断', async () => {
    // ① 可用
    const s1 = fakeSession([10, 11])
    await queueFor(s1, { summary: '阶段概括', dirName: '2026-08-28--S200--rename-ok' })
    const rename = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    hookCtx({ sessionTitle: { rename } }).fire({ agent: fakeAgent('s1', s1), turn: 1 })
    expect(rename).toHaveBeenCalledTimes(1)
    const [sessArg, title] = rename.mock.calls[0] as [unknown, string]
    expect(sessArg).toBe(s1) // 传的是真实 session 对象（不是拷贝）
    expect(title).toContain('S200')
    expect(title).toContain('阶段概括')
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('rebuild 后会话重命名')
    log.mockRestore()

    // ② 服务缺失 ⇒ 跳过（warn）但重建已完成
    const s2 = fakeSession([10, 11])
    await queueFor(s2, { dirName: '2026-08-28--S200--rename-skip' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a2 = fakeAgent('s1', s2)
    hookCtx({ sessionTitle: {} }).fire({ agent: a2, turn: 1 })
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('重命名跳过')
    expect(s2._calls.map((c) => c.type)).toEqual(['user/message'])
    expect(a2._steers).toHaveLength(1)
    warn.mockRestore()

    // ③ rename 抛错 ⇒ warn「不阻断」＋ 重建与自动继续都照做
    const s3 = fakeSession([10, 11])
    await queueFor(s3, { dirName: '2026-08-28--S200--rename-throw' })
    const warn3 = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a3 = fakeAgent('s1', s3)
    hookCtx({ sessionTitle: { rename: () => { throw new Error('rename boom') } } }).fire({ agent: a3, turn: 1 })
    expect(warn3.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('重命名失败（不阻断）')
    expect(s3._calls.map((c) => c.type)).toEqual(['user/message'])
    expect(a3._steers).toHaveLength(1)
    warn3.mockRestore()
  })
})

// ── 诊断根回落（⚠️ 用 spy 钉住，绝不写进真仓库） ────────────────────────────────

describe('rebuild-executor：诊断根的回落', () => {
  it('agent 无 `header.cwd` ⇒ 诊断回落到 `process.cwd()`（spy 钉在临时目录 ⇒ 真仓库零污染）', async () => {
    altRoot = mkdtempSync(join(tmpdir(), 'hooks-rebuildexec-cwd-'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(altRoot)

    const session = fakeSession([10, 11])
    await queueFor(session, { dirName: '2026-08-28--S200--nocwd' })
    const agent = fakeAgent('s1', session, { withCwd: false })
    hookCtx().fire({ agent, turn: 1 })

    expect(cwd).toHaveBeenCalled()
    const diag = readDiag(altRoot) // 落在回落根，而不是 CCC 夹具根
    expect(diag.lastEvent).toBe('rebuilt')
    // ⚠️ 计数是**进程级**的（`diagState` 模块单例，源码 P3 已注明"不可跨重启累加比较"）
    // ⇒ 同一进程内多个用例会累加，故此处只能断言"≥1"，不能断言"恰好 1"（那是用例顺序耦合）
    expect(diag.rebuiltCount).toBeGreaterThanOrEqual(1)
  })
})

// ── 第二片：锚点 ／ 定位 ／ 定价 ／ 重命名的残余分支（⑤ 第 23 件） ────────────────────

describe('rebuild 第二片：锚点/定位/定价/重命名的残余分支', () => {
  it('buildRebuildAnchor：mdPath **在根外** ⇒ 路径行直接用绝对路径（`startsWith(root)` 的 else 侧）', () => {
    const outsideMd = join(tmpdir(), 'elsewhere-x', 'SESSION.md')
    const anchor = buildRebuildAnchor(dir, 'S900', outsideMd, ['body'])
    expect(anchor).toContain(`SESSION.md path: ${outsideMd}`)
    // 正控：根内路径走 slice 侧（相对路径）——两条路必须产出**不同**形态，否则本用例读不出差别
    const insideMd = join(dir, 'AGENT_SESSIONS', '2026-01-01--S901--x', 'SESSION.md')
    expect(buildRebuildAnchor(dir, 'S901', insideMd, ['body'])).toContain('SESSION.md path: AGENT_SESSIONS/2026-01-01--S901--x/SESSION.md')
  })

  it('buildRebuildAnchor：**无激活会话名** ⇒ 通用指令 ＋ 会话行只写目录名（不写空名）', () => {
    const md = join(dir, 'AGENT_SESSIONS', '2026-01-01--S902--named', 'SESSION.md')
    const anchor = buildRebuildAnchor(dir, '', md, ['body'])
    expect(anchor).toContain('Continue the current work.')
    expect(anchor).not.toContain('Continue the work of .')
    expect(anchor).toContain('- Serenity session: 2026-01-01--S902--named') // 空名 ⇒ 只目录名，不带 "( )"
  })

  it('buildRebuildAnchor：会话目录 = `AGENT_SESSIONS` 本身 ⇒ **整行不输出**（sessionLine null）', () => {
    const anchor = buildRebuildAnchor(dir, 'S903', join(dir, 'AGENT_SESSIONS', 'SESSION.md'), ['body'])
    expect(anchor).not.toContain('- Serenity session:')
  })

  it('parseAnchorMdPath 的守卫与 `?? 空串` 回落（经 resolveSessionMdPath 的候选④）——三形态走守卫，另两形态走**真分支**（catch ／ 非 text 内容项）', () => {
    // ① 事件存在但取不出 message ⇒ `!message` 守卫 ⇒ 候选全空 ⇒ null
    const s1 = fakeSession([0])
    ;(s1 as { events?: unknown[] }).events = [{ type: 'user/message' }]
    expect(resolveSessionMdPath(dir, 'scope-none', s1 as never)).toBeNull()

    // ② 有 content 但 text 块缺 `text` 字段 ⇒ `.text ?? ''` 回落 ⇒ 文本为空 ⇒ null
    const s2 = fakeSession([0])
    ;(s2 as { events?: unknown[] }).events = [{ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text' }] } } }]
    expect(resolveSessionMdPath(dir, 'scope-none', s2 as never)).toBeNull()

    // ③ message **无 content** ⇒ 可选链整体短路（`.join('')` 侧不炸）⇒ `?? ''` 回落 ⇒ null
    const s3 = fakeSession([0])
    ;(s3 as { events?: unknown[] }).events = [{ type: 'user/message', data: { message: { role: 'user' } } }]
    expect(resolveSessionMdPath(dir, 'scope-none', s3 as never)).toBeNull()

    // ④ 🔴 **真抛进 catch** 的形态：`content` 是**字符串**（非数组）⇒ `.map` 不是函数 ⇒ TypeError
    //    （判据 = 源码只写 `content?.map`，**无 Array.isArray 守卫** ⇒ 该 catch **可达**，不是死代码；
    //      三形态只走守卫、从不抛，故本形态专测「抛了也不炸、仍回落 null」）
    const s4 = fakeSession([0])
    ;(s4 as { events?: unknown[] }).events = [{ type: 'user/message', data: { message: { role: 'user', content: 'not-an-array' } } }]
    expect(resolveSessionMdPath(dir, 'scope-none', s4 as never)).toBeNull()

    // ⑤ 内容项**不是 text**（多模态：`{type:'image'}`）⇒ `.map` 的**三元 else 侧**（空串）
    //    —— ④ 与 ⑤ 各补掉一条**真分支**（都不是死代码：一个是异常兜底、一个是图片项）
    const s5 = fakeSession([0])
    ;(s5 as { events?: unknown[] }).events = [{ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'image', source: {} }] } } }]
    expect(resolveSessionMdPath(dir, 'scope-none', s5 as never)).toBeNull()
  })

  it('🔴 performRebuild：被替换 node **无对应事件** ⇒ `continue`（prune 仍 append，但**定价 0** 且 meter 不被调用）', () => {
    const session = fakeSession([10, 11])
    // node 11 无事件（events 只到 index 10）⇒ 命中 `if (!event) continue`
    ;(session as { events?: unknown[] }).events = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]
    const estimate = vi.fn(() => 7)
    const done = performRebuild(session as never, { anchor: 'x', queuedAt: Date.now() } as never, { estimateMessage: estimate })

    expect(done).toBe(true)
    expect(estimate).not.toHaveBeenCalled() // 🔴「prune 出现」≠「真定了价」——两者必须分开断言
    const prune = session._calls[0]!
    expect(prune.type).toBe('compaction/prune')
    expect((prune.data as { shadowedTokenCount: number }).shadowedTokenCount).toBe(0)
  })

  it('rename：无 `--S###--` 的目录名两种形态 —— 剥离日期前缀得 S 号则走 `S###-日期-概括`，否则**整名回退且概括被丢弃**', async () => {
    // ① 剥离后**不是** S### ⇒ `namingTitleFor` 回退**原始目录名**，summary 不进标题（契约既定：非 S### ⇒ 回退目录名）
    const s1 = fakeSession([10, 11])
    await queueFor(s1, { summary: '匿名阶段', dirName: '2026-08-30--no-session-id' })
    const rename1 = vi.fn()
    hookCtx({ sessionTitle: { rename: rename1 } }).fire({ agent: fakeAgent('s1', s1), turn: 1 })

    const t1 = String((rename1.mock.calls[0] as [unknown, string])[1])
    expect(t1).toBe('2026-08-30--no-session-id') // 逐字 = 目录名（日期前缀**没有**被剥掉：那条 replace 只喂 sessionId）
    expect(t1).not.toContain('匿名阶段') // 🔵 该回退路径**丢弃**概括——「编号派生」与「标题成形」是两段

    // ② 剥离后**是** S###（短目录名 `YYYY-MM-DD--S###`，无尾 `--`，故 `--S###--` 匹配不上）⇒ 走 S###-日期-概括
    const s2 = fakeSession([10, 11])
    await queueFor(s2, { summary: '匿名阶段', dirName: '2026-08-30--S123' })
    const rename2 = vi.fn()
    hookCtx({ sessionTitle: { rename: rename2 } }).fire({ agent: fakeAgent('s1', s2), turn: 1 })

    expect(String((rename2.mock.calls[0] as [unknown, string])[1])).toBe('S123-2026-08-30-匿名阶段')
  })

  it('两处 `?? error` 回落：抛**非 Error** 时仍报出内容（rename 与 rebuild 失败各一处）', async () => {
    // ① rename 抛非 Error（字符串）
    const s1 = fakeSession([10, 11])
    await queueFor(s1, { dirName: '2026-08-28--S220--nonerr-rename' })
    const warn1 = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hookCtx({ sessionTitle: { rename: () => { throw 'plain-string-err' } } }).fire({ agent: fakeAgent('s1', s1), turn: 1 })
    expect(warn1.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('plain-string-err')
    warn1.mockRestore()

    // ② rebuild 失败抛非 Error（对象）⇒ `String(error?.message ?? error)` ⇒ '[object Object]'
    const s2 = fakeSession([10, 11])
    ;(s2 as unknown as { append: () => never }).append = () => { throw { code: 'E_FAIL' } }
    await queueFor(s2, { dirName: '2026-08-28--S221--nonerr-failed' })
    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hookCtx().fire({ agent: fakeAgent('s1', s2), turn: 1 })
    expect(readDiag().detail ?? '').toContain('object')
    expect(warn2.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('rebuild failed')
    warn2.mockRestore()
  })

  it('turn 缺失 ⇒ 成功日志回落 `(turn ? ended)`（宿主不带 turn 的事件）', async () => {
    const session = fakeSession([10, 11])
    await queueFor(session, { dirName: '2026-08-28--S222--noturn' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    hookCtx().fire({ agent: fakeAgent('s1', session) }) // 不传 turn
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('(turn ? ended)')
    log.mockRestore()
  })
})
