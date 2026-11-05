/**
 * client/HumorEditor.tsx — 脱口秀片段面板编辑器（D287，2026-11-04 owner 想法）
 *
 * ## owner 原话
 *
 * > 「在 Serenity 的配置页填写好了，这样比较方便」
 * > 「收集 30 段，每次随机注入一段；在提示词中要诚恳：先来看看这段脱口秀片段再继续阅读吧」
 *
 * ## 交互设计（三个刻意的选择）
 *
 * ### ① 一个多行框 + `---` 分隔，⛔ 不是 30 个输入框
 *
 * 30 个独立的 input 会让面板变成一堵墙，而且粘贴 30 段要点 30 次。
 * ⇒ **一个 textarea，`---` 独行分隔**：一次粘贴全部、随时增删、肉眼可见边界。
 *
 * ### ② 实时显示段数
 *
 * 判据：owner 说"收集 30 段"，那**填的时候就要能看见现在有几段** ——
 * 否则填到第 28 段无从确认。这里显示「当前 N 段」，并提示空段会被忽略。
 *
 * ### ③ 原文住用户配置，⛔ 不进仓
 *
 * 本仓是 GitHub 公开仓。段子是有版权的创作文本 ⇒
 * 存在 `~/.dsh/serenity-hooks.json`（仓外），本组件只负责编辑它。
 * ⛔ 不要往仓库里的任何文件贴段子原文。
 */
import { useEffect, useState } from 'react'
import { fetchConfig, saveConfig } from './accounts-api.js'

/** 段分隔符（**独占一行**的 `---`）；选中它是因为它不会出现在正常段子里 */
const SEP = '---'

/** 把 textarea 原文按分隔符拆成段（去空段、trim） */
export function splitBits(raw: string): string[] {
  return raw
    .split(/^---\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 把段数组写回 textarea 形态（与 splitBits 互逆） */
export function joinBits(bits: readonly string[]): string {
  return bits.join(`\n${SEP}\n`)
}

export function HumorEditor(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [raw, setRaw] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const bits = splitBits(raw)

  useEffect(() => {
    let alive = true
    void fetchConfig().then((cfg) => {
      if (!alive || !cfg) return
      setEnabled(cfg.config?.humor?.enabled === true)
      setRaw(joinBits(cfg.config?.humor?.bits ?? []))
      setLoaded(true)
    })
    return () => { alive = false }
  }, [])

  const save = (): void => {
    setBusy(true)
    setError(null)
    setSaved(false)
    void saveConfig({ humor: { enabled, bits } })
      .then((cfg) => {
        if (cfg) {
          setEnabled(cfg.humor?.enabled === true)
          setRaw(joinBits(cfg.humor?.bits ?? []))
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="pe-wrap">
      <div className="pe-row">
        <label className="pe-label" htmlFor="hu-enabled">
          <input
            id="hu-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          启用（缺省关；纯装饰，不影响任何判断）
        </label>
      </div>

      <div className="pe-row">
        <label className="pe-label" htmlFor="hu-bits">
          片段池 —— 用独占一行的 <code>{SEP}</code> 分隔各段；当前 <strong>{bits.length}</strong> 段
        </label>
        <textarea
          id="hu-bits"
          className="pe-textarea"
          rows={14}
          value={raw}
          placeholder={
            `第一段完整文本\n${SEP}\n第二段完整文本\n${SEP}\n第三段……\n\n` +
            '每段会被完整注入，不会截断；空段自动忽略。\n' +
            '每开启一条新会话随机选一段，会话进行中保持不变。'
          }
          onChange={(e) => setRaw(e.target.value)}
        />
      </div>

      <div className="pe-actions">
        <button
          className="pe-btn pe-btnGhost"
          type="button"
          onClick={() => setRaw(joinBits([...bits, '']))}
          disabled={!loaded}
        >
          追加一段
        </button>
        <button className="pe-btn pe-btnGhost" type="button" onClick={() => setRaw('')} disabled={!loaded}>
          清空
        </button>
        <button className="pe-btn pe-btnPrimary" type="button" onClick={save} disabled={busy || !loaded}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {enabled && bits.length === 0 && (
        <p className="pe-hint pe-hintErr">已启用但池是空的 ⇒ 实际不注入任何内容（等于关闭）。</p>
      )}
      {saved && <p className="pe-hint pe-hintOk">已保存，新会话即时生效</p>}
      {error && <p className="pe-hint pe-hintErr">{error}</p>}
    </div>
  )
}
