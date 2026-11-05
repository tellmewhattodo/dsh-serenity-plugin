/**
 * gateway-ws.test.ts — 面 B 的 **WS 反代残余面**（⑤ 第 24 件）
 *
 * 挑靶依据 = **分支覆盖率**（`gateway/server.ts` 分支 86/122 = 70.49%，是已满靶之外最低者之一）。
 *
 * 🔴 **先复核再开工（本件的第一条产出）**：既有 `tests/gateway.test.ts` 的 v1.22.3 组
 * **已经**跑过一条**已认证**的 WS upgrade（断言 101 被回写）⇒ 那段不是"整块未覆盖"，
 * 残余**只有四类真分支**（判据 = 报告里该段的 `cbranch-no`/`cstat-no` 逐行核对）：
 *   ① `!authed(req)` 的**真侧**（未认证 upgrade ⇒ 立即销毁，不建隧道）
 *   ② `Array.isArray(v) ? v.join(', ')` 的**数组侧**（上游响应头有数组值，如两条 `set-cookie`）
 *   ③ `if (head.length > 0)` ／ `if (uhead.length > 0)`（握手包里**紧跟载荷**的双向转发）
 *   ④ `upstream.on('response')` **整块**（上游回**非 101** ⇒ 透传普通 HTTP 响应 ——
 *      这正是 v1.22.2 `ERR_INVALID_HTTP_RESPONSE` 的另一半修复）
 *
 * ⚠️ **诚实边界（刻意不覆盖，别当欠账）**：`statusCode ?? 101` ／ `statusMessage ?? 'Switching Protocols'`
 * 的**默认侧**（上游写 101 却不给状态短语 ⇒ 近乎畸形报文，硬造会把"从不发生"固化成期望）；
 * `socket.write(...)` 周围那个 `catch`（要 write 抛错 ＝ socket 已坏，与"未认证"档不同因）。
 *
 * 🔵 **判据形态（可复用）**：全部走**真 listener ＋ 真 socket ＋ 真上游**——客户端用裸 `net` 手写
 * upgrade 请求（不引 WS 库），断言的读数是**客户端 socket 上真实收到的字节**。
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

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

interface WsProbe {
  server: import('node:http').Server
  mainPort: number
  upgradeSeen: boolean
  echoSeen: string
}

/**
 * 上游替身（真实 DSH WebUI 的位置）：
 *  · `/blocked` ⇒ **非 101**：手写一条普通 403 响应（含两个**应被过滤**的跳头：`connection`/`upgrade`）
 *  · 其余      ⇒ **真 101**：单次 write 写「握手头 ＋ 紧跟载荷」（载荷 ⇒ 上游侧 `uhead` 非空）；
 *                两条 `set-cookie` ⇒ 上游响应头出现**数组值**；随后 echo 客户端数据。
 */
