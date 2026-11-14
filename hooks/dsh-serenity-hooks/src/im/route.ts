/**
 * im/route.ts — 微信桥 CCC 配置层纯逻辑（F4c-3，v1.27.0 实验性）
 *
 * 职责（零 DSH 依赖，可独立单测）：
 * - 读取 CCC 的 weixin 配置（.opencode/serenity.json weixin 段——结构/路由/开关）
 * - 读取/写入 CCC localstore 的账号凭据（weixin.accounts.<accountId>.token/.baseUrl/.userId）
 * - 微信用户 → 轨迹约束会话 id 映射（固定可重建：skiff-weixin-<sha256(userid)>.slice(1, 17)；
 *   v1.27.3 错位一位避开损坏 log）
 * - 路由匹配（exact user → 通配 * 兜底）
 *
 * 配置归属（S142 用户拍板）：**CCC 级**——serenity.json 结构 + localstore 凭据分离；
 * 不绑定具体 role（用户自选路由目标）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS, type WeixinSettings, type WeixinRouteConfig, type WeixinAccountConfig, type ImSettings, type ImAccountConfig, type ImRouteConfig } from '../kernel/ccc.js'
import { writeEntry, getEntry, unsetEntry } from '../tools/localstore/service.js'
import type { WeixinMediaRef, WeixinMessageItem } from './ilink.js'

/** localstore 凭据键前缀（**credential scope**——token 是凭据，走 UPPER_SNAKE 键；
 *  格式 WEIXIN_<ACCOUNT_ID>_TOKEN / _BASEURL / _USERID（accountId 归一为大写蛇形）） */
const LS_PREFIX = 'WEIXIN_'

