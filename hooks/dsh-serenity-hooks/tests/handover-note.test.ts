/**
 * handover-note.test.ts — 交接便签「住 LOG、轮转搬运」（2026-11-16 owner 裁定）
 *
 * ## 它守的是什么
 * 便签从独立文件迁进 `LOG/LOG.md` 的 `## Handover note` 节之后，**获得 LOG 的机械轮转**。
 * 但轮转把整份 `LOG.md` `mv` 成冻结代、新代是空白的 —— 若**不搬运该节**，
 * 新会话读新代 ⇒ **读不到在办状态** ⇒ 交接断开，**且没有任何报错**。
 *
 * ⇒ 本文件钉三件事：
 *   ① `extractHandoverNote` 的切片边界（含/不含、止于下一个 `## `）
 *   ② `rotateCarrierLog` 把该节搬进新代出生头
 *   ③ 负控：**没有该节时代不伪造空白节**（空节会让新会话以为"上一代没写"，是假信号）
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractHandoverNote, rotateCarrierLog } from '../src/trajectory/carrier-log.js'
import { HANDOVER_NOTE_HEADING } from '../src/trajectory/assistant.js'

const H = HANDOVER_NOTE_HEADING // '## Handover note'

function mkTraj(logBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'handover-'))
  mkdirSync(join(dir, 'LOG'), { recursive: true })
  writeFileSync(join(dir, 'LOG', 'LOG.md'), logBody, 'utf-8')
  return dir
}

describe('extractHandoverNote：切片边界', () => {
  it('抽出整节（含标题），止于下一个 `## `', () => {
    const text = [
      '# LOG — generation 1',
      '',
      '## 2026-11-16 work',
      '- did something',
      '',
      `${H}`,
      '- in flight: step 3 of 5',
      '- next: run the mutation check',
      '',
      '## Later section',
      '- not part of the note',
    ].join('\n')
    const note = extractHandoverNote(text)
    expect(note).not.toBeNull()
    expect(note).toContain(H)
    expect(note).toContain('in flight: step 3 of 5')
    expect(note).toContain('next: run the mutation check')
    // 🔴 边界：不得吞掉后面那一节
    expect(note).not.toContain('Later section')
    expect(note).not.toContain('not part of the note')
  })

  it('无该节 ⇒ null（⛔ 不造空节）', () => {
    expect(extractHandoverNote('# LOG\ngeneration 1\n')).toBeNull()
  })

  it('该节是最后一节 ⇒ 取到文件末尾（去掉尾部空行）', () => {
    const text = `# LOG\n\n${H}\n- last thing\n\n\n`
    const note = extractHandoverNote(text)
    expect(note).toBe(`${H}\n- last thing`)
  })

  /**
   * 🔴 边界用例（**变异检验逼出来的**）：便签之后出现 **一级标题** `# ` 也必须截断。
   *
   * 为什么单列一条：我第一版实现只认 `## ` 作截断符，`test` **照样全绿** ——
   * 因为没有任何用例把 `# ` 放在便签之后（真实形态里它出现在文件开头，永远在便签之前）。
   * 但"当代之后的下一份文档拼进来"这类写入是可能发生的，届时便签会吞掉半份别人的正文。
   * ⇒ 判据：**边界必须双向都有用例**（`## ` 一条、`# ` 一条），否则"止于一级标题"这半个条件无人守。
   */
  it('🔴 边界：止于**一级标题**（`# `），不只认 `## `', () => {
    const text = [
      '# LOG — generation 1',
      `${H}`,
      '- in flight: X',
      '# NEXT DOC',
      '- someone else content',
    ].join('\n')
    const note = extractHandoverNote(text)
    expect(note).toContain('- in flight: X')
    expect(note).not.toContain('NEXT DOC')
    expect(note).not.toContain('someone else content')
  })
})

describe('rotateCarrierLog：把交接便签搬进新代出生头', () => {
  it('🔴 搬运成立：轮转后新代含上一代的 ## Handover note 全文', () => {
    const dir = mkTraj([
      '# LOG — generation 1 (born x)',
      '',
      '## work log',
      '- some process detail',
      '',
      H,
      '- in flight: writing the injector',
      '- next: wire it into keeper',
      '',
    ].join('\n'))

    const r = rotateCarrierLog(dir, new Date('2026-11-16T01:00:00'))
    expect(r.rotated).toBe(true)
    expect(r.verified).toBe(true)

    const live = readFileSync(join(dir, 'LOG', 'LOG.md'), 'utf-8')
    // 新代出生头在
    expect(live).toContain('# LOG — generation 2')
    // 🔴 判据：便签内容必须在新代里 —— 这是"交接后能读到"的唯一机械保证
    expect(live).toContain(H)
    expect(live).toContain('in flight: writing the injector')
    expect(live).toContain('next: wire it into keeper')
    // 过程正文**不搬**（它留在冻结代里，这正是轮转的意义）
    expect(live).not.toContain('some process detail')

    rmSync(dir, { recursive: true, force: true })
  })

  it('负控：没有该节 ⇒ 新代里不得出现空的 ## Handover note', () => {
    const dir = mkTraj('# LOG — generation 1\n\n## work log\n- only process\n')
    rotateCarrierLog(dir, new Date('2026-11-16T01:00:00'))
    const live = readFileSync(join(dir, 'LOG', 'LOG.md'), 'utf-8')
    expect(live).not.toContain(H)
    rmSync(dir, { recursive: true, force: true })
  })

  it('空代不轮转（既有判据不被搬运逻辑影响）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handover-empty-'))
    mkdirSync(join(dir, 'LOG'), { recursive: true })
    writeFileSync(join(dir, 'LOG', 'LOG.md'), '# LOG — generation 1\n', 'utf-8')
    const r = rotateCarrierLog(dir, new Date('2026-11-16T01:00:00'))
    expect(r.rotated).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
