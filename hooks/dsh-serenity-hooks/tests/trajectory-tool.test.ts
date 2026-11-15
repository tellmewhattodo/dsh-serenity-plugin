/**
 * trajectory-tool.test.ts — `cognitive_trajectory` 工具的 **execute 分派面** 行为测试（⑤ 第 5 件）
 *
 * 🔴 为什么有这个文件（挑靶依据 = coverage 的**未覆盖行**；`fstat-no` 逐条命中）：
 *   本仓 coverage 实测 `src/tools/cognitive-trajectory.ts` **57.66%**，未覆盖的**函数**恰好是
 *   `agentScope` / `agentDshSession` / `currentBoundDirName` / `renderText`（＋ `output.render`）/
 *   `renderWakeEntry` / `advisoryHint` —— 它们**只经由本工具的 `execute` 进入**，
 *   而既有的 `trajectory-ops.test.ts`（测纯函数）与 `session-title.test.ts`（测重命名门面）
 *   **都不调用 `execute`** ⇒ 这六处是"**被提到、但从没被执行**"（§3-9 #5 的形态）。
 *
 * 测法（L3 工具面；**真实现 + 真夹具**，只在两处不可控面上打桩，理由逐条写在下）：
 *   · 真：`findSession` / `useSession` / `createSession` / `listSessions` / `showSession` /
 *     `addWake` ／ `appendBound`（绑定落 `.bindings.json`）／ 真 `轨迹约束`-free 的 fake ctx/exec
 *   · 桩 ① `../src/session-cleanup.js` 的 `hasSessionLogById`：**宿主会话日志面在测试里不可能是真的**
 *     （夹具的 dsh 会话 id 在宿主机上没有日志）⇒ 打成可控开关：默认 `true`（= 有日志 ⇒ 不剪枝），
 *     一条用例置 `false` 以覆盖**悬空绑定剪枝**分支。⚠️ 不桩它的话，`(c)` 分支会**恒剪掉刚写的绑定**
 *     ⇒ 断言会变成"测宿主机上有没有那个 session"，即**环境耦合的假绿**。
 *   · 桩 ② `setBindingStore(null)`：把绑定存储钉回 CCC 内 `.bindings.json`（既有先例
 *     `tests/trajectory-bound.test.ts` 同款）⇒ 全程密闭、不碰 `~/.dsh/storages/`。
 *
 * 覆盖面（按动作）：工具面/render ／ 根解析失败 ／ list ／ show ／ create（summary 必填·dry-run 豁免·
 *   issue 豁免·真建目录＋写 create 绑定）／ use（summary 必填·未找到·**happy 写 activate 绑定**·
 *   **G1 切换守卫（拒 / --force 放行 + action=switch）**·**重命名成功与不可用两态**·**advisory 陈旧分支**·
 *   **空壳目录的实际失败点（钉住 advisory ① 分支不可达）**·无 agent session）／ send-later（守卫·回执渲染·
 *   长消息截断）／ send-now（守卫）／ rebuild（两条守卫）／ cro-guide ／ 未知动作。
 *
 * ⚠️ 诚实边界（同 ⑤ 前几件）：**不写覆盖率百分比**（MSM 输出会被截断）；证据 = 这些函数只由本文件的断言触达。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

// 桩 ①（理由见文件头）：宿主会话日志面在测试里不可为真 ⇒ 打成可控开关
vi.mock('../src/trajectory/cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/trajectory/cleanup.js')>()
  return { ...actual, hasSessionLogById: vi.fn(() => true) }
})

import { createCognitiveTrajectoryTool } from '../src/tools/cognitive-trajectory.js'
import { hasSessionLogById } from '../src/trajectory/cleanup.js'
import { resetActiveSessionStore, COGNITIVE_TRAJECTORY_ACTIONS } from '../src/trajectory/core.js'
import { BIND_FILENAME } from '../src/trajectory/bound.js'
import { NO_CCC_FROM_AGENT_CWD } from '../src/kernel/ccc-roots.js'

const mockHasLog = vi.mocked(hasSessionLogById)

const A_DIR = '2026-09-25--S900--alpha'
const B_DIR = '2026-09-25--S901--beta'
const A_BODY = '# SESSION: alpha\n- ID: S900\n'

let ccc: string

/** 工具对象在测试里是 defineTool 的透传形态 */
const tool = createCognitiveTrajectoryTool({ get: () => undefined } as never) as unknown as {
  name: string
  description: string
  parameters: Record<string, { type?: string; enum?: string[]; required?: boolean }>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (a: unknown, e: unknown) => Promise<unknown>
}

