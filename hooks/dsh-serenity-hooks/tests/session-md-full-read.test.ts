/**
 * session-md-full-read.test.ts — 读 SESSION.md 一次给全文（v1.137.13，owner 2026-11-20 令）
 *
 * ## 判据的重点不在"能拼出全文"，而在**四个会静默出错的地方**
 *
 * ① **对照验证**：非 SESSION.md 的读取**一个字节都不能变** ——
 *    否则这个钩子成了所有文件读取的故障源。
 * ② **精确文件名，⛔ 不是包含匹配**：`SESSION-archive-*.md`（几百 KB 的归档）
 *    绝不能被接管 —— 归档本来就该分次读，接管它等于每次读都吞一份大归档。
 * ③ **不自己拼整份文本**：取宿主真实产出的前缀（保它的编号样式），只接续剩余行。
 *    故这里用**宿主真实形态**的夹具，而不是我编的形态。
 * ④ **身份核验**：宿主给的最后一行必须与磁盘同编号那行逐字相同；不一致 ⇒ 放行。
 *    这条防的是"文件在两次读之间被改过" ⇒ 拼出一份**看起来连续、实则错位**的文本。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isSessionMdRead,
  extendToWholeFile,
  singleTextOf,
} from '../src/seams/session-md-full-read.js'

const dirs: string[] = []
function mkFile(name: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'smd-'))
  dirs.push(dir)
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** 造宿主真实形态的 read 产出（逐字对读过 `formatReadOutput`） */
function hostReadEnvelope(absPath: string, given: string[], footer: string): string {
  const body = given.map((t, i) => `${i + 1}: ${t}`).join('\n')
  return `<path>${absPath}</path>\n<type>file</type>\n<content>\n${body}\n\n${footer}\n</content>`
}

describe('isSessionMdRead：精确文件名（本模块最危险误判的守门）', () => {
  it('✅ SESSION.md（正控）', () => {
    expect(isSessionMdRead('/a/b/SESSION.md')).toBe(true)
    expect(isSessionMdRead('SESSION.md')).toBe(true)
  })

  it('🔴 归档件**不得**被接管 —— 包含匹配会让它每次读都吞一份几百 KB 的归档', () => {
    expect(isSessionMdRead('/a/references/SESSION-archive-2026-11-20.md')).toBe(false)
    expect(isSessionMdRead('/a/references/SESSION-status-archive.md')).toBe(false)
    expect(isSessionMdRead('/a/old-SESSION.md')).toBe(false)
    expect(isSessionMdRead('/a/SESSION.md.bak')).toBe(false)
  })

  it('非字符串 / 空串 ⇒ false（不抛）', () => {
    expect(isSessionMdRead(undefined)).toBe(false)
    expect(isSessionMdRead(null)).toBe(false)
    expect(isSessionMdRead('')).toBe(false)
    expect(isSessionMdRead(42)).toBe(false)
  })
})

