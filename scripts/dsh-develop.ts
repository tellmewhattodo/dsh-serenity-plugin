#!/usr/bin/env bun
/**
 * dsh-develop.ts — dsh-serenity-plugin 开发操作 MSM（Mech，纯确定性）
 *
 * safe-mode 下 bash 被禁，但构建/测试/git/部署仍需执行。
 * 本 MSM 是注册的机械工具（acc_msm exec 走 bun 直跑），封装常用开发操作的白名单通道。
 *
 * 子命令:
 *   dsh-develop typecheck             tsc --noEmit（hooks 目录）
 *   dsh-develop typecheck-cli         🔴 已退役（恒 exit 2）：对象 = 仓库根包 src/，2026-09-28 随安装器族删除
 *   dsh-develop test [--filter <p>]   vitest run（hooks 目录）
 *   dsh-develop build                 tsc + tsdown 双 bundle（产物 lib/）
 *   dsh-develop status                插件仓库 git status + 版本
 *   dsh-develop commit <message>      git add -A + commit（插件仓库）
 *   dsh-develop push                  git push origin（GitHub 公开仓库，SSH-over-443）
 *   dsh-develop deploy                load-plugin.sh 全流程（构建+双锚+shim+profile+预检）
 *   dsh-develop version               package.json / dsh.plugin.json / CHANGELOG 版本
 *   dsh-develop bump <version>        同步 package.json + dsh.plugin.json 版本
 *
 * 退出码: 0 成功 / 1 用户错误 / 2 系统错误
 *
 * 边界（安全语义）: 本 MSM 只执行固定的开发操作集，不接受任意命令执行。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, cpSync, copyFileSync, symlinkSync, statSync, lstatSync, readlinkSync, createReadStream } from 'node:fs'
import { resolve, dirname, join, basename, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync, execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const __filename = fileURLToPath(import.meta.url)
const SCRIPTS_DIR = dirname(__filename)
const REPO_ROOT = resolve(SCRIPTS_DIR, '..')
const HOOKS_DIR = join(REPO_ROOT, 'hooks', 'dsh-serenity-hooks')

const HOME_DIR = process.env.HOME ?? ''

const GIT_SSH = process.env.GIT_SSH_COMMAND
  ?? `ssh -F /dev/null -i ${process.env.SERENITY_GITLAB_KEY ?? join(HOME_DIR, '.ssh', 'id_ed25519_gitlab')} -o IdentitiesOnly=yes`
// GitHub 走 SSH-over-443（ssh.github.com:443）：家庭网络常封 22 端口
const GIT_SSH_GITHUB = process.env.GIT_SSH_COMMAND_GITHUB
  ?? `ssh -F /dev/null -i ${process.env.SERENITY_GITHUB_KEY ?? join(HOME_DIR, '.ssh', 'id_rsa_github')} -o IdentitiesOnly=yes -o HostName=ssh.github.com -o Port=443 -o StrictHostKeyChecking=accept-new`

/**
 * `pnpm` 的可执行路径 —— **解析成绝对路径，不用裸名**（2026-11-09 实测）。
 *
 * 🔴 **症状与成因**：`dsh-develop publish` 报「锁文件与 package.json 不一致 → 先跑 lockfile」，
 * 而紧接着 `dsh-develop lockfile` 又只印一行 `pnpm install --lockfile-only` 就失败。
 * 真相是 **`spawnSync('pnpm')` 拿到 `ENOENT`** —— 宿主进程的 `PATH` 里**没有 pnpm**
 * （本机 pnpm 装在 `~/.local/bin/bin/pnpm`，而 `PATH` 只含 `~/.local/bin` 本级）。
 * ⇒ **不是锁文件的问题，是解释器找不到**（D252 同族：读数器坏了 ≠ 被测对象坏了）。
 *
 * 口径与 `run-trajectory-test` 的 bun 一致：`SERENITY_PNPM` 可覆盖，否则按常见落点探测，
 * 都没有才退回裸名（让 `run()` 如实抛 ENOENT，而不是静默走一条看似相关的失败路径）。
 */
const PNPM = ((): string => {
  const override = process.env.SERENITY_PNPM
  if (override !== undefined && override !== '') return override
  for (const candidate of [
    process.env.PNPM_HOME ? join(process.env.PNPM_HOME, 'pnpm') : '',
    join(HOME_DIR, '.local', 'bin', 'bin', 'pnpm'),
    join(HOME_DIR, '.local', 'share', 'pnpm', 'pnpm'),
  ]) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return 'pnpm'
})()

// ── 工具 ──

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: opts.quiet ? 'pipe' : 'inherit',
    timeout: 600_000,
  })
  return { status: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
}

/**
 * JSONC 解析（tsconfig.json 是 JSONC——带 `//` 行注释）。
 * 只剥行注释，且**跳过字符串内部**（本仓库 tsconfig 的路径含 `//`? 不含，但注释剥离必须对字符串安全）。
 */
function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  // 容忍结尾多余逗号（JSONC 常见）
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>
}

function currentVersion(): { pkg: string; plugin: string; changelog: string | null } {
  const pkg = readJson(join(HOOKS_DIR, 'package.json'))
  const plugin = readJson(join(HOOKS_DIR, 'dsh.plugin.json'))
  const changelogPath = join(REPO_ROOT, 'CHANGELOG.md')
  let changelog: string | null = null
  if (existsSync(changelogPath)) {
    const m = readFileSync(changelogPath, 'utf-8').match(/^## v([\d.]+)/m)
    changelog = m ? m[1] : null
  }
  return { pkg: String(pkg.version ?? ''), plugin: String(plugin.version ?? ''), changelog }
}

function fail(msg: string, code = 1): never {
  console.error(`[dsh-develop] ${msg}`)
  process.exit(code)
}

// ── 子命令 ──

function cmdTypecheck(): void {
  if (!existsSync(join(HOOKS_DIR, 'tsconfig.json'))) fail(`hooks 目录缺失: ${HOOKS_DIR}`, 2)
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const r = run(tscBin, ['-p', 'tsconfig.json', '--noEmit'], { cwd: HOOKS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`typecheck 失败 (exit ${r.status})`, 2)
  }
  // client half（独立 tsconfig，包含浏览器 bundle 源码）
  const clientR = run(tscBin, ['-p', 'client/tsconfig.json'], { cwd: HOOKS_DIR, quiet: true })
  if (clientR.status !== 0) {
    console.error(clientR.stdout + clientR.stderr)
    fail(`client typecheck 失败 (exit ${clientR.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ typecheck 通过（node + client）`)
}

/**
 * cmdTypecheckCli — 🔴 **已退役（恒 exit 2）**：**对象已不存在**。
 *
 * 对象 = **仓库根包 `@shgroup/dsh-serenity-plugin`**（安装器 CLI ＋ init 向导 ＋ 技能模板）
 * ＋ 它的 tsconfig（`include: ["src"]`）。那一族与其测试已于 **2026-09-28** 整体删除
 * （S142 ③ 周边整合；owner 早前令「连模板和安装命令一起删」，`b6a964b`/`fd5352f` 逐字留着
 * 「安装命令面……与相关测试【尚未删】——留给下一单元」，**本轮就是那个单元**）。
 *
 * 🆕 为什么**删而不留**（R↓）：它当年存在的理由是「根包 `src/` 不在任何门禁范围内」（2026-09-21 补），
 * 而**`src/` 本身没了** ⇒ 门禁跟着没有对象。留一个 stub 只会在门禁清单里制造
 * 「看起来还有这一关」的假象（同族：判据 43「退役必须留『旧形态不再出现』的钉」——
 * 钉在 `scripts/dsh-develop.test.ts`，本函数只负责给人一句路牌）。
 *
 * 判据 43 的两条钉：① **旧形态不再出现** = 本命令恒 exit 2（不再是"跑一下看看"的绿门）
 * ② **旧配置静默忽略的正向钉** = 仓库根 `tsconfig.json` 已删，`typecheck`（hooks 双面）**照常全绿**。
 */
function cmdTypecheckCli(): void {
  console.log('[dsh-develop typecheck-cli] 🔴 本命令已退役（对象已不存在）\n'
    + '  · 对象 = 仓库根包 `@shgroup/dsh-serenity-plugin`（安装器 CLI ／ init 向导 ／ 技能模板）'
    + ' ＋ 根 tsconfig（include: src）\n'
    + '  · 该族与其 9 个测试已于 2026-09-28 整体删除（S142 ③ 周边整合；owner 令「连模板和安装命令一起删」）\n'
    + '  ⇒ 真产物 = `hooks/dsh-serenity-hooks`，它的类型门禁 = **`typecheck`（node + client 双面）**\n'
    + '  ⇒ 若你要找的是"脚本自己有没有类型错误"：见 `typecheck-scripts`（A26-c）')
  process.exit(2)
}

/**
 * cmdTypecheckScripts — `scripts/` 下**开发工具**的类型检查（**A26-c 的探针／门禁**）。
 *
 * 为什么存在（R↓，2026-09-28 实测缺口）：`scripts/` 由 **bun 直接跑**（只转译、**不检查**），
 * 且它**不在任何 tsconfig 的 `include` 里** ⇒ `dsh-develop.ts`（123 KB）的改动
 * **没有任何机械判据**（`typecheck` 只管 `hooks/` 双面；`typecheck-cli` 随安装器族退役 ⇒ 恒 exit 2）。
 *
 * 两条设计约束：
 *  ① 🔴 **不落盘任何配置** —— `/scripts/` 被 `.gitignore` 排除（本仓的开发工具目录，A12）；
 *     往里加 `tsconfig.json` 会**加深"被忽略 ∧ 已跟踪"的灰区** ⇒ 参数**全部走 CLI**。
 *  ② **默认 `--strict`**，且报错时**逐条打印**（不吞）：本目录**从未被检查过**，首跑的意义是
 *     **量出存量**，不是假装一直绿。若存量太大 ⇒ 那是**要给 owner 看的数**（A26-c 的判据），
 *     而不是把它悄悄降级成宽松档。
 *
 * 用法: `dsh-develop typecheck-scripts [--no-strict]`
 */
function cmdTypecheckScripts(strict: boolean): void {
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  if (!existsSync(tscBin)) fail(`找不到 tsc: ${tscBin}（先 pnpm install）`, 2)
  const files = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SCRIPTS_DIR, f))
    .sort()
  if (files.length === 0) fail(`scripts/ 下没有 .ts（SCRIPTS_DIR=${SCRIPTS_DIR}）`, 2)
  const args = [
    '--noEmit',
    '--target', 'ES2022',
    '--module', 'ESNext',
    '--moduleResolution', 'Bundler',
    '--esModuleInterop',
    '--skipLibCheck',
    '--types', 'node',
    ...(strict ? ['--strict'] : []),
    ...files,
  ]
  const r = run(tscBin, args, { cwd: SCRIPTS_DIR, quiet: true })
  const out = `${r.stdout}${r.stderr}`.trim()
  if (r.status !== 0) {
    if (out) console.error(out)
    const errs = out.split('\n').filter((l) => /error TS\d+/.test(l)).length
    fail(`typecheck-scripts 失败（exit ${r.status}；${errs} 条 error TS；strict=${strict}）——`
      + `未见"全绿"不等于"没坏"，见上方逐条`, 2)
  }
  console.log(`[dsh-develop] ✓ typecheck-scripts 通过（${files.length} 个 .ts；strict=${strict}）`)
}

function cmdTest(filter?: string): void {
  if (!existsSync(join(HOOKS_DIR, 'tests'))) {
    fail(`hooks 测试目录缺失`, 2)
  }
  const args = ['run']
  if (filter) args.push(filter)
  // cwd = 仓库根（vitest.config.ts include 覆盖 hooks/**/tests/ + scripts/；根 tests/ 已随安装器族退场）
  const r = run(join(REPO_ROOT, 'node_modules', '.bin', 'vitest'), args, { cwd: REPO_ROOT, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`vitest 失败 (exit ${r.status})`, 2)
  }
  // 汇总行
  const m = r.stdout.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/)
  console.log(m ? `[dsh-develop] ✓ 测试通过 (${m[1]} files / ${m[2]} tests)` : '[dsh-develop] ✓ 测试通过')
}

/** coverage：vitest --coverage（v1.28.0 可测试可验证——coverage 阈值门禁见 hooks vitest.config.ts）。
 *  从 HOOKS_DIR 运行：coverage-v8 装在 hooks 自身 node_modules（根 node_modules 无），
 *  且 hooks/vitest.config.ts 定义 coverage 范围 = hooks src。
 *
 *  🔴 2026-10-17（S142 续 181，owner 令「只输出不通过的」）：
 *  此前**不 quiet** ⇒ `r.stdout` 收下全部 vitest 输出（含每个 describe 的 stdout/stderr
 *  捕获块），实测单次回执 **≈160 KB**，把真正要看的两行（汇总 + 阈值）埋在中间。
 *  ⇒ 改为 `quiet: true` **只留摘要**；失败时才把**筛选过的**失败行打出来。
 *  ⚠️ **不是"少报"**：判据仍是 exit code（唯一权威）；这里只是把"全绿时的噪音"去掉，
 *  失败时反而比原先**更聚焦**（只印 FAIL 段，不再夹着几千行 stderr 捕获）。 */
function cmdCoverage(): void {
  if (!existsSync(join(HOOKS_DIR, 'tests'))) {
    fail(`hooks 测试目录缺失`, 2)
  }
  const r = run(join(HOOKS_DIR, 'node_modules', '.bin', 'vitest'), ['run', '--coverage'], { cwd: HOOKS_DIR, quiet: true })
  const combined = `${r.stdout}\n${r.stderr}`

  if (r.status !== 0) {
    // 只印"不通过"的那些行。
    // 🔴 为什么不能只靠 `quiet`：vitest 把**每个用例的 stdout/stderr 捕获**直接写进
    //   真实 stderr 流（不是 stdout），`quiet` 只挡 stdout ⇒ 实测仍会灌进几千行
    //   `[serenity-hooks] ✗ …` 噪声，把 FAIL 段埋掉。
    // ⇒ 用**白名单**（只留 FAIL 块与断言差异），而不是黑名单（永远漏一种噪声）。
    const lines = combined.split('\n')
    const kept: string[] = []
    let inFailBlock = false
    for (const line of lines) {
      // FAIL 段起点：` FAIL <file>` / ` ❯ <file> (n tests | m failed)`
      //               或覆盖率门禁标题
      if (/^\s*(FAIL\s|❯\s.*\|\s*\d+\s+failed|.*Failed Tests.*|.*ERROR:\s*Coverage)/.test(line)) {
        inFailBlock = true
      }
      // 失败块结束：下一条顶层进度行（✓ 文件 / Test Files 汇总）之后不再收
      if (/^\s*(✓|Test Files|Tests)\s/.test(line) && inFailBlock) {
        // 汇总行本身有用 → 留；但退出失败块
        if (/^\s*(Test Files|Tests)\s/.test(line)) kept.push(line)
        inFailBlock = false
        continue
      }
      if (!inFailBlock) continue
      // 块内继续过滤：拖尾的插件告警不属于失败证据
      if (/^\s*\[serenity-hooks\]/.test(line)) continue
      if (/^\s*\[dsh-develop\]/.test(line)) continue
      kept.push(line)
    }
    const MAX = 120
    const shown = kept.slice(0, MAX)
    if (shown.length > 0) console.error(shown.join('\n').trimEnd())
    if (kept.length > MAX) console.error(`… 另有 ${kept.length - MAX} 行失败输出已省略（看 hooks/dsh-serenity-hooks/coverage/ 或重跑单文件）`)
    fail(`vitest --coverage 失败 (exit ${r.status})——覆盖率低于阈值或测试失败，见 hooks/vitest.config.ts thresholds`, 2)
  }

  // 全绿时只留两行：用例汇总 + 覆盖率门禁结论
  const m = r.stdout.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/)
  console.log(m ? `[dsh-develop] ✓ 测试通过 (${m[1]} files / ${m[2]} tests)` : '[dsh-develop] ✓ 测试通过')
  // 覆盖率总表（vitest 的 "All files" 行）——有就印，没有不编
  const allRow = r.stdout.split('\n').find((l) => /^All files\s*\|/.test(l.trim()) || /^\s*All files\s/.test(l))
  if (allRow) console.log(`[dsh-develop]   ${allRow.trim()}`)
  console.log('[dsh-develop] ✓ coverage 门禁通过（报告：hooks/dsh-serenity-hooks/coverage/）')
}

function cmdBuild(): void {
  cmdTypecheck()
  const staging = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : resolve(process.env.HOME ?? '', '.dsh', 'source', 'current')
  const stagingRoot = readlinkSafe(staging)
  if (!existsSync(join(HOOKS_DIR, 'tsdown.config.ts'))) fail('tsdown.config.ts 缺失', 2)
  // tsdown: 优先 staging 的 harness tsdown 0.22.2（本仓 0.7.5 与 rolldown 不兼容）
  const tsdownBin = join(stagingRoot, 'node_modules', '.bin', 'tsdown')
  const bin = existsSync(tsdownBin) ? tsdownBin : join(REPO_ROOT, 'node_modules', '.bin', 'tsdown')
  const r = run(bin, ['-c', 'tsdown.config.ts'], { cwd: HOOKS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`tsdown 失败 (exit ${r.status})`, 2)
  }
  // 🔴 **两个产物都要报**（2026-10-23 v1.90.0）。
  //
  // 修前只报 `client.js` 一个，而文案写的是「lib/index.js + lib/client.js 224144 B」
  // ⇒ **读起来像"两个产物的合计/指纹"**，实际只测一个。
  // 实测后果（同日，跨轨迹）：改了 **node 半**（`src/tools/*`、`src/wake/*`）后，
  // build 打印的字节数与上一版**逐字相同** ⇒ 对方据此判「这条门禁不证明新代码被编译过」。
  // ⇒ 那个怀疑**是对的**（这条读数确实什么都不证明），但**真因不是"没重跑"**，
  //   而是**读数覆盖域与改动域不相交**（改的不是 client 半 ⇒ client 必然不变）。
  //
  // ⇒ 判据（D227）：**判据要覆盖"我改的那一半"**；跨半引用同一个数字 = 拿不相关的读数当证据。
  // ⇒ 修法：**两个产物各自报一个数**，读的人不用猜"这个 224144 到底测的是谁"。
  // ⚠️ 同时报 `index.js` 是因为**绝大多数改动落在 node 半**（工具的 src 都在那边），
  //    只报 client 等于对多数改动失明。
  const sizeText = (rel: string): string => {
    const p = join(HOOKS_DIR, 'lib', rel)
    return existsSync(p) ? `${statSync(p).size} B` : 'N/A'
  }
  console.log(
    `[dsh-develop] ✓ 构建完成（node: lib/index.js ${sizeText('index.js')}｜client: lib/client.js ${sizeText('client.js')}）`,
  )

  // 🔴 2026-10-16（S142 续 147）：**必须补第二半** —— `tsc --emitDeclarationOnly`。
  //
  // 为什么（R↓，实测事故形态）：本函数此前只跑 `tsdown`，而 **`tsdown.config.ts` 两个 entry
  // 都是 `dts: false`**，Node entry 还带 **`clean: true`** ⇒ **每跑一次 build 就先清空 `lib/`、
  // 只写回 `.js`** ⇒ `lib/*.d.ts` **必然消失，且永不自行回来**。
  //
  // ⇒ 后果不是"coverage 红了"这一条，而是**发布物缺类型**：
  //   `package.json` 声明的 `types: ./lib/index.d.ts` 与 `files[]` 的 `lib/*.d.ts`
  //   在包内**指向不存在**；而 `verifyTarball()` 的动态核对**只过滤 `.js`**
  //   （`missingLibJs`，见下）⇒ **类型缺失不被任何门捕获**。
  //
  // ⇒ 与 `package.json` 的 `build` 脚本**逐字对齐**（`tsdown … && tsc -p tsconfig.json --emitDeclarationOnly`）：
  //   两条链必须同一条，否则"我本地绿的"与"发布出去的"是两个东西（同族判据：判据 = 仓库实际状态）。
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const dts = run(tscBin, ['-p', 'tsconfig.json', '--emitDeclarationOnly'], { cwd: HOOKS_DIR, quiet: true })
  if (dts.status !== 0) {
    console.error(dts.stdout + dts.stderr)
    fail(`tsc --emitDeclarationOnly 失败 (exit ${dts.status})——lib/*.d.ts 未产出，中止（不发布缺类型的包）`, 2)
  }
  // 自证：清点产物，别只说"跑过了"（判据 = 盘上的文件，不是命令的退出码）
  // 🔴 **扫描域必须与 `verifyTarball()` 同口径 = 递归全树**（它报的是 `lib/**/*.d.ts`）。
  //    只数顶层会得到 68，而 tarball 报 111 ⇒ 两个数看着"对不上"，正是"扫描域 ≠ 判据真实边界"
  //    那族坑（新写读数器必须自证扫描域）。这里手动递归，不依赖 `readdirSync(…,{recursive})`
  //    的运行时版本支持（本脚本由 bun 直接跑，特性面不假设）。
  const countDts = (dir: string): number => readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory()
      ? countDts(join(dir, e.name))
      : (e.name.endsWith('.d.ts') ? 1 : 0)), 0)
  const dtsCount = countDts(join(HOOKS_DIR, 'lib'))
  if (dtsCount === 0) {
    fail('构建后 lib/ 仍无 .d.ts —— 类型产物未落地，中止', 2)
  }
  const jsCount = readdirSync(join(HOOKS_DIR, 'lib')).filter((f) => f.endsWith('.js')).length
  console.log(`[dsh-develop] ✓ 类型声明已产出（lib/**/*.d.ts ${dtsCount} 个；顶层 js ${jsCount} 个）`)
}

function readlinkSafe(p: string): string {
  try {
    return execFileSync('readlink', ['-f', p], { encoding: 'utf-8' }).trim() || p
  } catch {
    return p
  }
}

function cmdStatus(): void {
  const v = currentVersion()
  console.log(`[dsh-develop] 版本: package.json=${v.pkg} | dsh.plugin.json=${v.plugin} | CHANGELOG=${v.changelog ?? '(无)'}`)
  const r = run('git', ['status', '--short'], { cwd: REPO_ROOT, quiet: true })
  if (r.status !== 0) {
    console.log('[dsh-develop] 仓库非 git 或 status 失败')
    return
  }
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  console.log(lines.length ? `[dsh-develop] git status (${lines.length} 变更):` : '[dsh-develop] git status: clean')
  for (const l of lines.slice(0, 40)) console.log('  ' + l)
  if (lines.length > 40) console.log(`  … 还有 ${lines.length - 40} 条`)
}

function cmdCommit(message?: string): void {
  if (!message) fail('commit 需要消息: dsh-develop commit <message>')
  const add = run('git', ['add', '-A'], { cwd: REPO_ROOT, quiet: true })
  if (add.status !== 0) fail(`git add 失败: ${add.stderr}`, 2)
  const c = run('git', ['commit', '-m', message], { cwd: REPO_ROOT, quiet: true })
  if (c.status !== 0) {
    console.log('[dsh-develop] 无可提交内容或提交失败')
    console.log(c.stderr.trim())
    process.exit(c.status)
  }
  console.log(`[dsh-develop] ✓ committed: ${message}`)
}

function cmdPush(): void {
  // 2026-10-16（S142 续 153）：本命令**原先只推 `origin`**，而 `omdsh` 镜像**只由 `github-push` 推**
  //   ⇒ 任何走 `push` 的提交都会把**镜像静默落下一整版**（实测**两次**：v1.58.1、v1.58.2 —— 两次都是
  //   「本地与 github 看起来一切正常，只有 omdsh 停在上一个版本」）。
  //   改法是**委托** `cmdGithubPush()` —— 两个入口共用同一份"该推哪些远端"的实现（**单真相源**），
  //   不再依赖"记得要用 github-push"这种**靠自觉**的纪律（本轨已反复实测：靠自觉的纪律会静默失效）。
  //   `github` 与 `origin` 是**同一 URL 的两个名**（`git remote -v` 逐字）⇒ 换名推送对主仓无影响。
  cmdGithubPush()
}

/** omdsh-dev 组织镜像 remote（v1.24.9：dsp 同步到 omdsh-dev 组织增加曝光） */
const OMD_SH_REMOTE = 'omdsh'
const OMD_SH_URL = 'git@github.com:omdsh-dev/dsh-serenity-plugin.git'

/** 确保 remote 存在且 URL 正确（缺则 add，变了则 set-url） */
function ensureRemote(target: string, url: string, cwd = REPO_ROOT): void {
  const existing = run('git', ['remote', 'get-url', target], { cwd, quiet: true })
  if (existing.status !== 0) {
    const add = run('git', ['remote', 'add', target, url], { cwd, quiet: true })
    if (add.status !== 0) fail(`remote add ${target} 失败: ${add.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} -> ${url}`)
  } else if (existing.stdout.trim() !== url) {
    const set = run('git', ['remote', 'set-url', target, url], { cwd, quiet: true })
    if (set.status !== 0) fail(`remote set-url ${target} 失败: ${set.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} 更新为 ${url}`)
  }
}

