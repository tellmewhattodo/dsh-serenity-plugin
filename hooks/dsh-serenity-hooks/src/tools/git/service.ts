/**
 * tools/git/service.ts — container_git 纯操作层（cc_git → container_git，v1.30；零 DSH 依赖）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/git/cc-git-tool.ts）——osp 是 ACC 工具 spec：
 *   - status：JSON {clean, files:[{status,file}], summary, ahead, behind}
 *   - commit：默认「只提交指定 paths」；未给 paths ⇒ 整仓 add -A（并在回执里显式告知）
 *   - commit：**默认随后 push**（`noPush` 可关）；push 结果如实附在回执里
 *   - push：成功判据 = **`git push --porcelain` 的 stdout 里读到 ref 行**（绝不采信"stderr 为空"）
 *   - pull：git fetch + merge --ff-only；up-to-date / [REJECTED] 建议
 *   - log：--oneline [-n <count>]
 *   - diff：git diff [--cached] [<ref>] [-- <path>]
 * 保留 dsp 增强：localstore git 合规联动（S134：deny 且 .gitignore 未覆盖 → status 提示 / commit 拒绝）。
 *
 * 🔴 2026-09-26 修（由另一个 CCC 实例报障）：**push 曾把"超时被杀"报成成功**。
 *   机制（**实测**，非推断）：`spawnSync` 超时**不设 `err.killed`**（实测 `code=ETIMEDOUT` /
 *   `signal=SIGTERM` / `status=null` / `stderr` 长度 0），而 `execFileSync` **成功时丢弃 stderr**；
 *   于是"超时被杀"与"真成功"都交出 `{stdout:'', stderr:''}` —— 旧判据 `if (!stderr) → 成功`
 *   把两者判成同一件事，回显 `Pushed to origin/<branch>` 而远程 ref 从未变。
 *   ⇒ 本版三处硬修：① `git()` 交出**结构化结果**（ok/timedOut/status），守卫一律看它，不再看
 *   "stderr 是否为空"；② push 的成功判据改为**可核验事实**（`--porcelain` 的 ref 行）；
 *   ③ 超时/未确认一律**不报成功**，并给出 `git ls-remote` 核验指令。
 */

import { execFileSync } from 'node:child_process'
import { checkLocalstoreGitCompliance } from '../localstore/service.js'
import type { JsonValue } from '../../kernel/json.js'

type GitAction = 'status' | 'commit' | 'push' | 'log' | 'pull' | 'diff'

export const GIT_ACTIONS: readonly GitAction[] = ['status', 'commit', 'push', 'log', 'pull', 'diff']

interface GitArgs {
  action: GitAction
  message?: string
  /** commit：只提交这些路径（不传 ⇒ 整仓 `add -A`） */
  paths?: string[]
  /** commit：只提交到本地、不随后推送（默认提交后自动推送） */
  noPush?: boolean
  /** log 条数（对齐 osp 参数 n，默认 10，max 100） */
  count?: number
  /** diff: 显示暂存区变更（--cached） */
  staged?: boolean
  /** diff: 对比 ref（如 HEAD~1 / main / origin/main） */
  ref?: string
  /** diff: 限定路径 */
  path?: string
}

/** 本地动作超时（ms） */
const DEFAULT_LOCAL_TIMEOUT_MS = 30_000
/** 网络动作（fetch/push/pull）超时（ms）——大体量推送可能远超 30s（实测某实例 >60s） */
const DEFAULT_NET_TIMEOUT_MS = 180_000

/**
 * 超时可覆盖（`DSH_localTimeout()` / `DSH_netTimeout()`）。
 * 🔵 两个用途：① 慢远端／大体量推送的用户可自行放宽 ② 测试可在**不真等 180s** 的前提下
 *    驱动"超时"这条路径（本仓对它的回归测试就靠这个缝）。
 * ⚠️ **每次调用现读**（不在模块加载时固化）——否则测试改了 env 也影响不到已加载的模块。
 */
