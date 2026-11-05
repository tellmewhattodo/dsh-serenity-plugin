/**
 * gateway-lifecycle.test.ts — 面 B（3081 网关）的 **装配与生命周期面**（⑤ 第 27 件）
 *
 * 靶 = `registerGateway` 里 `sync()` 的**四条真路径**（前两件只攻了它的请求处理面）：
 *   ① `!enabled` ⇒ **停旧面 ＋ 日志**（`current.dispose()` 与 `gateway 已停止…`）
 *   ② `serenity/config-updated` ⇒ **`lastSig = null` 强制重建**（配置无实质变化也要重建）
 *   ③ **同步失败 ⇒ catch 兜底**（`gateway 同步失败` —— 宿主设置服务读取抛错；**面不许因此死掉**）
 *   ④ `agent/created` 的 **cwd 迁移**（CCC localstore 的旧节 → plugin 全局文件，**真写盘**）
 *
 * 🔵 **驱动方式**：`ctx.on` 不再用 `vi.fn()`，改为**记录监听器**再手动触发 —— 于是三条事件入口
 * （`agent/created` ／ `serenity/config-updated` ／ `serenity/settings-changed`）都成了可测入口。
 * 🔵 **判据**：一律看**面状态（`faceActive`）／盘上文件／真发出的 HTTP 往返**，不看"函数返回了什么"。
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'

// gateway/server.ts 依赖 settings-section（peerDep schemastery/dsh-settings）——mock 保证 vitest 解析
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
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

// 🔴 v1.119.0：口令登录退役 ⇒ 拿会话改走 TOTP（判据见 helpers/totp-fixture.ts 头注）
import { totpAccount, totpLoginBody } from './helpers/totp-fixture.js'
import { registerGateway } from '../src/gateway/server.js'
import { faceActive, facePort, stopAllFaces } from '../src/surface/faces.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'

async function startUpstream(): Promise<{ server: import('node:http').Server; mainPort: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('upstream-body')
  })
  const mainPort = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  return { server, mainPort }
}

interface RawRes { status: number; body: string }

function raw(opts: { port: number; method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

type Listener = (payload: unknown) => unknown

interface Booted {
  gwPort: number
  token: string
  cfgPath: string
  /** 手动触发注册过的事件入口（返回处理器结果，async 的会被 await） */
  fire: (name: string, payload?: unknown) => Promise<void>
  /** 捕获到的 console.log 文案（已安装 spy） */
  logs: () => string[]
  cleanup: () => Promise<void>
}

async function boot(server: import('node:http').Server, mainPort: number): Promise<Booted> {
  const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-life-'))
  const cfgPath = join(cfgDir, 'serenity-hooks.json')
  writeFileSync(cfgPath, JSON.stringify({
    gateway: {
      enabled: true,
      host: '127.0.0.1',
      port: 0, // 内核分配（不猜端口段，防 EADDRINUSE ⇒ 面宿主重试挂死）
      accounts: [totpAccount('tester')],
      totpEnabled: true,
    },
    weixinApi: { enabled: false, port: 0 },
  }))
  const prevCfg = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = cfgPath
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), gatewayEnabled: true }))

  const listeners = new Map<string, Listener[]>()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}) // 🔴 必须早于 registerGateway：要数"已启动"日志
  const ctx = {
    get: (name: string) => (name === 'webServer' ? { port: mainPort } : undefined),
    on: (name: string, fn: Listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    },
    effect: vi.fn(() => () => {}),
  }
  registerGateway(ctx as never)
  await vi.waitFor(() => expect(faceActive('gateway')).toBe(true), { timeout: 5000 })
  const gwPort = facePort('gateway') ?? 0

  const csrf = /serenity_csrf=([^;]+)/.exec(await csrfFrom(gwPort))?.[1] ?? ''
  const loginRes = await loginRaw(gwPort, csrf)
  const token = /serenity_session=([^;]+)/.exec(loginRes.cookie)?.[1] ?? ''
  expect(loginRes.status).toBe(302)
  expect(token).not.toBe('')

  return {
    gwPort,
    token,
    cfgPath,
    logs: () => log.mock.calls.map((c) => c.join(' ')),
    fire: async (name, payload) => {
      for (const fn of listeners.get(name) ?? []) await fn(payload)
    },
    cleanup: async () => {
      stopAllFaces()
      log.mockRestore()
      __setSimpleSourceForTest(null)
      if (prevCfg === undefined) delete process.env.SERENITY_HOOKS_CONFIG
      else process.env.SERENITY_HOOKS_CONFIG = prevCfg
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        setTimeout(resolve, 1000)
      })
      rmSync(cfgDir, { recursive: true, force: true })
    },
  }
}

/** 取登录页的 csrf cookie（登录 POST 需要双提交） */
function csrfFrom(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
      res.resume()
      res.on('end', () => resolve(String(res.headers['set-cookie'] ?? '')))
    })
    req.on('error', reject)
    req.end()
  })
}

function loginRaw(port: number, csrf: string): Promise<{ status: number; cookie: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1', port, method: 'POST', path: '/serenity/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf, cookie: `serenity_csrf=${csrf}` },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') }))
      },
    )
    req.on('error', reject)
    req.end(totpLoginBody('tester'))
  })
}

