/**
 * surface/voyage/page.ts — `/serenity/voyage`：宁静号航行动画（**ACC 层静态资产**）
 *
 * 作用：把「宁静号航行动画」作为 **ACC 的一部分**随包分发，并用一条 HTTP 路由把它
 * 交给 WebUI。当前唯一消费者 = 会话头部状态胶囊展开卡片（`SafeModePanel` 的 `sp-pop`）
 * 的**背景层**——即所有者定的定位：「宁静号的心智模型」。
 *
 * 资产本体：`assets/serenity-voyage.html`（单文件自包含，three.js r180 内联）。
 * 同一份文件两种用法，靠 query 切换：
 *   - 无参数    → **全屏构图版**（标题/品牌语/航速/容器事实面板齐备），可独立打开
 *   - `?card=1` → **卡片模式**：隐藏自带 UI 层、镜头拉远、星野调暗、铭牌层关闭
 *
 * 为什么用「独立路由 + iframe」而不是内联进 client bundle：
 *   ① 作品自包含 830 KB（其中 704 KB 是 three.js）——内联会把整包灌进 client chunk；
 *   ② 作品自带全局 CSS/画布，内联会与卡片样式互相污染；
 *   ③ 独立路由 ⇒ **惰性加载**（只在卡片展开时请求一次）+ 可长缓存，关闭 iframe 即卸载，
 *      WebGL 上下文随之释放。
 *
 * 来历（R↓）：作品由**另一个 Serenity CCC 实例**赠予；**本仓库只携带
 * 构建产物**，源与构建脚本住在该实例侧（详见 `assets/README.md`）。内容已重播为宁静号自己的
 * 技能/公理/MSM/本体词元与实测容器规模数字。
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { injectVoyageVocab, injectVoyageVersion, scanVoyageLiveVocab } from './vocab.js'
import { findPackageRoot, ACC_VERSION } from '../../kernel/constants.js'
// 类型引用：拉入 webserver 的 cordis 声明增强（ctx.webServer）；运行时擦除
import type {} from '@deepseek-ai/dsh-host-webserver'

export const VOYAGE_PATH = '/serenity/voyage'

/**
 * 资产相对包根的路径。
 * 🔒 它**必须**同时出现在 `package.json` 的 `files` 白名单里——否则发布包缺文件，
 * 路由会在运行时报「资产不可用」（同 v1.26.15 那次 `files` 漏 chunk 的事故形态）。
 * `dsh-develop pack-check` 的 `required` 已把它列为发布前硬断言。
 */
export const VOYAGE_ASSET = 'assets/serenity-voyage.html'

/**
 * 包根 = 含本包 `package.json` 的目录。
 * 🔴 **不许写死层数**：本模块自身位置随目录重构变化（曾 `src/surface/voyage/page.ts`，现
 * `src/surface/voyage/page.ts`），而发布态是从打包入口 `lib/index.js` 反推 ⇒ 两种布局深度不同，
 * 写死 `'..'` 必在其中一个布局下静默指错（实测：搬进 `surface/voyage/` 后路由直接读不到资产 → 500）。
 * ⇒ 交给 {@link findPackageRoot} 按**内容**定位。
 */
function packageRootPath(): string {
  return findPackageRoot() ?? join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 资产绝对路径（导出以便测试与 pack-check 共用同一判据来源） */
export function voyageAssetPath(): string {
  return join(packageRootPath(), VOYAGE_ASSET)
}

/** 缓存（830 KB，避免每次展开卡片都读盘；进程内只读一次） */
let cachedHtml: string | null = null

/** 读取资产全文。读不到即抛错（由 handler 转 500，绝不静默发空页）。 */
export function loadVoyageHtml(assetPath: string = voyageAssetPath()): string {
  if (assetPath === voyageAssetPath()) {
    if (cachedHtml === null) cachedHtml = readFileSync(assetPath, 'utf-8')
    return cachedHtml
  }
  return readFileSync(assetPath, 'utf-8')
}

/** 清缓存（测试用） */
export function resetVoyageCache(): void {
  cachedHtml = null
}

/** 发 JSON（错误分支用；与 surface/http.ts 的 sendJson 同形，但本模块不依赖它，保持零耦合） */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 注册 `/serenity/voyage`（GET）。
 * @param opts.assetPath 覆盖资产路径（测试用；生产不传）
 * @param opts.resolveRoot 解析本次请求所属 CCC 根（生产由 surface/http.ts 的 resolveWorkspace 提供）。
 *   🔴 **2026-10-18 新增**：词表按请求所属 CCC **运行时注入**（owner 报「在别的 CCC 点开
 *   显示的还是 home-serenity 的信息」）。不传 ⇒ 不注入（保持资产原样 = 旧行为）。
 */
export function registerVoyageApi(
  ctx: Context,
  opts: { assetPath?: string; resolveRoot?: (req: IncomingMessage) => string | null } = {},
): void {
  ctx.webServer.register({
    kind: 'exact',
    path: VOYAGE_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let html: string
      try {
        html = loadVoyageHtml(opts.assetPath ?? voyageAssetPath())
      } catch (err: any) {
        sendJson(res, 500, { error: `voyage asset unavailable: ${err?.message ?? String(err)}` })
        return
      }
      // ── 版本号注入（v1.127.0，与词表注入**互相独立**）──
      // 蓝图标注层的标题栏要写"这张图是哪一版"；资产是静态单文件、看不见 package.json
      // ⇒ 唯一可信来源是本进程的 ACC_VERSION。失败只少这一条标注，不影响其它。
      // ⚠️ 它**无条件**执行（不依赖 root）：版本与"哪个 CCC"无关。
      try {
        html = injectVoyageVersion(html, ACC_VERSION)
      } catch {
        /* 注入失败 ⇒ 标题栏那格显示 —（退化，不是缺陷） */
      }
      // ── 词表按当前 CCC 注入（只改那一行；任何环节失败 ⇒ 原样返回）──
      let root: string | null = null
      try {
        root = opts.resolveRoot?.(req) ?? null
      } catch {
        root = null // 解析失败不该让整页打不开
      }
      if (root !== null) {
        try {
          html = injectVoyageVocab(html, scanVoyageLiveVocab(root))
        } catch {
          /* 注入失败 ⇒ 用资产自带词表（退化到旧行为，仍可用） */
        }
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      // 🔴 **缓存策略因注入而改变**（2026-10-18）：
      //   注入前资产是**与 CCC 无关的静态文件** ⇒ `max-age=86400` 合理。
      //   注入后同一 URL 在**不同 CCC 下返回不同内容** ⇒ 长缓存会让"切了 CCC 还是旧词表"，
      //   而这正是本轮要修的那类"看到别人的信息"病症的同族形态。
      //   ⇒ 改 `no-cache`（**可缓存但每次回源校验**）：830 KB 走 304 仍很便宜，
      //      而正确性优先于那点带宽。未注入时（resolveRoot 未接）仍给长缓存。
      res.setHeader('cache-control', root !== null ? 'no-cache' : 'private, max-age=86400')
      res.setHeader('content-length', String(Buffer.byteLength(html)))
      res.end(html)
    },
  })
}
