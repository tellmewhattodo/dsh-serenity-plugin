import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  registerTrajectorySession,
  unregisterTrajectorySession,
  trajectoryDirNameForSession,
  trajectorySessionInfo,
  trajectorySessionSnapshot,
  getTrajectoryAgent,
  trajectoryConstraintFor,
  trajectoryConstraintByCode,
  trajectoryConstraintToolWhitelist,
  trajectoryWorkspaceMdPath,
  ensureWorkspacePromptSection,
  workspaceCognitiveTrajectoryLine,
  trajectoryConstraintParticipates,
  trajectoryConstraintMsmGate,
  askTrajectory,
  createTrajectoryAgent,
  type TrajectoryConstraint,
} from '../src/trajectory/session.js'
import { resetTrajectorySessions } from '../src/trajectory/policy/window.js'
import {
  profileToolWhitelist,
  profileMsmWhitelist,
  constraintCognitiveTrajectory,
  resolveConstraintSystemPrompt,
  constraintSystemPromptSource,
  createProfilePromptReader,
  TRAJECTORY_CONSTRAINT_HINT,
} from '../src/trajectory/policy/rules.js'
import { appendBound } from '../src/trajectory/bound.js'
import { TRAJECTORY_CONSTRAINT_FILENAME } from '../src/trajectory/policy/profile.js'
import { makeTrajectory, make轨迹约束Session, 轨迹约束Json, profileFor } from './helpers/trajectory-constraint-fixture.js'