function cmdGithubPush(remote?: string, force = false): void {
  // v1.24.9：默认双推——主仓 github（必达）+ omdsh-dev 组织镜像（失败仅 warn 不阻断发布）；
  // 显式 remote 参数时只推指定 remote（如 github-push github / github-push omdsh）
  const targets = remote ? [remote] : ['github', OMD_SH_REMOTE]
  for (const target of targets) {
    if (target === OMD_SH_REMOTE) ensureRemote(OMD_SH_REMOTE, OMD_SH_URL)
    const args = ['push', target, 'HEAD']
    if (force) args.push('--force')
    const r = run('git', args, {
      cwd: REPO_ROOT,
      quiet: true,
      env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
    })
    if (r.status !== 0) {
      if (target === OMD_SH_REMOTE) {
        // 组织镜像失败不阻断主发布（网络/权限问题可后续补推）；保留日志便于排查
        console.warn(`[dsh-develop] ⚠️ omdsh 组织镜像推送失败（不影响主仓，可后续 github-push omdsh 补推）: ${(r.stderr || r.stdout).slice(0, 300)}`)
        continue
      }
      console.error(r.stdout + r.stderr)
      fail(`git push ${target} 失败 (exit ${r.status})`, 2)
    }
    console.log(`[dsh-develop] ✓ pushed to ${target}${force ? '（force）' : ''}`)
  }
}

function cmdSquashHistory(message?: string): void {
  // 抹除历史：orphan 分支重建为单个初始 commit（保留工作树；历史不可逆——公开发布前清敏感历史用）
  const msg = message ?? 'Initial commit'
  const st = run('git', ['status', '--porcelain'], { cwd: REPO_ROOT, quiet: true })
  if (st.stdout.trim()) {
    fail(`工作树有未提交变更，先 commit 或 stash：\n${st.stdout.slice(0, 600)}`, 1)
  }  const orphan = run('git', ['checkout', '--orphan', 'squash-tmp'], { cwd: REPO_ROOT, quiet: true })
  if (orphan.status !== 0) fail(`checkout --orphan 失败: ${orphan.stderr}`, 2)
  const add = run('git', ['add', '-A'], { cwd: REPO_ROOT, quiet: true })
  if (add.status !== 0) fail(`git add 失败: ${add.stderr}`, 2)
  const commit = run('git', ['commit', '-m', msg], { cwd: REPO_ROOT, quiet: true })
  if (commit.status !== 0) fail(`commit 失败: ${commit.stderr}`, 2)
  run('git', ['branch', '-D', 'master'], { cwd: REPO_ROOT, quiet: true })
  const rename = run('git', ['branch', '-m', 'master'], { cwd: REPO_ROOT, quiet: true })
  if (rename.status !== 0) fail(`分支改名失败: ${rename.stderr}`, 2)
  console.log(`[dsh-develop] ✓ 历史已抹除（单初始 commit: ${msg}）`)
  console.log(`[dsh-develop]   推送公开仓库需 force（如: dsh-develop github-push --force）`)
}

/**
 * syncPackageReadme — 包内 README 与仓库 README 机械同步（单一真相源）
 *
 * 背景（v1.30.11）：npm 页面展示的是 **包内** README（hooks/dsh-serenity-hooks/README.md，
 * 经 package.json files 白名单进 tarball），**不是仓库根 README**。此前包内 README 是独立
 * 手写的短版；v1.30.11 重写根 README 后它停在 v1.30.0（"8 块"等过时事实）——于是
 * "发布后 npm README 会更新"的预期落空（实证：jsdelivr 取 @1.30.10 包内 README 仍是旧短版）。
 * 修复 = 发布前把根 README 复制为包内 README，并把**仓库相对链接改写成绝对 GitHub URL**
 * （tarball 内没有 docs/、CHANGELOG.md、LICENSE，相对链接在 npm 页会 404）。
 */
const REPO_BLOB_URL = 'https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master'

function syncPackageReadme(): void {
  const src = join(REPO_ROOT, 'README.md')
  const dst = join(HOOKS_DIR, 'README.md')
  if (!existsSync(src)) fail(`包内 README 同步失败：源文件不存在 ${src}`, 2)
  const out = readFileSync(src, 'utf-8')
    .replace(/\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g, (_m, rel: string) => `](${REPO_BLOB_URL}/${rel})`)
  const before = existsSync(dst) ? readFileSync(dst, 'utf-8') : ''
  if (before === out) {
    console.log('[dsh-develop] ✓ 包内 README 与仓库 README 一致（无变更）')
    return
  }
  writeFileSync(dst, out, 'utf-8')
  console.log(`[dsh-develop] ✓ 包内 README 已同步（README.md → hooks/dsh-serenity-hooks/README.md，${out.length} 字节）`)
}

function cmdPublish(): void {
  // npm publish @shgroup/dsh-serenity-hooks（cwd=hooks；凭据走 ~/.npmrc；publishConfig.access=public 已声明）
  // 发布前先构建（lib/ 最新）；npm cache 指向可写临时目录（沙箱 ~/.npm 只读）
  // v1.17.4：显式 --registry https://registry.npmjs.org/ —— ~/.npmrc 默认 registry 可能指向
  // 内网 nexus（私有只读镜像 → npm publish 400 Bad Request）。@shgroup token
  // 按 registry URL 匹配，官方 registry 发布不受影响。
  // v1.30.7（S142 review F-14）：发布前强制跑测试——此前 publish 只做 typecheck+build+pack-check，
  // 测试是"人记得跑"的步骤，绿着发布可能带着红测试。
  // v1.31.11（用户裁决 D52"检查归发布机制"）：前置补**锁文件一致性判定**——GitHub CI 不再是
  // 我们的质量门（用户"我对 github ci 持反对态度"），原先由 CI 的 `Install (hooks)` 兜住的
  // "锁文件漂移"改由发布链在 publish 前拦下。
  // 发布链的检查面（= 我们的门）：锁文件一致 → 测试（含 typecheck 双面）→ 构建 → README 同步 → tarball 核对。
  verifyLockfile()
  cmdTest()
  cmdBuild()
  syncPackageReadme()
  verifyTarball()
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  const r = run('npm', ['publish', '--access', 'public', '--registry', 'https://registry.npmjs.org/'], {
    cwd: HOOKS_DIR,
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  })
  // 🔴 2026-09-25（S142，v1.47.3 实测事故）：**成功路径此前完全不印 npm 的输出** ⇒
  //   一次「exit 0 但包里什么都没上去」的静默假成功**无任何痕迹可查**（见下方 verifyPublished）。
  //   从此两条路径都印 —— 发布是低频、高代价动作，宁可多印。
  if (r.stdout.trim()) console.log(r.stdout.trim())
  if (r.stderr.trim()) console.error(r.stderr.trim())
  if (r.status !== 0) {
    fail(`npm publish 失败 (exit ${r.status})`, 2)
  }
  verifyPublished(currentVersion().pkg, r.stdout + r.stderr)
  console.log(`[dsh-develop] ✓ published @shgroup/dsh-serenity-hooks@${currentVersion().pkg}（npm registry）`)
}

/**
 * verifyPublished — **落地判据**：npm 报成功 ≠ 包真的能被装上。
 *
 * 🔴 为什么必须（2026-09-25 S142 v1.47.3 实测）：发布链的"成功"曾经**只是 npm 的退出码**。
 *   既有纪律早写着**「落地判据 = tarball 200，不是看元数据」**，但那条判据此前**靠人肉执行**。
 *
 * 🔴 为什么**不能只读 tarball**（同日实测，两个反向陷阱）：
 *   ① 普通 packument 读会**滞后**（本例滞后 >10 分钟：`latest` 仍显示上一版），
 *      只有 **`?write=true`** 是**绕开 CDN 的权威读**；
 *   ② tarball 的 404 **也会被边缘负缓存**（本例连续 15 分钟 404），
 *      ⇒ **单读 tarball 会误判"没上去"**，把已落地的发布判成失败。
 *
 * ⇒ 判据取**两条读数**，缺一不可：
 *   **A（权威）** `GET {packument}/{version}?write=true` == 200 ⇒ 版本记录已在 registry 上；
 *   **B（可装）** `GET {dist.tarball}` == 200 ⇒ 包体真能下载（**这才是用户能不能装**）。
 *
 * 🔴🔴 **2026-10-14 更正（本处曾写过一个没有证据的断言，并因此害人）**：
 *   原文写着「A 绿 B 红 = **半上架**（记录在、包体取不到）⇒ **正是"staged 待批准"的签名**，必须响亮失败」。
 *   **该断言从未被验证过**，而它**正是 S142 那次误判的源头** —— 我照它把一句
 *   `409 … Cannot publish over previously staged version` 文案**命名成了 npm 的「staged 待批」机制**，
 *   并**据此让 owner 去网页批准**；实测 `GET /-/stage` 返 `{"items":[],"total":0}`
 *   （**没有任何待批项**），该版本**自己上架了**。
 *   ⇒ **正确表述**：A 绿 B 红 = **记录在、包体此刻取不到**；**成因是开放的**
 *      （边缘负缓存 / 传播 / 其它），**不得就此断言任何具体机制**。
 *   ⇒ **判据（D131）**：**错误文案不是机制的证据** —— 要给状态命名，必须能从
 *      **该机制自己的权威读数面**独立取到。staged 的权威面 = `GET /-/stage`（**须带 token**；
 *      **401 = 查不到 ≠ 没有**，`200 + items:[]` 才是"没有"的证据）。
 *   ⇒ 现成入口：`msm("npm-registry-doctor", ["status"])`（四档判读，含 staged 权威面）。
 */
function landingRead(version: string): { record: string; tarball: string } {
  const base = 'https://registry.npmjs.org/@shgroup%2Fdsh-serenity-hooks'
  const r = run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${base}/${version}?write=true`],
    { cwd: SCRIPTS_DIR, quiet: true, env: {} })
  const t = run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    `https://registry.npmjs.org/@shgroup/dsh-serenity-hooks/-/dsh-serenity-hooks-${version}.tgz`],
    { cwd: SCRIPTS_DIR, quiet: true, env: {} })
  return {
    record: (r.stdout || '').trim() || `curl exit ${r.status}`,
    tarball: (t.stdout || '').trim() || `curl exit ${t.status}`,
  }
}

/**
 * packumentHasVersion — 第三个读数：registry 的 packument 里有没有这个版本。
 *
 * 🔴 **它不是权威读（这一条被实测推翻过一次，别再把单个读数当权威）**：
 *   2026-10-11 v1.51.6 发布时，`?write=true` 与 tarball **双双 404** 而 **packument 已完整含该版本**
 *   （`dist` 的 shasum／fileCount／unpackedSize／integrity 与 npm 回执逐字相同）⇒ 当时我据此把
 *   "权威 = packument" 写进了判据。**同一天 v1.52.0 发布把这条推翻**：t≈90s 时**三个读数都没有** 1.52.0，
 *   t≈4min 时 **record 已 200 而 packument 仍无** —— **与 1.51.6 恰好相反**。
 *
 * ⇒ **三个读数（record `?write=true` ／ packument ／ tarball）各自独立滞后**，没有谁永远更快；
 *   **哪一个都不能单独当权威**（单次观测得出的"权威"是我犯过的错 —— n=1 的结论）。
 *   真正的"已提交"证据只有 **npm 自己**：`exit 0` ＋ stdout 含 `+ <pkg>@<ver>`（见 {@link npmReportedSuccess}）。
 */
function packumentHasVersion(version: string): { has: boolean; detail: string } {
  const r = run('curl', ['-s', '--max-time', '20',
    '-H', 'Accept: application/vnd.npm.install-v1+json',
    'https://registry.npmjs.org/@shgroup%2Fdsh-serenity-hooks'],
    { cwd: SCRIPTS_DIR, quiet: true, env: {} })
  if (r.status !== 0) return { has: false, detail: `curl exit ${r.status}` }
  const body = (r.stdout || '').trim()
  if (!body) return { has: false, detail: 'packument 空响应' }
  try {
    const doc = JSON.parse(body) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, unknown> }
    const has = typeof doc.versions === 'object' && doc.versions !== null && version in doc.versions
    const latest = doc['dist-tags']?.latest ?? '?'
    return { has, detail: `latest=${latest}` }
  } catch {
    return { has: false, detail: 'packument 解析失败' }
  }
}

/**
 * npmReportedSuccess — **"已提交"的唯一证据**：npm 自己报的 `+ <pkg>@<ver>`。
 *
 * 为什么它就是证据：npm 会在**服务端接受发布**之后才打印这一行；三个落地读数都只是**传播**，
 * 它们可以在发布成功后仍然全部显示旧态（v1.52.0 实测：90 秒内三个读数皆无、而 npm 已成功）。
 * ⇒ **把"提交"与"传播"分开判**：提交看 npm，传播看读数。
 */
function npmReportedSuccess(npmOutput: string, version: string): boolean {
  return npmOutput.includes(`+ @shgroup/dsh-serenity-hooks@${version}`)
}

/**
 * verifyPublished — **落地核对**：把「已提交」（npm）与「已传播」（三个读数）分开判。
 *
 * 判据（三层，别退化成单条）：
 *   ① **已提交** = npm exit 0 且 stdout 含 `+ <pkg>@<ver>`（由调用方传入，见 {@link npmReportedSuccess}）；
 *   ② **上架成立** = 三个读数**任一**为真（record 200 ／ packument 含该版本 ／ tarball 200）
 *      —— 它们**各自独立滞后**，所以是**析取**，不是合取、也不是"某个读数说了算"；
 *   ③ **两者都假** ⇒ 若 ① 为真 = **未确认（传播中）**，**不判失败**（重跑 publish 只会 409）；
 *      若 ① 为假 = 真失败。
 */
function verifyPublished(version: string, npmOutput: string): void {
  const reported = npmReportedSuccess(npmOutput, version)
  const deadline = Date.now() + 90_000
  let last: { record: string; tarball: string } = { record: '?', tarball: '?' }
  for (;;) {
    last = landingRead(version)
    if (last.record === '200' && last.tarball === '200') {
      console.log(`[dsh-develop] ✓ 落地核对：版本记录 200 ＋ tarball 200 — ${version}`)
      return
    }
    if (Date.now() >= deadline) break
    run('sleep', ['3'], { cwd: SCRIPTS_DIR, quiet: true, env: {} })
  }
  const pk = packumentHasVersion(version)
  const anyFresh = last.record === '200' || last.tarball === '200' || pk.has
  if (anyFresh) {
    console.log(`[dsh-develop] ✓ 落地核对：**上架成立**（三个读数任一为真）— ${version}`)
    console.log(`   读数：record=${last.record} ／ tarball=${last.tarball} ／ packument.has=${pk.has}（${pk.detail}）`)
    console.log(`   落后者属**滞后**（三者各自独立滞后：v1.51.6 是 packument 先到，v1.52.0 是 record 先到）`
      + ' ⇒ 若此刻装不上，等几分钟再试；`npm-install` 自带传播重试')
    // 🔴 2026-10-17（S142 · A65-P3 修复）：原文案把这句统称「传播延迟」。
    //   但此刻 **至少一个读数为真** ⇒ 落后的那个更可能是**边缘负缓存**，也可能是**各面刷新节奏不同**。
    //   两者处置相同（等），**但名称不同** —— 而"命名状态"正是本轨判据禁止在无区分读数时做的事
    //   （D131 / 续 162：吻合度不是区分度）。改用中性词「滞后」，不再断言成因。
    return
  }
  if (reported) {
    console.log(`[dsh-develop] ⚠️ 落地核对：**未确认（传播中）** — ${version}`)
    console.log(`   三个读数此刻都还没有它：record=${last.record} ／ tarball=${last.tarball} ／ packument=${pk.has}（${pk.detail}）`)
    console.log('   但 **npm 自己报了成功**（stdout 含 `+ @shgroup/dsh-serenity-hooks@' + version + '`）⇒ 视为**已提交、正在传播**。')
    console.log(`   ⇒ **不判失败**（重跑 publish 只会 409）。复核 = publish-landed ${version}；装 = npm-install（该步自带传播重试）`)
    return
  }
  fail(`landing 核对失败：三个读数都没有 ${version}，**且 npm 也没有报成功**\n`
    + `  （record=${last.record} ／ tarball=${last.tarball} ／ packument=${pk.has}（${pk.detail}））\n`
    + '  🔴 形态 = 真没上去。处置：看上方 npm 的实际输出再重跑 publish。', 2)
}

/**
 * verifyTarball — npm pack --dry-run 机械核对 tarball 完整性（发布前强制；pack-check 可独立调用）
 * 核对范围：lib/ 全部 JS 产物（含 tsdown chunk）+ 双 bundle 必需文件。
 * 历史教训：files 白名单漏 chunk（lib/ccc-*.js）→ npm 包 index.js import 失败（加载即崩，v1.26.15 事故）。
 */
function verifyTarball(): void {
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  // 发布前核对 tarball 内容：npm publish 会自动运行 prepare（只构建 Node 半的 prepare
  // 曾清掉 lib/client.js → 发布包缺 client.js，DSH web 激活抛 MissingClientBundleError）。
  // 用 npm pack --dry-run --json 机械断言 Node 半 + client 半都在包内。
  //
  // 🔴 `--ignore-scripts` 同 `publishFileList`（本文件 1290 行的硬约束），**同样适用本函数**：
  //    不带它则 pack 会跑 `prepare` ⇒ **清掉 lib/client.js 且重建整个 lib/**。
  //    ⚠️ 2026-10-17 实测后果（本行是那次修复）：`coverage` 由 vitest **并行 worker** 跑，
  //    `privacy-scan.test.ts` 也在测里跑 `npm pack --dry-run` ⇒ 两个 pack 同时在**重建中的 lib/** 上取树，
  //    读到**残缺快照**（实测两次分别 27 / 36 文件，而真值 139）⇒ 一条**稳定的假红**。
  //    ⇒ 判据：**凡"读发布物清单"的调用，一律带 `--ignore-scripts`**（三处统一，不许各写各的）。
  const dry = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: HOOKS_DIR,
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  })
  if (dry.status !== 0) {
    console.error(dry.stdout + dry.stderr)
    fail(`npm pack --dry-run 失败 (exit ${dry.status})`, 2)
  }
  let tarballFiles: string[] = []
  try {
    const parsed = JSON.parse(dry.stdout) as Array<{ files: Array<{ path: string }> }>
    tarballFiles = (parsed[0]?.files ?? []).map((f) => f.path)
  } catch {
    fail(`npm pack --dry-run 输出解析失败（非预期 JSON）：\n${dry.stdout.slice(0, 400)}`, 2)
  }
  // S142 §12.44：航行动画资产（/serenity/voyage 路由要读它；漏了 ⇒ 卡片背景 500）
  // 同 v1.26.15 事故形态（files 白名单漏运行时必需文件）⇒ 提到发布前硬断言。
  // 🔴 D104（2026-09-29）：**diagram 的内置字体**同理 —— `rasterize.ts` 在**运行时**读它
  //    （wasm 对系统字体不可见 ⇒ 没有它就连中文都画不出），而它 3.8 MB、又是二进制资产
  //    ⇒ 最容易在 files 白名单里被漏掉。许可证同属"必须随包分发"（Apache-2.0 的再分发条件）。
  const required = [
    'lib/index.js', 'lib/client.js', 'lib/invariant.js',
    'assets/serenity-voyage.html',
    // v1.57.2（S142 续 125）：`praxis eap` 的正文改为**随包论文全文** ⇒ `tools/eap.ts` 在
    //    运行时读它；漏了 ⇒ `praxis eap` 抛「paper asset unavailable」（同族的又一次
    //    "files 白名单漏运行时必需文件"，形态见 v1.26.15）。许可证同属必须随包分发（MIT）。
    'assets/eap-paper.md',
    'assets/eap-paper-LICENSE.txt',
    'assets/diagram/DroidSansFallbackFull.ttf',
    'assets/diagram/LICENSE-Apache-2.0.txt',
    // v1.51.1：补拉丁字型（CJK 字型**不含拉丁** ⇒ 只带一个时英文字母全渲染成方框）
    'assets/diagram/NotoSans-Regular.ttf',
    'assets/diagram/LICENSE-OFL-1.1.txt',
    // v1.51.1（续，D108）：再补**符号**字型 —— 视觉取证显示前两个**都没有** `①`／`⇒`／`→` 的字形，
    //    只带前两个时它们仍是方框（DejaVu 的许可证与 Apache/OFL 不同 ⇒ 必须单独随包）。
    'assets/diagram/DejaVuSans.ttf',
    'assets/diagram/LICENSE-DejaVu.txt',
  ]
  const missing = required.filter((f) => !tarballFiles.includes(f))
  if (missing.length > 0) {
    fail(`tarball 缺必需文件（${missing.join(', ')}）——检查 tsdown.prepare.config.ts 是否构建完整双 bundle，中止发布`, 2)
  }
  // v1.26.16：动态核对 lib/ 全部 JS 产物（含 tsdown chunk 如 lib/ccc-*.js）——
  // files 白名单漏 chunk 曾致 npm 包 index.js import "./ccc-xxx.js" 失败（加载即崩）。
  const libJs = readdirSync(join(HOOKS_DIR, 'lib')).filter((f) => f.endsWith('.js'))
  const missingLibJs = libJs.filter((f) => !tarballFiles.includes(`lib/${f}`))
  if (missingLibJs.length > 0) {
    fail(`tarball 缺 lib/ 产物（${missingLibJs.join(', ')}）——package.json files 白名单未覆盖 tsdown 全部输出，中止发布`, 2)
  }
  console.log(`[dsh-develop] ✓ tarball 核对通过（${tarballFiles.length} 文件，含 lib/index.js + lib/client.js + lib/invariant.js）`)
  // lib/ 产物清单（验证 chunk 与 .d.ts 齐全——v1.26.15 事故后常驻可见性）
  const libEntries = tarballFiles.filter((f) => f.startsWith('lib/'))
  const dtsCount = tarballFiles.filter((f) => f.endsWith('.d.ts')).length
  const libJsCount = libEntries.filter((f) => f.endsWith('.js')).length
  const libDtsCount = libEntries.filter((f) => f.endsWith('.d.ts')).length
  // 🔴 D237（2026-10-24 owner 令「成功要大幅精简，别逐条列」）：
  //    此前这里**无条件逐行打印 145 项** lib/ 产物 —— 那是**成功**路径，
  //    而"清单每一项都在"这件事已经由上面那行 `✓ 核对通过` 的**判据**保证了
  //    （缺任何一个 chunk，`missingLibJs` 早就 fail 退出、根本走不到这里）。
  //    ⇒ 成功面只留「结论 ＋ 计数」；**要看全清单时**显式传 `--list-artifacts` 拿全（人读/排障用）。
  console.log(`[dsh-develop]   lib/ 共 ${libEntries.length} 项（js ${libJsCount} / d.ts ${libDtsCount}）｜包内 .d.ts 共 ${dtsCount} 个`)
  if (process.argv.includes('--list-artifacts')) {
    for (const f of libEntries) console.log(`    ${f}`)
  } else {
    console.log('[dsh-develop]   （要看逐项清单：pack-check --list-artifacts）')
  }
}

function cmdGithubPushRepo(dir?: string): void {
  // 任意仓库发布到 GitHub 公开仓库（tellmewhattodo/<仓库名>）：缺 github remote 自动添加；SSH-443
  if (!dir) fail('github-push-repo 需要仓库目录（相对 CCC 根，如 AI_LAB/serenity-acc-specs）')
  const abs = resolve(process.cwd(), dir)
  if (!existsSync(join(abs, '.git'))) fail(`不是 git 仓库: ${abs}`, 2)
  const target = 'github'
  const repoName = basename(abs)
  const url = `git@github.com:tellmewhattodo/${repoName}.git`
  const existing = run('git', ['remote', 'get-url', target], { cwd: abs, quiet: true })
  if (existing.status !== 0) {
    const add = run('git', ['remote', 'add', target, url], { cwd: abs, quiet: true })
    if (add.status !== 0) fail(`remote add 失败: ${add.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} -> ${url}`)
  } else if (existing.stdout.trim() !== url) {
    const set = run('git', ['remote', 'set-url', target, url], { cwd: abs, quiet: true })
    if (set.status !== 0) fail(`remote set-url 失败: ${set.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} 更新为 ${url}`)
  }
  const r = run('git', ['push', target, 'HEAD'], {
    cwd: abs,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`git push ${target} 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ pushed ${repoName} -> github (${url})`)
}

function cmdGithubLs(remote?: string): void {
  // 验证 GitHub remote 连通性 + 仓库存在（git ls-remote）；remote 缺失则自动添加
  const target = remote ?? 'github'
  const url = 'git@github.com:tellmewhattodo/dsh-serenity-plugin.git'
  const existing = run('git', ['remote', 'get-url', target], { cwd: REPO_ROOT, quiet: true })
  if (existing.status !== 0) {
    const add = run('git', ['remote', 'add', target, url], { cwd: REPO_ROOT, quiet: true })
    if (add.status !== 0) fail(`git remote add ${target} 失败: ${add.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} -> ${url}`)
  } else if (existing.stdout.trim() !== url) {
    const set = run('git', ['remote', 'set-url', target, url], { cwd: REPO_ROOT, quiet: true })
    if (set.status !== 0) fail(`git remote set-url ${target} 失败: ${set.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} 更新为 ${url}`)
  }
  const r = run('git', ['ls-remote', '--heads', target], {
    cwd: REPO_ROOT,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`ls-remote ${target} 失败（SSH key 无权访问或仓库不存在）`, 2)
  }
  console.log(`[dsh-develop] ✓ ${target} 可达，heads:\n${r.stdout.trim() || '(空，新仓库)'}`)
}

function cmdInspectDsh(pattern?: string): void {
  // 诊断工具：在 staging DSH 源码中检索 src/（排除 lib/types 噪音；独立进程不受工具守卫约束）
  if (!pattern) fail('inspect-dsh 需要 pattern')
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const staging = readlinkSafe(join(dshHome, 'source', 'current'))
  // 只搜 packages/*/src 与 apps/*/src，排除 lib（.d.ts 噪音）
  const grep = run('bash', ['-c',
    `find '${join(staging, 'packages')}' '${join(staging, 'apps')}' -type f -name '*.ts' -not -path '*/lib/*' -not -path '*/tests/*' 2>/dev/null | xargs grep -l -E '${pattern}' 2>/dev/null | head -8 | while read f; do echo "== $f"; grep -n -E '${pattern}' "$f" | head -5; done`],
  { cwd: staging, quiet: true })
  if (grep.status !== 0 || !grep.stdout.trim()) {
    console.log(`[dsh-develop] 无匹配: ${pattern}`)
    return
  }
  console.log(`[dsh-develop] 匹配 ${pattern}:`)
  console.log(grep.stdout.slice(0, 4000))
}

/**
 * host-fetch — 抓取指定版本的**宿主包**并解包到仓库内 `_tmp/host-<version>/`（**不动本机安装**）。
 *
 * 为什么存在（R↓，0.1.5-rc.1 适配轮）：宿主升级适配需要三样东西，全都要求**新版源码在场**：
 *   ① 我们 peer 依赖的包的 `.d.ts`（类型面/契约核对——`host/contract.ts` 的服务与成员表要逐条对账）；
 *   ② 宿主插件源码（如 `dsh-llm-pi-ai` 的 provider 请求构造，用于判断"特殊 header 能否在插件层注入"）；
 *   ③ 新旧两版对比（移除/改名的 API）。
 * 本机 `~/.npm-global/.../@deepseek-ai/dsh` 是**旧版安装**（用户要求先不升级），所以在这里把新版抓到
 * 仓库内 `_tmp/`（gitignore）——解包后 `read`/`grep`/`glob` 可直接读，无需安装、无需改 tsconfig。
 *
 * 用法: dsh-develop host-fetch <version> [pkg...] [--list]
 *   包集合 = hooks/package.json 的 peerDependencies（`@deepseek-ai/dsh-*`）+ client 半 ui 包 + 任务专用包
 *            ＋ **两份基准 tsconfig 的 `paths` 派生**（见 `hostPackagesFromTsConfig`）——末项的用途是
 *            让随后那句 `typecheck-host <version>` **一次就能跑到**，不必人工补跑
 *   已是幂等：已解包的包跳过；单个包失败仅告警（不阻断其余）
 *   `--list`：只打印解析后的包集（逐项含版本）**不抓取**——供测试与人工核对
 */
const HOST_FETCH_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
]