describe('extendToWholeFile：就地接续（⛔ 不复刻宿主渲染）', () => {
  it('🔴 字节上限截断（`Output capped`）⇒ 接续到末行，并换成宿主的"End of file"结尾', () => {
    const all = ['L1', 'L2', 'L3', 'L4', 'L5']
    const p = mkFile('SESSION.md', all)
    const partial = hostReadEnvelope(p, ['L1', 'L2'], '(Output capped. Showing lines 1-2. Use offset=3 to continue.)')
    const out = extendToWholeFile(partial, p)
    expect(out.reason).toBeNull()
    const t = out.text!
    // 五行齐全、编号连续（沿用宿主样式 `N: `）
    for (let i = 1; i <= 5; i++) expect(t).toContain(`${i}: L${i}`)
    // 结尾是宿主自己的形态，⛔ 不是我造的第 4 种
    expect(t).toContain('(End of file - total 5 lines)')
    expect(t).not.toContain('Output capped')
    // 信封结构不变
    expect(t.startsWith(`<path>${p}</path>\n<type>file</type>\n<content>\n`)).toBe(true)
    expect(t.endsWith('\n</content>')).toBe(true)
  })

  it('🔴 行数限制截断（`Showing lines x-y of N`）同样接续', () => {
    const p = mkFile('SESSION.md', ['a', 'b', 'c'])
    const partial = hostReadEnvelope(p, ['a'], '(Showing lines 1-1 of 3. Use offset=2 to continue.)')
    const out = extendToWholeFile(partial, p)
    expect(out.reason).toBeNull()
    expect(out.text).toContain('2: b')
    expect(out.text).toContain('3: c')
    expect(out.text).toContain('(End of file - total 3 lines)')
  })

  it('🔴 已经是全文（`End of file`）⇒ **不接管**（⛔ 不做无意义的重写）', () => {
    const p = mkFile('SESSION.md', ['only'])
    const full = hostReadEnvelope(p, ['only'], '(End of file - total 1 lines)')
    expect(extendToWholeFile(full, p).reason).toBe('already-complete')
    expect(extendToWholeFile(full, p).text).toBeNull()
  })

  it('🔴 身份核验：接缝那一行与磁盘不符（文件被改过／读错文件）⇒ 放行，⛔ 不拼出错位文本', () => {
    const p = mkFile('SESSION.md', ['CHANGED', 'b', 'c'])
    const seamed = hostReadEnvelope(p, ['CHANGED', 'OLD-B'], '(Output capped. Showing lines 1-2. Use offset=3 to continue.)')
    expect(extendToWholeFile(seamed, p).reason).toBe('seam-mismatch')
    expect(extendToWholeFile(seamed, p).text).toBeNull()
  })

  it('文件读不到（路径不存在）⇒ 放行，且**不抛**', () => {
    const ghost = join(tmpdir(), 'definitely-not-here-SESSION.md')
    const partial = hostReadEnvelope(ghost, ['x'], '(Output capped. Showing lines 1-1. Use offset=2 to continue.)')
    expect(() => extendToWholeFile(partial, ghost)).not.toThrow()
    expect(extendToWholeFile(partial, ghost).reason).toBe('file-unreadable')
  })

  /**
   * 🔴 **真机踩到的形态（v1.137.13 发布后第一次真读才发现）**：
   * 调用参数传的是**相对路径**，而读盘按**进程 cwd** 解析 ⇒ ENOENT ⇒ 静默放行
   * ⇒ 功能看起来"没生效"，实际是路径取错了。
   * ⇒ 权威路径必须是**信封里的 `<path>`**（宿主给的是绝对路径）。
   */
  it('🔴 参数是相对路径、信封里是绝对路径 ⇒ 用信封那条（真机形态）', () => {
    const p = mkFile('SESSION.md', ['A', 'B', 'C'])
    const partial = hostReadEnvelope(p, ['A'], '(Output capped. Showing lines 1-1. Use offset=2 to continue.)')
    // 参数给一个**必然不存在**的相对路径：只有走信封才可能成功
    const out = extendToWholeFile(partial, 'AGENT_SESSIONS/x/SESSION.md')
    expect(out.reason).toBeNull()
    expect(out.text).toContain('2: B')
    expect(out.text).toContain('3: C')
  })

  it('两条路径都是相对 ⇒ 放行（相对路径无法可靠解析，⛔ 不猜）', () => {
    const rel = `<path>AGENT_SESSIONS/x/SESSION.md</path>\n<type>file</type>\n<content>\n1: a\n\n(Output capped. Showing lines 1-1. Use offset=2 to continue.)\n</content>`
    const out = extendToWholeFile(rel, 'AGENT_SESSIONS/x/SESSION.md')
    expect(out.reason).toBe('no-absolute-path')
    expect(out.text).toBeNull()
  })

  it('信封路径指向别处（接缝对不上）⇒ 放行，⛔ 不拼出错位文本', () => {
    const real = mkFile('SESSION.md', ['A', 'B', 'C'])
    const other = mkFile('SESSION.md', ['X', 'Y', 'Z'])
    // 信封说读的是 real，但给的行是 other 的内容 ⇒ 接缝核验必须拦住
    const partial = hostReadEnvelope(real, ['X'], '(Output capped. Showing lines 1-1. Use offset=2 to continue.)')
    expect(extendToWholeFile(partial, other).reason).toBe('seam-mismatch')
  })

  it('信封/结尾形态不认识 ⇒ 放行（形态变了就诚实退出，⛔ 不猜）', () => {
    expect(extendToWholeFile('随便一段文本', '/x/SESSION.md').reason).toBe('envelope-unrecognized')
    const p = mkFile('SESSION.md', ['a', 'b'])
    const weird = `<path>${p}</path>\n<type>file</type>\n<content>\n1: a\n\n(某种新结尾)\n</content>`
    expect(extendToWholeFile(weird, p).reason).toBe('footer-unrecognized')
  })
})

describe('singleTextOf：只认单块 text', () => {
  it('单块 text ⇒ 取出正文', () => {
    expect(singleTextOf([{ type: 'text', text: 'hi' }])).toBe('hi')
  })
  it('多块 / 非 text / 非数组 ⇒ null（放行，⛔ 不猜哪个块是正文）', () => {
    expect(singleTextOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBeNull()
    expect(singleTextOf([{ type: 'image', text: 'a' }])).toBeNull()
    expect(singleTextOf('hi')).toBeNull()
    expect(singleTextOf(undefined)).toBeNull()
  })
})