/**
 * trajectory-session 单测（**2026-10-19 重做后**）。
 *
 * ## 这次重写删掉了什么、为什么删（R↓ —— 删的是"特性没了"，不是"断言碍事"）
 *
 * owner 2026-10-19 重做令（逐字）：**轨迹约束本身是认知轨迹的一个特殊情况，即目录下拥有
 * `trajectory-constraint.json` 的认知轨迹自动是一个 轨迹约束**。旧的"角色"模型（`serenity.json` 的
 * `轨迹约束.roles.<name>` ＋ sessionId 前缀 `轨迹约束-` ＋ 另建工作台 SESSION ＋
 * `kind: temporary|persistent`）整块退役。
 *
 * | 旧测试组 | 处置 | 理由（判据 = 生产代码里那个机制**已不存在**） |
 * |---|---|---|
 * | `轨迹约束RoleFor` 命中/未命中（会话注册表组内） | **删** | 角色名不再是身份，`registry.ts` 里已无此函数；身份 = 轨迹编码 |
 * | `ensureTrajectorySession` 专属 SESSION 整组（自动创建 / 幂等 / 每用户隔离 / 旧 bound 不认 / 跨消息恢复 / bindings 自愈 / `persistent=false` 零熵增） | **删** | `ensureTrajectorySession` 已删除：工作台**就是该轨迹自己的 SESSION.md**，没有"另建"这个动作，也没有 per-轨迹约束-session 的工作台 |
 * | `kind: temporary`（建快照提示词、不建工作台） | **删** | 临时/持久二分已删：轨迹约束 永远是轨迹、永远有 SESSION.md ⇒ 该二分**没有指称对象** |
 * | `kind: persistent`（无 sessionId 也建工作台 + 热更） | **删** | 同上；且"热不热更"现在**不再按身份二分**，而是提示词**文件按 mtime 热重载 / JSON 每轮重读**（见下方"提示词热生效"组） |
 * | `trajectoryConstraintParticipates`「未注册 ⇒ 保守旁路 false」 | **改写** | 语义**翻转**：现在"不是 轨迹约束"⇒ 恒 true（fail-open，正常参与纪律）。旧实现靠 sessionId 前缀猜身份，前缀命中却没登记 ⇒ 判成 轨迹约束 并拒绝；新判据是"绑定的轨迹有没有 `trajectory-constraint.json`"，查不到就是普通轨迹 ⇒ 放行 |
 * | `trajectoryConstraintMsmGate`「轨迹约束会话未注册 ⇒ 拒绝」 | **改写** | 同上（fail-open 的一致后果）：查不到 `trajectory-constraint.json` = 不是 轨迹约束 = 门控不生效 |
 * | `askTrajectory` 结果里的 `cognitiveTrajectory` 断言 | **删** | 该字段已从返回类型移除（返回只剩 `{answer, sessionId}`）；断言改为**钉返回形状** |
 * | `createTrajectoryAgent` 的 `serenity-轨迹约束-workspace` 段「有/无工作台」对比 | **改写** | 不再由"建不建工作台"决定，而由**会话有没有登记轨迹**决定（`trajectoryWorkspaceMdPath(root, id)` 非空才挂） |
 *
 * ## 本文件钉的七件事（每条都对应新模型里一个会漂的面）
 *  ① 注册表 = 会话 → **轨迹**（`{trajectoryDirName, ccc}`；没有角色名了）；
 *  ② 工作台 = 该轨迹自己的 `SESSION.md`（**纯查询，零创建**）；
 *  ③ `createTrajectoryAgent` 吃 **约束面**（不是角色名 + 角色配置），并把它登记进注册表；
 *  ④ 提示词**文件**按 mtime 热重载、**JSON** 每轮重读（两个热路径，别混）；
 *  ⑤ 纪律子集默认**全 true**（工作台就是它自己的身体 ⇒ 拿得到自己）；
 *  ⑥ 守门查询一律**单一判据**（`trajectoryConstraintForSession`），且 **fail-open**；
 *  ⑦ `askTrajectory` 的本轮判据 = assistant 计数**增长**（不复读上一轮）。
 *
 * 判据本身的读盘形态（文件存在性 / 缺省值 / 坏 JSON / 两来源并取）在
 * `tests/轨迹约束-profile.test.ts`；本文件只测**约束如何被施加**。
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trajectory-session-'))
  writeFileSync(join(root, '.serenity'), 'test')
  resetTrajectorySessions()
})

afterEach(() => {
  resetTrajectorySessions()
  rmSync(root, { recursive: true, force: true })
})

/** CCC 级配置（`trajectory-constraint.json` 之外的容器配置——本文件只用于 CCC 级 cognitiveTrajectory.skills） */
function writeCCCConfig(cfg: unknown): void {
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

/** 建一条轨迹并按编码取它的约束面（= 生产代码里 `trajectoryConstraintByCode` 的路径） */
function profileOf(code: string, json: Record<string, unknown>): TrajectoryConstraint {
  makeTrajectory(root, code, json)
  const p = trajectoryConstraintByCode(root, code)
  if (p === null) throw new Error(`fixture: trajectory "${code}" has no trajectory-constraint.json`)
  return p
}

/**
 * 把一个会话登记到某条**普通轨迹**（该轨迹没有 `trajectory-constraint.json` ⇒ 它不是 轨迹约束）。
 *
 * ⚠️ 不能用 `make轨迹约束Session(root, id, code, null)` 造这个形态：夹具里 `profile ?? {}`
 * 会把 `null` 变成 `{}`，等于**写出一份空 trajectory-constraint.json**（那样它就成了 轨迹约束）⇒ 用本函数显式造。
 */
function bindPlainTrajectory(sessionId: string, code: string): string {
  const { dirName } = makeTrajectory(root, code, null)
  registerTrajectorySession(sessionId, dirName, root, fakeAgent(sessionId) as never)
  return dirName
}

interface Section {
  name: string
  order?: number
  text: () => string
}

interface FakeAgent {
  session: { id: string; events: unknown[] }
  followup: () => void
}

/** 假 agent（只提供注册表 / askTrajectory 需要的最小面） */
function fakeAgent(sessionId: string, events: unknown[] = []): FakeAgent {
  return { session: { id: sessionId, events }, followup: () => {} }
}

/** 写文件并把 mtime 明确推后（让 mtime 缓存判据在测试里确定，不依赖文件系统时间粒度） */
function writeAndTouch(path: string, text: string): void {
  writeFileSync(path, text, 'utf-8')
  const t = new Date(Date.now() + 2000)
  utimesSync(path, t, t)
}

// ── ① 会话注册表：会话 → 轨迹 ────────────────────────────────────────────────

describe('trajectory-session: 会话注册表（会话 → 轨迹，不再有角色名）', () => {
  it('register → 轨迹目录名 + CCC 绑定可查；snapshot 值是 {trajectoryDirName, ccc}', () => {
    // ⛔ 旧用例断言的是 `轨迹约束RoleFor(id) === 'qa-readonly'`：`轨迹约束RoleFor` 已从 registry 删除
    //    （角色名这个概念不存在了，身份 = 轨迹编码）⇒ 断言换成"查得到哪条轨迹"。
    const { dirName } = makeTrajectory(root, 'qa-readonly', 轨迹约束Json({ msms: ['x'] }))
    const agent = fakeAgent('sess-registry-1')
    registerTrajectorySession(agent.session.id, dirName, root, agent as never)
    expect(trajectoryDirNameForSession(agent.session.id)).toBe(dirName)
    expect([...trajectorySessionSnapshot().entries()]).toEqual([
      [agent.session.id, { trajectoryDirName: dirName, ccc: root }],
    ])
    unregisterTrajectorySession(agent.session.id)
    expect(trajectoryDirNameForSession(agent.session.id)).toBeNull()
    expect(trajectorySessionSnapshot().size).toBe(0)
  })

  it('trajectorySessionInfo 返回 trajectoryDirName + ccc 绑定（追问校验用）', () => {
    const { dirName } = makeTrajectory(root, 'qa', 轨迹约束Json({ msms: ['x'] }))
    const agent = fakeAgent('sess-info-1')
    registerTrajectorySession(agent.session.id, dirName, root, agent as never)
    expect(trajectorySessionInfo(agent.session.id)).toEqual({ trajectoryDirName: dirName, ccc: root })
    expect(trajectorySessionInfo('sess-ghost-1')).toBeNull()
    unregisterTrajectorySession(agent.session.id)
    expect(trajectorySessionInfo(agent.session.id)).toBeNull()
  })

  it('getTrajectoryAgent 进程内会话查询（未注册 → undefined）', () => {
    const { dirName } = makeTrajectory(root, 'qa', 轨迹约束Json({}))
    const agent = fakeAgent('sess-agent-1')
    registerTrajectorySession(agent.session.id, dirName, root, agent as never)
    expect(getTrajectoryAgent(agent.session.id)).toBe(agent)
    expect(getTrajectoryAgent('sess-ghost-2')).toBeUndefined()
    unregisterTrajectorySession(agent.session.id)
    expect(getTrajectoryAgent(agent.session.id)).toBeUndefined()
  })

  it('未登记的会话 → null（判据：没有映射就没有身份）', () => {
    expect(trajectoryDirNameForSession('sess-unknown-1')).toBeNull()
    expect(trajectoryDirNameForSession('normal')).toBeNull()
    expect(trajectorySessionInfo('normal')).toBeNull()
  })

  it('resetTrajectorySessions 清空注册表（进程级状态，用例间复位）', () => {
    const { dirName } = makeTrajectory(root, 'reset', 轨迹约束Json({}))
    const agent = fakeAgent('sess-reset-1')
    registerTrajectorySession(agent.session.id, dirName, root, agent as never)
    resetTrajectorySessions()
    expect(trajectorySessionSnapshot().size).toBe(0)
    expect(trajectoryDirNameForSession(agent.session.id)).toBeNull()
  })
})

describe('trajectory-session: 判据入口（core 只转发，不另立判据）', () => {
  it('trajectoryConstraintFor：登记了 + 有 trajectory-constraint.json ⇒ 拿到约束面；否则 null', () => {
    make轨迹约束Session(root, 'sess-轨迹约束', 'withprofile', 轨迹约束Json({ tools: ['read'] }))
    bindPlainTrajectory('sess-plain', 'noprofile')
    expect(trajectoryConstraintFor(root, 'sess-轨迹约束')?.code).toBe('withprofile')
    expect(trajectoryConstraintFor(root, 'sess-plain'), '登记过但没有 trajectory-constraint.json ⇒ 不是 轨迹约束').toBeNull()
    expect(trajectoryConstraintFor(root, 'sess-ghost')).toBeNull()
    expect(trajectoryConstraintFor(root, undefined)).toBeNull()
  })

  it('trajectoryConstraintByCode：按轨迹编码取（只精确匹配），普通轨迹 / 未知编码 → null', () => {
    makeTrajectory(root, 'bycode', 轨迹约束Json({ msms: ['m1'] }))
    makeTrajectory(root, 'plain', null)
    expect(trajectoryConstraintByCode(root, 'bycode')?.msms).toEqual(['m1'])
    expect(trajectoryConstraintByCode(root, 'byc'), '前缀不算命中').toBeNull()
    expect(trajectoryConstraintByCode(root, 'plain')).toBeNull()
    expect(trajectoryConstraintByCode(root, 'ghost')).toBeNull()
  })
})

// ── ② 工作台 = 该轨迹自己的 SESSION.md ───────────────────────────────────────

describe('trajectory-session: 工作台（= 轨迹自己的 SESSION.md，零创建）', () => {
  // ⛔ 旧「ensureTrajectorySession 专属 SESSION」整组已删：那个机制不存在了。
  //    `ensureTrajectorySession` 曾负责"给 轨迹约束 另建一个 SESSION + 激活 + 写 bound"，
  //    连带 `persistent` 开关、`auto-created for 轨迹约束 role` 标记、`.bindings.json` 自愈、
  //    "S159 手工 bound 不认"等一整套 per-轨迹约束-session 工作台机制。
  //    新模型里 **工作台就是这条轨迹的 SESSION.md** ⇒ 语义退化为纯查询，断言从
  //    "建了什么" 改为 "指到哪个已有文件" + "没有就 null（不创建、不激活、不写绑定）"。

  it('已登记的 轨迹约束会话 → 该轨迹的 SESSION.md 路径（不是新建的别处）', () => {
    const dirName = make轨迹约束Session(root, 'sess-ws', 'ws', 轨迹约束Json({}), '工作台')
    expect(trajectoryWorkspaceMdPath(root, 'sess-ws')).toBe(join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'))
    // 🔴 关键不变量：查询**不产生任何文件** —— AGENT_SESSIONS 下仍只有它自己那一条轨迹
    expect(activeTrajectoryDirs()).toEqual([dirName])
  })

  it('两个会话各挂各的轨迹 → 工作台互不共享（不再有"per-user 工作台"，是"per-trajectory"）', () => {
    const dirA = make轨迹约束Session(root, 'sess-a', 'traj-a', 轨迹约束Json({}), '甲')
    const dirB = make轨迹约束Session(root, 'sess-b', 'traj-b', 轨迹约束Json({}), '乙')
    const mdA = trajectoryWorkspaceMdPath(root, 'sess-a')
    const mdB = trajectoryWorkspaceMdPath(root, 'sess-b')
    expect(mdA).toBe(join(root, 'AGENT_SESSIONS', dirA, 'SESSION.md'))
    expect(mdB).toBe(join(root, 'AGENT_SESSIONS', dirB, 'SESSION.md'))
    expect(mdA).not.toBe(mdB)
  })

  it('不是 轨迹约束（未登记）→ null；且不会顺手建一个工作台', () => {
    expect(trajectoryWorkspaceMdPath(root, 'sess-ghost')).toBeNull()
    expect(trajectoryWorkspaceMdPath(root, undefined)).toBeNull()
    expect(existsSync(join(root, 'AGENT_SESSIONS')), '查不到就什么都不做').toBe(false)
  })

  it('已登记但轨迹的 SESSION.md 不在 → null（不创建占位文件）', () => {
    const { dirName, dir } = makeTrajectory(root, 'nosession', 轨迹约束Json({}))
    rmSync(join(dir, 'SESSION.md'))
    registerTrajectorySession('sess-nosession', dirName, root, fakeAgent('sess-nosession') as never)
    expect(trajectoryWorkspaceMdPath(root, 'sess-nosession')).toBeNull()
    expect(existsSync(join(dir, 'SESSION.md'))).toBe(false)
  })

  it('workspaceCognitiveTrajectoryLine：完整纪律块含 SESSION.md 路径 + 写入/rebuild 约束', () => {
    const line = workspaceCognitiveTrajectoryLine('/x/AGENT_SESSIONS/2026-10-19--my-role--轨迹/SESSION.md')
    expect(line).toContain('SESSION.md: /x/AGENT_SESSIONS/2026-10-19--my-role--轨迹/SESSION.md')
    // v1.30.13（D5）：不点名具体工具 —— 旧文案 "with write/edit" 指向未必被授权的工具
    expect(line).not.toContain('write/edit')
    expect(line).toContain('write channel')
    expect(line).toContain('never assume')
    expect(line).toContain('cognitive_trajectory rebuild')
  })

  it('ensureWorkspacePromptSection：挂 serenity-轨迹约束-workspace 段（order -55），text 指向当前 SESSION.md', () => {
    const dirName = make轨迹约束Session(root, 'sess-ws-sec', 'ws-sec', 轨迹约束Json({}))
    const sections: Section[] = []
    const agent = { ctx: { systemPrompt: { section: (s: Section) => sections.push(s) } } }
    expect(ensureWorkspacePromptSection(agent as never, 'sess-ws-sec', root)).toBe(true)
    const ws = sections.find((s) => s.name === 'serenity-轨迹约束-workspace')
    expect(ws).toBeDefined()
    expect(ws?.order).toBe(-55)
    expect(ws?.text()).toContain(join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'))
  })

  it('ensureWorkspacePromptSection 幂等：同一 agent 只注册一次（不产生 duplicate section）', () => {
    make轨迹约束Session(root, 'sess-ws-idem', 'ws-idem', 轨迹约束Json({}))
    const sections: Section[] = []
    const agent = { ctx: { systemPrompt: { section: (s: Section) => sections.push(s) } } }
    expect(ensureWorkspacePromptSection(agent as never, 'sess-ws-idem', root)).toBe(true)
    expect(ensureWorkspacePromptSection(agent as never, 'sess-ws-idem', root)).toBe(true)
    expect(sections.filter((s) => s.name === 'serenity-轨迹约束-workspace')).toHaveLength(1)
  })

  it('挂不上段（无 systemPrompt.section）→ false，不抛错（调用方降级）', () => {
    make轨迹约束Session(root, 'sess-ws-nocap', 'ws-nocap', 轨迹约束Json({}))
    expect(ensureWorkspacePromptSection({ ctx: {} } as never, 'sess-ws-nocap', root)).toBe(false)
    expect(ensureWorkspacePromptSection(null as never, 'sess-ws-nocap', root)).toBe(false)
  })

  it('段已挂但会话后来不是 轨迹约束（无工作台）→ text() 返回空串（宿主丢弃空 section，不留噪声）', () => {
    make轨迹约束Session(root, 'sess-ws-then-gone', 'ws-gone', 轨迹约束Json({}))
    const sections: Section[] = []
    const agent = { ctx: { systemPrompt: { section: (s: Section) => sections.push(s) } } }
    expect(ensureWorkspacePromptSection(agent as never, 'sess-ws-then-gone', root)).toBe(true)
    unregisterTrajectorySession('sess-ws-then-gone')
    expect(sections.find((s) => s.name === 'serenity-轨迹约束-workspace')?.text()).toBe('')
  })
})

// ── ③ createTrajectoryAgent：吃约束面，挂 preset，登记轨迹 ─────────────────────────

/** 记录型 ctx（agents.create + section 收集 + preset 挂载记录） */
function recordingCtx(withPreset = true, hostDefaultModel?: { provider?: string; model?: string } | null): {
  ctx: unknown
  sections: Section[]
  mounted: Array<{ id: string }>
  created: Array<Record<string, unknown>>
} {
  const sections: Section[] = []
  const mounted: Array<{ id: string }> = []
  const created: Array<Record<string, unknown>> = []
  const ctx = {
    // 🔴 v1.105.0：宿主默认模型的替身。`hostAgentDefaultModel` 走 `hostInjected`
    //   （先直接属性读、抛错再回落 `ctx.get`）⇒ 这里两种形态都给，才不偏袒任一路。
    ...(hostDefaultModel === null
      ? {}
      : {
          agentDefaultModel: {
            currentSelection: () => hostDefaultModel ?? { provider: 'host-prov', model: 'host-model' },
          },
        }),
    agents: {
      create: async (opts: Record<string, unknown>) => {
        created.push(opts)
        const agentCtx = {
          get: (name: string) =>
            withPreset && name === 'agentPresets'
              ? { mount: async (_c: unknown, id: string) => { mounted.push({ id }) } }
              : undefined,
          systemPrompt: { section: (s: Section) => sections.push(s) },
        }
        await (opts.setup as ((c: unknown) => Promise<void>) | undefined)?.(agentCtx)
        return {
          agent: {
            ctx: agentCtx,
            session: { id: opts.sessionId as string, events: [] },
            followup: () => {},
          },
        }
      },
    },
  }
  return { ctx, sections, mounted, created }
}

describe('trajectory-session: createTrajectoryAgent（preset 挂载 + 约束面注入 + 注册表）', () => {
  it('挂 standard preset + 约束面的模型 + scoped 提示词 + 注册表登记（身份 = 轨迹）', async () => {
    // ⛔ 旧用例的入参是 `(ctx, root, 'qa', {model,msms,tools,systemPrompt})`（角色名 + 角色配置）；
    //    新入参是 `(ctx, root, profile)` —— 约束面整体来自轨迹里的 `trajectory-constraint.json`。
    const profile = profileOf('main', 轨迹约束Json({ model: 'p/m', msms: ['x'], tools: ['read'], systemPrompt: '轨迹人格' }))
    const { ctx, sections, mounted, created } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    // preset 挂载（平台工具面——read/grep/glob/web_search 可用的关键）
    expect(mounted).toEqual([{ id: 'standard' }])
    // meta 记录 agentPreset（重建恢复工具面）
    expect(created[0]?.meta).toEqual({ cwd: root, agentPreset: 'standard' })
    // 模型来自约束面
    expect(created[0]?.agentOptions).toEqual({ provider: 'p', model: 'm' })
    // scoped 系统提示词（基础段含轨迹编码 + CCC 段）
    expect(sections[0]?.name).toBe('serenity-轨迹约束')
    expect(sections[0]?.order).toBe(-60)
    expect(sections[0]?.text()).toContain('=== Serenity 轨迹约束 ===')
    expect(sections[0]?.text()).toContain('main')
    expect(sections[0]?.text()).toContain('轨迹人格')
    // 注册表登记的是**轨迹**（不再是角色名）
    expect(trajectorySessionInfo(ref.sessionId)).toEqual({ trajectoryDirName: profile.dirName, ccc: root })
    expect(ref.sessionId.startsWith('轨迹约束-main-')).toBe(true)
    // 会话未登记轨迹 ⇒ 不挂工作台段（判据是"有没有工作台"，不是"是不是 persistent"）
    expect(sections.find((s) => s.name === 'serenity-轨迹约束-workspace')).toBeUndefined()
    unregisterTrajectorySession(ref.sessionId)
  })

  /**
   * 🔴🔴 **v1.105.0 回归钉（这条用例的方向被彻底反转了一次，理由必须写在用例里）**
   *
   * **v1.102.0 写的是**：「未声明 model ⇒ ⛔ 不得出现 `agentOptions` 键」。
   * 那条判据的**前提是错的** —— 它只验了"`agents.create` 不传 `agentOptions` 是合法的"，
   * **没验下游有没有人要求这个值必须存在**。真机结果是：宿主 persona 模板
   * `powered by the {{model}} model` 严格插值，`agent.options.model === undefined` ⇒
   * **每一轮装配都抛 `prompt variable "{{model}}" has no value` ⇒ 该轨迹完全不可用**
   * （实测：本容器两条 IM 轨迹，2026-10-28）。
   *
   * ⇒ 现在的判据：**未声明 model ⇒ 必须回落到「宿主承认的默认模型」，不许留空**。
   *   回落来源是 `agentDefaultModel.currentSelection()` —— 宿主契约逐字
   *   *"Default model selection for Agents created **without an explicit model**"*。
   *
   * ⚠️ 与旧回落（`cheap-worker.defaultModel`）的区别不是"谁的值更好"，而是：
   *   **旧的是我们自己的一份猜测且已退役，新的是宿主自己承认的默认**。
   */
  it('🔴 未声明 model ⇒ 回落到宿主默认模型（⛔ 绝不留空 —— 留空必炸每一轮）', async () => {
    const profile = profileOf('nomodel', 轨迹约束Json({ systemPrompt: '人格' }))
    const { ctx, created } = recordingCtx(true, { provider: 'host-prov', model: 'host-model' })
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    expect(
      created[0]?.agentOptions,
      '未声明 model ⇒ 必须带上宿主默认模型（留空 ⇒ persona 模板 {{model}} 无值 ⇒ 整轮失败）',
    ).toEqual({ provider: 'host-prov', model: 'host-model' })
    unregisterTrajectorySession(ref.sessionId)
  })

  it('🔴 声明了 model ⇒ 用声明的那个（不被宿主默认取代）', async () => {
    const profile = profileOf('withmodel', 轨迹约束Json({ model: 'mine/m1', systemPrompt: '人格' }))
    const { ctx, created } = recordingCtx(true, { provider: 'host-prov', model: 'host-model' })
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    expect(created[0]?.agentOptions).toEqual({ provider: 'mine', model: 'm1' })
    unregisterTrajectorySession(ref.sessionId)
  })

  it('🔴 宿主没有 agentDefaultModel 服务 ⇒ 仍不传 agentOptions，但**响亮告警**（不静默）', async () => {
    const profile = profileOf('noservice', 轨迹约束Json({ systemPrompt: '人格' }))
    const { ctx, created } = recordingCtx(true, null) // null ⇒ ctx 上根本没有该服务
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    // 那种宿主自己也没有默认 ⇒ 不编一个值出来（编了就是第二真相源）
    expect(created[0]).not.toHaveProperty('agentOptions')
    // 🔴 但必须出声：否则用户只看到宿主那句指不到根因的 {{model}} 报错
    expect(warn.mock.calls.some((c) => String(c[0]).includes('没有可用模型'))).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('has no value'))).toBe(true)
    warn.mockRestore()
    unregisterTrajectorySession(ref.sessionId)
  })

  it('基础提示词不抄工具/MSM 清单（第二真相源 = 模型自己的 schema 与 msm() 目录）', async () => {
    // ⚠️ 断言打在**真正注入的那段**上，不是打在 buildTrajectoryBasePrompt 的返回值上——
    //    否则这条用例只钉了纯函数，没钉"注入面真的是它"。
    const profile = profileOf('nomanifest', 轨迹约束Json({ tools: ['read', 'grep'], msms: ['m1', 'm2'] }))
    const { ctx, sections } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    const injected = sections.find((s) => s.name === 'serenity-轨迹约束')!.text()
    expect(injected).toContain('=== Serenity 轨迹约束 ===')
    expect(injected).toContain('Cognitive trajectory: nomanifest')
    expect(injected, '不得枚举工具清单（真相源 = 本轮 tool schema）').not.toContain('grep')
    expect(injected, '不得枚举 MSM 清单（真相源 = msm() 目录）').not.toContain('m1')
    expect(injected).toContain('msm()')
    unregisterTrajectorySession(ref.sessionId)
  })

  it('systemPromptFile 优先：文件内容盖过内嵌 systemPrompt', async () => {
    mkdirSync(join(root, '.opencode', 'skiff'), { recursive: true })
    writeFileSync(join(root, '.opencode', 'skiff', 'qa.md'), '文件版提示词')
    const profile = profileOf('filefirst', {
      systemPromptFile: '.opencode/skiff/qa.md',
      systemPrompt: '旧内嵌（不应出现）',
    })
    const { ctx, sections } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    expect(sections[0]?.text()).toContain('文件版提示词')
    expect(sections[0]?.text()).not.toContain('旧内嵌')
    unregisterTrajectorySession(ref.sessionId)
  })

  it('systemPromptFile 缺失 → 降级仅基础段 + 不阻断创建（console.warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const profile = profileOf('missingfile', { systemPromptFile: '.opencode/skiff/missing.md' })
    const { ctx, sections } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    expect(sections[0]?.text()).toContain('=== Serenity 轨迹约束 ===')
    expect(sections[0]?.text()).not.toContain('CCC 完整定义')
    expect(warn, '读不到提示词文件必须响亮 —— 静默 = 人格与纪律消失').toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('读取失败'))).toBe(true)
    warn.mockRestore()
    unregisterTrajectorySession(ref.sessionId)
  })

  it('agentPresets 服务缺失 → 不阻断创建（回退全局工具层）', async () => {
    const profile = profileOf('nopreset', 轨迹约束Json({ msms: ['x'] }))
    const { ctx, mounted } = recordingCtx(false)
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    expect(mounted).toEqual([])
    expect(ref.sessionId.startsWith('轨迹约束-nopreset-')).toBe(true)
    unregisterTrajectorySession(ref.sessionId)
  })

  it('ctx.agents 缺失 → 抛错（不静默退化成一个没有 agent 的"成功"）', async () => {
    const profile = profileOf('noagents', 轨迹约束Json({}))
    await expect(createTrajectoryAgent({} as never, root, profile)).rejects.toThrow('ctx.agents unavailable')
  })

  it('🔴 不新建工作台轨迹：创建 轨迹约束 agent 后 AGENT_SESSIONS 下仍只有它自己那一条', async () => {
    // ⛔ 旧版对应的断言是"不建工作台 / 建工作台"（按 kind 二分）；新模型的等价事实是
    //    **工作台不会凭空多出一条轨迹**（旧机制整块删除的后果）——它就是 agent 自己那条。
    const profile = profileOf('nospace', 轨迹约束Json({ systemPrompt: '人格' }))
    const { ctx } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'sess-fixed-nospace')
    expect(activeTrajectoryDirs()).toEqual([profile.dirName])
    // 创建过程自带"会话 → 轨迹"登记 ⇒ 工作台随之可查，且指向的正是它自己（不靠任何开关）
    expect(trajectorySessionInfo(ref.sessionId)).toEqual({ trajectoryDirName: profile.dirName, ccc: root })
    expect(trajectoryWorkspaceMdPath(root, ref.sessionId)).toBe(join(root, 'AGENT_SESSIONS', profile.dirName, 'SESSION.md'))
    unregisterTrajectorySession(ref.sessionId)
  })

  it('createTrajectoryAgent 集成：已登记轨迹的会话 → 挂工作台段，指向它自己的 SESSION.md', async () => {
    // 生产序：桥先登记"会话 → 轨迹"，再建 agent ⇒ 测试同序。
    const dirName = make轨迹约束Session(root, 'sess-fixed-workspace', 'ws-role', 轨迹约束Json({ systemPrompt: '轨迹人格' }))
    const profile = profileFor(root, 'sess-fixed-workspace')!
    const { ctx, sections } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'sess-fixed-workspace')
    const base = sections.find((s) => s.name === 'serenity-轨迹约束')
    const ws = sections.find((s) => s.name === 'serenity-轨迹约束-workspace')
    expect(base?.text()).toContain('轨迹人格')
    expect(ws?.text()).toContain('Serenity Session Workspace')
    expect(ws?.text()).toContain(`SESSION.md: ${join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md')}`)
    expect(activeTrajectoryDirs(), '仍然只有那一条轨迹').toEqual([dirName])
    unregisterTrajectorySession(ref.sessionId)
  })

  it('🔴 CCC 级 cognitiveTrajectory.skills ⇒ 轨迹约束会话也拿到该 section（v1.44.0，owner「轨迹约束也支持」）', async () => {
    // CCC 级声明：一处声明、全容器生效（含 轨迹约束）
    writeCCCConfig({ cognitiveTrajectory: { skills: ['cce'] } })
    mkdirSync(join(root, '.dsh', 'skills', 'cce'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'skills', 'cce', 'SKILL.md'), '# CCE 正文')
    const dirName = make轨迹约束Session(root, 'sess-cccskills', 'cccskills', 轨迹约束Json({ systemPrompt: '轨迹人格' }))
    // 绑定：工作台随认知轨迹机制一起给出（`readLastBound` 是这份 section 的注册门）
    const session = {
      id: 'sess-cccskills',
      header: { id: 'sess-cccskills', cwd: root },
      events: [],
      snapshotEvents: (): unknown[] => session.events,
    }
    expect(appendBound(session, 'activate', {
      dirName,
      mdPath: join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'),
      sessionId: 'cccskills',
    }).ok).toBe(true)

    const sections: Section[] = []
    const ctx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = {
            get: () => undefined,
            systemPrompt: { section: (s: Section) => sections.push(s) },
          }
          await opts.setup?.(agentCtx)
          return { agent: { ctx: agentCtx, session, followup: () => {} } }
        },
      },
    }
    const profile = profileFor(root, 'sess-cccskills')!
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'sess-cccskills')
    // 轨迹约束 自己的段照旧在
    expect(sections.find((s) => s.name === 'serenity-轨迹约束')?.text()).toContain('轨迹人格')
    // 🔴 CCC 级 skill 供给也送达（复用同一 registerCognitiveTrajectorySkillSection，不另写一套）
    const injected = sections.find((s) => s.name === 'serenity-trajectory-skills')
    expect(injected).toBeDefined()
    expect(injected?.order).toBe(-45)
    expect(injected?.text()).toContain('=== skill: cce ===')
    expect(injected?.text()).toContain('# CCE 正文')
    unregisterTrajectorySession(ref.sessionId)
  })
})

