/**
 * patches/web-fetch.ts — fake-ip / TUN 网络下的 web_fetch provider（v1.30.12，S142）
 *
 * 问题（用户报告 + 实证）：`web_fetch` 在本机恒失败，报
 *   `URL hostname "X" resolves to a non-public IP address`（`WEB_BLOCKED_URL`）。
 * 根因不是 DSH 误判，而是**本地 DNS 在说谎**：Clash/mihomo 的 fake-ip 让所有域名解析到
 * 198.18.0.0/15（实证 `cdn.jsdelivr.net → 198.18.1.85`），而宿主的
 * `@deepseek-ai/dsh-web-fetch-http` 用 `ipaddr.js` 判定 `range() === "unicast"`，
 * 该段属 reserved → 无条件 throw（其 Config 只有 5 个配额字段，**没有开关**）。
 *
 * 方案（用户拍板 L3）：ACC 自己注册一个 fetch provider——**复用宿主的 HttpFetchProvider**
 * （重定向策略/字节与字符配额/字符集解码/连接固定全部继承），只替换 `resolveAddresses`：
 * 「必须公网单播」→「公网单播 **或** fake-ip 段」。其余私网段（loopback / link-local /
 * RFC1918 / CGNAT / 云元数据 169.254.169.254 / ULA / 组播）**依旧拒绝**。
 *
 * 屏蔽（用户要求「屏蔽掉 dsh 自身注册的」）：宿主内置的 `web-fetch-http` 插件由本包的
 * `cordis.patch.yml`（bundle patch 层）`disabled: true` 关闭——两者都注册 id `http`
 * （`LOCAL_FETCH_PROVIDER_ID`，HttpFetchProvider 的实例字段），同时存在会
 * `WEB_DUPLICATE_PROVIDER`；禁用后由本模块的实例接管同一 id，宿主 `web` 的既有
 * 配置 `fetchProvider: http` 无需改动（**不改宿主的 web 配置对象**，避免覆盖 searchProvider）。
 *
 * 边界：本模块只放宽「地址可达性」一条判据；URL 校验（协议/凭据/长度）、同源重定向、
 * 配额、二进制拒绝全部仍由宿主实现执行。
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Context } from 'cordis'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { hostWeb } from '../host/access.js'

/**
 * 🔴 **0.2.2-rc.1 适配（2026-11-05，S142）**：宿主导出的 `HttpFetchResolver` 类型被**删除**了。
 *
 * 不是改名，是**整层消失**：`0.2.1-rc.2` 的 `provider.d.ts:24` 有
 * `export type HttpFetchResolver = (hostname, signal) => Promise<PublicAddress[]>`，
 * 而 `0.2.2-rc.1` 的同名文件里**没有这个导出**（同时 `network.ts` / `isPublicIpAddress` /
 * `createPinnedLookup` 也一起消失，构造器从 `(limits, resolveAddresses?)` 缩成 `(limits)`）。
 * 上游 README 已明写新立场：「It does not restrict destination addresses」。
 *
 * ⇒ 本模块**在 0.2.2+ 上已无存在理由**（它当年唯一的作用就是放宽那条地址判据）。
 * 但**旧宿主（0.1.7 / 0.2.0 / 0.2.1）仍在支持档里**，而它们真的会拦 fake-ip
 * ⇒ 不能现在删。故此处**自带一份结构等价的契约**，⛔ 不再从宿主 import 那个已消失的类型。
 *
 * ⚠️ 退役条件（写给下一个我）：当 `VERIFIED_HOST_BANDS` 的下界抬到 `0.2.2` 之上时，
 * **本文件连同 `cordis.patch.yml` 的 `disabled: true` 一起整块删除** —— 留着的每一天都是
 * 一份「没人需要、但将来会漂」的代码。
 */
type FetchResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<Array<{ address: string; family: 4 | 6 }>>