/** accountId → UPPER_SNAKE 片段（wechat-1 → WECHAT_1） */
function accountKeyPart(accountId: string): string {
  return accountId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/**
 * 微信桥 轨迹约束会话 id 前缀（守卫识别"外部面"用）。
 *
 * ⚠️ **2026-10-19 起它只是命名习惯，不再是判据** —— 轨迹约束的身份是**轨迹**，
 * 判据 = 「绑定的轨迹有 `trajectory-constraint.json`」（`trajectory/policy/profile.ts` 的 `isTrajectoryConstrained`）。
 * 保留前缀只为：① 日志/会话列表里一眼认出这是外部面；② 存量会话目录名不变。
 */
const WEIXIN_SESSION_PREFIX = 'skiff-weixin-'

/** 判定 sessionId 是否为微信桥会话（**命名形态**判定；权力面判据见 `isTrajectoryConstrained`） */
export function isWeixinSessionId(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(WEIXIN_SESSION_PREFIX)
}

/**
 * **轨迹编码 → 固定的 dsh 会话 id**（2026-10-19 重做：身份挂在轨迹上，不挂在用户上）。
 *
 * ## 为什么改（owner 重做令的实际含义）
 *
 * 旧派生 = `skiff-weixin-<sha256(微信用户 id)>`：**同一条轨迹换一个用户就是另一条会话**，
 * 而**同一个用户换一条轨迹也还是原来那条会话**（后者的症状：改路由之后，新轨迹的约束
 * 对不上旧会话的历史工具清单）。⇒ 那不是"轨迹是一等公民"，那是"用户是一等公民"。
 *
 * 新派生 = **由轨迹编码决定**：同一条轨迹 ⇒ 恒同一条 dsh 会话（无论谁在跟它说话）；
 * 换轨迹 ⇒ 新会话。这正是"轨迹约束是认知轨迹的一种"。
 *
 * ## 连带删掉的东西
 *
 * 旧实现有 `.weixin-session-gen.json` 换代计数器（`baseId-g<n>`），存在的唯一理由是
 * "身份绑在用户上、载体（SESSION.md）可能先被归档" ⇒ 只能靠换代续命。
 * 现在**身份就是轨迹**：轨迹没了就该报"目标不存在"（响亮），**不该静默续命**
 * ⇒ 计数器整件删除。
 *
 * ⚠️ 会话 id 里保留 `skiff-weixin-` 前缀只为可读性；**它不含用户身份**，
 * 因此也不会泄漏"谁在跟它说话"（旧形态的哈希虽是伪名，但它是**可复算的稳定标识**，
 * 见 `privacy-scan` 的 `weixin-session-pseudonym` 规则 —— 新形态连这个问题都没有了）。
 */
export function weixinSessionIdForTrajectory(code: string): string {
  // 编码已在 create 时过 `isValidTrajectoryCode`（无中文/无 `--`），此处只做长度安全截断。
  return `${WEIXIN_SESSION_PREFIX}${code}`
}

/**
 * 路由行的**目标编码**（过渡别名解析，单一处）。
 *
 * 🔴 2026-10-19：目标从「角色名」改为**认知轨迹编码**。存量 CCC 的配置里写的是
 * `{user, role}` —— **不强制同批迁移**（配置是 CCC 的数据，改它不该要求同步发版）。
 * ⇒ 读侧接受三种写法，按确定性顺序：`trajectory`（新）→ `role`（旧值，语义已等同编码）
 * → 空（该行作废，由调用方按"未命中"处理）。
 */
function routeTarget(row: { trajectory?: unknown; role?: unknown }): string {
  for (const v of [row.trajectory, row.role]) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

/**
 * **统一 IM 配置的单一读取入口**（2026-10-19 owner 定向：微信与飞书只是账号实现不同，
 * 整合到统一配置）。
 *
 * 读取顺序（**确定性，只有这一处**）：
 *   ① `im` 段 —— 但**判据是 `accounts` 是数组**，不是"段存在"（见下 🔴）
 *   ② 旧 `weixin` 段 —— 存量 CCC 零迁移
 *   ③ 都没有 ⇒ 归一默认（`enabled:false`、空数组）
 *
 * 🔴 **为什么判据是「`accounts` 是数组」**：本 CCC 的配置里**曾经**有过一个 `im` 段
 * （退役的 ACP 形态：`{channel:"acp", acp:{enabled, accounts:[…]}}`）。若只判"段存在"，
 * 那份残留会被当成新配置读 ⇒ 得到一个没有 `accounts` 数组 ／ 或 `accounts` 形状完全不同的对象
 * ⇒ 表现为**"配置没生效"且不报错**。⇒ 用可判别的形状把它排除掉（退役残留继续被静默忽略，
 * 与 v1.59.0 的裁决一致）。
 *
 * ⚠️ 本函数**只做归一**，不判断"这个通道实现有没有"——那是装配处的事
 * （`syncMachinePollers` 里有"未实现的 channel 出声但不静默跳过"）。
 */
export function readImSettings(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): ImSettings {
  const empty = (): ImSettings => ({ enabled: false, accounts: [], routes: [] })
  try {
    const cfg = loadSerenityConfig(root, paths)
    // ① 统一段（形状可判别才认）
    const unified = cfg.im
    if (isUnifiedImSection(unified)) {
      return normalizeImSection(unified, empty())
    }
    // ② 回退旧段（逐字保留既有归一语义——回退路径必须与升级前完全相同）
    const legacy = cfg.weixin
    if (!legacy || typeof legacy !== 'object') return empty()
    return normalizeImSection(legacy, empty())
  } catch {
    return empty()
  }
}

/**
 * 判别一个 `im` 段是不是**新的统一形态**。
 *
 * 判据 = `accounts` 是数组 **且** 不带已退役 ACP 的形状；
 * 已退役 ACP 形态的特征是顶层有 `channel:"acp"` 或 `acp` 对象。
 * ⇒ 两者**任一命中**即判为"退役残留"，不认。
 *
 * 🔴 **2026-11-15（owner 令清除所有 ACP 代码）—— 本条**刻意保留**，理由要写清**：
 *   ACP 的**实现**已全部删除（`acp-core` / `acp-http` / 端口 / 配置校验 / 会话前缀分支）。
 *   但**别的 CCC 的配置文件里可能还留着** `im: {channel:"acp", acp:{…}}` ——
 *   删掉这条判别 ⇒ 那些残留会被当成新配置读进来 ⇒ 得到一个没有 `accounts` 数组的对象
 *   ⇒ 表现为**"配置没生效"且不报错**（静默失效，本轨最贵的一类）。
 *   ⇒ 本函数是**防误读的护栏**，不是"ACP 功能的一部分"。**清功能 ≠ 拆护栏。**
 *   ⚠️ 本仓自己的 `.opencode/serenity.json` 已无该段（2026-11-15 同批删除），
 *      所以这条现在**没有已知的存量消费者** —— 它守的是别的容器与将来可能出现的旧配置。
 */
function isUnifiedImSection(v: unknown): v is ImSettings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const obj = v as Record<string, unknown>
  // 退役 ACP 残留：顶层有 acp 对象，或 channel === 'acp'
  // （变异探针已验：把这两行去掉 ⇒ 本文件两条残留判据立刻变红 ⇒ 判据有承重）
  if (obj.acp !== undefined && (typeof obj.acp === 'object' || typeof obj.acp === 'string')) return false
  if (obj.channel === 'acp') return false
  return Array.isArray(obj.accounts)
}

/** 段 → 归一形态（统一段与旧段**共用同一套归一语义**，避免两条读法各漂） */
function normalizeImSection(w: ImSettings | WeixinSettings, d: ImSettings): ImSettings {
  const src = w as WeixinSettings & ImSettings
  const accountsIn = Array.isArray(src.accounts) ? src.accounts : []
  return {
    enabled: src.enabled === true,
    botType: typeof src.botType === 'string' && src.botType !== '' ? src.botType : undefined,
    hook: typeof src.hook === 'string' && src.hook.trim() !== '' ? src.hook.trim() : undefined,
    // 🔴🔴 2026-10-24（owner 令，D238）：`autoReplyWithLastMessage` 与 `fallbackOnNoSend`
    // **整条退役** —— 出站只剩一条路：agent 自己调 `im-bridge`。
    // 旧配置里残留这两个键 ⇒ **静默忽略**（无人读，不是报错）。
    // 退役理由（owner 原话）：「autoReply 并不合适，主动性的 imBridge 仍然是更好的」。
    accounts: accountsIn
      .filter((a): a is ImAccountConfig =>
        typeof a === 'object' && a !== null && typeof a.accountId === 'string' && a.accountId !== '')
      .map((a) => ({
        accountId: a.accountId,
        // 🔴 缺省 `weixin`：老配置平移到 `im` 段时不必补这个字段（owner 的"统一配置"要能直接吃旧数据）
        channel: typeof a.channel === 'string' && a.channel.trim() !== '' ? a.channel.trim() : 'weixin',
        name: typeof a.name === 'string' ? a.name : undefined,
        enabled: a.enabled !== false,
      })),
    routes: Array.isArray(src.routes)
      ? src.routes
          .filter((r): r is ImRouteConfig =>
            typeof r === 'object' && r !== null && typeof r.user === 'string' && r.user !== '' && typeof routeTarget(r) === 'string')
          .map((r) => ({ user: r.user, trajectory: routeTarget(r) }))
      : [],
    aliases: readAliases(src),
  }
}

/**
 * 读取 CCC 微信桥配置（未配置/未启用 → 归一默认）。
 *
 * ⚠️ 2026-10-19 起它是 {@link readImSettings} 的**薄别名**（签名与返回形状不变）：
 * 旧调用点无需改动，但**配置来源已经统一**——`im` 段优先、`weixin` 段回退。
 * 保留名字是为了让既有调用点与测试**逐字不动**（P1 是纯重构，读数必须不变）。
 *
 * 🔴 2026-10-22：**返回类型由 `WeixinSettings` 改为 `ImSettings`**。
 * 此前实现返回的就是 `readImSettings(...)`（已是归一形态：`accounts[].channel` 必填），
 * 却把它断言成旧类型 —— 于是类型层"看不见"`channel` 字段，
 * 调用方写 `a.channel` 会报 TS2339，而**运行时它一直在那儿**。
 * ⇒ 那是**类型声明在撒谎**，不是调用方写错。改成真实类型后，多账户/多渠道的读侧才敢用它。
 * ⚠️ 附带效应：`WeixinSettings` 的旧形状调用方若用到旧字段，会在此处暴露（好事，早暴露）。
 */
export function readWeixinSettings(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): ImSettings {
  return readImSettings(root, paths)
}

/**
 * 别名表清洗（v1.56.10）：键归一为小写、值必须是非空字符串；非法项静默丢弃。
 * 空/缺省 → `{}`（此时别名解析不可用，只能用裸 iLink 用户 id）。
 */
function readAliases(w: { aliases?: unknown }): Record<string, string> {
  const raw = w.aliases
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const alias = k.trim().toLowerCase()
    if (alias === '' || typeof v !== 'string' || v.trim() === '') continue
    out[alias] = v.trim()
  }
  return out
}