// ── ④ 提示词热生效：文件按 mtime，JSON 每轮重读 ──────────────────────────────

describe('trajectory-session: 提示词热生效（文件 mtime / JSON 每轮 —— 不按身份二分）', () => {
  // ⛔ 旧的 persistent/temporary 四条用例已删：身份二分（kind）连同 ensureTrajectorySession 一起退役。
  //    保留并改写的，是它们真正想钉的那件事 —— **改配置要不要重启**。
  //    新答案：**永远不用重启**，但热更分两条路（别把它们混成一句）：
  //      ① `systemPromptFile` 指向的**文件**：按 mtime+size 缓存重读（改文件即生效）；
  //         连**路径本身**改了也生效（读取器按路径缓存，路径变则重建）。
  //      ② `trajectory-constraint.json` 的**其余部分**（tools / msms / cognitiveTrajectory）：守门每调用一次
  //         重读一次 ⇒ 改白名单下一轮就生效（owner 2026-10-19「工具清单也要热加载」令）。
  //    ⚠️ **内嵌 `systemPrompt` 是创建时快照**：JSON 没有 mtime 可比，这是 config.ts 的既定取舍；
  //    它的热更入口是"改用 systemPromptFile"（本组最后一条用例钉的就是这条路径）。
  //    TRAJECTORY_CONSTRAINT_HINT 就是对外说的这句话，两处（apply 回执 / 面板）共用一个串。

  it('提示词文件：改文件即生效（mtime 变化后读到新内容）', () => {
    const promptPath = join(root, 'live.md')
    writeAndTouch(promptPath, '第一版角色提示词')
    const profile = profileOf('hot-file', { systemPromptFile: 'live.md' })
    const read = createProfilePromptReader(root, profile)
    expect(read()).toBe('第一版角色提示词')
    writeAndTouch(promptPath, '第二版角色提示词（热更后）')
    expect(read()).toBe('第二版角色提示词（热更后）')
  })

  it('提示词文件读失败 → 沿用上次成功内容 + 告警去重（绝不返回空：空 = 人格与纪律消失）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const promptPath = join(root, 'gone.md')
    writeAndTouch(promptPath, '唯一一份好内容')
    const profile = profileOf('hot-fail', { systemPromptFile: 'gone.md' })
    const read = createProfilePromptReader(root, profile)
    expect(read()).toBe('唯一一份好内容')
    rmSync(promptPath)
    expect(read()).toBe('唯一一份好内容')
    expect(read()).toBe('唯一一份好内容')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('读取失败'))).toHaveLength(1)
    warn.mockRestore()
  })

  it('内嵌 systemPrompt：读取器本身是静态快照（它没有 mtime 可比）', () => {
    const profile = profileOf('inline', { systemPrompt: '内嵌人格' })
    const read = createProfilePromptReader(root, profile)
    expect(read()).toBe('内嵌人格')
    expect(constraintSystemPromptSource(profile)).toBe('inline')
  })

  it('🔴 改 trajectory.json 的约束面 → 守门立即跟上（JSON 每轮重读，不必重建 agent、不必重启）', async () => {
    // ⚠️ 这条才是 owner 2026-10-19「工具清单也要热加载」那句话的机械形态：
    //    守门每调用一次就重读一次声明文件 ⇒ 改了白名单/纪律，下一轮就生效。
    //    （提示词**内嵌**串是创建时快照——它没有 mtime 可比，见 config.ts 的说明；
    //      它的热更入口是"改用 systemPromptFile"，见下一条。）
    const profile = profileOf('hot-json', 轨迹约束Json({ msms: ['m1'], tools: ['read'] }))
    const { ctx } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'sess-hot-json')
    // 正控：创建时的约束面
    expect([...trajectoryConstraintToolWhitelist(root, ref.sessionId)!].sort()).toEqual(['msm', 'read'])
    expect(trajectoryConstraintMsmGate(root, ref.sessionId, 'exec', 'm2').reject, '白名单外').toBeDefined()
    // CCC 改了约束面：不重建 agent，不重启
    // 🔴 文件名**必须用常量**（不写死字面量）：它是"写入目标"，改名后写死会写到族里的旧名上，
    //    而读取侧优先命中新名 ⇒ 测试会以为"改了没生效"（本轨实测踩到）。
    writeFileSync(join(root, 'AGENT_SESSIONS', profile.dirName, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify({
      msms: ['m2'],
      tools: ['grep'],
      cognitiveTrajectory: { keeper: false },
    }), 'utf-8')
    expect([...trajectoryConstraintToolWhitelist(root, ref.sessionId)!].sort()).toEqual(['grep', 'msm'])
    expect(trajectoryConstraintMsmGate(root, ref.sessionId, 'exec', 'm2'), '新的白名单成员').toEqual({})
    expect(trajectoryConstraintMsmGate(root, ref.sessionId, 'exec', 'm1').reject, '旧的已被移出').toBeDefined()
    expect(trajectoryConstraintParticipates(root, ref.sessionId, 'keeper')).toBe(false)
    expect(trajectoryConstraintParticipates(root, ref.sessionId, 'rebuild'), '未写的项缺省 true').toBe(true)
    unregisterTrajectorySession(ref.sessionId)
  })

  it('🔴 换 systemPromptFile 路径 → 重建读取器（新路径的文件内容当轮生效）', async () => {
    writeAndTouch(join(root, 'a.md'), 'A 版提示词')
    writeAndTouch(join(root, 'b.md'), 'B 版提示词')
    const profile = profileOf('hot-path', { systemPromptFile: 'a.md' })
    const { ctx, sections } = recordingCtx()
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    const base = sections.find((s) => s.name === 'serenity-轨迹约束')!
    expect(base.text()).toContain('A 版提示词')
    writeFileSync(join(root, 'AGENT_SESSIONS', profile.dirName, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify({ systemPromptFile: 'b.md' }), 'utf-8')
    expect(base.text()).toContain('B 版提示词')
    expect(base.text()).not.toContain('A 版提示词')
    unregisterTrajectorySession(ref.sessionId)
  })

  it('提示词来源提示串：文件热重载 + JSON 每轮重读（面板与回执共用一句）', () => {
    expect(TRAJECTORY_CONSTRAINT_HINT).toContain('hot-reloads by mtime')
    expect(TRAJECTORY_CONSTRAINT_HINT).toContain('re-read every turn')
  })

  // ── 以下五条随旧角色模型一起删了，但判据仍成立（2026-10-19 迁移时补回）────────
  //
  // 旧用例住在 `tests/trajectory-constraint.test.ts`（随 `轨迹约束.roles` 整段退役而删除）。删之前逐条比过
  // 本文件与 `tests/轨迹约束-profile.test.ts`：**这五条的判据面在别处没有第二条用例**——它们都落在
  // `createProfilePromptReader` 内部的**独立分支**上（mtime+size 缓存命中、BOM 口径、逃逸降级、
  // 无约束面、热更日志），而那两处只钉了「改文件即生效」「读失败沿用上次」「内嵌是快照」。
  // ⇒ 跟着角色模型一起删 = 这些分支静默失去回归保护（且不会红，红的是"删掉也没人发现"）。
  //    它们属于**提示词热路径**，故补在本组（与 `轨迹约束-profile.test.ts` 的读盘判据分开：那边判
  //    "约束面读出来是什么"，这边判"读取器怎么用它"）。

  it('mtime+size 未变 ⇒ 命中缓存（返回同一字符串实例，零重复读盘/解析）', () => {
    const promptPath = join(root, 'stable.md')
    writeAndTouch(promptPath, '稳定内容')
    const read = createProfilePromptReader(root, profileOf('cache-hit', { systemPromptFile: 'stable.md' }))
    const a = read()
    const b = read()
    expect(a).toBe('稳定内容')
    // 身份相等（不是内容相等）⇒ 走的确实是缓存分支，没有重新 readFile + parse
    expect(b, '未变更时不重新解析 —— 引用相等即缓存命中').toBe(a)
  })

  it('🔴 BOM 剥除 + trim（Windows 编辑器写出的 \\uFEFF 前缀；与 resolveConstraintSystemPrompt 同口径）', () => {
    const promptPath = join(root, 'bom.md')
    writeAndTouch(promptPath, '\uFEFF 带 BOM  \n')
    const read = createProfilePromptReader(root, profileOf('bom', { systemPromptFile: 'bom.md' }))
    expect(read()).toBe('带 BOM')
  })

  it('systemPromptFile 越界 ⇒ 空读取器 + 告警（不抛错，装配不阻断）', () => {
    // ⚠️ 为什么这里**手工造** profile：读盘层（`readTrajectoryConstraintAt`）已经把越界项丢掉了
    //    （见「约束面派生纯函数」组的「越界路径被拒绝」）⇒ 从读盘层出来的约束面**永远走不到**
    //    读取器自己的逃逸分支。该分支是纵深防御（约束面由别的入口构造 / 配置在读盘与读取之间
    //    被改），钉它是为了防它被当成死代码删掉。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const escape = { ...profileOf('reader-escape', {}), systemPromptFile: '../outside.md' }
    const read = createProfilePromptReader(root, escape)
    expect(read(), '越界路径不给内容，也不抛错打断装配').toBe('')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('路径非法'))).toBe(true)
    warn.mockRestore()
  })

  it('无约束面（null）⇒ 空读取器（装配拿不到 profile 时不崩、也不给假内容）', () => {
    expect(createProfilePromptReader(root, null)()).toBe('')
  })

  it('热重载打一行 info 日志（首次不报，变更才报一次）', () => {
    const promptPath = join(root, 'logged.md')
    writeAndTouch(promptPath, 'v1')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const read = createProfilePromptReader(root, profileOf('reload-log', { systemPromptFile: 'logged.md' }))
    read()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('热重载')), '首次读取不是热重载').toHaveLength(0)
    writeAndTouch(promptPath, 'v2 更长一些的内容')
    read()
    expect(info.mock.calls.filter((c) => String(c[0]).includes('热重载')), '每次内容变更报一行').toHaveLength(1)
    info.mockRestore()
  })
})

