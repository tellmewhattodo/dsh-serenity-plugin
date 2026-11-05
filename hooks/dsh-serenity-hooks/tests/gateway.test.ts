import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { gzipSync } from 'node:zlib'

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
import { SESSION_ABSOLUTE_TTL_MS } from '../src/gateway/auth.js'
import {
  loginPageHtml,
  issueToken,
  validateToken,
  revokeToken,
  cookieValue,
  RANDOM_UUID_POLYFILL,
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  isWorkspaceCreatePath,
  parseWorkspaceCreateBody,
  buildProxyHeaders,
  transformHtmlForProxy,
  resetFailState,
  recordLoginFailure,
  accountLockRemaining,
  isAccountLocked,
  FAIL_LOCK_THRESHOLD,
  FAIL_LOCK_BASE_MS,
  newCsrfToken,
  isCsrfValid,
  csrfFromRequest,
  safeEqual,
  originAllowed,
} from '../src/gateway/server.js'
// C4 块 A 冒烟：装配入口 + 面状态真值源 + 简单配置注入
import { registerGateway } from '../src/gateway/server.js'
import { faceActive, facePort, stopAllFaces } from '../src/surface/faces.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'
// 登录面集成：TOTP 二选一（真 code 生成，不 mock 校验器）
import { totpCode, base32Encode, TOTP_STEP_SECONDS } from '../src/gateway/totp.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-gateway-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 🔴 v1.119.0（2026-11-05 owner 令）：**口令登录整条退役** ⇒ 原
// `describe('F1: verifyGatewayLogin（账号验证）')` 的 4 例**已删除**（被测函数不存在了）。
// ⛔ 不要改成"跳过"或"改期望值"：那是把一条已作废的契约留在测试里当装饰。
// 取而代之的判据在下面「登录面集成 ④」（口令即使正确也必须 401）。

describe('F1: token（颁发/校验/登出，v1.22.4 会话化）', () => {
  it('颁发后有效（返回会话含 user）', () => {
    const t = issueToken('user-b')
    const s = validateToken(t)
    expect(s).toBeDefined()
    expect(s?.user).toBe('user-b')
  })

  it('未颁发/空/乱值 → undefined', () => {
    expect(validateToken(undefined)).toBeUndefined()
    expect(validateToken('')).toBeUndefined()
    expect(validateToken('not-issued')).toBeUndefined()
  })

  it('revokeToken：吊销后无效', () => {
    const t = issueToken('user-b')
    expect(validateToken(t)).toBeDefined()
    expect(revokeToken(t)).toBe(true)
    expect(validateToken(t)).toBeUndefined()
    expect(revokeToken(t)).toBe(false)
  })

  it('滑动过期：超过 TTL 后失效（fake time）', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      const t = issueToken('user-b')
      expect(validateToken(t)).toBeDefined()
      // 跳到 25h 后（无中间校验 → lastActiveAt 未被续期）
      now += 25 * 60 * 60 * 1000
      expect(validateToken(t)).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })

  it('滑动续期：TTL 内活动刷新过期点（fake time）', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      const t = issueToken('user-b')
      // 连续活动（每次间隔 <24h）→ 永不自然过期
      for (let i = 0; i < 3; i++) {
        now += 23 * 60 * 60 * 1000
        expect(validateToken(t)).toBeDefined()
      }
      // 最后一次活动后 25h 无活动 → 过期
      now += 25 * 60 * 60 * 1000
      expect(validateToken(t)).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })
})

describe('v1.22.4: 失败锁定（账号维度，不按 IP）', () => {
  it('连续失败达到阈值 → 锁定；剩余毫秒 > 0', () => {
    resetFailState('attacker')
    for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) {
      recordLoginFailure('attacker')
    }
    const remaining = accountLockRemaining('attacker')
    expect(remaining).toBeGreaterThan(0)
    expect(isAccountLocked('attacker')).toBe(true)
  })

  it('锁定到期自动解锁（fake time）', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      resetFailState('u2')
      for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u2')
      expect(isAccountLocked('u2')).toBe(true)
      now += FAIL_LOCK_BASE_MS + 1000
      expect(isAccountLocked('u2')).toBe(false)
    } finally {
      Date.now = realNow
    }
  })

  it('成功登录（resetFailState）→ 解锁', () => {
    resetFailState('u3')
    for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u3')
    expect(isAccountLocked('u3')).toBe(true)
    resetFailState('u3')
    expect(isAccountLocked('u3')).toBe(false)
  })

  it('锁定指数退避：第二次锁定更长', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      resetFailState('u4')
      for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u4')
      const first = accountLockRemaining('u4')
      now += FAIL_LOCK_BASE_MS + 1000 // 解锁
      isAccountLocked('u4') // 触发到期解锁
      for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u4')
      const second = accountLockRemaining('u4')
      expect(second).toBeGreaterThan(first)
    } finally {
      Date.now = realNow
    }
  })
})

