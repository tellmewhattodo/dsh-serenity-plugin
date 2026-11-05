/**
 * kernel/config.ts — plugin 全局配置读写（结构化，`~/.dsh/serenity-hooks.json`）
 *
 * 归属原则（S142 用户拍板，v1.22）：**plugin 是全局的，CCC 是具体的**——
 * 账号密码/gateway 监听配置是 plugin 级能力，归 plugin 全局文件；
 * CCC 的 localstore.json 只管 CCC 自己的凭据/配置。v1.21.x 曾把
 * `serenityAdvanced` 存进 CCC localstore（归属错误 + 与 DSH settings 开关割裂），
 * 本版本迁移到 plugin 全局文件（migrateLegacyLocalstore 一次性迁移）。
 *
 * 文件：$DSH_HOME/serenity-hooks.json（缺省 ~/.dsh/serenity-hooks.json；
 * env SERENITY_HOOKS_CONFIG 可覆盖——测试/部署注入）。
 * 权限：0600（含账号密码 hash，敏感）。
 *
 * 安全：密码仅存 scrypt hash（node:crypto 内置，零依赖）；wire 层永不返回 hash
 * （GET 只回 user/id，设置面板"密码"字段提交空串 = 不修改）。
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { base32Decode } from '../gateway/totp.js'
// C4 块 B：端口默认值只从集中端口表取（不再散写）
import { FACE_PORTS, GATEWAY_PORT, WEIXIN_SEND_PORT } from './ports.js'

// ── 配置模型 ──

/** 高级设定节名（localstore.json 顶层） */
export const ADVANCED_SECTION = 'serenityAdvanced'

/** 一个外部访问账号（密码只存 hash，永不落 wire） */
interface GatewayAccount {
  /** 稳定键（UI CRUD 定位） */
  id: string
  /** 登录用户名 */
  user: string
  /** scrypt hash（salt:hex） */
  passHash: string
  /** TOTP 第二因素 secret（v1.22.4；可选；base32 无填充。缺省/空 = 该账号仅密码登录） */
  totpSecret?: string
}

/** F1 双端口网关配置 */
interface GatewaySettings {
  enabled: boolean
  host: string
  port: number
  accounts: GatewayAccount[]
  /** 外部可访问的工作区路径前缀白名单（v1.22；空数组 = 全部允许） */
  workspaces: string[]
  /** Cookie Secure 属性（v1.22.4；反代 TLS 时开启，明文 HTTP 下必须关） */
  cookieSecure: boolean
  /** 是否允许外部（gateway）新建工作区（v1.22.4；false = workspace.create 一律 403） */
  allowWorkspaceCreate: boolean
  /** 是否启用 Authenticator 第二因素（v1.22.4；false = TOTP 完全禁用——登录不要求、绑定入口隐藏） */
  totpEnabled: boolean
}

/** 彩蛋功能：persona 模式（v1.23.1，S142 用户需求）
 * 配置后替换 ACC 系统提示词中"输出约束/指令遵循约束"部分（EAP 块 + MSM 原则段）；
 * 未配置（mode 空）→ 完全默认行为，零影响。 */
interface PersonaSettings {
  /** 彩蛋模式名（显示用；空 = 彩蛋关闭） */
  mode: string
  /** 用户替换文本（替代 EAP 块 + MSM 原则段的原文） */
  overrideText: string
}

/**
 * 脱口秀片段（2026-11-04 owner 想法）：
 * 「收集一版各类脱口秀的片段内容，随机在会话开始 / rebuild 时注入一段到系统提示词，
 *   这个不会改变什么行为，但是会让过程变得有趣」＋「要有个开关」。
 *
 * 🔴 **原文住在用户配置里，⛔ 不进仓**：本仓是 GitHub 公开仓，段子是有版权的创作文本。
 *   机制在 ACC（怎么选、怎么注入），措辞在用户配置（填什么）—— 与 D23 同款分工。
 */
interface HumorSettings {
  /** 总开关（缺省 **关**：纯装饰不该是默认状态） */
  enabled: boolean
  /**
   * 片段池（每项 = 一段完整文本）。
   * ⚠️ 面板里用 `---` 分隔多段；这里存拆好的数组。
   */
  bits: string[]
}