// ── ⑤ resume-or-create（与角色模型无关：只讲会话怎么来） ───────────────────────

describe('trajectory-session: createTrajectoryAgent resume-or-create（v1.27.2 微信桥 id collision 修复 + v1.27.3 live 复用）', () => {
  /** fake ctx：agents.create + agents.resume 双路；resume 按模式（成功 / not-found / 缺方法 / live 恢复） */
  function fakeResumeCtx(mode: 'success' | 'not-found' | 'absent' | 'live'): {
    agents: Record<string, unknown>
    calls: Array<{ kind: string; id: string }>
  } {
    const calls: Array<{ kind: string; id: string }> = []
    const makeAgent = (id: string): unknown => {
      const agentCtx = { get: () => undefined, systemPrompt: { section: () => {} } }
      return { ctx: agentCtx, session: { id, events: [] }, followup: () => {} }
    }
    const makeHandle = async (kind: 'create' | 'resume', id: string, opts: { setup?: (c: unknown) => Promise<void> }): Promise<unknown> => {
      calls.push({ kind, id })
      await opts.setup?.(makeAgent(id) as never)
      return { agent: makeAgent(id) }
    }
    const agents: Record<string, unknown> = {
      create: (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => makeHandle('create', opts.sessionId, opts),
    }
    if (mode === 'success') {
      agents.resume = (opts: { resumeSessionId: string; setup?: (c: unknown) => Promise<void> }) => makeHandle('resume', opts.resumeSessionId, opts)
    } else if (mode === 'not-found') {
      agents.resume = async (opts: { resumeSessionId: string }) => {
        calls.push({ kind: 'resume', id: opts.resumeSessionId })
        const err = new Error(`session "${opts.resumeSessionId}" not found`)
        err.name = 'SessionPersistenceNotFoundError'
        throw err
      }
    } else if (mode === 'live') {
      // 重启后 DSH 恢复的 live 会话：resume 报 "while it is live"、create 报 "already exists"、
      // get 返回 live agent（v1.27.3 修复的根因场景）
      const liveAgent = makeAgent('skiff-weixin-live-1')
      agents.get = (id: string) => (id === 'skiff-weixin-live-1' ? liveAgent : undefined)
      agents.resume = async (opts: { resumeSessionId: string }) => {
        calls.push({ kind: 'resume', id: opts.resumeSessionId })
        throw new Error(`cannot prepare session "${opts.resumeSessionId}" while it is live`)
      }
      agents.create = async (opts: { sessionId: string }) => {
        calls.push({ kind: 'create', id: opts.sessionId })
        throw new Error(`session "${opts.sessionId}" already exists`)
      }
    }
    return { agents, calls }
  }

  it('固定 id + 磁盘已有持久化 log → resume（resumed=true，历史延续）', async () => {
    const profile = profileOf('resume-ok', 轨迹约束Json({ msms: ['x'] }))
    const ctx = fakeResumeCtx('success')
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'skiff-weixin-fixed-1')
    expect(ref.resumed).toBe(true)
    expect(ref.sessionId).toBe('skiff-weixin-fixed-1')
    expect(trajectorySessionInfo(ref.sessionId)?.trajectoryDirName).toBe(profile.dirName)
    unregisterTrajectorySession(ref.sessionId)
  })

  it('固定 id + resume not-found（首次无持久化）→ 降级 create（resumed=false + 新对话语义）', async () => {
    const profile = profileOf('resume-new', 轨迹约束Json({ msms: ['x'] }))
    const ctx = fakeResumeCtx('not-found')
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'skiff-weixin-fixed-2')
    expect(ref.resumed).toBe(false)
    expect(ref.sessionId).toBe('skiff-weixin-fixed-2')
    expect(trajectorySessionInfo(ref.sessionId)?.trajectoryDirName).toBe(profile.dirName)
    unregisterTrajectorySession(ref.sessionId)
  })

  it('固定 id + 会话已 live（重启后 DSH 恢复）→ live 复用，resume/create 均不调用（v1.27.3 修复）', async () => {
    const profile = profileOf('resume-live', 轨迹约束Json({ msms: ['x'] }))
    const ctx = fakeResumeCtx('live')
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'skiff-weixin-live-1')
    expect(ref.resumed).toBe(true) // 历史延续语义（非新对话）
    expect(ref.sessionId).toBe('skiff-weixin-live-1')
    // 不经过 resume/create（二者在此场景必抛错——live 会话唯一可行路径 = get 复用）
    expect(ctx.calls).toEqual([])
    expect(trajectorySessionInfo(ref.sessionId)?.trajectoryDirName, 'live 复用也要登记轨迹').toBe(profile.dirName)
    unregisterTrajectorySession(ref.sessionId)
  })

  it('无固定 id（随机）→ 恒 create，resume 不参与', async () => {
    const profile = profileOf('resume-random', 轨迹约束Json({ msms: ['x'] }))
    const ctx = fakeResumeCtx('absent') // 无 resume 方法——随机路径根本不该调
    const ref = await createTrajectoryAgent(ctx as never, root, profile)
    expect(ref.resumed).toBe(false)
    expect(ref.sessionId.startsWith(`轨迹约束-${profile.code}-`)).toBe(true)
    unregisterTrajectorySession(ref.sessionId)
  })

  it('🔴 记录：live 复用路径的返回形状（dispose 不在外层，只在内层 handle）', async () => {
    // 契约记录，不是行为验收：`轨迹约束AgentRef = {handle, agent, sessionId, resumed}`，
    // 内层 handle 造的空操作 dispose **不外传** ⇒ 调用方要 dispose 必须走 `ref.handle.dispose`。
    const profile = profileOf('resume-dispose', 轨迹约束Json({ msms: ['x'] }))
    const ctx = fakeResumeCtx('live')
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'skiff-weixin-live-1')

    // 正控：确认走的是 live 复用路径
    expect(ref.resumed).toBe(true)
    expect(ctx.calls).toEqual([])
    // 事实一：外层返回**没有** dispose
    expect((ref as { dispose?: unknown }).dispose).toBeUndefined()
    // 事实二：内层 handle 带着它
    expect(typeof (ref.handle as { dispose?: unknown }).dispose).toBe('function')
    // 事实三：可被调用且不抛（空操作是安全的）
    await expect((ref.handle as { dispose: () => Promise<void> }).dispose()).resolves.toBeUndefined()
    // 事实四：调用它**不拆掉 live agent**
    expect(ref.agent).toBeTruthy()

    unregisterTrajectorySession(ref.sessionId)
  })

  it('resume 其他错误（非 not-found）→ 也降级 create + 打堆栈（用户拍板：不静默不唤醒）', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const profile = profileOf('resume-fallback', 轨迹约束Json({ msms: ['x'] }))
    const ctx = fakeResumeCtx('not-found')
    // 覆盖 resume 抛任意错误（如 DSH 内部 "Cannot read properties of undefined (reading 'ctx')"）→ 一律降级
    ;(ctx.agents as { resume: (o: { resumeSessionId: string }) => Promise<unknown> }).resume = async () => {
      throw new Error("Cannot read properties of undefined (reading 'ctx')")
    }
    const ref = await createTrajectoryAgent(ctx as never, root, profile, 'skiff-weixin-fixed-3')
    expect(ref.resumed).toBe(false)
    expect(ref.sessionId).toBe('skiff-weixin-fixed-3')
    // 堆栈已打印（诊断定位）
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('轨迹约束 resume 失败降级 create'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('轨迹约束 resume stack'))
    spy.mockRestore()
    unregisterTrajectorySession(ref.sessionId)
  })
})

