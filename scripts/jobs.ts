/**
 * jobs.ts — 后台续验子系统（开发 MSM 的非阻塞底座）
 *
 * ## 为什么需要它（R↓：这个文件存在的原因，不是"顺手抽象"）
 *
 * 开发 MSM 跑在**一个必须返回的工具调用**里。任何"等"都会把整个调用挂住：
 *   · `verifyPublished` 的 `for(;;)` ＋ 无超时 `curl` ⇒ **最坏无限**
 *   · `npm-install` 的 6×60 s 传播重试      ⇒ 360 s
 *   · `restart-web` 的 `sleep 18`            ⇒ 18 s
 *
 * 🔴 **改 `async/await` 解决不了**：`await` 一样等，返回值照样不回来 ——
 * 那只是把"`spawnSync` 阻塞"换成"`await` 阻塞"。真正能解阻塞的只有一件事：
 * **把"等"交给一个脱离的进程，调用方立刻拿到句柄。**
 *
 * 🔴 **为什么不靠"让 agent 隔几分钟再跑一次命令"**（判据 #105 的形态）：
 * 那要求模型**记住**一个时刻 —— 而「定时刻的事件靠提示词」= 恒不可达。
 * ⇒ 必须有一个**脱离的进程**替我们到点去看，并把结论**落到文件**。
 *
 * ## 数据契约
 *
 * 落盘 = `<repo>/_tmp/jobs/<jobId>.json`（`_tmp/` 已 gitignore ⇒ 不入库）。
 * **写者只有后台进程**；前端只读 —— 两个写者一定漂。
 *
 * ⚠️ **这不是第二真相源**：它只记「某个后台进程到点看到了什么」，
 * 不重复 registry 的真相。但它确实会**过期** ⇒ 每条读数都必须带时刻，
 * 读取时必须显著标记陈旧（见 `formatJob`）。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, openSync, closeSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// ── 类型 ──

export type JobState = 'running' | 'ok' | 'failed' | 'timeout'

export interface JobReading {
  /** ISO8601 本地时刻 —— **必须带**，否则"读数"与"现状"分不开 */
  at: string
  /** 该次读到的键值对（形状由各类 job 自定） */
  values: Record<string, string>
}

export interface JobRecord {
  id: string
  /** job 种类：`publish-landing` / `npm-install` / …（决定怎么解读 readings） */
  kind: string
  /** 人类可读的一句话：这个 job 在等什么 */
  what: string
  startedAt: string
  /** 到点必自杀（ISO） —— 防孤儿进程 */
  deadlineAt: string
  state: JobState
  readings: JobReading[]
  /** 终局结论（state ≠ running 时必有） */
  conclusion: string | null
  /** 后台进程自己的 pid（只用于诊断；⛔ 不当存活判据） */
  runnerPid: number | null
  /**
   * 该 job 的**参数**（如 `publish-landing` 的 `version`）。
   *
   * 🔴 为什么存进记录而不是只靠环境变量（2026-11-15 真机踩到）：
   *   第一版把目标版本只经 `SERENITY_JOB_TARGET` 传 ⇒
   *   ① 脱离 `spawnRunner` 手工跑 `__job-run` 时**必然失败**（"缺少 SERENITY_JOB_TARGET"）
   *   ② job 文件**不自描述**：三天后看一份 job，看不出它在等哪个版本
   *   ⇒ 参数属于 job 的**身份**，必须落盘。环境变量降级为"可覆盖"。
   */
  params: Record<string, string>
}

// ── 路径 ──

