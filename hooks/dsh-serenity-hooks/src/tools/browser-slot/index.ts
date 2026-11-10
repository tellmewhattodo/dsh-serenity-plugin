/**
 * tools/browser-slot/index.ts — browser_slot 工具（ACC 级浏览器槽位管理器）
 *
 * owner 2026-11-09 令（原话）：
 *   「通过 msm 通道获得另外两个宁静号的浏览器操作完整实现，然后各取所长，开始实现 ACC 级的
 *     浏览器操作，务必给我实现槽位管理，最多 20 个 chrome 槽位，每个独立 profile，固定分辨率，
 *     每个槽位有状态，状态异常例如长时间不动作、cpu 占用过高，直接可以反过来向唤醒这个浏览器的
 *     会话注入消息提醒它管好自己的浏览器，槽位是否已经被会话正在使用要有状态，每个会话用完要
 *     自觉退出占用」
 *
 * 本工具接的就是这条令。它是 **ACC 级**（进插件本体、随 npm 发布），
 * ⛔ 不是 CCC 的某个 skill —— 因为"浏览器进程属于谁"和"哪个会话忘了关"是**跨 CCC 的**问题。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import { cccRootForExec, listCccs, NO_CCC_FROM_AGENT_CWD } from '../../kernel/ccc-roots.js'
import { sendToCognitiveTrajectory } from '../../wake/scheduler.js'
import {
  SLOT_ACTIONS,
  acquireSlot,
  doctorSlots,
  listSlots,
  nudgeStaleSlots,
  reapSlot,
  releaseSlot,
  slotClose,
  slotEval,
  slotExt,
  slotExtList,
  slotGoto,
  slotHtml,
  slotOpen,
  slotReload,
  slotShot,
  slotStatus,
  slotTargets,
  slotText,
  waitSlotReady,
  type SlotAction,
  type SlotView,
} from '../../browser/service.js'
import { MAX_SLOTS, slotLabel, slotPort } from '../../browser/state.js'
import { EXT_DIR_REL } from '../../browser/extend.js'
import { normalizeSlotId } from '../../browser/process.js'

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

const STATE_GLYPH: Record<string, string> = {  free: '·',
  leased: '✓',
  stale: '!',
  orphaned: '✗',
}

/**
 * 从会话 cwd 反查轨迹目录名。
 *
 * 判据：**只在 cwd 落在 `<root>/AGENT_SESSIONS/<dir>` 内时才认**，否则返回空串。
 * ⛔ 不做模糊匹配、⛔ 不回落到"最后修改的那个目录" —— 归属猜错会让**看守把提醒发给别人**，
 * 那比不提醒更坏（收到的人无从判断自己是否真的占着槽位）。
 */
function trajectoryNameFromCwd(root: string, cwd: string): string {
  if (!cwd) return ''
  const marker = `${root.replace(/\/+$/, '')}/AGENT_SESSIONS/`
  if (!cwd.startsWith(marker)) return ''
  const rest = cwd.slice(marker.length)
  const seg = rest.split('/')[0] ?? ''
  return seg.startsWith('_') ? '' : seg
}

/** 一行渲染一个槽位（宽度克制：20 行要塞得进一屏） */
function row(v: SlotView): string {
  const g = STATE_GLYPH[v.state] ?? '?'
  const who = v.state === 'free' ? '' : ` ${v.trajectory || v.sessionId || '(无归属)'}`
  const extra = v.state === 'free' ? '' : ` 持${v.heldMin}m 闲${v.idleMin}m cpu${v.cpuPct}% 内存${v.rssMb}M`
  const why = v.reasons.length > 0 ? `\n      ↳ ${v.reasons.join('；')}` : ''
  return `  ${g} ${v.label.padEnd(3)} :${v.port} ${v.resolution.padEnd(9)} ${v.state.padEnd(8)}${who}${extra}${why}`
}