/**
 * 适配轮常需、但不在 peer 列表里的宿主包（核对用）。
 *
 * 🔴 2026-09-28：**删去 `@deepseek-ai/dsh-agent-presets`** —— 该包在新线已改名为
 * `@deepseek-ai/dsh-agent-preset-registry`（后者本来就在 peerDependencies 里），
 * 故这一项**两代（0.1.7-rc.2 / 0.2.0-rc.1）都必然 `npm pack` 失败**，
 * 每次跑都留下一条 "失败 1"，把"包集不完整"与"包已改名"两种情形混成同一个信号。
 * 谁依赖它：无——它只出现在这张抓取表里，仓库内 `grep` 不到任何引用。
 */
const HOST_FETCH_EXTRA_PACKAGES = [
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
]

/**
 * `typecheck-host` 的**必需包集** = 基准 tsconfig 的 `paths` 里指向宿主 `node_modules` 的包。
 *
 * 为什么必须派生（2026-09-28，**第二次**踩同一坑）：`host-fetch` 的默认集此前是**手维护**的
 * （peer 过滤 `@deepseek-ai/dsh-` ＋ 两张硬编码表），它与 tsconfig 的 `paths` **各自演化** ⇒
 * 手维护那份必然漂移，而漂移**只在下一步才暴露**。两次实测都当场卡住：
 * `host-fetch <ver>` 跑完报"成功"，紧接着 `typecheck-host <ver>` 立刻失败于
 * 「派生 paths 指向缺失目录（10 条）」—— **看起来像宿主删包，其实只是默认集少了它们**
 * （node 半那 10 条键 = **8 个包**：6 个只在 devDependencies 里 ∧ 过不了 peer 的
 * `@deepseek-ai/dsh-` 前缀过滤的 `dsh-*`，＋ `cordis`/`schemastery` 这对**不以 `dsh-` 开头、
 * 被该过滤器整类丢掉**的 vendor 包；client 半另需 `dsh-api-session-controller` ⇒ **合计 9 个**）。
 * ⇒ **包集的唯一真相源 = tsconfig 的 `paths`**（那里本就是类型基准的声明处）。
 *
 * 锚点与 `mapHostPathToTmp` **同一处**（`node_modules/@deepseek-ai/` 的最后一次出现）——
 * 另起一套解析必然再次分叉。
 */
function hostPackagesFromTsConfig(file: string): string[] {
  let parsed: { compilerOptions?: { paths?: Record<string, string[]> } }
  try {
    parsed = parseJsonc(readFileSync(file, 'utf-8')) as typeof parsed
  } catch {
    return [] // 基准缺失不阻断（另一份仍供包）
  }
  const out = new Set<string>()
  for (const targets of Object.values(parsed.compilerOptions?.paths ?? {})) {
    for (const target of targets) {
      const nm = target.lastIndexOf('node_modules/@deepseek-ai/')
      if (nm < 0) continue
      const name = target.slice(nm + 'node_modules/@deepseek-ai/'.length).split('/')[0]
      if (name) out.add(`@deepseek-ai/${name}`)
    }
  }
  return [...out]
}

/** 两份基准 = node 半 ＋ client 半，与 `typecheck-host` 用的**同一批文件** */
const HOST_FETCH_BASELINE_TSCONFIGS = [
  join(HOOKS_DIR, 'tsconfig.json'),
  join(HOOKS_DIR, 'client', 'tsconfig.json'),
]

/**
 * 非 `dsh-*` 的宿主包（`@deepseek-ai/cordis` / `@deepseek-ai/schemastery`）**不跟宿主版本号走**
 * （宿主各包声明的是 `~4.0.4` / `~3.18.4`）⇒ 取仓库内**已装版本**
 * —— 与类型基准同源，两版解包快照才**对称**（否则 diff 会把 cordis 显示成"被改动"，
 * 而那是**我这次抓取造成的**假象，不是宿主变化）。
 */
function vendorHostVersion(name: string): string | undefined {
  try {
    const pkg = readJson(join(HOOKS_DIR, 'node_modules', name, 'package.json')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

function cmdHostFetch(version?: string, extraArg: string[] = []): void {
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    fail('host-fetch 需要版本号: dsh-develop host-fetch <x.y.z[-rc.n]> [pkg...] [--list]')
  }
  const listOnly = extraArg.includes('--list')
  const extra = extraArg.filter((a) => a !== '--list')
  const pkg = readJson(join(HOOKS_DIR, 'package.json'))
  const peers = Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>)
    .filter((n) => n.startsWith('@deepseek-ai/dsh-'))
  const fromBaselines = HOST_FETCH_BASELINE_TSCONFIGS.flatMap(hostPackagesFromTsConfig)
  const names = [...new Set([
    ...peers, ...HOST_FETCH_CLIENT_PACKAGES, ...HOST_FETCH_EXTRA_PACKAGES, ...fromBaselines, ...extra,
  ])]
  // 未钉版的条目：`dsh-*` 跟宿主版本号走；其余（vendor）钉到仓库内已装版本
  const specs = names.map((n) => {
    if (n.includes('@', 1)) return n
    if (n.startsWith('@deepseek-ai/dsh-')) return n
    const v = vendorHostVersion(n)
    if (!v) console.log(`[dsh-develop]   ⚠️ ${n} 未在仓库内找到已装版本 ⇒ 按宿主版本号试取（可能失败）`)
    return v ? `${n}@${v}` : n
  })
  if (listOnly) {
    console.log(`[dsh-develop] host-fetch 默认包集（${specs.length} 项；--list 不抓取）:`)
    console.log(specs.join('\n'))
    return
  }
  const outRoot = join(REPO_ROOT, '_tmp', `host-${version}`)
  mkdirSync(outRoot, { recursive: true })
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  console.log(`[dsh-develop] host-fetch ${version} → ${outRoot}（${specs.length} 个包；其中 ${fromBaselines.length} 项由基准 tsconfig 派生）`)

  const failed: string[] = []
  let done = 0
  let skipped = 0
  for (const spec of specs) {
    // 支持 `pkg@version` 逐包钉版本（cordis / schemastery 这类非 dsh-* 的 peer 不跟宿主版本号走）
    const at = spec.lastIndexOf('@')
    const name = at > 0 ? spec.slice(0, at) : spec
    const pkgVersion = at > 0 ? spec.slice(at + 1) : version
    const dest = join(outRoot, name)
    if (existsSync(join(dest, 'package.json'))) { skipped += 1; continue }
    const packed = run('npm', ['pack', `${name}@${pkgVersion}`, '--pack-destination', outRoot,
      '--registry', 'https://registry.npmjs.org/'], {
      cwd: outRoot, quiet: true, env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
    })
    if (packed.status !== 0) {
      failed.push(spec)
      continue
    }
    // npm pack 输出末行为 tarball 文件名
    const tgz = packed.stdout.trim().split('\n').pop() ?? ''
    const tgzPath = join(outRoot, tgz)
    if (!tgz || !existsSync(tgzPath)) { failed.push(name); continue }
    mkdirSync(dest, { recursive: true })
    const x = run('tar', ['-xzf', tgzPath, '-C', dest, '--strip-components=1'], { cwd: outRoot, quiet: true })
    rmSync(tgzPath, { force: true })
    if (x.status !== 0) { failed.push(name); continue }
    done += 1
  }
  console.log(`[dsh-develop] ✓ 解包 ${done} / 跳过（已存在）${skipped} / 失败 ${failed.length}`)
  if (failed.length) console.log(`[dsh-develop]   失败包: ${failed.join(', ')}`)
  console.log('[dsh-develop]   下一步：直接 read/grep/glob 读源码与 .d.ts（typecheck 基线仍指向本机安装，未改动）')
}

/**
 * 把基准 tsconfig 里的宿主路径值改写到本次解包的宿主根下。
 *
 * 三类基准来源（R↓）：
 *  ① **仓库内 devDependencies**（v1.31.11 §7-8 起的正式形态）：
 *     `node_modules/@deepseek-ai/<pkg>[/子路径]`（node 半）／`../node_modules/@deepseek-ai/<pkg>`（client 半）
 *  ② 本机安装（历史形态，v1.31.10 及更早）：`…/.npm-global/…/node_modules/@deepseek-ai/dsh-tools[/子路径]`
 *  ③ 本机源码树（历史 client 半）：`.dsh/source/current/packages/client/ui-slots[/子路径]`
 *     → 包名按官方约定还原为 `@deepseek-ai/dsh-client-ui-slots`
 * 其余值（如 `../node_modules/@types/react`）与宿主无关，**原样保留**——误映射会把 react 类型打断。
 */
function mapHostPathToTmp(value: string, hostPrefix: string): string {
  // 三类来源的共同锚点 = `node_modules/@deepseek-ai/` 的**最后一次**出现：
  //  · 形态①：`node_modules/@deepseek-ai/dsh-tools`（无前导斜杠 → 只出现一次）
  //  · 形态②：`…/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools`
  //    ——有**两个** `node_modules/@deepseek-ai/`，必须取最后一次
  // 切片偏移 = 'node_modules/'.length（锚点不含前导斜杠——形态①下没有前导斜杠可切）
  const nm = value.lastIndexOf('node_modules/@deepseek-ai/')
  if (nm >= 0) return `${hostPrefix}/${value.slice(nm + 'node_modules/'.length)}`
  const src = value.indexOf('.dsh/source/current/packages/')
  if (src >= 0) {
    const parts = value.slice(src + '.dsh/source/current/packages/'.length).split('/')
    const pkg = `@deepseek-ai/dsh-${parts[0]}-${parts[1]}`
    return `${hostPrefix}/${[pkg, ...parts.slice(2)].join('/')}`
  }
  return value
}

/** 生成派生 tsconfig 并跑 tsc；返回 { label, status, output, hostFiles } */
function runHostTypecheckHalf(
  tscBin: string,
  version: string,
  baseFile: string,
  outFile: string,
  hostPrefix: string,
  label: string,
  fileMarker: string,
): { status: number; output: string; hostFiles: number } {
  const baseDir = dirname(baseFile)
  const base = parseJsonc(readFileSync(baseFile, 'utf-8'))
  const basePaths = (base.compilerOptions as { paths?: Record<string, string[]> }).paths ?? {}
  const paths: Record<string, string[]> = {}
  const remapped = new Set<string>()
  for (const [key, targets] of Object.entries(basePaths)) {
    paths[key] = targets.map((t) => {
      const mapped = mapHostPathToTmp(t, hostPrefix)
      if (mapped !== t) remapped.add(key)
      return mapped
    })
  }
  const derived = { ...base, compilerOptions: { ...(base.compilerOptions as Record<string, unknown>), paths } }
  writeFileSync(outFile, JSON.stringify(derived, null, 2) + '\n')
  // 基线自证（R↓）：paths 若指向不存在的目录，tsc 会**静默回落** node_modules（=旧宿主/未安装），
  // 于是"无类型错误"变成假阳性。存在性检查 + --listFiles 命中数把假阳性变成可读事实。
  // 只校验**被改写的**条目——`react` 这类与宿主无关的值原样保留，从 client 目录看本就不该存在。
  const missing = Object.entries(paths)
    .filter(([key]) => remapped.has(key))
    .filter(([, targets]) => !targets.some((t) => existsSync(resolve(baseDir, t))))
    .map(([key]) => key)
  if (missing.length) {
    fail(`${label}: 派生 paths 指向缺失目录（${missing.length} 条）: ${missing.join(', ')}\n`
      + `  说明 _tmp/host-${version}/ 解包不全 → 补跑: dsh-develop host-fetch ${version} <pkg...>`, 2)
  }
  console.log(`[dsh-develop] ${label}: 派生 ${basename(outFile)}，paths ${Object.keys(paths).length} 条全部命中`)
  const args = ['-p', basename(outFile), '--noEmit']
  const r = run(tscBin, args, { cwd: baseDir, quiet: true })
  const listed = run(tscBin, [...args, '--listFiles'], { cwd: baseDir, quiet: true })
  const hostFiles = listed.stdout.split('\n').filter((l) => l.includes(fileMarker)).length
  if (hostFiles === 0) fail(`${label}: 解包宿主文件命中 0 —— 派生 paths 未生效，结论不可用`, 2)
  console.log(`[dsh-develop]   ${label}: 实测载入解包宿主 ${hostFiles} 个文件`)
  return { status: r.status, output: (r.stdout + r.stderr).trim(), hostFiles }
}

/**
 * typecheck-host — 用**仓库内解包的宿主**（host-fetch 产物）对类型面做对账。
 *
 * 为什么存在（R↓，0.1.5-rc.1 适配轮）：正式 tsconfig 的 `paths` 硬编码指向**本机 DSH 安装**
 * （用户要求回家后再升级 → 仍是旧版）。于是"新版宿主下哪里会红"在本地无法回答，只能人肉读 .d.ts。
 * 本命令生成**一次性派生 tsconfig**（`tsconfig.host-<version>.local.json`，与基准同目录、gitignore）：
 *   - 编译选项逐字继承基准（JSONC 解析后仅覆写 `paths`；两份不漂移）
 *   - `paths` 指向 `_tmp/host-<version>/@deepseek-ai/*`（host-fetch 解包产物）
 *   - 产物不进仓、不动本机安装、不改正式 tsconfig
 *
 * 用法: dsh-develop typecheck-host <version>
 * 退出码: 0 两份全过 / 2 有类型错误（原文打印，即适配清单）
 */
function cmdTypecheckHost(version?: string): void {
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    fail('typecheck-host 需要宿主版本号: dsh-develop typecheck-host <x.y.z[-rc.n]>（先跑 host-fetch）')
  }
  const hostRoot = join(REPO_ROOT, '_tmp', `host-${version}`)
  if (!existsSync(hostRoot)) {
    fail(`未找到 ${hostRoot} —— 先跑: dsh-develop host-fetch ${version}`, 1)
  }
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const marker = `host-${version}/@deepseek-ai/`
  const halves = [
    {
      label: 'node',
      base: join(HOOKS_DIR, 'tsconfig.json'),
      out: join(HOOKS_DIR, `tsconfig.host-${version}.local.json`),
      prefix: `../../_tmp/host-${version}`,
    },
    {
      label: 'client',
      base: join(HOOKS_DIR, 'client', 'tsconfig.json'),
      out: join(HOOKS_DIR, 'client', `tsconfig.host-${version}.local.json`),
      prefix: `../../../_tmp/host-${version}`,
    },
  ]
  console.log(`[dsh-develop] typecheck-host ${version}（解包宿主 → _tmp/host-${version}/）`)
  const failures: string[] = []
  for (const half of halves) {
    if (!existsSync(half.base)) { failures.push(`${half.label}: 基准 tsconfig 缺失`); continue }
    const r = runHostTypecheckHalf(tscBin, version, half.base, half.out, half.prefix, half.label, marker)
    if (r.status !== 0) {
      console.log(r.output)
      failures.push(`${half.label}: tsc exit ${r.status}`)
    } else {
      console.log(`[dsh-develop] ✓ ${half.label} 半：新宿主 ${version} 下无类型错误`)
    }
  }
  if (failures.length) fail(`typecheck-host 失败（${failures.join(' / ')}）——以上条目即适配清单`, 2)
  console.log(`[dsh-develop] ✓ typecheck-host 通过（宿主 ${version}，node + client）`)
}

function cmdReadDsh(relPath?: string, start?: string, end?: string): void {
  // 诊断工具：读取 staging DSH 源码或任意文件片段（sed 式行范围；独立进程不受工具守卫约束）
  if (!relPath) fail('read-dsh 需要相对路径（如 packages/core/tools/src/index.ts）或绝对路径')
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const staging = readlinkSafe(join(dshHome, 'source', 'current'))
  const file = relPath.startsWith('/') ? relPath : join(staging, relPath)
  if (!existsSync(file)) fail(`路径不存在: ${relPath}`, 2)
  if (statSync(file).isDirectory()) {
    const out = readdirSync(file).map((n) => {
      const p = join(file, n)
      return (statSync(p).isDirectory() ? 'd ' : 'f ') + n
    })
    console.log(out.join('\n'))
    return
  }
  const s = start ? String(parseInt(start, 10) || 1) : '1'
  const e = end ? String(parseInt(end, 10) || 1) : undefined
  const sedArgs = e ? ['-n', `${s},${e}p`, file] : ['-n', `${s},$p`, file]
  const r = run('sed', sedArgs, { cwd: staging, quiet: true })
  if (r.status !== 0) fail(`读取失败: ${r.stderr}`, 2)
  console.log(r.stdout)
}

function cmdDumpConfig(pattern?: string): void {
  // v1.30.12：机械验证 profile 合成结果——宿主 `dsh --dump-config` 与 boot 走**同一个**
  // applyEntryPatches（app-boot 注释明示"a dump can never drift from what boots"），
  // 因此可用它核对 bundle patch（如禁用 web-fetch-http）是否真的生效。
  const dshBin = process.env.SERENITY_DSH_BIN ?? join(HOME_DIR, '.npm-global', 'bin', 'dsh')
  const bin = existsSync(dshBin) ? dshBin : 'dsh'
  const profile = process.env.SERENITY_DSH_PROFILE ?? 'web'
  const r = run(bin, ['--profile', profile, '--dump-config'], { cwd: REPO_ROOT, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`dsh --dump-config 失败 (exit ${r.status})`, 2)
  }
  if (!pattern) {
    console.log(r.stdout)
    return
  }
  const re = new RegExp(pattern, 'i')
  const all = r.stdout.split('\n')
  const keep = new Set<number>()
  all.forEach((line, i) => {
    if (re.test(line)) {
      keep.add(i - 1)
      keep.add(i)
      keep.add(i + 1)
    }
  })
  if (keep.size === 0) {
    console.log(`[dsh-develop] --dump-config 无匹配: ${pattern}`)
    return
  }
  console.log(all.filter((_, i) => keep.has(i)).join('\n'))
}

/**
 * 🔴 **`diag` 已退役（2026-09-24 S142）** —— 它的对象是 **ACC autopilot 的"唤起条件链"**，
 * 而该机制已随 **v1.35.0 ACC 侧 autopilot 整段退场**删除（提交 `2386f6f`；判据唯一实现
 * `hooks/dsh-serenity-hooks/src/autopilot-chain.ts` 已不在仓里）。
 *
 * **本命令是那次退场的漏网消费者**：退场清单覆盖了 `acc-diag` ④ 段与 `container_admin autopilot`
 * 域，**漏了开发面这一条** ⇒ 自 v1.35.0 起每次调用都 `exit 2`
 * （`Cannot find module '…/autopilot-chain.js'`）—— 症状看着像"环境缺模块"，实为**对象已不存在**。
 *
 * **为什么删而不是重写**（R↓，与既有书面裁决一致）：`acc-diag` 行的 v1.35.0 标注写着
 * **「不留第二份条件链、也不留半死的手写版」** ⇒ 重写一份"离线条件链"正是该条否掉的东西。
 * 且"为什么这轮没唤起"这个**已登记缺口**（插件仓 `docs/acc-autopilot-retirement.md` §8/§9）
 * **不因保留本命令而闭合**（它当年渲染的是 autopilot 的条件，不是 CRO / 注册表的事实）。
 *
 * **替代品（命令输出里也印）**：运行态诊断 = **`dashboard` 的 `diag` 动作**（v1.106.0 起，
 * 原专属工具 `acc-diag` 已并入，**常驻可见、无需任何声明**：live ／ 时钟态 ／ CRO 已启用 ／
 * 注册表未来+已过期项）；**离线**想看一眼唤醒态 = **直接读 `<CCC>/AGENT_SESSIONS/wake-registry.json`
 * 与 `<CCC>/AGENT_SESSIONS/cro-state.json`**（数据是它们自己的真相源，**不复制判据**）。
 */

/**
 * 🔴 **退出码 = 2**（不是 0）：这是一条**已失效**的命令 —— 退出 0 会让调用方以为"诊断跑通了"。
 * 保留命令名而不整条从 CLI 摘掉的理由：老习惯（含我自己）仍会敲它，**路牌**比
 * `Cannot find module '…/autopilot-chain.js'` 有用得多 —— 后者看着像"环境缺模块"。
 */
function cmdDiag(): void {
  console.error('[dsh-develop diag] 🔴 本命令已退役（对象已不存在）')

  console.error('  · 对象 = ACC autopilot 的「唤起条件链」；该机制随 v1.35.0 ACC 侧 autopilot 退场一并删除')
  console.error('    （判据唯一实现 hooks/dsh-serenity-hooks/src/autopilot-chain.ts 已不在仓里，提交 2386f6f）。')
  console.error('  · 本命令是那次退场的漏网消费者 ⇒ 自 v1.35.0 起恒 exit 2，与"环境缺模块"无关。')
  console.error('  · 不留重写版：acc-diag 行的既有裁决 = 「不留第二份条件链、也不留半死的手写版」。')
  // ⚠️ v1.106.0：`acc-diag` 已并入常驻的 `dashboard diag`（owner 2026-11-01 裁「方案 C」，
  //    `exclusiveTools` 机制同批删除）⇒ 此处**必须**跟着改，否则这是一块把人引向
  //    已不存在的工具的路牌（D262：报错要指路 —— 指错路比不指更坏）。
  console.error('  ⇒ 运行态诊断：`dashboard` 的 `diag` 动作（常驻，无需声明：live ／ 时钟态 ／ CRO 已启用 ／ 注册表未来+已过期项）')
  console.error('  ⇒ 离线看一眼唤醒态：直接读 <CCC>/AGENT_SESSIONS/wake-registry.json 与 cro-state.json')
  process.exit(2)
}

function cmdApiStatus(path?: string): void {  // 查询本地 dsh web HTTP 接口（同步阻塞版；避免异步回调在 bun 进程退出前未执行）
  const urlPath = path ?? '/serenity/status?workspace=' + (process.env.SERENITY_CCC_ROOT ?? '')
  const code = `const http = require('node:http');
const req = http.request({ host: '127.0.0.1', port: 3080, path: ${JSON.stringify(urlPath)}, method: 'GET', headers: { 'cache-control': 'no-store' } }, (res) => {
  let data = '';
  res.on('data', c => data += c.toString('utf-8'));
  res.on('end', () => {
    console.log('HTTP ' + res.statusCode);
    console.log(data.slice(0, 1200));
  });
});
req.setTimeout(10000, () => req.destroy(new Error('timeout')));
req.on('error', e => { console.error('request failed: ' + e.message); process.exit(2); });
req.end();`
  const r = run('node', ['-e', code], { cwd: process.cwd(), quiet: true })
  if (r.status !== 0 && !r.stdout) { console.error(r.stderr); process.exit(r.status) }
  console.log(r.stdout)
}

