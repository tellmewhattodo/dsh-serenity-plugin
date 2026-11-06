import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { __setSimpleSourceForTest, defaultSimpleSettings, type SerenitySimpleSettings } from '../src/surface/settings.js'

/**
 * im/inbound-event.ts —— **中立入站事件层**的判据（B1，2026-10-19）
 *
 * ## 这个文件要证明什么（判据分层，别把绿读成"飞书能用了"）
 *
 * ✅ **证明**：`handleInboundEvent` 能**完全不知道 iLink 存在**地跑完一条消息——
 *    路由 → 会话 → 提问 → 回复 → 记账 → 媒体落盘。
 * ✅ **证明**：它吃的是**中立事件**（`userId` / `text` / `media[].fetch()` / `replyRef`），
 *    与 iLink 的 `from_user_id` / `context_token` / `item_list` **没有一处同名**。
 * ⛔ **不证明**：飞书能连上、能收、能发 —— 那要真 appId/appSecret 与真网络（P3 三格分开验）。
 *
 * ## 为什么"非 iLink 形状"是核心判据
 *
 * 抽没抽干净，**不是**看代码里有没有 `context_token` 字样 —— 那种判据随手就能糊弄。
 * 真判据是：**喂进一个主流程从没见过的形状，它照样跑通**。
 * ⇒ 这就是"未来第三家 IM 接进来要不要改主流程"的答案。
 */

let dir: string
let oldAuditEnv: string | undefined
let oldConfigEnv: string | undefined
/** 机器级订阅表的可变量（每例改它） */
let machineSubscriptions: Array<Record<string, unknown>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'im-inbound-event-'))
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  // CCC 标记（`cccRootForCwd` 上溯要它）
  writeFileSync(join(dir, '.serenity'), 'test')
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  // 机器级留痕隔离（未命中档会写它，不隔离会污染别的用例）
  oldAuditEnv = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  process.env.SERENITY_HUMAN_CHANNEL_AUDIT = join(dir, 'audit.jsonl')
  machineSubscriptions = []
  __setSimpleSourceForTest((): SerenitySimpleSettings => ({
    ...defaultSimpleSettings(),
    humanChannel: { ...defaultSimpleSettings().humanChannel, subscriptions: machineSubscriptions },
  }))
})

