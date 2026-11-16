/**
 * bootstrap-register.test.ts — 拦截缝 `registerBootstrap` 的 **行为**测试（S142 ⑤ 分层单元测试·第 2 件）
 *
 * 🔴 **为何单开一个文件**：`tests/bootstrap.test.ts` 只覆盖纯函数
 * （`createEpochPromotion` / `hasUserMessageHistory` / `resolveBootstrapSettings`）；
 * 而 `registerBootstrap` 在全仓**只被 `src/index.ts` 调用**（grep 实证：无任何测试调它）
 * ⇒ **四条缝的处理器体（"首锚"机制的实际效果）无直接测试**。
 * 本文件补的正是这一块：**目录窄化**（system-prompt/assemble）＋ **剥离自动注入上下文**
 * （agent/pre-step）＋ **锚定轮注入**（agent/inbox/inserted）。
 *
 * **分层**：L2（服务与适配）的装配测试（约束文档 §5.2 / §5.1-T3），与纯函数测试分开。
 *
 * **替身与安全性**（读源码后确认，非猜测）：
 *   · `ctx` = 只记录 handler 的最小对象（第三参 `{prepend:true}` 被忽略，符合替身「同形」原则）
 *   · `agent` = `{ session, inbox?, id? }`；`agentRoot()` 靠 `session.header.cwd` → `cccRootForCwd`
 *   · `bootstrap.ts` 对宿主的引用**全是 `import type`**（Context / Agent / UserMessage /
 *     PromptAssembly）⇒ 运行时无需 mock 任何宿主包
 *   · `SETTINGS` 是**模块级固化常量**（协议固有、零配置面）⇒ 测试断言对**导出常量**取，
 *     不硬编码字面量（`DEFAULT_FAKE_INITIAL_MESSAGES` / `DEFAULT_COMPACTION_TOOLS`），改常量不会假红
 *   · ⚠️ `warnOnce` 是"只喊一次"的模块级函数 ⇒ **本文件不断言日志**（否则用例间互相干扰）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerBootstrap, DEFAULT_FAKE_INITIAL_MESSAGES, FAKE_TURN_SUMMARY, FAKE_TURN_ACK_TEXT, DEFAULT_COMPACTION_TOOLS } from '../../src/seams/bootstrap.js'
// 不硬编码字面量：插件来源 kind 的**单一真相源**在 kernel/message-source.ts
import { ACC_MESSAGE_KIND } from '../../src/kernel/message-source.js'
// 🔴 2026-10-19 轨迹约束 重做：判据 = 绑定轨迹里有 `trajectory-constraint.json`（不再是 sessionId 前缀）
//    ⇒ 本文件里"这个会话是 轨迹约束"的两处都必须**真造一条轨迹**（夹具唯一入口）。
import { make轨迹约束Session, 轨迹约束Json } from '../helpers/trajectory-constraint-fixture.js'

type Handler = (...args: unknown[]) => unknown

interface FakeCtx {
  handlers: Map<string, Handler[]>
  on: (name: string, fn: Handler) => FakeCtx
}

function fakeCtx(): FakeCtx {
  const handlers = new Map<string, Handler[]>()
  const ctx: FakeCtx = {
    handlers,
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return ctx
    },
  }
  return ctx
}

/** 假 agent：`events` 供 createEpochPromotion 的 scan 读（session/event 走 sessionEvents） */
function fakeAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session: { id, ...extra } }
}

function first(ctx: FakeCtx, name: string): Handler {
  const h = (ctx.handlers.get(name) ?? [])[0]
  if (!h) throw new Error(`handler not registered: ${name}`)
  return h
}

let dir: string
let outside: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-bootseam-')) // 有 .serenity ⇒ 认作 CCC 根
  writeFileSync(join(dir, '.serenity'), 'test')
  outside = mkdtempSync(join(tmpdir(), 'hooks-bootout-')) // 无 .serenity ⇒ 不在任何 CCC
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

// ── 接线 ────────────────────────────────────────────────────────────────────

describe('registerBootstrap: 接线', () => {
  it('装五条缝：session/event ／ agent/inbox/inserted ／ llm/stream ／ system-prompt/assemble ／ agent/pre-step', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    for (const name of ['session/event', 'agent/inbox/inserted', 'llm/stream', 'system-prompt/assemble', 'agent/pre-step']) {
      expect(ctx.handlers.get(name), name).toHaveLength(1)
    }
  })
})

// ── system-prompt/assemble：首锚「目录窄化」 ────────────────────────────────

