/**
 * cro-guide.test.ts — CRO 编写指南的镜像测试（S142 §7.8，2026-09-19）
 *
 * ## 为什么这个文件必须存在（两层理由，第二层才是真理由）
 *
 * ① 本仓有 **coverage-gate**（`vitest.config.ts`）：新增 `src` 模块必须同批带镜像测试；
 * ② 🔴 **指南是 CCC 用户写 CRO 程序的唯一入口** —— 它一旦与实现漂移，
 *    用户就会照着**错的契约**写程序，而且**没有任何编译期信号**会提醒他。
 *
 * ⇒ 本文件的核心不是"覆盖率"，而是把指南里**每一句可机械验的断言**钉住：
 *
 * | 指南里的那句话 | 本文件怎么钉 |
 * |---|---|
 * | "样例快照**由装配器实时生成**，永不与 schema 漂移" | 与 `buildCroSnapshot(...)` **逐字相等** |
 * | "（正文里那份 JSON 就是）测试用的参数" | 正文**含有**同一份文本（不是另抄一份） |
 * | "该样例刻意覆盖了：体积 182000 / 空闲 / 有待办唤醒" | 逐条断言（**防指南说谎**） |
 * | 骨架示例里的 `s.body.sessionMdBytes` / `s.binding.runningSessionIds` | 在真快照里**按路径取值**（照抄不会 TypeError） |
 * | owner 两条明示要求（自测+改名 / 一并给测试参数） | 正文断言 |
 *
 * ⚠️ **诚实标注**：本文件测的是"指南与代码一致"，**不是**"指南好读"——
 * 后者只能由人判断（D70 同族：表达质量无法机械验）。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCroSnapshot, CRO_FILENAME, CRO_TIMEOUT_MS } from '../src/cro/core.js'
import {
  CRO_GUIDE,
  CRO_SAMPLE_SNAPSHOT_INPUT,
  croGuidePayload,
  renderCroSampleSnapshot,
} from '../src/cro/guide.js'
import { COGNITIVE_TRAJECTORY_ACTIONS } from '../src/trajectory/core.js'
import { createCognitiveTrajectoryTool } from '../src/tools/cognitive-trajectory.js'

/** 按 `a.b.c` 取值（**取不到返回 undefined**，不抛 —— 本测试就是要判"取不取得到"） */
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

/** 正文里那份样例（派生一次，多处复用） */
const SAMPLE_TEXT = renderCroSampleSnapshot()

describe('CRO 指南: 出口形状（guide 老套路，设计 §8.1）', () => {
  it('croGuidePayload() = { guide }，与 MSM_GUIDE 同款出口', () => {
    const payload = croGuidePayload()
    expect(Object.keys(payload)).toEqual(['guide'])
    expect(payload.guide).toBe(CRO_GUIDE)
  })

  it('🔴 指南真的**够得到**（2026-09-20 前它是"够不到的代码"）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cro-guide-act-'))
    writeFileSync(join(root, '.serenity'), '')
    try {
      const tool = createCognitiveTrajectoryTool({} as never) as unknown as {
        execute: (args: unknown, exec: unknown) => Promise<unknown>
      }
      const out = await tool.execute({ action: 'cro-guide' }, { agent: { session: { header: { cwd: root } } } })
      expect(out).toBe(CRO_GUIDE) // 逐字同源（不是另抄一份）
      expect(out as string).toContain(CRO_FILENAME)
      expect(out as string).toContain(SAMPLE_TEXT) // 样例快照随之到达用户
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('🔴 动作集合含 cro-guide（动作面 = 单一真相源，schema enum 由它派生）', () => {
    expect([...COGNITIVE_TRAJECTORY_ACTIONS]).toContain('cro-guide')
    // 9 → 10（2026-10-18 新增 `uid`：认知轨迹的唯一标识符，独立于编码与命名）
    // 10 → 11（2026-10-20 新增 `resident`：常驻名单只读动作，D173 兑现）
    // 11 → 12（2026-10-22 新增 `interrupted`：以 interrupted 结尾的 dsh 会话只读发现）
    // 12 → 13（同日新增 `continue-all-interrupted`）
    // 🔴🔴 **13 → 11（2026-11-15 owner 令）：`interrupted` 与 `continue-all-interrupted` 整体移除。**
    //    这是「动作面 = 单一真相源」这条判据的**第二次兑现**：本文件不复制动作表，只断言派生出来的
    //    计数与成员关系 ⇒ 删动作时**这里必须跟着红**（本轮它确实红了，正是判据有判别力的证据）。
    //    ⚠️ 能力没删：scheduler 的 60s tick 仍在用 `scanInterruptedSessions`/`createResumeOne`。
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toHaveLength(11)
    // 反向钉（与 trajectory-tool.test.ts 同款）：加回来必须红，⛔ 不许"顺手"恢复
    expect(COGNITIVE_TRAJECTORY_ACTIONS).not.toContain('interrupted')
    expect(COGNITIVE_TRAJECTORY_ACTIONS).not.toContain('continue-all-interrupted')
  })

  it('指南非空且是多行正文（不是占位符）', () => {
    expect(typeof CRO_GUIDE).toBe('string')
    expect(CRO_GUIDE.length).toBeGreaterThan(1000)
    expect(CRO_GUIDE.split('\n').length).toBeGreaterThan(50)
  })

  it('正文含设计 §8.2 大纲的九节骨架（§0~§8）', () => {
    for (const section of ['## 0.', '## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.', '## 8.']) {
      expect(CRO_GUIDE).toContain(section)
    }
  })
})