afterEach(async () => {
  __setSimpleSourceForTest(null)
  const { __resetWeixinOutputGuardForTest } = await import('../src/im/guard.js')
  __resetWeixinOutputGuardForTest()
  // 会话注册表是模块级 → 不清理会串到别的用例（与 human-channel-routing 同款收尾）
  const { unregisterTrajectorySession, trajectorySessionSnapshot } = await import('../src/trajectory/session.js')
  for (const [id] of trajectorySessionSnapshot()) unregisterTrajectorySession(id)
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  if (oldAuditEnv === undefined) delete process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  else process.env.SERENITY_HUMAN_CHANNEL_AUDIT = oldAuditEnv
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * 造一条**认知轨迹**（普通轨迹：有 SESSION.md，**无 trajectory-constraint.json**）
 * ⇒ 中立层不施加 轨迹约束 约束，但仍能往里投（这是"轨迹存在性"判据的正控）。
 */
function makeTrajectory(code: string): void {
  const d = join(dir, 'AGENT_SESSIONS', `2026-10-19--${code}--probe`)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SESSION.md'), `# SESSION: probe\n- ID: ${code}\n`)
}

/** 一条机器级订阅：账号 + 用户 → (CCC 别名, 轨迹编码) */
function subscribe(account: string, user: string, code: string): void {
  // ⚠️ 字段名是 `role`（计划层的历史名），值 = **轨迹编码** —— 这不是笔误：
  //    `planInboundRoute` 至今按 `role` 取该列（"角色名"这个语义已退役，键名保留）。
  machineSubscriptions = [{ account, user, ccc: basename(dir), role: code }]
}

/** fake ctx：agents.create 造一个带 followup 的 agent；on 立即触发 idle */
function fakeCtx(): { ctx: unknown; questions: string[] } {
  const questions: string[] = []
  const agent = {
    session: { id: 'probe', events: [] as unknown[] },
    ctx: { systemPrompt: { section: () => {} } },
    followup: (msg?: { content?: Array<{ type?: string; text?: string }> }) => {
      const q = (msg?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
      if (q) questions.push(q)
      agent.session.events.push(
        { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**答**案' }] } } },
      )
    },
    interrupt: () => {},
  }
  const ctx = {
    // `listCccs` 靠工作区注册表枚举出本 CCC（订阅表按**别名**寻址时必须能解析）
    get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
    agents: {
      create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
        agent.session.id = opts.sessionId
        await opts.setup?.(agent as never)
        return { agent }
      },
      resume: async () => { throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' }) },
    },
    on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => { cb({ agent, status: 'idle' }); return () => {} },
  }
  return { ctx, questions }
}

describe('中立入站事件层：一条消息的主流程（与通道无关）', () => {
  it('🔴 主流程吃一个**非 iLink 形状**的事件也能跑通（抽缝是否干净的判据）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'someone-else', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()

    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'someone-else', cccFallback: null })
    expect(target).not.toBeNull()

    const sent: string[] = []
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async ({ text }: { text: string }) => { sent.push(text) },
    }, {
      // ⚠️ 这些字段名与 iLink **毫无关系**：这就是"第三家 IM"会拿来的形状
      userId: 'someone-else',
      text: '你好呀',
      media: [],
      hasVoice: false,
    }, { target: target! })

    expect(questions.join('\n')).toContain('你好呀') // 问题真进了会话
    // 🔴 D238（2026-10-24，owner 令「出站只有 im-bridge 一条路」）：
    //    **桥不再转发 agent 的最终文本** ⇒ 只有系统类「新的对话已开始」这一条，
    //    而 fake agent 的 `**答**案` **不会**出现在出站里。
    //    ⇒ 「问题真被追问」由上面的 questions 断言承担（否则"没发"无从谈起）。
    expect(sent.some((s) => s.includes('新的对话已开始'))).toBe(true)
    expect(sent.some((s) => s.includes('答案'))).toBe(false)
    // 且机制标记已注入（手动模式是唯一路径）
    expect(questions.join('\n')).toContain('[serenity:weixin-manual-output]')
  })

  it('无文本无媒体 + 有语音 ⇒ 发降级提示（不静默、不建会话）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-voice', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-voice', cccFallback: null })

    const sent: string[] = []
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async ({ text }: { text: string }) => { sent.push(text) },
    }, {
      userId: 'u-voice', text: null, media: [], hasVoice: true,
    }, { target: target! })

    expect(sent.join('\n')).toContain('无法解析这条语音')
    expect(questions).toEqual([]) // 没进对话 = 没建会话
  })

  it('无文本无媒体且**不是**语音 ⇒ 完全静默（不打扰用户）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-empty', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-empty', cccFallback: null })

    const sent: string[] = []
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async ({ text }: { text: string }) => { sent.push(text) },
    }, {
      userId: 'u-empty', text: null, media: [], hasVoice: false,
    }, { target: target! })

    expect(sent).toEqual([])
  })

  it('媒体：`fetch()` 由事件自带 ⇒ 主流程落盘并注入路径（不认 iLink 的下载函数）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-media', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-media', cccFallback: null })

    let fetched = 0
    await handleInboundEvent(ctx as never, dir, 'acct-a', { sendText: async () => {} }, {
      userId: 'u-media',
      text: '看这个',
      media: [{
        kind: 'file',
        fileName: '报表.csv',
        fetch: async () => { fetched += 1; return { data: Buffer.from('a,b\n1,2\n'), fileName: '报表.csv' } },
      }],
      hasVoice: false,
    }, { target: target! })

    expect(fetched).toBe(1)
    expect(questions.join('\n')).toContain('已保存到')
    // 文件真落盘（按用户分目录）
    const inboundRoot = join(dir, '_tmp', 'weixin-inbound')
    expect(existsSync(inboundRoot)).toBe(true)
    const perUser = readdirSync(inboundRoot)
    expect(perUser.length).toBe(1)
    expect(readdirSync(join(inboundRoot, perUser[0]!)).join(',')).toContain('报表.csv')
  })

  it('媒体 `fetch()` 返回 null ⇒ 降级告知进对话（不静默丢消息）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-fail', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-fail', cccFallback: null })

    await handleInboundEvent(ctx as never, dir, 'acct-a', { sendText: async () => {} }, {
      userId: 'u-fail',
      text: '',
      media: [{ kind: 'image', fetch: async () => null }],
      hasVoice: false,
    }, { target: target! })

    expect(questions.join('\n')).toContain('下载失败')
  })

  it('🔴 `io.typingStart/typingStop` **可选** ⇒ 没有打字态的通道（如飞书）不会因此失败', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-notyping', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-notyping', cccFallback: null })

    await expect(handleInboundEvent(ctx as never, dir, 'acct-a', { sendText: async () => {} }, {
      userId: 'u-notyping', text: 'hi', media: [], hasVoice: false,
    }, { target: target! })).resolves.toBeUndefined()
    expect(questions.length).toBeGreaterThan(0)
  })

  it('异常路径也调 typingStop（try/finally 真存在）', async () => {
    makeTrajectory('probe-code')
    subscribe('acct-a', 'u-throw', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')

    const agent = {
      session: { id: 'probe', events: [] as unknown[] },
      ctx: { systemPrompt: { section: () => {} } },
      followup: () => { throw new Error('boom') }, // 提问阶段就炸
      interrupt: () => {},
    }
    const ctx = {
      get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: dir }] } : undefined),
      agents: {
        create: async () => ({ agent }),
        resume: async () => { throw Object.assign(new Error('nf'), { name: 'SessionPersistenceNotFoundError' }) },
      },
      on: (_e: string, cb: (p: unknown) => void) => { cb({ agent, status: 'idle' }); return () => {} },
    }
    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-throw', cccFallback: null })

    let stopped = 0
    // 主流程自己吞错误（桥错误静默是轮询循环存活的前提）⇒ 断言"不抛"且 stop 被调
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async () => {},
      typingStart: async () => {},
      typingStop: async () => { stopped += 1 },
    }, {
      userId: 'u-throw', text: 'hi', media: [], hasVoice: false,
    }, { target: target! })

    expect(stopped).toBe(1)
  })
})

