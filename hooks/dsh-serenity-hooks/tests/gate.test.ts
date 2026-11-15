import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { registerKeeper, rebuildReminderStateSnapshot } from '../src/seams/keeper.js'
import { __setSimpleSourceForTest } from '../src/surface/settings.js'

type PostExecuteListener = (
  exec: unknown,
  result: unknown,
  next: () => Promise<{ kind: string; additionalContexts?: unknown[] }>,
) => Promise<unknown>

function captureListener(): PostExecuteListener {
  let captured: PostExecuteListener = async () => undefined
  const ctx = {
    on: (event: string, listener: PostExecuteListener) => {
      if (event === 'tools/post-execute') captured = listener
      return () => {}
    },
  } as any
  registerKeeper(ctx, { defaultThreshold: 2 })
  return captured
}

function fakeExec(cwd: string, name = 'write') {
  return { name, agent: { session: { header: { cwd } } } }
}

const accept = () => Promise.resolve({ kind: 'accept' })

describe('keeper: 激活门控（只在 .serenity 存在的目录生效）', () => {
  it('非 CCC 目录：不计分、不提醒，原样放行', async () => {
    const listener = captureListener()
    const downstream = await listener(fakeExec('/tmp/non-ccc'), {}, accept)
    // 阈值 2，write=3 本应触发；但非 CCC → 直接放行且无提醒
    expect(downstream).toEqual({ kind: 'accept' })
  })

  it('CCC 目录：达阈值注入 [COGNITIVE-TRAJECTORY-ASSISTANT · CHECKPOINT] 提醒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-gate-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    try {
      const listener = captureListener()
      const downstream = (await listener(
        fakeExec(dir),
        {},
        () => Promise.resolve({ kind: 'accept', additionalContexts: [] }),
      )) as { kind: string; additionalContexts: { content: { text: string }[] }[] }
      expect(downstream.kind).toBe('accept')
      const texts = (downstream.additionalContexts ?? [])
        .map((c) => c.content?.map((b) => b.text).join(''))
        .join('\n')
      expect(texts).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT-recorded-K1]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('v1.23.3 重建提醒：不做节流（每轮都催）+ 连续 3 轮升级强制语气（用户拍板）', () => {
  afterEach(() => {
    // 重置注入的简单配置源（防跨用例污染）
    __setSimpleSourceForTest(null)
  })

  // 完整装配：sessionProjections 返回固定高压力（9000 tokens ≥ 阈值 8K*1000 缺省触发——需求① K 数值判定）
  function captureWithPressure(sessionId = 's1'): {
    listener: PostExecuteListener
  } {
    let captured: PostExecuteListener = async () => undefined
    const ctx = {
      on: (event: string, listener: PostExecuteListener) => {
        if (event === 'tools/post-execute') captured = listener
        return () => {}
      },
      get: (name: string) =>
        name === 'sessionProjections'
          ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 9000, contextWindow: 10000 } } }) }
          : undefined,
    } as any
    registerKeeper(ctx, { defaultThreshold: 200 })
    // 需求①：注入简单配置源（低 K 阈值 8 → 9000 ≥ 8000 恒触发）
    // v1.49.0：`rebuildEnabled` 已砍掉 ⇒ 提醒恒开，本夹具不再需要那个键
    // 2026-10-15：面 E 退役 ⇒ `acpEnabled`/`acpHttpPort`/`publicAskEnabled` 三个键同批删除（本夹具不再列）
    // 2026-10-18（v1.63.3）：无人值守退役 ⇒ `unattendedEnabled` 同批删除（本夹具不再列）
    __setSimpleSourceForTest(() => ({ gatewayEnabled: false, rebuildThresholdK: 8, 轨迹约束Enabled: false, 轨迹约束DebugPort: 3099, croEnabled: true }))
    return { listener: captured }
  }

  async function runOnce(listener: PostExecuteListener, sessionId: string, cwd: string): Promise<string> {
    const exec = { name: 'read', agent: { session: { id: sessionId, header: { cwd } } } }
    const downstream = (await listener(
      exec,
      {},
      () => Promise.resolve({ kind: 'accept', additionalContexts: [] }),
    )) as { kind: string; additionalContexts: { content: { text: string }[] }[] }
    return (downstream.additionalContexts ?? [])
      .map((c) => c.content?.map((b) => b.text).join(''))
      .join('\n')
  }

  it('每次超阈值都注入交接提醒（不做节流）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-rebuild-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    try {
      const { listener } = captureWithPressure()
      // 连续两次工具调用 → 每次都注入交接提醒（无冷却跳过）
      // 🔴 2026-11-16：`LIMIT` 已并入 `HANDOVER`（rebuild ≡ reconstruct 共用一条注入）。
      const t1 = await runOnce(listener, 's1', dir)
      const t2 = await runOnce(listener, 's1', dir)
      expect(t1).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
      expect(t2).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
      // 第 2 轮仍未升级：升级档只有语气更硬，**token 不变**（2026-11-16 裁定不加 ESCALATED 标记）
      expect(t2).not.toContain('STOP:')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('连续 3 轮超阈值未交接 → 升级为 STOP 强制语气（token 不变，持续催）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-rebuild-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    try {
      const { listener } = captureWithPressure()
      const t1 = await runOnce(listener, 's2', dir)
      const t2 = await runOnce(listener, 's2', dir)
      const t3 = await runOnce(listener, 's2', dir)
      const t4 = await runOnce(listener, 's2', dir)
      expect(t1).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
      expect(t2).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
      // 🔴 升级的**判据是语气**，不是 token：同一个 HANDOVER token 贯穿两档，
      //    这样模型看到的是"同一件事说得更硬"，而不是"出现了第二件事"。
      expect(t3).toContain('[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]')
      expect(t3).toContain('STOP:')
      expect(t4).toContain('STOP:') // 升级后持续催（不重置）
      // 状态累计可见
      expect(rebuildReminderStateSnapshot().get('s2')?.consecutive).toBeGreaterThanOrEqual(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