describe('CRO 指南: 样例快照 = 派生（🔴 单真相源纪律）', () => {
  it('renderCroSampleSnapshot() 可解析为 JSON 对象', () => {
    const parsed = JSON.parse(SAMPLE_TEXT) as Record<string, unknown>
    expect(typeof parsed).toBe('object')
    expect(parsed).not.toBeNull()
  })

  it('🔴 与 buildCroSnapshot() 逐字相等 —— schema 一变样例自动跟着变', () => {
    expect(SAMPLE_TEXT).toBe(JSON.stringify(buildCroSnapshot(CRO_SAMPLE_SNAPSHOT_INPUT), null, 2))
  })

  it('含四组字段（identity / time / body / binding+scheduling）', () => {
    const snap = JSON.parse(SAMPLE_TEXT) as Record<string, unknown>
    expect(snap.version).toBe(1)
    for (const group of ['identity', 'time', 'body', 'binding', 'scheduling']) {
      expect(snap[group], `缺字段组：${group}`).toBeTypeOf('object')
    }
    expect(getPath(snap, 'identity.dirName')).toBe(CRO_SAMPLE_SNAPSHOT_INPUT.dirName)
    // 🔒 不写死轨迹号：从样例 dirName **派生**（否则样例一改中性占位，本断言就成假红；
    //    且写死真轨迹号＝把私有会话号带进随包测试 —— 2026-10-14 隐私核查）
    const expectedCode = /--(S\d+)--/.exec(CRO_SAMPLE_SNAPSHOT_INPUT.dirName)?.[1]
    expect(expectedCode).toBeDefined()
    expect(getPath(snap, 'identity.code')).toBe(expectedCode)
    expect(getPath(snap, 'time.nowMs')).toBe(CRO_SAMPLE_SNAPSHOT_INPUT.nowMs)
  })

  it('🔴 正文里嵌的那份 = 同一份（防"改了模板忘了样例"这类双真相源）', () => {
    expect(CRO_GUIDE).toContain(SAMPLE_TEXT)
  })
})

describe('CRO 指南: 样例确实覆盖它声称覆盖的档位（防指南说谎）', () => {
  const snap = JSON.parse(SAMPLE_TEXT) as Record<string, unknown>

  it('`body.sessionMdBytes` = 182000（**日志过大**那一档）', () => {
    expect(getPath(snap, 'body.sessionMdBytes')).toBe(182_000)
    // 指南的示例代码用 150_000 做阈值 ⇒ 样例必须落在"超限"一侧，否则示例演示不了任何东西
    expect(getPath(snap, 'body.sessionMdBytes') as number).toBeGreaterThan(150_000)
  })

  it('`binding.runningSessionIds` = []（**空闲**；填一个 id 即测"已在干活"分支）', () => {
    expect(getPath(snap, 'binding.runningSessionIds')).toEqual([])
  })

  it('`binding.boundSessionIds` / `liveSessionIds` 非空（演示"绑定"与"live"两组）', () => {
    expect(getPath(snap, 'binding.boundSessionIds')).not.toEqual([])
    expect(getPath(snap, 'binding.liveSessionIds')).not.toEqual([])
  })

  it('`scheduling.pendingWakes` 非空（**已有待办唤醒**）', () => {
    expect(getPath(snap, 'scheduling.pendingWakes')).not.toEqual([])
  })

  it('`body.references` 非空（演示 references 组）+ `scheduling.scheduler` 四字段齐', () => {
    expect(getPath(snap, 'body.references')).not.toEqual([])
    for (const k of ['armed', 'enabled', 'ticks', 'lastSkipReason']) {
      expect(getPath(snap, `scheduling.scheduler.${k}`), `scheduler 缺 ${k}`).not.toBeUndefined()
    }
  })
})

