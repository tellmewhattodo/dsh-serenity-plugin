/**
 * bench/trajectory-prompt-probe.mjs —— 轨迹提示词装配探针（真机判据，非单测）
 *
 * 用途：在**真实的 CCC** 上验证 v1.72.0 的装配结果，而不是依赖模型自述
 * （「你有没有某段」这类提问会受提示词回声污染 —— 本轨已踩过）。
 *
 * 判据（四条，逐条可证伪）：
 *  J1 容器层在：`=== Serenity ACC ===` 与 `=== Serenity EAP ===` 都出现
 *  J2 轨迹提示词在：`=== Serenity Trajectory Prompt ===` 出现，且**紧跟标题的第一行**
 *     与该轨迹 PROMPT.md 的第一行正文逐字相同
 *  J3 **顺序**：ACC → EAP → Trajectory Prompt → Tools（先容器、再质量、再章程、最后工具参考）
 *  J4 无该轨迹 ⇒ 第 ⑧ 段消失（反向控制：证明它来自轨迹，不是恒有的噪声）
 *
 * 用法：node bench/trajectory-prompt-probe.mjs <CCC 根> <轨迹目录名> [对比用轨迹目录名]
 * 退出码：0 全过 ／ 1 有失败 ／ 2 参数错
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const [root, dirName, otherDir] = process.argv.slice(2)
if (!root || !dirName) {
  console.error('用法: node bench/trajectory-prompt-probe.mjs <CCC 根> <轨迹目录名> [另一轨迹目录名]')
  process.exit(2)
}

const libUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href
let mod
try {
  mod = await import(libUrl)
} catch (err) {
  console.error(`✗ 无法载入 lib/index.js: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}

/** 从发布物里取装配函数（导出名可能是 serenitySystemPrompt，也可能被收敛进命名空间） */
const build =
  mod.serenitySystemPrompt ??
  mod['system-prompt']?.serenitySystemPrompt ??
  mod.default?.serenitySystemPrompt
if (typeof build !== 'function') {
  const keys = Object.keys(mod).filter((k) => /prompt/i.test(k)).slice(0, 10)
  console.error(`✗ 发布物里找不到 serenitySystemPrompt（相关导出：${keys.join(', ') || '(无)'}）`)
  process.exit(2)
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

/** 取某标记块之后的第一行非空正文 */
function firstLineAfter(text, marker) {
  const i = text.indexOf(marker)
  if (i < 0) return null
  const rest = text.slice(i + marker.length).split('\n')
  for (const line of rest) {
    const t = line.trim()
    if (t !== '') return t
  }
  return null
}

// ── 主装配（给一条轨迹） ──
const withTraj = build(root, 'probe-scope', dirName)
check('J1 容器层在（ACC）', withTraj.includes('=== Serenity ACC ==='))
check('J1 容器层在（EAP 自检）', withTraj.includes('=== Serenity EAP ==='))

const promptFile = join(root, 'AGENT_SESSIONS', dirName, 'PROMPT.md')
const hasPromptFile = existsSync(promptFile)
check('J2 轨迹提示词段出现', withTraj.includes('=== Serenity Trajectory Prompt ==='),
  hasPromptFile ? '' : '（该轨迹无 PROMPT.md —— 本格预期为 ❌，属正常）')

if (hasPromptFile) {
  const firstBody = readFileSync(promptFile, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('>')) ?? ''
  const inPrompt = firstLineAfter(withTraj, '=== Serenity Trajectory Prompt ===')
  check('J2 正文与 PROMPT.md 逐字一致', inPrompt === firstBody,
    inPrompt === firstBody ? '' : `提示词首行=${JSON.stringify(inPrompt)} ／ 文件首行=${JSON.stringify(firstBody)}`)
}

// ── 顺序 ──
const iAcc = withTraj.indexOf('=== Serenity ACC ===')
const iEap = withTraj.indexOf('=== Serenity EAP ===')
const iTraj = withTraj.indexOf('=== Serenity Trajectory Prompt ===')
// 🔴 v1.124.0：工具清单块已删（owner 令"省点空间"），该位置只剩 MSM 调用示例 ⇒ 标题改 `Serenity MSM`。
//    ⚠️ 漏改这里的后果：`indexOf` 恒 -1 ⇒ 断言 `iEap < iTools` 变成 `iEap < -1` 恒假，探针**恒红**；
//    反之若哪个断言写成 `> iTools`，会变成**恒绿**（-1 小于一切）。两种都失去判别力。
const iMsm = withTraj.indexOf('=== Serenity MSM ===')
check('J3 顺序 ACC → EAP → Trajectory Prompt → MSM',
  iMsm > 0 && iAcc >= 0 && iAcc < iEap && (iTraj < 0 || iEap < iTraj) && iEap < iMsm,
  `acc=${iAcc} eap=${iEap} traj=${iTraj} msm=${iMsm}`)

// ── 反向控制：不给轨迹 ⇒ 第 ⑧ 段消失 ──
const noTraj = build(root, 'probe-scope', undefined)
check('J4 反向控制：不给轨迹 ⇒ 无 Trajectory Prompt 段（证明它来自轨迹，不是恒有噪声）',
  !noTraj.includes('=== Serenity Trajectory Prompt ==='))

// ── 另一条轨迹（串味检查：两份章程不得互相出现） ──
if (otherDir) {
  const other = build(root, 'probe-scope', otherDir)
  const otherFile = join(root, 'AGENT_SESSIONS', otherDir, 'PROMPT.md')
  if (existsSync(otherFile) && hasPromptFile) {
    const a = readFileSync(promptFile, 'utf-8').trim()
    const b = readFileSync(otherFile, 'utf-8').trim()
    const aFirst = a.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('>')) ?? ''
    const bFirst = b.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('>')) ?? ''
    const wrongInOther = aFirst !== '' && aFirst !== bFirst && other.includes(aFirst)
    check('J5 串味检查：另一条轨迹的装配里不出现本条章程', !wrongInOther,
      wrongInOther ? '另一条轨迹拿到了本条的首行' : '')
    const wrongInThis = bFirst !== '' && aFirst !== bFirst && withTraj.includes(bFirst)
    check('J5 串味检查：本条装配里不出现另一条章程', !wrongInThis,
      wrongInThis ? '本条拿到了另一条的首行' : '')
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[probe] ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('[probe] 失败项：')
  for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`)
  process.exit(1)
}