/**
 * 工作语域（2026-11-05 owner 令）：压"开场/声明/重复要许可"的摩擦。
 * 参考 dsh-purge 的提示词（Apache-2.0），但**只抄减摩擦那半边，⛔ 不抄取消判断那半边**
 * —— 逐条边界见 `seams/work-register.ts` 的文件头。
 */
interface WorkRegisterSettings {
  /** 总开关（缺省 **开**：这是效率项，不是装饰；owner 令的直接目的就是"避免低效"） */
  enabled: boolean
}

/** F4d 建议问答页（v1.26.1）**已于 2026-10-15 整面退役**（owner 裁「砍掉外部问答」）
 * ⇒ 原 `PublicAskSettings`（key ＋ 容器白名单）连同 `AdvancedSettings.publicAsk` 一并删除。
 * 旧配置文件残留 `publicAsk` 节 ⇒ **静默忽略**（`mergeWithDefaults` 不再读它，幂等安全）。 */

/**
 * 高级设定全量（~/.dsh/serenity-hooks.json 持久化形态；passHash 含 hash）。
 * review P2-3：**rebuild 已从高级配置删除**——rebuild 开关/阈值归"简单配置"
 * （settings.yaml 原生面板，见 surface/settings.ts），运行时只读 readSimpleSettings()；
 * 旧高级 rebuild 字段是死双胞胎（/serenity/config PUT 回显但运行时从不读它）——
 * 删除防误导（用户在高级面板改了却无效）。历史残留字段被 mergeWithDefaults 忽略（幂等安全）。
 */
interface AdvancedSettings {
  gateway: GatewaySettings
  persona: PersonaSettings
  /** 脱口秀片段注入（2026-11-04）：纯装饰，缺省关 */
  humor: HumorSettings
  /** 工作语域（2026-11-05）：压开场/声明摩擦，缺省开 */
  workRegister: WorkRegisterSettings
  /** 主动发送入口（v1.30.9）：**只绑 127.0.0.1** 的独立监听器——CCC 的 MSM 用它发消息给指定用户 */
  weixinApi: WeixinApiSettings
}

/**
 * 主动发送入口配置（v1.30.9，S142 用户需求"微信桥支持被调用发消息"）。
 * 只监听 loopback（公网网关 3081 不可达），故不做密钥；`enabled:false` 或 `port:0` 关闭。
 */
interface WeixinApiSettings {
  enabled: boolean
  port: number
}

/** 默认值（工厂——每次返回新对象，防止调用方意外共享引用） */
export function defaultAdvancedSettings(): AdvancedSettings {
  return {
    gateway: {
      enabled: false,
      host: FACE_PORTS.gateway.host ?? '0.0.0.0',
      port: GATEWAY_PORT,
      accounts: [],
      workspaces: [],
      cookieSecure: false,
      allowWorkspaceCreate: true,
      totpEnabled: false,
    },
    persona: {
      mode: '',
      overrideText: '',
    },
    // 🔴 缺省 **关**：纯装饰不该是默认状态（owner 要开关，这里是它的默认值）
    humor: {
      enabled: false,
      bits: [],
    },
    // 🔴 缺省 **开**：owner 令的目的就是"避免工作中的低效"，缺省关就等于没做
    workRegister: {
      enabled: true,
    },
    weixinApi: {
      enabled: true,
      port: WEIXIN_SEND_PORT,
    },
  }
}

// ── 密码 hash（scrypt，node:crypto 内置）──

const SCRYPT_KEYLEN = 32

/** 生成 scrypt hash（格式 `salt:hex`）；salt 16 字节随机 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/** 校验密码与存储 hash（timing-safe） */
export function verifyPassword(password: string, stored: string): boolean {
  const idx = stored.indexOf(':')
  if (idx <= 0) return false
  const salt = Buffer.from(stored.slice(0, idx), 'hex')
  const expected = Buffer.from(stored.slice(idx + 1), 'hex')
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN)
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}