/**
 * 取 `--slot` 并校验（页面层与扩展层的统一入口）。
 *
 * 🔴 页面动作**必须亮明槽位**，⛔ 不接受裸端口：
 *    槽位号是循环复用的（b1 今天给 A、明天给 B），裸端口会让「这是谁的浏览器」
 *    变成隐含状态 —— 而那正是 `browser` MSM 与槽位体系断开的那个口子。
 */
function needSlot(args: Record<string, unknown>): number {
  const n = normalizeSlotId(String(args.slot ?? ''))
  if (n === 0) {
    throw new Error(
      `⛔ 需要 --slot <b1..b20>（当前收到 ${JSON.stringify(args.slot)}）。\n` +
        `  ⇒ 页面操作必须指明槽位：先 \`browser_slot list\` 看你租的是哪个。`,
    )
  }
  return n
}

/** 取字符串参数（空串当没给） */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 取数字参数（非有限数当没给） */
function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 组装扩展的 `args`。
 *
 * 契约：`--earg key=value` 可重复；`--earg` 之后的值一律当字符串
 * （⛔ 不做类型猜测 —— 猜错会让扩展收到 `"true"` 而不是 `true`，而那种错在扩展里静默）。
 */
function extArgs(args: Record<string, unknown>): Record<string, unknown> {
  const raw = args.earg
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const out: Record<string, unknown> = {}
  for (const item of list) {
    if (typeof item !== 'string') continue
    const i = item.indexOf('=')
    if (i <= 0) continue
    out[item.slice(0, i)] = item.slice(i + 1)
  }
  return out
}

