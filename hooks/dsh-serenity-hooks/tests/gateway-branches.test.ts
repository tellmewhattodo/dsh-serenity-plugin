import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerGateway } from '../src/gateway/server.js'
import { stopAllFaces, faceActive, facePort } from '../src/surface/faces.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'
// 🔴 v1.119.0：口令登录退役 ⇒ 拿会话改走 TOTP（判据见 helpers/totp-fixture.ts 头注）
import { totpAccount, totpLoginBody } from './helpers/totp-fixture.js'

/**
 * gateway-branches.test.ts — 网关面：**cookieSecure 四分支与会话装配退路**（⑤ 第 58 件，S142 2026-09-26）
 *
 * ## 与既有 `gateway.test.ts` 的分工（互补不重叠）
 *
 * 既有文件走的是**默认配置下的全部正路**：登录三态／锁定／TOTP 二选一／登出吊销／
 * 反代 RST／WS upgrade／HTML 注入／workspace.create 三态／跨源配置写拒绝。
 * 本文件补它**全部没碰**的一类：**`cookieSecure = true` 这条配置线**（明文 HTTP 之外的那条路）。
 *
 * ## 为什么 `cookieSecure` 值得单独一件（贴 objective：这是**对外面**的安全属性）
 *
 * 全覆盖报告实测：`cookieSecure ? '; Secure' : ''` 这个三元在 **四处**（登出 `:279` ／
 * 登录成功 `:399` ／ CSRF 告警 `:352` ／ 登录页文案 `:359`）**只有 `''` 那一侧被执行过**。
 * 而 `cookieSecure` 的语义是**安全属性**（源码 `:20` 逐字："反代 TLS 时开启；默认关保持明文 HTTP 可用"）：
 *   · 该开而不开 ⇒ **会话 cookie 在明文段裸奔**；
 *   · 该关而不关 ⇒ 明文 HTTP 下浏览器**丢弃带 Secure 的 cookie** ⇒ 登录后**立刻掉线**
 *     （源码 `:351` 的告警注释逐字描述了这条事故：*"cookieSecure=true 时明文 HTTP 会丢 CSRF cookie"*）。
 * ⇒ 两个方向都是"看不到的功能损坏"，而**既有测试对这条线零执行** ⇒ 同族（第 45/46/47/55/56/57 件）：
 * **承诺写进注释与配置项、却没有回归钉**。
 *
 * 🔵 **另一处本件补的对象**：`:442` 的 `enabled: () => readSimpleSettings().gatewayEnabled`
 * 是覆盖率报告里 `gateway/server.ts` **唯一剩下的 `fstat-no`**（函数从未被调用）——
 * 它是 spec 的**意图读取闭包**（`faceEnabled(spec)` 才调它），而既有用例全部**直接调 `registerGateway`**
 * ⇒ 这个闭包从未被求值过。本件把它钉住（"配置说关 ⇒ 意图为假"）。
 *
 * ## 🔴 夹具纪律（本件遵守，不造第四套 harness）
 *
 * `gateway.test.ts` 已有**三套** boot harness（`:787` 反代 ／ `:948` 登录 ／ `:1191` bootProxy）。
 * 夹具重复 = 第二真相源 ⇒ 本件**照 `:948` 那套的形态**加一个 `cookieSecure` 参数，
 * 不另发明一套；且**端口全用 `port: 0`**（内核分配，绝不占用 3080/3081/3082/3099/3100 活端口）。
 *
 * ## 🔴 本件的硬前置
 *
 * 1. **端口隔离**：`gateway.port = 0` ＋ 上游 `listen(0)`（真实生产 3081 绝不能被碰）。
 * 2. **模块级状态必须复位**：`__setSimpleSourceForTest(null)` ＋ `stopAllFaces()`（`afterEach`）。
 * 3. **降级面断言与正控方向成对**（累积纪律 ⑬）：`cookieSecure=true` 的每条断言都配
 *    "同夹具 `cookieSecure=false` 时**不带** `Secure`"的对照 —— 否则无法区分"配置生效"与"夹具坏了"。
 */

type RawRes = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

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

