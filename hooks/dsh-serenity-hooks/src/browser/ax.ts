/**
 * browser/ax.ts — 无障碍树（AX）快照的**纯判定**：剪枝、ref 解析、渲染。
 *
 * 🔴 为什么要有这一格（而不是让调用方自己 eval 一个 querySelectorAll）：
 *    eval 只能看见 DOM，看不见三件事 ——
 *      ① 元素**是否真的在无障碍树上**（aria-hidden / inert / 视觉隐藏 ⇒ DOM 在、AX 不在）
 *      ② 元素**是什么角色**（div role=button 与 button 在 DOM 里一个是 div，在 AX 里同为 button）
 *      ③ 元素**是否可操作**（AX 的 disabled 是浏览器算出来的，比读属性准）
 *    ⇒ 「点不到某个控件」这类问题，问 DOM 会得到一堆「看起来是对的」，问 AX 才有答案。
 *
 * ## 🔴🔴 ref 是**身份**，不是索引（这条决定了本文件怎么写）
 *
 *    ref 形如 eNNN —— 里面装的是 **Chrome 自己给的 backendNodeId**。
 *    ⛔ 不用 e1,e2,e3 这种**按遍历顺序编号**：那份编号只在「这一次快照」里成立，
 *    下一次快照只要 DOM 变了，e3 就指向**另一个元素** —— 而且**没有任何信号**，
 *    你会点到旁边那个按钮，并真诚地以为点对了（与 D311 的 --match 选错 tab 同族，但更隐蔽）。
 *    ⇒ 用 backendNodeId：它对同一个节点**跨快照稳定**，且能直接喂给 DOM.resolveNode。
 *    ⚠️ 它不是永久 id（节点被删/页面导航后失效）⇒ 失效时报错并提示重取，⛔ 不静默回落。
 *
 * ## 剪枝判据（为什么只留「可交互」）
 *
 *    全量 AX 树在真实页面上是几千节点、几百 KB —— 塞进上下文会把「看」变成「读不完」。
 *    而调用方要做的事 99% 是**操作某控件**，不是读语义结构。
 *    ⇒ 只留**可交互角色**；要读正文走 text，要读结构走 html。
 */

/** AX 节点里本模块用到的字段（CDP Accessibility.AXNode 的子集，⛔ 不声明未用的） */
export interface AxNode {
  nodeId?: string
  ignored?: boolean
  role?: { type: string; value?: unknown }
  name?: { type: string; value?: unknown }
  description?: { type: string; value?: unknown }
  value?: { type: string; value?: unknown }
  properties?: Array<{ name: string; value?: { type: string; value?: unknown } }>
  backendDOMNodeId?: number
  childIds?: string[]
}

/** 一行快照（对外输出的最小单元） */
export interface AxLine {
  ref: string
  role: string
  name: string
  /** 值（输入框/下拉的当前值）；空串 = 没有或为空 */
  value: string
  /** 浏览器算出来的禁用态（⛔ 不是读 aria-disabled 属性） */
  disabled: boolean
  /** 展开/选中/勾选等（只报「有值且为真」的那些，省体积） */
  flags: string[]
}

/**
 * 视为「可交互」的角色白名单。
 *
 * 🔴 为什么是**白名单**而不是黑名单：AX 角色有 80+ 个，新的会随 Chrome 版本加。
 *    黑名单会**静默漏掉新角色**（那些控件在快照里消失，而读者以为页面上没有它）；
 *    白名单漏掉时表现为「看得少了」，比「以为不存在」安全。
 *    ⇒ 缺角色就往这里加 —— 这是唯一需要维护的清单。
 */
export const INTERACTIVE_ROLES: readonly string[] = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'gridcell',
  'columnheader',
  'rowheader',
  'scrollbar',
  'dialog',
  'alertdialog',
  'menu',
  'toolbar',
  'disclosuretriangle',
]

/** 会出现在 flags 里的属性（只报真值；false 不占位置） */
const FLAG_PROPS: readonly string[] = ['checked', 'selected', 'expanded', 'pressed', 'required', 'readonly', 'invalid']

/** 读一个 AX 值字段为字符串 */
function val(v: { value?: unknown } | undefined): string {
  if (!v) return ''
  const x = v.value
  return typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : ''
}

/**
 * 把 CDP 的 AX 节点数组剪成「可操作清单」。
 *
 * 判据：
 *   ① ignored === true ⇒ 丢掉（aria-hidden ／ inert ／ 视觉隐藏都在这一档）
 *   ② 角色不在白名单 ⇒ 丢掉
 *   ③ **没有名字的可交互节点保留**（图标按钮就是这样：role=button、name 空、有无障碍标签在 description 里）
 *      —— ⛔ 不许因为「名字为空」就丢：那会把最常见的图标按钮整类漏掉
 *   ④ 没有 backendDOMNodeId 的节点 ⇒ 丢掉（没有它就点不到，留着只会让人以为能点）
 */
export function pruneAx(nodes: readonly AxNode[], limit = 200): AxLine[] {
  const out: AxLine[] = []
  for (const n of nodes) {
    if (out.length >= limit) break
    if (n.ignored === true) continue
    const role = val(n.role).toLowerCase()
    if (!INTERACTIVE_ROLES.includes(role)) continue
    const id = n.backendDOMNodeId
    if (typeof id !== 'number' || id <= 0) continue
    const name = val(n.name)
    const desc = val(n.description)
    const flags: string[] = []
    let disabled = false
    for (const p of n.properties ?? []) {
      const pv = val(p.value)
      if (p.name === 'disabled' && (pv === 'true' || pv === '1')) disabled = true
      if (FLAG_PROPS.includes(p.name) && pv !== '' && pv !== 'false') flags.push(p.name + '=' + pv)
    }
    out.push({
      ref: 'e' + String(id),
      role,
      name: name || (desc ? '(' + desc + ')' : ''),
      value: val(n.value),
      disabled,
      flags,
    })
  }
  return out
}

/** 从 ref 里解出 backendNodeId；格式不对 ⇒ null（⛔ 不猜） */
export function refToBackendId(ref: string): number | null {
  const m = /^e([1-9][0-9]{0,15})$/.exec(ref.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 渲染成「能照着 ref 用」的几行 */
export function renderAx(lines: readonly AxLine[], total?: number): string {
  const body = lines
    .map((l) => {
      const v = l.value ? '  =' + JSON.stringify(l.value.slice(0, 40)) : ''
      const f = l.flags.length > 0 ? '  [' + l.flags.join(' ') + ']' : ''
      const d = l.disabled ? '  [disabled]' : ''
      return '  ' + l.ref.padEnd(9) + ' ' + l.role.padEnd(14) + ' ' + (l.name || '(无名)').slice(0, 60) + v + f + d
    })
    .join('\n')
  const more =
    typeof total === 'number' && total > lines.length
      ? '\n  …另有 ' + String(total - lines.length) + ' 个（用 --limit 调大）'
      : ''
  return body + more
}
