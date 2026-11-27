/**
 * browser/headless-shot.ts —— 锁屏取不到帧时的**补拍通道**（2026-11-28）
 *
 * ## 为什么需要它（真机取证，⛔ 非推断）
 *
 * 2026-11-28 凌晨真机对照，同一槽位同一页：
 *   · `text` / `eval` ⇒ **正常返回**（CDP 通道活着，页面 `visibilityState=visible`、`hasFocus=true`）
 *   · `Page.captureScreenshot` 默认 ⇒ 4s 超时
 *   · 同一方法 `fromSurface:false` ⇒ 4s 超时
 *   · 同一方法 `+captureBeyondViewport` ⇒ 4s 超时
 *   · `Page.startScreencast`（走事件流，另一条通路）⇒ **5s 内一帧都没有**
 *   ⇒ **锁屏时整个 headed/Wayland 档根本不提交帧**。换参数、换通路都无解。
 *   ⚠️ 这是 v1.139.6 的教训：那一版加了三条回退，真机上**一条都没用**，
 *      只把「挂 20 秒」变成「12 秒内明确失败」。
 *
 * 同一时刻另起一个 `--headless=new` 实例打开同一 URL ⇒ **立刻截到正确的图**
 * （1600×913、21KB、内容经肉眼核对无误）。
 *
 * ## 因此本文件做什么
 *
 * **不试图让 headed 实例出帧**（它出不了），而是：headed 取不到帧时，
 * 用无头实例打开**同一个 URL** 补拍一张，并在回执里**写明这是补拍**。
 *
 * ## 🔴 三条必须写死的边界（否则这个功能会骗人）
 *
 * ① **补拍 ≠ 原页取证**。无头实例是**另一个浏览器**、全新 profile ⇒
 *    没有登录态、没有滚动位置、没有表单填写、没有单页应用的内存状态。
 *    ⇒ 回执必须显式说「这不是原页面的状态」，⛔ 不许静默替代。
 * ② **只在 headed 明确取不到帧时才用**。能原页拍就绝不补拍。
 * ③ **补拍也失败 ⇒ 明确报错**，⛔ 不许返回一张空白图冒充成功。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { findChrome } from './process.js'

/** 补拍实例的端口：刻意避开槽位端口区间（9301+），避免撞上一个真槽位。
 *  🔵 导出是为了让"它不在槽位区间内"成为**可判的机械断言**，⛔ 不是给生产代码用的 API。 */
export const HEADLESS_PORT = 9399

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function connect(url: string, timeoutMs = 8000): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const t = setTimeout(() => rej(new Error(`ws 连接超时 ${timeoutMs}ms`)), timeoutMs)
    ws.on('open', () => { clearTimeout(t); res(ws) })
    ws.on('error', (e: Error) => { clearTimeout(t); rej(e) })
  })
}

/** 极简 CDP 调用（本通道只发三条命令，不引入既有 cdp 层的连接池语义） */
function call(
  ws: WebSocket,
  nextId: { v: number },
  method: string,
  params: Record<string, unknown> = {},
  ms = 15000,
): Promise<Record<string, unknown>> {
  const id = nextId.v++
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error(`CDP ${method} 超时 ${ms}ms`)) }, ms)
    const onMsg = (raw: Buffer | string): void => {
      let m: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
      try { m = JSON.parse(String(raw)) } catch { return }
      if (m.id !== id) return
      cleanup()
      if (m.error) rej(new Error(`CDP ${method}: ${m.error.message ?? ''}`))
      else res(m.result ?? {})
    }
    const cleanup = (): void => { clearTimeout(t); ws.off('message', onMsg) }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 补拍结果 */
export interface HeadlessShotResult {
  /** base64 PNG；空串表示失败（调用方不得写盘） */
  data: string
  /** 失败原因（成功时为空） */
  error?: string
}

/** 前置判定的结果：要么放行并交出 Chrome 路径，要么**拒绝**并交出原因 */
export type ShotPreflight =
  | { ok: true; chrome: string }
  | { ok: false; data: ''; error: string }

