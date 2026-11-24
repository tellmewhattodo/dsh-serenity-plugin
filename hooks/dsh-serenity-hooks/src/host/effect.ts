/**
 * host/effect.ts — 插件资源拆卸登记（S142 review F-08）
 *
 * 宿主把"注册即效果"作为统一模型：每个贡献都走 `ctx.effect()` / `ctx.on()`，
 * 注册返回 disposer，fiber 销毁时自动回收（`cordis` Context.effect，rc.1 全量使用，
 * 如 `core/tools/src/index.ts:943`）。
 *
 * 本模块是 dsp 各装配点登记自起资源（端口监听器/定时器/轮询器）的**唯一入口**，
 * 理由：
 *  - `ctx.effect` 是宿主成员，但**不可假定存在**（测试替身、极旧宿主、HMR 早期阶段）。
 *    直接裸调会让 `apply` 抛错 = 整个 dsh 启动失败（app-boot "plugin(s) failed to load"），
 *    这比"资源没拆卸"严重得多——所以缺失时**响亮降级**（记录 + 返回 false）。
 *  - 零依赖叶模块：gateway 等模块只引它，不会因此被拖进 轨迹约束/rebuild 的依赖链。
 */

/** 与宿主 `ctx.effect` 同形的最小结构（避免为一次调用引入 cordis 类型依赖） */
interface EffectCapable {
  effect?: (callback: () => () => void, label?: string) => unknown
}

/** 已告警的标签（进程级去重：重复装配/多测试替身不刷屏，但绝不静默） */
const warnedLabels = new Set<string>()

/** 测试辅助：重置"未装配"告警去重（生产零调用） */
export function __resetDisposerWarningsForTest(): void {
  warnedLabels.clear()
}

/**
 * 登记一个卸载时执行的清理。
 * @param ctx 宿主插件上下文
 * @param label 日志标签（定位是哪个资源未装配）
 * @param cleanup 卸载时执行；抛错被吞掉（不阻断其它清理）
 * @returns 是否成功装配（false = 宿主无 `ctx.effect`，已告警）
 */
export function registerDisposer(ctx: unknown, label: string, cleanup: () => void): boolean {
  const effect = (ctx as EffectCapable | undefined)?.effect
  if (typeof effect !== 'function') {
    if (!warnedLabels.has(label)) {
      warnedLabels.add(label)
      console.warn(`[serenity-hooks] ✗ 资源拆卸未装配（${label}）：ctx.effect 不可用（宿主契约缺失）`)
    }
    return false
  }
  try {
    effect.call(ctx, () => () => {
      try {
        cleanup()
      } catch (err) {
        console.warn(`[serenity-hooks] ✗ 资源清理失败（${label}）: ${String((err as Error)?.message ?? err)}`)
      }
    }, `dsh-serenity-hooks: ${label}`)
    return true
  } catch (err) {
    console.warn(`[serenity-hooks] ✗ 资源拆卸注册失败（${label}）: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

/** 与宿主 `webServer.register` 同形的最小结构（避免为一次调用引入 webserver 类型依赖） */
interface RouteRegistrar {
  register: (route: { kind: 'exact' | 'prefix'; path: string; handler: unknown }) => () => void
}

/**
 * 把一个 HTTP 路由注册器包成「注册即撤销」。
 *
 * ## 为什么必须有这一层（2026-11-24 真机事故）
 *
 * 宿主 `WebServer.register()` 只把 disposer **返回**给调用方，**自己不代管**
 * （`dsh-host-webserver` 逐字：同路径第二次注册 `throw new Error('webserver: duplicate … route')`；
 * 同类的 `listen()` 反而走 `ctx.effect` ⇒ **拆卸登记是调用方的责任**）。
 *
 * 我们此前 11 处注册**全部丢弃返回值** ⇒ 路由挂在宿主表上、插件卸下时无人摘除。
 * 后果不是"泄漏一点内存"：同一进程内再装配一次就撞上那条 throw，
 * 而宿主对插件抛错的处理是**整份插件判失败** ⇒ 工具面与附带服务面一起消失，
 * 而宿主本身照常运行（现象：ACC「突然没了」）。
 *
 * ## 形态
 *
 * 返回一个与 `ctx.webServer` 同形的对象，`register()` 内部照旧调用真宿主并把
 * disposer 交给 `registerDisposer`。既有调用点**只改传入的对象**，路由定义一个字不动。
 *
 * @param ctx 宿主插件上下文（交给 `registerDisposer` 登记拆卸）
 * @param label 日志标签，指明是哪一面
 * @param webServer 真宿主服务（可能是测试替身）
 * @returns 同形对象；`effect` 不可用时仍照常注册（响亮降级，见 `registerDisposer`）
 */
export function withRouteDisposal<T extends object>(ctx: unknown, label: string, webServer: T): T {
  const real = webServer as unknown as RouteRegistrar
  const disposers: Array<() => void> = []
  registerDisposer(ctx, label, () => {
    // 逆序摘除：与注册顺序相反，避免中间态出现"父先没了子还在"
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        disposers[i]?.()
      } catch (err) {
        console.warn(`[serenity-hooks] ✗ 路由摘除失败（${label} #${i}）: ${String((err as Error)?.message ?? err)}`)
      }
    }
    disposers.length = 0
  })
  const proxy = Object.create(webServer as object) as T
  ;(proxy as unknown as RouteRegistrar).register = ((route: { kind: 'exact' | 'prefix'; path: string; handler: unknown }) => {
    const dispose = real.register(route)
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }) as RouteRegistrar['register']
  return proxy
}