// ── ⑥ 轨迹纪律子集（fail-open） ───────────────────────────────────────────────

describe('trajectory-session: trajectoryConstraintParticipates 轨迹纪律子集', () => {
  it('非 轨迹约束会话恒 true（fail-open：正常参与所有轨迹机制）', () => {
    expect(trajectoryConstraintParticipates(root, 'normal-session', 'keeper')).toBe(true)
    expect(trajectoryConstraintParticipates(root, 'cheap-worker-x', 'rebuild')).toBe(true)
    expect(trajectoryConstraintParticipates(root, undefined, 'session')).toBe(true)
  })

  it('登记了但轨迹没有 trajectory-constraint.json ⇒ 判"不是 轨迹约束" ⇒ 恒 true（不因缺登记而失去 keeper/rebuild）', () => {
    // ⛔ 旧用例是"轨迹约束会话未注册 → 保守旁路 false"。新模型里**没有**"轨迹约束 但没登记"这回事：
    //    身份判据是"绑定的轨迹有没有 trajectory-constraint.json"，查不到就是普通轨迹 ⇒ 放行（fail-open 是有意的）。
    make轨迹约束Session(root, 'sess-noreg', 'noreg', 轨迹约束Json({}))
    rmSync(join(root, 'AGENT_SESSIONS', '2026-10-19--noreg--traj', TRAJECTORY_CONSTRAINT_FILENAME)) // 删掉判据文件 = 当场退化为普通轨迹
    expect(trajectoryConstraintParticipates(root, 'sess-noreg', 'keeper')).toBe(true)
    expect(trajectoryConstraintParticipates(root, 'sess-noreg', 'rebuild')).toBe(true)
  })

  it('🔴 轨迹约束 缺省全 true（工作台就是它自己的身体 ⇒ 拿得到自己）', () => {
    make轨迹约束Session(root, 'sess-default', 'defaults', 轨迹约束Json({ msms: ['x'] }))
    expect(trajectoryConstraintParticipates(root, 'sess-default', 'keeper')).toBe(true)
    expect(trajectoryConstraintParticipates(root, 'sess-default', 'rebuild')).toBe(true)
    expect(trajectoryConstraintParticipates(root, 'sess-default', 'session')).toBe(true)
  })

  it('显式子集：逐项独立生效（关掉的不参与，开着的照常）', () => {
    make轨迹约束Session(root, 'sess-review', 'review', 轨迹约束Json({
      msms: ['y'],
      cognitiveTrajectory: { session: false, keeper: true, rebuild: false },
    }))
    expect(trajectoryConstraintParticipates(root, 'sess-review', 'keeper')).toBe(true)
    expect(trajectoryConstraintParticipates(root, 'sess-review', 'rebuild')).toBe(false)
    expect(trajectoryConstraintParticipates(root, 'sess-review', 'session')).toBe(false)
  })
})

