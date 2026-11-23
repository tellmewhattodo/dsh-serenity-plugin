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
  forceReapIdleSlots,
  holdSlot,
  reapSlot,
  releaseSlot,
  slotAx,
  slotClose,
  slotDialog,
  slotDownloads,
  slotDrag,
  slotEval,
  slotFill,
  slotPress,
  slotScroll,
  slotType,
  slotUpload,
  slotWait,
  slotExt,
  slotExtList,
  slotGoto,
  slotHtml,
  slotOpen,
  slotReload,
  slotShot,
  slotStatus,
  slotTargets,
  resolveTarget,
  slotClick,
  slotText,
  waitSlotReady,
  needBackendId,
  resolveUploadPath,
  downloadDirFor,
  type SlotAction,
  type SlotView,
} from '../../browser/service.js'
import { MAX_SLOTS, slotLabel, slotPort } from '../../browser/state.js'
import { EXT_DIR_REL } from '../../browser/extend.js'
import { normalizeSlotId } from '../../browser/process.js'
import { refToBackendId, renderAx } from '../../browser/ax.js'
import { parseXY, xyFormHint } from '../../browser/coords.js'
import { renderHit } from '../../browser/hit-test.js'
import { loadDomainSkill, recordVisit, domainSkillPrompt, readVisits, hasDomainSkill, snippetTail } from '../../browser/domain-skill.js'

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

/**
 * 一行渲染一个槽位（宽度克制：20 行要塞得进一屏）。
 *
 * 🔴 **`sampled === false` 时印 `—`，⛔ 不印 `0`**（2026-11-19，v1.137.10）：
 *   Windows 上刻意不采样（成本见 `process.ts` 的 win32 分支）⇒ 若照旧渲染 `cpu0% 内存0M`，
 *   那与「测了，确实很低」**完全同形**，而后者正是 2026-11-09 耗电事故里我们**没能及时发现**
 *   的那个读数。⇒ 判据：**「没测」必须与「测了是 0」在读数上分得开**（D253 家族）。
 */
function row(v: SlotView): string {
  const g = STATE_GLYPH[v.state] ?? '?'
  const who = v.state === 'free' ? '' : ` ${v.trajectory || v.sessionId || '(unowned)'}`
  const res = v.sampled ? `cpu${v.cpuPct}% rss${v.rssMb}M` : 'cpu— rss—(not sampled on this platform)'
  const extra = v.state === 'free' ? '' : ` held${v.heldMin}m idle${v.idleMin}m ${res}`
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
      `⛔ needs --slot <b1..b20> (got ${JSON.stringify(args.slot)}).\n` +
        `  ⇒ Page actions must name the slot: run \`browser_slot list\` to see which one you hold.`,
    )
  }
  return n
}

/**
 * 解析「要操作哪个 target」——`--target`（身份）或 `--match`（子串线索）二选一。
 *
 * 🔴 判据在 `browser/target-pick.ts`（0 命中不猜 / 多命中不猜 / 身份优先于线索）。
 *    这里只负责**把拒绝翻成人话**：多命中时把候选列全，让调用方一次就能改对。
 */
