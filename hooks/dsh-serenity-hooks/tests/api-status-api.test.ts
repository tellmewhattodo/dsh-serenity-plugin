/**
 * api-status-api.test.ts — 🔴 **HTTP 对外面（`registerStatusApi`）的首次行为验收**
 * （2026-09-25 · ⑤ 第 8 件 · 对应地图 §3-9 新增行）
 *
 * 为什么必须补（R↓，读数是实测的）：`src/surface/http.ts` 是**整个 HTTP 对外面**（9 条 `/serenity/*`
 * 路由：状态／safe-mode 切换／图片落盘／文件落盘／配置读写／cccs／public-ask／weixin／
 * session-cleanup）。而覆盖率报告实测：**`surface/http.ts` 23.55% statements、4/11 functions**
 * —— **`registerStatusApi` 这个入口本身（约 530 行）从未被执行过**，连带 6 个私有助手
 * （`readBody` / `sendJson` / `senderIsWebUi` / `requireWebUi` / `resolveWorkspace` / `requireCcc`）
 * 也全是"零执行"。⇒ 此前**没有任何测试证明这些端点真的能应答**。
 *
 * 🔴 为什么覆盖门禁没拦住（这正是地图 §3-9 第 5 行那条缺口形态）：`coverage-gate` 用**正则匹配
 * 测试源码里的 import 字符串**（"**提到即算覆盖**"）——`accounts-api.test.ts` 提到了 `surface/http.ts`，
 * 于是门禁判"已覆盖"，而**77% 的语句从未运行**。
 *
 * 本组用的是**真 listener ＋ 真 HTTP 往返 ＋ 真 CCC 夹具**（不是构造 req/res 假对象）：
 *   ① `ctx.webServer.register` 的**接线自证**（9 条路由真被注册、且全在 `/serenity/` 下）
 *   ② cheapWorkers 端点：GET（无 CCC ⇒ 空表）／ 非 GET ⇒ 405
 *   ③ status GET：200 ＋ `codeRuntime: null`（探测服务缺失时的降级形态）
 *   ④ status POST 的**安全边界**（v1.22.4 语义）：**无 WebUI 头 ⇒ 403 且 `on` 的标记文件绝不出现**（正负成对）
 *   ⑤ status POST 带 WebUI 头 ＋ 真 CCC ⇒ 200 且 **`.serenity-safe-on` 真的被写到盘上**
 *   ⑥ `readBody` 上限：超 64KB ⇒ 400 `body too large`
 *   ⑦ image-upload：无头 ⇒ 403；带头 ＋ 真 CCC ⇒ 200 且**图片真的落在 `_tmp/images_from_user/`**
 *   ⑧ file-upload：可执行扩展名 ⇒ 400（**安全边界**：不落盘可执行文件）＋ 盘上无文件（负控）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { IMAGE_UPLOAD_DIR, registerStatusApi } from '../src/surface/http.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'
// 🔴 2026-10-19：微信桥路由的目标是**认知轨迹编码**，`save-routes` 会校验该轨迹在 CCC 里真实存在
//    ⇒ "保存成功"的前置 = 先造出那条轨迹（夹具是造 轨迹约束/轨迹数据的唯一入口）。
import { makeTrajectory, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

interface Booted {
  port: number
  routes: string[]
  close: () => Promise<void>
}

/** 起一台真 listener：把 `registerStatusApi` 注册的处理器按**精确路径**派发出去。 */
async function bootApi(opts: {
  liveSessionIds?: string[]
  /** 🆕 ⑤ 第 17 件：`sessions.get(id).header.cwd` —— 覆盖 `resolveWorkspace` 的**首选路径** */
  sessionCwdById?: Record<string, string>
  /** 🆕 同上：live 会话的 cwd（覆盖 `resolveWorkspace` 的**遍历兜底**） */
  liveSessionCwds?: string[]
  /** 🆕 同上：让 `ctx.emit` 抛错 —— 覆盖 config PUT 的"事件通知失败不影响保存"分支 */
  emitThrows?: boolean
  /** 🆕 ⑤ 第 18 件：让 `sessions.get` **抛错** —— 触发端点自己的 catch（真实故障形态：宿主服务读取失败） */
  sessionGetThrows?: boolean
  /** 🆕 同上：让 `workspaceRegistry.list()` 抛错 —— 覆盖 config GET 的"工作区服务不可用"支线 */
  registryListThrows?: boolean
  /** 🆕 ⑤ 第 18 件：让 `sessions.list()` 抛错 —— 它在 `session-cleanup` 里是**裸调用**（不被收口层吞） */
  sessionListThrows?: boolean
} = {}): Promise<Booted> {
  const handlers = new Map<string, Handler>()
  const routes: string[] = []
  const ctx = {
    webServer: {
      register: (r: { path: string; handler: Handler }) => {
        handlers.set(r.path, r.handler)
        routes.push(r.path)
      },
    },
    // 🔴 必须提供 `get`：真实 cordis 的 ctx **必有**服务读取器，而本端点里有一处**裸**
    //    `ctx.get('codeRuntime')`（F-06 残留，见地图 §3-1 登记项）。夹具不提供它时，
    //    异常会被 handler 的 catch 吞成 **400** ⇒ 整端点降级为"不可用"，而**不是**"codeRuntime 为 null"。
    //    ⇒ 这一处正是"走收口层（`hostService`，异常吞掉返回 undefined）vs 裸调用"的**失败模式差异**的实证。
    get: (name: string) => {
      if (name === 'workspaceRegistry' && opts.registryListThrows) {
        return { list: () => { throw new Error('workspaceRegistry.list boom') } }
      }
      // 只有 cleanup 那组需要"宿主里正在跑的会话"（live 保护 = 该端点的安全底线）
      if (name !== 'sessions') return undefined
      if (opts.sessionGetThrows) return { get: () => { throw new Error('sessions.get boom') } }
      if (opts.sessionListThrows) return { list: () => { throw new Error('sessions.list boom') } }
      const wantGet = opts.sessionCwdById !== undefined
      const wantList = opts.liveSessionIds !== undefined || opts.liveSessionCwds !== undefined
      if (!wantGet && !wantList) return undefined
      return {
        ...wantGet
          ? {
              get: (id: string) => {
                const cwd = opts.sessionCwdById![id]
                return cwd === undefined ? undefined : { header: { id, cwd } }
              },
            }
          : {},
        ...wantList
          ? {
              list: () => [
                ...(opts.liveSessionIds ?? []).map((id) => ({ header: { id } })),
                ...(opts.liveSessionCwds ?? []).map((cwd) => ({ header: { id: 'live-from-cwd', cwd } })),
              ],
            }
          : {},
      }
    },
    ...opts.emitThrows
      ? { emit: () => { throw new Error('emit boom') } }
      : {},
    // 也刻意不提供 sessions/agents ⇒ `resolveWorkspace` 走"无参回落"分支
  }
  registerStatusApi(ctx as never)

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no such route')
      return
    }
    void Promise.resolve(handler(req, res)).catch(() => {
      try { res.writeHead(500); res.end() } catch { /* 已结束 */ }
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  return {
    port,
    routes,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => resolve()); setTimeout(resolve, 1000) })
    },
  }
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