describe('registerBootstrap: system-prompt/assemble —— 首锚目录窄化', () => {
  /** 造一条 assemble 调用：返回处理器结果 */
  async function assemble(ctx: FakeCtx, agent: unknown, tools: unknown): Promise<unknown> {
    const h = first(ctx, 'system-prompt/assemble')
    return h({}, { agent }, async () => ({ tools }))
  }

  const fullCatalog = () => [
    { name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' },
    { name: 'todo_write' }, { name: 'unrelated_tool' },
  ]

  it('CCC 内、未晋升、boundary < 0 ⇒ **完整目录**（v1.62 / D140：首请求不再收窄）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const agent = fakeAgent('main-boot-1', { header: { cwd: dir } }) // 无 events ⇒ boundary -1

    const out = (await assemble(ctx, agent, fullCatalog())) as { tools: unknown[] }
    // 🔴 断言语义变更（v1.62）：锚定历史只造 user 消息 ⇒ 首请求时晋升信号尚未满足，
    //    而**目的正是取消那个工具断点** ⇒ 若仍收窄成 5 个工具，只是把「空→满」换成「窄→满」，白改。
    expect(out.tools).toHaveLength(fullCatalog().length)
  })

  it('非 CCC（cwd 无 .serenity）⇒ 原样返回完整目录', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const agent = fakeAgent('main-boot-2', { header: { cwd: outside } })

    const out = (await assemble(ctx, agent, fullCatalog())) as { tools: unknown[] }
    expect(out.tools).toHaveLength(fullCatalog().length)
  })

  it('cheap-worker/轨迹约束会话**恒晋升** ⇒ 原样返回完整目录（无锚定轮）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    // 🔴 2026-10-19：轨迹约束 一半必须**真造轨迹**——否则 `轨迹约束-` 前缀早已不是判据，
    //    走的还是普通分支，而"普通 + 未晋升"同样返回完整目录 ⇒ 这条会**假绿**。
    //    （判据恒等的局限是既有的：本缝对外只暴露 `tools`，无法区分 promoted 与 boundary<0。）
    make轨迹约束Session(dir, '轨迹约束-qa-boot-1', 'qa-boot-1', 轨迹约束Json({}), 'boot')
    for (const id of ['cheap-worker-worker-1', '轨迹约束-qa-boot-1']) {
      const out = (await assemble(ctx, fakeAgent(id, { header: { cwd: dir } }), fullCatalog())) as { tools: unknown[] }
      expect(out.tools, id).toHaveLength(fullCatalog().length)
    }
  })

  it('已达 requiredSignals（= 假首轮条数）⇒ 晋升 ⇒ 原样返回完整目录', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    // boundary 5 之后再攒够 requiredSignals 条 assistant/message
    const events = [
      { type: 'compaction/end', seq: 5 },
      ...DEFAULT_FAKE_INITIAL_MESSAGES.map((_, i) => ({ type: 'assistant/message', seq: 6 + i })),
    ]
    const out = (await assemble(ctx, fakeAgent('main-boot-3', { header: { cwd: dir }, events }), fullCatalog())) as { tools: unknown[] }
    expect(out.tools).toHaveLength(fullCatalog().length)
  })

  it('boundary ≥ 0 且 compactionTools 齐全 ⇒ 窄化到 compactionTools（压缩后继续任务）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const events = [{ type: 'compaction/end', seq: 5 }] // boundary 5、未晋升
    const out = (await assemble(ctx, fakeAgent('main-boot-4', { header: { cwd: dir }, events }), fullCatalog())) as { tools: { name: string }[] }

    const kept = out.tools.map((t) => t.name).sort()
    expect(kept).toEqual([...DEFAULT_COMPACTION_TOOLS].sort())
    expect(kept).not.toContain('unrelated_tool')
  })

  it('boundary ≥ 0 但 compactionTools **缺一** ⇒ 降级完整目录（组合漂移不锁死会话）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const events = [{ type: 'compaction/end', seq: 5 }]
    // 故意去掉 DEFAULT_COMPACTION_TOOLS 的最后一个
    const missingName = DEFAULT_COMPACTION_TOOLS[DEFAULT_COMPACTION_TOOLS.length - 1]!
    const tools = fullCatalog().filter((t) => t.name !== missingName)

    const out = (await assemble(ctx, fakeAgent('main-boot-5', { header: { cwd: dir }, events }), tools)) as { tools: unknown[] }
    expect(out.tools).toHaveLength(tools.length) // 原样返回，不窄化
  })

  it('tools 不是数组 ⇒ 原样返回（防御）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const assembled = { tools: 'not-an-array' }
    const h = first(ctx, 'system-prompt/assemble')
    const out = await h({}, { agent: fakeAgent('main-boot-6', { header: { cwd: dir } }) }, async () => assembled)
    expect(out).toEqual(assembled)
  })
})

