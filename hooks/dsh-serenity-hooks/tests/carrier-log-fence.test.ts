/**
 * carrier-log-fence.test.ts — 交接节提取必须**围栏感知**（v1.137.15，butler 报障逼出）
 *
 * ## 真机现场（butler 的载体，2026-11-21 01:30，逐行可复算）
 *
 * | 项 | 冻结件 `LOG-2026-11-21T0130.md` | 轮转后的新 live |
 * |---|---|---|
 * | 行数 | 1805 | **1494** |
 * | 字节 | 216,500 | **187,470** |
 * | `续七` | L1479 | **L1479（同位）** |
 * | `续八` | L1516 | 🔴 **没有**（文件停在 1494） |
 *
 * **机制**（不是"拷贝并封顶"）：新 live = 出生头（5 行）＋ `extractAllHandoverNotes()` 搬出的节。
 * 而 `## Handover note` 在 L6、下一个「行首 `## `/`# `」在 **L1494** ⇒ 节 = **1,488 行** ⇒ 5+1488 ≈ 1494。
 *
 * 🔴 **L1494 是代码围栏内部的一行注释**：
 * ```
 * ```
 * # 本轨迹的 CRO 只在 CCC 宿主机上跑（fail-closed：没绑 = 不跑）
 * ```
 * ```
 * ⇒ 提取器**只看行首字符、不看是否在围栏里** ⇒ 把围栏内的 `# ` 当成节边界
 * ⇒ L1494 之后（`续八`～`续十七`，含 22:37–01:27 一大段）**整块被静默丢弃**。
 *
 * ## 本文件的判据重点（四个会静默出错的地方）
 *
 * ① **围栏内的 `# `/`## ` 不是节边界** —— 本次真因，丢了最新内容且零信号；
 * ② **围栏外的 `## ` 仍是边界** —— 别为了修①把正常边界也一起吞了（反向控制）；
 * ③ **体量上限** —— 一个 1,488 行的节会让"新代"1,494 行 ⇒ **轮转等于没轮转**；
 * ④ **未闭合围栏**（写到一半被中断）⇒ 不得把文件剩余部分全吞进节里。
 */
import { describe, it, expect } from 'vitest'
import {
  extractAllHandoverNotes,
  MAX_HANDOVER_NOTE_LINES,
} from '../src/trajectory/carrier-log.js'
// ⚠️ 标题常量住在 `assistant.ts`（`carrier-log.ts` 只是 import 它，**没有 re-export**）。
//    第一版我从 carrier-log 导入 ⇒ 拿到 undefined ⇒ 夹具里根本没有便签标题 ⇒ 6 条全空。
import { HANDOVER_NOTE_HEADING } from '../src/trajectory/assistant.js'

/** 拼一份"宿主出生头 + 便签节 + 正文"的 LOG 文本 */
function buildLog(opts: { noteBody: string[]; tail?: string[] }): string {
  const lines = [
    '# LOG — generation 19 (born 2026-11-20T22:00)',
    '',
    '> Previous generation frozen as: `LOG/LOG-2026-11-20T2200.md`',
    HANDOVER_NOTE_HEADING,
    '',
    ...opts.noteBody,
    ...(opts.tail ?? []),
  ]
  return lines.join('\n') + '\n'
}

