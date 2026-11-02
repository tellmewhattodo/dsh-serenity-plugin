/**
 * tools/kit/service.ts — dashboard 纯操作层（acc_kit → dashboard，v1.30；零 DSH 依赖）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/acc-kit.ts）——osp 是 ACC 工具 spec：
 *   - health：{ccc, root, version, status: healthy|degraded, principles: {P1_rooted, P2_git_managed, P3_binary_permissions}}
 *   - time：{now_iso, now_local, epoch_ms}
 * 平台适配：P3 在 osp 检查 opencode.json，DSH 无 opencode.json → 检查 DSH/opencode 配置路径
 * （.opencode/serenity.json / .dsh/serenity.json 等，见 DEFAULT_SERENITY_CONFIG_PATHS）。
 * CCC 缺失时返回 degraded 报告而非抛错（对齐 osp 未激活语义）。
 * 保留 dsp 增强：accVersion/dshVersion 版本自省字段。
 *
 * 🔴 `wait` 已于 2026-11-02 按 owner 令**整条砍掉**（原「砍掉 wait」令第一条）。
 *    理由：它唯一的用途是"循环睡等长任务"，而那正是 owner 反感的形态
 *    ——把一次等待摊成一串轮询，且**每睡一次都要占一轮模型上下文**。
 *    替代表达：短延迟用 `send-later +0.5m`（`wake/registry.ts` 正则认小数分钟），
 *    长任务用 `send-later` 排到点。⛔ 不要再把它加回来。
 *    ⚠️ ACC 自己的 `dashboard` 是"时钟"，⛔ 不是"可用 sleep" —— 两者别混。
 *
 * C5「观察面归一」（S142 2026-09-15）：本文件的 health **不再自己取数**——三原则、注册表结构判据、
 * 配置、宿主契约一律经 `surface/observation.ts` 取（唯一取数出口），本文件只把事实**渲染**成 osp
 * 既有 wire 形状。故：
 *  - `checkRegistryHealth` 已迁入 `surface/observation.ts`（同一实现，名字不变）；
 *  - `surface/observation.ts` 带 @deepseek-ai 值依赖（时钟段）⇒ 这里用 `await import` 保持本模块
 *    静态链**零 DSH 依赖**（与 `surface/http.ts` 的既有约定同规格）。
 * ⚠️ wire 形状**逐字不变**（字段名/取值/出现条件都不许动）——C5 是取数归一，不是文案改版。
 */

import type { JsonValue } from '../../kernel/json.js'
import { isoLocal } from '../../kernel/time.js'

type KitAction = 'health' | 'time' | 'diag'

export const KIT_ACTIONS: readonly KitAction[] = ['health', 'time', 'diag']

interface KitArgs {
  action: KitAction
}

export async function runKit(root: string | null, args: KitArgs, hostCtx?: unknown): Promise<JsonValue> {
  switch (args.action) {
    case 'health': {
      // 取数唯一出口（动态 import：见文件头「依赖分层」）
      const { containerStatus } = await import('../../surface/observation.js')
      const s = containerStatus({ root, hostCtx })
      // osp 的 P1/P2/P3 在 DSH 上的判据由 container-status 给出；**人读 detail 文案归本渲染点**
      // （模型只给事实：rooted / gitManaged / configPath）——原文案逐字保留。
      const p = s.principles
      const report: Record<string, unknown> = {
        ccc: s.identity.ccc,
        root: s.identity.root,
        version: s.identity.accVersion,
        status: p.allPass ? 'healthy' : 'degraded',
        principles: {
          P1_rooted: {
            pass: p.rooted,
            detail: p.rooted ? '.serenity marker found' : '.serenity marker missing',
          },
          P2_git_managed: {
            pass: p.gitManaged,
            detail: p.gitManaged ? 'git repository verified' : 'not in a git repository',
          },
          P3_binary_permissions: {
            pass: p.configPath !== null,
            detail: p.configPath ? `${p.configPath} found` : 'config not found at CCC root',
          },
        },
      }
      // 需求⑤c：MSM 注册表完整性检查段（用户：注册表太核心，要有 ACC 层检查方法检查没坏）
      // 判据 = 结构完整性（**不是** `container_admin msm check` 的 DC-M1~M4 质量契约，两者不许合并）
      if (s.identity.root) {
        report.registry = s.registry.structure
      }
      // CCC 配置段（面板/升级排查用）
      if (s.identity.root) {
        report.config = s.config
      }
      // dsp 增强：版本自省（升级提示依据）
      report.accVersion = s.identity.accVersion
      report.dshVersion = s.identity.dshVersion
      // review F-05（v1.30.7）：宿主契约探针——把"静默漂移"变成可读信号
      // （服务/成员缺失 + 宿主版本是否落在被验证范围；required 缺失 → status 降级）
      // C5：报告来自**进程内唯一来源**（apply 时捕获一次的快照），此处不再二次探针。
      if (hostCtx !== undefined && s.hostContract !== null) {
        report.hostContract = s.hostContract as unknown as JsonValue
        if (!s.hostContract.ok) report.status = 'degraded'
      }
      return report as JsonValue
    }
    case 'time': {
      const now = new Date()
      return {
        now_iso: isoLocal(now),
        now_local: now.toString(),
        epoch_ms: now.getTime(),
      }
    }
    case 'diag': {
      // 原 `acc-diag` 工具整体并入（owner 2026-11-01 裁「方案 C」）。
      // 🔴 动态 import：`diag/service.ts` 静态链带 `cro/core.js` → node:fs 等，
      //    而本模块的约定是**零 DSH 依赖**（见文件头）；动态 import 保持这条边界。
      // ⚠️ 需要 `hostCtx`（Context）才能读 live 会话 —— 无 ctx 时**响亮失败**，
      //    ⛔ 不返回空报告（"零个 live 会话"与"读不了"在阅读面上同形，D233）。
      if (hostCtx === undefined) {
        throw new Error('diag requires the plugin context (live session data unavailable without it)')
      }
      const { runDiag, renderDiag } = await import('../diag/service.js')
      return renderDiag(await runDiag(hostCtx as never, root ?? ''))
    }
    default:
      throw new Error(`Unknown action: ${args.action as string}`)
  }
}