async function needTarget(
  root: string,
  n: number,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const target = str(args.target)
  const match = str(args.match)
  if (!target && !match) {
    throw new Error(
      `⛔ needs --target=<targetId> or --match=<URL/title substring> (run targets first).\n` +
        `  ⇒ --match is a substring match: it acts only on a unique hit; multiple hits are rejected with all candidates listed.`,
    )
  }
  return resolveTarget(root, n, sessionId, { target, match })
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

/**
 * `open`/`goto` 回执的**域名说明书尾巴**（owner 2026-11-23 令：浏览器扩展 skill 域名强相关）。
 *
 * 🔴 为什么是"回执尾巴"而⛔ 不是新注入点：模型刚打开这个站、正要操作它 ——
 *    此刻把说明书写进**这次调用的结果**里，时机最准，且**零唤醒风险**
 *    （`kernel/injection-sites.ts` 那张表的 `wakes` 一轴一行都不用改）。
 *
 * 🔴 未命中 ⇒ **返回空串**，回执与今天**逐字相同**：绝大多数站没有说明书，
 *    给它们加一句"本站无说明书"是每天几十次的纯噪声，会把真信号埋掉。
 *
 * ⚠️ 任何异常都吞掉 —— 说明书是旁路，⛔ 不许让"打开网页"因它失败。
 */
function domainSkillTail(root: string, url: string, sessionId: string, slot: number): string {
  try {
    // 记账**先于**注入：即使读说明书失败，"用过这个站"这个事实也要留下（设计 §改动 2）
    recordVisit(root, url, sessionId, slot)
    const hit = loadDomainSkill(root, url)
    // 🔴 片段清单与说明书**各自独立**：说明书没写但放了片段 ⇒ 片段清单照样出现。
    //    ⛔ 不要写成"有说明书才看片段" —— 那是两个不同的存在，互不依赖。
    const snip = snippetTail(root, url)
    return (hit ? hit.text : '') + snip
  } catch {
    return ''
  }
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
      if (!res.ok) return `⛔ acquire failed.\n${res.detail}`
      // 要求同步等到可用（opt-in）：CDP 就绪才算真的能用
      if (args.wait === true) {
        const ready = await waitSlotReady(root, res.slot)
        return `${res.detail}\n${ready.ok ? '✓ ' + ready.detail : '⚠️ ' + ready.detail}`
      }
      return res.detail
    }
    case 'release': {
      const n = normalizeSlotId(String(args.slot ?? ''))
      if (n === 0) return '⛔ release needs --slot <b1..b20>'
      const r = releaseSlot(root, sessionId, n)
      // 🔴 只在**真的释放成功**时才提"写说明书"（owner 裁的触发点就是这里）。
      //    "本就无人占用"那条路径 released=false ⇒ ⛔ 一个字都不加。
      return r.detail + (r.released && r.ok ? domainSkillPrompt(root) : '')
    }
    case 'reap': {
      const n = normalizeSlotId(String(args.slot ?? ''))
      if (n === 0) return '⛔ reap needs --slot <b1..b20>'
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'manual reaping'
      return reapSlot(root, n, reason).detail
    }
    case 'hold': {
      // 🔴 保活（owner 2026-11-24 裁）：长下载／慢查询期间别被闲置强关误杀。
      const n = normalizeSlotId(String(args.slot ?? ''))
      if (n === 0) return '⛔ hold needs --slot <b1..b20>'
      const mins = num(args.holdFor)
      if (mins === undefined) {
        return '⛔ hold needs --holdFor=<minutes> (e.g. --holdFor 60). No permanent hold — that would defeat idle reclaim.'
      }
      const reason = typeof args.reason === 'string' ? args.reason : ''
      const r = holdSlot(root, sessionId, n, mins, reason)
      return r.ok ? r.detail : `⛔ ${r.detail}`
    }
    case 'status': {
      const n = normalizeSlotId(String(args.slot ?? ''))
      const v = n > 0 ? slotStatus(root, n) : null
      if (!v) return `⛔ invalid slot (1..${MAX_SLOTS})`
      return row(v).trimStart()
    }
    case 'list':
    default: {
      const { views, ledgerAgeMin } = listSlots(root)
      const occupied = views.filter((v) => v.state !== 'free')
      const bad = views.filter((v) => v.state === 'stale' || v.state === 'orphaned')
      const lines: string[] = []
      lines.push(
        `slots ${views.length} (busy ${occupied.length}, free ${views.length - occupied.length}, bad ${bad.length})` +
          (ledgerAgeMin > 0 ? `  ledger ${ledgerAgeMin}m old` : ''),
      )
      lines.push('  · free   ✓ leased   ! stale(act)   ✗ orphaned')
      if (occupied.length === 0) {
        lines.push('  (all free)')
      } else {
        for (const v of occupied) lines.push(row(v))
      }
      if (bad.length > 0) {
        lines.push('')
        lines.push('🔴 The watchman notifies the OWNING session; if the owner is gone, reap it:')
        for (const v of bad) lines.push(`  browser_slot reap --slot ${v.label}`)
      }
      lines.push('')
      lines.push('usage: acquire (auto-picks, or --slot) · release (always when done) · status --slot b1')
      // 🔴 P3 读数面（v1.138.1）：域名台账此前**只有写没有读** —— 那等于"记了但没人能看"，
      //    而"写了没人读"的机制无法被验，也无法被质疑。这里给它一个最小可见面。
      //    ⚠️ 只列**前 5 个**（按次数降序）：list 是高频调用的动作，⛔ 不能变成一份长报告。
      const visits = Object.entries(readVisits(root).domains).sort(
        (a, b) => b[1].opens - a[1].opens || b[1].lastAt - a[1].lastAt,
      )
      if (visits.length > 0) {
        const missing = visits.filter(([h]) => !hasDomainSkill(root, h)).length
        lines.push('')
        lines.push(
          `domains ${visits.length}${missing > 0 ? ` (${missing} without notes)` : ' (all documented)'}:`,
        )
        for (const [h, v] of visits.slice(0, 5)) {
          lines.push(`  ${hasDomainSkill(root, h) ? '✓' : '·'} ${h.padEnd(28)} ${v.opens}x`)
        }
        if (visits.length > 5) lines.push(`  …${visits.length - 5} more (BROWSER/_index.json)`)
      }
      return lines.join('\n')
    }
    case 'doctor': {
      return JSON.stringify(doctorSlots(root), null, 2)
    }
    // ── ② 页面层（v1.129.0 从 browser MSM 搬入）──────────────────
    case 'targets': {
      const n = needSlot(args)
      const list = await slotTargets(root, n, sessionId)
      if (list.length === 0) return `no targets on ${slotLabel(n)} (port ${slotPort(n)})`
      return (
        `[browser_slot] ${list.length} target(s) on ${slotLabel(n)} (port ${slotPort(n)})\n` +
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
      if (!url) return '⛔ needs --url=<address>'
      const id = await slotOpen(root, n, sessionId, url)
      return `[browser_slot] targetId=${id}` + domainSkillTail(root, url, sessionId, n)
    }
    case 'goto': {
      // 🔴 2026-11-24 实测代价：一次只报一个缺参 ⇒ 调用方要猜两轮才拼对
      //    （先报缺 --target，再报缺 --slot）。⇒ 这里**一次报全**，且把 `open` 与 `goto` 的
      //    参数差异直接写进文案 —— 两者形状不同，是最容易照抄错的地方。
      const rawSlot = String(args.slot ?? '')
      const n = normalizeSlotId(rawSlot)
      const url = str(args.url)
      const target = str(args.target)
      const match = str(args.match)
      const missing: string[] = []
      if (n === 0) missing.push('--slot <b1..b20>')
      if (!target && !match) missing.push('--target <targetId> or --match <URL/title substring> (run targets first)')
      if (!url) missing.push('--url <destination>')
      if (missing.length > 0) {
        return (
          `⛔ goto missing ${missing.length} arg(s), all listed at once:\n` +
          missing.map((m) => `  · ${m}`).join('\n') +
          `\n  ⚠️ goto differs from open: open needs only --slot + --url; goto also needs WHICH tab to navigate.`
        )
      }
      // TS 无法从 missing.length 收窄三者的类型 ⇒ 此处显式断言（上面已判过它们都非空）
      const slotN = n as number
      const destUrl = url as string
      const tgt = target ?? (await needTarget(root, slotN, sessionId, args))
      await slotGoto(root, slotN, sessionId, tgt, destUrl)
      return `[browser_slot] navigate ${tgt} → ${destUrl}` + domainSkillTail(root, destUrl, sessionId, slotN)
    }
    case 'eval': {
      const n = needSlot(args)
      const js = str(args.js)
      const target = await needTarget(root, n, sessionId, args)
      if (!js) return '⛔ needs --js=<expression> (e.g. document.title)'
      const v = await slotEval(root, n, sessionId, target, js, num(args.timeout))
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    }
    case 'text': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      return await slotText(root, n, sessionId, target)
    }
    case 'html': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      return await slotHtml(root, n, sessionId, target, num(args.max))
    }
    case 'shot': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const out = str(args.out) ?? `_tmp/browser-shots/shot-${target.slice(0, 8)}-${Date.now()}.png`
      const rel = await slotShot(root, n, sessionId, target, out)
      return `[browser_slot] shot → ${rel}`
    }
    case 'reload': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const state = await slotReload(root, n, sessionId, target, str(args.script))
      return `[browser_slot] reload done (readyState=${state || '?'})`
    }
    case 'click': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const text = str(args.text)
      const xy = parseXY(args.xy as never)
      if (!text && !xy) {
        return `⛔ needs --text=<visible label> or coordinates (all three forms accepted):\n${xyFormHint('xy')}\n  e.g. --text=Sign in`;
      }
      // 🔴 `--ref` 参与命中判定（2026-11-13 B 项）：给了 ref 就**必须**落在那个 ref 上，
      //    ⛔ 不给 ref 时只报告"落到了谁"（调用方没说要打谁，就没有"打错了"这回事）
      const refRaw = str(args.ref)
      const refId = refRaw === undefined ? undefined : (refToBackendId(refRaw) ?? undefined)
      if (refRaw !== undefined && refId === undefined) {
        return `⛔ malformed --ref: ${JSON.stringify(refRaw)} (want eNNN from \`ax\`)`
      }
      const { picked, dialogs, hit } = await slotClick(root, n, sessionId, target, { text, xy, ref: refId })
      // ⚠️ 回执只说"点了什么 / 落到谁身上"，⛔ 不说"点成功了" —— 界面该变成什么样由调用方判断
      const what = xy
        ? `@${xy.x},${xy.y}`
        : `<${picked.tag}> "${picked.text.slice(0, 60)}" @${picked.x},${picked.y}`
      const base = `[browser_slot] clicked ${what}｜hit: ${renderHit(hit)}`;
      // 🔴 自动处理掉的弹窗必须报出来（⛔ 静默替你点了「取消」是另一种欺骗）
      if (dialogs.length === 0) return base
      const seen = dialogs
        .map((d) => `  ⚠️ auto-handled dialog ${d.type || '(unknown)'}: ${JSON.stringify(d.message.slice(0, 100))} ⇒ ${d.accepted ? 'accepted' : 'dismissed'}`)
        .join('\n')
      return `${base}\n${seen}\n  (default = dismiss; use dialog --accept to confirm — OK often means delete/pay/publish)`
    }
    // ── ②b 高阶页面动作（v1.130.0）──────────────────────────────
    case 'ax': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const { lines, total } = await slotAx(root, n, sessionId, target, num(args.limit) ?? 200)
      if (lines.length === 0) {
        return (
          `[browser_slot] ax — no interactive elements in the a11y tree (target=${target}).\n` +
            `  ⇒ maybe not rendered yet (wait first), or the page is genuinely static text (use text).`
        )
      }
      return `[browser_slot] ax — ${lines.length} interactive element(s) (of ${total}; ref stays stable across snapshots)\n${renderAx(lines, total)}`;
    }
    case 'press': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const k = str(args.key)
      if (!k) return '⛔ needs --key=<key> (e.g. Enter / Escape / Control+A / Meta+Shift+Enter)';
      const { stroke, sent } = await slotPress(root, n, sessionId, target, k, num(args.times) ?? 1);
      return (
        `[browser_slot] press ${stroke.key} (code=${stroke.code}, modifiers=${stroke.modifiers}) × ${sent}\n` +
          `  ⚠️ This only reports keys SENT, ⛔ not that the UI responded — re-read with ax / eval.`
      );
    }
    case 'type': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const text = typeof args.text === 'string' ? args.text : undefined;
      if (text === undefined || text === '') return '⛔ needs --text=<exact text> (acts on current focus; use fill to set a value)';
      await slotType(root, n, sessionId, target, text);
      return `[browser_slot] type ${JSON.stringify(text.slice(0, 40))} (inserted ${[...text].length} chars; ⛔ no change event — blur triggers it)`;
    }
    case 'fill': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const id = needBackendId(args);
      const value = typeof args.value === 'string' ? args.value : undefined;
      if (value === undefined) return '⛔ needs --value=<value> (empty string allowed: --value=)';
      const r = await slotFill(root, n, sessionId, target, id, value);
      if (!r.ok) return `⛔ fill failed (<${r.tag || '?'}>): ${r.why ?? 'unknown reason'}`;
      // 🔴 只报读回来的值：设值没有可靠成功信号
      const same = r.readBack === value;
      return (
        `[browser_slot] fill <${r.tag}> read-back=${JSON.stringify(r.readBack.slice(0, 80))}` +
          (same ? '  ✓ matches the value given' : '  ⚠️ does NOT match — the control may reformat or reject it')
      );
    }
    case 'scroll': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const refStr = str(args.ref);
      const xy = parseXY(args.xy as never);
      const toRaw = str(args.to);
      const to = toRaw === 'top' || toRaw === 'bottom' ? toRaw : undefined;
      if (!refStr && !xy && !to) return '⛔ needs one of --ref=<eNNN> / --xy=<x,y> / --to=<top|bottom>';
      const ref = refStr ? needBackendId(args) : undefined;
      const { scrolledY, via, why } = await slotScroll(root, n, sessionId, target, { ref, xy, to, deltaY: num(args.delta) });
      const viaLine =
        via === 'wheel'
          ? '(real wheel event)'
          : `(⚠️ fell back to JS scroll — ${why ?? ''}; NO wheel event was emitted, so wheel-triggered lazy loading will not start)`;
      return `[browser_slot] scroll → scrollY ${scrolledY > 0 ? '+' : ''}${scrolledY}px ${viaLine}`;
    }
    case 'wait': {
      const n = needSlot(args)
      const target = await needTarget(root, n, sessionId, args)
      const forRaw = str(args.for);
      if (!forRaw) return '⛔ needs --for=<selector:…|text:…|url:…|gone:…|js:…> (prefix required)';
      const { spec, waitedMs } = await slotWait(root, n, sessionId, target, forRaw, num(args.timeout) ?? 15_000);
      return `[browser_slot] wait ${spec.kind} satisfied (waited ${waitedMs}ms)`;
    }
    case 'drag': {
      const n = needSlot(args);
      const target = await needTarget(root, n, sessionId, args);
      const from = parseXY(args.from as never);
      const to = parseXY(args.to as never);
      if (!from || !to) return `⛔ needs --from and --to (all three coordinate forms accepted):\n${xyFormHint('from')}${xyFormHint('to')}\n  get a ref via ax, then measure coords with scroll/eval`;
      const steps = num(args.steps) ?? 12;
      await slotDrag(root, n, sessionId, target, from, to, steps);
      return `[browser_slot] drag ${from.x},${from.y} → ${to.x},${to.y} (${steps} steps; ⛔ this does not report success)`;
    }
    case 'upload': {
      const n = needSlot(args);
      const target = await needTarget(root, n, sessionId, args);
      const id = needBackendId(args);
      const list = Array.isArray(args.file) ? (args.file as unknown[]) : typeof args.file === 'string' ? [args.file] : [];
      if (list.length === 0) return '⛔ needs --file=<path inside CCC> (repeatable; paths outside the CCC root are refused)';
      const abs = list.filter((x): x is string => typeof x === 'string' && x !== '').map((f) => resolveUploadPath(root, f));
      if (abs.length === 0) return '⛔ no usable path in --file';
      const r = await slotUpload(root, n, sessionId, target, id, abs);
      return `[browser_slot] upload ${r.files.length} file(s) → ref ${str(args.ref) ?? ''}\n  ${r.files.map((f) => f.replace(root + '/', '')).join('\n  ')}`;
    }
    case 'downloads': {
      const n = needSlot(args);
      const target = await needTarget(root, n, sessionId, args);
      const { dir, files } = await slotDownloads(root, n, sessionId, target);
      const body = files.length === 0 ? '(directory is empty)' : files.map((f) => `  ${f.name}  ${Math.round(f.bytes / 1024)} KB`).join('\n');
      return (
        `[browser_slot] download capture dir: ${dir}\n${body}\n` +
          `  ⇒ trigger a download with click (links with download attr are refused) or eval; then call downloads again to see new files.\n` +
          `  ⚠️ The dir is never auto-cleaned — cleaning it destroys evidence.`
      );
    }
    case 'dialog': {
      const n = needSlot(args);
      const target = await needTarget(root, n, sessionId, args);
      const accept = args.accept === true;
      const r = await slotDialog(root, n, sessionId, target, accept, str(args.prompt));
      if (!r.hadDialog) return '[browser_slot] dialog — no dialog open right now (normal, not an error)';
      return (
        `[browser_slot] dialog ${r.type || '(unknown)'}: ${JSON.stringify(r.message.slice(0, 120))}\n` +
          `  ${r.accepted ? '✓ accepted (OK)' : '✓ dismissed (Cancel)'}`
      );
    }
    case 'close': {
      const n = needSlot(args)
      const all = args.all === true
      // --all 时不需要点名 target（全关）；否则按同一套 --target/--match 规则解析
      const target = all ? '' : await needTarget(root, n, sessionId, args)
      const closed = await slotClose(root, n, sessionId, target, all)
      return `[browser_slot] closed ${closed.join(', ')}`
    }
    // ── ③ 扩展层 ─────────────────────────────────────────────────
    case 'ext-list': {
      const exts = slotExtList(root)
      if (exts.length === 0) {
        return (
          `No browser extensions in this CCC yet.\n` +
          `  To add one: drop a .ts file under <CCC root>/${EXT_DIR_REL}/ — the filename is the extension name.\n` +
          `  Contract: stdin gets {slot,port,cccRoot,args}; stdout's LAST non-empty line must be {"ok":true,"result":…}.\n` +
          `  ⚠️ ACC only spawns, ⛔ never imports — your syntax error cannot take down the host.`
        )
      }
      return (
        `browser extensions in this CCC: ${exts.length} (<CCC root>/${EXT_DIR_REL}/):\n` +
        exts.map((e: { name: string }) => `  · ${e.name}`).join('\n') +
        `\n\ncall: browser_slot ext --slot b1 --name <name> [--earg key=value … (repeatable)]`
      )
    }
    case 'ext': {
      const n = needSlot(args)
      const name = str(args.name)
      if (!name) return '⛔ needs --name=<extension> (run ext-list first)'
      const res = await slotExt(root, n, sessionId, name, extArgs(args))
      if (!res.ok) return `⛔ extension "${name}" failed (${res.code ?? 'unknown'}):\n${res.error ?? ''}`
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
      'Actions: acquire (lease a slot; reuses your existing lease instead of leasing a second one) / release (REQUIRED when done — a background watchman nudges you if you forget, and **force-reclaims after ~30 min of silence**) / list (all slots + occupancy) / status --slot <bN> / hold --slot <bN> --holdFor <minutes> [--reason] (keep-alive: the idle reclaim skips a held slot; use it before long downloads or slow queries — no permanent hold) / reap --slot <bN> (force-reclaim an abandoned slot, records a reason) / doctor (self-check, read-only). ' +
      'PAGE: targets / open / goto / eval / text / html / shot / reload / close / click (text or xy, real mouse events). ' +
      'HIGH-LEVEL (v1.130.0): ax (accessibility-tree snapshot -> stable `ref` like e12345; the only honest answer to "is this control clickable") / press (semantic keys & chords: Enter, Escape, Control+A; non-ASCII text must use `type`) / type (browser text input at the focused element) / fill --ref --value (native setter + input/change so React/Vue actually see it; receipt reports the READ-BACK value) / scroll (real wheel events, so lazy-loading and virtual lists fire) / wait --for <selector:|text:|url:|gone:|js:> (in-page polling; timeout says WHAT it waited for and what it last read) / drag --from --to (multi-step mouseMoved; one-jump drags are ignored by sortablejs & friends) / upload --ref --file (paths must stay inside the CCC root) / downloads (pins the capture dir to _tmp/browser-downloads/<slot>) / dialog (default DISMISS — OK often means delete/pay/publish). ' +
      '🔴 Lease before you drive a browser for evidence, and ALWAYS release when finished — an unreleased slot keeps a Chrome process alive and burns power. ' +
      'DOMAIN SKILL (browser extension skill — per-site know-how): `open`/`goto` automatically append `BROWSER/<domain>/SKILL.md` to their receipt when that site has one (nothing is added when it does not — silence means "no notes for this site yet"). On a successful `release` the receipt lists sites you have used that still have no SKILL.md, with the exact path to write. When a site gives you trouble twice, record what you learned there (four sections: quirks / known traps with how you found them / working sequence / what failed).',
    parameters: {
      action: { type: 'string', enum: [...SLOT_ACTIONS], required: true, description: 'Subcommand' },
      slot: { type: 'string', description: 'Slot label for status/release/reap (b1..b20, or 1..20); for acquire = request a specific slot (omit = auto-pick a free one)' },
      wait: { type: 'boolean', description: 'acquire: wait until the CDP endpoint actually answers (2 consecutive probes) before returning. Default false (returns once the process is spawned).' },
      reason: { type: 'string', description: 'reap / hold: why this slot is being force-reclaimed, or why it must stay alive (recorded).' },
      // 🔴 键名必须是 `holdFor`，⛔ 不能叫 `for` —— `wait` 已经占用了 `for`（前缀字符串），
      //    同一个 schema 对象里两次声明同名键 ⇒ **后者覆盖前者**，`hold --for` 会静默拿到 wait 的
      //    字符串 schema ⇒ 数字被当成非法值。TS1117 只在 typecheck 里报，单测不构造工具就看不见。
      holdFor: { type: 'number', description: 'hold: keep-alive minutes (max 240). Use before a long download / slow query, or the idle guard will force-reclaim the slot after ~30 min of silence. No permanent hold — renew it instead.' },
      // ── 页面层（v1.129.0 搬入）与扩展层的参数 ─────────────────────
      //
      // 🔴🔴 **这 7 个参数曾长期缺失**（v1.129.0 ~ v1.129.2）：`run()` 一直在读它们，
      //    而 `parameters` 只声明了 4 个。JS 忽略多余字段 ⇒ **功能一直是对的**，
      //    坏的是**可发现性**：调用方（尤其没有文档的模型）在 schema 里看不到
      //    `url`/`target`/`js`，自然也不会传 —— 于是 `⛔ 需要 --url=<地址>`
      //    这类拒绝看起来像"功能没做"，而不是"你没给参数"。
      //
      // ⇒ 判据（D310）：**读而没说 = 半个功能**。一个参数的"存在"由 schema 决定，
      //    不由 execute 里的 `args.x` 决定 —— 后者只有读过源码的人才知道。
      //    ⛔ 不靠"文档里写了"补这一格：文档是给人看的，schema 是给调用方看的。
      url: { type: 'string', description: 'open / goto: the address to open or navigate to (http(s)://…)' },
      target: { type: 'string', description: 'goto / eval / text / html / shot / reload / close: the targetId from `targets` (⛔ not a slot number). Identity — beats `match` when both given' },
      match: { type: 'string', description: 'goto / eval / text / html / shot / reload / close: URL or title SUBSTRING (case-insensitive) instead of a targetId — saves the `targets` round-trip. Refuses unless exactly ONE page matches; on ambiguity it lists the candidates instead of guessing' },
      js: { type: 'string', description: 'eval: a JavaScript expression to evaluate in the page (e.g. document.title); uses Runtime.evaluate' },
      out: { type: 'string', description: 'shot: output path for the PNG, relative to the CCC root. Omit = auto-named under _tmp/browser-shots/' },
      max: { type: 'number', description: 'html: truncate the returned HTML after this many characters' },
      all: { type: 'boolean', description: 'close: close every target in the slot instead of one (then `target` is not needed)' },
      name: { type: 'string', description: 'ext: extension name = the .ts file name under <CCC>/browser-ext/ (run `ext-list` to see them)' },
      // earg 刻意只声明 string：契约是"重复的 key=value，值一律当字符串"，
      // 若声明成 object 会诱导调用方传 {"k":"true"}，然后在扩展里静默变成字符串 "true"。
      earg: { type: 'array', items: { type: 'string' }, description: 'ext: repeatable key=value pairs passed to the extension as strings (e.g. ["city=Suzhou"])' },
      timeout: { type: 'number', description: 'eval: evaluate timeout in milliseconds' },
      text: { type: 'string', description: 'click: visible-text SUBSTRING of the element to click (matched against rendered text + value + aria-label + title). Refuses when 0 or >1 elements match, or the single hit is disabled/zero-size/pointer-events:none — never guesses, because a wrong click has already happened' },
      // 🔴 坐标三种形态都声明（2026-11-13 事故）：只收 string 会逼模型把两个数字序列化进字符串，
      //    它更自然的写法是裸两个数字 ⇒ 参数 JSON 直接坏在解析阶段（MALFORMED_RESPONSE），工具一次没跑。
      // 🔴🔴 对象那一支的形状是**试出来的，不是想出来的**（D326），四种写法只有一种能用：
      //    ① `{ type:'object', additionalProperties:true }` ⇒ 任何对象都命中 ⇒ 非数字分量也放行
      //    ② `{ enum:[{}] }`（想表达"任意对象"）            ⇒ **恒不命中**（枚举匹配只认标量）⇒ 对象形态整体被拒
      //    ③ `{ …properties, required:['x','y'] }`（分支级必填）⇒ **最低档宿主编译失败**
      //       （`oneOf` 的子分支不允许 `required`，报 "is not supported by the value schema DSL"）
      //       ⚠️ 这一条最险：`defineTool` 在**创建时**就编译 ⇒ 抛错 = **整个 browser_slot 在真机上不存在**，
      //       而单测只要不构造工具就照样全绿。⇒ 本文件必须有一条"工具能构造出来"的用例兜底（见 S1）。
      //    ④ ✅ 采纳：`type:'object' + properties{x,y 各带 required:true} + additionalProperties:false`
      //       ⇒ 三种形态**各自恰好命中一支**；非数字分量 / 缺分量 / 多余键**照旧被拒**。
      //    ⇒ 判据：**收得宽 ≠ 判得松**。放宽的是「形态」，收紧的是「分量」——两层分工写清：
      //      schema 管**形状**，`parseXY` 管**内容**（分量个数、有限数、非负）。谁都不越界。
      xy: {
        oneOf: [
          { type: 'string', description: '"x,y" (comma or space separated)' },
          { type: 'array', items: { type: 'number' }, description: '[x, y]' },
          {
            type: 'object',
            properties: { x: { type: 'number', required: true, description: 'viewport x' }, y: { type: 'number', required: true, description: 'viewport y' } },
            additionalProperties: false,
            description: '{x, y}',
          },
        ],
        description: 'click / scroll: viewport coordinates as "x,y" | [x,y] | {x,y}. ⛔ Not a slot or element id — pass `ref` for provenance',
      },
      script: { type: 'string', description: 'reload: a script to run after the reload completes' },
      ref: { type: 'string', description: 'fill / scroll / upload: the element ref from \`ax\` (e.g. e12345 = an AX backendDOMNodeId). ⛔ NOT a CSS selector — refs are identities and re-snapshot when stale' },
      value: { type: 'string', description: 'fill: the value to set (empty string allowed). Drives the native value setter + input/change so controlled components (React/Vue) see it. Receipt reports the READ-BACK value, not "success"' },
      key: { type: 'string', description: 'press: key or chord — Enter / Escape / Tab / ArrowUp / Home / Space / Backspace / Delete / Control+A / Meta+Shift+Enter / single a-z 0-9. Non-ASCII text must use \`type\`' },
      times: { type: 'number', description: 'press: how many times to send the key (default 1)' },
      to: { type: 'string', description: 'scroll: "top" | "bottom" (whole-page jump). Otherwise give ref or xy plus optional delta' },
      delta: { type: 'number', description: 'scroll: wheel deltaY in px (default 600; negative scrolls up)' },
      for: { type: 'string', description: 'wait: REQUIRED PREFIX — selector:<css> | text:<substring> | url:<substring> | gone:<css> | js:<expr>. A bare value is refused because "which form" would be a guess' },
      from: {
        // 三支互斥的理由同 `xy`（四种写法的实测结论见上面那段；⛔ 别把 required 提到分支级）
        oneOf: [
          { type: 'string', description: '"x,y"' },
          { type: 'array', items: { type: 'number' }, description: '[x, y]' },
          {
            type: 'object',
            properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
            additionalProperties: false,
            description: '{x, y}',
          },
        ],
        description: 'drag: start point in viewport coords (three forms, same as xy)',
      },
      steps: { type: 'number', description: 'drag: number of intermediate mouseMoved steps (default 12; sortablejs needs a real move sequence)' },
      file: { type: 'array', items: { type: 'string' }, description: 'upload: repeatable path INSIDE the CCC root. Paths outside are refused, as are missing files (DOM.setFileInputFiles silently succeeds on them)' },
      accept: { type: 'boolean', description: 'dialog: accept (OK) instead of the default dismiss (Cancel). Default is dismiss because "OK" often means delete/pay/publish' },
      prompt: { type: 'string', description: 'dialog: text to type into a prompt() dialog (only meaningful with accept)' },
      limit: { type: 'number', description: 'ax: max interactive rows to return (default 200)' },
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
        // 🔴 **顺序不可换**（owner 2026-11-24 令）：**先提醒、后强关**。
        //    强关函数内部还有第二道闸（`nudges >= 1`），所以即使这里写反也不会误杀 ——
        //    但两道闸都要留：一道是流程，一道是函数自身的不变式。
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
        // 🔴 强关：把"劝"变成"劝不动就关"（owner：「浏览器一直不关的现象严重」）
        const killed = await forceReapIdleSlots(root, async (r, target, message) => {
          const out = await sendToCognitiveTrajectory(ctx, r, target, message, '浏览器槽位看守')
          return { ok: out.ok, detail: out.detail }
        })
        for (const k of killed.reaped) {
          console.warn(
            `[serenity-hooks] 槽位强关：${slotLabel(k.slot)} → ${k.trajectory || '(无归属)'} ` +
              `闲置 ${k.idleMin} 分钟：${k.killDetail}｜` +
              `告知 ${k.delivered ? '已注入' : '未注入'}：${k.deliverDetail}`,
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