function cmdRestartWeb(): void {
  // 重启 dsh web：kill 旧进程 → 等待端口释放 → rc.6 CLI 启动新进程（setsid 脱离，nohup 后台）
  // 公开版适配：运行时 = 已安装 CLI（~/.npm-global/bin/dsh），非 staging 源码（旧架构）
  // v1.22.1 稳定性修复：kill 后同时等待 3080 + 3081 释放（gateway 第二端口常被旧进程占用，
  // 只等 3080 → 新进程 gateway listen EADDRINUSE → 崩溃，表现为"restart 不成功，需手动启动"）
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const cliBin = join(process.env.HOME ?? '', '.npm-global', 'bin', 'dsh')
  const npmDsh = join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = existsSync(npmDsh) ? npmDsh : cliBin
  const PORT = 3080
  const GATEWAY_PORT = 3081
  if (!existsSync(bin)) fail(`dsh CLI 缺失: ${bin}`, 2)

  // 1) 找到旧 web 进程并 kill（含残留：匹配 bin.js web / bin/dsh web）
  const ps = run('bash', ['-c', `ps aux | grep -E 'dsh/lib/bin\\.js web|bin/dsh web' | grep -v grep | awk '{print $2}'`], { cwd: process.cwd(), quiet: true })
  const pids = ps.stdout.trim().split('\n').filter(Boolean)
  if (pids.length === 0) console.log('[dsh-develop]    无旧 web 进程')
  for (const pid of pids) {
    console.log(`    kill ${pid}`)
    run('kill', [pid], { cwd: process.cwd(), quiet: true })
  }
  // 2) 轮询等待端口释放（最多 15s；EADDRINUSE 根因：kill 后旧进程未完全退出 / gateway 端口未释放）
  const waitForPortsFree = (): boolean => {
    for (let i = 0; i < 15; i++) {
      const probe = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -qE ':(${PORT}|${GATEWAY_PORT}) ' && echo busy || echo free`], { cwd: process.cwd(), quiet: true })
      if (probe.stdout.trim().includes('free')) return true
      run('sleep', ['1'], { cwd: process.cwd(), quiet: true })
    }
    return false
  }
  if (!waitForPortsFree()) {
    console.error(`[dsh-develop] ⚠️ 端口 ${PORT}/${GATEWAY_PORT} 15s 内未释放，尝试强杀`)
    const hard = run('bash', ['-c', `ss -ltnp 2>/dev/null | grep -E ':(${PORT}|${GATEWAY_PORT}) ' | grep -oP 'pid=\\K[0-9]+' | sort -u`], { cwd: process.cwd(), quiet: true })
    for (const pid of hard.stdout.trim().split('\n').filter(Boolean)) {
      run('kill', ['-9', pid], { cwd: process.cwd(), quiet: true })
    }
    run('sleep', ['2'], { cwd: process.cwd(), quiet: true })
  }

  // 3) setsid + nohup 启动新进程（rc.6 CLI web profile）
  //
  // 🔴🔴 **2026-10-18（owner 报「把 node 搞崩了」）—— 必须显式给堆上限**：
  //   本行原先是裸 `node … web` ⇒ 用 V8 **默认堆上限（本机实测 ≈4 GB）**。
  //   实测（`/tmp/dsh-web-restart-v1.69.0.log`）：进程在**启动期**就把堆推到 3.7 GB
  //   （`/proc/<pid>/status` 的 `VmHWM`），随后撞线 ⇒
  //   `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`。
  //   ⚠️ **不是内存不够**：同一时刻 `/proc/meminfo` 的 `MemAvailable` ≈17 GB（物理 31 GB）
  //   ⇒ 真正的病是「**给自己设的上限低于自己的峰值**」，机器还有一半空着。
  //
  //   ⇒ 判据：**上限按机器容量推导，不写死一个数字**（写死会在换机器/加负载时再次贴线）。
  //   取 `MemTotal × 0.6`，并夹在 [4 GB, 16 GB]：
  //     · 下限 4 GB = 不低于 Node 默认值（换到小机器时行为不回退）
  //     · 上限 16 GB = 给宿主 UI / chromium / 其他 CCC 留出余量（本机 31 GB 的一半以上）
  //   🔵 为什么是 0.6 而不是 0.8：宿主的峰值里有一部分是**可回收的年轻代**，
  //      留出空间能让 GC 正常工作；贴太紧会让 V8 提前进入"越 GC 越慢"的形态。
  //
  //   `--max-old-space-size` 只调**老生代**；总 RSS 会略高，因此上限不能再收紧。
  const heapMb = ((): number => {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8')
      const m = /^MemTotal:\s+(\d+)\s+kB$/m.exec(meminfo)
      if (!m) return 8192
      const totalMb = Math.floor(Number(m[1]) / 1024)
      return Math.max(4096, Math.min(16384, Math.floor(totalMb * 0.6)))
    } catch {
      // 读不到 meminfo（非 Linux / 受限容器）⇒ 退回一个仍然高于默认值的稳妥档
      return 8192
    }
  })()
  const log = `/tmp/dsh-web-restart-v${currentVersion().pkg}.log`
  console.log(`[dsh-develop]    堆上限 --max-old-space-size=${heapMb} MB（按 MemTotal 推导）`)
  // 🔴 2026-10-18（owner 令「我们 dsp 占用内存不能过多」）—— 加**按需**诊断报告开关：
  //   进程收到 SIGUSR2 时把 V8 诊断报告写到 `--report-directory`（默认 cwd）。
  //   报告按**堆空间分项**报数（old_space / large_object_space / code_space / external_memory），
  //   这正是「4.87 GB 到底是什么」缺的那一维 —— 只靠 RSS 与 VmHWM 只能知道"多"，
  //   说不出"多在哪一份里"。
  //   ⚠️ **默认不开 `--report-on-fatalerror`**：那会在 OOM 崩溃时额外写盘，崩溃现场要的是"能重启"，
  //      而不是再抢一次 IO。分析用信号按需触发即可 ⇒ 平时**零开销**（无定时器、无采样）。
  const reportDir = join(process.env.HOME ?? '', '.dsh', 'logs', 'heap-reports')
  try {
    mkdirSync(reportDir, { recursive: true })
  } catch {
    /* 建不出来就不带该 flag（不因诊断能力让宿主起不来） */
  }
  const reportFlags = `--report-on-signal --report-signal=SIGUSR2 --report-directory=${reportDir} --report-filename=heap-${Date.now()}.json`
  console.log(`[dsh-develop]    诊断报告：kill -USR2 <pid> ⇒ ${reportDir}`)
  // 报告 flag 用环境变量传（Node 认 NODE_OPTIONS 里的诊断类 flag），
  // 这样不必拼进 setsid 的命令串、也不会与 --max-old-space-size 的位置耦合。
  const cmd = `cd ${process.env.HOME ?? ''} && NODE_OPTIONS="${reportFlags}" setsid nohup node --max-old-space-size=${heapMb} ${bin} web > ${log} 2>&1 < /dev/null & disown`
  const r = run('bash', ['-c', cmd], { cwd: process.cwd(), quiet: true })
  if (r.status !== 0) fail(`web 启动失败: ${r.stderr}`, 2)
  console.log(`[dsh-develop] ✓ web 已重启（bin: ${bin}，日志: ${log}）`)
  console.log(`[dsh-develop]   等待 18s 后健康检查（curl /serenity/status，端口 ${PORT}）...`)
  run('sleep', ['18'], { cwd: process.cwd(), quiet: true })
  // 端口确认（主端口 + gateway 第二端口）
  const portCheck = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -q ':${PORT} ' && echo LISTENING || echo DOWN`], { cwd: process.cwd(), quiet: true })
  const gwCheck = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -q ':${GATEWAY_PORT} ' && echo LISTENING || echo DOWN`], { cwd: process.cwd(), quiet: true })
  const health = run('curl', ['-s', 'http://127.0.0.1:3080/serenity/status?workspace=' + (process.env.SERENITY_CCC_ROOT ?? '')], { cwd: process.cwd(), quiet: true })
  const statusLine = health.status === 0 && health.stdout ? health.stdout.trim().slice(0, 400) : ''
  console.log(`[dsh-develop] 端口: 主=${portCheck.stdout.trim()} 网关=${gwCheck.stdout.trim()}`)
  console.log(statusLine ? `[dsh-develop] ✓ 状态: ${statusLine}` : '[dsh-develop] ⚠️ 健康检查未返回（检查日志）')
  if (statusLine) {
    try {
      const st = JSON.parse(statusLine) as { safeModeOn?: boolean; restrict?: { lastSuccess?: boolean | null; lastError?: string | null; activeKeys?: string[] } }
      console.log(`[dsh-develop] safeModeOn=${st.safeModeOn} restrict.lastSuccess=${st.restrict?.lastSuccess} activeKeys=${JSON.stringify(st.restrict?.activeKeys ?? [])}${st.restrict?.lastError ? ` lastError=${st.restrict.lastError}` : ''}`)
    } catch { /* 解析失败忽略 */ }
  }
}

function cmdVersion(): void {
  const v = currentVersion()
  console.log(`package.json      ${v.pkg}`)
  console.log(`dsh.plugin.json   ${v.plugin}`)
  console.log(`CHANGELOG.md      ${v.changelog ?? '(无条目)'}`)
  const drift = new Set([v.pkg, v.plugin, v.changelog])
  if (drift.size > 1) console.log('⚠️ 版本漂移！三处不一致（ACC_VERSION 从 package.json 派生）')
  else console.log('✓ 版本一致')
}

/**
 * `run-trajectory-test <轨迹目录名> [测试文件名]` —— **跑某条轨迹自己的自测脚本**（Mech，只读）。
 *
 * ## 为什么这个子命令必须存在（2026-10-24，guard 报障引出）
 *
 * 容器里**没有给轨迹的本地执行通道**：无 bash ／ 无通用 exec MSM ／ `sys` 白名单**无 `bun`**。
 * 而 guard 的 CRO 程序是 **bun .ts**，它的 23 例自测**只能**由别人代跑
 * ⇒ 那是**单点依赖**：他改一行措辞都要等我的轮次（他自己在 SESSION 里记为「唯一还欠的一次绿」）。
 *
 * ⇒ 本子命令把那件事变成一个**可自助的窄入口**：给轨迹目录名，跑它目录里的 `*.dev.test.ts`
 *   （或显式给文件名），把 stdout/stderr 原样透出。
 *
 * ## 边界（写在这里免得后人扩大它）
 * - 🔴 **只读被跑的对象**：本命令**不写**目标轨迹目录的任何文件，也不替它改代码。
 * - 🔴 **不碰 `src/`，不发版**：纯开发工具面，与插件产物无关。
 * - ⚠️ **只在 scratch 上改代码是调用方的事**：本命令**只负责跑**，不复制、不改写。
 *   guard 的纪律是「⛔ 不改自己的活程序」⇒ 他改副本、指本命令去跑副本目录。
 * - 🔴 **bun 路径可从 env 覆盖**（`SERENITY_BUN`），缺省 `~/.bun/bin/bun`。
 *
 * @param rest `[轨迹目录名, 测试文件名?]`
 */
function cmdRunTrajectoryTest(rest: string[]): void {
  const [trajectoryDir, explicitFile] = rest
  if (!trajectoryDir) {
    fail('run-trajectory-test 需要轨迹目录名: dsh-develop run-trajectory-test "<AGENT_SESSIONS 下的目录名>" [测试文件名]')
  }
  const root = resolve(REPO_ROOT, '../..') // AI_LAB/dsh-serenity-plugin → CCC 根（home-serenity）
  const target = join(root, 'AGENT_SESSIONS', trajectoryDir)
  if (!existsSync(target)) fail(`轨迹目录不存在: ${target}`)

  // 缺省挑它目录里的 *.dev.test.ts（本仓约定；显式给文件名可覆盖）
  //
  // 🔴 **2026-11-04：支持 `tests/` 子目录**（轨迹目录清理）。判据与边界：
  //
  // 背景 —— 本轨迹根目录曾平铺 **60 个** `*.dev.test.ts`，把身份文件埋掉了；
  // 清理时它们被移进 `tests/`。若本命令只扫根，那次清理会**静默打断**唯一测试通道
  // （报「目录里没有 *.dev.test.ts」，而文件明明在）。
  //
  // 判据：**先扫根，根没有再看 `tests/`**（⛔ 不合并两处）。
  //   合并会让"同名的两个测试"变成一个说不清的歧义；分开则"根优先"是明确规则。
  // ⚠️ 仍然只认**一级**目录（`tests/` 的下层不再递归）：`_retired/` 这类归档子目录
  //   里的退役脚本**不该被当成当前测试**跑 —— 它们是留档，不是门禁。
  let testFile = explicitFile
  if (!testFile) {
    const searchDirs = [target, join(target, 'tests')]
    let found: { dir: string; files: string[] } | null = null
    for (const d of searchDirs) {
      if (!existsSync(d)) continue
      const candidates = readdirSync(d).filter((f) => f.endsWith('.dev.test.ts'))
      if (candidates.length > 0) {
        found = { dir: d, files: candidates }
        break
      }
    }
    if (!found) fail(`目录里没有 *.dev.test.ts（已查 ${searchDirs.join(' 、 ')}）`)
    if (found.files.length > 1) {
      fail(`目录里有多个 *.dev.test.ts（${found.files.join(', ')}）⇒ 请显式指定文件名`)
    }
    testFile = found.files[0]
    return runTrajectoryTestFile(join(found.dir, testFile), found.dir)
  }
  // 🔴 显式给文件名时**同样两处都找**（与缺省路径同一判据）。
  //    ⛔ 否则会出现「不给名字能找到、给了名字反而找不到」—— 那是同一事实的两套规则。
  for (const d of [target, join(target, 'tests')]) {
    const p = join(d, testFile)
    if (existsSync(p)) return runTrajectoryTestFile(p, d)
  }
  return runTrajectoryTestFile(join(target, testFile), target) // 落到统一报错
}

/**
 * 跑一个确定的测试文件（`cmdRunTrajectoryTest` 的尾半段）。
 *
 * 拆出来是因为"找文件"与"跑文件"是两件事：前者有两条路径（根 ／ `tests/`），
 * 后者只有一条。⛔ 别为了让一个函数容纳两条路径而把尾部复制两份（那就是两份会漂的实现）。
 *
 * `cwd` 取**测试文件所在目录**：轨迹自测常按 `./xxx` 相对路径取同目录素材。
 */
function runTrajectoryTestFile(testPath: string, cwd: string): void {
  if (!existsSync(testPath)) fail(`测试文件不存在: ${testPath}`)

  const bun = process.env.SERENITY_BUN ?? join(HOME_DIR, '.bun', 'bin', 'bun')
  if (!existsSync(bun)) fail(`找不到 bun: ${bun}（可用 SERENITY_BUN 覆盖）`)

  console.log(`[dsh-develop] run-trajectory-test: ${testPath}`)
  console.log(`[dsh-develop] bun: ${bun}（cwd = ${cwd}；只读，不改该目录任何文件）`)
  // ⚠️ 用 pipe 再回放：要拿到 exit code，同时把被测程序的原话**逐字**透出（不夹杂工具噪音）
  const r = spawnSync(bun, [testPath], {
    cwd,
    encoding: 'utf-8',
    timeout: 300_000,
    env: process.env,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.error) fail(`执行失败: ${String(r.error.message ?? r.error)}`)
  console.log(`[dsh-develop] ${r.status === 0 ? '✓ 自测通过' : `✗ 自测失败（exit ${r.status}）`}`)
  if (r.status !== 0) process.exit(r.status ?? 2)
}

function cmdBump(version?: string): void {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('bump 需要版本号: dsh-develop bump <x.y.z>')
  for (const f of ['package.json', 'dsh.plugin.json']) {
    const p = join(HOOKS_DIR, f)
    const j = readJson(p)
    j.version = version
    writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf-8')
  }
  console.log(`[dsh-develop] ✓ version → ${version}（package.json + dsh.plugin.json；CHANGELOG 需手动补条目）`)
}

/**
 * 检测 profile 是否已通过 bundle 层挂载插件（npm-install / `dsh plugin add` 写入
 * package.json `dsh.profile.bundles`）。存在 → deploy 不得再写 cordis.patch.yml insert
 * （双挂载 → duplicate loader entry id: serenity-hooks）。
 */
function profileBundleMounted(dshHome: string, profile: string): boolean {
  const candidates = [
    join(dshHome, 'profiles', profile, 'package.json'),
    join(dshHome, 'profiles', 'package.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf-8')) as {
        dsh?: { profile?: { bundles?: unknown }; bundle?: { patch?: string } }
      }
      const dsh = j.dsh
      if (!dsh || typeof dsh !== 'object') continue
      const bundles = dsh.profile?.bundles
      if (Array.isArray(bundles) && bundles.includes('@shgroup/dsh-serenity-hooks')) return true
      if (typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch.includes('dsh-serenity-hooks')) return true
    } catch {
      /* 解析失败忽略 */
    }
  }
  return false
}

/**
 * 从 cordis.patch.yml 文本中幂等移除含目标 id 的顶层 `- insert:` 块。
 * 返回清理后的文本；未找到该块返回 null（调用方无需写回）。
 */
function stripInsertBlock(content: string, id: string): string | null {
  const lines = content.split('\n')
  const out: string[] = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (/^-\s*insert:/.test(line)) {
      // 扫描该 insert 块（到下一个 0 缩进非注释行）是否含目标 id
      let j = i + 1
      let hasId = false
      while (j < lines.length) {
        const l = lines[j]!
        if (l.trim() !== '' && !/^\s/.test(l) && !l.startsWith('#')) break
        if (l.includes(`id: ${id}`)) {
          hasId = true
          break
        }
        j++
      }
      if (hasId) {
        removed = true
        i = j // 跳过整个块（j 指向下一块首行或 EOF）
        continue
      }
    }
    out.push(line)
    i++
  }
  if (!removed) return null
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * publishFileList — **「发布物」的唯一定义**：`npm pack --dry-run --json` 报出的文件清单。
 *
 * 🔴 **为什么要有它**（S142 2026-09-24 10:3x 取证）：deploy 以前用**黑名单** `cpSync` 复制**工作树**
 * （只排除 `tests/src/.pnpm-store/client/node_modules` ＋ 两个后缀），而 `publish` 走
 * `package.json` 的**白名单** `files[]` ⇒ **「发布物」有两个各自演化的定义**。实测后果（本机安装副本）：
 * 多出 **11 类**发布物外条目（`coverage/ experiments/ pnpm-lock.yaml pnpm-workspace.yaml
 * tsconfig.host-*.local.json ×5 tsdown.config.ts tsdown.prepare.config.ts vitest.config.ts`），
 * 并**反向缺 `dsh.plugin.json`**（它在 `files[]` 里，却被那条 filter 的 `endsWith` 排掉）。
 * ⇒ 改为**白名单驱动**：副本集合直接取自发布物自身，**两套定义合一**（副本 = 发布物，逐条相同）。
 *
 * 🔴 **`--ignore-scripts` 是硬约束，不是优化**：`npm pack` 会跑 `package.json` 的 `prepare`
 * （`tsdown --config tsdown.prepare.config.ts`——**只构建 Node 半**），而 cmdDeploy 的 1/4 步
 * 已用 cmdBuild 建好**双 bundle**；让 prepare 在 pack 时再跑一次会**清掉 `lib/client.js`**
 * ⇒ 副本缺 client bundle（**v1.26.15 同类事故形态**：DSH web 激活抛 `MissingClientBundleError`）。
 * 本函数**先证清单含双 bundle 再返回**（前置断言，见下）——防的就是"prepare 失效后照样往下拷"。
 */
function publishFileList(): string[] {
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  const dry = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: HOOKS_DIR,
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  })
  if (dry.status !== 0) {
    console.error(dry.stdout + dry.stderr)
    fail(`deploy: npm pack --dry-run 失败 (exit ${dry.status})——取不到发布物清单，中止（不猜）`, 2)
  }
  let files: string[] = []
  try {
    const parsed = JSON.parse(dry.stdout) as Array<{ files?: Array<{ path?: string }> }>
    files = (parsed[0]?.files ?? []).map((f) => String(f.path ?? '')).filter((f) => f.length > 0)
  } catch {
    fail(`deploy: npm pack --dry-run 输出解析失败（非预期 JSON）：\n${dry.stdout.slice(0, 400)}`, 2)
  }
  // 路径守卫：发布物清单只应是**包内相对路径**。出现绝对路径或上跳 ⇒ 判据本身可疑，绝不往下拷。
  const bad = files.filter((f) => f.startsWith('/') || f.split('/').includes('..'))
  if (bad.length > 0) fail(`deploy: 发布物清单含非法路径（${bad.join(', ')}）——中止`, 2)
  // 🔴 前置断言：**先证清单非空且含双 bundle，再动任何文件**（与 verifyTarball 的 required 同源）。
  const required = ['lib/index.js', 'lib/client.js', 'lib/invariant.js', 'assets/serenity-voyage.html', 'assets/eap-paper.md']
  const missing = required.filter((f) => !files.includes(f))
  if (missing.length > 0) {
    fail(`deploy: 发布物清单缺必需文件（${missing.join(', ')}）——疑 pack 时 prepare 被触发、--ignore-scripts 未生效，中止`, 2)
  }
  return files
}

/**
 * copyPublishProduct — 逐文件复制发布物（副本内容 ⟺ 发布物内容，逐条相同）。
 * 调用方已 `rmSync` 清空 dst ⇒ 不残留上一次的旧文件（陈旧残留正是本缺陷暴露出来的形态）。
 */
function copyPublishProduct(dst: string, files: string[]): void {
  for (const rel of files) {
    const to = join(dst, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(HOOKS_DIR, rel), to)
  }
}

/**
 * verifyCopyMatchesPublish — 复制后**回读整棵副本树**，与发布物清单逐条比。
 * 判据 = 文件相对路径集合**完全相等**；多一个或少一个都失败并**点名**（不给"大概对"）。
 *
 * 为什么这不是同义反复（它抓的是三类**静默漂移**，正是本缺陷的形态）：
 * ① **陈旧残留**（`rmSync` 失败或被 `force` 吞掉 ⇒ 上次的文件还在）；
 * ② **复制漏项**（某项没拷成）；
 * ③ **清单与盘上不符**（`files[]` 变了但没人知道）。
 */
function verifyCopyMatchesPublish(dst: string, files: string[]): void {
  const expect = new Set(files)
  const actual = new Set<string>()
  const walk = (rel: string): void => {
    for (const e of readdirSync(rel ? join(dst, rel) : dst, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else actual.add(r)
    }
  }
  walk('')
  const extra = [...actual].filter((f) => !expect.has(f)).sort()
  const missing = [...expect].filter((f) => !actual.has(f)).sort()
  if (extra.length > 0 || missing.length > 0) {
    fail('deploy: 副本 ≠ 发布物（多 ' + extra.length + ' / 少 ' + missing.length + '）'
      + (extra.length > 0 ? `\n  多出: ${extra.join(', ')}` : '')
      + (missing.length > 0 ? `\n  缺失: ${missing.join(', ')}` : ''), 2)
  }
  console.log(`    ✓ 副本 = 发布物（${actual.size} 文件，逐条相同）`)
}

function cmdDeploy(opts: { listCopySet?: boolean } = {}): void {
  // 🔴 `--list-copy-set`：**只读**印出发布物清单（= deploy 的复制集合），不动任何文件、不构建。
  // 用途：① 让"副本 = 发布物"成为**可查询的事实**（而不是文档里的形容词）；② 可被测试机械断言。
  if (opts.listCopySet) {
    const files = publishFileList().slice().sort()
    console.log(`[dsh-develop] 发布物清单（deploy 的复制集合；判据 = npm pack --dry-run --json --ignore-scripts）：${files.length} 文件`)
    for (const f of files) console.log(`  ${f}`)
    return
  }
  // 复刻 scripts/load-plugin.sh 全流程（纯 Node 实现，不依赖 bash）
  // 公开版适配（v1.16+）：运行时 = rc.6 CLI + profile（~/.dsh/profiles/node_modules），
  // staging 双锚保留为源码调试目标（旧架构，非运行时）。
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const staging = readlinkSafe(join(dshHome, 'source', 'current'))
  const appNm = join(staging, 'apps', 'cli', 'node_modules')
  const rootNm = join(staging, 'node_modules')
  // v1.16.9 修复（S134）：CLI（`dsh web`）实际从 **profiles/web/node_modules**（pnpm profile 结构）
  // 解析 bundle 插件——deploy 原只复制 profiles/node_modules（错误目标，从未被加载，
  // 导致 deploy 后 web 仍是旧版）。两处都复制：web 为实际加载路径，profiles/node_modules 历史兼容。
  const profilePkg = join(dshHome, 'profiles', 'node_modules', '@shgroup', 'dsh-serenity-hooks')
  const webProfilePkg = join(dshHome, 'profiles', 'web', 'node_modules', '@shgroup', 'dsh-serenity-hooks')
  const profileTargets = [profilePkg, webProfilePkg]
  const targets = [rootNm, appNm]

  console.log('==> 1/4 构建插件')
  cmdBuild()

  console.log('==> 2/4 复制插件（staging 双锚 + profile 双目标：profiles/node_modules + profiles/web/node_modules）')
  // 🔴 复制集合 = **发布物清单**（白名单驱动）——不再用黑名单枚举工作树（见 publishFileList 头注释）
  const publishFiles = publishFileList()
  console.log(`    发布物 ${publishFiles.length} 文件（npm pack --dry-run --json --ignore-scripts）`)
  for (const nm of targets) {
    const dst = join(nm, '@shgroup', 'dsh-serenity-hooks')
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(join(nm, '@shgroup'), { recursive: true })
    copyPublishProduct(dst, publishFiles)
    console.log(`    copied -> ${dst}`)
    verifyCopyMatchesPublish(dst, publishFiles)
  }
  // profile 真实目录（公开版运行时目标）：替换任何历史符号链接（旧 staging 时代残留）
  for (const dst of profileTargets) {
    try {
      if (lstatSync(dst).isSymbolicLink()) rmSync(dst, { force: true })
    } catch { /* 不存在或非链接 */ }
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dirname(dst), { recursive: true })
    copyPublishProduct(dst, publishFiles)
    console.log(`    copied -> ${dst}（真实目录，非链接）`)
    verifyCopyMatchesPublish(dst, publishFiles)
  }

  console.log('==> 3/4 依赖 shim（仅 staging 锚需要；profile 目标走 rc.6 profile node_modules）')
  const shims: Record<string, string> = {
    cordis: join(staging, 'vendor', 'cordis'),
    schemastery: join(staging, 'vendor', 'schemastery'),
    '@deepseek-ai/dsh-tools': join(staging, 'packages', 'core', 'tools'),
    '@deepseek-ai/dsh-agent': join(staging, 'packages', 'core', 'agent'),
    '@deepseek-ai/dsh-session': join(staging, 'packages', 'core', 'session'),
    '@deepseek-ai/dsh-llm': join(staging, 'packages', 'llm', 'llm'),
    '@deepseek-ai/dsh-host-webserver': join(staging, 'packages', 'host', 'webserver'),
  }
  for (const nm of targets) {
    const dst = join(nm, '@shgroup', 'dsh-serenity-hooks')
    mkdirSync(join(dst, 'node_modules', '@deepseek-ai'), { recursive: true })
    for (const [spec, target] of Object.entries(shims)) {
      if (existsSync(target)) {
        try { symlinkSync(target, join(dst, 'node_modules', spec)) } catch { /* 已存在 */ }
      } else {
        console.log(`    !! shim 目标缺失: ${spec} -> ${target}`)
      }
    }
  }

  // 🔴 v1.51.0（D104）**运行时依赖**的 shim（与上面的 peer shim 是两件事，别合并）：
  //   `dependencies` 里的包（`@resvg/resvg-wasm`，diagram 的光栅化器）**不由宿主提供**，
  //   而 deploy 是**文件复制**（不是 `npm install`）⇒ 不补这一步，复制过去的那份
  //   `lib/index.js` 会 `ERR_MODULE_NOT_FOUND: Cannot find package '@resvg/resvg-wasm'`
  //   ——**实测**：v1.51.0 首次 deploy 就是这么在**预检**上失败的（预检拦住了"复制成功但装不上"）。
  //   ⚠️ 只在**本机开发路径**用仓库里的（pnpm）副本：公开用户的正确路径是 `npm install`
  //   （`dsh plugin add` 会连依赖一起装，见 `cmdNpmInstall`），那条路不需要本 shim。
  const runtimeDepShims: Record<string, string> = {
    '@resvg/resvg-wasm': join(HOOKS_DIR, 'node_modules', '@resvg', 'resvg-wasm'),
    // 🔴 2026-10-16（面 E）：`ws` 是**面 E 的新运行时依赖**（`dependencies`，不由宿主提供）。
    //    —— 它与 `@resvg/resvg-wasm` **同类**（运行时依赖 shim），故**加在这一张表里**，不是 peer 那张。
    //    ⚠️ 面 E **默认关** ⇒ 不加它时症状会**更隐蔽**：deploy 预检不会红，
    //    直到有人拨开开关、连进来的那一刻才 `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`
    //    —— 而这正是 W4「干净 profile 真装一次」要拦的东西。
    //    ⚠️ 注意 `@deepseek-ai/dsh-acp` **不在此表**：它是**宿主提供的包** ⇒ 走上面的 **peer shim**（两表不许合并，D107）。
    'ws': join(HOOKS_DIR, 'node_modules', 'ws'),
  }
  for (const dst of [...targets.map((nm) => join(nm, '@shgroup', 'dsh-serenity-hooks')),
    ...profileTargets]) {
    for (const [spec, target] of Object.entries(runtimeDepShims)) {
      if (!existsSync(target)) {
        console.log(`    !! 运行时依赖 shim 目标缺失: ${spec} -> ${target}（先 dsh-develop npm-install-dev ${spec}）`)
        continue
      }
      const link = join(dst, 'node_modules', spec)
      mkdirSync(dirname(link), { recursive: true })
      try { symlinkSync(target, link) } catch { /* 已存在 */ }
    }
  }

  console.log('==> 4/4 profile 挂载 + 预检')
  const profileDir = join(dshHome, 'profiles', 'web')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  // v1.16.6（S134 双挂载修复）：bundle 层（package.json `dsh.profile.bundles`，npm-install
  // 写入）与 cordis.patch.yml insert **二选一**——同挂载同一 loader entry 会报
  // `duplicate loader entry id: serenity-hooks`（web 起不来）：
  //   bundle 层已挂载 → 跳过 insert 写入，并幂等移除历史写入的 insert（bundle 是公开版主路径）
  //   无 bundle 层（纯 deploy 本地开发）→ 写入 insert（唯一挂载方式）
  if (profileBundleMounted(dshHome, 'web')) {
    if (existsSync(patchFile)) {
      const cleaned = stripInsertBlock(readFileSync(patchFile, 'utf-8'), 'serenity-hooks')
      if (cleaned !== null) {
        writeFileSync(patchFile, cleaned, 'utf-8')
        console.log('    bundle 层已挂载（dsh.profile.bundles）→ 移除 cordis.patch.yml 冗余 insert（防 duplicate loader entry）')
      } else {
        console.log('    bundle 层已挂载（dsh.profile.bundles）→ 跳过 insert（cordis.patch.yml 无冗余）')
      }
    } else {
      console.log('    bundle 层已挂载（dsh.profile.bundles）→ 无需 cordis.patch.yml')
    }
  } else {
    const bundlePatch = join(HOOKS_DIR, 'cordis.patch.yml')
    if (!existsSync(bundlePatch)) fail(`插件自带 cordis.patch.yml 缺失: ${bundlePatch}`, 2)
    const insertBlock = readFileSync(bundlePatch, 'utf-8')
    if (existsSync(patchFile) && readFileSync(patchFile, 'utf-8').includes('id: serenity-hooks')) {
      console.log('    cordis.patch.yml 已包含，跳过（幂等）')
    } else {
      mkdirSync(profileDir, { recursive: true })
      const content = existsSync(patchFile) ? readFileSync(patchFile, 'utf-8') + '\n' + insertBlock + '\n' : insertBlock + '\n'
      writeFileSync(patchFile, content, 'utf-8')
      console.log(`    ${patchFile} 已写入（无 bundle 层，insert 为唯一挂载）`)
    }
  }

  // 预检：公开版从 profile/web/node_modules（CLI 实际加载路径）导入
  const preflight = run('node', ['--input-type=module', '-e',
    `const m = await import('file://${webProfilePkg}/lib/index.js'); console.log('[preflight]', m.name, '|', JSON.stringify(m.inject))`],
  { cwd: profileDir, quiet: true })
  if (preflight.status === 0 && preflight.stdout.includes('dsh-serenity-hooks')) {
    console.log(preflight.stdout.trim())
  } else {
    console.error(`    preflight 尝试失败: ${(preflight.stderr || preflight.stdout).trim().slice(0, 400)}`)
    fail('预检失败（profile 目录无法加载插件）', 2)
  }

  console.log('\n==> 完成。重启 dsh web 使插件生效。')
}

/**
 * npm-install — 官方 npm 安装路径：`dsh plugin --profile web add @shgroup/dsh-serenity-hooks`。
 * 从 npm registry 拉取包（含 lib/client.js）并自动对账 profile bundles 层，取代旧的
 * deploy（复制本地目录）。安装后需 restart-web 生效。
 *
 * 版本解析：缺省或 `latest` → 查 registry 最新版本并显式 add @<latest>（绕过
 * package.json specifier 惰性——pnpm 对未变化 specifier 报 "Already up to date"，
 * 升级后 lock 会钉旧版）；显式版本（如 1.16.3）→ 按给定版本安装。
 * @param profile - profile 名（默认 web）。
 * @param version - 精确版本或 `latest`；缺省 = latest。
 */
/**
 * npm-install [profile] [version] [registry]
 *
 * `registry`（第三参，可选——v1.31.9 新增）：**只对本次安装的子进程**用
 * `npm_config_registry` 指向该源，**不改任何 .npmrc**。
 *
 * 为什么需要它（R↓，2026-09-10 实证）：profile 的 pnpm 走**部署方的内网 Nexus 镜像**
 * （来自用户级 `~/.npmrc` 的 `registry=`，此处不写具体主机名），
 * 其 **packument 带 ~24h TTL 缓存**——我们发布新版本比 TTL 快时，Nexus 仍报**上一版**为 latest →
 * `ERR_PNPM_NO_MATCHING_VERSION`（v1.31.8 / v1.31.9 连续两次撞墙）。
 * profile 目录**没有** `.npmrc`（源来自用户级文件，在 CCC 边界外，agent 无权写）。
 *
 * ⚠️ **实测边界（勿重复试）**：`npm_config_registry` 只对 **npm** 生效，对 `dsh plugin add` 内部的
 * **pnpm 不生效**——2026-09-10 实测：同一 env 下 `npm view` 正确返回 1.31.9，而 `dsh plugin add`
 * 仍从 Nexus 拉取并失败（pnpm 的源解析被更高优先级来源压过，疑似 DSH 以显式参数传入）。
 * 故本参数**只能**修正版本发现（`latest` 分支），**不能**救活 `dsh plugin add`。
 * 本地装新版的可行出路（按成本排序）：
 *   ① **`dsh-develop deploy`**（本地构建直写 profile，**不碰 npm**）← 2026-09-10 两次实际走通的路
 *   ② 用户级操作：在 `~/.dsh/profiles/<p>/` 建 `.npmrc` 写 `registry=https://registry.npmjs.org/`（CCC 边界外）
 *   ③ 刷 Nexus 缓存（需管理权限）/ 等 ~24h TTL 过期
 */
function cmdNpmInstall(profile = 'web', version?: string, registry?: string): void {
  const cliBin = join(process.env.HOME ?? '', '.npm-global', 'bin', 'dsh')
  const npmDsh = join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = existsSync(npmDsh) ? npmDsh : cliBin
  if (!existsSync(bin)) fail(`dsh CLI 缺失: ${bin}`, 2)
  if (registry !== undefined && !/^https?:\/\//.test(registry)) fail(`registry 必须是 http(s) URL: ${registry}`, 2)
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  const registryEnv: Record<string, string> = registry ? { npm_config_registry: registry } : {}

  // 解析目标版本：
  //   · 显式版本 ⇒ 用它
  //   · `latest`  ⇒ registry 的 dist-tag latest（**显式要求"最新"时才走**）
  //   · 缺省      ⇒ 🔴 **本仓 package.json 的版本**（见下）
  const npmViewEnv = { npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...registryEnv }
  const viewVersion = (spec: string): string | null => {
    const r = run('npm', ['view', spec, 'version'], { cwd: process.cwd(), quiet: true, env: npmViewEnv })
    if (r.status !== 0) return null
    return r.stdout.trim().split('\n').pop()?.trim() || null
  }
  let target = version
  if (target === undefined) {
    // 🔴 **缺省语义修正**（2026-10-12 v1.56.1 实测逼出）：缺省**不再等于 registry `latest`**，
    //   而是"**装本仓声明的那个版本**"。
    //   为什么（实测经过）：publish 之后 dist-tag `latest` 仍会指**上一版**（发布后约 2 分钟
    //   `npm view … version` 仍返回 1.56.0）⇒ 缺省路径**照它装**：pnpm 成功、零报错、
    //   `Packages: +1`、还打印「✓ 已安装」—— 而 deploy 刚铺好的新版被**上一版覆盖**，
    //   此刻重启得到的运行态就是旧版。**每一步都报成功**是最坏的失败形态。
    //   本命令在发布链里的意图本就是"装上我刚发布的那个" ⇒ 拿本仓的版本当目标才对；
    //   `latest` 是**传播读数**，不是意图。
    const repoVer = currentVersion().pkg
    if (repoVer === '') fail('读不到本仓 hooks/dsh-serenity-hooks/package.json 的 version', 2)
    if (viewVersion(`@shgroup/dsh-serenity-hooks@${repoVer}`) === null) {
      // 🔴 **不回落 `latest`** —— 那正是要根除的动作（会静默装成上一版）。
      fail(`registry 上取不到本仓版本 ${repoVer} —— 无法确定该装哪个。\n`
        + `  两种情形，处置不同：\n`
        + `    · 刚 publish 完（传播中）⇒ 等 1~2 分钟重跑本命令（缺省路径即可）\n`
        + `    · 本仓还没发布（bump 了没 publish）⇒ 先 \`dsh-develop publish\`；`
        + `或**显式**要最新已发布版：\`dsh-develop npm-install ${profile} latest\``, 2)
    }
    target = repoVer
    console.log(`[dsh-develop] 目标 = 本仓版本 ${target}（缺省语义；已确认 registry 上有它）`)
  }
  if (target === 'latest') {
    const latest = viewVersion('@shgroup/dsh-serenity-hooks')
    if (latest === null) fail('npm view 最新版本失败', 2)
    target = latest
    console.log(`[dsh-develop] registry 最新版本: ${target}`)
    // 显式要 latest 时，若它落后于本仓 ⇒ 说一句（不是错，只是"最新"此刻指谁）
    const repoVer = currentVersion().pkg
    if (repoVer !== '' && repoVer !== target) {
      console.log(`[dsh-develop] ⚠️ 本仓 package.json = ${repoVer}，而 registry latest = ${target}`
        + ` ⇒ \`latest\` 的传播可能还没到（发布链里应缺省调用或显式给 ${repoVer}）`)
    }
  }
  const pkgSpec = `@shgroup/dsh-serenity-hooks@${target}`
  console.log(
    `[dsh-develop] npm 安装 ${pkgSpec} 到 profile '${profile}'（官方 dsh plugin add 路径）` +
      (registry ? `｜源覆盖: ${registry}` : ''),
  )
  // 🔴 tarball 传播重试（2026-10-11 v1.51.6 实测）：publish 成功后 packument **立刻**含该版本，
  //   但 tarball 的 404 会被**边缘负缓存** ⇒ 紧跟发布的 npm-install 会吃到 ERR_PNPM_FETCH_404
  //   （实测：发布后约 5 分钟 pnpm 仍报 ERR_PNPM_FETCH_404，而版本记录与 integrity 都已齐）。
  //   ⇒ **只对这一种错误**做有界重试（其余失败原样立刻报错，不掩盖真问题）。
  //   ⚠️ 总预算须留在 msm 的 600s 执行超时内 ⇒ 6 轮 × 60s ≈ 5 分钟；更长的传播延迟要手动重跑。
  const TARBALL_WAIT_ATTEMPTS = 6
  const TARBALL_WAIT_MS = 60_000
  let r: { status: number; stdout: string; stderr: string } = { status: 0, stdout: '', stderr: '' }
  for (let attempt = 1; ; attempt++) {
    r = run(bin, ['plugin', '--profile', profile, 'add', pkgSpec], {
      cwd: process.cwd(),
      quiet: true,
      env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...registryEnv },
    })
    if (r.status === 0) break
    const out = r.stdout + r.stderr
    // 🔴 2026-10-11（S142 实测）：传播延迟在 pnpm 侧有**两种**报错形态，**都要重试**——
    //   ① `ERR_PNPM_FETCH_404`（packument 已知该版本，但 tarball 还没到边缘）—— 走 `latest` 时常见
    //   ② `ERR_PNPM_NO_MATCHING_VERSION`（**packument 本身还没列出该版本**）—— **指定精确版本**时常见
    //   实测：`npm-install web 1.52.3` 在发布后 ~1 分钟报 ② 而**当场退出、一轮都不等**；
    //   同一时刻走 ① 的路径（`latest` 还是上一版）反倒能装上 ⇒ 只认 ① 会把
    //   "指定版本的正常传播等待"误判成失败（同族：把"传播"当"没上去"）。
    const isPropagation = (/ERR_PNPM_FETCH_404/.test(out) && /dsh-serenity-hooks[-\d.]*\.tgz/.test(out))
      || /ERR_PNPM_NO_MATCHING_VERSION/.test(out)
    if (!isPropagation) {
      console.error(out)
      fail(`dsh plugin add 失败 (exit ${r.status})`, 2)
    }
    if (attempt >= TARBALL_WAIT_ATTEMPTS) {
      console.error(out)
      // 🔴 2026-10-17（S142 · A65-P1 修复）：**这里曾写死一句「packument 已含 ${target}」** ——
      //   而该分支**根本没有查过 packument**（它只由 pnpm 的两个错误码触发）。
      //   实测反证：2026-10-17 报同一句话时，权威读数逐字是 `no`（latest 仍 1.59.2）
      //   ⇒ 照它信会得出「已上架、是安装端坏了」这个**反向结论**。已发作 3 次。
      //   修法（判据：**要印的处置建议，其状态断言必须当场取读数**）：先真查一次，再据实印。
      const pk = packumentHasVersion(target)
      const landed = pk.has
      fail(`dsh plugin add 失败 (exit ${r.status})：tarball 仍取不到 —— 已等 ${attempt} 轮 × 60s。\n`
        + `  实测读数（当场查，非推测）：packument 含 ${target} = **${landed ? 'yes' : 'no'}**（${pk.detail}）\n`
        + (landed
          ? `  ⇒ 包已上架但 tarball 取不到 ⇒ **传播延迟／边缘负缓存**。处置：等几分钟后重跑 \`dsh-develop npm-install\`。\n`
          : `  ⇒ 🔴 **该版本此刻还不在 registry 的权威面上** —— 这**不等于**"发布失败"（三读数可滞后，实测有慢到 ≈10 小时的样本）。\n`
            + `  ⇒ 处置：**不要重跑 publish**（同版本只会 409）。先用 \`msm("npm-registry-doctor", ["status", "${target}"])\` 取权威读数；仍为档② ⇒ 继续等。\n`), 2)
    }
    const shape = /ERR_PNPM_NO_MATCHING_VERSION/.test(out) ? 'ERR_PNPM_NO_MATCHING_VERSION' : 'ERR_PNPM_FETCH_404'
    console.log(`[dsh-develop] ⏳ 尚未传播（第 ${attempt}/${TARBALL_WAIT_ATTEMPTS} 轮；60s 后重试）`
      + ` —— ${shape}，非真失败`)
    run('sleep', ['60'], { cwd: process.cwd(), quiet: true })
  }
  console.log(r.stdout.trim() || r.stderr.trim())

  // 🔴 **装机核对**（2026-10-12 v1.56.1 实测逼出；与 D120「已提交 vs 已传播」同族）：
  //   pnpm 报 `Packages: +1` **只说明"装成功了"**，不说明"装的是你要的那个版本"。
  //   实测：缺省路径（latest）在发布后 ~2 分钟静默装成**上一版** 1.56.0 —— 全程零错误，
  //   而 deploy 刚铺好的 1.56.1 被覆盖。⇒ 装完**回读装机副本的版本**与目标对账。
  //   判据分层（读数器先证明不瞎）：**读不到 = 无法核对**（警告，不判失败）；
  //   **读得到且不等 = 真失败**（响亮，且给出可执行的处置）。
  const installedPkg = join(HOME_DIR, '.dsh', 'profiles', profile, 'node_modules', '@shgroup', 'dsh-serenity-hooks', 'package.json')
  let installed: string | null = null
  if (existsSync(installedPkg)) {
    try {
      installed = String(readJson(installedPkg).version ?? '') || null
    } catch {
      installed = null
    }
  }
  if (installed === null) {
    console.log(`[dsh-develop] ⚠️ 装机核对：读不到 ${installedPkg} —— **无法确认**装的是 ${target}（不当成失败）`)
  } else if (installed !== target) {
    // 处置按"该装哪个"给，不按 target 复读（target 可能就是错的那个）：
    // 本仓 package.json 与 target 不等 ⇒ 该装的是本仓那个版本；相等 ⇒ 只能等传播。
    // 🔴 2026-10-17（S142 · A65-P2 修复）：**原文案有两处未经取证的断言**：
    //   ① 「这不是"装不上"——pnpm 报了成功」—— 但该分支**也覆盖"pnpm 报错而旧副本还在"**，
    //      那种情况下 pnpm 并没有报成功 ⇒ 这句话在部分路径上是**假的**。
    //   ② 「原因**多半是** registry 侧还没传播到」—— 用一个"多半是"把单一成因写成结论，
    //      而**该分支从未查过 dist-tag 现值** ⇒ 真因可能是"显式版本给错"。
    //   修法（判据同 P1：状态断言必须当场取读数）：先查 packument 的 latest，再据实分诊。
    const want = currentVersion().pkg
    const pk = packumentHasVersion(target)
    const remedy = want !== '' && want !== target
      ? `用**显式版本**重跑（该路径自带传播重试）—— \`dsh-develop npm-install ${profile} ${want}\``
      : `registry 侧尚未传播到位：等 2~5 分钟后重跑 \`dsh-develop npm-install ${profile} ${target}\``
    fail(`装机核对失败：目标是 ${target}，而装机副本是 ${installed}。\n`
      + `  实测读数（当场查）：packument 含 ${target} = **${pk.has ? 'yes' : 'no'}**（${pk.detail}）\n`
      + (pk.has
        ? `  ⇒ 包已在 registry 上，但装进来的不是它 ⇒ 多半是 **dist-tag / 缓存仍指向旧版**，或**显式版本给错**。\n`
        : `  ⇒ 该版本此刻还不在 registry 的权威面上 ⇒ **传播未到位**（不是"装不上"，也不是"发布失败"）。\n`)
      + `  处置：${remedy}。`, 2)
  } else {
    console.log(`[dsh-develop] ✓ 装机核对：装机副本版本 = ${installed}`)
  }
  console.log(`[dsh-develop] ✓ 已安装 ${pkgSpec}（npm registry）→ 重启 dsh web 生效（restart-web）`)
}

/**
 * host-upgrade — 全局升级 DSH 宿主 CLI（v1.31.12，S142 D53）。
 *
 * 为什么需要（R↓）：本机运行态 = `node ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web`
 * （全局 npm 安装，见 {@link cmdRestartWeb} 的注释）。宿主要从 0.1.5-rc.1 抬到 0.1.5-rc.2 时，
 * ACC 侧**没有可用的执行通道**——safe-mode 下 agent 无 bash，`sys` 白名单（ps/ss/curl/lsof/…）
 * 不含 npm。用户裁决（2026-09-11，通道 b）：由本 MSM 内部 spawn npm 执行。
 *
 * 边界收紧（防"万能执行器"，这是本子命令的安全前提）：
 *   · 包名**硬编码** `@deepseek-ai/dsh`——不接受任意包名 ⇒ 不构成通用安装面
 *   · 参数必须匹配 `latest|next|alpha|x.y.z[-pre]` 白名单正则
 *   · 默认官方源 `https://registry.npmjs.org/`（预发布版 + 内网 Nexus packument TTL 双重风险），
 *     `--registry <url>` 可覆盖
 *   · `--dry-run` 只打印将执行的命令，不落盘
 *
 * 用法: dsh-develop host-upgrade <version|dist-tag> [--registry <url>] [--dry-run]
 */
// ── host-probe（2026-10-17，升级适配标准流程 §5.0 的第 1、2 步机械化）──
//
// 为什么有它：流程第 1 步（触发）与第 2 步（基线核实）此前全靠人肉，而这两步恰好
// 是**本轨最容易犯错的**两处 —— ① 只查 `latest` 就断言"没有新版"（rc 常常只在 `next`）；
// ② 拿 README / 发行说明当"这个版本可下载"的证据（那是两类不同的事实）。
//
// 本命令把这两步变成一次可复跑、可读数的检查：
//   ① 打印 dist-tags **全量**（latest / next / alpha / …），并把**非 latest 的更高版本**标出来
//   ② 对本机现值与"候选新版本"各自核一次 tarball 可达性（http_code）——**这才是"可下载"的证据**
//   ③ 给出下一步该跑的那条命令（host-fetch <ver>）
//
// ⚠️ 它**不判断"要不要升级"**（那是人判）；它只负责把"有没有新版 / 能不能下载"变成读数。

/**
 * 读 dist-tags（走 `curl`；本仓 `sys` 白名单与运行 `run()` 都可调 curl）。
 * @returns 标签 → 版本映射；失败返回 null（**不静默伪装成空**）
 */
function readDshDistTags(registry: string): Record<string, string> | null {
  const url = `${registry.replace(/\/$/, '')}/@deepseek-ai%2Fdsh`
  const r = run('curl', ['-s', url], { cwd: SCRIPTS_DIR, quiet: true })
  if (r.status !== 0 || !r.stdout.trim()) return null
  try {
    const doc = JSON.parse(r.stdout) as { 'dist-tags'?: Record<string, string> }
    return doc['dist-tags'] ?? null
  } catch {
    return null
  }
}

/** 核一个版本的 tarball 是否真能下载（HTTP 状态码 = 唯一判据） */
function probeTarballCode(registry: string, version: string): string {
  const url = `${registry.replace(/\/$/, '')}/@deepseek-ai/dsh/-/dsh-${version}.tgz`
  const r = run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url], { cwd: SCRIPTS_DIR, quiet: true })
  return (r.stdout.trim() || '(无响应)')
}

