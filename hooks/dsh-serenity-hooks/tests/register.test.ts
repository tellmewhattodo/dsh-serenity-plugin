import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

vi.mock('schemastery', () => {
  const chain = (val: unknown) => Object.assign(() => val, { default: () => val })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain([]),
      string: () => chain(''),
      boolean: () => chain(true),
      number: () => chain(0),
    },
  }
})

// 公开版：schemastery 由 @deepseek-ai/schemastery 提供（index.ts 直接导入；v1.21 Config 含 .min/.max 链）
vi.mock('@deepseek-ai/schemastery', () => {
  // 链式 mock：任何属性访问/函数调用返回链自身（.min().max().default() 无限链）
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})

// v1.21 settings-section：index.ts 经 registerSettingsSection 引入 dsh-settings
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

// v1.23.5 trajectory/rebuild.ts 运行时引入 dsh-session（shadow-price 定价）
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))

import { name, inject, apply, type Config } from '../src/index.ts'
import { REGISTERED_TOOLS } from '../src/kernel/invariant.js'
import { __setSimpleSourceForTest, defaultSimpleSettings, SERENITY_SETTINGS_NS } from '../src/surface/settings.js'

/**
 * 宿主替身。
 * 🔴 `disposers` 必须逐次收好：宿主 `tools.register` **返回注销器**，而"关开关 ⇒ 注销"这条
 *    需求的**唯一可观察效果**就是这个返回的函数被调用（`register` 的调用次数只会增加）。
 */
function mockCtx() {
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn(() => {
    const d = vi.fn()
    disposers.push(d)
    return d
  })
  const guard = vi.fn()
  const on = vi.fn()
  // v1.30.8（review F-08）：宿主 Context 有 ctx.effect（rc.1 全量使用，如 core/tools/src/index.ts:943）
  // ——替身必须保真，否则 lifecycle 装配在测试里被误判为"缺失"（E-01 同族：替身不镜像宿主）。
  const effect = vi.fn(() => () => {})
  const ctx = { tools: { register, guard }, on, effect } as any
  return { ctx, register, guard, on, effect, disposers }
}

/** 该替身上被注册过的工具名（按注册顺序） */
function registeredNames(register: ReturnType<typeof mockCtx>['register']): string[] {
  return register.mock.calls.map((c) => (c[0] as { name: string }).name)
}

/**
 * 派发一条宿主事件。
 * 🔴 必须**广播给该事件的所有监听器**（宿主就是这么做的）：同一个事件名上还挂着
 *    `opencode-provider` ／ `deepseek-vision-patch` ／ `weixin-bridge` 的监听器 ⇒
 *    只挑"第一条"会让本用例取决于注册顺序（一个与需求无关的偶然量）。
 * ⚠️ 无关监听器抛错**吞掉**：本替身不是真宿主（没有 `ctx.settings` 等面），它们抛的是
 *    "替身不够保真"，与被测行为无关；被测行为由**断言**（注册了没有／注销器调没调）承载，
 *    我们的监听器若自己抛错，断言照样会红 ⇒ 吞掉不损失信号。
 */
function emit(ctx: { on: ReturnType<typeof vi.fn> }, event: string, ...args: unknown[]): void {
  for (const c of ctx.on.mock.calls) {
    if (c[0] !== event) continue
    try {
      ;(c[1] as (...a: unknown[]) => void)(...args)
    } catch {
      /* 无关监听器（见上） */
    }
  }
}

const FULL_CONFIG: Config = {
  tools: true,
  guards: true,
  serenityConfigPaths: [],
}

/**
 * 测试卫生（C4 块 A 顺带修复）：`apply` 会装配微信主动发送面，其 sync 读 **plugin 全局配置**
 * （`SERENITY_HOOKS_CONFIG` → 缺省 `~/.dsh/serenity-hooks.json`）。此前本文件没有隔离 ⇒
 * 每个用例都去**真绑生产端口 3082**：本机真插件在跑时是被占用（触发一次"启动失败"日志），
 * 不在跑时**测试会抢走生产端口**。现注入临时配置（面关闭）→ 不绑端口、无日志噪音。
 */
const prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG
let cfgDir: string

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'hooks-register-'))
  const cfgPath = join(cfgDir, 'serenity-hooks.json')
  // 面关（enabled:false）+ 端口 0：两份判据任一都足以关闭本面
  writeFileSync(cfgPath, JSON.stringify({ weixinApi: { enabled: false, port: 0 } }))
  process.env.SERENITY_HOOKS_CONFIG = cfgPath
})

afterEach(() => {
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  rmSync(cfgDir, { recursive: true, force: true })
})

describe('dsh-serenity-hooks: 插件契约（native cordis 规范）', () => {
  it('导出 name/inject/apply，无 default export', () => {
    expect(typeof name).toBe('string')
    expect(name).toBe('dsh-serenity-hooks')
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('apply 注册全部「具备的工具面」＝ REGISTERED_TOOLS 去掉开关注的 diagram（⛔ 不手写数字）', () => {
    const { ctx, register } = mockCtx()
    apply(ctx, FULL_CONFIG)
    // 🔴 **数字从 `REGISTERED_TOOLS` 推**（2026-11-06 修）：此前写死 11，
    //    加 `reconstruct` 后它红得对，但红的原因是"夹具过期"而不是"实现错了"——
    //    手写数字会随每次工具面变更变成噪音，而噪音会训练人"这条红了大概是夹具问题"。
    //    ⚠️ 判据强度不变：仍然是"注册数**恰好**等于该注册的那个集合"，多一个少一个都红。
    const expected = REGISTERED_TOOLS.filter((n) => n !== 'diagram')
    expect(register).toHaveBeenCalledTimes(expected.length)
    const names = register.mock.calls.map((c) => (c[0] as { name: string }).name)
    // 逐名对账（比数字更强：数字对而名字换了照样红）
    expect([...names].sort()).toEqual([...expected].sort())
    expect(names).toContain('container_fs')
    expect(names).toContain('cognitive_trajectory')
    expect(names).toContain('dashboard')
    expect(names).toContain('container_git')
    expect(names).toContain('msm')
    expect(names).toContain('praxis')
    expect(names).not.toContain('cheap-worker')
    expect(names).toContain('localstore')
    expect(names).toContain('container_admin')
    expect(names).toContain('im-bridge')
    // 🔒 v1.106.0 回归钉：acc-diag 已并入 dashboard diag ⇒ **不得**再有独立工具
    expect(names).not.toContain('acc-diag')
    expect(names).toContain('ontology')
    expect(names).toContain('serenity-skill-creator')
    // 🆕 v1.121.0：reconstruct 恒被 register（可见性由 `when` 判，**不靠不注册**）
    expect(names).toContain('reconstruct')
  })

  it('🆕 D104：diagram 工具按开关注册 —— 关（缺省）时**不注册**，开时**恰好多这一个**', () => {
    // 关（= 本文件的 FULL_CONFIG 不带 diagramEnabled）
    const off = mockCtx()
    apply(off.ctx, FULL_CONFIG)
    const offNames = off.register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(offNames).not.toContain('diagram')
    const withoutDiagram = REGISTERED_TOOLS.length - 1
    expect(off.register).toHaveBeenCalledTimes(withoutDiagram)
    // 开 ⇒ **多一个**（不是"多注册一遍全部"：总数恰好 +1 才算对）
    const on = mockCtx()
    apply(on.ctx, { ...FULL_CONFIG, diagramEnabled: true } as Config)
    const onNames = on.register.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(onNames).toContain('diagram')
    expect(on.register).toHaveBeenCalledTimes(withoutDiagram + 1)
  })

  /**
   * 🔴 v1.51.1 回归钉：**面板拨开关热生效**（owner 实测「我把开关开了，工具没出来」）。
   *
   * 根因（已复现）：宿主写配置**不重跑 `apply`**（铁证 = 插件重启才刷新"武装于"；
   * `cordis.patch.yml` 里 `diagramEnabled: true` 已落盘而工具没注册）⇒ 旧实现"apply 时判一次"
   * 等于**开关要重启才生效**。修法 = 听宿主的真事件 `settings/document-updated` ＋ 兜底事件，
   * 且**关的时候要注销**（不是"留着不响应"）。
   *
   * 本用例把这三件事钉死：① 拨开 ⇒ 当场注册；② 拨回 ⇒ **注销器被调用**；
   * ③ **别的命名空间**的写入不得把工具打出来（漏掉 ns 过滤会变成"任何设置写入都注册一次"）。
   */
  it('🆕 v1.51.1：diagram 开关**热生效** —— 拨开/拨回都当场生效，且只认本插件的命名空间', () => {
    // 🔴 数字一律从 `REGISTERED_TOOLS` 推（⛔ 不写死）：写死会让每次工具面变更都制造一条
    //    "夹具过期"的红，而那种红训练人忽视本用例 —— 它恰恰是**热生效**唯一的机械钉子。
    const base = REGISTERED_TOOLS.length - 1 // 初始态：diagram 关 ⇒ 比全表少一个
    const cfg: Config = { ...FULL_CONFIG, diagramEnabled: false }
    const { ctx, register, on, disposers } = mockCtx()
    apply(ctx, cfg)
    expect(registeredNames(register)).not.toContain('diagram') // 初始：关
    expect(register).toHaveBeenCalledTimes(base)

    // 宿主写了一份**新配置**（真宿主 = 换 `fiber.config`；本替身无 fiber ⇒ 源 = 我们注入的这份）
    let enabled = false
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), diagramEnabled: enabled }))
    try {
      // ③ 负控先行：**别的**命名空间写入 ⇒ 不得注册（ns 过滤若丢了，本条即红）
      emit(ctx, 'settings/document-updated', 'llm-pi-ai', 1)
      expect(registeredNames(register)).not.toContain('diagram')

      // ① 拨开 ⇒ 宿主发 settings/document-updated（ns = 我们那张设置页）⇒ 当场注册
      enabled = true
      emit(ctx, 'settings/document-updated', SERENITY_SETTINGS_NS, 2)
      expect(registeredNames(register)).toContain('diagram')
      expect(register).toHaveBeenCalledTimes(base + 1) // 只多这一个，不是"重注册一遍全部"

      // ② 拨回 ⇒ **注销**（工具从模型工具清单里消失，不是"留着但不响应"）
      const idx = registeredNames(register).indexOf('diagram')
      expect(disposers[idx]).toHaveBeenCalledTimes(0)
      enabled = false
      emit(ctx, 'settings/document-updated', SERENITY_SETTINGS_NS, 3)
      expect(disposers[idx]).toHaveBeenCalledTimes(1)

      // ①b 兜底通道：宿主事件面若换名，`session/created` 仍能把开关的最新值同步过来
      enabled = true
      emit(ctx, 'session/created')
      expect(registeredNames(register)).toHaveLength(base + 2) // 再一次注册（前一次已注销）⇒ 第二次同名注册
      expect(disposers[base + 1]).not.toBe(disposers[idx])
    } finally {
      __setSimpleSourceForTest(null) // 模块级源必须复位（跨用例泄漏会让别处的门控判据失真）
    }
  })

  it('apply 订阅拦截缝：tools/pre-execute + guard', () => {
    const { ctx, on, guard } = mockCtx()
    apply(ctx, FULL_CONFIG)
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).toContain('tools/pre-execute')
    expect(guard).toHaveBeenCalledTimes(1)
  })

  it('v1.30.8 F-08：apply 装配生命周期（agent/session disposed 订阅 + 各资源 ctx.effect 拆卸）', () => {
    const { ctx, on, effect } = mockCtx()
    apply(ctx, FULL_CONFIG)
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).toContain('agent/disposed')
    expect(events).toContain('session/disposed')
    // 自起资源各自登记拆卸：lifecycle 聚合资源（**含四个自起 HTTP 面**）/
    // opencode 路由自动配置的重试定时器（v1.31.7——命名空间竞态退避）/
    // cognitive trajectory 唤醒调度器（D58，v1.32.0——中心 tick + 冷唤醒投递）。
    // ⚠️ v1.35（C2 块 C3）：**轨迹约束 root 退避重试定时器已退场**（原 v1.30.13/D1 的第 7 项），故 7 → 6。
    // ⚠️ C4 块 A（2026-09-15）：**gateway 第二监听器**与**weixin send api** 两处自带 disposer 已删
    //    ——listener 生命周期归 `face-host`，拆卸路径归一到 lifecycle 的聚合入口（`stopAllFaces`）。
    //    故 6 → 4，且这两个标签从此**不应再现**（回归钉：删了就别让它悄悄回来）。
    // ⚠️ 2026-09-15（ACC 侧 autopilot 退场）：**autopilot 时钟 disposer 已删**，故 4 → 3；
    //    该标签从此**不应再现**（回归钉：整段删除的机制不得借拆卸登记悄悄复活）。
    // ⚠️ 2026-09-19（§26 §0x-9 DeepSeek 多模态临时补丁）：新增
    //    `deepseek vision patch retry timer`（与 opencode 路由自动配置同款"命名空间竞态退避"）
    //    ⇒ 3 → 4。**这是有意的登记**（F-08 纪律：自起资源必须各带拆卸），不是悄悄复活旧机制。
    // ⚠️ 2026-09-19（CRO，§7.8 `docs/cro-design.md`）：新增 `cro turn tracking`
    //    ——「是否正在跑轮次」是**进程级内存表**，载体销毁必须清项（该模块的头号风险
    //    就是本容器栽过 5 次的"只增不清"）⇒ **必须在拆卸时清表**，故计入本清单。
    //    ⇒ 4 → 5。
    // ⚠️ 2026-09-23（无人值守代理回复，S142 D77）：原新增 `unattended proxy` ⇒ 5 → 6。
    // 🔴 2026-10-18（v1.63.3，owner 裁「砍掉无人值守功能，整个砍掉」）：该缝整条退役
    //    ⇒ 拆卸清单少一项 ⇒ **6 → 5**。它的"进程级内存表"（代理段 + 用户轮次 + 出站账本）
    //    随模块一起消失 ⇒ 不再是拆卸对象。
    // ⚠️ 2026-11-01（v1.107.0，轨迹消息订阅）：新增 `trajectory subscriptions`
    //    ——它持有一张进程级内存表（会话 → 上一次观察到的 agent 状态，用于判 running→idle）
    //    ＋ 投递计数表 ⇒ **必须在拆卸时清**，否则同属"只增不清"病族。⇒ **5 → 6**。
    const labels = effect.mock.calls.map((c) => String(c[1]))
    expect(labels).toHaveLength(6)
    expect(labels.join('|')).not.toContain('autopilot')
    expect(labels.join('|')).toContain('认知轨迹唤醒调度器')
    expect(labels.join('|')).toContain('self-started resources')
    expect(labels.join('|')).toContain('opencode provider auto-config retry timer')
    expect(labels.join('|')).toContain('deepseek vision patch retry timer')
    expect(labels.join('|')).toContain('cro turn tracking')
    expect(labels.join('|')).toContain('trajectory subscriptions')
    // 退役回归钉：无人值守代理缝不得再被装配（删了就不要再悄悄回来）
    expect(labels.join('|')).not.toContain('unattended proxy')
    // 退避重试定时器不得再出现（回归钉：删了就不要再悄悄回来）
    expect(labels.join('|')).not.toContain('轨迹约束 root retry timer')
    // C4 块 A 回归钉：两处自带 listener disposer 已被单点取代
    expect(labels.join('|')).not.toContain('gateway 第二监听器')
    expect(labels.join('|')).not.toContain('weixin send api')
  })

  it('v1.30.8 F-08：ctx.effect 缺失 → 响亮降级不抛错（apply 不可成为启动单点）', () => {
    const { ctx, register } = mockCtx()
    delete (ctx as { effect?: unknown }).effect
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => apply(ctx, FULL_CONFIG)).not.toThrow()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ctx.effect 不可用'))).toBe(true)
    warn.mockRestore()
    expect(register).toHaveBeenCalledTimes(REGISTERED_TOOLS.length - 1) // 其余装配不受影响（diagram 关）
  })

  it('config 开关控制注册项', () => {
    const { ctx, register, on, guard } = mockCtx()
    apply(ctx, { ...FULL_CONFIG, tools: false, guards: false })
    expect(register).not.toHaveBeenCalled()
    expect(guard).not.toHaveBeenCalled()
    // bootstrap seam 无条件注册（直接默认开启，用户明确"不能关"）——全关时 on 仅含 bootstrap 事件
    const events = on.mock.calls.map((c) => c[0] as string)
    expect(events).not.toContain('tools/pre-execute')
    expect(events).toContain('session/event')
  })
})