// ── ⑦ 守门：MSM 门控 + 工具白名单 ────────────────────────────────────────────

describe('trajectory-session: trajectoryConstraintMsmGate msm 白名单门控', () => {
  const qaId = 'sess-msm-gate'

  beforeEach(() => {
    make轨迹约束Session(root, qaId, 'qa', 轨迹约束Json({ msms: ['cognitive-qa', 'meta-x'], tools: [] }))
  })

  it('非 轨迹约束会话恒放行（无 reject 无 whitelist）', () => {
    expect(trajectoryConstraintMsmGate(root, 'normal', 'exec', 'anything')).toEqual({})
    expect(trajectoryConstraintMsmGate(root, undefined, 'register', 'x')).toEqual({})
  })

  it('不是 轨迹约束的会话（未登记 / 登记到无 trajectory-constraint.json 的轨迹）⇒ 放行（fail-open，与纪律子集同一口径）', () => {
    // ⛔ 旧断言是 `reject` 含 'not allowed in this 轨迹约束 session'：那是靠 sessionId 前缀
    //    判身份留下的补丁（前缀命中却没登记 ⇒ 拒）。新判据下"没登记"就是"不是 轨迹约束"。
    expect(trajectoryConstraintMsmGate(root, '轨迹约束-ghost-1', 'exec', 'cognitive-qa')).toEqual({})
    bindPlainTrajectory('sess-plain-msm', 'plainmsm')
    expect(trajectoryConstraintMsmGate(root, 'sess-plain-msm', 'exec', 'cognitive-qa')).toEqual({})
  })

  it('exec：白名单内放行 / 白名单外拒绝（不列名单）', () => {
    expect(trajectoryConstraintMsmGate(root, qaId, 'exec', 'cognitive-qa')).toEqual({})
    const g = trajectoryConstraintMsmGate(root, qaId, 'exec', 'not-allowed')
    expect(g.reject).toBeDefined()
    expect(g.reject).toContain('MSM not allowed')
    expect(g.reject).not.toContain('not-allowed')
  })

  it('register/deregister：**声明了 msms 就拒**（原语义）', () => {
    // 🔴 2026-10-19 v1.75.0：文案从「…in 轨迹约束 sessions」改为英文
    // （原文是改名机把标识符改成中文后留下的中英混排，见 tests/identifier-ascii.test.ts）
    // 🔴 2026-11-19 v1.137.11：**判据从"文件存在"改成"显式声明了 msms"** ⇒ 文案随之改。
    expect(trajectoryConstraintMsmGate(root, qaId, 'register', 'x').reject).toContain('msms')
    expect(trajectoryConstraintMsmGate(root, qaId, 'deregister', 'x').reject).toContain('msms')
  })

  /**
   * 🔴🔴 **本组是 v1.137.11 的核心判据**（butler 报障逼出，2026-11-19）。
   *
   * 现场：一条轨迹的声明文件**只有 4 行**（只写 `resident.serves`），
   * 却拿不到 MSM 注册权 —— 因为旧实现把拒绝**挂在"文件存在"上**，而不是"声明了 msms"。
   * 而文档两处逐字承诺「不写 = 不收窄」，并推荐「只想声明常驻 ⇒ 只写 resident」。
   *
   * ⇒ 判据：**收窄必须发生在被声明的维度上**，⛔ 不能是"写了文件"的副作用。
   * ⚠️ 成对测：只测"缺省放行"无法排除"整个分支被删掉"（那样显式 `msms` 也会放行）。
   */
  describe('🔴 v1.137.11：register/deregister 按 msms 声明面判（⛔ 不按"文件存在"）', () => {
    it('缺省 msms（只写 resident）⇒ register **放行** —— 这是 butler 那条 4 行文件的形态', () => {
      // 真造一份"只写 resident"的声明（⛔ 不复用 轨迹约束Json({})，那连字段都不带）
      const dirName = make轨迹约束Session(root, 'sess-resident-only', 'resident-only', {
        resident: { serves: '只声明常驻' },
      })
      expect(dirName).toBeTruthy()
      expect(trajectoryConstraintMsmGate(root, 'sess-resident-only', 'register', 'vultr-tool')).toEqual({})
      expect(trajectoryConstraintMsmGate(root, 'sess-resident-only', 'deregister', 'gone-tool')).toEqual({})
    })

    it('缺省 msms 但写了 tools（另一维收窄）⇒ register **仍放行**（逐维成立，⛔ 不互相牵连）', () => {
      make轨迹约束Session(root, 'sess-tools-only', 'tools-only', 轨迹约束Json({ tools: ['read'] }))
      expect(trajectoryConstraintMsmGate(root, 'sess-tools-only', 'register', 'x')).toEqual({})
    })

    it('缺省 msms 但写了 writes ⇒ register **仍放行**（同上，第三维不该牵连第四维）', () => {
      make轨迹约束Session(root, 'sess-writes-only', 'writes-only', 轨迹约束Json({ writes: ['_tmp/'] }))
      expect(trajectoryConstraintMsmGate(root, 'sess-writes-only', 'register', 'x')).toEqual({})
    })

    it('显式 msms: [] ⇒ **拒**（显式表达"我不要任何 MSM" ⇒ 注册权随之关掉）', () => {
      make轨迹约束Session(root, 'sess-empty-msms', 'empty-msms', 轨迹约束Json({ msms: [] }))
      expect(trajectoryConstraintMsmGate(root, 'sess-empty-msms', 'register', 'x').reject).toBeDefined()
      expect(trajectoryConstraintMsmGate(root, 'sess-empty-msms', 'deregister', 'x').reject).toBeDefined()
    })

    it('非空 msms ⇒ **拒**（能力面已收窄，原语义保留）', () => {
      make轨迹约束Session(root, 'sess-some-msms', 'some-msms', 轨迹约束Json({ msms: ['a'] }))
      expect(trajectoryConstraintMsmGate(root, 'sess-some-msms', 'register', 'x').reject).toBeDefined()
    })

    it('拒绝文案必须指出**是哪一维**挡住的（⛔ 不说"not allowed in trajectory-constraint sessions"这种不指路的旧话）', () => {
      const msg = trajectoryConstraintMsmGate(root, qaId, 'register', 'x').reject ?? ''
      expect(msg).toContain('msms')
      expect(msg).not.toContain('trajectory-constraint sessions')
    })
  })

  it('list → 白名单过滤（来自 trajectory-constraint.json 的 msms）', () => {
    const g = trajectoryConstraintMsmGate(root, qaId, 'list')
    expect(g.reject).toBeUndefined()
    expect([...g.whitelist!].sort()).toEqual(['cognitive-qa', 'meta-x'])
  })

  it('check/guide/ccc-config 只读放行', () => {
    expect(trajectoryConstraintMsmGate(root, qaId, 'check')).toEqual({})
    expect(trajectoryConstraintMsmGate(root, qaId, 'guide')).toEqual({})
    expect(trajectoryConstraintMsmGate(root, qaId, 'ccc-config')).toEqual({})
  })
})

