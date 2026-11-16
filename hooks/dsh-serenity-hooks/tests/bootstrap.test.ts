import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEpochPromotion,
  resolveBootstrapSettings,
  DEFAULT_BOOTSTRAP_TOOLS,
  DEFAULT_SUPPRESSED_SOURCES,
  DEFAULT_COMPACTION_TOOLS,
  DEFAULT_FAKE_INITIAL_MESSAGES,
  hasUserMessageHistory,
} from '../src/seams/bootstrap.js'
import { resetTrajectorySessions, registerTrajectorySession } from '../src/trajectory/policy/window.js'
import { make轨迹约束Session, makeTrajectory, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

/** 构造最小 agent（子 agent 模拟） */
function mkAgent(session: unknown): unknown {
  return { session }
}

function mkSession(id: string, events: unknown[] = [], header: Record<string, unknown> = {}): unknown {
  return { id, events, header }
}

function ev(type: string, seq = 0): unknown {
  return { type, seq }
}

describe('bootstrap: createEpochPromotion 阶段机（对齐 anchored compaction-epoch）', () => {
  it('无事件 → 未晋升（boundary -1）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const agent = mkAgent(mkSession('s1'))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: false })
  })

  it('tool/call 事件 → 晋升（tool-call 模式）', () => {
    const p = createEpochPromotion(new Set(['tool/call']))
    const agent = mkAgent(mkSession('s1', [ev('tool/call', 1)]))
    expect(p.status(agent as never).promoted).toBe(true)
  })

  it('either 模式：assistant/message 或 tool/call 先到者晋升', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    expect(p.status(mkAgent(mkSession('s1', [ev('assistant/message', 1)])) as never).promoted).toBe(true)
    expect(p.status(mkAgent(mkSession('s2', [ev('tool/call', 1)])) as never).promoted).toBe(true)
  })

  it('observe 增量：事件到达后晋升（无需重新 scan）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const session = mkSession('s1')
    p.status(mkAgent(session) as never) // 冷启动 scan 建条目
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('tool/call', 1))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('compaction/end 后回落未晋升，需新的晋升信号（epoch 感知）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 晋升后压缩
    const session = mkSession('s1', [ev('tool/call', 1), ev('compaction/end', 5)])
    const status = p.status(mkAgent(session) as never)
    expect(status.promoted).toBe(false)
    expect(status.boundary).toBe(5)
    // 压缩后新 tool/call → 重新晋升
    p.observe(session, ev('tool/call', 6))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('压缩前的事件不算晋升（boundary 前）', () => {
    const p = createEpochPromotion(new Set(['tool/call']))
    const session = mkSession('s1', [ev('tool/call', 1), ev('compaction/end', 5), ev('assistant/message', 6)])
    // either 模式：boundary 后 assistant/message → 晋升
    const p2 = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    expect(p2.status(mkAgent(session) as never).promoted).toBe(true)
    // tool-call 模式：boundary 后无 tool/call → 未晋升
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
  })

  it('子 agent（delegationDepth > 0）恒晋升（完整目录）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    const agent = mkAgent(mkSession('sub', [], { delegationDepth: 1 }))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('cheap-worker agent（sessionId `cheap-worker-` 前缀）恒晋升（完整目录，对齐 S140 修复）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // cheap-worker agent 经 ctx.agents.create 直接创建，delegationDepth 为 0（非 delegation 路径），
    // 但 sessionId 固定 `cheap-worker-` 前缀 → 必须恒判 promoted（否则 zeroTools 配置下拿到 0 工具）
    const agent = mkAgent(mkSession('cheap-worker-sqc-scan-9f3a2b', [], { delegationDepth: 0 }))
    expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('cheap-worker agent 即使有历史事件也恒晋升（不回落 bootstrap 阶段）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 即便含 compaction/end，cheap-worker agent 仍恒 promoted（autonomous worker 不需 epoch 收窄）
    const session = mkSession('cheap-worker-x-1', [ev('compaction/end', 5), ev('tool/call', 6)])
    expect(p.status(mkAgent(session) as never)).toEqual({ boundary: -1, promoted: true })
  })

  it('轨迹约束 agent（绑定轨迹**有 `trajectory-constraint.json`**）恒晋升（提示词全替换，无锚定轮，F4b 旁路）', () => {
    // 🔴 2026-10-19：判据不再是 sessionId 的 `轨迹约束-` 前缀，而是「**会话绑定的轨迹目录里
    //    有 `trajectory-constraint.json`**」（`seams/bootstrap.ts` 的 `isTrajectoryConstrained(loopRoot, loopSid)`）。
    //    ⇒ 夹具必须造一条真轨迹（CCC 根 → `AGENT_SESSIONS/2026-10-19--qa--traj/trajectory-constraint.json`）
    //    并把会话登记进去，同时让 `session.header.cwd` 指向该 CCC 根（根解析靠 `.serenity` 标记）。
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-轨迹约束-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    const dirName = make轨迹约束Session(dir, 'sess-轨迹约束-1', 'qa', 轨迹约束Json({ tools: [], systemPromptFile: 'charter.md' }))

    try {
      const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
      const agent = mkAgent(mkSession('sess-轨迹约束-1', [], { delegationDepth: 0, cwd: dir }))
      expect(p.status(agent as never)).toEqual({ boundary: -1, promoted: true })
      // 有历史事件也恒晋升
      const session = mkSession('sess-轨迹约束-1', [ev('compaction/end', 5), ev('tool/call', 6)], { delegationDepth: 0, cwd: dir })
      expect(p.status(mkAgent(session) as never)).toEqual({ boundary: -1, promoted: true })
      expect(dirName).toContain('qa') // 夹具自证：登记的确实是这条轨迹
    } finally {
      resetTrajectorySessions()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('🔴 反控：sessionId 带 `轨迹约束-` 前缀但绑定的轨迹**没有 `trajectory-constraint.json`** ⇒ 按普通会话判（不恒晋升）', () => {
    // 这条与上一条成对：删掉前缀判据后，"恒晋升"若退化成"凡是 轨迹约束-* 都恒晋升"，
    // 上一条照样绿 —— 只有反控能把判据钉在**轨迹**上。
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-plain-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    // 普通轨迹：**不写 `trajectory-constraint.json`**（`makeTrajectory(root, code, null)`），再把会话登记到它
    // ⚠️ 不能用 `make轨迹约束Session(..., null)`：它内部是 `profile ?? {}` ⇒ 仍会落一个空
    //    `trajectory-constraint.json`，那样这条反控会**假绿**（判成了"是 轨迹约束"）。
    const { dirName } = makeTrajectory(dir, 'plain-trajectory', null)
    registerTrajectorySession('轨迹约束-legacy-looking-id', dirName, dir)

    try {
      const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
      const agent = mkAgent(mkSession('轨迹约束-legacy-looking-id', [], { delegationDepth: 0, cwd: dir }))
      expect(p.status(agent as never).promoted).toBe(false)
    } finally {
      resetTrajectorySessions()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resume：从持久 events 重建阶段（不依赖进程内存）', () => {
    const p = createEpochPromotion(new Set(['tool/call', 'assistant/message']))
    // 模拟重启：新 tracker + 有历史的 session
    const agent = mkAgent(mkSession('s1', [ev('assistant/message', 3)]))
    expect(p.status(agent as never).promoted).toBe(true)
  })

  it('requiredSignals=2：两轮锚定——第 2 条 assistant/message 才晋升（v4 多轮递进）', () => {
    const p = createEpochPromotion(new Set(['assistant/message']), 2)
    // 第一条锚定回复 → 未晋升
    const session = mkSession('s1', [ev('assistant/message', 1)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 第二条锚定回复 → 晋升
    p.observe(session, ev('assistant/message', 2))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('轮次兜底：晋升信号缺失时，step/start 达 maxRoundsFallback（3）强制晋升（responses API 兼容）', () => {
    // 模拟 responses API 模型：promoteEvents 不含 assistant/message（如 tool-call 模式）
    // 或信号永不到达——3 步后必须解锁完整工具，不能永久卡 0 工具
    const p = createEpochPromotion(new Set(['tool/call']), 1, 3)
    const session = mkSession('s-resp', [])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 第 1、2 步 step/start → 仍未晋升（兜底未到）
    p.observe(session, ev('step/start', 1))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('step/start', 2))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 第 3 步 step/start → 兜底强制晋升
    p.observe(session, ev('step/start', 3))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('轮次兜底：scan 路径同样生效（resume 会话，step/start 计数）', () => {
    const p = createEpochPromotion(new Set(['tool/call']), 1, 3)
    // 3 条 step/start（无 tool/call）→ scan 时即 promoted
    const session = mkSession('s-resp-resume', [ev('step/start', 1), ev('step/start', 2), ev('step/start', 3)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('轮次兜底：compaction 后回落，需重新计数（epoch 感知）', () => {
    const p = createEpochPromotion(new Set(['tool/call']), 1, 3)
    const session = mkSession('s-resp-epoch', [ev('step/start', 1), ev('step/start', 2), ev('step/start', 3), ev('compaction/end', 5)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    // 压缩后 3 步 step/start → 重新兜底晋升
    p.observe(session, ev('step/start', 6))
    p.observe(session, ev('step/start', 7))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('step/start', 8))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })

  it('requiredSignals=2：压缩后计数重置，需重新累计 2 条', () => {
    const p = createEpochPromotion(new Set(['assistant/message']), 2)
    const session = mkSession('s1', [ev('assistant/message', 1), ev('assistant/message', 2), ev('compaction/end', 5)])
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('assistant/message', 6))
    expect(p.status(mkAgent(session) as never).promoted).toBe(false)
    p.observe(session, ev('assistant/message', 7))
    expect(p.status(mkAgent(session) as never).promoted).toBe(true)
  })
})

describe('bootstrap: hasUserMessageHistory（v1.28.1 根会话重锚判定；v1.62 收紧到真人）', () => {
  /** 真人说的 user/message（`source.kind === 'user'`） */
  const human = (seq = 1) => ({ type: 'user/message', seq, data: { source: { kind: 'user' } } })

  it('有**真人** user/message 事件 → true（resume/续跑不重锚）', () => {
    const session = mkSession('resume', [human(1), ev('assistant/message', 2)])
    expect(hasUserMessageHistory(session)).toBe(true)
  })

  it('snapshotEvents() 形态同样生效（rc.1 Session 无 .events 属性——bug 2 根因回归）', () => {
    const session = { id: 'resume-snap', header: {}, snapshotEvents: () => [human(1)] }
    // 旧实现裸读 .events → undefined → 误判"无历史"→ 每条消息都重插锚定（bug 2）
    expect(hasUserMessageHistory(session)).toBe(true)
  })

  it('🔴 v1.62：宿主注入的 user/message（runtime-context / plugin / time-context）**不算**历史', () => {
    // 为什么重要：宿主在为每条会话自动写一批 `source.kind !== 'user'` 的 user 消息
    // （ACC 横幅 `plugin:*`、`runtime-context`、`time-context`、`skill-catalog`…）。
    // 若把它们算作"历史"，本判定在**首轮就已经为真** ⇒ 锚定永不触发（实测静默失效）。
    const injected = [
      { type: 'user/message', seq: 1, data: { source: { kind: 'plugin:dsh-serenity-hooks' } } },
      { type: 'user/message', seq: 2, data: { source: { kind: 'runtime-context' } } },
      { type: 'user/message', seq: 3, data: { source: { kind: 'time-context' } } },
    ]
    expect(hasUserMessageHistory({ id: 'inj', header: {}, snapshotEvents: () => injected })).toBe(false)
  })

  it('无 user/message（仅 assistant/工具事件）→ false（仍首轮锚定）', () => {
    const session = mkSession('first', [ev('assistant/message', 1)])
    expect(hasUserMessageHistory(session)).toBe(false)
  })

  it('无事件 / 空会话 → false', () => {
    expect(hasUserMessageHistory(mkSession('empty'))).toBe(false)
    expect(hasUserMessageHistory(null)).toBe(false)
    expect(hasUserMessageHistory(undefined)).toBe(false)
  })
})

describe('bootstrap: resolveBootstrapSettings 协议固有默认值（零配置面，S142）', () => {
  it('无参返回唯一固化设置：zeroTools + 协议假首轮消息（2026-11-16 起合并为一条）', () => {
    const s = resolveBootstrapSettings()
    expect(s.bootstrapTools).toEqual(DEFAULT_BOOTSTRAP_TOOLS)
    expect(s.promoteEvents.has('assistant/message')).toBe(true)
    expect(s.promoteEvents.has('tool/call')).toBe(false) // zeroTools 变体：仅 assistant/message
    expect([...s.suppressedSources]).toEqual(DEFAULT_SUPPRESSED_SOURCES)
    expect(s.compactionTools).toEqual(DEFAULT_COMPACTION_TOOLS)
    expect(s.fakeInitialMessages).toEqual(DEFAULT_FAKE_INITIAL_MESSAGES)
    expect(s.fakeInitialMessages).toHaveLength(1)
    expect(s.requiredSignals).toBe(1) // 一条假首轮：每条回复计一次，该条回复后晋升
    expect(s.zeroTools).toBe(false) // v1.70：假首轮真跑但模型侧短路 ⇒ 首请求须给完整目录
  })

  it('协议固有设置：zeroTools=false 是**结构性要求**，不是调参', () => {
    const s = resolveBootstrapSettings()
    // 🔴 为什么必须是 false：假首轮的两轮回复走短路（不发真调用），晋升信号要等事件落盘后
    //    才计数 ⇒ 首请求时 `boundary < 0` ⇒ 若 zeroTools=true，首请求会退化成「0 工具」，
    //    模型看不到任何 ACC 工具。
    expect(s.zeroTools).toBe(false)
  })

  it('协议假首轮消息内容不可配置：含 ACC 身份 + 协作五条 + acknowledge（S142 固化；2026-11-16 合并为一条）', () => {
    const [only] = DEFAULT_FAKE_INITIAL_MESSAGES
    // ① 身份与原则（系统提示词的 eapBlock 给操作定义，此处只指认不复述）
    expect(only).toContain('Abstract Cognitive Container (ACC) protocol')
    expect(only).toContain('Explicit Abstraction Principle')
    expect(only).toContain('The personal pronoun is us/we.')
    expect(only).toContain('We anchor first, then act: the abstract layer precedes the concrete.')
    // ② 协作五条（系统提示词零处，只在 bootstrap 有 ⇒ 合并时一条都不许丢）
    expect(only).toContain('We read before we write')
    expect(only).toContain('Every output records its reasoning')
    expect(only).toContain('We never jump levels')
    expect(only).toContain('durable cognitive anchor')
    expect(only).toContain('SESSION.md')
    // ③ acknowledge 要求只出现一次（原两条各写一遍 = 重复）
    expect(only).toContain('Please simply reply "acknowledge" — no action needed.')
    expect(only.match(/simply reply "acknowledge"/g)).toHaveLength(1)
  })

  it('🔴 反向钉：假首轮合并为**一条**（防止有人拆回两条而不自知）', () => {
    expect(DEFAULT_FAKE_INITIAL_MESSAGES).toHaveLength(1)
    // 合并后的那条必须同时承载"身份"与"协作协议"两半
    const [only] = DEFAULT_FAKE_INITIAL_MESSAGES as [string]
    expect(only).toContain('operator agent of Serenity')
    expect(only).toContain('How we work:')
    // EAP 的展开复述不该回来（操作定义归系统提示词）
    expect(only).not.toContain('every output we produce must be explicit')
  })
})