/**
 * 补拍前的两道拒绝（**纯函数，chrome 路径可注入**）。
 *
 * 🔴 **为什么抽出来**（承本仓 `tryShotChain()` 的先例）：这两道拒绝是"我们会拒绝"的那一侧，
 *    而它原先埋在 `headlessShot()` 里 ⇒ 判它需要真 Chrome ＋ 真起进程。
 *    抽成纯函数后：无浏览器也能判、也能**变异**（把分支弄没必须变红）。
 *
 * 🔴 **两道判据的次序是承重的**，⛔ 不要调换：
 *    Chrome 缺失时先报"找不到 Chrome" —— 否则在没装浏览器的机器上，
 *    `headlessShot('')` 会报"地址是空"，而**真因是没有浏览器**（读数器与被测对象混为一谈）。
 */
export function shotPreflight(chrome: string | null, url: string): ShotPreflight {
  if (chrome === null) return { ok: false, data: '', error: '找不到 Chrome，无法补拍' }
  if (url === '' || url === 'about:blank') {
    return { ok: false, data: '', error: `原页面地址是「${url || '空'}」，补拍没有意义` }
  }
  return { ok: true, chrome }
}

/**
 * 用无头实例打开 `url` 拍一张。
 *
 * ⚠️ **它不保证与原页面状态一致** —— 见文件头注 ①。调用方必须把这一点告诉使用者。
 *
 * @param url            要补拍的地址（取自原 target 的当前 URL）
 * @param timeoutMs      整条通道的上限（起进程 + 加载 + 拍）
 */
export async function headlessShot(url: string, timeoutMs = 30_000): Promise<HeadlessShotResult> {
  const pre = shotPreflight(findChrome(), url)
  if (!pre.ok) return { data: pre.data, error: pre.error }
  const chrome = pre.chrome

  const deadline = Date.now() + timeoutMs
  const profile = mkdtempSync(join(tmpdir(), 'acc-headless-shot-'))
  let child: ChildProcess | null = null
  let ws: WebSocket | null = null
  try {
    child = spawn(chrome, [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${HEADLESS_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      'about:blank',
    ], { stdio: 'ignore' })

    // ① 等 CDP 就绪（有界轮询，⛔ 不固定 sleep）
    let endpoint = ''
    while (Date.now() < deadline) {
      await sleep(200)
      try {
        const r = await fetch(`http://127.0.0.1:${HEADLESS_PORT}/json/version`, {
          signal: AbortSignal.timeout(1500),
        })
        if (r.ok) { endpoint = 'ready'; break }
      } catch { /* 还没起来 */ }
    }
    if (endpoint === '') return { data: '', error: '补拍实例的 CDP 端点未就绪（超时）' }

    // ② 开页面
    const tRes = await fetch(
      `http://127.0.0.1:${HEADLESS_PORT}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' },
    )
    const target = (await tRes.json()) as { id: string; webSocketDebuggerUrl?: string }
    if (!target.webSocketDebuggerUrl) return { data: '', error: '补拍实例没有可用的 target 端点' }

    ws = await connect(target.webSocketDebuggerUrl)
    const nextId = { v: 1 }

    // ③ 等页面加载完（有界轮询 readyState）
    let state = ''
    while (Date.now() < deadline) {
      const v = await call(ws, nextId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 5000)
      state = String((v.result as { value?: unknown })?.value ?? '')
      if (state === 'complete') break
      await sleep(200)
    }
    if (state !== 'complete') return { data: '', error: `补拍页面未加载完（readyState=${state || '空'}）` }

    // ④ 拍
    const r = await call(ws, nextId, 'Page.captureScreenshot', { format: 'png' }, Math.max(5000, deadline - Date.now()))
    const data = String(r.data ?? '')
    if (data === '') return { data: '', error: '补拍返回空帧（无头实例也没拿到图）' }
    return { data }
  } catch (e) {
    return { data: '', error: String((e as Error)?.message ?? e) }
  } finally {
    try { ws?.close() } catch { /* 忽略 */ }
    try { child?.kill('SIGKILL') } catch { /* 忽略 */ }
    // ⚠️ 等进程真退出再删 profile，否则可能删不干净
    await sleep(200)
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}