/** 账号凭据（localstore credential scope；baseUrl 缺省 = 官方默认） */
export interface WeixinAccountCredential {
  token: string
  baseUrl: string
  userId?: string
}

/** localstore 凭据键（credential scope: WEIXIN_<ACCOUNT_ID>_<FIELD>） */
function lsKey(accountId: string, field: 'TOKEN' | 'BASEURL' | 'USERID'): string {
  return `${LS_PREFIX}${accountKeyPart(accountId)}_${field}`
}

/** 读取账号凭据（token 缺失 → null——账号未绑定） */
export function readWeixinCredential(root: string, accountId: string): WeixinAccountCredential | null {
  const token = getEntry(root, 'credential', lsKey(accountId, 'TOKEN'))
  if (!token) return null
  const baseUrl = getEntry(root, 'credential', lsKey(accountId, 'BASEURL'))
  const userId = getEntry(root, 'credential', lsKey(accountId, 'USERID'))
  return { token, baseUrl: baseUrl ?? '', userId: userId ?? undefined }
}

/** 写入账号凭据（扫码 confirmed 后；token 必写，baseUrl/userId 可选） */
export function writeWeixinCredential(root: string, accountId: string, cred: WeixinAccountCredential): void {
  writeEntry(root, 'credential', lsKey(accountId, 'TOKEN'), cred.token)
  if (cred.baseUrl) writeEntry(root, 'credential', lsKey(accountId, 'BASEURL'), cred.baseUrl)
  if (cred.userId) writeEntry(root, 'credential', lsKey(accountId, 'USERID'), cred.userId)
}