describe('v1.22.4: CSRF（双提交 + Origin）', () => {
  it('newCsrfToken：随机且不同', () => {
    expect(newCsrfToken()).not.toBe(newCsrfToken())
    expect(newCsrfToken().length).toBe(64)
  })

  it('v1.24.9 isCsrfValid：生成即有效；未知 token 无效；多标签各自 token 都有效（集合语义）', () => {
    const a = newCsrfToken()
    const b = newCsrfToken()
    expect(isCsrfValid(a)).toBe(true)
    expect(isCsrfValid(b)).toBe(true)
    expect(isCsrfValid('deadbeef'.repeat(8))).toBe(false)
    expect(isCsrfValid('')).toBe(false)
  })

  it('safeEqual：常量时间比较', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  it('originAllowed：同源 / 主端口 loopback 允许；跨源拒绝', () => {
    expect(originAllowed('http://192.0.2.31:3081', '192.0.2.31:3081', 3080)).toBe(true)
    expect(originAllowed('http://127.0.0.1:3080', '192.0.2.31:3081', 3080)).toBe(true)
    expect(originAllowed('http://localhost:3080', '192.0.2.31:3081', 3080)).toBe(true)
    expect(originAllowed('http://evil.example.com', '192.0.2.31:3081', 3080)).toBe(false)
    expect(originAllowed('not-a-url', '192.0.2.31:3081', 3080)).toBe(false)
    // 无 Origin（curl/非浏览器）→ 放行（CSRF cookie 兜底）
    expect(originAllowed(undefined, '192.0.2.31:3081', 3080)).toBe(true)
  })

  it('csrfFromRequest：头优先，表单兜底', () => {
    const body = new URLSearchParams('csrf=formtoken&user=x')
    const req = { headers: {} } as never
    expect(csrfFromRequest(req, body)).toBe('formtoken')
    const req2 = { headers: { 'x-csrf-token': 'headertoken' } } as never
    expect(csrfFromRequest(req2, body)).toBe('headertoken')
  })
})

describe('F1: cookieValue（Cookie 头解析）', () => {
  it('提取指定 cookie', () => {
    const header = 'serenity_session=abc123; other=x'
    expect(cookieValue(header, 'serenity_session')).toBe('abc123')
    expect(cookieValue(header, 'other')).toBe('x')
  })

  it('无 header/无匹配 → undefined', () => {
    expect(cookieValue(undefined, 'serenity_session')).toBeUndefined()
    expect(cookieValue('a=b', 'missing')).toBeUndefined()
  })
})

describe('F1: loginPageHtml（登录页）', () => {
  it('含表单 + 错误提示注入', () => {
    const html = loginPageHtml('用户名或密码错误')
    expect(html).toContain('<form')
    expect(html).toContain('action="/serenity/login"')
    expect(html).toContain('用户名或密码错误')
    expect(html).toContain('autocomplete="username"')
  })

  it('无错误时提示区为空', () => {
    const html = loginPageHtml('')
    expect(html).toContain('class="error"></div>')
  })

  it('v1.22.1 移动端适配：viewport + 安全区 + 触控尺寸 + iOS 字号', () => {
    const html = loginPageHtml('')
    // viewport meta（移动浏览器不按 980px 缩放）
    expect(html).toContain('name="viewport"')
    expect(html).toContain('width=device-width')
    expect(html).toContain('viewport-fit=cover')
    // 安全区（刘海屏/手势条）
    expect(html).toContain('env(safe-area-inset-')
    // 触控目标 ≥ 44px / min-height 50px
    expect(html).toContain('min-height:50px')
    // 输入字号 16px（iOS 聚焦不自动放大）
    expect(html).toContain('font-size:16px')
    // 明暗自适应
    expect(html).toContain('prefers-color-scheme')
    expect(html).toContain('color-scheme')
    // 移动输入优化
    expect(html).toContain('autocapitalize="none"')
    expect(html).toContain('enterkeyhint="go"')
    // 响应式卡片宽度
    expect(html).toContain('min(340px,calc(100vw - 48px))')
  })

  it('v1.22.4：CSRF 隐藏字段 + TOTP 输入框（传 csrf 时）', () => {
    const html = loginPageHtml('', 'csrf-abc')
    expect(html).toContain('name="csrf" value="csrf-abc"')
    expect(html).toContain('name="code"')
    expect(html).toContain('inputmode="numeric"')
    expect(html).toContain('maxlength="6"')
  })

  it('v1.22.4：不传 csrf 时无隐藏字段（兼容）', () => {
    expect(loginPageHtml('')).not.toContain('name="csrf"')
  })
})

describe('v1.22: crypto.randomUUID polyfill（非安全上下文修复）', () => {
  it('polyfill 含 getRandomValues 实现（DSH 官方同算法）', () => {
    expect(RANDOM_UUID_POLYFILL).toContain('crypto.randomUUID')
    expect(RANDOM_UUID_POLYFILL).toContain('crypto.getRandomValues')
    expect(RANDOM_UUID_POLYFILL).toContain('padStart')
    expect(RANDOM_UUID_POLYFILL).toContain('</script>')
  })

  it('注入 HTML：</head> 前插入 + 幂等', () => {
    const html = '<!doctype html><head><title>t</title></head><body>x</body></html>'
    const out = injectPolyfillHtml(html)
    expect(out).toContain('data-sp-randomuuid-polyfill')
    expect(out.indexOf('data-sp-randomuuid-polyfill')).toBeLessThan(out.indexOf('</head>'))
    expect(injectPolyfillHtml(out)).toBe(out) // 幂等
  })

  it('无 </head> → 前置注入', () => {
    const out = injectPolyfillHtml('<html><body>x</body></html>')
    expect(out.startsWith('<script')).toBe(true)
  })
})

describe('v1.22: workspace 白名单过滤', () => {
  const listBody = JSON.stringify({
    type: 'server-response',
    rpcId: 'r1',
    result: {
      ok: true,
      value: {
        items: [
          { workspaceId: 'w1', path: '/home/user/workspace', title: 'serenity' },
          { workspaceId: 'w2', path: '/home/user/other', title: 'other' },
          { workspaceId: 'w3', path: '/data/x', title: 'x' },
        ],
        archivedSessionIds: [],
      },
    },
  })

  it('白名单为空 → 原样透传', () => {
    expect(filterWorkspaceList(listBody, [])).toBe(listBody)
  })

  it('前缀匹配过滤 items（保留匹配路径）', () => {
    const out = JSON.parse(filterWorkspaceList(listBody, ['/home/user/workspace'])) as {
      result: { value: { items: Array<{ path: string }> } }
    }
    expect(out.result.value.items.map((i) => i.path)).toEqual(['/home/user/workspace'])
  })

  it('多前缀并集', () => {
    const out = JSON.parse(filterWorkspaceList(listBody, ['/home/user/workspace', '/data'])) as {
      result: { value: { items: Array<{ path: string }> } }
    }
    expect(out.result.value.items.map((i) => i.path)).toEqual(['/home/user/workspace', '/data/x'])
  })

  it('非 ok / 非 JSON → 原样透传', () => {
    const errBody = JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'x', message: 'm' } } })
    expect(filterWorkspaceList(errBody, ['/home'])).toBe(errBody)
    expect(filterWorkspaceList('not-json{', ['/home'])).toBe('not-json{')
  })
})

describe('v1.22: workspace.create 白名单校验', () => {
  it('白名单空 → 全部允许', () => {
    expect(workspaceAllowed([], '/any/path')).toBe(true)
    expect(workspaceAllowed([], undefined)).toBe(true)
  })

  it('前缀匹配 → 允许；不匹配 → 拒绝', () => {
    expect(workspaceAllowed(['/home/user/workspace'], '/home/user/workspace')).toBe(true)
    expect(workspaceAllowed(['/home/user/workspace'], '/home/user/other')).toBe(false)
    expect(workspaceAllowed(['/home/user/workspace'], undefined)).toBe(false)
  })

  it('拒绝响应为合法 RPC error（code=forbidden）', () => {
    const out = JSON.parse(workspaceDenyResponse('r9')) as {
      type: string; rpcId: string; result: { ok: boolean; error: { code: string } }
    }
    expect(out.type).toBe('server-response')
    expect(out.rpcId).toBe('r9')
    expect(out.result.ok).toBe(false)
    expect(out.result.error.code).toBe('forbidden')
  })
})

