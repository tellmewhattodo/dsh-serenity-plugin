/**
 * jobs.test.ts — `jobs.ts` 的配对测试（DC-M1）
 *
 * 挑靶原则：**每条用例都要能"故意弄坏实现 ⇒ 变红"**（变异检验）。
 * 只断言"函数被调用了""没报错"的用例在这里不算数。
 */

import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  jobsDir, readJob, writeJob, listJobs, pruneJobs, makeJobId, localIso,
  decidePoll, formatJob, STALE_RUNNING_MS,
  type JobRecord,
} from './jobs.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobs-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function rec(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: 'test',
    what: '单测用',
    startedAt: localIso(),
    deadlineAt: localIso(new Date(Date.now() + 60_000)),
    state: 'running',
    readings: [],
    conclusion: null,
    runnerPid: null,
    params: {},
    ...over,
  }
}

// ── J1 落盘与回读 ──

test('J1 写入后能逐字回读（字段不丢）', () => {
  const r = rec('j1', { state: 'ok', conclusion: '成立', runnerPid: 4321 })
  writeJob(root, r)
  const back = readJob(root, 'j1')
  expect(back).not.toBeNull()
  expect(back!.id).toBe('j1')
  expect(back!.state).toBe('ok')
  expect(back!.conclusion).toBe('成立')
  expect(back!.runnerPid).toBe(4321)
  // 落点契约：必须在 _tmp/jobs 下（否则会被提交进 git）
  expect(existsSync(join(jobsDir(root), 'j1.json'))).toBe(true)
})

// ── J2 读坏文件不抛（读取面不该因坏文件中断） ──

test('J2 坏 JSON ⇒ readJob 返回 null 而不是抛', () => {
  const dir = jobsDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'bad.json'), '{ 这不是 json', 'utf-8')
  expect(() => readJob(root, 'bad')).not.toThrow()
  expect(readJob(root, 'bad')).toBeNull()
})

test('J3 不存在的 job ⇒ null', () => {
  expect(readJob(root, 'nope')).toBeNull()
})

// ── J4 列表排序 ──

test('J4 listJobs 按 startedAt 倒序且遵守 limit', () => {
  writeJob(root, rec('old', { startedAt: '2026-01-01T00:00:00+08:00' }))
  writeJob(root, rec('new', { startedAt: '2026-06-01T00:00:00+08:00' }))
  writeJob(root, rec('mid', { startedAt: '2026-03-01T00:00:00+08:00' }))
  const all = listJobs(root, 10)
  expect(all.map((j) => j.id)).toEqual(['new', 'mid', 'old'])
  expect(listJobs(root, 2).map((j) => j.id)).toEqual(['new', 'mid'])
})

test('J5 空目录 ⇒ 空数组（不抛）', () => {
  expect(listJobs(root, 10)).toEqual([])
})

// ── J6 prune ──

test('J6 pruneJobs 只删过期的，且连坏文件一起清', () => {
  const old = rec('old', { startedAt: '2026-01-01T00:00:00+08:00' })
  const fresh = rec('fresh', { startedAt: localIso() })
  writeJob(root, old)
  writeJob(root, fresh)
  const dir = jobsDir(root)
  writeFileSync(join(dir, 'broken.json'), 'nope', 'utf-8')

  const n = pruneJobs(root, 7 * 24 * 3_600_000, Date.parse(localIso()))
  expect(n).toBe(2) // old + broken
  expect(readJob(root, 'old')).toBeNull()
  expect(readJob(root, 'fresh')).not.toBeNull()
})

// ── J7 id 形状 ──

test('J7 makeJobId 含 kind 与时缀，且随机段固定 4 位', () => {
  const id = makeJobId('publish', new Date(2026, 10, 15, 9, 5, 7), () => 0.5)
  expect(id).toBe('publish-20261115T090507-8000')
  // 两次不同随机 ⇒ 不同 id（防同秒碰撞）
  expect(makeJobId('x', new Date(2026, 10, 15, 9, 5, 7), () => 0.1))
    .not.toBe(makeJobId('x', new Date(2026, 10, 15, 9, 5, 7), () => 0.9))
})

// ── J8 本地 ISO 带偏移 ──

test('J8 localIso 带时区偏移，且能被 Date.parse 还原', () => {
  const s = localIso(new Date(2026, 10, 15, 9, 5, 7))
  expect(s).toMatch(/^2026-11-15T09:05:07[+-]\d{2}:\d{2}$/)
  expect(Number.isNaN(Date.parse(s))).toBe(false)
})

// ── J9~J11 decidePoll 的三条停法必须分开 ──

test('J9 成立 ⇒ ok', () => {
  const d = decidePoll({ satisfied: true, nowMs: 100, deadlineMs: 200 })
  expect(d).toEqual({ keepGoing: false, state: 'ok', conclusion: '成立' })
})

test('J10 到点未成立 ⇒ timeout（⛔ 不是 failed）', () => {
  const d = decidePoll({ satisfied: false, nowMs: 200, deadlineMs: 200 })
  expect(d.keepGoing).toBe(false)
  expect(d.state).toBe('timeout')
  expect(d.conclusion).toContain('不是')
})

test('J11 未到点未成立 ⇒ 继续；硬失败 ⇒ failed 优先', () => {
  expect(decidePoll({ satisfied: false, nowMs: 100, deadlineMs: 200 }).keepGoing).toBe(true)
  const hard = decidePoll({ satisfied: true, nowMs: 100, deadlineMs: 200, hardFailure: 'npm 报错' })
  expect(hard).toEqual({ keepGoing: false, state: 'failed', conclusion: 'npm 报错' })
})

// ── J12 陈旧 running 必须显著标记 ──

test('J12 running 超过陈旧阈值 ⇒ 渲染里出现"可能已死"', () => {
  const started = new Date(Date.now() - STALE_RUNNING_MS - 60_000)
  const r = rec('stale', { startedAt: localIso(started) })
  const text = formatJob(r).join('\n')
  expect(text).toContain('可能已死')

  // 正控：刚起的 job **不得**出现该提示（否则这条标记等于恒真）
  const fresh = rec('fresh', { startedAt: localIso() })
  expect(formatJob(fresh).join('\n')).not.toContain('可能已死')
})

// ── J13 每条读数带时刻，且最新在上 ──

test('J13 读数渲染带时刻、倒序', () => {
  const r = rec('r', {
    readings: [
      { at: '2026-11-15T09:00:00+08:00', values: { record: '404' } },
      { at: '2026-11-15T09:03:00+08:00', values: { record: '200' } },
    ],
  })
  const lines = formatJob(r)
  const i200 = lines.findIndex((l) => l.includes('record=200'))
  const i404 = lines.findIndex((l) => l.includes('record=404'))
  expect(i200).toBeGreaterThan(-1)
  expect(i200).toBeLessThan(i404) // 新的在前
  expect(lines[i200]).toContain('2026-11-15T09:03:00+08:00')
})

// ── J14 原子写：并发读不到半份 ──

test('J14 写入过程不留下 .tmp 残留（原子替换）', () => {
  writeJob(root, rec('a1'))
  writeJob(root, rec('a1', { state: 'ok' }))
  const leftovers = readdirSync(jobsDir(root)).filter((n) => n.includes('.tmp-'))
  expect(leftovers).toEqual([])
  expect(readJob(root, 'a1')!.state).toBe('ok')
})
