/**
 * browser/extend.ts — CCC 给 `browser_slot` 写扩展的唯一通道
 *
 * 🔴🔴 owner 2026-11-10 令（逐字）：
 *    「我希望所有浏览器能力都集中到这个 browser_slot，同时这个 browser_slot 支持
 *      CCC 给它写扩展，这样各个 CCC 可以用上最好的浏览器操作能力」
 *
 * ═══════════════════════════════════════════════════════════════════
 * ## 契约：**ACC 只 spawn，从不 import**（照 CRO 的 B 案，2026-09-19 owner 裁「B 是设计」）
 *
 * `cro/core.ts` 把理由写得很清楚，这里逐条适用，一条不少：
 *   ① ACC **import** 用户的 TS ⇒ ACC 依赖 CCC 的**源码路径**，而 npm 装机版在别处
 *      ⇒ 两条路径都要活 = **两个真相源**。
 *   ② 用户程序**语法错会让 ACC 启动失败** ⇒ 一个用户程序的错误放倒整个容器。
 * ⇒ 进程边界把两件事同时挡掉：路径只需一个（文件系统），错误被隔离在子进程里。
 *
 * ⚠️ 并且浏览器扩展比 CRO 更需要在进程边界外：它要**驱动一个真浏览器**，
 *    而 Chrome 的失败形态（sandbox / 显示层 / 自杀窗口）已经在 2026-11-09 付过一次代价。
 *    让那些失败只死在一个子进程里，⛔ 不牵连宿主。
 *
 * ## 落点（文件在 = 启用，不在 = 禁用；无 enabled 字段、无注册表）
 *
 *   <CCC 根>/AGENT_SESSIONS/…           ← 轨迹级不看这里
 *   <CCC 根>/browser-ext/<name>.ts      ← CCC 级扩展（本模块扫这里）
 *
 * 判据（为什么放在 CCC 根而不是 `.opencode/skills`）：扩展要跟着 **CCC 的 git** 走
 * —— `browser-ext/` 就在根上，clone 下来即可用；放进某个 skill 的 scripts 会把它
 * 绑死到那个 skill 的目录约定上，而扩展是**跨 skill** 的浏览器能力。
 *
 * ## 协议（stdin JSON 进、stdout JSON 出、退出码说话）
 *
 * 输入（stdin，单行 JSON）：
 *   { "name": "my-ext", "slot": 1, "port": 9301,
 *     "args": { …调用方 --ext-arg 传的键值… },
 *     "cccRoot": "/…", "timeoutMs": 30000 }
 *
 * 输出（stdout，**最后一个非空行**必须是 JSON）：
 *   { "ok": true,  "result": <任意 JSON> }
 *   { "ok": false, "error": "人话原因" }     ← ok:false = 扩展自己报的失败
 *
 * 判据（为什么规定"最后一个非空行"）：扩展可以自由 `console.log` 调试输出，
 * ⛔ 不要求它保持 stdout 干净 —— 那会让"加一句 debug"变成破坏契约的动作。
 * 反例先例：CRO 的 `parseCroOutput` 也是取最后一行 JSON。
 *
 * ## 铁律：扩展的任何失败，绝不影响 `browser_slot` 的既有动作
 *
 * 超时 kill / 非 0 退出 / spawn 失败 / stdout 不是 JSON ⇒ **仅日志 + 结构化失败返回，绝不抛**。
 * （先例 = `im/hook.ts` 的旁路容忍 ＋ `cro/core.ts` 的同一条铁律。）
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveInside } from '../kernel/ccc.js'

/** 扩展目录（相对 CCC 根） */
export const EXT_DIR_REL = 'browser-ext'

/** 单次扩展硬超时（比 CRO 的 60s 短：它要驱动浏览器，长任务应自己分批） */
export const EXT_TIMEOUT_MS = 45_000

/** stdout 上限（防一个坏扩展把日志撑爆） */
const EXT_STDOUT_MAX = 64 * 1024

/** 一个已发现的扩展 */
export interface ExtEntry {
  /** 扩展名 = 文件名去掉 `.ts`（**这就是调用时用的名字**） */
  name: string
  /** 绝对路径 */
  path: string
}

/**
 * 扫一个 CCC 的扩展目录。
 *
 * ⛔ **不抛**：目录不存在、读不动 ⇒ 空数组（"没有扩展"是合法状态，不是错误）。
 * ⚠️ 只收 `.ts` / `.mjs` / `.js`：不要收 `.test.ts` —— 那会让测试文件变成可调用的"扩展"。
 */
