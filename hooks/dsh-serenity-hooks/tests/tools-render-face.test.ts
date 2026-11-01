/**
 * tools-render-face.test.ts — ⑤ 第 32 件：**工具面的 `output.render` 通路**
 *
 * 挑靶依据 = **全量 `fstat-no` 复扫**（地图 §3-9b；读数 = 44 处 / 23 文件），其中
 * **A 类 = `tools/*` 的 render 面（9 文件 / 23 处）**，形态高度同一：
 *
 *   function renderText(value: unknown): ContentBlock[] {
 *     const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
 *     return [{ type: 'text', text }]
 *   }
 *   …
 *   output: { schema: …, render: (args, value) => renderText(value) }
 *
 * 🔴 **为什么在此之前从未被执行**：`render` 由**宿主**在渲染工具结果时调用 ——
 *    本仓的测试全都自己断言 `execute` 的返回值，**没有一处经过宿主的渲染调用点**
 *    ⇒ 这 9 个文件的 `renderText` 与 `render` 闭包一直是 `fstat-no`。
 *
 * 🔴 **可达性自证（本件全部断言的前提）**：读 `@deepseek-ai/dsh-tools` 的 `defineTool` 实现 ——
 *    它返回**普通对象**，其 `output.render(args, value)` 就是 `return userRender(args, value)`
 *    （`lib/index.js` 的 `defineTool` 内 `output` 字面量）⇒ `tool.output.render(...)` **确实可达**。
 *    ⚠️ **本件刻意不用 `vi.mock('@deepseek-ai/dsh-tools')`**（`acc-diag.test.ts` 那种 identity 桩）——
 *    走**真的 `defineTool`**，于是测到的是**产线的那个包装**，不是替身。
 *
 * ⚠️ **契约边界（决定本件测哪几条分支）**：`output.schema` 是 `{ type: 'string' }` 的只有 **2 个**
 *    （`praxis`，以及 v1.52 起新增的 `ontology` —— 后者刻意用 string：引擎报告是多行 Markdown 式，
 *    走 json 会被 `JSON.stringify` 把换行转义成 `\n`），其余 7 个都是 `{ type: 'json' }`
 *    ⇒ 对 7 个 json 工具，"非字符串值"是**契约内**的正常形态；
 *    而两个 string 工具的 `execute` **恒返回字符串** ⇒ 那条 `JSON.stringify` 支线**在产线永不执行**
 *    （属"构造上不可达／防御性归一化"档）。
 *    ⇒ 🔴 **刻意不测它**：硬凑会把"从不发生"固化成"期望形态"（同 §2.7b／§2.7n 的判断）。
 *    本件要的是**函数面**（`fstat-no` 归零），进入函数即可，**不需要把不可达支线填满**。
 *
 * ⚠️ **本件不覆盖**（留给"execute 面"那件）：`cc-fs`／`git`／`kit`／`localstore`／`im-bridge`
 *    的 `execute`（与本件不同风险面）。
 * 🔴 2026-10-28：`cheap-worker` 整条下线 ⇒ 它当年的靶（`parseJobs`）不再存在，靶数 10 → 9。
 */

import { describe, it, expect } from 'vitest'

import { praxisTool } from '../src/tools/praxis.js'
import { ccFsTool } from '../src/tools/fs/index.js'
import { gitTool } from '../src/tools/git/index.js'
import { localstoreTool } from '../src/tools/localstore/index.js'
import { createKitTool } from '../src/tools/kit/index.js'
import { createContainerAdminTool } from '../src/tools/container-admin.js'
import { createImBridgeTool } from '../src/tools/im-bridge.js'
import { createOntologyTool } from '../src/tools/ontology-eng.js'

/** 单个内容块的**结构性**视图（本件只关心 `type` 与 `text`，不引宿主类型） */
type Block = { type: string; text?: string }

/**
 * `output.render` 的最小结构视图。
 * 🔴 **`args` 传什么是无所谓** —— 9 个文件的 render 闭包**全部忽略第一个形参**
 * （`(_args, value)` 或 `(args, value)` 但体内只用了 `value`）⇒ 本件统一传 `{}`。
 */
type ToolLike = {
  name: string
  output: { render: (args: unknown, value: unknown) => Block[] }
}

/** 工厂形工具的 ctx 形参类型（不额外 import `cordis` 的类型） */
type Ctx = Parameters<typeof createKitTool>[0]
const ctx = {} as Ctx