// v1.30.6（S142 review F-03）：宿主 rc.1 把 Remote 端点改为 `workspace/create`
// （typertEndpoint = `<namespace>/<method>`）且 wire 信封为 payload.args —— 旧实现
// 匹配 `/api/workspace.create` + payload.path，分支从未命中 → 白名单/禁建校验失效。
describe('v1.30.6: workspace 创建端点与信封按宿主 rc.1 修正（F-03）', () => {
  it('端点判定：rc.1 /api/workspace/create 命中，旧端点兼容，其余不命中', () => {
    expect(isWorkspaceCreatePath('/api/workspace/create')).toBe(true)
    expect(isWorkspaceCreatePath('/api/workspace.create')).toBe(true)
    expect(isWorkspaceCreatePath('/api/workspace/rename')).toBe(false)
    expect(isWorkspaceCreatePath('/serenity/config')).toBe(false)
  })

  it('rc.1 信封 payload.args.path → 解析出路径（白名单据此生效）', () => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'workspace/create',
      payload: { args: { path: '/home/user/workspace' } },
    })
    expect(parseWorkspaceCreateBody(body)).toEqual({ rpcId: 'r1', path: '/home/user/workspace' })
    // 白名单据此拒绝白名单外路径
    expect(workspaceAllowed(['/home/user/workspace'], parseWorkspaceCreateBody(body).path)).toBe(true)
    const outside = JSON.stringify({ rpcId: 'r2', payload: { args: { path: '/tmp/evil' } } })
    expect(workspaceAllowed(['/home/user/workspace'], parseWorkspaceCreateBody(outside).path)).toBe(false)
  })

  it('旧宿主信封 payload.path 仍兼容；缺路径/坏 JSON → path undefined（白名单非空即拒绝）', () => {
    expect(parseWorkspaceCreateBody(JSON.stringify({ rpcId: 'r3', payload: { path: '/w/a' } })))
      .toEqual({ rpcId: 'r3', path: '/w/a' })
    expect(parseWorkspaceCreateBody(JSON.stringify({ rpcId: 'r4', payload: { args: {} } })))
      .toEqual({ rpcId: 'r4' })
    expect(parseWorkspaceCreateBody('not-json')).toEqual({ rpcId: 'unknown' })
    expect(workspaceAllowed(['/home/user/workspace'], undefined)).toBe(false)
  })
})

describe('v1.22.1: 信任栅栏修复（Origin 与 Host 同源）', () => {
  it('反代头：Host + Origin 都改写为 loopback 主端口', () => {
    const headers = buildProxyHeaders(
      { host: '192.0.2.31:3081', origin: 'http://192.0.2.31:3081', cookie: 'a=b' },
      3080,
    )
    expect(headers.host).toBe('127.0.0.1:3080')
    expect(headers.origin).toBe('http://127.0.0.1:3080')
    expect(headers.cookie).toBe('a=b') // 其余头保留
  })

  it('bodyOverride → content-length 更新', () => {
    const headers = buildProxyHeaders({ host: 'x:3081' }, 3080, '{"rpcId":"r1"}')
    expect(headers['content-length']).toBe(Buffer.byteLength('{"rpcId":"r1"}'))
  })

  it('信任栅栏等价性：Origin.host === Host（DSH isTrustedApiRequest 判定条件）', () => {
    const headers = buildProxyHeaders({ host: '192.0.2.31:3081', origin: 'http://192.0.2.31:3081' }, 3080)
    const originHost = new URL(String(headers.origin)).host
    const hostValue = String(headers.host)
    expect(originHost).toBe(hostValue) // 修复前 origin=192.0.2.31:3081 ≠ 127.0.0.1:3080 → 403
  })
})