async function startUpstream(): Promise<WsProbe> {
  const probe: WsProbe = { server: undefined as never, mainPort: 0, upgradeSeen: false, echoSeen: '' }
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('plain-upstream')
  })
  server.on('upgrade', (req, sock) => {
    probe.upgradeSeen = true
    if ((req.url ?? '').startsWith('/blocked')) {
      sock.end(
        'HTTP/1.1 403 Forbidden\r\nconnection: keep-alive\r\nupgrade: websocket\r\n' +
          'content-type: text/plain\r\nset-cookie: wsr=1\r\nset-cookie: wsr=2\r\n' +
          'content-length: 12\r\n\r\nws-rejected!',
      )
      return
    }
    sock.on('data', (d: Buffer) => {
      probe.echoSeen += d.toString('utf-8')
      sock.write(d)
    })
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
        'sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
        'set-cookie: wsa=1\r\nset-cookie: wsb=2\r\n\r\nUHELLO',
    )
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

/**
 * 裸 socket 手写 upgrade 请求（不引 WS 库 ⇒ 断言的是**客户端真实收到的字节**）。
 * `payload` 与握手**同一次 write** 发出 ⇒ 网关侧 `head` 非空（③ 的一半）。
 */
function rawUpgrade(opts: { port: number; path?: string; headers?: Record<string, string>; payload?: string; until?: (acc: string) => boolean }): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: '127.0.0.1', port: opts.port })
    let received = ''
    let settled = false
    const timer = setTimeout(() => finish(false), 5000)
    function finish(closed: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* noop */ }
      resolve({ received, closed })
    }
    sock.on('connect', () => {
      const lines = [
        `GET ${opts.path ?? '/ws'} HTTP/1.1`,
        `Host: 127.0.0.1:${opts.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ]
      sock.write(lines.join('\r\n') + (opts.payload ?? ''))
    })
    sock.on('data', (c: Buffer) => {
      received += c.toString('utf-8')
      if (opts.until?.(received) === true) finish(false)
    })
    sock.on('close', () => finish(true))
    sock.on('error', () => finish(true)) // 被服务端 destroy ⇒ ECONNRESET 属预期
  })
}

/** 起真网关（内核分配端口）＋ 真登录，返回 { gwPort, token, cleanup }。 */
async function boot(probe: WsProbe): Promise<{ gwPort: number; token: string; cleanup: () => Promise<void> }> {
  const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-ws-'))
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
    get: (name: string) => (name === 'webServer' ? { port: probe.mainPort } : undefined),
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
      // 🔴 cleanup 不允许挂住：悬挂连接会让 `server.close()` 永不回调 ⇒ 断言失败会被伪装成超时。
      probe.server.closeAllConnections()
      await new Promise<void>((resolve) => {
        probe.server.close(() => resolve())
        setTimeout(resolve, 1000)
      })
      rmSync(cfgDir, { recursive: true, force: true })
    },
  }
}

describe('面 B：WS 反代残余面（未认证拒绝 / 握手缓冲转发 / 非 101 透传）', () => {
  it('① 未认证 upgrade ⇒ **立即销毁、零字节回写**（不建立隧道；真实 cookie 缺失形态）', async () => {
    const probe = await startUpstream()
    const { gwPort, cleanup } = await boot(probe)
    try {
      // 不发 Cookie（浏览器未登录 / cookie 过期）
      const res = await rawUpgrade({ port: gwPort, path: '/ws' })

      expect(res.closed).toBe(true)
      expect(res.received).toBe('') // 🔴 判据 = 客户端**一个字节都没收到**（既无 101 也无错误页）
      expect(probe.upgradeSeen).toBe(false) // 🔴 更强：请求**根本没被转给上游**
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('② 已认证 + 上游 101 ⇒ 握手回写 ＋ **head/uhead 双向转发** ＋ 数组值响应头 join', async () => {
    const probe = await startUpstream()
    const { gwPort, token, cleanup } = await boot(probe)
    try {
      // 握手与载荷**同一次 write** ⇒ 网关侧 `head` 非空；上游 101 也紧跟载荷 ⇒ `uhead` 非空
      const res = await rawUpgrade({
        port: gwPort,
        path: '/ws',
        headers: { Cookie: `serenity_session=${token}` },
        payload: 'CHELLO',
        until: (acc) => acc.includes('CHELLO'),
      })

      expect(probe.upgradeSeen).toBe(true)
      expect(res.received).toContain('HTTP/1.1 101 Switching Protocols')
      expect(res.received).toContain('sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
      // ③ 上游紧跟握手的载荷（uhead）被转发到客户端
      expect(res.received).toContain('UHELLO')
      // ③ 客户端紧跟握手的载荷（head）被转发到上游，并经 echo 回到客户端
      expect(probe.echoSeen).toContain('CHELLO')
      expect(res.received).toContain('CHELLO')
      // ② 两条 set-cookie ⇒ 数组值响应头走 `v.join(', ')` 侧
      expect(res.received).toContain('set-cookie: wsa=1, wsb=2')
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('③ 已认证 + 上游回**非 101**（403）⇒ 透传普通 HTTP 响应（跳头被过滤），不是挂起', async () => {
    const probe = await startUpstream()
    const { gwPort, token, cleanup } = await boot(probe)
    try {
      // 🔴 这是 v1.22.2 `ERR_INVALID_HTTP_RESPONSE` 的另一半：此前只监听 upgrade/error ⇒ 非 101 时连接挂起
      const res = await rawUpgrade({
        port: gwPort,
        path: '/blocked',
        headers: { Cookie: `serenity_session=${token}` },
      })

      expect(probe.upgradeSeen).toBe(true)
      expect(res.received).toContain('HTTP/1.1 403 Forbidden')
      expect(res.received).toContain('ws-rejected!')
      // 透传侧的**数组值**响应头同样走 `v.join(', ')`（两条 set-cookie）
      expect(res.received).toContain('set-cookie: wsr=1, wsr=2')
      // 跳头过滤：上游那两条不得漏给客户端（否则客户端会误判为升级响应）
      expect(res.received.toLowerCase()).not.toContain('connection:')
      expect(res.received.toLowerCase()).not.toContain('upgrade:')
      // 网关自己补 content-length 并 end ⇒ 客户端看到连接结束（不是挂起）
      expect(res.closed).toBe(true)
    } finally {
      await cleanup()
    }
  }, 20_000)
})
