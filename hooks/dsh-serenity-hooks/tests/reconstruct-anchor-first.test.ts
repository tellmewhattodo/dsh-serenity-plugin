/**
 * reconstruct-anchor-first.test.ts — **继续锚点必须"直接进"，不排队**（owner 2026-11-10 报障）
 *
 * ## 它守的是什么
 *
 * 换代（`reconstruct`）会往一条**新建出来**的载体上投两条消息：载体开场白 ＋ 继续锚点。
 * 修前两条都走 `agent.followup()` ⇒ 都落 `next-turn`，而宿主
 * `inbox.claim('next-turn', …)` **每个 turn 只认领 1 条**（`packages/core/agent/src/inbox.ts`）。
 *
 * ⇒ 真机后果（platform-9047 换代日志，逐字）：`seq 12` 是开场白落在 `next-turn`，
 *   `seq 76` 才是锚点 ⇒ **第 1 轮只拿到开场白**。而开场白正文写的就是
 *   「接着它 SESSION.md 里的工作往下做」⇒ 模型**在读到锚点之前就开始干活**，
 *   锚点留在排队区（= owner 截图里被红框圈住的那条）。
 *
 * ## 判据为什么钉"调用顺序"而不是"最终都投到了"
 *
 * "两条都在队列里"是**弱断言** —— 修前的实现同样满足它（两条都进 `next-turn`）。
 * 真正决定第 1 轮看到什么的是**消息落在哪个 inbox 目标、以及入队先后**：
 * `claim()` 的返回是 **`next-step` 全部在前、`next-turn` 取 1 条在后**。
 * ⇒ 锚点先进 `next-step`（`inject`）再投开场白（`followup`），第 1 轮第 1 步才会拿到
 *   `[锚点, 开场白]`。本文件钉的就是这个。
 *
 * ⚠️ **反面对照必须存在**：只断言"inject 被调用过"挡不住"先 followup 再 inject"的回归，
 * 所以额外断言 `inject` 的发生时刻早于 `followup`（用同一条时间线数组的序号比）。
 *
 * ## 隐私门（D145）
 * 不写真实家目录 / 私有 CCC 名；根一律用临时目录。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAndBindTarget } from '../src/wake/scheduler.js'

const DIR_NAME = '2020-01-01--S999--demo'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anchor-first-'))
  // `appendBound` 靠 `cccRootForCwd` 上溯 `.serenity` 定位 CCC 根 ⇒ 夹具必须像真 CCC
  writeFileSync(join(root, '.serenity'), 'test\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个能走通 `createAndBindTarget` 的最小 ctx，并把两次投递记进同一条时间线 */
function harness(): { ctx: unknown; timeline: string[] } {
  const timeline: string[] = []
  const agent = {
    id: 'sess-new',
    status: 'idle' as const,
    // `inject` = `send(msg,'next-step',false)`（**不唤醒**）
    inject: (m: { content: Array<{ text?: string }> }) => {
      timeline.push(`inject:${(m.content[0]?.text ?? '').slice(0, 24)}`)
    },
    // `followup` = `send(msg,'next-turn',true)`
    followup: (m: { content: Array<{ text?: string }> }) => {
      timeline.push(`followup:${(m.content[0]?.text ?? '').slice(0, 24)}`)
    },
  }
  const ctx = {
    get: (name: string) => {
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'sess-new' }),
          resolveAgent: async () => ({ agent }),
        }
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-1', path: root, sessionIds: [], attachSession: async () => {} }] }
      }
      // sessionTitle 故意缺 ⇒ 走到 `⚠️ 标题未写` 分支，不干扰本文件的判据
      return undefined
    },
  }
  return { ctx, timeline }
}

describe('reconstruct / createAndBindTarget：锚点必须"直接进"（不排队）', () => {
  it('🔴 锚点走 inject（next-step），开场白走 followup（next-turn）', async () => {
    const { ctx, timeline } = harness()
    const out = await createAndBindTarget(ctx, root, DIR_NAME, {
      takeover: true,
      beforeOpening: (a) => {
        ;(a as unknown as { inject: (m: unknown) => void }).inject({
          content: [{ type: 'text', text: 'ANCHOR-TEXT 接着 SESSION.md 往下做' }],
        })
      },
    })
    expect('error' in out).toBe(false)
    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toMatch(/^inject:/)
    expect(timeline[1]).toMatch(/^followup:/)
  })

  it('🔴 反面对照：入队顺序必须是「先 inject、后 followup」（换过来就红）', async () => {
    const { ctx, timeline } = harness()
    await createAndBindTarget(ctx, root, DIR_NAME, {
      takeover: true,
      beforeOpening: (a) => {
        ;(a as unknown as { inject: (m: unknown) => void }).inject({ content: [{ type: 'text', text: 'A' }] })
      },
    })
    const injectAt = timeline.findIndex((l) => l.startsWith('inject:'))
    const followupAt = timeline.findIndex((l) => l.startsWith('followup:'))
    expect(injectAt, 'inject 必须真的发生过').toBeGreaterThanOrEqual(0)
    expect(followupAt, '开场白必须真的投过').toBeGreaterThanOrEqual(0)
    expect(injectAt, '⛔ 锚点不得排到开场白之后').toBeLessThan(followupAt)
  })

  it('不传 beforeOpening ⇒ 行为与旧版一致（只投开场白；send-now 语义一字不变）', async () => {
    const { ctx, timeline } = harness()
    await createAndBindTarget(ctx, root, DIR_NAME)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatch(/^followup:/)
  })

  it('🔴 回调抛错不阻断建会话，且原因进回执（不静默）', async () => {
    const { ctx, timeline } = harness()
    const out = await createAndBindTarget(ctx, root, DIR_NAME, {
      takeover: true,
      beforeOpening: () => {
        throw new Error('boom-anchor')
      },
    })
    // ① 会话仍然建出来并绑上（"会话建了却没投递"比"锚点没插上"更坏）
    expect('error' in out).toBe(false)
    // ② 开场白照投
    expect(timeline.some((l) => l.startsWith('followup:'))).toBe(true)
    // ③ 失败必须出声 —— 回执里点名原因，否则"锚点没插上"与"根本没设计这一步"同形
    expect((out as { how: string }).how).toContain('锚点前置失败')
    expect((out as { how: string }).how).toContain('boom-anchor')
  })
})