/** WebUI 判别头（client 专属动作的门；见 `requireWebUi` 的语义边界注释） */
const UI_HEADERS = { 'content-type': 'application/json', 'x-serenity-ui': '1' }

let ccc: string
let plain: string
let cfgDir: string
let prevCfgEnv: string | undefined
let prevDshHome: string | undefined
let dshHome: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'hooks-api-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'test')
  plain = mkdtempSync(join(tmpdir(), 'hooks-api-plain-')) // 无 .serenity ⇒ cccRootForCwd 解析不到
  // 🔴 环境隔离（两条，都是"绝不碰真实环境"）：
  //   ① `SERENITY_HOOKS_CONFIG` → 临时文件：`/serenity/config` 的 PUT 与 public-ask 的 key
  //      轮换都会**写全局配置**（`globalConfigPath()` 认这个 env）⇒ 不隔离就会改到真机配置。
  //   ② simple settings 源：`readSimpleSettings()` 需要宿主 settings 源，测试里注入默认值。
  prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG
  cfgDir = mkdtempSync(join(tmpdir(), 'hooks-api-cfg-'))
  process.env.SERENITY_HOOKS_CONFIG = join(cfgDir, 'serenity-hooks.json')
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings() }))
  //   ③ `DSH_HOME` → 临时目录：`session-cleanup` 的 POST **会真删会话**（`sessionsRootDir()` 认
  //      这个 env）⇒ 不隔离就会删到**真机会话日志**。隔离后该端点才敢测（见文件末尾那组）。
  prevDshHome = process.env.DSH_HOME
  dshHome = mkdtempSync(join(tmpdir(), 'hooks-api-dsh-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  __setSimpleSourceForTest(null)
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  rmSync(ccc, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
})

describe('src/api.ts：HTTP 对外面（真 listener ＋ 真往返）', () => {
  it('🔴 接线自证：8 条 `/serenity/*` 路由真被注册，且全部落在 `/serenity/` 前缀下', () => {
    return bootApi().then(async (api) => {
      try {
        // 🔴 2026-10-14：`/serenity/cheap-workers` 已随 background 模式删除（它是**进度文件**的读口，
        //    而进度文件不再有生产者）⇒ 期望值从 9 条降为 8 条。**该路径必须不再被注册**（见下一条否定断言）。
        // 🔴 2026-10-15：`/serenity/public-ask` 已随**面 E 退役**删除（owner 裁「砍掉外部问答」）
        //    ⇒ 期望值 8 → **7** 条。同样**必须不再注册**（见下面第二条否定断言）。
        const expected = [
          '/serenity/status',
          '/serenity/image-upload',
          '/serenity/file-upload',
          '/serenity/config',
          '/serenity/cccs',
          '/serenity/weixin',
          '/serenity/session-cleanup',
        ]
        for (const p of expected) expect(api.routes, `未注册：${p}`).toContain(p)
        // 🔴 否定面：退场端点不得残留（否则前端会拿到一个"永远空表"的假读数）
        expect(api.routes, '已删除的端点不得复活').not.toContain('/serenity/cheap-workers')
        expect(api.routes, '面 E 退役后 public-ask 不得复活').not.toContain('/serenity/public-ask')
        // 不变式：这个面**只碰**自己的命名空间（不许顺手抢别的路径）
        for (const p of api.routes) expect(p.startsWith('/serenity/'), `越界路径：${p}`).toBe(true)
        expect(new Set(api.routes).size, '路径重复注册').toBe(api.routes.length)
      } finally {
        await api.close()
      }
    })
  })

  it('🔴 /serenity/cheap-workers 已退场：GET 与 POST 都走 404（不是"空表"）', async () => {
    const api = await bootApi()
    try {
      // 判据刻意选 404 而非"200 + 空表"：后者**看起来正常**，正是死端点最难发现之处。
      const g = await raw({ port: api.port, method: 'GET', path: `/serenity/cheap-workers?workspace=${encodeURIComponent(plain)}` })
      expect(g.status).toBe(404)
      const p = await raw({ port: api.port, method: 'POST', path: '/serenity/cheap-workers' })
      expect(p.status).toBe(404)
    } finally {
      await api.close()
    }
  })

  it('/serenity/status GET ⇒ 200 ＋ 探测服务缺失时 codeRuntime: null（降级形态）', async () => {
    const api = await bootApi()
    try {
      // CCC 内 ⇒ 完整 status
      const inCcc = await raw({ port: api.port, method: 'GET', path: `/serenity/status?workspace=${encodeURIComponent(ccc)}` })
      expect(inCcc.status).toBe(200)
      const body = JSON.parse(inCcc.body) as Record<string, unknown>
      expect(body.root).toBe(ccc)
      expect(body.codeRuntime).toBeNull()

      // CCC 外 ⇒ **降级不是报错**（`getStatus` 对 `root=null` 有明确分支）
      const outside = await raw({ port: api.port, method: 'GET', path: `/serenity/status?workspace=${encodeURIComponent(plain)}` })
      expect(outside.status).toBe(200)
      expect((JSON.parse(outside.body) as Record<string, unknown>).root).toBeNull()
    } finally {
      await api.close()
    }
  })

  it('⚠️ 现状（**已登记的缺陷**）：超 64KB 的 POST 体 ⇒ **连接被重置**，预期的 400 JSON 不可达', async () => {
    const api = await bootApi()
    try {
      // 语义：`readBody` 在超限时 `reject` **并 `req.destroy()`** ⇒ socket 被销毁 ⇒
      // handler 随后那句 `sendJson(res, 400, {error:'body too large'})` **写不出去** ⇒
      // 客户端看到的是 ECONNRESET，而不是一条可读的 400。🔴 **已登记待裁**（改实现 = 先排空再回 400；
      // 或改判据 = 承认"硬断"是刻意的 DoS 防护）。本例**钉住现状**：谁修了它，这里会红并提醒更新。
      await expect(
        raw({
          port: api.port,
          method: 'POST',
          path: '/serenity/status',
          headers: UI_HEADERS,
          body: JSON.stringify({ workspace: ccc, on: true, pad: 'x'.repeat(70 * 1024) }),
        }),
      ).rejects.toThrow(/socket hang up|ECONNRESET/i)

      // 🔴 但"硬断"**确实拦住了动作**：被拒的请求没有副作用（安全性质仍成立）
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 safe-mode 安全边界（正负成对）：无 WebUI 头 ⇒ 403，且**标记文件绝不出现**', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/status',
        headers: { 'content-type': 'application/json' }, // 故意不带 x-serenity-ui
        body: JSON.stringify({ workspace: ccc, on: true }),
      })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'safe-mode 切换仅限 WebUI（agent 不可自行开关）' })
      // 🔴 负控：**守卫生效的实质证据**——不是"回了个 403"，而是"**动作根本没发生**"
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 带 WebUI 头 ＋ 真 CCC ⇒ 200，且 `.serenity-safe-on` 真的落到盘上（端到端真动作）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/status',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, on: true }),
      })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ on: true })
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(true)

      // 再关掉：同一个端点要能把状态改回去（否则"只能开不能关"是半个功能）
      const off = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/status',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, on: false }),
      })
      expect(off.status).toBe(200)
      expect(JSON.parse(off.body)).toMatchObject({ on: false })
      expect(existsSync(join(ccc, '.serenity-safe-on'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 image-upload：无头 ⇒ 403；带头 ⇒ 200 且图片真的落在 _tmp/images_from_user/', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/image-upload',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: ccc, mediaType: 'image/png', data: 'AAAA' }),
      })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '图片落盘仅限 WebUI（client 专用）' })

      const ok = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/image-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64') }),
      })
      expect(ok.status).toBe(200)
      const rel = (JSON.parse(ok.body) as { path: string }).path
      expect(rel.startsWith(`${IMAGE_UPLOAD_DIR}/`)).toBe(true)
      expect(existsSync(join(ccc, rel))).toBe(true)
      expect(readdirSync(join(ccc, IMAGE_UPLOAD_DIR)).length).toBe(1)

      // 白名单外类型 ⇒ 400（校验在核心逻辑里，端点只负责转码）
      const badType = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/image-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, mediaType: 'application/x-msdownload', data: 'AAAA' }),
      })
      expect(badType.status).toBe(400)
    } finally {
      await api.close()
    }
  })

  it('🔴 file-upload 安全边界：可执行扩展名 ⇒ 400，且**盘上不留文件**（负控）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/file-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, name: 'evil.sh', data: Buffer.from('#!/bin/sh\nrm -rf /').toString('base64') }),
      })
      expect(res.status).toBe(400)
      expect(String(JSON.parse(res.body).error)).toContain('blocked executable file type')
      expect(existsSync(join(ccc, '_tmp/files_from_user'))).toBe(false)

      // 正控：普通扩展名同一端点要能落盘（否则上一条可能只是"端点坏了"）
      const ok = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/file-upload',
        headers: UI_HEADERS,
        body: JSON.stringify({ workspace: ccc, name: '报告.txt', data: Buffer.from('hello').toString('base64') }),
      })
      expect(ok.status).toBe(200)
      const rel = (JSON.parse(ok.body) as { path: string }).path
      expect(existsSync(join(ccc, rel))).toBe(true)
    } finally {
      await api.close()
    }
  })

  it('未知路径 ⇒ 本面不接管（404 由派发层给，不是本面抢答）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/api/whatever' })
      expect(res.status).toBe(404)
      expect(res.body).toBe('no such route')
    } finally {
      await api.close()
    }
  })
})

