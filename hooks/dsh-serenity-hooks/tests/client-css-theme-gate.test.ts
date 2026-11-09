/**
 * client-css-theme-gate.test.ts — client CSS **主题盲写死色**门禁（S142，2026-11-09）
 *
 * 背景（owner 报障，真机取证）：「这个页面没适配白色主题」——
 *   浅色主题下 CCC 面板整张卡片是一块**深色方块**、字几乎看不见。
 *   定因（CDP 计算样式逐项对读）：文字色**全部走语义 token**（浅色下算出深字 ✔），
 *   而 `.sp-popVoyage` 的 `background: rgba(6,11,14,.9)` **写死、无深色分档** ⇒ 深底 + 深字。
 *
 * 🔴 本缺陷是既有门禁的反面，所以既有门禁抓不到：
 *   - `client-css-tokens.test.ts` 守的是「**自造 token** ⇒ var() 解析不了 ⇒ 浅色黑块」（2026-09-04）；
 *   - 本缺陷恰好相反：token **用对了**，但**有一处没用 token**。
 *   ⇒ 两者是互补的两端，任一缺失都会漏掉一整类。
 *
 * 本测试机械守卫两条：
 *  ① **深色写死色必须分档**：`src/client/*.css` 里任何"深色写死"（深底 hex / 深色 rgba）
 *     必须存在 `body[data-ds-dark-theme]` 的对应规则。否则它会在浅色主题下把卡片压黑。
 *  ② **主题判据必须是宿主的输出，不是输入**：禁用 `@media (prefers-color-scheme: …)`。
 *     宿主的主题 = 「设置项 ∥ 系统跟随」两路合成，`prefers-color-scheme` 只是其中一个输入
 *     （`dsh-client-ui-theme` 的 bootThemeBodyScript：`preference==='dark' || systemDark`）。
 *     拿输入当结果 ⇒ 在「设置浅色 + 系统深色」这类组合上判反。
 *
 * ⚠️ 允许的豁免必须**在这张表里显式登记并写理由**（下方 ALLOWLIST）——
 *    "这个色两种主题下都要"是一个**判断**，判断必须留下痕迹（R↓），
 *    否则下一个人无法区分"忘了改"与"刻意留死"。
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')

/** 宿主合成后的**真实**主题开关（输出面）。所有主题分档只能钉它。 */
const DARK_SELECTOR = 'body[data-ds-dark-theme]'

/**
 * 豁免表：`文件::选择器` ⇒ 理由。
 * 🔴 只登记"两种主题下都**必须**是那个色"的项（品牌色 / 物理约束），⛔ 不登记"懒得改"。
 * ⚠️ 现为空 —— 当前 client CSS 里所有深色背景**都已分档**。
 *    留这张表是为了让"刻意留死"有一条**可执行的登记路径**，而不是被迫把它藏进注释里。
 */
const ALLOWLIST: readonly { file: string; selector: string; reason: string }[] = []

type Hit = { file: string; line: number; selector: string; value: string }

/** 🔴 判据前必须先剥注释：注释里合法地写着"⛔ 不要用 prefers-color-scheme"，
 *  不剥就会把**禁令的说明文字**判成违规（本文件第一版就这么红过一次）。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 把 CSS 粗切成「选择器 → 声明体」块（足够本门禁用：无嵌套 CSS，块以 } 收尾） */
function parseBlocks(css: string): { selector: string; body: string }[] {
  const src = stripComments(css)
  const out: { selector: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const selector = m[1].trim()
    if (!selector || selector.startsWith('@')) continue
    out.push({ selector, body: m[2] })
  }
  return out
}

/** 判断一个颜色字面量是否"深色写死"：深底 hex 或深色 rgba（亮度阈值 + 高不透明度） */
function isDarkLiteral(value: string): boolean {
  const hex = value.match(/#([0-9a-fA-F]{3,8})\b/)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      // 相对亮度（近似）：三个通道加权，≤ 60 视为深色
      return 0.2126 * r + 0.7152 * g + 0.0722 * b <= 60
    }
  }
  const rgba = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/)
  if (rgba) {
    const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    // 半透明深色同样会压暗底色（`rgba(6,11,14,.9)` 正是本缺陷的形态）⇒ alpha > 0.5 即计入
    return lum <= 60 && alpha > 0.5
  }
  return false
}

/**
 * 该选择器是否被某条 dark 分档**覆盖到同一个元素**。
 * 🔴 判据必须按**组合器边界**比，⛔ 不能剥空白后比前缀 —— 第一版就是那样，变异检验当场抓到它恒绿：
 * `.sp-popVoyageZZ` 以 `.sp-popVoyage` 开头 ⇒ 被判"已分档"，于是**删掉真分档、只留一个改名的空壳**，
 * 门禁照样绿（D254 同族：判据没有判别力）。
 *   合法：`t === sel`（同一元素）
 *         `t` 以「空白／>／+／~ ＋ sel」结尾（更具体的 dark 后代选择器，仍落在同一元素上）
 */
function coversSameElement(sel: string, tieredSel: string): boolean {
  if (tieredSel === sel) return true
  const tail = tieredSel.slice(-(sel.length + 1))
  return tail.length === sel.length + 1 && /[\s>+~]/.test(tail[0]!) && tail.slice(1) === sel
}

