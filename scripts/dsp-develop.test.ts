/**
 * dsp-develop.test.ts — DC-M1 配对测试
 *
 * 验证核心纯逻辑：版本读取（currentVersion）、版本一致性判断、bump 版本号校验。
 * 子命令执行链路（typecheck/test/build）由 acc_msm exec 冒烟覆盖（本项目惯例）。
 */

import { test, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')

function runDshDevelop(...args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bun', [join(SCRIPTS_DIR, 'dsp-develop.ts'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh') },
      timeout: 120_000,
    })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 2, stdout: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

let hasBun = true
beforeAll(() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' })
  } catch {
    hasBun = false
  }
})

test('version 输出三处版本且一致', () => {
  if (!hasBun) return
  const r = runDshDevelop('version')
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('package.json')
  expect(r.stdout).toContain('dsh.plugin.json')
  expect(r.stdout).toContain('CHANGELOG.md')
  expect(r.stdout).toContain('✓ 版本一致')
})

test('bump 拒绝非法版本号', () => {
  if (!hasBun) return
  const r = runDshDevelop('bump', 'not-a-version')
  expect(r.status).not.toBe(0)
  expect(r.stdout).toContain('bump 需要版本号')
})

test('list 输出子命令清单', () => {
  if (!hasBun) return
  const r = runDshDevelop('list')
  expect(r.status).toBe(0)
  for (const cmd of ['typecheck', 'test', 'build', 'status', 'commit', 'push', 'version', 'bump', 'deploy']) {
    expect(r.stdout).toContain(cmd)
  }
})

test('未知子命令报错（退出码 1）', () => {
  if (!hasBun) return
  const r = runDshDevelop('no-such-cmd')
  expect(r.status).toBe(1)
  expect(r.stdout).toContain('未知子命令')
})

/**
 * 🔴 退役命令的行为 pin（S142 2026-09-24）：`diag` 的对象（autopilot 唤起条件链）随 v1.35.0
 * 整段退场后已不存在 ⇒ 它**只印路牌且恒 exit 2**。**exit 2 是验收的一部分**：
 * 退出 0 会让调用方以为"诊断跑通了"（静默的假成功，比报错更坏）。
 */
test('diag 已退役：印路牌且恒 exit 2（不许变 0）', () => {
  if (!hasBun) return
  const r = runDshDevelop('diag')
  expect(r.status).toBe(2)
  expect(r.stdout).toContain('已退役')
  expect(r.stdout).toContain('acc-diag')          // 替代品写进了路牌
  expect(r.stdout).not.toContain('Cannot find module') // 不再是"看着像环境缺模块"的症状
})

/**
 * 🔴 `deploy` 的复制集合必须是**发布物清单本身**（S142 2026-09-24 取证后的修法）。
 * 判据 = 白名单驱动：发布物有的**必须有**，发布物没有的**一个都不许有**。
 * 反例清单取自那次**实测**的缺陷读数（当时副本多出 11 类、并反向缺 dsh.plugin.json）。
 */
