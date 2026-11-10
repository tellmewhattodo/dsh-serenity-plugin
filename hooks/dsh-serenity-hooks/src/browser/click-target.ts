/**
 * click-target.ts — 「按语义点一个元素」的**纯判定**（选中谁），执行在 cdp.ts。
 *
 * 🔴🔴 为什么这一格比 `--match`（选 tab）要求更严：
 *    **选错 tab 只是退回来，点错元素是已经发生的事。** 少一步、少一次 `targets` 是便利，
 *    但便利必须由**判定**承担，不能由"猜"承担 —— 猜错点下去的按钮不会自己撤销。
 *
 * 判据（四条，都是"宁可拒绝"）：
 *   ① **0 命中 ⇒ 拒绝**，并把页面上可见的可点元素列一批（让调用方一眼改对）。
 *   ② **多命中 ⇒ 拒绝**，列全部候选。⛔ 不选"第一个""最像的""最上层的"。
 *   ③ **命中但不可点**（`disabled` / `aria-disabled=true` / 零尺寸 / `pointer-events:none`）
 *      ⇒ **拒绝**，并说明是哪一条。⛔ 不"尽力点一下试试"—— 点了没反应与点了没点，
 *      在下一次读数里**看起来一样**，而这正是最难查的那种错。
 *   ④ **可见文本取"渲染后的文本"**，不取 `textContent`：后者含 `display:none` 与
 *      `<script>` 里的字，会让"匹配到了"与"屏幕上真看得见"变成两件事。
 *
 * ⛔ **刻意不做的事**：不点 `<input type="file">`（会开系统文件选择器，把自动化卡死）、
 *    不点带 `download` 的链接（会产生本工具不追踪的落盘）。
 */

/** 在页面里跑的采集器：把可点元素压成一份小表。 */
export const COLLECT_CLICKABLE = `(() => {
  const sel = 'a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (i >= 400) break;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && type === 'file') continue;
    const text = ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '') + '')
      .replace(/\\s+/g, ' ').trim();
    out.push({
      tag: el.tagName.toLowerCase(),
      type,
      text: text.slice(0, 120),
      role: el.getAttribute('role') || '',
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      pointerNone: cs.pointerEvents === 'none',
      download: el.hasAttribute('download'),
    });
    i++;
  }
  return out;
})()`

/** 采集器回来的一个元素。 */
export interface Clickable {
  tag: string
  type: string
  text: string
  role: string
  x: number
  y: number
  w: number
  h: number
  disabled: boolean
  pointerNone: boolean
  download: boolean
}

export type ClickPick =
  | { ok: true; el: Clickable; by: 'xy' | 'text' }
  | { ok: false; reason: 'no-candidate' | 'not-found' | 'ambiguous' | 'not-clickable'; hits: Clickable[]; why?: string }

/**
 * 挑一个元素。
 *
 * @param list `COLLECT_CLICKABLE` 的结果
 * @param opts `xy` = 直接给坐标（⛔ 不参与文本匹配）；`text` = 可见文本子串（大小写不敏感）
 */
export function pickClickable(
  list: Clickable[],
  opts: { xy?: { x: number; y: number }; text?: string },
): ClickPick {
  // ① 坐标直通：调用方已经知道点哪（多半是从 `eval` 里量出来的），⛔ 不再做"顺便校验一下文本"
  if (opts.xy) {
    return { ok: true, el: { tag: '', type: '', text: '', role: '', ...opts.xy, w: 0, h: 0, disabled: false, pointerNone: false, download: false }, by: 'xy' }
  }

  const needle = (opts.text ?? '').trim().toLowerCase()
  if (!needle) return { ok: false, reason: 'no-candidate', hits: [] }

  // ② 只在**看得见**的元素里找：零尺寸 = 不在屏幕上（`innerText` 也拿不到它，但 `value` 会）
  const visible = list.filter((e) => e.w > 0 && e.h > 0)
  const hits = visible.filter((e) => e.text.toLowerCase().includes(needle))
  if (hits.length === 0) return { ok: false, reason: 'not-found', hits: [] }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', hits }

  // ③ 唯一命中，但它不可点 —— 拒绝，并说清是哪一条
  const el = hits[0]!
  if (el.pointerNone) return { ok: false, reason: 'not-clickable', hits, why: 'pointer-events:none（点不到它，点击会穿透到下面的元素）' }
  if (el.disabled) return { ok: false, reason: 'not-clickable', hits, why: 'disabled（点它不会有任何效果）' }
  if (el.download) return { ok: false, reason: 'not-clickable', hits, why: 'download 链接（会产生本工具不追踪的落盘）' }
  return { ok: true, el, by: 'text' }
}

/** 把候选渲染成「可以照着改」的几行。 */
export function renderClickables(list: Clickable[], max = 15): string {
  const shown = list.slice(0, max)
  const lines = shown.map(
    (e) => `  <${e.tag}${e.type ? ` type=${e.type}` : ''}> "${e.text.slice(0, 50)}" @${e.x},${e.y} ${e.w}x${e.h}${e.disabled ? ' [disabled]' : ''}`,
  )
  if (list.length > shown.length) lines.push(`  …另有 ${list.length - shown.length} 个`)
  return lines.join('\n')
}
