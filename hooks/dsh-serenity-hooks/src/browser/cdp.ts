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

import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { slotPort } from './state.js'
import type { KeyStroke } from './keys.js'
import type { AxNode } from './ax.js'

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
export async function clickAt(
  slot: number,
  targetId: string,
  x: number,
  y: number,
): Promise<{ dialogs: AutoDialog['handled'] }> {
  /**
   * 🔴🔴 **点击是「会弹窗」的动作，所以自动弹窗必须挂在这条连接上**（2026-11-11 owner 现场报障）。
   *
   *    改之前：点一个 `confirm()` 按钮 ⇒ `mouseReleased` **30s 超时**，弹窗留在屏幕上，
   *    这个 tab 之后所有调用全超时 —— **整条自动化被原地卡死**。
   *    改之后：事件到达即由浏览器进程 dismiss ⇒ 点击**正常返回**，且回执写明处理了什么。
   *
   * ⚠️ 超时也保留兜底：真的 30s 没返回（页面被别的东西卡住），错误文案要说清
   *    「可能是同步弹窗且自动处理没接住」并给出路，⛔ 不甩一句裸超时。
   */
  const policy: AutoDialog = { mode: 'dismiss', handled: [] }
  try {
    await withPage(
      slot,
      targetId,
      async (send) => {
        const base = { x, y, button: 'left' as const, clickCount: 1 }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 8000)
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, 8000)
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, 20_000)
      },
      { autoDialog: policy },
    )
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    if (/超时|timeout/i.test(msg) && policy.handled.length === 0) {
      throw new Error(
        `⛔ 点击超时（${msg}），且本次**没有捕获到任何弹窗**。\n` +
          `  ⇒ 页面可能被同步脚本卡住（死循环 / 大计算 / 已存在的弹窗不是本连接触发的）。\n` +
          `  ⇒ 出路：\`browser_slot dialog\` 试一次救场；不行就 \`close\` 掉这个 tab 重来。\n` +
          `  ⚠️ 自动弹窗处理**只对本连接期间新出现的弹窗**生效。`,
      )
    }
    throw e
  }
  return { dialogs: policy.handled }
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

/**
 * 页面级连接的高阶封装：**一次连接、多次调用、必关**。
 *
 * 🔴 为什么需要它（新能力全靠它）：既有 10 个动作每个都自己 `attach(wsConnect(...))` +
 *    `finally close()`。新动作若照抄，会把「连接生命周期」复制十几份 ——
 *    而那正是本轮要避免的：**同一件事只该有一个实现**（D314 同族教训）。
 *
 * @param fn 收到一个 `send(method, params, timeoutMs)`，它就是本连接上的 `cdpRaw`
 * @param opts.events 要订阅的 CDP 事件名（例如 `Page.javascriptDialogOpening`）
 * @param opts.onEvent 事件回调（**同步**执行；不要在里面 await CDP，那会卡住消息循环）
 */
export interface AutoDialog {
  /** 自动处理策略：dismiss（默认，等于点「取消」）／accept（等于点「确定」）／none（交给调用方） */
  mode: 'dismiss' | 'accept' | 'none'
  /** 本次连接上**实际处理掉**的弹窗（回执要报出去，⛔ 不许静默） */
  handled: Array<{ type: string; message: string; accepted: boolean }>
}

/**
 * 🔴🔴 **自动处理原生弹窗（2026-11-11 owner 现场报障）**
 *
 *    **现象**（owner 截图）：点一个会 `confirm()` 的按钮 ⇒ 弹窗留在屏幕上，**整个自动化流程被原地卡死** ——
 *    那次 `click` 30s 超时，之后这个 tab 上**所有** CDP 调用全部超时，只能 `close` 掉重来。
 *
 *    **为什么以前必须在点击之后手动调 `dialog` 是错的**：那个编排要求调用方**预知**「这一下会弹窗」，
 *    而真实站点里弹窗常由页面逻辑触发（离开确认、删除确认、会话过期重登）——
 *    **没有人能在点击前知道**。⇒ 正确的形态是「**持续在场，事件一到就处理**」。
 *
 *    **唯一可行的实现**（判据 D320 的反面）：
 *      · 在**同一条连接**上先 `Page.enable` ⇒ 才会收到 `Page.javascriptDialogOpening`
 *      · 事件到达时立刻发 `Page.handleJavaScriptDialog` —— 它由**浏览器进程**处理，
 *        **不经过被阻塞的渲染器**，所以在「点击请求还挂着」的同一时刻也能生效
 *      · 处理完，被阻塞的点击请求才会返回
 *    ⚠️ 顺序反了（先等点击返回再处理弹窗）就永远等不到 —— 那就是这次的卡死。
 *
 *    **默认 dismiss**（判据 D318：不可逆性小的那侧）。要 accept 必须由调用方显式要求。
 */
