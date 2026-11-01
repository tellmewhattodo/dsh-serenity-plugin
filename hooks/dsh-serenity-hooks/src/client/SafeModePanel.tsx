/**
 * dsh-serenity-hooks — 浏览器端（client half）
 *
 * 会话头部 **Serenity 状态胶囊**（v1.24.10 胶囊改版，对齐 OcgoDockEntry pill 风格）：
 *  - 胶囊形态：全圆 999px + padding 4px 9px（无固定高度）+ 半透明 bg-layer-2
 *  - 绿点（恒亮 = Serenity 在线，不随 SAFE 变）+ Serenity vX.Y.Z + 分隔线 + 🛡 SAFE 滑块 + chevron
 *  - SAFE = 盾牌 + 文字：ON 绿（emerald 渐变）/ OFF 灰；滑块 Mac 风格（24×13 轨道 + 11px 灰白 thumb 无图标）
 *  - 点击 → **自绘 popover**（340px 右上角卡片，外点 / Escape 关闭）——替代官方 Modal
 * 面板承载两件事：
 *  - **safe-mode 快捷开关**（2026-10-22 owner：「放到 CCC 面板里吧，方便些」）——
 *    位于 popover 的「运行环境」行首，写通道 = 同源 `POST /serenity/status`（需 WebUI 专属头）
 *  - 状态展示：CCC / 守卫 / 活跃轨迹 / 技能
 * 账号密码等 plugin 配置仍在 DSH 设置面板「Serenity」页（v1.22 归属原则）。
 * 数据经同源 HTTP /serenity/status（插件服务端路由）。
 *
 * 槽：conversation.session.header.actions（官方既有槽，list）
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  // v0.1.7（0.1.7-rc.1）：ui-primitives 图标改名 —— 尺寸后缀（`…14`/`…16`）换成
  // 笔画粗细后缀（`…Regular` 1px / `…Medium` 1.3px），尺寸一律走 `size` prop。
  // 本面板两处都是小尺寸图标 ⇒ 取 Medium（细笔在小号下更易读）。
  IconChevronDownOutlineMedium,
  IconWarningOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import './SafeModePanel.css'

/** 会话头部操作区（list 槽）props */
type SafeModePanelProps = PropsRuntime<'conversation.session.header.actions'>

/** popover 与锚点胶囊之间的间距（= 旧 CSS `top: calc(100% + 8px)` 的 8） */
const POP_GAP_PX = 8
/** popover 与视口边缘的最小留白（夹取用，防卡片贴边或被视口切掉） */
const POP_VIEW_PAD_PX = 8
/** 尚未落位时的屏外坐标（`useLayoutEffect` 在绘制前就会覆写，肉眼看不到） */
const POP_OFFSCREEN = -9999

/** 自绘 popover 的视口坐标（v1.39.1：fixed 定位后由 JS 计算） */
interface PopPlacement {
  left: number
  top: number
}

interface SerenityStatus {
  root: string | null
  accVersion: string
  safeModeOn: boolean
  blacklist: string[]
  threshold: number | null
  /** 活跃轨迹（不含归档）。后端已排除 `_` 前缀目录 ⇒ 这里拿到的**就是**"没有归档的轨迹"。 */
  trajectories?: TrajectorySummary[]
  /** 技能清单（全量扫 `.opencode/skills/` 下每个含 SKILL.md 的目录）。老后端不返回该字段 ⇒ 退化为空清单。 */
  skills?: SkillSummary[]
}

/** 一条活跃轨迹（与后端 `TrajectorySummary` 同形；无生命周期字段 —— 轨迹永存） */
interface TrajectorySummary {
  dirName: string
  sessionId: string
  /** 唯一标识符（未设定 ⇒ null）；面板优先显示它，否则退回编码（owner："不设定就还是用编码"） */
  uid: string | null
  ageDays: number
  hasSessionMd: boolean
}

/** 技能摘要（owner 2026-10-18：skills 单独占一个 panel） */
interface SkillSummary {
  name: string
  /** 已建模 = 存在 skill.ttl。**无 skill.ttl 完全正常**，不是缺陷。 */
  modeled: boolean
}

const API = '/serenity/status'

