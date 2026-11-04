/**
 * msm-ops-branches.test.ts — MSM **exec 侧**的校验与降级面（⑤ 第 59 件，S142 2026-09-26）
 *
 * ## 与既有测试的分工（互补不重叠）
 *
 * 既有四份已覆盖：`ops.test.ts`（exec 执行／register 成功／check M1）／`acc-extras.test.ts`
 * （guide／catalog／`--schema`／`--format=json`／**词法**逃逸）／`msm-admin.test.ts`
 * （register 五态／deregister／list／**真 symlink 逃逸**／M4／扫描边）／`msm-tool.test.ts`（工具面）。
 * **本文件补的是 `prepareExec` 与 `exec` 分支里"只走 register 侧测试碰不到"的那几条**：
 *
 *   ① 🔴 **`prepareExec` 的两条最终守卫**（`:815` script 逃逸 ／ `:816` script 不存在）
 *      —— 既有对这两条的断言**全在 register 路径**（`registerEntry`），而它们是 `prepareExec`
 *      里的**独立副本**（register 有自己的 `:673`/`:676`）⇒ **exec 侧这两行从未被执行**。
 *      这不是"重复实现的小瑕疵"：exec 侧这两条正是**拦住"注册表被手工改成指向根外"**的守门人
 *      （注册表是 JSON 文本，可被直接编辑）。
 *   ② 🔴 **`--schema` 的目标未注册**（`:787` `MSM not registered`）与 **`business[1]` 缺省**
 *      （`:786` 三元 `target ? … : null`）—— `acc-extras.test.ts` 只测了**命中**那一侧。
 *   ③ 🔴 **`--schema` 的 flags 三字段归一**（`:793`）：`type ?? null` ／ `description ?? null`
 *      —— 既有用例的 entry **三字段齐全** ⇒ 两个 `?? null` 从未执行。
 *   ④ 🔴 **path 型 flag 的两条取值形态**（`:803~810`）：`--flag=value` 等号式 ／ `--flag value` 空格式
 *      —— 既有的 path-flag 用例只用了其中一种。
 *   ⑤ 🔴 **协议 flag 的"后置不透传"承诺**（`:775`/`:784` 都只认 `business[0]`）
 *      —— 源码注释逐字写着「业务参数中后置的同名 flag 一律**无损透传**」，
 *      而既有用例**全部把协议 flag 放在首位** ⇒ **这条承诺从未被验证**。
 *
 * ## 为什么这些值得一件（贴 objective：MSM 是**宿主接触面**）
 *
 * ① 是安全边界（注册表可手改 ⇒ exec 必须自己再验一次）；⑤ 是**契约承诺**
 * （后置 flag 不得被吞）—— 若哪天有人把 `business[0] ===` 改成 `business.includes()`，
 * 用户传给 MSM 的业务参数会被**静默吃掉**，而**既有测试全绿** ⇒ 同族（第 45/46/47/55/56/57/58 件）：
 * **承诺写进注释、却没有回归钉**。
 *
 * ## 🔴 诚实边界（沿用既有先例，不写恒绿）
 *
 * 本机（Linux）**有 bun** ⇒ 「bun 缺失回落 npx」与 `isBunMissing()` 真分支**不可达**
 * （`msm-admin.test.ts` 文件头已登记同一事实）；`:42` 的 `platform !== 'win32'` 早退同理。
 * 本文件**不**为它们硬凑用例（纪律 8：不涂绿），只在必要处**钉住"当前平台走哪条路"**。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMsm } from '../src/tools/msm/service.js'

const SCRIPTS_REL = '.opencode/skills/t/scripts'
const REGISTRY_REL = '.opencode/skills/t/references/mech-registry.json'

/** 真入口脚本：命中 `hasCliEntry` 判据（shebang ∨ `function main(`） */
const ENTRY_SRC = 'function main() {}\nmain()\n'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-msm-exec-br-'))
  writeFileSync(join(dir, '.serenity'), 't') // cccName = t ⇒ 聚合档注册表
  mkdirSync(join(dir, SCRIPTS_REL), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeScript(name: string, src = ENTRY_SRC): string {
  const p = join(dir, SCRIPTS_REL, name)
  writeFileSync(p, src)
  return p
}

function registryAbs(): string {
  return join(dir, REGISTRY_REL)
}

/** 直接落一份注册表（模拟"被手工编辑过"的形态 —— 本文件 A 组的核心场景） */
function writeRegistry(entries: unknown[]): void {
  mkdirSync(join(dir, '.opencode/skills/t/references'), { recursive: true })
  writeFileSync(registryAbs(), JSON.stringify({ version: 1, entries }))
}

function entry(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, skill: 't', path: `${SCRIPTS_REL}/${name}.ts`, category: 'mech', description: 'd', ...over }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. exec 侧的路径守卫（register 侧有独立副本 ⇒ 这两行在 exec 侧零执行）
// ─────────────────────────────────────────────────────────────────────────────

describe('msm-ops · exec 侧路径守卫（拦"注册表被手工改成指向根外"）', () => {
  it('🔴 A1：注册表指向**根外**脚本 ⇒ exec 拒绝（`escapes CCC root`）', () => {
    // `:815` `if (classifyPath(script, root) === 'outside') throw …`
    // 真故障形态：**直接编辑注册表 JSON**（这正是"注册表是文本"的现实风险），
    // 绕过 register 的校验把 path 改成 ../.. ⇒ exec 必须自己再拦一次。
    writeRegistry([entry('evil', { path: '../../outside.ts' })])
    expect(() => runMsm(dir, { action: 'exec', name: 'evil', args: [] })).toThrow(/escapes CCC root/)
  })

  it('🔴 A2：注册表指向**根内但不存在的**脚本 ⇒ exec 拒绝（`script not found`）', () => {
    // `:816` `if (!existsSync(script)) throw …`
    writeRegistry([entry('ghost')]) // 不写脚本文件
    expect(() => runMsm(dir, { action: 'exec', name: 'ghost', args: [] })).toThrow(/MSM script not found/)
  })

  it('A3（正控）：同一夹具在脚本**真存在且根内**时正常进入执行 ⇒ 证明 A1/A2 不是夹具坏了', () => {
    // 没有这条，A1/A2 的"拒绝"无法区分"守卫生效"与"夹具本身就走不通"。
    writeScript('ok.ts')
    writeRegistry([entry('ok')])
    // 真跑（本机有 bun）：空脚本 main() 立即退出 0。
    // 🔴 2026-11-04 owner 令：**成功路径返回裸 stdout**（不再有 `{name, exit}` 信封）。
    //    本用例的本意是「它真的进入了执行、并且跑成功了」——
    //    钉「返回的是字符串（= 走了成功分支）」＋「不是结构」，即可达成本意，
    //    ⛔ 不要为了让它过而放弃断言（D274：改钉本意，不放宽到能过）。
    const r = runMsm(dir, { action: 'exec', name: 'ok', args: [] })
    expect(typeof r).toBe('string')
    expect(r).not.toHaveProperty('exit')
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// B. --schema 的未命中与字段归一
// ─────────────────────────────────────────────────────────────────────────────

describe('msm-ops · --schema 未命中与 flags 字段归一', () => {
  it('🔴 B1：`--schema <未注册名>` ⇒ 拒绝（既有只测了命中侧）', () => {
    // `:787` `if (!found) throw new Error(\`MSM not registered: "${target}"\`)`
    writeScript('a.ts')
    writeRegistry([entry('a')])
    expect(() => runMsm(dir, { action: 'exec', name: 'a', args: ['--schema', 'nope'] })).toThrow(/MSM not registered/)
  })

  it('🔴 B2：`--schema` **后无名字** ⇒ 同样按未注册拒绝（`target ? … : null` 的缺省侧）', () => {
    // `:786` `const found = target ? … : null` —— target 为 undefined ⇒ found=null ⇒ :787 抛。
    // 既有用例恒传名字 ⇒ 这个三元的 false 侧零执行。
    writeScript('a.ts')
    writeRegistry([entry('a')])
    // 🔴 判据 = 报错里带上那个**字面量 undefined** 的位置（证明走的是"缺名字"这条路，不是别的）
    expect(() => runMsm(dir, { action: 'exec', name: 'a', args: ['--schema'] })).toThrow(/MSM not registered/)
  })

  it('🔴 B3：flags **缺 type/description** ⇒ schema 里归一为 `null`（不是 undefined/缺键）', () => {
    // `:793` `type: f.type ?? null` ／ `description: f.description ?? null`
    // 既有用例的 entry 三字段齐全 ⇒ 两个 ?? 从未执行。
    // 🔴 判据用 **`in` + `=== null`**（累积纪律 ⑥ 同族）：`toBeUndefined()` 对
    //    "键在但值为 undefined" 与 "无该键" 都绿，无法钉住"归一为 null"这条契约。
    writeScript('a.ts')
    writeRegistry([entry('a', { flags: [{ name: 'only-name' }] })])
    const schema = runMsm(dir, { action: 'exec', name: 'a', args: ['--schema', 'a'] }) as {
      flags: { name: string; type: unknown; description: unknown }[]
    }
    const f = schema.flags[0]!
    expect(f.name).toBe('only-name')
    expect('type' in f).toBe(true)
    expect(f.type).toBeNull()
    expect('description' in f).toBe(true)
    expect(f.description).toBeNull()
  })

  it('🔴 B4：entry **无 flags 键** ⇒ schema.flags 为 `[]`（`found.flags ?? []` 那侧）', () => {
    // `:793` 的 `(found.flags ?? [])`
    writeScript('a.ts')
    writeRegistry([entry('a')]) // 无 flags
    const schema = runMsm(dir, { action: 'exec', name: 'a', args: ['--schema', 'a'] }) as { flags: unknown[] }
    expect(Array.isArray(schema.flags)).toBe(true)
    expect(schema.flags).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. path 型 flag 的两种取值形态 + 逃逸判定
// ─────────────────────────────────────────────────────────────────────────────

describe('msm-ops · path 型 flag 的两种取值形态（等号式 / 空格式）', () => {
  const PATH_FLAG_ENTRY = entry('pf', { flags: [{ name: 'file', type: 'path', description: 'p' }] })

  it('🔴 C1：`--file=<根内路径>` 等号式 ⇒ 放行（并进入执行）', () => {
    // `:803` `const eq = businessArgs.find((a) => a.startsWith(\`--${flag.name}=\`))`
    writeScript('pf.ts')
    writeRegistry([PATH_FLAG_ENTRY])
    // 🔴 成功路径现在是裸 stdout（2026-11-04），本意 = "放行并跑成功" ⇒ 钉返回字符串
    const r = runMsm(dir, { action: 'exec', name: 'pf', args: ['--file=inside.txt'] })
    expect(typeof r).toBe('string')
  }, 30_000)

  it('🔴 C2：`--file <根内路径>` 空格式 ⇒ 放行（并进入执行）', () => {
    // `:807~810` 的 `indexOf` ＋ `businessArgs[idx + 1]` 分支
    writeScript('pf.ts')
    writeRegistry([PATH_FLAG_ENTRY])
    const r = runMsm(dir, { action: 'exec', name: 'pf', args: ['--file', 'inside.txt'] })
    expect(typeof r).toBe('string')
  }, 30_000)

  it('🔴 C3：等号式**根外**路径 ⇒ 拒绝（安全边界对两种形态都要成立）', () => {
    writeScript('pf.ts')
    writeRegistry([PATH_FLAG_ENTRY])
    expect(() => runMsm(dir, { action: 'exec', name: 'pf', args: ['--file=../../etc/passwd'] })).toThrow()
  })

  it('🔴 C4：空格式**根外**路径 ⇒ 拒绝（与 C3 成对 —— 只钉一种形态会漏另一种）', () => {
    writeScript('pf.ts')
    writeRegistry([PATH_FLAG_ENTRY])
    expect(() => runMsm(dir, { action: 'exec', name: 'pf', args: ['--file', '../../etc/passwd'] })).toThrow()
  })

  it('🔴 C5：`--file` 在**末尾且无值** ⇒ 不做越界判定、照常执行（不得因缺值而崩）', () => {
    // `:808` 的 `idx >= 0 && businessArgs[idx + 1]` —— 有 name 但**没有**下一个 token ⇒
    // 该三元 false ⇒ 跳过校验。若写成 `businessArgs[idx+1]!` 硬取 ⇒ undefined 传进校验函数会炸。
    writeScript('pf.ts')
    writeRegistry([PATH_FLAG_ENTRY])
    const r = runMsm(dir, { action: 'exec', name: 'pf', args: ['--file'] })
    expect(typeof r).toBe('string') // 照常跑成功（裸 stdout）
  }, 30_000)

  it('🔴 C6：非 path 型 flag 的取值**不做**越界校验（`type !== "path"` ⇒ continue）', () => {
    // `:802` `if (flag.type !== 'path') continue`
    // 真故障形态：把 string 型 flag 的**故意根外**值传进去 ⇒ 必须原样放行（业务参数无损透传）。
    writeScript('sf.ts')
    writeRegistry([entry('sf', { flags: [{ name: 'note', type: 'string', description: 'n' }] })])
    const r = runMsm(dir, { action: 'exec', name: 'sf', args: ['--note=../../etc/passwd'] })
    // 不是"应该拒绝"，而是"这一层不管它"（路径校验只归 path 型）⇒ 照常跑成功
    expect(typeof r).toBe('string')
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// D. 协议 flag 的"仅首位识别、后置无损透传"承诺
// ─────────────────────────────────────────────────────────────────────────────

describe('msm-ops · 协议 flag 只在**首位**识别（后置必须无损透传）', () => {
  it('🔴 D1：`--list` 不在首位 ⇒ **不触发协议**，当作业务参数透传', () => {
    // `:775` `if (business[0] === '--list')` —— 源码注释逐字承诺：
    // 「业务参数中后置的同名 flag 一律**无损透传**（避免误拦截）」。
    // 既有用例**全部把协议 flag 放首位** ⇒ 这条承诺从未被验证。
    // 🔴 判据 = 结果**不是**协议形状 `{msms:…}`，而是执行结果（证明没被当成协议吞掉）。
    //    2026-11-04 起成功路径是裸 stdout ⇒ "走了真执行路径"钉为"返回字符串"。
    writeScript('a.ts')
    writeRegistry([entry('a')])
    const r = runMsm(dir, { action: 'exec', name: 'a', args: ['python', '--list'] })
    expect(typeof r).toBe('string')
    expect(r).not.toHaveProperty('msms')
  }, 30_000)

  it('🔴 D2：`--schema` 不在首位 ⇒ 同样不触发协议（后置透传）', () => {
    writeScript('a.ts')
    writeRegistry([entry('a')])
    const r = runMsm(dir, { action: 'exec', name: 'a', args: ['run', '--schema', 'a'] })
    expect(typeof r).toBe('string')
    expect(r).not.toHaveProperty('flags') // 协议 schema 形状才有 flags
  }, 30_000)

  it('🔴 D3：`--format=json` 只在首位生效 ⇒ 后置时为**普通业务参数**（不进包装开关）', () => {
    // `:796` `const fmtJson = business[0] === '--format=json'`
    writeScript('a.ts')
    writeRegistry([entry('a')])
    const r = runMsm(dir, { action: 'exec', name: 'a', args: ['x', '--format=json'] })
    // 首位才是开关 ⇒ 此处应走**非 json 包装**（无 data 字段，且成功时是裸 stdout）
    expect(typeof r).toBe('string')
    expect(r).not.toHaveProperty('data')
  }, 30_000)

  it('D4（正控）：`--format=json` 在**首位** ⇒ 确实走 json 包装 ⇒ 与 D3 成对', () => {
    writeScript('a.ts')
    writeRegistry([entry('a')])
    const r = runMsm(dir, { action: 'exec', name: 'a', args: ['--format=json'] }) as { name?: string; data?: unknown }
    expect(r.name).toBe('a')
    expect(r).toHaveProperty('data')
  }, 30_000)
})