/**
 * 其余四条路由的验收（2026-09-25 · ⑤ 第 9 件）：`config` ／ `cccs` ／ `public-ask` ／ `weixin`
 * ／ `session-cleanup`（第 8 件只覆盖了 status/cheapWorkers/两个 upload ⇒ 本组把这块 HTTP 面补齐）。
 * 🔴 两条纪律：① **写操作只落临时全局配置**（`SERENITY_HOOKS_CONFIG` 已隔离，见 beforeEach）；
 * ② **破坏性动作不做** —— `session-cleanup` 只验 **GET 的 dryRun 预览**（POST 会真删会话，不测）。
 */
describe('src/api.ts：其余路由（config ／ cccs ／ public-ask ／ weixin ／ session-cleanup）', () => {
  it('/serenity/config：无 WebUI 头 ⇒ 403；带头 GET ⇒ 200（wire 形态 ＋ knownWorkspaces）', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({ port: api.port, method: 'GET', path: '/serenity/config' })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '高级设定仅限 WebUI（client 专用）' })

      const ok = await raw({ port: api.port, method: 'GET', path: '/serenity/config', headers: { 'x-serenity-ui': '1' } })
      expect(ok.status).toBe(200)
      const body = JSON.parse(ok.body) as { config?: unknown; knownWorkspaces?: unknown }
      expect(body.config).toBeTypeOf('object')
      expect(Array.isArray(body.knownWorkspaces)).toBe(true)

      const wrong = await raw({ port: api.port, method: 'DELETE', path: '/serenity/config', headers: { 'x-serenity-ui': '1' } })
      expect(wrong.status).toBe(405)
    } finally {
      await api.close()
    }
  })

  it('🔴 /serenity/config PUT：**真写进临时全局配置**，且明文口令既不上 wire 也不落盘', async () => {
    const api = await bootApi()
    try {
      const SECRET = 'S3cret-pw-value'
      const res = await raw({
        port: api.port,
        method: 'PUT',
        path: '/serenity/config',
        headers: UI_HEADERS,
        body: JSON.stringify({ config: { gateway: { accounts: [{ id: 'a1', user: 'tester', pass: SECRET }] } } }),
      })
      expect(res.status).toBe(200)
      const wire = JSON.parse(res.body) as { config: { gateway: { accounts?: Array<Record<string, unknown>> } } }
      // ① 回包是 wire 形态：账号只回元信息（**口令不回**）
      expect(res.body).not.toContain(SECRET)
      expect(wire.config.gateway.accounts?.[0]).toMatchObject({ id: 'a1', user: 'tester', hasPassword: true })

      // ② 端到端：文件**真的**写到了隔离路径上（并且口令是 hash，不是明文）
      const onDisk = readFileSync(process.env.SERENITY_HOOKS_CONFIG!, 'utf-8')
      expect(onDisk).toContain('tester')
      expect(onDisk).not.toContain(SECRET)
      expect(onDisk.toLowerCase()).toContain('hash')
    } finally {
      await api.close()
    }
  })

  it('/serenity/cccs：GET ⇒ 200（候选容器数组）；POST ⇒ 405', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: `/serenity/cccs?workspace=${encodeURIComponent(ccc)}` })
      expect(res.status).toBe(200)
      expect(Array.isArray((JSON.parse(res.body) as { cccs: unknown }).cccs)).toBe(true)

      const wrong = await raw({ port: api.port, method: 'POST', path: '/serenity/cccs' })
      expect(wrong.status).toBe(405)
    } finally {
      await api.close()
    }
  })

  it('🆕 /serenity/subscriptions：GET ⇒ 200（两栏分开给）；POST ⇒ 405（只读）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'GET',
        path: `/serenity/subscriptions?workspace=${encodeURIComponent(ccc)}`,
        headers: UI_HEADERS,
      })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as {
        subscriptions: unknown
        problems: unknown
        deliveries: unknown
        eval: unknown
      }
      // 🔴 四个字段一个都不能少：它们**分工**（意图 / 坏项 / 实际 / 机制在跑吗），少一个面板就分不清
      expect(Array.isArray(body.subscriptions)).toBe(true)
      expect(Array.isArray(body.problems)).toBe(true)
      expect(Array.isArray(body.deliveries)).toBe(true)
      // eval 回答"机制在跑吗"—— 没有它，"没装配"与"装配了但从未命中"同形
      expect(body.eval).toMatchObject({ statusEvents: expect.any(Number), turnFinished: expect.any(Number) })

      // 只读端点：写方法必须 405（⛔ 不是"200 但什么都不做"——那看起来像成功）
      const wrong = await raw({ port: api.port, method: 'POST', path: '/serenity/subscriptions' })
      expect(wrong.status).toBe(405)
    } finally {
      await api.close()
    }
  })

  it('🔴 /serenity/public-ask 已随面 E 退役：GET 与 PUT 都走 404（不是"空配置"）', async () => {
    const api = await bootApi()
    try {
      // 判据刻意选 404 而非"403/200 + 空表"：后者**看起来正常**，正是死端点最难发现之处
      // （与本文件里 `/serenity/cheap-workers` 那条同款判据，2026-10-15）。
      const got = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask', headers: UI_HEADERS })
      expect(got.status, '已退役的端点不得再应答').toBe(404)

      const put = await raw({
        port: api.port,
        method: 'PUT',
        path: '/serenity/public-ask',
        headers: UI_HEADERS,
        body: JSON.stringify({ action: 'rotate' }),
      })
      expect(put.status, '已退役的端点不得再应答（PUT）').toBe(404)
    } finally {
      await api.close()
    }
  })

  it('/serenity/weixin：无头 ⇒ 403；缺 ccc ⇒ 400；非 CCC 目录 ⇒ 400；真 CCC ⇒ 200（脱敏形态）', async () => {
    const api = await bootApi()
    try {
      const denied = await raw({ port: api.port, method: 'GET', path: '/serenity/weixin' })
      expect(denied.status).toBe(403)
      expect(JSON.parse(denied.body)).toEqual({ error: '微信桥配置仅限 WebUI（client 专用）' })

      const missing = await raw({ port: api.port, method: 'GET', path: '/serenity/weixin', headers: { 'x-serenity-ui': '1' } })
      expect(missing.status).toBe(400)
      expect(JSON.parse(missing.body)).toEqual({ error: 'missing ccc param' })

      const notCcc = await raw({
        port: api.port,
        method: 'GET',
        path: `/serenity/weixin?ccc=${encodeURIComponent(plain)}`,
        headers: { 'x-serenity-ui': '1' },
      })
      expect(notCcc.status).toBe(400)
      expect(String((JSON.parse(notCcc.body) as { error: string }).error)).toContain('no CCC found from:')

      const ok = await raw({
        port: api.port,
        method: 'GET',
        path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`,
        headers: { 'x-serenity-ui': '1' },
      })
      expect(ok.status).toBe(200)
      const body = JSON.parse(ok.body) as Record<string, unknown>
      expect(body.enabled).toBe(false) // 空 CCC ⇒ 未启用
      expect(body.accounts).toEqual([])
      // 🔴 脱敏不变量：**token 永不落 wire**（面板只回元信息）
      expect(JSON.stringify(body)).not.toContain('token')
    } finally {
      await api.close()
    }
  })

  it('🔴 /serenity/session-cleanup GET：dryRun 预览（只读；POST 会真删会话 ⇒ 见下一组）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup?olderThanDays=30' })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { dryRun: boolean; count: number; candidates: unknown[]; olderThanDays: number }
      expect(body.dryRun).toBe(true) // 🔴 预览语义：GET 绝不删
      expect(body.olderThanDays).toBe(30)
      expect(typeof body.count).toBe('number')
      expect(Array.isArray(body.candidates)).toBe(true)
      expect(body.candidates.length).toBe(body.count)
    } finally {
      await api.close()
    }
  })
})

/**
 * 🔴 破坏性端点：`session-cleanup` 的 **POST 真删**（2026-09-25 · ⑤ 第 10 件）。
 *
 * 为什么现在才测：它**会物理删掉会话日志**（`performCleanup` 无 dryRun）。上一轮因此只敢测 GET 预览。
 * 本轮先补**夹具**：`DSH_HOME` 隔离到临时目录（`sessionsRootDir()` 认它）⇒ 删的只是夹具自己造的
 * `<tmp>/sessions/<project>/<id>/session.jsonl`，**碰不到真机会话**。
 *
 * 钉住的三件事（按重要性）：
 *   ① 🔴 **live 保护 = 该端点的安全底线**：宿主里正在跑的会话**即使超龄也不许删**（代码注释原话：
 *      "绝不动正在跑的会话"）；
 *   ② 阈值语义：超龄的删、未超龄的留；
 *   ③ **不是会话目录的东西不动**（无 `session*.jsonl` 的目录不进候选）。
 */
describe('src/api.ts：session-cleanup 的 POST（隔离 DSH_HOME 下的真删）', () => {
  /** 造一个会话目录：`<DSH_HOME>/sessions/<project>/<id>/session.jsonl`，mtime = 现在 − ageDays */
  function makeSession(project: string, id: string, ageDays: number): string {
    const dir = join(process.env.DSH_HOME!, 'sessions', project, id)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'session.jsonl')
    writeFileSync(log, '{"kind":"turn/end"}\n')
    const t = (Date.now() - ageDays * 24 * 3600 * 1000) / 1000
    utimesSync(log, t, t) // 决定"是否超龄"的是**文件 mtime**，不是目录
    return dir
  }

  /** 造一个"像会话但其实不是"的目录（没有 session*.jsonl）—— 不该被动 */
  function makeNoise(project: string, id: string): string {
    const dir = join(process.env.DSH_HOME!, 'sessions', project, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'no session log here\n')
    return dir
  }

  it('🔴 夹具自证：三个会话目录 + 一个非会话目录都在隔离的 DSH_HOME 下（不是真机）', () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    expect(old.startsWith(process.env.DSH_HOME!)).toBe(true)
    expect(existsSync(old)).toBe(true)
  })

  it('GET 预览（正负成对）：只列超龄且非 live 的那一个；**盘上谁也不动**', async () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    const fresh = makeSession('--proj-new--', 'new-1', 1)
    const live = makeSession('--proj-live--', 'live-1', 60) // 超龄 **但** live
    const noise = makeNoise('--proj-noise--', 'noise-1')
    const api = await bootApi({ liveSessionIds: ['live-1'] })
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup?olderThanDays=30' })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { candidates: Array<{ id: string }>; count: number }
      expect(body.candidates.map((c) => c.id)).toEqual(['old-1'])
      expect(body.count).toBe(1)
      // 🔴 预览的实质：四个目录**全都还在**
      for (const d of [old, fresh, live, noise]) expect(existsSync(d), `${d} 不该被预览删掉`).toBe(true)
    } finally {
      await api.close()
    }
  })

  it('🔴 POST 真删：超龄的删掉；**live 的即使超龄也保留**；未超龄与"非会话目录"保留', async () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    const fresh = makeSession('--proj-new--', 'new-1', 1)
    const live = makeSession('--proj-live--', 'live-1', 60)
    const noise = makeNoise('--proj-noise--', 'noise-1')
    const api = await bootApi({ liveSessionIds: ['live-1'] })
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/session-cleanup?olderThanDays=30',
        headers: UI_HEADERS,
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as { dryRun: boolean; deleted: string[]; errors: string[] }
      expect(body.dryRun).toBe(false)
      expect(body.deleted).toEqual(['old-1'])
      expect(body.errors).toEqual([])

      // 🔴 以**盘上状态**为准（响应说什么 ≠ 真删了什么）
      expect(existsSync(old), '超龄会话应当被物理删除').toBe(false)
      expect(existsSync(fresh), '未超龄的必须保留').toBe(true)
      expect(existsSync(live), '🔴 live 会话即使超龄也必须保留（安全底线）').toBe(true)
      expect(existsSync(noise), '不是会话目录的不许动').toBe(true)
    } finally {
      await api.close()
    }
  })

  it('🔴 无 WebUI 头 ⇒ 403，且**盘上什么都没删**（守卫生效的实质证据）', async () => {
    const old = makeSession('--proj-old--', 'old-1', 40)
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port,
        method: 'POST',
        path: '/serenity/session-cleanup?olderThanDays=30',
        headers: { 'content-type': 'application/json' }, // 故意不带 x-serenity-ui
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: '会话清理仅限 WebUI（client 专用）' })
      expect(existsSync(old)).toBe(true) // 🔴 回 403 不算数 —— 要看**动作没发生**
    } finally {
      await api.close()
    }
  })
})

/**
 * weixin 的三个**写动作**（2026-09-25 · ⑤ 第 11 件）：`save-routes` ／ `set-enabled` ／ `remove-account`
 * —— 它们都只写 **CCC 自己的 `serenity.json`**（`.opencode/serenity.json`）⇒ 临时 CCC 夹具即可。
 *
 * 🔴 **刻意不测 `login-start` 与"带账号的 enable"**（诚实边界）：前者 `fetchQRCode()` 要**真连微信后端**、
 * 后者 `syncCccBridge()` 会**真起轮询循环**（`runAccountLoop`）⇒ 同"外向动作先隔离作用域"的判据：
 * **当前没有假微信后端**，贸然测就是把测试接到真网络上。它们的夹具设计留作后续。
 */
describe('src/api.ts：weixin 的三个写动作（只写 CCC 配置）', () => {
  function writeCccConfig(cfg: unknown): void {
    mkdirSync(join(ccc, '.opencode'), { recursive: true })
    writeFileSync(join(ccc, '.opencode', 'serenity.json'), JSON.stringify(cfg, null, 2))
  }
  // 🔴 2026-10-19：路由行的字段是 `trajectory`（旧字段 `role` 读侧仍作过渡别名，落盘统一写 `trajectory`）
  function readCccConfig(): { weixin?: { enabled?: boolean; routes?: Array<{ user: string; trajectory: string }> } } {
    return JSON.parse(readFileSync(join(ccc, '.opencode', 'serenity.json'), 'utf-8')) as never
  }
  async function postWeixin(port: number, body: Record<string, unknown>): Promise<RawRes> {
    return raw({ port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS, body: JSON.stringify({ ccc, ...body }) })
  }

  it('save-routes：形状不合 ⇒ 400（非数组 ／ 空 user ／ 空 trajectory）；**省略 routes = 清空表**（整体替换语义）', async () => {
    // 🔴 2026-10-19：`serenity.json` 的 `轨迹约束.roles` 段已**退役**（约束面搬进轨迹目录的
    //    `trajectory-constraint.json`）⇒ 本组不再写任何 轨迹约束 配置，路由目标改为**认知轨迹编码**。
    writeCccConfig({})
    const api = await bootApi()
    try {
      // ① 形状层（routes 不是数组）——与旧模型同一条判据，只有文案里的字段名变了
      const notArray = await postWeixin(api.port, { action: 'save-routes', routes: 'nope' })
      expect(notArray.status).toBe(400)
      expect(JSON.parse(notArray.body)).toEqual({ error: 'invalid routes (expected [{user, trajectory}, ...])' })

      // ② 行层（空 user / 空 trajectory）——🔴 新模型下是**两条独立文案**：
      //    旧实现把"非数组"与"行不合法"合成一条 `some(...)` 判据，重做后拆开了。
      //    ⇒ 这里分别断言，钉住"哪类输入得到哪句话"（避免只钉住其中一半）。
      for (const bad of [{ routes: [{ user: '', trajectory: 'qa' }] }, { routes: [{ user: 'u', trajectory: '' }] }]) {
        const res = await postWeixin(api.port, { action: 'save-routes', ...bad })
        expect(res.status, JSON.stringify(bad)).toBe(400)
        expect(JSON.parse(res.body)).toEqual({ error: 'invalid routes (each row needs non-empty user and trajectory)' })
      }

      // 先存一条，再用"省略 routes"把它清掉 —— 钉住「整体替换」语义
      // （首跑时我把它当成"非法输入"，实测是 200：`body.routes ?? []`）
      // 🔴 保存成功的前置：目标轨迹必须**真实存在**（save-routes 校验 `findDirNameByCode`）
      makeTrajectory(ccc, 'qa', 轨迹约束Json({}), '桥接目标')
      await postWeixin(api.port, { action: 'save-routes', routes: [{ user: 'u1', trajectory: 'qa' }] })
      expect(readCccConfig().weixin?.routes).toEqual([{ user: 'u1', trajectory: 'qa' }])

      // 🔴 过渡别名（存量面板/脚本仍在发旧 `role` 字段）：**读侧接受，落盘统一写 `trajectory`**
      const viaAlias = await postWeixin(api.port, { action: 'save-routes', routes: [{ user: 'u1', role: 'qa' }] })
      expect(viaAlias.status).toBe(200)
      expect(readCccConfig().weixin?.routes, '旧 role 字段必须被归一为 trajectory').toEqual([{ user: 'u1', trajectory: 'qa' }])

      const cleared = await postWeixin(api.port, { action: 'save-routes' })
      expect(cleared.status).toBe(200)
      expect(JSON.parse(cleared.body)).toEqual({ saved: 0 })
      expect(readCccConfig().weixin?.routes).toEqual([])
    } finally {
      await api.close()
    }
  })

  it('🔴 save-routes：目标必须是该 CCC 里**真实存在的认知轨迹**；合法时**真写进 CCC 配置**', async () => {
    // 🔴 2026-10-19 换被测对象（不是改断言）：旧判据是"角色 ∈ serenity.json 的 `轨迹约束.roles`"
    //    （该段已退役）；新判据是"**轨迹编码能在 CCC 的 AGENT_SESSIONS/ 里解析到一条目录**"
    //    ⇒ 同样的"不存在即拒绝"语义，落在新载体上。
    writeCccConfig({}) // CCC 里一条轨迹都没有
    const api = await bootApi()
    try {
      const denied = await postWeixin(api.port, { action: 'save-routes', routes: [{ user: 'u1', trajectory: 'qa' }] })
      expect(denied.status).toBe(400)
      expect(String((JSON.parse(denied.body) as { error: string }).error)).toContain('unknown trajectory: qa')
      // 负控：被拒的写入**没落盘**
      expect(readCccConfig().weixin?.routes).toBeUndefined()
    } finally {
      await api.close()
    }

    // 造出那条轨迹后，同一个请求应当成功（同一夹具、只多一条轨迹）
    makeTrajectory(ccc, 'qa', 轨迹约束Json({}), '桥接目标')
    const api2 = await bootApi()
    try {
      const ok = await postWeixin(api2.port, { action: 'save-routes', routes: [{ user: 'u1', trajectory: 'qa' }] })
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.body)).toEqual({ saved: 1 })
      // 🔴 端到端：配置**真落盘**（不是只在内存里），且字段是 `trajectory`
      expect(readCccConfig().weixin?.routes).toEqual([{ user: 'u1', trajectory: 'qa' }])
    } finally {
      await api2.close()
    }
  })

  it('🔴 set-enabled：无账号时 enable ⇒ 400（提示先绑定）且**配置未改**；disable ⇒ 200 且真写入', async () => {
    writeCccConfig({ weixin: { enabled: true } })
    const api = await bootApi()
    try {
      const enable = await postWeixin(api.port, { action: 'set-enabled', enabled: true })
      expect(enable.status).toBe(400)
      expect(JSON.parse(enable.body)).toEqual({ error: '启用前请先扫码绑定至少一个账号' })
      // 负控：被拒时**配置保持原样**（原值就是 true —— 证明它没被"顺手改成 false"）
      expect(readCccConfig().weixin?.enabled).toBe(true)

      const disable = await postWeixin(api.port, { action: 'set-enabled', enabled: false })
      expect(disable.status).toBe(200)
      expect(JSON.parse(disable.body)).toEqual({ enabled: false })
      expect(readCccConfig().weixin?.enabled).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('remove-account：缺 accountId ⇒ 400；未知 action ⇒ 400（都不落盘）', async () => {
    writeCccConfig({})
    const api = await bootApi()
    try {
      const missing = await postWeixin(api.port, { action: 'remove-account' })
      expect(missing.status).toBe(400)
      expect(JSON.parse(missing.body)).toEqual({ error: 'missing accountId' })

      const unknown = await postWeixin(api.port, { action: 'nope' })
      expect(unknown.status).toBe(400)
      expect(JSON.parse(unknown.body)).toEqual({ error: 'unsupported action: nope' })
    } finally {
      await api.close()
    }
  })
})

/**
 * 🔴 ⑤ 第 17 件：`surface/http.ts` 的**错误与边界分支**（客户端真会走到，此前 64 条语句零执行）。
 *
 * 挑靶法（本轮写入地图 §2.7b）：从 `coverage/src/surface/http.ts.html` 的 `cline-no` **反推源行**
 * （该文件 `class="text"` 块起始 HTML 行 = 源行 1）⇒ 得到的是"哪些分支从没走过"，
 * 而不是"哪个文件覆盖率低"（后者已无靶：每个 src 文件都 ≥80%）。
 *
 * 分档（本轮只做**不需要裁决**的那一档）：405 ／ 404 ／ 取值兜底 ／ 事件通知失败 ／ 账号移除——
 * 全是"用户点到了就会走到"的路径。**不碰**待裁项（`readBody` 超限体在实践里被 `req.destroy()`
 * 变成 ECONNRESET ⇒ 断言"400"会把假期望固化）。
 */
describe('src/api.ts：错误与边界分支（⑤ 第 17 件）', () => {
  const jsonBody = (r: RawRes): any => JSON.parse(r.body)
  /** 与上一组同名但**作用域不同**（那一个定义在另一个 describe 内 ⇒ 这里必须自带一份） */
  const postWeixin = (port: number, body: Record<string, unknown>): Promise<RawRes> =>
    raw({ port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS, body: JSON.stringify({ ccc, ...body }) })

  it('🔴 `resolveWorkspace` 两条真路径：`?sessionId=` 取会话 cwd（首选）／无 sessionId 时遍历 live 会话找 CCC', async () => {
    const byId = await bootApi({ sessionCwdById: { 's-1': ccc } })
    try {
      const res = await raw({ port: byId.port, method: 'GET', path: `/serenity/status?sessionId=s-1`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(jsonBody(res).root, 'sessionId → header.cwd 必须被真用上').toBe(ccc)
    } finally {
      await byId.close()
    }

    // 遍历兜底：无 sessionId、无 workspace ⇒ 从 live 会话列表里挑出"能解析出 CCC 的那个 cwd"
    const byList = await bootApi({ liveSessionCwds: [ccc] })
    try {
      const res = await raw({ port: byList.port, method: 'GET', path: `/serenity/status`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(jsonBody(res).root).toBe(ccc)
    } finally {
      await byList.close()
    }

    // 对照（负控）：live 会话的 cwd **不是** CCC ⇒ 不采用它，落到 process.cwd()
    // ⚠️ 这里**不能**断言 `root === null`：测试进程的 cwd 就在真 CCC（本仓）里 ⇒ 回落也会解析出根。
    //    ⇒ 判据取"**没有采用那个非 CCC 的 cwd**"（即没走 197 行的采纳分支）。
    const plainCwd = await bootApi({ liveSessionCwds: [plain] })
    try {
      const res = await raw({ port: plainCwd.port, method: 'GET', path: `/serenity/status`, headers: UI_HEADERS })
      expect(jsonBody(res).root).not.toBe(plain)
      expect(jsonBody(res).root).not.toBe(ccc)
    } finally {
      await plainCwd.close()
    }
  })

  it('🔴 `cccs`：workspace 指向真 CCC ⇒ 走真枚举分支（既有用例只测了"无 CCC ⇒ 空表"）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: `/serenity/cccs?workspace=${encodeURIComponent(ccc)}`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(Array.isArray(jsonBody(res).cccs)).toBe(true)
    } finally {
      await api.close()
    }
  })

  it('🔴 status POST：workspace 解析不到 CCC ⇒ 404 `no CCC found from workspace`，且**盘上零改动**（负控）；非 GET/POST ⇒ 405', async () => {
    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port, method: 'POST', path: '/serenity/status', headers: UI_HEADERS,
        body: JSON.stringify({ workspace: plain, on: true }),
      })
      expect(res.status).toBe(404)
      expect(String(jsonBody(res).error)).toContain('no CCC found from workspace')
      // 🔴 负控：**动作没发生**（不是"回了个 404 就算数"）
      expect(existsSync(join(plain, '.serenity-safe-on'))).toBe(false)

      const del = await raw({ port: api.port, method: 'DELETE', path: '/serenity/status', headers: UI_HEADERS })
      expect(del.status).toBe(405)
    } finally {
      await api.close()
    }
  })

  it('🔴 两条上传端点：**先判方法**（GET ⇒ 405，不因缺 UI 头变 403）＋ workspace 无 CCC ⇒ 404，且盘上无新目录', async () => {
    const api = await bootApi()
    try {
      for (const path of ['/serenity/image-upload', '/serenity/file-upload']) {
        // 刻意**不带** UI 头：证明"方法检查排在守卫之前"（顺序本身是契约的一部分）
        const wrongMethod = await raw({ port: api.port, method: 'GET', path })
        expect(wrongMethod.status, `${path} 的 GET 应为 405`).toBe(405)
        expect(jsonBody(wrongMethod).error).toBe('method not allowed')

        const noCcc = await raw({
          port: api.port, method: 'POST', path, headers: UI_HEADERS,
          body: JSON.stringify({ workspace: plain, data: 'AAAA', mediaType: 'image/png', name: 'x.txt' }),
        })
        expect(noCcc.status, `${path} 无 CCC 应为 404`).toBe(404)
        expect(String(jsonBody(noCcc).error)).toContain('no CCC found from workspace')
      }
      // 负控：两条落盘目录都不该被建出来
      expect(existsSync(join(plain, '_tmp'))).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('🔴 weixin GET **带账号**：`bound` 按 localstore 凭据真伪两态（此前只测了空账号表 ⇒ 该映射整段零执行）', async () => {
    mkdirSync(join(ccc, '.opencode'), { recursive: true })
    writeFileSync(join(ccc, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: { accounts: [{ accountId: 'wechat-1', name: '微信 1' }, { accountId: 'wechat-2' }] },
    }, null, 2))
    writeFileSync(join(ccc, 'localstore.json'), JSON.stringify({
      credentials: { WEIXIN_WECHAT_1_TOKEN: 'tok-1' },
    }, null, 2))
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      const body = jsonBody(res) as { accounts: Array<{ accountId: string; name?: string; enabled: boolean; bound: boolean; channel?: string }> }
      // 🔴 2026-10-19（P2 面板）起 wire **必须带 `channel`**：面板按它选标签与绑定表单；
      //    缺字段 ⇒ 飞书账号被显示成「微信」且只给扫码入口（用户"不知道怎么配"的直接成因）。
      //    行的 `channel` 缺省归一为 `weixin`（存量配置不必补这个字段）。
      expect(body.accounts).toEqual([
        { accountId: 'wechat-1', name: '微信 1', enabled: true, channel: 'weixin', bound: true },
        { accountId: 'wechat-2', name: undefined, enabled: true, channel: 'weixin', bound: false },
      ])
      // 脱敏不变量（强化版）：token 值本身也**不出现**在 wire 上
      expect(res.body).not.toContain('tok-1')
      expect(res.body).not.toContain('WEIXIN_WECHAT_1_TOKEN')
      expect(body.accounts[0]).not.toHaveProperty('token')
    } finally {
      await api.close()
    }
  })

  /**
   * 🔴 回归钉（2026-10-19，P2 读数面缺陷）：`bound` 必须**按渠道**判。
   *
   * 原先这里对**所有**账号都调 `readWeixinCredential`（只看 `WEIXIN_<A>_TOKEN`）⇒
   * 一个凭据齐全的**飞书**账号（`FEISHU_<A>_APPID|SECRET`）必然被读成"未绑定"，
   * ⇒ 面板显示「未绑定凭据」⇒ 用户据此以为没配上，反复重填。
   *
   * 变异检验：把 `imCredentialBound` 换回 `readWeixinCredential` ⇒ 本用例 feishu-1 的
   * `bound` 变 false ⇒ 当场红。
   */
  it('🔴 weixin GET 飞书账号：`bound` 走 FEISHU_* 凭据（用微信读法必然读到 null）', async () => {
    mkdirSync(join(ccc, '.opencode'), { recursive: true })
    writeFileSync(join(ccc, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: {
        accounts: [
          { accountId: 'feishu-1', channel: 'feishu', name: '飞书机器人' },
          { accountId: 'feishu-2', channel: 'feishu' },
        ],
      },
    }, null, 2))
    writeFileSync(join(ccc, 'localstore.json'), JSON.stringify({
      credentials: { FEISHU_FEISHU_1_APPID: 'cli_x', FEISHU_FEISHU_1_SECRET: 'sec-x' },
    }, null, 2))
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      const body = jsonBody(res) as { accounts: Array<{ accountId: string; bound: boolean; channel?: string }> }
      expect(body.accounts.map((a) => ({ id: a.accountId, channel: a.channel, bound: a.bound }))).toEqual([
        { id: 'feishu-1', channel: 'feishu', bound: true },
        { id: 'feishu-2', channel: 'feishu', bound: false },
      ])
      // 凭据值不得上 wire（appSecret 是密）
      expect(res.body).not.toContain('sec-x')
      expect(res.body).not.toContain('FEISHU_FEISHU_1_SECRET')
    } finally {
      await api.close()
    }
  })

  it('🔴 weixin POST 边界：非 POST ⇒ 405；**缺 ccc ⇒ 400 `missing ccc param`**（此前只测了 GET 一侧）', async () => {
    const api = await bootApi()
    try {
      const put = await raw({ port: api.port, method: 'PUT', path: '/serenity/weixin', headers: UI_HEADERS, body: '{}' })
      expect(put.status).toBe(405)

      const noCcc = await raw({ port: api.port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS, body: JSON.stringify({ action: 'login-start' }) })
      expect(noCcc.status).toBe(400)
      expect(jsonBody(noCcc)).toEqual({ error: 'missing ccc param' })
    } finally {
      await api.close()
    }
  })

  it('🔴 `remove-account` 成功路径：账号与凭据**都从盘上消失**（此前只测了缺参 400）', async () => {
    mkdirSync(join(ccc, '.opencode'), { recursive: true })
    writeFileSync(join(ccc, '.opencode', 'serenity.json'), JSON.stringify({
      weixin: { accounts: [{ accountId: 'wechat-1' }], routes: [{ user: 'u1', role: 'qa' }] },
    }, null, 2))
    writeFileSync(join(ccc, 'localstore.json'), JSON.stringify({
      credentials: { WEIXIN_WECHAT_1_TOKEN: 'tok-1', WEIXIN_WECHAT_1_BASEURL: 'https://x.invalid' },
    }, null, 2))
    const api = await bootApi()
    try {
      const res = await postWeixin(api.port, { action: 'remove-account', accountId: 'wechat-1' })
      expect(res.status).toBe(200)
      expect(jsonBody(res)).toEqual({ removed: 'wechat-1' })

      // 🔴 盘上读数（不看响应自述）
      const cfg = JSON.parse(readFileSync(join(ccc, '.opencode', 'serenity.json'), 'utf-8')) as { weixin?: { accounts?: unknown[]; routes?: unknown[] } }
      expect(cfg.weixin?.accounts).toEqual([])
      expect(cfg.weixin?.routes, '移除账号不该动路由表').toEqual([{ user: 'u1', trajectory: 'qa' }])
      const creds = JSON.parse(readFileSync(join(ccc, 'localstore.json'), 'utf-8')) as { credentials?: Record<string, string> }
      expect(Object.keys(creds.credentials ?? {}).filter((k) => k.startsWith('WEIXIN_WECHAT_1_'))).toEqual([])
    } finally {
      await api.close()
    }
  })

  it('🔴 config PUT：**事件通知抛错仍回 200**（`serenity/config-updated` 只是通知，不是保存的一部分）', async () => {
    const api = await bootApi({ emitThrows: true })
    try {
      const res = await raw({ port: api.port, method: 'PUT', path: '/serenity/config', headers: UI_HEADERS, body: JSON.stringify({ config: {} }) })
      expect(res.status).toBe(200)
      expect(jsonBody(res).config, '保存结果必须照常返回').toBeTypeOf('object')
    } finally {
      await api.close()
    }
  })
})

/**
 * 🔴 ⑤ 第 18 件：`surface/http.ts` 的**残余 catch 与尾部支线**（第 17 件后剩 22 条里的可覆盖部分）。
 *
 * 🔵 **本件的判据要点：用"真实故障形态"触发 catch，不用 mock 制造异常**（§4.2-㊾）。
 *    三种形态都是产线上真会发生的：① 宿主服务读取抛错（cordis Proxy 对未声明服务确实会抛）
 *    ② 请求体不是合法 JSON（面板发坏包）③ `DSH_HOME` 被指到一个**文件**（配置被写坏）。
 *
 * ⚠️ 唯一**刻意不覆盖**的一条：`resolveWorkspace` 的 `catch`（"遍历失败 → 空列表"）——
 *    实测**构造上不可达**（三层访问器全吞异常），硬凑会把"从不发生"固化成"期望形态"
 *    ⇒ 已登记地图 §3-8 第 9 行。
 */
describe('src/api.ts：残余 catch 与尾部支线（⑤ 第 18 件）', () => {
  const jsonBody = (r: RawRes): any => JSON.parse(r.body)

  it('🔴 宿主服务读取抛错 ⇒ `cccs` 的 catch 回 400（不是 500、不是崩）', async () => {
    const api = await bootApi({ sessionGetThrows: true })
    try {
      // 🔴 2026-10-14：原用例同时覆盖 `cheapWorkers` 与 `cccs`；前者已退场 ⇒ 只剩后者。
      //    （那条端点现在直接 404，走不到 catch —— 见"接线自证"组的否定断言。）
      const path = '/serenity/cccs'
      const res = await raw({ port: api.port, method: 'GET', path: `${path}?sessionId=s-1`, headers: UI_HEADERS })
      expect(res.status, `${path} 应把异常收敛成 400`).toBe(400)
      expect(String(jsonBody(res).error)).toContain('sessions.get boom')
    } finally {
      await api.close()
    }
  })

  it('🔴 config GET：工作区服务**抛错** ⇒ 仍 200 且 `knownWorkspaces: []`（面板显示"暂无可选工作区"，不是整页失败）', async () => {
    const api = await bootApi({ registryListThrows: true })
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/config', headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(jsonBody(res).knownWorkspaces).toEqual([])
      expect(jsonBody(res).config, '配置本体必须照常返回').toBeTypeOf('object')
    } finally {
      await api.close()
    }
  })

  it('🔴 坏 JSON 请求体 ⇒ `config PUT` 的 catch 回 400（面板发坏包的真实形态）', async () => {
    const api = await bootApi()
    try {
      const cfg = await raw({ port: api.port, method: 'PUT', path: '/serenity/config', headers: UI_HEADERS, body: '{ not json' })
      expect(cfg.status).toBe(400)
      expect(String(jsonBody(cfg).error)).toMatch(/JSON|Unexpected/i)

      // ⚠️ 2026-10-15：原同批还测 `public-ask PUT` 的 catch；该端点已随面 E 退役 ⇒
      //    它现在**由路由层 404 拦下、根本进不到 catch**（见上面的退役专项用例）。
      const retired = await raw({ port: api.port, method: 'PUT', path: '/serenity/public-ask', headers: UI_HEADERS, body: '{ not json' })
      expect(retired.status, '退役端点不得进入任何 handler').toBe(404)
    } finally {
      await api.close()
    }
  })

  it('🔴 `public-ask` 已退役：任意方法（POST）⇒ 404（路由层拦下，不再有 405 语义）', async () => {
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'POST', path: '/serenity/public-ask', headers: UI_HEADERS, body: '{}' })
      expect(res.status).toBe(404)
    } finally {
      await api.close()
    }
  })

  it('🔴 `session-cleanup`：非 GET/POST ⇒ 405；`sessions.list()` 抛错 ⇒ catch 回 400（它在端点里是**裸调用**，不被收口层吞）', async () => {
    const wrongMethod = await bootApi()
    try {
      const del = await raw({ port: wrongMethod.port, method: 'DELETE', path: '/serenity/session-cleanup', headers: UI_HEADERS })
      expect(del.status).toBe(405)
    } finally {
      await wrongMethod.close()
    }

    // 🔵 真实故障形态的对照（**已实测**）：把 `DSH_HOME` 指到一个**文件** *不会* 让这条端点失败
    //    （会话根不可读被它自己容错成"零候选"）⇒ 所以这条 catch 的触发面是**服务调用抛错**，不是 fs。
    const api = await bootApi({ sessionListThrows: true })
    try {
      const bad = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup?olderThanDays=30', headers: UI_HEADERS })
      expect(bad.status).toBe(400)
      expect(String(jsonBody(bad).error)).toContain('sessions.list boom')
    } finally {
      await api.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🆕 2026-09-25 ⑤ 第 31 件：`resolveWorkspace` 的**默认箭头**（`listCwds = () => []`）
//
// 挑靶依据 = **先逐行读覆盖率报告的 `cstat-no`/`fstat-no`**（别按 branch% 排序硬上）：
// 当时 `surface/http.ts` 的**唯一未执行函数**就是那句默认箭头（语句面已 99.73%，另一处 2 条属
// **构造上不可达**的 catch ⇒ 地图 §3-8 第 9 行已登记）⇒ 补掉它即可让该文件**函数面全满**。
//
// 🔴 为什么既有用例没覆盖到：⑰ 件那组测的是"**列表存在**"的两条路（`sessions.get` ／
//    `sessions.list`），而默认箭头只在 **宿主连 `sessions` 服务都没有**时才存活到被调用。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **独立读数器**：从 `process.cwd()` 上溯找 `.serenity`（= CCC 标记）。
 * 🔴 刻意**不复用** `cccRootForCwd` —— 用实现去验实现是自证（读数器要先证明不瞎，纪律 §2.7j）。
 */
function enclosingCccFromCwd(): string | null {
  let cur = process.cwd()
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(cur, '.serenity'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

describe('src/api.ts：`resolveWorkspace` 的默认箭头（⑤ 第 31 件）', () => {
  const jsonBody = (r: RawRes): any => JSON.parse(r.body)

  it('🔴 宿主无 `sessions` 服务 ⇒ 默认箭头 `() => []` 被真调用 ⇒ 回落 `process.cwd()`（含判别性对照）', async () => {
    // 夹具自证：`bootApi()` 不带任何 opts ⇒ `ctx.get('sessions')` 返回 undefined
    // ⇒ `listCwds` **保持默认箭头**（既有的两条件路都会把它换掉）
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/status', headers: UI_HEADERS })
      expect(res.status).toBe(200)
      const enclosing = enclosingCccFromCwd()
      if (enclosing === null) {
        // 本仓被检出到任何 CCC 之外 ⇒ cwd 上溯无所获
        expect(jsonBody(res).root).toBeNull()
      } else {
        // 本仓位于 `<外层 CCC>/AI_LAB/dsh-serenity-plugin` 之下 ⇒ 落点是**外层那个 CCC**
        expect(jsonBody(res).root, '默认箭头 ⇒ 空列表 ⇒ 回落 process.cwd()').toBe(enclosing)
      }
    } finally {
      await api.close()
    }
  })

  it('🔴 判别性对照：同一条链上**只要** `sessions.list` 在场，落点就变成它给的 cwd（不是 `process.cwd()`）', async () => {
    const api = await bootApi({ liveSessionCwds: [ccc] })
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/status', headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(jsonBody(res).root, '列表在场 ⇒ 采用它的 cwd').toBe(ccc)
      expect(jsonBody(res).root, '且**不是** cwd 上溯的结果').not.toBe(enclosingCccFromCwd())
    } finally {
      await api.close()
    }
  })
})