describe('中立入站事件层：通道无关的纯机制面', () => {
  it('机制标记仍是已导出、可独立测的纯函数；兜底函数已随 D238 退役', async () => {
    const mod = await import('../src/im/inbound-event.js')
    expect(mod.manualOutputMarker('acct-a', 'u1')).toContain('[serenity:weixin-manual-output]')
    // 🔴 D238：`manualOutputFallbackNeeded` 已删除 —— 兜底随 fallbackOnNoSend 一起退役。
    //    判据 = **符号不存在**；它若被"贴心地"恢复回来，这条会红。
    expect('manualOutputFallbackNeeded' in mod).toBe(false)
  })

  it('🔴 渠道不是常量：传 `channel:"feishu"` ⇒ 注入的命令写 feishu（缺省仍是 weixin）', async () => {
    const { manualOutputMarker } = await import('../src/im/inbound-event.js')
    expect(manualOutputMarker('acct-a', 'u1')).toContain('channel:"weixin"')
    expect(manualOutputMarker('acct-a', 'u1', 'feishu')).toContain('channel:"feishu"')
    // 协议标记本身**不改名**（CCC 侧角色提示词按它做判据；A85）
    expect(manualOutputMarker('acct-a', 'u1', 'feishu')).toContain('[serenity:weixin-manual-output]')
  })
})