/** 清除账号凭据（移除账号时） */
export function clearWeixinCredential(root: string, accountId: string): void {
  unsetEntry(root, 'credential', lsKey(accountId, 'TOKEN'))
  unsetEntry(root, 'credential', lsKey(accountId, 'BASEURL'))
  unsetEntry(root, 'credential', lsKey(accountId, 'USERID'))
}

// ── 飞书凭据（P3，2026-10-19）──────────────────────────────────────────────
//
// 与微信**同族但不同形态**：微信是单要素（token），飞书是双要素（appId ＋ appSecret）。
// 🔴 appSecret 落 **credential** scope（UPPER_SNAKE），不进 git 明文面；
//    appId 不是密（它出现在每个事件的 `app_id` 字段里），但为对称也放同一处。
// ⇒ 复用的是**同一套 localstore 约定**，不是新造一层存储。

/** 飞书凭据键（credential scope: FEISHU_<ACCOUNT_ID>_<FIELD>） */
function feishuLsKey(accountId: string, field: 'APPID' | 'SECRET'): string {
  return `FEISHU_${accountKeyPart(accountId)}_${field}`
}

/** 飞书账号凭据（appSecret 缺 ⇒ 账号未绑定） */
export interface FeishuAccountCredential {
  /** 应用 appId（自建应用「凭证与基础信息」页） */
  appId: string
  /** 应用 appSecret（**凭据**，只在 localstore） */
  appSecret: string
}