const cookieOf = (res: RawRes, name: string): string =>
  new RegExp(`${name}=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''))?.[1] ?? ''

/** 起真网关（内核分配端口）＋ 上游替身；`cookieSecure` 是本件要驱动的那条配置线 */
async function boot(cfg: { cookieSecure?: boolean }): Promise<{ gwPort: number; cleanup: () => Promise<void> }> {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('upstream-main-body')
  })
  const mainPort = await new Promise<number>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const addr = upstream.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-br-'))
  const cfgPath = join(cfgDir, 'serenity-hooks.json')
  writeFileSync(cfgPath, JSON.stringify({
    gateway: {
      enabled: true,
      host: '127.0.0.1',
      port: 0, // 🔴 内核分配 —— 绝不占用真实 3081
      accounts: [totpAccount('tester')],
      totpEnabled: true,
      ...(cfg.cookieSecure === true ? { cookieSecure: true } : {}),
    },
    weixinApi: { enabled: false, port: 0 },
  }))
  const prevCfg = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = cfgPath
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), gatewayEnabled: true }))
  const ctx = {
    get: (name: string) => (name === 'webServer' ? { port: mainPort } : undefined),
    on: vi.fn(),
    effect: vi.fn(() => () => {}),
  }
  registerGateway(ctx as never)
  await vi.waitFor(() => expect(faceActive('gateway')).toBe(true), { timeout: 5000 })
  const gwPort = facePort('gateway') ?? 0
  expect(gwPort).toBeGreaterThan(0)
  return {
    gwPort,
    cleanup: async () => {
      stopAllFaces()
      __setSimpleSourceForTest(null)
      if (prevCfg === undefined) delete process.env.SERENITY_HOOKS_CONFIG
      else process.env.SERENITY_HOOKS_CONFIG = prevCfg
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve())
        setTimeout(resolve, 1000)
      })
      rmSync(cfgDir, { recursive: true, force: true })
    },
  }
}

async function freshCsrf(gwPort: number): Promise<string> {
  const page = await raw({ port: gwPort, method: 'GET', path: '/' })
  expect(page.status).toBe(200)
  const csrf = cookieOf(page, 'serenity_csrf')
  expect(csrf).not.toBe('')
  return csrf
}

function postLogin(gwPort: number, body: string, csrf?: string): Promise<RawRes> {
  return raw({
    port: gwPort,
    method: 'POST',
    path: '/serenity/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf, cookie: `serenity_csrf=${csrf}` }),
    },
    body,
  })
}

afterEach(() => {
  stopAllFaces()
  __setSimpleSourceForTest(null)
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// A. cookieSecure = true：四条 '; Secure' 分支
// ─────────────────────────────────────────────────────────────────────────────

describe('gateway: cookieSecure=true 的四处 Secure 分支（既有用例只走「空串」那一侧）', () => {
  it('🔴 A1：登录成功 ⇒ **会话 cookie 带 Secure**；且 CSRF cookie **刻意不带**', async () => {
    const h = await boot({ cookieSecure: true })
    try {
      const csrf = await freshCsrf(h.gwPort)
      const login = await postLogin(h.gwPort, totpLoginBody('tester'), csrf)
      expect(login.status).toBe(302)

      const setCookie = String(login.headers['set-cookie'])
      // 🔴 判据一：登录会话 cookie **必须带 Secure**（这正是 cookieSecure 的语义）
      expect(setCookie).toMatch(new RegExp(`serenity_session=[^;]+;[^]*Secure`))

      // 🔴 判据二（源码 :424 的设计决策，写进注释却无测试）：**CSRF cookie 独立于 cookieSecure、
      //    刻意不设 Secure** —— 明文 HTTP 下若给 CSRF 加 Secure，浏览器会丢弃它 ⇒ 登录页无法重试。
      //    故这里断言"CSRF 那条 set-cookie 不含 Secure"，把该决策的非对称性钉住。
      const loginPage = await raw({ port: h.gwPort, method: 'GET', path: '/' })
      const csrfSetCookie = String(loginPage.headers['set-cookie'])
      expect(csrfSetCookie).toContain('serenity_csrf=')
      expect(csrfSetCookie).not.toContain('Secure')
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('🔴 A2：登出 ⇒ 清 cookie 的那条也带 Secure（与登录侧对称）', async () => {
    const h = await boot({ cookieSecure: true })
    try {
      const csrf = await freshCsrf(h.gwPort)
      const login = await postLogin(h.gwPort, totpLoginBody('tester'), csrf)
      const token = cookieOf(login, 'serenity_session')
      expect(token).not.toBe('')

      const out = await raw({
        port: h.gwPort,
        method: 'POST',
        path: '/serenity/logout',
        headers: { cookie: `serenity_session=${token}` },
      })
      expect(out.status).toBe(302)
      const setCookie = String(out.headers['set-cookie'])
      // 🔴 判据 = 清除动作与设置动作**属性一致**：不清成"非 Secure 空 cookie"而留下残留路径
      expect(setCookie).toContain('Max-Age=0')
      expect(setCookie).toContain('Secure')
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('🔴 A3：CSRF 校验失败 ⇒ 告警文案**指名 cookieSecure=on**，且登录页提示**带"明文 HTTP 必须关闭"**', async () => {
    // 源码 :352 与 :359 的两条 `cookieSecure ? … : ''` —— 这是**诊断质量**的分支：
    // 排查"登录后掉线"时，告警里有没有这条线索，决定要不要去翻源码。
    const h = await boot({ cookieSecure: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 真故障形态：带 **csrf cookie** 但不带 **x-csrf-token 头** ⇒ 双提交判定失败
      await freshCsrf(h.gwPort)
      const page = await raw({ port: h.gwPort, method: 'GET', path: '/' })
      const csrf = cookieOf(page, 'serenity_csrf')
      const bad = await raw({
        port: h.gwPort,
        method: 'POST',
        path: '/serenity/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `serenity_csrf=${csrf}` },
        body: totpLoginBody('tester'),
      })
      expect(bad.status).toBe(403) // 源码 :355 的 CSRF 失败分支（回登录页 + 新 csrf；**不是 500、也不是 302**）

      // 🔴 判据一：告警里**出现 cookieSecure=on**（诊断线索在场）
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('CSRF') && String(c[0]).includes('cookieSecure=on')),
      ).toBe(true)
      // 🔴 判据二：登录页文案含那条**指向修法**的提示（否则用户只看到"校验失败"而无从下手）
      expect(bad.body).toContain('Secure Cookie')
    } finally {
      warn.mockRestore()
      await h.cleanup()
    }
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 正控方向：cookieSecure 缺省（= false）时**不得**出现 Secure
// ─────────────────────────────────────────────────────────────────────────────

describe('gateway: cookieSecure 缺省的正控方向（成对测 —— 累积纪律 ⑬）', () => {
  it('🔴 B1：缺省配置 ⇒ 会话 cookie **不带** Secure（明文 HTTP 仍可用这条语义）', async () => {
    const h = await boot({})
    try {
      const csrf = await freshCsrf(h.gwPort)
      const login = await postLogin(h.gwPort, totpLoginBody('tester'), csrf)
      expect(login.status).toBe(302)

      const setCookie = String(login.headers['set-cookie'])
      expect(setCookie).toContain('serenity_session=')
      // 🔴 判据 = **不带 Secure**。没有这条，A1 无法证明"Secure 来自配置"而不是恒有。
      expect(setCookie).not.toContain('Secure')
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('🔴 B2：缺省配置的 CSRF 告警**不**出现 cookieSecure=on（与 A3 成对）', async () => {
    const h = await boot({})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const page = await raw({ port: h.gwPort, method: 'GET', path: '/' })
      const csrf = cookieOf(page, 'serenity_csrf')
      await raw({
        port: h.gwPort,
        method: 'POST',
        path: '/serenity/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `serenity_csrf=${csrf}` },
        body: totpLoginBody('tester'),
      })
      const csrfWarns = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('CSRF'))
      expect(csrfWarns.length).toBeGreaterThan(0) // 正控：告警确实打了（否则下面那条断言无意义）
      expect(csrfWarns.some((s) => s.includes('cookieSecure=on'))).toBe(false)
    } finally {
      warn.mockRestore()
      await h.cleanup()
    }
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 装配意图闭包（gateway/server.ts 唯一剩下的 fstat-no）
// ─────────────────────────────────────────────────────────────────────────────

describe('gateway: spec.enabled 意图闭包（faceEnabled 才调它 —— 既有用例全部绕过）', () => {
  it('🔴 C1：`gateway.ts` 传给面宿主的 spec，其 `enabled()` **如实读设置源**（开/关两个方向）', async () => {
    // 源码 :442 `enabled: () => readSimpleSettings().gatewayEnabled`
    // 覆盖率报告里这是 gateway/server.ts **唯一剩下的 fstat-no**（该箭头从未被求值）。
    // 语义：装配层据此判"该面此刻应否在监听"。判反的后果 =
    // **设置面板关了网关、意图仍报"开"** ⇒ 用户在 UI 上关不掉这个对外端口。
    //
    // 🔴 手法：**不 mock 被测模块** —— 只 mock `face-host.startFace`（面宿主的**边界**），
    //    把 gateway 真正构造的那个 spec 截获下来。这样 enabled() 仍是**生产代码里那个箭头**，
    //    而不是我在测试里照抄一份（照抄 = 测自己，是假覆盖 —— 累积纪律 ⑧）。
    const captured = await captureGatewaySpec()
    expect(captured).toBeDefined()
    expect(typeof captured!.enabled).toBe('function')

    // 方向一：设置源说开 ⇒ true
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), gatewayEnabled: true }))
    expect(captured!.enabled()).toBe(true)

    // 方向二：设置源说关 ⇒ false（这才是"关得掉"的判据；只测一侧无法区分"真读设置"与"恒 true"）
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), gatewayEnabled: false }))
    expect(captured!.enabled()).toBe(false)
  })
})

/**
 * 截获 `gateway/server.ts` 真正传给面宿主的 spec。
 *
 * 手法：把 `face-host.startFace` 换成一个**只记录不绑定**的替身（面宿主的边界，不是被测对象），
 * 于是 `startGateway` 会走到它自己那句 `startFace({ … enabled: () => … , handler })` 并把 spec 交出来。
 * ⚠️ 替身**必须给出返回值**（累积第 57 件纪律 ⑧：`vi.fn()` 默认 undefined ⇒ 调用方解引用崩）——
 *    这里返回一个形状完整的假 handle（含 `server.on`，因为 gateway 随后就挂 'upgrade'）。
 */
async function captureGatewaySpec(): Promise<{ enabled: () => boolean } | undefined> {
  const { EventEmitter } = await import('node:events')
  const faceHost = await import('../src/surface/faces.js')
  let captured: { enabled: () => boolean } | undefined

  const fakeServer = new EventEmitter() as EventEmitter & { close: () => void; closeIdleConnections?: () => void }
  fakeServer.close = () => {}
  const spy = vi.spyOn(faceHost, 'startFace').mockImplementation((async (spec: { enabled: () => boolean }) => {
    captured = spec
    return { name: 'gateway', port: 0, host: '127.0.0.1', server: fakeServer, dispose: () => {} }
  }) as never)

  const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-spec-'))
  const cfgPath = join(cfgDir, 'serenity-hooks.json')
  writeFileSync(cfgPath, JSON.stringify({ gateway: { enabled: true, host: '127.0.0.1', port: 0, accounts: [] }, weixinApi: { enabled: false, port: 0 } }))
  const prevCfg = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = cfgPath
  try {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), gatewayEnabled: true }))
    const ctx = {
      get: (name: string) => (name === 'webServer' ? { port: 1 } : undefined),
      on: vi.fn(),
      effect: vi.fn(() => () => {}),
    }
    registerGateway(ctx as never)
    await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: 5000 })
    return captured
  } finally {
    spy.mockRestore()
    if (prevCfg === undefined) delete process.env.SERENITY_HOOKS_CONFIG
    else process.env.SERENITY_HOOKS_CONFIG = prevCfg
    rmSync(cfgDir, { recursive: true, force: true })
  }
}