/** job 目录。`repoRoot` 传入而非从本文件推导 ⇒ 单测可以指到临时目录。 */
export function jobsDir(repoRoot: string): string {
  return join(repoRoot, '_tmp', 'jobs')
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** 只读一个 job；缺失/坏 JSON 一律返回 null（⛔ 不抛，读取面不该因坏文件中断）。 */
export function readJob(repoRoot: string, id: string): JobRecord | null {
  const p = join(jobsDir(repoRoot), `${id}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as JobRecord
  } catch {
    return null
  }
}

/** 原子写：`writeFileSync` 到临时名再 `renameSync` —— 读侧永远看不到半份 JSON。 */
export function writeJob(repoRoot: string, rec: JobRecord): void {
  const dir = jobsDir(repoRoot)
  ensureDir(dir)
  const dst = join(dir, `${rec.id}.json`)
  const tmp = `${dst}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8')
  // rename 同目录内是原子的（跨设备才不原子；这里必然同目录）
  renameSync(tmp, dst)
}

/** 列出 job，按 startedAt 倒序（缺文件的跳过）。 */
export function listJobs(repoRoot: string, limit = 10): JobRecord[] {
  const dir = jobsDir(repoRoot)
  if (!existsSync(dir)) return []
  const out: JobRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const rec = readJob(repoRoot, name.slice(0, -'.json'.length))
    if (rec !== null) out.push(rec)
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  return out.slice(0, limit)
}

/** 删掉 `olderThanMs` 之前的 job 文件，返回删除数。 */
export function pruneJobs(repoRoot: string, olderThanMs = 7 * 24 * 3_600_000, nowMs = Date.now()): number {
  const dir = jobsDir(repoRoot)
  if (!existsSync(dir)) return 0
  let n = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const p = join(dir, name)
    try {
      const rec = JSON.parse(readFileSync(p, 'utf-8')) as JobRecord
      if (Date.parse(rec.startedAt) + olderThanMs < nowMs) {
        rmSync(p, { force: true })
        n++
      }
    } catch {
      // 坏文件同样按"过期"处理：它已经不可能被正确读取
      rmSync(p, { force: true })
      n++
    }
  }
  return n
}

// ── id ──

/** `<kind>-<本地时刻 YYYYMMDDTHHmmss>-<4 位随机>` —— 时刻给出先后序，随机防同秒碰撞。 */
export function makeJobId(kind: string, now = new Date(), rand = Math.random): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
  return `${kind}-${stamp}-${suffix}`
}

