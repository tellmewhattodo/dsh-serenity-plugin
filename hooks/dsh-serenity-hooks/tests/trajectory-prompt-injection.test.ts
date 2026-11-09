/**
 * trajectory-prompt-injection.test.ts — **轨迹提示词注入模式**（owner 2026-10-20 令）
 *
 * ## 判据来自哪里（每一条都对着 owner 的原话或一条失败模式）
 *
 * > 「轨迹自身的配置里要有提示词注入选项：**默认追加**，可以设定为**替换宁静号系统提示词的约束部分**；
 * >   同时要确认对该提示词和设定的修改可以**热生效**。」
 *
 * | 判据 | 防的是什么 |
 * |---|---|
 * | 缺省 = append（逐字不变） | 加选项**不许**改变既有轨迹的装配结果（兼容） |
 * | replace ⇒ 四个约束块消失、轨迹提示词站到它们原位 | "替换"必须真的替换，且读者顺序仍然是"身份→章法" |
 * | **身份块（`=== Serenity ACC ===`）永不在可替换集** | 边界：它回答"我在哪工作"，不是"按什么章法" |
 * | replace 但**没有** PROMPT.md ⇒ **不替换** + 告警 | 没有替代物的替换 = **静默清空纪律** |
 * | 未知块名 / append 下写 replaces ⇒ 丢弃并**指名** | 不教"会静默不生效的写法" |
 * | 改 `trajectory.json`／改 `PROMPT.md` ⇒ **同进程下一轮即生效** | 这两者都必须热生效（不靠重启解释） |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planPromptInjection, REPLACEABLE_PROMPT_BLOCKS } from '../src/trajectory/prompt-injection.js'
import { serenitySystemPrompt } from '../src/seams/system-prompt.js'

const DIR = '2026-10-20--S930--role'
const H = {
  acc: '=== Serenity ACC ===',
  metaphor: '=== Serenity Metaphor ===',
  principles: '=== Serenity Principles ===',
  cce: '=== Serenity CCE ===',
  eap: '=== Serenity EAP ===',
  traj: '=== Serenity Trajectory Prompt ===',
  // 🔴 v1.124.0：原 `tools: '=== Serenity Tools ==='`（工具清单块）已随 owner 令删除，
  //    该位置只剩 MSM 调用示例，标题随之改为 `Serenity MSM`。
  //    ⚠️ 本常量在这里的作用是**块尾锚点**（"轨迹提示词排在它之前"）——
  //    换成 MSM 标题后语义不变：轨迹提示词仍在工具/协议层之前。
  tools: '=== Serenity MSM ===',
}
const CONSTRAINT_HEADERS = [H.metaphor, H.principles, H.cce, H.eap]

let ccc: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'pi-'))
  writeFileSync(join(ccc, '.serenity'), 'test')
})
afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
})

/** 建一条轨迹目录：`prompt` = PROMPT.md 正文（不给则不建文件）；`injection` = trajectory.json 的 prompt 段 */
function makeTrajectory(opts: { prompt?: string; injection?: unknown } = {}): string {
  const d = join(ccc, 'AGENT_SESSIONS', DIR)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SESSION.md'), '# SESSION: role\n')
  if (opts.prompt !== undefined) writeFileSync(join(d, 'PROMPT.md'), opts.prompt)
  if (opts.injection !== undefined) writeFileSync(join(d, 'trajectory.json'), JSON.stringify({ prompt: opts.injection }))
  return d
}

/** 按块标记取装配结果 */
const assemble = (): string => serenitySystemPrompt(ccc, 'scope-x', DIR)

describe('planPromptInjection：纯判决（不读盘、不打日志）', () => {
  it('没写 prompt 段 ⇒ append / 空替换集 / 第 ⑧ 位 / 零告警（**默认行为逐字不变**）', () => {
    const plan = planPromptInjection(undefined, true)
    expect(plan.mode).toBe('append')
    expect([...plan.replaces]).toEqual([])
    expect(plan.promptPosition).toBe('late')
    expect(plan.problems).toEqual([])
  })

  it('replace（缺省 replaces）⇒ 四个约束块全换，提示词站原位', () => {
    const plan = planPromptInjection({ injection: 'replace' }, true)
    expect(plan.mode).toBe('replace')
    expect([...plan.replaces].sort()).toEqual([...REPLACEABLE_PROMPT_BLOCKS].sort())
    expect(plan.promptPosition).toBe('constraint')
    expect(plan.problems).toEqual([])
  })

  it('🔴 replace 但没有 PROMPT.md ⇒ **降级 append** 并告警（没有替代物的替换 = 静默清空纪律）', () => {
    const plan = planPromptInjection({ injection: 'replace' }, false)
    expect(plan.mode).toBe('append')
    expect([...plan.replaces]).toEqual([])
    expect(plan.problems.join('\n')).toMatch(/没有 PROMPT\.md/)
  })

  it('非法 injection 取值 ⇒ append + 指名该取值', () => {
    const plan = planPromptInjection({ injection: 'replaceAll' }, true)
    expect(plan.mode).toBe('append')
    expect(plan.problems.join('\n')).toContain('replaceAll')
  })

  it('append 下写 replaces ⇒ 忽略并说明（不教空头写法）', () => {
    const plan = planPromptInjection({ injection: 'append', replaces: ['cce'] }, true)
    expect(plan.mode).toBe('append')
    expect([...plan.replaces]).toEqual([])
    expect(plan.problems.join('\n')).toMatch(/只在 injection="replace" 下生效/)
  })

  it('🔴 身份块不可替换：`identity` 被丢弃且**指名**，合法项照常生效', () => {
    const plan = planPromptInjection({ injection: 'replace', replaces: ['metaphor', 'identity'] }, true)
    expect([...plan.replaces]).toEqual(['metaphor'])
    expect(plan.problems.join('\n')).toContain('identity')
    expect(plan.problems.join('\n')).toMatch(/刻意不可替换/)
  })

  it('显式 `[]` ⇒ 一块都不换，提示词仍站第 ⑧ 位（用户的明确意图，不告警）', () => {
    const plan = planPromptInjection({ injection: 'replace', replaces: [] }, true)
    expect(plan.mode).toBe('replace')
    expect([...plan.replaces]).toEqual([])
    expect(plan.promptPosition).toBe('late')
    expect(plan.problems).toEqual([])
  })
})

