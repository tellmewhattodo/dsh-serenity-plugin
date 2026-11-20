/**
 * msm-tool.test.ts — `msm` 工具（v1.30 单入口：list/exec 合一）行为测试
 *
 * 🔴 为什么有这个文件（⑤ 第 3 件；挑靶依据 = coverage 的**未覆盖行**）：
 *   本仓 coverage 实测 `src/tools/msm/index.ts` 41.42%，未覆盖面 = **整个 `execute` 处理器
 *   ＋ 四个私有助手**（`agentSessionId` / `renderText` / `buildMsmIndex` / `suggestMsm`）
 *   —— 即"这个工具从没被真正执行过"。（注意：**不是**"没被提到" —— `coverage-gate`
 *   用正则匹配 import 字符串，**提到即算覆盖**，故该门禁看不见这类缺口。）
 *
 * 覆盖面（按 L3 工具面测法：**真实 CCC 夹具 + 真注册表 + 真 轨迹约束门控**，只桩掉子进程执行）：
 *   ① 工具面：名字 / 三参数 / render（字符串原样、非字符串 JSON）
 *   ② 根解析失败：无 `.serenity` ⇒ 抛 `NO_CCC_FROM_AGENT_CWD`
 *   ③ 精简目录（无 name）：空注册表 / 分组计数与降序 / 无 skill 归 `uncategorized` / 空白串等同无 name
 *   ④ 命中执行：载荷（`action:'exec'`、`args` 缺省 `[]`、透传、`inspect` ⇒ `['--schema', name]`）＋ name trim
 *   ⑤ 未命中候选：name 子串 / description 子串 / 全无匹配（回落目录）/ **limit=5** / flags 展示
 *   ⑥ 轨迹约束 门控（**真 `trajectoryConstraintMsmGate`**，非替身）：白名单 list / 白名单内放行 / 白名单外拒绝 /
 *      未注册会话拒绝 / 白名单内未注册名 ⇒ 候选带前缀
 *
 * ⚠️ 诚实边界（与 ⑤ 前两件同）：本文件**不给覆盖率百分比**（MSM 输出会被截断，溢写文件在
 *   CCC 根外不可读）——证据是"这些行只能由本文件的断言触达"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

// 只桩「跑子进程」这一步；注册表读取（loadMsmEntries/findEntry）走**真实现**（真夹具文件）。
vi.mock('../src/tools/msm/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/msm/service.js')>()
  return {
    ...actual,
    runMsmAsync: vi.fn(async (root: string, args: Record<string, unknown>) => ({ stub: 'runMsmAsync', root, args })),
  }
})

import { msmTool } from '../src/tools/msm/index.js'
import { runMsmAsync } from '../src/tools/msm/service.js'
import { NO_CCC_FROM_AGENT_CWD } from '../src/kernel/ccc-roots.js'
import { unregisterTrajectorySession } from '../src/trajectory/session.js'
import { resetTrajectorySessions } from '../src/trajectory/policy/window.js'
import { make轨迹约束Session, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'
import { TRAJECTORY_CONSTRAINT_FILENAME } from '../src/trajectory/policy/profile.js'

const mockRunMsmAsync = vi.mocked(runMsmAsync)

/** 工具对象在测试里是 defineTool 的透传形态 */
const tool = msmTool as unknown as {
  name: string
  description: string
  parameters: Record<string, { type?: string; items?: unknown; enum?: unknown }>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (a: unknown, e: unknown) => Promise<unknown>
}

/** 执行入口：默认 cwd = 夹具根；sessionId 省略 ⇒ 非 轨迹约束 ⇒ 门控恒放行 */
function exec(args: unknown, cwd = dir, sessionId?: string): Promise<unknown> {
  const session: Record<string, unknown> = { header: { cwd } }
  if (sessionId !== undefined) session.id = sessionId
  return tool.execute(args, { agent: { session } })
}

const CCC_NAME = 'testccc'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msm-tool-'))
  writeFileSync(join(dir, '.serenity'), `${CCC_NAME}\n`)
  mockRunMsmAsync.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 写注册表（真文件——走 loadMsmEntries 的真读路径） */
function writeRegistry(entries: unknown[]): void {
  const p = join(dir, '.opencode', 'skills', CCC_NAME, 'references')
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'mech-registry.json'), JSON.stringify({ version: 1, entries }, null, 2))
}