// ── agent/pre-step：首锚「剥离自动注入上下文」 ──────────────────────────────

describe('registerBootstrap: agent/pre-step —— 首锚剥离注入上下文', () => {
  async function preStep(ctx: FakeCtx, agent: unknown, decision: unknown): Promise<unknown> {
    const h = first(ctx, 'agent/pre-step')
    return h({ agent }, async () => decision)
  }

  const msg = (kind?: string) => ({ source: kind === undefined ? undefined : { kind } })

  it('未晋升 + 含 suppressedSources（skill-catalog / agent-instructions）⇒ 剥掉它们', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = {
      kind: 'enter',
      messages: [msg('skill-catalog'), msg('user'), msg('agent-instructions'), msg(undefined)],
    }

    const out = (await preStep(ctx, fakeAgent('main-boot-7', { header: { cwd: dir } }), decision)) as { messages: unknown[] }
    expect(out.messages).toHaveLength(2) // 只剩 user 与无 source 的那条
    expect(out.messages[0]).toEqual(msg('user'))
    expect(out.messages[1]).toEqual(msg(undefined))
  })

  it('未晋升 + 无被抑制来源 ⇒ **返回同一个对象**（不重建，零漂移）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: [msg('user'), msg('assistant')] }

    const out = await preStep(ctx, fakeAgent('main-boot-8', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision) // 身份相同 ⇒ 证明走的是 early-return 而非重建
  })

  it('已晋升（cheap-worker/轨迹约束恒晋升）⇒ 原样返回，不剥离', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: [msg('skill-catalog')] }

    const out = await preStep(ctx, fakeAgent('cheap-worker-worker-2', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision)
  })

  it('非 CCC ⇒ 原样返回', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: [msg('skill-catalog')] }

    const out = await preStep(ctx, fakeAgent('main-boot-9', { header: { cwd: outside } }), decision)
    expect(out).toBe(decision)
  })

  it('下游 kind=reject ⇒ 原样返回（不干预拒绝）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'reject', messages: [msg('skill-catalog')] }

    const out = await preStep(ctx, fakeAgent('main-boot-10', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision)
  })

  it('messages 不是数组 ⇒ 原样返回（防御）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: 'nope' }

    const out = await preStep(ctx, fakeAgent('main-boot-11', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision)
  })
})

// ── fake-initial-turns：注入（agent/inbox/inserted）＋ 短路（llm/stream）──────

