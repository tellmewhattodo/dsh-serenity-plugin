/**
 * browser/domain.ts —— 域名归一化（**唯一实现**）
 *
 * 设计稿：`AGENT_SESSIONS/…S142…/proposals/browser-domain-skill-design.md` §4.1 / §5.1
 *
 * 🔴 **为什么归一化只许写一次**：槽位动作（open/goto）、访问台账、SKILL 注入三处都要用它。
 *    各写一份 ⇒ 三者会分叉，而分叉的表现是"目录名对不上" —— 那**没有报错**，
 *    只会让说明书**静默失效**（打开 a.com 却读不到 `www.a.com` 目录里的经验）。
 *    本仓为"两套判据必然分叉"付过多次代价 ⇒ 这里只出一个函数。
 *
 * 🔴 **纯函数、零依赖、不抛错**：一个坏 URL 不该炸掉 `open` 动作。
 *    解析不了就返回 `null`，调用方按"没有域名"处理（⛔ 不是"报错"）。
 */

export interface DomainRef {
  /** 归一化主机名（小写、剥 `www.`、保留端口）—— 用于台账键与展示 */
  host: string
  /** 目录名（在 `host` 基础上把非法文件名字符换成 `_`）—— 用于 `<CCC>/BROWSER/<目录名>/` */
  dirName: string
}

/**
 * 文件系统目录名里不能出现的字符 → `_`。
 *
 * 实测唯一会出现的非法字符是冒号（`a.com:8080`），但 Windows 上还有 `< > : " | ? *`
 * 与反斜杠。全域替换（而不是只处理冒号）是因为**同一个 CCC 可能被不同平台打开**。
 */
const ILLEGAL_DIR_CHARS = /[<>:"|?*\\/]/g

/**
 * 归一化一个 URL 到"站点身份"。
 *
 * @param url 任何字符串；非 http(s) 或无法解析 ⇒ `null`
 */
export function normalizeDomain(url: string): DomainRef | null {
  if (typeof url !== 'string' || !url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // ⛔ 只认 http(s)：`file:` / `data:` / `chrome:` 没有"站点经验"这回事，
  //    把它们当域名会在 BROWSER/ 下造出 `file_`、`data_` 这种无意义目录。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  let host = parsed.hostname.toLowerCase()
  if (!host) return null

  // 剥 `www.`（设计 §4.1）：绝大多数站两者内容等价，分成两个目录会让同一份经验被写两次。
  // ⚠️ 只剥**一个** `www.` 前缀，且只在后面还有内容时剥（`www.` 单独不成站）。
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4)

  // 保留端口：`:8080` 与默认端口是**不同的站**（设计 §4.1 明写）。
  // `URL.hostname` 本身不含端口，故从 `port` 补回；空串表示默认端口 ⇒ 不补。
  if (parsed.port) host = `${host}:${parsed.port}`

  return { host, dirName: host.replace(ILLEGAL_DIR_CHARS, '_') }
}

/** 只要目录名时的手感包装（`null` 原样返回）。 */
export function domainDirName(url: string): string | null {
  return normalizeDomain(url)?.dirName ?? null
}