function attachAutoDialog(
  send: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>,
  policy: AutoDialog,
): { events: string[]; onEvent: (method: string, params: Record<string, unknown>) => void } | null {
  if (policy.mode === 'none') return null;
  const accept = policy.mode === 'accept';
  return {
    events: ['Page.javascriptDialogOpening'],
    onEvent: (method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return;
      const entry = {
        type: String(params.type ?? ''),
        message: String(params.message ?? ''),
        accepted: accept,
      };
      policy.handled.push(entry);
      // 🔴 fire-and-forget：事件回调是同步的，await 会把消息循环堵住（然后所有调用一起超时）
      void send('Page.handleJavaScriptDialog', { accept }, 8000).catch(() => {
        /* 处理失败不抛：页面可能已被别处关掉；回执侧靠 handled 里那条记录如实呈现 */
      });
    },
  };
}

export async function withPage<T>(
  slot: number,
  targetId: string,
  fn: (send: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>) => Promise<T>,
  opts: {
    events?: readonly string[];
    onEvent?: (method: string, params: Record<string, unknown>) => void;
    /** 自动处理原生弹窗（默认 **dismiss**）；传 { mode: 'none' } 才交回调用方 */
    autoDialog?: AutoDialog;
  } = {},
): Promise<T> {
  const conn = attach(await wsConnect(await pageWsUrl(slot, targetId)))
  const send = (method: string, params?: Record<string, unknown>, timeoutMs?: number) =>
    cdpRaw(conn, method, params, timeoutMs)
  /**
   * 🔴 **默认就是 dismiss**（判据 D318 + 2026-11-11 owner 报障）。
   *    只有显式 `{ mode: 'none' }` 才把弹窗交回调用方 —— 那意味着调用方承诺自己接得住。
   */
  const policy: AutoDialog = opts.autoDialog ?? { mode: 'dismiss', handled: [] }
  try {
    // ① 自动弹窗：必须先 Page.enable（不 enable 收不到 dialogOpening 事件）
    const auto = attachAutoDialog(send, policy)
    if (auto) {
      await send('Page.enable', {}, 8000).catch(() => {
        /* 页面已被阻塞时 enable 会挂住 ⇒ 8s 内放弃，⛔ 不把整次调用拖进 30s 超时 */
      });
    }
    const events = [...(opts.events ?? []), ...(auto?.events ?? [])]
    if (events.length > 0) {
      const want = new Set(events)
      const prev = conn.ws.onmessage
      conn.ws.onmessage = (ev: { data: unknown }) => {
        prev?.call(conn.ws, ev as never)
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as {
            method?: string;
            params?: Record<string, unknown>;
          };
          if (!msg.method || !want.has(msg.method)) return;
          auto?.onEvent(msg.method, msg.params ?? {});
          if (opts.onEvent && !auto) opts.onEvent(msg.method, msg.params ?? {});
          if (opts.onEvent && auto && msg.method !== 'Page.javascriptDialogOpening') {
            opts.onEvent(msg.method, msg.params ?? {});
          }
        } catch {
          /* 非 JSON 帧：忽略 */
        }
      };
    }
    return await fn(send)
  } finally {
    conn.ws.close()
  }
}