describe('trajectory-session: trajectoryConstraintToolWhitelist 工具面收窄', () => {
  it('轨迹约束：tools ∪ {msm}（msms 非空 ⇒ msm 工具自动可达，单入口纪律）', () => {
    make轨迹约束Session(root, 'sess-tools', 'tools', 轨迹约束Json({ tools: ['read', 'grep'], msms: ['x'] }))
    const w = trajectoryConstraintToolWhitelist(root, 'sess-tools')
    expect([...w!].sort()).toEqual(['grep', 'msm', 'read'])
  })

  it('msms 为空 ⇒ 不加 msm（并集不是覆盖：显式写的 tools 照旧生效）', () => {
    make轨迹约束Session(root, 'sess-nom', 'nom', 轨迹约束Json({ tools: ['read'] }))
    expect([...trajectoryConstraintToolWhitelist(root, 'sess-nom')!].sort()).toEqual(['read'])
  })

  it('非 轨迹约束 ⇒ null（调用方据此不收窄 schema）', () => {
    expect(trajectoryConstraintToolWhitelist(root, 'normal')).toBeNull()
    expect(trajectoryConstraintToolWhitelist(root, undefined)).toBeNull()
  })
})

describe('trajectory-session: 约束面派生纯函数（config 层）', () => {
  it('profileToolWhitelist / profileMsmWhitelist / constraintCognitiveTrajectory 对齐读盘结果', () => {
    const profile = profileOf('derived', 轨迹约束Json({
      tools: ['read'],
      msms: ['m1'],
      cognitiveTrajectory: { session: true, keeper: false, rebuild: true },
    }))
    expect([...profileToolWhitelist(profile)].sort()).toEqual(['msm', 'read'])
    expect([...profileMsmWhitelist(profile)]).toEqual(['m1'])
    expect(constraintCognitiveTrajectory(profile)).toEqual({ session: true, keeper: false, rebuild: true })
  })

  it('无约束面（null）⇒ 白名单 **null**（= 不收窄）/ MSM 空集 / 全 false', () => {
    // 🔴 D181：`profileToolWhitelist` 的返回类型改成 `Set<string> | null`，
    //    `null` 专门表示"不限制工具面"。这里钉的是"没有约束面 ⇒ 也不限制"。
    expect(profileToolWhitelist(null)).toBeNull()
    expect([...profileMsmWhitelist(null)]).toEqual([])
    expect(constraintCognitiveTrajectory(null)).toEqual({ session: false, keeper: false, rebuild: false })
  })

  it('🔴 D181：字段**缺省** ⇒ 白名单 null（不收窄）；**显式空数组** ⇒ 空集（全隐藏）', () => {
    // 同一个"空"，两种意思 —— 这是 owner 2026-10-20 那条令的机械判据。
    const unset = profileOf('unset', 轨迹约束Json({ model: 'p/m' }))
    expect(profileToolWhitelist(unset)).toBeNull()

    const explicitEmpty = profileOf('explicit-empty', 轨迹约束Json({ tools: [], msms: [] }))
    expect(profileToolWhitelist(explicitEmpty)).not.toBeNull()
    expect([...profileToolWhitelist(explicitEmpty)!]).toEqual([])

    // 只写 tools 不写 msms ⇒ 仍是"限制态"（给了 tools 就是明确的白名单），但 msm 通道不自动开
    const toolsOnly = profileOf('tools-only', 轨迹约束Json({ tools: ['read'] }))
    expect([...profileToolWhitelist(toolsOnly)!].sort()).toEqual(['read'])
  })

  it('resolveConstraintSystemPrompt：file 优先于 inline；缺失抛错（调用方降级）', () => {
    writeFileSync(join(root, 'p.md'), '文件版')
    const byFile = profileOf('prompt-file', { systemPromptFile: 'p.md', systemPrompt: '内嵌版' })
    const byInline = profileOf('prompt-inline', { systemPrompt: '内嵌版' })
    const missing = profileOf('prompt-missing', { systemPromptFile: 'nope.md' })
    expect(resolveConstraintSystemPrompt(root, byFile)).toBe('文件版')
    expect(constraintSystemPromptSource(byFile)).toBe('file')
    expect(resolveConstraintSystemPrompt(root, byInline)).toBe('内嵌版')
    expect(constraintSystemPromptSource(byInline)).toBe('inline')
    expect(constraintSystemPromptSource(null)).toBe('none')
    expect(resolveConstraintSystemPrompt(root, null)).toBe('')
    expect(() => resolveConstraintSystemPrompt(root, missing)).toThrow(/not found/)
  })

  it('resolveConstraintSystemPrompt：越界路径被拒绝（读盘层就丢掉该项，不是带着越界路径去读）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const escape = profileOf('prompt-escape', { systemPromptFile: '../../etc/passwd' })
    // 读盘层已把越界项丢掉 ⇒ 该约束面落到内嵌/空，而不是带着越界路径
    expect(escape.systemPromptFile).toBeUndefined()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('越界'))).toBe(true)
    expect(resolveConstraintSystemPrompt(root, escape)).toBe('')
    warn.mockRestore()
  })
})