/** 建一条轨迹目录（dirName 形如 `2026-09-25--S900--alpha`）；`withMd=false` ⇒ 空壳 */
function writeSession(dirName: string, body = A_BODY, withMd = true): string {
  const dir = join(ccc, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  const md = join(dir, 'SESSION.md')
  if (withMd) writeFileSync(md, body)
  return md
}

/** dsh 会话替身：`append` 存在是 `agentDshSession` 的判据；`header` 供绑定定位 */
function fakeExec(opts: { id?: string; append?: boolean; cwd?: string } = {}): never {
  const session: Record<string, unknown> = { header: { id: opts.id ?? 'dsh-1', cwd: opts.cwd ?? ccc } }
  if (opts.append !== false) session.append = () => {}
  return { agent: { session } } as never
}

/** fake ctx：`sessionTitle` 服务可给可不给（覆盖重命名门面的成功/降级两态） */
function fakeCtx(opts: { titles?: { rename: (s: unknown, t: string) => unknown } } = {}): never {
  return { get: (n: string) => (n === 'sessionTitle' ? opts.titles : undefined) } as never
}

function run(args: unknown, exec = fakeExec()): Promise<unknown> {
  return tool.execute(args, exec)
}

/** 用指定 ctx 重新构造工具（仅「重命名两态」组用） */
function toolWith(ctx: unknown) {
  return createCognitiveTrajectoryTool(ctx as never) as unknown as typeof tool
}

/**
 * 🔵 **2026-11-15 移除**：本文件原有一组 `continue-all-interrupted` 夹具
 * （`LIVE_ID` ＋ `writeInterruptedSessionLog`），随该动作一并删除 —— 动作已从
 * `COGNITIVE_TRAJECTORY_ACTIONS` 移除，工具面不再有续跑入口。
 * 中断扫描与续跑的**逻辑**仍由 `src/trajectory/interrupted.ts` 提供并被 scheduler 调用，
 * 其夹具与用例在 `tests/trajectory/interrupted.test.ts` 里（真 zstd 多帧，与真机同形）。
 */

/**
 * 🔴 手册**可被发现性**的机械钉（owner 2026-10-20：「这是认知轨迹感知理解这些边界的重要手册」）。
 *
 * ## 为什么这条必须存在（它抓的是"内容对但没人找得到"这一类）
 *
 * 手册正文本身早就写好了，但它住在 `container_admin config docs` 的第二章里。
 * 而**该读它的人 —— 想给自己写章程／声明常驻的轨迹 —— 用的是 `cognitive_trajectory`**。
 * ⇒ 那条路此前**没有任何指针**，于是"手册存在"与"手册可用"是两回事，且**零机械信号**。
 *
 * ## 判据的两半（缺一不可）
 * ① 正向：本工具的 description 必须**逐字**给出可达路径 `config docs trajectory-self`
 * ② 反向：这条指针**不能**指向一个不存在的章（钉章 id，防止改章时指针悄悄悬空）
 */
describe('cognitive_trajectory: 自我描述手册的可发现性（指针钉）', () => {
  const desc = (tool as unknown as { description?: string }).description ?? ''

  it('① 工具说明里必须给出自述手册的可达路径（否则该读它的人找不到）', () => {
    // 🔴 必须钉**词边界**，不能只 toContain：子串匹配对"改名成 trajectory-selffff"是瞎的
    //    （2026-10-20 变异检验实测：只写 toContain 时，把章名改成 trajectory-selffff 测试仍绿）
    expect(desc).toMatch(/config docs trajectory-self(?![\w-])/)
    // 三种自设都要点名 —— 只写"看手册"而不说手册管什么，等于没指
    expect(desc).toContain('PROMPT.md')
    expect(desc).toContain('resident')
  })

  it('🔴 ② 反向钉：说明里承诺的章必须真的在目录里注册（章改名 ⇒ 指针不许悬空）', async () => {
    // 用 container_admin 的公开面（一次 docs 目录调用）取回真实章表 —— 不碰模块私有表
    const { createContainerAdminTool } = await import('../src/tools/container-admin.js')
    const t = createContainerAdminTool({ get: () => undefined } as never) as unknown as {
      execute: (a: unknown, e: unknown) => Promise<{ chapters?: string[] }>
    }
    const res = await t.execute({ domain: 'config', action: 'docs' }, { agent: { session: { header: { cwd: ccc } } } })
    const ids = res.chapters ?? []
    // ① 指针里承诺的那一章必须存在 —— 否则说明在撒谎
    expect(ids).toContain('trajectory-self')
    // ② 两章互指：限制面章同样可达（拆章不是把旧章删掉）
    expect(ids).toContain('trajectory-constraint')
    // 🔵 正控：不是"目录为空"导致的假通过
    expect(ids.length).toBeGreaterThan(1)
  })
})

/**
 * 读绑定（D172：归属住在**轨迹目录**的 `current.dsh_session_bind`，不再是旁路表）。
 *
 * 返回形状保持旧用例的读法（`{version, sessions: {sessionId: record}}`），便于判据几乎不动 ——
 * **但来源换成了"扫所有轨迹目录"**，即"归属是算出来的，不是记下来的"。
 */
/**
 * D172：判断"有没有绑定"不再看旁路表，而是**扫轨迹目录**。
 * 空 ⇒ 一条归属都没有；非空 ⇒ 有会话被绑在某条轨迹上。
 */
function hasAnyBindingFile(): boolean {
  return Object.keys(bindings().sessions).length > 0
}

function bindings(): { version: number; sessions: Record<string, { dirName: string; action: string; note?: string }> } {
  const sessions: Record<string, { dirName: string; action: string; note?: string }> = {}
  const root = join(ccc, 'AGENT_SESSIONS')
  let names: string[] = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return { version: 1, sessions }
  }
  for (const dirName of names) {
    const p = join(root, dirName, BIND_FILENAME)
    if (!existsSync(p)) continue
    try {
      const d = JSON.parse(readFileSync(p, 'utf-8')) as { sessionId?: string; action?: string; note?: string }
      if (typeof d.sessionId === 'string' && d.sessionId !== '') {
        sessions[d.sessionId] = { dirName, action: d.action ?? 'activate', ...(d.note ? { note: d.note } : {}) }
      }
    } catch {
      /* 坏文件跳过 */
    }
  }
  return { version: 1, sessions }
}

function wakeRegistry(): { entries?: Array<{ id: string; target: string; state: string }> } {
  return JSON.parse(readFileSync(join(ccc, 'AGENT_SESSIONS', 'wake-registry.json'), 'utf-8'))
}

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'traj-tool-'))
  writeFileSync(join(ccc, '.serenity'), 'trajtest\n')
  mkdirSync(join(ccc, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore()
  mockHasLog.mockReturnValue(true)
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
  resetActiveSessionStore()
})

