/**
 * hit-test.ts — 「这一下**到底会点到谁**」的**纯判定**（取数在 cdp.ts，执行在 cdp.ts）。
 *
 * 🔴🔴 为什么这一格必须存在（2026-11-13，owner 令做的 B 项，属 `browser-cdp-landscape` §5 最贵的那个缺口）：
 *
 *    直到现在，`click --xy` 的回执说的是「**我点了哪里**」，不是「**我点到了什么**」。
 *    而下面这三种情况，**CDP 一行都不报**，回执照样写着 `clicked @x,y`：
 *
 *      ① **坐标在视口外** —— 事件发出去了，但视口里没有这个点 ⇒ 什么也没发生
 *      ② **被别的元素盖住** —— 点到了盖在上面的那个（弹层 ／ 固定头 ／ 遮罩 ／ 兄弟浮层）
 *      ③ **点在了空白处** —— 那里根本没有元素
 *
 *    ⇒ 判据：**「发了鼠标事件」与「点到了目标」是两件事**（D311 的坐标版）。
 *      回执必须回答后者，且**答案要能在下一步被验证**（所以回执里带"实际命中是谁"）。
 *
 * ## 取数为什么用 `DOM.getNodeForLocation` 而不用自己的 `elementFromPoint`
 *
 *    它问的是**合成器的真实命中测试**（与真实点击走同一套命中逻辑），而 `elementFromPoint`
 *    是 DOM 侧的另一份实现（同族判据：**有宿主自带实现时，直接调用它，不要复刻语义**）。
 *
 * ## 三条输出语义（`hit-test` 的返回值名就是这三条）
 *
 *    `ok`        —— 点下去会落在**你指定的那个元素**上
 *    `blocked`   —— 落在**别的元素**上（回执说清是谁；这是最常见的真故障）
 *    `blank`     —— 那里没有元素（页面确实留白）
 *    `offscreen` —— 点的位置不在视口内（**先 scroll**，⛔ 不要"点一下试试"）
 */

/** 一次命中测试的读数（由 `cdp.ts` 的 `hitTestAt` 采集，形状与 CDP 一一对应） */
export interface HitProbe {
  /** 该点是否落在视口内（CDP 对越界坐标**不报错**，只回空） */
  inViewport: boolean
  /** 视口尺寸（用于回执里说清"这个点在哪之外"） */
  viewport?: { w: number; h: number }
  /** `DOM.getNodeForLocation` 反解出的那个节点；空 = 那里没节点 */
  node?: { backendNodeId: number; nodeName: string; id?: string }
}

/** 判定结果（`kind` 就是上面那四条之一） */
export type HitVerdict =
  | { kind: 'ok'; node?: { backendNodeId: number; nodeName: string; id?: string } }
  | { kind: 'blocked'; hit: { backendNodeId: number; nodeName: string; id?: string }; why: string }
  | { kind: 'blank' }
  | { kind: 'offscreen'; why: string }

/**
 * 判「这一下会点到谁」。
 *
 * @param probe 命中测试读数
 * @param expect 期望命中的节点（`--ref` 时**有**这个值；纯 `--xy` 时**没有**）。
 *   ⚠️ 没有 `expect` 时**永远不判 `blocked`**：调用方没说要打谁，就没有"打错了"这回事 ——
 *   只能报告"打到了谁"。⛔ 不替调用方猜目标。
 */
export function judgeHit(probe: HitProbe, expect?: { backendNodeId: number }): HitVerdict {
  // ① 视口外：CDP 不报错，只回空 ⇒ 这一格必须**先判**，否则空的读数会被误判成 blank
  if (!probe.inViewport) {
    const vp = probe.viewport
    return {
      kind: 'offscreen',
      why: vp ? `不在视口内（视口 ${vp.w}×${vp.h}）` : '不在视口内（视口尺寸未取到）',
    }
  }

  // ② 那里没有节点
  if (!probe.node || probe.node.backendNodeId <= 0) return { kind: 'blank' }

  // ③ 没有期望 ⇒ 只报告"落到了谁"
  if (!expect) return { kind: 'ok', node: probe.node }

  // ④ 有期望 ⇒ 比对身份。⛔ 不比 tag/文字：同一个位置的两个 div 文字可以一样，backendiNodeId 才是身份（D316 同族）
  if (probe.node.backendNodeId === expect.backendNodeId) return { kind: 'ok', node: probe.node }

  const who = `<${probe.node.nodeName.toLowerCase()}${probe.node.id ? ` id="${probe.node.id}"` : ''}>`
  return {
    kind: 'blocked',
    hit: probe.node,
    why: `落点被 ${who} 接住了（它的 backendNodeId=${probe.node.backendNodeId}，期望的是 ${expect.backendNodeId}）`,
  }
}

/** 把判定渲染成一句**能被下一步验证**的回执（⛔ 不写"点击成功"这种无法证伪的话） */
export function renderHit(v: HitVerdict): string {
  switch (v.kind) {
    case 'ok':
      return v.node
        ? `命中 <${v.node.nodeName.toLowerCase()}${v.node.id ? ` id="${v.node.id}"` : ''}>`
        : '命中（未取反查节点）'
    case 'blocked':
      return `🔴 实际命中的不是你指定的元素：${v.why}`
    case 'blank':
      return '🔴 这个点上没有元素（页面留白／坐标算错了）'
    case 'offscreen':
      return `🔴 ${v.why} ⇒ 先 scroll 再点，⛔ 别"点一下试试"`
  }
}