describe('v1.22.3: 外部连接中断崩溃修复（S142 实测：Unhandled ECONNRESET → 进程崩溃）', () => {
  // 回归防护：gateway 反代链路的客户端侧 req/res/socket 必须挂 'error' 监听。
  // Node 对无监听器的 'error' 事件直接 throw（node:events:497）→ 整个 dsh web 进程崩溃。
  // 验证方式：源文件必须包含这些监听注册（防止未来重构删除）。
  it('proxy 链路：客户端 req/res 挂 error 监听 + 透传 upstream 挂 error', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway', 'server.ts'), 'utf-8')
    const proxyBody = src.split("const proxy = ")[1] ?? ''
    // req error → 销毁 target
    expect(proxyBody).toMatch(/req\.on\('error'/)
    // res error → 销毁 target
    expect(proxyBody).toMatch(/res\.on\('error'/)
    // 透传路径 upstream error → 销毁 res（HTML/workspace.list 分支原本就有）
    expect(src).toMatch(/upstream\.on\('error'/)
  })

  it('WS upgrade 链路：客户端 socket 与上游 usocket 都挂 error 监听', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway', 'server.ts'), 'utf-8')
    const upgradeBody = src.split("server.on('upgrade'")[1] ?? ''
    // 客户端 socket error → 销毁上游
    expect(upgradeBody).toMatch(/socket\.on\('error'/)
    // 上游 usock error → 销毁客户端 socket
    expect(upgradeBody).toMatch(/usock\.on\('error'/)
  })

  it('登录 POST 分支 req/res 挂 error 监听', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway', 'server.ts'), 'utf-8')
    const loginBody = src.split("'/serenity/login'")[1] ?? ''
    expect(loginBody).toMatch(/req\.on\('error'/)
    expect(loginBody).toMatch(/res\.on\('error'/)
  })

  it('server 级 clientError 兜底监听存在（C4 块 A 起：归面宿主 face-host.ts）', () => {
    // C4（2026-09-15）：该兜底原本内联在 gateway/server.ts 的 listenWithRetry 里；listener 生命周期
    // 归一到 `surface/faces.ts` 后，**守护的对象没变**（server 级 clientError → 静默销毁 socket，
    // 防"无 error 监听的 socket 直接 throw → 进程崩溃"），只是位置从面内搬到面宿主。
    // 本断言随代码位置迁移（回归钉保留：不许静默消失）。
    const src = readFileSync(join(__dirname, '..', 'src', 'surface', 'faces.ts'), 'utf-8')
    expect(src).toMatch(/server\.on\('clientError'/)
    // 且 gateway/server.ts 不再自持一份（同一卸载语义两套实现 = C4 要收的重复形态）
    const gw = readFileSync(join(__dirname, '..', 'src', 'gateway', 'server.ts'), 'utf-8')
    expect(gw).not.toMatch(/server\.on\('clientError'/)
  })
})

describe('v1.28.2: transformHtmlForProxy（HTML 注入 + content-encoding 解压——S142 白屏根因修复）', () => {
  const gzip = (s: string): Buffer => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('node:zlib') as typeof import('node:zlib')
    return zlib.gzipSync(Buffer.from(s, 'utf-8'))
  }
  const sample = (): string => '<!doctype html><html><head><title>t</title></head><body>x</body></html>'

  it('明文 HTML → 注入 polyfill + 重算 content-length（去 transfer-encoding）', () => {
    const res = transformHtmlForProxy(Buffer.from(sample(), 'utf-8'), {
      'content-type': 'text/html; charset=utf-8',
      'transfer-encoding': 'chunked',
    })
    expect(res).not.toBeNull()
    expect(res!.body).toContain('randomUUID')
    expect(res!.body).toContain('</head>')
    expect(res!.headers['content-length']).toBe(Buffer.byteLength(res!.body))
    expect(res!.headers['transfer-encoding']).toBeUndefined()
    expect(res!.headers['content-encoding']).toBeUndefined()
  })

  it('gzip HTML → 解压后注入（不破坏压缩流——白屏根因回归）', () => {
    const compressed = gzip(sample())
    const res = transformHtmlForProxy(compressed, {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
    })
    expect(res).not.toBeNull()
    // 注入后是明文完整 HTML（含 </head> 插入的 polyfill），非乱码
    expect(res!.body).toContain('randomUUID')
    expect(res!.body).toContain('</head>')
    expect(res!.body).toContain('<body>x</body>')
    expect(res!.headers['content-encoding']).toBeUndefined()
    expect(res!.headers['content-length']).toBe(Buffer.byteLength(res!.body))
  })

  it('br HTML → 解压后注入', () => {
    const zlib = require('node:zlib') as typeof import('node:zlib')
    const compressed = zlib.brotliCompressSync(Buffer.from(sample(), 'utf-8'))
    const res = transformHtmlForProxy(compressed, {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'br',
    })
    expect(res).not.toBeNull()
    expect(res!.body).toContain('randomUUID')
    expect(res!.headers['content-encoding']).toBeUndefined()
  })

  it('非压缩 HTML（无 content-encoding）→ 直接注入', () => {
    const res = transformHtmlForProxy(Buffer.from(sample(), 'utf-8'), { 'content-type': 'text/html' })
    expect(res).not.toBeNull()
    expect(res!.body).toContain('randomUUID')
  })

  it('gzip 解压失败（损坏数据）→ null（调用方原样透传避免破坏）', () => {
    const res = transformHtmlForProxy(Buffer.from('not-gzip-data', 'utf-8'), {
      'content-type': 'text/html',
      'content-encoding': 'gzip',
    })
    expect(res).toBeNull()
  })

  it('幂等：已注入的 HTML 不重复注入', () => {
    const once = transformHtmlForProxy(Buffer.from(sample(), 'utf-8'), {})
    const twice = transformHtmlForProxy(Buffer.from(once!.body, 'utf-8'), {})
    expect(twice!.body).toBe(once!.body)
  })
})

/**
 * C4 块 A 验收：**面 B（3081 网关）冒烟**——真起 listener + 真 HTTP 往返。
 *
 * 现状取证（§⑦ 局限 1）指出：本仓此前对 gateway 只有纯函数/源文本断言
 * （`verifyGatewayLogin` / `buildProxyHeaders` / `split(src)` 形态），**没有任何**
 * "真的绑端口 + 真的发请求"的用例——B 面是四面里唯一没有冒烟的。
 * 本组补齐：登录页（真实 GET）→ 登录（真实 POST，302 + 会话 cookie）→
 * 已登录反代（真实 GET → 打到 stub 主端口，拿到上游响应体）。
 */
describe('C4 块 A：面 B 冒烟（真实 listener + 真实 HTTP 往返）', () => {
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

  it('登录页 GET → 登录 POST(302 + 会话 cookie) → 已登录 GET 反代到主端口', async () => {
    // v1.34.1 修 flake（块 3）：两个端口都改为**内核分配 + 读回**，不再用 `7800 + random(300)` 猜端口段
    // ——撞端口会造成 EADDRINUSE ⇒ 面宿主重试 10s > 本用例超时/5s 单测超时 ⇒ 挂死。
    //
    // 主端口替身（真实 DSH WebUI 的位置）：listen(0) → 读回实际端口
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

    const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gateway-smoke-'))
    const cfgPath = join(cfgDir, 'serenity-hooks.json')
    writeFileSync(cfgPath, JSON.stringify({
      gateway: {
        enabled: true,
        host: '127.0.0.1',
        port: 0, // gateway 侧同样内核分配（`toWire`/`readAdvancedSettings` 对 0 无过滤，见 config-ops.ts:193）
        accounts: [totpAccount('tester')],
        totpEnabled: true,
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
    try {
      registerGateway(ctx as never)
      // 真实 listener 起来了（异步 sync → 等 active 表）
      await vi.waitFor(() => expect(faceActive('gateway')).toBe(true), { timeout: 5000 })
      const gwPort = facePort('gateway') ?? 0 // 实际监听端口（状态真相源）
      expect(gwPort).toBeGreaterThan(0)

      // ① 未登录 → 内嵌登录页（真实 HTTP 往返 + CSRF cookie）
      const page = await raw({ port: gwPort, method: 'GET', path: '/' })
      expect(page.status).toBe(200)
      expect(page.body).toContain('<input id="f-user"')
      const setCookie = String(page.headers['set-cookie'] ?? '')
      const csrf = /serenity_csrf=([^;]+)/.exec(setCookie)?.[1] ?? ''
      expect(csrf).not.toBe('')

      // ② 登录 POST → 302 + 会话 cookie（CSRF 双提交：cookie + 头同值）
      const login = await raw({
        port: gwPort,
        method: 'POST',
        path: '/serenity/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
          cookie: `serenity_csrf=${csrf}`,
        },
        body: totpLoginBody('tester'),
      })
      expect(login.status).toBe(302)
      const sessionToken = /serenity_session=([^;]+)/.exec(String(login.headers['set-cookie'] ?? ''))?.[1] ?? ''
      expect(sessionToken).not.toBe('')

      // ③ 已登录 → 反代到主端口（拿到上游响应体 = 真往返）
      const proxied = await raw({
        port: gwPort,
        method: 'GET',
        path: '/',
        headers: { cookie: `serenity_session=${sessionToken}` },
      })
      expect(proxied.status).toBe(200)
      expect(proxied.body).toBe('upstream-main-body')

      // ④ A↔C 解耦回归钉：3081 上**没有** 3082 的本地业务路由——/health 被当普通路径反代
      //（若把 3082 的端点挂进来，这里会拿到 { ok:true, port:3082 } 而不是上游响应体）
      const health = await raw({
        port: gwPort,
        method: 'GET',
        path: '/health',
        headers: { cookie: `serenity_session=${sessionToken}` },
      })
      expect(health.body).toBe('upstream-main-body')
      expect(health.body).not.toContain('"ok":true')
    } finally {
      stopAllFaces()
      __setSimpleSourceForTest(null)
      if (prevCfg === undefined) delete process.env.SERENITY_HOOKS_CONFIG
      else process.env.SERENITY_HOOKS_CONFIG = prevCfg
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      rmSync(cfgDir, { recursive: true, force: true })
    }
  }, 15_000)
})

/**
 * 🔴 v1.22.3 崩溃防护的**语义化**验收（2026-09-25 · ⑤ 语义深度 · 对应地图 §3-9 #10「接线钉」）。
 *
 * 上文那组接线钉（`readFileSync(src)` ＋ `toMatch(/req\.on\('error'/)`）只能证明**那句话被写在文件里**，
 * 证不了**这条链真的生效** —— 而它的失效形态是**整个 dsh web 进程崩掉**（v1.22.3 线上实测事故）。
 * ⇒ 本组不复用任何源码字符串，改为**真实 listener ＋ 真实 socket 硬断（RST）**跑两条真实路径
 * （反代 HTTP ／ WS upgrade），断言**崩溃回归**这一半：**中断之后进程与面都还活着、还能正常反代**。
 * 若 error 链失效，失效形态是**进程级**的（Node 直接 throw），本用例根本走不到断言处。
 *
 * 🆕 🔴 **本组顺带实测到的一条发现（2026-09-25，真 socket；已登记，不写成断言）**：
 *   客户端 RST 之后，**上游那一侧并没有被销毁** ——
 *   ① 反代路径：上游请求悬挂（`/hold` 那条 5s 内仍未被 abort）；
 *      **机制已定位**（探针实测）：网关 `proxy()` 是 `req.pipe(target)` ⇒ 请求**已 complete**，
 *      而 Node 只对"**未读完**的请求"在 socket 出错时补发 `req`/`res` 的 `error`
 *      （对照实验：处理器**不读**请求 ⇒ `req:error` 触发；**pipe 读完** ⇒ 一个事件都不触发）
 *      ⇒ `req.on('error')` / `res.on('error')` 这两条**在这条最常见路径上不会触发**。
 *   ② WS upgrade 路径：上游 usock 1.5s 内未关闭；**原因未定位**
 *      （复刻探针本身不成立 = 读数器失败 ⇒ 不作判据，不下结论）。
 *   ⇒ 处置不在本回合：这是**行为缺口**（不是死代码），归 §3-9 #10 / SESSION.md S142 待裁。
 *
 * 🔵 **诚实边界（I7）**：本组断言的是**可观测不变量（进程不崩 ＋ 面可用）**；上述"对端未销毁"实测读数
 * **故意不写成断言** —— 断言会把它固化成"期望行为"。要定位 ② 需在源码里插桩（本回合未做）。
 * ⚠️ 因此本组与上文接线钉是**互补**关系，不是替代：接线钉管"实现还在"，本组管"崩没崩"。
 */
describe('v1.22.3 语义化：外部连接硬断不崩（真 socket ＋ 真上游）', () => {
  interface UpstreamProbe {
    server: import('node:http').Server
    mainPort: number
    holdSeen: boolean
    holdTornDown: boolean
    upgradeSeen: boolean
    upgradeTornDown: boolean
  }

  /** 上游替身：`/hold` 故意**不响应**（悬挂）；`upgrade` 回 101；其余回固定体。 */
  async function startUpstream(): Promise<UpstreamProbe> {
    const probe: UpstreamProbe = {
      server: undefined as never,
      mainPort: 0,
      holdSeen: false,
      holdTornDown: false,
      upgradeSeen: false,
      upgradeTornDown: false,
    }
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/hold')) {
        probe.holdSeen = true
        // 两种"对端不在了"的读数都收：Node 世代不同时给 'aborted' 或 'close'+未 end
        req.on('aborted', () => { probe.holdTornDown = true })
        res.on('close', () => { if (!res.writableEnded) probe.holdTornDown = true })
        return // 故意不响应 ⇒ 请求悬挂到客户端断连为止
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('upstream-main-body')
    })
    server.on('upgrade', (_req, sock) => {
      probe.upgradeSeen = true
      sock.on('close', () => { probe.upgradeTornDown = true })
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
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

  type RawRes = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

  function raw(opts: { port: number; method: string; path: string; headers?: Record<string, string> }): Promise<RawRes> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** 起真网关（内核分配端口）＋ 真登录，返回 { gwPort, token, cleanup }。 */
  async function boot(probe: UpstreamProbe): Promise<{ gwPort: number; token: string; cleanup: () => Promise<void> }> {
    const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-abort-'))
    const cfgPath = join(cfgDir, 'serenity-hooks.json')
    writeFileSync(cfgPath, JSON.stringify({
      gateway: {
        enabled: true,
        host: '127.0.0.1',
        port: 0, // 内核分配（同 C4 冒烟：不猜端口段，防 EADDRINUSE ⇒ 面宿主重试 10s 挂死）
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
    const loginRes = await new Promise<RawRes>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port: gwPort, method: 'POST', path: '/serenity/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf, cookie: `serenity_csrf=${csrf}` },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
      })
      req.on('error', reject)
      req.end(totpLoginBody('tester'))
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
        // 🔴 cleanup 绝不允许挂住：**悬挂的连接会让 `server.close()` 永不回调**，
        // 于是"断言失败"会被伪装成"用例超时"（20s），真因被吞掉（本用例首跑就踩了这个）。
        probe.server.closeAllConnections()
        await new Promise<void>((resolve) => {
          probe.server.close(() => resolve())
          setTimeout(resolve, 1000) // 有界兜底：1s 内没关干净也往下走
        })
        rmSync(cfgDir, { recursive: true, force: true })
      },
    }
  }

  it('① 反代链路：客户端 RST ⇒ **进程不崩 ＋ 网关仍可用**（真 socket ＋ 真上游）', async () => {
    const probe = await startUpstream()
    const { gwPort, token, cleanup } = await boot(probe)
    try {
      // 裸 socket 发一个会悬挂的反代请求（上游 /hold 不响应），确认请求**真到了上游**
      const sock = netConnect({ host: '127.0.0.1', port: gwPort })
      sock.on('error', () => { /* 我们主动 RST，错误是预期内的 */ })
      sock.write(`GET /hold HTTP/1.1\r\nHost: 127.0.0.1:${gwPort}\r\nCookie: serenity_session=${token}\r\nConnection: keep-alive\r\n\r\n`)
      await vi.waitFor(() => expect(probe.holdSeen).toBe(true), { timeout: 5000 })

      // 🔴 硬断（RST，不是 FIN —— 生产事故的形态就是 ECONNRESET）
      sock.resetAndDestroy()

      // 🔴 语义断言：**进程与面都还活着** —— 中断之后再要一次，仍能拿到上游响应体。
      //    这正是 v1.22.3 事故的本体（"无人监听 'error' → Node 直接 throw → 整个进程崩"）：
      //    若那条链失效，本用例会在**进程级**炸掉，而不是在这里拿到 200。
      await vi.waitFor(async () => {
        const after = await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
        expect(after.status).toBe(200)
        expect(after.body).toBe('upstream-main-body')
      }, { timeout: 5000 })

      // ⚠️ **不断言的一半（诚实边界）**：RST 之后上游那条请求**并未被销毁**（本回合实测
      //    `probe.holdTornDown` 恒 false；机制见 SESSION.md S142「⑤ 语义深度」与地图 §3-9 #10）。
      //    不写成断言 = 不把"当前缺陷"固化成"期望行为"；该读数已作为**发现项**登记。
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('② WS upgrade：客户端 socket RST ⇒ **进程不崩、网关仍可用**（真握手 ＋ 真管道）', async () => {
    const probe = await startUpstream()
    const { gwPort, token, cleanup } = await boot(probe)
    try {
      const sock = netConnect({ host: '127.0.0.1', port: gwPort })
      sock.on('error', () => { /* 主动 RST */ })
      let handshake = ''
      sock.on('data', (c: Buffer) => { handshake += c.toString('utf-8') })
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${gwPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: serenity_session=${token}\r\n\r\n`,
      )
      await vi.waitFor(() => expect(probe.upgradeSeen).toBe(true), { timeout: 5000 })
      // 101 真的被回写（= 网关把上游的握手透传回来了 ⇒ 双向 pipe 已建立）
      await vi.waitFor(() => expect(handshake).toContain('101'), { timeout: 5000 })

      // upgrade 后的客户端 socket 已脱离 http 生命周期 ⇒ 这条路径正是"无人监听 'error' 就崩"的现场
      sock.resetAndDestroy()

      // 🔴 语义断言 = 进程/面未崩：中断之后 HTTP 侧仍能正常反代
      await vi.waitFor(async () => {
        const after = await raw({ port: gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
        expect(after.body).toBe('upstream-main-body')
      }, { timeout: 5000 })

      // ⚠️ **不断言的一半**：RST 之后上游 usock **未在 1.5s 内关闭**（本回合实测 `probe.upgradeTornDown` false）。
      //    原因**未定位**（复刻件不成立 = 读数器失败 ⇒ 不作判据）；已登记为发现项。
    } finally {
      await cleanup()
    }
  }, 20_000)
})

/**
 * ⑤ 第 11 件（登录面集成，2026-09-25）：上文各 describe 已把登录**纯逻辑**逐件覆盖（verifyGatewayLogin ／
 * token ／ 锁定计数 ／ CSRF ／ loginPageHtml ／ TOTP），但**装配层那一段**（`startGateway` 的登录 POST
 * 分支——CSRF 双提交判定 → 锁定前置 → 密码/TOTP 二选一 → 失败计数与三档响应 ／ 登出吊销）从未被
 * **真 listener** 走到：覆盖率报告显示 gateway/server.ts 该段全为 `fstat-no`（同批未测的还有 `readBody`，
 * 归 workspace.create 那一组）。
 * ⇒ 本组用**真 HTTP 往返**补齐这条装配链，断言取"客户端看到什么"（状态码 ＋ 响应体文案 ＋ 回注的 csrf
 * cookie ＋ 会话 cookie 是否真能换来反代），**不复用任何源码字符串**。
 *
 * 🔴 两条负控（防空跑）：
 *   ① `totpEnabled=false` 那例里，同一账号**用密码仍能登录**（证明 401 来自"未启用不接受 TOTP"，
 *      不是夹具坏了/账号不存在）；
 *   ② 锁定那例里，前 4 次失败的**文案与首次不同**（证明 401 的分档真的存在）。
 */
describe('面 B 集成：登录三态 / 账号锁定 / TOTP 二选一与防重放 / 登出吊销（真 listener）', () => {
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

  /** 起真网关（内核分配端口）＋ 一个只回固定体的上游替身（登录面之外的路径用它证明会话真有效）。 */
  async function boot(cfg: { accounts: unknown[]; totpEnabled?: boolean }): Promise<{ gwPort: number; cleanup: () => Promise<void> }> {
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
    const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-login-'))
    const cfgPath = join(cfgDir, 'serenity-hooks.json')
    writeFileSync(cfgPath, JSON.stringify({
      gateway: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        accounts: cfg.accounts,
        ...(cfg.totpEnabled === true ? { totpEnabled: true } : {}),
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
        // cleanup 绝不允许挂住（悬挂连接会让 close() 永不回调 ⇒ 真因被"用例超时"吞掉）
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => {
          upstream.close(() => resolve())
          setTimeout(resolve, 1000)
        })
        rmSync(cfgDir, { recursive: true, force: true })
      },
    }
  }

  /** 取一次登录页的 csrf（真往返；每次重试都取新的——旧 token 仍有效，但取新更贴浏览器行为）。 */
  async function freshCsrf(gwPort: number): Promise<string> {
    const page = await raw({ port: gwPort, method: 'GET', path: '/' })
    expect(page.status).toBe(200)
    const csrf = cookieOf(page, 'serenity_csrf')
    expect(csrf).not.toBe('')
    return csrf
  }

  async function postLogin(gwPort: number, body: string, csrf?: string): Promise<RawRes> {
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

  /** RFC 4226 官方向量的种子（与 tests/totp.test.ts 同源，便于两处读数互相印证）。 */
  const TOTP_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
  const currentTotpCode = (): string => totpCode(TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS))

  it('① CSRF 缺失 → 403 ＋ 回注新 csrf（重试表单不再是 missing）', async () => {
    const h = await boot({ accounts: [totpAccount('tester')], totpEnabled: true })
    try {
      // 无 csrf cookie、无表单字段、无 x-csrf-token（= 跨站伪造/直接 curl 的形态）
      const res = await postLogin(h.gwPort, totpLoginBody('tester'))
      expect(res.status).toBe(403)
      expect(res.body).toContain('会话校验失败')
      expect(res.body).not.toContain('upstream-main-body')
      const retry = cookieOf(res, 'serenity_csrf')
      expect(retry).not.toBe('')
      // v1.24.9 的意义就在这一条：失败页把**新的** csrf 注进表单 ⇒ 用户直接重试即可，不再 missing
      expect(res.body).toContain(`name="csrf" value="${retry}"`)
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('② 验证码错 → 401；第 5 次失败起文案转「已锁定」；再试 → 429 ＋ retry-after', async () => {
    // 账号名专用于本用例：失败状态是**模块级按 user 存**的（跨用例污染会让计数不确定）
    const h = await boot({ accounts: [totpAccount('lock-user', 'lk1')], totpEnabled: true })
    try {
      // 🔴 v1.119.0：失败形态从"密码错"改成"验证码错"（口令已退役）
      const first = await postLogin(h.gwPort, 'user=lock-user&code=000000', await freshCsrf(h.gwPort))
      expect(first.status).toBe(401)
      expect(first.body).toContain('用户名或验证码错误')
      expect(cookieOf(first, 'serenity_csrf')).not.toBe('')

      // 再失败 4 次（合计 5 = FAIL_LOCK_THRESHOLD）⇒ 第 5 次的响应**已经带着锁定文案**回来
      let fifth: RawRes | undefined
      for (let i = 0; i < 4; i++) {
        fifth = await postLogin(h.gwPort, 'user=lock-user&code=000000', await freshCsrf(h.gwPort))
      }
      expect(fifth?.status).toBe(401)
      expect(fifth?.body).toContain('尝试过多，账号已锁定')
      expect(fifth?.body).not.toContain('用户名或验证码错误')

      // 已锁定 ⇒ **验证码正确也不放行**（锁定前置在凭据校验之前）
      const locked = await postLogin(h.gwPort, totpLoginBody('lock-user'), await freshCsrf(h.gwPort))
      expect(locked.status).toBe(429)
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
      expect(locked.body).toContain('账号已锁定，请')
      expect(locked.body).not.toContain('upstream-main-body')
    } finally {
      await h.cleanup()
    }
  }, 25_000)

  it('③ TOTP 登录 → 302 ＋ 会话可用 ＋ cookie 带 Max-Age（记住登录）；同 counter 重放 → 401', async () => {
    const h = await boot({ accounts: [totpAccount('totp-user', 't1')], totpEnabled: true })
    try {
      const ok = await postLogin(h.gwPort, totpLoginBody('totp-user'), await freshCsrf(h.gwPort))
      expect(ok.status).toBe(302)
      expect(String(ok.headers.location)).toBe('/')
      const token = cookieOf(ok, 'serenity_session')
      expect(token).not.toBe('')

      // 🔴 v1.119.0 新增判据：cookie **必须带 Max-Age**（否则关浏览器即掉线 = owner 说的"记住"没做到）
      //    且 Max-Age 必须与 SESSION_ABSOLUTE_TTL_MS 同源 —— ⛔ 不是随便一个正数
      const setCookie = String(ok.headers['set-cookie'])
      const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1] ?? 0)
      expect(maxAge).toBe(Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000))

      // 会话真有效（不是"只回了个 302"）：拿它反代拿得到上游体
      const proxied = await raw({ port: h.gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(proxied.body).toBe('upstream-main-body')

      // 防重放：同一 code 再来一次 ⇒ 不接受（同 counter 已在 lastTotpCounter 里）
      const replay = await postLogin(h.gwPort, totpLoginBody('totp-user'), await freshCsrf(h.gwPort))
      expect(replay.status).toBe(401)
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('④ 负控：totpEnabled=false → 正确 code 也不接受；且**口令也不再放行**（两把钥匙都没了）', async () => {
    const h = await boot({
      accounts: [totpAccount('totp-off-user', 't2')],
      // 刻意不给 totpEnabled ⇒ 安全默认 = 未配置即不可用
    })
    try {
      const res = await postLogin(h.gwPort, totpLoginBody('totp-off-user'), await freshCsrf(h.gwPort))
      expect(res.status).toBe(401)
      expect(res.body).toContain('用户名或验证码错误')

      // 🔴 反向钉（v1.119.0 的核心）：口令字段**即使正确也不放行**。
      //    这条是本次改造的**判别力所在** —— 若哪天有人把 passOk 加回去，这里立刻红。
      const pwAttempt = await postLogin(h.gwPort, 'user=totp-off-user&password=pw', await freshCsrf(h.gwPort))
      expect(pwAttempt.status).toBe(401)
      expect(cookieOf(pwAttempt, 'serenity_session')).toBe('')
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('⑤ 登出 POST → 302 ＋ 清 cookie（Max-Age=0）；旧 token 随即失效', async () => {
    const h = await boot({ accounts: [totpAccount('tester')], totpEnabled: true })
    try {
      const login = await postLogin(h.gwPort, totpLoginBody('tester'), await freshCsrf(h.gwPort))
      expect(login.status).toBe(302)
      const token = cookieOf(login, 'serenity_session')
      expect(token).not.toBe('')

      const before = await raw({ port: h.gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(before.body).toBe('upstream-main-body')

      const out = await raw({ port: h.gwPort, method: 'POST', path: '/serenity/logout', headers: { cookie: `serenity_session=${token}` } })
      expect(out.status).toBe(302)
      expect(String(out.headers.location)).toBe('/')
      expect(String(out.headers['set-cookie'])).toContain('Max-Age=0')

      // 吊销是真的（不是只清了客户端 cookie）：服务端也不认这个 token 了 ⇒ 回到登录页
      const after = await raw({ port: h.gwPort, method: 'GET', path: '/', headers: { cookie: `serenity_session=${token}` } })
      expect(after.status).toBe(200)
      expect(after.body).toContain('<input id="f-user"')
      expect(after.body).not.toContain('upstream-main-body')
    } finally {
      await h.cleanup()
    }
  }, 20_000)
})

/**
 * ⑤ 第 12 件（反代面集成，2026-09-25）：上一组补的是**登录面**，本组补**已登录之后的三个装配分支**
 * ——它们在覆盖率报告里同批是 `fstat-no`/未执行：
 *   ① **HTML 注入反代**（`proxy()` 里 `status===200 && text/html` 那一支）：函数级 `transformHtmlForProxy`
 *      早有单测，但**装配层这段接线**（取 chunks → 变换 → `writeHead(transformed.headers)` → `end(body)`）
 *      从未被执行 ⇒ v1.28.2「gzip HTML 被当文本注入 → 白屏」这条**线上事故**此前没有端到端回归钉。
 *   ② **workspace.create 三态**（禁建 ／ 白名单拒 ／ 放行转发）：`readBody` 与 `bodyOverride` 重放同批。
 *   ③ **PUT /serenity/config 的跨源拒绝**（v1.22.4 S3）。
 *
 * 断言全部取"客户端看到什么"（状态码 ／ 响应头 ／ 响应体字节），**不复用源码字符串**。
 * 🔴 每条拒绝类断言都配**同夹具的正控**（例如同为 POST workspace/create，白名单内路径必须 200），
 * 否则"403 通过"可能只是夹具坏了。
 */
describe('面 B 集成：HTML 注入反代（含 gzip 白屏根因）/ workspace.create 三态 / 跨源配置写拒绝（真 listener）', () => {
  type RawRes = { status: number; headers: Record<string, string | string[] | undefined>; body: string; buf: Buffer }

  /** 上游 HTML（明文），供注入路径使用 */
  const PLAIN_HTML = '<!doctype html><html><head><title>t</title></head><body>hello-upstream</body></html>'
  /** 损坏的 gzip 字节（解压必失败）——用于钉"失败即原样透传，绝不注入" */
  const CORRUPT_GZ = Buffer.from('this-is-not-gzip-at-all', 'utf-8')

  function raw(opts: { port: number; method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawRes> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf.toString('utf-8'), buf })
          })
        },
      )
      req.on('error', reject)
      req.end(opts.body)
    })
  }

  const cookieOf = (res: RawRes, name: string): string =>
    new RegExp(`${name}=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''))?.[1] ?? ''

  const POLYFILL_MARKER = 'data-sp-randomuuid-polyfill'

  interface ProxyHarness { gwPort: number; mainPort: number; token: string; cleanup: () => Promise<void> }

  /** 起真网关 + 按路径分派的上游替身（HTML 明文 ／ gzip ／ 坏 gzip ／ 500 ／ 回显式 create 端点）。 */
  async function bootProxy(cfg: { workspaces?: string[]; allowWorkspaceCreate?: boolean }): Promise<ProxyHarness> {
    const upstream = createServer((req, res) => {
      const path = req.url ?? '/'
      if (path.startsWith('/html-gz')) {
        const gz = gzipSync(Buffer.from(PLAIN_HTML, 'utf-8'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
        res.end(gz)
        return
      }
      if (path.startsWith('/html-bad-gz')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
        res.end(CORRUPT_GZ)
        return
      }
      if (path.startsWith('/html-500')) {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PLAIN_HTML)
        return
      }
      if (path.startsWith('/html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PLAIN_HTML)
        return
      }
      if (path.startsWith('/api/workspace/create')) {
        // 回显：证明网关**真的把请求体转发过来了**（bodyOverride 重放路径）
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ echoedLength: Buffer.concat(chunks).length, method: req.method }))
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('upstream-main-body')
    })
    const mainPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        const addr = upstream.address()
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })

    const cfgDir = mkdtempSync(join(tmpdir(), 'hooks-gw-proxy-'))
    const cfgPath = join(cfgDir, 'serenity-hooks.json')
    writeFileSync(cfgPath, JSON.stringify({
      gateway: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        accounts: [totpAccount('tester')],
        totpEnabled: true,
        ...(cfg.workspaces === undefined ? {} : { workspaces: cfg.workspaces }),
        ...(cfg.allowWorkspaceCreate === undefined ? {} : { allowWorkspaceCreate: cfg.allowWorkspaceCreate }),
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

    // 真登录（拿会话 token），后面的断言全部走"已登录"分支
    const page = await raw({ port: gwPort, method: 'GET', path: '/' })
    const csrf = cookieOf(page, 'serenity_csrf')
    const login = await raw({
      port: gwPort,
      method: 'POST',
      path: '/serenity/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf, cookie: `serenity_csrf=${csrf}` },
      body: totpLoginBody('tester'),
    })
    expect(login.status).toBe(302)
    const token = cookieOf(login, 'serenity_session')
    expect(token).not.toBe('')

    return {
      gwPort,
      mainPort,
      token,
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

  it('① 明文 HTML → 反代时注入 polyfill ＋ 重算 content-length（装配层接线）', async () => {
    const h = await bootProxy({})
    try {
      const res = await raw({ port: h.gwPort, method: 'GET', path: '/html', headers: { cookie: `serenity_session=${h.token}` } })
      expect(res.status).toBe(200)
      expect(res.body).toContain(POLYFILL_MARKER)
      expect(res.body).toContain('hello-upstream')
      // 注入位置：仍在 </head> 之前（不是把整页顶掉）
      expect(res.body.indexOf(POLYFILL_MARKER)).toBeLessThan(res.body.indexOf('</head>'))
      // 长度声明与实体一致（否则浏览器截断 ⇒ 白屏的另一种形态）
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body, 'utf-8'))
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('② gzip HTML → 解压后注入 ＋ 去掉 content-encoding（v1.28.2 白屏根因端到端回归钉）', async () => {
    const h = await bootProxy({})
    try {
      const res = await raw({ port: h.gwPort, method: 'GET', path: '/html-gz', headers: { cookie: `serenity_session=${h.token}` } })
      expect(res.status).toBe(200)
      // 🔴 事故形态：不解压就注入 ⇒ 压缩字节里找不到 </head> ⇒ polyfill 前置 ⇒ HTML 全毁 ⇒ 白屏。
      //    修好之后客户端应当拿到**明文**（encoding 头已去掉）＋ 注入标记 ＋ 原内容完整。
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.body).toContain(POLYFILL_MARKER)
      expect(res.body).toContain('hello-upstream')
      expect(res.body.indexOf(POLYFILL_MARKER)).toBeLessThan(res.body.indexOf('</head>'))
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body, 'utf-8'))
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('③ 解压失败（坏 gzip）→ **原样透传**：不注入、保留 content-encoding、字节逐字不变', async () => {
    const h = await bootProxy({})
    try {
      const res = await raw({ port: h.gwPort, method: 'GET', path: '/html-bad-gz', headers: { cookie: `serenity_session=${h.token}` } })
      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(res.body).not.toContain(POLYFILL_MARKER)
      expect(res.buf.equals(CORRUPT_GZ)).toBe(true) // 一个字节都没动（"宁可不解，绝不弄坏"）
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('④ 非 200 的 HTML（500）→ 不注入（注入只发生在 200 上）', async () => {
    const h = await bootProxy({})
    try {
      const res = await raw({ port: h.gwPort, method: 'GET', path: '/html-500', headers: { cookie: `serenity_session=${h.token}` } })
      expect(res.status).toBe(500)
      expect(res.body).not.toContain(POLYFILL_MARKER)
      expect(res.body).toContain('hello-upstream') // 透传仍在（错误页也要能看见上游内容）
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  // ── workspace.create 三态（禁建 ／ 白名单拒 ／ 放行转发）──

  const createBody = (rpcId: string, path: string): string =>
    JSON.stringify({ type: 'client-request', rpcId, method: 'workspace/create', payload: { args: { path } } })

  const postCreate = (h: ProxyHarness, body: string): Promise<RawRes> =>
    raw({
      port: h.gwPort,
      method: 'POST',
      path: '/api/workspace/create',
      headers: { 'content-type': 'application/json', cookie: `serenity_session=${h.token}` },
      body,
    })

  it('⑤ allowWorkspaceCreate=false → 403（禁建文案 ＋ rpcId 回显），且**不转发**给上游', async () => {
    const h = await bootProxy({ allowWorkspaceCreate: false })
    try {
      const res = await postCreate(h, createBody('r-deny', '/home/user/proj'))
      expect(res.status).toBe(403)
      const parsed = JSON.parse(res.body) as { rpcId: string; result: { ok: boolean; error: { code: string; message: string } } }
      expect(parsed.rpcId).toBe('r-deny')
      expect(parsed.result.ok).toBe(false)
      expect(parsed.result.error.code).toBe('forbidden')
      expect(parsed.result.error.message).toContain('disabled for external access')
      expect(res.body).not.toContain('echoedLength') // 没被转发（上游的回显体不该出现）
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('⑥ 白名单外的路径 → 403（allowlist 文案）；**同夹具的白名单内路径必须 200**（正控）', async () => {
    const h = await bootProxy({ workspaces: ['/home/user/workspace'] })
    try {
      const denied = await postCreate(h, createBody('r-out', '/tmp/evil'))
      expect(denied.status).toBe(403)
      expect(denied.body).toContain('workspace not in external allowlist')
      expect(denied.body).toContain('r-out')
      expect(denied.body).not.toContain('echoedLength')

      // 🔴 正控：同一夹具、同一条端点，换成白名单内路径 ⇒ 真转发（否则上面那条 403 可能只是夹具坏）
      const body = createBody('r-in', '/home/user/workspace/proj')
      const allowed = await postCreate(h, body)
      expect(allowed.status).toBe(200)
      const echoed = JSON.parse(allowed.body) as { echoedLength: number; method: string }
      expect(echoed.method).toBe('POST')
      // 白名单分支是"先读 body、再重放转发"（bodyOverride）⇒ 上游收到的长度必须与原 body 逐字等长
      expect(echoed.echoedLength).toBe(Buffer.byteLength(body, 'utf-8'))
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  it('⑦ PUT /serenity/config：跨源 Origin → 403；loopback 主端口 Origin → 放行（正控）', async () => {
    const h = await bootProxy({})
    try {
      const cross = await raw({
        port: h.gwPort,
        method: 'PUT',
        path: '/serenity/config',
        headers: { cookie: `serenity_session=${h.token}`, origin: 'https://evil.example' },
      })
      expect(cross.status).toBe(403)
      expect(cross.body).toContain('cross-origin config write rejected')

      // 🔴 正控：换成主端口 loopback Origin ⇒ 过闸（本用例里"过闸"表现为透传到上游）
      const same = await raw({
        port: h.gwPort,
        method: 'PUT',
        path: '/serenity/config',
        headers: { cookie: `serenity_session=${h.token}`, origin: `http://127.0.0.1:${h.mainPort}` },
      })
      expect(same.status).toBe(200)
      expect(same.body).toBe('upstream-main-body')
    } finally {
      await h.cleanup()
    }
  }, 20_000)
})
