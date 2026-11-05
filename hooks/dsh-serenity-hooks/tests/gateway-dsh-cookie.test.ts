/**
 * gateway-dsh-cookie.test.ts — 面 B（3081 网关）的 **DSH BrowserAuth cookie 注入面**（⑤ 第 26 件）
 *
 * 靶 = `gateway/server.ts` 对 `gateway/dsh-auth.ts` 的**接线**（纯函数面已被 `tests/gateway-dsh-auth.test.ts` 覆盖，
 * 该文件报告里已无 `cstat-no`）：
 *   · `buildDshCookieProvider`：connection **可取／不可取**两态 ＋ **首次诊断日志** ＋ **缓存**
 *   · `upstreamHeaders`：`dshCookie !== undefined` ⇒ **合并进反代上游的 cookie 头**
 *
 * 🔴 **为什么要钉（这是"与 DSH 的衔接面"本身）**：v1.28.2 线上 bug —— DSH 0.1.2-rc.1 加 BrowserAuth 后，
 * 3081 的反代请求**没有 dsh browser cookie** ⇒ 主端口 **401「dsh web authentication required」**（整面不可用）。
 * 本组的判据**落在上游真收到的 `cookie` 头上**（不是"函数返回了什么"）。
 *
 * ⚠️ **诚实边界**：`cachedProvider` 的**成功缓存**用"`authenticatedUrl` 只被调一次"证明；
 * 反例（**失败不缓存**）用"调两次"证明 —— 两者都是**计数读数**，不是时间读数（无 flake）。
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

/** 主端口替身：**记录真收到的 cookie 头**（判据源） */
interface UpstreamProbe {
  server: import('node:http').Server
  mainPort: number
  hits: number
  lastCookie: string | null
}

async function startUpstream(): Promise<UpstreamProbe> {
  const probe: UpstreamProbe = { server: undefined as never, mainPort: 0, hits: 0, lastCookie: null }
  const server = createServer((req, res) => {
    probe.hits += 1
    probe.lastCookie = req.headers.cookie ?? null
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('upstream-body')
  })
  probe.mainPort = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  probe.server = server
  return probe
}

