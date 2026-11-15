import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs'
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

import {
  buildRebuildAnchor,
  queueRebuild,
  performRebuild,
  registerRebuildTurnHook,
  pendingRebuildSnapshot,
  stripAckSuffix,
  resolveSessionMdPath,
  sanitizeFocusLine,
} from '../src/trajectory/rebuild.js'
import { handoverReminderText, readContextPressure } from '../src/seams/cognitive-trajectory-lifecycle.js'
import { setActiveSessionInfo, resetActiveSessionStore } from '../src/trajectory/core.js'
import { SESSION_CONTEXT_MARKER } from '../src/trajectory/core.js'
import { readLastBound, appendBound } from '../src/trajectory/bound.js'
import { HANDOVER_NOTE_HEADING, LOG_FILE_REL } from '../src/trajectory/assistant.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-rebuild-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 构造最小可测 dsh 会话（surface nodes 可读 + append 记录调用 + header 供绑定文件定位） */
function fakeSession(nodes: number[]) {
  const calls: Array<{ type: string; data: unknown; opts: unknown }> = []
  return {
    header: { id: 'session-x', cwd: dir },
    surface: { nodes, replaceGeneration: 0 },
    append: (type: string, data: unknown, opts?: unknown) => {
      calls.push({ type, data, opts })
      return { type, data, opts }
    },
    _calls: calls,
  }
}

/** 写一个活动会话目录（约定回退可解析；v1.24.11 测试夹具） */
function mkActiveSession(desc: string, mtimeBump = false): string {
  const md = join(dir, 'AGENT_SESSIONS', `2026-08-28--S200--${desc}`, 'SESSION.md')
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, `# SESSION ${desc}`)
  if (mtimeBump) utimesSync(md, new Date(), new Date(Date.now() + 60_000))
  return md
}

/**
 * 预置**权威绑定**（`AGENT_SESSIONS/.bindings.json`）——v1.30.13（D4）后
 * resolveSessionMdPath 的候选②b。真实形态 = 会话此前 use/create/轨迹约束 自动绑过，
 * 进程重启后内存活跃为空、events 无上下文时仍能精确定位。
 */
function bindSession(session: unknown, mdPath: string): void {
  appendBound(session, 'activate', { dirName: basename(dirname(mdPath)), mdPath })
}

/** 构造最小可测 agent（session + steer 记录调用） */
function fakeAgent(id: string, session: unknown) {
  const steers: unknown[] = []
  return {
    id,
    session,
    steer: (msg: unknown) => { steers.push(msg) },
    _steers: steers,
  }
}