describe('cognitive_trajectory：工具面', () => {
  it('工具名 = cognitive_trajectory；action 必填且枚举 = COGNITIVE_TRAJECTORY_ACTIONS（11 个，含 archive/uid/resident）', () => {
    expect(tool.name).toBe('cognitive_trajectory')
    expect(tool.parameters.action?.required).toBe(true)
    expect(tool.parameters.action?.enum).toEqual([...COGNITIVE_TRAJECTORY_ACTIONS])
    // 🔴 2026-10-18：8 → 9（`archive`）→ **10**（`uid`：唯一标识符，独立于编码与命名）
    // 🔴 2026-10-20（D173 兑现）：10 → **11**（`resident`：常驻名单的只读发现动作）。
    //    ⚠️ 它补的正是 v1.77.1 手册**曾承诺却不存在**的那个动作（D179(a)，S196 踩到）
    //    ⇒ 这个计数不只是加一，它是一条"说明面终于与实现对齐"的证据。
    // 🔴 2026-10-22：11 → 12（`interrupted`）；同日 → 13（`continue-all-interrupted`）。
    // 🔴🔴 **2026-11-15（owner 令）：13 → 11** —— `interrupted` 与 `continue-all-interrupted`
    //    **两个动作整体移除**。理由见 `core.ts` 的 `CognitiveTrajectoryAction` 注释：
    //    ACC 的自动兜底（scheduler 60s tick）已足够可靠，工具上再挂一份能起 agent 的入口
    //    = 第二真相源，且它把一件已自动化的事重新变成人的义务。
    //    ⚠️ **能力没删**（scheduler 仍在用 `scanInterruptedSessions`/`createResumeOne`），只删入口。
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toHaveLength(11)
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toContain('archive')
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toContain('uid')
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toContain('resident')
    // 🔴 **反向钉**（2026-11-15）：这两个动作**已移除**，将来谁把它们加回来必须变红。
    //    同族纪律 #43：退役要留「旧形态不再出现」的钉，否则下一个我会"顺手"加回去而无人报警。
    expect(COGNITIVE_TRAJECTORY_ACTIONS).not.toContain('interrupted')
    expect(COGNITIVE_TRAJECTORY_ACTIONS).not.toContain('continue-all-interrupted')
    for (const k of ['name', 'uid', 'summary', 'target', 'at', 'message', 'note', 'force', 'dryRun']) {
      expect(tool.parameters[k], `缺参数 ${k}`).toBeDefined()
    }
  })

  it('render：字符串原样；非字符串 ⇒ JSON 缩进（覆盖 renderText）', () => {
    expect(tool.output.render({}, 'text')).toEqual([{ type: 'text', text: 'text' }])
    expect(tool.output.render({}, { ok: true })).toEqual([{ type: 'text', text: '{\n  "ok": true\n}' }])
  })

  it('cwd 不在任何 CCC 内 ⇒ 抛 NO_CCC_FROM_AGENT_CWD（不误报"session not found"）', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'traj-bare-'))
    try {
      await expect(run({ action: 'list' }, fakeExec({ cwd: bare }))).rejects.toThrow(NO_CCC_FROM_AGENT_CWD)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('cognitive_trajectory：list / show', () => {
  it('list = 清单 + 全库统计（summary 已并入 list）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'list' })) as string
    expect(out).toContain(A_DIR)
    expect(out).toContain('AGENT_SESSIONS Summary')
    // 🔴 2026-10-18：计数字样改为「Active (not archived)」（四项生命周期计数已删）
    expect(out).toContain('Active (not archived): 1')
  })

  it('空库：list 报无会话且统计为空库文案（不抛）', async () => {
    const out = (await run({ action: 'list' })) as string
    expect(out).toContain('(no sessions in AGENT_SESSIONS/)')
    expect(out).toContain('AGENT_SESSIONS/ is empty.')
  })

  it('show 缺 name ⇒ 抛；有 name ⇒ 回 SESSION.md 正文', async () => {
    writeSession(A_DIR)
    await expect(run({ action: 'show' })).rejects.toThrow('show requires name')
    expect((await run({ action: 'show', name: 'S900' })) as string).toContain('# SESSION: alpha')
  })
})

describe('cognitive_trajectory：create', () => {
  it('非 dry-run 且非 issue：缺 summary ⇒ 抛（且不建目录）', async () => {
    await expect(run({ action: 'create', desc: 'x' })).rejects.toThrow('create requires --summary')
    expect(readdirSync(join(ccc, 'AGENT_SESSIONS'))).toHaveLength(0)
  })

  it('dry-run 豁免 summary（未真实创建 ⇒ 不写绑定）', async () => {
    const out = (await run({ action: 'create', desc: 'preview', dryRun: true })) as string
    expect(out.length).toBeGreaterThan(0)
    expect(hasAnyBindingFile()).toBe(false)
  })

  it('issue 会话豁免 summary（编号固定派生、无概括语义）', async () => {
    await run({ action: 'create', issue: 'apaas-1' })
    // 真建了目录 + 写了绑定。🆕 2026-10-16（owner 令）：**无绑定 ⇒ 自动激活**（故 action=activate，不再是 create）
    expect(hasAnyBindingFile()).toBe(true)
    expect(bindings().sessions['dsh-1']?.action).toBe('activate')
    expect(bindings().sessions['dsh-1']?.note).toContain('auto-activated on create (no prior binding)')
  })

  it('desc + summary ⇒ 真建目录，目录名含日期与 desc 片段', async () => {
    await run({ action: 'create', desc: 'hello world', summary: '概' })
    const dirs = readdirSync(join(ccc, 'AGENT_SESSIONS'))
    expect(dirs.some((d) => d.includes('hello'))).toBe(true)
  })

  // ── 🆕 2026-10-16（owner 令）：create 的分支语义由「有无绑定」决定 ──
  // 两条路径**互为对照**：同样的 create，只因"当前有没有绑定"而行为不同。
  it('🆕 路径①：**无绑定** ⇒ 直接激活（写 activate 绑定 + 正文告知已自动激活）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'create', desc: 'fresh', summary: '概' })) as string
    expect(out).toContain('已自动激活')
    expect(out).toContain('此前**无绑定**')
    const rec = bindings().sessions['dsh-1']
    expect(rec?.action).toBe('activate')
    expect(rec?.note).toContain('auto-activated on create (no prior binding)')
    // 绑定指向**新**轨迹（不是 A_DIR）
    expect(rec?.dirName).toContain('fresh')
  })

  it('🆕 路径②：**已有绑定** ⇒ 只建不夺（绑定仍指原轨迹）+ 提示用 send-now 激活', async () => {
    writeSession(A_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' }) // 先建立绑定
    const before = bindings().sessions['dsh-1']?.dirName
    expect(before).toBe(A_DIR)

    const out = (await run({ action: 'create', desc: 'later-work', summary: '概' })) as string
    expect(out).toContain('未')
    expect(out).toContain('send-now')
    expect(out).toContain(before as string) // 正文点名当前绑定是谁
    // 🔴 核心断言：**绑定没被夺走**（这正是 U6 要保的行为，不能被本次改动破坏）
    expect(bindings().sessions['dsh-1']?.dirName).toBe(A_DIR)
  })
})

describe('cognitive_trajectory：use —— 守卫与绑定（agentScope / agentDshSession / currentBoundDirName）', () => {
  it('缺 summary ⇒ 抛（不动绑定）', async () => {
    writeSession(A_DIR)
    await expect(run({ action: 'use', name: 'S900' })).rejects.toThrow('use requires --summary')
  })

  it('目标不存在 ⇒ 抛（文案指向 list）', async () => {
    await expect(run({ action: 'use', name: 'S999', summary: '概' })).rejects.toThrow('Session not found: "S999"')
  })

  it('happy：激活 + 写 activate 绑定（dirName/mdPath/sessionId）+ 回 dir/mdPath/context', async () => {
    const md = writeSession(A_DIR)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
    expect(out.dir).toBe(A_DIR)
    expect(out.mdPath).toBe(md)
    expect(out.context).toContain('SESSION.md path:')
    const rec = bindings().sessions['dsh-1']
    expect(rec?.dirName).toBe(A_DIR)
    expect(rec?.action).toBe('activate')
  })

  it('🔴 G1 切换守卫（D172）：已承载 A ⇒ 用 B 被拒（**一个会话终身一条轨迹**）', async () => {
    writeSession(A_DIR)
    writeSession(B_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    await expect(run({ action: 'use', name: 'S901', summary: '概' })).rejects.toThrow(/不能改宗到/)
    // 被拒后归属不变（仍是 A）
    expect(bindings().sessions['dsh-1']?.dirName).toBe(A_DIR)
  })

  it('🔴 D172：`--force` **已退役** —— 显式传它也照样被拒（不是"换了个后门"）', async () => {
    writeSession(A_DIR)
    writeSession(B_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    // 旧实现在这里真的会切过去；现在必须拒绝，且**文案要说明为何退役**（静默忽略更坏）
    await expect(run({ action: 'use', name: 'S901', summary: '概', force: true })).rejects.toThrow(/--force 已退役/)
    // 归属仍是 A，B 一个字节都没被写
    expect(bindings().sessions['dsh-1']?.dirName).toBe(A_DIR)
    expect(bindings().sessions['dsh-1']?.dirName).not.toBe(B_DIR)
  })

  it('重复 use 同一条（非切换）仍记 activate（守卫只挡"换目标"）', async () => {
    writeSession(A_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    await run({ action: 'use', name: 'S900', summary: '概' })
    expect(bindings().sessions['dsh-1']?.action).toBe('activate')
  })

  /**
   * 🔴 **D191（owner 裁决「use 只要被调用了，可以无条件覆盖绑定到当前会话」）**。
   *
   * ## 这条判据为什么必须存在（它抓的是一个**真实使用者付过代价**的缺陷）
   *
   * 上一版实现**收窄**了那条裁决：传 `alive` 探针 ⇒ "活着的旧载体"仍然拒绝。
   * 现场后果（一条 skiff 轨迹实测）：`send-now` 给一条轨迹自动建了载体（它必须写绑定，
   * 否则唤醒路径找不到载体），随后**人**那条会话 `use` 时被这个机器建来的活载体挡住
   * ⇒ 表现为"绑定反复被顶掉 / use 一直 not-written"，只能干等它退场。
   *
   * ⚠️ **本夹具的判活探针恒为真**（`hasSessionLogById` 在文件头被桩成 `() => true`），
   * 所以这条用例**天然带判别力**：旧实现（alive 探针）在这里必然 `not-written`。
   */
  it('🔴 活载体占着槽位 ⇒ use 照样写成，并把被顶掉的 id 带进回执（覆盖可以，静默覆盖不行）', async () => {
    writeSession(A_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    expect(bindings().sessions['dsh-1']?.dirName).toBe(A_DIR)
    const out = (await run(
      { action: 'use', name: 'S900', summary: '概' },
      fakeExec({ id: 'dsh-2' }),
    )) as Record<string, string>
    expect(out.binding).toBe('written')
    // 顶掉了谁必须能被读出来（D186 同族：可以覆盖，但不许静默覆盖）
    expect(out.bindingReplaced).toBe('dsh-1')
    // 单槽位：旧载体不再承载，新载体是唯一那条
    expect(bindings().sessions['dsh-2']?.dirName).toBe(A_DIR)
    expect(bindings().sessions['dsh-1']).toBeUndefined()
  })

  it('同一会话重复 use ⇒ 没有 bindingReplaced（重入不是换代）', async () => {
    writeSession(A_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
    expect(out.binding).toBe('written')
    expect(out.bindingReplaced).toBeUndefined()
  })

  /**
   * 🔴 **D190：回执必须指名"是哪一半失败"**（2026-10-20，一条 skiff 轨迹实测逼出）。
   *
   * 旧文案把**两条完全不同的失败路径**都说成"取不到可用的 header"：header 守卫
   * （`SESSION_HEADER_UNRESOLVED`）与 `claimBinding` 拒绝（`SESSION_TAKEN` /
   * `TRAJECTORY_OCCUPIED` / `WRITE_FAILED`）。实测者照着文案去找 header，
   * 真因是槽位被占 ⇒ **错误文案会把人指向错误的方向**（比不出声更坏）。
   */
  it('🔴 绑定写失败 ⇒ 回执带 bindingCode，且不许再套 header 文案（真故障形态：目录只读）', async () => {
    const dir = join(ccc, 'AGENT_SESSIONS', A_DIR)
    writeSession(A_DIR)
    chmodSync(dir, 0o555) // 原子写建不出 .tmp ⇒ WRITE_FAILED（真故障形态，不是桩）
    try {
      const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
      expect(out.binding).toBe('not-written')
      expect(out.bindingCode).toBe('WRITE_FAILED')
      expect(out.bindingHint).toContain('WRITE_FAILED')
      // 🔴 反向钉：旧文案必须消失 —— 它把"写盘失败"也说成 header 缺失
      expect(out.bindingHint).not.toContain('取不到可用的 header')
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('agent 无 session ⇒ 仍激活成功，但不写绑定（不抛）', async () => {
    writeSession(A_DIR)
    // ⚠️ `cwd` 必须在场：缺它 ⇒ `agentCwdFor` 回落 `process.cwd()` ⇒ 会解析到**跑测试的那个真 CCC 根**
    //   （本轮实测踩到：报 "Session not found: S900"，因为它在真 AGENT_SESSIONS 里找夹具会话）
    const exec = { agent: { session: { header: { id: 'x', cwd: ccc } } } } // 无 append ⇒ agentDshSession → null
    const out = (await run({ action: 'use', name: 'S900', summary: '概' }, exec as never)) as Record<string, string>
    expect(out.dir).toBe(A_DIR)
    expect(hasAnyBindingFile()).toBe(false)
  })

  it('🔴 D172：**不再有 prunedBindings**（悬空清理整条退役）—— 过期绑定自动失效', async () => {
    writeSession(A_DIR)
    // 宿主侧根本没有该会话日志（旧形态会把这类记录"剪掉"）
    mockHasLog.mockReturnValue(false)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    // ① 结果里不再有这个字段（机制已不存在，不是"这次没触发"）
    expect(out.prunedBindings).toBeUndefined()
    // ② 而绑定本身照常写成 —— 因为"会话在不在"由 `isBindUsable` 探针判，不由清理动作判
    expect(hasAnyBindingFile()).toBe(true)
  })

  it('宿主机读不到会话日志根（hasSessionLogById=true）⇒ 不剪枝（fail-closed 保留）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(out.prunedBindings).toBeUndefined()
  })
})

describe('cognitive_trajectory：use —— 重命名门面（两态）', () => {
  it('有 sessionTitle 服务 ⇒ rename 收到命名标题（S###-日期-概括）', async () => {
    writeSession(A_DIR)
    const rename = vi.fn()
    const t = toolWith(fakeCtx({ titles: { rename } }))
    await t.execute({ action: 'use', name: 'S900', summary: '概' }, fakeExec())
    expect(rename).toHaveBeenCalledTimes(1)
    const title = rename.mock.calls[0]?.[1] as string
    expect(title).toContain('S900')
    expect(title).toContain('概')
    expect(title.startsWith('S900-')).toBe(true)
  })

  it('无 sessionTitle 服务 ⇒ 不抛（主流程完成），仅告警', async () => {
    writeSession(A_DIR)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
    expect(out.dir).toBe(A_DIR)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('重命名未执行'))).toBe(true)
    warn.mockRestore()
  })
})

describe('cognitive_trajectory：use —— advisoryHint（只提示不阻断）', () => {
  it('🔴 SESSION.md 陈旧（>7 天）⇒ **不再有 advisory**（年龄已不是判据）', async () => {
    // owner 2026-10-18：轨迹永存 ⇒ 「旧轨迹该退休了」这个前提消失。
    // 旧实现在这里会返回 `… 已 N 天未更新 …` 的告警；现在必须**完全静默**。
    // ⚠️ 这是**删除的钉子**：老化告警若回来，这条用例立刻红。
    const md = writeSession(A_DIR)
    const old = new Date(Date.now() - 8 * 86_400_000)
    utimesSync(md, old, old)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(out.advisory, '年龄不再是判据 ⇒ 不得给任何老化提示').toBeUndefined()
    // 正控：确实**激活成功**了（否则"无 advisory"可能只是因为它根本没跑到）
    expect(out.dir, '激活必须真的成功，才能证明"静默"是判据生效而非路径没走到').toBe(A_DIR)
  })

  it('SESSION.md 新鲜 ⇒ 无 advisory 键（通过就静默）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(out.advisory).toBeUndefined()
  })

  it('🔴 空壳目录（无 SESSION.md）⇒ 失败发生在 useSession，**不是** advisory —— 钉住 advisory 空壳分支不可达', async () => {
    // 判据：`advisoryHint` 只有本工具一个调用点，且它排在 `useSession` **之后**；
    // 而 `useSession` 对同一 mdPath 已经做过 existsSync 校验（同 root、同 key ⇒ 同一个 entry）
    // ⇒ 走到 advisoryHint 时文件**必然存在** ⇒ 空壳分支除"竞态"外不可达。
    writeSession(A_DIR, A_BODY, false)
    const err = await run({ action: 'use', name: 'S900', summary: '概' }).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain('has no SESSION.md')
    expect(String((err as Error).message)).not.toContain('空壳')
  })
})

describe('cognitive_trajectory：send-later（renderWakeEntry）', () => {
  const at = (): string => new Date(Date.now() + 3_600_000).toISOString()

  it('缺 target/at/message 任一 ⇒ 抛（三个都点名）', async () => {
    await expect(run({ action: 'send-later', at: at(), message: 'm' })).rejects.toThrow(/requires target/)
    await expect(run({ action: 'send-later', target: 'S900', message: 'm' })).rejects.toThrow(/requires target/)
    await expect(run({ action: 'send-later', target: 'S900', at: at() })).rejects.toThrow(/requires target/)
  })

  it('happy：落注册表 + 回执含 id/state/at/target/by + 补跑窗与不可回收声明', async () => {
    const out = (await run({ action: 'send-later', target: 'S900', at: at(), message: 'ping' })) as {
      ok: boolean
      output: string
    }
    expect(out.ok).toBe(true)
    expect(out.output).toContain('✓ 已登记唤醒')
    expect(out.output).toContain('[pending]')
    expect(out.output).toContain('target=S900')
    expect(out.output).toContain('补跑窗口 2h')
    expect(out.output).toContain('不可回收')
    const reg = wakeRegistry()
    expect(reg.entries?.[0]?.target).toBe('S900')
    expect(reg.entries?.[0]?.id.startsWith('w-')).toBe(true)
  })

  it('长消息（>120 字）在回执里截断到 120 + 省略号；短消息原样', async () => {
    const long = 'x'.repeat(200)
    const out = (await run({ action: 'send-later', target: 'S900', at: at(), message: long })) as { output: string }
    expect(out.output).toContain(`${'x'.repeat(120)}…`)
    expect(out.output).not.toContain('x'.repeat(121))
    const out2 = (await run({ action: 'send-later', target: 'S901', at: at(), message: 'short' })) as { output: string }
    expect(out2.output).toContain('message: short')
  })
})

describe('cognitive_trajectory：其余动作的守卫与纯读面', () => {
  it('send-now 缺 target / message ⇒ 抛（与 send-later 同款文案风格）', async () => {
    await expect(run({ action: 'send-now', message: 'm' })).rejects.toThrow('send-now requires target')
    await expect(run({ action: 'send-now', target: 'S900' })).rejects.toThrow('send-now requires target')
  })

  it('rebuild 缺 summary ⇒ 先抛（不进入 queueRebuild）', async () => {
    await expect(run({ action: 'rebuild' }, fakeExec({ id: 'sess' }))).rejects.toThrow('rebuild requires --summary')
  })

  it('rebuild 有 summary 但拿不到 dsh 会话 id ⇒ 抛（第二道守卫）', async () => {
    const noId = { agent: { session: { header: { cwd: ccc }, append: () => {} } } }
    await expect(run({ action: 'rebuild', summary: '概' }, noId as never)).rejects.toThrow(
      'Unable to determine the current dsh session id',
    )
  })

  it('cro-guide ⇒ 纯读返回 CRO 指南正文（不抛、不写盘）', async () => {
    const out = (await run({ action: 'cro-guide' })) as string
    expect(out).toContain('CRO')
    expect(typeof out).toBe('string')
    expect(hasAnyBindingFile()).toBe(false)
  })

  it('未知动作 ⇒ 抛 Unknown action（响亮而非静默）', async () => {
    await expect(run({ action: 'nope' })).rejects.toThrow('Unknown action: nope')
  })
})

/**
 * 🔴 2026-10-18 新增：`archive` —— 轨迹没有生命周期后，它是**唯一**的"状态变化"。
 *
 * 这组用例是本次改动的**核心判据**，四条各自对应一条会真出事的失效形态：
 *  ① 归档后**仍出现在 list 里** ⇒ "归档"名不副实（`readAllSessions` 漏了 `_` 跳过）
 *  ② 归档**覆盖了**同名既有轨迹 ⇒ 不可逆的丢失（唯一副本被毁）
 *  ③ 归档**改动了内容** ⇒ 它不是"换位置"，而是"改写历史"
 *  ④ 归档后 `use` 仍能激活它 ⇒ 归档区没有真正退出域
 */
describe('cognitive_trajectory：archive（🔴 唯一的"状态变化"，单向）', () => {
  it('归档成功 ⇒ 目录移入 _archived/，且 list 里**不再出现**（判据①）', async () => {
    writeSession(A_DIR)
    const listBefore = (await run({ action: 'list' })) as string
    expect(listBefore, '正控：归档前必须在清单里').toContain(A_DIR)

    const out = (await run({ action: 'archive', name: 'S900' })) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.dirName).toBe(A_DIR)

    // 物理位置：旧路径没了、新路径在
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), '原位置必须已不存在').toBe(false)
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR)), '必须落在 _archived/').toBe(true)

    // 🔴 判据①：list 里不得再出现
    const listAfter = (await run({ action: 'list' })) as string
    expect(listAfter, '归档后不得再出现在活跃清单里').not.toContain(A_DIR)
    // 空仓走 summarize 的专属文案（不是计数行）—— 这本身就是"活跃数为 0"的证据
    expect(listAfter).toContain('AGENT_SESSIONS/ is empty.')
    expect(listAfter, '归档件不得被计入活跃').not.toContain('Active (not archived): 1')
  })

  it('归档**不得覆盖**同名既有轨迹（判据②：不可逆丢失的护栏）', async () => {
    writeSession(A_DIR)
    await run({ action: 'archive', name: 'S900' })

    // 再建一个同名的新轨迹，并塞不同内容 —— 然后试图再归档
    writeSession(A_DIR, '# SESSION: alpha（新的一条，内容不同）\n')
    await expect(run({ action: 'archive', name: 'S900' })).rejects.toThrow('already exists in _archived/')

    // 🔴 负控：**先归档的那一份必须原封不动**（没被新内容覆盖，也没被删）
    const kept = readFileSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR, 'SESSION.md'), 'utf-8')
    expect(kept, '既有归档件的内容必须还是最早那一份').toBe(A_BODY)
    // 并确认新那条仍在活跃区（报错不应产生任何副作用）
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), '归档失败 ⇒ 活跃区那条必须原地不动').toBe(true)
  })

  it('归档只换位置，**内容逐字节不变**（判据③：它不是改写历史）', async () => {
    const md = writeSession(A_DIR)
    const before = readFileSync(md, 'utf-8')
    await run({ action: 'archive', name: 'S900' })
    const after = readFileSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR, 'SESSION.md'), 'utf-8')
    expect(after, 'SESSION.md 必须逐字节一致').toBe(before)
  })

  it('归档后 `use` 不再找得到它（判据④：归档区已退出域）', async () => {
    writeSession(A_DIR)
    await run({ action: 'archive', name: 'S900' })
    await expect(run({ action: 'use', name: 'S900', summary: '概' })).rejects.toThrow('Session not found')
  })

  it('dryRun ⇒ 只报路径不落盘（真故障形态：误用预览时把轨迹挪走了）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'archive', name: 'S900', dryRun: true })) as Record<string, unknown>
    expect(String(out.message)).toContain('[dry-run]')
    // 🔴 原地必须还在、归档区必须还不存在 —— 预览零副作用
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), 'dryRun 不得移动任何东西').toBe(true)
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR)), 'dryRun 不得创建归档件').toBe(false)
  })

  it('目标不存在 ⇒ 抛（响亮失败，不静默成功）', async () => {
    await expect(run({ action: 'archive', name: 'S999' })).rejects.toThrow('Trajectory not found')
  })

  it('缺 name ⇒ 抛参数错', async () => {
    await expect(run({ action: 'archive' })).rejects.toThrow('archive requires name')
  })

  it('🔴 `_archived` 本身不是轨迹：它不出现在 list，也不能被归档', async () => {
    writeSession(A_DIR)
    await run({ action: 'archive', name: 'S900' })
    const list = (await run({ action: 'list' })) as string
    // 归档区目录名不得被当成一条轨迹列出来（`_` 前缀跳过的正控）
    expect(list, '`_archived` 不得出现在清单里').not.toContain('_archived')
    // 它的子项也不该被列
    expect(list).not.toContain(A_DIR)
  })
})