/** 最小版本比较（与 host/contract.ts 的 compareSemver 同规则；此处只管"谁更新"） */
function cmpVer(a: string, b: string): number {
  const parse = (v: string): [number, number, number, string] => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : [0, 0, 0, '']
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) < (pb[i] as number) ? -1 : 1
  }
  if (pa[3] === pb[3]) return 0
  if (pa[3] === '') return 1
  if (pb[3] === '') return -1
  return pa[3] < pb[3] ? -1 : 1
}

function cmdHostProbe(argv: string[]): void {
  let registry = 'https://registry.npmjs.org/'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--registry') { registry = argv[++i] ?? registry; continue }
    if (a.startsWith('--registry=')) { registry = a.slice('--registry='.length); continue }
  }
  const installedJson = join(HOME_DIR, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const current = existsSync(installedJson) ? String(readJson(installedJson).version ?? '?') : '(未安装)'
  console.log(`[dsh-develop] host-probe ｜ 源: ${registry}`)
  console.log(`[dsh-develop] 本机现值: ${current}`)

  const tags = readDshDistTags(registry)
  if (tags === null) {
    fail(`读不到 @deepseek-ai/dsh 的 dist-tags（源不可达或响应非 JSON）`, 2)
  }
  // 🔴 全量打印 —— 这正是本命令存在的理由：rc 常常只在 next/alpha 上
  console.log('[dsh-develop] dist-tags（**全量**，不是只 latest）:')
  for (const [tag, ver] of Object.entries(tags)) console.log(`    ${tag.padEnd(8)} → ${ver}`)

  const latest = tags['latest']
  // 候选 = 所有标签里**比 latest 更新**的版本（含 latest 本身）
  const candidates = [...new Set(Object.values(tags))]
    .filter((v) => latest === undefined || cmpVer(v, latest) >= 0)
    .sort((a, b) => cmpVer(b, a))
  const newest = candidates[0] ?? latest ?? ''

  if (latest !== undefined && newest !== '' && cmpVer(newest, latest) > 0) {
    const ownerTags = Object.entries(tags).filter(([, v]) => cmpVer(v, latest) > 0).map(([t]) => t)
    console.log(`[dsh-develop] 🔴 检出比 latest 更新的版本: ${newest}（在 ${ownerTags.join(' / ')} 标签上）`)
  } else {
    console.log(`[dsh-develop] 最新可见版本 = ${latest ?? '(无)'}（无更高标签）`)
  }

  // 🔴 "可下载"的唯一判据：HTTP 状态码。⛔ 不用 release notes / README 代替
  console.log('[dsh-develop] tarball 可达性（这才是"可下载"的证据）:')
  for (const v of [current, newest].filter((v) => v !== '' && v !== '(未安装)')) {
    console.log(`    ${v.padEnd(14)} → ${probeTarballCode(registry, v)}`)
  }
  console.log('')
  console.log(`[dsh-develop] 下一步（若决定适配）: dsh-develop host-fetch ${newest}`)
  console.log(`[dsh-develop]                             dsh-develop typecheck-host ${newest}`)
  console.log('[dsh-develop] 流程与禁止项: skill dsh-serenity-plugin-development → references/20-host-compat.md §5.0')
}

