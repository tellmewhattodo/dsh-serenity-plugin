/**
 * guard/seam.ts — 输出守卫拦截缝（v1.26.3，S142 用户需求）
 *
 * `agent/turn-stopping`（serial）时：取该 turn 最后 assistant 文本 → 敏感词表检测 →
 * 命中 → `agent.steer(buildRebuke(hits))` 打回重生成（turn 不关闭，模型同轮重答）。
 * 连续命中达 REBUKE_MAX_ROUNDS → 放弃打回（防死循环），输出保留 + 审计日志。
 *
 * 作用范围（v1.26.3 用户拍板）：**仅外部面**——轨迹约束 等对外输出会话
 * （session id `轨迹约束-`/`rebuild-` 前缀；v1.22.4 rebuild 新建会话同面）。
 * **本地维护会话（普通 dsh 会话）不检测**——维护会话必然提及机制词
 * （dsh-serenity-hooks/cognitive_trajectory rebuild/mech-registry），打回会瘫痪自身工作。
 *
 * 🔴 **2026-10-15 补注（面 E 退役）**：`acp-` 前缀分支**已成孤儿，但本批不动**。
 * 判据（两条，实测）：① **该前缀从来没有生产者** —— 历史 `acp-core.ts` 建会话走的是
 * `createTrajectoryAgent`，其 id = `` `轨迹约束-${role}-${uuid}` ``（`trajectory/session.ts`）⇒ `acp-` **从不出现**；
 * ② 面 E 退役后连"本可能产生它的模块"也不在了。⇒ 该分支是**恒 false 的死判据**。
 * ⚠️ **仍不擅自删**：这是**运行时字符串比较**，删它属**行为变更**（不是纯清理），
 * 依本轨既有先例（`cheap-worker-` 前缀孤儿 —— 生产者文件已于 2026-10-28 整条删除，
 * 但四处判断保留作兼容，同族、同判据）⇒ **登记待裁**（见 S142 §当前状态「观察」）。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { deliver, makeInjection } from '../kernel/injection.js'
import { isTrajectoryConstrained } from '../trajectory/policy/profile.js'
import { stripThink } from '../surface/text.js'
import { buildSensitiveTable, detectSensitive, buildRebuke, rebukeStates, REBUKE_MAX_ROUNDS } from './filter.js'
import { sessionEvents } from '../trajectory/core.js'

/**
 * 外部面会话判定（v1.26.3 用户拍板：仅外部面检测，本地维护会话豁免）。
 *
 * 🔴 **2026-10-19 判据更换**：轨迹约束那一条从「sessionId 前缀 `轨迹约束-`」改为
 * **「该会话绑定的轨迹有 `trajectory-constraint.json`」**（owner 重做令）。前缀判据在新模型下是
 * **错的**——轨迹约束的身份是轨迹，不再由 id 前缀表达；继续用前缀会漏掉所有
 * "挂在 轨迹约束轨迹上、但 id 不带前缀"的会话（典型 = 微信桥按轨迹派生的会话 id）。
 *
 * ⚠️ `rebuild-` 前缀保留（那是另一件事：重建会话同属对外面，与 轨迹约束 无关）；
 * `acp-` 分支保留但**已是死判据**（无生产者；面 E 已于 2026-10-15 退役）——
 * 理由与"为何不擅自删"见文件头注释。
 */
function isExternalFaceSession(sessionId: string | undefined, root: string): boolean {
  if (!sessionId) return false
  // 🔵 **这里刻意仍用 `isTrajectoryConstrained`（文件存在），不用 D183 的
  //    `replacesDefaultIdentity`** —— 两个判据回答**不同的问题**：
  //    · 身份旁路问「它自带章程吗」（自带 ⇒ 不该再注入 ACC 身份）
  //    · 本函数问「它是不是对外面」（输出守卫要不要保护隐私）
  //    受约束的轨迹（IM 会话）**没有**自带章程，但**确实是**对外面 ⇒ 用身份判据会把
  //    它们的输出守卫误关掉，那是一次静默的隐私回归。
  return isTrajectoryConstrained(root, sessionId) || sessionId.startsWith('acp-') || sessionId.startsWith('rebuild-')
}

