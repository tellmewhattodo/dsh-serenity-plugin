/**
 * browser-slot-schema.test.ts — `browser_slot` 的 **schema ↔ 实际读取** 必须一一对上。
 *
 * 🔴 这条判据来自一个已经发生的静默失效（v1.129.0 ~ v1.129.2，D310）：
 *    `run()` 读 9 个参数，而 `parameters` 只声明了 4 个。JS 忽略多余字段 ⇒
 *    **功能一直是对的**，坏的是**可发现性** —— 调用方在 schema 里看不到 `url`/`target`/`js`，
 *    于是 `⛔ 需要 --url=<地址>` 这行拒绝看起来像"功能没做"，而不是"你没给参数"。
 *
 * ⛔ 为什么不能只靠"文档里写了"：文档是给人看的，**schema 是给调用方看的**。
 *    一份写得再好的 `70-browser-surface.md` 也救不了一个 schema 里没有的参数。
 *
 * 判据（两条，互补）：
 *   J1 **声明⊆读取**：schema 里声明的每个参数，`run()` 都得真的读它
 *      （否则就是一个骗人的参数：声明了、传了、被忽略 —— 比不声明更坏）。
 *   J2 **读取⊆声明**：`run()` 读的每个参数，schema 里都得声明
 *      （否则就是 D310 那个形态：能用但看不见）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src', 'tools', 'browser-slot', 'index.ts')
const text = readFileSync(SRC, 'utf8')

/**
 * 抽 `parameters: { … }` 块里声明的顶层键。
 *
 * 边界：只认缩进 6 空格、`ident:` 形状的行（本仓该块的固定排版）。
 * ⛔ 不做通用 TS 解析 —— 那会把"命名形状"变成"语法树"依赖，收益不抵成本；
 *   代价是**排版变了本用例会少算**，所以另加一条正控（见下面 J0）证明它真的抽到了东西。
 */
function declaredParams(): string[] {
  const start = text.indexOf('parameters: {')
  expect(start, '找不到 parameters: { 块 —— 锚变了，先修抽取器').toBeGreaterThan(-1)
  const end = text.indexOf('\n    },', start)
  expect(end, '找不到 parameters 块的结尾 —— 锚变了，先修抽取器').toBeGreaterThan(start)
  const block = text.slice(start, end)
  const names: string[] = []
  for (const line of block.split('\n')) {
    const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*\{/.exec(line)
    if (m) names.push(m[1]!)
  }
  return names
}

/**
 * 剥 TS 注释（块注释 + 行注释）。
 *
 * 🔴 **`//` 必须要求前面不是 `:`**（第二版在这里红过）：
 *    朴素写法会把协议头里的双斜杠当成注释起点
 *    ⇒ 那一行之后的内容被整行吃掉，真读取凭空消失。
 *
 * ⛔ **只有这一份实现**：`readParams` 与 `readOutsideRun` 都调它。
 *    两处各写一套会各自漂，而漂了没有任何信号（本文件第一~三版就是这么红的）。
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')
}

/**
 * 抽 `run()` 里读到的 `args.<key>`。
 *
 * ⚠️ 只扫 `run()` 函数体（`async function run(` 到文件末尾的下一个顶层 `}`），
 *    因为 `extArgs(args)` 等帮手也读 `args`，混进来会把"帮手读的"算成"动作读的"。
 *
 * 🔴 **两个必须剥掉的干扰**（第一版就在这里红过，红得对）：
 *   ① **注释**：`⛔ 不新造"当前轨迹"环境变量` 之类正文里出现 `args.x` 是说明文字，
 *      不是读取 ⇒ 先剥 `//` 行注释与块注释，再匹配。
 *   ② **帮手**：`extArgs(args)` 读的是 `args.earg`，但它**在 run() 之外** ⇒
 *      按"只扫 run 的函数体"处理（到第一个顶层 `}` 为止）。
 */
function readParams(): string[] {
  const start = text.indexOf('async function run(')
  expect(start, '找不到 async function run( —— 锚变了，先修抽取器').toBeGreaterThan(-1)
  // 截到 run() 结束：从 start 往后找第一个"行首是 }"的位置（本文件 run() 是顶层函数）
  const tail = text.slice(start)
  const endMatch = /\n}\n/.exec(tail)
  const body = endMatch ? tail.slice(0, endMatch.index) : tail
  // 剥注释（行注释 + 块注释）——注释里举的例子不是读取
  const stripped = stripComments(body)
  const names = new Set<string>()
  for (const m of stripped.matchAll(/\bargs\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]!)
  return [...names]
}

