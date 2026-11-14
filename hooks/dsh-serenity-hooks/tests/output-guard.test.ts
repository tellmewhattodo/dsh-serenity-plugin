import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  buildSensitiveTable,
  detectSensitive,
  buildRebuke,
  REBUKE_MAX_ROUNDS,
  rebukeStates,
} from '../src/guard/filter.js'
import { registerOutputGuardHook } from '../src/guard/seam.js'
import { stripThink } from '../src/surface/text.js'
import { resetTrajectorySessions, registerTrajectorySession } from '../src/trajectory/policy/window.js'
import { makeTrajectory, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'output-guard-'))
  // 需求⑤a：注册表单级化——cccName = demo → 聚合档 .opencode/skills/demo/references/mech-registry.json
  writeFileSync(join(dir, '.serenity'), 'demo')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  mkdirSync(join(dir, '.opencode', 'skills', 'demo', 'references'), { recursive: true })
  // 凭据文件（测试敏感词源）
  writeFileSync(join(dir, 'localstore.json'), JSON.stringify({
    credentials: { SSH_UBUNTU_PASSWORD: 'hunter2-secret', HOME_GITLAB_TOKEN: 'glpat-xyz' },
  }))
  // mech-registry（测试 MSM 词源）
  writeFileSync(join(dir, '.opencode', 'skills', 'demo', 'references', 'mech-registry.json'), JSON.stringify({
    entries: [
      { name: 'web-search', script: 'web-search.ts' },
      { name: 'vlm-describe', script: 'vlm-describe.ts' },
    ],
  }))
  // 🔴 2026-10-19：输出守卫的「外部面」判据不再是 sessionId 的 `轨迹约束-` 前缀，而是
  //    「**该会话绑定的轨迹有 `trajectory-constraint.json`**」（`guard/seam.ts` 的 `isTrajectoryConstrained`）。
  //    ⇒ 下方两个默认夹具会话必须**真的挂到一条 轨迹约束轨迹上**，否则它们会被判成
  //    本地维护会话（豁免）⇒ 打回类用例会集体假红。
  const { dirName } = makeTrajectory(dir, 'qa', 轨迹约束Json({ tools: [] }))
  registerTrajectorySession('轨迹约束-qa-uuid', dirName, dir)     // turn-stopping 组默认夹具
  registerTrajectorySession('轨迹约束-edge-uuid', dirName, dir)   // 边界与失败路径组默认夹具
})

afterEach(() => {
  rebukeStates.clear()
  resetTrajectorySessions() // 进程级注册表：会话 → 轨迹，用例间必须复位
  rmSync(dir, { recursive: true, force: true })
})

describe('output-guard: 敏感词表构建（v1.26.3）', () => {
  it('凭据词：localstore credentials 条目名 + 值入精确表', () => {
    const t = buildSensitiveTable(dir)
    expect(t.exact.has('SSH_UBUNTU_PASSWORD')).toBe(true)
    expect(t.exact.has('hunter2-secret')).toBe(true)
    expect(t.exact.has('HOME_GITLAB_TOKEN')).toBe(true)
    expect(t.exact.has('glpat-xyz')).toBe(true)
  })

  it('MSM 词：mech-registry 注册的工具名入精确表（用户补充：msm_list 列表里的工具名）', () => {
    const t = buildSensitiveTable(dir)
    expect(t.exact.has('web-search')).toBe(true)
    expect(t.exact.has('vlm-describe')).toBe(true)
  })

  it('机制词：静态内部结构词入子串表（插件名/配置路径/内部实现词）', () => {
    const t = buildSensitiveTable(dir)
    expect(t.substring).toContain('dsh-serenity-hooks')
    expect(t.substring).toContain('mech-registry.json')
    expect(t.substring).toContain('.opencode/serenity.json')
    // v1.33：logbook 已并入 cognitive trajectory——敏感机制词不含任何对外工具名
    expect(t.substring).not.toContain('session_rebuild')
  })

  it('凭据文件缺失 → 表仍含机制词 + MSM 词（不抛错）', () => {
    const noCred = mkdtempSync(join(tmpdir(), 'og-nocred-'))
    writeFileSync(join(noCred, '.serenity'), 'test')
    const t = buildSensitiveTable(noCred)
    expect(t.substring.length).toBeGreaterThan(0)
    rmSync(noCred, { recursive: true, force: true })
  })
})

