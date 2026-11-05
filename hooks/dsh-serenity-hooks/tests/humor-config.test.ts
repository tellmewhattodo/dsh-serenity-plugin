/**
 * humor-config.test.ts — 面板 ↔ 配置文件之间的往返（D287 的门面判据）
 *
 * ## 为什么必须单独钉这一组
 *
 * `humor.test.ts` 只测了"选出哪一段 + 块长什么样"，那是**纯函数**。
 * 但用户在面板上填写走的是另一条路：
 *
 *   面板 PUT  →  applyWirePatch()  →  updateAdvancedSettings()  →  写盘
 *   面板 GET  ←  toWire()          ←  readAdvancedSettings()    ←  读盘
 *
 * 🔴 **这条路少改任何一处，表现都是"面板能填、但存不进去 / 存进去了但读不出来"**，
 * 而且**主流程一切正常**（没有报错、没有告警）。
 *
 * ## 🔴🔴 隔离方式换过一次 —— 第一版**污染了真实用户配置**
 *
 * 第一版用 `vi.doMock('../src/kernel/config.js', …)` 替换 `globalConfigPath`。
 * **它没有生效**：`readAdvancedSettings()` 在模块**内部**调用 `globalConfigPath`，
 * 而 `doMock` 只替换**对外导出**，模块内部调用拿到的是原始实现。
 * ⇒ 测试真的写进了 `~/.dsh/serenity-hooks.json`，把用户的配置改成了
 *   `humor.bits: ["保留我"]`（实测确认，已手工清回）。
 *
 * ⇒ 正确做法 = 用**实现自己提供的注入口**：`SERENITY_HOOKS_CONFIG` 环境变量
 *   （`globalConfigPath()` 的第一优先级，本来就是为测试留的）。
 *   **⛔ 不要再 mock 模块内部函数** —— 那既不可靠，又会打到真实文件。
 *
 * 📌 更一般的判据：**替换"路径来源"要用被测代码自己的注入点，不要 mock 内部调用。**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyWirePatch, readAdvancedSettings, toWire } from '../src/kernel/config.js'

let dir: string
let cfgPath: string
let prevEnv: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'humor-cfg-'))
  cfgPath = join(dir, 'serenity-hooks.json')
  // 🔴 用实现自己的注入口（真实路径隔离），⛔ 不 mock 模块内部函数
  prevEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = cfgPath
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('humor 配置往返：面板填的必须存得进、读得出', () => {
  it('🔴 缺省状态 = 关闭 + 空池（纯装饰不该是默认状态）', () => {
    const s = readAdvancedSettings()
    expect(s.humor.enabled).toBe(false)
    expect(s.humor.bits).toEqual([])
  })

  it('🔴 applyWirePatch 写入 ⇒ 从盘上真的读得回来（往返等价）', () => {
    applyWirePatch({ humor: { enabled: true, bits: ['第一段', '第二段', '第三段'] } })
    const s = readAdvancedSettings()
    expect(s.humor.enabled).toBe(true)
    expect(s.humor.bits).toEqual(['第一段', '第二段', '第三段'])
  })

  it('🔴 toWire 回显 ⇒ 面板能读到自己刚填的内容', () => {
    applyWirePatch({ humor: { enabled: true, bits: ['甲', '乙'] } })
    const wire = toWire(readAdvancedSettings())
    expect(wire.humor).toEqual({ enabled: true, bits: ['甲', '乙'] })
  })

  it('空段被过滤（面板 `---` 分隔会留下空段；空段进提示词就是纯噪声）', () => {
    applyWirePatch({ humor: { enabled: true, bits: ['有内容', '   ', '', '也有内容'] } })
    expect(readAdvancedSettings().humor.bits).toEqual(['有内容', '也有内容'])
  })

  it('只改开关时，池保持不变（部分更新不得清空别的字段）', () => {
    applyWirePatch({ humor: { enabled: true, bits: ['保留我'] } })
    applyWirePatch({ humor: { enabled: false } })
    const s = readAdvancedSettings()
    expect(s.humor.enabled).toBe(false)
    expect(s.humor.bits, '关掉开关不该把池一起清掉').toEqual(['保留我'])
  })

  it('🆕 旧配置文件没有 humor 节 ⇒ 补默认值，不抛错（兼容存量用户）', () => {
    writeFileSync(cfgPath, JSON.stringify({ persona: { mode: '', overrideText: '' } }), 'utf-8')
    const s = readAdvancedSettings()
    expect(s.humor).toEqual({ enabled: false, bits: [] })
    // 既有字段必须原样保留（不许因为加新节而丢老配置）
    expect(s.persona).toEqual({ mode: '', overrideText: '' })
  })
})

/**
 * 🔴🔴 **回归钉：本组测试绝不许写真实用户配置。**
 *
 * 这条不是重复第一条 —— 它钉的是**测试自身的安全性**。
 * 若哪天有人把这个文件的隔离方式再改回去（mock 内部函数），这条会立刻红。
 */
describe('测试自身安全：不得触碰真实配置', () => {
  it('每次跑完，真实路径的 humor 节不应被本文件写过', () => {
    const real = join(process.env.HOME ?? '', '.dsh', 'serenity-hooks.json')
    // 只在真实文件存在时检查（不存在 = 从未写过，也算安全）
    let raw = ''
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      raw = require('node:fs').readFileSync(real, 'utf-8') as string
    } catch {
      return // 文件不存在 ⇒ 安全
    }
    expect(raw, `本测试污染了真实配置：${real}`).not.toContain('保留我')
    expect(raw, `本测试污染了真实配置：${real}`).not.toContain('有内容')
  })
})
