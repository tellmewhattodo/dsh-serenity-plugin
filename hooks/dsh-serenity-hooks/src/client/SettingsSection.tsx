/**
 * SettingsSection.tsx — dsh 原生设置面板的 serenity-hooks 配置页
 *
 * 归属原则（D23）：**plugin 是全局的，CCC 是具体的** —— 账号/开关/阈值/工作区白名单都是
 * plugin 级配置，统一在本页设定；CCC 状态栏面板（SafeModePanel）只展示状态。
 *
 * 页面结构（官方 settings 设计语言：section > title + intro + 分组 + 行卡）：
 *  - 访问：双端口网关（展开 → 监听/账号/白名单/TOTP）
 *  - 上下文：超限重建（展开 → 阈值）
 *  - 外部能力：CRO（展开 → 说明）
 *  - 工具：图 diagram（展开 → 说明）
 *  - 折叠块：彩蛋模式 ／ **IM 桥**（微信 ＋ 飞书，原「微信桥」）／ 会话清理
 * 行卡可展开：点整行 → 行内详设（开关与详设合一）；重型编辑器挂所属开关行下。
 *
 * ⛔ 2026-10-19：原「轨迹约束调试」行已删（3099 调试面整条退役，owner 令）。
 *
 * 数据通道（双层）：
 *  - 简单配置：`ctx.configForms.get('serenity-hooks')` —— 0.1.7 起设置页由「profile 条目
 *    Config」投影成表单，命名空间 = 条目 id；旧 `settingsScope.bind` 通道已随 0.1.7 移除。
 *  - 复杂配置（账号/白名单）：同源 HTTP /serenity/config（accounts-api.ts，服务端 scrypt hash）
 *
 * 降级守卫由 host 侧承担：`configForms.whileServed([ns], …)` 只在宿主 serve 该命名空间时
 * 注册本页（没 serve 就整页不出现）⇒ 本组件没有 `status === 'unavailable'` 分支。
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { useState } from 'react'
import { AccountsEditor } from './AccountsEditor.js'
import { PersonaEditor } from './PersonaEditor.js'
import { HumorEditor } from './HumorEditor.js'
import { ImBridgeEditor } from './ImBridgeEditor.js'
import './SettingsSection.css'

/** serenity-hooks 简单配置 wire 形态（= 插件 Config 的**面板层**扁平键；host 侧同名） */
export interface SerenitySimpleWire {
  gatewayEnabled?: boolean
  // 🔴 v1.49.0：`rebuildEnabled` 已砍掉（超限重建恒开、无总闸；owner 2026-09-26 裁决）
  rebuildThresholdK?: number
  // ⛔ 2026-10-19：`轨迹约束Enabled` / `轨迹约束DebugPort` 面板键已删（轨迹约束调试面 3099 退役）。
  /** CRO（轨迹自编程唤起）总闸（缺省开；只关 CRO 阶段，投递照常） */
  croEnabled?: boolean
  /** diagram 工具总开关：agent 给一段标签式源码，进程内光栅化成 PNG 并贴进对话
   *  （不借浏览器；实验性 demo，缺省关） */
  diagramEnabled?: boolean
  // ⚠️ `acpFaceEnabled` / `acpFacePort` **已删除**（owner 2026-10-19 裁整面移除 ACP）。
}

/** 本 section 的注入面（apply 闭包提供表单源与写回调；组件不含任何订阅机制） */
export interface SettingsSectionInjected {
  /** 表单快照源（渲染器绑成 `useSerenitySettings` 选择器 hook） */
  hooks: { serenitySettings: ConfigForm<SerenitySimpleWire> }
  /** 写一个面板层字段（宿主校验 + 落 profile 文档） */
  set: (field: keyof SerenitySimpleWire, value: unknown) => void
}

type SettingsSectionProps = PropsRuntime<'settings.section'> & InjectFace<SettingsSectionInjected>

/** 开关（官方 settings 语言：label 右置 toggle，--dsw-alias-* token） */
function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  const { checked, disabled, onChange } = props
  return (
    <label className="ss-switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ss-switchTrack" />
    </label>
  )
}

