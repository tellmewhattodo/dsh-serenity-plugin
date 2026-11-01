/**
 * tools/kit/index.ts — dashboard 真实 DSH 工具定义（defineTool）（v1.30：acc_kit → dashboard）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import { cccRootForExec } from '../../kernel/ccc-roots.js'
import { runKit, KIT_ACTIONS } from './service.js'

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * dashboard 工具（v1.30.7：闭包捕获 ctx → health 可附宿主契约探针 F-05）。
 * ctx 仅用于**只读探针**（`ctx.get` / 属性读取），无副作用。
 */
export function createKitTool(ctx: Context) {
  return defineTool({
    name: 'dashboard',
    description: 'Dashboard — always-on container instruments (works any time, no side effects): health (CCC three-principle check P1/P2/config + MSM registry integrity + host-contract probe, healthy/degraded) / time (now_iso/now_local/epoch_ms) / wait (wait N seconds, default 1) / diag (ACC runtime diagnosis, read-only: live sessions across all CCCs / wake scheduler clock / CRO-enabled trajectories / wake registry split into future vs overdue / trajectory-subscription delivery readings). Routine self-check before entering a CCC.',
    parameters: {
      action: { type: 'string', enum: [...KIT_ACTIONS], required: true, description: 'Subcommand' },
      seconds: { type: 'integer', description: 'Seconds to wait (positive integer, default 1)' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      // CCC 缺失时不抛错——health 返回 degraded 报告（对齐 osp 未激活语义）
      const root = cccRootForExec(exec)
      return await runKit(root, args, ctx)
    },
  })
}