/**
 * `run()` 的**形参**里，哪些是直接从 `args` 上摘下来的。
 *
 * 🔴 为什么需要这条（第三版在这里红过）：`action` 在 `createBrowserSlotTool` 里就已解出
 *    （`const action = args.action as SlotAction`），`run()` 收到的是**形参** `action`，
 *    所以扫 `run` 的函数体会报"`action` 声明了却没人读" —— 那是**抽取器漏了一层**，
 *    不是源码有问题。
 *
 * 判据：`run(` 之后、第一个 `)` 之前的参数名里，凡是 `parameters` 也声明过的，都算已读。
 * ⚠️ 这一格刻意**窄**：只认"同名同参"，⛔ 不做"传进去的可能是别的参数"的推断。
 */
function runFormals(): string[] {
  const start = text.indexOf('async function run(')
  expect(start, '找不到 async function run( —— 锚变了').toBeGreaterThan(-1)
  const open = text.indexOf('(', start)
  // 参数表到第一个深度归零的 `)` 为止（这里都是简单形参，不含嵌套括号）
  const close = text.indexOf(')', open)
  const params = text.slice(open + 1, close)
  return params
    .split(',')
    .map((s) => s.trim().replace(/\s*[:?].*$/, '').replace(/\s*=.*$/, ''))
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
}

/**
 * 从 `args` 上**间接**取走的参数：`const action = args.action`、`const foo = args['bar']` 等
 * 发生在 `run()` 之外（通常是 `createBrowserSlotTool` 的 execute 里）的读取。
 *
 * 🔴 扫全文件而不是只扫 run()：`action` 的读取就在外面。这与"只扫 run 函数体"不矛盾 ——
 *    那条是为了**排除帮手**（`extArgs` 的读取是合法的，但那是帮手自己的事）；
 *    这里要抓的恰恰是"在别处被解出来再传进来"的那几个。
 */
function readOutsideRun(): string[] {
  const runStart = text.indexOf('async function run(')
  const runEnd = runStart + (/\n}\n/.exec(text.slice(runStart))?.index ?? text.length)
  const outside = text.slice(0, runStart) + text.slice(runEnd)
  // 🔴 **必须剥注释**：这一片的注释里满是 `args.x` 这类举例（J3 就是钉这个的负控制）。
  //    剥法与 readParams 同一套 —— ⛔ 两处写法不同会各自漂，而漂了零信号。
  const clean = stripComments(outside)
  const names = new Set<string>()
  for (const m of clean.matchAll(/\bargs\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]!)
  for (const m of clean.matchAll(/\bargs\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) names.add(m[1]!)
  return [...names]
}

describe('browser_slot: schema 与实际读取必须对上', () => {
  const declared = declaredParams()
  const formals = runFormals()
  const helperRead = ['earg'] // extArgs() 里读；J0b 会去核对它真的存在
  const read = [...new Set([...readParams(), ...readOutsideRun(), ...helperRead, ...formals.filter((f) => declared.includes(f))])]

  it('J0 正控：抽取器真的抽到了东西（⛔ 抽到空数组时下面两条会假绿）', () => {
    expect(declared.length).toBeGreaterThan(8)
    expect(read.length).toBeGreaterThan(8)
    expect(declared).toContain('action')
    expect(declared).toContain('slot')
    expect(read).toContain('action')
    expect(read).toContain('url')
  })

  it('J0b 帮手读取是真的（⛔ 别让 helperRead 变成一句许愿）', () => {
    const helperStart = text.indexOf('function extArgs(')
    expect(helperStart, '找不到 extArgs —— 锚变了').toBeGreaterThan(-1)
    const helperBody = text.slice(helperStart, text.indexOf('\n}', helperStart))
    expect(helperBody).toContain('args.earg')
  })

  it('J1 声明 ⊆ 读取（⛔ 不许有"声明了却不读"的骗人参数）', () => {
    const orphans = declared.filter((p) => !read.includes(p))
    expect(orphans, `这些参数声明了但没人读 ⇒ 传了被静默忽略：${orphans.join(', ')}`).toEqual([])
  })

  it('J2 读取 ⊆ 声明（⛔ 不许有"能用但 schema 里看不见"的参数 —— D310）', () => {
    const hidden = read.filter((p) => !declared.includes(p))
    expect(hidden, `这些参数在读但 schema 没声明 ⇒ 调用方发现不了：${hidden.join(', ')}`).toEqual([])
  })

  it('J3 注释里的 `args.x` 不算读取（抽取器自身的负控制）', () => {
    expect(read).not.toContain('x')
  })
})
