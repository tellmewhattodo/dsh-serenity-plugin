/**
 * voyage-theme.ts — 航行动画的**主题接线**（纯函数，v1.126.0，S142 2026-11-09）
 *
 * ## 为什么需要这一层
 * 浅色主题下那幅深色星空作品在白色面板里「很突兀」（owner 2026-11-09 报障）⇒
 * `assets/serenity-voyage.html` 现在支持 `?theme=blueprint`（工程蓝图线稿 + 纸白底）。
 * 但**资产自己不嗅探主题**：它是 iframe 里的独立文档，宿主主题只有父窗口知道。
 * ⇒ 参数必须由客户端（本面板）按宿主的**输出**决定，资产只**消费**参数。
 *
 * ## 🔴 判据源必须是宿主的输出，⛔ 不是输入（D297）
 * 宿主的主题 = 「设置项 ∥ 系统跟随」两路合成，落成 `body[data-ds-dark-theme]` 这个属性
 * （`dsh-client-ui-theme` 的 bootThemeBodyScript：`preference==='dark' || systemDark`）。
 * `prefers-color-scheme` 只是其中**一个输入** ⇒ 拿它在「设置浅色 + 系统深色」这一档会判反。
 * ⇒ 这里读属性，⛔ 不读 media query。**已进机械门禁**
 *    （`tests/voyage-theme-wiring.test.ts` ③ 禁 `prefers-color-scheme` / `matchMedia`）。
 *
 * ## 为什么需要「随主题重建」
 * 主题可能在面板打开期间被切换（用户在设置里改）。iframe 的 `src` 变了浏览器**不一定**重载
 * （同文档导航不算），而且改完后画面会停在旧语汇上 —— 那种「主题切了但动画没变」
 * 在读数上与「参数没传」不可分。⇒ 主题进 `key`（与 `accVersion` 同一套办法）：
 * 切一次主题 = 卸载重建一次 iframe，代价是一次 WebGL 重建（面板关闭本来就卸载）。
 *
 * ⚠️ 本模块刻意**不 import react**：`useHostDarkTheme` 那个 hook 住在 `SafeModePanel.tsx`
 *   （本仓 client 侧无 DOM 测试环境，纯函数留在这里才能被 node 单测直接跑）。
 */

/**
 * 宿主合成后的**真实**主题开关（输出面）。
 * 🔴 与 `client-css-theme-gate.test.ts` 的 `DARK_SELECTOR` 同一个属性名 ——
 *    两处必须一起改（属性名漂移会让两边**同时**静默失效）。
 */
export const HOST_DARK_ATTR = 'data-ds-dark-theme'

/**
 * 该主题下 iframe 要带的附加查询串。
 *
 * - 深色 ⇒ `''`（资产默认档就是深色写实电影质感，⛔ 不传参数以免多一个"显式但无意义"的值）
 * - 浅色 ⇒ `'&theme=blueprint'`（工程蓝图线稿语汇）
 *
 * 🔴 返回**带 `&` 前缀**的片段是刻意的：调用点已经有一个 `?`，这里再返回 `?` 会拼出
 *    `?…?theme=`（那样服务端/资产的正则 `[?&]theme=` 仍能命中，缺陷会**静默生效**）。
 *    判据 = `tests/voyage-theme-wiring.test.ts` ① 逐字断言这两个字面量。
 */
export function themeParamFor(isDark: boolean): string {
  return isDark ? '' : '&theme=blueprint'
}

/**
 * iframe `key` 里的主题分格。
 *
 * 与 `themeParamFor` 分开导出是有意的：**「带对上参」与「换主题时重建」是两件事**，
 * 只做前者会留下"切了主题画面没跟着换"的窗口（那正是本模块要消灭的形态）。
 */
export function themeKeyPart(isDark: boolean): string {
  return isDark ? 'dark' : 'light'
}