/** ISO8601 **带本地偏移**（`at` 字段用它 ⇒ 跨时区读得懂）。 */
export function localIso(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const off = -now.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// ── 脱离执行 ──

export interface SpawnRunnerOptions {
  repoRoot: string
  /** 要跑的脚本绝对路径（= dsp-develop.ts） */
  scriptPath: string
  /** 传给它这个 job 的 id */
  jobId: string
  /** 日志路径；缺省 `<repo>/_tmp/jobs/<id>.log` */
  logPath?: string
  /** 解释器；缺省 `process.execPath`（⛔ 不用裸 `bun`/`node` —— PATH 里可能没有） */
  execPath?: string
  /** 额外环境变量 */
  env?: Record<string, string>
  /** 追加到命令行的额外参数（`__job-run <jobId> <extra...>`）—— 单测用来给假 runner 递参数 */
  extraArgs?: string[]
}

/**
 * 起一个**脱离**的后台进程跑 `__job-run <id>`，返回它的 pid。
 *
 * 三个 flag 缺一不可（每一个都有它的失败形态）：
 *   · `detached: true` ⇒ 新进程组，**父进程被信号/被重启时不会连带打死它**
 *   · `unref()`        ⇒ 父进程**不等**它（否则 `spawn` 仍会吊住事件循环）
 *   · `stdio: 'ignore'`／重定向到文件 ⇒ 不持有父的管道（持有就会在父退出时被 SIGPIPE）
 *
 * 🔴🔴 **变异实测的诚实登记（2026-11-15，别信"三个都缺一不可"这句话的字面意思）**：
 *   我逐个拿掉它们，**测试都没红**：
 *     · 拿掉 `detached` ⇒ 仍绿（父进程照样立刻返回 —— 真正让它"不等"的是 stdio 重定向）
 *     · 拿掉 `unref`    ⇒ 仍绿（**stdio 全部指向文件时，子进程不持有管道 ⇒ 本就不吊事件循环**）
 *   ⇒ 正确表述：**"父进程不等子进程"这件事的主因是 stdio 重定向**；`detached` 管的是
 *     **另一件事**（进程组独立 ⇒ 父被杀时不连带），而 `unref` 与 stdio 重定向**功能重叠**。
 *   ⚠️ 这条为什么必须写下来：留着"缺一不可"会让下一个我**以为已有测试守着**，
 *     而实际上那两条**没有任何判据覆盖**（判据纪律：`「调用没报错」一律降级为「未验证」`）。
 *   ⇒ `detached` 的真实价值（父被杀时不连带子进程）**当前无自动判据**，只有它的
 *     **存在**被 `jobs-spawn.test.ts` S1 的"父退出后子仍写完"间接覆盖。
 *
 * ⚠️ **回执不是送达证明**：pid 只说明"起来了"，不说明它跑到了。
 * 判「它真跑了」= job 文件里出现 `runnerPid`（只有后台进程自己会写这一格）。
 */
export function spawnRunner(opts: SpawnRunnerOptions): { pid: number | null; logPath: string } {
  const dir = jobsDir(opts.repoRoot)
  ensureDir(dir)
  const logPath = opts.logPath ?? join(dir, `${opts.jobId}.log`)
  const fd = openSync(logPath, 'a')
  try {
    const child = spawn(
      opts.execPath ?? process.execPath,
      ['--experimental-strip-types', opts.scriptPath, '__job-run', opts.jobId, ...(opts.extraArgs ?? [])],
      {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: opts.repoRoot,
        env: { ...process.env, ...(opts.env ?? {}) },
      },
    )
    child.unref()
    return { pid: child.pid ?? null, logPath }
  } finally {
    closeSync(fd)
  }
}

// ── 呈现 ──

/** 陈旧阈值：超过这个时长的 `running` job 大概率已经死了（进程被杀/机器重启）。 */
export const STALE_RUNNING_MS = 10 * 60_000

/**
 * 把一条 job 渲染成人读的几行。
 *
 * 🔴 两处**必须显著**：
 *   ① `running` 且 `startedAt` 距今 > `STALE_RUNNING_MS` ⇒ 标「可能已死」。
 *      因为**进程死了不会报错**，job 文件会永远停在 `running` —— 那是静默失效。
 *   ② 每条读数都带时刻 ⇒ 读者能自己判断"这条是当时的还是现在的"。
 */
export function formatJob(rec: JobRecord, nowMs = Date.now()): string[] {
  const out: string[] = []
  out.push(`job ${rec.id}`)
  out.push(`  种类      ${rec.kind} —— ${rec.what}`)
  out.push(`  状态      ${rec.state}${rec.state === 'running' ? runningHint(rec, nowMs) : ''}`)
  out.push(`  起始      ${rec.startedAt}`)
  out.push(`  截止      ${rec.deadlineAt}`)
  if (rec.runnerPid !== null) out.push(`  后台 pid  ${rec.runnerPid}（⛔ 不是存活判据）`)
  if (rec.readings.length > 0) {
    out.push(`  读数      ${rec.readings.length} 次（最新在上）`)
    for (const r of [...rec.readings].reverse().slice(0, 5)) {
      const kv = Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(' ／ ')
      out.push(`            ${r.at}  ${kv}`)
    }
  } else {
    out.push('  读数      尚无')
  }
  if (rec.conclusion !== null) out.push(`  结论      ${rec.conclusion}`)
  return out
}

function runningHint(rec: JobRecord, nowMs: number): string {
  const age = nowMs - Date.parse(rec.startedAt)
  if (age > STALE_RUNNING_MS) {
    return `  ⚠️ 已运行 ${Math.round(age / 60_000)} 分钟仍 running —— **可能已死**（进程死了不报错）。`
      + ' 复核：看 `_tmp/jobs/<id>.log`；确认死掉就重跑原命令。'
  }
  return `  已运行 ${Math.round(age / 1000)} s`
}

// ── 纯判定（可单测，不碰文件系统）──

export interface PollDecision {
  /** 是否继续轮询 */
  keepGoing: boolean
  /** 终局状态；`keepGoing` 为真时忽略 */
  state: JobState
  /** 终局结论；`keepGoing` 为真时为 null */
  conclusion: string | null
}

/**
 * 决定一次轮询之后该停还是该继续。
 *
 * 🔴 三条停法**必须分开**（这是本函数全部的判别力）：
 *   · 成立     ⇒ `ok`
 *   · 到点未成立 ⇒ `timeout`（**不是 failed** —— "还没传播到"与"失败了"是两件事）
 *   · 被外部判失败 ⇒ `failed`（调用方显式传入）
 *
 * ⚠️ 若把 `timeout` 也叫 `failed`，读者会去重跑一次可能已成功的动作（publish 复跑只会 409）。
 */
export function decidePoll(input: {
  satisfied: boolean
  nowMs: number
  deadlineMs: number
  /** 调用方判定出的硬失败；给了就直接 failed */
  hardFailure?: string | null
}): PollDecision {
  if (input.hardFailure !== undefined && input.hardFailure !== null) {
    return { keepGoing: false, state: 'failed', conclusion: input.hardFailure }
  }
  if (input.satisfied) {
    return { keepGoing: false, state: 'ok', conclusion: '成立' }
  }
  if (input.nowMs >= input.deadlineMs) {
    return { keepGoing: false, state: 'timeout', conclusion: '到点仍未成立（⛔ 不是"失败"）' }
  }
  return { keepGoing: true, state: 'running', conclusion: null }
}
