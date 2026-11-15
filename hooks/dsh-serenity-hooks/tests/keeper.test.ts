import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

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

import {
  KeeperTracker,
  scoreTool,
  reminderText,
  rebuildReminderText,
  readContextPressure,
  registerKeeper,
  cognitiveTrajectoryCompactionReminderText,
  readSessionMdMaxKB,
  readFileSize,
  resolveActiveSessionMdPath,
  compactionStateSnapshot,
  forgetLogbookCompactionState,
  __resetLogbookCompactionForTest,
  DEFAULT_SESSION_MD_MAX_KB,
  handoverReminderText,
} from '../src/seams/keeper.js'
import { unregisterTrajectorySession } from '../src/trajectory/session.js'
import { resetTrajectorySessions } from '../src/trajectory/policy/window.js'
import { make轨迹约束Session, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'
import { setActiveSessionInfo, clearActiveSessionInfo } from '../src/trajectory/core.js'

describe('keeper: 纯跟踪器', () => {
  it('计分表：write=3, task=10, read=1', () => {
    expect(scoreTool('write')).toBe(3)
    expect(scoreTool('task')).toBe(10)
    expect(scoreTool('read')).toBe(1)
    expect(scoreTool('unknown-tool')).toBe(0)
  })

  it('达到阈值触发提醒，ack 后清零', () => {
    let now = 0
    const t = new KeeperTracker(10, () => now)
    expect(t.step('write')).toBe(false) // 3
    expect(t.step('write')).toBe(false) // 6
    expect(t.step('write')).toBe(false) // 9
    expect(t.step('write')).toBe(true) // 12 ≥ 10
    const code = t.ack()
    expect(code).toBe('K1')
    expect(t.currentScore).toBe(0)
    expect(t.step('read')).toBe(false) // 1
  })

  it('经过时间计分：+1 分/分钟', () => {
    let now = 0
    const t = new KeeperTracker(5, () => now)
    t.step('read') // 1, now=0
    now = 120_000 // +2 分钟
    expect(t.step('read')).toBe(false) // 1+2+1 = 4
    now = 240_000
    expect(t.step('read')).toBe(true) // 4+2+1 = 7 ≥ 5
  })

  it('reminderText 含确认码（cognitive-trajectory-assistant checkpoint 前缀）', () => {
    expect(reminderText('K1')).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT-recorded-K1]')
    expect(reminderText('K1')).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(reminderText('K1')).not.toContain('SESSION-KEEPER')
    expect(reminderText('K1')).not.toContain('[TRAJECTORY-STEWARD]')
  })

  // 🔴 2026-09-16（S142 所有者指令，D64）：注入文本不得携带任何数值
  //
  // ⚠️ 判据边界（第一版写错过，留痕）：初版断言 `not.toContain('threshold')` **失败**——
  //    因为新文案自身用了 "reached the configured rebuild threshold" 这个词。
  //    失败的**不是实现**：禁令的对象是"**数值**"，不是"**词**"。
  //    word "threshold" 只为可读性而保留，它不透露任何量。
  //    ⇒ 断言只拒绝**数值形态**与旧版式（`Context usage at`），不拒绝词。
  it('reminderText 不再注入计分数值（D64：内部账目不进 LLM 上下文）', () => {
    const text = reminderText('K1')
    // 旧文案形态 = `Score threshold reached (150)`；新文案不得回显该计数
    expect(text).not.toContain('(150)')
    expect(text).not.toContain('reached (')
    // 确认协议不受影响（必须仍然可用——它是正常工作的前提）
    expect(text).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(text).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT-recorded-K1]')
  })
})

describe('交接提醒（HANDOVER）：rebuild ≡ reconstruct 共用一条注入（2026-11-16 裁定）', () => {
  it('普通档：一条注入，便签落点 = LOG/LOG.md 的 ## Handover note', () => {
    const text = handoverReminderText()
    expect(text).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
    // 唯一动作：写便签 → 调 rebuild（`--summary` 保留：标题命名要靠它）
    expect(text).toContain('LOG/LOG.md')
    expect(text).toContain('## Handover note')
    expect(text).toContain('cognitive_trajectory rebuild')
    expect(text).toContain('--summary')
    expect(text).toContain('≤20 chars')
    // 🔴 反向钉：⛔ 不得出现选路信息 —— 走哪条路是机械的账，会话不需要知道
    expect(text).not.toContain('reconstruct')
    expect(text).not.toContain('archive')
    // 🔴 反向钉：独立便签文件已退役
    expect(text).not.toContain('REBUILD-TODO')
    expect(text).not.toContain('create it if it does not exist')
  })

  it('升级档：同一 token、更强语气（⛔ 不换成第二个 token）', () => {
    const text = handoverReminderText(true)
    // 判据：升级的是**语气**，不是"出现了第二件事"
    expect(text).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
    expect(text).not.toContain('MANDATORY') // token 不再分档
    expect(text).toContain('STOP')
    expect(text).toContain('## Handover note')
    expect(text).toContain('cognitive_trajectory rebuild')
  })
})