export function listExtensions(cccRoot: string): ExtEntry[] {
  const dir = join(cccRoot, EXT_DIR_REL)
  let names: string[]
  try {
    names = readdirSync(dir) as string[]
  } catch {
    return []
  }
  const out: ExtEntry[] = []
  for (const n of names) {
    if (n.includes('.test.')) continue
    const m = /^(.+)\.(ts|mjs|js)$/.exec(n)
    if (!m) continue
    out.push({ name: m[1]!, path: join(dir, n) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 按名字找扩展（名字非法或不存在 ⇒ null，⛔ 不抛） */
export function findExtension(cccRoot: string, name: string): ExtEntry | null {
  // 名字收窄：它就是文件名主干，⛔ 不许路径分隔符（否则能点读任意文件）
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return null
  return listExtensions(cccRoot).find((e) => e.name === name) ?? null
}

/** runner 执行结果 */
export interface ExtRunResult {
  ok: boolean
  /** 解析出来的 result（ok=true 时） */
  result?: unknown
  /** 失败原因（ok=false 时，人话） */
  error?: string
  /** 原始 stdout（诊断用，已截断） */
  stdout?: string
  /** 机器可读的失败码 */
  code?: string
}

/**
 * 跑一个扩展（**永不抛** —— 旁路容忍铁律）。
 *
 * runner 顺序照 `cro/core.ts`：`bun` → `process.execPath`。
 * 判据：`ENOENT`（二进制不存在）⇒ 试下一个；**其余失败视为最终结果**
 * （扩展自己报错就是报错，⛔ 不该用另一个 runner 掩盖）。
 */
export async function runExtension(
  entry: ExtEntry,
  payload: Record<string, unknown>,
  timeoutMs: number = EXT_TIMEOUT_MS,
): Promise<ExtRunResult> {
  const stdinJson = JSON.stringify(payload)
  const runners: Array<[string, string[]]> = [
    ['bun', [entry.path]],
    [process.execPath, [entry.path]],
  ]
  for (const [cmd, args] of runners) {
    const res = await runOnce(cmd, args, stdinJson, timeoutMs)
    if (!res.ok && res.code === 'ENOENT') continue // 该 runner 不在 ⇒ 试下一个
    return res
  }
  return { ok: false, error: '扩展执行失败（bun 与 node 均不可用）', code: 'ext-no-runner' }
}

/** 单次 spawn（Promise 化 + 超时 kill + 输出截断 + 绝不抛） */
function runOnce(cmd: string, args: string[], stdinJson: string, timeoutMs: number): Promise<ExtRunResult> {
  return new Promise((resolvePromise) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    } catch (err) {
      return resolvePromise({ ok: false, error: String(err), code: 'SPAWN_ERR' })
    }
    const finish = (r: ExtRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(r)
    }
    const timer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish({
        ok: false,
        error: `扩展执行超时（>${Math.round(timeoutMs / 1000)}s，已 kill）`,
        code: 'ext-timeout',
        stdout,
      })
    }, timeoutMs)

    child.stdin?.on('error', () => {
      /* stdin 关闭竞态忽略（扩展可能不读 stdin 就退出） */
    })
    try {
      child.stdin?.write(stdinJson)
      child.stdin?.end()
    } catch {
      /* 忽略：扩展提前退出 */
    }
    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(0, EXT_STDOUT_MAX)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(0, EXT_STDOUT_MAX)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, error: String(err.message ?? err), code: err.code, stdout })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        return finish({
          ok: false,
          error: `扩展退出码 ${code}${stderr ? `：${stderr.slice(-500)}` : ''}`,
          code: 'ext-nonzero',
          stdout,
        })
      }
      const parsed = parseExtOutput(stdout)
      if (!parsed.ok || !parsed.value) {
        return finish({
          ok: false,
          error: `扩展没有在 stdout 最后一行给出合法 JSON（${parsed.error ?? '解析失败'}）`,
          code: 'ext-bad-output',
          stdout,
        })
      }
      const value = parsed.value
      if (value.ok === false) {
        return finish({
          ok: false,
          error: String(value.error ?? '扩展自报失败（未给原因）'),
          code: 'ext-reported-failure',
          stdout,
        })
      }
      finish({ ok: true, result: value.result, stdout })
    })
  })
}

/**
 * 解析扩展输出：取**最后一个非空行**当 JSON。
 *
 * 判据：扩展可以自由 `console.log` 调试，⛔ 不要求 stdout 干净 ——
 * 否则"加一句 debug"就会破坏契约，而那种代价会让人**不敢调试**。
 */
export function parseExtOutput(stdout: string): { ok: boolean; value?: Record<string, unknown>; error?: string } {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (!l.startsWith('{')) continue
    try {
      const v = JSON.parse(l) as unknown
      // 判据：必须是一个**对象**。裸的 `123`／`"str"`／`null` 都是合法 JSON 但不是本契约。
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return { ok: true, value: v as Record<string, unknown> }
      }
    } catch {
      /* 这一行不是 JSON，试上一行 */
    }
  }
  return { ok: false, error: '没有任何一行可解析为 JSON 对象' }
}

/**
 * 组装给扩展的输入。
 *
 * 🔴 扩展拿到的**只有槽位号、端口、cccRoot 与它自己的 args** —— ⛔ 不塞进程表、
 *    ⛔ 不塞别人的台账。判据：扩展可以驱动浏览器，但**不该知道别人的槽位在干什么**；
 *    知道得越多，「我的读数是怎么来的」就越难重建（R↓）。
 */
export function buildExtPayload(opts: {
  name: string
  slot: number
  port: number
  cccRoot: string
  args: Record<string, unknown>
  timeoutMs?: number
}): Record<string, unknown> {
  return {
    name: opts.name,
    slot: opts.slot,
    port: opts.port,
    cccRoot: opts.cccRoot,
    args: opts.args,
    timeoutMs: opts.timeoutMs ?? EXT_TIMEOUT_MS,
  }
}

/**
 * 扩展路径必须落在 CCC 内（纵深防御）。
 * ⚠️ 本模块的路径全部由 `listExtensions` 从目录里读出来，理论上不会越界；
 *    这一条挡的是**将来有人给 findExtension 加一条"按路径直取"的口子**。
 * ⇒ 用宿主既有的 `resolveInside`（它自己会抛），⛔ 不在这里复刻一份越界判断。
 */
export function assertExtInside(cccRoot: string, extPath: string): void {
  resolveInside(cccRoot, extPath)
}

/** 目录是否已存在（给 tool 的 doctor 用） */
export function extDirExists(cccRoot: string): boolean {
  return existsSync(join(cccRoot, EXT_DIR_REL))
}