interface RawRes { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(opts: { port: number; method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** ctx.connection 的最小替身（+ 调用计数）；`cookie: null` ⇒ authorizeIndex **不写** set-cookie（换取失败形态） */
function fakeConnection(opts: { cookie?: string | null; url?: (base: string) => string } = {}): {
  conn: Record<string, unknown>
  calls: { authenticatedUrl: number; authorizeIndex: number }
} {
  const calls = { authenticatedUrl: 0, authorizeIndex: 0 }
  const cookie = opts.cookie === undefined ? 'dsh-auth-xyz=v1.body.sig; Max-Age=2592000; Path=/' : opts.cookie
  return {
    calls,
    conn: {
      authenticatedUrl: (base: string) => {
        calls.authenticatedUrl += 1
        return opts.url ? opts.url(base) : `${base}/?token=launch-token`
      },
      authorizeIndex: (_req: unknown, res: unknown) => {
        calls.authorizeIndex += 1
        if (cookie !== null) {
          ;(res as { writeHead: (s: number, h?: Record<string, string | string[]>) => unknown }).writeHead(200, { 'set-cookie': cookie })
        }
        return false
      },
    },
  }
}

/** 起真网关（内核分配端口）＋ 真登录；`connection` 由各用例决定给不给 */
async function boot(probe: UpstreamProbe, connection: Record<string, unknown> | undefined): Promise<{ gwPort: number; token: string; cleanup: () => Promise<void> }> {
  const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-dsh-'))
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
  const ctx = {
    get: (name: string) => (name === 'webServer' ? { port: probe.mainPort } : name === 'connection' ? connection : undefined),
    on: vi.fn(),
    effect: vi.fn(() => () => {}),
  }
  registerGateway(ctx as never)
  await vi.waitFor(() => expect(faceActive('gateway')).toBe(true), { timeout: 5000 })
  const gwPort = facePort('gateway') ?? 0

  const page = await raw({ port: gwPort, method: 'GET', path: '/' })
  const csrf = /serenity_csrf=([^;]+)/.exec(String(page.headers['set-cookie'] ?? ''))?.[1] ?? ''
  const loginRes = await raw({
    port: gwPort,
    method: 'POST',
    path: '/serenity/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf, cookie: `serenity_csrf=${csrf}` },
    body: totpLoginBody('tester'),
  })
  const token = /serenity_session=([^;]+)/.exec(String(loginRes.headers['set-cookie'] ?? ''))?.[1] ?? ''
  expect(loginRes.status).toBe(302)
  expect(token).not.toBe('')

  return {
    gwPort,
    token,
    cleanup: async () => {
      stopAllFaces()
      __setSimpleSourceForTest(null)
      if (prevCfg === undefined) delete process.env.SERENITY_HOOKS_CONFIG
      else process.env.SERENITY_HOOKS_CONFIG = prevCfg
      probe.server.closeAllConnections()
      await new Promise<void>((resolve) => {
        probe.server.close(() => resolve())
        setTimeout(resolve, 1000)
      })
      rmSync(cfgDir, { recursive: true, force: true })
    },
  }
}

/** 只数「本面产生的」诊断日志（启动日志等同前缀不含 `dsh browser-auth`） */
function dshAuthLogs(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => c.join(' ')).filter((s) => s.includes('dsh browser-auth'))
}

describe('面 B：DSH BrowserAuth cookie 注入面（衔接面 —— 上游真收到的 cookie 头是判据）', () => {
  it('① **无 connection**（旧 dsh／非 web 装配）⇒ 不注入；上游只看到会话 cookie（正控）＋ 首次诊断日志**只打一次**', async () => {
    const probe = await startUpstream()
    const { gwPort, token, cleanup } = await boot(probe, undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r1 = await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(r1.status).toBe(200)
      expect(r1.body).toBe('upstream-body')
      // 🔴 正控：请求**真带着会话 cookie 到了上游**（否则"没有 dsh-auth"这个阴性判据毫无意义）
      expect(probe.lastCookie).toContain(`serenity_session=${token}`)
      expect(probe.lastCookie).not.toContain('dsh-auth-')

      // 再发一次：诊断日志不得重复（`diagnosed` 只让首条出）
      await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(dshAuthLogs(log).filter((s) => s.includes('✗ 不可取'))).toHaveLength(1)
    } finally {
      log.mockRestore()
      await cleanup()
    }
  }, 20_000)

  it('② **有 connection 且换取成功** ⇒ dsh cookie 被**合并**进上游 cookie 头；诊断一次；且**成功被缓存**', async () => {
    const probe = await startUpstream()
    const { conn, calls } = fakeConnection()
    const { gwPort, token, cleanup } = await boot(probe, conn)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r1 = await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(r1.status).toBe(200)
      // 🔴 衔接面本体：上游同时看到**外部既有 cookie** 与 **dsh browser cookie**
      expect(probe.lastCookie).toContain('dsh-auth-xyz=v1.body.sig')
      expect(probe.lastCookie).toContain(`serenity_session=${token}`)
      expect(dshAuthLogs(log).filter((s) => s.includes('✓ 已内存换取'))).toHaveLength(1)

      // 缓存：第二次请求**不再**向 connection 换取
      await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(calls.authenticatedUrl).toBe(1)
      expect(calls.authorizeIndex).toBe(1)
      expect(dshAuthLogs(log)).toHaveLength(1) // 诊断仍只有一条
    } finally {
      log.mockRestore()
      await cleanup()
    }
  }, 20_000)

  it('③ **换取失败**（authorizeIndex 不写 set-cookie）⇒ 不注入，且**失败不被缓存**（下次仍重试）', async () => {
    const probe = await startUpstream()
    const { conn, calls } = fakeConnection({ cookie: null })
    const { gwPort, token, cleanup } = await boot(probe, conn)
    try {
      await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(probe.lastCookie).toContain(`serenity_session=${token}`)
      expect(probe.lastCookie).not.toContain('dsh-auth-')

      await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      // 🔴 反例判据：失败**不**缓存 ⇒ 两次请求各换一次（若被缓存，这里会是 1）
      expect(calls.authenticatedUrl).toBe(2)
      expect(calls.authorizeIndex).toBe(2)
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('④ `connection.authenticatedUrl` 是**抛错的 getter**（cordis「未声明属性即抛」的真形态）⇒ 不注入、面照常 200', async () => {
    const probe = await startUpstream()
    // 真形态：读属性就抛（同 hostInjected 注释里记录的 cordis 行为）
    const conn: Record<string, unknown> = {}
    Object.defineProperty(conn, 'authenticatedUrl', {
      get() {
        throw new Error('cannot get property "authenticatedUrl" without inject')
      },
      enumerable: true,
    })
    Object.defineProperty(conn, 'authorizeIndex', { value: () => false, enumerable: true })
    const { gwPort, token, cleanup } = await boot(probe, conn)
    try {
      const r = await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      // 🔴 衔接面异常**不得**拖垮面本身
      expect(r.status).toBe(200)
      expect(r.body).toBe('upstream-body')
      expect(probe.lastCookie).not.toContain('dsh-auth-')
    } finally {
      await cleanup()
    }
  }, 20_000)
})