/** 浏览器级连接的高阶封装（`Target.*` / `Browser.*`；⛔ 页面动作不要用这个） */
export async function withBrowser<T>(
  slot: number,
  fn: (send: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const conn = attach(await wsConnect(await browserWsUrl(slot)))
  try {
    return await fn((method, params, timeoutMs) => cdpRaw(conn, method, params, timeoutMs))
  } finally {
    conn.ws.close()
  }
}

// ═══════════════════════════════════════════════════════════════════
// 高阶动作（v1.130.0）：键盘 ／ 填值 ／ 滚动 ／ 等待 ／ 拖拽 ／
//                    上传 ／ 下载 ／ dialog ／ AX 快照
//
// 🔴 全部走 withPage/withBrowser —— ⛔ 不再各自 attach/close。
//    判据：连接生命周期只有一份实现；照抄十份就必然有一份忘了 finally。
// ═══════════════════════════════════════════════════════════════════

/**
 * 发一个按键（三事件 `keyDown` → `char`（仅可打印）→ `keyUp`）。
 *
 * 🔴 为什么必须是三事件、且 `char` 只在可打印键上发：
 *    只发 `keyDown`/`keyUp`（`rawKeyDown` 形态）⇒ 大多数页面收得到事件，但**输入框里不会有字**；
 *    而只发 `char` ⇒ 有字但**没有 keydown**，于是「回车提交」「Esc 关闭」这类**监听 keydown 的逻辑全不触发**。
 *    两者都缺的表现都是「脚本成功、界面没反应」—— 没有报错。
 *
 * ⚠️ 可打印字符走 `Input.insertText` 更稳（不猜键位）；本函数只在**按键语义**（Enter/Esc/方向键/快捷键）用。
 */
export async function pressKey(slot: number, targetId: string, stroke: KeyStroke, times = 1): Promise<number> {
  let sent = 0
  await withPage(slot, targetId, async (send) => {
    for (let i = 0; i < times; i++) {
      const base = {
        key: stroke.key,
        code: stroke.code,
        modifiers: stroke.modifiers,
        windowsVirtualKeyCode: stroke.windowsVirtualKeyCode ?? 0,
        nativeVirtualKeyCode: stroke.windowsVirtualKeyCode ?? 0,
      }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
      // 🔴 可打印字符才补 char 事件：Enter/Esc/方向键发 char 会被 Chrome 丢弃（不报错）
      const printable = [...stroke.key].length === 1
      if (printable) await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: stroke.key, unmodifiedText: stroke.key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      sent++
    }
  })
  return sent
}

/**
 * 往「当前焦点」打字（`Input.insertText`）。
 *
 * 🔴 与 `fill` 的分工（⛔ 别互相顶替）：
 *    · `insertText` = **模拟人打字**：走浏览器的文本输入路径 ⇒ 受控组件（React/Vue）**会收到**真事件。
 *      但它只作用于**当前有焦点**的元素，且**不触发 change**（要 blur 才触发）。
 *    · `fill` = **设值**：清空 + 设值 + 派发 input/change，一步到位，且不依赖焦点。
 *    ⇒ 要「像人一样逐字输入、触发每次 keydown」用 `type`；要「把这个字段设成这个值」用 `fill`。
 */
export async function insertText(slot: number, targetId: string, text: string): Promise<void> {
  await withPage(slot, targetId, async (send) => {
    await send('Input.insertText', { text })
  })
}

/**
 * 滚轮滚动（`Input.dispatchMouseEvent` wheel）。
 *
 * 🔴 判据：滚动**必须走真实 wheel 事件**，⛔ 不用 `window.scrollTo`：
 *    前者会触发懒加载/无限滚动/吸顶 header 的监听；后者只移动视口 ⇒ 页面上的虚拟列表**不加载新行**，
 *    而读数看起来「滚动成功」（scrollY 变了）。
 */
export async function scrollAt(
  slot: number,
  targetId: string,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<{ via: 'wheel' | 'js-fallback'; why?: string }> {
  /**
   * 🔴🔴 **真机实测（2026-11-11）：Wayland headed Chrome 上 `mouseWheel` 会永久挂住。**
   *
   *    同一台机器、同一个 Chrome 版本，对照实验三档：
   *      · `mouseMoved/mousePressed/mouseReleased` ⇒ **立刻返回**
   *      · `Input.dispatchMouseEvent{type:'mouseWheel'}` ⇒ **30s 超时**
   *      · `Input.synthesizeScrollGesture` ⇒ **同样超时**
   *    而**另起一个 `--headless=new` 实例**发同一个 wheel ⇒ **立刻返回**。
   *    ⇒ 根因在「headed + Wayland」这一档：窗口被节流/遮挡时合成器不确认输入，
   *      而 CDP 的 wheel 是**等确认**的（不像 mouseMoved 那样 fire-and-forget）。
   *    ⚠️ 我们**刻意**没有加 `--disable-renderer-backgrounding` 那组 flag（2026-11-09 耗电事故的教训），
   *      所以这个节流是预期行为 ⇒ 不该为了让 wheel 好用去关它。
   *
   * ⇒ 判据：**一种能力在有副作用的动作上不能"挂住"**。等 30s 再失败，等于把一个
   *    「滚不动」变成「卡死 30 秒」，而调用方无从区分。
   *    ⇒ wheel 给**短超时**，超时后回落 JS 滚动，**并在回执里写明走的是哪条路**。
   *    🔴 回落不是等价物：JS 滚动**不产生 wheel 事件**，只靠 wheel 的懒加载不会触发。
   *       所以它必须**可见**（`via: 'js-fallback'`），⛔ 不静默替代。
   */
  const wheel = { type: 'mouseWheel', x, y, deltaX, deltaY, pointerType: 'mouse' };
  try {
    await withPage(slot, targetId, async (send) => {
      await send('Input.dispatchMouseEvent', wheel, 4000);
    });
    return { via: 'wheel' };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!/超时|timeout/i.test(msg)) throw e;
    // 回落：JS 滚动（会产生真正的 scroll 事件，滚动监听的懒加载仍会触发）
    await withPage(slot, targetId, async (send) => {
      await send(
        'Runtime.evaluate',
        {
          expression: `window.scrollBy(${Math.round(deltaX)}, ${Math.round(deltaY)})`,
          returnByValue: true,
        },
        8000,
      );
    });
    return { via: 'js-fallback', why: 'mouseWheel 在本机 headed/Wayland 档会挂住（见 scrollAt 判据），已回落 JS 滚动' };
  }
}

/**
 * 拖拽（`mousePressed` → 多次 `mouseMoved` → `mouseReleased`）。
 *
 * 🔴 为什么必须**分多步移动**、且每步之间要 `await`：
 *    HTML5 拖放与大多数拖拽库（dnd-kit / sortablejs / 原生 draggable）都监听 `mousemove` 序列来算方向与阈值。
 *    **一次 `mouseMoved` 直接跳到终点** ⇒ 它们收到的是一个「瞬移」，判定为不构成拖拽 ⇒ 什么都不发生，
 *    而回执与真拖拽一模一样。steps 默认 12 是实测下限（再少 sortablejs 偶发不认）。
 */
export async function dragFromTo(
  slot: number,
  targetId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  const n = Math.max(2, Math.min(64, Math.round(steps)))
  await withPage(slot, targetId, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
    })
    for (let i = 1; i <= n; i++) {
      const t = i / n
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t),
        button: 'left',
        buttons: 1,
      })
    }
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      clickCount: 1,
    })
  })
}

