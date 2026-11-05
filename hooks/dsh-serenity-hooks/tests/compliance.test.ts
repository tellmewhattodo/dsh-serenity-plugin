import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * compliance.test.ts — DSH plugin 开发标准合规门禁（docs/plugin-development-standard.md）
 *
 * 机械验证 B/E/F 关键项：
 *   B1  package.json 声明 dsh.bundle.patch
 *   B2  插件自带 cordis.patch.yml 存在且含 insert 行
 *   B3  patch 行 name 用包名
 *   E4  prepare script 存在
 *   F1  files 含 lib/ + cordis.patch.yml
 *   F2  peerDependencies 含 cordis + @deepseek-ai/dsh-tools
 *   F4  tsdown.prepare.config.ts 存在
 */
const __filename = fileURLToPath(import.meta.url)
// tests/ 位于 hooks/dsh-serenity-hooks/tests/，上一级即插件根
const HOOKS_DIR = resolve(dirname(__filename), '..')

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
}

describe('DSH plugin 合规门禁（v1.15）', () => {
  const pkgPath = join(HOOKS_DIR, 'package.json')
  const pkg = readJson(pkgPath)

  it('B1: package.json 声明 dsh.bundle.patch', () => {
    const dsh = pkg.dsh as { bundle?: { patch?: string } } | undefined
    expect(dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('B2: 插件自带 cordis.patch.yml 存在且含 insert 行', () => {
    const patchPath = join(HOOKS_DIR, 'cordis.patch.yml')
    expect(existsSync(patchPath)).toBe(true)
    const content = readFileSync(patchPath, 'utf-8')
    expect(content).toContain('- insert:')
    expect(content).toContain('id: serenity-hooks')
  })

  it('B3: patch 行 name 用包名', () => {
    const content = readFileSync(join(HOOKS_DIR, 'cordis.patch.yml'), 'utf-8')
    expect(content).toContain(`name: '${pkg.name}'`)
  })

  it('E4: prepare script 存在且指向 prepare 配置', () => {
    const scripts = pkg.scripts as Record<string, string>
    expect(scripts.prepare).toContain('tsdown.prepare.config.ts')
    expect(existsSync(join(HOOKS_DIR, 'tsdown.prepare.config.ts'))).toBe(true)
    expect(existsSync(join(HOOKS_DIR, 'tsconfig.prepare.json'))).toBe(true)
  })

  it('F1: files 含 lib/ 与 cordis.patch.yml', () => {
    const files = pkg.files as string[]
    expect(files.some((f) => f.startsWith('lib'))).toBe(true)
    expect(files).toContain('cordis.patch.yml')
  })

  it('F2: peerDependencies 含 cordis 与 @deepseek-ai/dsh-tools', () => {
    const peers = pkg.peerDependencies as Record<string, string>
    expect(peers.cordis).toBeTruthy()
    expect(peers['@deepseek-ai/dsh-tools']).toBeTruthy()
  })

  it('F3: scripts 含 build/test/typecheck/prepare', () => {
    const scripts = pkg.scripts as Record<string, string>
    for (const s of ['build', 'test', 'typecheck', 'prepare']) {
      expect(scripts[s]).toBeTruthy()
    }
  })

  it('E4 端到端: prepare 消费端构建可独立产出完整双 bundle（lib/index.js + invariant.js + client.js）', () => {
    // 回归门禁：v1.16.0/1.16.1 的 prepare 只构建 Node 半（clean:true 清掉 client.js），
    // 导致 npm publish 的 tarball 缺 lib/client.js → DSH web 激活抛 MissingClientBundleError。
    // prepare 必须复用完整双 bundle 配置（tsdown.config.ts）。
    //
    // 🔴🔴 **2026-10-17：本用例改为构建到【临时 outDir】，不再 `rmSync` 仓库的 `lib/`**
    //    —— 原因是它**污染了同一进程里别的测试的读数面**（实测的稳定假红）：
    //      · `privacy-scan.test.ts` 的 A 面判据读的是 `npm pack` 扫出来的**真实 `lib/`**；
    //      · `vitest` 在 `coverage` 下用**并行 worker**跑各测试文件；
    //      · 本用例原先 `rmSync(lib/)` 再 tsdown 重建 ⇒ 两者并发时，`privacy-scan`
    //        读到**重建中的残缺树**（实测 27 / 36 个文件，真值 139）
    //        ⇒ 报成"发布面为空"⇒ **一条与代码无关、每次数值还不同的假红**。
    //    ⇒ 判据（本仓通用）：**凡会改写「别人正在读的共享目录」的测试，必须写到私有 outDir**。
    //      `--out-dir` 只影响产物落点，**不动** `tsdown.config.ts` 的语义
    //      （F5 另有用例钉"prepare 配置 = 完整双 bundle"，那条读的是**配置文件**，不受本改动影响）。
    const staging = resolve(process.env.HOME ?? '', '.dsh', 'source', 'current')
    const tsdownBin = join(staging, 'node_modules', '.bin', 'tsdown')
    if (!existsSync(tsdownBin)) return // 无 staging checkout（如 CI）→ 自跳过，对齐 G1
    const outDir = join(HOOKS_DIR, '.tmp-e4-out')
    rmSync(outDir, { recursive: true, force: true })
    try {
      // 🔴 `--config-loader unrun` 不是可选装饰，是 **Node 24 下让本构建能跑**的必要条件
      //    （2026-11-05 实测：本机 Node 22.22.1 → 24.22.2 之后本用例由绿转红）。
      //    机制：Node 24 起 `process.features.typescript === 'strip'`（22 是 `false`），
      //    tsdown 据此**改用原生类型剥离**加载配置文件；而原生剥离**不做 `.js` → `.ts` 后缀改写**，
      //    于是 `tsdown.prepare.config.ts` 里的 `export { default } from './tsdown.config.js'`
      //    会去找**不存在的** `tsdown.config.js`（真身是 `.ts`）⇒ 报
      //    「Failed to load the config file … Cannot find module …/tsdown.config.js」。
      //    ⛔ 别把这个 flag 当冗余删掉：删了在 Node 22 上照样绿（差分正控），只在 Node 24 上红。
      //    同一原因，`package.json` 的 `prepare` 脚本也带同一 flag（那条会打断 npm publish）。
      //    备选且更彻底的修法 = 把配置里的 `'./tsdown.config.js'` 改成无扩展名或 `.ts`，
      //    但那会动到 F5 的断言与 dev 构建共用面，收益不足以抵消风险。
      execFileSync(tsdownBin, ['-c', 'tsdown.prepare.config.ts', '--config-loader', 'unrun', '--out-dir', '.tmp-e4-out'], {
        cwd: HOOKS_DIR,
        encoding: 'utf-8',
      })
      expect(existsSync(join(outDir, 'index.js'))).toBe(true)
      expect(existsSync(join(outDir, 'invariant.js'))).toBe(true)
      expect(existsSync(join(outDir, 'client.js'))).toBe(true)
    } finally {
      // 清理私有产物（无论成败），不在仓里留垃圾
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('F5: prepare 配置复用完整双 bundle（单一真相源，防 Node-only 漂移）', () => {
    const prepare = readFileSync(join(HOOKS_DIR, 'tsdown.prepare.config.ts'), 'utf-8')
    expect(prepare).toMatch(/export\s*\{\s*default\s*\}\s*from\s*'\.\/tsdown\.config\.js'/)
    expect(prepare).not.toMatch(/entry:\s*\{\s*index/)
  })

  it('F6: peerDependencies 的 schemastery 范围在 npm 可满足（^3.18.4）', () => {
    // v1.16.0/1.16.1 曾声明 ^0.1.0-rc.5 → npm 无匹配版本（该包仅 3.18.x 系列，
    // harness 依赖 ^3.18.x）→ dsh plugin add 报 ERR_PNPM_NO_MATCHING_VERSION
    // v1.31.6（0.1.5-rc.1 适配）：宿主依赖升 ^3.18.2 → 本处同步（下界跟宿主走，避免解析到宿主未验证的旧版）
    // v1.47（0.1.7-rc.1 适配）：宿主升 ~3.18.4 → 下界同步 ^3.18.4
    const peers = pkg.peerDependencies as Record<string, string>
    expect(peers['@deepseek-ai/schemastery']).toBe('^3.18.4')
  })

  it('F6b: peerDependencies 的 cordis 双映射各自**可解析**（v1.31.10 修正：上游 cordis 无 4.0.2）', () => {
    // 双实例（`cordis` + `@deepseek-ai/cordis`）都必须能被 npm 解析——否则 hooks 安装直接失败，
    // 而失败点在 vitest 之前 → 测试整步 skipped、阻塞门静默失效（CI run #31 实证，SESSION §17）。
    // v1.31.6 曾把两者都写成 `^4.0.4`，但那对**上游 bare `cordis`** 不可满足：
    //   · 上游 cordis 最高只到 4.0.0-rc.10（实测 registry.npmjs.org/cordis/4.0.2 → 404）
    //   · 宿主 profile 实际提供的 bare `cordis` 是 dsh 注入的私有 shim，版本 4.0.0-rc.7
    //   · 43 个 DSH 0.1.5-rc.1 宿主包 peer 的都是 `@deepseek-ai/cordis`，**没有**任何宿主包 peer bare cordis
    // 故两者本就不必同串：`@deepseek-ai/cordis` 跟宿主保持一致（^4.0.4）；bare `cordis` 用
    // 既可解析、又覆盖运行时 shim 的 rc 线（^4.0.0-rc.7）。Context 声明合并由 tsconfig 的
    // 双映射（两条 paths 指向同一个 @deepseek-ai/cordis 实体）保证，真实实例用例见
    // tests/host/cordis-access.test.ts。
    const peers = pkg.peerDependencies as Record<string, string>
    expect(peers['@deepseek-ai/cordis']).toBe('^4.0.4')
    expect(peers['cordis']).toMatch(/^\^4\.0\.0-rc\.\d+$/)
  })

  it('F6c: peerDependencies 的 dsh-* 全部同一版本范围（硬切后不得混版）', () => {
    const peers = pkg.peerDependencies as Record<string, string>
    const dshPeers = Object.entries(peers).filter(([n]) => n.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(10)
    // 🔴 0.2.0-rc.1 适配轮：dsh-* 从单档 `^0.1.7-rc.1` 改为**双档联合范围**。
    //   依据（实测，非推断）：宿主门 `evaluatePluginCompatibility` 的判据是真
    //   `semver.satisfies(runtime, range, { includePrerelease: true })` ⇒ **支持 `||`**；
    //   而单档 `^0.1.7-rc.1` 在 `0.2.0-rc.1` 上被**整包拒绝 ＋ 回滚**、单档 `^0.2.0-rc.1`
    //   又会把本机在跑的 `0.1.7-rc.2` 堵死 ⇒ 双档是唯一两全写法。
    //   ⚠️ 本处**刻意保留字面量**（不 import `contract.ts` 的常量）：本文件的职责是查**发布物形状**，
    //   与源码常量同串的一致性由 `tests/host-contract.test.ts` 的跨文件对账用例负责。
    //
    // 🆕 **v1.59.3（0.2.1-rc.1 适配）**：加第三档 `^0.2.1-rc.1`。
    //   为什么必须加（实测依据）：npm 的 `^0.2.0-rc.1` 对**预发布**只放行**同一
    //   `major.minor.patch`** 的 prerelease ⇒ **`0.2.1-rc.1` 不满足它** ⇒ 宿主门拒装
    //   （D98 同族：上一轮就是它导致整包拒绝安装并回滚）。
    //   逐字字面量在此同步；跨文件一致性仍由 host-contract.test.ts 负责。
    for (const [name, range] of dshPeers) {
      expect(range, `${name} 与 peer 范围不一致`).toBe('^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1')
    }
  })
})

/**
 * F7 — 宿主类型基准（v1.31.11 §7-8）：两份 tsconfig 的 `paths` 必须**仓库内可解析**。
 *
 * 为什么必须机械化（R↓）：这条基准此前是**机器耦合**的（硬编码 `~/.npm-global/…/dsh` 与
 * `~/.dsh/source/current`）→ CI 上 tsconfig 全不命中，tsc 静默回落 node_modules → 实测 94 条错误，
 * 而 CI 的两个 typecheck 步是 `continue-on-error`，于是**没人发现它早已不是门禁**。
 * 本组用例把新纪律变成机械事实：
 *   a) 不许任何机器路径残留（`.npm-global` / `.dsh/source`）
 *   b) 每条 paths 值的包名必须在 devDependencies 里（**缺一条 = tsc 静默回落 = 假绿/假红**）
 *   c) `cordis` 与 `@deepseek-ai/cordis` 必须指向同一实体（宿主 `Context` 声明合并的前提）
 *   d) devDependencies 的宿主包版本 == peer 范围的基准版本（改一处忘另一处 → 当场红）
 */
describe('宿主类型基准（F7，v1.31.11 §7-8）', () => {
  const pkg = readJson(join(HOOKS_DIR, 'package.json'))
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
  const peers = (pkg.peerDependencies ?? {}) as Record<string, string>

  /** 两份 tsconfig 都是 JSONC（含整行 `//` 注释）——按行剥注释后解析 */
  function readJsonc(p: string): { compilerOptions: { paths?: Record<string, string[]> } } {
    const stripped = readFileSync(p, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    return JSON.parse(stripped) as { compilerOptions: { paths?: Record<string, string[]> } }
  }

  const halves = [
    { label: 'node', file: join(HOOKS_DIR, 'tsconfig.json') },
    { label: 'client', file: join(HOOKS_DIR, 'client', 'tsconfig.json') },
  ]

  it('F7a: 没有任何机器耦合路径残留（.npm-global / DSH 源码检出）', () => {
    for (const half of halves) {
      const paths = readJsonc(half.file).compilerOptions.paths ?? {}
      expect(Object.keys(paths).length).toBeGreaterThan(5)
      for (const [key, targets] of Object.entries(paths)) {
        for (const t of targets) {
          expect(t, `${half.label} 半 ${key} 仍指向本机安装`).not.toContain('.npm-global')
          expect(t, `${half.label} 半 ${key} 仍指向 DSH 源码检出`).not.toContain('.dsh/source')
        }
      }
    }
  })

  it('F7b: 每条 paths 值的包名都在 devDependencies 里（否则 tsc 静默回落）', () => {
    for (const half of halves) {
      const paths = readJsonc(half.file).compilerOptions.paths ?? {}
      for (const [key, targets] of Object.entries(paths)) {
        for (const t of targets) {
          const m = /node_modules\/(@[^/]+\/[^/]+)/.exec(t)
          expect(m, `${half.label} 半 ${key} 的值不是仓库内 node_modules 形态: ${t}`).toBeTruthy()
          const pkgName = m![1]!
          expect(devDeps[pkgName], `${pkgName} 缺少 devDependency（${half.label} 半 ${key}）`).toBeTruthy()
        }
      }
    }
  })

  it('F7c: cordis 双映射指向同一实体（Context 声明合并的前提）', () => {
    for (const half of halves) {
      const paths = readJsonc(half.file).compilerOptions.paths ?? {}
      expect(paths['cordis'], `${half.label} 半缺 cordis 映射`).toBeTruthy()
      expect(paths['cordis'], `${half.label} 半 cordis 双映射不同实体`).toEqual(paths['@deepseek-ai/cordis'])
    }
  })

  it('F7d: devDependencies 的宿主包版本 == peer 范围的**最低档**基准版本', () => {
    const hostDevDeps = Object.entries(devDeps).filter(([n]) => n.startsWith('@deepseek-ai/dsh-'))
    expect(hostDevDeps.length).toBeGreaterThan(20)
    // 关系式断言（不锁字面量）：peer 写 `^0.1.5-rc.1` → devDep 必须精确 `0.1.5-rc.1`。
    // 🔴 0.2.0-rc.1 适配轮：peer 成了**联合范围**（`^0.1.7-rc.1 || ^0.2.0-rc.1`）⇒ 取
    //   **第一个候选项**（= 最低档）作基准 —— 因为本仓的 `paths` 类型基准就是**最低档那一版**
    //   （`node_modules/` 里装的就是它）；**高档由 `dsh-develop typecheck-host <ver>` 单独验**
    //   （`host-fetch` 把该版宿主包解到 `_tmp/` 再跑 tsc）。两处职责不同：
    //   把 devDependencies 一起抬 ⇒ 本地 node_modules 换版 ＋ 锁文件重算，而收益是零。
    //   ⚠️ 不取 `||` 之后那段：`'^0.1.7-rc.1 || ^0.2.0-rc.1'.replace(/^\^/,'')` 会得到
    //     `0.1.7-rc.1 || ^0.2.0-rc.1` 这类**永不相等的垃圾**（与 contract.ts 本轮修掉的那个 bug 同源）。
    const peerBase = (peers['@deepseek-ai/dsh-tools'] ?? '').split('||')[0]!.trim().replace(/^\^/, '')
    expect(peerBase).toBeTruthy()
    for (const [name, range] of hostDevDeps) {
      expect(range, `${name} 的 devDep 版本与 peer 基准版本不一致`).toBe(peerBase)
    }
  })
})
