import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runKit, KIT_ACTIONS } from '../src/tools/kit/service.js'
// C5（2026-09-15）：`checkRegistryHealth` 迁入 container-status（唯一取数出口；实现逐字未变）
import { checkRegistryHealth } from '../src/surface/observation.js'
import { runGit } from '../src/tools/git/service.js'
import { runMsm, findEntry } from '../src/tools/msm/service.js'

let dir: string

/**
 * MSM `exec` 直跑 `.ts` 脚本需要 **TS 运行时**：有 bun 则直跑；无 bun 时 ACC 回落到
 * `npx tsx`——而该脚本位于**临时 CCC 目录**（`mkdtemp`），那里没有本地 tsx，npx 只能
 * **联网拉取**。CI runner 无 bun 且网络/registry 抖动 → 偶发 exit 1（实证：CI run #22
 * `ops.test.ts:166 expected 1 to be +0`，同代码在 run #25 通过）。
 * 故本用例只断言"注册表扫描"（与运行时无关），执行断言仅在 bun 在场时进行——
 * 机器耦合是可移植性缺陷，参照 `scripts/dsh-develop.test.ts` 的 hasBun 先例。
 */
const HAS_BUN = ((): boolean => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ops-'))
  // 需求⑤a：注册表单级化——cccName = t → 聚合档 .opencode/skills/t/references/mech-registry.json
  writeFileSync(join(dir, '.serenity'), 't')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('kit-ops', () => {
  it('health 输出三原则（对齐 osp schema）', async () => {
    const h = (await runKit(dir, { action: 'health' })) as {
      status: string
      principles: { P1_rooted: { pass: boolean }; P2_git_managed: { pass: boolean }; P3_binary_permissions: { pass: boolean } }
    }
    expect(h.status).toBe('degraded') // 无 .git → degraded
    expect(h.principles.P1_rooted.pass).toBe(true)
    expect(h.principles.P2_git_managed.pass).toBe(false) // 无 .git
    expect(h.principles.P3_binary_permissions.pass).toBe(false) // 无配置
  })

  it('CCC 缺失时返回 degraded（不抛错）', async () => {
    const h = (await runKit(null, { action: 'health' })) as { status: string; root: string | null }
    expect(h.status).toBe('degraded')
    expect(h.root).toBeNull()
  })

  it('time 输出 {now_iso, now_local, epoch_ms}', async () => {
    const t = (await runKit(dir, { action: 'time' })) as { now_iso: string; now_local: string; epoch_ms: number }
    expect(new Date(t.now_iso).toString()).not.toBe('Invalid Date')
    expect(typeof t.epoch_ms).toBe('number')
  })

  it('wait 需正整数秒数（对齐 osp；缺省 1）', async () => {
    // 0 秒拒绝（osp spec：positive int）
    await expect(runKit(dir, { action: 'wait', seconds: 0 })).rejects.toThrow(/positive integer/)
    // 负秒数拒绝
    await expect(runKit(dir, { action: 'wait', seconds: -1 })).rejects.toThrow(/positive integer/)
  })

  // 🔴 v1.106.0：`diag` 动作（原独立工具 acc-diag 并入）。
  //    这一组钉的是**接线**，不是诊断内容本身（内容见 `diag.test.ts`）——
  //    两个失败面必须分开测：① 动作声明了但分支没接 ⇒ 落到 default 抛 "Unknown action"
  //    ② 没有 ctx 却静默返回空报告（"零 live 会话"与"读不了"同形，D233）
  it('🔴 diag 已接线：不落到 default 的 "Unknown action"（KIT_ACTIONS 与 switch 同真源）', async () => {
    const out = (await runKit(dir, { action: 'diag' }, {})) as string
    expect(typeof out).toBe('string')
    expect(out).toContain('ACC 运行态诊断')
    expect(out).not.toContain('Unknown action')
  })

  it('🔴 diag 缺 ctx ⇒ 响亮失败，⛔ 不返回空报告（"读不了"不得冒充"没有"）', async () => {
    await expect(runKit(dir, { action: 'diag' })).rejects.toThrow(/plugin context/i)
  })

  it('KIT_ACTIONS 含 diag 且与 switch 分支一致（防"声明了但没接"）', () => {
    expect(KIT_ACTIONS).toContain('diag')
  })

  it('wait 1 秒耗时 ≥ 约 1 秒', async () => {
    const started = Date.now()
    const w = await runKit(dir, { action: 'wait', seconds: 1 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(w).toBe('waited 1s') // 对齐 osp 文本输出
  })
})

describe('git-ops', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'hi')
  })

  it('commit + status + log（对齐 osp 文本/JSON 输出）', () => {
    const c = runGit(dir, { action: 'commit', message: 'init' }) as string
    expect(c).toContain('master')
    const s = runGit(dir, { action: 'status' }) as { clean: boolean; files: { status: string; file: string }[]; summary: string }
    expect(s.clean).toBe(true)
    expect(Array.isArray(s.files)).toBe(true)
    const l = runGit(dir, { action: 'log' }) as string
    expect(l).toContain('init')
  })

  it('commit 缺消息抛错', () => {
    expect(() => runGit(dir, { action: 'commit' })).toThrow(/message/)
  })

  it('pull：无远程配置报错；diff：无差异返回 (no diff)', () => {
    expect(() => runGit(dir, { action: 'pull' })).toThrow(/no remote configured/)
    expect(runGit(dir, { action: 'diff' })).toBe('(no diff)')
  })

  it('push 拒绝（non-fast-forward）→ [REJECTED] 不误报成功（v1.18.8 回归）', () => {
    // 远程 bare repo
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote], { cwd: dir })
    // 工作树 A：commit + push 到远程
    const workA = join(dir, 'workA')
    mkdirSync(workA, { recursive: true })
    for (const w of [workA]) {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: w })
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: w })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: w })
    }
    writeFileSync(join(workA, 'f.txt'), 'a')
    execFileSync('git', ['add', '-A'], { cwd: workA })
    execFileSync('git', ['commit', '-m', 'a'], { cwd: workA })
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: workA })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: workA })
    // 工作树 B：clone 远程（落后）
    const workB = join(dir, 'workB')
    execFileSync('git', ['clone', '-q', remote, workB], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: workB })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: workB })
    // B 检出 main（bare HEAD 未指向 main → clone 后 detached，需显式 checkout）
    execFileSync('git', ['checkout', '-b', 'main', 'origin/main'], { cwd: workB })
    // A 再推新 commit（远程领先）
    writeFileSync(join(workA, 'f.txt'), 'a2')
    execFileSync('git', ['add', '-A'], { cwd: workA })
    execFileSync('git', ['commit', '-m', 'a2'], { cwd: workA })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workA })
    // B 落后：新 commit 后 push → non-fast-forward 拒绝（v1.18.8 前误报 "Pushed to"）
    writeFileSync(join(workB, 'g.txt'), 'b')
    execFileSync('git', ['add', '-A'], { cwd: workB })
    execFileSync('git', ['commit', '-m', 'b'], { cwd: workB })
    const r = runGit(workB, { action: 'push' }) as string
    expect(r).toContain('[REJECTED]')
    expect(r).not.toContain('Pushed to')
  })

  it('localstore git 联动：deny 且未 gitignore → commit 拒绝 + status warning', () => {
    // 模拟：localstore.json 已存在，但 .gitignore 未覆盖（用户手删了行）
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')

    const s = runGit(dir, { action: 'status' }) as { warning?: string }
    expect(s.warning).toContain('localstore.json')

    expect(() => runGit(dir, { action: 'commit', message: 'x' })).toThrow(/localstore\.json/)
  })

  it('localstore git 联动：deny + gitignore 覆盖 → 放行 commit', () => {
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    writeFileSync(join(dir, '.gitignore'), 'localstore.json\n')
    const c = runGit(dir, { action: 'commit', message: 'init' }) as string
    expect(c).toContain('master')
  })

  it('localstore git 联动：allow 配置 → 放行（即使未 gitignore）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const c = runGit(dir, { action: 'commit', message: 'init' }) as string
    expect(c).toContain('master')
  })
})

