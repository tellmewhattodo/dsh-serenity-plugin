/**
 * context-register.test.ts — 拦截缝 `registerContext` 的 **行为**测试（S142 ⑤ 分层单元测试）
 *
 * 🔴 **为何单开一个文件**：`tests/context.test.ts` 只覆盖 `seams/context.ts` 的**纯函数**
 * （`accIdentityText` / `accMessage` / `shouldAutoRestore` / `shouldRestoreActive`）⇒
 * coverage 实测该模块 **43.85%**，而 `registerContext`（`src/seams/context.ts` 的 147–285）
 * **从未被执行** —— 那是"缝的接线与效果"，恰是本模块对系统真正起作用的部分。
 * 本文件补的就是这一块。
 *
 * **分层**：本条属 L2（服务与适配）的**装配测试**（约束文档 §5.2），与同目录的纯函数测试分开。
 *
 * **替身与安全性**（读源码后确认，非猜测 —— fake ctx 有已知盲区，故必须逐条核）：
 *   · `ctx` = 只记录 handler 的最小对象（不模拟 cordis Proxy）
 *   · `agent` = `{ session, inject }`
 *   · `registerEntrySkillSection` 内部 **try/catch** ⇒ 缺 `agent.ctx` 只是返回 false，**不抛**
 *   · `registerCognitiveTrajectorySkillSection` 内部 try/catch ＋ `readLastBound()` 无绑定即**早返回**
 *   ⇒ 二者都在 `agent.inject(...)` **之前**，既然都不抛，注入就一定会发生 ⇒ 断言可靠
 *   · 注入**之后**的 `syncSafeModeRestriction` 等即使抛，也被 `agent/created` 处理器自己的
 *     try/catch 吞掉（不影响已发生的注入）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `accMessage` 走宿主构造器；替身让它恒等返回，便于直接读正文
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { registerContext } from '../../src/seams/context.js'
import { getActiveSessionInfo } from '../../src/trajectory/core.js'
import { REGISTERED_TOOLS } from '../../src/kernel/invariant.js'
import { forgetNonCccToolVisibility } from '../../src/seams/guards.js'
import { forgetToolVisibility } from '../../src/seams/tool-visibility.js'
// 🔴 2026-10-19 轨迹约束 重做：判据 = 绑定轨迹里有 `trajectory-constraint.json`（不再是 sessionId 前缀）
//    ⇒ "这个会话是 轨迹约束" 必须**真造一条轨迹**，统一走夹具（tests/helpers/trajectory-constraint-fixture.ts）。
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

function fakeAgent(id: string, extra: Record<string, unknown> = {}): { agent: unknown; injected: unknown[] } {
  const injected: unknown[] = []
  return {
    agent: {
      session: { id, ...extra },
      inject: (m: unknown) => {
        injected.push(m)
      },
    },
    injected,
  }
}

/** 取注入消息正文（`createUserMessage` 已被替身改成恒等返回） */
function msgText(msg: unknown): string {
  const m = msg as { content?: Array<{ text?: string }> }
  return (m.content ?? []).map((c) => c.text ?? '').join('')
}

let dir: string
let outside: string