describe('面 B：装配与生命周期面（sync 四条真路径）', () => {
  it('① `!enabled` ⇒ **停旧面 ＋ 日志**（`serenity/settings-changed` 触发重 sync）', async () => {
    const { server, mainPort } = await startUpstream()
    const b = await boot(server, mainPort)
    try {
      expect(faceActive('gateway')).toBe(true)
      expect(b.logs().filter((s) => s.includes('gateway 已启动'))).toHaveLength(1)

      // 关开关 → 触发重 sync
      __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), gatewayEnabled: false }))
      await b.fire('serenity/settings-changed')

      await vi.waitFor(() => expect(faceActive('gateway')).toBe(false), { timeout: 5000 })
      expect(b.logs().some((s) => s.includes('gateway 已停止'))).toBe(true)
      // 面真没了：再连不上（正控的反面）
      await expect(raw({ port: b.gwPort, method: 'GET', path: '/' })).rejects.toBeTruthy()
    } finally {
      await b.cleanup()
    }
  }, 20_000)

  it('② `serenity/config-updated` ⇒ `lastSig = null` ⇒ **配置无变化也强制重建**（"已启动"日志由 1 变 2）', async () => {
    const { server, mainPort } = await startUpstream()
    const b = await boot(server, mainPort)
    try {
      expect(b.logs().filter((s) => s.includes('gateway 已启动'))).toHaveLength(1)

      await b.fire('serenity/config-updated')
      await vi.waitFor(() => expect(b.logs().filter((s) => s.includes('gateway 已启动'))).toHaveLength(2), { timeout: 5000 })

      // 重建之后面仍然可用（反代照旧）
      const after = await raw({ port: facePort('gateway') ?? 0, method: 'GET', path: '/', headers: { cookie: `serenity_session=${b.token}` } })
      expect(after.status).toBe(200)
      expect(after.body).toBe('upstream-body')
    } finally {
      await b.cleanup()
    }
  }, 20_000)

  it('③ **同步失败 ⇒ catch 兜底**（设置源读取抛错）：只告警，**面不许因此死掉**', async () => {
    const { server, mainPort } = await startUpstream()
    const b = await boot(server, mainPort)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 真形态：宿主 settings 服务读取抛错（`readSimpleSettings` 无 try/catch ⇒ 一路冒到 queue 的 catch）
      __setSimpleSourceForTest(() => {
        throw new Error('settings source boom')
      })
      await b.fire('serenity/settings-changed')

      await vi.waitFor(() => expect(b.logs().concat(warn.mock.calls.map((c) => c.join(' '))).some((s) => s.includes('gateway 同步失败'))).toBe(true), { timeout: 5000 })
      expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('settings source boom')

      // 🔴 面仍活着（同步失败不得拖垮已起的面）
      expect(faceActive('gateway')).toBe(true)
      const r = await raw({ port: facePort('gateway') ?? 0, method: 'GET', path: '/', headers: { cookie: `serenity_session=${b.token}` } })
      expect(r.status).toBe(200)
    } finally {
      warn.mockRestore()
      await b.cleanup()
    }
  }, 20_000)

  it('④ `agent/created` 的 cwd 迁移：CCC localstore 旧节 → plugin 全局文件（**真写盘** ＋ 幂等）', async () => {
    const { server, mainPort } = await startUpstream()
    const b = await boot(server, mainPort)
    const ccc = mkdtempSync(join(tmpdir(), 'hooks-gw-ccc-'))
    try {
      // 造 CCC 根：`.serenity` 标记 ＋ localstore.json 里的旧节（v1.21.x 形态）
      writeFileSync(join(ccc, '.serenity'), 'test')
      writeFileSync(join(ccc, 'localstore.json'), JSON.stringify({
        serenityAdvanced: { gateway: { host: '127.0.0.1', port: 0, accounts: [{ id: 'legacy', user: 'legacy', passHash: 'x' }] } },
        credentials: { KEEP: 'me' },
      }))
      // 🔴 迁移的前置条件：**全局文件必须不存在**（存在 ⇒ migrateLegacyLocalstore 直接 return false）
      rmSync(b.cfgPath, { force: true })

      await b.fire('agent/created', { agent: { session: { header: { cwd: ccc } } } })

      expect(b.logs().some((s) => s.includes('已迁移 serenityAdvanced'))).toBe(true)
      // 🔴 真写盘：全局文件里出现了那一节（且是我们给的那个账号）
      expect(existsSync(b.cfgPath)).toBe(true)
      const migrated = JSON.parse(readFileSync(b.cfgPath, 'utf-8')) as { gateway?: { accounts?: Array<{ id: string }> } }
      expect(migrated.gateway?.accounts?.[0]?.id).toBe('legacy')

      // 幂等：全局文件已存在 ⇒ 不再迁移（日志不增）
      const before = b.logs().filter((s) => s.includes('已迁移 serenityAdvanced')).length
      await b.fire('agent/created', { agent: { session: { header: { cwd: ccc } } } })
      expect(b.logs().filter((s) => s.includes('已迁移 serenityAdvanced'))).toHaveLength(before)
    } finally {
      rmSync(ccc, { recursive: true, force: true })
      await b.cleanup()
    }
  }, 20_000)
})