function timeoutMs(envName: string, dflt: number): number {
  const v = Number(process.env[envName] ?? '')
  return Number.isFinite(v) && v > 0 ? v : dflt
}
const localTimeout = (): number => timeoutMs('DSH_GIT_TIMEOUT_MS', DEFAULT_LOCAL_TIMEOUT_MS)
const netTimeout = (): number => timeoutMs('DSH_GIT_NET_TIMEOUT_MS', DEFAULT_NET_TIMEOUT_MS)

interface GitResult {
  /** 进程正常退出（exit 0） */
  ok: boolean
  stdout: string
  /** 🔴 只在**失败**时有值（`execFileSync` 成功时不回传 stderr —— 这正是旧 bug 的一半成因） */
  stderr: string
  /** 超时被杀（判据见下方注释：**不能用 `err.killed`**） */
  timedOut: boolean
  /** 退出码（超时/未启动时为 null） */
  status: number | null
}

/**
 * 执行 git 并交出**结构化结果**。
 * 🔴 超时判据必须用 `code==='ETIMEDOUT' || signal!=null && status==null`——
 *    `spawnSync` 超时**不设 `err.killed`**（2026-09-26 实测；旧守卫 `err.killed ? … : err.stderr`
 *    因此是死代码，超时被当成"stderr 为空 = 成功"）。
 */
function git(root: string, args: string[], timeoutMs: number = localTimeout()): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    })
    return { ok: true, stdout: String(stdout).trimEnd(), stderr: '', timedOut: false, status: 0 }
  } catch (err: any) {
    const timedOut =
      err?.killed === true || err?.code === 'ETIMEDOUT' || (err?.signal != null && err?.status == null)
    return {
      ok: false,
      stdout: (err?.stdout?.toString() ?? '').trimEnd(),
      stderr: (err?.stderr?.toString() ?? '').trimEnd(),
      timedOut,
      status: typeof err?.status === 'number' ? err.status : null,
    }
  }
}

function getCurrentBranch(root: string): string {
  const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!r.ok || !r.stdout) throw new Error('container_git: cannot determine current branch')
  return r.stdout
}

function hasChanges(root: string): boolean {
  return git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain']).stdout.length > 0
}

function hasRemote(root: string): boolean {
  return git(root, ['remote']).stdout.length > 0
}

/** 推送成功与否的**唯一**核验指令（给使用者，也写进回执） */
function verifyHint(branch: string): string {
  return `🔴 Verification (the only honest check): git ls-remote origin ${branch}, or git fetch && git rev-parse origin/${branch} — compare against local HEAD. **Do not trust any receipt.**`
}

const REJECTED_TEXT = (branch: string): string =>
  `[REJECTED] Push to origin/${branch} was rejected (non-fast-forward).\n\nRemote has new commits and your local branch is behind. Suggested actions:\n  1. Use bash: git fetch origin ${branch}\n  2. Inspect remote changes: git log HEAD..origin/${branch}\n  3. Merge or rebase: git merge origin/${branch} or git rebase origin/${branch}\n  4. Resolve conflicts manually if any: git add ... && git commit\n  5. Push again: container_git push`

/**
 * 推送并把结果**如实**翻成文本（`hard` = 作为独立动作时应抛错）。
 * 🔴 成功判据 = `--porcelain` 的 **stdout 里有 ref 行**；退出码 0 但读不到 ref 行 ⇒ **不视为成功**。
 */
