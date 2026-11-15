/**
 * trajectory-assistant.test.ts — `trajectory/assistant.ts` 的镜像测试（v0.3，S142）
 *
 * 覆盖：token 常量单一真相源（eventToken / EVENT_LABEL）/ ACK 前缀 /
 * 风格门面（plain 默认 + metaphor 变体——仅前缀措辞，D8 无 game 档）/
 * 交接便签落点常量（2026-11-16：住 LOG，不另立文件）。
 */
import { describe, it, expect } from 'vitest'
import {
  ASSISTANT_PREFIX,
  EVENT_LABEL,
  ACK_PREFIX,
  ACK_SKIP_PREFIX,
  eventToken,
  styledToken,
  HANDOVER_NOTE_HEADING,
  LOG_FILE_REL,
} from '../src/trajectory/assistant.js'

describe('cognitive-trajectory-assistant: token 常量（单一真相源）', () => {
  it('家族标识 + 可见用词（自然跨领域词，无游戏黑话 D8）', () => {
    expect(ASSISTANT_PREFIX).toBe('COGNITIVE-TRAJECTORY-ASSISTANT')
    expect(EVENT_LABEL.checkpoint).toBe('CHECKPOINT')
    // 🔴 2026-11-16：`limit` / `limitMandatory` 已合并为 **handover** ——
    //    rebuild 与 reconstruct 对会话做的是同一件事（把它换掉），故只有一条注入。
    expect(EVENT_LABEL.handover).toBe('HANDOVER')
    expect(EVENT_LABEL.rebuild).toBe('REBUILD')
    expect(EVENT_LABEL.guard).toBe('BOUNDARY GUARD')
    // D8：无任何游戏黑话
    const all = Object.values(EVENT_LABEL).join(' ')
    expect(all).not.toMatch(/BOSS|XP|level|respawn/i)
    // 反向钉：旧档位不许复活（两档并存 = 两条注入 = 会话要自己判断该调哪个）
    expect(Object.keys(EVENT_LABEL)).not.toContain('limit')
    expect(Object.keys(EVENT_LABEL)).not.toContain('limitMandatory')
  })

  it('eventToken 组装完整前缀', () => {
    expect(eventToken('checkpoint')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(eventToken('handover')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
    expect(eventToken('rebuild')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · REBUILD]')
    expect(eventToken('guard')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · BOUNDARY GUARD]')
  })

  it('ACK 前缀（recorded/skipped 语义不变，家族名更新）', () => {
    expect(ACK_PREFIX).toBe('COGNITIVE-TRAJECTORY-ASSISTANT-recorded')
    expect(ACK_SKIP_PREFIX).toBe('COGNITIVE-TRAJECTORY-ASSISTANT-skipped')
  })
})

describe('cognitive-trajectory-assistant: 交接便签落点（2026-11-16 裁定）', () => {
  it('🔴 便签住 LOG/LOG.md 的固定节名，⛔ 不另立文件', () => {
    expect(HANDOVER_NOTE_HEADING).toBe('## Handover note')
    expect(LOG_FILE_REL).toBe('LOG/LOG.md')
  })

  it('反向钉：独立便签文件名不得复活（它会让在办状态出现第二个住处）', () => {
    // 判据：`REBUILD-TODO.md` 这个常量已从 assistant.ts 删除。
    // 若有人把它加回来，写侧与读侧会再次分叉而无人报警。
    expect(HANDOVER_NOTE_HEADING).not.toContain('REBUILD-TODO')
    expect(LOG_FILE_REL).toContain('LOG/')
  })
})

describe('cognitive-trajectory-assistant: 风格门面（plain 默认 / metaphor 变体）', () => {
  it('缺省 = plain（与 eventToken 一致）', () => {
    expect(styledToken('checkpoint')).toBe(eventToken('checkpoint'))
    expect(styledToken('handover')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
  })

  it('metaphor 档：仅前缀措辞变体（无 game 档——D8）', () => {
    // metaphor 与 plain 目前对 handover 等价（星舰词库无更强变体）—— 记下来而不是假装有差别
    expect(styledToken('handover', 'metaphor')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
    // 无 metaphor 变体的事件 → 回退 plain（措辞一致）
    expect(styledToken('checkpoint', 'metaphor')).toBe('[COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT]')
  })
})
