/**
 * subscriptions-panel-placement.test.ts — 「轨迹订阅」块的**落点判据**（v1.110.0）
 *
 * ## 这条判据守的是什么（owner 2026-11-01 的架构纠正）
 *
 * owner 逐字：「轨迹订阅应该显示在CCC的面板而不是ACC的，**不然你数据怎么拿呢**」。
 *
 * 我第一版把它做在 **DSH 设置面板**（`SettingsSection.tsx`）——那是**跨 CCC 的全局页**，
 * 它不知道自己属于哪个 CCC ⇒ 取数只能靠调用方传 `workspace`，而浏览器侧没有任何东西
 * "本来就知道"这个值。真机实测过：
 *   · 不带 `workspace` 打 `GET /serenity/subscriptions` ⇒ `{"root":"","subscriptions":[]}`
 *   · 带 `?workspace=/…/home-serenity` ⇒ 才拿到真数据
 * 🔴 **这就是本判据存在的理由**：前者**静默给空表且不报错**，
 *    界面上看起来与「确实没配订阅」完全一样 —— 一个不会红的缺陷。
 *
 * ## 判据三条（缺一条就退化）
 *
 * | # | 断言 | 缺了会怎样 |
 * |---|---|---|
 * | ① | 块在 **CCC 面板**（`SafeModePanel.tsx`）里 | 用户够不着（同 `settings-section-panel.test.ts` 那类"全绿但拿不到"） |
 * | ② | 请求**带上本面板的 CCC**（`workspace=`，取值 `status.root`） | 服务端不猜 ⇒ 静默空表 |
 * | ③ | 已从 **设置面板**（`SettingsSection.tsx`）**移除** | 两处各存一份 ⇒ 必然漂（本轨迹已多次踩） |
 *
 * ⚠️ **本件的边界（如实标注）**：client 侧无 DOM 测试环境（无 jsdom/react-dom，
 *    与 `client-popover-clip-guard.test.ts` / `voyage-workspace-wiring.test.ts` 同一套办法）
 *    ⇒ 断言作用在**源码形态**上。它**不证明**那段 JSX 渲染出来好看、
 *    也不证明接口真的返回 200（后者由 `api-status-api.test.ts` 的真 HTTP 往返覆盖）。
 *    ⇒ 它钉的是**落点与接线**这一格 —— 正是 owner 纠正的那一格。
 *
 * 🔴 **判据纪律**：断言前**剥注释**（否则我在注释里写了
 *    「本条已搬到 SafeModePanel」就会把 ③ 弄成假绿 —— 本文件里正好有这么一段注释）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')

/** 剥块注释与行注释（同 `settings-section-panel.test.ts` 的构造法，避免在注释里写出闭合序列） */
function stripComments(code: string): string {
  const lineComment = new RegExp('/' + '/.*$', 'gm')
  const blockComment = new RegExp('/' + '\\*[\\s\\S]*?\\*' + '/', 'g')
  return code.replace(blockComment, '').replace(lineComment, '')
}

const panelRaw = readFileSync(join(clientDir, 'SafeModePanel.tsx'), 'utf8')
const settingsRaw = readFileSync(join(clientDir, 'SettingsSection.tsx'), 'utf8')
const panel = stripComments(panelRaw)
const settings = stripComments(settingsRaw)

describe('「轨迹订阅」块的落点：必须在 CCC 面板，且只能在一处', () => {
  it('① 块在 CCC 面板（SafeModePanel）里 —— 组件与请求都在', () => {
    // 组件本体
    expect(panel, '订阅视图组件不在 CCC 面板里').toContain('SubscriptionsView')
    // 请求出口
    expect(panel, '面板没有订阅取数函数').toContain('/serenity/subscriptions')
  })

  it('🔴 ② 请求带 `workspace=`，且取值来自 `status.root`（不传 ⇒ 服务端不猜 ⇒ 静默空表）', () => {
    // 取数函数必须拼 workspace 参数
    expect(panel, '不传 workspace ⇒ 端点回 {"root":"","subscriptions":[]}（静默空表）').toMatch(
      /workspace=\$\{encodeURIComponent\(workspace\)\}/,
    )
    // 取值必须来自本面板正在显示的那个 CCC（与轨迹/技能同源），不是随便找个路径
    expect(panel, 'workspace 必须取自 status.root —— 否则会显示别的 CCC 的订阅').toContain(
      'const subsRoot = status?.root ?? null',
    )
    expect(panel, '取数必须真的用 subsRoot').toMatch(/fetchSubscriptions\(subsRoot\)/)
  })

  it('🔴 ③ 已从设置面板移除（移 ≠ 复制：两处各存一份必然漂）', () => {
    // 正向：设置面板不得再有该区块的标题行与组件
    expect(settings, '设置面板里仍有「轨迹订阅」折叠块（应在 CCC 面板）').not.toContain('<SubscriptionsBlock')
    expect(settings, '设置面板里仍有 SubscriptionsBlock 定义（应已删除）').not.toContain('function SubscriptionsBlock')
    // 请求出口也不该留在设置面板：它拿不到 CCC 身份，留着就是在鼓励再犯
    expect(settings, '设置面板不应再请求 /serenity/subscriptions').not.toContain('/serenity/subscriptions')
  })

  it('对照（防假绿）：stripComments 真的会剥注释', () => {
    // 防"我靠注释里的字样通过断言"。本文件两块源码里都有含有关键词的注释，
    // 若 stripComments 是 no-op，上面 ③ 就会因为设置面板里那段"已搬走"的说明而假红/假绿。
    const sample = 'const a = 1 // SubscriptionsBlock\n/* /serenity/subscriptions */ const b = 2'
    const out = stripComments(sample)
    expect(out).not.toContain('SubscriptionsBlock')
    expect(out).not.toContain('/serenity/subscriptions')
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
    // 真文件里确实有注释被剥掉（两个文件都在用注释）
    expect(panelRaw.length).toBeGreaterThan(panel.length)
    expect(settingsRaw.length).toBeGreaterThan(settings.length)
  })
})