/**
 * 🔴 2026-10-18 新增：`uid` —— 认知轨迹的**唯一标识符**。
 *
 * owner 原话：*"命名很可能由于变化而变化，所以我们需要让认知轨迹支持一种用于交流的唯一标识符，
 * 它不同于编码和命名，而是单独设定的（也可以不设定，不设定就还是用编码），
 * 所有可以用编码操作的能力，都同样支持唯一标识符，唯一标识符用文件形式声明在认知轨迹目录中"*。
 *
 * 核心判据 = **"所有能用编码操作的，都能用 UID 操作"**（本组第 2 条就是它的机械形式）。
 */
describe('cognitive_trajectory：uid（🔴 2026-10-19 起写入退役、读取保留）', () => {
  const B_BODY = '# SESSION: beta\n- ID: S901\n'

  it('未设定 ⇒ 读回 null（不是错误）；并回执说明写入已退役', async () => {
    writeSession(A_DIR)
    const before = (await run({ action: 'uid', name: 'S900' })) as Record<string, unknown>
    expect(before.uid).toBeNull()
    expect(before.retired).toBe(true)
    expect(String(before.note)).toContain('create --id')
  })

  it('🔴 任何写入尝试都被拒，且给出可行动指引（指向 create --id）', async () => {
    writeSession(A_DIR)
    // 值 / 空串（旧语义=清除）**都**拒绝：退役是"不再产生新标识"，
    // 而"清除"也是写操作 —— 留一个半开的口子会长出两套语义。
    for (const attempt of ['alpha-main', '']) {
      await expect(
        run({ action: 'uid', name: 'S900', uid: attempt }),
        `uid="${attempt}" 应被拒（写入已退役）`,
      ).rejects.toThrow(/retired/)
    }
    // 负控：文件**没有**被创建
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'))).toBe(false)
  })

  it('🔴 核心判据：遗留 UID 文件仍可指认（写入退役 ≠ 读取退役）', async () => {
    // 这条守的是"能力不倒退"：S142 的 TRAJECTORY-UID 是**存量事实**，
    // 退役写入不该把它变成不可用。文件直接写盘 = 模拟存量。
    writeSession(A_DIR)
    writeSession(B_DIR, B_BODY)
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'), 'alpha-main\n', 'utf-8')

    // uid 读回
    const readBack = (await run({ action: 'uid', name: 'alpha-main' })) as Record<string, unknown>
    expect(readBack.uid).toBe('alpha-main')
    // show / use / archive 逐条点名（不只测 show —— 与退役前同一套判据）
    const viaUid = (await run({ action: 'show', name: 'alpha-main' })) as string
    const viaId = (await run({ action: 'show', name: 'S900' })) as string
    expect(viaUid, 'show 用遗留 UID 与用编码必须等价').toBe(viaId)
    const used = (await run({ action: 'use', name: 'alpha-main', summary: '概' })) as Record<string, unknown>
    expect(used.dir).toBe(A_DIR)
    const arch = (await run({ action: 'archive', name: 'alpha-main' })) as Record<string, unknown>
    expect(arch.ok).toBe(true)
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR))).toBe(true)
  })

  it('🔴 遗留 UID 精确匹配仍大小写敏感（`Zulu` ≠ `zulu`）', async () => {
    writeSession(A_DIR)
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'), 'Zulu\n', 'utf-8')
    expect((await run({ action: 'show', name: 'Zulu' })) as string).toContain('SESSION: alpha')
    await expect(
      run({ action: 'show', name: 'zulu' }),
      '小写 zulu 不得命中 UID "Zulu"（也不含在目录名里 ⇒ 两条路都不该命中）',
    ).rejects.toThrow('Session not found')
  })

  it('list 会印出遗留 UID（它是用于交流的标识，得让人看得见）', async () => {
    writeSession(A_DIR)
    expect((await run({ action: 'list' })) as string).not.toContain('[alpha-main]')
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'), 'alpha-main\n', 'utf-8')
    expect((await run({ action: 'list' })) as string).toContain('[alpha-main]')
  })

  it('🔴 只读：查看 UID 不改本体（目录名与 SESSION.md 逐字节不变）', async () => {
    const md = writeSession(A_DIR)
    const before = readFileSync(md, 'utf-8')
    await run({ action: 'uid', name: 'S900' })
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), '目录名不得因查看 UID 而改').toBe(true)
    expect(readFileSync(md, 'utf-8'), 'SESSION.md 不得被改写').toBe(before)
  })

  /**
   * 🆕 2026-10-19 owner 裁 Q2：**声明文件里的 `uid` 优先，独立文件回落**（两代并读）。
   *
   * 🔴 为什么这条必须有：收拢之后旧标识住进了 `trajectory.json`，而**存量轨迹**里
   * 它还在独立文件里。只实现一侧的后果是「一部分轨迹的 UID 突然指认不到了」——
   * 而症状（`Session not found`）与真因（"读的是另一条路"）在读数上完全不像。
   */
  it('🆕 声明文件的 `uid` 字段也能指认（收拢后的新形态）', async () => {
    writeSession(A_DIR)
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'trajectory.json'), JSON.stringify({ uid: 'alpha-decl' }), 'utf-8')
    const readBack = (await run({ action: 'uid', name: 'alpha-decl' })) as Record<string, unknown>
    expect(readBack.uid).toBe('alpha-decl')
    expect((await run({ action: 'show', name: 'alpha-decl' })) as string).toContain('SESSION: alpha')
  })

  it('🔴 两处都给 ⇒ **声明文件优先**（独立文件不得遮蔽它）', async () => {
    writeSession(A_DIR)
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'), 'from-file\n', 'utf-8')
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'trajectory.json'), JSON.stringify({ uid: 'from-json' }), 'utf-8')
    expect((await run({ action: 'uid', name: 'S900' })) as Record<string, unknown>).toMatchObject({ uid: 'from-json' })
    // 反向钉：被遮蔽的那个**不该**还能指认（否则等于两个标识同时生效）
    await expect(run({ action: 'show', name: 'from-file' })).rejects.toThrow('Session not found')
  })

  it('🔴 声明文件的 `uid` 形态非法 ⇒ 按"没设定"处理，**回落独立文件**（不抛、不连坐）', async () => {
    writeSession(A_DIR)
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'), 'good-handle\n', 'utf-8')
    writeFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'trajectory.json'), JSON.stringify({ uid: '带中文 的 非法值' }), 'utf-8')
    expect((await run({ action: 'uid', name: 'S900' })) as Record<string, unknown>).toMatchObject({ uid: 'good-handle' })
  })

  // 🔴🔴 **2026-11-15（owner 令）：本组原有两条 `continue-all-interrupted` 用例已删除。**
  //    它们测的是 `cognitive_trajectory` 的**续跑入口**（从工厂 ctx 取 agents ／ 无服务时如实报"不可用"），
  //    而该动作已整体移除（`COGNITIVE_TRAJECTORY_ACTIONS` 13 → 11，见文件上方「工具面」组的反向钉）。
  //
  //    ⚠️ **能力没删，判据也没丢**：`scanInterruptedSessions` / `createResumeOne` / `buildContinueText`
  //    全在 `src/trajectory/interrupted.ts`，且仍由 `wake/scheduler.ts` 的 60s tick 调用 ⇒ 它们的
  //    单测继续在 `tests/trajectory/interrupted.test.ts` 覆盖。这里删掉的只是"**工具入口**那一层"。
  //    ⚠️ 顺带登记：这两条本来就挂错了分组（测续跑却挂在 `uid` 组里，历史遗留），借这次一起清掉。
})