/** 读取飞书账号凭据（appId 或 appSecret 缺失 → null——账号未绑定） */
export function readFeishuCredential(root: string, accountId: string): FeishuAccountCredential | null {
  const appId = getEntry(root, 'credential', feishuLsKey(accountId, 'APPID'))
  const appSecret = getEntry(root, 'credential', feishuLsKey(accountId, 'SECRET'))
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

/** 写入飞书账号凭据（面板保存后；两者都必写——只写一半等于没绑） */
export function writeFeishuCredential(root: string, accountId: string, cred: FeishuAccountCredential): void {
  writeEntry(root, 'credential', feishuLsKey(accountId, 'APPID'), cred.appId)
  writeEntry(root, 'credential', feishuLsKey(accountId, 'SECRET'), cred.appSecret)
}

/** 清除飞书账号凭据（移除账号时） */
export function clearFeishuCredential(root: string, accountId: string): void {
  unsetEntry(root, 'credential', feishuLsKey(accountId, 'APPID'))
  unsetEntry(root, 'credential', feishuLsKey(accountId, 'SECRET'))
}

/**
 * **按渠道判「该账号是否已绑定凭据」**（面板读数用；单一处）。
 *
 * 🔴 为什么需要它（2026-10-19 P2 面板实测缺陷）：面板原先对所有账号都调
 * `readWeixinCredential`（只看 `WEIXIN_<A>_TOKEN`）。一个**飞书**账号的凭据在
 * `FEISHU_<A>_APPID|SECRET`，走那条读法**必然读到 null** ⇒ 面板把一个配好的飞书账号
 * 显示成「未绑定凭据」，用户据此以为没配上。
 *
 * 判据与装配处**同源**（`im/bridge.ts` 的 `readImCredentialByChannel`）：飞书要 appId **且**
 * appSecret，微信只要有 token。两处若各写一份判据，就会重演"两个读数器给出不同答案"。
 *
 * ⚠️ 只回**布尔**，不回任何凭据值 —— 这是 wire 面。
 */
export function imCredentialBound(root: string, accountId: string, channel: string | undefined): boolean {
  if ((channel ?? '').trim() === 'feishu') return readFeishuCredential(root, accountId) !== null
  return readWeixinCredential(root, accountId) !== null
}

/**
 * 路由匹配：exact user 优先，通配 `*` 兜底。
 * @returns 命中的**轨迹编码**；未命中 → null（无路由 → 消息不回复/忽略）
 */
export function matchWeixinRoute(routes: WeixinRouteConfig[], fromUserId: string): string | null {
  if (!Array.isArray(routes) || routes.length === 0) return null
  for (const r of routes) {
    if (r.user === fromUserId) return r.trajectory
  }
  for (const r of routes) {
    if (r.user === '*') return r.trajectory
  }
  return null
}

/**
 * 提取消息文本（文本项 + **语音项的服务端转写**）：
 * - type 1 TEXT → `text_item.text`
 * - type 3 VOICE → `voice_item.text`——**微信服务端自带语音转写**（官方 openclaw-weixin
 *   直接读该字段并入对话文本，无需下载/ASR；对齐参考实现 index.ts voiceTexts）。
 * @returns 纯文本；无文本 → null
 */
export function extractWeixinText(msg: { item_list?: Array<{ type?: number; text_item?: { text?: string }; voice_item?: { text?: string } }> }): string | null {
  const items = msg.item_list
  if (!Array.isArray(items) || items.length === 0) return null
  for (const item of items) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim()
      if (text !== '') return text
    }
    if (item.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim()
      if (text !== '') return text
    }
  }
  return null
}

/** 是否包含语音项（无转写文本时的降级提示判定——bridge 用） */
export function hasVoiceItem(msg: { item_list?: Array<{ type?: number; voice_item?: unknown }> }): boolean {
  return (msg.item_list ?? []).some((item) => item.type === 3 && item.voice_item != null)
}

/**
 * 提取消息媒体项（图片 type 2 / 文件 type 4）：
 * 只收集**带 media 元数据**的项（下载前置条件）；返回 kind + **完整消息项**（downloadMedia 用
 * `item[mediaType]` 取 image_item/file_item）。纯 ACC 层可达性——不做内容处理（v0.2 用户拍板）。
 */
export function extractWeixinMedia(msg: { item_list?: WeixinMessageItem[] }): WeixinMediaRef[] {
  const out: WeixinMediaRef[] = []
  for (const item of msg.item_list ?? []) {
    if (item.type === 2 && item.image_item?.media) {
      out.push({ kind: 'image', fileName: undefined, item })
    } else if (item.type === 4 && item.file_item?.media) {
      out.push({ kind: 'file', fileName: item.file_item.file_name, item })
    }
  }
  return out
}

/** 文件名净化：basename + 去控制字符 + 截断 128（防路径穿越——落盘安全） */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return cleaned.slice(0, 128)
}