describe('轨迹跟踪器 rebuild（v1.22.4 定稿：复用旧会话 + turn 结束清空；v1.22.5：自动继续 + 保留协议正文）', () => {
  it('stripAckSuffix：去掉 acknowledge 尾句（保留协议正文）', () => {
    const text = 'We anchor first, then act.\nPlease simply reply "acknowledge" — no action needed.'
    expect(stripAckSuffix(text)).toBe('We anchor first, then act.')
  })

  it('stripAckSuffix：无尾句 → 原样返回', () => {
    expect(stripAckSuffix('plain text')).toBe('plain text')
  })

  it('buildRebuildAnchor：Continue {SESSION name} + persistent cognitive trajectory path + fake-initial-turns protocol body（ack 剥离）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    expect(a).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · REBUILD]')
    expect(a).toContain('Continue the work of S142')
    expect(a).toContain('AGENT_SESSIONS/2026-08-24--S142--dsp/SESSION.md')
    expect(a).toContain('Persistent cognitive trajectory')
    // v1.24.11 规范行：SESSION.md path: 与 use 上下文同格式（恢复机制可解析，无需 [SESSION CONTEXT] 标记）
    expect(a).toContain('SESSION.md path: AGENT_SESSIONS/2026-08-24--S142--dsp/SESSION.md')
    // v1.22.5：保留协议正文（ACC 身份/EAP/协作协议）—— v1.70 起这段正文归 fake-initial-turns
    expect(a).toContain('Abstract Cognitive Container')
    expect(a).toContain('Explicit Abstraction Principle')
    expect(a).toContain('We anchor first, then act')
    expect(a).toContain('Before we proceed')
    // 去掉 acknowledge 尾句（重建后不重走确认轮）
    expect(a).not.toContain('acknowledge')
    expect(a).not.toContain('no action needed')
  })

  it('buildRebuildAnchor：会话目录名含空格 → 完整目录名行 + 完整相对路径（S142 v1.23.4 定位回归）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsh-serenity-plugin 长期维护', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    // 完整目录名（含空格）明确写入锚点——重建后直接定位 SESSION
    expect(a).toContain('Serenity session: S142 (2026-08-24--S142--dsh-serenity-plugin 长期维护)')
    // 相对路径完整（不再截断在空格处）
    expect(a).toContain('AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/SESSION.md')
  })

  it('无激活会话名 → 通用指令', () => {
    const a = buildRebuildAnchor(dir, '', join(dir, 'AGENT_SESSIONS', 'SESSION.md'))
    expect(a).toContain('Continue the current work')
    expect(a).not.toContain('Continue the work of S')
  })

  // ── 2026-11-16 交接协议读侧（owner 裁定）：便签住 `LOG/LOG.md` 的 `## Handover note` 节，
  //    锚点必须**同时**指向当前代与被冻结的上一代（轮转可能把在办状态留在上一代里）──

  it('buildRebuildAnchor：读侧指 LOG 的 ## Handover note（节名常量与写侧同源）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    // 与 keeper.handoverReminderText（写侧）共用同两个常量——漂移则读侧找不到写侧写的东西
    expect(a).toContain(HANDOVER_NOTE_HEADING)
    expect(a).toContain(LOG_FILE_REL)
    // 相对路径给出（新我可直接 read）
    expect(a).toContain('AGENT_SESSIONS/2026-08-24--S142--dsp/LOG/LOG.md')
    // 🔴 关键：必须提示**也读被冻结的上一代** —— 轮转把整份 LOG mv 走时，
    //    在办状态可能还留在上一代里；只指当前代会读到空白。
    expect(a).toContain('previous generation')
    expect(a).toContain('LOG-<stamp>.md')
    // 顺序：先读 SESSION.md 全貌 → 再读交接便签
    expect(a.indexOf(HANDOVER_NOTE_HEADING)).toBeGreaterThan(a.indexOf('Read that SESSION.md first'))
  })

  it('🔴 buildRebuildAnchor：不再指向独立便签文件（回归钉）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    // 2026-11-16：独立文件整体删除，改住 LOG —— 加回来就是第二个"在办"住处
    expect(a).not.toContain('REBUILD-TODO')
    expect(a).not.toContain('handover scratch note')
    // 旧的 In-flight 段同样不许复活
    expect(a).not.toContain('In-flight (rebuild handover)')
    expect(a).not.toContain('at the very end of SESSION.md')
  })

  it('buildRebuildAnchor：无激活会话名时同样带交接便签读侧指令（非会话相关分支）', () => {
    const a = buildRebuildAnchor(dir, '', join(dir, 'AGENT_SESSIONS', 'SESSION.md'))
    expect(a).toContain(HANDOVER_NOTE_HEADING)
  })

  // ── v1.29.2（R1）：rebuild 任务焦点传递（note → Task focus 段）──

  it('buildRebuildAnchor：带 focus → 锚点含 Task focus 段（简短任务焦点，无历史）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath, undefined, '完成 R1/R2 修正并验证发布')
    expect(a).toContain('Continue the work of S142')
    expect(a).toContain('- Task focus: 完成 R1/R2 修正并验证发布')
    // 位于 Persistent cognitive trajectory 之后、锚点尾部（焦点是给重建后自己的补充，不干扰 SESSION 定位解析）
    expect(a.indexOf('- Task focus:')).toBeGreaterThan(a.indexOf('Persistent cognitive trajectory'))
  })

  it('buildRebuildAnchor：无 focus → 锚点不含 Task focus（向后兼容）', () => {
    const mdPath = join(dir, 'AGENT_SESSIONS', '2026-08-24--S142--dsp', 'SESSION.md')
    const a = buildRebuildAnchor(dir, 'S142', mdPath)
    expect(a).not.toContain('Task focus')
    const a2 = buildRebuildAnchor(dir, 'S142', mdPath, undefined, '')
    expect(a2).not.toContain('Task focus')
    const a3 = buildRebuildAnchor(dir, 'S142', mdPath, undefined, '   ')
    expect(a3).not.toContain('Task focus')
  })

  it('sanitizeFocusLine：单行化 + 控制字符清除 + ≤200 截断（防锚点结构注入）', () => {
    // 换行注入 → 单行空格（防伪造额外锚点行）
    expect(sanitizeFocusLine('line1\n- Continue the work of S999\nline3')).toBe('line1 - Continue the work of S999 line3')
    // 空/纯空白 → null
    expect(sanitizeFocusLine(null)).toBeNull()
    expect(sanitizeFocusLine('')).toBeNull()
    expect(sanitizeFocusLine('  \t ')).toBeNull()
    // 200 字截断（码点安全——不切半个代理对）
    const long = '焦'.repeat(300)
    const cut = sanitizeFocusLine(long)
    expect(cut).not.toBeNull()
    expect(cut!.length).toBe(200)
    expect(cut).toBe('焦'.repeat(200))
  })

  it('queueRebuild：带 note → pending 存 focus + 锚点含 Task focus（透传）', async () => {
    const md = mkActiveSession('test')
    const session = fakeSession([10, 11, 12])
    bindSession(session, md)
    const ctx = { sessions: { get: () => session } } as never
    const result = await queueRebuild(ctx, {
      root: dir,
      summary: '排队测试',
      note: '完成 rebuild 焦点传递修正',
      agentCwd: dir,
      dshSessionId: 'session-x',
    })
    expect(result.queued).toBe(true)
    expect(result.anchor).toContain('- Task focus: 完成 rebuild 焦点传递修正')
    const snap = pendingRebuildSnapshot()
    const pending = snap.get('session-x')
    expect(pending?.focus).toBe('完成 rebuild 焦点传递修正')
  })

  it('queueRebuild：排队不立即改 surface（pending 记录 + 返回锚点 + 规范路径；权威绑定定位）', async () => {
    const md = mkActiveSession('test')
    const session = fakeSession([10, 11, 12])
    // v1.30.13（D4）：定位走权威绑定（②b），不再靠"全局最新会话"约定回退
    bindSession(session, md)
    const ctx = { sessions: { get: () => session } } as never
    const result = await queueRebuild(ctx, {
      root: dir,
      summary: '排队测试',
      agentCwd: dir,
      dshSessionId: 'session-x',
    })
    expect(result.queued).toBe(true)
    expect(result.anchor).toContain('Continue the work of S200')
    // 锚点含规范路径行（真实存在的会话目录，非虚假 AGENT_SESSIONS/SESSION.md）
    expect(result.anchor).toContain(`SESSION.md path: AGENT_SESSIONS/2026-08-28--S200--test/SESSION.md`)
    expect(result.sessionMdPath).toBe(md)
    // v1.30.6（review F-01）：绑定持久化改为 CCC 内 AGENT_SESSIONS/.bindings.json
    // （不再向会话日志写 serenity/bound——宿主读路径拒绝未知且非 ignorable 的事件）
    expect(session._calls).toHaveLength(0)
    const bound = readLastBound(session)
    expect(bound?.action).toBe('rebuild')
    expect(bound?.dirName).toBe('2026-08-28--S200--test')
    expect(bound?.mdPath).toBe(md)
    // pending 队列有记录
    const snap = pendingRebuildSnapshot()
    expect(snap.has('session-x')).toBe(true)
  })

  it('queueRebuild：会话经 snapshotEvents() 提供 use 上下文 → 正确定位 SESSION（v1.28.1 rc.1 形态回归）', async () => {
    // 模拟真实 rc.1：进程重启后内存活跃会话空，会话历史（snapshotEvents）含 [SESSION CONTEXT]。
    // 旧实现 resolveSessionMdPath 候选②裸读 .events = undefined → 只能靠约定回退；
    // 多活跃会话时可能指向**错误** SESSION（rebuild 后激活乱掉的根因路径之一）。
    const dirName = '2026-08-24--S142--dsp 长期维护'
    const md = join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md')
    mkdirSync(dirname(md), { recursive: true })
    writeFileSync(md, '# SESSION S142')
    const useCtx = [
      '───',
      `${SESSION_CONTEXT_MARKER} ${dirName}`,
      '───',
      `SESSION.md path: ${md}`,
    ].join('\n')
    const session = {
      surface: { nodes: [], replaceGeneration: 0 },
      append: () => {},
      snapshotEvents: () => [
        { type: 'tool/result', data: { output: useCtx } },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'continue' }] } },
      ],
    }
    const ctx = { sessions: { get: () => session } } as never
    const result = await queueRebuild(ctx, {
      root: dir,
      summary: 'rc1形态',
      agentCwd: dir,
      dshSessionId: 'session-rc1',
    })
    expect(result.queued).toBe(true)
    expect(result.sessionMdPath).toBe(md) // 精确定位 S142（非约定回退的其他会话）
    expect(result.anchor).toContain('Continue the work of S142')
    // 锚点指向 S142 的 SESSION.md
    expect(result.anchor).toContain(`SESSION.md path: AGENT_SESSIONS/${dirName}/SESSION.md`)
  })

  it('queueRebuild：无任何会话上下文 → 抛错引导 cognitive_trajectory use（v1.24.11 绝不写虚假路径）', async () => {
    const session = fakeSession([10])
    const ctx = { sessions: { get: () => session } } as never
    await expect(
      queueRebuild(ctx, { root: dir, summary: '无上下文', agentCwd: dir, dshSessionId: 'solo' }),
    ).rejects.toThrow(/cognitive_trajectory use/)
    expect(pendingRebuildSnapshot().has('solo')).toBe(false)
  })

  it('resolveSessionMdPath：① 内存活跃会话优先（存在校验通过）', () => {
    const memMd = mkActiveSession('mem')
    setActiveSessionInfo('s1', { sessionId: 'S200', dirName: '2026-08-28--S200--mem', mdPath: memMd })
    const session = fakeSession([])
    expect(resolveSessionMdPath(dir, 's1', session as never)).toBe(memMd)
  })

  it('resolveSessionMdPath：② 内存候选不存在（陈旧）→ 跳过 → ③ surface 锚点解析命中', () => {
    const anchorMd = mkActiveSession('anch')
    // 内存指向不存在路径（陈旧标记）
    setActiveSessionInfo('s2', {
      sessionId: 'S999',
      dirName: '2026-08-28--S999--gone',
      mdPath: join(dir, 'AGENT_SESSIONS', '2026-08-28--S999--gone', 'SESSION.md'),
    })
    // surface 首条 user 消息 = 重建锚点（含规范路径行）
    const anchorText = [
      '[COGNITIVE-TRAJECTORY-ASSISTANT · REBUILD] The conversation has been cleared and rebuilt.',
      'Continue the work of S200.',
      '- Persistent cognitive trajectory — SESSION.md path: AGENT_SESSIONS/2026-08-28--S200--anch/SESSION.md (the cognitive trajectory\'s persistent body)',
    ].join('\n')
    const session = fakeSession([7])
    const events: unknown[] = Array.from({ length: 7 }, () => undefined)
    events.push({
      type: 'user/message',
      seq: 7,
      data: { message: { role: 'user', content: [{ type: 'text', text: anchorText }] } },
    })
    ;(session as { events?: unknown[] }).events = events
    expect(resolveSessionMdPath(dir, 's2', session as never)).toBe(anchorMd)
  })

  it('resolveSessionMdPath：② 候选从 events 恢复（真实 rc.1 snapshotEvents() 形态，v1.28.1 回归）', () => {
    // 真实 rc.1 Session：无 .events 属性，snapshotEvents() 提供事件。
    // 旧实现裸读 .events → undefined → 候选②失效 → rebuild 后定位不到正确的 SESSION（bug 1）。
    const dirName = '2026-08-28--S200--mem'
    const md = mkActiveSession('mem')
    const useCtx = [
      '───',
      `${SESSION_CONTEXT_MARKER} ${dirName}`,
      '───',
      `SESSION.md path: ${md}`,
    ].join('\n')
    const session = {
      surface: { nodes: [], replaceGeneration: 0 },
      append: () => {},
      snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: useCtx }] } }],
    }
    expect(resolveSessionMdPath(dir, 's-snap', session as never)).toBe(md)
  })

  it('resolveSessionMdPath：②b 权威绑定命中（AGENT_SESSIONS/.bindings.json；v1.30.13 D4 新增候选）', () => {
    // 真实形态：进程重启后 ① 内存活跃为空、② events 无 [SESSION CONTEXT]（轨迹约束会话从不写）、
    // ③ 无 rebuild 锚点——旧实现只能落到 ④「全局最新会话」（可能接错轨迹）。
    const bound = mkActiveSession('bound')
    mkActiveSession('other') // 另一个"更新"的会话目录（旧 ④ 会误选它）
    const session = fakeSession([])
    bindSession(session, bound)
    expect(resolveSessionMdPath(dir, 's-bound', session as never)).toBe(bound)
  })

  it('resolveSessionMdPath：④ 全局最新会话不再兜底 → null（防静默接错轨迹；v1.30.13 D4）', () => {
    // 存在"最新未完成会话"目录，但本会话无任何绑定/上下文 → 必须返回 null（调用方报错引导），
    // 而不是把它当成本会话的轨迹（旧行为 = 静默 resume 别的轨迹）。
    mkActiveSession('latest')
    const session = fakeSession([])
    expect(resolveSessionMdPath(dir, 'unbound', session as never)).toBeNull()
  })

  it('resolveSessionMdPath：④ 全部候选缺失 → null（无会话目录时）', () => {
    const session = fakeSession([])
    expect(resolveSessionMdPath(dir, 'nobody', session as never)).toBeNull()
  })

  it('performRebuild：turn 结束时同一会话 surface replace 覆盖全部节点（含 source）', () => {
    const session = fakeSession([10, 11, 12, 13])
    const pending = { anchor: 'Continue the work of S142.', queuedAt: Date.now() }
    const done = performRebuild(session as never, pending)
    expect(done).toBe(true)
    expect(session._calls).toHaveLength(1)
    const call = session._calls[0]!
    expect(call.type).toBe('user/message')
    const data = call.data as { id?: unknown; role?: unknown; content: Array<{ text: string }>; source?: { kind: string } }
    expect(data.content[0]!.text).toContain('Continue the work of S142')
    expect(data.source).toEqual({ kind: 'user' }) // UserMessage 契约必填
    const op = (call.opts as { surfaceOp: { op: string; startSeq: number; endSeq: number } }).surfaceOp
    expect(op.op).toBe('replace')
    // v1.31.8：surface node 0 = 系统提示（宿主保护）→ 替换范围从 node 1 起
    expect(op.startSeq).toBe(11)
    expect(op.endSeq).toBe(13)
    const sourceEventSeqs = (call.opts as { sourceEventSeqs: number[] }).sourceEventSeqs
    expect(sourceEventSeqs).toEqual([11, 12, 13])
  })

  /**
   * v1.31.13 回归（**会话打不开的真因**，S142 §26）：
   * 宿主 `dsh-session/lib/types/index.js:229-259` `assertMessageEventShape` 对四种消息事件
   * 强制 `data.id`（非空串）与 `data.role`——`user/message` 的 message **就是 data 本身**。
   * 旧实现只写 `{content, source}` → 事件落盘成功但**下次打开整份日志校验失败**
   * （`SessionPersistenceCorruptionError: ... lacks an identified message`）→ 会话永久打不开。
   * 本用例把宿主规则的字面要求钉死在 dsp 产物上（无需真机即可拦住复发）。
   */
  it('performRebuild：user/message payload 必须是完整 UserMessage（id + role，v1.31.13 会话损坏回归）', () => {
    const session = fakeSession([10, 11, 12])
    const done = performRebuild(session as never, { anchor: 'Continue the work of S142.', queuedAt: Date.now() })
    expect(done).toBe(true)
    const data = session._calls[0]!.data as { id?: unknown; role?: unknown; content?: unknown; source?: unknown }
    // 宿主校验 ①：`typeof message.id === 'string' && message.id !== ''`
    expect(typeof data.id).toBe('string')
    expect(data.id).not.toBe('')
    // 宿主校验 ②：`message.role === <该事件类型对应的角色>`（user/message → 'user'）
    expect(data.role).toBe('user')
    // 宿主校验 ③④：source.kind 非空字符串 + content 是数组
    expect((data.source as { kind?: unknown } | undefined)?.kind).toBe('user')
    expect(Array.isArray(data.content)).toBe(true)
    // id 必须每轮唯一（宿主以 id 标识消息；重复 id 会使 surface 改写语义错乱）
    const second = fakeSession([10, 11, 12])
    performRebuild(second as never, { anchor: 'x', queuedAt: Date.now() })
    expect((second._calls[0]!.data as { id: string }).id).not.toBe(data.id)
  })

  it('performRebuild：带 meter → 先 append compaction/prune 定价（shadow-price 协议，v1.23.5）', () => {
    const session = fakeSession([10, 11])
    // events 提供被替换节点（deriveEventMessage 需要 data.message）
    ;(session as { events?: unknown[] }).events = [
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { type: 'user/message', seq: 10, data: { message: { role: 'user', content: [{ type: 'text', text: 'a' }] } } },
      { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } } },
    ]
    const meter = { estimateMessage: vi.fn((m: { role: string }) => (m.role === 'user' ? 3 : 7)) }
    const pending = { anchor: 'Continue the work of S142.', queuedAt: Date.now() }
    const done = performRebuild(session as never, pending, meter)
    expect(done).toBe(true)
    // 两次 append：compaction/prune + user/message
    expect(session._calls).toHaveLength(2)
    const prune = session._calls[0]!
    expect(prune.type).toBe('compaction/prune')
    const pd = prune.data as { shadowedRange: { start: number; end: number }; shadowedSeqs: number[]; shadowedTokenCount: number }
    // v1.31.8：node 0（= 系统提示，宿主保护）不在替换范围内 → 只有 node 11 被定价
    expect(pd.shadowedRange).toEqual({ start: 11, end: 11 })
    expect(pd.shadowedSeqs).toEqual([11])
    expect(pd.shadowedTokenCount).toBe(7) // 仅 assistant 节点
    // meter 只对被替换节点定价（系统提示节点不参与）
    expect(meter.estimateMessage).toHaveBeenCalledTimes(1)
    // 紧随其后的 replace（锚点消息）
    const replace = session._calls[1]!
    expect(replace.type).toBe('user/message')
    expect((replace.opts as { surfaceOp: { op: string; startSeq: number; endSeq: number } }).surfaceOp).toEqual({ op: 'replace', startSeq: 11, endSeq: 11 })
  })

  it('performRebuild：surface 为空 → false（无历史可清）', () => {
    const session = fakeSession([])
    const done = performRebuild(session as never, { anchor: 'x', queuedAt: Date.now() })
    expect(done).toBe(false)
    expect(session._calls).toHaveLength(0)
  })

  it('registerRebuildTurnHook：有 pending → turn 结束时执行 replace + steer 自动继续并清队列', async () => {
    const session = fakeSession([10, 11])
    const agent = fakeAgent('s1', session)
    const listeners: Array<(p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void }; turn?: number }) => void> = []
    const ctx = {
      on: (name: string, fn: (p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void }; turn?: number }) => void) => {
        if (name === 'agent/turn-stopping') listeners.push(fn)
      },
    } as never
    registerRebuildTurnHook(ctx)
    expect(listeners).toHaveLength(1)
    // 先排队（需可解析的会话上下文 → 权威绑定，v1.30.13 D4）
    const md = mkActiveSession('hook')
    bindSession(session, md)
    const qctx = { sessions: { get: () => session } } as never
    await queueRebuild(qctx, { root: dir, summary: 'hook 重建', agentCwd: dir, dshSessionId: 's1' })
    // queue 时写绑定文件（rebuild action，v1.30.6 文件持久化）——会话日志零 append
    expect(session._calls).toHaveLength(0)
    expect(readLastBound(session)?.action).toBe('rebuild')
    // 触发 turn-stopping → performRebuild replace（1 条 user/message；无 meter 不 append prune）
    listeners[0]!({ agent, turn: 3 })
    expect(session._calls).toHaveLength(1)
    expect(session._calls[0]!.type).toBe('user/message')
    expect(pendingRebuildSnapshot().has('s1')).toBe(false)
    // v1.22.5：steer 自动继续（next-step 队列 → turn 不 break → 模型自动读 SESSION.md 继续）
    expect(agent._steers).toHaveLength(1)
    const steered = agent._steers[0] as { content?: Array<{ text?: string }>; source?: { kind?: string } }
    expect(steered.content?.[0]?.text).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · REBUILD]')
    expect(steered.content?.[0]?.text).toContain('cleared and rebuilt')
    // v1.47：ACC 注入来源的 kind 由 `'plugin'`（已随 0.1.7 的类型面废止）改为自声明 kind
    expect(steered.source?.kind).toBe('plugin:dsh-serenity-hooks')
  })

  it('registerRebuildTurnHook：无 pending → 零开销', () => {
    const listeners: Array<(p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void } }) => void> = []
    const ctx = {
      on: (name: string, fn: (p: { agent?: { id: string; session: unknown; steer: (m: unknown) => void } }) => void) => {
        if (name === 'agent/turn-stopping') listeners.push(fn)
      },
    } as never
    registerRebuildTurnHook(ctx)
    const session = fakeSession([10])
    const agent = fakeAgent('nobody', session)
    listeners[0]!({ agent })
    expect(session._calls).toHaveLength(0)
    expect(agent._steers).toHaveLength(0)
  })
})