describe('output-guard: 检测（detectSensitive）', () => {
  it('正常认知结果 → 无命中（公开概念词不敏感）', () => {
    const t = buildSensitiveTable(dir)
    const hits = detectSensitive('根据宁静号的知识，EAP 强调外部可重建性。建议使用 CCE 框架评估。', t)
    expect(hits).toEqual([])
  })

  it('回答含凭据值 → 命中（精确匹配，分类 credential）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('服务器密码是 hunter2-secret', t)).toContainEqual({ word: 'hunter2-secret', category: 'credential' })
  })

  it('回答含凭据条目名 → 命中（分类 credential）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('我读取了 SSH_UBUNTU_PASSWORD 配置', t)).toContainEqual({ word: 'SSH_UBUNTU_PASSWORD', category: 'credential' })
  })

  it('回答含 MSM 工具名 → 命中（分类 msm）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('我调用 web-search 搜索了资料', t)).toContainEqual({ word: 'web-search', category: 'msm' })
  })

  it('回答含机制词（插件名/内部路径）→ 命中（分类 mechanism）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('这是 dsh-serenity-hooks 的实现', t)).toContainEqual({ word: 'dsh-serenity-hooks', category: 'mechanism' })
    expect(detectSensitive('配置在 .opencode/serenity.json', t)).toContainEqual({ word: '.opencode/serenity.json', category: 'mechanism' })
  })

  it('回答含内部端口 → 命中（分类 port，v1.26.11）', () => {
    const t = buildSensitiveTable(dir)
    // ⚠️ 2026-10-15：原用 3100 举例，该面（旧面 E）已退役 ⇒ 曾改用 3099。
    // ⚠️ 2026-10-19：**3099（轨迹约束调试面）也退役了** ⇒ 改用**仍在役**的 3081（网关面）。
    //    判据不变：在役内部端口出现在用户可见输出里必须被打回。
    //    🔴 三次换例子都只因"例子所在的面退了"，不是因为判据变了 —— 这正是本用例的正确演化方式。
    expect(detectSensitive('端口 3081 提供服务', t)).toContainEqual({ word: '3081', category: 'port' })
  })

  it('🔴 C4 块 B 缺陷修复：3082（微信发送面，默认开）也在守卫端口集合内', () => {
    // 修复前 MECHANISM_PORTS 硬写 ['3080','3081','3099','3100']——漏 3082 ⇒ 提 3082 不被打回。
    // 现由集中端口表派生（kernel/ports.ts），本断言钉住"守卫端口集合 = 各面端口"。
    // ⚠️ 2026-10-15：面 E（3100）退役 ⇒ 期望集合由五项改四项。
    // ⚠️ 2026-10-19：面 D（3099）退役 ⇒ 期望集合再改三项；**3082 那条判据不变**（它是本用例的主题）。
    const t = buildSensitiveTable(dir)
    for (const port of ['3080', '3081', '3082']) {
      expect(t.portWords, `守卫端口词表缺 ${port}`).toContain(port)
      expect(detectSensitive(`服务监听在 ${port}`, t), `${port} 未被守卫识别`).toContainEqual({ word: port, category: 'port' })
    }
    // 负控：已退役的 3100 / 3099 不该再被当内部端口（否则守的是个不存在的面）
    expect(t.portWords, '已退役的 3100 仍在守卫词表里').not.toContain('3100')
    expect(t.portWords, '已退役的 3099 仍在守卫词表里').not.toContain('3099')
  })

  it('空文本 → 无命中', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('', t)).toEqual([])
  })
})

