/**
 * gateway/server.ts — F1 双端口网关（v1.21）+ 安全加固（v1.22.4）——**装配层**
 *
 * 需求（S142 用户拍板）：dsh web 维持 127.0.0.1 主端口现状不变，**额外监听一个端口**；
 * 额外端口需网页登录（账号+密码），登录后即原生 Web UI 使用；适应任何部署情况。
 *
 * 实现（零改 DSH）：
 *   - 插件自起第二 node:http server（host/port 走 localstore 配置，默认 0.0.0.0:3081）
 *   - 未登录 → 返回内嵌极简登录页（user + pass + submit）
 *   - POST /serenity/login → 验证账号（localstore accounts，scrypt hash）→ Set-Cookie（HttpOnly）
 *   - 已登录 → 反向代理到 http://127.0.0.1:${ctx.webServer.port}
 *     （Host 头改写成 127.0.0.1:<主端口> → 过信任栅栏；WS upgrade 转发握手 + pipe socket）
 *   - token 内存表 + HttpOnly cookie（重启即失效——用户决策"重启重新登录"）
 *
 * v1.22.4 安全加固（S142 公网审计，用户原则：不体验影响直接修/体验影响改方案/不限制 IP）：
 *   - S5：token 带过期时间（滑动 24h）+ POST /serenity/logout 主动吊销
 *   - S3：登录 POST 与配置写操作校验 Origin（同源/loopback 主端口）+ 双提交 CSRF cookie
 *   - S2：账号维度失败锁定（5 次失败 → 15 分钟，指数退避）——不按 IP（用户要求随时随地访问）
 *   - S1：可选 TOTP 第二因素（账号绑定后登录需 6 位码；Authenticator 兼容，RFC 6238）
 *   - S7：cookieSecure 配置项（反代 TLS 时开启；默认关保持明文 HTTP 可用）
 *   - S9：登录失败审计日志（时间/IP/账号/原因，console.warn）
 *
 * v1.22.8 熵点治理（S142）：认证域纯逻辑拆到 gateway/auth.ts（会话/锁定/CSRF/Origin/
 * cookie/登录页），代理辅助纯逻辑拆到 gateway/proxy.ts（polyfill/headers/workspace 过滤）；
 * 本文件只保留 HTTP 装配（startGateway/registerGateway/readBody）——re-export 两模块
 * 保持既有 import 面兼容（tests/gateway.test.ts 直接 import 两模块导出）。
 */

import type { Context } from 'cordis'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { readAdvancedSettings, migrateLegacyLocalstore } from '../kernel/config.js'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { readSimpleSettings } from '../surface/settings.js'
// C4 块 A：listener 生命周期归面宿主（本面=面 B，端口语义见 kernel/ports.ts 的 FACE_PORTS.gateway）
import { startFace, type FaceHandle } from '../surface/faces.js'
import { verifyTotpCode } from './totp.js'
import {
  loginPageHtml,
  issueToken,
  revokeToken,
  validateToken,
  // 🔴 会话**绝对**寿命上限：cookie 的 Max-Age 必须与它同源（⛔ 不写字面量，两处漂移=静默失效）
  SESSION_ABSOLUTE_TTL_MS,
  type GatewaySession,
  resetFailState,
  recordLoginFailure,
  accountLockRemaining,
  newCsrfToken,
  isCsrfValid,
  csrfFromRequest,
  originAllowed,
  cookieValue,
} from './auth.js'
import {
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  isWorkspaceCreatePath,
  parseWorkspaceCreateBody,
  buildProxyHeaders,
  transformHtmlForProxy,
} from './proxy.js'

/** 面名（C4 块 A：listener 生命周期归 `face-host`） */
const FACE_GATEWAY = 'gateway'
import { createDshCookieProvider, mergeCookieHeader, type DshCookieProvider } from './dsh-auth.js'
import { hostService, hostWebServer } from '../host/access.js'