/**
 * 断言"**恰好一个 `text` 块**"这一条契约，并返回它的正文。
 * 🔴 独立读数器式写法：**先验形状、再取正文** —— 若哪天 render 改回返回多块／别的类型，本断言先红。
 */
function textOf(blocks: Block[]): string {
  expect(Array.isArray(blocks), 'render 必须返回块数组').toBe(true)
  expect(blocks, '本件覆盖的 render 恒返回单块').toHaveLength(1)
  expect(blocks[0]!.type).toBe('text')
  expect(typeof blocks[0]!.text).toBe('string')
  return blocks[0]!.text as string
}

/** render 取值器：把"拿不到就静默 undefined"变成**响亮失败**（防"扫了零个 ⇒ 永远绿"） */
function renderOf(tool: unknown, label: string): (args: unknown, value: unknown) => Block[] {
  const out = (tool as { output?: { render?: unknown } }).output
  if (out === undefined || typeof out.render !== 'function') {
    throw new Error(`不可达：${label} 没有暴露 output.render（defineTool 的返回形状变了？）`)
  }
  return out.render as (args: unknown, value: unknown) => Block[]
}

/** 8 个靶（schema 决定"非字符串值"是否属契约内 —— 见文件头；🔴 2026-10-28 cheap-worker 下线 ⇒ 10→9；v1.106.0 acc-diag 并入 dashboard diag ⇒ 9→8） */
const TOOLS: Array<{ label: string; schema: 'string' | 'json'; make: () => unknown }> = [
  { label: 'praxis', schema: 'string', make: () => praxisTool },
  { label: 'cc-fs', schema: 'json', make: () => ccFsTool },
  { label: 'git', schema: 'json', make: () => gitTool },
  { label: 'localstore', schema: 'json', make: () => localstoreTool },
  { label: 'dashboard（kit）', schema: 'json', make: () => createKitTool(ctx) },
  { label: 'container_admin', schema: 'json', make: () => createContainerAdminTool(ctx) },
  { label: 'im-bridge', schema: 'json', make: () => createImBridgeTool() },
  // v1.52（D121）：本体工程引擎。**schema 刻意是 string 而非 json** —— 引擎报告是多行 Markdown 式，
  // 走 json 会被 `JSON.stringify` 把换行转义成 `\n`（模型读到的是一坨转义串）。见 `ontology-eng.ts` 的 receiptOf。
  { label: 'ontology', schema: 'string', make: () => createOntologyTool() },
]

describe('tools/*：`output.render` 通路（⑤ 第 32 件）', () => {
  it('🔴 可达性自证：8 个工具对象都真的暴露 output.render（本件全部断言的前提）', () => {
    // ⚠️ 扫描域自证：先钉"靶确实是 8 个"，否则"零个不合格"会永远绿（同 §3-9 #7 的写法）
    expect(TOOLS).toHaveLength(8)
    const unreachable = TOOLS.filter((t) => {
      try {
        renderOf(t.make(), t.label)
        return false
      } catch {
        return true
      }
    })
    expect(unreachable.map((t) => t.label)).toEqual([])
  })

  for (const { label, schema, make } of TOOLS) {
    describe(`${label}（schema=${schema}）`, () => {
      it('字符串值 ⇒ 原样透传（不二次编码）', () => {
        const render = renderOf(make(), label)
        const probe = `probe-${label}-正文`
        expect(textOf(render({}, probe))).toBe(probe)

        // 🔵 **判别性探针**：给一个**长得像 JSON 的字符串**。
        //    若实现被写成"先 stringify 再判断"，或两个分支接反 ⇒ 这里会得到带引号的转义串。
        const looksLikeJson = '{"a":1}'
        expect(textOf(render({}, looksLikeJson))).toBe(looksLikeJson)
      })

      if (schema === 'json') {
        it('非字符串值 ⇒ 归一化为 JSON.stringify(value, null, 2)', () => {
          const render = renderOf(make(), label)
          // 刻意用**键序非字典序 + 嵌套 + 混合类型**的样本：能同时钉住"缩进 2"与"键序保持插入序"
          const probe = { b: 2, a: [1, 'x'], nested: { ok: true, n: null } }
          expect(textOf(render({}, probe))).toBe(JSON.stringify(probe, null, 2))
          // 正控：期望值本身必须**含换行**（否则该断言对"没缩进"也成立 ⇒ 空断言）
          expect(JSON.stringify(probe, null, 2)).toContain('\n')
        })
      }
    })
  }
})
