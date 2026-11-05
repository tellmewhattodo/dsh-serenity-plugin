/**
 * seams/humor.ts — **脱口秀片段注入**（2026-11-04，owner 想法）
 *
 * ## owner 原话（本文件存在的全部理由）
 *
 * > 「我们 Serenity 收集一版各类脱口秀的片段内容，随机性在会话和 rebuild 的时候
 * >   去进行一段注入到系统提示词（一段完整的），这个不会改变什么行为，
 * >   但是会让过程变得有趣」
 * > 「要做到随机，例如我们收集 30 段，每次随机注入一段；在提示词中要诚恳：
 * >   先来看看这段脱口秀片段再继续阅读吧」
 * > 「这个功能要做个开关」
 *
 * ## 🔴 三条硬约束（每条都对应一个会出问题的位置）
 *
 * ### ① 随机的时机 = **会话开始**，会话进行中**绝不变**
 *
 * owner 原话：「随机是指会话开始的时候随机，rebuild 的时候换一个；会话进行中不变动」
 * （2026-11-04 二次确认：**rebuild 用同一个 session.id**，故 `sessionId` 单种子即满足
 *   —— rebuild 属实不换段，这正是期望行为。⛔ 不要为了"rebuild 也换"而引入代次。）
 *
 * ⚠️ **为什么不用 `Math.random()` 现抽**：`serenitySystemPrompt()` **每次请求都重新求值**
 * ⇒ 现抽会让系统提示词每轮都变（刷新页面都可能换段），而我们**无法解释为什么变了**。
 * ⇒ 选哪段可以随机，但**选定后必须可重放**：种子 = sessionId，纯函数。
 *
 * ### ② 原文住**用户配置**，⛔ 不进仓
 *
 * 本仓是 **GitHub 公开仓**。脱口秀段子是有版权的创作文本，
 * ⇒ 机制在 ACC（怎么选、怎么注入），**措辞在用户配置**（`~/.dsh/serenity-hooks.json`
 *   的 `humor.bits`，仓外）—— 与 D23「ACC 管机制、CCC 管措辞」同款分工。
 * ⛔ 不要往本文件里贴任何段子原文。
 *
 * ### ③ 关闭时必须与现状**逐字节相同**
 *
 * 它是纯装饰，进的是每次请求的系统提示词。
 * ⇒ `enabled=false`（或池为空）时 `humorBlock()` 返回 `''`，装配层不 push。
 *   判据由测试钉住。
 */

/** 会话（或任意字符串）→ 稳定索引。FNV-1a 32 位：无依赖、纯函数、够均匀。 */
function stableIndex(seed: string, mod: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % mod
}

/**
 * 按种子稳定地选一段（**纯函数**：同种子必得同一段）。
 *
 * @param seed 会话 id
 * @param bits 片段池（来自用户配置）
 * @returns 选中的文本；池空 ⇒ `null`
 */
export function pickHumor(seed: string, bits: readonly string[]): string | null {
  if (bits.length === 0) return null
  return bits[stableIndex(seed, bits.length)] ?? null
}

/**
 * 装配进系统提示词的块（owner 指定的诚恳开场：**先来看看这段脱口秀片段再继续阅读吧**）。
 *
 * 🔴 **分段边界必须说清**：本块自带 `=== Serenity Humor ===` 标记头，
 * 与 persona／EAP 等块同构，便于从装配结果里一眼确认它在不在。
 * 结尾补一句「不影响任何判断」—— 它是装饰，**不能被读成行为约束**。
 *
 * @param seed 会话稳定种子（sessionId）
 * @param bits 片段池
 * @param enabled 总开关；`false` ⇒ 返回 `''`（逐字节等于没有本功能）
 */
export function humorBlock(seed: string, bits: readonly string[], enabled: boolean): string {
  if (!enabled) return ''
  const bit = pickHumor(seed, bits)
  if (bit === null) return ''
  return [
    '',
    '=== Serenity Humor ===',
    '先来看看这段脱口秀片段再继续阅读吧：',
    '',
    bit.trimEnd(),
    '',
    '（读完就继续正事。它只是路过，不影响任何判断。）',
    '',
  ].join('\n')
}