describe('output-guard: 打回消息（buildRebuke，v1.26.11 分类指引）', () => {
  it('逐词列出命中词 + 分类规避指引（端口类：告知是内部端口）', () => {
    const msg = buildRebuke([{ word: '3080', category: 'port' }])
    expect(msg).toContain('sensitive internal term')
    expect(msg).toContain('"3080"')
    expect(msg).toMatch(/internal service port or address/)
    expect(msg).toMatch(/never mention internal ports, addresses, or service endpoints/)
  })

  it('凭据/机制/工具名分类各给对应指引 + 多命中全列出', () => {
    const msg = buildRebuke([
      { word: 'hunter2-secret', category: 'credential' },
      { word: 'dsh-serenity-hooks', category: 'mechanism' },
      { word: 'web-search', category: 'msm' },
    ])
    expect(msg).toContain('3 sensitive internal terms')
    expect(msg).toContain('"hunter2-secret"')
    expect(msg).toContain('"dsh-serenity-hooks"')
    expect(msg).toContain('"web-search"')
    expect(msg).toMatch(/credential identifier/)
    expect(msg).toMatch(/internal mechanism term/)
    expect(msg).toMatch(/internal tool name/)
    expect(msg).toMatch(/Regenerate the response/)
    expect(msg).toMatch(/without referencing internal machinery/)
  })

  it('单数名词（1 term）', () => {
    const msg = buildRebuke([{ word: '3100', category: 'port' }])
    expect(msg).toContain('1 sensitive internal term')
    expect(msg).not.toContain('term(s)')
  })
})

describe('output-guard-seam: turn-stopping 接线（v1.26.3）', () => {
  function fakeCtx(id = '轨迹约束-qa-uuid') {
    const steers: string[] = []
    let hook: ((p: { agent?: unknown; turn?: number }) => void) | undefined
    const agent = {
      id,
      session: {
        id,
        header: { cwd: dir },
        events: [] as unknown[],
      },
      steer: (m: { content?: Array<{ type?: string; text?: string }> }) => {
        steers.push(m.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') ?? '')
      },
    }
    return {
      steers,
      agent,
      fire: (turn: number) => hook?.({ agent, turn }),
      ctx: {
        on: (_ev: string, cb: (p: unknown) => void) => { hook = cb as (p: unknown) => void },
      },
    }
  }

  it('外部面合规输出 → 不打回（steer 不调用）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是一个正常的认知回答' }] } } })
    f.fire(1)
    expect(f.steers).toEqual([])
  })

  it('外部面命中敏感词 → steer 打回（v1.26.10：打回文本含命中词，模型据此重写）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '密码是 hunter2-secret' }] } } })
    f.fire(1)
    expect(f.steers.length).toBe(1)
    expect(f.steers[0]).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · BOUNDARY GUARD]')
    expect(f.steers[0]).toContain('hunter2-secret')
  })

  it('连续命中达上限 → 放弃打回（不再 steer）+ 状态清理', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'web-search 工具' }] } } })
    for (let i = 1; i <= REBUKE_MAX_ROUNDS + 1; i++) f.fire(i)
    // REBUKE_MAX_ROUNDS 次打回 + 最后一次放弃
    expect(f.steers.length).toBe(REBUKE_MAX_ROUNDS)
    expect(rebukeStates.has('轨迹约束-qa-uuid')).toBe(false)
  })

  it('合规轮重置连续计数（先命中后合规 → 计数清零）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'SSH_UBUNTU_PASSWORD' }] } } })
    f.fire(1)
    expect(f.steers.length).toBe(1)
    expect(rebukeStates.get('轨迹约束-qa-uuid')?.consecutive).toBe(1)
    // 合规轮
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正常回答' }] } } })
    f.fire(2)
    expect(rebukeStates.has('轨迹约束-qa-uuid')).toBe(false)
  })

  it('本地维护会话（普通 dsh id）→ 豁免不检测（用户拍板：仅外部面）', () => {
    const f = fakeCtx('dsh-local-maintenance')
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'dsh-serenity-hooks 与 mech-registry 维护记录' }] } } })
    f.fire(1)
    expect(f.steers).toEqual([])
  })

  it('🔴 反向钉：`acp-` 前缀会话**不再**被特殊对待（2026-11-15 owner 令清除所有 ACP 代码）', () => {
    // 历史：`isExternalFaceSession` 曾有一条 `sessionId.startsWith('acp-')` —— 那是**死判据**
    // （该前缀从无生产者；面 E 已于 2026-10-15 退役）。2026-11-15 owner 明令「ACP 所有代码清除」
    // ⇒ 分支删除。本用例由"钉住契约仍在"翻转为"**钉住它已不在**"。
    // 🔴 为什么保留而不是直接删用例：删了就没有任何东西阻止别人**悄悄把它加回来**。
    //    现在这条会红 —— 红的意思是"acp- 又被当外部面了，你去看看是谁加回来的"。
    const f = fakeCtx('acp-session-uuid')
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'vlm-describe 输出' }] } } })
    f.fire(1)
    expect(f.steers.length).toBe(0)
  })

  it('非 CCC 目录（无 .serenity）→ 零干预', () => {
    const outside = mkdtempSync(join(tmpdir(), 'og-outside-'))
    const f = fakeCtx()
    f.agent.session.header = { cwd: outside }
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hunter2-secret 密码' }] } } })
    f.fire(1)
    expect(f.steers).toEqual([])
    rmSync(outside, { recursive: true, force: true })
  })

  it('v1.27.7 think 块内敏感词 → 不检测不打回（think 不输出给用户）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    // think 内含凭据词 + 机制词（思考过程推演内部机制是正常的）——检测只针对最终呈现文本
    // 真实标签 = <think>（5 字母）——matchOpenThink 只匹配 `<think` 后跟 `>`/空白
    const raw = '<think>\n这里需要检查 SSH_UBUNTU_PASSWORD 与 dsh-serenity-hooks 的配置\n</think>\n这是正常的回答内容'
    f.agent.session.events.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: raw }] } },
    })
    f.fire(1)
    expect(f.steers).toEqual([])
  })
})