function cmdHostUpgrade(argv: string[]): void {
  let registry = 'https://registry.npmjs.org/'
  let dryRun = false
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--registry') { registry = argv[++i] ?? ''; continue }
    if (a.startsWith('--registry=')) { registry = a.slice('--registry='.length); continue }
    positional.push(a)
  }
  const target = positional[0]
  if (target === undefined) fail('host-upgrade 需要版本或 dist-tag（如 0.1.5-rc.2 / next / latest）', 2)
  if (!/^(latest|next|alpha|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.test(target)) {
    fail(`非法版本/dist-tag: ${target}（只接受 latest|next|alpha|x.y.z[-pre]）`, 2)
  }
  if (!/^https?:\/\//.test(registry)) fail(`registry 必须是 http(s) URL: ${registry}`, 2)

  const dshDir = join(HOME_DIR, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  const installedJson = join(dshDir, 'package.json')
  const before = existsSync(installedJson) ? String(readJson(installedJson).version ?? '?') : '(未安装)'
  const spec = `@deepseek-ai/dsh@${target}`
  console.log(`[dsh-develop] 当前宿主: ${before}（${dshDir}）`)
  console.log(`[dsh-develop] 目标: ${spec}｜源: ${registry}`)
  if (dryRun) {
    console.log(`[dsh-develop] --dry-run：将执行 npm install -g --registry ${registry} ${spec}`)
    return
  }
  // 先解析目标版本（失败信息比 npm install 的报错更直白：源不对 / 版本不存在）
  const view = run('npm', ['view', spec, 'version', '--registry', registry], { cwd: SCRIPTS_DIR, quiet: true })
  if (view.status !== 0) {
    console.error(view.stdout + view.stderr)
    fail(`npm view ${spec} 解析失败（源 ${registry}；版本不存在或源不可达）`, 2)
  }
  const resolved = view.stdout.trim().split('\n').pop() ?? ''
  console.log(`[dsh-develop] 解析结果: ${resolved || '(空)'}`)
  const r = run('npm', ['install', '-g', '--registry', registry, spec], { cwd: SCRIPTS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`npm install -g ${spec} 失败 (exit ${r.status})`, 2)
  }
  console.log((r.stdout + r.stderr).trim() || '(no output)')
  if (!existsSync(installedJson)) fail(`安装后仍找不到 ${installedJson}`, 2)
  const after = String(readJson(installedJson).version ?? '?')
  console.log(`[dsh-develop] ✓ 宿主已升级: ${before} → ${after}`)
  if (after === before) console.log('[dsh-develop] ⚠️ 版本未变——确认目标参数是否写错')
  console.log('[dsh-develop] 下一步: restart-web → dashboard health 的 dshVersion 应变为新版本')
}

// ── session-doctor（v1.31.13，S142 §24「会话损坏」调查的常备诊断）──

/**
 * 会话日志体检（**只读**）。
 *
 * 为什么存在（R↓）：宿主自 0.1.5 起读取路径是**失败即关**（fail-closed）——
 * `validateStoredEvents` 对「不在 `KNOWN_SESSION_EVENT_TYPES`（生成静态集）**且**未带
 * envelope `ignorable:true`」的事件抛 `SessionFormatUnsupportedError`
 * （"refusing to interpret the log"），对用户的表现就是**会话打不开 / 报错 / 白屏**；
 * 且格式世代迁移（v0→v3）对未知历史事件**同样拒绝**。没有本命令时，只能靠猜。
 *
 * 判定面（逐份日志，逐条给证据；**判据 version-first**）：
 *   ① 可读性：能否解压（zstd）/ 能否读行
 *   ② 结构：header 可否解析；行是否以 `{` 开头（`--deep` 时逐行 JSON.parse）
 *   ③ **版本门（在先）**：header 的 format version vs 本机宿主支持版本 ——
 *      `> supported` → `refused-version`；`< supported` → **`needs-migration`**（早停，不扫正文）；
 *      `=== supported` 才继续词表门
 *   ④ 词表门（仅当前世代）：顶层 `type` 是否在宿主已知集内；**存储行类型先剔除**
 *      （`PACKED_STORAGE_ROW_TAGS`，否则必然假阳性）
 *   ⑤ 世代：同一会话 v0/v1/v2/v3 共存情况（迁移保留源文件）
 *
 * ⚠️ **静态扫描的诚实边界**：历史世代（v0~v2）的可读性**静态不可判**——宿主会走迁移分支，
 * 迁移可能成功，也可能在**内容层**拒绝（实证：v0 含 `subagent/descriptor` version≠3 即被拒）。
 * ⇒ 真判据只有 `--probe`（宿主真实 `open(id,'read')`）。静态扫描只做**分诊**，不下最终结论。
 *
 * 真相源（单一来源，不重复维护）：词表 + 版本号从**本机安装的宿主**读取
 * （`~/.npm-global/.../dsh-session/lib/types/`），失败时回落到 hooks 的 devDependencies 副本；
 * 命令会打印实际用了哪一份。
 *
 * 用法: dsh-develop session-doctor [--root <dir>] [--session <id>] [--json] [--deep] [--probe] [--limit <n>]
 */
interface DoctorOffence { type: string; seq: number | null }

/**
 * 存储行类型（**不是事件**）：`packChunks` 打包的 Assistant chunk 行。
 * 出处：`dsh-session-persistence-jsonl/lib/worker.cjs:7724` `PACKED_TAGS`。
 * 语义：v0/v1/v2 物理布局里它们是**顶层行**；v3 把同一内容嵌进 `assistant/message.data.stream`。
 * ⇒ 静态扫描若把它们当事件送进词表，必然假阳性（§24.5 的坑，v1.31.13 首轮踩过）。
 */
const PACKED_STORAGE_ROW_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

interface DoctorReport {
  id: string
  project: string
  artifact: string
  generation: number
  generations: number[]
  sizeBytes: number
  mtimeMs: number
  headerVersion: number | null
  events: number
  malformedLines: number
  ignorableUnknown: number
  offences: DoctorOffence[]
  verdict: 'ok' | 'needs-migration' | 'refused-version' | 'refused-unknown-event' | 'malformed' | 'unreadable'
  detail: string
}

/** `session.jsonl` / `session.jsonl.zstd`（= v0）/ `session.v<N>.jsonl.zstd` */
const DOCTOR_ARTIFACT_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

function sessionStoreRoot(explicit?: string): string {
  if (explicit !== undefined) return resolve(explicit)
  return join(process.env.DSH_HOME ?? join(HOME_DIR, '.dsh'), 'sessions')
}

/** 读出某个会话目录下的日志世代（按代递增排序；同代重复时全部保留由调用方裁决） */
function sessionArtifacts(dir: string): Array<{ name: string; generation: number; path: string }> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ name: string; generation: number; path: string }> = []
  for (const name of names) {
    const m = DOCTOR_ARTIFACT_RE.exec(name)
    if (!m) continue
    out.push({ name, generation: m[1] === undefined ? 0 : Number(m[1]), path: join(dir, name) })
  }
  return out.sort((a, b) => a.generation - b.generation)
}

/**
 * 载入宿主事件词表 + 支持的格式版本。
 * 单一真相源优先级：① 本机安装的宿主（运行时实际执行的判定）② hooks devDependencies（仓库基准）。
 */
async function loadSessionVocabulary(): Promise<{ known: Set<string>; supported: number | null; source: string; versionSource: string | null }> {
  const bases = [
    join(HOME_DIR, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'types'),
    join(HOOKS_DIR, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'types'),
  ]
  for (const base of bases) {
    const knownPath = join(base, 'known-event-types.js')
    if (!existsSync(knownPath)) continue
    try {
      const mod = (await import(pathToFileURL(knownPath).href)) as { KNOWN_SESSION_EVENT_TYPES?: unknown }
      const known = mod.KNOWN_SESSION_EVENT_TYPES
      if (!(known instanceof Set) || known.size === 0) continue
      let supported: number | null = null
      let versionSource: string | null = null
      const typesPath = join(base, 'types.js')
      if (existsSync(typesPath)) {
        const m = /export const SESSION_FORMAT_VERSION = (\d+)/.exec(readFileSync(typesPath, 'utf-8'))
        if (m?.[1] !== undefined) {
          supported = Number(m[1])
          versionSource = typesPath
        }
      }
      return { known: known as Set<string>, supported, source: knownPath, versionSource }
    } catch {
      /* 换下一个候选源 */
    }
  }
  return fail('无法载入宿主事件词表（known-event-types.js）——检查本机 DSH 安装或 hooks devDependencies', 2)
}

/** 扫描单份日志（流式，内存与日志大小无关）。**判据 version-first**（见文件头 §会话日志世代）。 */
async function scanSessionArtifact(
  artifact: { name: string; generation: number; path: string },
  known: Set<string>,
  supported: number | null,
  deep: boolean,
): Promise<Pick<DoctorReport, 'headerVersion' | 'events' | 'malformedLines' | 'ignorableUnknown' | 'offences' | 'verdict' | 'detail'>> {
  let events = 0
  let malformedLines = 0
  let ignorableUnknown = 0
  let headerVersion: number | null = null
  const offences: DoctorOffence[] = []
  let compressedExit: number | null = null
  let compressedErr = ''

  let input: NodeJS.ReadableStream
  let child: ReturnType<typeof spawn> | null = null
  if (artifact.name.endsWith('.zstd')) {
    child = spawn('zstd', ['-d', '-c', artifact.path], { stdio: ['ignore', 'pipe', 'pipe'] })
    input = child.stdout as unknown as NodeJS.ReadableStream
    child.stderr?.on('data', (chunk: Buffer) => { compressedErr += chunk.toString('utf-8') })
  } else {
    input = createReadStream(artifact.path)
  }
  const closed = child
    ? new Promise<void>((done) => {
        child?.on('close', (code) => { compressedExit = code ?? 0; done() })
        child?.on('error', (e) => { compressedExit = -1; compressedErr += e.message; done() })
      })
    : Promise.resolve()
  const streamErr: { message: string | null } = { message: null }
  input.on('error', (e: Error) => { streamErr.message = e.message })
  const rl = createInterface({ input, crlfDelay: Infinity })
  const iterator = rl[Symbol.asyncIterator]()

  /** 早停收尾：必须显式关流并等 zstd 子进程回收，否则子进程变孤儿 / 管道 SIGPIPE。 */
  const stopEarly = async (): Promise<void> => {
    rl.close()
    try { child?.kill() } catch { /* 已退出 */ }
    // ⚠️ `NodeJS.ReadableStream` 这个类型面（@types/node 20）**没有声明 `destroy`**，而 Node 流运行时恒有它
    // （`typecheck-scripts` 首跑抓到）；收窄到有 `destroy` 的形状，**保留 `?.`**（语义与改前逐字相同）。
    ;(input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
    await closed
  }

  // ① 头行：格式世代。**版本门在先**——早于词表门，也早于全文件扫描。
  const first = await iterator.next()
  if (first.done !== true) {
    const line = String(first.value)
    if (line.length > 0) {
      try {
        const header = JSON.parse(line) as { version?: unknown }
        if (typeof header.version === 'number') headerVersion = header.version
      } catch {
        malformedLines++
      }
    }
  }

  // 🔴 版本门：两个来源都已知才判 —— **直接内联**而非借道布尔量，因为 TS 的**控制流收窄不穿过中间变量**
  // （`typecheck-scripts` 首跑抓到：`versionKnown && headerVersion > supported` 会被判 `possibly null`）。
  if (headerVersion !== null && supported !== null && headerVersion > supported) {
    await stopEarly()
    return {
      headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'refused-version',
      detail: `日志 format v${headerVersion} > 本机宿主支持 v${supported} → 宿主会拒绝（"written by a newer harness — upgrade the harness"）`,
    }
  }
  if (headerVersion !== null && supported !== null && headerVersion < supported) {
    // 可读性**静态不可判**：宿主对历史世代走迁移分支（`open(id,'read')` → `requireStoredMigration`），
    // 迁移**可能成功也可能在内容层拒绝**（实证：v0 日志含 `subagent/descriptor` version≠3 时被拒）。
    // ⇒ 不报"会被拒"（那是假阳性），报 `needs-migration`，真判据交给 `--probe`。
    await stopEarly()
    return {
      headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'needs-migration',
      detail: `历史世代 v${headerVersion}（本机宿主写 v${supported}）→ 可读性取决于迁移，须用 --probe 实测；版本门在先故未扫正文`,
    }
  }

  // ② 正文：仅当前世代（v3）扫词表门；存储行类型先剔除，避免假阳性。
  while (true) {
    const next = await iterator.next()
    if (next.done === true) break
    const line = String(next.value)
    if (line.length === 0) continue
    events++
    if (!line.startsWith('{')) { malformedLines++; continue }
    const tm = /"type":"([^"]+)"/.exec(line)
    if (tm?.[1] === undefined) { malformedLines++; continue }
    const type = tm[1]
    if (PACKED_STORAGE_ROW_TAGS.has(type) === false && !known.has(type)) {
      if (/"ignorable":true/.test(line)) ignorableUnknown++
      else if (offences.length < 5) {
        const sm = /"seq":(\d+)/.exec(line)
        offences.push({ type, seq: sm?.[1] === undefined ? null : Number(sm[1]) })
      }
    }
    if (deep) {
      try { JSON.parse(line) } catch { malformedLines++ }
    }
  }
  await closed

  if (streamErr.message !== null || (compressedExit !== null && compressedExit !== 0)) {
    const why = streamErr.message ?? compressedErr.trim().split('\n')[0] ?? `zstd exit ${compressedExit}`
    return { headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'unreadable', detail: `无法读取: ${why}` }
  }
  if (malformedLines > 0) {
    return { headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'malformed', detail: `${malformedLines} 行不可解析（结构损坏）` }
  }
  // 注：`headerVersion > supported` / `< supported` 已在头行处判定并早停，此处不再重复。
  if (offences.length > 0) {
    return {
      headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'refused-unknown-event',
      detail: `含未知且非 ignorable 的事件类型（宿主会拒绝整份日志）: ${offences.map((o) => `${o.type}@seq${o.seq ?? '?'}`).join(', ')}`,
    }
  }
  const note = ignorableUnknown > 0 ? `（另有 ${ignorableUnknown} 条未知但 ignorable 的事件：宿主语义为保留不解释，安全）` : ''
  return { headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'ok', detail: `当前世代（v${headerVersion ?? '?'}）事件 ${events} 条全部在已知词表内${note}` }
}

/** 枚举会话目录（storeRoot/<project>/<id>/ + 其日志世代） */
function collectSessionDirs(
  storeRoot: string,
  only?: Set<string>,
): Array<{ project: string; id: string; dir: string; artifacts: Array<{ name: string; generation: number; path: string }> }> {
  const out: Array<{ project: string; id: string; dir: string; artifacts: Array<{ name: string; generation: number; path: string }> }> = []
  for (const project of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(storeRoot, project.name)
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (only !== undefined && !only.has(entry.name)) continue
      const dir = join(projectPath, entry.name)
      const artifacts = sessionArtifacts(dir)
      if (artifacts.length === 0) continue
      out.push({ project: project.name, id: entry.name, dir, artifacts })
    }
  }
  return out
}

/**
 * 探针模式：把日志**复制**到临时根，交给宿主自己的 `JsonlSessionPersistence.load()` 判定。
 *
 * 为什么必须复制（R↓）：load 可能触发格式世代迁移 → 会写新世代文件；体检不得改原存储。
 * 为什么必须走宿主代码：判据是分层的（内存词表 + 存储行类型 + 逐格式 disposition 表 + 迁移规则），
 * 任何自写复刻都会产出假阳性/假阴性（实测：只用内存词表会把 `text-chunks` 打包行误报为未知事件）。
 */
async function runSessionProbe(storeRoot: string, only: Set<string> | undefined, json: boolean, limit: number | undefined, quiet: boolean): Promise<void> {
  const probeScript = join(SCRIPTS_DIR, 'session-probe.mjs')
  if (!existsSync(probeScript)) fail(`探针脚本缺失: ${probeScript}`, 2)
  const pkgBases = [
    join(HOME_DIR, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    join(HOOKS_DIR, 'node_modules', '@deepseek-ai'),
  ].filter((p) => existsSync(p))
  if (pkgBases.length === 0) fail('找不到宿主包目录（本机 DSH 安装 / hooks devDependencies）', 2)
  const say = (line: string): void => { if (!json) console.log(line) }
  const scratchRoot = join(REPO_ROOT, '_tmp', 'session-probe', `probe-${Date.now()}`)
  const candidates = collectSessionDirs(storeRoot, only)
  interface ProbeSide {
    openRead?: { ok?: boolean; events?: number | null; headerVersion?: number | null; errorName?: string; errorMessage?: string }
    migrationChannels?: Record<string, unknown>
    list?: { ok?: boolean; count?: number | null; errorName?: string; errorMessage?: string }
  }
  interface ProbeRow { project: string; id: string; file: string; generation: number; ok: boolean; events: number | null; errorName: string | null; error: string | null; side?: ProbeSide }
  const rows: ProbeRow[] = []

  // 每个会话只探测**最新世代**（`findLog` 本来就选当前世代 ⇒ 这正是"用户能不能打开"的问题）。
  // 会话数量可达数百：**批量模式**（一次 node 进程判定多个会话）把 N 次进程启动压成 N/CHUNK 次。
  const targets: Array<{ project: string; id: string; artifact: { name: string; generation: number; path: string } }> = []
  for (const c of candidates) {
    if (limit !== undefined && targets.length >= limit) break
    const latest = c.artifacts[c.artifacts.length - 1]
    if (latest === undefined) continue
    targets.push({ project: c.project, id: c.id, artifact: latest })
  }
  for (const t of targets) {
    const destDir = join(scratchRoot, t.project, t.id)
    mkdirSync(destDir, { recursive: true })
    cpSync(t.artifact.path, join(destDir, t.artifact.name))
  }

  const PROBE_CHUNK = 20
  const parsedById = new Map<string, ProbeSide & { generations?: Array<{ ok?: boolean; events?: number | null; errorName?: string; errorMessage?: string }>; errorName?: string; errorMessage?: string; debug?: unknown }>()
  for (let i = 0; i < targets.length; i += PROBE_CHUNK) {
    const chunk = targets.slice(i, i + PROBE_CHUNK)
    const args = [probeScript, scratchRoot, ...chunk.map((t) => t.id)]
    for (const base of pkgBases) args.push('--pkg-base', base)
    const r = run('node', args, { cwd: SCRIPTS_DIR, quiet: true })
    for (const lineText of r.stdout.split('\n')) {
      const line = lineText.trim()
      if (line.length === 0 || !line.startsWith('{')) continue
      try {
        const parsed = JSON.parse(line) as { id?: string } & ProbeSide & { generations?: never[]; debug?: unknown }
        if (typeof parsed.id === 'string') parsedById.set(parsed.id, parsed)
      } catch { /* 单行解析失败不影响其余会话 */ }
    }
  }

  for (const t of targets) {
    const parsed = parsedById.get(t.id)
    const gen = parsed?.generations?.[0]
    const ok = gen?.ok === true
    const errorName = gen?.errorName ?? parsed?.errorName ?? (ok ? null : 'ProbeError')
    const error = ok ? null : (gen?.errorMessage ?? parsed?.errorMessage ?? '（探针无输出）')
    // 应用面探针（open(id,'read')）与旁证字段（迁移通道 / list）**必须原样带回**：
    // 只测 readStoredLog 无法区分"存储层拒绝"与"应用层拒绝"，而用户症状由应用面决定。
    const side: ProbeSide = { openRead: parsed?.openRead, migrationChannels: parsed?.migrationChannels, list: parsed?.list }
    rows.push({ project: t.project, id: t.id, file: t.artifact.name, generation: t.artifact.generation, ok, events: gen?.events ?? null, errorName, error, side })
    const openRead = side.openRead
    const appNote = openRead === undefined
      ? '｜open: 未测'
      : `｜open ${openRead.ok === true ? `✓ 可打开（${openRead.events ?? '?'} 条）` : `✗ 打不开`}`
    if (!quiet) say(`${openRead?.ok === true ? '✓' : '✗'} ${t.id}（${t.project}）｜${t.artifact.name}｜存储层 ${ok ? '✓' : `✗ ${errorName}`}${appNote}`)
  }
  rmSync(scratchRoot, { recursive: true, force: true })

  const unopenable = rows.filter((r) => r.side?.openRead?.ok !== true)
  const storeLevel = rows.filter((r) => !r.ok)
  const byProject = (list: ProbeRow[]): string => {
    const counts = new Map<string, number>()
    for (const r of list) counts.set(r.project, (counts.get(r.project) ?? 0) + 1)
    return [...counts.entries()].sort().map(([p, n]) => `${p}=${n}`).join(' ')
  }
  const errorHistogram = (list: ProbeRow[]): Array<[string, number]> => {
    const counts = new Map<string, number>()
    for (const r of list) {
      const msg = r.side?.openRead?.errorMessage ?? ''
      // 归类到"规则级"指纹：错误文案带具体 seq/路径，须剥离才能聚合
      const key = /subagent\/descriptor/.test(msg) ? '宿主侧：v0 迁移拒绝（subagent/descriptor 版本不受支持）'
        : /lacks an identified message/.test(msg) ? '**我方 dsp 缺陷**：消息缺 id/role（rebuild 写坏日志）'
          : /message must have role/.test(msg) ? '**我方 dsp 缺陷**：消息 role 不符'
            : /no upgrade path/.test(msg) ? '宿主侧：版本门 no upgrade path'
              : /migration .* is missing/.test(msg) ? '宿主侧：迁移链缺环'
                : /unknown historical event type/.test(msg) ? '宿主侧：未知历史事件（迁移拒绝）'
                  : (r.side?.openRead?.errorName ?? 'Error')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }
  if (json) {
    console.log(JSON.stringify({
      mode: 'probe', root: storeRoot, probes: rows.length,
      openable: rows.length - unopenable.length,
      unopenable: unopenable.length,
      unopenableByProject: byProject(unopenable),
      storeLevelFailing: storeLevel.length,
      errorHistogram: errorHistogram(unopenable),
      migrationChannels: rows[0]?.side?.migrationChannels ?? null,
      list: rows[0]?.side?.list ?? null,
      pkgBases, rows,
    }, null, 2))
    return
  }
  console.log('')
  console.log(`[session-doctor] 探针 ${rows.length} 个会话（宿主真实读取路径，只读副本）`)
  console.log(`  ✓ 应用面可打开      ${rows.length - unopenable.length}`)
  console.log(`  ✗ 应用面打不开      ${unopenable.length}   ${byProject(unopenable)}`)
  console.log(`  （存储层 readStoredLog 读不出 ${storeLevel.length} —— 历史世代**必然**如此，非损坏证据）`)
  if (unopenable.length > 0) {
    console.log('  打不开的根因分布：')
    for (const [key, n] of errorHistogram(unopenable)) console.log(`    ${n.toString().padStart(4)}  ${key}`)
    if (!quiet) {
      console.log('  逐条清单：')
      for (const r of unopenable) console.log(`    ✗ ${r.id}（${r.project}）｜${r.side?.openRead?.errorName}: ${r.side?.openRead?.errorMessage}`)
    }
  } else {
    console.log('  （全部可打开）')
  }
  const first = rows[0]
  if (first?.side !== undefined) {
    console.log(`[session-doctor] 迁移通道: ${JSON.stringify(first.side.migrationChannels ?? {})}`)
    console.log(`[session-doctor] list(): ${JSON.stringify(first.side.list ?? {})}`)
  }
}

// ── refactor-move：目录/命名重构的机械改名机 ────────────────────────────

/** 递归收集某目录下的 `.ts`（跳过 node_modules / lib / coverage / dist） */
function collectTs(dir: string, out: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'lib', 'coverage', 'dist', '.git'].includes(e.name)) continue
      collectTs(p, out)
    } else if (e.isFile() && e.name.endsWith('.ts')) {
      out.push(p)
    }
  }
  return out
}