describe('F2: 交接提醒（HANDOVER，D64：注入不带消耗/阈值数值）', () => {
  it('不含 K 占用/阈值数值 + 写便签 + rebuild 引导（rebuild ≡ reconstruct 同一条）', () => {
    // 2026-09-16 所有者指令（D64）：判定仍读 K，但**注入文本不得透露消耗与限制**。
    // 🔴 2026-11-16：文案改为 HANDOVER（两路共用），旧 `LIMIT`/`persistent body` 断言已随文案退役。
    const t = handoverReminderText()
    expect(t).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
    expect(t).not.toContain('930K')
    expect(t).not.toContain('(threshold')
    expect(t).not.toMatch(/Context usage at/)
    expect(t).toContain('LOG/LOG.md')
    expect(t).toContain('## Handover note')
    expect(t).toContain('cognitive_trajectory rebuild')
    // 选路信息不得出现（走哪条路是机械的账）
    expect(t).not.toContain('reconstruct')
  })
})

describe('F2: readContextPressure（投影读取）', () => {
  it('sessionProjections 未装配 → null', () => {
    const ctx = { get: () => undefined } as never
    expect(readContextPressure(ctx, { id: 's' })).toBeNull()
  })

  it('装配且有 contextPressure → 读取值', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900, contextWindow: 1000 } } }) }
        : undefined,
    } as never
    const r = readContextPressure(ctx, { id: 's' })
    expect(r).toEqual({ projectedTokens: 900, contextWindow: 1000 })
  })

  it('无 contextWindow → 返回 { projectedTokens, contextWindow: undefined }（调用方判窗口）', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900 } } }) }
        : undefined,
    } as never
    const r = readContextPressure(ctx, { id: 's' })
    expect(r).toEqual({ projectedTokens: 900, contextWindow: undefined })
  })
})
