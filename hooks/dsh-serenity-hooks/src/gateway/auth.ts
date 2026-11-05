/**
 * gateway/auth.ts — F1 双端口网关：认证域纯逻辑（v1.22.4 安全加固）
 *
 * 从 gateway/server.ts 拆分（S142 熵点治理，v1.22.8）：认证纯逻辑独立成模块——
 * 登录验证（scrypt）/ 会话 token（滑动 TTL + 吊销）/ 失败锁定（账号维度指数退避）/
 * CSRF（双提交 + Origin 校验）/ cookie 解析 / 登录页 HTML。
 * gateway/server.ts 保留 HTTP 装配（startGateway/registerGateway）并从本模块 import。
 *
 * 纯函数设计（可单测）：无 socket/无 HTTP 依赖，全部导出可注入测试。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

// ── 账号验证 ──
//
// 🔴 **v1.119.0（2026-11-05 owner 令）：账号密码登录整条退役，网关只认 Authenticator（TOTP）。**
//
// 原话：「砍掉账号密码登录，只允许 authenticator 登录 ⋯ 原因是加强安全性」。
//
// ⛔ **不要加回口令校验的调用**：口令可被复用/撞库/肩窥，TOTP 是动态的且绑定设备。
// ⇒ 数据模型里的 `passHash` 字段**保留但不参与认证**（见 `kernel/config.ts` 的退役注记）；
//   保留的理由只是**旧配置文件读得进来**，不是"还能用"。
// ⇒ 判据（可机械执行，见 `tests/gateway-totp-only.test.ts`）：
//   `src/gateway/server.ts` 里**不许出现 `password` 参与判定的表达式** ——
//   即 `passOk` 这个标识符必须 0 命中。⛔ 只 grep 函数名是弱判据（注释里就会命中）。

// ── 会话（token + 双 TTL + 主动登出 + **磁盘持久化**）──

/** 会话**空闲**过期时长（毫秒）：24h 无活动 → 失效 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 会话**绝对**寿命上限（毫秒）：30 天。
 *
 * 🔴 为什么必须有它（owner 要"记住登录"时最容易踩的坑）：
 * 只有滑动 TTL 的会话表，**只要用户每天都用，就永远不会过期** ——
 * 那不是"记住我"，那是"永不过期"。安全上必须有一条**不随活动延长的硬上限**，
 * 到点强制重新登录（重新出示 TOTP）。
 *
 * owner 原话：「考虑 cookie 有效期做法」⇒ 这条就是 cookie `Max-Age` 的服务端对应物。
 */
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface GatewaySession {
  token: string
  /** 最后活动时间（滑动续期：每次校验通过刷新） */
  lastActiveAt: number
  /** 签发时间（**绝对寿命基准**，活动不延长它） */
  createdAt: number
  /** 绑定账号（审计/登出定位） */
  user: string
}

/**
 * 会话表。
 *
 * 🔴 **v1.119.0 变更（owner 令「重启后仍然有效」）**：此前是纯内存、重启即清空。
 * 现在是**内存 + 磁盘**：启动时按需加载，变更时落盘。
 * ⚠️ 旧注释写着「重启即清空——用户决策」，**那条决策已被本次 owner 令反转**。
 */
const sessions = new Map<string, GatewaySession>()

/** 是否已尝试过从磁盘加载（只尝试一次；文件不存在也算尝试过） */
let loadAttempted = false

/**
 * 会话持久化文件路径。
 * 与 `SERENITY_HOOKS_CONFIG` 同目录（该 env 是测试注入点 ⇒ 测试天然隔离，不会碰真实文件）。
 * 权限 0600：文件里是**可直接登录的活 token**，比密码 hash 更敏感。
 */
export function sessionStorePath(): string {
  const override = process.env.SERENITY_HOOKS_CONFIG
  if (override !== undefined && override !== '') {
    const idx = override.lastIndexOf('/')
    if (idx > 0) return join(override.slice(0, idx), 'serenity-gateway-sessions.json')
  }
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return join(dshHome, 'serenity-gateway-sessions.json')
}