/** 一个配置行卡（官方 rowCard：标题+说明 左列 / 控件右置）
 *  help：可选——desc 下方渲染「?」帮助浮层（三行以上说明；仅不可展开的行用）
 *  expandable：可选——整行点击展开 detail 内联详设（开关与详设合一）。
 *    点击行（标题/desc 区）toggle 展开态；detail 渲染在行内下方（含该功能全部配置项/重型编辑器）。
 *    展开态由标题右侧 ▸/▾ 指示。 */
function RowCard(props: {
  title: string
  desc: string
  /** 右置控件；**可选** —— 有"恒开、无开关"的行（如超限重建） */
  control?: React.ReactNode
  help?: string
  expandable?: boolean
  /** 受控展开态（外部持有 state 时）；缺省内部自管理 */
  open?: boolean
  onToggle?: (open: boolean) => void
  /** 展开后渲染的内联详设——配置说明 + 配置编辑器 */
  detail?: React.ReactNode
}): React.JSX.Element {
  const { title, desc, control, help, expandable, detail } = props
  const isControlled = props.open !== undefined
  const [selfOpen, setSelfOpen] = useState(false)
  const open = isControlled ? !!props.open : selfOpen

  const toggle = (): void => {
    if (!expandable) return
    if (isControlled) props.onToggle?.(!open)
    else setSelfOpen(!open)
  }

  return (
    <div className={`ss-rowCard${expandable ? ' ss-expandable' : ''}${expandable && open ? ' ss-expanded' : ''}`}>
      <div className="ss-rowText" role={expandable ? 'button' : undefined} tabIndex={expandable ? 0 : undefined}
        onClick={toggle}
        onKeyDown={(e) => { if (expandable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}>
        <span className="ss-rowName">
          {title}
          {/* 方向只由 CSS 旋转给出（.ss-expanded 里 rotate 90°）——
              字符本身固定 ▸，否则"▾ ＋ 再转 90°"会转成指右的怪符号 */}
          {expandable && <span className="ss-expandMark" aria-hidden>▸</span>}
        </span>
        {/* desc 最多显示两行（紧凑）；截断时靠 title 给出全文，否则用户看不到后半句 */}
        <span className="ss-rowDesc" title={desc}>{desc}</span>
        {help && !expandable && (
          <span className="ss-help">
            <button type="button" className="ss-helpMark" aria-label={`${title} 帮助`}>?</button>
            <span className="ss-helpTip">{help}</span>
          </span>
        )}
      </div>
      {control !== undefined && <div className="ss-rowControl">{control}</div>}
      {expandable && open && detail !== undefined && (
        <div className="ss-rowDetail">{detail}</div>
      )}
    </div>
  )
}

/** 分组（多级标题：分组标题 + 一组行卡） */
function Group(props: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const { title, children } = props
  return (
    <div className="ss-group">
      <h3 className="ss-groupTitle">{title}</h3>
      <ul className="ss-rows">{children}</ul>
    </div>
  )
}

/** 折叠组（details/summary：默认收起，点开展开——v1.27.5 紧凑化） */
function Collapse(props: {
  title: string
  desc?: string
  open?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { title, desc, open, children } = props
  return (
    <details className="ss-collapse" open={open}>
      <summary className="ss-collapseHead">
        <span className="ss-collapseTitle">{title}</span>
        {desc && <span className="ss-collapseDesc">{desc}</span>}
      </summary>
      <div className="ss-collapseBody">{children}</div>
    </details>
  )
}

/** dsh 原生设置面板：serenity-hooks 配置页（官方 settings 设计语言，多级标题） */
export function SettingsSection(props: SettingsSectionProps): React.JSX.Element {
  const { set, useSerenitySettings } = props
  // 数据只经注入面的选择器 hook 到达（组件内**不做**任何订阅机制：见 client AGENTS 纪律）。
  // 选择器入参显式标注：渲染器的 hook 面在跨包解析时会给不出上下文类型（否则 TS7006）。
  const snapshot = useSerenitySettings((s: ConfigFormSnapshot<SerenitySimpleWire>) => s)
  const value = snapshot.value

  const toggle = (field: keyof SerenitySimpleWire, on: boolean): void => {
    set(field, on)
  }
  const setThreshold = (v: number): void => {
    // 需求①：K 数值（默认 400K；范围 50~4000，纯绝对无窗口比例保护）
    set('rebuildThresholdK', Math.min(4000, Math.max(50, Math.round(v))))
  }

  const gatewayOn = value?.gatewayEnabled ?? false
  // v1.49.0：`rebuildOn` 已随总开关一起砍掉（超限重建恒开，面板不再有该 Toggle）
  const thresholdK = value?.rebuildThresholdK ?? 400
  const croOn = value?.croEnabled ?? true // 缺省开（与 schema 一致）
  const diagramOn = value?.diagramEnabled ?? false // 缺省关（与 schema 一致；D104）

  // 需求②：可展开行受控状态（默认网关/重建/问答页展开——首个详设可见引导用户理解）
  const [openGateway, setOpenGateway] = useState(false)
  const [openRebuild, setOpenRebuild] = useState(false)
  const [openCro, setOpenCro] = useState(false)
  const [openDiagram, setOpenDiagram] = useState(false)

  return (
    <div className="ss-section">
      <h2 className="ss-title">Serenity</h2>
      <p className="ss-intro">
        插件级配置，全局生效，不依赖具体 CCC。点任一行展开设定；改动即时保存。
      </p>

      <Group title="访问">
        <li>
          <RowCard
            title="双端口网关"
            desc="额外监听端口 3081，登录后可从外部访问 Web UI"
            expandable
            open={openGateway}
            onToggle={setOpenGateway}
            control={<Toggle checked={gatewayOn} onChange={(on) => toggle('gatewayEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'在 3081 端口另起一个监听，让外网／局域网经登录页访问本机 Web UI（3080 只监听本机）。\n' +
                  '· 登录：账号密码 ＋ 可选 TOTP 第二因素\n' +
                  '· 白名单：登录后只看到名单内的工作区（留空 = 全部）\n' +
                  '· 改完立即生效，不用重启'}
                </p>
                <AccountsEditor gatewayOn={gatewayOn} />
              </div>
            }
          />
        </li>
      </Group>

      <Group title="上下文">
        <li>
          <RowCard
            title="超限重建"
            desc="上下文接近上限时提示调用 cognitive_trajectory rebuild 清空重建"
            expandable
            open={openRebuild}
            onToggle={setOpenRebuild}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'上下文占用到阈值时，由模型调用 cognitive_trajectory rebuild 原地清空重建。\n' +
                  '· 语义：丢弃当前会话 → 新建 → 注入「继续原 SESSION 的工作」\n' +
                  '· SESSION.md 原位不动，轨迹延续，上下文归零\n' +
                  '· 恒开、无总闸；要调敏感度只改下面的阈值'}
                </p>
                <RowCard
                  title="重建阈值"
                  desc="上下文占用到该值（K token，默认 400）时提示重建"
                  help={'重建触发阈值（K token，默认 400，范围 50~4000）：\n' +
                    '· 上下文 projected tokens ≥ 阈值 × 1000 时提示\n' +
                    '· 绝对数值，与窗口大小无关\n' +
                    '· 调低更早触发，调高更晚触发'}
                  control={
                    <input
                      className="ss-portInput"
                      type="number"
                      min={50}
                      max={4000}
                      step={50}
                      value={thresholdK}
                      title="重建阈值（K token，默认 400）"
                      onChange={(e) => setThreshold(Number(e.target.value))}
                    />
                  }
                />
              </div>
            }
          />
        </li>
      </Group>

      {/* 🔴 v1.63.3：原「无人值守」整组已删除（owner 2026-10-18 裁「砍掉无人值守功能，
          整个砍掉，已经证实没意义了」）。该组只有一行「无人值守代理回复」，机制已整条退役。 */}

      <Group title="外部能力">
        <li>
          <RowCard
            title="CRO（轨迹自编程唤起）"
            desc="让轨迹用自己的一段程序决定何时唤起（全局开关，默认开）"
            expandable
            open={openCro}
            onToggle={setOpenCro}
            control={<Toggle checked={croOn} onChange={(on) => toggle('croEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'轨迹目录下放一个 continuous-re-occurrence.ts，调度器每 5 分钟跑它一次，由这段程序决定要不要唤、何时唤、唤的时候说什么。\n' +
                  '· 程序文件在即启用，不必在此配置；本开关只是总闸\n' +
                  '· 关掉只停 CRO 阶段：定时唤醒（send-later）、即时投递（send-now）与唤醒表投递照常\n' +
                  '· 没有程序文件的轨迹本来就不参与'}
                </p>
              </div>
            }
          />
        </li>
      </Group>

      {/* 工具（D104，2026-09-29 owner 具名令）：图（diagram）—— 实验性 demo，默认关；
          关时工具**根本不注册**（模型看不到它），开时 agent 给源码即出图 */}
      <Group title="工具">
        <li>
          <RowCard
            title="图（diagram）"
            desc="agent 给一段标签式源码，进程内直接画出 PNG 并贴进对话（不借浏览器；默认关）"
            expandable
            open={openDiagram}
            onToggle={setOpenDiagram}
            control={<Toggle checked={diagramOn} onChange={(on) => toggle('diagramEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'agent 给一段标签式源码（<diagram> 根 ＋ <rect>/<arrow>/<text>/<color>/<legend>），由 ACC 在进程内画成图并贴进对话 —— 不启浏览器、不截图。\n' +
                  '· 产物：图进对话记录（可回看、可被后续轮次引用、可转微信）；另落两份文件在 CCC 的 _tmp/diagram/（.svg 可读可改 ／ .png 是进对话的那份）\n' +
                  '· 自带体检：重叠块 ／ 标签溢出 ／ 悬空端点 ／ 线压字，四条只告警不拦图；写错的图元被跳过并逐条报错，其余照画\n' +
                  '· 字体随插件内置（约 3.8 MB），因为光栅化引擎看不见系统字体\n' +
                  '· 默认关；关着时工具根本不注册（模型看不到它，不占上下文）\n' +
                  '· 前提：当前模型路由要声明收图像输入。没声明时图照样画、照样落盘，回执里写明原因并给路径'}
                </p>
              </div>
            }
          />
        </li>
      </Group>
      <Collapse title="彩蛋模式" desc="替换输出风格提示词（默认关闭）">
        <PersonaEditor />
      </Collapse>

      {/* D287 脱口秀片段（2026-11-04 owner 想法）：独立的折叠块，⛔ 不并进"彩蛋模式"——
          彩蛋改的是**输出风格**（会改变行为），而它**纯装饰、不影响任何判断**。
          两类东西放同一个标题下，读者会以为它们是一回事。 */}
      <Collapse title="脱口秀片段" desc="会话开始时随机注入一段到系统提示词（纯装饰，默认关闭）">
        <HumorEditor />
      </Collapse>

      {/* IM 桥（原「微信桥」，2026-10-19 泛化）：CCC 级配置——无顶层 plugin 开关
          （CCC 级 enabled），保留独立折叠块；内部行已用可展开详设。
          🔴 泛化理由：P2 起「微信」与「飞书」是**并列的账号实现**（`account.channel` 分发），
          而面板属于"设定账号"这一层 ⇒ 标题若仍叫微信，第二家 IM 一接上就开始说谎。 */}
      <Collapse title="IM 桥" desc="绑定即时通讯账号 · 路由到认知轨迹（CCC 级配置）">
        <ImBridgeEditor />
      </Collapse>

      {/* 旧会话清理（v1.29 需求③）：DSH 平台会话（对话历史）手动清理——lastActive 基准 + 物理删 */}
      <Collapse title="会话清理" desc="删除 N 天前无活动的 DSH 会话（手动，不可恢复）">
        <SessionCleanupBlock />
      </Collapse>

      {/* 🔴 「轨迹订阅」块**已于 v1.110.0 搬走**（owner 2026-11-01：
          「轨迹订阅应该显示在CCC的面板而不是ACC的，不然你数据怎么拿呢」）。
          新落点 = `SafeModePanel.tsx` 的「订阅」tab —— 那是**每个 CCC 自己的面板**，
          天然知道自己在显示哪个 CCC（`status.root`），不需要外部传 workspace。
          ⛔ **不要把它搬回这里**：本页是**跨 CCC 的全局设置页**，它拿不到实例身份；
          实测过不传 workspace 时该端点回 `{"root":"","subscriptions":[]}` ——
          **静默空表且不报错**，看起来就像"没配订阅"。
          🔒 落点由测试 `tests/subscriptions-panel-placement.test.ts` 钉住（三条判据）。 */}
    </div>
  )
}

/** /serenity/session-cleanup 清理预览 wire（与 api.ts 对齐） */
interface CleanupPreview {
  root: string
  olderThanDays: number
  count: number
  candidates: Array<{ id: string; project: string; lastActive: string }>
}

/** 清理执行结果 wire */
interface CleanupDone {
  deleted: string[]
  errors: Array<{ id: string; reason: string }>
}

/** 「会话清理」块（v1.29 需求③，S142 用户拍板：lastActive + 手动按钮 + 直接物理删）：
 *  天数输入 → GET 预览（dryRun 列表）→ 确认 → POST 执行。live 会话由服务端保护跳过。 */
function SessionCleanupBlock(): React.JSX.Element {
  const [days, setDays] = useState(30)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [done, setDone] = useState<CleanupDone | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const previewNow = async (): Promise<void> => {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(`/serenity/session-cleanup?olderThanDays=${days}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setPreview((await res.json()) as CleanupPreview)
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!confirming) { setConfirming(true); return } // 第一击 → 确认态
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/serenity/session-cleanup?olderThanDays=${days}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'x-serenity-ui': '1' },
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setDone((await res.json()) as CleanupDone)
      setPreview(null)
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ss-detailStack">
      <RowCard
        title="删除前无活动天数"
        desc="删除最后活动早于该天数的 DSH 会话（默认 30）"
        help={'删除「最后活动早于 N 天前」的 DSH 会话（对话历史）。\n' +
          '· lastActive = 会话日志文件最后写入时间（日志只追加，mtime 可靠）\n' +
          '· 正在运行的会话不会被删（服务端强制跳过）\n' +
          '· 物理删除不可恢复 —— 先「预览」核列表再执行'}
        control={
          <input
            className="ss-portInput"
            type="number"
            min={1}
            max={3650}
            step={1}
            value={days}
            title="删除前无活动天数（默认 30）"
            onChange={(e) => { setDays(Math.min(3650, Math.max(1, Math.round(Number(e.target.value) || 30)))); setPreview(null); setDone(null); setConfirming(false) }}
          />
        }
      />
      {error && <p className="ss-error">{error}</p>}
      {preview && (
        <div className="ss-detailIntro">
          {preview.count === 0
            ? `无早于 ${preview.olderThanDays} 天前无活动的会话可清理（root: ${preview.root}）`
            : `将删除 ${preview.count} 个会话（root: ${preview.root}）：\n` + preview.candidates.map((c) => `  · ${c.id}（${c.project}，最后活动 ${new Date(c.lastActive).toLocaleDateString()}）`).join('\n')}
        </div>
      )}
      {done && (
        <div className="ss-detailIntro">
          {`已删除 ${done.deleted.length} 个会话${done.errors.length > 0 ? `；${done.errors.length} 个失败（${done.errors.map((e) => `${e.id}: ${e.reason}`).join('; ')}）` : ''}`}
        </div>
      )}
      <div className="ss-switchRow">
        <button type="button" className="ss-wakeBtn" disabled={busy} onClick={() => void previewNow()}>
          {busy ? '处理中…' : preview ? '刷新预览' : '预览将删会话'}
        </button>
        {preview && preview.count > 0 && (
          <button type="button" className="ss-removeBtn" disabled={busy} onClick={() => void execute()}>
            {confirming ? '确认物理删除（不可恢复）' : '执行删除'}
          </button>
        )}
        {done && <button type="button" className="ss-wakeBtn" onClick={() => { setPreview(null); setDone(null) }}>完成</button>}
      </div>
    </div>
  )
}