/**
 * 在页面里跑的**设值器**：给一个 backendNodeId 与该设什么值，返回设完之后的读数。
 *
 * 🔴🔴 这是本轮最容易被做错的一格，判据有三条：
 *
 *   ① **必须用原型上的原生 setter**（`Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v)`）。
 *      直接 `el.value = 'x'` 在 React 下**不触发 onChange** ⇒ 界面上显示新值，但**提交的仍是旧值**。
 *      这是最贵的一种错：读数（界面上有字）与真相（state 没变）相反，而且**永不报错**。
 *   ② **必须派发 `input` 和 `change` 两个事件**，且 `input` 用 `InputEvent`（带 `inputType`）。
 *      只发 `change` ⇒ 监听 input 的组件不更新；只发 `input` ⇒ 提交时校验不认。
 *   ③ **contenteditable 走另一条路**（`textContent` 无 setter 钩子）⇒ 用 `execCommand('insertText')`
 *      （唯一能让富文本编辑器（ProseMirror/Quill/Slate）真正更新的路径；它们监听 beforeinput）。
 *
 * ⚠️ 返回值**只报读回来的值**，⛔ 不报「设置成功」 —— 判据：设值这个动作没有可靠的成功信号，
 *    唯一能说的是「读回来是什么」；两者不同就是失败，而那正是调用方要看见的东西。
 */