/** 从磁盘加载会话（幂等；坏文件 ⇒ 视为空表，不让坏数据挡住登录） */
function ensureLoaded(): void {
  if (loadAttempted) return
  loadAttempted = true
  const p = sessionStorePath()
  if (!existsSync(p)) return
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
    if (!Array.isArray(raw)) return
    const now = Date.now()
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const s = item as Partial<GatewaySession>
      if (typeof s.token !== 'string' || s.token === '') continue
      if (typeof s.user !== 'string' || s.user === '') continue
      const created = typeof s.createdAt === 'number' ? s.createdAt : 0
      const active = typeof s.lastActiveAt === 'number' ? s.lastActiveAt : created
      // 加载时**就**做一次双 TTL 过滤：过期的不要带进内存（否则等于延长了寿命）
      if (created === 0) continue
      if (now - active > SESSION_TTL_MS) continue
      if (now - created > SESSION_ABSOLUTE_TTL_MS) continue
      sessions.set(s.token, { token: s.token, user: s.user, createdAt: created, lastActiveAt: active })
    }
  } catch {
    // 坏 JSON ⇒ 空表。**不删除文件**（保留现场供排查）；下次写盘会覆盖它。
  }
}

/**
 * 落盘（原子替换：临时文件 → rename）。
 *
 * 🔴 为什么用 rename 而不是直接 write：**写到一半断电会留下半截 JSON**，
 * 下次加载就整表丢失（= 所有人都被登出，且没有任何信号）。rename 是原子的。
 */
function persist(): void {
  const p = sessionStorePath()
  const tmp = `${p}.tmp`
  try {
    const list = [...sessions.values()]
    writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf-8')
    try { chmodSync(tmp, 0o600) } catch { /* 只读挂载等：不阻断 */ }
    renameSync(tmp, p)
    try { chmodSync(p, 0o600) } catch { /* 同上 */ }
  } catch {
    // 写盘失败**不阻断登录**：内存会话仍然有效，只是重启后丢。
    // ⚠️ 这是**有意的降级**（可用性优先），但意味着"记住登录"在磁盘满/只读时不成立。
  }
}

/** 颁发会话 token（Hex 32 字节） */
export function issueToken(user: string): string {
  ensureLoaded()
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  sessions.set(token, { token, lastActiveAt: now, createdAt: now, user })
  persist()
  return token
}

/** 主动吊销会话（登出）；返回是否确实存在 */
export function revokeToken(token: string): boolean {
  ensureLoaded()
  const had = sessions.delete(token)
  if (had) persist()
  return had
}

/** 吊销某账号的全部会话（改 TOTP 绑定/删账号时用：旧 token 不该继续有效） */
export function revokeAllFor(user: string): number {
  ensureLoaded()
  let n = 0
  for (const [token, s] of sessions) {
    if (s.user === user) {
      sessions.delete(token)
      n += 1
    }
  }
  if (n > 0) persist()
  return n
}

/**
 * 校验 token 有效性（**双 TTL**：空闲滑动 ＋ 绝对上限；有效则刷新 lastActiveAt）。
 * @returns 有效会话或 undefined
 */
export function validateToken(token: string | undefined): GatewaySession | undefined {
  if (typeof token !== 'string' || token === '') return undefined
  ensureLoaded()
  const session = sessions.get(token)
  if (session === undefined) return undefined
  const now = Date.now()
  // 绝对寿命到点 ⇒ 失效（活动不延长它）
  if (now - session.createdAt > SESSION_ABSOLUTE_TTL_MS) {
    sessions.delete(token)
    persist()
    return undefined
  }
  // 空闲超时 ⇒ 失效
  if (now - session.lastActiveAt > SESSION_TTL_MS) {
    sessions.delete(token)
    persist()
    return undefined
  }
  session.lastActiveAt = now // 滑动续期
  // ⚠️ 每次校验都落盘会产生大量写；只在**续期跨度够大**时写（见下）
  maybePersistOnTouch(session)
  return session
}

/** 上次落盘的 lastActiveAt 快照（token → 时间），用于给"每轮请求都写盘"限流 */
const lastPersistedAt = new Map<string, number>()
/** 续期落盘的最小间隔：小于它的活动只改内存，不写盘（重启后最多丢这么多活动时间） */
const PERSIST_TOUCH_INTERVAL_MS = 10 * 60 * 1000

function maybePersistOnTouch(session: GatewaySession): void {
  const prev = lastPersistedAt.get(session.token)
  if (prev !== undefined && session.lastActiveAt - prev < PERSIST_TOUCH_INTERVAL_MS) return
  lastPersistedAt.set(session.token, session.lastActiveAt)
  persist()
}

// ── 失败锁定（账号维度；不按 IP——用户要求随时随地访问）──

/** 失败锁定阈值：连续失败 N 次进入锁定 */
export const FAIL_LOCK_THRESHOLD = 5
/** 首次锁定时长（毫秒） */
export const FAIL_LOCK_BASE_MS = 15 * 60 * 1000
/** 锁定时长指数退避上限 */
export const FAIL_LOCK_MAX_MS = 4 * 60 * 60 * 1000

