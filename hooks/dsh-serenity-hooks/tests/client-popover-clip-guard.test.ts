/**
 * client-popover-clip-guard.test.ts — 自绘 popover **定位形态守卫**（S142，2026-09-17）
 *
 * 背景（真机取证全过程见 SESSION.md §0p）：
 *   会话头部状态胶囊展开的卡片 `.sp-pop` 曾是 `position:absolute; right:0`。
 *   v1.36.1 把卡片加宽 340 → 680px（owner：「卡片做成双倍宽」），且 `right:0` 对齐
 *   ⇒ 卡片只向**左**长，左边界落到 274.2px。
 *   而祖先 `pI_x6G_centerCol` / `wSkVaW_root` 是 `overflow:hidden` 且左边界 = **280px**
 *   ⇒ 左边缘 5.8px 被**裁掉**（左边框线与圆角消失）。
 *   用户反馈原文：「下拉 dialog / 弹窗内容过宽后，会被左侧元素遮挡」。
 *
 * 修法（v1.39.1）：`.sp-pop` 改 `position:fixed`（**fixed 子元素不受祖先 overflow 裁切**）
 *   ＋ SafeModePanel 用 `getBoundingClientRect()` 算坐标并夹取进视口。
 *   （本仓 client 侧无 `react-dom` 依赖 ⇒ `createPortal` 不可用。）
 *
 * 本测试**机械守卫该形态**：`.sp-pop` 一旦被改回 absolute 定位（或被"顺手简化"回去），
 * 立即变红——因为那不是样式偏好，而是本 bug 的**成因本身**。
 * 行为面证据（hit-test / 三档宽度）在 **CCC（宁静号仓）** 的
 *   `AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/ui-probe/`
 * （CDP 真机探针：`measure.mjs`（测量唯一真相源）／`probe.mjs`／`verify.mjs`／`mock-probe.mjs` ＋ `artifacts/` 读数），
 * **不在本插件仓** —— 两仓分离（本插件仓只放代码与单测；真机取证链住在 CCC）。
 * ⚠️ 2026-09-25 更正：此行原先只写 `ui-probe/`（**仓内相对路径写法**）⇒ 在本仓找不到，
 * 会被读成"指向一个已删目录"（地图 §3-9 第 9 行当时就是这么判的）。
 * 本单测跑在 node 环境（无 DOM）⇒ 只能守**形态**；行为面必须回上面那条路径取证。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const css = readFileSync(join(clientDir, 'SafeModePanel.css'), 'utf-8')
const tsx = readFileSync(join(clientDir, 'SafeModePanel.tsx'), 'utf-8')

/** 取 `.sp-pop { … }` 基础规则体（注意别匹配到 `.sp-popBody` / `.sp-popVoyage` / `.sp-popVoyage > .sp-popBody`） */
function ruleBody(source: string, selector: string): string {
  const re = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`)
  const m = re.exec(source)
  if (!m) throw new Error(`rule not found: ${selector}`)
  return m[1]
}

describe('自绘 popover 定位形态（防"祖先 overflow 裁切"回归）', () => {
  const pop = ruleBody(css, '.sp-pop')

  it('.sp-pop 用 position: fixed（不受祖先 overflow:hidden 裁切）', () => {
    expect(pop).toMatch(/position:\s*fixed/)
    expect(pop).not.toMatch(/position:\s*absolute/)
  })

  it('.sp-pop 不再用 right 锚定（right:0 是"向左长"、撞上祖先裁剪边界的成因）', () => {
    expect(pop).not.toMatch(/^\s*right:\s*0/m)
  })

  it('宽度仍保留视口兜底（窄视口不溢出）', () => {
    // 🔴 2026-10-18（owner：「可以到 1000px 宽」）：680 → 1000。
    // ⚠️ 这条断言**刻意钉住"形如 min(<数字>px, calc(100vw - 24px))"这个结构**，
    // 而不是钉住 680 这个具体值 —— 宽度是产品旋钮（会再变），
    // 而"必须有视口兜底、否则窄屏溢出"是**不变量**。钉值会让每次调宽都红一次，
    // 且红了之后容易被顺手改成 `expect(true)`（判据退化）。
    expect(pop).toMatch(/width:\s*min\(\s*\d+px\s*,\s*calc\(100vw\s*-\s*24px\)\s*\)/)
    // 正控：当前确实已经是 1000（若有人把它改回小值，上面那条结构断言仍会通过 ⇒ 需要这条）
    expect(pop).toMatch(/width:\s*min\(\s*1000px\s*,/)
  })

  it('坐标由组件计算：useLayoutEffect + getBoundingClientRect + 视口夹取', () => {
    // 三个要素缺一不可——缺 useLayoutEffect 会闪帧；缺 rect 无法跟随锚点；缺夹取会在窄视口溢出
    expect(tsx).toMatch(/useLayoutEffect\(/)
    expect(tsx).toMatch(/getBoundingClientRect\(\)/)
    expect(tsx).toMatch(/window\.innerWidth/)
    expect(tsx).toMatch(/Math\.max\(POP_VIEW_PAD_PX/) // 视口左/上留白夹取
  })

  it('落位前渲染在屏外（避免未定位时闪现在 0,0）', () => {
    expect(tsx).toMatch(/POP_OFFSCREEN/)
    expect(tsx).toMatch(/popPos\s*\?/)
  })
})

/**
 * 🔴 2026-10-18（owner 修正）：「活动轨迹和 skills 使用 tab 来实现，剩下的位置还是给动画」
 *
 * 这条守卫的**对象是布局角色分配**，不是某个 class 名：
 *   · 两个列表必须**互斥显示**（tab），而不是并排 —— 并排会把宽度吃光、动画只剩窄条
 *   · 内容区占**定宽一列**，动画**吃剩余**（flex）—— 顺序反了就等于没给动画让位
 *
 * ⚠️ 为什么用源码形态断言而不是渲染测试：本仓 client 侧**没有 DOM 测试环境**
 *   （无 jsdom / react-dom），这是既有边界；形态断言能抓住"被顺手改回去"，与
 *   `.sp-pop` 那组守卫同一套办法。真实观感留给真机看（D149）。
 */
describe('CCC 状态面板：tab 布局（活跃轨迹 ／ 技能 互斥显示，剩余位置给动画）', () => {
  const tabBody = ruleBody(css, '.sp-tabs')
  const voyage = ruleBody(css, '.sp-voyage')
  const content = ruleBody(css, '.sp-popVoyage > .sp-content')

  it('tsx 用 tab（role=tablist/tab ／ aria-selected）而不是两个并排 panel', () => {
    expect(tsx, 'tab 容器必须存在').toMatch(/sp-tabs/)
    expect(tsx).toMatch(/role="tablist"/)
    expect(tsx).toMatch(/role="tab"/)
    expect(tsx).toMatch(/aria-selected=/)
    // 🔴 负控：旧的并排 panel 形态不得复活
    expect(tsx, '两个并排 panel 的形态已被 owner 修正掉，不得复活').not.toMatch(/sp-panels/)
  })

  it('各 tab 互斥显示（条件渲染，不是都挂着再 CSS 隐藏）', () => {
    // 判据：tab 状态驱动条件渲染 ⇒ 同一时刻只有一个列表在 DOM 里。
    // 若改成"都渲染 + display:none"，所有列表会同时存在于无障碍树里（读屏会念一遍又一遍）。
    expect(tsx).toMatch(/tab === 'trajectories' \?/)
    // 🔴 v1.110.0 订正本行：原写死 `useState<'trajectories' | 'skills'>`，
    //    那是**当时只有两个 tab** 的形态。本轮加了第三个（`subscriptions`，owner 纠正落点后
    //    从设置面板搬来）⇒ 字面类型必然变宽。
    //    本判据的**本意**是"tab 状态驱动渲染"，不是"永远只有两个 tab" ⇒
    //    改为钉住"三个 tab 都在同一个 state 里、且每个都有条件分支"，
    //    这样既不因为加 tab 而假红，也仍然能抓住"退回并排 panel"。
    expect(tsx, 'tab state 必须同时容纳三个 tab').toMatch(
      /useState<'trajectories' \| 'skills' \| 'subscriptions'>/,
    )
    // 每个 tab 都必须有它自己的条件分之（不是只列出按钮、内容却共用一份）
    expect(tsx).toMatch(/tab === 'skills' \?/)
    expect(tsx, '订阅 tab 必须有独立内容分之').toMatch(/<SubscriptionsView/)
  })

  it('内容区定宽一列 ＋ 动画吃剩余（顺序反了就等于没给动画让位）', () => {
    expect(content, '内容区必须是定宽列（flex:none + width）').toMatch(/flex:\s*none/)
    expect(content).toMatch(/width:\s*420px/)
    expect(voyage, '动画必须吃剩余宽度').toMatch(/flex:\s*1 1 auto/)
    // 🔴 负控：上一版的"定宽 240px 装饰条"不得复活 —— 那正是本次被推翻的布局
    expect(voyage).not.toMatch(/width:\s*240px/)
  })

  it('tab 容器自身可滚动但不外溢（列表长时不把卡片顶破）', () => {
    expect(tabBody).toMatch(/overflow:\s*hidden/)
    expect(tabBody).toMatch(/min-height:\s*0/)
  })
})