describe('CRO 指南: 骨架点名的字段路径在真快照里真的存在', () => {
  const snap = JSON.parse(SAMPLE_TEXT) as Record<string, unknown>

  // 这些路径**逐字取自指南正文的示例代码**（§5 骨架 + §6 常见模式）：
  // 用户会照抄它们，所以它们必须真的取得到值（否则照抄即 TypeError）。
  it.each([
    'body.sessionMdBytes',
    'binding.runningSessionIds',
    'scheduling.pendingWakes',
    'identity.dirName',
    'identity.code',
    'time.nowMs',
  ])('路径 %s 可取值', (path) => {
    expect(getPath(snap, path)).not.toBeUndefined()
  })

  it('示例用到的类型也对：`sessionMdBytes` 是数字、`runningSessionIds` 是数组', () => {
    expect(typeof getPath(snap, 'body.sessionMdBytes')).toBe('number')
    expect(Array.isArray(getPath(snap, 'binding.runningSessionIds'))).toBe(true)
  })

  it('🔴 指南正文确实点名了这两个路径（否则上面两条钉的是"我猜的路径"）', () => {
    expect(CRO_GUIDE).toContain('s.body.sessionMdBytes')
    expect(CRO_GUIDE).toContain('s.binding.runningSessionIds')
  })
})

describe('CRO 指南: owner 两条明示要求（2026-09-19）', () => {
  it('① 备注"CRO 程序可自测、测试通过再改名"', () => {
    expect(CRO_GUIDE).toContain('自测')
    // 要点 = "用开发名写 → 绿了再改成正式名" 这条可执行流程（改名 = 上线动作）
    expect(CRO_GUIDE).toContain('.dev.ts')
    expect(CRO_GUIDE).toMatch(/测试通过再把文件名改成正式的|绿了[，,]?\s*再改名/)
  })

  it('①-补充：明确"文件在 = 启用"⇒ 改名即上线（用户最易踩的坑）', () => {
    expect(CRO_GUIDE).toContain('文件在 = 启用')
  })

  it('② 一并给出测试用的参数（= 样例快照那一节）', () => {
    expect(CRO_GUIDE).toContain('测试用的参数')
    expect(CRO_GUIDE).toContain(SAMPLE_TEXT) // 参数就是那份快照本身
  })

  it('②-补充：自测断言清单在正文里（§8.4）', () => {
    expect(CRO_GUIDE).toContain('## 8.4')
    expect(CRO_GUIDE).toMatch(/自测该断言什么/)
  })
})

describe('CRO 指南: 与实现常量一致（防"文档说 60 秒、代码是 30 秒"）', () => {
  it('正式入口文件名 = CRO_FILENAME 常量，且正文出现该全名', () => {
    expect(CRO_FILENAME).toBe('continuous-re-occurrence.ts')
    expect(CRO_GUIDE).toContain(CRO_FILENAME)
  })

  it('硬超时数值与 CRO_TIMEOUT_MS 一致（正文写 60 秒）', () => {
    expect(CRO_TIMEOUT_MS).toBe(60_000)
    expect(CRO_GUIDE).toContain(`${CRO_TIMEOUT_MS / 1000} 秒`)
  })

  it('输出契约两字段（wake / prompt）在正文里写全，`reason` 标为可选', () => {
    for (const k of ['"wake"', '"prompt"', '"reason"']) expect(CRO_GUIDE).toContain(k)
    expect(CRO_GUIDE).toContain('可选')
  })

  /**
   * 2026-09-21 所有者令新增全局总闸 `croEnabled`（「需要上 CRO 的开关」）之后补的钉。
   *
   * 钉的是**一句容易漏的话**：指南原文只写「文件在 = 启用」，读者会顺理成章地推成
   * 「文件在 ⇒ 一定会跑」。总闸关掉时 ACC **根本不调用**程序 —— 这两种情况在
   * 现象上都是「没被叫醒」，只有 tick 日志能分辨。所以这句必须在正文里。
   */
  it('🔴 指南点名全局总闸 `croEnabled`（"文件在" ≠ "一定会跑"）', () => {
    expect(CRO_GUIDE).toContain('croEnabled')
    expect(CRO_GUIDE).toContain('总闸')
  })
})