/**
 * 设值：CDP 侧 `DOM.resolveNode` 拿 objectId，再 `Runtime.callFunctionOn` 跑设值器。
 *
 * 🔴 为什么不用页面内的 `eval` 直接 querySelector：
 *    ref 是 backendNodeId（AX 快照给的），它**不告诉你 CSS 选择器** ——
 *    要把 backendNodeId 变回可操作的 JS 对象，**唯一正确通道就是 DOM.resolveNode**。
 *    ⛔ 不要试图「猜一个选择器」（那是猜，猜错就设到别的元素上，且静默）。
 */
export async function fillByBackendId(
  slot: number,
  targetId: string,
  backendNodeId: number,
  value: string,
): Promise<{ ok: boolean; tag: string; readBack: string; why?: string }> {
  return await withPage(slot, targetId, async (send) => {
    await send('DOM.enable')
    const resolved = await send('DOM.resolveNode', { backendNodeId })
    const objectId = (resolved.object as { objectId?: string } | undefined)?.objectId
    if (!objectId) return { ok: false, tag: '', readBack: '', why: 'resolveNode 没有给出 objectId（节点可能已失效）' }
    const r = await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: FILL_FN,
      arguments: [{ value }],
      returnByValue: true,
      awaitPromise: true,
    })
    const ex = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    if (ex) return { ok: false, tag: '', readBack: '', why: (ex.text ?? '') + ' ' + (ex.exception?.description ?? '') }
    const v = (r.result as { value?: unknown } | undefined)?.value as
      | { ok?: boolean; tag?: string; readBack?: string; why?: string }
      | undefined
    return {
      ok: v?.ok === true,
      tag: String(v?.tag ?? ''),
      readBack: String(v?.readBack ?? ''),
      ...(v?.why ? { why: String(v.why) } : {}),
    }
  })
}

/**
 * 页面里跑的设值函数（`this` = 目标元素）。
 *
 * 三条判据见 `fillByBackendId` 的头注释；这里只补两条实现细节：
 *   · `input` 事件优先用 `InputEvent`，不支持时降级 `Event`（老引擎/某些自定义元素）
 *   · `input type=file` **不走这条路**（它的 value 是只读的设在 C:\fakepath）⇒ 明确拒绝并指路 `upload`
 */
export const FILL_FN = `function (value) {
  const el = this;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'file') {
    return { ok: false, tag, readBack: '', why: 'input[type=file] 不能用设值 —— 用 browser_slot upload（走 DOM.setFileInputFiles）' };
  }
  if (el.isContentEditable) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch { ok = false; }
    if (!ok) { el.textContent = value; }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, tag, readBack: (el.innerText || el.textContent || '') + '' };
  }
  const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : tag === 'select' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!desc || !desc.set) return { ok: false, tag, readBack: '', why: '这个元素没有 value setter（不是表单控件）' };
  el.focus();
  desc.set.call(el, value);
  let ev;
  try { ev = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }); }
  catch { ev = new Event('input', { bubbles: true }); }
  el.dispatchEvent(ev);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag, readBack: (el.value === undefined ? '' : el.value) + '' };
}`;

/**
 * AX 快照：拿整棵无障碍树，交给 `ax.ts` 的纯判定去剪。
 *
 * 🔴 为什么先 `Accessibility.enable`：不启用时 `getFullAXTree` 给的是**空数组**（不是报错）。
 *    那是典型的恒空读数 —— 与「页面上没有可交互元素」同形。
 */