/**
 * refactor-move — 把一批模块搬到新路径，并**机械改写全仓的 import 说明符**。
 *
 * ## 为什么必须有这台机器
 *
 * 一次"域化"重构要动 **上百处** 说明符（静态 import、`import type`、动态 `import()`、
 * `vi.mock()`），且 **src 与 tests 两侧**都要改。手改必然漏。
 *
 * ## 判据（每次都用，缺一不可）
 *
 * 1. **dry-run 先看数**：移动 N 个文件 / 需改写 M 处；M 与预期量级不符 ⇒ 先查，别 apply；
 * 2. apply 后 **`typecheck` ＋ `test` 全绿**（漏改一处 typecheck 就红）；
 * 3. **工具面 14 项逐字不变**（`kernel/invariant.ts:REGISTERED_TOOLS` ↔ `dsh.plugin.json`）。
 *
 * ## 边界（只做这一件事）
 *
 * - 只改**能解析到被移动文件**的相对说明符（`./x.js` 形态）；
 * - **不碰注释行**（`//` / `*` / `/*` 开头）—— 那里的 `.js` 是散文，不是依赖；
 * - 不碰包名（`@deepseek-ai/…`）、不碰非 `.js` 字面量、不改任何导出符号名。
 *
 * 用法: dsh-develop refactor-move --map <json> [--apply]
 *   json 形态（相对 HOOKS_DIR）: { "src/old.ts": "src/new/old.ts", ... }
 */
function cmdRefactorMove(argv: string[]): void {
  const apply = argv.includes('--apply')
  const mapIdx = argv.indexOf('--map')
  const mapPath = mapIdx >= 0 ? argv[mapIdx + 1] : undefined
  if (mapPath === undefined) fail('refactor-move 需要 --map <json>（{ "src/old.ts": "src/new.ts" }）')
  if (!existsSync(mapPath)) fail(`map 文件不存在: ${mapPath}`, 2)

  const raw = readMapJson(mapPath)
  const moves: Array<{ fromRel: string; toRel: string; fromAbs: string; toAbs: string }> = []
  for (const [fromRel, toRel] of Object.entries(raw)) {
    const fromAbs = resolve(HOOKS_DIR, fromRel)
    const toAbs = resolve(HOOKS_DIR, toRel)
    if (!existsSync(fromAbs)) fail(`源文件不存在: ${fromRel}`, 2)
    if (existsSync(toAbs)) fail(`目标已存在（拒绝覆盖）: ${toRel}`, 2)
    moves.push({ fromRel, toRel, fromAbs, toAbs })
  }
  const byFrom = new Map(moves.map((m) => [m.fromAbs, m.toAbs]))

  const scanDirs = [join(HOOKS_DIR, 'src'), join(HOOKS_DIR, 'tests')]
  const files = scanDirs.flatMap((d) => collectTs(d))

  // 计划：**在移动之前**算出新内容，但记住"该写到哪"（自己也被移动时写新路径）
  const plans: Array<{ from: string; to: string; next: string; hits: number }> = []
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    const movedTo = byFrom.get(file)
    const next = rewriteSpecifiers(text, file, movedTo ?? file, byFrom)
    if (next.text !== text) plans.push({ from: file, to: movedTo ?? file, next: next.text, hits: next.hits })
  }
  const totalHits = plans.reduce((n, p) => n + p.hits, 0)

  console.log(`[refactor-move] ${apply ? '写回模式' : 'dry-run（只报告，不动任何文件）'}｜HOOKS_DIR=${HOOKS_DIR}`)
  console.log(`  移动 ${moves.length} 个文件；扫描 ${files.length} 个 .ts；需改写 ${totalHits} 处（分布在 ${plans.length} 个文件）`)
  for (const m of moves) console.log(`    mv ${m.fromRel} → ${m.toRel}`)
  for (const p of plans) {
    const rel = p.from.startsWith(HOOKS_DIR) ? p.from.slice(HOOKS_DIR.length + 1) : p.from
    console.log(`    ~ ${rel}（${p.hits} 处）`)
  }
  if (!apply) {
    console.log('[refactor-move] dry-run 结束；确认数字无误后加 --apply')
    return
  }

  for (const m of moves) {
    mkdirSync(dirname(m.toAbs), { recursive: true })
    const r = run('git', ['-C', REPO_ROOT, 'mv', m.fromAbs, m.toAbs], { quiet: true })
    if (r.status !== 0) {
      const mv = run('mv', [m.fromAbs, m.toAbs], { quiet: true })
      if (mv.status !== 0) fail(`移动失败: ${m.fromRel}（git mv + mv 都失败）`, 2)
    }
  }
  let rewritten = 0
  for (const p of plans) {
    // 🔴 写到**移动后**的路径：写回旧路径会凭空重建一份旧文件（本轮实测发生过）
    writeFileSync(p.to, p.next, 'utf-8')
    rewritten += p.hits
  }
  console.log(`[refactor-move] ✓ 已移动 ${moves.length} 个文件，改写 ${rewritten} 处说明符`)
  console.log('[refactor-move] 下一步必跑：typecheck ＋ test（漏改一处 typecheck 就红）')
}

// ── rename-symbols：**代码级**标识符机械改名（rename-mentions 只管注释，本机管全部）──

/**
 * rename-symbols — 把代码与注释里的**标识符**按映射表机械改名。
 *
 * ## 为什么必须另起一台机器（R↓）
 *
 * `rename-mentions` **只改注释行**（它当年是为"注释里的旧文件名"造的，见其头注判据 2）。
 * 而「skiff → 轨迹约束」这类改名要动的是**标识符本身**（`SkiffProfile` / `skiff.json` /
 * 导入符号 / 字符串字面量）。用 `rename-mentions` 跑它 ⇒ **代码一行不改，测试全绿**，
 * 而你要的功能没变 —— 那是本轨最怕的一类静默失效。
 *
 * ## 判据（与 rename-mentions 同族，逐条都有事故出处）
 *
 * 1. **长键优先**：`skiffProfile` 必须先于 `skiff` 换，否则长出 `trajectory-constraintProfile`；
 * 2. **左边界守卫** `(?<![A-Za-z0-9_-])`：否则 `skiff-weixin-` 里的 `skiff` 被换掉
 *    （那会把**正在续的对话史**砸断 —— 那是 owner 没授权的破坏性改动）；
 * 3. **保护名单**：`skiff-weixin-` 整段先占位、后还原（它与会话 id 历史绑定，不得随改名消失）；
 * 4. **dry-run 先看数**，apply 后自动复扫，残留必须为 0（残留里排除保护段）；
 * 5. 🔴 **改完必须 typecheck** —— 预演通过 ≠ 改名成立（D132）。
 *
 * 用法: dsh-develop rename-symbols --map <json> [--apply]
 *   json 形态: { "SkiffProfile": "TrajectoryConstraint", "skiff.json": "trajectory-constraint.json", ... }
 */
function cmdRenameSymbols(argv: string[]): void {
  const apply = argv.includes('--apply')
  const mapIdx = argv.indexOf('--map')
  const mapPath = mapIdx >= 0 ? argv[mapIdx + 1] : undefined
  if (mapPath === undefined) fail('rename-symbols 需要 --map <json>')
  if (!existsSync(mapPath)) fail(`map 文件不存在: ${mapPath}`, 2)

  const raw = readMapJson(mapPath)
  // 长键优先（第 1 条判据）
  const rules = Object.entries(raw).sort((a, b) => b[0].length - a[0].length)

  /**
   * 保护段（第 3 条判据）：先换成占位符，改完还原。
   * ⚠️ 占位符里**不能含任何被映射的子串**，否则第二轮又被换掉。
   */
  const PROTECT = ['skiff-weixin-']
  const PH = '\u0001P0\u0001'

  const files = [
    ...collectByExt(join(HOOKS_DIR, 'src'), ['.ts', '.tsx']),
    ...collectByExt(join(HOOKS_DIR, 'tests'), ['.ts', '.tsx']),
    ...collectByExt(join(REPO_ROOT, 'bench'), ['.mjs', '.sh']),
  ]

  const transform = (text: string): string => {
    let t = text
    for (const p of PROTECT) t = t.split(p).join(PH)
    for (const [from, to] of rules) t = t.split(from).join(to)
    t = t.split(PH).join(PROTECT[0]!)
    return t
  }

  const plans: Array<{ file: string; next: string; hits: Map<string, number> }> = []
  for (const file of files) {
    const before = readFileSync(file, 'utf-8')
    const after = transform(before)
    if (after === before) continue
    let probe = before
    for (const p of PROTECT) probe = probe.split(p).join('')
    const hits = new Map<string, number>()
    let n = 0
    for (const [from] of rules) {
      const c = probe.split(from).length - 1
      if (c > 0) { hits.set(from, c); n += c }
    }
    if (n > 0) plans.push({ file, next: after, hits })
  }

  const rel = (f: string): string => (f.startsWith(REPO_ROOT) ? f.slice(REPO_ROOT.length + 1) : f)
  const total = plans.reduce((n, p) => n + [...p.hits.values()].reduce((a, b) => a + b, 0), 0)
  console.log(`[rename-symbols] ${apply ? '写回模式' : 'dry-run（只报告）'}｜规则 ${rules.length} 条｜扫描 ${files.length} 个文件`)
  console.log(`  命中 ${total} 处，分布在 ${plans.length} 个文件`)
  for (const p of plans) {
    const detail = [...p.hits.entries()].map(([k, v]) => `${k}×${v}`).join(' ')
    console.log(`    ~ ${rel(p.file)}（${[...p.hits.values()].reduce((a, b) => a + b, 0)} 处）${detail.slice(0, 160)}`)
  }
  if (!apply) {
    console.log('[rename-symbols] dry-run 结束；确认数字无误后加 --apply（**改完必须 typecheck**）')
    return
  }

  for (const p of plans) writeFileSync(p.file, p.next, 'utf-8')
  console.log(`[rename-symbols] ✓ 已改写 ${plans.length} 个文件`)

  // 判据 4：复扫残留（排除保护段）
  let leftovers = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    let probe = text
    for (const pt of PROTECT) probe = probe.split(pt).join('')
    for (const [from] of rules) {
      const c = probe.split(from).length - 1
      if (c > 0) {
        leftovers += c
        console.log(`    ⚠ 残留 ${rel(file)}: ${from} ×${c}`)
      }
    }
  }
  console.log(leftovers === 0
    ? '[rename-symbols] ✓ 标识符残留 = 0（保护段已排除）'
    : `[rename-symbols] ⚠ 仍有 ${leftovers} 处残留`)
}

// ── rename-mentions：注释里的旧文件名机械改名 ─────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 新树的一级域目录（做"不许再加前缀"的守卫，也做 dedupe 回修） */
const MENTION_DOMAINS = [
  'kernel', 'trajectory', 'wake', 'im', 'gateway', 'guard', 'patches', 'role',
  'surface', 'tools', 'skills', 'host', 'seams', 'client', 'diagram', 'ontology',
]

/**
 * 旧名的匹配正则。
 * 🔴 **两道守卫，缺一即出事故**（本机两次实测）：
 *  ① 左边界不是标识符字符（`[A-Za-z0-9_-]`）—— 否则 `clock-runtime.ts` 里的 `time.ts` 被误换；
 *  ② 左边界**也不是「域目录 ＋ /」** —— 否则已是新路径的尾段会被**再加一次前缀**：
 *     `kernel/ccc.ts` 里含 `ccc.ts` ⇒ `kernel/kernel/ccc.ts`（本机真发生过，随后要 dedupe 回修）。
 */
function mentionRe(from: string): RegExp {
  const guards = MENTION_DOMAINS.map((d) => `(?<!${d}/)`).join('')
  return new RegExp(`(?<![A-Za-z0-9_-])${guards}${escapeRe(from)}`, 'g')
}

/** 一行是不是「注释行」（够用即可：本仓注释全部是行首 `//` / `/*` / `*` / `#`（shell）） */
function isCommentLine(line: string, ext: string): boolean {
  const t = line.trimStart()
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return true
  return ext === '.sh' && t.startsWith('#')
}

/** 递归收集指定扩展名的文件（跳过 node_modules / lib / coverage / dist / .git） */
function collectByExt(dir: string, exts: string[], out: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'lib', 'coverage', 'dist', '.git'].includes(e.name)) continue
      collectByExt(p, exts, out)
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      out.push(p)
    }
  }
  return out
}

/**
 * rename-mentions — 把**注释里**的旧文件名机械换成新路径。
 *
 * ## 为什么必须有这台机器（R↓）
 *
 * 目录重构后，`src/` 与 `tests/` 里有 **~90 个文件**在注释里写着旧文件名
 * （"见 `wake/scheduler.ts`"、"同 `cro/log.ts` 款"）。这些引用**不参与编译**，
 * 所以 typecheck/test 全绿也抓不到它们 —— 只有人读代码时被误导。
 * 手改必漏（同族教训：`INDIRECT_COVERED` 白名单按基名匹配，改名即静默失效）。
 *
 * ## 判据（每次都用）
 *
 * 1. **dry-run 先看数**：命中行数 / 文件数与预期量级不符 ⇒ 先查规则表，别 apply；
 * 2. **只动注释行** —— 代码行、字符串字面量一律不碰（那里的旧名可能是运行时契约）；
 * 3. **长键优先 ＋ 左边界**（`(?<![A-Za-z0-9_-])`）—— 否则 `wake/clock.ts` 里的 `kernel/time.ts`
 *    会被误换（这是本机第一版就会踩的坑）；
 * 4. apply 后**自动复扫**，残留必须为 0（否则点名打印）。
 *
 * 用法: dsh-develop rename-mentions --map <json> [--apply]
 *   json 形态: { "旧文件名.ts": "新路径/文件名.ts", ... }
 */
function cmdRenameMentions(argv: string[]): void {
  const apply = argv.includes('--apply')
  const dedupe = argv.includes('--dedupe')
  const mapIdx = argv.indexOf('--map')
  const mapPath = mapIdx >= 0 ? argv[mapIdx + 1] : undefined
  if (mapPath === undefined && !dedupe) fail('rename-mentions 需要 --map <json>（或 --dedupe 单独回修重复前缀）')
  if (mapPath !== undefined && !existsSync(mapPath)) fail(`map 文件不存在: ${mapPath}`, 2)

  const raw = mapPath === undefined ? {} : readMapJson(mapPath)
  const rules = Object.entries(raw)
    .sort((a, b) => b[0].length - a[0].length) // 长键优先
    .map(([from, to]) => ({ from, to, re: mentionRe(from) }))

  /** --dedupe：把 `域/域/` 折叠成 `域/`（回修"已被加了两次前缀"的注释） */
  const dedupeLine = (line: string): string => {
    let cur = line
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false
      for (const d of MENTION_DOMAINS) {
        const re = new RegExp(`${d}/${d}/`, 'g')
        if (re.test(cur)) { cur = cur.replace(re, `${d}/`); changed = true }
      }
      if (!changed) break
    }
    return cur
  }

  const files = [
    ...collectTs(join(HOOKS_DIR, 'src')),
    ...collectTs(join(HOOKS_DIR, 'tests')),
    ...collectByExt(join(REPO_ROOT, 'bench'), ['.mjs', '.sh']),
    ...collectByExt(join(REPO_ROOT, 'scripts'), ['.ts']),
  ]

  const plans: Array<{ file: string; next: string; hits: number; lines: number }> = []
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'))
    const text = readFileSync(file, 'utf-8')
    const outLines: string[] = []
    let hits = 0
    let lines = 0
    for (const line of text.split('\n')) {
      if (!isCommentLine(line, ext)) { outLines.push(line); continue }
      let next = line
      if (dedupe) {
        const ded = dedupeLine(next)
        if (ded !== next) { hits += 1; next = ded }
      }
      for (const r of rules) {
        const found = next.match(r.re)
        if (found !== null) {
          hits += found.length
          next = next.replace(r.re, r.to)
        }
      }
      if (next !== line) lines += 1
      outLines.push(next)
    }
    if (hits > 0) plans.push({ file, next: outLines.join('\n'), hits, lines })
  }

  const totalHits = plans.reduce((n, p) => n + p.hits, 0)
  const rel = (f: string): string => (f.startsWith(REPO_ROOT) ? f.slice(REPO_ROOT.length + 1) : f)
  const mode = `${apply ? '写回模式' : 'dry-run（只报告，不动任何文件）'}${dedupe ? '｜dedupe' : ''}`
  console.log(`[rename-mentions] ${mode}｜规则 ${rules.length} 条｜扫描 ${files.length} 个文件`)
  console.log(`  命中 ${totalHits} 处，分布在 ${plans.length} 个文件的注释里`)
  for (const p of plans) console.log(`    ~ ${rel(p.file)}（${p.hits} 处 / ${p.lines} 行）`)
  if (!apply) {
    console.log('[rename-mentions] dry-run 结束；确认数字无误后加 --apply')
    return
  }

  for (const p of plans) writeFileSync(p.file, p.next, 'utf-8')
  console.log(`[rename-mentions] ✓ 已改写 ${plans.length} 个文件`)

  // 判据 4：复扫残留。只认注释行（代码/字符串里的旧名是**故意留的**，不在此列），
  // 且**用同一个带守卫的正则**判 —— 否则 `image-fallback-api.ts` 这类会被 `api.ts` 误报。
  let leftovers = 0
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'))
    const text = readFileSync(file, 'utf-8')
    for (const line of text.split('\n')) {
      if (!isCommentLine(line, ext)) continue
      if (dedupe) {
        for (const d of MENTION_DOMAINS) {
          if (line.includes(`${d}/${d}/`)) {
            leftovers += 1
            console.log(`    ⚠ 重复前缀 ${rel(file)}: ${line.trim().slice(0, 100)}`)
          }
        }
      }
      for (const r of rules) {
        if (r.re.test(line)) {
          leftovers += 1
          console.log(`    ⚠ 残留 ${rel(file)}: ${line.trim().slice(0, 100)}`)
        }
        r.re.lastIndex = 0
      }
    }
  }
  console.log(leftovers === 0
    ? '[rename-mentions] ✓ 注释里旧名残留 = 0'
    : `[rename-mentions] ⚠ 仍有 ${leftovers} 处残留（见上）`)
}

function readMapJson(p: string): Record<string, string> {
  const parsed = readJson(p)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') fail(`map 值必须是字符串: ${k}`, 2)
    out[k] = v
  }
  return out
}

/**
 * 改写一个文件里的模块说明符（**纯函数**，可单测）。
 *
 * ## 两条必须同时成立（本轮实测各栽一次）
 *
 * **(a) 目标被移动** ⇒ 说明符要按**新位置**重算。
 * **(b) 自己（importer）被移动** ⇒ 即使目标没动，**相对路径也变了**（`./ccc.js` → `../ccc.js`）。
 *     ⛔ 只做 (a) 会让搬走的文件里所有"指向留在原处的模块"的 import 全部断（TS2307 一片）。
 *
 * @param text 原文
 * @param importerOldAbs 该文件**移动前**的绝对路径（用来解析原说明符）
 * @param importerNewAbs 该文件**移动后**的绝对路径（用来算新说明符）；没移动则与 old 相同
 * @param byFrom 旧绝对路径 → 新绝对路径（只含被移动的模块）
 * @returns 新文本与命中处数
 */
function rewriteSpecifiers(
  text: string,
  importerOldAbs: string,
  importerNewAbs: string,
  byFrom: Map<string, string>,
): { text: string; hits: number } {
  let hits = 0
  const lines = text.split('\n')
  const out = lines.map((line) => {
    const trimmed = line.trimStart()
    // 🔴 注释里的 `.js` 是散文，不是依赖 ⇒ 一律跳过
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return line
    return line.replace(/(['"])([^'"]+\.js)\1/g, (whole: string, quote: string, spec: string) => {
      if (!spec.startsWith('.')) return whole // 包名不碰
      // 🔴 TS 约定：说明符写 .js、磁盘上是 .ts ⇒ 换成 .ts 才解析得到目标
      const targetOldTs = resolve(dirname(importerOldAbs), spec.replace(/\.js$/, '.ts'))
      const movedTo = byFrom.get(targetOldTs)
      const targetNewTs = movedTo ?? targetOldTs
      // 目标没动 且 自己没动 ⇒ 这条说明符不受影响
      if (movedTo === undefined && importerOldAbs === importerNewAbs) return whole
      const nextSpec = relativeSpecifier(dirname(importerNewAbs), targetNewTs).replace(/\.ts$/, '.js')
      if (nextSpec === spec) return whole
      hits += 1
      return `${quote}${nextSpec}${quote}`
    })
  })
  return { text: out.join('\n'), hits }
}

/** posix 形态的相对说明符，且以 `./` / `../` 开头（Node ESM 要求） */
function relativeSpecifier(fromDir: string, toAbs: string): string {
  const rel = relative(fromDir, toAbs).split('\\').join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}


async function cmdSessionDoctor(argv: string[]): Promise<void> {
  let root: string | undefined
  let only: Set<string> | undefined
  let json = false
  let deep = false
  let probe = false
  let quiet = false
  let limit: number | undefined
  const addIds = (list: string): void => {
    const ids = list.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (ids.length === 0) return
    only ??= new Set<string>()
    for (const id of ids) only.add(id)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--root') { root = argv[++i]; continue }
    if (a.startsWith('--root=')) { root = a.slice('--root='.length); continue }
    if (a === '--session') { addIds(argv[++i] ?? ''); continue }
    if (a.startsWith('--session=')) { addIds(a.slice('--session='.length)); continue }
    if (a === '--sessions') { addIds(argv[++i] ?? ''); continue }
    if (a.startsWith('--sessions=')) { addIds(a.slice('--sessions='.length)); continue }
    if (a === '--json') { json = true; continue }
    if (a === '--deep') { deep = true; continue }
    if (a === '--probe') { probe = true; continue }
    if (a === '--summary') { quiet = true; continue }
    if (a === '--limit') { limit = Number(argv[++i]); continue }
    if (a.startsWith('--limit=')) { limit = Number(a.slice('--limit='.length)); continue }
    fail(`session-doctor 未知参数: ${a}（用法: session-doctor [--root <dir>] [--session <id>] [--sessions <id,...>] [--json] [--deep] [--probe] [--summary] [--limit <n>]）`)
  }
  const storeRoot = sessionStoreRoot(root)
  if (!existsSync(storeRoot)) fail(`会话存储不存在: ${storeRoot}`, 2)
  if (probe) {
    if (!json) console.log(`[session-doctor] 探针模式（宿主真实 load()；读只读副本，不动原存储）`)
    await runSessionProbe(storeRoot, only, json, limit, quiet)
    return
  }
  const vocab = await loadSessionVocabulary()
  const say = (line: string): void => { if (!json) console.log(line) }
  say(`[session-doctor] 存储: ${storeRoot}`)
  say(`[session-doctor] 词表: ${vocab.known.size} 类（源: ${vocab.source}）`)
  say(`[session-doctor] 宿主格式版本: ${vocab.supported === null ? '未知（跳过版本判定）' : `v${vocab.supported}`}${vocab.versionSource === null ? '' : `（源: ${vocab.versionSource}）`}`)

  const reports: DoctorReport[] = []
  let scanned = 0
  for (const project of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(storeRoot, project.name)
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (only !== undefined && !only.has(entry.name)) continue
      if (limit !== undefined && scanned >= limit) break
      const dir = join(projectPath, entry.name)
      const generations = sessionArtifacts(dir)
      if (generations.length === 0) continue
      scanned++
      const latest = generations[generations.length - 1] as { name: string; generation: number; path: string }
      const scan = await scanSessionArtifact(latest, vocab.known, vocab.supported, deep)
      const report: DoctorReport = {
        id: entry.name,
        project: project.name,
        artifact: latest.name,
        generation: latest.generation,
        generations: generations.map((g) => g.generation),
        sizeBytes: statSync(latest.path).size,
        mtimeMs: statSync(latest.path).mtimeMs,
        ...scan,
      }
      reports.push(report)
      say(
        `${report.verdict === 'ok' ? '✓' : '✗'} ${report.id}｜${latest.name}｜${(report.sizeBytes / 1024 / 1024).toFixed(1)}MB｜`
        + `${new Date(report.mtimeMs).toISOString().slice(0, 16)}｜${report.verdict}｜${report.detail}`,
      )
      if (only !== undefined && scanned >= only.size) break
    }
    if (only !== undefined && scanned >= only.size) break
  }

  const refused = reports.filter((r) => r.verdict !== 'ok' && r.verdict !== 'needs-migration')
  const migrate = reports.filter((r) => r.verdict === 'needs-migration')
  const byProject = (list: DoctorReport[]): string => {
    const counts = new Map<string, number>()
    for (const r of list) counts.set(r.project, (counts.get(r.project) ?? 0) + 1)
    return [...counts.entries()].sort().map(([p, n]) => `${p}=${n}`).join(' ')
  }
  if (json) {
    console.log(JSON.stringify({
      root: storeRoot,
      vocabulary: { size: vocab.known.size, source: vocab.source },
      supportedVersion: vocab.supported,
      scanned: reports.length,
      ok: reports.length - refused.length - migrate.length,
      needsMigration: migrate.length,
      refused: refused.length,
      refusedByProject: byProject(refused),
      needsMigrationByProject: byProject(migrate),
      reports,
    }, null, 2))
    return
  }
  console.log('')
  console.log(`[session-doctor] 扫描 ${reports.length} 份日志（判据 version-first）`)
  console.log(`  ✓ 当前世代可读      ${reports.length - refused.length - migrate.length} 份`)
  console.log(`  ~ 历史世代待迁移判定 ${migrate.length} 份  ${byProject(migrate) || ''}`)
  console.log(`  ✗ 静态判定会被拒    ${refused.length} 份  ${byProject(refused) || ''}`)
  if (refused.length > 0) {
    console.log('  静态判定会被拒的逐条：')
    for (const r of refused) console.log(`    ✗ ${r.id}（${r.project}）: ${r.verdict} — ${r.detail}`)
  }
  if (migrate.length > 0) {
    console.log('  ⚠️ 历史世代的可读性**静态不可判**——须用 `--probe` 走宿主真实迁移路径实测（迁移可能成功，也可能在内容层被拒）')
  }
}