test('deploy --list-copy-set：复制集合 = 发布物白名单（无黑名单漏项）', () => {
  if (!hasBun) return
  const r = runDshDevelop('deploy', '--list-copy-set')
  expect(r.status).toBe(0)
  // 必须有的（双 bundle + 声明面 + 清单本体）
  for (const f of ['lib/index.js', 'lib/client.js', 'lib/invariant.js',
    'assets/serenity-voyage.html', 'cordis.patch.yml', 'dsh.plugin.json', 'package.json']) {
    expect(r.stdout).toContain(f)
  }
  // 🔴 一个都不许有的（本缺陷的形态：黑名单只能枚举"想不到的"，所以它总会漏）
  for (const f of ['coverage/', 'experiments/', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsdown.config.ts', 'vitest.config.ts', 'tsconfig.prepare.json', 'tsconfig.host-']) {
    expect(r.stdout).not.toContain(f)
  }
})

/**
 * 🔴 回归钉：`host-fetch` 的默认包集必须**覆盖两份基准 tsconfig 声明的全部宿主包**。
 *
 * 为什么钉这条（S142 2026-09-28，同族坑**第二次**踩）：默认集是手维护的
 * （peer 过滤 `@deepseek-ai/dsh-` ＋ 两张硬编码表），与 tsconfig 的 `paths` 各自演化 ⇒
 * `host-fetch <ver>` 报"成功"，紧接着 `typecheck-host <ver>` 却失败于
 * 「派生 paths 指向缺失目录（10 条）」——**看起来像宿主删包，其实只是默认集少了几项**。
 * 那一次卡住了整条适配链的入口（上一次 rc.1→rc.2 轮同样卡过）。
 *
 * 判据形态：**枚举型**（把两份 tsconfig 的宿主包名全枚举出来，逐项查是否在包集里），
 * 不是"点名型"——这样新加一条 `paths` 而忘了抓包时，它会**自动**变红。
 */
test('host-fetch --list：默认包集 ⊇ 两份基准 tsconfig 声明的全部宿主包', () => {
  if (!hasBun) return
  const r = runDshDevelop('host-fetch', '0.0.0-list', '--list')
  expect(r.status).toBe(0)
  const raw = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@deepseek-ai/'))
  // 去版本后缀（`@deepseek-ai/cordis@4.0.4` → `@deepseek-ai/cordis`）
  const bare = new Set(raw.map((l) => l.split('@').slice(0, 2).join('@')))

  const declared = new Set<string>()
  for (const rel of ['tsconfig.json', 'client/tsconfig.json']) {
    const text = readFileSync(join(REPO_ROOT, 'hooks', 'dsh-serenity-hooks', rel), 'utf-8')
    // 🔴 只认**双引号内的 JSON 字符串值**：`paths` 的值是 JSON 字符串，而 tsconfig 是 JSONC，
    // 注释里也写过宿主路径（node 半的注释逐字记着**旧形态**
    // `…/.npm-global/…/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`）——
    // 那个注释里含 `@deepseek-ai/dsh`（**宿主元包，根本不在任何 path 里**）⇒
    // 不限定引号就会凭空多出一项假欠账（本用例首跑即因此红，实测）。
    for (const m of text.matchAll(/"[^"\n]*node_modules\/@deepseek-ai\/([a-z0-9-]+)/g)) {
      declared.add(`@deepseek-ai/${m[1]}`)
    }
  }

  // 正控：派生真读到了东西——否则"missing 为空"只是空集的假绿
  expect(declared.size).toBeGreaterThan(20)
  expect([...declared].filter((n) => !bare.has(n))).toEqual([])

  // vendor 包（不以 `dsh-` 开头）必须**已钉版本**：否则会被按宿主版本号去抓 ⇒ 必失败
  for (const vendor of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
    expect(bare.has(vendor)).toBe(true)
    expect(raw.some((l) => l.startsWith(`${vendor}@`))).toBe(true)
  }
})

/**
 * 🔴 回归钉（判据 43：退役必须留「旧形态不再出现」的钉）：**安装器族整体退役**。
 *
 * 钉的是什么：仓库根包 `@shgroup/dsh-serenity-plugin`（安装器 CLI ＋ init 向导 ＋ 技能模板）
 * 与其测试、其 tsconfig、其根级 mech-registry —— 2026-09-28（S142 ③ 周边整合）整体删除。
 * 判据形态用**枚举型 + 正控**：枚举 5 个旧路径断言**不存在**，再用**真产物在场**作正控
 * （否则"都不存在"可能只是我把路径写错了 —— 那是无法自证的假绿）。
 */
test('安装器族已退役：根 src/ bin/ tests/ tsconfig.json mech-registry.json 均不存在（含正控）', () => {
  for (const rel of ['src', 'bin', 'tests', 'tsconfig.json', 'mech-registry.json']) {
    expect(existsSync(join(REPO_ROOT, rel)), `旧路径仍在: ${rel}`).toBe(false)
  }
  // 正控：真产物必须在场 —— 证明上面那组"不存在"不是因为根路径解析错了
  expect(existsSync(join(REPO_ROOT, 'hooks', 'dsh-serenity-hooks', 'package.json'))).toBe(true)
  expect(existsSync(join(SCRIPTS_DIR, 'dsp-develop.ts'))).toBe(true)
})