function pushCore(root: string): { text: string; hard: boolean } {
  if (!hasRemote(root)) {
    return {
      text: '⚠️ 未配置 remote ⇒ **未推送**（本地提交不受影响）。加 remote: git remote add origin <url>',
      hard: true,
    }
  }
  const branch = getCurrentBranch(root)
  // fetch 非致命（保持原行为）：仅为让 origin/<branch> 尽量新
  git(root, ['fetch', 'origin', branch], netTimeout())

  const r = git(root, ['push', '--porcelain', 'origin', branch], netTimeout())

  if (r.timedOut) {
    return {
      text: `[TIMEOUT] git push 在 ${netTimeout() / 1000}s 内未结束 —— 🔴 **推送是否成功【未确认】**（既未成功也未失败）。\n原始输出: ${r.stdout || '(空)'}\n${r.stderr ? `stderr: ${r.stderr}\n` : ''}${verifyHint(branch)}`,
      hard: true,
    }
  }

  // `--porcelain` 的 ref 行形如 `<flag>\t<from>:<to>\t<summary>`；flag: '=' 最新 / '*' 新建 / '+' 强推 / '!' 被拒
  const refLines = r.stdout.split('\n').filter((l) => /^[ =*+!-]\t/.test(l))
  if (refLines.some((l) => l.startsWith('!'))) {
    return { text: REJECTED_TEXT(branch), hard: false }
  }
  const updated = refLines.filter((l) => /^[ *+-]/.test(l))
  // 🔴 flag 语义（git-push --porcelain 文档）：` `=成功快进 ／ `+`=强推 ／ `*`=新建 ／ `-`=删除 ／ `=`=已最新 ／ `!`=被拒。
  //    ⚠️ **正常快进用的是【空格】flag** —— 首版只认 `*`/`+`，把真成功的推送报成"已是最新"
  //    （**假阴性**，与原 bug 同族）⇒ 被 `tests/git-ops-remote.test.ts` 当场打回，据此更正。
  const upToDate = refLines.length > 0 && refLines.every((l) => l.startsWith('='))
  if (updated.length > 0 && !upToDate) {
    // 回显 before..after 的 SHA 变迁 = 可核验事实（对齐 git push 原生输出）
    return { text: `✅ 已推送 origin/${branch}\n${updated.join('\n')}`, hard: false }
  }
  if (upToDate) {
    return { text: `origin/${branch} 已是最新（无可推送的新提交）\n${refLines.join('\n')}`, hard: false }
  }
  if (!r.ok) {
    return {
      text: `[FAILED] git push 退出码 ${r.status ?? '未知'} —— **未推送**\n${r.stderr || r.stdout || '(无输出)'}\n${verifyHint(branch)}`,
      hard: true,
    }
  }
  return {
    text: `[UNVERIFIED] git push 退出码 0，但**未从 --porcelain 读到 ref 行** ⇒ 🔴 **不视为成功**。\n原始输出: ${r.stdout || '(空)'}\n${verifyHint(branch)}`,
    hard: true,
  }
}