describe('extractAllHandoverNotes：围栏感知（真机缺陷，butler 01:30）', () => {
  it('🔴 围栏内的行首 `# ` **不得**当作节边界（本次真因）', () => {
    // 复刻真机形态：便签节内含一个代码块，块内有一行 `# 注释`
    const text = buildLog({
      noteBody: [
        '### 现役交接',
        '',
        '正文一段。',
        '',
        '```',
        '# 本轨迹的 CRO 只在 CCC 宿主机上跑（fail-closed：没绑 = 不跑）',
        '# 换机器时改这一行。',
        'yh-Standard-PC-Q35-ICH9-2009',
        '```',
        '',
        '### 续七（围栏之后、仍在便签节内）',
        '',
        '这段必须被搬走。',
        '',
      ],
      // ⚠️ 节外内容必须用 `## ` 开头才是真边界 —— `### ` 按本文件既有规则**属于本节内**
      //    （当初就是这么定的：人可能在便签里写子标题）。夹具用错层级会误判实现。
      tail: ['## 第 67 段续八（节外正文）', '', '正文……', ''],
    })
    const notes = extractAllHandoverNotes(text)
    expect(notes).toHaveLength(1)
    const n = notes[0]!
    // 🔴 围栏内那行注释之后的内容必须还在
    expect(n).toContain('### 续七（围栏之后、仍在便签节内）')
    expect(n).toContain('这段必须被搬走。')
    expect(n).toContain('yh-Standard-PC-Q35-ICH9-2009')
    // ⛔ 节外的正文不该被搬
    expect(n).not.toContain('续八（节外正文）')
  })

  it('反向控制：围栏外的 `## ` 仍必须是边界（⛔ 修 A 时误伤 B）', () => {
    const text = buildLog({
      noteBody: ['### 交接正文', '', '这一行属于便签。', ''],
      tail: ['## 下一节', '', '这一行不属于便签。', ''],
    })
    const notes = extractAllHandoverNotes(text)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('这一行属于便签。')
    expect(notes[0]).not.toContain('这一行不属于便签。')
  })

  it('🔴 未闭合围栏（写到一半被打断）⇒ 不得吞掉文件剩余部分', () => {
    const text = buildLog({
      noteBody: ['### 交接', '', '```', '开了一个围栏但没闭合', ''],
      tail: ['## 别的节', '', '这里不是便签。', ''],
    })
    const notes = extractAllHandoverNotes(text)
    expect(notes).toHaveLength(1)
    // 未闭合 ⇒ 围栏之后的内容**不能**算进便签（宁可少搬，不可错搬）
    expect(notes[0]).not.toContain('这里不是便签。')
  })

  it('🔴 体量上限：超长便签节必须被截断并留可判记号（轮转不能被一个大节架空）', () => {
    const huge = Array.from({ length: MAX_HANDOVER_NOTE_LINES + 200 }, (_, i) => `填充行 ${i + 1}`)
    const text = buildLog({ noteBody: huge })
    const notes = extractAllHandoverNotes(text)
    expect(notes).toHaveLength(1)
    const n = notes[0]!
    const nLines = n.split('\n').length
    expect(nLines).toBeLessThanOrEqual(MAX_HANDOVER_NOTE_LINES + 8) // 上限 + 记号行
    // 🔴 截断必须有可见记号：静默截断 = 又一次"残缺的长文档"
    expect(n).toMatch(/truncated|已截断|omitted/i)
    expect(n).toContain('填充行 1')
    expect(n).not.toContain(`填充行 ${MAX_HANDOVER_NOTE_LINES + 200}`)
  })

  it('多节并存仍全搬（2026-11-17 那条不许退化）', () => {
    const lines = [
      HANDOVER_NOTE_HEADING,
      '',
      '第一节',
      '',
      '## 中间正文',
      '',
      HANDOVER_NOTE_HEADING,
      '',
      '第二节',
      '',
    ]
    const notes = extractAllHandoverNotes(lines.join('\n'))
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain('第一节')
    expect(notes[1]).toContain('第二节')
  })

  it('四反引号围栏也能识别（``` 与 ```` 都算围栏）', () => {
    const text = buildLog({
      noteBody: ['````', '# 四反引号围栏内的注释', '````', '', '围栏后的便签内容', ''],
      tail: ['## 节外', ''],
    })
    const notes = extractAllHandoverNotes(text)
    expect(notes[0]).toContain('围栏后的便签内容')
    expect(notes[0]).not.toContain('节外')
  })
})