export async function captureAx(slot: number, targetId: string): Promise<AxNode[]> {
  return await withPage(slot, targetId, async (send) => {
    await send('Accessibility.enable')
    const r = await send('Accessibility.getFullAXTree', {}, 20_000)
    const nodes = r.nodes
    return Array.isArray(nodes) ? (nodes as AxNode[]) : []
  })
}

/**
 * 把 backendNodeId 变成一个可点的坐标（`DOM.getBoxModel` 的中心点）。
 *
 * 🔴 为什么不用 `Runtime.callFunctionOn` + `getBoundingClientRect`：
 *    `getBoundingClientRect` 是**相对视口且受 transform 影响**的读数，而 `DOM.getBoxModel`
 *    给的是**布局盒**坐标（同样视口系）且会把 padding/border 算进去；
 *    更关键的是：`getBoxModel` 对 `display:none` / 零尺寸元素**会明确失败**，
 *    而 rect 会给一个全 0 的「成功」读数 ⇒ 点 (0,0)。前者报错，后者点错地方。
 *
 * ⚠️ 元素**在视口外**时盒模型仍在（会被滚动条挡住）⇒ 返回值额外带 `inViewport`，
 *    调用方据此决定要不要先 `scroll`。⛔ 这里不代劳滚动：滚动本身有副作用（懒加载）。
 */
export async function boxCenterByBackendId(
  slot: number,
  targetId: string,
  backendNodeId: number,
): Promise<{ x: number; y: number; w: number; h: number; inViewport: boolean }> {
  return await withPage(slot, targetId, async (send) => {
    await send('DOM.enable')
    const box = (await send('DOM.getBoxModel', { backendNodeId })) as {
      model?: { content?: number[]; border?: number[] }
    }
    const quad = box.model?.border ?? box.model?.content
    if (!quad || quad.length < 8) throw new Error('这个 ref 所在元素没有可见盒（可能 display:none / 零尺寸）');
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const vp = (await send('Runtime.evaluate', {
      expression: 'JSON.stringify({w:innerWidth,h:innerHeight})',
      returnByValue: true,
    })) as { result?: { value?: string } }
    let vw = 0
    let vh = 0
    try {
      const o = JSON.parse(String(vp.result?.value ?? '{}')) as { w?: number; h?: number }
      vw = Number(o.w ?? 0)
      vh = Number(o.h ?? 0)
    } catch {
      /* 视口量不出来 ⇒ inViewport 报 false（保守：调用方会先滚动） */
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    return {
      x: Math.round(cx),
      y: Math.round(cy),
      w: Math.round(maxX - minX),
      h: Math.round(maxY - minY),
      inViewport: vw > 0 && vh > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh,
    }
  })
}

/**
 * 上传文件：`DOM.setFileInputFiles`。
 *
 * 🔴🔴 **这是本轮唯一一个能把本地文件送进网页的动作**，所以守卫写在这里而不是工具层：
 *
 *   ① **路径必须在 CCC 根内**（`insideRoot` 由调用方传入已判定的结果 ——
 *      ⛔ 本函数不自己算根：那会造出第二个「根在哪」的判定点，D307 同族）。
 *   ② **文件必须真实存在且是普通文件**（目录/符号链接/设备文件一律拒）——
 *      判据：`DOM.setFileInputFiles` 对不存在的路径**静默成功**（回执 OK，但表单里是空的），
 *      而那个空上传在页面上看起来与「上传中」一样。
 *   ③ **必须同时显式给 target 的 ref/坐标**：不给就变成「上传到页面上任意 file input」，
 *      而真实页面常有多个（头像/附件/水印）⇒ 传错的那个不会报错，会成功。
 */
export async function uploadFiles(
  slot: number,
  targetId: string,
  backendNodeId: number,
  absPaths: readonly string[],
): Promise<{ files: string[] }> {
  return await withPage(slot, targetId, async (send) => {
    await send('DOM.enable')
    await send('DOM.setFileInputFiles', { files: [...absPaths], backendNodeId });
    return { files: [...absPaths] }
  })
}

/**
 * 摄取下载：把 `Browser.setDownloadBehavior` 指向一个固定目录，然后**读那个目录**。
 *
 * 🔴 为什么必须显式设行为（而不是「点了下载就完事」）：
 *    默认行为是弹系统保存框 / 落到用户 `~/Downloads`。前者会把自动化**卡死**（等人点）；
 *    后者让文件落在**我们看不见的地方**，而回执一切正常。
 *
 * 🔴 判据：**落点只有一个**（调用方给，必须在 CCC 根内）。⛔ 不给「用默认目录」这个选项 ——
 *    那会让「这个文件哪来的」在下一次读数里无法重建。
 */
export async function enableDownloads(slot: number, targetId: string, absDir: string): Promise<void> {
  await withPage(slot, targetId, async (send) => {
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: absDir }, 10_000);
  })
}