/**
 * session-repair — 修复**已知形态**的会话日志损坏（重建机制写坏的 `user/message` 缺 `id`/`role`）。
 *
 * 与 `session-doctor` 的分工（单一真相源，不重叠）：
 *   - `session-doctor` = **诊断**（只读分诊 + 探针实测），永不写
 *   - `session-repair` = **治疗**（缺省 dry-run 只报计划；`--apply` 才备份 + 原子替换 + 自检）
 *
 * 纪律（R↓）：
 *   - 判据来自宿主源码 `dsh-session/lib/types/index.js:241-268`（消息形状门），**不自写复刻**
 *   - 只补 `id`/`role` 两项；`content`/`source` 形状不齐的事件一律报告不动（不替宿主猜内容）
 *   - 缺省排除"近期仍在写入"的日志（`--min-age-min`，缺省 10 分钟）⇒ 绝不改写活动会话
 *   - 每次 `--apply` 必先落备份；备份含会话原文 ⇒ `_tmp/` 下（gitignore，仅本地）
 *   - `--probe` 用宿主真实读取路径 (`open(id,'read')`) 复验，不靠"应该好了"
 *
 * 用法: dsh-develop session-repair [--root <dir>] [--session <id,...>] [--apply]
 *       [--backup-dir <dir>] [--min-age-min <n>] [--force] [--probe] [--json]
 */
async function cmdSessionRepair(argv: string[]): Promise<void> {
  let root: string | undefined
  const ids: string[] = []
  let apply = false
  let json = false
  let probe = false
  let force = false
  let backupDir: string | undefined
  let mirrorTo: string | undefined
  let minAgeMin = 10
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--root') { root = argv[++i]; continue }
    if (a.startsWith('--root=')) { root = a.slice('--root='.length); continue }
    if (a === '--session' || a === '--sessions') {
      for (const id of (argv[++i] ?? '').split(',')) if (id.trim() !== '') ids.push(id.trim())
      continue
    }
    if (a === '--apply') { apply = true; continue }
    if (a === '--json') { json = true; continue }
    if (a === '--probe') { probe = true; continue }
    if (a === '--force') { force = true; continue }
    if (a === '--backup-dir') { backupDir = argv[++i]; continue }
    if (a.startsWith('--backup-dir=')) { backupDir = a.slice('--backup-dir='.length); continue }
    if (a === '--mirror-to') { mirrorTo = argv[++i]; continue }
    if (a.startsWith('--mirror-to=')) { mirrorTo = a.slice('--mirror-to='.length); continue }
    if (a === '--min-age-min') { minAgeMin = Number(argv[++i]); continue }
    fail(`session-repair 未知参数: ${a}（用法: session-repair [--root <dir>] [--session <id,...>] [--apply] [--backup-dir <dir>] [--mirror-to <dir>] [--min-age-min <n>] [--force] [--probe] [--json]）`)
  }
  const storeRoot = sessionStoreRoot(root)
  const script = join(SCRIPTS_DIR, 'session-repair.mjs')
  if (!existsSync(script)) fail(`修复脚本缺失: ${script}`, 2)

  let effectiveBackup = backupDir
  if (apply && (effectiveBackup === undefined || effectiveBackup === '')) {
    // 缺省备份目录放在 CCC 的 `_tmp/`（gitignore；**含会话原文，仅本地**）
    effectiveBackup = join(REPO_ROOT, '_tmp', 'session-repair-backup', `bak-${Date.now()}`)
    console.log(`[session-repair] 未指定 --backup-dir ⇒ 缺省 ${effectiveBackup}`)
  }

  const args = [script, storeRoot, ...ids, '--min-age-min', String(minAgeMin)]
  if (apply) args.push('--apply', '--backup-dir', effectiveBackup as string)
  if (mirrorTo !== undefined) args.push('--mirror-to', mirrorTo)
  if (force) args.push('--force')
  const r = run('node', args, { cwd: SCRIPTS_DIR, quiet: true })

  interface RepairReport {
    id: string; project?: string; artifact?: string; ageMin?: number; compressedBytes?: number
    events?: number; patches?: Array<{ seq: number | null; added: string[] }>
    problems?: Array<{ seq?: number | null; type?: string; reason: string }>
    ok?: boolean; applied?: boolean; backup?: string; error?: string; note?: string; skipped?: string
    verified?: { patchesRemaining?: number; problemsRemaining?: number; events?: number; error?: string }
  }
  const reports: RepairReport[] = []
  for (const line of r.stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { reports.push(JSON.parse(t) as RepairReport) } catch { /* 单行解析失败不影响其余会话 */ }
  }

  if (json) {
    console.log(JSON.stringify({ root: storeRoot, apply, backupDir: effectiveBackup ?? null, reports }, null, 2))
  } else {
    console.log('')
    console.log(`[session-repair] ${apply ? '写回模式' : 'dry-run 模式（只报告，不写任何文件）'}｜root=${storeRoot}`)
    let patched = 0
    let failed = 0
    for (const rep of reports) {
      const n = rep.patches?.length ?? 0
      if (n > 0) patched++
      if (rep.ok !== true) failed++
      const bits = [
        rep.patches === undefined ? '（无报告）' : `${n} 处缺口`,
        rep.problems !== undefined && rep.problems.length > 0 ? `${rep.problems.length} 处不可自动修` : null,
        rep.applied === true ? `已写回${rep.verified?.patchesRemaining === 0 ? '（自检零缺口）' : `（自检残留 ${rep.verified?.patchesRemaining ?? '?'}）`}` : null,
        rep.error ?? rep.note ?? null,
      ].filter((x): x is string => x !== null)
      console.log(`  ${rep.ok === true ? '✓' : '✗'} ${rep.id}（${rep.project ?? '?'}）｜${rep.artifact ?? '?'}｜${bits.join('｜')}`)
      for (const p of rep.patches ?? []) console.log(`      seq ${p.seq ?? '?'} 补 ${p.added.join('+')}`)
      for (const p of rep.problems ?? []) console.log(`      ⚠️ seq ${p.seq ?? '?'} ${p.type ?? ''} ${p.reason}`)
      if (rep.backup !== undefined) console.log(`      备份: ${rep.backup}`)
    }
    console.log(`  合计: 有缺口 ${patched} / ${reports.length}｜未成功 ${failed}`)
  }

  if (probe) {
    console.log('')
    console.log('[session-repair] 复验：宿主真实读取路径（open(id,\'read\')）')
    await runSessionProbe(storeRoot, ids.length > 0 ? new Set(ids) : undefined, json, undefined, false)
  }
  if (r.status !== 0 && reports.length === 0) fail(`session-repair 执行失败（exit ${r.status}）: ${r.stderr.trim().slice(0, 300)}`, 2)
}

/**
 * npm-install-dev — 安装 hooks 开发依赖（v1.24.6：二维码绑定引入 qrcode-generator）。
 * 在 HOOKS_DIR 执行 `pnpm install --save-dev <pkgs>`（hooks 是 pnpm 项目——
 * pnpm-lock.yaml + .pnpm-store，npm 与 pnpm node_modules 布局冲突会崩）；
 * client bundle noExternal 全 true，第三方库内联进 lib/client.js（零运行时新依赖）；
 * devDependencies 记录可复现。
 *
 * v1.31.11：新增可选 `--registry <url>`（对齐 npm-install 的第三参语义）。
 * 为什么需要（§7-8 宿主类型基准落地）：要一次装 32 个宿主包（`@deepseek-ai/dsh-*`），
 * 而 hooks 目录自身没有 .npmrc——registry 会回落到用户级 `~/.npmrc`（内网 Nexus）。
 * 显式传官方源可绕开代理缓存（同 host-fetch 的做法），**且不改任何 .npmrc**。
 * 用法: dsh-develop npm-install-dev [--registry <url>] <pkg[@version]>...
 */
function cmdNpmInstallDev(argv: string[]): void {
  let registry: string | undefined
  let pkgs = argv
  if (argv[0] === '--registry') {
    registry = argv[1]
    pkgs = argv.slice(2)
  } else if (argv[0]?.startsWith('--registry=')) {
    registry = argv[0].slice('--registry='.length)
    pkgs = argv.slice(1)
  }
  if (registry !== undefined && !/^https?:\/\//.test(registry)) fail(`--registry 必须是 http(s) URL: ${registry}`, 2)
  if (pkgs.length === 0) fail('npm-install-dev 需要包名: dsh-develop npm-install-dev [--registry <url>] <pkg>[@version]...')
  console.log(`[dsh-develop] pnpm install --save-dev ${pkgs.length} 个包（hooks）${registry ? `｜源覆盖: ${registry}` : ''}`)
  // store-dir 必须与既有 node_modules 链接一致（hooks/.pnpm-store/v11）——
  // pnpm 默认全局 store（~/.local/bin/store）与本地 store 冲突会 ERR_PNPM_UNEXPECTED_STORE
  const storeDir = join(HOOKS_DIR, '.pnpm-store')
  const args = ['install', '--store-dir', storeDir, '--save-dev']
  if (registry) args.push('--registry', registry)
  args.push(...pkgs)
  const r = run(PNPM, args, {
    cwd: HOOKS_DIR,
    quiet: true,
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`pnpm install --save-dev 失败 (exit ${r.status})`, 2)
  }
  console.log(r.stdout.trim() || r.stderr.trim())
  console.log(`[dsh-develop] ✓ 已安装 devDeps（${pkgs.length} 个，hooks/package.json）`)
}

/**
 * verifyLockfile — 锁文件与 package.json 一致性**判定**（不做重算）。
 *
 * 单一真相源：`cmdLockfile` 的第 ② 步与 `cmdPublish` 的前置都调它 →
 * 跑 `lockfile` 就是在验证发布链的同一段代码（可测）。
 *
 * 语义：`pnpm install --lockfile-only --frozen-lockfile` = CI 的 `Install (hooks)` 同款判定；
 * exit 0 = 一致。**只判定不乱改**——重算由 `lockfile` 命令（人显式执行）承担，
 * 发布路径不得顺手改锁文件。
 *
 * 为什么发布链要管它（D52，2026-09-10 用户裁决"检查归发布机制"）：GitHub CI 不再是质量门，
 * 原先由 CI 兜住的漂移（v1.31.6 实例：改了 peer 没重跑锁文件 → `--frozen-lockfile` 拒绝安装）
 * 改由发布前拦下。
 */
function verifyLockfile(): void {
  const storeDir = join(HOOKS_DIR, '.pnpm-store')
  const r = run(PNPM, ['install', '--lockfile-only', '--frozen-lockfile', '--store-dir', storeDir], { cwd: HOOKS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail('锁文件与 package.json 不一致 → 先跑 `dsh-develop lockfile` 并提交锁文件（否则安装/CI 会失败）', 2)
  }
  console.log('[dsh-develop] ✓ 锁文件与 package.json 一致')
}

/**
 * lockfile — 重生成 hooks 的 pnpm 锁文件，并**用 CI 的同一把尺子当场自检**（v1.31.10）。
 *
 * 为什么存在（SESSION §17 实锤）：CI 的 `Install (hooks)` 走
 * `pnpm install --frozen-lockfile --ignore-scripts`（ci.yml:96）。只要
 * `hooks/dsh-serenity-hooks/package.json` 的依赖变了而锁文件没重跑，pnpm 判定
 * "锁文件与 package.json 不一致" → **拒绝安装** → `Test` 整步 skipped → **vitest 从未执行**
 * （阻塞门静默失效，注解只留 `no vitest log captured`）。
 * 触发实例：v1.31.6 把 18 项 peerDependencies 从 `^0.1.2-rc.1` 抬到 `^0.1.5-rc.1`
 * （锁文件自 v1.30.16 的 6751fd0 后再没重生成）→ 自 `2c59e23` 起每次 push 的 CI 皆红。
 *
 * 语义（两步，第二步是关键）：
 *   ① `pnpm install --lockfile-only` —— 只重算锁文件，**不动 node_modules**
 *   ② `verifyLockfile()` —— CI 该步的**本地等价判定**（同一函数被 publish 前置复用）
 *
 * 纪律：改完 package.json 依赖后**必须**跑本命令并提交锁文件（ci.yml 文件头同款要求）。
 * 用法：dsh-develop lockfile
 */
function cmdLockfile(): void {
  // store-dir 与既有 node_modules 链接保持一致（同 npm-install-dev 的理由：
  // 全局 store 与 hooks/.pnpm-store 冲突会 ERR_PNPM_UNEXPECTED_STORE）
  const storeDir = join(HOOKS_DIR, '.pnpm-store')
  console.log('[dsh-develop] ① pnpm install --lockfile-only（hooks，不动 node_modules）')
  const r = run(PNPM, ['install', '--lockfile-only', '--store-dir', storeDir], { cwd: HOOKS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`pnpm install --lockfile-only 失败 (exit ${r.status})`, 2)
  }
  console.log((r.stdout + r.stderr).trim() || '(no output)')
  console.log('[dsh-develop] ② 自检：--frozen-lockfile --lockfile-only（= CI Install (hooks) 同款判定；publish 前置复用同一函数）')
  verifyLockfile()
}

// ── main 守卫 ──

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sub, ...rest] = process.argv.slice(2)
  try {
    switch (sub) {
      case 'typecheck': cmdTypecheck(); break
      case 'typecheck-scripts': cmdTypecheckScripts(!rest.includes('--no-strict')); break
      case 'typecheck-cli': cmdTypecheckCli(); break
      case 'typecheck-host': cmdTypecheckHost(rest[0]); break
      case 'test': {
        const fi = rest.indexOf('--filter')
        const filter = fi >= 0 ? rest[fi + 1] : undefined
        cmdTest(filter)
        break
      }
      case 'coverage': cmdCoverage(); break
      case 'build': cmdBuild(); break
      case 'status': cmdStatus(); break
      case 'commit': cmdCommit(rest[0]); break
      case 'push': cmdPush(); break
      case 'github-push': {
        const force = rest.includes('--force')
        cmdGithubPush(rest.find((a) => !a.startsWith('--')), force)
        break
      }
      case 'squash-history': cmdSquashHistory(rest[0]); break
      case 'publish': cmdPublish(); break
      // 落地判据可单独调用（发布后复核 / 事后审计都用它）——**只读**，不改任何东西。
      // ⚠️ 判据 = **三个读数任一为真** ⇒「上架成立」。
      // 🔴 2026-10-11 实测（S142）：**三读数全假时只能说"未确认"，不能说"真没有"** ——
      //    发布 1.52.3 后 ~1 分钟跑本命令 ⇒ 三读数**全假**；而 npm 当时**明确报过成功**
      //    （`+ @shgroup/dsh-serenity-hooks@1.52.3`），且 35 分钟后再看 **全真**（对照：1.52.2 全真）。
      //    ⇒ 三读数的滞后**可以超过十分钟**，与"没上去"**在读数上不可分**。
      //    要分开只有一个办法：看 **publish 当时的 npm 回执**（那一步在 {@link verifyPublished}，
      //    它拿得到 npm 输出，所以说得出"未确认（传播中）"）。本命令拿不到 ⇒ 不许下断言。
      case 'publish-landed': {
        const v = rest[0] ?? currentVersion().pkg
        const read = landingRead(v)
        const pk = packumentHasVersion(v)
        console.log(`[dsh-develop] publish-landed ${v}`)
        console.log(`  版本记录（${v}?write=true） = ${read.record}`)
        console.log(`  tarball（-/${v}.tgz）        = ${read.tarball}`)
        console.log(`  packument 含该版本           = ${pk.has}（${pk.detail}）`)
        const fresh = read.record === '200' || read.tarball === '200' || pk.has
        if (fresh) {
          console.log('[dsh-develop] ✓ **上架成立**（三读数任一为真）')
          if (read.tarball === '200') console.log('[dsh-develop] ✓ 且包体此刻可下载（tarball 200）')
          else console.log(`[dsh-develop] ⚠️ 包体此刻仍取不到（tarball=${read.tarball}）⇒ 传播延迟／边缘负缓存，`
            + '不是"没上架"；装不上就等几分钟重试')
        } else {
          fail(`**三读数都没有 ${v}**（record=${read.record} / tarball=${read.tarball} / packument=${pk.has}）\n`
            + '  ⚠️ 这**不是**"真没有"：三读数可滞后十几分钟，与"没上去"**在读数上不可分**。\n'
            + `  处置：**不要重跑 publish**（同一版本只会 409）。隔 2~5 分钟复测本命令；\n`
            + '  🔴 **若要判断"是否卡在待批"之类的具体机制，别靠错误文案猜** —— 那正是 2026-10-14 我犯过的错\n'
            + '     （照一句 `409 … previously staged` 编出了 npm 的"staged 待批"，实际 `/-/stage` 是空的）。\n'
            + `     跑 \`msm("npm-registry-doctor", ["status", "${v}"])\`：它带 **staged 权威面**，一次分清四档。`, 2)
        }
        break
      }
      case 'pack-check': verifyTarball(); break
      case 'readme-sync': syncPackageReadme(); break
      case 'github-push-repo': cmdGithubPushRepo(rest[0]); break
      case 'github-ls': cmdGithubLs(rest[0]); break
      case 'version': cmdVersion(); break
      case 'run-trajectory-test': cmdRunTrajectoryTest(rest); break
      case 'sys': {
        // 诊断：执行白名单系统命令（ps/ss/curl/lsof/xdg-open/zstd/git 等只读诊断）
        const [cmd, ...args] = rest
        if (!['ps', 'ss', 'curl', 'lsof', 'pgrep', 'pkill', 'kill', 'sleep', 'ss', 'date', 'ls', 'xdg-open', 'zstd', 'git'].includes(cmd ?? '')) {
          fail(`sys 仅允许白名单命令: ${cmd}`)
        }
        // curl 强制 --max-time（防无超时请求维持死锁；postmortem 2026-08-08）
        const curlArgs = cmd === 'curl' && !args.some((a) => a === '--max-time' || a === '-m')
          ? [...args, '--max-time', '5']
          : args
        const r = run(cmd, curlArgs, { cwd: process.cwd(), quiet: true })
        if (r.status !== 0 && cmd !== 'pkill') { console.error(r.stderr); process.exit(r.status) }
        console.log(r.stdout)
        break
      }
      case 'bump': cmdBump(rest[0]); break
      case 'deploy': cmdDeploy({ listCopySet: rest.includes('--list-copy-set') }); break
      case 'npm-install': cmdNpmInstall(rest[0] ?? 'web', rest[1], rest[2]); break
      case 'npm-install-dev': cmdNpmInstallDev(rest); break
      case 'lockfile': cmdLockfile(); break
      case 'restart-web': cmdRestartWeb(); break
      case 'host-upgrade': cmdHostUpgrade(rest); break
      case 'session-doctor': await cmdSessionDoctor(rest); break
      case 'session-repair': await cmdSessionRepair(rest); break
      case 'refactor-move': cmdRefactorMove(rest); break
      case 'rename-mentions': cmdRenameMentions(rest); break
      case 'rename-symbols': cmdRenameSymbols(rest); break
      case 'diag': cmdDiag(); break
      case 'api-status': cmdApiStatus(rest[0]); break
      case 'inspect-dsh': cmdInspectDsh(rest[0]); break
      case 'read-dsh': cmdReadDsh(rest[0], rest[1], rest[2]); break
      case 'host-fetch': cmdHostFetch(rest[0], rest.slice(1)); break
      case 'host-probe': cmdHostProbe(rest); break
      case 'dump-config': cmdDumpConfig(rest[0]); break
      case '--list':
      case 'list':
        console.log('typecheck | typecheck-scripts | typecheck-cli（🔴 已退役） | typecheck-host <ver> | test [--filter] | coverage | build | status | commit <msg> | push | version | bump <ver> | deploy [--list-copy-set] | npm-install [<profile>] [<version>] [<registry>] | restart-web | host-probe [--registry <url>] | host-upgrade <ver|tag> [--registry <url>] [--dry-run] | session-doctor [--root <dir>] [--session <id>] [--json] [--deep] [--limit <n>] | session-repair [--root <dir>] [--session <id,...>] [--apply] [--backup-dir <dir>] [--min-age-min <n>] [--force] [--probe] [--json] | diag（🔴 已退役） | squash-history [<msg>] | github-push [--force] | pack-check | readme-sync | publish | inspect-dsh <pattern> | host-fetch <ver> [pkg[@ver]] [--list]')
        break
      case '--schema': {
        const target = rest[0] ?? 'dsh-develop'
        console.log(JSON.stringify({
          name: 'dsh-develop',
          path: 'AI_LAB/dsh-serenity-plugin/scripts/dsh-develop.ts',
          flags: [
            { name: 'filter', type: 'string', description: 'vitest 过滤（test）' },
            { name: 'message', type: 'string', description: 'commit 消息' },
            { name: 'version', type: 'string', description: 'bump 版本号 x.y.z' },
          ],
        }, null, 2))
        break
      }
      case '--help':
      case '-h':
      case undefined:
        console.log(`dsh-develop — dsh-serenity-plugin 开发操作 MSM（safe-mode 白名单通道）
用法: dsh-develop <typecheck|typecheck-scripts|typecheck-cli（🔴 已退役）|test|coverage|build|status|commit|push|version|bump|deploy|npm-install|lockfile|restart-web|pack-check|readme-sync|publish|github-push|squash-history> [args]
  typecheck             tsc --noEmit（hooks 的 node + client 两面）
  typecheck-scripts [--no-strict]  tsc --noEmit 覆盖 scripts/*.ts（开发工具面；默认 strict。A26-c）
  typecheck-cli         🔴 已退役（恒 exit 2）：对象 = 仓库根包 src/（安装器 CLI ／ init 向导 ／ 技能模板），2026-09-28 随该族整体删除
  test [--filter <p>]   vitest run
  coverage              vitest run --coverage（阈值门禁见 vitest.config.ts）
  build                 tsc + tsdown 双 bundle
  status                git status + 版本
  commit <message>      git add -A + commit
  push                  git push origin（GitHub，SSH-443）
  version               三处版本一致性
  bump <x.y.z>          package.json + dsh.plugin.json 版本同步
  deploy [--list-copy-set]  load-plugin.sh 全流程（构建+双锚+shim+profile+预检）；复制集合 = 发布物清单（白名单驱动，副本逐条 = 发布物）；--list-copy-set 只读印清单
  npm-install [profile] [version] 官方 npm 安装：缺省/latest=registry 最新（**发布链里请显式给版本**）；装完回读装机副本核对版本
  npm-install-dev <pkg...> hooks 开发依赖安装（npm install --save-dev；client bundle 内联）
  lockfile              重生成 hooks pnpm-lock.yaml + 用 --frozen-lockfile 自检（CI 同款判定）
  restart-web           kill + setsid 重启 dsh web（健康检查）
  host-upgrade <ver|tag> 全局升级 DSH 宿主 CLI（包名硬编码 @deepseek-ai/dsh；默认官方源；--dry-run 预览）
  session-doctor        会话日志体检（只读）：逐份判定宿主读取门（未知事件词表/格式版本/结构），列出会被拒的会话
  session-repair        会话日志治疗（缺省 dry-run）：补 rebuild 写坏的 user/message 缺 id/role；--apply 才备份+原子替换+自检
  diag                  🔴 **已退役**（对象 = autopilot 唤起条件链，随 v1.35.0 退场）⇒ 只印路牌，恒 exit 2
  squash-history [msg]  抹除历史为单个初始 commit（公开发布前清敏感历史；不可逆）
  pack-check            npm pack --dry-run 核对 tarball 完整性（chunk/双 bundle/类型）
  readme-sync           包内 README ← 仓库 README（机械同步，相对链接转绝对 URL）
  dump-config [pattern] dsh --dump-config（合成后的 profile 条目树；pattern 过滤）
  publish               npm publish @shgroup/dsh-serenity-hooks（凭据走 ~/.npmrc）
  github-push [--force] push 到 GitHub 公开仓库（tellmewhattodo）
  run-trajectory-test <轨迹目录名> [测试文件名]  跑某条轨迹自己的 *.dev.test.ts（只读；bun 缺省 ~/.bun/bin/bun，可用 SERENITY_BUN 覆盖）`)
        break
      default:
        fail(`未知子命令: ${sub}`)
    }
  } catch (e) {
    fail((e as Error).message, 2)
  }
}