export function runGit(root: string, args: GitArgs): JsonValue {
  switch (args.action) {
    case 'status': {
      // -c core.quotepath=false：中文/空格路径按原文输出
      const r = git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
      if (r.timedOut) throw new Error(`status timed out (${localTimeout() / 1000}s)`)
      if (!r.ok) throw new Error(`status failed: ${r.stderr || r.stdout || '(no output)'}`)
      const lines = r.stdout ? r.stdout.split('\n') : []
      const files = lines.map((line) => {
        const status = line.slice(0, 2).trim() || '??'
        const file = line.slice(3)
        return { status, file }
      })
      const out: Record<string, unknown> = {
        clean: files.length === 0,
        files,
        summary: files.length === 0 ? '(clean)' : `${files.length} file(s) with changes`,
      }
      // 🆕 本地领先/落后 origin（只读本地 remote-tracking ref；要它新 ⇒ 先 fetch）
      if (hasRemote(root)) {
        try {
          const branch = getCurrentBranch(root)
          const rr = git(root, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])
          if (rr.ok && /^\d+\s+\d+$/.test(rr.stdout)) {
            const [behind, ahead] = rr.stdout.split(/\s+/).map(Number) as [number, number]
            out.ahead = ahead
            out.behind = behind
            if (ahead > 0) {
              out.summary = `${out.summary} ｜ 🔴 本地领先 origin/${branch} **${ahead} 笔未推送**`
            }
          }
        } catch {
          // 取不到 ahead/behind 不阻断 status（可能是 detached HEAD / 无 upstream）
        }
      }
      // localstore git 联动（S134）：deny 且 .gitignore 未覆盖 → status 输出提示（不阻断）
      const ls = checkLocalstoreGitCompliance(root)
      if (!ls.ok) out.warning = ls.reason
      return out as JsonValue
    }
    case 'commit': {
      // localstore git 联动（S134 第二道防线）：文件存在 && deny && .gitignore 未覆盖 → 拒绝 commit
      const ls = checkLocalstoreGitCompliance(root)
      if (!ls.ok) throw new Error(ls.reason)
      if (!args.message || args.message.trim() === '') {
        throw new Error('container_git commit: missing required arg "message"')
      }
      const paths = (args.paths ?? []).map((p) => p.trim()).filter((p) => p !== '')
      const scoped = paths.length > 0

      if (!scoped && !hasChanges(root)) return '(nothing to commit — working tree clean)'

      // 1) 暂存：给了 paths ⇒ 只暂存这些路径；未给 ⇒ 保持原行为（整仓）
      //
      // 🔴 **2026-10-20（S222 实测报告，owner 转 S142 处置）：归档移动提交不了。**
      //
      // 现场：17 条轨迹 `mv` 进 `_archived/` 之后，按路径提交报
      //   `fatal: 路径规格 '…' 未匹配任何文件`（exit 128）。
      //
      // 真因（本轮用 `--dry-run` 逐形态实测，不是推断）：
      //   · `git add -- <已跟踪的、文件已消失的路径>` ⇒ **能**匹配，输出「删除 '…'」（正常）
      //   · `git add -- <源目录已不存在、且从未被跟踪的路径>` ⇒ **`fatal` exit 128**
      //   · 整条命令**整体失败** ⇒ 同批里那些本来能匹配的删除也**一条都没暂存**
      //     ⇒ 这才是"归档 + 按路径提交不通"的真实形状：**一条坏路径毒死整批**。
      //
      // 修法：改用 `git add -A -- <paths>`。
      //   `-A` 的语义 = 这些 pathspec 下**增/删/改全收**，因此：
      //   ① 源目录消失的删除仍被收下（这正是归档要提交的那一半）；
      //   ② 对"根本不存在"的 pathspec，`-A` 不再 exit 128（`--dry-run` 实测：空输出、exit 0）。
      //   ⚠️ **风险边界**：`-A` 只作用于**给定的 pathspec**，不会扩大成整仓
      //   （那正是 `add -A`（无 pathspec）才有的行为，本函数未传 paths 时仍走那条老路）。
      const addR = git(root, scoped ? ['add', '-A', '--', ...paths] : ['add', '-A'])
      if (addR.timedOut) throw new Error(`container_git commit: git add timed out (${localTimeout() / 1000}s)`)
      if (!addR.ok) throw new Error(`container_git commit: git add failed\n${addR.stderr || addR.stdout}`)

      // 2) 提交（同样按 paths 限定）
      const commitR = git(
        root,
        scoped ? ['commit', '-m', args.message, '--', ...paths] : ['commit', '-m', args.message],
      )
      if (commitR.timedOut) throw new Error(`container_git commit: git commit timed out (${localTimeout() / 1000}s)`)
      const combined = `${commitR.stdout}\n${commitR.stderr}`
      if (combined.includes('nothing to commit')) return '(nothing to commit — working tree clean)'
      if (!commitR.ok) {
        throw new Error(`container_git commit: git commit failed\n${commitR.stderr || commitR.stdout}`)
      }

      const lines: string[] = [(commitR.stdout || commitR.stderr || 'committed').trimEnd()]
      if (!scoped) {
        lines.push(
          'ℹ️ 本次是**整仓**提交（未传 `paths`）—— 包含工作树里**所有**改动，可能含其它轨迹的在途文件。要只提交指定路径 ⇒ 传 `paths`。',
        )
      }
      // 3) 🆕 默认随后推送（`noPush` 可关）—— 提交与持久化不再分家
      if (args.noPush) {
        lines.push('⚠️ 按 `noPush` 只提交到**本地** —— 尚未推送到 origin。推送：container_git push')
        return lines.join('\n')
      }
      const p = pushCore(root)
      lines.push(p.hard ? `🔴 **已本地提交，但未推送** ——\n${p.text}` : p.text)
      return lines.join('\n')
    }
    case 'push': {
      const p = pushCore(root)
      if (p.hard) throw new Error(p.text)
      return p.text
    }
    case 'pull': {
      if (!hasRemote(root)) {
        throw new Error(
          'container_git pull: no remote configured. Add one with:\n  git remote add origin <url>',
        )
      }
      const branch = getCurrentBranch(root)
      const fetchResult = git(root, ['fetch', 'origin', branch], netTimeout())
      if (fetchResult.timedOut) {
        return `[TIMEOUT] git fetch did not finish within ${netTimeout() / 1000}s — **whether it fetched is UNCONFIRMED**; no merge performed.`
      }
      if (!fetchResult.ok) return `[WARN] fetch failed:\n${fetchResult.stderr || fetchResult.stdout}`
      const revResult = git(root, ['rev-list', '--count', 'HEAD..FETCH_HEAD'])
      if (!revResult.ok) return `[WARN] cannot check ahead count:\n${revResult.stderr || revResult.stdout}`
      if (revResult.stdout === '0' || revResult.stdout === '') return 'Already up to date.'
      const mergeResult = git(root, ['merge', '--ff-only', 'FETCH_HEAD'])
      if (mergeResult.timedOut) {
        return `[TIMEOUT] git merge did not finish within ${localTimeout() / 1000}s — **whether the merge completed is UNCONFIRMED**.`
      }
      if (mergeResult.ok) {
        const msg = mergeResult.stdout || 'Pulled successfully.'
        return msg.endsWith('\n') ? msg.trimEnd() : msg
      }
      const mErr = `${mergeResult.stderr}\n${mergeResult.stdout}`
      if (
        mErr.includes('non-fast-forward') ||
        mErr.includes('Not possible to fast-forward') ||
        mErr.includes('rejected') ||
        mErr.includes('could not be applied')
      ) {
        return `[REJECTED] Pull from origin/${branch} was rejected (non-fast-forward).\n\nRemote has new commits and your local history diverged from remote (non-fast-forward). Suggested actions:\n  1. Inspect differences: container_git log HEAD..origin/${branch}\n  2. Merge manually with bash: git merge origin/${branch}\n  3. Or rebase: git rebase origin/${branch}\n  4. Resolve conflicts manually if any: git add <file> && git commit\n  5. Push: container_git push`
      }
      throw new Error(`container_git pull failed:\n${mergeResult.stderr || mergeResult.stdout}`)
    }
    case 'log': {
      // 对齐 osp：-n 默认 10，max 100（运行时兜底 + schema minimum/maximum 双保险）
      const n = Math.min(Math.max(args.count ?? 10, 1), 100)
      const r = git(root, ['-c', 'core.quotepath=false', 'log', '--oneline', '-n', String(n)])
      if (r.timedOut) throw new Error(`git log timed out (${localTimeout() / 1000}s)`)
      if (!r.ok) throw new Error(`git log failed: ${r.stderr || r.stdout || '(no output)'}`)
      if (!r.stdout) return '(no commits)'
      return r.stdout
    }
    case 'diff': {
      const diffArgs: string[] = ['diff']
      if (args.staged) diffArgs.push('--cached')
      if (args.ref) diffArgs.push(args.ref)
      if (args.path) diffArgs.push('--', args.path)
      const r = git(root, diffArgs)
      if (r.timedOut) throw new Error(`git diff timed out (${localTimeout() / 1000}s)`)
      if (!r.ok) return `[WARN] git diff failed:\n${r.stderr || r.stdout || '(no output)'}`
      if (!r.stdout) return '(no diff)'
      return r.stdout
    }
    default:
      throw new Error(`Unknown action: ${args.action as string}`)
  }
}
