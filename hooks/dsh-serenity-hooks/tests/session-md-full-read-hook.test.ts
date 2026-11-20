/**
 * session-md-full-read-hook.test.ts — 钩子层（不只是纯函数层）
 *
 * 🔴 为什么必须单写这一组：纯函数全绿**证明不了钩子接对了**。
 * 本仓已多次踩「有函数、有测试、没有接线」（D151 同族）。
 * 这里钉三件事：
 *  ① **只改 content，⛔ 不动 value** —— 宿主源码对此有硬断言（同时给两者会抛）；
 *     落到实处：用量统计读的是 `value`，动它就会打断统计。
 *  ② **对照：非 SESSION.md 的 read 原样不动**（本钩子绝不能成为所有文件读取的故障源）。
 *  ③ **失败结果 / 非 read 工具 / block 决策 一律放行**。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerSessionMdFullRead } from '../src/seams/session-md-full-read.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function mkFile(name: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'smdh-'))
  dirs.push(dir)
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

function envelope(absPath: string, given: string[], footer: string): string {
  const body = given.map((t, i) => `${i + 1}: ${t}`).join('\n')
  return `<path>${absPath}</path>\n<type>file</type>\n<content>\n${body}\n\n${footer}\n</content>`
}

/** 装一个只捕获 post-execute 监听的假 ctx，返回可调用的钩子 */
function mount(): (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown> {
  let hook: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    on: (name: string, fn: never) => {
      if (name === 'tools/post-execute') hook = fn as never
    },
  }
  registerSessionMdFullRead(ctx)
  if (!hook) throw new Error('未注册 post-execute 监听 —— 接线断了')
  return hook
}

const ACCEPT = (result: unknown) => () => Promise.resolve({ kind: 'accept', ...(result as object) })

describe('钩子：SESSION.md 读全文', () => {
  it('🔴 截断的 read ⇒ content 被换成全文，且 **value 一个字节不动**', async () => {
    const all = ['A', 'B', 'C', 'D']
    const p = mkFile('SESSION.md', all)
    const content = [{ type: 'text', text: envelope(p, ['A', 'B'], '(Output capped. Showing lines 1-2. Use offset=3 to continue.)') }]
    const value = { path: p, offset: 1, lines: [{ number: 1, text: 'A' }], totalLines: 4 }

    const out = await mount()(
      { name: 'read', arguments: { file_path: p, limit: 200 } },
      { isError: false, content, value },
      ACCEPT({ content, value }),
    ) as { content?: { text?: string }[]; value?: unknown }

    const text = out.content?.[0]?.text ?? ''
    for (let i = 1; i <= 4; i++) expect(text).toContain(`${i}: ${all[i - 1]}`)
    expect(text).toContain('(End of file - total 4 lines)')
    // 🔴 关键：结构化 value 不被替换（用量统计读它；宿主也不允许两者同给）
    expect(out.value).toEqual(value)
  })

  it('🔴 对照验证：同一份内容，但文件名不是 SESSION.md ⇒ **原样不动**', async () => {
    const p = mkFile('NOTES.md', ['A', 'B', 'C'])
    const content = [{ type: 'text', text: envelope(p, ['A'], '(Output capped. Showing lines 1-1. Use offset=2 to continue.)') }]
    const out = await mount()(
      { name: 'read', arguments: { file_path: p } },
      { isError: false, content },
      ACCEPT({ content }),
    ) as { content?: unknown }
    // 逐字节相同（同一个对象引用即可证"没动"）
    expect(out.content).toBe(content)
  })

  it('🔴 对照验证：SESSION.md 但工具不是 read ⇒ 原样不动', async () => {
    const p = mkFile('SESSION.md', ['A', 'B'])
    const content = [{ type: 'text', text: envelope(p, ['A'], '(Output capped. Showing lines 1-1. Use offset=2 to continue.)') }]
    const out = await mount()(
      { name: 'edit', arguments: { file_path: p } },
      { isError: false, content },
      ACCEPT({ content }),
    ) as { content?: unknown }
    expect(out.content).toBe(content)
  })

  it('失败结果 ⇒ 放行（没有正文可接续）', async () => {
    const p = mkFile('SESSION.md', ['A', 'B'])
    const content = [{ type: 'text', text: 'boom' }]
    const out = await mount()(
      { name: 'read', arguments: { file_path: p } },
      { isError: true, content },
      ACCEPT({ content }),
    ) as { content?: unknown }
    expect(out.content).toBe(content)
  })

  it('下游已 block ⇒ 放行（block 的分支没有 content 可改）', async () => {
    const p = mkFile('SESSION.md', ['A', 'B'])
    const out = await mount()(
      { name: 'read', arguments: { file_path: p } },
      { isError: false, content: [{ type: 'text', text: 'x' }] },
      () => Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }),
    ) as { kind?: string }
    expect(out.kind).toBe('block')
  })

  it('🔴 任何内部异常 ⇒ 绝不抛（本钩子挂在每轮返回路径上）', async () => {
    const hook = mount()
    await expect(hook(
      { name: 'read', get arguments(): never { throw new Error('boom') } },
      { isError: false, content: [{ type: 'text', text: 'x' }] },
      ACCEPT({ content: [] }),
    )).resolves.toBeDefined()
  })

  it('ctx 没有 on ⇒ 静默跳过（不炸启动）', () => {
    expect(() => registerSessionMdFullRead({} as never)).not.toThrow()
  })
})
