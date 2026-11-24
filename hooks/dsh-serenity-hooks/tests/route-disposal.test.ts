/**
 * route-disposal.test.ts — 🔴 **路由注册必须「注册即撤销」（2026-11-24 真机事故的回归钉）**
 *
 * ## 事故形态（⛔ 不是假想，是 owner 报的现象）
 *
 * 切换界面主题后，整份插件被判加载失败 ⇒ 工具面全部消失、附带服务面一个都不起，
 * 而宿主本身照常运行。宿主给出的原因逐字是：
 *
 *     webserver: duplicate exact route "/serenity/image-upload"
 *
 * ## 真因（读宿主源码 + 本仓源码，逐字对读）
 *
 * 宿主 `WebServer.register()` 只把 disposer **返回**给调用方，**自己不代管**：
 * 同路径第二次注册直接 `throw`；而同类的 `listen()` 反而走 `ctx.effect`
 * ⇒ **拆卸登记是调用方的责任**，不登记就等于把路由永久钉在宿主表上。
 *
 * 本仓此前 11 处注册**全部丢弃返回值** ⇒ 同一进程内再装配一次即撞上那条 throw，
 * 而宿主对插件抛错的处理是**整份插件判失败**（这就是"ACC 突然没了"）。
 *
 * ## 本文件为什么用「会真拒绝」的替身
 *
 * 既有 fixtures 的 `register` 都是 `() => { push(...) }`，**不返回 disposer、也不查重**
 * ⇒ 它们对这一类失效**结构性无判别力**（测试全绿而真机炸）。
 * ⇒ 本文件显式复刻宿主的**拒绝语义**（同路径第二次 ⇒ throw），
 *    否则用例永远绿、也就永远抓不住它。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { withRouteDisposal, registerDisposer } from '../src/host/effect.js'

type Route = { kind: 'exact' | 'prefix'; path: string; handler: unknown }

/**
 * 宿主 `WebServer` 的行为替身 —— 只看它**会拒绝重复**这一条语义。
 * 🔴 故意实现 dispose（不是空函数）：撤销登记漏了，第二条注册就会真的抛错。
 */
function hostLikeWebServer() {
  const table = new Map<string, Route>()
  const log: string[] = []
  const svc = {
    register(route: Route): () => void {
      if (table.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      table.set(route.path, route)
      log.push(`+${route.path}`)
      return () => {
        table.delete(route.path)
        log.push(`-${route.path}`)
      }
    },
    get paths(): string[] {
      return [...table.keys()]
    },
    get log(): string[] {
      return [...log]
    },
  }
  return svc
}

/** 最小 ctx：只需 `effect` 能收藏 cleanup（与 cordis `ctx.effect` 同形） */
function effectCtx() {
  const cleanups: Array<() => void> = []
  return {
    ctx: {
      effect(cb: () => () => void, _label?: string) {
        cleanups.push(cb())
      },
    },
    /** 模拟「插件被卸下」 */
    runCleanups() {
      for (const fn of cleanups) fn()
      cleanups.length = 0
    },
  }
}

const route = (path: string): Route => ({ kind: 'exact', path, handler: () => {} })

describe('withRouteDisposal — 路由必须「注册即撤销」', () => {
  it('C1 卸下后路由被摘除（不留幽灵）', () => {
    const host = hostLikeWebServer()
    const { ctx, runCleanups } = effectCtx()
    const ws = withRouteDisposal(ctx, 'test routes', host)

    ws.register(route('/a'))
    ws.register(route('/b'))
    expect(host.paths).toEqual(['/a', '/b'])

    runCleanups()
    expect(host.paths).toEqual([])
  })

  it('🔴 C2 同一进程内装配两次**不得**抛 duplicate —— 这就是那条真机报错', () => {
    const host = hostLikeWebServer()
    const { ctx, runCleanups } = effectCtx()

    // 第一次装配
    const first = withRouteDisposal(ctx, 'test routes', host)
    first.register(route('/x'))
    first.register(route('/y'))

    // 插件被卸下（HMR / 重挂 / 设置面触发的重装配都会走这里）
    runCleanups()

    // 第二次装配 —— 修好之前，这一行会抛 webserver: duplicate exact route
    const second = withRouteDisposal(ctx, 'test routes', host)
    expect(() => {
      second.register(route('/x'))
      second.register(route('/y'))
    }).not.toThrow()

    expect(host.paths).toEqual(['/x', '/y'])
  })

  it('C3 摘除顺序为逆序（反向控制：不是"删光就算"）', () => {
    const host = hostLikeWebServer()
    const { ctx, runCleanups } = effectCtx()
    const ws = withRouteDisposal(ctx, 'test routes', host)

    ws.register(route('/1'))
    ws.register(route('/2'))
    runCleanups()

    expect(host.log).toEqual(['+/1', '+/2', '-/2', '-/1'])
  })

  it('C4 单条 dispose 仍返回给调用方（形态不吞返回值）', () => {
    const host = hostLikeWebServer()
    const { ctx } = effectCtx()
    const ws = withRouteDisposal(ctx, 'test routes', host)

    const dispose = ws.register(route('/only'))
    expect(typeof dispose).toBe('function')
    dispose()
    expect(host.paths).toEqual([])
  })

  it('C5 宿主缺 `ctx.effect` 时仍照常注册（响亮降级，⛔ 不得让整份插件起不来）', () => {
    const host = hostLikeWebServer()
    const ws = withRouteDisposal({}, 'test routes', host)
    expect(() => ws.register(route('/no-effect'))).not.toThrow()
    expect(host.paths).toEqual(['/no-effect'])
  })
})

describe('registerDisposer — 撤销登记的底座', () => {
  it('C6 无 `effect` 时返回 false 而非抛错（插件启动不得成为单点）', () => {
    expect(registerDisposer({}, 'x', () => {})).toBe(false)
  })

  it('C7 有 `effect` 时返回 true，且 cleanup 被执行一次', () => {
    const { ctx, runCleanups } = effectCtx()
    let n = 0
    expect(registerDisposer(ctx, 'x', () => { n += 1 })).toBe(true)
    expect(n).toBe(0)
    runCleanups()
    expect(n).toBe(1)
  })
})