interface FailState {
  /** 连续失败计数（成功登录后清零） */
  count: number
  /** 当前锁定截止时间（0 = 未锁定） */
  lockedUntil: number
  /** 已连续锁定次数（退避指数） */
  lockRound: number
}

/** 账号 → 失败状态（内存；重启清零——攻击者重启服务可绕过，但公网常驻服务下有效） */
const failStates = new Map<string, FailState>()

/** 获取账号失败状态（纯逻辑，供测试注入） */
export function getFailState(user: string): FailState {
  let st = failStates.get(user)
  if (!st) {
    st = { count: 0, lockedUntil: 0, lockRound: 0 }
    failStates.set(user, st)
  }
  return st
}

/** 重置失败状态（登录成功/管理员解封） */
export function resetFailState(user: string): void {
  failStates.delete(user)
}

/** 账号当前是否锁定（含锁定到期自动解锁——到期后读取即解锁） */
export function isAccountLocked(user: string): boolean {
  const st = getFailState(user)
  if (st.lockedUntil === 0) return false
  if (Date.now() >= st.lockedUntil) {
    st.lockedUntil = 0
    st.count = 0
    return false
  }
  return true
}

/** 记录一次失败；达到阈值 → 锁定（指数退避）。返回锁定剩余毫秒（0 = 未锁定） */
export function recordLoginFailure(user: string): number {
  const st = getFailState(user)
  if (st.lockedUntil > 0 && Date.now() < st.lockedUntil) return st.lockedUntil - Date.now()
  st.count += 1
  if (st.count >= FAIL_LOCK_THRESHOLD) {
    const base = FAIL_LOCK_BASE_MS * (2 ** st.lockRound)
    st.lockedUntil = Date.now() + Math.min(base, FAIL_LOCK_MAX_MS)
    st.lockRound += 1
    st.count = 0
    return st.lockedUntil - Date.now()
  }
  return 0
}

/** 剩余锁定毫秒（0 = 未锁定） */
export function accountLockRemaining(user: string): number {
  const st = getFailState(user)
  return st.lockedUntil > 0 && Date.now() < st.lockedUntil ? st.lockedUntil - Date.now() : 0
}

// ── CSRF（双提交 cookie + Origin 校验 + 服务端 token 集合）──

/** CSRF token 有效期（毫秒）：10 分钟窗口（扫码/多标签场景留足时间） */
const CSRF_TTL_MS = 10 * 60 * 1000
/** CSRF token 集合上限（防内存膨胀；超限清理最旧） */
const CSRF_MAX_TOKENS = 50

/**
 * 服务端 CSRF token 集合（v1.24.9 修复：多标签/刷新竞争导致登录死循环）。
 * 背景：每次 GET 登录页都生成新 token 覆盖 cookie——多标签页场景下，早先打开的
 * 标签携带旧 form token 提交时与最新 cookie 不匹配 → "会话校验失败"永远失败
 * （S142 用户实测：cookieCsrf=present formCsrf=present 但不匹配）。
 * 修复：每次 GET 生成的 token 存入集合（TTL 10min），提交时 form/cookie token
 * 只要 ∈ 集合即有效——多标签各自 token 都接受。
 */
const csrfTokens = new Map<string, number>() // token → expiry

/** 生成 CSRF token（随机 32B hex）并入集合 */
export function newCsrfToken(): string {
  const token = randomBytes(32).toString('hex')
  csrfTokens.set(token, Date.now() + CSRF_TTL_MS)
  if (csrfTokens.size > CSRF_MAX_TOKENS) {
    const now = Date.now()
    for (const [t, expiry] of csrfTokens) {
      if (expiry < now) csrfTokens.delete(t)
    }
    if (csrfTokens.size > CSRF_MAX_TOKENS) {
      let oldest: string | null = null
      let oldestExpiry = Infinity
      for (const [t, expiry] of csrfTokens) {
        if (expiry < oldestExpiry) { oldest = t; oldestExpiry = expiry }
      }
      if (oldest !== null) csrfTokens.delete(oldest)
    }
  }
  return token
}

/** token 是否有效（在集合且未过期；过期自动清理） */
export function isCsrfValid(token: string): boolean {
  const expiry = csrfTokens.get(token)
  if (expiry === undefined) return false
  if (expiry < Date.now()) {
    csrfTokens.delete(token)
    return false
  }
  return true
}

/** 从请求头取 CSRF token（X-CSRF-Token 或表单字段） */
export function csrfFromRequest(req: IncomingMessage, body: URLSearchParams): string | null {
  const header = req.headers['x-csrf-token']
  if (typeof header === 'string' && header !== '') return header
  const form = body.get('csrf')
  return form && form !== '' ? form : null
}

