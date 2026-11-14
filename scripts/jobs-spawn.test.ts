/**
 * jobs-spawn.test.ts — 验证「脱离进程」真的脱离了（这是整个方案唯一不可被单测完全证明的一环）
 *
 * 🔴 这一条为什么必须单独验：
 *   `jobs.test.ts` 验的是**数据面**（写/读/排序/陈旧标记），它证明不了
 *   「`detached` ＋ `unref` ＋ `stdio` 重定向」这三件套**真的**让父进程不等子进程。
 *   而"父进程不等"恰恰是整个重构的全部价值 —— 若它不成立，改完还是阻塞。
 *
 * 判据（三条独立证据，缺一不可）：
 *   ① 父进程**立刻**返回（耗时远小于子进程的工作时长）
 *   ② 父进程退出后，**子进程仍然活着**并继续写 job 文件
 *   ③ job 文件里出现 `runnerPid` —— 这一格**只有子进程自己会写**（= 它真跑起来了）
 */

import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnRunner, readJob, writeJob, jobsDir, localIso, type JobRecord } from './jobs.js'

let root: string | null = null
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

/**
 * 造一个假 runner：它写活 `runnerPid`、忙等一会、再写结论。
 * 用它而不是真 `__job-run` ⇒ 本测试不依赖 registry 网络。
 *
 * argv 形状与真 runner 一致：`<script> __job-run <jobId> <sleMs>` ——
 * 所以它按 `argv[3..]` 取参数，而不是按"第一个参数"取。
 */
function makeFakeRunner(dir: string): string {
  const p = join(dir, 'fake-runner.mjs')
  const src = [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)', // [__job-run, jobId, sleepMs]
    'const jobId = args[1]',
    'const sleepMs = Number(args[2])',
    'const jobPath = process.env.FAKE_JOB_PATH',
    'const rec = JSON.parse(readFileSync(jobPath, "utf-8"))',
    'rec.runnerPid = process.pid',
    'writeFileSync(jobPath, JSON.stringify(rec))',
    'const t0 = Date.now()',
    'while (Date.now() - t0 < sleepMs) { /* 忙等：不依赖定时器精度 */ }',
    'rec.state = "ok"',
    'rec.conclusion = "子进程自己写完的"',
    'writeFileSync(jobPath, JSON.stringify(rec))',
  ].join('\n')
  writeFileSync(p, src, 'utf-8')
  return p
}

test('S1 父进程立刻返回，且子进程在父退出后仍写完 job 文件', async () => {
  root = mkdtempSync(join(tmpdir(), 'jobs-spawn-'))
  const runner = makeFakeRunner(root)
  const id = 'spawn-1'

  // 先造出 job 文件（后台进程要读它）
  const rec: JobRecord = {
    id,
    kind: 'test',
    what: 'spawn 验证',
    startedAt: localIso(),
    deadlineAt: localIso(new Date(Date.now() + 60_000)),
    state: 'running',
    readings: [],
    conclusion: null,
    runnerPid: null,
    params: {},
  }
  writeJob(root, rec)
  const jobPath = join(jobsDir(root), `${id}.json`)

  // 子进程要忙等 1.2 s —— 父进程若真脱离，应在远小于这个时间内返回
  const t0 = Date.now()
  const { pid } = spawnRunner({
    repoRoot: root,
    scriptPath: runner,
    jobId: id,
    logPath: join(root, 'runner.log'),
    extraArgs: ['1200'], // 假 runner 的忙等时长（ms）
    env: { FAKE_JOB_PATH: jobPath },
  })
  const spawnCost = Date.now() - t0

  // ① 立刻返回
  expect(pid).toBeGreaterThan(0)
  expect(spawnCost).toBeLessThan(600)

  // ② 此刻子进程还没写完（否则"脱离"这条就没有观测窗口）
  expect(readJob(root, id)!.state).toBe('running')

  // 父进程（= 本测试）此刻**不等**它 —— 我们去干别的，到点再回来看
  await new Promise((r) => setTimeout(r, 2000))

  // ③ 子进程自己写完了结论，且 runnerPid 是**它的**（不是父进程的）
  const done = readJob(root, id)!
  expect(done.state).toBe('ok')
  expect(done.conclusion).toBe('子进程自己写完的')
  expect(done.runnerPid).toBeGreaterThan(0)
  expect(done.runnerPid).not.toBe(process.pid)
})

test('S2 父进程不等：spawn 后本进程能继续同步推进（没被吊住）', () => {
  root = mkdtempSync(join(tmpdir(), 'jobs-spawn-'))
  const runner = makeFakeRunner(root)
  const rec: JobRecord = {
    id: 'spawn-2',
    kind: 'test',
    what: '不吊住',
    startedAt: localIso(),
    deadlineAt: localIso(new Date(Date.now() + 60_000)),
    state: 'running',
    readings: [],
    conclusion: null,
    runnerPid: null,
    params: {},
  }
  writeJob(root, rec)
  const jobPath = join(jobsDir(root), 'spawn-2.json')

  spawnRunner({
    repoRoot: root,
    scriptPath: runner,
    jobId: 'spawn-2',
    logPath: join(root, 'runner2.log'),
    extraArgs: ['1200'],
    env: { FAKE_JOB_PATH: jobPath },
  })

  // 若 unref 失效，下一行会等到子进程（1.2 s）结束才执行 ⇒ 本断言仍会过，
  // 但**整个 vitest 进程**会被拖到子进程结束。⇒ 真正的判据在 S1 的 2 s 窗口里。
  // 这里只钉一件事：spawn 之后本进程状态完好（没有抛、没有等到子进程的 stdout）。
  expect(typeof readJob(root, 'spawn-2')).toBe('object')
})

test('S3 job 目录在 _tmp 下（⛔ 不能落在会被提交的位置）', () => {
  root = mkdtempSync(join(tmpdir(), 'jobs-spawn-'))
  expect(jobsDir(root)).toBe(join(root, '_tmp', 'jobs'))
  mkdirSync(jobsDir(root), { recursive: true })
  expect(existsSync(jobsDir(root))).toBe(true)
})
