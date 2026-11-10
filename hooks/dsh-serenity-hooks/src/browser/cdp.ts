/**
 * browser/cdp.ts — 槽位的 CDP 客户端（页面操作的唯一实现）
 *
 * 🔴🔴 **这个文件的存在理由**（owner 2026-11-10 令）：
 *    「我希望所有浏览器能力都集中到这个 browser_slot」
 *
 *    在此之前能力被**切在两处**：`browser_slot` 管槽位（端口/进程/归属），
 *    `browser` MSM 管页面（goto/eval/shot）。而两者**各写一份端口表**，
 *    于是 2026-11-09 出现「槽位租到了、没有任何工具能操作它」——
 *    两段端口一个数都不重叠。**那不是配置不一致，是同一件事有两个实现。**
 *
 *    ⇒ 本文件把页面操作搬进 ACC，`browser` MSM 随之退场（只留一条退役指引）。
 *
 * ## 为什么零依赖（不引 `ws` 包）
 *
 * 运行时自带 `WebSocket`（Node ≥21 / bun 都有），CDP 只需要
 * 「发一条 JSON、按 id 收一条结果」这一个能力。引第三方 ws 包会让
 * 装机面多一个运行时依赖，而它换来的是本文件 40 行就能写完的东西。
 * （先例：`home-browser/scripts/browser.ts` 的注释里也记着同一个取舍。）
 *
 * ## 与既有实现的关系
 *
 * 语义逐条对齐 `home-browser/scripts/browser.ts` 的 12 个子命令 ——
 * 那些行为有真实使用与踩坑记录（4 条轨迹的手册在用）。搬的时候**不为好看改语义**。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { slotPort } from './state.js'

/** 一条 CDP 连接上的相关器：发出去的 id → 待兑现的 promise */
interface CdpConn {
  ws: WebSocket
  nextId: number
  pending: Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>
}

/** 连一个 WS 端点（带超时；超时即拒绝，⛔ 不无限等） */
async function wsConnect(url: string, timeoutMs = 8000): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`WebSocket 连接超时: ${url}`)), timeoutMs)
    ws.onopen = () => {
      clearTimeout(t)
      res()
    }
    ws.onerror = (ev: unknown) => {
      clearTimeout(t)
      rej(new Error(`WebSocket 连接失败: ${String((ev as { message?: string })?.message ?? 'error')}`))
    }
  })
  return ws
}

/** 挂上 id→promise 相关器 */
function attach(ws: WebSocket): CdpConn {
  const conn: CdpConn = { ws, nextId: 1, pending: new Map() }
  ws.onmessage = (ev: { data: unknown }) => {
    let msg: { id?: number; result?: unknown; error?: { message?: string; data?: string } }
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (msg.id && conn.pending.has(msg.id)) {
      const p = conn.pending.get(msg.id)!
      conn.pending.delete(msg.id)
      if (msg.error) {
        p.rej(new Error(`${msg.error.message ?? 'CDP error'}${msg.error.data ? ` (${msg.error.data})` : ''}`))
      } else {
        p.res(msg.result)
      }
    }
  }
  return conn
}

/** 发一条 CDP 方法调用并等结果 */
function cdpRaw(
  conn: CdpConn,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const id = conn.nextId++
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      conn.pending.delete(id)
      rej(new Error(`CDP ${method} 超时 ${timeoutMs}ms`))
    }, timeoutMs)
    conn.pending.set(id, {
      res: (v) => {
        clearTimeout(t)
        res(v as Record<string, unknown>)
      },
      rej: (e) => {
        clearTimeout(t)
        rej(e)
      },
    })
    conn.ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 取 `/json/version`（浏览器级 WS 端点） */
async function httpJson(port: number, path: string): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`CDP 端点 ${path} 返回 ${r.status}（端口 ${port}）`)
  return await r.json()
}

/** 一个页面 target 的最小视图 */
export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
}

/** 列 targets */
export async function listTargets(slot: number): Promise<CdpTarget[]> {
  const port = slotPort(slot)
  const raw = (await httpJson(port, '/json/list')) as Array<Record<string, unknown>>
  return raw.map((t) => ({
    id: String(t.id ?? t.targetId ?? ''),
    type: String(t.type ?? ''),
    title: String(t.title ?? ''),
    url: String(t.url ?? ''),
  }))
}