/** 动作实现 */
async function run(
  ctx: Context,
  root: string,
  sessionId: string,
  trajectory: string,
  action: SlotAction,
  args: Record<string, unknown>,
): Promise<string> {
  switch (action) {
    case 'acquire': {
      const want = typeof args.slot === 'string' ? normalizeSlotId(args.slot) : 0
      const res = await acquireSlot({ root, sessionId, trajectory, want })
      if (!res.ok) return `⛔ 未租到槽位。\n${res.detail}`
      // 要求同步等到可用（opt-in）：CDP 就绪才算真的能用
      if (args.wait === true) {
        const ready = await waitSlotReady(root, res.slot)
        return `${res.detail}\n${ready.ok ? '✓ ' + ready.detail : '⚠️ ' + ready.detail}`
      }
      return res.detail
    }
    case 'release': {
      const n = normalizeSlotId(String(args.slot ?? ''))
      if (n === 0) return '⛔ 需要槽位号：release 需要 --slot <b1..b20>'
      return releaseSlot(root, sessionId, n).detail
    }
    case 'reap': {
      const n = normalizeSlotId(String(args.slot ?? ''))
      if (n === 0) return '⛔ 需要槽位号：reap 需要 --slot <b1..b20>'
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'manual reaping'
      return reapSlot(root, n, reason).detail
    }
    case 'status': {
      const n = normalizeSlotId(String(args.slot ?? ''))
      const v = n > 0 ? slotStatus(root, n) : null
      if (!v) return `⛔ 槽位号非法（1..${MAX_SLOTS}）。`
      return row(v).trimStart()
    }
    case 'list':
    default: {
      const { views, ledgerAgeMin } = listSlots(root)
      const occupied = views.filter((v) => v.state !== 'free')
      const bad = views.filter((v) => v.state === 'stale' || v.state === 'orphaned')
      const lines: string[] = []
      lines.push(
        `浏览器槽位 ${views.length} 个（占用 ${occupied.length}，空闲 ${views.length - occupied.length}，异常 ${bad.length}）` +
          (ledgerAgeMin > 0 ? `  台账 ${ledgerAgeMin} 分钟前更新` : ''),
      )
      lines.push('  · 空闲   ✓ 占用   ! 异常(需处理)   ✗ 进程已死')
      if (occupied.length === 0) {
        lines.push('  （全部空闲）')
      } else {
        for (const v of occupied) lines.push(row(v))
      }
      if (bad.length > 0) {
        lines.push('')
        lines.push('🔴 异常槽位会由看守向**占用它的会话**注入提醒；若占用者已经不在，用 reap 回收：')
        for (const v of bad) lines.push(`  browser_slot reap --slot ${v.label}`)
      }
      lines.push('')
      lines.push('用法：acquire（自动挑空槽，可 --slot 指定）· release（用完必须交还）· status --slot b1')
      return lines.join('\n')
    }
    case 'doctor': {
      return JSON.stringify(doctorSlots(root), null, 2)
    }
    // ── ② 页面层（v1.129.0 从 browser MSM 搬入）──────────────────
    case 'targets': {
      const n = needSlot(args)
      const list = await slotTargets(root, n, sessionId)
      if (list.length === 0) return `槽位 ${slotLabel(n)}（端口 ${slotPort(n)}）上没有 target。`
      return (
        `[browser_slot] ${list.length} 个 target（槽位 ${slotLabel(n)}，端口 ${slotPort(n)}）\n` +
        list
          .map(
            (t: { type: string; id: string; title: string; url: string }) =>
              `  ${t.type.padEnd(10)} ${t.id}  ${t.title.slice(0, 40)}  ${t.url.slice(0, 90)}`,
          )
          .join('\n')
      )
    }
    case 'open': {
      const n = needSlot(args)
      const url = str(args.url)
      if (!url) return '⛔ 需要 --url=<地址>'
      const id = await slotOpen(root, n, sessionId, url)
      return `[browser_slot] targetId=${id}`
    }
    case 'goto': {
      const n = needSlot(args)
      const target = str(args.target)
      const url = str(args.url)
      if (!target) return '⛔ 需要 --target=<targetId>（先跑 targets）'
      if (!url) return '⛔ 需要 --url=<地址>'
      await slotGoto(root, n, sessionId, target, url)
      return `[browser_slot] navigate ${target} → ${url}`
    }
    case 'eval': {
      const n = needSlot(args)
      const target = str(args.target)
      const js = str(args.js)
      if (!target) return '⛔ 需要 --target=<targetId>（先跑 targets）'
      if (!js) return '⛔ 需要 --js=<表达式>（例如 document.title）'
      const v = await slotEval(root, n, sessionId, target, js, num(args.timeout))
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    }
    case 'text': {
      const n = needSlot(args)
      const target = str(args.target)
      if (!target) return '⛔ 需要 --target=<targetId>（先跑 targets）'
      return await slotText(root, n, sessionId, target)
    }
    case 'html': {
      const n = needSlot(args)
      const target = str(args.target)
      if (!target) return '⛔ 需要 --target=<targetId>（先跑 targets）'
      return await slotHtml(root, n, sessionId, target, num(args.max))
    }
    case 'shot': {
      const n = needSlot(args)
      const target = str(args.target)
      if (!target) return '⛔ 需要 --target=<targetId>（先跑 targets）'
      const out = str(args.out) ?? `_tmp/browser-shots/shot-${target.slice(0, 8)}-${Date.now()}.png`
      const rel = await slotShot(root, n, sessionId, target, out)
      return `[browser_slot] shot → ${rel}`
    }
    case 'reload': {
      const n = needSlot(args)
      const target = str(args.target)
      if (!target) return '⛔ 需要 --target=<targetId>（先跑 targets）'
      const state = await slotReload(root, n, sessionId, target, str(args.script))
      return `[browser_slot] reload 完成（readyState=${state || '?'}）`
    }
    case 'close': {
      const n = needSlot(args)
      const all = args.all === true
      const closed = await slotClose(root, n, sessionId, str(args.target) ?? '', all)
      return `[browser_slot] closed ${closed.join(', ')}`
    }
    // ── ③ 扩展层 ─────────────────────────────────────────────────
    case 'ext-list': {
      const exts = slotExtList(root)
      if (exts.length === 0) {
        return (
          `本 CCC 还没有任何扩展。\n` +
          `  写一个：在 <CCC 根>/${EXT_DIR_REL}/ 下放一个 .ts 文件，文件名即扩展名。\n` +
          `  契约：stdin 收 {slot,port,cccRoot,args}；stdout **最后一个非空行**给 {"ok":true,"result":…}。\n` +
          `  ⚠️ ACC 只 spawn、⛔ 从不 import —— 你的语法错不会放倒宿主。`
        )
      }
      return (
        `本 CCC 的浏览器扩展 ${exts.length} 个（<CCC 根>/${EXT_DIR_REL}/）：\n` +
        exts.map((e: { name: string }) => `  · ${e.name}`).join('\n') +
        `\n\n调用：browser_slot ext --slot b1 --name <名> [--eslot …/--earg key=value]`
      )
    }
    case 'ext': {
      const n = needSlot(args)
      const name = str(args.name)
      if (!name) return '⛔ 需要 --name=<扩展名>（先跑 ext-list）'
      const res = await slotExt(root, n, sessionId, name, extArgs(args))
      if (!res.ok) return `⛔ 扩展「${name}」失败（${res.code ?? 'unknown'}）：\n${res.error ?? ''}`
      return typeof res.result === 'string' ? res.result : JSON.stringify(res.result ?? null, null, 2)
    }
  }
}