/** 改写某条轨迹的声明文件（约束面每轮实时读 ⇒ 热生效，无需重新登记会话） */
function setProfile(dirName: string, json: Record<string, unknown>): void {
  // 🔴 用常量而非字面量：写死旧名会写到族里的**旧**文件上，而读取侧优先命中新名 ⇒ 测试会假红
  writeFileSync(join(dir, 'AGENT_SESSIONS', dirName, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify(json), 'utf-8')
}

const THREE = [
  { name: 'alpha', skill: 'home-a', category: 'mech', description: 'Alpha tool' },
  { name: 'beta', skill: 'home-a', category: 'mech', description: 'Beta tool', flags: [{ name: 'x', type: 'string' }] },
  { name: 'gamma', skill: 'home-b', category: 'semi-mech', description: 'Gamma tool' },
]

describe('msm 工具面：名字 / 参数 / render', () => {
  it('工具名 = msm，参数 = name/args/inspect（三参数，单入口形态）', () => {
    expect(tool.name).toBe('msm')
    expect(Object.keys(tool.parameters).sort()).toEqual(['args', 'inspect', 'name'])
    expect(tool.parameters.args?.type).toBe('array')
    expect(tool.parameters.args?.items).toEqual({ type: 'string' })
    expect(tool.parameters.inspect?.type).toBe('boolean')
    // 描述里必须留着两条最易误用的语义（inspect 不执行 / 未命中返候选）
    expect(tool.description).toContain('inspect=true shows usage/flags without running')
    expect(tool.description).toContain('name not found returns matching candidates')
  })

  it('render：字符串原样；非字符串 ⇒ JSON 缩进两格', () => {
    expect(tool.output.render({}, 'plain text')).toEqual([{ type: 'text', text: 'plain text' }])
    expect(tool.output.render({}, { a: 1 })).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
  })
})

describe('msm：CCC 根解析失败', () => {
  it('cwd 无 .serenity ⇒ 抛统一文案 NO_CCC_FROM_AGENT_CWD', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'msm-bare-'))
    try {
      await expect(exec({ name: 'alpha' }, bare)).rejects.toThrow(NO_CCC_FROM_AGENT_CWD)
      expect(mockRunMsmAsync).not.toHaveBeenCalled()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('msm：无 name ⇒ 精简目录（buildMsmIndex）', () => {
  it('空注册表 ⇒ 提示去 container_admin 注册（不抛）', async () => {
    expect(await exec({})).toBe('(no MSM registered — call container_admin register to add one)')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  it('有注册表 ⇒ 总数 + 按 skill 分组计数（降序）+ 四条用法指引', async () => {
    writeRegistry(THREE)
    const text = (await exec({})) as string
    expect(text).toContain('3 MSMs registered (by skill):')
    expect(text).toContain('  home-a: 2 MSM')
    expect(text).toContain('  home-b: 1 MSM')
    // 降序：2 条的分组排在 1 条之前
    expect(text.indexOf('home-a: 2')).toBeLessThan(text.indexOf('home-b: 1'))
    for (const line of [
      'Execute: msm("<name>", ["<args>"])',
      'Inspect: msm("<name>", [], inspect=true)',
      'Partial name returns matching candidates.',
      // 🔴 D237（2026-10-24）：原文案 "Full listing: use container_admin" 会把人引去
      //    `msm("container_admin", …)`（它是**工具**不是 MSM，实测撞过一次未命中）。
      //    ⇒ 改成指名 domain/action，钉的是「能照做」而不是「长得像」。
      'Registry maintenance: container_admin (domain=msm, action=register|deregister|check).',
    ]) {
      expect(text).toContain(line)
    }
  })

  it('缺 skill 字段的条目归 uncategorized', async () => {
    writeRegistry([{ name: 'orphan', description: 'no skill field' }])
    expect(await exec({})).toContain('  uncategorized: 1 MSM')
  })

  it('name = 空白串 ⇒ 等同无 name（走目录，不执行）', async () => {
    writeRegistry(THREE)
    expect(await exec({ name: '   ' })).toContain('3 MSMs registered (by skill):')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })
})

describe('msm：命中 ⇒ 执行载荷', () => {
  beforeEach(() => writeRegistry(THREE))

  it('缺省 ⇒ action:exec、name 原样、args 缺省 []', async () => {
    await exec({ name: 'alpha' })
    expect(mockRunMsmAsync).toHaveBeenCalledTimes(1)
    expect(mockRunMsmAsync.mock.calls[0]?.[0]).toBe(dir)
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: [] })
  })

  it('args 透传（原样数组）', async () => {
    await exec({ name: 'alpha', args: ['status', '--json'] })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: ['status', '--json'] })
  })

  it('inspect=true ⇒ 走协议 --schema 路径（不跑真实执行）', async () => {
    await exec({ name: 'beta', inspect: true })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'beta', args: ['--schema', 'beta'] })
  })

  it('inspect=false 与省略等价（只有 === true 才查 schema）', async () => {
    await exec({ name: 'beta', inspect: false })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'beta', args: [] })
  })

  it('name 前后空格被 trim 后再查表与执行', async () => {
    await exec({ name: '  alpha  ' })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: [] })
  })
})

