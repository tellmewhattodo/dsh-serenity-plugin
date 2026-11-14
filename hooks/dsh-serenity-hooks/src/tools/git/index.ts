/**
 * tools/git/index.ts — container_git 真实 DSH 工具定义（defineTool）（v1.30：cc_git → container_git）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../../kernel/ccc-roots.js'
import { runGit, GIT_ACTIONS } from './service.js'

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const gitTool = defineTool({
  name: 'container_git',
  description:
    'CCC git operations (cc-git semantics, aligned with osp). status/commit/push/log/pull/diff. ' +
    'commit pushes right after committing by default (pass noPush to skip); commit with paths ⇒ only those paths ' +
    '(omitting paths = whole-repo `add -A`, and the receipt says so explicitly). ' +
    'push success criterion = the ref line of `--porcelain` (a timeout or an unconfirmed result is NEVER reported as success; ' +
    'the receipt hands you a `git ls-remote` verification command). A non-fast-forward push/pull prints [REJECTED] plus advice ' +
    '(never auto-force). merge/rebase/conflict resolution go through bash.',
  parameters: {
    action: { type: 'string', enum: [...GIT_ACTIONS], required: true, description: 'Subcommand: status/commit/push/log/pull/diff' },
    message: { type: 'string', description: 'Commit message (required for commit)' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'commit: submit only these paths (e.g. ["docs/a.md","src/b.ts"]). Omitting it = whole-repo `git add -A`, which also ' +
        'sweeps up other trajectories\' in-flight files — the receipt warns about this explicitly',
    },
    noPush: { type: 'boolean', description: 'commit: commit locally only, without pushing afterwards (default: push automatically)' },
    // 注意：公测 rc.6 value schema DSL 不支持 minimum/maximum 数字边界键（defineTool 阶段会拒绝）。
    // 边界校验（1-100）在 tools/git/service.ts 运行时 clamp 执行。
    count: { type: 'integer', description: 'Log count (default 10, max 100; runtime clamp 1-100)' },
    staged: { type: 'boolean', description: 'diff: show staged changes (--cached)' },
    ref: { type: 'string', description: 'diff: compare ref (e.g. HEAD~1 / main / origin/main)' },
    path: { type: 'string', description: 'diff: restrict to path (e.g. src/, package.json)' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = cccRootForExec(exec)
    if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
    return runGit(root, args)
  },
})