// ── 读写（plugin 全局文件 ~/.dsh/serenity-hooks.json）──

/** 全局配置文件路径：env SERENITY_HOOKS_CONFIG 覆盖（测试注入）→ $DSH_HOME → ~/.dsh */
export function globalConfigPath(): string {
  const override = process.env.SERENITY_HOOKS_CONFIG
  if (override && override !== '') return override
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return join(dshHome, 'serenity-hooks.json')
}

type StoreShape = Record<string, unknown>

function readFileSafe(p: string): StoreShape {
  if (!existsSync(p)) return {}
  try {
    const v = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as StoreShape
    return {}
  } catch {
    return {}
  }
}

function writeFileSafe(p: string, data: StoreShape): void {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  // 全局文件含账号密码 hash——0600（仅属主可读）
  try { chmodSync(p, 0o600) } catch { /* 权限设置失败不阻断（如只读挂载） */ }
}

/** 深合并默认值（缺省字段补齐；accounts 数组整体替换） */
function mergeWithDefaults(raw: unknown): AdvancedSettings {
  const def = defaultAdvancedSettings()
  if (raw === null || typeof raw !== 'object') return def
  const o = raw as Partial<AdvancedSettings>
  const gateway = (o.gateway ?? {}) as Partial<GatewaySettings>
  const persona = (o.persona ?? {}) as Partial<PersonaSettings>
  const humor = (o.humor ?? {}) as Partial<HumorSettings>
  const workRegister = (o.workRegister ?? {}) as Partial<WorkRegisterSettings>
  const weixinApi = (o.weixinApi ?? {}) as Partial<WeixinApiSettings>
  return {
    gateway: {
      enabled: typeof gateway.enabled === 'boolean' ? gateway.enabled : def.gateway.enabled,
      host: typeof gateway.host === 'string' && gateway.host !== '' ? gateway.host : def.gateway.host,
      port: typeof gateway.port === 'number' && Number.isInteger(gateway.port) ? gateway.port : def.gateway.port,
      accounts: Array.isArray(gateway.accounts)
        ? gateway.accounts.filter((a): a is GatewayAccount =>
            typeof a === 'object' && a !== null
            && typeof (a as GatewayAccount).id === 'string'
            && typeof (a as GatewayAccount).user === 'string'
            && typeof (a as GatewayAccount).passHash === 'string')
        : def.gateway.accounts,
      workspaces: Array.isArray(gateway.workspaces)
        ? gateway.workspaces.filter((w): w is string => typeof w === 'string' && w !== '')
        : def.gateway.workspaces,
      cookieSecure: typeof gateway.cookieSecure === 'boolean'
        ? gateway.cookieSecure
        : def.gateway.cookieSecure,
      allowWorkspaceCreate: typeof gateway.allowWorkspaceCreate === 'boolean'
        ? gateway.allowWorkspaceCreate
        : def.gateway.allowWorkspaceCreate,
      totpEnabled: typeof gateway.totpEnabled === 'boolean'
        ? gateway.totpEnabled
        : def.gateway.totpEnabled,
    },
    persona: {
      mode: typeof persona.mode === 'string' ? persona.mode : def.persona.mode,
      overrideText: typeof persona.overrideText === 'string' ? persona.overrideText : def.persona.overrideText,
    },
    humor: {
      enabled: typeof humor.enabled === 'boolean' ? humor.enabled : def.humor.enabled,
      // 🔴 过滤空串：面板里用 `---` 分隔时会留下空段，空段进提示词就是纯噪声
      bits: Array.isArray(humor.bits)
        ? humor.bits.filter((b): b is string => typeof b === 'string' && b.trim() !== '')
        : def.humor.bits,
    },
    workRegister: {
      enabled: typeof workRegister.enabled === 'boolean'
        ? workRegister.enabled
        : def.workRegister.enabled,
    },
    weixinApi: {
      enabled: typeof weixinApi.enabled === 'boolean' ? weixinApi.enabled : def.weixinApi.enabled,
      port: typeof weixinApi.port === 'number' && Number.isInteger(weixinApi.port) && weixinApi.port >= 0
        ? weixinApi.port
        : def.weixinApi.port,
    },
  }
}

