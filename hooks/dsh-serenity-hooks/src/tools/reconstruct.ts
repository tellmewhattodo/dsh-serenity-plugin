/**
 * tools/reconstruct.ts — `reconstruct` 工具面（owner 2026-11-06 令）
 *
 * 只有一个动作、两个参数（与 `rebuild` 同形），因为它的语义就是"rebuild 的换代版"：
 *
 * | 参数 | 必需 | 说明 |
 * |---|---|---|
 * | `summary` | ✅ | 内容概括 ≤20 字（新载体的会话标题用它，与 rebuild 同一个服务端清洗/截断） |
 * | `note` | — | 任务焦点 ≤200 字（注入新载体锚点的 `- Task focus:` 行） |
 *
 * ## 🔴 本工具**平时不可见**，由 `register(def, { when })` 控制
 *
 * 判据在 `trajectory/reconstruct.ts` 的 {@link makeReconstructWhen}：累计 token ≥ 阈值才放出。
 * ⇒ **工具面的注册点在 `index.ts`**，本文件只给 `def`（不为可见性负责）。
 *
 * ## 为什么文案要写"它和 rebuild 有什么不同"
 *
 * 模型同时看到 `rebuild` / `reconstruct` 时会**默认选更熟的那个**（rebuild），
 * 而两者治的**不是同一个病**（rebuild 治上下文、reconstruct 治日志体积）。
 * ⇒ 描述里必须一句话说清"什么时候该用我"，否则这个工具等于不存在
 *   （它只在阈值后才出现，那时模型更没机会摸索）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { agentCwdFor, cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../kernel/ccc-roots.js'
import { queueReconstruct, RECONSTRUCT_TOKEN_THRESHOLD, readTokenTotals, cumulativeTokens } from '../trajectory/reconstruct.js'

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 造 `reconstruct` 工具定义（**不带任何可见性判定**）。
 *
 * @param ctx 插件上下文（排队时需要 `ctx.sessions.get` 定位会话；闭包捕获）
 */
export function createReconstructTool(ctx: unknown) {
  return defineTool({
    name: 'reconstruct',
    description: [
      'Replace this conversation as the carrier of this cognitive trajectory — the successor of rebuild, '
      + 'not a variant of it.',
      'rebuild clears THIS conversation in place, so the same session keeps growing its log. reconstruct '
      + 'creates a NEW dsh session, binds the same cognitive trajectory to it, injects the continue anchor '
      + 'there, and then archives the current session. Nothing is lost: SESSION.md stays where it is and the '
      + 'new carrier resumes from it.',
      'Use it when the carrier session itself has become too large to keep (its cumulative token usage passed '
      + 'the configured ceiling). Use rebuild instead when only the model context is too big — that one is '
      + 'cheap and keeps the same session.',
      `This tool appears only after that ceiling is passed (threshold ${RECONSTRUCT_TOKEN_THRESHOLD} cumulative '
      + 'tokens, counting every usage bucket: uncached input + cache read + cache write + output). `
      + 'Its absence means the carrier is still within budget.',
      'It queues: the swap runs when this turn ends, so finish the step you are in first. It takes the same '
      + 'parameters as rebuild — summary (required, ≤20 chars, becomes part of the new carrier\'s title) and '
      + 'note (optional, ≤200 chars, becomes the task focus line in the new carrier\'s anchor).',
    ].join(' '),
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description:
          'Content summary ≤20 chars — names the next work phase. Appended to the NEW carrier\'s session title '
          + 'as S###-YYYY-MM-DD-<summary>; the S### id and date stay server-derived. Same parameter as rebuild.',
      },
      note: {
        type: 'string',
        description:
          'Task focus ≤200 chars for the new carrier — what to work on next (short, no history; SESSION.md holds '
          + 'the full history). Injected as "- Task focus: …" into the continue anchor. Same parameter as rebuild.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
      if (!args.summary || args.summary.trim() === '') {
        throw new Error(
          'reconstruct requires summary <content summary ≤20 chars> '
          + '(the new carrier\'s dsh session title is renamed to S###-YYYY-MM-DD-<summary>)',
        )
      }
      const dshSessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? ''
      if (!dshSessionId) throw new Error('Unable to determine the current dsh session id')
      const result = queueReconstruct(ctx, {
        root,
        note: args.note as string | undefined,
        summary: args.summary as string,
        dshSessionId,
      })
      // 回执里给出**当前读数**：owner 要的"已经过于庞大"是可核的量，不是一句话。
      const totals = readTokenTotals(ctx, (exec as { agent?: { session?: unknown } }).agent?.session)
      return {
        ok: true,
        queued: result.queued,
        carrierSessionId: dshSessionId,
        cumulativeTokens: totals ? cumulativeTokens(totals) : null,
        threshold: RECONSTRUCT_TOKEN_THRESHOLD,
        anchor: result.anchor,
        sessionMdPath: result.sessionMdPath,
        instruction:
          'Queued carrier replacement: when this turn ends, a NEW dsh session is created, this cognitive trajectory '
          + 'is bound to it, the continue anchor is injected there, and the current session is archived. '
          + 'Resume from SESSION.md in the new conversation — do not keep working in this one.',
      }
    },
  })
}

/** 供 `when` 判据复用的 cwd 读取（同一处来源，⛔ 不各写一份） */
export { agentCwdFor }
