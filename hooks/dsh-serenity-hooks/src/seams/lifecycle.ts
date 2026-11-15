/**
 * lifecycle.ts — 宿主生命周期订阅 + 资源拆卸（S142 review F-08）
 *
 * 两个此前缺失的收尾面：
 *
 * ① **会话/agent 销毁 → 清理 per-会话内存态**。dsp 有约 10 处 per-会话 Map
 *    （活跃 SESSION 作用域、轨迹约束 注册表、keeper 计分、guard 白名单缓存、bootstrap
 *    晋升状态、输出守卫状态…）。此前无人订阅 `agent/disposed` / `session/disposed`
 *    （宿主 0.1.2-rc.1 真实存在：`core/agent/src/runtime-types.ts:175`、
 *    `core/session/src/index.ts:62`），长跑进程里这些 Map 只增不减——且 `waitIdle`
 *    在 agent 先被销毁时永不结算。
 *
 * ② **插件卸载/HMR/profile 重载 → 停掉自起的监听器与轮询器**。轨迹约束调试页、微信桥轮询
 *    都是 dsp 自己起的资源（⚠️ 2026-10-15：原同批还有 ACP HTTP 端点，该面已退役）；
 *    此前没有 `ctx.effect` 拆卸，卸载后端口仍被占用（EADDRINUSE）、轮询器重复启动。
 *
 * 设计约束：清理与拆卸**一律吞掉异常**——生命周期回调里抛错会影响宿主的销毁流程
 * （宿主对 `session/disposed` 监听器异常是"contained"语义，但没必要制造噪音）。
 */

import type { Context } from 'cordis'
import { clearActiveSessionInfo } from '../trajectory/core.js'
import { unregisterTrajectorySession } from '../trajectory/session.js'
import { stopAllFaces } from '../surface/faces.js'
import { stopAllBridges } from '../im/bridge.js'
import { forgetManualOutputSession } from '../im/guard.js'
import { forgetImBridgeVisibility, forgetExclusiveToolsVisibility, forgetNonCccToolVisibility, forgetHostScheduleToolHiding, forgetTrajectoryConstraintToolVisibility } from './guards.js'
import { forgetToolVisibility } from './tool-visibility.js'
import { forgetLogbookCompactionState } from './cognitive-trajectory-lifecycle.js'
import { registerDisposer } from '../host/effect.js'

/** 从 Agent / Session / 事件负载中取会话 id（形状宽容：未知结构返回 null） */
export function sessionIdOf(value: unknown): string | null {
  const v = value as
    | { id?: unknown; header?: { id?: unknown }; session?: { id?: unknown } }
    | null
    | undefined
  const id = v?.session?.id ?? v?.id ?? v?.header?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** 单会话内存态清理（幂等；无对应状态即 no-op） */
export function cleanupSessionState(sessionId: string): void {
  try {
    unregisterTrajectorySession(sessionId)
  } catch {
    /* 未注册 */
  }
  try {
    clearActiveSessionInfo(sessionId)
  } catch {
    /* 无作用域 */
  }
  try {
    // v1.30.16：手动输出闸门状态（会话销毁后不再判定；同时防 per-会话 Map 无界增长）
    forgetManualOutputSession(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // 🔴 2026-10-22 方案 C：**六源汇一后的唯一撤销点**。
    //    顺序上必须**先**于下面那些语义占位（它们现在不做实际动作）。
    //    为什么这一条不可省：合并后只有**一份** restrict，若不在销毁时撤销，
    //    它持有的 disposer 永远不会被调用 —— 会话没了，状态表还在（这正是 review F-08 那类泄漏）。
    forgetToolVisibility(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // v1.31.0：im-bridge 可见性隐藏状态（同上——防 per-会话 Map 无界增长）
    forgetImBridgeVisibility(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // v1.33：专属工具（acc-diag）可见性隐藏状态（同上）
    forgetExclusiveToolsVisibility(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // v1.56.6：非 CCC 会话的全工具面隐藏状态（同上——防 per-会话 Map 无界增长）
    forgetNonCccToolVisibility(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // 🆕 v1.59.5：宿主定时器工具（schedule_*）的屏蔽状态（同上——防 per-会话 Map 无界增长）
    forgetHostScheduleToolHiding(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // 🆕 v1.69.3：轨迹约束工具面（白名单之外从 schema 移除）的 restrict 状态（同上）
    forgetTrajectoryConstraintToolVisibility(sessionId)
  } catch {
    /* 无状态 */
  }
  try {
    // v1.31.1：SESSION.md 体积提醒的路径缓存与超限计数（同上）
    forgetLogbookCompactionState(sessionId)
  } catch {
    /* 无状态 */
  }
}

/**
 * 装配生命周期订阅与资源拆卸。
 * @param ctx 宿主插件上下文
 */
export function registerLifecycle(ctx: Context): void {
  // ① 会话/agent 销毁 → 清理 per-会话状态
  try {
    ctx.on('agent/disposed', (payload: { agent?: unknown }) => {
      const id = sessionIdOf(payload?.agent)
      if (id) cleanupSessionState(id)
    })
  } catch {
    /* 事件通道缺失（旧宿主）不阻断装配 */
  }
  try {
    ctx.on('session/disposed', (session: unknown) => {
      const id = sessionIdOf(session)
      if (id) cleanupSessionState(id)
    })
  } catch {
    /* 同上 */
  }
  // ② 插件卸载/HMR → 停掉自起资源（端口/轮询器）
  //
  // 🔒 C4 块 A（2026-09-15）：**这是自起 HTTP listener 的唯一拆卸挂点**。
  // 此前拆卸裂成两套——本处一个聚合 disposer，而 `gateway/server.ts` / `im/send.ts`
  // 各自另注册一个（D/E 干脆没有自己的）。现在四个面（B 3081 / C 3082 / D 3099 /
  // E 3100）的 listener 全部由 `face-host` 持有，拆卸 = `stopAllFaces()` 一处；
  // 面自己的 `registerDisposer` 已删除（名单归 active 表，不再靠人记）。
  const disposeAll = (): void => {
    try {
      stopAllFaces()
    } catch {
      /* 已停/未启 */
    }
    try {
      // 非 listener 的自起资源（微信桥轮询器等）
      stopAllBridges()
    } catch {
      /* 已停/未启 */
    }
  }
  // ctx.effect 是 cordis Context 成员（宿主 rc.1 全量使用，如 core/tools/src/index.ts:943）——
  // 但**不可假定存在**：apply 抛错 = 整个 dsh 启动失败（app-boot "plugin(s) failed to load"），
  // 且测试替身/极旧宿主可能没有。缺失 → 响亮降级（registerDisposer 内记录）。
  registerDisposer(ctx, 'self-started resources (gateway/weixin/trajectory-debug faces + weixin bridges)', disposeAll)
}