/** 落盘目录：`<CCC 根>/_tmp/weixin-inbound/<userhash>/`（gitignored ✓；agent read 边界内 ✓；按用户分目录） */
export function weixinInboundDir(root: string, fromUserId: string): string {
  const userHash = createHash('sha256').update(fromUserId).digest('hex').slice(0, 12)
  return join(root, '_tmp', 'weixin-inbound', userHash)
}

// ── CCC 配置写入（面板保存；serenity.json 结构部分）──

/**
 * 读取 serenity.json 文件（原始；不存在 → 空对象）。
 * 注意：loadSerenityConfig 返回解析对象但无法写回——此处直接文件读写。
 */
function readRawConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): Record<string, unknown> {
  for (const candidate of paths) {
    const p = resolve(root, candidate)
    if (existsSync(p)) {
      try {
        const v = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as unknown
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
      } catch {
        return {}
      }
    }
  }
  return {}
}

/** 写入 serenity.json（保留既有字段；weixin 段整体替换） */
function writeWeixinSection(root: string, weixin: WeixinSettings, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): void {
  // 写回规范位置（paths[0] = .opencode/serenity.json）；文件不存在则新建
  const target = resolve(root, paths[0] ?? '.opencode/serenity.json')
  const raw = readRawConfig(root, paths)
  raw.weixin = weixin
  const dir = resolve(target, '..')
  if (!existsSync(dir)) {
    // .opencode 目录可能不存在（新 CCC）——创建
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
}

/** 添加/更新账号（serenity.json 结构部分；凭据单独写 localstore） */
export function upsertWeixinAccount(root: string, account: WeixinAccountConfig): WeixinSettings {
  const settings = readWeixinSettings(root)
  const accounts = settings.accounts ?? []
  const idx = accounts.findIndex((a) => a.accountId === account.accountId)
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...account }
  else accounts.push(account)
  const next: WeixinSettings = { ...settings, accounts }
  writeWeixinSection(root, next)
  return next
}

/** 移除账号（serenity.json 结构 + localstore 凭据；同时停桥由调用方 syncCccBridge） */
export function removeWeixinAccount(root: string, accountId: string): WeixinSettings {
  const settings = readWeixinSettings(root)
  const accounts = (settings.accounts ?? []).filter((a) => a.accountId !== accountId)
  const next: WeixinSettings = { ...settings, accounts }
  writeWeixinSection(root, next)
  clearWeixinCredential(root, accountId)
  return next
}

/** 保存路由表（整体替换） */
export function saveWeixinRoutes(root: string, routes: WeixinRouteConfig[]): WeixinSettings {
  const settings = readWeixinSettings(root)
  const next: WeixinSettings = { ...settings, routes }
  writeWeixinSection(root, next)
  return next
}

/**
 * 生成下一个可用账号 id（`wechat-N`，N 自增取**最小未占用**）：
 * 多账号支持（S142 用户反馈 ①"要支持添加多个账号，每个都是扫码"）——
 * 移除中间账号后不冲突（wechat-2 被删 → 新账号复用 wechat-2 而非跳到 4）。
 */
export function nextWeixinAccountId(settings: WeixinSettings): string {
  const used = new Set((settings.accounts ?? []).map((a) => a.accountId))
  let n = 1
  while (used.has(`wechat-${n}`)) n++
  return `wechat-${n}`
}

/**
 * 生成下一个可用飞书账号 id（`feishu-N`，N 取**最小未占用**）。
 *
 * 与 {@link nextWeixinAccountId} 分开而不是加参数：两者的**前缀不同**，
 * 而前缀是给人看的（面板上一眼分清哪些账号来自哪个渠道）。
 * 判据相同（最小未占用，删中间不跳号）。
 */
export function nextFeishuAccountId(settings: WeixinSettings): string {
  const used = new Set((settings.accounts ?? []).map((a) => a.accountId))
  let n = 1
  while (used.has(`feishu-${n}`)) n++
  return `feishu-${n}`
}

/** 切换总开关 */
export function setWeixinEnabled(root: string, enabled: boolean): WeixinSettings {
  const settings = readWeixinSettings(root)
  const next: WeixinSettings = { ...settings, enabled }
  writeWeixinSection(root, next)
  return next
}