/** 读取全局配置（文件缺失/坏 JSON → 默认值） */
export function readAdvancedSettings(): AdvancedSettings {
  return mergeWithDefaults(readFileSafe(globalConfigPath()))
}

/** 写入全局配置（整体替换） */
export function writeAdvancedSettings(settings: AdvancedSettings): void {
  writeFileSafe(globalConfigPath(), settings as unknown as StoreShape)
}

/**
 * 部分更新：传入 Partial，深合并到现有值。
 * accounts 传入数组 → 整体替换；accounts 未传 → 保留现有。
 */
export function updateAdvancedSettings(patch: Partial<AdvancedSettings>): AdvancedSettings {
  const current = readAdvancedSettings()
  const gw = patch.gateway
  const ps = patch.persona
  const next: AdvancedSettings = {
    gateway: gw !== undefined
      ? {
        enabled: typeof gw.enabled === 'boolean' ? gw.enabled : current.gateway.enabled,
        host: typeof gw.host === 'string' && gw.host !== '' ? gw.host : current.gateway.host,
        port: typeof gw.port === 'number' && Number.isInteger(gw.port) ? gw.port : current.gateway.port,
        accounts: Array.isArray(gw.accounts) ? gw.accounts : current.gateway.accounts,
        workspaces: Array.isArray(gw.workspaces)
          ? gw.workspaces.filter((w): w is string => typeof w === 'string' && w !== '')
          : current.gateway.workspaces,
        cookieSecure: typeof gw.cookieSecure === 'boolean'
          ? gw.cookieSecure
          : current.gateway.cookieSecure,
        allowWorkspaceCreate: typeof gw.allowWorkspaceCreate === 'boolean'
          ? gw.allowWorkspaceCreate
          : current.gateway.allowWorkspaceCreate,
        totpEnabled: typeof gw.totpEnabled === 'boolean'
          ? gw.totpEnabled
          : current.gateway.totpEnabled,
      }
      : current.gateway,
    persona: ps !== undefined
      ? {
        mode: typeof ps.mode === 'string' ? ps.mode : current.persona.mode,
        overrideText: typeof ps.overrideText === 'string' ? ps.overrideText : current.persona.overrideText,
      }
      : current.persona,
    humor: patch.humor !== undefined
      ? {
        enabled: typeof patch.humor.enabled === 'boolean' ? patch.humor.enabled : current.humor.enabled,
        bits: Array.isArray(patch.humor.bits)
          ? patch.humor.bits.filter((b): b is string => typeof b === 'string' && b.trim() !== '')
          : current.humor.bits,
      }
      : current.humor,
    workRegister: patch.workRegister !== undefined
      ? {
        enabled: typeof patch.workRegister.enabled === 'boolean'
          ? patch.workRegister.enabled
          : current.workRegister.enabled,
      }
      : current.workRegister,
    weixinApi: patch.weixinApi !== undefined
      ? {
        enabled: typeof patch.weixinApi.enabled === 'boolean' ? patch.weixinApi.enabled : current.weixinApi.enabled,
        port: typeof patch.weixinApi.port === 'number' && Number.isInteger(patch.weixinApi.port) && patch.weixinApi.port >= 0
          ? patch.weixinApi.port
          : current.weixinApi.port,
      }
      : current.weixinApi,
  }
  writeAdvancedSettings(next)
  return next
}

// ── F4d 建议问答页访问 key／IP 失败锁定（v1.26.1／v1.26.5）**已于 2026-10-15 整面退役** ──
// 随之删除：`ensurePublicAskKey` / `verifyPublicAskKey` / `rotatePublicAskKey` /
// `resetPublicAskIpFail` / `isPublicAskIpLocked` / `recordPublicAskFail` 与 `ipFailStates`
// ＋ 三个 `PUBLIC_ASK_*` 常量（owner 裁「砍掉外部问答」；替代路径 = 官方 ACP ＋ 隧道/Access 层认证）。
// 🔴 **边界（别误删）**：**网关自己的**密码失败锁定（`gateway/auth.ts`）**不受影响**，仍在用。