/**
 * 找页面 target 的 WS 端点。
 *
 * 🔴 `slot` 与 `targetId` **必须同时给**：只给 targetId 会让「哪个槽位」变成隐含状态，
 *    而槽位是循环复用的（b1 今天给 A 用、明天给 B 用）⇒ 那条 targetId 可能属于**另一个人**。
 *    ⇒ 调用方必须先亮明槽位，这一层再在这个槽位的端口上找。
 */
async function pageWsUrl(slot: number, targetId: string): Promise<string> {
  const port = slotPort(slot)
  const list = (await httpJson(port, '/json/list')) as Array<Record<string, unknown>>
  const t = list.find((x) => x.id === targetId || x.targetId === targetId)
  if (!t) {
    throw new Error(
      `槽位 b${slot}（端口 ${port}）上没有这个 target: ${targetId}\n` +
        `  ⇒ 现有 target：\n${list.map((x) => `     ${String(x.type)} ${String(x.id)} ${String(x.url)}`).join('\n')}`,
    )
  }
  const ws = t.webSocketDebuggerUrl
  if (!ws) throw new Error(`target ${targetId} 没有 webSocketDebuggerUrl（type=${String(t.type)}）`)
  return String(ws)
}

async function browserWsUrl(slot: number): Promise<string> {
  const port = slotPort(slot)
  const v = (await httpJson(port, '/json/version')) as Record<string, unknown>
  if (!v.webSocketDebuggerUrl) throw new Error(`/json/version 未给 webSocketDebuggerUrl（端口 ${port}）`)
  return String(v.webSocketDebuggerUrl)
}

/** 在页面里求值（`awaitPromise` + `returnByValue`，与既有实现同口径） */
export async function evalInPage(
  slot: number,
  targetId: string,
  expression: string,
  timeoutMs = 30_000,
): Promise<unknown> {
  const conn = attach(await wsConnect(await pageWsUrl(slot, targetId)))
  try {
    const r = await cdpRaw(
      conn,
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs,
    )
    const ex = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    if (ex) {
      throw new Error(`页面内求值抛错：${ex.text ?? ''}\n  ${ex.exception?.description?.slice(0, 500) ?? ''}`)
    }
    return (r.result as { value?: unknown } | undefined)?.value
  } finally {
    conn.ws.close()
  }
}

/** 导航 */
export async function navigate(slot: number, targetId: string, url: string): Promise<void> {
  const conn = attach(await wsConnect(await pageWsUrl(slot, targetId)))
  try {
    await cdpRaw(conn, 'Page.enable')
    await cdpRaw(conn, 'Page.navigate', { url })
  } finally {
    conn.ws.close()
  }
}

/** 新建标签页，返回 targetId */
export async function openTab(slot: number, url: string): Promise<string> {
  const conn = attach(await wsConnect(await browserWsUrl(slot)))
  try {
    const r = await cdpRaw(conn, 'Target.createTarget', { url })
    return String(r.targetId ?? '')
  } finally {
    conn.ws.close()
  }
}

/** 关标签页（`all=true` 关全部 page 类型的） */
export async function closeTab(slot: number, targetId: string, all = false): Promise<string[]> {
  const conn = attach(await wsConnect(await browserWsUrl(slot)))
  try {
    const list = (await httpJson(slotPort(slot), '/json/list')) as Array<Record<string, unknown>>
    const victims = all
      ? list.filter((t) => t.type === 'page')
      : list.filter((t) => String(t.id) === targetId)
    if (victims.length === 0) throw new Error(`没有匹配的 target（given=${all ? '--all' : targetId}）`)
    const closed: string[] = []
    for (const v of victims) {
      await cdpRaw(conn, 'Target.closeTarget', { targetId: String(v.id) })
      closed.push(String(v.id))
    }
    return closed
  } finally {
    conn.ws.close()
  }
}

/**
 * 真实鼠标点击（CDP `Input.dispatchMouseEvent`）。
 *
 * 🔴 **为什么不用 `el.click()`**：它只派发一次合成 `click`，**不产生 pointerdown/mousedown/mouseup**，
 *    也不做命中测试。React/Vue 之外的大量组件库（含 `choerodon-ui`、多数下拉/浮层）
 *    监听的是 `pointerdown`/`mousedown` ⇒ 用 `el.click()` 会得到"脚本执行成功、界面毫无反应"，
 *    而那正是最难查的一种——**没报错，也没发生**。
 *
 * 🔴 顺序与坐标：`mouseMoved` → `mousePressed` → `mouseReleased`，三次同一坐标。
 *    ⛔ 不发 `mousePressed` 就发 `mouseReleased` 会被 Chrome 丢弃（且**不报错**）。
 */