export function createBrowserSlotTool(ctx: Context) {
  return defineTool({
    name: 'browser_slot',
    description:
      'Browser slot manager (ACC-level, max 20 Chrome slots). Each slot = one isolated Chrome process with its own profile dir, fixed resolution, and a CDP port (9301+). ' +
      'Slots carry state: free / leased / stale (idle too long, CPU or memory over threshold, lease expired) / orphaned (process died). ' +
      'Actions: acquire (lease a slot; reuses your existing lease instead of leasing a second one) / release (REQUIRED when done — a background watchman nudges you if you forget) / list (all slots + occupancy) / status --slot <bN> / reap --slot <bN> (force-reclaim an abandoned slot, records a reason) / doctor (self-check, read-only). ' +
      '🔴 Lease before you drive a browser for evidence, and ALWAYS release when finished — an unreleased slot keeps a Chrome process alive and burns power.',
    parameters: {
      action: { type: 'string', enum: [...SLOT_ACTIONS], required: true, description: 'Subcommand' },
      slot: { type: 'string', description: 'Slot label for status/release/reap (b1..b20, or 1..20); for acquire = request a specific slot (omit = auto-pick a free one)' },
      wait: { type: 'boolean', description: 'acquire: wait until the CDP endpoint actually answers (2 consecutive probes) before returning. Default false (returns once the process is spawned).' },
      reason: { type: 'string', description: 'reap: why this slot is being force-reclaimed (recorded).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
      const sessionId = (exec.agent?.session?.id ?? '') as string
      // 🔴 归属用 `header.cwd` 反查 CCC 内的轨迹目录名。
      //    ⛔ 不用 `session.title`（宿主 Session 类型上没有这个字段，typecheck 会红）；
      //    ⛔ 也不新造"当前轨迹"环境变量（本仓已有判据：AGENT_SESSIONS/.current 是全局的、不可靠）。
      const trajectory = trajectoryNameFromCwd(root, (exec.agent?.session?.header?.cwd ?? '') as string)
      const action = args.action as SlotAction
      return await run(ctx, root, sessionId, trajectory, action, args as Record<string, unknown>)
    },
  })
}

/**
 * 找出**所有**该被看守盯的 CCC 根。
 *
 * 🔴🔴 **为什么不能再用 `cccRootForCwd(process.cwd())`**（2026-11-09 真机实测，一个静默失效）：
 *    宿主进程的 cwd 是**用户家目录**（`dashboard diag` 明写「进程 CCC:（无）」）
 *    ⇒ `cccRootForCwd(process.cwd())` **恒返回 `null`** ⇒ `tick()` 第一行 `if (!root) return`
 *    ⇒ **看守每一拍都直接返回，一次都没工作过**，而它没有任何报错、没有任何日志、台账上
 *    也看不出异常（`nudges` 一直是 0，与"没人在用槽位"读数相同）。
 *
 *    实测取证：把 b1 造成 `stale`（闲 55 分钟）、归属指向本轨迹、进程活着、
 *    连等两拍（23:11:21 过了）⇒ 台账 `nudges` 仍为 **0**。
 *
 *    判据（这条比修法值钱）：**"装配了" ≠ "在工作"**。`registerSlotWatchman` 确实被调用、
 *    `setInterval` 确实在跑、`tick` 确实被触发 —— 而它每次都在第一行静默返回。
 *    一个**永远走不到第二行**的定时器，在"有没有装配"这个读数上与健康的一模一样。
 *
 *    修法：用 `listCccs(ctx)` —— 它是「本机有哪些 CCC 根」**唯一的权威枚举**
 *    （并集语义；`dashboard diag` 也是走它那一族）。⛔ 不用进程 cwd（那是服务启动目录，
 *    与会话无关）；⛔ 不猜目录（猜出来的根会去读别人的台账）。
 *
 *    ⚠️ 一个宿主进程服务多个 CCC（实测 3 个）⇒ 必须**逐个**看守，⛔ 不能只挑一个。
 */
export async function findWatchRoots(ctx: unknown): Promise<string[]> {
  try {
    const all = await listCccs(ctx)
    return all.map((c) => c.root).filter((r): r is string => typeof r === 'string' && r.length > 0)
  } catch {
    return []
  }
}

/**
 * 槽位看守（后台）—— owner 要的「反过来向唤醒这个浏览器的会话注入消息」就是这里。
 *
 * 🔴 为什么放在 ACC 而不是某个轨迹：**忘了关浏览器的不止一条轨迹**，而看守必须比任何
 *    单条轨迹活得久。它挂在宿主进程上，任何轨迹租的槽位都由它盯。
 *
 * ⚠️ 它**只提醒、不代为释放** —— 见 nudgeText 的判据：只有占用者知道那个浏览器还有没有用。
 */
export function registerSlotWatchman(ctx: Context): { dispose: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async (): Promise<void> => {
    // 🔴 多根：一个宿主服务多个 CCC。旧实现的 `rootProvider()` 返回 null 时**直接 return**，
    //    而那正是它在真机上的常态（进程 cwd 不在任何 CCC 内）⇒ 整个看守从未工作。
    const roots = await findWatchRoots(ctx)
    if (roots.length === 0) {
      // ⚠️ 这一行是**必要的**：让"一次都没扫描"在日志里可见。
      //    旧实现没有它 ⇒ "没有槽位要处理"与"根本没在扫"在读数上完全一样。
      console.warn('[serenity-hooks] ⚠️ 槽位看守：未枚举到任何 CCC 根 ⇒ 本拍未扫描（不是"无异常"）')
      return
    }
    for (const root of roots) {
      try {
        const res = await nudgeStaleSlots(root, async (r, target, message) => {
          const out = await sendToCognitiveTrajectory(ctx, r, target, message, '浏览器槽位看守')
          return { ok: out.ok, detail: out.detail }
        })
        for (const n of res.nudged) {
          console.log(
            `[serenity-hooks] 槽位看守：${slotLabel(n.slot)} (${n.state}) → ${n.trajectory || '(无归属)'} ` +
              `${n.delivered ? '已注入' : '注入失败'}：${n.detail}`,
          )
        }
      } catch (err) {
        console.warn(`[serenity-hooks] ✗ 槽位看守异常（${root}）: ${String((err as Error)?.message ?? err)}`)
      }
    }
  }

  // 5 分钟一拍：与 CRO 同节拍。⛔ 不必更快 —— 判定阈值本身是 15 分钟量级。
  timer = setInterval(tick, 5 * 60_000)
  timer.unref()

  return {
    dispose: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