// ── ⑧ askTrajectory（本轮判据 = assistant 计数增长） ────────────────────────────────

describe('trajectory-session: askTrajectory 会话核心', () => {
  /** fake ctx：on 立即触发 idle（waitIdle 同步 resolve） */
  function fakeCtx(agent: unknown): { on: () => () => void } {
    return {
      on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent, status: 'idle' })
        return () => {}
      },
    }
  }

  it('followup → idle → 答案 + sessionId（返回只有这两个字段）', async () => {
    const events: unknown[] = []
    const agent = { session: { id: 'sess-ask-1', events }, followup: () => {} }
    agent.followup = () => {
      events.push(
        { type: 'user/message', data: { content: [{ type: 'text', text: 'question' }] } },
        {
          type: 'assistant/message',
          data: {
            message: {
              content: [{ type: 'text', text: 'the answer' }],
              tool_calls: [{ name: 'container_fs', arguments: '{"action":"list"}' }],
            },
          },
        },
        { type: 'tool/result', data: { name: 'container_fs', content: [{ type: 'text', text: 'tool result' }] } },
      )
    }
    const result = await askTrajectory(fakeCtx(agent) as never, agent as never, 'question')
    expect(result.answer).toBe('the answer')
    expect(result.sessionId).toBe(agent.session.id)
    // ⛔ 旧用例断言 `result.cognitiveTrajectory`（本轮事件轨迹）：该字段已从返回类型移除
    //    （轨迹不再随返回值外泄 —— 要看本轮事件直接读会话）⇒ 改为钉返回形状本身。
    expect(Object.keys(result).sort()).toEqual(['answer', 'sessionId'])
  })

  it('本轮无 assistant 文本 → 空答案（不拿上一轮的旧文本充数）', async () => {
    const events: unknown[] = []
    const agent = { session: { id: 'sess-ask-2', events }, followup: () => {} }
    agent.followup = () => {
      events.push({ type: 'tool/result', data: { name: 'container_fs', content: [{ type: 'text', text: 'r' }] } })
    }
    const result = await askTrajectory(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('')
    expect(result.sessionId).toBe('sess-ask-2')
  })

  it('🔴 本轮没起来（idle 不来）→ 超时判失败 ⇒ 空答案，且**绝不复读上一轮**', async () => {
    // 旧复读缺陷：idle 一到就结算，而 followup 是异步投递 ⇒ 读到的是**上一轮**的答案。
    // 现在判据是 assistant 计数**增长**；超时路径同样走这个判据。
    const events: unknown[] = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '上一轮的答案' }] } } },
    ]
    const agent = { session: { id: 'sess-ask-3', events }, followup: () => {}, status: 'running' }
    const silentCtx = { on: () => () => {} } // 事件通道永不触发（宿主没发 idle）
    const result = await askTrajectory(silentCtx as never, agent as never, 'q', { timeoutMs: 20 })
    expect(result.answer).toBe('')
  })

  it('本轮产生了 assistant 消息 → 取的是本轮最后一条', async () => {
    const events: unknown[] = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧答案' }] } } },
    ]
    const agent = { session: { id: 'sess-ask-4', events }, followup: () => {} }
    agent.followup = () => {
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新答案' }] } } })
    }
    const result = await askTrajectory(fakeCtx(agent) as never, agent as never, 'q')
    expect(result.answer).toBe('新答案')
  })
})

/** AGENT_SESSIONS 下的活跃轨迹目录名（跳过 `_` 归档/日志区与 `.` 点目录） */
function activeTrajectoryDirs(): string[] {
  try {
    return readdirSync(join(root, 'AGENT_SESSIONS'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
