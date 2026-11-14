/**
 * curl-timeout.test.ts — 机械钉子：**脚本里每一条 curl 都必须有超时上界**
 *
 * ## 为什么需要这条测试（它是本轮重构的根因，不是"顺手补个规范"）
 *
 * 2026-11-15 之前，`verifyPublished()` 里有一个 `for(;;)` 循环调 `landingRead()`，
 * 而 `landingRead` 的两条 curl **没有 `--max-time`**。后果不是"慢"，是**永久挂住**
 * 整个 MSM 调用 —— 网络一抖就不返回，且**没有任何信号**（工具调用就那么悬着）。
 *
 * ⇒ 判据：**无界的网络请求不允许存在于本仓脚本里**。
 *   这条判据的判别力在于：它扫的是**源码文本**，而不是"跑一次看看会不会挂"——
 *   后者要等真的网络抖动才发作，而那时你不在。
 *
 * ⚠️ 已知边界（如实登记）：
 *   · 本测试**只查 `scripts/` 下的 .ts**，不查 bench/ 与 _tmp/
 *   · 它认 `--max-time` 与 `-m` 两种写法；`curl` 若以变量拼接 URL 也照样能查到（只看参数）
 *   · 若有朝一日需要"故意无界的 curl"（极少见），必须在本文件里加白名单**并写明理由**
 */

import { test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

/** 白名单：文件 → 允许无超时 curl 的行号理由（当前为空，且应保持为空） */
const ALLOWLIST: Record<string, string> = {}

/**
 * 扫描域排除：**测试文件自身**。
 *
 * 🔴 理由（不是"图省事"）：本文件的 C3 用例里**必然**含有"一条无超时的 curl"字面量
 *   —— 那是被测样本，不是被测对象。若把测试文件纳入扫描域，门禁会因为**自己的样本**而恒红。
 * ⚠️ 这条排除的代价：`scripts/` 下**其他**测试文件也不被扫了。
 *   可接受，因为测试文件不发起真实网络请求（它们跑的是纯函数或本地夹具）。
 */
function isTestFile(name: string): boolean {
  return name.endsWith('.test.ts') || name.endsWith('.dev.test.ts')
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !isTestFile(d.name))
    .filter((d) => d.name.endsWith('.ts') || d.name.endsWith('.mjs'))
    .map((d) => join(dir, d.name))
}

/**
 * 抽出一行里 `run('curl', [...])` 的真实调用。
 *
 * 🔴 第一版扫描器过于粗（只看该行有没有 `'curl'`），一次就误报了三处：
 *   · 本文件的**注释**（描述 curl 的句子）
 *   · `sys` 子命令的**白名单数组**（`['ps','ss','curl',…]`）
 *   而误报会训练人"这条门禁噪音大 ⇒ 选择性忽略"，那比没有门禁更坏。
 * ⇒ 收窄到**调用形态**：必须是 `run(` 或 `run(` 前有 `run('curl'` 紧邻的实参列表。
 * ⚠️ 同时**保留**注释行剔除，但不剔除白名单数组 —— 前者是自然语言，后者靠形态区分。
 */
function curlCalls(source: string): Array<{ line: number; argsText: string }> {
  const out: Array<{ line: number; argsText: string }> = []
  const lines = source.split('\n')
  lines.forEach((text, i) => {
    // 调用形态：run('curl', [...]  —— 前面允许有空白/赋值
    const m = /run\(\s*['"]curl['"]\s*,/.exec(text)
    if (m === null) return
    // 剔除整行是注释的情况（`// …` 或 ` * …`）
    const trimmed = text.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    out.push({ line: i + 1, argsText: text.slice(m.index) })
  })
  return out
}

test('C1 scripts/ 下每一条 curl 都带超时上界（--max-time 或 -m）', () => {
  const offenders: string[] = []
  for (const file of tsFiles(SCRIPTS_DIR)) {
    const rel = file.slice(SCRIPTS_DIR.length + 1)
    const src = readFileSync(file, 'utf-8')
    for (const call of curlCalls(src)) {
      const hasTimeout = /--max-time|['"]-m['"]/.test(call.argsText)
      if (!hasTimeout && ALLOWLIST[rel] === undefined) {
        offenders.push(`${rel}:${call.line}  ${call.argsText.slice(0, 100)}`)
      }
    }
  }
  expect(offenders, `发现无超时的 curl（网络一抖就会永久挂住整个 MSM 调用）：\n${offenders.join('\n')}`)
    .toEqual([])
})

test('C2 正控：本测试**确实**能找到 curl 调用（否则 C1 是空转）', () => {
  // 若扫描面写错（比如路径不对、正则不匹配），C1 会"永远绿"——
  // 那是最坏的假绿形态。⇒ 必须先证明扫描面非空。
  const src = readFileSync(join(SCRIPTS_DIR, 'dsp-develop.ts'), 'utf-8')
  const calls = curlCalls(src)
  expect(calls.length).toBeGreaterThan(3)
})

test('C3 变异靶：故意造一条无超时的 curl ⇒ 检测逻辑必须报出来', () => {
  // 直接喂给检测函数，而不是往真文件里写（⛔ 不改被测对象）
  const bad = "  const r = run('curl', ['-s', '-o', '/dev/null', url], { quiet: true })"
  const calls = curlCalls(bad)
  expect(calls).toHaveLength(1)
  const hasTimeout = /--max-time|['"]-m['"]/.test(calls[0]!.argsText)
  expect(hasTimeout).toBe(false)

  // 正控：带 --max-time 的同形调用必须被判为"有上界"
  const good = "  const r = run('curl', ['-s', '--max-time', '8', url], { quiet: true })"
  expect(/--max-time|['"]-m['"]/.test(curlCalls(good)[0]!.argsText)).toBe(true)

  // 负控：白名单数组与注释**不得**被当成调用（第一版的误报源）
  expect(curlCalls("        if (!['ps', 'ss', 'curl', 'git'].includes(cmd)) {")).toHaveLength(0)
  expect(curlCalls("   * 读 dist-tags（走 `run('curl', …)`）")).toHaveLength(0)
})