// re-export 认证域 + 代理域（兼容既有 import 面；gateway-auth/gateway-proxy 为权威定义）
export {
  RANDOM_UUID_POLYFILL,
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  isWorkspaceCreatePath,
  parseWorkspaceCreateBody,
  buildProxyHeaders,
  transformHtmlForProxy,
} from './proxy.js'
export {
  loginPageHtml,
  // 🔴 v1.119.0：`verifyGatewayLogin` **不再导出** —— 口令登录整条退役（见 auth.ts 头注）。
  //    ⛔ 不要为了"兼容旧 import"把它加回来：那会让"口令还能用"这个错误印象继续存在。
  SESSION_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  sessionStorePath,
  issueToken,
  revokeToken,
  validateToken,
  FAIL_LOCK_THRESHOLD,
  FAIL_LOCK_BASE_MS,
  FAIL_LOCK_MAX_MS,
  getFailState,
  resetFailState,
  isAccountLocked,
  recordLoginFailure,
  accountLockRemaining,
  newCsrfToken,
  isCsrfValid,
  csrfFromRequest,
  safeEqual,
  originAllowed,
  cookieValue,
} from './auth.js'

// 自定义事件：配置 PUT 后触发 gateway 重建（跨模块松耦合通知）
declare module 'cordis' {
  interface Events {
    /** /serenity/config PUT（账号/监听/白名单变化）→ 强制重建 gateway（lastSig=null） */
    'serenity/config-updated'(): void
    /** DSH settings 简单配置变化（开关/阈值）→ 重新 sync（sig 判断，无实质变化不重建） */
    'serenity/settings-changed'(): void
  }
}

// ── 服务注册 ──

interface GatewayConfig {
  host: string
  port: number
  /** 登录态 cookie 名 */
  cookieName: string
  /** 主端口（ctx.webServer.port） */
  mainPort: number
  /** 登录失败后的重定向延迟（秒） */
  loginDelayMs: number
  /** 外部可访问的工作区路径前缀白名单（v1.22；空 = 全部允许） */
  allowWorkspaces?: string[]
  /** Cookie Secure 属性（v1.22.4；反代 TLS 时开启；明文 HTTP 下必须关，否则 cookie 不落） */
  cookieSecure?: boolean
  /** 允许外部新建工作区（v1.22.4；false = workspace.create 一律 403 RPC error） */
  allowWorkspaceCreate?: boolean
  /** 启用 Authenticator 第二因素（v1.22.4；false = TOTP 完全禁用） */
  totpEnabled?: boolean
}