export async function clickAt(slot: number, targetId: string, x: number, y: number): Promise<void> {
  const conn = attach(await wsConnect(await pageWsUrl(slot, targetId)))
  try {
    const base = { x, y, button: 'left' as const, clickCount: 1 }
    await cdpRaw(conn, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdpRaw(conn, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await cdpRaw(conn, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  } finally {
    conn.ws.close()
  }
}

/** 正文（`document.body.innerText`） */
export async function pageText(slot: number, targetId: string): Promise<string> {
  const v = await evalInPage(slot, targetId, "document.body ? document.body.innerText : ''")
  return String(v ?? '')
}

/** HTML（默认截断 4000，同既有实现） */
export async function pageHtml(slot: number, targetId: string, max = 4000): Promise<string> {
  const v = await evalInPage(slot, targetId, 'document.documentElement.outerHTML')
  const s = String(v ?? '')
  return s.length > max ? `${s.slice(0, max)}\n… [truncated, ${s.length} chars total]` : s
}

/**
 * 截图并存盘。
 *
 * 🔴 落点**必须在 CCC 根内**（`resolveInside` 语义在这里手写，因为本层不知道 CCC 根）：
 *    调用方传进来的 `outAbs` 必须已经通过越界检查 —— 本函数只负责写。
 *    ⛔ 不在这里自己算根：那会造出第二个「根在哪」的判定点。
 */
export async function screenshot(slot: number, targetId: string, outAbs: string): Promise<void> {
  const conn = attach(await wsConnect(await pageWsUrl(slot, targetId)))
  try {
    const r = await cdpRaw(conn, 'Page.captureScreenshot', { format: 'png' }, 20_000)
    mkdirSync(dirname(outAbs), { recursive: true })
    writeFileSync(outAbs, Buffer.from(String(r.data ?? ''), 'base64'))
  } finally {
    conn.ws.close()
  }
}

/** 重载，可选先装「新文档脚本」（要在应用发请求之前挂探针时用） */
export async function reloadPage(
  slot: number,
  targetId: string,
  script?: string,
  timeoutMs = 25_000,
): Promise<string> {
  const conn = attach(await wsConnect(await pageWsUrl(slot, targetId)))
  try {
    await cdpRaw(conn, 'Page.enable')
    if (script) await cdpRaw(conn, 'Page.addScriptToEvaluateOnNewDocument', { source: script })
    await cdpRaw(conn, 'Page.reload', { ignoreCache: true })
    const deadline = Date.now() + timeoutMs
    let state = ''
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      try {
        const r = await cdpRaw(
          conn,
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          5000,
        )
        state = String((r.result as { value?: unknown } | undefined)?.value ?? '')
        if (state === 'complete') break
      } catch {
        /* 导航中，继续等 */
      }
    }
    return state
  } finally {
    conn.ws.close()
  }
}

/**
 * 一次 CDP 就绪探测（给 `wait` 动作与 `acquire --wait` 用）。
 * 判据与 `process.ts` 的 `waitCdp` 不同：那一个管**进程稳定性**（自杀窗口），
 * 这一个只回答「端点此刻答不答话」。⛔ 不要互相替代。
 */
export async function probeCdpOnce(slot: number, timeoutMs = 1200): Promise<boolean> {
  const port = slotPort(slot)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return false
    const b = await r.json()
    return typeof b === 'object' && b !== null
  } catch {
    return false
  }
}

/** 把相对落点解析成绝对路径，并做越界检查（截图用） */
export function resolveShotPath(cccRoot: string, relOrAbs: string): string {
  const abs = resolve(cccRoot, relOrAbs)
  const rootResolved = resolve(cccRoot)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error(`截图落点越界（必须在 CCC 根内）：${relOrAbs}`)
  }
  return abs
}

/** 导出给测试用（⛔ 生产代码不要直接调这两个） */
export const __test = { attach, cdpRaw }