/**
 * `/serenity/subscriptions` 只读 wire（与 `surface/http.ts` 的 SUBSCRIPTIONS_PATH 对齐）。
 *
 * 🔴 **为什么这个块住在 CCC 面板、而不是 DSH 设置面板**（owner 2026-11-01 纠正，
 *    本文件即纠正的落点）：
 *    设置面板是**跨 CCC 的全局页**，它不知道自己属于哪个 CCC ⇒ 取数只能靠调用方传
 *    `workspace`，而浏览器侧没有任何东西"本来就知道"这个值。实测过这条路走不通：
 *    不带 `workspace` 打该端点 ⇒ `{"root":"","subscriptions":[]}` —— 静默给空表且不报错。
 *    CCC 面板则相反：它**已经在显示某个 CCC**（`status.root`，与轨迹/技能同源）
 *    ⇒ 订阅跟着它走，身份天然正确。
 *    ⇒ 本面板把 `status.root` 作为 `workspace` 传下去（与航行页 iframe 同一套做法）。
 *    ⛔ **别再把它搬回设置面板** —— 那等于把"取数入口选错了层"这件事重做一遍。
 */
interface SubscriptionsWire {
  root: string
  /** 配置的订阅（**意图**：谁盯谁）。原始名（配置里的写法）＋ 展示名（人读的短名）都带。 */
  subscriptions: Array<{
    watcher: string
    members: string[]
    note: string | null
    /** 展示名：`butler · 家庭容器治理管家`（缺省回落到原始名 —— 老后端不返回该字段时不崩） */
    watcherLabel?: string
    memberLabels?: string[]
  }>
  /** 配置坏项（配了但不生效 —— 必须显形） */
  problems: string[]
  /** 投递读数（**实际**：发生了没有；键 = `watcher←member`） */
  deliveries: Array<{ key: string; ok: number; failed: number; lastError: string | null; lastAt: number | null }>
  /** 评估计数（**机制在跑吗** —— 与"送出过吗"是两个问题） */
  eval: {
    statusEvents: number
    runningSeen: number
    idleSeen: number
    turnFinished: number
    skips: Record<string, number>
  }
}

/**
 * 轨迹名 → 展示名（v1.111.0）。
 *
 * 🔴 **为什么需要它**（owner 原话：「功能正常，但太丑陋了 这怎么让人看得懂呢」）：
 *   原始目录名 `2026-10-23--butler--家庭容器治理管家` 在 420px 窄栏里被截断成
 *   `2026-10-23--butler--家庭容器…` —— 用户看到的是一串**日期**，而"谁"被挤没了。
 *   日期前缀是**排序/归档信息，不是身份** ⇒ 展示时让位。
 *
 * 规则与 `surface/http.ts` 的 `trajectoryLabel` **同源**（剥 `YYYY-MM-DD--`，`--` → ` · `）。
 * ⚠️ 这里是**纯字符串**副本，刻意不在 client bundle 里引入 node 侧的 `trajectory/core.ts`；
 *   若展示规则哪天变复杂（要查盘/要本地化）⇒ **必须改为服务端下发**，别让两份规则漂。
 */
function labelOf(name: string): string {
  const m = /^\d{4}-\d{2}-\d{2}--(.*)$/.exec(name)
  if (!m) return name
  return (m[1] as string).replace(/--/g, ' · ')
}

/** 投递键 `watcher←member` → 两端展示名 */
function splitDeliveryKey(key: string): { watcher: string; member: string } {
  const at = key.indexOf('←')
  if (at === -1) return { watcher: labelOf(key), member: '' }
  return { watcher: labelOf(key.slice(0, at)), member: labelOf(key.slice(at + 1)) }
}

const SUBSCRIPTIONS_API = '/serenity/subscriptions'

/**
 * 拉取订阅读数（只读、无副作用）。
 *
 * @param workspace 本面板正在显示的那个 CCC（= `status.root`）。
 *   🔴 **必须传**：服务端在"没有归属信息且多 CCC 共存"时**故意不猜**
 *   （`surface/http.ts` 的 `resolveWorkspaceCore`）⇒ 不传就会拿到 `root:""` ＋ 空表。
 *   ⚠️ 空表**不报错**，所以漏传这件事在界面上看起来像"没配订阅"——这正是要避免的形态。
 */
async function fetchSubscriptions(workspace: string): Promise<SubscriptionsWire> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  const res = await fetch(`${SUBSCRIPTIONS_API}${qs}`, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as SubscriptionsWire
}