/** 读取请求体（≤ maxBytes；超限 reject） */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
      if (data.length > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * 启动第二监听器（C4 块 A：listener 的创建/监听/错误/端口占用重试/关闭归 `face-host`）。
 *
 * 返回面句柄——**dispose 只关 server，不清 token**（token 模块级，进程重启自然清空；
 * 热重建清 token → 已登录用户 WS 断 + 重连 cookie 无效）。
 * @param config - 监听/代理配置。
 * @param getAccounts - 运行时读取账号列表（plugin 全局文件；gateway.enabled 开关在调用方判）。
 */
async function startGateway(
  config: GatewayConfig,
  getAccounts: () => readonly { id: string; user: string; passHash: string; totpSecret?: string }[],
  getDshCookie?: () => string | undefined,
): Promise<FaceHandle> {
  const { host, port, cookieName, mainPort, loginDelayMs } = config
  const allowWorkspaces = config.allowWorkspaces ?? []
  const cookieSecure = config.cookieSecure === true
  const allowWorkspaceCreate = config.allowWorkspaceCreate !== false
  const totpEnabled = config.totpEnabled === true

  /** 校验请求 Cookie 是否含有效 token（v1.22.4：滑动过期 + 返回会话供审计） */
  const authed = (req: IncomingMessage): GatewaySession | undefined =>
    validateToken(cookieValue(req.headers.cookie, cookieName))

  /**
   * 构造上游请求头（buildProxyHeaders 基准 + dsh browser cookie 注入）。
   * v1.28.2（0.1.2-rc.1 BrowserAuth 适配）：主端口 /api + index 需 dsh browser cookie。
   * 反代 Host 已改写 loopback（过信任栅栏）→ 只缺 cookie → 注入内存换取 cookie
   *（createDshCookieProvider 官方通道，零落盘）。无 cookie（旧 dsh/换取失败）→ 不注入向后兼容。
   */
  const upstreamHeaders = (req: IncomingMessage, bodyOverride?: string): Record<string, string | number | string[]> => {
    const headers = buildProxyHeaders(req.headers as Record<string, string | string[] | undefined>, mainPort, bodyOverride)
    const dshCookie = getDshCookie?.()
    if (dshCookie !== undefined) {
      headers.cookie = mergeCookieHeader(headers.cookie, dshCookie)
    }
    return headers
  }

  /**
   * 反向代理：改写 Host + Origin 头 → 主端口（loopback 过信任栅栏）。
   * v1.22.1 修复：DSH 信任栅栏（api-request-trust.ts isTrustedApiRequest）要求
   * **Origin.host === Host.host**——仅改写 Host（127.0.0.1:3080）而 Origin 透传
   * （http://192.168.x.x:3081）→ 不一致 → 所有 /api RPC 403（host.pickDirectory 首个暴露）。
   * 增强：
   *  - HTML 响应 → 注入 crypto.randomUUID polyfill（非安全上下文修复）
   *  - /api/workspace.list 响应 → 白名单过滤 items
   * @param bodyOverride - workspace.create 已读 body 时的重放（白名单检查后转发）
   */
  const proxy = (req: IncomingMessage, res: ServerResponse, bodyOverride?: string): void => {
    // v1.28.0 适配 0.1.2-rc.1 A2 方案 B：method/url 派生已删（原 workspace.list 过滤分支移除——
    // rc.1 无 list unary，无 HTTP 层方法可判；create 校验在装配层直接判 pathname）
    const headers = upstreamHeaders(req, bodyOverride)
    // v1.22.3 崩溃修复（S142 实测：外部连接中断 → Unhandled 'error' event → 进程崩溃）：
    // 反代链路的**客户端侧** req/res 必须挂 error 监听。外部客户端（浏览器/手机）随时会
    // 中断连接（切网络/关页面/锁屏/超时）→ socket 收到 ECONNRESET/EPIPE → 若无人监听
    // 'error' 事件，Node 直接 throw → 整个 dsh web 进程崩溃。代理语义下这些错误是
    // 正常现象：吞掉并销毁对端即可（与上游 target.on('error') 同款处理）。
    const target = httpRequest({
      host: '127.0.0.1',
      port: mainPort,
      path: req.url ?? '/',
      method: req.method,
      headers,
    }, (upstream) => {
      const status = upstream.statusCode ?? 502
      const ct = String(upstream.headers['content-type'] ?? '')

      // HTML → polyfill 注入（幂等）
      if (status === 200 && ct.includes('text/html')) {
        const chunks: Buffer[] = []
        upstream.on('data', (c: Buffer) => chunks.push(c))
        upstream.on('end', () => {
          // v1.28.2 修复（S142 白屏根因）：上游可能按 Accept-Encoding 返回 gzip/br 压缩 HTML。
          // 注入必须先在**明文**上进行——把压缩字节 toString 当文本注入会破坏压缩流
          // （找不到 </head> → polyfill 前置 → 整个 HTML 损坏 → 浏览器白屏）。
          // 处理：content-encoding 存在 → 解压为明文 → 注入 → 去掉 encoding 头 + 重算长度
          // （输出明文，浏览器接受；仅 HTML 注入路径受影响，其余透传不动）。
          let raw = Buffer.concat(chunks)
          // v1.28.2：HTML 注入统一走 transformHtmlForProxy（处理 content-encoding 解压，
          // 防 gzip 字节被当文本注入破坏——S142 白屏根因）。失败返回 null → 原样透传。
          const transformedRes = transformHtmlForProxy(raw, upstream.headers)
          if (transformedRes === null) {
            res.writeHead(status, upstream.headers)
            res.end(raw)
            return
          }
          res.writeHead(status, transformedRes.headers)
          res.end(transformedRes.body)
        })
        upstream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
        return
      }

      // workspace.list 过滤分支已删（v1.28.0 适配 0.1.2-rc.1 A2 方案 B）：
      // rc.1 workspace.list unary 整个删除（改 follow 流）——HTTP 响应层无 list 可过滤；
      // 白名单语义降为「create 校验 + 已知工作区投影（/serenity/config knownWorkspaces）」。

      // 其余 → 原样透传
      res.writeHead(status, upstream.headers)
      upstream.pipe(res)
      // 透传路径的 upstream error（对端中断）→ 静默销毁，不成为 unhandled 'error'
      upstream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
    })
    target.on('error', () => {
      try {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('502 Bad Gateway: dsh web 主端口不可达')
      } catch { /* res 已关闭 */ }
    })
    // 客户端侧 req/res error（外部连接中断）→ 静默销毁对端（代理场景正常现象）
    req.on('error', () => { try { target.destroy() } catch { /* noop */ } })
    res.on('error', () => { try { target.destroy() } catch { /* noop */ } })
    if (bodyOverride !== undefined) target.end(bodyOverride)
    else req.pipe(target)
  }

  // v1.22.4 S1b：账号 id → 最近成功 TOTP counter（防重放；模块级，重启清空）
  const lastTotpCounter = new Map<string, number>()

  // 单请求处理（路由 / 登录 / CSRF / 反代 / 白名单校验全部归本面——面宿主只做派发）
  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // ── 登出（v1.22.4 S5）：主动吊销会话 → 清除 cookie → 回登录页 ──
    if (req.method === 'POST' && url.pathname === '/serenity/logout') {
      const cookie = cookieValue(req.headers.cookie, cookieName)
      if (cookie !== undefined) revokeToken(cookie)
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure ? '; Secure' : ''}`,
      })
      res.end()
      return
    }

    // 已登录 → 全量反代（含 /serenity/* 配置接口——第二端口登录后同样可管理）
    const session = authed(req)
    if (session !== undefined) {
      // workspace 创建：① 外部新建开关（allowWorkspaceCreate=false → 一律拒绝）
      // ② 白名单校验（读 body → 检查路径 → 转发或拒绝）
      // v1.30.6（review F-03）：端点与信封按宿主 rc.1 修正——旧实现匹配
      // `/api/workspace.create` + `payload.path`，而 rc.1 是 `/api/workspace/create`
      // + `payload.args.path`，导致该分支从未命中、白名单与禁建校验完全失效。
      if (req.method === 'POST' && isWorkspaceCreatePath(url.pathname)) {
        void readBody(req, 128 * 1024).then((body) => {
          const { rpcId, path } = parseWorkspaceCreateBody(body)
          if (!allowWorkspaceCreate) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId,
              result: { ok: false, error: { code: 'forbidden', message: 'workspace creation disabled for external access', details: {} } },
            }))
            return
          }
          if (!workspaceAllowed(allowWorkspaces, path)) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(workspaceDenyResponse(rpcId))
            return
          }
          proxy(req, res, body)
        }).catch(() => {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: 'unknown', result: { ok: false, error: { code: 'bad-request', message: 'body too large', details: {} } } }))
        })
        return
      }
      // v1.22.4 S3：配置写接口（PUT /serenity/config）需 Origin 校验（防跨站 RPC 改写凭据）。
      // GET/其余透传不受影响（读操作无状态变更，跨站读取受 SameSite=Strict 保护）。
      if (req.method === 'PUT' && url.pathname === '/serenity/config') {
        if (!originAllowed(req.headers.origin, req.headers.host ?? '', mainPort)) {
          console.warn(`[serenity-hooks] 拒绝跨源配置写（Origin=${String(req.headers.origin)}）：session=${session.user}`)
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'cross-origin config write rejected' }))
          return
        }
      }
      proxy(req, res)
      return
    }

    // 登录 POST
    if (req.method === 'POST' && url.pathname === '/serenity/login') {
      let body = ''
      // v1.22.3 崩溃修复：登录 POST 的外部连接中断同样会触发 socket 'error' → 挂监听静默吞掉
      req.on('error', () => { try { res.destroy() } catch { /* noop */ } })
      res.on('error', () => { try { req.destroy() } catch { /* noop */ } })
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const user = params.get('user') ?? ''
        // ⚠️ `password` **不读**（v1.119.0 口令登录退役）。旧页面若仍提交该字段，
        // 它会被忽略 —— 这正是期望行为：字段存在不等于它有效力。
        const code = params.get('code') ?? ''
        const remote = req.socket.remoteAddress ?? 'unknown'

        // v1.22.4 S3：CSRF 双提交校验——表单字段 csrf 与 cookie serenity_csrf 都必须是
        // 服务端集合中的有效 token（v1.24.9：token 集合替代相等匹配——多标签/刷新时
        // 各自 GET 生成的 token 都有效，不再因 cookie 被最新 GET 覆盖而拒绝旧标签提交）。
        const cookieCsrf = cookieValue(req.headers.cookie, 'serenity_csrf')
        const formCsrf = csrfFromRequest(req, params)
        if (cookieCsrf === undefined || formCsrf === null || !isCsrfValid(formCsrf) || !isCsrfValid(cookieCsrf)) {
          // v1.24.8 诊断增强：cookieSecure=true 时明文 HTTP 会丢 CSRF cookie（浏览器 Secure 语义）
          console.warn(`[serenity-hooks] 登录拒绝（CSRF 校验失败）：user=${user} ip=${remote} cookieSecure=${cookieSecure ? 'on' : 'off'} cookieCsrf=${cookieCsrf === undefined ? 'missing' : 'present'} formCsrf=${formCsrf === null ? 'missing' : 'present'}`)
          // v1.24.9：失败页注入新 csrf（form + cookie 同步）——重试表单带字段，不再 missing
          const retryCsrf = newCsrfToken()
          res.writeHead(403, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `serenity_csrf=${retryCsrf}; HttpOnly; SameSite=Strict; Path=/`,
          })
          res.end(loginPageHtml('会话校验失败，请刷新页面重试' + (cookieSecure ? '（若仍失败：设置面板关闭 Secure Cookie——明文 HTTP 下必须关闭）' : ''), retryCsrf))
          return
        }

        // v1.22.4 S2：账号维度失败锁定（不按 IP——用户要求随时随地访问）。
        const lockedRemaining = accountLockRemaining(user)
        if (lockedRemaining > 0) {
          console.warn(`[serenity-hooks] 登录拒绝（账号锁定中）：user=${user} ip=${remote} 剩余=${Math.ceil(lockedRemaining / 60000)}min`)
          const retryCsrf = newCsrfToken()
          res.writeHead(429, {
            'content-type': 'text/html; charset=utf-8',
            'retry-after': String(Math.ceil(lockedRemaining / 1000)),
            'set-cookie': `serenity_csrf=${retryCsrf}; HttpOnly; SameSite=Strict; Path=/`,
          })
          res.end(loginPageHtml(`账号已锁定，请 ${Math.ceil(lockedRemaining / 60000)} 分钟后再试`, retryCsrf))
          return
        }

        const accounts = getAccounts()
        const account = accounts.find((a) => a.user === user)

        // 🔴 v1.119.0（2026-11-05 owner 令）：**账号密码登录整条退役，只认 TOTP**。
        // 原话：「砍掉账号密码登录，只允许 authenticator 登录 ⋯ 原因是加强安全性」。
        //
        // ⛔ **不要恢复 `passOk`／`verifyPassword`**。`password` 字段仍从表单读出来是为了
        //    **兼容旧页面缓存**（不报错），但**它不参与任何判定**。
        // ⚠️ `totpEnabled` 这个开关**保留**，但它现在只决定"是否启用 TOTP 登录"：
        //    关掉它 = **没有任何登录方式**（网关不可登录）。这不是缺陷，是刻意——
        //    口令没了，TOTP 再关掉就没有第二把钥匙了，此时把网关关掉才是正确操作。
        let totpOk = false
        if (totpEnabled && account !== undefined
          && typeof account.totpSecret === 'string' && account.totpSecret !== '') {
          const hit = verifyTotpCode(account.totpSecret, code)
          totpOk = hit !== null
          if (totpOk && hit !== null && lastTotpCounter.get(account.id) === hit) totpOk = false
          if (totpOk && hit !== null) lastTotpCounter.set(account.id, hit)
        }

        if (totpOk) {
          resetFailState(user)
          const token = issueToken(user)
          // 🔴 cookie 带 Max-Age ⇒ 浏览器**关闭后仍保留**（owner 要的"记住登录"）。
          //    服务端侧对应的是 SESSION_ABSOLUTE_TTL_MS（30 天硬上限），两者必须同量级：
          //    cookie 比服务端活得久 ⇒ 用户拿着一个**必死**的 cookie（表现为"莫名其妙的登录页"）。
          //    ⚠️ 取 `SESSION_ABSOLUTE_TTL_MS` 的秒数，⛔ 不写字面量（两处漂移 = 静默失效）。
          const maxAgeSec = Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${cookieSecure ? '; Secure' : ''}`,
          })
          res.end()
          console.log(`[serenity-hooks] 登录成功: user=${user} ip=${remote} via=totp`)
          return
        }

        // 失败路径：TOTP 失败计入账号锁定（防爆破）。
        // ⚠️ 账号不存在与"码错"走同一条文案——不泄露账号是否存在。
        const lockMs = recordLoginFailure(user)
        console.warn(`[serenity-hooks] 登录失败: user=${user} ip=${remote}${lockMs > 0 ? ` 锁定=${Math.ceil(lockMs / 60000)}min` : ''}`)
        const msg = lockMs > 0
          ? `尝试过多，账号已锁定 ${Math.ceil(lockMs / 60000)} 分钟`
          : '用户名或验证码错误'
        // v1.24.9：失败页注入新 csrf（form + cookie 同步）——用户重试表单带字段
        const retryCsrf = newCsrfToken()
        res.writeHead(401, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `serenity_csrf=${retryCsrf}; HttpOnly; SameSite=Strict; Path=/`,
        })
        res.end(loginPageHtml(msg, retryCsrf))
      })
      return
    }

    // 其余 → 登录页（v1.22.4：登录页注入 CSRF cookie，供登录表单双提交）
    // v1.24.8 修复：CSRF cookie **不设 Secure**（独立于 cookieSecure）——明文 HTTP 下
    // Secure cookie 浏览器规范不发送 → CSRF 校验永远失败（"会话校验失败"，用户实测）。
    // CSRF token 是短时随机会话防护（HttpOnly + SameSite=Strict + 双提交已足够），
    // 泄露无认证价值；只有登录成功的会话 token cookie 受 cookieSecure 控制。
    const csrf = newCsrfToken()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `serenity_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/`,
    })
    res.end(loginPageHtml('', csrf))
  }

  // C4 块 A：listener 由面宿主统一创建/监听（错误 / EADDRINUSE 重试 / clientError 兜底 / 关闭）
  const handle = await startFace({
    name: FACE_GATEWAY,
    port,
    host,
    // 意图 = DSH settings 的 gatewayEnabled（装配层以此门控；本处是规格自述）
    enabled: () => readSimpleSettings().gatewayEnabled,
    handler: handleRequest,
  })

  // WS upgrade 转发：主端口握手 + socket pipe
  // v1.22.1：upgrade 也过 DSH isTrustedApiRequest（Host/Origin 一致）——
  // 除 Host 外 **Origin 必须同步改写**为 loopback（浏览器 WS 握手带 Origin）。
  // v1.22.2 决定性修复（ERR_INVALID_HTTP_RESPONSE 根因）：
  //  - **必须把上游 101 状态行 + 响应头写回客户端 socket**（Node http upgrade
  //    事件不自动回写；只 pipe 数据 → 浏览器收到无头响应 → handshake 失败）
  //  - 监听 'response'（DSH 返回 403/404/426 等非 101）→ 透传普通 HTTP 响应
  //    （此前只监听 upgrade/error，非 101 时连接挂起 → ERR_INVALID_HTTP_RESPONSE）
  handle.server.on('upgrade', (req, socket, head) => {
    if (!authed(req)) {
      socket.destroy()
      return
    }
    // v1.22.3 崩溃修复（S142 实测）：upgrade 后客户端 socket 脱离 http 生命周期，
    // pipe 不传播 'error'——外部 WS 连接中断（切网络/锁屏/关页面）→ socket 收到
    // ECONNRESET/EPIPE → 无人监听 'error' → Node throw → 进程崩溃。必须在 pipe
    // 前为双向 socket 挂 error 监听（代理语义：对端断开是正常现象，静默销毁即可）。
    socket.on('error', () => {
      try { usocket?.destroy() } catch { /* noop */ }
    })
    let usocket: import('node:net').Socket | undefined
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: mainPort,
      path: req.url ?? '/',
      method: req.method,
      headers: upstreamHeaders(req),
    })
    upstream.on('upgrade', (ures, usock, uhead) => {
      usocket = usock
      // 上游 socket 同样挂 error 监听（主端口侧断开 → 静默销毁客户端侧）
      usock.on('error', () => {
        try { socket.destroy() } catch { /* noop */ }
      })
      // ① 回写 101 状态行 + 响应头（含 Sec-WebSocket-Accept 等握手字段）
      const statusLine = `HTTP/1.1 ${ures.statusCode ?? 101} ${ures.statusMessage ?? 'Switching Protocols'}\r\n`
      const headerLines = Object.entries(ures.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`)
        .join('')
      try {
        socket.write(statusLine + headerLines + '\r\n')
      } catch {
        usock.destroy()
        socket.destroy()
        return
      }
      // ② 双向 pipe：客户端 socket ↔ 上游 socket
      usock.pipe(socket)
      socket.pipe(usock)
      // ③ 握手后缓冲数据按方向转发：head=客户端已发数据 → 上游；uhead=上游已发数据 → 客户端
      if (head.length > 0) usock.write(head)
      if (uhead.length > 0) socket.write(uhead)
    })
    // ③ 非 101 响应（DSH rejectWebSocketUpgrade=403 / 426 / 404）→ 透传普通 HTTP 响应
    upstream.on('response', (ures) => {
      const chunks: Buffer[] = []
      ures.on('data', (c: Buffer) => chunks.push(c))
      ures.on('end', () => {
        const body = Buffer.concat(chunks)
        const statusLine = `HTTP/1.1 ${ures.statusCode ?? 502} ${ures.statusMessage ?? ''}\r\n`
        const headerLines = Object.entries(ures.headers)
          .filter(([k]) => !['transfer-encoding', 'connection', 'upgrade'].includes(k.toLowerCase()))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`)
          .join('')
        try {
          socket.write(statusLine + headerLines + `content-length: ${body.length}\r\n\r\n`)
          socket.write(body)
          socket.end()
        } catch {
          socket.destroy()
        }
      })
      ures.on('error', () => socket.destroy())
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  // v1.22.1 稳定性：listen 的 EADDRINUSE 重试与 clientError 兜底**已归面宿主**
  // （`surface/faces.ts` 的 `listenWithRetry` / `dispatch`；此前面只有 gateway 独享这套样板，
  //  C4 归一后四个面统一享有——见 face-host 的模块头注释）。
  return handle
}