beforeEach(() => {
  // 有 .serenity ⇒ cccRootForCwd 认它是 CCC 根
  dir = mkdtempSync(join(tmpdir(), 'hooks-ctxseam-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  // 无 .serenity ⇒ 不在任何 CCC 内
  outside = mkdtempSync(join(tmpdir(), 'hooks-ctxout-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

async function fireCreated(ctx: FakeCtx, agent: unknown): Promise<void> {
  for (const h of ctx.handlers.get('agent/created') ?? []) await h({ agent })
}

async function firePreStep(
  ctx: FakeCtx,
  agent: unknown,
  messages: unknown[],
  downstream: unknown,
): Promise<{ calls: number; decision: unknown }> {
  const h = (ctx.handlers.get('agent/pre-step') ?? [])[0]
  let calls = 0
  const next = async (): Promise<unknown> => {
    calls += 1
    return downstream
  }
  const decision = await h({ agent, messages }, next)
  return { calls, decision }
}

// ── 接线：哪个开关装哪条缝 ──────────────────────────────────────────────────
// ⚠️ `injected` / `sectionedAgents` 都是**模块级 Set**（无清理路径，见模块图 §3-4）
// ⇒ 每个用例必须用**互不相同**的 session id，否则会被"已注入过"提前返回。

describe('registerContext: 接线（opts 决定装哪条缝）', () => {
  it('默认：两条缝都装（agent/created 播种 ＋ agent/pre-step 兜底）', () => {
    const ctx = fakeCtx()
    registerContext(ctx as never)
    expect(ctx.handlers.get('agent/created')).toHaveLength(1)
    expect(ctx.handlers.get('agent/pre-step')).toHaveLength(1)
  })

  it('seedOnStart=false ⇒ 不装 agent/created（pre-step 仍在）', () => {
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })
    expect(ctx.handlers.get('agent/created')).toBeUndefined()
    expect(ctx.handlers.get('agent/pre-step')).toHaveLength(1)
  })

  it('injectOnPrompt=false ⇒ 不装 agent/pre-step（created 仍在）', () => {
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })
    expect(ctx.handlers.get('agent/created')).toHaveLength(1)
    expect(ctx.handlers.get('agent/pre-step')).toBeUndefined()
  })
})

// ── agent/created：播种 ACC 身份 ────────────────────────────────────────────

describe('registerContext: agent/created 播种', () => {
  it('CCC 内根会话 ⇒ 注入一次，正文含 ACC 身份锚点与 CCC 根', async () => {
    const { agent, injected } = fakeAgent('main-seam-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(1)
    const text = msgText(injected[0])
    expect(text).toContain('[ACC] Serenity cognitive container active')
    expect(text).toContain(dir)
  })

  it('同一载体重复触发 ⇒ 只注入一次（`injected` 幂等，防每轮 token 膨胀）', async () => {
    const { agent, injected } = fakeAgent('main-seam-2', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)
    await fireCreated(ctx, agent)
    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(1)
  })

  it('不在任何 CCC（cwd 无 .serenity）⇒ 完全不注入', async () => {
    const { agent, injected } = fakeAgent('main-seam-3', { header: { cwd: outside } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(0)
  })

  it('轨迹**自带章程** ⇒ 完全旁路（不注入 ACC 身份，轨迹提示词全替换）', async () => {
    // 🔴 2026-10-20 D183：判据从「有 trajectory-constraint.json」收窄为「**自带章程**」。
    //    只收窄能力／改模型／写自述 都**不**取代身份 ⇒ 照常注入 ACC 身份。
    make轨迹约束Session(dir, '轨迹约束-qa-seam-1', 'qa-seam', 轨迹约束Json({ systemPromptFile: 'charter.md' }), 'seam')
    const { agent, injected } = fakeAgent('轨迹约束-qa-seam-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(0)
  })

  it('🔴 D183 反向钉：声明存在但**没写任何取代默认的东西** ⇒ 照常注入（不写就是不设定）', async () => {
    // owner 2026-10-20：「所有 key 都是可选的；**不写就是不设定 不应影响默认行为**」
    // ⇒ 一个空 `{}` 声明的轨迹，行为必须与"根本没有这个文件"**逐字相同**。
    make轨迹约束Session(dir, '轨迹约束-empty-decl', 'empty-decl', 轨迹约束Json({}), 'seam')
    const { agent, injected } = fakeAgent('轨迹约束-empty-decl', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected.length).toBeGreaterThan(0)
  })

  it('🔴 判别性对照：id 带 `轨迹约束-` 前缀但**没有真实 轨迹约束轨迹** ⇒ 不再当 轨迹约束，照常注入', async () => {
    // 这条是"前缀判据已移除"的机械证据：同一条缝、同一个前缀，只差有没有 trajectory-constraint.json。
    // （若哪天有人把前缀判据加回来，本例会红 —— 它挡住的是**静默放宽**，不是噪声。）
    const { agent, injected } = fakeAgent('轨迹约束-qa-seam-prefix-only', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(1)
    expect(msgText(injected[0])).toContain('[ACC] Serenity cognitive container active')
  })
})

// ── 🔴 非 CCC ⇒ 工具面隐藏（v1.56.6，owner 报缺陷）──────────────────────────
// 靶 = **接线**：`syncCccToolVisibility` 必须真被两条缝调用，且**在 `if (root)` 之外**
// （放进那道分支里 = 非 CCC 一条 restrict 都不发 = 缺陷原样）。

describe('registerContext: 非 CCC 会话的工具面隐藏（v1.56.6 接线）', () => {
  /**
   * 带 `ctx.tools.restrict` 记录的 agent。
   *
   * 🔴 2026-10-22（方案 C）：**必须提供 `get`**，否则合并发射会走"旧的 host 无探活"分支；
   * 而真宿主有 `get`，替身不补就等于用一个不存在的宿主形态来验（D144 同族）。
   */
  function fakeAgentWithTools(id: string, cwd: string): { agent: unknown; restrictCalls: { deny?: string[] }[] } {
    const restrictCalls: { deny?: string[] }[] = []
    return {
      agent: {
        session: { id, header: { cwd } },
        inject: () => {},
        ctx: {
          tools: {
            get: (_n: string) => ({}),
            restrict: (f: { deny?: string[] }) => {
              restrictCalls.push(f)
              return () => {}
            },
          },
        },
      },
      restrictCalls,
    }
  }

  it('🔴 agent/created：非 CCC ⇒ 发一次 restrict 隐藏全部工具（在 `if (!root) return` 之前）', async () => {
    const { agent, restrictCalls } = fakeAgentWithTools('main-noccc-created', outside)
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(restrictCalls).toHaveLength(1)
    // 🔴 方案 C 后 deny 是**合并集且已排序**（排序让签名稳定、幂等判据才成立）
    //    ⇒ 比较用排序后的副本；集合本身仍要求"恰好等于全部注册工具"（不是"包含"——那会放松判据）。
    expect([...restrictCalls[0]!.deny!].sort()).toEqual([...REGISTERED_TOOLS].sort())
    forgetToolVisibility('main-noccc-created')
    forgetNonCccToolVisibility('main-noccc-created')
  })

  it('🔴 agent/pre-step：非 CCC ⇒ 同样发 restrict（**不能只在 `if (root)` 里**）', async () => {
    const { agent, restrictCalls } = fakeAgentWithTools('main-noccc-pre', outside)
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'enter', messages: [] }
    await firePreStep(ctx, agent, [], downstream)

    expect(restrictCalls).toHaveLength(1)
    expect([...restrictCalls[0]!.deny!].sort()).toEqual([...REGISTERED_TOOLS].sort())
    forgetToolVisibility('main-noccc-pre')
    forgetNonCccToolVisibility('main-noccc-pre')
  })

  it('🔴 对照：CCC 内会话 ⇒ **不隐藏工具面**（既有行为零改变的机械证据）', async () => {
    const { agent, restrictCalls } = fakeAgentWithTools('main-ccc-created', dir)
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    // ⚠️ 不能断言 "零 restrict" —— CCC 内本来就有条件可见同步会发 restrict
    //    （im-bridge 未配 IM 通道 / 宿主 schedule_* 在 CCC 内恒隐 / alwaysDeny 常驻表
    //     ⇒ 各发来源、合并后一条，**这是既有正确行为**）。
    //    判别点 = **有没有"整工具面隐藏"那一条**（deny 覆盖 REGISTERED_TOOLS）。
    //
    // 🔴 2026-11-06 修正（D274 同族：改钉本意，不放宽阈值）：
    //    原判别式是 `deny.length === REGISTERED_TOOLS.length` —— **用长度当集合的替身**。
    //    `alwaysDeny` 从 1 项扩到 8 项后，它(8) + hostSchedule(4) + imBridge(1) = **13**，
    //    与 `REGISTERED_TOOLS.length` **碰巧相等** ⇒ 本用例假红。
    //    这不是"判据太严"，是**判据钉错了东西**：要判的是「这条 restrict 是否覆盖了全部
    //    已注册工具」，长度只是它的一个必要不充分条件。
    //    ⇒ 改成真正的集合判据（`⊇ REGISTERED_TOOLS`），它对"数目碰巧相等"免疫。
    const registeredSet = new Set<string>(REGISTERED_TOOLS)
    const fullHide = restrictCalls.filter((c) => {
      const deny = new Set(c.deny ?? [])
      return [...registeredSet].every((name) => deny.has(name))
    })
    expect(fullHide).toHaveLength(0)
    // 判别性：确认本用例**真的**观测到了那几条条件可见（否则"零 fullHide"可能是"什么都没发生"）
    expect(restrictCalls.length).toBeGreaterThan(0)
  })
})

// ── 重启恢复：从历史把激活会话捞回内存 ──────────────────────────────────────
// 覆盖 `registerContext` 里此前**零执行**的那一段（恢复链 ①②③ ＋ 展示码派生 ＋ 配置门）。

describe('registerContext: agent/created 重启恢复（覆盖此前零执行的恢复链）', () => {
  /** 造一个真实存在的会话目录，返回 { dirName, mdPath } */
  function makeSessionDir(name: string): { dirName: string; mdPath: string } {
    const sessDir = join(dir, 'AGENT_SESSIONS', name)
    mkdirSync(sessDir, { recursive: true })
    const mdPath = join(sessDir, 'SESSION.md')
    writeFileSync(mdPath, '# test')
    return { dirName: name, mdPath }
  }

  it('② 文本扫回退：events 含「SESSION.md path:」⇒ 恢复激活会话，并从目录名派生 S### 展示码', async () => {
    const { dirName, mdPath } = makeSessionDir('2026-01-01--S042--restore-me')
    const id = 'main-restore-2'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      // 同时带标记行与规范路径行：两种扫描策略下都应能解析
      events: [{ type: 'user/message', text: `[SESSION CONTEXT] Activated: S042\nSESSION.md path: ${mdPath}` }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    expect(getActiveSessionInfo(id)).toBeNull() // 前置：内存里还没有

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toEqual({ sessionId: 'S042', dirName, mdPath })
  })

  it('② 但 mdPath 已不存在（陈旧/归档/删除）⇒ 不恢复（existsSync 校验拦住污染）', async () => {
    const id = 'main-restore-stale'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [{ type: 'user/message', text: `SESSION.md path: ${join(dir, 'AGENT_SESSIONS', '2026-01-01--S043--gone', 'SESSION.md')}` }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toBeNull()
  })

  it('配置门：hooks.autoRestoreSession=false ⇒ 不恢复（即使历史可解析）', async () => {
    const { mdPath } = makeSessionDir('2026-01-01--S044--gated')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ hooks: { autoRestoreSession: false } }))

    const id = 'main-restore-gated'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [{ type: 'user/message', text: `SESSION.md path: ${mdPath}` }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toBeNull()
  })

  it('全新会话（无历史）⇒ 不恢复（不把过去的 SESSION 注入新任务）', async () => {
    makeSessionDir('2026-01-01--S045--fresh')
    const id = 'main-restore-fresh'
    const { agent } = fakeAgent(id, { header: { cwd: dir }, events: [] })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toBeNull()
  })
})

// ── agent/pre-step：必须 next() 委托 ＋ 消息顺序 ────────────────────────────

describe('registerContext: agent/pre-step（"context-only 必须 next() 委托"的回归钉）', () => {
  it('下游 kind=enter ⇒ **调用 next()**，且返回 enter：ACC 消息在前、原 messages 居中、下游消息在后', async () => {
    const { agent } = fakeAgent('main-pre-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const { calls, decision } = await firePreStep(
      ctx,
      agent,
      [{ tag: 'current' }],
      { kind: 'enter', messages: [{ tag: 'downstream' }] },
    )

    // 🔴 核心不变量：context-only 缝**必须**委托，短路会跳过后续策略监听器
    expect(calls).toBe(1)

    const d = decision as { kind: string; messages: unknown[] }
    expect(d.kind).toBe('enter')
    expect(d.messages).toHaveLength(3)
    expect(msgText(d.messages[0])).toContain('[ACC] Serenity cognitive container active')
    expect(d.messages[1]).toEqual({ tag: 'current' })
    expect(d.messages[2]).toEqual({ tag: 'downstream' })
  })

  it('下游非 enter ⇒ 不注入、原样返回 downstream', async () => {
    const { agent } = fakeAgent('main-pre-2', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'skip', messages: [] }
    const { calls, decision } = await firePreStep(ctx, agent, [{ tag: 'current' }], downstream)

    expect(calls).toBe(1) // 仍然委托
    expect(decision).toEqual(downstream)
  })

  /**
   * 🔴🔴 2026-10-22（owner 报「send-now 创建的会话消息注入两次」）：
   * 「注入过没有」的判据从**进程内 Set** 改为**会话历史**。
   *
   * 这两条必须**成对**存在 —— 只钉"跨重启不重复"，就会让修复退化成"干脆不注入"
   * （那比重复更坏：陈旧会话里 ACC 身份彻底缺失，且零信号）。
   */
  describe('🔴 横幅去重：判据是会话历史，不是进程内存', () => {
    /** 造一条"历史里已经有 ACC 横幅"的会话事件（形状对齐真实日志） */
    const bannerEvent = (): unknown => ({
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '[ACC] Serenity cognitive container active (dsh-serenity-hooks v1.85.0)\n- CCC root: …' }],
        source: { kind: 'plugin:dsh-serenity-hooks' },
      },
    })

    it('历史里已有横幅 ⇒ 再进 pre-step **不再注入**（等价于"跨重启后的老会话"）', async () => {
      // 关键：**全新 registerContext = 全新进程**（`injected` 是模块级 Set，
      // 但本文件每条用例 import 同一模块实例；用 history 判据才能表达"新进程 + 老会话"）。
      // ⇒ 本用例不依赖 Set 是否为空：就算 Set 有值，判据也必须由历史给出。
      const { agent } = fakeAgent('banner-dup-1', { header: { cwd: dir }, events: [bannerEvent()] })
      const ctx = fakeCtx()
      registerContext(ctx as never, { seedOnStart: false })

      const { decision } = await firePreStep(
        ctx,
        agent,
        [{ tag: 'current' }],
        { kind: 'enter', messages: [{ tag: 'downstream' }] },
      )
      // 不注入 ⇒ 原样返回 downstream（messages 长度仍是它自己那 1 条）
      const d = decision as { kind: string; messages: unknown[] }
      expect(d.messages).toEqual([{ tag: 'downstream' }])
    })

    it('🔴 反向钉：历史里**没有**横幅 ⇒ 照常注入一次（⛔ 不许把去重做成不注入）', async () => {
      const { agent } = fakeAgent('banner-fresh-1', {
        header: { cwd: dir },
        // 有历史、但**不含** ACC 横幅（例如只有别的注入消息）
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: '别的注入' }], source: { kind: 'skill-catalog' } } },
        ],
      })
      const ctx = fakeCtx()
      registerContext(ctx as never, { seedOnStart: false })

      const { decision } = await firePreStep(
        ctx,
        agent,
        [{ tag: 'current' }],
        { kind: 'enter', messages: [{ tag: 'downstream' }] },
      )
      const d = decision as { kind: string; messages: unknown[] }
      expect(d.messages).toHaveLength(3)
      expect(msgText(d.messages[0])).toContain('[ACC] Serenity cognitive container active')
    })

    it('🔴 判别性：别的插件注入（非 ACC banner）**不算**注入过', async () => {
      // 若判据只认 `source.kind === PLUGIN_SOURCE` 而不认正文前缀，这条会误判成"已注入"
      // ⇒ 真会话将**永不再**拿到身份横幅。这里把那个错误形状钉死。
      const { agent } = fakeAgent('banner-other-1', {
        header: { cwd: dir },
        events: [
          {
            type: 'user/message',
            data: {
              // 同 kind，但正文**不是**横幅（例如 keeper 提醒 / 唤醒投递 / 打回提示）
              content: [{ type: 'text', text: '[唤醒] 到点，请继续 S142 的工作' }],
              source: { kind: 'plugin:dsh-serenity-hooks' },
            },
          },
        ],
      })
      const ctx = fakeCtx()
      registerContext(ctx as never, { seedOnStart: false })

      const { decision } = await firePreStep(
        ctx,
        agent,
        [],
        { kind: 'enter', messages: [] },
      )
      const d = decision as { kind: string; messages: unknown[] }
      expect(d.messages).toHaveLength(1)
      expect(msgText(d.messages[0])).toContain('[ACC] Serenity cognitive container active')
    })
  })

  it('不在任何 CCC ⇒ 不注入、原样返回 downstream', async () => {
    const { agent } = fakeAgent('main-pre-3', { header: { cwd: outside } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'enter', messages: [] }
    const { decision } = await firePreStep(ctx, agent, [], downstream)

    expect(decision).toEqual(downstream)
  })

  it('轨迹**自带章程** ⇒ 不注入、原样返回 downstream（D183 完全旁路）', async () => {
    // 🔴 2026-10-20 D183：判据 = 「自带章程」，不再等于「有 trajectory.json」。
    make轨迹约束Session(dir, '轨迹约束-qa-pre-1', 'qa-pre', 轨迹约束Json({ systemPromptFile: 'charter.md' }), 'pre')
    const { agent } = fakeAgent('轨迹约束-qa-pre-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'enter', messages: [] }
    const { decision } = await firePreStep(ctx, agent, [], downstream)

    expect(decision).toEqual(downstream)
  })

  it('已经在 agent/created 播过种的同一载体 ⇒ pre-step 不重复注入（仍委托）', async () => {
    const id = 'main-pre-4'
    const { agent } = fakeAgent(id, { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never) // 两条缝都装

    await fireCreated(ctx, agent) // 先播种 ⇒ 进 `injected`

    const downstream = { kind: 'enter', messages: [] }
    const { calls, decision } = await firePreStep(ctx, agent, [], downstream)

    expect(calls).toBe(1)
    expect(decision).toEqual(downstream) // 不再前置 ACC 消息
  })
})
