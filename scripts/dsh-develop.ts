#!/usr/bin/env bun
/**
 * dsh-develop.ts — dsh-serenity-plugin 开发操作 MSM（Mech，纯确定性）
 *
 * safe-mode 下 bash 被禁，但构建/测试/git/部署仍需执行。
 * 本 MSM 是注册的机械工具（acc_msm exec 走 bun 直跑），封装常用开发操作的白名单通道。
 *
 * 子命令:
 *   dsh-develop typecheck             tsc --noEmit（hooks 目录）
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

import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, cpSync, symlinkSync, statSync, readlinkSync, createReadStream } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
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

function cmdTest(filter?: string): void {
  if (!existsSync(join(HOOKS_DIR, 'tests'))) {
    fail(`hooks 测试目录缺失`, 2)
  }
  const args = ['run']
  if (filter) args.push(filter)
  // cwd = 仓库根（vitest.config.ts include 覆盖 tests/ + scripts/）
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
 *  且 hooks/vitest.config.ts 定义 coverage 范围 = hooks src。 */
function cmdCoverage(): void {
  if (!existsSync(join(HOOKS_DIR, 'tests'))) {
    fail(`hooks 测试目录缺失`, 2)
  }
  const r = run(join(HOOKS_DIR, 'node_modules', '.bin', 'vitest'), ['run', '--coverage'], { cwd: HOOKS_DIR })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`vitest --coverage 失败 (exit ${r.status})——覆盖率低于阈值或测试失败，见 hooks/vitest.config.ts thresholds`, 2)
  }
  // 汇总行（vitest coverage 文本报告在 stdout 尾部）
  const m = r.stdout.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/)
  console.log(m ? `[dsh-develop] ✓ 测试通过 (${m[1]} files / ${m[2]} tests) + coverage 报告（hooks/dsh-serenity-hooks/coverage/）` : '[dsh-develop] ✓ 测试通过 + coverage 报告')
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
  const clientSize = existsSync(join(HOOKS_DIR, 'lib', 'client.js'))
    ? `${statSync(join(HOOKS_DIR, 'lib', 'client.js')).size} B`
    : 'N/A'
  console.log(`[dsh-develop] ✓ 构建完成（lib/index.js + lib/client.js ${clientSize}）`)
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
  // origin 已指向 GitHub 公开仓库（与 github 远程同 URL；v1.16.0 起 GitHub 为主远程）。
  // 推送走 GIT_SSH_GITHUB（id_rsa_github + SSH-over-443）。
  const r = run('git', ['push', 'origin', 'HEAD'], {
    cwd: REPO_ROOT,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`git push 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ pushed to origin (GitHub)`)
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
  // 内网 nexus（tiangong-npm-group，只读镜像 → npm publish 400 Bad Request）。@shgroup token
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
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`npm publish 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ published @shgroup/dsh-serenity-hooks@${currentVersion().pkg}（npm registry）`)
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
  const dry = run('npm', ['pack', '--dry-run', '--json'], {
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
  const required = ['lib/index.js', 'lib/client.js', 'lib/invariant.js']
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
  console.log(`[dsh-develop]   lib/ 共 ${libEntries.length} 项（js ${libEntries.filter((f) => f.endsWith('.js')).length} / d.ts ${libEntries.filter((f) => f.endsWith('.d.ts')).length}）`)
  for (const f of libEntries) console.log(`    ${f}`)
  console.log(`[dsh-develop]   包内 .d.ts 类型文件总计 ${dtsCount} 个`)
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
 * 用法: dsh-develop host-fetch <version> [pkg...]
 *   包集合 = hooks/package.json 的 peerDependencies（`@deepseek-ai/dsh-*`）+ client 半 ui 包 + 任务专用包
 *   已是幂等：已解包的包跳过；单个包失败仅告警（不阻断其余）
 */
const HOST_FETCH_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
]

/** 适配轮常需、但不在 peer 列表里的宿主包（核对用） */
const HOST_FETCH_EXTRA_PACKAGES = [
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-agent-presets',
]

function cmdHostFetch(version?: string, extra: string[] = []): void {
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    fail('host-fetch 需要版本号: dsh-develop host-fetch <x.y.z[-rc.n]> [pkg...]')
  }
  const pkg = readJson(join(HOOKS_DIR, 'package.json'))
  const peers = Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>)
    .filter((n) => n.startsWith('@deepseek-ai/dsh-'))
  const names = [...new Set([...peers, ...HOST_FETCH_CLIENT_PACKAGES, ...HOST_FETCH_EXTRA_PACKAGES, ...extra])]
  const outRoot = join(REPO_ROOT, '_tmp', `host-${version}`)
  mkdirSync(outRoot, { recursive: true })
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  console.log(`[dsh-develop] host-fetch ${version} → ${outRoot}（${names.length} 个包）`)

  const failed: string[] = []
  let done = 0
  let skipped = 0
  for (const spec of names) {
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

function cmdApiStatus(path?: string): void {
  // 查询本地 dsh web HTTP 接口（同步阻塞版；避免异步回调在 bun 进程退出前未执行）
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
  const log = `/tmp/dsh-web-restart-v${currentVersion().pkg}.log`
  const cmd = `cd ${process.env.HOME ?? ''} && setsid nohup node ${bin} web > ${log} 2>&1 < /dev/null & disown`
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

function cmdDeploy(): void {
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
  for (const nm of targets) {
    const dst = join(nm, '@shgroup', 'dsh-serenity-hooks')
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(join(nm, '@shgroup'), { recursive: true })
    cpSync(HOOKS_DIR, dst, {
      recursive: true,
      filter: (src) => {
        const base = src.split('/').pop() ?? ''
        return !['tests', 'src', '.pnpm-store', 'client', 'node_modules'].includes(base) && !src.endsWith('tsconfig.json') && !src.endsWith('dsh.plugin.json')
      },
    })
    console.log(`    copied -> ${dst}`)
  }
  // profile 真实目录（公开版运行时目标）：替换任何历史符号链接（旧 staging 时代残留）
  for (const dst of profileTargets) {
    try {
      if (lstatSync(dst).isSymbolicLink()) rmSync(dst, { force: true })
    } catch { /* 不存在或非链接 */ }
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(HOOKS_DIR, dst, {
      recursive: true,
      filter: (src) => {
        const base = src.split('/').pop() ?? ''
        return !['tests', 'src', '.pnpm-store', 'client', 'node_modules'].includes(base) && !src.endsWith('tsconfig.json') && !src.endsWith('dsh.plugin.json')
      },
    })
    console.log(`    copied -> ${dst}（真实目录，非链接）`)
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
  const registryEnv = registry ? { npm_config_registry: registry } : {}

  // 解析目标版本：显式版本直接使用；缺省/latest 查 registry 最新版。
  let target = version
  if (target === undefined || target === 'latest') {
    const view = run('npm', ['view', '@shgroup/dsh-serenity-hooks', 'version'], {
      cwd: process.cwd(),
      quiet: true,
      env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...registryEnv },
    })
    if (view.status !== 0) {
      console.error(view.stdout + view.stderr)
      fail(`npm view 最新版本失败 (exit ${view.status})`, 2)
    }
    target = view.stdout.trim().split('\n').pop() ?? ''
    if (target === '') fail('npm view 返回空版本', 2)
    console.log(`[dsh-develop] registry 最新版本: ${target}`)
  }
  const pkgSpec = `@shgroup/dsh-serenity-hooks@${target}`
  console.log(
    `[dsh-develop] npm 安装 ${pkgSpec} 到 profile '${profile}'（官方 dsh plugin add 路径）` +
      (registry ? `｜源覆盖: ${registry}` : ''),
  )
  const r = run(bin, ['plugin', '--profile', profile, 'add', pkgSpec], {
    cwd: process.cwd(),
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...registryEnv },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`dsh plugin add 失败 (exit ${r.status})`, 2)
  }
  console.log(r.stdout.trim() || r.stderr.trim())
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
    input.destroy?.()
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

  const versionKnown = headerVersion !== null && supported !== null
  if (versionKnown && headerVersion > supported) {
    await stopEarly()
    return {
      headerVersion, events, malformedLines, ignorableUnknown, offences, verdict: 'refused-version',
      detail: `日志 format v${headerVersion} > 本机宿主支持 v${supported} → 宿主会拒绝（"written by a newer harness — upgrade the harness"）`,
    }
  }
  if (versionKnown && headerVersion < supported) {
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
  const r = run('pnpm', args, {
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
  const r = run('pnpm', ['install', '--lockfile-only', '--frozen-lockfile', '--store-dir', storeDir], { cwd: HOOKS_DIR, quiet: true })
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
  const r = run('pnpm', ['install', '--lockfile-only', '--store-dir', storeDir], { cwd: HOOKS_DIR, quiet: true })
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
      case 'pack-check': verifyTarball(); break
      case 'readme-sync': syncPackageReadme(); break
      case 'github-push-repo': cmdGithubPushRepo(rest[0]); break
      case 'github-ls': cmdGithubLs(rest[0]); break
      case 'version': cmdVersion(); break
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
      case 'deploy': cmdDeploy(); break
      case 'npm-install': cmdNpmInstall(rest[0] ?? 'web', rest[1], rest[2]); break
      case 'npm-install-dev': cmdNpmInstallDev(rest); break
      case 'lockfile': cmdLockfile(); break
      case 'restart-web': cmdRestartWeb(); break
      case 'host-upgrade': cmdHostUpgrade(rest); break
      case 'session-doctor': await cmdSessionDoctor(rest); break
      case 'session-repair': await cmdSessionRepair(rest); break
      case 'api-status': cmdApiStatus(rest[0]); break
      case 'inspect-dsh': cmdInspectDsh(rest[0]); break
      case 'read-dsh': cmdReadDsh(rest[0], rest[1], rest[2]); break
      case 'host-fetch': cmdHostFetch(rest[0], rest.slice(1)); break
      case 'dump-config': cmdDumpConfig(rest[0]); break
      case '--list':
      case 'list':
        console.log('typecheck | typecheck-host <ver> | test [--filter] | coverage | build | status | commit <msg> | push | version | bump <ver> | deploy | npm-install [<profile>] [<version>] [<registry>] | restart-web | host-upgrade <ver|tag> [--registry <url>] [--dry-run] | session-doctor [--root <dir>] [--session <id>] [--json] [--deep] [--limit <n>] | session-repair [--root <dir>] [--session <id,...>] [--apply] [--backup-dir <dir>] [--min-age-min <n>] [--force] [--probe] [--json] | squash-history [<msg>] | github-push [--force] | pack-check | readme-sync | publish | inspect-dsh <pattern> | host-fetch <ver> [pkg[@ver]]')
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
用法: dsh-develop <typecheck|test|coverage|build|status|commit|push|version|bump|deploy|npm-install|lockfile|restart-web|pack-check|readme-sync|publish|github-push|squash-history> [args]
  typecheck             tsc --noEmit
  test [--filter <p>]   vitest run
  coverage              vitest run --coverage（阈值门禁见 vitest.config.ts）
  build                 tsc + tsdown 双 bundle
  status                git status + 版本
  commit <message>      git add -A + commit
  push                  git push origin（GitHub，SSH-443）
  version               三处版本一致性
  bump <x.y.z>          package.json + dsh.plugin.json 版本同步
  deploy                load-plugin.sh 全流程（构建+双锚+shim+profile+预检）
  npm-install [profile] [version] 官方 npm 安装：缺省/latest=registry 最新；可指定精确版本
  npm-install-dev <pkg...> hooks 开发依赖安装（npm install --save-dev；client bundle 内联）
  lockfile              重生成 hooks pnpm-lock.yaml + 用 --frozen-lockfile 自检（CI 同款判定）
  restart-web           kill + setsid 重启 dsh web（健康检查）
  host-upgrade <ver|tag> 全局升级 DSH 宿主 CLI（包名硬编码 @deepseek-ai/dsh；默认官方源；--dry-run 预览）
  session-doctor        会话日志体检（只读）：逐份判定宿主读取门（未知事件词表/格式版本/结构），列出会被拒的会话
  session-repair        会话日志治疗（缺省 dry-run）：补 rebuild 写坏的 user/message 缺 id/role；--apply 才备份+原子替换+自检
  squash-history [msg]  抹除历史为单个初始 commit（公开发布前清敏感历史；不可逆）
  pack-check            npm pack --dry-run 核对 tarball 完整性（chunk/双 bundle/类型）
  readme-sync           包内 README ← 仓库 README（机械同步，相对链接转绝对 URL）
  dump-config [pattern] dsh --dump-config（合成后的 profile 条目树；pattern 过滤）
  publish               npm publish @shgroup/dsh-serenity-hooks（凭据走 ~/.npmrc）
  github-push [--force] push 到 GitHub 公开仓库（tellmewhattodo）`)
        break
      default:
        fail(`未知子命令: ${sub}`)
    }
  } catch (e) {
    fail((e as Error).message, 2)
  }
}
