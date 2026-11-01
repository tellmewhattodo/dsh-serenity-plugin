import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { verifyToolConsistency, assertManifestProse, REGISTERED_TOOLS, CONDITIONAL_TOOL_COUNT } from '../src/kernel/invariant.js'

describe('invariant: 清单与注册工具一致性', () => {
  it('一致时零问题（13 工具，与 dsh.plugin.json contributes.tools 一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const manifest = join(dir, 'dsh.plugin.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        id: 'x',
        contributes: {
          tools: ['container_fs', 'cognitive_trajectory', 'dashboard', 'container_git', 'msm', 'praxis', 'localstore', 'container_admin', 'im-bridge', 'diagram', 'ontology', 'serenity-skill-creator'],
        },
      }),
    )
    expect(verifyToolConsistency(manifest, REGISTERED_TOOLS)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('REGISTERED_TOOLS 含 12 工具（v1.30 命名重构 + v1.31.0 im-bridge + v1.51 diagram + v1.52 ontology + v1.54 serenity-skill-creator；2026-10-28 下线 cheap-worker ⇒ 14→13；v1.106.0 acc-diag 并入 dashboard diag ⇒ 13→12）', () => {
    expect(REGISTERED_TOOLS).toHaveLength(12)
    expect(REGISTERED_TOOLS).toContain('container_fs')
    expect(REGISTERED_TOOLS).toContain('container_admin')
    expect(REGISTERED_TOOLS).toContain('cognitive_trajectory')
    expect(REGISTERED_TOOLS).toContain('msm')
    expect(REGISTERED_TOOLS).toContain('praxis')
    expect(REGISTERED_TOOLS).toContain('dashboard')
    expect(REGISTERED_TOOLS).toContain('localstore')
    expect(REGISTERED_TOOLS).toContain('cognitive_trajectory')
    // v1.31.1：v1.31.0 漏改此处与清单（双侧同错 → 陈旧一致静默通过），本次补齐
    expect(REGISTERED_TOOLS).toContain('im-bridge')
    expect(REGISTERED_TOOLS).toContain('serenity-skill-creator')
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