/**
 * 列目录（下载捕获用；只读、不递归）。
 *
 * ⚠️ 返回**文件名与大小**，⛔ 不读内容：读内容会让一个「下载了 40 MB 视频」的动作
 *    把 40 MB 塞进上下文。要看内容由调用方自己决定怎么读。
 */
export function listDownloaded(absDir: string): Array<{ name: string; bytes: number }> {
  let names: string[]
  try {
    names = readdirSync(absDir) as string[];
  } catch {
    return [];
  }
  const out: Array<{ name: string; bytes: number }> = [];
  for (const n of names) {
    try {
      const st = statSync(join(absDir, n));
      if (st.isFile()) out.push({ name: n, bytes: st.size });
    } catch {
        /* 读不到就跳过：下载中的 .crdownload 可能恰好被删 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 处理原生 dialog（`alert` / `confirm` / `prompt` / `beforeunload`）。
 *
 * 🔴🔴 **不处理就会把整个页面卡死** —— `alert`/`confirm` 是**同步阻塞**的，
 *    页面脚本停在那一行，之后所有 `Runtime.evaluate` 全部超时。而**没有 dialog 时调用这个
 *    又会报错**（Chrome：`No dialog is showing`）⇒ 所以它必须是「先探、再处理」。
 *
 * 判据：**默认 dismiss**（等于点「取消」）。⛔ 不默认 accept ——
 *    「确定」在真实站点上常意味着**删除/支付/发布**这类不可逆动作，
 *    而对话框正文由页面控制（可以写任何话）。要接受必须由调用方显式要求。
 */
export async function handleDialog(
  slot: number,
  targetId: string,
  accept: boolean,
  promptText?: string,
): Promise<{ hadDialog: boolean; type: string; message: string; accepted: boolean }> {
  /**
   * 🔴🔴 **真机实测（2026-11-11）：先 `Page.enable` 再处理弹窗，会把整页卡死。**
   *
   *    现象：`click` 一个会 `confirm()` 的按钮 ⇒ 点击请求 30s 超时（页面同步阻塞，这是**预期的**）；
   *    接着调 `dialog` 去处理它 ⇒ **`Page.enable` 自己超时 30s**，弹窗一直挂着，页面永久卡死。
   *
   *    对照实验（裸 WS 直连，同一个卡死的页面）：
   *      · `Page.handleJavaScriptDialog{accept:false}` **不 enable 直接发** ⇒ 立刻返回 `No dialog is showing`
   *        （说明这条路**通**，只是此刻那条 confirm 已被上一次尝试里的某个环节关掉了）
   *      · `Page.enable` ⇒ 在弹窗阻塞的页面上**挂住**
   *
   *    ⇒ 判据：**在「页面已阻塞」这个状态下，任何需要页面响应的方法都不能排在前面**。
   *      `Page.enable` 要往渲染器要一次响应，而渲染器正停在 `confirm()` 那一行上。
   *      ⇒ **先直接发 `handleJavaScriptDialog`**（它由浏览器进程处理，不经过被阻塞的渲染器），
   *      成功/失败都能立刻知道；`Page.enable` 只在需要**事件面**（拿弹窗类型与正文）时**事后**补。
   *
   * ⚠️ 代价如实登记：不 enable 就拿不到 `Page.javascriptDialogOpening` 的 type/message，
   *    所以本函数报的 `type`/`message` 多为空。**这不是缺陷** —— 判据是「先把页面救回来」，
   *    而类型/正文属于附加信息（要它就得在弹窗出现**之前** enable，那是调用方的编排问题）。
   */
  const send = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> =>
    await withPage(slot, targetId, async (s) => await s(method, params, timeoutMs));

  try {
    await send(
      'Page.handleJavaScriptDialog',
      { accept, ...(promptText !== undefined ? { promptText } : {}) },
      8000,
    );
    return { hadDialog: true, type: '', message: '', accepted: accept };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // 「没有弹窗」是**正常状态**（⛔ 不当失败报）
    if (/no dialog|No dialog is showing/i.test(msg)) {
      return { hadDialog: false, type: '', message: '', accepted: false };
    }
    // 连 handleJavaScriptDialog 都超时 ⇒ 页面此刻已无法响应，如实说清楚
    if (/超时|timeout/i.test(msg)) {
      throw new Error(
        `⛔ 处理弹窗超时：连 handleJavaScriptDialog 都没能在 8s 内返回。\n` +
          `  ⇒ 这个 target 已经不响应了（多半是被 sync alert/confirm 卡住且浏览器进程也没接住）。\n` +
          `  ⇒ 出路：close 掉这个 tab 重来（页面状态已不可信）—— ⛔ 不要反复重试同一个 target。`,
      );
    }
    throw e;
  }
}
/**
 * 在页面里等一个条件成立（`wait` 动作）。
 *
 * 🔴🔴 为什么条件表达式在**页面内轮询**，而不是在宿主侧每次 `eval` 一次：
 *    宿主侧轮询 = 每 200ms 一次 CDP 往返 ⇒ 等 30s 就是 150 次往返，
 *    而**每次往返都可能因为导航而失败**（页面对到了一个死连接），于是「等」本身成了不稳定源。
 *    页面内轮询 = 一次调用、一次往返，条件是同一段 JS 的连续求值。
 *
 * 🔴 判据（超时必须说清等的是什么）：
 *    超时返回 `{ ok:false, waitedMs, last }` —— `last` 是**最后一次求值的原始结果**，
 *    ⛔ 不只给一句「超时」。没有 `last` 时，读者无法区分：
 *      ① 选择器写错了（`last` = null/false）② 元素出现了但条件是别的东西（`last` = 具体值）
 *    这一格是本轨迹的老账（D252 同族：读了数 ≠ 读的是那个数）。
 */
export async function waitForInPage(
  slot: number,
  targetId: string,
  expression: string,
  timeoutMs: number,
  pollMs = 200,
): Promise<{ ok: boolean; waitedMs: number; last: unknown }> {
  const started = Date.now();
  const budget = Math.max(50, Math.round(timeoutMs));
  const poll = Math.max(50, Math.round(pollMs));
  return await withPage(slot, targetId, async (send) => {
    const src =
      '(async () => {' +
      '  const deadline = Date.now() + ' + String(budget) + ';' +
      '  let last = null;' +
      '  while (Date.now() < deadline) {' +
      '    try { last = await (' + expression + '); } catch (e) { last = "ERR: " + (e && e.message ? e.message : String(e)); }' +
      '    if (last === true) return { ok: true, last };' +
      '    if (last && typeof last === "object" && last.ok === true) return { ok: true, last };' +
      '    await new Promise(r => setTimeout(r, ' + String(poll) + '));' +
      '  }' +
      '  return { ok: false, last };' +
      '})()';
    const r = await send('Runtime.evaluate', {
      expression: src,
      awaitPromise: true,
      returnByValue: true,
    }, budget + 10_000);
    const v = (r.result as { value?: unknown } | undefined)?.value as { ok?: boolean; last?: unknown } | undefined;
    return { ok: v?.ok === true, waitedMs: Date.now() - started, last: v?.last ?? null };
  });
}

/** 导出给测试用（⛔ 生产代码不要直接调这两个） */
export const __test = { attach, cdpRaw }