/**
 * 与宿主 `WebError` 同形的最小错误（带机器可路由的 `code`）。
 *
 * 为什么不 import 宿主的 WebError：宿主 peer 包在测试环境不可解析（现有测试全部
 * `vi.mock('@deepseek-ai/dsh-tools')` 同因），而 `dsh-tool-web` 只渲染 `error.message`、
 * 不判 `instanceof`——因此本地错误对象足以满足契约，且让本模块零运行时宿主依赖。
 */
function fetchError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

/**
 * 传输与配额上限。
 *
 * 值镜像 `@deepseek-ai/dsh-web-fetch-http` 的 Config 默认值（该包 README 的字段表；
 * 它不导出解析后的默认值，`Config` 是 schemastery schema 而非结果）。`userAgent`
 * 运行时取该包导出的 `DEFAULT_USER_AGENT`（单一真相源，不复制字符串）。
 */
const FETCH_LIMIT_DEFAULTS = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
} as const

/** Clash/mihomo fake-ip 默认段 198.18.0.0/15（可配 fake-ip-range；改配置需同步此常量） */
const FAKE_IP_OCTET_A = 198
const FAKE_IP_OCTET_B_MIN = 18
const FAKE_IP_OCTET_B_MAX = 19

/** 去掉 IPv6 字面量的方括号（`[::1]` → `::1`） */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  const [a, b, c, d] = nums
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return [a, b, c, d]
}

/** 公网单播 IPv4（拒绝全部保留/私网段——与宿主判定口径一致，只额外放行 fake-ip） */
export function isPublicV4(address: string): boolean {
  const parsed = octets(address)
  if (parsed === null) return false
  const [a, b] = parsed
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64/10
  if (a === 169 && b === 254) return false // link-local + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918
  if (a === 192 && b === 168) return false // RFC1918
  if (a === 192 && b === 0) return false // 192.0.0/24（含 NAT64 哨兵）+ 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15（benchmarking：由 fake-ip 判据单独放行）
  if (a === 198 && b === 51) return false // 198.51.100/24
  if (a === 203 && b === 0) return false // 203.0.113/24
  if (a >= 224) return false // 组播 224/4 + 保留 240/4 + 广播
  return true
}

/** fake-ip 段判定（198.18.0.0/15） */
export function isFakeIpV4(address: string): boolean {
  const parsed = octets(address)
  if (parsed === null) return false
  const [a, b] = parsed
  return a === FAKE_IP_OCTET_A && b >= FAKE_IP_OCTET_B_MIN && b <= FAKE_IP_OCTET_B_MAX
}

/**
 * 公网单播 IPv6：只接受全局单播 2000::/3；IPv4-mapped（`::ffff:a.b.c.d`）按内嵌 IPv4 判定。
 * 其余（`::1` / `::` / ULA fc00::/7 / link-local fe80::/10 / 组播 ff00::/8 / v4-translated）一律拒绝。
 */
export function isPublicV6(address: string): boolean {
  const lower = address.toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (mapped?.[1] !== undefined) return isPublicV4(mapped[1])
  const first = lower.split(':')[0] ?? ''
  if (first === '') return false
  const value = Number.parseInt(first, 16)
  if (!Number.isInteger(value)) return false
  return value >= 0x2000 && value <= 0x3fff
}

/** 该地址是否允许被抓取：公网单播 **或** fake-ip 段 */
export function isAllowedFetchAddress(address: string): boolean {
  const bare = stripBrackets(address)
  const family = isIP(bare)
  if (family === 4) return isPublicV4(bare) || isFakeIpV4(bare)
  if (family === 6) return isPublicV6(bare)
  return false
}

/**
 * 解析并校验地址集合（宿主 `HttpFetchResolver` 契约）。
 *
 * 语义与宿主 `resolvePublicAddresses` 一致——**任一地址不合法即整体拒绝**（防 DNS 重绑定），
 * 仅判据从「公网单播」放宽为 `isAllowedFetchAddress`。
 */