describe('client CSS 主题门禁（防"写死深色"在浅色主题下压黑面板）', () => {
  const cssFiles = readdirSync(clientDir).filter((f) => f.endsWith('.css'))

  it('① 每个深色写死的块，都必须有 body[data-ds-dark-theme] 分档', () => {
    const hits: Hit[] = []
    for (const file of cssFiles) {
      const css = readFileSync(join(clientDir, file), 'utf-8')
      const blocks = parseBlocks(css)
      // 该文件里所有 dark 分档作用到的选择器：去掉 `body[data-ds-dark-theme]` 前缀，**保留组合器空白**
      const tiered = new Set<string>()
      for (const b of blocks) {
        if (!b.selector.includes(DARK_SELECTOR)) continue
        tiered.add(b.selector.replace(/body\[data-ds-dark-theme\]/g, '').trim())
      }
      for (const b of blocks) {
        if (b.selector.includes(DARK_SELECTOR)) continue // 分档块自身不需要再分档
        // 只看**背景/填充类**声明：`color` 在浅色底上变浅是可读性另一回事（另一类缺陷），
        // 本门禁专抓"把整块底色压黑"这一类（= owner 报的那张截图）。
        for (const d of b.body.split(';')) {
          const [propRaw, ...rest] = d.split(':')
          const prop = (propRaw ?? '').trim()
          if (!/^(background|background-color|fill)$/.test(prop)) continue
          const value = rest.join(':').trim()
          if (!isDarkLiteral(value)) continue
          const sel = b.selector.trim()
          if (ALLOWLIST.some((a) => a.file === file && sel.replace(/\s+/g, '').includes(a.selector.replace(/\s+/g, '')))) continue
          const covered = [...tiered].some((t) => coversSameElement(sel, t))
          if (!covered) hits.push({ file, line: 0, selector: sel, value })
        }
      }
    }
    // 失败信息要能直接指到"改哪个选择器"（D262：报错要能引到"我该改哪里"）
    const report = hits.map((h) => `${h.file} → ${h.selector} { background: ${h.value} } 需补 ${DARK_SELECTOR} 分档`)
    expect(report).toEqual([])
  })

  it('①-control 检测器自身有判别力（正控 / 负控 / 边界对照）', () => {
    // 🔴 这一条是 ① 的**正控**：如果 `isDarkLiteral` 或 `coversSameElement` 退化，
    //    ① 会变成恒绿而**没有任何信号**（本文件第一版正是如此，被变异检验抓到）。
    //    同族判据：D253「恒空的读数器会让『我没藏』与『藏了但读不到』publish 成同一输出」。
    const css = [
      '/* 注释里的 rgba(6,11,14,.9) 不算 */',
      '.a { background: rgba(6, 11, 14, 0.9); }', // 深色写死、无分档 ⇒ 应被抓
      '.b { background: #02050a; }', // 深色 hex、无分档 ⇒ 应被抓
      '.c { background: #e9ecf2; }', // 浅色 ⇒ 不算
      '.d { background: rgba(6, 11, 14, 0.2); }', // 低不透明度 ⇒ 不压黑，不算
      '.e { color: #02050a; }', // 前景色不归本门禁管
      'body[data-ds-dark-theme] .f { background: #02050a; }', // 分档块自身不抓
      '.g { background: #02050a; }',
      'body[data-ds-dark-theme] .g { background: #02050a; }', // 已分档 ⇒ 不抓
      '.h { background: #02050a; }',
      'body[data-ds-dark-theme] .wrapper .h { background: #02050a; }', // 更具体的后代写法，仍落在同一元素
      '.i { background: #02050a; }',
      'body[data-ds-dark-theme] .iZZZ { background: #02050a; }', // 🔴 前缀相似 ≠ 同一元素 ⇒ 仍要抓
    ].join('\n')
    const blocks = parseBlocks(css)
    const tiered = new Set(
      blocks
        .filter((b) => b.selector.includes(DARK_SELECTOR))
        .map((b) => b.selector.replace(/body\[data-ds-dark-theme\]/g, '').trim()),
    )
    const found: string[] = []
    for (const b of blocks) {
      if (b.selector.includes(DARK_SELECTOR)) continue
      for (const d of b.body.split(';')) {
        const [p, ...r] = d.split(':')
        if (!/^(background|background-color|fill)$/.test((p ?? '').trim())) continue
        if (!isDarkLiteral(r.join(':').trim())) continue
        const k = b.selector.trim()
        if (![...tiered].some((t) => coversSameElement(k, t))) found.push(k)
      }
    }
    expect(found.sort()).toEqual(['.a', '.b', '.i'])
  })

  it('② 不使用 prefers-color-scheme 判主题（宿主的输入 ≠ 宿主的输出）', () => {
    const offenders: string[] = []
    for (const file of cssFiles) {
      // 剥注释后再判：注释里写"⛔ 不要用 prefers-color-scheme"是**禁令的说明**，不是违规
      const css = stripComments(readFileSync(join(clientDir, file), 'utf-8'))
      if (/prefers-color-scheme/.test(css)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('③ 分档选择器用的必须是宿主真实属性名（防手误写成 data-dark-theme）', () => {
    // 这只是防拼写漂移：如果宿主某天改了属性名，本条会随 ① 一起失效 —— 所以它必须配上
    // 「至少存在一条正确的 dark 分档」这条正向断言，否则"全都不写分档"也会让本条通过。
    let anyCorrect = false
    for (const file of cssFiles) {
      const css = stripComments(readFileSync(join(clientDir, file), 'utf-8'))
      expect(css).not.toMatch(/data-dark-theme(?!\])/) // 不带前缀的近似拼写
      if (css.includes(DARK_SELECTOR)) anyCorrect = true
    }
    expect(anyCorrect).toBe(true)
  })
})