describe('registerBootstrap: fake-initial-turns —— 注入假首轮（2026-11-16 起一条）＋ 短路模型回复', () => {
  type Queued = {
    role?: string
    content?: Array<{ text?: string }>
    source?: { kind?: string; summary?: string }
  }

  /** 假 agent：`inbox.prepend` 记录器（**unshift 语义**，与宿主一致） */
  function inboxAgent(id: string, extra: Record<string, unknown> = {}): { agent: Record<string, unknown>; queue: Queued[] } {
    const queue: Queued[] = []
    const agent = {
      session: { id, ...extra },
      inbox: {
        prepend: (_target: string, message: unknown) => {
          queue.unshift(message as Queued)
        },
      },
    }
    return { agent, queue }
  }

  /** 注入时机 = 新会话第一条**真实**用户消息进 inbox */
  const fireInserted = (ctx: FakeCtx, agent: unknown, kind = 'user') =>
    first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind } } })

  /** 造一条模型请求：`text` 是"最近一条人写的话" */
  const request = (sessionId: string, text: string, sourceKind?: string) => ({
    sessionId,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text }],
        ...(sourceKind === undefined ? {} : { source: { kind: sourceKind } }),
      },
    ],
  })

  /** 把短路流抽干（形状断言用） */
  async function drain(stream: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    for await (const chunk of stream) out.push(chunk as Record<string, unknown>)
    return out
  }

  /** 调用 llm/stream 处理器；`nextCalled` 记录**真调用**是否被放行 */
  async function streamCall(
    ctx: FakeCtx,
    options: unknown,
  ): Promise<{ nextCalled: boolean; chunks: Array<Record<string, unknown>> }> {
    let nextCalled = false
    const next = () => {
      nextCalled = true
      return (async function* () {
        yield { type: 'REAL' }
      })()
    }
    const out = await first(ctx, 'llm/stream')(options, next)
    return { nextCalled, chunks: await drain(out as AsyncIterable<unknown>) }
  }

  it('注入：按**正序**排队 ⇒ [假首轮①, 假首轮②, 真实消息]（逆序 prepend 的净效果）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, queue } = inboxAgent('main-boot-12', { header: { cwd: dir }, events: [] })

    fireInserted(ctx, agent)

    expect(queue).toHaveLength(DEFAULT_FAKE_INITIAL_MESSAGES.length)
    expect(queue.map((q) => q.content?.[0]?.text)).toEqual([...DEFAULT_FAKE_INITIAL_MESSAGES])
    // 带 ACC 标记 ⇒ ① 递归守卫认它 ② 拦截判据认它（两处同源）
    for (const q of queue) {
      expect(q.source?.kind).toBe(ACC_MESSAGE_KIND)
      expect(q.source?.summary).toBe(FAKE_TURN_SUMMARY)
    }
  })

  it('🔴 两条都不调 `next()`：**请求根本不发给模型**（owner 令「拦截 LLM」）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent } = inboxAgent('main-boot-13', { header: { cwd: dir }, events: [] })
    fireInserted(ctx, agent)

    for (const text of DEFAULT_FAKE_INITIAL_MESSAGES) {
      const { nextCalled, chunks } = await streamCall(ctx, request('main-boot-13', text, ACC_MESSAGE_KIND))
      expect(nextCalled, '假首轮不许落到真调用').toBe(false)
      // 形状：text 块 → usage 全零 → finish(stop)
      expect(chunks[0]).toMatchObject({ type: 'block-start', blockType: 'text' })
      expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual([FAKE_TURN_ACK_TEXT])
      expect(chunks.some((c) => c.type === 'usage' && (c as { usage?: { outputTokens?: number } }).usage?.outputTokens === 0)).toBe(true)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    }
  })

  it('🔴 假首轮兑现完之后：真实用户消息**必须放行**给模型（不许被吞）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent } = inboxAgent('main-boot-14', { header: { cwd: dir }, events: [] })
    fireInserted(ctx, agent)

    for (const text of DEFAULT_FAKE_INITIAL_MESSAGES) {
      await streamCall(ctx, request('main-boot-14', text, ACC_MESSAGE_KIND))
    }
    const real = await streamCall(ctx, request('main-boot-14', 'please fix the bug'))
    expect(real.nextCalled, '登记清零后必须回到真调用').toBe(true)
    expect(real.chunks).toEqual([{ type: 'REAL' }])
  })

  it('🔴 文本不符（真人的话）⇒ 即便登记还在也**不拦**（误拦会吞掉真实请求）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent } = inboxAgent('main-boot-15', { header: { cwd: dir }, events: [] })
    fireInserted(ctx, agent)

    const { nextCalled } = await streamCall(ctx, request('main-boot-15', 'hello, are you there?', 'user'))
    expect(nextCalled).toBe(true)
  })

  it('未登记的会话 ⇒ 一律放行（别的会话不受影响）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { nextCalled } = await streamCall(ctx, request('other-session', DEFAULT_FAKE_INITIAL_MESSAGES[0]!, ACC_MESSAGE_KIND))
    expect(nextCalled).toBe(true)
  })

  it('已有**真人历史**的会话 ⇒ 不注入（resume/续跑不重插）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, queue } = inboxAgent('main-boot-16', {
      header: { cwd: dir },
      events: [{ type: 'user/message', seq: 1, data: { source: { kind: 'user' } } }],
    })

    fireInserted(ctx, agent)
    expect(queue).toHaveLength(0)
  })

  it('cheap-worker / 自带章程的轨迹 ⇒ 不注入（轨迹自带完整提示词）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    // 🔴 2026-10-20 D183：判据 = 「**自带章程**」；只写 tools/model/resident 不触发旁路。
    make轨迹约束Session(dir, '轨迹约束-qa-boot-2', 'qa-boot-2', 轨迹约束Json({ systemPromptFile: 'charter.md' }), 'boot')
    for (const id of ['cheap-worker-worker-3', '轨迹约束-qa-boot-2']) {
      const { agent, queue } = inboxAgent(id, { header: { cwd: dir }, events: [] })
      fireInserted(ctx, agent)
      expect(queue, id).toHaveLength(0)
    }
  })

  it('我们自己的 ACC 消息进队列 ⇒ 不递归注入（否则每轮都插两轮）', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, queue } = inboxAgent('main-boot-17', { header: { cwd: dir }, events: [] })

    fireInserted(ctx, agent, ACC_MESSAGE_KIND)
    expect(queue).toHaveLength(0)
  })

  it('非 CCC（cwd 无 .serenity）⇒ 不注入', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, queue } = inboxAgent('main-boot-18', { header: { cwd: outside }, events: [] })

    fireInserted(ctx, agent)
    expect(queue).toHaveLength(0)
  })
})