export const resolveAllowedAddresses: FetchResolver = async (hostname, signal) => {
  const bare = stripBrackets(hostname)
  const literalFamily = isIP(bare)
  let resolved: Array<{ address: string; family: number }>
  if (literalFamily === 0) {
    resolved = await lookupAll(bare, signal)
  } else {
    resolved = [{ address: bare, family: literalFamily }]
  }
  if (resolved.length === 0) {
    throw fetchError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }
  const addresses: Array<{ address: string; family: 4 | 6 }> = []
  for (const entry of resolved) {
    if (entry.family !== 4 && entry.family !== 6) {
      throw fetchError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (isIP(entry.address) !== entry.family) {
      throw fetchError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (!isAllowedFetchAddress(entry.address)) {
      throw fetchError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    addresses.push({ address: entry.address, family: entry.family })
  }
  return addresses
}

/** `dns.lookup` 的 `all` 形态 + 信号中断（宿主同款语义：OS 查询可能无谓完成） */
async function lookupAll(hostname: string, signal: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  if (signal.aborted) throw fetchError('web fetch aborted', 'WEB_ABORTED')
  const lookupPromise = lookup(hostname, { all: true, order: 'verbatim' })
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(fetchError('web fetch aborted', 'WEB_ABORTED')), { once: true })
  })
  try {
    const entries = await Promise.race([lookupPromise, aborted])
    return entries.map((e) => ({ address: e.address, family: e.family }))
  } finally {
    // 避免未决的 lookup 在 abort 后产生 unhandled rejection
    lookupPromise.catch(() => undefined)
  }
}

/**
 * 注册接管 `http` id 的 fetch provider（宿主内置 provider 由本包 bundle patch 禁用）。
 *
 * 后端包 `@deepseek-ai/dsh-web-fetch-http` 用**动态 import**：宿主版本里若没有该包，
 * 只降级为一条告警（绝不因缺一个可选后端而让整机启动失败——apply 抛错 = dsh 启动失败）。
 * 失败一律响亮但不抛错。
 *
 * 🔴 **双宿主形态兼容（0.2.2-rc.1 适配）**：构造器签名在两档之间变了 ——
 * | 宿主 | 签名 | 我们的 resolver 还起作用吗 |
 * |---|---|---|
 * | `≤0.2.1` | `(limits, resolveAddresses?)` | ✅ 起作用（这是本模块存在的理由） |
 * | `≥0.2.2` | `(limits)` —— 地址判据整层移除 | ❌ 被**忽略**（宿主不再拦任何地址） |
 *
 * ⇒ **不能直接 `new Backend(limits, resolver)`**：对着 0.2.2 的 `.d.ts` 它是
 * `TS2554: Expected 1 arguments, but got 2`（本适配轮实测）。
 * ⇒ 用一次**局部放宽的构造签名**把两种情况都表达出来：多传的参数在 0.2.2 上被 JS 静默忽略，
 * 正是我们想要的（那时它已经不需要了）。⛔ 不写成 `as any` —— 那会让将来真正的签名变化静默通过。
 */
type ProviderCtor = new (
  limits: HttpFetchLimits,
  resolveAddresses?: FetchResolver,
) => { readonly id: string; available(): boolean }

export async function registerWebFetchProvider(ctx: Context): Promise<void> {
  const web = hostWeb(ctx)
  if (typeof web?.registerFetchProvider !== 'function') {
    console.warn('[serenity-hooks] ✗ web fetch provider 未注册：宿主 web 服务不可用（web_fetch 退回宿主默认实现）')
    return
  }
  try {
    const backend = await import('@deepseek-ai/dsh-web-fetch-http')
    const limits: HttpFetchLimits = { ...FETCH_LIMIT_DEFAULTS, userAgent: backend.DEFAULT_USER_AGENT }
    const Provider = backend.HttpFetchProvider as unknown as ProviderCtor
    web.registerFetchProvider(new Provider(limits, resolveAllowedAddresses))
    console.log(`[serenity-hooks] ✓ web fetch provider 已接管（id=${backend.LOCAL_FETCH_PROVIDER_ID}，额外放行 fake-ip 段 198.18.0.0/15）`)
  } catch (error) {
    console.error(`[serenity-hooks] ✗ web fetch provider 注册失败（web_fetch 将不可用）: ${String((error as Error)?.message ?? error)}`)
  }
}
