import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideGuard,
  getRestrictDiagnostics,
  getNonCccHiddenDiagnostics,
  getHostScheduleHiddenDiagnostics,
  computeVisibilitySources,
} from '../src/seams/guards.js'
import { REGISTERED_TOOLS, CONDITIONAL_TOOL_COUNT } from '../src/kernel/invariant.js'
import { registerImChannel, __resetImChannelsForTest } from '../src/im/channels.js'
import { readBlacklist, matchBlacklist, pathInside, readSafeModeHiddenTools, type BlacklistRule } from '../src/kernel/ccc.js'
import type { TrajectoryConstraint } from '../src/trajectory/policy/profile.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guards-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function base(over: Partial<GuardInput>): GuardInput {
  return { root: '/ccc', toolName: 'read', safeModeOn: false, blacklist: [], pathArg: undefined, ...over }
}

function rules(...patterns: string[]): BlacklistRule[] {
  return patterns.map((p) => ({ pattern: p }))
}

/**
 * 直接造一条 `TrajectoryConstraint`（`decideGuard` 的纯函数契约：约束面由调用方解析好传进来，守卫自己不读盘）。
 *
 * 🔴 2026-10-19 重做带来的构造方式变化（R↓，别按旧模型再写回 `writeConfig({轨迹约束:{roles:…}})`）：
 * - **载体**：轨迹约束的约束从 `.opencode/serenity.json` 的 `轨迹约束.roles.<name>` 搬到**轨迹目录下的
 *   `trajectory-constraint.json`**（`轨迹约束.roles` 整段已退役 ⇒ 旧写法写进去也读不到）；
 * - **判据**：谁是 轨迹约束 由 `trajectory/policy/profile.ts` 的 `trajectoryConstraintForSession` **唯一**判定
 *   （"绑定的轨迹有 `trajectory-constraint.json`"，不再看 sessionId 前缀）；
 * - **守卫**：只消费已解析好的 `trajectoryConstraint`；`null`/`undefined` = 不是 轨迹约束 ⇒ 整段跳过。
 *
 * ⇒ 本文件只描述"给守卫什么约束面"，不落盘、不注册会话；落盘与判据路径由
 * `tests/轨迹约束-profile.test.ts`（+ `tests/helpers/trajectory-constraint-fixture.ts`）覆盖。
 */
function profile(over: Partial<TrajectoryConstraint> = {}): TrajectoryConstraint {
  return {
    dirName: '2026-10-19--qa--t',
    code: 'qa',
    path: '',
    tools: [],
    msms: [],
    // 缺省全 true：新模型里工作台就是这条轨迹自己的 SESSION.md（旧模型缺省全 false，见 profile.ts R↓）
    cognitiveTrajectory: { session: true, keeper: true, rebuild: true },
    ...over,
  }
}

/**
 * 🔴 方案 C（owner 2026-10-22 裁）后的测试入口。
 *
 * 六条 `syncXxx` 已合并成一次发射（`syncToolVisibility`），它们**不再单独存在**。
 * 但这些用例真正要钉的东西没变 —— **每一源算出来的 deny 清单是什么**。
 * ⇒ 改成直接问纯函数 `computeVisibilitySources`：判据一条不动，只是入口换了。
 * （这正是"计算与发射分离"的直接收益：算 deny 不再需要替身宿主。）
 */
function denyOf(id: string, root: string | null, sessionId = 's-test'): string[] {
  const s = computeVisibilitySources(sessionId, root).find((x) => x.id === id)
  if (!s) throw new Error(`没有这个来源：${id}（候选：${computeVisibilitySources(sessionId, root).map((x) => x.id).join(', ')}）`)
  return [...s.deny].sort()
}