describe('装配：append（缺省）与 replace 两个模式', () => {
  it('缺省（无 trajectory.json）⇒ 四块齐在，轨迹提示词在第 ⑧ 位（EAP 之后、Tools 之前）', () => {
    makeTrajectory({ prompt: '这是我的章法' })
    const text = assemble()
    for (const h of CONSTRAINT_HEADERS) expect(text, `缺块：${h}`).toContain(h)
    expect(text).toContain(H.acc)
    expect(text).toContain('这是我的章法')
    expect(text.indexOf(H.eap)).toBeLessThan(text.indexOf(H.traj))
    expect(text.indexOf(H.traj)).toBeLessThan(text.indexOf(H.tools))
  })

  it('🔴 replace ⇒ 四个约束块**消失**，轨迹提示词紧随身份之后，身份块**仍在**', () => {
    makeTrajectory({ prompt: '这是我的章法', injection: { injection: 'replace' } })
    const text = assemble()
    for (const h of CONSTRAINT_HEADERS) expect(text, `本应被替换却仍在：${h}`).not.toContain(h)
    expect(text).toContain(H.acc)
    expect(text).toContain('这是我的章法')
    // 位置：身份 → 我的章法 → 其余（工具块殿后）
    expect(text.indexOf(H.acc)).toBeLessThan(text.indexOf(H.traj))
    expect(text.indexOf(H.traj)).toBeLessThan(text.indexOf(H.tools))
  })

  it('replace + 只点名 `cce` ⇒ 其余三块照常注入（细粒度替换）', () => {
    makeTrajectory({ prompt: '只换连续性纪律', injection: { injection: 'replace', replaces: ['cce'] } })
    const text = assemble()
    expect(text).not.toContain(H.cce)
    expect(text).toContain(H.metaphor)
    expect(text).toContain(H.principles)
    expect(text).toContain(H.eap)
    expect(text).toContain('只换连续性纪律')
  })

  it('🔴 replace 但没有 PROMPT.md ⇒ 装配结果与 append **逐块一致**（不静默清空）', () => {
    makeTrajectory({ injection: { injection: 'replace' } })
    const text = assemble()
    for (const h of CONSTRAINT_HEADERS) expect(text, `被静默清空了：${h}`).toContain(h)
    expect(text).not.toContain(H.traj)
  })
})

describe('🔴 热生效：设定与正文的改动都不需要重启', () => {
  it('同进程内把 append 改成 replace ⇒ **下一次装配**即换挡（无需重启）', () => {
    makeTrajectory({ prompt: '我的章法' })
    expect(assemble()).toContain(H.cce) // ① 缺省：块在
    // ② 改设定（文件系统层面就是写一个 trajectory.json）
    writeFileSync(
      join(ccc, 'AGENT_SESSIONS', DIR, 'trajectory.json'),
      JSON.stringify({ prompt: { injection: 'replace' } }),
    )
    const after = assemble()
    expect(after).not.toContain(H.cce)
    expect(after).toContain('我的章法')
  })

  it('改 PROMPT.md 正文 ⇒ 下一次装配即读到新正文（mtime + size 判据）', () => {
    makeTrajectory({ prompt: '第一版章法' })
    expect(assemble()).toContain('第一版章法')
    writeFileSync(join(ccc, 'AGENT_SESSIONS', DIR, 'PROMPT.md'), '第二版章法（更长一点，确保 size 变化）')
    const after = assemble()
    expect(after).toContain('第二版章法')
    expect(after).not.toContain('第一版章法')
  })

  it('删掉 PROMPT.md ⇒ replace 立刻降级回 append（块回来，章程消失）', () => {
    const d = makeTrajectory({ prompt: '我的章法', injection: { injection: 'replace' } })
    expect(assemble()).not.toContain(H.cce)
    rmSync(join(d, 'PROMPT.md'))
    const after = assemble()
    expect(after).toContain(H.cce)
    expect(after).not.toContain('我的章法')
  })
})

describe('告警：坏设定响亮但不刷屏', () => {
  it('未知块名 ⇒ 告警一次（同一 CCC × 轨迹 × 原因去重），且不阻断装配', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    makeTrajectory({ prompt: 'x', injection: { injection: 'replace', replaces: ['principle'] } })
    const text = assemble()
    assemble()
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('principle'))
    expect(hits).toHaveLength(1)
    // 拼错的块名不生效 ⇒ 该块照常注入（**不静默失配**）
    expect(text).toContain(H.principles)
    warn.mockRestore()
  })
})