/**
 * ── v1.111.0：展示名（owner：「功能正常，但太丑陋了 这怎么让人看得懂呢」）──
 *
 * 🔴 这一组守的是**可读性**这个真实缺陷，不是审美偏好。旧形态把原始目录名
 * `2026-10-23--butler--家庭容器治理管家` 直接放进 420px 窄栏 ⇒ 被截断成
 * `2026-10-23--butler--家庭容器…`：用户看到的是一串**日期**，"谁"被挤没了。
 * 更严重的是 note 与成员清单被拼成一个长句 ⇒ **后半批成员根本读不到**（信息丢失）。
 */
describe('订阅展示名：原始目录名不得直接上屏', () => {
  /** 与 `surface/http.ts` 的 `trajectoryLabel` / 客户端 `labelOf` 同一条纯规则 */
  function labelOf(name: string): string {
    const m = /^\d{4}-\d{2}-\d{2}--(.*)$/.exec(name)
    if (!m) return name
    return (m[1] as string).replace(/--/g, ' · ')
  }

  it('目录名 → 短名：日期前缀让位，`--` 变成分隔符', () => {
    expect(labelOf('2026-10-23--butler--家庭容器治理管家')).toBe('butler · 家庭容器治理管家')
    expect(labelOf('2026-10-20--logistics--苏州家庭后勤与智能家居')).toBe('logistics · 苏州家庭后勤与智能家居')
    // issue 型目录（只有 ticket，没有描述段）
    expect(labelOf('2026-10-01--apaas-26116')).toBe('apaas-26116')
  })

  it('🔴 已经是编码 / 形态不认识 ⇒ **原样返回**（⛔ 不猜、不吞）', () => {
    expect(labelOf('butler')).toBe('butler')
    expect(labelOf('S142')).toBe('S142')
    expect(labelOf('some-random-name')).toBe('some-random-name')
  })

  it('🔴 展示名必须**不含** `YYYY-MM-DD--` 前缀（这正是"看不懂"的根因）', () => {
    const dirs = [
      '2026-10-23--butler--家庭容器治理管家',
      '2026-10-22--guard--中断守护',
      '2026-10-24--desk-observer--书桌观察员',
    ]
    for (const d of dirs) {
      const shown = labelOf(d)
      expect(shown, `${d} 的展示名仍带日期前缀`).not.toMatch(/^\d{4}-\d{2}-\d{2}--/)
      expect(shown, '展示名不得残留 `--` 分隔符').not.toContain('--')
    }
  })

  it('🔴 服务端与客户端用**同一条**规则，且面板真的用了它（参数对 ≠ 效果达成）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const httpCode = stripComments(readFileSync(join(here, '..', 'src', 'surface', 'http.ts'), 'utf8'))
    // ① 服务端导出展示名函数，且**复用**既有解析（⛔ 不另写一份剥日期逻辑 —— 会长出第二真相源）
    expect(httpCode, '服务端应有 trajectoryLabel').toContain('export function trajectoryLabel')
    expect(httpCode, '服务端应复用既有解析函数').toContain('parseTrajectoryCode')
    // ② 客户端有同形的纯字符串规则
    expect(panel, '客户端应有展示名规则').toMatch(/\\d\{4\}-\\d\{2\}-\\d\{2\}--/)
    // ③ 面板**实际使用**展示名（定义了却没接上，是本仓反复踩的形态）。
    // 🔴 这一条最初写成 `toContain('watcherLabel')` —— 而**接口声明里就有这个词**，
    //    于是把实现改成 `s.watcher` 它照样绿（变异检验当场抓到，D222 的假绿）。
    //    改为钉**赋值表达式本身**：`??` 回落形式说明"优先用服务端展示名、缺了才本地算"。
    expect(panel, '面板必须真的用 watcherLabel 渲染（钉赋值式，⛔ 不钉字段名）').toMatch(
      /watcherLabel\s*\?\?\s*labelOf\(/,
    )
    expect(panel, '成员也必须用展示名（同样钉赋值式）').toMatch(/memberLabels\?\.\[j\]\s*\?\?\s*labelOf\(/)
    // ④ 负控：旧形态"原始名 盯 原始成员名"这一整句不得复活
    expect(panel, '不得再有「原始 watcher 名 盯 原始成员名」长句').not.toMatch(
      /<strong>\{s\.watcher\}<\/strong>\s*盯/,
    )
  })
})