/**
 * 构造 dsh browser cookie 提供者（v1.28.2 0.1.2-rc.1 BrowserAuth 适配）：
 * 经 ctx.connection（HostConnectionHandle）官方通道在内存换取 authority=127.0.0.1:<mainPort>
 * 的 cookie 并缓存（createDshCookieProvider 惰性换取）。connection 缺失（旧 dsh/非 web 装配）
 * → provider 返回 undefined → 反代不注入（旧形态无 BrowserAuth，天然兼容）。
 *
 * v1.28.2 修复：**connection 每次调用现取**（不绑定 sync 时点）——gateway sync 在 apply
 * 早期跑，此时 connection 服务可能尚未装配（web-app 的 URL 打印在其后）；首次反代请求
 * 到达时 connection 必已就绪。cachedProvider 缓存换取结果（同一 connection 实例）。
 */
function buildDshCookieProvider(ctx: Context, mainPort: number): DshCookieProvider {
  const authority = `127.0.0.1:${mainPort}`
  let cachedProvider: DshCookieProvider | undefined
  let diagnosed = false
  return () => {
    try {
      const connection = hostService<{ authenticatedUrl?: (baseUrl: string) => string; authorizeIndex?: (req: unknown, res: unknown) => boolean }>(ctx, 'connection')
      if (!connection || typeof connection.authenticatedUrl !== 'function' || typeof connection.authorizeIndex !== 'function') {
        if (!diagnosed) {
          diagnosed = true
          console.log('[serenity-hooks] dsh browser-auth 适配: connection ✗ 不可取（不注入 dsh cookie——旧 dsh/非 web 装配兼容）')
        }
        return undefined
      }
      if (cachedProvider === undefined) {
        cachedProvider = createDshCookieProvider(
          connection as Parameters<typeof createDshCookieProvider>[0],
          authority,
        )
      }
      const cookie = cachedProvider()
      if (!diagnosed) {
        diagnosed = true
        console.log(`[serenity-hooks] dsh browser-auth 适配: connection ✓ 可取 + cookie ${cookie === undefined ? '✗ 换取失败（上游 401 时检查）' : '✓ 已内存换取（注入反代）'}`)
      }
      return cookie
    } catch {
      return undefined
    }
  }
}