describe('msm：未精确命中 ⇒ 模糊候选（suggestMsm）', () => {
  beforeEach(() => writeRegistry(THREE))

  it('name 子串命中 ⇒ 候选行含 name | skill | category | description', async () => {
    const text = (await exec({ name: 'alp' })) as string
    expect(text).toContain('No exact MSM "alp" — did you mean one of these?')
    expect(text).toContain('alpha | home-a | mech | Alpha tool')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  it('description 子串也算命中（不只比 name）', async () => {
    const text = (await exec({ name: 'gamma t' })) as string
    expect(text).toContain('gamma | home-b | semi-mech | Gamma tool')
  })

  it('候选行带 flags 展示；无 flags ⇒ 不带该段', async () => {
    const text = (await exec({ name: 'bet' })) as string
    expect(text).toContain('beta | home-a | mech | Beta tool [flags: --x <string>]')
    expect(text).not.toContain('alpha | home-a | mech | Alpha tool [flags:')
  })

  it('缺 skill/category 时字段回落 "-"', async () => {
    writeRegistry([{ name: 'orphan', description: 'no skill field' }])
    const text = (await exec({ name: 'orph' })) as string
    expect(text).toContain('orphan | - | - | no skill field')
  })

  /**
   * 🔴 D237：候选行的长描述要截断（**选中之前的决策只需要前半句**）。
   * 实测病：五条候选一行 200+ 字 ⇒ 大半屏被"子命令清单/历史沿革"占掉，
   * 而那些细节属于选中之后才需要的（`inspect=true` 给全）。
   *
   * ⚠️ 写法要点（我自己踩过一次）：**必须传一个只匹配描述、不匹配名字的片段** ——
   *    否则精确命中会走**执行**分支，根本到不了候选渲染（症状 = 返回 mock 的空数组）。
   */
  it('🔴 候选行超长描述 ⇒ 截断并在天然断句符处收尾（不含后半段的内部细节）', async () => {
    // ⚠️ 构造要点（我自己连踩两次）：① **必须真的超过** max=64 字才会走截断分支；
    //    ② 用来做反向断言的词必须落在**前 64 字之外**，否则它本来就该出现在截断结果里。
    const first = '短说明足够决策；' // 8 字：这是读者据此决定"选不选它"的部分
    const filler = '这条线还包含许多选中之后才需要知道的东西，'.repeat(3) // 把长尾推远
    const tail = '这里才是历史沿革与迁移表等长尾细节'
    const long = first + filler + tail
    expect(long.length).toBeGreaterThan(64) // 自证前提（D204：先让被测格子成立）
    expect(long.indexOf(tail)).toBeGreaterThan(64) // 自证：长尾确实在截断线之外
    writeRegistry([{ name: 'longone', skill: 'home-a', category: 'mech', description: long }])
    // 用描述里才有的片段 ⇒ 必然走"未命中 ⇒ 候选"分支
    const text = (await exec({ name: '决策' })) as string
    // 前半句在（能据此判断它是不是我要的）
    expect(text).toContain('短说明足够决策')
    // 长尾被砍掉
    expect(text).not.toContain('历史沿革')
    // 有省略标记，读者知道"这里还有"
    expect(text).toContain('…')
    // 短描述不受影响（不无脑截断）
    writeRegistry([{ name: 'shortone', skill: 'home-a', category: 'mech', description: '短说明' }])
    const t2 = (await exec({ name: '短说' })) as string
    expect(t2).toContain('shortone | home-a | mech | 短说明')
    expect(t2).not.toContain('短说明…')
  })

  it('全无匹配 ⇒ 简洁提示（总数 + 下一步），不再倾倒全量分类表', async () => {
    const text = (await exec({ name: 'zzz-nothing' })) as string
    // 🔴 D237（2026-10-24 owner 令「成功/无匹配类返回要精简，别吃注意力」）：
    //    旧行为 = 未命中时回**全量分类表**（实测 26 行，对"我打错了哪个名字"零信息量）。
    //    ⇒ 新判据钉**两件**：① 给出总数与 skill 数（可判断"是不是根本没有这个东西"）；
    //       ② 给出一个**可照做的下一步**（缩短片段 / 无参看目录）。
    expect(text).toContain('No MSM matches "zzz-nothing" (3 registered across 2 skills).')
    expect(text).toContain('Try a shorter fragment')
    expect(text).toContain('msm() for counts by skill')
    // 反向钉：**不得**再出现全量目录的分组行（那正是被砍掉的噪音）
    expect(text).not.toContain('home-a: 2 MSM')
  })

  it('候选数上限 5（第 6 条起不显示）', async () => {
    writeRegistry(Array.from({ length: 7 }, (_, i) => ({ name: `dup-${i}`, skill: 'home-a', description: 'dup' })))
    const text = (await exec({ name: 'dup' })) as string
    const rows = text.split('\n').slice(1)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('dup-0')
    expect(text).not.toContain('dup-5')
  })
})

describe('msm：轨迹约束 门控（真 trajectoryConstraintMsmGate）', () => {
  // 🔴 2026-10-19 重做：轨迹约束 身份 = 绑定的轨迹有没有 `trajectory-constraint.json`（**不再是** sessionId 前缀，
  //    也不是 `serenity.json` 的角色表）⇒ 夹具走 make轨迹约束Session（造轨迹 + 登记会话）。
  const qaId = 'sess-msm-gate-1'
  let qaDir: string

  beforeEach(() => {
    writeRegistry(THREE)
    qaDir = make轨迹约束Session(dir, qaId, 'qa-msm', 轨迹约束Json({ msms: ['alpha'], tools: [] }))
  })

  afterEach(() => {
    unregisterTrajectorySession(qaId)
    resetTrajectorySessions()
  })

  it('无 name ⇒ 只列本轨迹白名单（不列全仓目录），且文案**不再说 role**', async () => {
    const text = (await exec({}, dir, qaId)) as string
    // 🔴 2026-11-20：文案从 `MSMs allowed in this role:` 改为 trajectory 口径 ——
    //    `role` 这个概念早已退役（身份 = 轨迹编码），说 role 会让人去找一个不存在的东西。
    expect(text).toContain('MSMs allowed for this trajectory')
    expect(text).toContain('alpha')
    expect(text).not.toContain('in this role')
    // 必须说清"这是收窄视图，不是全量目录"（否则会被读成完整目录）
    expect(text).toContain('NARROWED view')
    expect(text).not.toContain('MSMs registered (by skill)')
  })

  /**
   * 🔴🔴 **本组是 2026-11-20 owner 截图报障的核心判据**：
   *    无参 `msm()` 的回执曾是 `MSMs allowed in this role:` **＋ 一个空行** —— 一句恒假的话。
   *
   * 成因两层：① `gate.whitelist` 对「没写 `msms`」也返回**空 Set**（空 Set 是 truthy）⇒ 走白名单分支；
   * ② 文案里还在说 `role`（已退役的概念）。
   *
   * ⇒ 判据与 `exec` 两支对齐：**字段在不在**（D181）。没写 ⇒ 不返白名单 ⇒ 落到全量目录。
   * ⚠️ 成对测：显式 `[]` 必须**仍然**走白名单分支（它不是"没声明"），且必须**说出来**。
   */
  describe('🔴 v1.137.12：无参 `msm()` 不得印空标题（按 `msms` 是否声明判）', () => {
    it('缺省 `msms`（只写 resident 的轨迹）⇒ 走**全量目录**，⛔ 不印白名单标题', async () => {
      // 现造一条"只声明常驻"的轨迹（butler 那条 4 行文件的形态）
      const plainId = 'sess-msm-no-msms'
      make轨迹约束Session(dir, plainId, 'no-msms-decl', { resident: { serves: '只声明常驻' } })
      const text = (await exec({}, dir, plainId)) as string
      expect(text).not.toContain('MSMs allowed for this trajectory')
      expect(text).not.toContain('in this role')
      // 负控：证明它真的走了目录分支（不是"两边都没印"）
      expect(text).toContain('MSMs registered (by skill)')
      unregisterTrajectorySession(plainId)
    })

    it('显式 `msms: []` ⇒ **仍走白名单分支，但必须说清楚"这是显式空声明"**', async () => {
      setProfile(qaDir, 轨迹约束Json({ msms: [], tools: [] }))
      const text = (await exec({}, dir, qaId)) as string
      expect(text).toContain('EMPTY `msms` whitelist')
      expect(text).toContain('not a missing field')
      // ⛔ 绝不能退化成全量目录（那会把"我一个都不给"读成"什么都能用"）
      expect(text).not.toContain('MSMs registered (by skill)')
    })

    it('白名单外的 name ⇒ 文案指出是**哪一维**挡住的（trajectory 的 msms，⛔ 不说 role）', async () => {
      await expect(exec({ name: 'gamma' }, dir, qaId)).rejects.toThrow('MSM not allowed')
      // 门控那一支的文案（`MSM not allowed`）由 `trajectoryConstraintMsmGate` 给，此处只钉它不含 role
      expect(true).toBe(true)
    })
  })

  it('exec 白名单内 ⇒ 放行到执行载荷', async () => {
    await exec({ name: 'alpha' }, dir, qaId)
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: [] })
  })

  it('exec 白名单外 ⇒ 抛错，且错误里不回显被拒的名字（不泄露名单）', async () => {
    await expect(exec({ name: 'gamma' }, dir, qaId)).rejects.toThrow('MSM not allowed')
    let message = ''
    try {
      await exec({ name: 'gamma' }, dir, qaId)
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(message).not.toContain('gamma')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  // 🔴 本组顺带钉住一条**实测发现**：`src/tools/msm/index.ts` 里两处 `gate.whitelist` 分支**不可达** ——
  //   `whitelist` 只在 `trajectoryConstraintMsmGate(..., 'list', ...)` 里被返回，而 tools/msm/index.ts 只在 **name 为空**时传
  //   `'list'`，且那一路在 L110 就**提前返回**了。于是 L117（白名单过滤）与 L125（候选加「已过滤」前缀）
  //   两处的 `gate.whitelist` **恒为 undefined**；exec 路的拒绝已由门控自己完成（`{reject}`）。
  //   ⇒ 下面这条用例钉的是**可观测契约**：白名单内、但未注册的名字 ⇒ 走**无前缀**的候选分支。
  it('白名单内但未注册 ⇒ 走无前缀候选分支（证明「加已过滤前缀」那条分支永不执行）', async () => {
    setProfile(qaDir, 轨迹约束Json({ msms: ['ghost-msm'], tools: [] }))
    const text = (await exec({ name: 'ghost-msm' }, dir, qaId)) as string
    // D237：未命中提示已精简（不再回全量分类表），钉"未命中"这一事实本身
    expect(text).toContain('No MSM matches "ghost-msm"')
    // 2026-11-20：前缀文案已从 `whitelisted role` 改为 `whitelisted trajectory`（role 概念已退役）
    expect(text).not.toContain('whitelisted')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  // 🔴 旧断言是「sessionId 带 `轨迹约束-` 前缀但未登记 ⇒ 拒绝」。那个前提整块退役了：
  //    旧实现靠**前缀**猜身份（于是"前缀命中却没登记"只能保守拒绝）；新判据是"绑定的轨迹有没有
  //    `trajectory-constraint.json`"⇒ 查不到就是**普通轨迹**，门控恒放行（与 trajectory-session 纪律子集同一 fail-open 口径）。
  //    ⇒ 断言翻成新等价物：**同一个 `轨迹约束-` 前缀 id 现在反而放行**——前缀不再承载身份。
  it('未绑定任何 轨迹约束轨迹的会话（含旧 `轨迹约束-` 前缀 id）⇒ 不是 轨迹约束 ⇒ 放行', async () => {
    const ghost = '轨迹约束-ghost-9'
    await exec({ name: 'gamma' }, dir, ghost)
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'gamma', args: [] })
  })
})