/** 读会话最后一个 assistant/message 文本（trajectory-session 同款）
 *  **v1.63.3 起唯一的导出理由消失**：原导出是给 `unattended-seam.ts` 复用的（D77），
 *  该文件已随无人值守功能整条退役 ⇒ 现只有本模块自己用（`isLeak` 的调用点）。
 *  ⚠️ 保持 `export` 无害（它有测试覆盖，且将来"同一读法只留一份"的纪律仍成立），
 *  但**不要**再写成"为了 X 复用才导出"——那个 X 不存在了。
 *  **v1.27.7：剥离 think 块再检测**（用户："不检查think内容（因为不输出）"）——
 *  ` think…` 是模型思考过程，不进入用户可见输出；敏感词检测只针对**最终呈现文本**，
 *  否则 think 内提及内部机制词（思考过程必然推演机制）会误打回。复用 stripThink
 *  （v1.26.8 状态机，弃正则——同 v1.27.1 微信桥回复链路）。 */
export function lastAssistantText(agent: Agent): string {
  const events = sessionEvents(agent.session)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { message?: { content?: unknown }; content?: unknown } } | undefined
    if (e && e.type === 'assistant/message') {
      const blocks = (e.data?.message?.content ?? e.data?.content ?? []) as Array<{ type?: string; text?: string }>
      const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
      if (text) return stripThink(text)
    }
  }
  return ''
}

/**
 * 注册输出守卫（index.ts apply 调用）：
 * turn-stopping 时检测最终输出，命中敏感词 → steer 打回重生成（官方机制，零改 DSH）。
 */
export function registerOutputGuardHook(ctx: Context): void {
  ctx.on('agent/turn-stopping', (payload: { agent?: Agent; turn?: number }) => {
    const agent = payload?.agent
    if (!agent) return
    // 作用范围（v1.26.3 用户拍板）：仅外部面（轨迹约束/acp/rebuild 前缀）——
    // 本地维护会话（普通 dsh 会话）豁免：维护会话必然提及机制词，打回会瘫痪自身工作
    const sessionId = String((agent.session as { id?: unknown }).id ?? '')
    // 激活门控：只在 .serenity 存在的 CCC 目录检测（非 CCC 目录零干预）
    const cwd = (agent.session as { header?: { cwd?: string } }).header?.cwd ?? process.cwd()
    const root = cccRootForCwd(cwd)
    if (!root) return
    // 作用范围：仅外部面 —— 本地维护会话豁免（维护会话必然提及机制词，打回会瘫痪自身工作）
    if (!isExternalFaceSession(sessionId, root)) return

    const id = agent.id
    const text = lastAssistantText(agent)
    if (!text) return // 无最终输出（工具调用轮等）不检测

    const table = buildSensitiveTable(root)
    const hits = detectSensitive(text, table)
    if (hits.length === 0) {
      rebukeStates.delete(id) // 合规 → 重置连续计数
      return
    }

    const st = rebukeStates.get(id) ?? { consecutive: 0 }
    st.consecutive += 1
    rebukeStates.set(id, st)

    if (st.consecutive > REBUKE_MAX_ROUNDS) {
      // 达上限放弃打回：审计 + 状态清理（输出保留——避免无响应；记录供人工介入）
      rebukeStates.delete(id)
      console.warn(
        `[serenity-hooks] output-guard: giving up after ${REBUKE_MAX_ROUNDS} rebukes (agent=${id}, turn=${payload.turn ?? '?'}) — response kept for manual review`,
      )
      return
    }

    console.log(
      `[serenity-hooks] output-guard: rebuke ${st.consecutive}/${REBUKE_MAX_ROUNDS} (agent=${id}, turn=${payload.turn ?? '?'}, hits=${hits.length})`,
    )
    // 打回：steer 纠正消息 → turn 不关闭 → 模型同轮重生成（DSH 官方机制）
    // 🔴 **DII M2 · 注入点 #7**（2026-11-04）：改走 `deliver()`。
    //    `delivery:'wake-now'` ⇒ 通道由 deliver 选（steer），⛔ 调用点不再自己挑。
    //    行为零变更：仍是 steer、仍是同轮重生成。
    try {
      deliver(
        makeInjection({
          origin: 'acc',
          form: 'notice',
          summary: `输出守卫打回（${hits.length} 处敏感词）`,
          text: buildRebuke(hits),
          delivery: 'wake-now',
        }),
        agent,
      )
    } catch (error) {
      console.warn(`[serenity-hooks] output-guard steer failed: ${String((error as Error)?.message ?? error)}`)
    }
  })
}