describe('guards: decideGuard 纯决策', () => {
  it('非安全模式 + 无路径 → allow', () => {
    expect(decideGuard(base({}))).toEqual({ kind: 'allow' })
  })

  it('安全模式 + 写工具 → deny（提示不泄露 safe-mode：bash 不存在）', () => {
    const d = decideGuard(base({ safeModeOn: true, toolName: 'bash' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('bash')
    expect(d.deny).not.toContain('safe mode')
    expect(d.deny).not.toContain('serenity')
  })

  it('安全模式 + write（非 bash）干净路径 → allow（标准语义：只禁 bash）', () => {
    expect(decideGuard(base({ safeModeOn: true, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('安全模式 + write + 黑名单路径 → deny（黑名单分支）', () => {
    const d = decideGuard(base({ safeModeOn: true, toolName: 'write', blacklist: rules('.secrets/'), pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('安全模式 + 读工具 → allow', () => {
    expect(decideGuard(base({ safeModeOn: true, toolName: 'read' })).kind).toBe('allow')
  })

  it('路径越界 → deny', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '../escape' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('path escape')
  })

  it('黑名单命中 → deny', () => {
    const d = decideGuard(base({ toolName: 'write', blacklist: rules('.secrets/'), pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('读工具 + 黑名单路径 → allow（v1.18.5：黑名单只拦写，不误伤读——对齐 osp）', () => {
    // read 读 REPOSITORIES/ 下 repo（只读参考源黑名单）不应被拦
    const d = decideGuard(base({ toolName: 'read', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/some-repo/README.md' }))
    expect(d.kind).toBe('allow')
    // 写工具仍拦
    const w = decideGuard(base({ toolName: 'write', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/some-repo/a.ts' }))
    expect(w.kind).toBe('deny')
  })

  it('读工具 + 治理文件路径 → allow（治理保护只拦写）', () => {
    expect(decideGuard(base({ toolName: 'read', pathArg: '.serenity' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'write', pathArg: '.serenity' })).kind).toBe('deny')
  })

  it('container_fs 只读子命令（exists/list/tree）→ 黑名单不拦（对齐 read 语义）', () => {
    // 用户实测：container_fs exists REPOSITORIES/arsenal 被误拦（v1.19.0 后修复）
    const d = decideGuard(base({ toolName: 'container_fs', action: 'exists', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' }))
    expect(d.kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'list', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'tree', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'info', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
  })

  it('container_fs 写子命令（mkdir/rm/mv/cp/touch）→ 黑名单仍拦', () => {
    for (const action of ['mkdir', 'rm', 'mv', 'cp', 'touch']) {
      const d = decideGuard(base({ toolName: 'container_fs', action, blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal/x' }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain('blacklist')
    }
  })

  it('🔴 append 退役后**不再**是写类子命令（它现在根本不可执行 ⇒ 不必也不该留在写清单里）', () => {
    // 判据：写清单里没有 append —— 与 service.ts 的 CC_FS_ACTIONS 同步
    //   若哪天有人"顺手"把 append 加回写清单而没加回动作表，本用例会变红。
    const d = decideGuard(base({ toolName: 'container_fs', action: 'append', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal/x' }))
    expect(d.kind).toBe('allow')
  })

  it('container_fs 无 action（参数缺失）→ 不按写类拦截（保守 allow，越界仍拦）', () => {
    expect(decideGuard(base({ toolName: 'container_fs', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
    // 越界检查不受影响
    expect(decideGuard(base({ toolName: 'container_fs', pathArg: '../escape' })).kind).toBe('deny')
  })

  it('container_fs 治理文件保护：写子命令写 .serenity → deny；只读子命令 → allow', () => {
    expect(decideGuard(base({ toolName: 'container_fs', action: 'touch', pathArg: '.serenity' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'exists', pathArg: '.serenity' })).kind).toBe('allow')
  })

  // ── v1.26.3 数据面守卫：localstore.json 凭据文件任何工具不可读（S142 用户指令）──

  it('read localstore.json → deny（用户：localstore.json 需要在 read 工具的黑名单里）', () => {
    const d = decideGuard(base({ toolName: 'read', pathArg: 'localstore.json' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('sensitive credential file')
    // 不依赖 safe-mode 开关（结构性边界）
    expect(decideGuard(base({ toolName: 'read', safeModeOn: true, pathArg: 'localstore.json' })).kind).toBe('deny')
  })

  it('grep/glob/container_fs 只读子命令 localstore.json → deny（数据面不看工具读写性）', () => {
    expect(decideGuard(base({ toolName: 'grep', pathArg: 'localstore.json' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'glob', pathArg: 'localstore.json' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'info', pathArg: 'localstore.json' })).kind).toBe('deny')
    // 嵌套目录同名文件不误伤（凭据文件只在根）
    expect(decideGuard(base({ toolName: 'read', pathArg: 'docs/localstore.json' })).kind).toBe('allow')
  })

  it('写工具 localstore.json → deny（写入同样阻断——凭据文件不可由 agent 改写）', () => {
    expect(decideGuard(base({ toolName: 'write', pathArg: 'localstore.json' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'touch', pathArg: 'localstore.json' })).kind).toBe('deny')
  })

  it('凭据文件守卫先于黑名单/读保护（localstore.json 恒 deny 无论 blacklist）', () => {
    const d = decideGuard(base({ toolName: 'read', blacklist: rules('.secrets/'), pathArg: 'localstore.json' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('sensitive credential file')
  })

  it('路径合法且不命中 → allow', () => {
    expect(decideGuard(base({ toolName: 'write', blacklist: rules('.secrets/'), pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('黑名单对象条目（{pattern, message}）→ deny 且提示用自定义 message（对齐 osp）', () => {
    const blacklist: BlacklistRule[] = [{ pattern: '.secrets/', message: 'secrets 目录禁止写入' }]
    const d = decideGuard(base({ toolName: 'write', blacklist, pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('secrets 目录禁止写入')
  })

  it('反斜杠路径归一化：斜杠结尾黑名单规则命中 Windows 风格路径（审计问题 9）', () => {
    // pathArg 含反斜杠（Windows 风格相对路径）→ rel 归一化为正斜杠后黑名单前缀匹配
    const d = decideGuard(base({ toolName: 'write', blacklist: rules('.secrets/'), pathArg: '.secrets\\file.txt' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('嵌套治理文件保护：反斜杠路径 .serenity\\child 归一化后拦截（审计问题 9）', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity\\child' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('governance file')
  })

  it('pathInside 跨盘语义（Windows，审计问题 6）：跨盘/兄弟目录 false，子路径 true', () => {
    // decideGuard 用 pathInside 判越界；此处直接验证 pathInside 的 Windows 跨盘语义
    // （resolve 平台行为差异使 decideGuard 级跨盘测试在 POSIX 无法复现——ccc.test.ts 覆盖守卫集成）
    expect(pathInside('D:\\project\\home', 'C:\\Windows', true)).toBe(false) // 跨盘符
    expect(pathInside('D:\\project\\home', 'D:\\project\\home2', true)).toBe(false) // 兄弟目录
    expect(pathInside('D:\\project\\home', 'D:\\project\\home\\docs', true)).toBe(true) // 子路径
  })
})

describe('blacklist: 对象条目解析（对齐 osp readBlacklist）', () => {
  it('string 与 object 条目混合解析', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        safeMode: {
          blacklist: ['.secrets/', { pattern: '/etc/', message: '系统目录' }, 'regex:^\\.tmp-'],
        },
      }),
    )
    const blacklist = readBlacklist(dir)
    expect(blacklist).toHaveLength(3)
    expect(blacklist[0]).toEqual({ pattern: '.secrets/' })
    expect(blacklist[1]).toEqual({ pattern: '/etc/', message: '系统目录' })
    // 前缀匹配
    expect(matchBlacklist('.secrets/x', blacklist)?.pattern).toBe('.secrets/')
    // 正则匹配
    expect(matchBlacklist('.tmp-test/y', blacklist)?.pattern).toBe('regex:^\\.tmp-')
    // 未命中
    expect(matchBlacklist('docs/a.md', blacklist)).toBeNull()
  })

  it('非法条目（数字/null/无 pattern 对象）跳过', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ safeMode: { blacklist: [42, null, { message: 'no pattern' }, 'ok/'] } }),
    )
    const blacklist = readBlacklist(dir)
    expect(blacklist).toHaveLength(1)
    expect(blacklist[0]!.pattern).toBe('ok/')
  })
})

describe('readSafeModeHiddenTools（判据：fail-open）', () => {
  function write(cfg: unknown): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg))
  }

  it('未配置 / 无该键 / 非数组 ⇒ []（不抛）', () => {
    expect(readSafeModeHiddenTools(dir)).toEqual([])
    write({ safeMode: {} })
    expect(readSafeModeHiddenTools(dir)).toEqual([])
    write({ safeMode: { hiddenTools: 'workflow' } })
    expect(readSafeModeHiddenTools(dir)).toEqual([])
  })

  it('读数组 / 去空白 / 丢非字符串 / 保序', () => {
    write({ safeMode: { hiddenTools: [' workflow ', 42, null, '', 'job_kill'] } })
    expect(readSafeModeHiddenTools(dir)).toEqual(['workflow', 'job_kill'])
  })

  it('🔴 配置损坏 ⇒ []（fail-open：隐藏是危险方向，读不到声明就不多藏）', () => {
    write('{ this is not json')
    expect(() => readSafeModeHiddenTools(dir)).not.toThrow()
    expect(readSafeModeHiddenTools(dir)).toEqual([])
  })
})

describe('safe-mode 工具隐藏（源 = computeVisibilitySources.safeMode）', () => {
  /**
   * 🔴 方案 C 后：六条 sync 合并成一次发射，**每源的判据仍要逐条钉**。
   * ⇒ 这里问纯函数 `computeVisibilitySources`（判据一条未动，只是不再需要替身宿主）。
   */
  function declareHidden(list: unknown): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ safeMode: { hiddenTools: list } }))
  }

  it('未声明 → 只隐藏基础表（bash），write/edit 保留', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    const deny = denyOf('safeMode', dir)
    expect(deny).toEqual(['bash'])
    expect(deny).not.toContain('write')
  })

  it('声明 hiddenTools → deny = 基础表 ∪ 声明（安全模式开启期间）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['workflow', 'job_kill'])
    expect(denyOf('safeMode', dir)).toEqual(['bash', 'job_kill', 'workflow'])
  })

  it('无安全模式标记 → 声明不生效（本源不贡献任何 deny）', () => {
    declareHidden(['workflow'])
    expect(denyOf('safeMode', dir)).toEqual([])
  })

  it('🔴 声明读坏 ≠ 安全模式失效：退化为只藏基础表（bash 不许丢）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    // 坏 JSON ⇒ readSafeModeHiddenTools 内部**fail-open 返回 []**（它自己不抛，见上一条 describe）
    // ⇒ 本源的 deny 退化成基础表；**这不是错误路径**，`error` 字段应当为空。
    // 🔴 如实记录：我最初在这里断言 `error` 非空（以为会抛），那是**把 fail-open 当成了抛错**。
    //    两者对上游的意义不同：抛错要告警，fail-open 是既定语义（"隐藏是危险方向，读不到就不多藏"）。
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), '{ bad json')
    const src = computeVisibilitySources('s-test', dir).find((x) => x.id === 'safeMode')!
    expect(src.ok).toBe(true)
    expect([...src.deny]).toEqual(['bash'])
    expect(src.error).toBeUndefined()
  })

  it('非法声明项（数字/空白）跳过，只留字符串', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden([42, null, '  ', 'workflow'])
    expect(denyOf('safeMode', dir)).toEqual(['bash', 'workflow'])
  })

  it('声明与基础表重名 ⇒ 去重', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['bash', 'workflow'])
    expect(denyOf('safeMode', dir)).toEqual(['bash', 'workflow'])
  })
})
describe('guards: im-bridge 条件可见（源 = computeVisibilitySources.imBridge，**轨迹级**）', () => {
  /**
   * 🔴🔴 **2026-10-23 owner 令：判据从「CCC 级」改为「轨迹级」**（D212）。
   *
   * 旧判据 = 本 CCC 有任一启用账号 ⇒ **全体可见**。owner 报的问题不是"少一个工具"，
   * 而是**一条错误的工作流**：每条轨迹都以为自己该直接对 owner 说话 ⇒ 发完就**停下来等人回**，
   * 而 owner 根本没空逐条回（原话见 `src/im/channels.ts` 的去标识改写）。
   *
   * ⇒ 新判据：**本会话所属轨迹出现在 IM 路由表（`routes[].trajectory`）里**才可见。
   *
   * ⚠️ **这组用例的前置条件变了，不是"放宽"**（D184：改判据必须能说出原前提被谁取代）：
   * 原来的 3 条只造了 `accounts`、**不造 `routes`、也不造轨迹绑定** ——
   * 那在旧判据下足以判可见，在新判据下则**必然不可见**（没有点名）。
   * ⇒ 每条用例现在都要显式造出"这条会话属于哪条轨迹"＋"路由表点了谁"，
   *    这样测的才是判据本身，而不是"夹具恰好空着"。
   */
  /** 造一条会话 → 轨迹的**持久绑定**（`trajectoryCodeForSession` 第二来源） */
  function bindSessionTo(sessionId: string, dirName: string): void {
    const trajDir = join(dir, 'AGENT_SESSIONS', dirName)
    mkdirSync(trajDir, { recursive: true })
    writeFileSync(
      join(trajDir, 'current.dsh_session_bind'),
      JSON.stringify({ sessionId, at: Date.now(), action: 'activate' }),
      'utf-8',
    )
  }

  /** 写 `weixin` 段（accounts ＋ routes 一起，夹具长成真形态） */
  function writeIm(accounts: unknown[], routes: unknown[]): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ weixin: { enabled: true, accounts, routes } }),
    )
  }

  const LIVE_ACCOUNT = [{ accountId: 'w1', channel: 'weixin', enabled: true }]

  it('没有可用账号 → deny im-bridge（工具不可见）', () => {
    expect(denyOf('imBridge', dir)).toEqual(['im-bridge'])
  })

  it('有账号但仍不隐藏的前提是**轨迹被路由点名**（连带验证"不看总开关"）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        weixin: {
          enabled: false, // 总开关关着也不影响可见性（owner 2026-10-22 令，保留）
          accounts: [{ accountId: 'f1', channel: 'feishu', enabled: true }],
          routes: [{ user: 'u-owner', trajectory: 'S999' }],
        },
      }),
    )
    bindSessionTo('s-test', '2026-01-01--S999--wired')
    expect(denyOf('imBridge', dir)).toEqual([])
  })

  it('账号被显式停用 → 视为没有可用账号 ⇒ 隐藏（即使轨迹被点名）', () => {
    writeIm([{ accountId: 'w1', channel: 'weixin', enabled: false }], [
      { user: 'u-owner', trajectory: 'S999' },
    ])
    bindSessionTo('s-test', '2026-01-01--S999--wired')
    expect(denyOf('imBridge', dir)).toEqual(['im-bridge'])
  })

  // ── 🆕 D212 的核心：**同样有账号，差别只在轨迹有没有被点名** ──
  it('🔴 有账号但这**条轨迹没被路由点名** ⇒ 隐藏（这就是 owner 要的那条边界）', () => {
    writeIm(LIVE_ACCOUNT, [{ user: 'u-owner', trajectory: 'S888' }]) // 点名的是**别人**
    bindSessionTo('s-test', '2026-01-01--S999--not-wired')
    expect(denyOf('imBridge', dir)).toEqual(['im-bridge'])
  })

  it('🔴 取不到轨迹归属（会话没绑定任何轨迹）⇒ 隐藏（fail-closed）', () => {
    writeIm(LIVE_ACCOUNT, [{ user: 'u-owner', trajectory: 'S999' }])
    // ⛔ 刻意不调 bindSessionTo：这就是"or"的另一侧
    expect(denyOf('imBridge', dir)).toEqual(['im-bridge'])
  })

  it('通配路由 `{user:"*"}` 也算点名（与 matchWeixinRoute 兜底同源）', () => {
    writeIm(LIVE_ACCOUNT, [{ user: '*', trajectory: 'S999' }])
    bindSessionTo('s-test', '2026-01-01--S999--wired')
    expect(denyOf('imBridge', dir)).toEqual([])
  })
})
describe('guards: 常驻拒绝表（源 = computeVisibilitySources.alwaysDeny，v1.106.0）', () => {
  // owner 2026-11-01 令：ask_user_question 是阻塞式提问，与「自动化 + 轨迹协作」冲突
  //   ⇒ 常驻隐藏，**与安全模式无关**。
  // 🔴 本组的主判据是**第二、三条**（安全模式开关都不改变本源的集合）——那是本机制区别于
  //    `safeMode.hiddenTools` 的**唯一那一维**。只测"藏了"会被 safeMode 的实现顺手满足（假绿）。

  it('CCC 内 ⇒ 恒贡献 deny ask_user_question', () => {
    expect(denyOf('alwaysDeny', dir)).toEqual(['ask_user_question'])
  })

  it('🔴 安全模式**关着**：safeMode 源为空，而 alwaysDeny 仍非空（解耦判据）', () => {
    const safeOn = join(dir, '.serenity-safe-on')
    if (existsSync(safeOn)) rmSync(safeOn)
    // 正控：关掉安全模式后 safeMode 源确实退化为空（证明下面那条非空不是"安全模式恰好开着"）
    expect(denyOf('safeMode', dir)).toEqual([])
    expect(denyOf('alwaysDeny', dir)).toEqual(['ask_user_question'])
  })

  it('🔴 安全模式**开着**也不会被并进 safeMode 那张表（两表分离判据）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'on')
    // 正控：安全模式开着时基础表生效
    expect(denyOf('safeMode', dir)).toContain('bash')
    // 🔴 主断言：ask_user_question **不得**出现在 safeMode 源 ——
    //    若它出现在那里，说明被错放进 SAFE_MODE_DENY_TOOLS，于是"与安全模式无关"就假了
    //    （D151：错放没有机械信号，只有这条断言能抓住它）
    expect(denyOf('safeMode', dir)).not.toContain('ask_user_question')
    expect(denyOf('alwaysDeny', dir)).toEqual(['ask_user_question'])
  })

  it('CCC 的 hiddenTools 声明改变不了本源的集合（本源不读配置）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'on')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    // 故意声明**别的**工具：本源的集合必须纹丝不动
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ safeMode: { hiddenTools: ['workflow'] } }),
    )
    expect(denyOf('alwaysDeny', dir)).toEqual(['ask_user_question'])
  })

  it('非 CCC（root=null）⇒ 本源缺席，且插件整体退让（不干预宿主工具）', () => {
    // 🔴 这是一条**边界判据**，不是"藏住了"的判据，别读反：
    //    非 CCC 时 `computeVisibilitySources` 在 ① 之后早返回，⑦ 根本不发射。
    //    而 ① 的 deny 是 `[...REGISTERED_TOOLS]`（ACC 自己的 14 个工具），
    //    **不含** `ask_user_question` —— 它是 DSH 宿主工具，不归 ACC 登记。
    // ⇒ 事实：**在 CCC 之外，本插件不干预 ask_user_question**（与"插件在非 CCC 时整体退让、
    //    只藏自己那批工具"一致）。owner 的令针对的是"宁静号里的阻塞式提问"，
    //    非 CCC 不是 ACC 的管辖面。若将来要在非 CCC 也拦，必须把 ⑦ 提到早返回**之前**，
    //    那时这条断言会变红 —— 这正是它存在的意义。
    const ids = computeVisibilitySources('s-test', null).map((x) => x.id)
    expect(ids).not.toContain('alwaysDeny')
    expect(denyOf('nonCcc', null)).not.toContain('ask_user_question')
    // 正控：插件确实退让了（藏的是自己的全表）
    expect(denyOf('nonCcc', null).length).toBeGreaterThan(0)
  })
})

// 🔴 v1.106.0（owner 2026-11-01 裁「exclusive 机制整体删」）：
//    「专属工具条件可见（源 = computeVisibilitySources.exclusive）」**整组删除**，不改为 skip。
//    判据消灭了（`EXCLUSIVE_TOOL_NAMES` 空表 ⇒ 恒回 []，任何测试都证伪不了它），
//    留着 skip 只会让下一个人以为"以后要补上"。原语义与删除理由见
//    `src/seams/guards.ts` 的 computeVisibilitySources ④ 处注释。
describe('guards: 非 CCC 会话的全工具面隐藏（源 = computeVisibilitySources.nonCcc）', () => {
  it('🔴 root=null ⇒ 该源的 deny = 全部 REGISTERED_TOOLS', () => {
    expect(denyOf('nonCcc', null)).toEqual([...REGISTERED_TOOLS].sort())
  })

  it('🔴 在 CCC 内 ⇒ 本源不贡献任何 deny（既有行为零改变）', () => {
    expect(denyOf('nonCcc', dir)).toEqual([])
  })

  it('🔴 非 CCC 时其余四源一律不贡献（没有 CCC 就没有配置可读）', () => {
    // v1.106.0：候选从五源降为四源（`exclusive` 已删）
    const sources = computeVisibilitySources('s-test', null)
    for (const id of ['safeMode', 'imBridge', 'hostSchedule', 'trajectoryConstraint']) {
      const s = sources.find((x) => x.id === id)!
      expect(s.ok, `${id} 在非 CCC 下应当 ok=false`).toBe(false)
      expect([...s.deny]).toEqual([])
    }
  })

  it('🔴 非 CCC 时 `alwaysDeny` **根本不发射**（早返回在第七源之前）—— 如实钉住而非假装藏住了', () => {
    // ⚠️ 别读反：这不是"藏住了"的判据，而是**边界判据**。
    //    §nonCcc 的 deny 只含 ACC 自己那批工具，`ask_user_question` 是宿主工具 ⇒ 不在内。
    //    ⇒ 事实：**CCC 之外本插件不干预 ask_user_question**（与"非 CCC 整体退让"一致）。
    //    若将来把第七源提到早返回之前，本断言会变红 —— 这正是它存在的意义。
    const ids = computeVisibilitySources('s-test', null).map((x) => x.id)
    expect(ids).not.toContain('alwaysDeny')
    expect(denyOf('nonCcc', null)).not.toContain('ask_user_question')
  })
})
describe('guards: CCC 治理文件保护（agent 不可写 .serenity/.serenity-safe-on）', () => {  it('写 .serenity-safe-on 被拒（无论安全模式）', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity-safe-on' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('governance file')
  })

  it('写 .serenity 被拒', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity' }))
    expect(d.kind).toBe('deny')
  })

  it('普通文件不受影响', () => {
    expect(decideGuard(base({ toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })
})

describe('guards: 轨迹约束 工具白名单（F4b ⑧）', () => {
  // 一条 轨迹约束轨迹的约束面（= 它目录里 trajectory-constraint.json 的解析结果）。
  // 旧模型这条角色写在 `.opencode/serenity.json` 的 `轨迹约束.roles.qa` 里、靠 sessionId 前缀认人；
  // 新模型约束面直接传给守卫（见 `profile()` 上方注释）。
  const QA = profile({
    dirName: '2026-10-19--qa--t',
    code: 'qa',
    msms: ['cognitive-qa'],
    tools: ['read', 'grep', 'glob'],
    systemPrompt: 'p',
  })

  it('白名单内工具 → allow（read/grep/glob）', () => {
    for (const tool of ['read', 'grep', 'glob']) {
      expect(decideGuard(base({ root: dir, toolName: tool, trajectoryConstraint: QA })).kind).toBe('allow')
    }
  })

  it('msms 非空 → msm 通道自动可用', () => {
    expect(decideGuard(base({ root: dir, toolName: 'msm', trajectoryConstraint: QA })).kind).toBe('allow')
  })

  it('白名单外工具 → deny（拒绝信息不泄漏白名单外工具名）', () => {
    for (const tool of ['write', 'edit', 'bash', 'web_search', 'container_fs']) {
      const d = decideGuard(base({ root: dir, toolName: tool, trajectoryConstraint: QA }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain('轨迹约束 trajectory')
      expect(d.deny).not.toContain(tool) // 不泄漏被拒工具名
      expect(d.deny).not.toContain('read') // 不泄漏白名单内容
    }
  })

  it('🔴 D181：tools/msms **字段缺省** ⇒ 不收窄（写文件≠要限制）', () => {
    // 🔴 语义于 2026-10-20 被 owner 裁定替换（**不是放宽，是前提变了**）：
    //    旧判据的前提是"写了 trajectory.json 就是要限制自己"，故当时把"白名单全空 ⇒ 保守 deny"
    //    钉成 fail-closed。owner 现在确立的原则是 **「这个 json 统一存放各类结构化设定」**
    //    ⇒ 写文件表达的是**任何一种设定**（常驻、章程指针、模型…），**不必然是限制**。
    //    再按旧判据办，会将"我只想声明常驻"读成"我要禁止一切" —— S196 实测被静默锁死（D179(b)）。
    //    ⇒ 判据改为按**字段在不在**区分，而不是按**数组空不空**区分（D181）。
    const noLists = profile({ dirName: '2026-10-19--res--t', code: 'res', tools: undefined, msms: undefined })
    expect(decideGuard(base({ root: dir, toolName: 'read', trajectoryConstraint: noLists })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'docs/a.md', trajectoryConstraint: noLists })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_admin', trajectoryConstraint: noLists })).kind).toBe('allow')
  })

  it('🔴 D181 反向钉：tools/msms **显式空数组** ⇒ 全隐藏（除恒可用的 skill）', () => {
    // 同一个"空"，两种意思。**显式 `[]` 是用户明说"我一个都不给"**，必须仍然生效 ——
    // 否则 D181 就把一条真正的限制能力一起削掉了。
    const explicitEmpty = profile({ dirName: '2026-10-19--empty--t', code: 'empty', tools: [], msms: [] })
    const d = decideGuard(base({ root: dir, toolName: 'read', trajectoryConstraint: explicitEmpty }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('轨迹约束 trajectory')
    // 对照：skill 恒可用（豁免在白名单判定之前，不受本次语义变更影响）
    expect(decideGuard(base({ root: dir, toolName: 'skill', trajectoryConstraint: explicitEmpty })).kind).toBe('allow')
  })

  it('非 轨迹约束会话（无约束面 / trajectoryConstraint=null）→ 不受白名单影响', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
    // 🔴 `null` 显式声明"这不是 轨迹约束"（新模型里普通会话的常态）——会话 id 已完全不参与判定
    expect(decideGuard(base({ root: dir, toolName: 'write', trajectoryConstraint: null, pathArg: 'docs/a.md' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'dashboard', trajectoryConstraint: null })).kind).toBe('allow')
  })

  // ── 第三个白名单：写**路径**（owner 2026-10-20 令「轨迹设定自己的写白名单」）────────────────
  //
  // 它补的是 `tools` 补不上的那一维：给了 `write` 之后，路径守卫只拦"逃出 CCC"与黑名单，
  // **拦不住它去写别人的轨迹或 docs/**。判据与 D181 同源：**字段在不在，不是数组空不空**。
  describe('writes 白名单（写路径维度）', () => {
    const OWN = 'AGENT_SESSIONS/2026-10-19--qa--t/'
    const withWrite = profile({
      tools: ['read', 'write', 'edit'],
      writes: [OWN],
    })

    it('目录内（含目录自身与其子路径）→ allow', () => {
      for (const p of [OWN, `${OWN}SESSION.md`, `${OWN}notes.md`, `${OWN}sub/x.md`]) {
        const d = decideGuard(base({ root: dir, toolName: 'write', pathArg: p, trajectoryConstraint: withWrite }))
        expect(d.kind, `${p} 应放行`).toBe('allow')
      }
    })

    it('目录外 → deny，且**指名允许的前缀与当前目标**（D186/D190：出声必须指对路）', () => {
      const d = decideGuard(base({
        root: dir, toolName: 'write', pathArg: 'AGENT_SESSIONS/2026-10-19--other--t/SESSION.md', trajectoryConstraint: withWrite,
      }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain(OWN)                                            // 允许什么
      expect(d.deny).toContain('AGENT_SESSIONS/2026-10-19--other--t/SESSION.md') // 目标是什么
      expect(d.deny).toContain('writes')                                       // 改哪个键
    })

    it('🔴 兄弟前缀陷阱：目录名只差一个后缀不算"在目录内"（边界按路径分隔符判）', () => {
      // 若按字符串 startsWith 判，`…--qa--t2/` 会命中 `…--qa--t`。
      const d = decideGuard(base({
        root: dir, toolName: 'write', pathArg: 'AGENT_SESSIONS/2026-10-19--qa--t2/SESSION.md', trajectoryConstraint: withWrite,
      }))
      expect(d.kind).toBe('deny')
    })

    it('**只约束写**：读同一目录外的文件照常 allow', () => {
      expect(decideGuard(base({
        root: dir, toolName: 'read', pathArg: 'docs/a.md', trajectoryConstraint: withWrite,
      })).kind).toBe('allow')
    })

    it('🔴 D181 反向钉：`writes: []` ⇒ 一个写都落不下（显式意图，不是"不收窄"）', () => {
      const none = profile({ tools: ['read', 'write', 'edit'], writes: [] })
      const d = decideGuard(base({ root: dir, toolName: 'write', pathArg: `${OWN}SESSION.md`, trajectoryConstraint: none }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain('empty array')
    })

    it('🔴 反向钉：`writes` **字段缺省** ⇒ 不收窄（与 D181 同一条判据）', () => {
      const unset = profile({ tools: ['read', 'write', 'edit'] })
      expect(decideGuard(base({
        root: dir, toolName: 'write', pathArg: 'docs/anything.md', trajectoryConstraint: unset,
      })).kind).toBe('allow')
    })

    it('绝对路径前缀同样可用（条目既可以是相对 CCC 根，也可以是绝对路径）', () => {
      const abs = profile({ tools: ['write'], writes: [join(dir, 'AGENT_SESSIONS/2026-10-19--qa--t')] })
      expect(decideGuard(base({
        root: dir, toolName: 'write', pathArg: `${OWN}x.md`, trajectoryConstraint: abs,
      })).kind).toBe('allow')
    })

    it('container_fs 的**写动作**受管、只读动作不受管', () => {
      // ⚠️ 夹具必须把 `container_fs` 放进 tools —— 否则命中的是**工具白名单**那条拒绝，
      //    而不是写路径这条 ⇒ 用例会"绿得不明所以"（判据打在错的那一维上）。
      const withFs = profile({ tools: ['read', 'container_fs'], writes: [OWN] })
      const deny = decideGuard(base({
        root: dir, toolName: 'container_fs', action: 'rm', pathArg: 'docs/a.md', trajectoryConstraint: withFs,
      }))
      expect(deny.kind).toBe('deny')
      expect(deny.deny).toContain('write scope') // 拒绝来自写路径这条，不是工具白名单
      const allow = decideGuard(base({
        root: dir, toolName: 'container_fs', action: 'list', pathArg: 'docs', trajectoryConstraint: withFs,
      }))
      expect(allow.kind).toBe('allow')
    })
  })

  it('约束面 tools 空（纯 MSM 轨迹）→ 仅 msm 可用', () => {
    const pure = profile({ dirName: '2026-10-19--pure--t', code: 'pure', msms: ['cognitive-qa'], tools: [] })
    expect(decideGuard(base({ root: dir, toolName: 'msm', trajectoryConstraint: pure })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'read', trajectoryConstraint: pure })).kind).toBe('deny')
  })

  it('skill 加载恒可用（不设白名单，v1.25.3）：白名单不含 skill 也 allow', () => {
    // 纯 MSM 约束面（tools 空）→ 其余工具全 deny，但 skill 恒 allow
    const pure = profile({ dirName: '2026-10-19--pure--t', code: 'pure', msms: ['cognitive-qa'], tools: [] })
    expect(decideGuard(base({ root: dir, toolName: 'skill', trajectoryConstraint: pure })).kind).toBe('allow')
    // 对照：非 轨迹约束会话（无约束面）+ skill 也放行（豁免在白名单判定之前）
    expect(decideGuard(base({ root: dir, toolName: 'skill', trajectoryConstraint: null })).kind).toBe('allow')
    // 非 skill 工具仍被白名单约束
    expect(decideGuard(base({ root: dir, toolName: 'read', trajectoryConstraint: pure })).kind).toBe('deny')
  })
})

describe('guards: 轨迹约束 工具白名单——真实形态（S142 微信 msm 全拒 bug 回归钉死）', () => {
  // 复刻一条真实 轨迹约束轨迹的约束（2026-09-07 磁盘态；v1.33 白名单里 logbook → trajectory，
  // v1.34 工具名硬切；现名 cognitive_trajectory）：
  // tools 含 msm/cognitive_trajectory + 19 msms——运行时实测全拒"tool not allowed in this 轨迹约束 role"
  // （该提示语已随 2026-10-19 重做改为 "...in this 轨迹约束 trajectory"）而 read/web_search 通。
  // 此测试钉死逻辑层：该约束面形态下 decideGuard 必须放行
  // msm/cognitive_trajectory/read/web_search（若此测试红 = 守卫逻辑 bug；绿 = 逻辑正确，差异在运行时层）。
  //
  // 🔴 载体与身份的对应（重做前后）：旧 = `.opencode/serenity.json` 的 `轨迹约束.roles['my-role']`；
  // 新 = 该轨迹目录下的 `trajectory-constraint.json`（`path` 指它），身份由**角色名**换成**轨迹编码**。
  // ⚠️ 编码用通用占位 `my-role`（**不用真实角色名**）：本仓公开面受 `privacy-scan` 的
  // `role-name-*` 规则约束（D145）——夹具要**能公开**，所以它描述形态、不搬运具体称呼。
  // 白名单内容（tools / msms / systemPromptFile）逐字照搬旧配置——那才是本组要钉的东西。
  const ZC_MSMS = [
    'anysearch', 'web-search', 'memory-tool', 'mail-tool', 'vlm-describe',
    'eap-analyzer', 'qbit', 'session-log-tool', 'movie-search', 'home-diag',
    'bill-analyzer', 'mortgage-rate-compare', 'sheet-parser', 'pdf-extract',
    'archive-extract', 'profile-tool', 'weixin-send', 'autopilot-todo', 'subscription-tool',
  ]
  const ZC = profile({
    dirName: '2026-10-19--my-role--weixin',
    code: 'my-role',
    model: 'provider-a/model-x',
    msms: ZC_MSMS,
    tools: ['read', 'grep', 'glob', 'web_search', 'cognitive_trajectory', 'msm'],
    cognitiveTrajectory: { session: true, keeper: false, rebuild: true },
    systemPromptFile: '.opencode/skiff/my-role.md',
  })

  it('真实形态：白名单内工具全放行（read/web_search/cognitive_trajectory/msm）', () => {
    for (const tool of ['read', 'grep', 'glob', 'web_search', 'cognitive_trajectory', 'msm']) {
      expect(decideGuard(base({ root: dir, toolName: tool, trajectoryConstraint: ZC })).kind, `tool ${tool} 应 allow`).toBe('allow')
    }
  })

  it('真实形态：白名单外工具 deny（write/bash 等）', () => {
    for (const tool of ['write', 'edit', 'bash', 'container_fs', 'container_git', 'container_admin', 'dashboard', 'praxis']) {
      const d = decideGuard(base({ root: dir, toolName: tool, trajectoryConstraint: ZC }))
      expect(d.kind, `tool ${tool} 应 deny`).toBe('deny')
      expect(d.deny).toContain('轨迹约束 trajectory')
    }
  })

  it('msms 非空 → msm 工具本身放行（profileToolWhitelist msm 通道）', () => {
    // 关键回归：即使 tools 不含 msm，msms 非空也必须放行 msm（profileToolWhitelist 自动加 msm）
    const zcReadOnly = profile({
      dirName: '2026-10-19--my-role--weixin2',
      code: 'my-role',
      msms: ZC_MSMS,
      tools: ['read'],
    })
    expect(decideGuard(base({ root: dir, toolName: 'msm', trajectoryConstraint: zcReadOnly })).kind).toBe('allow')
  })

  it('v1.30.2 回归：模型把 MSM 名当直接工具调 → 明确指引经 msm()（非泛化"未授权"）', () => {
    // 用户 bug（S142）：该轨迹调 memory-tool 等得到 "tool not allowed in this 轨迹约束 role" →
    // 误导成"没权限"。根因 = 把 MSM 名当直接工具调用。修复 = deny 消息给出 msm() 通道指引。
    for (const msmName of ZC_MSMS) {
      const d = decideGuard(base({ root: dir, toolName: msmName, trajectoryConstraint: ZC }))
      expect(d.kind, `直接调 ${msmName} 应 deny`).toBe('deny')
      // 明确说这是 MSM + 给调用法（可行动规避指引），不说泛化的"not allowed in this 轨迹约束 trajectory"
      expect(d.deny, `deny 消息应含 ${msmName} 与 msm() 指引`).toContain(msmName)
      expect(d.deny).toContain('msm("')
      expect(d.deny).toContain('not a direct tool')
      expect(d.deny).not.toContain('not allowed in this 轨迹约束 trajectory')
    }
  })

  it('v1.30.2：白名单外真工具（write/bash 等）仍保守泛化 deny（不泄漏）', () => {
    for (const tool of ['write', 'bash', 'container_fs', 'acc_msm', 'cc_fs', 'session_rebuild']) {
      const d = decideGuard(base({ root: dir, toolName: tool, trajectoryConstraint: ZC }))
      expect(d.kind, `工具 ${tool} 应 deny`).toBe('deny')
      expect(d.deny).toContain('not allowed in this 轨迹约束 trajectory')
      expect(d.deny).not.toContain(tool) // 不泄漏被拒工具名
    }
  })
})

describe('guards: MSM 注册表写保护（需求⑤b——写 deny 读 allow，防 CCC 意外写坏搞崩自己）', () => {
  // dir 的 .serenity=test → cccName=test → 聚合档 .opencode/skills/test/references/mech-registry.json
  const aggRel = '.opencode/skills/test/references/mech-registry.json'

  it('write/edit 直写 cccName 聚合档 → deny（ACC-managed）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: aggRel })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'edit', pathArg: aggRel })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'touch', pathArg: aggRel })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'mv', pathArg: aggRel })).kind).toBe('deny')
  })

  it('root 级 mech-registry.json 写 → allow（review P1：废弃形态不再保护——永不被读的文件保护=死锁，可删可迁移）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'mech-registry.json' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: 'mech-registry.json' })).kind).toBe('allow')
  })

  it('聚合档 references/ 祖先目录写 → deny（review P2-2：rm -r references/ 会绕过文件级保护删掉注册表）', () => {
    // references/ 目录本身
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test/references/' })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'mv', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
    // 共享父目录不误伤（.opencode/skills 属所有 skill——删它不属于本 CCC 专属保护）
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode' })).kind).toBe('allow')
  })

  it('读工具读注册表 → allow（注册表需被读——output-guard/trajectory-constraint-admin 建 MSM 词表；读 deny 只用于凭据）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'read', pathArg: aggRel })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'info', pathArg: aggRel })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'grep', pathArg: aggRel })).kind).toBe('allow')
  })

  it('非 cccName skill 目录的 mech-registry.json（历史分散残留）→ 不再保护（单级化后废弃，允许删除迁移）', () => {
    const legacy = '.opencode/skills/home-media/references/mech-registry.json'
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: legacy })).kind).toBe('allow')
  })

  it('其他普通文件写 → 不受注册表保护影响（allow）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('references/ 内非注册表兄弟文档写 → allow（review P1-1：只保护注册表文件与 references/ 目录节点本身，不误伤并置知识文档）', () => {
    // home-serenity 实测：msm-writing-standards.md 等 8 个知识文档与 mech-registry.json 并置——必须可正常维护
    const sibling = '.opencode/skills/test/references/msm-writing-standards.md'
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'edit', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'touch', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: sibling })).kind).toBe('allow')
    // 子树深层（references/sub/x.md）同样放行——只目录节点本身受保护
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: '.opencode/skills/test/references/sub/x.md' })).kind).toBe('allow')
  })

  it('references/ 目录节点本身 rm -r/mv → deny（review P1-1 收窄后仍防删目录绕过）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'mv', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
  })

  it('cccName 非 test 的 CCC（.serenity=other）→ 只保护自己的聚合档，test 聚合档对其不保护', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'guards-other-'))
    try {
      writeFileSync(join(otherDir, '.serenity'), 'other')
      // other 的聚合档被保护
      expect(decideGuard(base({ root: otherDir, toolName: 'write', pathArg: '.opencode/skills/other/references/mech-registry.json' })).kind).toBe('deny')
      // test 的聚合档对 other CCC 不特殊保护（root 级除外）
      expect(decideGuard(base({ root: otherDir, toolName: 'write', pathArg: aggRel })).kind).toBe('allow')
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

describe('guards: CCC 内屏蔽宿主自带定时器工具（源 = computeVisibilitySources.hostSchedule）', () => {
  it('CCC 内 ⇒ deny 全部 4 个 schedule_* 名字', () => {
    expect(denyOf('hostSchedule', dir)).toEqual([
      'schedule_create',
      'schedule_delete',
      'schedule_list',
      'schedule_update',
    ])
  })

  it('🔴 合并发射**不做预探活**：4 个名字原样进入 deny（在册与否交给宿主回答）', () => {
    // 🔴 D184 判据变更记录：原用例名「合并发射时逐个探活：不在册的名字被剔掉」，且注里写着
    //     "方案 C 顺带修掉了旧坑"。**那句是假的** —— v1.87.1 复盘：预探活本身是缺陷来源
    //     （`tools.get` 省略 scope = 全局视图，`schedule_*` 是 agent-plane 贡献 ⇒ 恒 undefined），
    //     删掉之后退档只保留 `REGISTERED_TOOLS`，而 schedule_* **不属** ACC ⇒ 真被拒时这一格**不生效**。
    //     ⇒ 改钉**源层**契约：源如实给出 4 个名字，剔不剔是发射层的事、由宿主裁决。
    //     ⚠️ 「宿主没装该包 ⇒ 这格不生效」是**已知缺口**，登记在用例尾注，不假装已修。
    expect(denyOf('hostSchedule', dir)).toEqual([
      'schedule_create',
      'schedule_delete',
      'schedule_list',
      'schedule_update',
    ])
  })
})
