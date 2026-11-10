/**
 * target-pick.ts — 「按 URL / 标题子串挑一个 target」的**纯判定**。
 *
 * 🔴 为什么要单独一个文件、且必须是纯函数：
 *    `browser_slot shot --match <子串>` 的第一诉求是"少一步 `targets`"，
 *    而**最坏的结果是多挑了一个 tab 去截图** —— 那会产出一张**看起来对、内容却属于别人**的图，
 *    零报错、零信号。所以判定规则要能单测，且判据必须写得下"我不猜"。
 *
 * 判据（每条都是被否方案换来的）：
 *   ① **0 个命中 ⇒ 不猜**（不回落"唯一那个 tab"，也不算"当前激活页"）。
 *   ② **多个命中 ⇒ 不猜**（要求更长的子串），且回执把候选**列全**。
 *   ③ ⛔ **不静默优先级**（"优先 title 再 url"这类）—— 命中语义不同的两处仍算多命中。
 *   ④ `exact`（`--target` 直接给 id）永远优先，且**不参与子串匹配** ——
 *      id 是身份，子串是线索，两者的可信度不同级。
 */

/** 一个 target 的最小视图（与 cdp.ts 的 CdpTarget 同形，这里不 import 以免循环依赖）。 */
export interface PickableTarget {
  id: string
  type: string
  title: string
  url: string
}

export type PickResult =
  | { ok: true; target: PickableTarget; by: 'id' | 'match' }
  | { ok: false; reason: 'empty' | 'not-found' | 'ambiguous'; hits: PickableTarget[] }

/**
 * 挑一个 target。
 *
 * @param list 当前槽位上的全部 target（`/json/list` 原样）
 * @param opts `id` = 直接给 targetId；`match` = URL 或 title 的子串（大小写不敏感）
 */
export function pickTarget(
  list: PickableTarget[],
  opts: { id?: string; match?: string },
): PickResult {
  // ① 身份优先：给了 id 就只认 id，⛔ 不做"id 没找到再试试按子串"的回落 ——
  //    那会把一个打错的 id 变成"恰好相符的另一个 tab"，比直接报错坏得多。
  if (opts.id) {
    const hit = list.find((t) => t.id === opts.id)
    return hit ? { ok: true, target: hit, by: 'id' } : { ok: false, reason: 'not-found', hits: [] }
  }

  const needle = (opts.match ?? '').trim().toLowerCase()
  if (!needle) return { ok: false, reason: 'empty', hits: [] }

  // ② 只在 page 类型里找：`/json/list` 还含 iframe/worker/service_worker 等，
  //    它们有 id 但**不能截图、不能导航** ⇒ 让它们参与匹配会把"匹配到了"变成"随后 step 才失败"。
  const pages = list.filter((t) => t.type === 'page')
  const hits = pages.filter(
    (t) => t.url.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
  )

  if (hits.length === 0) return { ok: false, reason: 'not-found', hits: [] }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', hits }
  return { ok: true, target: hits[0]!, by: 'match' }
}

/** 把候选渲染成「可以照着改」的几行（多命中回执用）。 */
export function renderHits(hits: PickableTarget[], max = 10): string {
  const shown = hits.slice(0, max)
  const lines = shown.map((t) => `  ${t.id}  ${t.title.slice(0, 40)}  ${t.url.slice(0, 90)}`)
  if (hits.length > shown.length) lines.push(`  …另有 ${hits.length - shown.length} 个`)
  return lines.join('\n')
}