describe('轨迹跟踪器：上下文压力读数（readContextPressure）', () => {
  // 2026-11-16：原「轨迹跟踪器」组的 `rebuildReminderText` 两条用例已删除 ——
  //   文案整体重写为 HANDOVER（rebuild ≡ reconstruct 共用），旧断言测的是旧文案的每一句
  //   （`ACT NOW` / `persistent body` / `REBUILD-TODO.md` / `LIMIT · MANDATORY`），
  //   保留它们等于用一个已不存在的契约定住实现。新契约定在上面的 HANDOVER 组。

  it('readContextPressure：sessionProjections 装配时读取投影', () => {
    const session = { id: 's1' }
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 9000, contextWindow: 10000 } } }) }
        : undefined,
    }
    const pressure = readContextPressure(ctx as never, session)
    expect(pressure).toEqual({ projectedTokens: 9000, contextWindow: 10000 })
  })

  it('readContextPressure：未装配 / 无压力值 → null（不抛错）', () => {
    const session = { id: 's1' }
    const noService = { get: () => undefined }
    expect(readContextPressure(noService as never, session)).toBeNull()
    const noPressure = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: {} }) }
        : undefined,
    }
    expect(readContextPressure(noPressure as never, session)).toBeNull()
  })
})

describe('keeper: LOGBOOK COMPACTION（SESSION.md 体积超限重写提醒，v1.31.1）', () => {
  let dir: string
  let handler: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null
  const SCOPE = 'md-size-1'

  /** 写 CCC 配置（阈值设很大 → 屏蔽计分提醒噪音，只观察体积提醒） */
  function writeConfig(sessionKeeper: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ sessionKeeper: { threshold: 99999, ...sessionKeeper } }),
    )
  }

  /**
   * 建 SESSION.md 并绑定为活跃会话；返回其绝对路径。
   *
   * ⚠️ `scope` 必须 = 发起工具调用的那个 **sessionId**（keeper 的 `resolveActiveSessionMdPath`
   * 以 sessionId 为缓存键）。把活跃绑定挂在别的 scope 上会让"体积提醒"因路径解析不到而恒不触发
   * —— 那时断言通过，但测的不是纪律开关 ⇒ 纪律子集用例必须显式传自己的 sessionId。
   */
  function bindSession(sizeBytes: number, scope: string = SCOPE): string {
    const dirName = `2026-01-01--${scope}--size-test`
    const sessionDir = join(dir, 'AGENT_SESSIONS', dirName)
    mkdirSync(sessionDir, { recursive: true })
    const mdPath = join(sessionDir, 'SESSION.md')
    writeFileSync(mdPath, 'x'.repeat(sizeBytes))
    setActiveSessionInfo(scope, { sessionId: scope, dirName, mdPath })
    return mdPath
  }

  async function fire(): Promise<string[]> {
    const exec = { name: 'read', agent: { session: { id: SCOPE, header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as {
      additionalContexts?: Array<{ content?: Array<{ text?: string }> }>
    }
    return (result.additionalContexts ?? []).map((m) => m.content?.[0]?.text ?? '')
  }

  beforeEach(() => {
    __resetLogbookCompactionForTest()
    dir = mkdtempSync(join(tmpdir(), 'keeper-compaction-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeConfig({ sessionMdMaxKB: 1 })
    handler = null
    registerKeeper({ on: (name: string, fn: unknown) => { if (name === 'tools/post-execute') handler = fn as typeof handler } } as never)
  })

  afterEach(() => {
    clearActiveSessionInfo(SCOPE)
    // 纪律子集用例按各自 sessionId 挂活跃绑定（见 bindSession 的注释）⇒ 一并清，别留给下个用例
    clearActiveSessionInfo('轨迹约束-quiet-1')
    clearActiveSessionInfo('轨迹约束-loud-1')
    resetTrajectorySessions()
    __resetLogbookCompactionForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('超限 → 注入提醒（含 token / 体积 / 阈值 / 路径 / EAP 三变量）', async () => {
    bindSession(2048) // 2 KB > 1 KB
    const texts = await fire()
    expect(texts).toHaveLength(1)
    const t = texts[0]!
    expect(t).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]')
    expect(t).toContain('2 KB')
    expect(t).toContain('limit 1 KB')
    expect(t).toContain('SESSION.md')
    expect(t).toContain('praxis eap')
    // 🔴 v1.136.6（2026-11-16 裁定）：文案从「按 EAP 重构」升级为「按性质分流」——
    //    压缩的出口有三个，而不是只有"移出到 references"：记录→LOG、证据→references、判断→主体。
    //    ⚠️ 旧断言 `refactor SESSION.md end to end under EAP` 与 `E↑/R↓/S↑` 三变量**不再钉**：
    //    那是上一版文案的措辞，留着等于用一个已不存在的契约定住实现（同族 D151）。
    expect(t).toContain('restructure it as a layered abstraction tree')
    expect(t).toContain('do not merely shorten it')
    // 三个出口，缺一即压缩只剩"改写得更短"这半条路
    expect(t).toContain('LOG/LOG.md')
    expect(t).toContain('references/')
    expect(t).toContain('judgement stays in the body')
    // 七段点名（2026-11-16 选 A：硬编码段名 —— 注入是模型读的，模型不看 SKILL）
    expect(t).toContain('身份与边界')
    expect(t).toContain('权威锚点')
    expect(t).toContain('工作纪律')
    expect(t).toContain('决策')
    expect(t).toContain('当前状态')
    expect(t).toContain('待 owner 裁决')
    // 硬约束：frontmatter 不许动
    expect(t).toContain('frontmatter')
  })

  it('未超限 → 零注入；重写后（文件变小）提醒自动停止', async () => {
    const mdPath = bindSession(512) // 0.5 KB < 1 KB
    expect(await fire()).toHaveLength(0)
    writeFileSync(mdPath, 'y'.repeat(4096))
    expect(await fire()).toHaveLength(1)
    writeFileSync(mdPath, 'z'.repeat(100))
    expect(await fire()).toHaveLength(0)
  })

  it('连续 3 轮超限 → 第 3 轮升级强制语气（mandatory + STOP）', async () => {
    bindSession(4096)
    const first = (await fire())[0]!
    const second = (await fire())[0]!
    const third = (await fire())[0]!
    expect(first).not.toContain('mandatory')
    expect(second).not.toContain('mandatory')
    expect(third).toContain('mandatory')
    expect(third).toContain('STOP')
  })

  it('CCC 配置 sessionMdMaxKB=0 → 关闭提醒', async () => {
    writeConfig({ sessionMdMaxKB: 0 })
    __resetLogbookCompactionForTest()
    bindSession(8192)
    expect(await fire()).toHaveLength(0)
  })

  it('活跃会话未绑定 / SESSION.md 不存在 → 不提醒且不抛错（不猜别的轨迹）', async () => {
    expect(await fire()).toHaveLength(0)
    setActiveSessionInfo(SCOPE, { sessionId: 'S002', dirName: 'ghost', mdPath: join(dir, 'nope', 'SESSION.md') })
    expect(await fire()).toHaveLength(0)
  })

  it('轨迹约束轨迹（cognitiveTrajectory.session 关）→ 不提醒（纪律子集控权）', async () => {
    // 🔴 2026-10-19 重做：身份判据 = 绑定的轨迹有没有 `trajectory-constraint.json`（不再是 `serenity.json` 的角色表）。
    //    纪律缺省也翻成了 **true** ⇒ 要"关"必须显式写 false（旧夹具靠缺省 false 拿到关闭）。
    const QUIET = '轨迹约束-quiet-1'
    make轨迹约束Session(dir, QUIET, 'quiet', 轨迹约束Json({ msms: [], cognitiveTrajectory: { session: false } }))
    // ⚠️ 活跃绑定挂在**同一个** sessionId 上：否则路径解析不到 ⇒ 恒零注入 ⇒ 断言测不到门控
    bindSession(4096, QUIET)
    const exec = { name: 'read', agent: { session: { id: QUIET, header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(0)
    unregisterTrajectorySession(QUIET)
  })

  it('对照组：同一超限体积、cognitiveTrajectory.session 开 ⇒ 提醒（唯一变量 = 纪律开关）', async () => {
    // ↑ 没有这条，上面那条就可能是"因为路径解析不到而恒零注入"的假绿（本条给出反证）
    const LOUD = '轨迹约束-loud-1'
    make轨迹约束Session(dir, LOUD, 'loud', 轨迹约束Json({ msms: [], cognitiveTrajectory: { session: true } }))
    bindSession(4096, LOUD)
    const exec = { name: 'read', agent: { session: { id: LOUD, header: { cwd: dir } } } }
    const texts = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as {
      additionalContexts?: Array<{ content?: Array<{ text?: string }> }>
    }
    expect((texts.additionalContexts ?? []).map((m) => m.content?.[0]?.text ?? '')).toHaveLength(1)
    expect(texts.additionalContexts?.[0]?.content?.[0]?.text).toContain('LOGBOOK COMPACTION')
    unregisterTrajectorySession(LOUD)
  })
})

describe('keeper: LOGBOOK COMPACTION 纯逻辑', () => {
  afterEach(() => { __resetLogbookCompactionForTest() })

  it('提醒文案：非升级版含行动指令 + EAP 三变量；升级版含 mandatory/STOP', () => {
    const base = cognitiveTrajectoryCompactionReminderText({ sizeKB: 285, limitKB: 100, mdPath: '/ccc/SESSION.md' })
    expect(base).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · LOGBOOK COMPACTION]')
    expect(base).toContain('285 KB')
    expect(base).toContain('limit 100 KB')
    expect(base).toContain('/ccc/SESSION.md')
    expect(base).toContain('Pause the current work')
    expect(base).toContain('H_op')
    expect(base).toContain('resume the paused work')
    // v1.136.6 文案（三条出口取代旧 EAP 三变量表述，见上一个用例的判据）
    expect(base).toContain('layered abstraction tree')
    expect(base).toContain('LOG/LOG.md')
    expect(base).toContain('references/')
    expect(base).toContain('judgement stays in the body')
    const esc = cognitiveTrajectoryCompactionReminderText({ sizeKB: 285, limitKB: 100, mdPath: '/ccc/SESSION.md', escalated: true })
    expect(esc).toContain('mandatory')
    expect(esc).toContain('STOP')
    expect(esc).toContain('persists until the file is under the limit')
    // 升级档同样保留三条出口（否则升级后模型只知道"要压"，不知道往哪压）
    expect(esc).toContain('belongs in AGENT_SESSIONS/<session>/references/')
    expect(esc).toContain('belongs in LOG/LOG.md')
  })

  it('阈值：未配置 → 缺省 100KB（v1.84.0 由 200 下调）；配置生效；0 生效（关闭）；坏值回落缺省', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-limit-'))
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    const cfg = join(dir, '.opencode', 'serenity.json')
    // 🔴 v1.84.0（owner 2026-10-21 令「阈值改为 100k」）：缺省值硬断言——防再次静默漂移。
    //    变更史：v1.31.1 引入 100 → v1.31.2 改 200 → v1.84.0 回到 100（配套文案改版）。
    expect(DEFAULT_SESSION_MD_MAX_KB).toBe(100)
    expect(readSessionMdMaxKB(dir)).toBe(DEFAULT_SESSION_MD_MAX_KB)
    writeFileSync(cfg, JSON.stringify({ sessionKeeper: { sessionMdMaxKB: 250 } }))
    __resetLogbookCompactionForTest()
    expect(readSessionMdMaxKB(dir)).toBe(250)
    writeFileSync(cfg, JSON.stringify({ sessionKeeper: { sessionMdMaxKB: 0 } }))
    __resetLogbookCompactionForTest()
    expect(readSessionMdMaxKB(dir)).toBe(0)
    writeFileSync(cfg, JSON.stringify({ sessionKeeper: { sessionMdMaxKB: 'huge' } }))
    __resetLogbookCompactionForTest()
    expect(readSessionMdMaxKB(dir)).toBe(DEFAULT_SESSION_MD_MAX_KB)
    rmSync(dir, { recursive: true, force: true })
  })

  it('路径解析：活跃会话信息优先；文件缺失 → null；缓存命中（TTL 内不重解析）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-path-'))
    mkdirSync(join(dir, 'AGENT_SESSIONS', 'S1'), { recursive: true })
    const mdPath = join(dir, 'AGENT_SESSIONS', 'S1', 'SESSION.md')
    writeFileSync(mdPath, 'hi')
    setActiveSessionInfo('p1', { sessionId: 'S1', dirName: 'S1', mdPath })
    expect(resolveActiveSessionMdPath(dir, 'p1', null)).toBe(mdPath)
    // 缓存命中：改活跃指向也不重解析（TTL 内）
    setActiveSessionInfo('p1', { sessionId: 'S2', dirName: 'S2', mdPath: join(dir, 'missing.md') })
    expect(resolveActiveSessionMdPath(dir, 'p1', null)).toBe(mdPath)
    // 清理后重新解析 → 文件不存在 → null
    forgetLogbookCompactionState('p1')
    expect(resolveActiveSessionMdPath(dir, 'p1', null)).toBeNull()
    clearActiveSessionInfo('p1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('readFileSize：存在 → 字节数；缺失 → null（不抛错）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-size-'))
    const f = join(dir, 'a.md')
    writeFileSync(f, 'abcd')
    expect(readFileSize(f)).toBe(4)
    expect(readFileSize(join(dir, 'nope.md'))).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('状态快照与清理：超限计数可观测，清理后归零', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-state-'))
    writeFileSync(join(dir, '.serenity'), 'x')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ sessionKeeper: { threshold: 99999, sessionMdMaxKB: 1 } }))
    const sessionDir = join(dir, 'AGENT_SESSIONS', 'S1')
    mkdirSync(sessionDir, { recursive: true })
    const mdPath = join(sessionDir, 'SESSION.md')
    writeFileSync(mdPath, 'x'.repeat(2048))
    setActiveSessionInfo('st-1', { sessionId: 'S1', dirName: 'S1', mdPath })
    let h: ((e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<unknown>) | null = null
    registerKeeper({ on: (name: string, fn: unknown) => { if (name === 'tools/post-execute') h = fn as typeof h } } as never)
    await h!({ name: 'read', agent: { session: { id: 'st-1', header: { cwd: dir } } } }, {}, async () => ({ kind: 'enter' }))
    expect(compactionStateSnapshot().get('st-1')?.consecutive).toBe(1)
    forgetLogbookCompactionState('st-1')
    expect(compactionStateSnapshot().has('st-1')).toBe(false)
    clearActiveSessionInfo('st-1')
    rmSync(dir, { recursive: true, force: true })
  })
})



describe('keeper: 轨迹约束轨迹纪律子集旁路（F4b ⑩）', () => {
  let dir: string
  let handler: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keeper-轨迹约束-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    // 🔴 2026-10-19 重做：轨迹约束面不再写在 `serenity.json` 的 `轨迹约束.roles`（该段已退役），
    //    改由**轨迹目录下的 `trajectory-constraint.json`** 承载 ⇒ 这里只留 CCC 级计分配置，轨迹面见下方各用例。
    //    ⚠️ 纪律缺省翻成 **全 true**（旧夹具靠"缺省 false"表达"这个 轨迹约束 不参与 keeper"）。
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ sessionKeeper: { threshold: 1 } }),
    )
    handler = null
    const fakeCtx = {
      on: (name: string, fn: unknown) => {
        if (name === 'tools/post-execute') handler = fn as typeof handler
      },
    }
    registerKeeper(fakeCtx as never, { defaultThreshold: 1 })
  })

  afterEach(() => {
    unregisterTrajectorySession('轨迹约束-qa-1')
    unregisterTrajectorySession('轨迹约束-tracked-1')
    unregisterTrajectorySession('轨迹约束-default-1')
    resetTrajectorySessions()
    rmSync(dir, { recursive: true, force: true })
  })

  it('轨迹约束轨迹（keeper 子集显式关）→ 计分不触发提醒（完全独立）', async () => {
    make轨迹约束Session(dir, '轨迹约束-qa-1', 'qa', 轨迹约束Json({ msms: ['x'], cognitiveTrajectory: { keeper: false } }))
    const exec = { name: 'read', agent: { session: { id: '轨迹约束-qa-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(0)
  })

  it('轨迹约束轨迹（keeper 子集开）→ 计分提醒生效（按 trajectory-constraint.json）', async () => {
    make轨迹约束Session(dir, '轨迹约束-tracked-1', 'tracked', 轨迹约束Json({ msms: ['y'], cognitiveTrajectory: { keeper: true } }))
    const exec = { name: 'read', agent: { session: { id: '轨迹约束-tracked-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })

  it('🔴 轨迹约束轨迹未声明 cognitiveTrajectory ⇒ 缺省参与 keeper（重做后缺省翻成 true）', async () => {
    // 回归钉：旧模型里 轨迹约束的纪律缺省全 false（工作台是外挂的）；新模型工作台就是它自己的
    // SESSION.md ⇒ 缺省全 true。若哪天又翻回 false，这条会红。
    make轨迹约束Session(dir, '轨迹约束-default-1', 'defaults', 轨迹约束Json({ msms: ['z'] }))
    const exec = { name: 'read', agent: { session: { id: '轨迹约束-default-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })

  it('非 轨迹约束会话 → 计分提醒正常（不受影响）', async () => {
    const exec = { name: 'read', agent: { session: { id: 'normal-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })
})