describe('msm-ops', () => {
  it('注册表扫描 + exec 执行脚本', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'hello.ts'), 'console.log("hi");\n')
    const refs = join(dir, '.opencode', 'skills', 't', 'references')
    mkdirSync(refs, { recursive: true })
    writeFileSync(
      join(refs, 'mech-registry.json'),
      JSON.stringify({ version: 1, entries: [{ name: 'hello', path: '.opencode/skills/t/scripts/hello.ts', skill: 't', category: 'mech' }] }),
    )
    expect(findEntry(dir, 'hello')).not.toBeNull()
    // 执行断言仅在 TS 运行时在场时进行（无 bun → npx 需联网，机器耦合；见 HAS_BUN 说明）
    if (!HAS_BUN) return
    const r = runMsm(dir, { action: 'exec', name: 'hello', args: [] }) as { exit: number; stdout: string }
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('hi')
  })

  it('exec 未注册抛错', () => {
    expect(() => runMsm(dir, { action: 'exec', name: 'nope' })).toThrow(/not registered/)
  })

  it('register 写注册表 + check 报告 M1', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'tool.ts'), 'console.log("x");\n')
    const r = runMsm(dir, {
      action: 'register',
      name: 'tool',
      skill: 't',
      path: '.opencode/skills/t/scripts/tool.ts',
      category: 'mech',
      description: '测试',
    }) as { registered: string }
    expect(r.registered).toBe('tool')
    // 🔴 D237：`check` 的**工具返回面**已改压缩形态（按 check+detail 分组）。
    //    逐条 `issues` 仍在，只是形状从「行数组」变成「组数组 + names」——
    //    这是渲染层压缩，判据内容（谁因什么被报）一个字没丢。
    const check = runMsm(dir, { action: 'check' }) as {
      issueCount: number
      groups: { check: string; detail: string; count: number; names: string[] }[]
    }
    expect(check.groups.some((g) => g.check === 'M1' && g.names.includes('tool'))).toBe(true)
  })
})