/**
 * ⑤ 第 20 件：**边界与失败路径**（挑靶依据 = 覆盖率报告的 `cbranch-no`/`cstat-no`，**不是**"再测一遍正常路径"）。
 *
 * 本文件上面那组只走**顺利路径**（外部面 ∧ 有文本 ∧ steer 不抛 ∧ turn 有值）⇒ 下列**真实可达**的
 * 分支从未被执行：`payload` 无 agent ／ 会话 id 缺失 ／ `session.header` 缺失（cwd 回落）／
 * 无可用最终输出（**四种事件形状**）／`payload.turn` 缺失（两条日志各一处回落）／`agent.steer` 抛错。
 * 🔴 与 `tools/msm/service.ts` 那类"平台门/不可达"不同 —— 这些**都是产线会真走到的路**（宿主事件形状不保证齐全）。
 */
describe('output-guard-seam: 边界与失败路径（⑤ 第 20 件）', () => {
  /** 可变夹具：**每条用例只针对一个具体分支**（不要用它去"再测一遍正常路径"） */
  function harness(opts: { omitSessionId?: boolean; sessionId?: string; withHeader?: boolean; steerThrows?: boolean } = {}) {
    const steers: string[] = []
    let hook: ((p: { agent?: unknown; turn?: number }) => void) | undefined
    const session: Record<string, unknown> = { events: [] as unknown[] }
    if (opts.omitSessionId !== true) session.id = opts.sessionId ?? '轨迹约束-edge-uuid'
    if (opts.withHeader !== false) session.header = { cwd: dir }
    const agent = {
      id: 'edge-agent',
      session,
      steer: (m: { content?: Array<{ type?: string; text?: string }> }) => {
        if (opts.steerThrows === true) throw new Error('steer boom')
        steers.push(m.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') ?? '')
      },
    }
    let cb: ((p: unknown) => void) | undefined
    return {
      steers,
      agent,
      /** 缺 turn ⇒ 覆盖 `payload.turn ?? '?'` 的**回落侧** */
      fire: (turn?: number) => (turn === undefined ? cb?.({ agent }) : cb?.({ agent, turn })),
      fireNoAgent: () => cb?.({}),
      register: () => registerOutputGuardHook({ on: (_ev: string, fn: (p: unknown) => void) => { cb = fn as (p: unknown) => void } } as never),
    }
  }

  const SENSITIVE_EVENT = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '密码是 hunter2-secret' }] } } }

  it('payload 缺 agent ⇒ 直接 return（不抛）', () => {
    const f = harness()
    f.register()
    expect(() => f.fireNoAgent()).not.toThrow()
    expect(f.steers).toEqual([])
  })

  it('会话 id 缺失 ⇒ 判为非外部面 ⇒ 不检测（同批覆盖 `id ?? 空串` 回落）', () => {
    const f = harness({ omitSessionId: true })
    f.register()
    f.agent.session.events.push(SENSITIVE_EVENT)
    f.fire(1)
    expect(f.steers).toEqual([])
  })

  it('session.header 缺失 ⇒ cwd 回落 process.cwd()（spy 钉在无 .serenity 的临时目录 ⇒ 零干预）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'og-nocwd-'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(outside)
    try {
      const f = harness({ withHeader: false })
      f.register()
      f.agent.session.events.push(SENSITIVE_EVENT)
      f.fire(1)
      // 结构判据：`header` 整个缺席 ⇒ `header?.cwd` 必为 undefined ⇒ `?? process.cwd()` **必然**执行
      expect(cwd).toHaveBeenCalled()
      expect(f.steers).toEqual([]) // 非 CCC ⇒ 零干预
    } finally {
      cwd.mockRestore()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('无可用文本的四种事件形状 ⇒ 不打回（逐条覆盖 `??` 回落与"text 为空"）', () => {
    const f = harness()
    f.register()
    // 逆序扫描（从末尾往前）⇒ 末条先被看：
    f.agent.session.events.push(
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '正常回答' }] } }, // 覆盖 `?? e.data?.content`
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } }, // 非 text 块 ⇒ text 为空
      { type: 'assistant/message', data: {} }, // 两个 content 都缺 ⇒ `?? []`
      { type: 'tool/call', data: {} }, // 非 assistant/message 事件
    )
    f.fire(1)
    expect(f.steers).toEqual([]) // 最终取到的文本 = 首条（'正常回答' ⇒ 无命中）
  })

  it('完全无可用文本 ⇒ 返回空串 ＋ 不检测（工具调用轮等）', () => {
    const f = harness()
    f.register()
    f.agent.session.events.push(
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
      { type: 'tool/call', data: {} },
    )
    f.fire(1)
    expect(f.steers).toEqual([])
  })

  it('payload.turn 缺失 ⇒ 两条日志都回落 `?`（打回行与放弃行各一处）', () => {
    const f = harness()
    f.register()
    f.agent.session.events.push(SENSITIVE_EVENT)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let i = 0; i < REBUKE_MAX_ROUNDS + 1; i++) f.fire()
      const logs = log.mock.calls.map((c) => c.join(' ')).join('\n')
      const warns = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logs).toContain('turn=?')
      expect(warns).toContain('turn=?')
      expect(f.steers.length).toBe(REBUKE_MAX_ROUNDS)
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })

  it('agent.steer 抛错 ⇒ 不向外抛 ＋ 告警（打回机制失效不得拖垮 turn）', () => {
    const f = harness({ steerThrows: true })
    f.register()
    f.agent.session.events.push(SENSITIVE_EVENT)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => f.fire(1)).not.toThrow()
      expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('steer failed')
      expect(f.steers).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('agent.steer 抛**非 Error**（无 `message` 字段）⇒ 告警仍成立（覆盖 `?? error` 回落侧）', () => {
    const f = harness()
    f.agent.steer = () => {
      throw { code: 'E_FAIL' } // 非 Error：`(error as Error)?.message` 为 undefined ⇒ 走 `?? error`
    }
    f.register()
    f.agent.session.events.push(SENSITIVE_EVENT)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => f.fire(1)).not.toThrow()
      expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('steer failed')
    } finally {
      warn.mockRestore()
    }
  })
})