/**
 * 🔴 同一条退役的第二个钉：**旧命令失去"绿门"形态**（判据 43 的第二半）。
 * 原先 `typecheck-cli` 是一道**会跑绿的门禁**，退役后它必须**恒非 0** ——
 * 否则门禁清单里会留一个"看起来还有这一关"的假象。
 */
test('typecheck-cli 已退役：恒 exit 2 且印路牌（不再是一道会跑绿的门）', () => {
  if (!hasBun) return
  const r = runDshDevelop('typecheck-cli')
  expect(r.status).toBe(2)
  expect(r.stdout).toContain('已退役')
})

/**
 * 🔴 回归钉（2026-10-17，A65 修复）：**"说反话"的处置文案不得复现**。
 *
 * 钉的是什么：本仓曾有三处「处置建议」把**未经取证的断言**当事实印出来 ——
 *   ① `cmdNpmInstall` 的失败收尾逐字写「packument 已含 <ver>」，而**那个分支根本没查过 packument**
 *      （实测反证：那一刻权威读数是 `no`）⇒ 照它信会得出「已上架、是安装端坏了」的**反向结论**。已发作 3 次。
 *   ② 装机核对分支写「pnpm 报了成功」＋「原因多半是…」，而该分支**也覆盖 pnpm 报错的情况**。
 *   ③ 「落后者属传播延迟」把"滞后"与"边缘负缓存"混成一个名称。
 *
 * 判据形态（同上方退役钉：**反向钉 + 正控**）：
 *   - 反向：那三句**旧文案不得再出现**（回来就报警）；
 *   - 正控：**新文案必须在场**（否则"旧的不在"可能只是文件没读到 / 路径错了 —— 无法自证的假绿）。
 *
 * ⚠️ 为什么必须是**静态钉**：这三处都在 `console.log/fail` 的**字符串**里，
 *   而现有测试（`dsp-develop.test.ts` 只覆盖版本读取/一致性/bump）**跑不到它们** ——
 *   "纯逻辑用例全绿"证明不了"这句话印对了"（v1.59.2 那条同族教训）。
 */
test('A65：处置文案里不得再出现未经取证的断言（反向钉 ＋ 正控）', () => {
  const src = readFileSync(join(SCRIPTS_DIR, 'dsp-develop.ts'), 'utf-8')

  // 🔴 **必须先剥注释再断言**：这次的修复本身就在注释里**逐字引用了旧文案**（为了说明"原来错在哪"）。
  //   若不剥注释，反向钉会把**解释这条修复的注释**当成"旧文案复现" ⇒ 假红。
  //   （这个假红本轮真的发生了 —— 它同时证明这条钉确实通电，见下方正控。）
  //   剥法：整行注释 `//…` + 块注释 `/* … */`（含跨行）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '')

  // 反向钉：三处旧文案，逐字不得复现（**在可执行代码里**）
  const banned = [
    'packument 已含 ${target}',
    '这不是"装不上"——pnpm 报了成功',
    '落后者属**传播延迟**',
  ]
  for (const s of banned) {
    expect(code.includes(s), `旧文案在代码里复现了（应已改成"当场取读数再断言"）：${s}`).toBe(false)
  }

  // 正控：新文案必须在场 —— 证明上面那组"不存在"不是因为读错文件/剥过头
  expect(code).toContain('实测读数（当场查，非推测）：packument 含')
  expect(code).toContain('packumentHasVersion(target)')
  expect(code).toContain('落后者属**滞后**')
  // 正控之二：**剥注释没有把代码也剥没**（否则上面三条"不含"会变成无法自证的假绿）
  expect(code).toContain('function cmdNpmInstall')
  expect(code).toContain('function currentVersion')
})
