import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { verifyToolConsistency, assertManifestProse, REGISTERED_TOOLS, CONDITIONAL_TOOL_COUNT } from '../src/kernel/invariant.js'

describe('invariant: 清单与注册工具一致性', () => {
  it('一致时零问题（清单与 REGISTERED_TOOLS 同集合 ⇒ 两侧不得有一处手写）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    // 🔴 **夹具从 REGISTERED_TOOLS 派生，⛔ 不手写名单**：
    //    2026-11-06 实测 —— 这条夹具原先把 12 个名字写死，加 `reconstruct` 后它**红得对**，
    //    但它红的原因是"夹具过期"而不是"实现错了"。手写名单会随每次工具面变更变成噪音，
    //    而噪音会训练人"这条红了大概是夹具问题" ⇒ 真正的不一致反而被放过去。
    writeFileSync(
      manifest,
      JSON.stringify({ id: 'x', contributes: { tools: [...REGISTERED_TOOLS] } }),
    )
    expect(verifyToolConsistency(manifest, REGISTERED_TOOLS)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('REGISTERED_TOOLS：常驻段在前、条件段在后（数量由两个常量对账，⛔ 不写死总数）', () => {
    // 🔴 只钉**结构不变量**（常驻/条件两段的划分），不钉总数：
    //    总数每加一个工具就要改一次数字，而那个数字**不承载任何判据**（真正的判据是
    //    "与清单同集合"，由上面那条用例守）。写死它 ⇒ 每次加工具都制造一条必然过期的断言。
    //
    // 🔴 **2026-11-09 自纠（v1.128.0 加 browser_slot 时这条自己红了）**：
    //    原文写着"⛔ 不写死总数"，而下一行就是 `toBe(10)` —— **它违反了它自己写下的判据**。
    //    这是本仓反复付代价的那种形态：判据是对的，**生成它的那一行没照做**。
    //    ⇒ 改成钉**结构**：常驻段（前 n-CONDITIONAL 项）一个条件工具都不许有；
    //      条件段（末 CONDITIONAL 项）必须恰好是那三个。加工具时**不需要改本用例**。
    const cond = (REGISTERED_TOOLS as readonly string[]).slice(-CONDITIONAL_TOOL_COUNT)
    const pinned = (REGISTERED_TOOLS as readonly string[]).slice(0, REGISTERED_TOOLS.length - CONDITIONAL_TOOL_COUNT)
    expect(CONDITIONAL_TOOL_COUNT).toBe(3)
    // 条件段 ⊆ 已知的条件工具集合；且常驻段与条件段不相交（顺序错了会在这里红）
    const CONDITIONAL = ['im-bridge', 'diagram', 'reconstruct']
    for (const n of cond) expect(CONDITIONAL).toContain(n)
    for (const n of pinned) expect(CONDITIONAL).not.toContain(n)
    expect(REGISTERED_TOOLS).toContain('container_fs')
    expect(REGISTERED_TOOLS).toContain('container_admin')
    expect(REGISTERED_TOOLS).toContain('cognitive_trajectory')
    expect(REGISTERED_TOOLS).toContain('msm')
    expect(REGISTERED_TOOLS).toContain('praxis')
    expect(REGISTERED_TOOLS).toContain('dashboard')
    expect(REGISTERED_TOOLS).toContain('localstore')
    expect(REGISTERED_TOOLS).toContain('im-bridge')
    expect(REGISTERED_TOOLS).toContain('serenity-skill-creator')
    // v1.128.0：browser_slot 必须在**常驻段**（它的价值恰在"使用者没想到的时候"，
    // 条件出现等于不存在）
    expect(pinned).toContain('browser_slot')
    // v1.121.0：reconstruct 必须在**条件段**（末 CONDITIONAL_TOOL_COUNT 项）
    expect(cond).toContain('reconstruct')
  })

  it('真实清单与 REGISTERED_TOOLS 一致（防双侧陈旧再次静默通过）', () => {
    // 用测试文件自身位置定位清单（不依赖 cwd——根/包两级 vitest 配置下都成立）
    const manifestPath = fileURLToPath(new URL('../dsh.plugin.json', import.meta.url))
    expect(verifyToolConsistency(manifestPath, REGISTERED_TOOLS)).toEqual([])
  })

  it('声明了未注册的工具 → 报告', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(manifest, JSON.stringify({ id: 'x', contributes: { tools: ['container_fs', 'ghost'] } }))
    const issues = verifyToolConsistency(manifest, REGISTERED_TOOLS)
    expect(issues.some((i) => i.includes('ghost'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('清单缺失 → 报告', () => {
    expect(verifyToolConsistency('/nonexistent/dsh.plugin.json', REGISTERED_TOOLS).length).toBeGreaterThan(0)
  })
})

describe('invariant: 声明面散文被钉住（v1.56.2）', () => {
  /** 造一份"正确的"最小声明面：清单 ＋ package.json ＋ 两份 README */
  function makeCorrectSurfaces(tools: readonly string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'prose-'))
    const pkgDir = join(dir, 'pkg')
    mkdirSync(pkgDir)
    const manifest = join(pkgDir, 'dsh.plugin.json')
    const pkgJson = join(pkgDir, 'package.json')
    // fixture 里两份 README 的位置不必与真实层级一致（判据只用传进来的路径）
    const readmeA = join(dir, 'README.md')
    const readmeB = join(pkgDir, 'README.md')
    const list = tools.join('/')
    const n = tools.length
    // 🔴 负控要造的是「错」，所以文案里的名字与中文标题都必须**按 n 推**，不能写死。
    //    2026-11-01 v1.106.0 实证：写死「另三个 im-bridge/acc-diag/diagram」与「十二个工具」
    //    在 acc-diag 删除后**恰好变成正确值** ⇒ 负控假绿（它报不出错，因为根本没有错）。
    const condNames = (REGISTERED_TOOLS as readonly string[]).slice(-CONDITIONAL_TOOL_COUNT).join('/')
    const condCn = ['零', '一', '两', '三', '四', '五'][CONDITIONAL_TOOL_COUNT]!
    writeFileSync(
      manifest,
      JSON.stringify({
        id: 'x',
        description: `工作区：${n} 个工具（${list}；另${condCn}个 ${condNames} 按配置条件出现）`,
        contributes: { tools: [...tools] },
      }),
    )
    writeFileSync(pkgJson, JSON.stringify({ description: `工作区：${n} 个工具（${list}）` }))
    // 标题里的中文数随工具数走（2026-10-28：cheap-worker 下线后 14→13，写死即假绿）
    const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    const countCn = n <= 10 ? cn[n] : n < 20 ? `十${cn[n - 10]}` : `二十${n === 20 ? '' : cn[n - 20]}`
    const heading = `### 3.1 ${countCn}个工具（其中${condCn}个按条件出现）\n\n| 工具 |\n|---|\n`
    writeFileSync(readmeA, `## 3\n\n${heading}`)
    writeFileSync(readmeB, `## 3\n\n${heading}`)
    return { dir, manifest, readmeA, readmeB }
  }

  const REAL_MANIFEST = fileURLToPath(new URL('../dsh.plugin.json', import.meta.url))
  // tests/ → 包根 → hooks/ → 仓根（三跳；写错由主判据当场报）
  const REAL_READMES = [
    fileURLToPath(new URL('../../../README.md', import.meta.url)),
    fileURLToPath(new URL('../README.md', import.meta.url)),
  ]

  it('真实声明面：三处散文全绿（这是本钉子的主判据）', () => {
    expect(assertManifestProse(REAL_MANIFEST, REAL_READMES)).toEqual([])
  })

  it('正控（假 fixture）：一份形态正确的声明面必须零问题 ⇒ 钉子不瞎', () => {
    const f = makeCorrectSurfaces(REGISTERED_TOOLS)
    expect(assertManifestProse(f.manifest, [f.readmeA, f.readmeB])).toEqual([])
    rmSync(f.dir, { recursive: true, force: true })
  })

  it('负控 ①「数错」：description 少一个工具名 ⇒ 必须报（这是 v1.54.0 的真实形态）', () => {
    const f = makeCorrectSurfaces(REGISTERED_TOOLS)
    const list = REGISTERED_TOOLS.filter((t) => t !== 'serenity-skill-creator').join('/')
    writeFileSync(
      f.manifest,
      JSON.stringify({
        id: 'x',
        description: `工作区：${REGISTERED_TOOLS.length} 个工具（${list}）`, // 数字对、名单缺一项
        contributes: { tools: [...REGISTERED_TOOLS] },
      }),
    )
    const issues = assertManifestProse(f.manifest, [f.readmeA, f.readmeB])
    expect(issues.some((i) => i.includes('serenity-skill-creator'))).toBe(true)
    rmSync(f.dir, { recursive: true, force: true })
  })

  it('负控 ②「总数错」：description 少报一个 ⇒ 必须报（错值按当前工具数推，⛔ 不写死）', () => {
    const f = makeCorrectSurfaces(REGISTERED_TOOLS)
    const list = REGISTERED_TOOLS.join('/')
    const wrong = REGISTERED_TOOLS.length - 1
    writeFileSync(
      f.manifest,
      JSON.stringify({
        id: 'x',
        description: `工作区：${wrong} 个工具（${list}）`,
        contributes: { tools: [...REGISTERED_TOOLS] },
      }),
    )
    const issues = assertManifestProse(f.manifest, [f.readmeA, f.readmeB])
    expect(issues.some((i) => i.includes(`${REGISTERED_TOOLS.length} 个工具`))).toBe(true)
    rmSync(f.dir, { recursive: true, force: true })
  })

  it('负控 ③「标题没跟上」：README §3.1 的中文数少一个 ⇒ 必须报（错值按当前工具数推）', () => {
    const f = makeCorrectSurfaces(REGISTERED_TOOLS)
    // 正确的标题由 makeCorrectSurfaces 生成；这里用**另一个**中文数（少一个）覆盖它
    const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    const n = REGISTERED_TOOLS.length
    const toCn = (k: number): string => (k <= 10 ? cn[k]! : k < 20 ? `十${cn[k - 10]!}` : `二十${cn[k - 20] ?? ''}`)
    const wrongHeading = toCn(n - 1)
    expect(wrongHeading).not.toBe(toCn(n)) // 正控：确实是"错值"，否则本用例没测到东西
    writeFileSync(f.readmeB, `## 3\n\n### 3.1 ${wrongHeading}个工具（其中两个按条件出现）\n`)
    const issues = assertManifestProse(f.manifest, [f.readmeA, f.readmeB])
    expect(issues.some((i) => i.includes(wrongHeading))).toBe(true)
    rmSync(f.dir, { recursive: true, force: true })
  })

  it('负控 ④ 清单与 REGISTERED_TOOLS 不同长 ⇒ 必须报', () => {
    const f = makeCorrectSurfaces(REGISTERED_TOOLS)
    const short = REGISTERED_TOOLS.slice(0, 3)
    writeFileSync(
      f.manifest,
      JSON.stringify({ id: 'x', description: `3 个工具（${short.join('/')}）`, contributes: { tools: [...short] } }),
    )
    const issues = assertManifestProse(f.manifest, [f.readmeA, f.readmeB])
    expect(issues.some((i) => i.includes('同长'))).toBe(true)
    rmSync(f.dir, { recursive: true, force: true })
  })
})