/** 注册 gateway（index.ts apply 调用）。
 * 归属原则（v1.22）：gateway 是 plugin 全局能力——enabled 开关读 DSH settings
 * （readSimpleSettings().gatewayEnabled），host/port/accounts 读 plugin 全局文件
 * （readAdvancedSettings()，~/.dsh/serenity-hooks.json）。**不依赖任何具体 CCC**。
 * 幂等 sync：仅当 配置/端口/开关 变化时重建监听器。
 * 事件驱动：config-updated（/serenity/config PUT 后 emit）+ DSH settings 变化（onChange emit）触发重新 sync。
 */
export function registerGateway(ctx: Context): void {
  let current: FaceHandle | null = null
  let lastSig: string | null = null
  /** 串行化：配置驱动的重建不并发（重建 = dispose + startFace，两个 sync 交叠会互相关掉对方） */
  let queue: Promise<void> = Promise.resolve()

  const doSync = async (): Promise<void> => {
    // F-06：宿主访问收口——原先此处裸写 (ctx as unknown as {get}).get('webServer')
    const webServer = hostWebServer(ctx)
    if (!webServer?.port) return

    const enabled = readSimpleSettings().gatewayEnabled
    const settings = readAdvancedSettings()
    // 签名：enabled + host + port + 账号数 + 白名单（配置变化才重启）
    const sig = `${enabled}|${settings.gateway.host}|${settings.gateway.port}|${settings.gateway.accounts.length}|${settings.gateway.workspaces.join(',')}|${webServer.port}`
    if (sig === lastSig) return
    lastSig = sig

    // 停旧
    if (current) {
      current.dispose()
      current = null
    }
    if (!enabled) {
      console.log('[serenity-hooks] gateway 已停止（gatewayEnabled=false，可在 dsh 设置面板开启）')
      return
    }
    const handle = await startGateway(
      {
        host: settings.gateway.host,
        port: settings.gateway.port,
        cookieName: 'serenity_session',
        mainPort: webServer.port,
        loginDelayMs: 0,
        allowWorkspaces: settings.gateway.workspaces,
        cookieSecure: settings.gateway.cookieSecure === true,
        allowWorkspaceCreate: settings.gateway.allowWorkspaceCreate !== false,
        totpEnabled: settings.gateway.totpEnabled === true,
      },
      () => readAdvancedSettings().gateway.accounts,
      // v1.28.2（0.1.2-rc.1 BrowserAuth 适配）：内存换取 dsh browser cookie（官方通道，
      // 零落盘）→ 反代上游注入。connection 服务缺失（旧 dsh/非 web 装配）→ provider 返回
      // undefined → 不注入（旧形态无 BrowserAuth 天然兼容）。authority = 反代后 Host（loopback）。
      buildDshCookieProvider(ctx, webServer.port),
    )
    current = handle
    const accounts = settings.gateway.accounts.length
    const wsNote = settings.gateway.workspaces.length === 0
      ? ''
      : `；工作区白名单 ${settings.gateway.workspaces.length} 条`
    console.log(
      `[serenity-hooks] gateway 已启动: http://${settings.gateway.host}:${settings.gateway.port} → 127.0.0.1:${webServer.port}` +
      (accounts === 0 ? '（⚠️ 未配置账号，登录页将提示）' : `（${accounts} 个账号）`) + wsNote,
    )
  }

  const sync = (): void => {
    queue = queue.then(doSync).catch((err) => {
      console.warn(`[serenity-hooks] gateway 同步失败: ${String((err as Error)?.message ?? err)}`)
    })
  }

  // apply 即尝试（webServer 已 inject；若尚未就绪由事件兜底）
  sync()

  // 会话出现 → ① 一次性迁移旧 CCC localstore 配置（v1.21.x → v1.22 全局文件）② 兜底重同步
  // ⚠️ v0.1.7：`agent/session-start` 已被 `agent/created` 取代，且新事件 `@mode = serial`
  //    （契约要求返回 `undefined | Promise<undefined>`，裸 `void` 不被接受 ⇒ 用 `async`；
  //     函数体只做同步迁移 + 入队，无 await，不会拖慢创建）
  ctx.on('agent/created', async (payload) => {
    try {
      const cwd = (payload as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd
      if (cwd) {
        const root = cccRootForCwd(cwd)
        if (root && migrateLegacyLocalstore(root)) {
          console.log(`[serenity-hooks] ✓ 已迁移 serenityAdvanced（CCC localstore → plugin 全局文件）`)
        }
      }
    } catch {
      /* 迁移失败不影响会话 */
    }
    sync()
  })

  // 配置变化（/serenity/config PUT 后 emit 'serenity/config-updated'）→ 强制重建
  ctx.on('serenity/config-updated', () => {
    lastSig = null
    sync()
  })

  // DSH settings 简单配置变化（开关/阈值；settings-section onChange emit）→ 重新 sync
  // （不强制 lastSig=null——无实质变化的设置（如阈值拖动）不重建，避免无谓断 WS）
  ctx.on('serenity/settings-changed', () => {
    sync()
  })

  // 🔒 C4 块 A（2026-09-15）：**不自带 disposer**。此前 gateway 在此 `registerDisposer`
  // 自管第二监听器（v1.30.8/F-08），而 `seams/lifecycle.ts` 另有一个聚合 disposer
  // ——同一种"自起资源拆卸"两套路径。现在 listener 的生命周期归面宿主，拆卸归一处：
  // `seams/lifecycle.ts` → `stopAllFaces()`（gateway 面在 active 表里，随之关闭）。
}