/**
 * 一次性迁移（v1.21.x → v1.22）：旧版把 `serenityAdvanced` 存在 CCC localstore.json；
 * 新版归 plugin 全局文件。全局文件已存在 → 跳过（幂等）；localstore 无旧节 → 跳过。
 * @param root - CCC 根（localstore.json 所在目录）
 * @returns true = 已迁移（旧节保留在 localstore 供回滚，读取方以全局文件为准）
 */
export function migrateLegacyLocalstore(root: string | null): boolean {
  if (!root) return false
  const gpath = globalConfigPath()
  if (existsSync(gpath)) return false // 全局文件已存在（已迁移/已配置）
  const legacy = readFileSafe(join(root, 'localstore.json'))[ADVANCED_SECTION]
  if (legacy === undefined || legacy === null || typeof legacy !== 'object') return false
  writeFileSafe(gpath, legacy as StoreShape)
  return true
}

// ── wire 形态（面板消费；密码 hash 永不出现）──

/** 账号的 wire 形态：只有 id/user + hasPassword/hasTotp（无 hash/secret） */
interface GatewayAccountWire {
  id: string
  user: string
  hasPassword: boolean
  /** 该账号是否已绑定 TOTP（v1.22.4） */
  hasTotp: boolean
}

/** 设定 wire 形态（GET /serenity/config 返回；gateway 去 hash） */
interface AdvancedSettingsWire {
  gateway: {
    enabled: boolean
    host: string
    port: number
    accounts: GatewayAccountWire[]
    workspaces: string[]
    cookieSecure: boolean
    allowWorkspaceCreate: boolean
    totpEnabled: boolean
  }
  persona: PersonaSettings
  humor: HumorSettings
  workRegister: WorkRegisterSettings
}

/** 持久化 → wire（剥离 passHash/totpSecret；只留布尔） */
export function toWire(settings: AdvancedSettings): AdvancedSettingsWire {
  return {
    gateway: {
      enabled: settings.gateway.enabled,
      host: settings.gateway.host,
      port: settings.gateway.port,
      accounts: settings.gateway.accounts.map((a) => ({
        id: a.id,
        user: a.user,
        hasPassword: a.passHash !== '',
        hasTotp: typeof a.totpSecret === 'string' && a.totpSecret !== '',
      })),
      workspaces: [...settings.gateway.workspaces],
      cookieSecure: settings.gateway.cookieSecure,
      allowWorkspaceCreate: settings.gateway.allowWorkspaceCreate,
      totpEnabled: settings.gateway.totpEnabled,
    },
    persona: settings.persona,
    humor: settings.humor,
    workRegister: settings.workRegister,
  }
}

/**
 * 已知工作区投影（v1.28.0 适配 0.1.2-rc.1 A2 方案 A′）：
 * rc.1 workspace.list unary 删除 → AccountsEditor 白名单下拉的数据源改走 gateway 自有
 * /serenity/config 的 knownWorkspaces（host workspaceRegistry.list() 投影，白名单过滤）。
 * 纯函数可单测。allowPrefixes 空 = 全部放行（向后兼容默认）。
 */
export function projectKnownWorkspaces(
  workspaces: Array<{ path?: string; title?: string }>,
  allowPrefixes: readonly string[],
): Array<{ path: string; title: string }> {
  return workspaces
    .filter((w) => typeof w.path === 'string' && w.path !== '')
    .filter((w) => allowPrefixes.length === 0 || allowPrefixes.some((p) => w.path!.startsWith(p)))
    .map((w) => ({ path: w.path!, title: typeof w.title === 'string' && w.title !== '' ? w.title : w.path! }))
}

/**
 * wire → 持久化（面板 PUT 用）：
 * accounts 元素可选带 `pass`：非空 → 重新 hash；空/缺省 → 保留现有 hash（按 id 匹配）。
 * 新账号（id 不在现有）必须带非空 pass，否则抛错（无法生成 hash）。
 */