describe('kit-ops: 注册表完整性检查（需求⑤c——dashboard health registry 段）', () => {
  function writeRegistryFile(rel: string, content: unknown): void {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  const aggRel = '.opencode/skills/t/references/mech-registry.json'

  it('无注册表文件（空 CCC）→ ok:true present:false（未注册非坏）', () => {
    const h = checkRegistryHealth(dir)
    expect(h.present).toBe(false)
    expect(h.ok).toBe(true)
  })

  it('合法 v1 wrapper → ok', () => {
    mkdirSync(join(dir, '.opencode', 'skills', 't', 'scripts'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 't', 'scripts', 'a.ts'), 'console.log(1)\n')
    writeRegistryFile(aggRel, {
      version: 1,
      entries: [{ name: 'a', path: '.opencode/skills/t/scripts/a.ts', skill: 't', category: 'mech', description: 'd', usage: 'u', flags: [] }],
    })
    const h = checkRegistryHealth(dir)
    expect(h.present).toBe(true)
    expect(h.ok).toBe(true)
    expect(h.issues).toEqual([])
  })

  it('坏 JSON → ok:false + git 恢复指引（不抛错——health 不能因坏表崩）', () => {
    writeRegistryFile(aggRel, '{broken')
    const h = checkRegistryHealth(dir)
    expect(h.present).toBe(true)
    expect(h.ok).toBe(false)
    expect(h.issues[0]).toContain('JSON is broken')
    expect(h.issues.join('\n')).toContain('git checkout --')
  })

  it('顶层非 wrapper/数组 → ok:false（结构损坏）', () => {
    writeRegistryFile(aggRel, { foo: 1 })
    const h = checkRegistryHealth(dir)
    expect(h.ok).toBe(false)
    expect(h.issues[0]).toContain('neither an array nor a v1 wrapper')
  })

  it('重复 name → issue（loadMsmEntries 去重歧义）', () => {
    writeRegistryFile(aggRel, { version: 1, entries: [{ name: 'dup', path: 'x.ts' }, { name: 'dup', path: 'y.ts' }] })
    const h = checkRegistryHealth(dir)
    expect(h.ok).toBe(false)
    expect(h.issues.some((i) => i.includes('duplicate MSM name'))).toBe(true)
  })

  it('path 根外 / 脚本不存在 → issue（引用完整）', () => {
    writeRegistryFile(aggRel, { version: 1, entries: [
      { name: 'out', path: '../escape.ts' },
      { name: 'missing', path: '.opencode/skills/t/scripts/ghost.ts' },
    ] })
    const h = checkRegistryHealth(dir)
    expect(h.ok).toBe(false)
    expect(h.issues.some((i) => i.includes('escapes CCC root'))).toBe(true)
    expect(h.issues.some((i) => i.includes('script not found'))).toBe(true)
  })

  it('cccName 缺失（无 .serenity）→ path:null（不抛错）', () => {
    const bare = mkdtempSync(join(tmpdir(), 'hooks-ops-bare-'))
    try {
      const h = checkRegistryHealth(bare)
      expect(h.path).toBeNull()
      expect(h.ok).toBe(true)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