/** 常量时间比较（token 校验用） */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Origin 校验（S3）：跨站 POST 被浏览器强制带 Origin（同源 GET/导航除外）。
 * 允许：① 同源（Origin.host === 网关自身 host）② 主端口 loopback（127.0.0.1:mainPort）。
 * 无 Origin（curl/非浏览器直连）→ 仅当携带有效 CSRF 双提交时放行（脚本无 cookie 无法伪造）。
 * @returns 是否通过
 */
export function originAllowed(
  originHeader: string | undefined,
  reqHost: string,
  mainPort: number,
): boolean {
  if (originHeader === undefined || originHeader === 'null') return true // 非浏览器/隐私模式降级由 CSRF 兜底
  try {
    const originHost = new URL(originHeader).host
    return originHost === reqHost || originHost === `127.0.0.1:${mainPort}` || originHost === `localhost:${mainPort}`
  } catch {
    return false
  }
}

/** 从 Cookie 头解析指定 cookie 值（纯逻辑，可单测） */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    if (key === name) return part.slice(idx + 1).trim()
  }
  return undefined
}

// ── 登录页（v1.22.1 移动端适配 + v1.22.4 CSRF/TOTP）──

/**
 * 登录页：内嵌 HTML 无外部资源——适配任何部署。
 * 移动端关键点：
 *  - viewport meta（防止移动浏览器按 980px 视口缩放）
 *  - 触控目标 ≥ 44px（Apple HIG）；输入字号 ≥ 16px（iOS 聚焦不自动放大）
 *  - env(safe-area-inset-*) 适配刘海屏/底部手势条
 *  - color-scheme: dark + 明暗自适应
 * @param extra - 错误提示文案
 * @param csrf - CSRF token（隐藏字段随表单双提交；无 = 旧调用方兼容）
 */
export function loginPageHtml(extra: string, csrf?: string): string {
  const csrfField = csrf ? `<input type="hidden" name="csrf" value="${csrf}">` : ''
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#111114">
<meta name="referrer" content="no-referrer">
<title>Serenity 登录</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;margin:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:#111114;color:#eee}
.card{background:#1c1c20;padding:32px 28px;border-radius:16px;width:min(340px,calc(100vw - 48px));box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.06)}
h1{font-size:20px;margin:0 0 4px;text-align:center;letter-spacing:.02em}
.sub{font-size:13px;color:#999;text-align:center;margin:0 0 24px}
label{display:block;font-size:13px;color:#bbb;margin:14px 0 6px}
input{width:100%;padding:14px 14px;margin:0;border:1px solid #3a3a40;border-radius:10px;background:#141418;color:#eee;font-size:16px;-webkit-appearance:none;appearance:none}
input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.25)}
input::placeholder{color:#666}
#f-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.35em;text-align:center;font-weight:600}
button{width:100%;padding:15px 14px;margin-top:24px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:16px;font-weight:600;cursor:pointer;min-height:50px;-webkit-appearance:none;appearance:none}
button:active{background:#2563eb}
.error{color:#f87171;font-size:13px;min-height:18px;margin-top:12px;text-align:center}
.hint{color:#777;font-size:12px;margin-top:10px;text-align:center}
.foot{margin-top:20px;text-align:center;font-size:12px;color:#666}
@media (prefers-color-scheme:light){
  body{background:#f4f4f6;color:#1a1a1e}
  .card{background:#fff;border-color:rgba(0,0,0,.08);box-shadow:0 12px 40px rgba(0,0,0,.12)}
  .sub{color:#666}
  label{color:#444}
  input{background:#fafafa;border-color:#d0d0d6;color:#1a1a1e}
  input::placeholder{color:#aaa}
  .hint{color:#999}
  .foot{color:#999}
}
</style></head><body><div class="card">
<h1>🔐 Serenity Web UI</h1>
<p class="sub">宁静号 · 外部访问</p>
<form method="post" action="/serenity/login">
${csrfField}
<label for="f-user">用户名</label>
<input id="f-user" type="text" name="user" placeholder="用户名" autocomplete="username" autocapitalize="none" autocorrect="off" required autofocus enterkeyhint="next">
<label for="f-code">Authenticator 验证码</label>
<input id="f-code" type="text" name="code" placeholder="6 位验证码" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required enterkeyhint="go">
<button type="submit">登录</button>
<div class="error">${extra}</div>
<p class="hint">仅支持 Authenticator 验证码登录（口令登录已停用）</p>
</form>
<p class="foot">Serenity ACC · dsh-serenity-hooks</p>
</div></body></html>`
}