export function applyWirePatch(wire: Partial<AdvancedSettingsWire>): AdvancedSettings {
  const current = readAdvancedSettings()
  const patch: Partial<AdvancedSettings> = {}

  if (wire.gateway !== undefined) {
    // 从 current 展开构造完整 GatewaySettings（Partial<AdvancedSettings> 的 gateway 字段是完整类型）
    const gwPatch: GatewaySettings = { ...current.gateway }
    if (typeof wire.gateway.enabled === 'boolean') gwPatch.enabled = wire.gateway.enabled
    if (typeof wire.gateway.host === 'string' && wire.gateway.host !== '') gwPatch.host = wire.gateway.host
    if (typeof wire.gateway.port === 'number' && Number.isInteger(wire.gateway.port)) gwPatch.port = wire.gateway.port
    if (Array.isArray(wire.gateway.workspaces)) {
      gwPatch.workspaces = wire.gateway.workspaces.filter((w): w is string => typeof w === 'string' && w !== '')
    }
    if (typeof wire.gateway.cookieSecure === 'boolean') gwPatch.cookieSecure = wire.gateway.cookieSecure
    if (typeof wire.gateway.allowWorkspaceCreate === 'boolean') gwPatch.allowWorkspaceCreate = wire.gateway.allowWorkspaceCreate
    if (typeof wire.gateway.totpEnabled === 'boolean') gwPatch.totpEnabled = wire.gateway.totpEnabled
    if (Array.isArray(wire.gateway.accounts)) {
      const byId = new Map(current.gateway.accounts.map((a) => [a.id, a]))
      const nextAccounts: GatewayAccount[] = wire.gateway.accounts.map((a) => {
        const existing = byId.get(a.id)
        const pass = (a as { pass?: string }).pass
        // v1.22.4 TOTP：wire 层 totpSecret（非空 = 设置新 secret；totpReset=true = 清除）。
        // 仅允许对既有账号操作（新账号必须 pass 非空；secret 不参与账号创建判定）。
        // v1.24.7 用户拍板：生成即绑定——去掉 totpConfirm 确认码（没录的 secret 登录时
        // TOTP 方式自然不生效，二选一里密码仍可用）；保留 base32 合法性轻校验防无效 secret。
        const totp = (a as { totpSecret?: string; totpReset?: boolean }).totpSecret
        const totpReset = (a as { totpReset?: boolean }).totpReset === true
        if (typeof totp === 'string' && totp !== '') {
          try {
            base32Decode(totp)
          } catch {
            throw new Error(`Account "${a.user}" TOTP secret is not valid base32`)
          }
        }
        const nextTotp: string | undefined = totpReset
          ? undefined
          : typeof totp === 'string' && totp !== '' ? totp : existing?.totpSecret
        // wire 的 user 总是权威（可改名）；existing 只供 passHash/totpSecret 继承
        const withTotp = {
          id: a.id,
          user: a.user,
          ...(nextTotp === undefined ? {} : { totpSecret: nextTotp }),
        }
        if (typeof pass === 'string' && pass !== '') {
          return { ...withTotp, passHash: hashPassword(pass) }
        }
        if (existing) {
          return { ...withTotp, passHash: existing.passHash }
        }
        throw new Error(`Account "${a.user}" (id=${a.id}) has no password and no existing hash — new accounts must set a password`)
      })
      gwPatch.accounts = nextAccounts
    }
    patch.gateway = gwPatch
  }
  if (wire.persona !== undefined) {
    const psPatch: PersonaSettings = { ...current.persona }
    if (typeof wire.persona.mode === 'string') psPatch.mode = wire.persona.mode
    if (typeof wire.persona.overrideText === 'string') psPatch.overrideText = wire.persona.overrideText
    patch.persona = psPatch
  }
  if (wire.humor !== undefined) {
    const hPatch: HumorSettings = { ...current.humor }
    if (typeof wire.humor.enabled === 'boolean') hPatch.enabled = wire.humor.enabled
    if (Array.isArray(wire.humor.bits)) {
      hPatch.bits = wire.humor.bits.filter((b): b is string => typeof b === 'string' && b.trim() !== '')
    }
    patch.humor = hPatch
  }
  return updateAdvancedSettings(patch)
}