describe('中立入站事件层：渠道身份穿过本层（Q4）', () => {
  it('🔴 CCC 级路径传 `{channel}`（无 target）⇒ 自己按 routes 路由并投递，**不被静默丢弃**', async () => {
    // 这是本轮实测抓到的一个真缺陷的反向钉：
    // 首版把"机器级模式"的判据写成 `if (preset)`，而飞书 CCC 级路径要传 `{channel:'feishu'}`
    // （没有 target）⇒ 那条路径 `resolved = undefined` ⇒ 命中 `if (!resolved) return`
    // ⇒ **每一条飞书消息都被静默丢掉**，且零报错。
    makeTrajectory('probe-code')
    const { handleInboundEvent } = await import('../src/im/inbound-event.js')
    const { ctx, questions } = fakeCtx()

    // CCC 级路由（serenity.json 的 routes），不靠订阅表
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({
      im: {
        enabled: true,
        accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }],
        routes: [{ user: 'ou_feishu', trajectory: 'probe-code' }],
      },
    }, null, 2))

    await handleInboundEvent(ctx as never, dir, 'feishu-1', { sendText: async () => {} }, {
      userId: 'ou_feishu', text: '来自飞书的消息', media: [], hasVoice: false,
    }, { channel: 'feishu' })

    // 🔴 判据 = **问题真的进了会话**（若被静默丢弃，这里会是空数组）
    expect(questions.join('\n')).toContain('来自飞书的消息')
  })
})

/**
 * 🔴🔴 **入站必须投给「该轨迹此刻的载体」**（2026-11-06 生产回归的反向钉）
 *
 * ## 这次回归长什么样（真机，不是假想）
 *
 * v1.121.0 发布了 `reconstruct`（换代：建新会话 → 绑轨迹 → 归档旧会话）。
 * 它在**走 IM 桥的那条轨迹**上真跑了（本容器实测，2026-11-06 08:3x）：
 * ```
 * reconstruct: 新载体 session-<uuid> 已接管「…<轨迹目录名>…」（旧 skiff-weixin-<code>）
 * reconstruct: 旧会话 skiff-weixin-<code> 已归档（attempt 1）
 * im 投递：会话 skiff-weixin-<code> → followup    ← 仍投给已归档的那条
 * ```
 * ⇒ 人在微信那头连发四条没人应（`人呢` × 3 ＋ 一条带地址的请求），
 * 而**每一层日志都报成功**：`followup` 不是空操作，它确实投了 —— 投进一条已被收起来的会话。
 *
 * ## 为什么旧用例全绿（判据盲区，比 bug 本身更值得记）
 *
 * 旧的 10 条用例全都**只走"还没有载体"那条路**（先 `create` 出派生 id）。
 * 那正是**派生值正确**的那一格 ⇒ 它们结构上不可能看见这次回归。
 * ⇒ 判据必须显式钉住**两种状态**（已绑定 / 未绑定），并把它们当成**两件事**断言。
 */
