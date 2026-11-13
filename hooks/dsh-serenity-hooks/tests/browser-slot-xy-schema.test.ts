/*
 * browser-slot-xy-schema.test.ts —— 坐标参数的 **schema 形状**必须让三种形态各自「恰好命中一支」。
 *
 * 🔴 为什么这条不能靠读代码推断（D326）：
 *    宿主的 `oneOf` 不是「满足任一」，而是「**恰好命中一支**」（`matched !== 1` ⇒ 拒）。
 *    在这种规则下，几种"看起来最自然"的写法会**静默失效**，而且必须用**真身**才判得出来：
 *      · 分支里写 `required: ['x','y']`      ⇒ 最低档宿主直接**编译失败**（整个工具消失，不是退化成宽松）
 *      · 分支里只写 `{ enum: [{}] }`        ⇒ 运行期**恒不命中**（枚举匹配只认标量）
 *      · 分支里只写 `{ type: 'object' }`    ⇒ 对任何对象都命中 ⇒ 与"对象形态要求 x/y"相悖
 *    ⇒ 结论：对象支必须是 `type:'object' + properties + additionalProperties:false`，且
 *      **必填写在属性上**（`properties.x.required = true`）—— 这是低档 DSL 唯一接受的形状。
 *
 * ⚠️ 本用例跑的是**本仓钉的最低档宿主**（dsh-tools 0.1.7-rc.1）的编译+校验器，同一份代码高档也有。
 */

import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createBrowserSlotTool } from '../src/tools/browser-slot/index.js'

/** 取**编译后**的参数 schema（⛔ 不读源码、不复制一份：复制的那份测的是副本） */
function compiledSchema(name: string): Record<string, unknown> {
  const tool = createBrowserSlotTool({} as never) as unknown as {
    parameters: { properties?: Record<string, Record<string, unknown>> }
  }
  const s = tool.parameters.properties?.[name]
  expect(s, `编译后的 schema 里没有 ${name} —— 锚变了，先修用例`).toBeTruthy()
  return s!
}

function violations(schema: unknown, value: unknown): string[] {
  const r = validateJsonSchemaValue(schema as never, value) as unknown
  return Array.isArray(r) ? (r as string[]) : []
}

const ACCEPT: Array<[string, unknown]> = [
  ['字符串 "x,y"', '1428,76'],
  ['字符串 "x y"（空白分隔）', '1428 76'],
  ['数组 [x,y]', [1428, 76]],
  ['对象 {x,y}', { x: 1428, y: 76 }],
  ['零坐标 "0,0"', '0,0'],
  ['零坐标 [0,0]', [0, 0]],
  ['零坐标 {x:0,y:0}', { x: 0, y: 0 }],
]

for (const name of ['xy', 'from']) {
  describe(`${name}: 三种形态都必须被宿主接受（恰好命中一支）`, () => {
    it('S1 合法值一律零违规', () => {
      const schema = compiledSchema(name)
      for (const [label, v] of ACCEPT) {
        expect(violations(schema, v), `${label} 被拒了 ⇒ 这个形态在真机上不可用`).toEqual([])
      }
    })
  })
}

describe('xy: 「收得宽 ≠ 判得松」—— 门槛一条没降', () => {
  it('S2 非数字分量 / 缺分量 / 多余键 一律被 schema 拒', () => {
    const schema = compiledSchema('xy')
    // ⚠️ `'1'` / `'a,b'` 这类**字符串**在 schema 层是合法的（字符串支不判内容），
    //    拦截它们的是 `parseXY`（C5/C6 已覆盖）—— 两层的分工必须写清，⛔ 别把"schema 没拦"读成"没人拦"。
    //    同理**数组成员的个数/类型**也不由 schema 判（`items` 只管成员类型，管不了长度）⇒ 归 `parseXY`（C5/C6）。
    for (const bad of [{ x: 1 }, {}, { y: 1 }, { x: '1428', y: 76 }, { x: 1, y: 2, extra: 1 }, ['1', '2']]) {
      expect(violations(schema, bad), `${JSON.stringify(bad)} 竟然被 schema 接受了`).not.toEqual([])
    }
  })

  it('S3 判别力正控：一个必然过宽的写法必须放行非法分量（证明 S2 不是恒绿）', () => {
    const tooWide = {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'number' }, additionalProperties: true },
        { type: 'object', properties: {}, additionalProperties: true },
      ],
    }
    expect(violations(tooWide, { x: '1428', y: 76 }), '太宽的对象支会放行非法分量').toEqual([])
    expect(violations(compiledSchema('xy'), { x: '1428', y: 76 }), '采纳的写法必须挡住非法分量').not.toEqual([])
  })
})
