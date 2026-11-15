/**
 * trajectory/assistant.ts — 关卡化注入的统一命名与风格门面（v0.3，S142）
 *
 * 概念（用户拍板 2026-09-05）：dsp 全部"过程中动态提示注入"统一命名为
 * cognitive-trajectory-assistant（轨迹助航员）。关卡设计思想塑造**结构与时机**
 * （何时/何地注入），**不用于提示词用词**（D8 词法原则）——纯游戏黑话
 * （BOSS/XP/level-up）禁止出现在提示词文本；CHECKPOINT/LIMIT/TUTORIAL 等
 * 跨领域自然通用词允许。
 *
 * 本模块 = token 常量 + level-event 词汇表的**单一真相源**（避免前缀散落
 * 各文件字符串字面量）+ 风格门面（plain 默认 / metaphor 星舰变体）。
 * 仅当 style=metaphor 时前缀包装措辞变化；可行动正文不变 → 零行为漂移。
 *
 * 设计简写（L0 环境 / L1 教程 / L2 目标 / L3 检查点 / L4 极限 / L5 守卫 /
 * L6 结算）仅在本模块注释与内部文档出现，永不浮现在提示词文本。
 *
 * 结算（settlement）挂点：D6 用户拍板——若 CCC 有标准 SESSION 复盘仪式，
 * 结算视图归 cognitive-trajectory-assistant。当前 close/archive 无复盘摘要 ⇒ 机制延后。
 * 🔴 2026-09-25（S142 分批清死代码·第 1 批）：原先那个 `onSettlement(cb)` **空 seam 已删**
 * （零调用者、无触发器、空实现）——仪式真落地时按当时的信号重新设计，**不再靠空占位**。
 */

// ── level-event 词汇表（内部设计简写 → 可见前缀用词）──

/** 可见提示词前缀用词（跨领域自然词，D8：无游戏黑话） */
export const EVENT_LABEL = {
  /** 计分同步提醒（原 TRAJECTORY-STEWARD） */
  checkpoint: 'CHECKPOINT',
  /** 交接提醒（rebuild ≡ reconstruct 共用；2026-11-16 由 `limit`/`limitMandatory` 合并而来） */
  handover: 'HANDOVER',
  /** 重建锚点头部（原 TRAJECTORY-REBUILD） */
  rebuild: 'REBUILD',
  /** 敏感输出边界守卫（原 SERENITY OUTPUT GUARD） */
  guard: 'BOUNDARY GUARD',
  /** SESSION.md 体积超限重写提醒（v1.31.1，S142 用户需求） */
  compaction: 'LOGBOOK COMPACTION',
} as const

/** 家族标识（所有动态注入统一前缀） */
export const ASSISTANT_PREFIX = 'COGNITIVE-TRAJECTORY-ASSISTANT'

/** 完整 token：`[COGNITIVE-TRAJECTORY-ASSISTANT · <LABEL>]` */
export function eventToken(event: keyof typeof EVENT_LABEL): string {
  return `[${ASSISTANT_PREFIX} · ${EVENT_LABEL[event]}]`
}

/** ACK 确认码前缀（recorded/skipped 语义不变，仅家族名更新） */
export const ACK_PREFIX = `${ASSISTANT_PREFIX}-recorded`
export const ACK_SKIP_PREFIX = `${ASSISTANT_PREFIX}-skipped`

/**
 * 交接便签的**落点**：`LOG/LOG.md` 里的节名（2026-11-16 owner 裁定）。
 *
 * ## 它取代了什么
 * v1.49.0 曾把交界材料分家到**独立文件** `REBUILD-TODO.md`。v1.136.0 起 LOG 有了
 * **机械轮转**（`carrier-log.ts`），于是那个独立文件成了第三种住处——而它要装的东西
 * （"我卡在哪一步"）本质是**过程留痕**，与 LOG 同性质、同寿命、同策展度。
 * ⇒ 2026-11-16 owner 裁定：**整体删掉独立文件**，便签住进 LOG 的一节，
 * 轮转时**整节搬运**进新代出生头（否则旧代冻结、新代空白 ⇒ 交接断开）。
 *
 * ## 🔴 三处引用同一常量（单一真相源）
 * **写侧** = `seams/cognitive-trajectory-lifecycle.ts` 的 `handoverReminderText()`｜**读侧** = `trajectory/rebuild.ts` 的重建锚点｜
 * **搬运** = `trajectory/carrier-log.ts` 的 `rotateCarrierLog()`。
 * 节名一旦漂移，写侧写的东西读侧就找不到，**且没有任何机械信号会报警**。
 */
export const HANDOVER_NOTE_HEADING = '## Handover note'

/** 交接便签在 LOG 里的相对路径（给人读的提示用） */
export const LOG_FILE_REL = 'LOG/LOG.md'

// ── 风格门面（D8：仅 plain 与 metaphor；无 game 档）──

/** 风格档位：plain（默认，精确文本）/ metaphor（借星舰词——产品隐喻非游戏词） */
type CognitiveTrajectoryStyle = 'plain' | 'metaphor'

/** 星舰词变体（仅在 style=metaphor 时替换可见前缀；正文不动） */
const METAPHOR_PREFIX: Record<keyof typeof EVENT_LABEL, string> = {
  checkpoint: 'CHECKPOINT',
  handover: 'HANDOVER',
  rebuild: 'REBUILD',
  guard: 'BOUNDARY GUARD',
  compaction: 'LOGBOOK COMPACTION',
}

/**
 * 按风格生成前缀 token。plain = eventToken()（原样）；metaphor 仅当有
 * 星舰化变体时替换用词（当前等价保留——星舰词库隐喻域的既有措辞即
 * "context limit/deck check" 类，不强制替换；扩展点留给未来实验）。
 */
export function styledToken(event: keyof typeof EVENT_LABEL, style: CognitiveTrajectoryStyle = 'plain'): string {
  if (style === 'metaphor' && METAPHOR_PREFIX[event]) {
    return `[${ASSISTANT_PREFIX} · ${METAPHOR_PREFIX[event]}]`
  }
  return eventToken(event)
}