describe('中立入站事件层：投递目标是「绑定真相源」，不是派生值', () => {
  /** 写一条轨迹的载体声明（`current.dsh_session_bind`，D172 起的唯一真相源） */
  function bindCarrier(code: string, sessionId: string): void {
    const d = join(dir, 'AGENT_SESSIONS', `2026-10-19--${code}--probe`)
    writeFileSync(join(d, 'current.dsh_session_bind'), JSON.stringify({
      sessionId, at: Date.now(), action: 'activate',
    }, null, 2))
  }

  /**
   * fake ctx：既能 `create`（未绑定路径）也能 `get`（绑定探针要问它"这条会话在不在"）。
   * `archived` 用来模拟宿主归档集 —— 判活时**归档优先于 live**（见 `isSessionAlive`）。
   */
  function ctxWithCradle(archived: string[] = []): { ctx: unknown; created: string[]; delivered: string[] } {
    const created: string[] = []
    const delivered: string[] = []
    const makeAgent = (id: string) => ({
      session: { id, events: [] as unknown[] },
      ctx: { systemPrompt: { section: () => {} } },
      followup: () => {
        delivered.push(id)
        return undefined
      },
      interrupt: () => {},
    })
    const agents = new Map<string, ReturnType<typeof makeAgent>>()
    const ctx = {
      get: (name: string) => {
        if (name === 'workspaceRegistry') {
          return { list: () => [{ path: dir }], archivedSessionIds: archived }
        }
        return undefined
      },
      agents: {
        get: (id: string) => agents.get(id),
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          created.push(opts.sessionId)
          const a = makeAgent(opts.sessionId)
          agents.set(opts.sessionId, a)
          await opts.setup?.(a as never)
          return { agent: a }
        },
        resume: async () => { throw Object.assign(new Error('nf'), { name: 'SessionPersistenceNotFoundError' }) },
      },
      on: (_e: string, cb: (p: unknown) => void) => { cb({ status: 'idle' }); return () => {} },
    }
    return { ctx, created, delivered }
  }

  it('🔴 已绑定 ⇒ 投给**绑定的那条**（⛔ 不是 `skiff-weixin-<code>` 派生值）', async () => {
    makeTrajectory('probe-code')
    // 🔴 这一格是本次回归的**唯一靶子**：绑定指向一条非派生 id 的会话
    //    （`reconstruct` 建出来的载体就是这种形状：`session-<uuid>`）
    const carrier = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    bindCarrier('probe-code', carrier)
    subscribe('acct-a', 'u-bound', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    const { ctx, created, delivered } = ctxWithCradle()
    // 绑定的那条会话活着（进程内 loaded）⇒ 探针判它 usable
    const live = { session: { id: carrier, events: [] }, ctx: { systemPrompt: { section: () => {} } }, followup: () => { delivered.push(carrier) }, interrupt: () => {} }
    ;(ctx as { agents: { get: (id: string) => unknown } }).agents.get = (id: string) => (id === carrier ? live : undefined)

    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-bound', cccFallback: null })
    expect(target).not.toBeNull()
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async () => {}, typingStart: async () => {}, typingStop: async () => {},
    }, { userId: 'u-bound', text: '人呢', media: [], hasVoice: false }, { target: target! })

    // 🔴 判据 = 消息落进**绑定那条**，且**没有**按派生值另建一条
    expect(delivered, '必须投给绑定的载体').toContain(carrier)
    expect(created, '⛔ 已绑定就不该再按派生值新建会话').not.toContain('skiff-weixin-probe-code')
  })

  it('🔴 绑定的那条**已被归档** ⇒ 视同没绑定，退回派生值（不投给归档会话）', async () => {
    makeTrajectory('probe-code')
    const stale = 'session-archived-carrier'
    bindCarrier('probe-code', stale)
    subscribe('acct-a', 'u-stale', 'probe-code')
    const { handleInboundEvent, resolveInboundTarget } = await import('../src/im/inbound-event.js')
    // 归档集里有它 ⇒ 探针判死 ⇒ `listBoundSessionIds` 返回空 ⇒ 走派生兜底
    const { ctx, created, delivered } = ctxWithCradle([stale])

    const target = await resolveInboundTarget(ctx as never, { account: 'acct-a', user: 'u-stale', cccFallback: null })
    expect(target).not.toBeNull()
    await handleInboundEvent(ctx as never, dir, 'acct-a', {
      sendText: async () => {}, typingStart: async () => {}, typingStop: async () => {},
    }, { userId: 'u-stale', text: '人呢', media: [], hasVoice: false }, { target: target! })

    // 归档会话一字都不该收到；派生值那条被建成新载体
    expect(delivered, '⛔ 已归档会话不得收到投递').not.toContain(stale)
    expect(created, '无可用绑定 ⇒ 按派生值建第一条载体').toContain('skiff-weixin-probe-code')
  })
})