/** 盾牌 SVG（v1.24.5 校准：fill=none 纯描边；ON=绿 emerald / OFF=灰 label-secondary 由状态类控制） */
const SHIELD_SVG = (
  <svg viewBox="0 0 16 16" fill="none" width={16} height={16} aria-hidden="true">
    <path
      d="M8 1.5L13.5 3.5V7.2C13.5 10.6 11.2 13.6 8 14.8C4.8 13.6 2.5 10.6 2.5 7.2V3.5L8 1.5Z"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
    />
    <path
      d="M5.8 8L7.3 9.5L10.2 6.6"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** 拼接类名（等价 clsx 最小子集，避免额外依赖） */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 会话头部：Serenity 状态胶囊（点击 → 自绘 popover，纯状态展示） */
export function SafeModePanel(props: SafeModePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SerenityStatus | null>(null)
  // ⚠️ 不再有 `busy` 状态：面板已无写操作（safe-mode 降为状态信息），见下方注释
  const [open, setOpen] = useState(false)
  /** tab 切换（2026-10-18 owner 修正：活跃轨迹 / 技能 用 tab，而不是并排两个 panel）
   *  ⚠️ 前两个 tab 是纯前端显示状态 —— 那两份数据后端一次性都给全，切换**不触发请求**。
   *  🔴 2026-11-01 新增第三个 tab「订阅」：它的数据**不在** `/serenity/status` 里
   *  （投递计数只存在于插件进程内，见 `SubscriptionsWire` 上方说明）⇒ 首次选中时才拉一次。 */
  const [tab, setTab] = useState<'trajectories' | 'skills' | 'subscriptions'>('trajectories')
  /** 切换在途（防重复点击；同时给按钮一个禁用态） */
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // v1.39.1：popover 改 `position:fixed` 后的视口坐标（null = 尚未测量，此时渲染在屏外）
  const [popPos, setPopPos] = useState<PopPlacement | null>(null)

  const sessionId = props.sessionId
  // 活跃轨迹（后端已排除归档区）。🔴 用 `?? []` 而非可选链散落各处：
  // 老后端（未升级）不返回该字段时，面板退化为"暂无活跃轨迹"而不是崩掉。
  const trajectories = status?.trajectories ?? []
  // 技能清单（老后端不返回 ⇒ 空清单，面板退化为"暂无技能"而不是崩）
  const skills = status?.skills ?? []
  // ── 订阅读数（v1.110.0，owner 2026-11-01 纠正落点后从设置面板搬来）──
  // 三个状态刻意分开：`null` = 还没拉过 ≠ 拉到空表（后者是"确认没有"）。
  const [subs, setSubs] = useState<SubscriptionsWire | null>(null)
  const [subsBusy, setSubsBusy] = useState(false)
  const [subsError, setSubsError] = useState<string | null>(null)
  const subsRoot = status?.root ?? null

  const refresh = useCallback(async () => {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    try {
      const r = await fetch(`${API}${qs}`, { headers: { accept: 'application/json' } })
      setStatus((await r.json()) as SerenityStatus)
    } catch {
      setStatus(null)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 拉订阅读数。**只在切到「订阅」tab 时拉**（不是每次开卡片都拉）：
   * 它读的是进程内计数，多拉一次只多一次噪声；而"进面板就要有数"的诉求由 tab 切换满足。
   * 🔴 依赖 `subsRoot`：`status` 首次加载完才有 root，root 变了必须重拉
   * （否则从 CCC 切到另一个 CCC 时会显示上一个 CCC 的订阅表）。
   */
  const loadSubs = useCallback(async (): Promise<void> => {
    if (subsRoot === null) return
    setSubsBusy(true)
    setSubsError(null)
    try {
      setSubs(await fetchSubscriptions(subsRoot))
    } catch (err) {
      // 拉失败**不清空**已有读数：让上一次的数据留着并把错误显形，
      // 比"失败后屏幕变空"更接近事实（同 `.sp-error` 的用法）。
      setSubsError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubsBusy(false)
    }
  }, [subsRoot])

  // 切到订阅 tab 且还没拉过 ⇒ 拉一次。
  // ⚠️ 已拉过就不重复（`subs !== null` 守卫）——用户手动刷新走「刷新读数」按钮。
  useEffect(() => {
    if (open && tab === 'subscriptions' && subs === null && !subsBusy) void loadSubs()
  }, [open, tab, subs, subsBusy, loadSubs])

  /**
   * 切换安全模式（owner 2026-10-22：「放到 CCC 面板里吧，方便些」⇒ 快捷开关放回面板）。
   *
   * 🔴 写通道 = 同源 `POST /serenity/status`，服务端要求 **WebUI 专属头 `x-serenity-ui`**
   *    （`requireWebUi`：agent 工具 / curl 不带该头 ⇒ 403，safe-mode 仍是**用户能力**）。
   * 🔴 成功后**以服务端回包为准**（`{...getStatus(), ...setSafeMode()}` 里带 `safeModeOn`），
   *    不做乐观刷新 —— 标记文件写没写成，只有回包知道（D144：断言入参 ≠ 断言效果）。
   */
  const toggleSafeMode = useCallback(async (on: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ sessionId, on }),
      })
      if (r.ok) {
        setStatus((await r.json()) as SerenityStatus)
      } else {
        // 失败不改本地状态：让面板继续显示**服务端上次告诉我们的**那个值
        await refresh()
      }
    } catch {
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, sessionId, refresh])

  // 自绘 popover：外点 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 自绘 popover 定位（v1.39.1）——`position:fixed` + 视口夹取
  // 为什么不是纯 CSS 定位：卡片锚在会话头右端的胶囊上，而会话中列是 `overflow:hidden`
  //   （真机实测 `pI_x6G_centerCol` / `wSkVaW_root` 左边界 = 280，卡片左边界 274.2）
  //   ⇒ 绝对定位的卡片向左长出去会被祖先**裁掉**（左边框与圆角消失）。
  //   `position:fixed` 的子元素不受祖先 `overflow` 裁切（且已实测本应用无祖先会捕获 fixed）。
  // 为什么是 useLayoutEffect：要在**浏览器绘制前**量到真实尺寸并落位，否则会闪一帧在屏外。
  // 为什么点"外部关闭"不受影响：`rootRef.current.contains()` 走 **DOM 树**，与定位方式无关。
  useLayoutEffect(() => {
    if (!open) {
      setPopPos(null)
      return
    }
    const place = (): void => {
      const anchor = rootRef.current
      const pop = popRef.current
      if (!anchor || !pop) return
      const a = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = pop.offsetWidth
      const h = pop.offsetHeight
      // 右端对齐胶囊右端（等价旧的 `right:0`），再夹取进视口 —— 窄视口时退化为"左留白对齐"
      const left = Math.max(POP_VIEW_PAD_PX, Math.min(a.right - w, vw - w - POP_VIEW_PAD_PX))
      // 卡片从胶囊下方展开；顶边同样夹取（高度另有 CSS `max-height: calc(100vh - 120px)` 兜底）
      const top = Math.max(POP_VIEW_PAD_PX, Math.min(a.bottom + POP_GAP_PX, vh - h - POP_VIEW_PAD_PX))
      setPopPos({ left, top })
    }
    place()
    // 锚点会随窗口尺寸变化 / 侧栏开合 / 内部滚动容器滚动而移动 ⇒ 重算
    // （capture=true：会话区滚动发生在内层滚动容器上，冒泡阶段接不到）
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // 🔴 2026-10-18（owner）：「safe_mode 在这里显示小标志即可，是个状态信息」⇒ 当时把写通道删了。
  // 🔴 2026-10-22（owner）：「safe-mode 放到 CCC 面板里吧，方便些」⇒ **写通道回来**（见上方 toggleSafeMode）。
  // 历史（R↓）：上一版注释写着「开关仍在设置 → Serenity」—— **那句是假的**，SettingsSection 里
  // 从来没有过 safe-mode 开关（2026-10-22 实测 grep 只有一条"面板只展示状态"的注释）。
  // ⇒ 当时那次删除把这个能力**从界面上彻底弄丢了**，而说明面还在指路。
  // 教训与 D179 同族：**说明面说它有、行为说它没有，且零报错**。

  if (!status) {
    return (
      <button type="button" className={cx('sp-card')} disabled>
        <span className={cx('sp-dot', 'sp-dotOff')} />
        <span className={cx('sp-brand')}>Serenity…</span>
      </button>
    )
  }

  const inCcc = status.root !== null

  return (
    <div className={cx('sp-root')} ref={rootRef}>
      {/* 状态胶囊（v1.24.10：999px 全圆 + 绿点恒亮 + SAFE 盾牌滑块 + chevron） */}
      <button
        type="button"
        className={cx(
          'sp-card',
          inCcc ? (status.safeModeOn ? 'sp-cardProtected' : 'sp-cardUnprotected') : 'sp-cardInactive',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          inCcc
            ? `Serenity v${status.accVersion} — ${status.root}（${status.safeModeOn ? 'SAFE ON — 写工具已隐藏' : 'SAFE OFF — 写工具全开，无保护'}）`
            : 'Serenity（未激活）'
        }
      >
        <span className={cx('sp-dot', inCcc ? undefined : 'sp-dotOff')} />
        <span className={cx('sp-brand')}>Serenity</span>
        <span className={cx('sp-ver')}>v{status.accVersion}</span>
        {inCcc && (
          <>
            <span className={cx('sp-sep')} />
            {/* 🔴 2026-10-18（owner）：「safe_mode 在这里显示小标志即可，是个状态信息」
                旧形态 = 盾牌 ＋ SAFE 字样 ＋ **Mac 风格滑块**（可点击切换）。
                现在：滑块去掉（配置面在设置里），只留一个小状态点 ＋ SAFE 字样。
                ⚠️ 保留 `<span>` 而非按钮 ⇒ 它不再可交互（状态信息不该长得像控件）。 */}
            <span
              className={cx('sp-safeBadge', status.safeModeOn ? 'sp-safeBadgeOn' : 'sp-safeBadgeOff')}
              title={
                status.safeModeOn
                  ? 'safe-mode ON — 写工具已隐藏（状态信息；开关在 设置 → Serenity）'
                  : 'safe-mode OFF — 写工具全开（状态信息；开关在 设置 → Serenity）'
              }
            >
              <span className={cx('sp-safeDot')} />
              SAFE {status.safeModeOn ? 'ON' : 'OFF'}
            </span>
          </>
        )}
        <IconChevronDownOutlineMedium size={12} className={cx('sp-chev')} />
      </button>

      {/* 自绘 popover（v1.36.1：加宽为两栏——左=信息 / 右=航行动画；外点/Escape 关闭）
          v1.39.1：`position:fixed` + 坐标由上面的 useLayoutEffect 计算（避免被祖先 overflow 裁切）。
          落位前渲染在屏外（POP_OFFSCREEN）——布局仍在，故 `offsetWidth/Height` 可量。 */}
      {open && (
        <div
          ref={popRef}
          className={cx('sp-pop', 'sp-popVoyage')}
          role="dialog"
          aria-label="CCC 状态栏"
          style={
            popPos ? { left: popPos.left, top: popPos.top } : { left: POP_OFFSCREEN, top: POP_OFFSCREEN }
          }
        >
          <div className={cx('sp-content')}>
            {inCcc ? (
              <>
                {/* ── 运行环境：压成**一行**元信息（owner 2026-10-18：「比较丑，简易一些」）
                    旧形态 = 三行带边框卡片（CCC / 模型 / 守卫），每行一个独立 box ⇒ 视觉噪声大于信息量。
                    现在 = 一行等宽文本，用 · 分隔：它是**背景事实**，不是需要逐项对焦的内容。 */}
                <div className={cx('sp-meta')} title={`CCC: ${status.root ?? ''}`}>
                  {/* 🔴 safe-mode 快捷开关（owner 2026-10-22：「放到 CCC 面板里吧，方便些」）。
                      ⚠️ **必须排在这一行最前面**：`.sp-meta` 是 `nowrap + overflow:hidden`，
                      只有 `sp-metaPath` 会收缩 —— 放在行尾时窄面板下会被裁掉，
                      那就等于"开关又没了"（正是本次要修的症状）。放行首则永在。
                      为什么和上面三项同一行而不新起一块：它同属「本 CCC 的运行态」，
                      而这一行的高度已经付过 —— 加一个 32×16 开关不换行、不涨高度。
                      为什么不必再写"去设置里开"的指路：那里**从来没有**过这个开关
                      （旧注释那句是不实说明，已删）。 */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={status.safeModeOn}
                    aria-label="safe-mode"
                    disabled={busy}
                    className={cx(
                      'sp-quickSwitch',
                      status.safeModeOn ? 'sp-quickSwitchOn' : 'sp-quickSwitchOff',
                      busy ? 'sp-quickSwitchBusy' : undefined,
                    )}
                    title={
                      status.safeModeOn
                        ? 'safe-mode ON —— 写工具已隐藏（点击关闭）'
                        : 'safe-mode OFF —— 写工具全开（点击开启）'
                    }
                    onClick={() => void toggleSafeMode(!status.safeModeOn)}
                  >
                    <span className={cx('sp-quickSwitchThumb')} />
                  </button>
                  <span className={cx('sp-metaSafeWord')}>SAFE {status.safeModeOn ? 'ON' : 'OFF'}</span>
                  <span className={cx('sp-metaSep')}>·</span>
                  <span className={cx('sp-metaPath')}>{status.root}</span>
                  <span className={cx('sp-metaSep')}>·</span>
                  <span>
                    blacklist {status.blacklist.length}
                    {status.threshold !== null ? ` · keeper ${status.threshold}` : ''}
                  </span>
                </div>

                {/* ── 主体：**tab 容器**（owner 2026-10-18 修正：「活动轨迹和 skills 使用 tab 来实现，
                    剩下的位置还是给动画」）
                    🔴 布局契约变更（比"多 panel 并排"更省横向空间）：
                      · 两个列表**不再并排**，改成**一个 tab 组**（同一块面积轮换显示）⇒ 内容区宽度减半、
                        动画栏因此可以从 240px 定宽**恢复为可伸缩**（flex:1）。
                      · 这正是 owner 的意图：让给动画的位置**是 tab 省下来的那份**。
                    ⚠️ tab 只切换"显示哪一个列表"，**不改变任何数据获取**（两份数据一直都在，
                      切换是纯前端状态，零额外请求）。 */}
                <div className={cx('sp-tabs')}>
                  <div className={cx('sp-tabBar')} role="tablist" aria-label="CCC 状态面板">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'trajectories'}
                      className={cx('sp-tab', tab === 'trajectories' && 'sp-tabActive')}
                      onClick={() => setTab('trajectories')}
                    >
                      活跃轨迹
                      <span className={cx('sp-count')}>{trajectories.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'skills'}
                      className={cx('sp-tab', tab === 'skills' && 'sp-tabActive')}
                      onClick={() => setTab('skills')}
                    >
                      技能
                      <span className={cx('sp-count')}>{skills.length}</span>
                    </button>
                    {/* 🔴 订阅 tab 的计数 = 配置了几条**订阅**（不是成员数，也不是投递数）：
                        它和上面两个 tab 的"条目数"同语义，才能并排看。投递读数进 tab 内容。 */}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'subscriptions'}
                      className={cx('sp-tab', tab === 'subscriptions' && 'sp-tabActive')}
                      onClick={() => setTab('subscriptions')}
                    >
                      订阅
                      <span className={cx('sp-count')}>{subs?.subscriptions.length ?? 0}</span>
                    </button>
                  </div>

                  {tab === 'trajectories' ? (
                    trajectories.length === 0 ? (
                      <p className={cx('sp-panelEmpty')}>暂无活跃轨迹</p>
                    ) : (
                      <ul className={cx('sp-list')} role="tabpanel">
                        {trajectories.map((t) => (
                          <li key={t.dirName} className={cx('sp-item')}>
                            {/* UID 优先显示：owner 定它是"用于交流的唯一标识"⇒ 有就顶在最前面；
                                没有则退回编码（"不设定就还是用编码"）。 */}
                            <span className={cx('sp-itemId')} title={t.uid !== null ? 'UID（唯一标识符）' : '编码（未设定 UID）'}>
                              {t.uid ?? (t.sessionId || '—')}
                            </span>
                            <span className={cx('sp-itemName')} title={t.dirName}>{t.dirName}</span>
                            <span className={cx('sp-itemAge')}>{t.ageDays}d</span>
                            {!t.hasSessionMd && (
                              <span className={cx('sp-itemWarn')} title="目录存在但没有 SESSION.md（空壳）">空壳</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )
                  ) : tab === 'skills' ? (
                    skills.length === 0 ? (
                      <p className={cx('sp-panelEmpty')}>暂无技能</p>
                    ) : (
                      <ul className={cx('sp-list')} role="tabpanel">
                        {skills.map((s) => (
                          <li key={s.name} className={cx('sp-item')}>
                            <span className={cx('sp-itemName', 'sp-itemNameFull')} title={s.name}>{s.name}</span>
                            {/* 已建模 = 有 skill.ttl。🟢 它是**信息**不是缺陷：无 skill.ttl 完全正常。 */}
                            {s.modeled && (
                              <span className={cx('sp-itemTag')} title="已建模（存在 skill.ttl）">建模</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )
                  ) : (
                    <SubscriptionsView
                      data={subs}
                      busy={subsBusy}
                      error={subsError}
                      onRefresh={() => void loadSubs()}
                    />
                  )}
                </div>
              </>
            ) : (
              <p className={cx('sp-panelEmpty')}>未激活（工作区不在 CCC 内）</p>
            )}
          </div>
          {/* 右栏：宁静号航行动画（ACC 层资产 /serenity/voyage，S142 §12.44 → v1.36.1 改右栏）。
              · 用 iframe：作品是自包含单文件（830 KB，85% 是 three.js），内联会灌进
                client bundle 并与卡片样式互相污染；iframe 隔离干净、**惰性加载**
                （只在展开时请求一次）、关闭即卸载 ⇒ WebGL 上下文随之释放。
              · ?card=1 → 卡片模式（作品自带的大标题/航速/事实面板/铭牌层全部让位）
              · ?v=版本 → 资产随包变、URL 稳定 ⇒ 用 ACC 版本号打点，升级即失效重取
              🔴 ?workspace=本面板所属 CCC → **词表按这个 CCC 运行时注入**（2026-10-18 缺陷：
                别的 CCC 打开动画看到的仍是构建它的那个 CCC 的技能/工具名）。
                ⚠️ 这一项**必须传**：src 若只带版本号，服务端无从知道"这一帧属于哪个 CCC"，
                而多 CCC 共存时它的兜底第③步**故意不猜**（见 api.ts `resolveWorkspaceCore`）
                ⇒ 不注入 ⇒ 退回资产里写死的词表 ⇒ 缺陷原样复现。两条修法是**互为前提**的。
                取值 = `status.root`（本面板正在显示的那个 CCC，与轨迹/技能同源）。
              · aria-hidden + 无 tabindex：纯装饰，不进无障碍树、不可聚焦
              · DOM 顺序放正文之后 ⇒ 单栏（窄屏）时动画自然落在信息**下方** */}
          <div className={cx('sp-voyage')} aria-hidden="true">
            <iframe
              key={`${status.accVersion}|${status.root ?? ''}`}
              src={`/serenity/voyage?card=1&v=${encodeURIComponent(status.accVersion)}${
                status.root ? `&workspace=${encodeURIComponent(status.root)}` : ''
              }`}
              title=""
              loading="lazy"
              tabIndex={-1}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 「订阅」tab 内容（v1.110.0）。
 *
 * 🔴 **刻意分三段显示，不合并不省略**：
 *  ① **意图**（配置里写了谁盯谁）② **实际**（真的投递过没有）③ **机制**（收到过事件吗）。
 *  三者回答三个不同问题，任一为真都不能推出另一个：
 *   · 有意图、无实际 ⇒ 还没触发过（⛔ 不是"在工作"）
 *   · 有实际、`failed>0` ⇒ 触发了但送不到（这才是要修的）
 *   · `statusEvents=0` ⇒ 要么没人跑轮次，要么订阅没装配 —— **两者在读数上同形**
 *  ⇒ 把三段合成一句话，人就分不出来了（这是本轨迹反复踩的同族形态）。
 *
 * ⚠️ 计数是**进程内**的（宿主重启清零）——UI 上必须写明，
 *    否则 `0` 会被读成"从来没配过"。
 */
function SubscriptionsView(props: {
  data: SubscriptionsWire | null
  busy: boolean
  error: string | null
  onRefresh: () => void
}): React.JSX.Element {
  const { data, busy, error, onRefresh } = props

  return (
    <div className={cx('sp-subs')}>
      <div className={cx('sp-subsBar')}>
        <button type="button" className={cx('sp-subsBtn')} disabled={busy} onClick={onRefresh}>
          {busy ? '读取中…' : '刷新'}
        </button>
        <span className={cx('sp-subsHint')} title="投递计数只存在于宿主进程内存，重启即清零">
          计数重启清零
        </span>
      </div>

      {error !== null && <p className={cx('sp-subsError')}>⚠ {error}</p>}

      {data === null ? (
        <p className={cx('sp-panelEmpty')}>{busy ? '读取中…' : '尚未读取'}</p>
      ) : (
        <div className={cx('sp-subsBody')}>
          {data.problems.length > 0 && (
            <p className={cx('sp-subsError')}>
              ⚠ 配置坏项 {data.problems.length} 条（配了但不生效）：{data.problems.join('；')}
            </p>
          )}

          {/* ── 一、谁盯谁（意图）──
              形态 = **一张卡一件事**：首行 `观察者 → 成员…`，次行 note。
              🔴 为什么不是「一句话把所有成员拼起来」：butler 盯 7 条 ⇒ 那行 130+ 字符，
                 在 420px 栏里必然截断，而**截断处恰好是后半批成员**（看不见 = 不知道它在管谁）。
                 改成卡片后每个成员占一行，读起来是清单，不是一个长句子。 */}
          <div className={cx('sp-subsSectionTitle')}>谁盯谁（配置）</div>
          {data.subscriptions.length === 0 ? (
            <p className={cx('sp-panelEmpty')}>
              未配置 —— 在 .opencode/serenity.json 的 trajectorySubscriptions 里写
            </p>
          ) : (
            data.subscriptions.map((s, i) => {
              const wLabel = s.watcherLabel ?? labelOf(s.watcher)
              return (
                <div key={`${s.watcher}-${i}`} className={cx('sp-subsCard')}>
                  <div className={cx('sp-subsCardHead')} title={`观察者：${s.watcher}`}>
                    <span className={cx('sp-subsWho')}>{wLabel}</span>
                    <span className={cx('sp-subsArrow')}>→</span>
                    <span className={cx('sp-subsCount')}>{s.members.length} 个</span>
                  </div>
                  <ul className={cx('sp-subsMembers')}>
                    {s.members.map((m, j) => (
                      <li key={m} className={cx('sp-subsMember')} title={m}>
                        {s.memberLabels?.[j] ?? labelOf(m)}
                      </li>
                    ))}
                  </ul>
                  {s.note !== null && (
                    <div className={cx('sp-subsNote')} title={s.note}>
                      {s.note}
                    </div>
                  )}
                </div>
              )
            })
          )}

          {/* ── 二、投递（实际）──
              🔴 键 `watcher←member` 也拆开美化：否则这一栏是 `2026-10-23--butler--…←2026-10-22--guard--…`
                 这种**两个长目录名拼在一起**，比上面那行更看不懂。 */}
          <div className={cx('sp-subsSectionTitle')}>投递（实际发生过）</div>
          {data.deliveries.length === 0 ? (
            <p className={cx('sp-panelEmpty')}>
              还没投递过 —— 配了但没出现＝还没触发，不等于在工作
            </p>
          ) : (
            <ul className={cx('sp-subsMembers')}>
              {data.deliveries.map((d) => {
                const { watcher, member } = splitDeliveryKey(d.key)
                return (
                  <li key={d.key} className={cx('sp-subsDelivery')} title={d.lastError ?? d.key}>
                    <span className={cx('sp-subsDlvWho')}>{member || watcher}</span>
                    <span className={cx('sp-subsDlvStat', d.failed > 0 ? 'sp-subsDlvBad' : 'sp-subsDlvOk')}>
                      {d.failed > 0 ? `失败 ${d.failed}` : `成功 ${d.ok}`}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {/* ── 三、机制（在跑吗）──
              这段是**背景读数**，压成两行小字；重要性与上面两张清单不同，所以视觉层级更低。 */}
          <div className={cx('sp-subsSectionTitle')}>机制（在跑吗）</div>
          <p className={cx('sp-subsMeter')}>
            收到状态事件 {data.eval.statusEvents} 次 ｜ 认出在跑 {data.eval.runningSeen} ／ 空闲{' '}
            {data.eval.idleSeen} ｜ 判成一轮结束 {data.eval.turnFinished}
          </p>
          {Object.keys(data.eval.skips).length > 0 && (
            <p className={cx('sp-subsMeter')}>
              跳过：{Object.entries(data.eval.skips).map(([k, v]) => `${k}×${v}`).join('、')}
            </p>
          )}
          {data.eval.statusEvents === 0 && (
            <p className={cx('sp-panelEmpty')}>
              ⚠ 一次状态事件都没收到 —— 此刻没人跑轮次，或订阅未装配；两者读数同形。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
