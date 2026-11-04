/**
 * container-admin.test.ts — container_admin（v1.30 机务舱：容器管理面统一入口）
 *
 * 覆盖：domain 路由（config/msm）、config 的两层说明菜单（P3）、轨迹约束四动作（P4 并入 config）、
 * msm 管理 action 转发、轨迹约束会话 register/deregister 拒绝。
 *
 * ## 结构变化史（留着，因为每一条都对应一次"门禁全绿也抓不到"的教训）
 * - v1.34.1：工具由 `export const containerAdminTool` 改为工厂 `createContainerAdminTool(ctx)`
 * - 2026-09-15：**autopilot 域整段退场**（ACC 侧 autopilot 删除）⇒ 该域一组用例整组删除
 * - **2026-10-19：`role` 域并入 `config`**（owner 裁「1 并入」）⇒ 本文件三处靶同批改：
 *   ① enum 从 `['role','msm','config']` → `['config','msm']`；
 *   ② 拒绝文案从 `domain: role | msm | config` → `domain: config | msm`；
 *   ③ `role` 四动作改走 `config`，且**旧别名必须仍可用**（存量 CCC 文档/脚本 30 处引用它）。
 *
 * 🔴 **别名为什么必须有判据**（不是顺手加的兼容）：本仓实测有 30 处 `container_admin role ...`
 * 的活引用（SESSION/文档/CCC 手册）。硬切会让它们全部"未知域"，而**没有任何机械信号**
 * 会告诉我们"哪份文档已经说谎了"（D151 同族）。⇒ 别名 + 一条钉住它的用例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

/**
 * 部分 mock：只替换 `runMsm`，其余导出走真模块。
 *
 * 🔴 **必须是 async 工厂 + `await importActual`**（2026-10-19 实测）：原先写
 * `const actual = vi.importActual(...)` 然后 `...actual` —— `importActual` 返回的是
 * **Promise**，展开 Promise 得到的是**空对象**（不报错）。此前只是因为测试只用到
 * `runMsm`（被显式覆盖）所以看不出来；一旦依赖别的导出（如 `CCC_CONFIG_REFERENCE`
 * 作菜单章节正文）就当场炸成 "No ... export is defined on the mock"。
 * ⇒ 判据：**部分 mock 里凡是 `...actual`，工厂就必须 async 且 `await` 过它**。
 */
vi.mock('../src/tools/msm/service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/tools/msm/service.js')>('../src/tools/msm/service.js')
  return {
    ...actual,
    runMsm: vi.fn((root: string, args: { action: string }) => ({ action: args.action, root })),
  }
})

import { createContainerAdminTool } from '../src/tools/container-admin.js'
import { runMsm } from '../src/tools/msm/service.js'
import { MANUALS } from '../src/tools/manuals.js'

const mockRunMsm = vi.mocked(runMsm)

/** 工具对象在测试里是 defineTool 的透传形态（工厂返回） */
const containerAdminTool = createContainerAdminTool({ get: () => undefined } as never) as {
  name: string
  parameters: Record<string, { enum?: string[]; [k: string]: unknown }>
  execute: (a: unknown, e: unknown) => Promise<unknown>
}

/** 统一调用入口 */
function exec(args: unknown, cwd = tmp): Promise<unknown> {
  return containerAdminTool.execute(args, { agent: { session: { header: { cwd } } } })
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ca-'))
  mockRunMsm.mockReset()
  // CCC 标记
  writeFileSync(join(tmp, '.serenity'), 'container-admin-test\n')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function execWith(cwd = tmp): unknown {
  return { agent: { session: { header: { cwd } } } }
}

describe('container_admin：domain 路由（v1.30 机务舱）', () => {
  it('工具名 = container_admin；参数含 domain/action/chapter', () => {
    expect(containerAdminTool).toMatchObject({ name: 'container_admin' })
    const params = containerAdminTool.parameters
    expect(params.domain).toBeDefined()
    expect(params.action).toBeDefined()
    // P3 第二层菜单参数
    expect(params.chapter).toBeDefined()
  })

  it('🔒 domain enum 恰为 config/msm（`role` 已并入 config；autopilot 已退场，均不得复活）', () => {
    expect(containerAdminTool.parameters.domain.enum).toEqual(['config', 'msm'])
    // `role` 是别名，**不进 enum**（文案不教它），但必须仍能用（下一条用例钉住）
    expect(containerAdminTool.parameters.domain.enum).not.toContain('role')
  })

  it('🔴 旧 `role` 域仍可用（过渡别名 → config），且三动作全部可达', async () => {
    // 本仓 30 处存量引用 `container_admin role ...` ⇒ 硬切会让它们静默失效
    await expect(exec({ domain: 'role', action: 'list' })).resolves.toMatchObject({ roles: [] })
    await expect(exec({ domain: 'role', action: 'validate' })).resolves.toMatchObject({ ok: true })
    await expect(exec({ domain: 'role', action: 'guide' })).resolves.toMatchObject({ guide: expect.any(String) })
  })

  it('config list → 轨迹约束摘要（无轨迹 → 空数组）', async () => {
    const res = await containerAdminTool.execute({ domain: 'config', action: 'list' }, execWith())
    expect(res).toMatchObject({ roles: [] })
  })

  it('config validate → 无轨迹时 ok:true + 计数 0', async () => {
    const res = await containerAdminTool.execute({ domain: 'config', action: 'validate' }, execWith())
    expect(res).toMatchObject({ ok: true, constraintCount: 0 })
  })

  it('config guide → 返回轨迹约束教程（非空）', async () => {
    const res = await containerAdminTool.execute({ domain: 'config', action: 'guide' }, execWith())
    expect(res).toMatchObject({ guide: expect.any(String) })
  })

  it('msm register → 转发 runMsm 且带业务参数', async () => {
    mockRunMsm.mockImplementation(((root: string, args: { action: string }) => ({ action: args.action, root, ok: true })) as never)
    const res = await containerAdminTool.execute(
      { domain: 'msm', action: 'register', name: 'my-tool', path: 'scripts/my-tool.ts', category: 'mech', description: 'test tool' },
      execWith(),
    )
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'register', name: 'my-tool' }))
    expect(res).toBeTruthy()
  })

  it('msm catalog → 转发 runMsm action=catalog', async () => {
    await containerAdminTool.execute({ domain: 'msm', action: 'catalog' }, execWith())
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'catalog' }))
  })

  it('msm 域不接受 exec（执行走 msm 工具）', async () => {
    await expect(
      containerAdminTool.execute({ domain: 'msm', action: 'exec', name: 'x' }, execWith()),
    ).rejects.toThrow(/execution goes through the msm tool/)
  })

  /**
   * 🔴 **2026-10-19 v1.75.0：`config view` 不再转发 `ccc-config`（那会返回整份说明正文）**。
   *
   * 它现在回答的是「**你这个 CCC 现在填了什么**」—— 与 `docs config` 的
   * 「**这个键该怎么填**」分工。两件事本来就不该共用一个动作。
   */
  it('config view → 现值摘要（不再转发 ccc-config 的说明正文）', async () => {
    // 🔴 `.opencode/` 在临时 CCC 里还不存在 ⇒ 必须先建目录，否则 writeFileSync 直接 ENOENT
    mkdirSync(join(tmp, '.opencode'), { recursive: true })
    writeFileSync(join(tmp, '.opencode', 'serenity.json'), JSON.stringify({ cheapWorker: { models: ['a/b'] } }))
    const res = (await containerAdminTool.execute({ domain: 'config', action: 'view' }, execWith())) as {
      config: { cccRoot: string; sections: string[]; note: string }
      docs: string
    }
    expect(res.config.cccRoot).toBe(tmp)
    expect(Array.isArray(res.config.sections)).toBe(true)
    // 指路：怎么填看 docs config
    expect(res.docs).toContain('config docs config')
    // 🔴 反向钉：**不再调用 runMsm 取说明正文**
    expect(mockRunMsm).not.toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'ccc-config' }))
  })

  it('config 无 action → 按 view 处理（向后兼容旧的 `{domain:"config"}` 调用）', async () => {
    const res = (await containerAdminTool.execute({ domain: 'config' }, execWith())) as { config: { cccRoot: string } }
    expect(res.config.cccRoot).toBe(tmp)
  })

  it('非法 domain → 拒绝（文案只列新名）', async () => {
    await expect(containerAdminTool.execute({ domain: 'nope' }, execWith())).rejects.toThrow(
      /domain: config \| msm/,
    )
  })

  it('🔒 已删除的 domain 不得复活：autopilot 一律拒绝（不派发任何实现）', async () => {
    await expect(exec({ domain: 'autopilot', action: 'status' })).rejects.toThrow(
      /domain: config \| msm/,
    )
  })

  it('非 CCC（无 .serenity）→ 拒绝', async () => {
    await expect(
      containerAdminTool.execute({ domain: 'config', action: 'list' }, { agent: { session: { header: { cwd: '/tmp' } } } }),
    ).rejects.toThrow(/No CCC found/)
  })
})

/**
 * P3：两层说明菜单（owner 原话「一个是使用说明目录，一个是使用说明详情（按章节获得）」）。
 *
 * 🔴 核心判据不是"能返回东西"，而是**目录与详情是两个不同大小的东西**：
 * 目录若把正文也带上，两层菜单就退化成一份长文（那就等于没做）。
 */
describe('config docs：两层说明菜单（P3）', () => {
  it('第一层：无 chapter ⇒ 目录，且列出全部章节 id', async () => {
    const res = (await exec({ domain: 'config', action: 'docs' })) as { docs: string; chapters: string[] }
    // v1.75.0：catalog 从 msm 域并进来（它描述整个 ACC，挂在 MSM 注册表下是域挂错了）
    // 2026-10-20：新增 `trajectory-self`（owner：「这是认知轨迹感知理解这些边界的重要手册」）
    //   ⇒ 拆章判据 = 描述自己（所有轨迹） vs 限制自己（特例），两者读者不同、不该同居一章。
    // 2026-10-22：新增 `im-bridge`（owner：「ACC 没提供 IM 桥使用说明…导致 CCC 没办法自己配路由」）
    //   ⇒ 同一条判据的第二次应用：读者是 **CCC 的 agent、手边工具是 im-bridge**，
    //     而不是"写自我声明的轨迹"。⛔ 不是把断言放宽 —— 集合相等仍然精确，只是成员变了。
    //
    // 🔴🔴 2026-11-04（owner：「手册架构也不好，导致你老是忘更新」）—— **本断言改了判据形态**：
    //   旧写法把 5 个 id **逐字写死**，于是「加一章」必然要改这里（这就是"加一章改四处"的第三处）。
    //   ⇒ 现在改成**与登记表对读**：索引必须列出 `MANUALS` 里的**全部** id，且**不多一个不少一个**。
    //   ⚠️ 这不是放宽（D274）：旧的精确列表是为了防"索引漏章"，**本意原样保留且更强** ——
    //      旧断言只能钉住"当时那 5 个"，新断言能钉住"任意时刻的全部"，且不必人工同步。
    //      真正被禁掉的行为（索引少一个／多一个）仍然精确红。
    expect(res.chapters).toEqual(MANUALS.map((m) => m.id))
    // 反向：三份 2026-11-04 才收进索引的游离手册**必须在场**（防回退到"只管自己域"）
    for (const id of ['msm', 'cro', 'skill-authoring']) expect(res.chapters).toContain(id)
    expect(res.docs).toContain('CCC 手册目录')
    // 目录里每一章都有一句话
    expect(res.docs).toContain('config')
    expect(res.docs).toContain('trajectory-self')
    expect(res.docs).toContain('trajectory-constraint')
  })

  it('🔴 目录必须显著短于详情（否则"两层"名不副实）', async () => {
    const index = (await exec({ domain: 'config', action: 'docs' })) as { docs: string }
    const detail = (await exec({ domain: 'config', action: 'docs', chapter: 'config' })) as { docs: string }
    // 目录只索引不复制 ⇒ 体量必须小一个量级以上
    expect(index.docs.length).toBeLessThan(detail.docs.length / 5)
  })

  it('第二层：给 chapter ⇒ 该章全文（config 章 = CCC 配置参考全文）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'config' })) as { chapter: string; docs: string }
    expect(res.chapter).toBe('config')
    expect(res.docs).toContain('CCC Configuration Reference')
    // 关键段落必须在（证明是真全文，不是摘要）
    expect(res.docs).toContain('exclusiveTools')
  })

  it('第二层：trajectory-constraint 章 = 限制面全文（并指路自述章，不复制）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'trajectory-constraint' })) as { docs: string }
    // 2026-10-20 拆章后标题变了 —— 断言改成钉**新**载体里逐字存在的串（D133：钉新载体，不钉旧标题）
    expect(res.docs).toContain('限制面')
    // 🔴 反向钉：描述面的内容必须**不在这里**（一个内容一个正文入口）
    expect(res.docs).not.toContain('── PROMPT.md：我的章程')
    // 但它必须**指路**（拆章不是藏起来）
    expect(res.docs).toContain('config docs trajectory-self')
  })

  /**
   * 🔴 新章 `trajectory-self` 的判据（2026-10-20 owner：「这是认知轨迹感知理解这些边界的重要手册」）。
   *
   * 为什么这条必须有：这份手册此前**藏在与"限制自己"同一章里**，而普通轨迹不会去读那一章
   * ⇒ 「怎么写章程 / 怎么声明常驻」在事实上不可发现。判据要钉住**三件自设都在**，
   * 而不只是"这章能返回东西"。
   */
  it('🔴 第二层：trajectory-self 章 —— 三种自我描述（章程／常驻／约束）齐备且各自可辨', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'trajectory-self' })) as { chapter: string; docs: string }
    expect(res.chapter).toBe('trajectory-self')
    // ① 章程
    expect(res.docs).toContain('PROMPT.md：我的章程')
    // ② 常驻 —— 必须带字段名与语义，且**先排除"资源状态"这个误解**
    expect(res.docs).toContain('resident')
    expect(res.docs).toContain('serves')
    expect(res.docs).toContain('不是资源状态')
    // ③ 限制面只指路不复制
    expect(res.docs).toContain('config docs trajectory-constraint')
    expect(res.docs).not.toContain('Two whitelists, both default-deny')
    // ④ 三个载体都点名（想改哪件事 → 写哪个文件）
    for (const f of ['SESSION.md', 'PROMPT.md', 'trajectory.json']) expect(res.docs).toContain(f)
    // ⑤ 写完怎么验（判据比描述重要）
    expect(res.docs).toContain('config validate')
  })

  /**
   * 🔴 **能力目录正文的验证落点**（2026-10-19 v1.75.0 从 `acc-extras.test.ts` 迁来）。
   *
   * 迁移原因：`msm catalog` 降为指针后，那份正文**只在** `docs catalog` 这一章可达。
   * ⇒ 若不放这里，全仓就**没有一处**在验"目录正文还对不对" —— 那是静默的覆盖退化。
   * （本条的存在本身就是"指针化不许降低覆盖"的判据。）
   */
  it('第二层：catalog 章 = ACC 能力目录全文（7 分区 ＋ 各功能指路）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'catalog' })) as { docs: string }
    expect(res.docs).toContain('ACC Usage Catalog')
    // 7 个能力分区（④ 于 2026-10-19 更名：role 域并入 config）
    for (const area of ['轨迹本体', '认知质量框架', '工具与执行', '轨迹约束与对外面', '自主与接入', 'CCC 配置总览', '注册表与安全']) {
      expect(res.docs).toContain(area)
    }
    // 🔴 目录不得再教旧域名（`role` 已并入 `config`）
    expect(res.docs).not.toContain('container_admin role')
    // 各详细入口指引（目录指向各功能，不复制全文）
    expect(res.docs).toContain('container_admin')
    expect(res.docs).toContain('cognitive_trajectory')
    expect(res.docs).toContain('weixin-doctor')
    // 🔴 2026-10-28：cheap-worker 下线后目录里不得再出现它
    expect(res.docs).not.toContain('cheap-worker')
    // 单一真相源声明
    expect(res.docs).toContain('only points')
  })

  /**
   * 🔴 **指针化的机械判据**（owner 裁 Q3 的核心）：旧入口**不得再返回正文**。
   * 反向断言比正向更难造假 —— 它直接钉住"同一份正文只有一处可达"。
   */
  it('🔴 config guide 只指路、不回正文（正文唯一入口 = docs trajectory-constraint）', async () => {
    const guide = (await exec({ domain: 'config', action: 'guide' })) as { guide: string }
    expect(guide.guide).toContain('container_admin config docs trajectory-constraint')
    // 反向钉：教程正文不再从这里出去（钉正文里一个逐字存在的串，不是标题——标题会随改版变）
    expect(guide.guide).not.toContain('A 轨迹约束 IS a cognitive trajectory')
  })

  it('章节名大小写不敏感（「我打错大小写」不该变成"没有这章"）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'CONFIG' })) as { chapter: string }
    expect(res.chapter).toBe('config')
  })

  it('🔴 未知章节 → 拒绝且**带候选清单**（"不知道这章"≠"这章是空的"）', async () => {
    // 2026-11-04：候选清单里必须含**新收进索引的章**（否则错误提示会指向一份过时的章目）
    await expect(exec({ domain: 'config', action: 'docs', chapter: 'nope' })).rejects.toThrow(
      /unknown chapter "nope"[\s\S]*Available: catalog \| config \| trajectory-self \| trajectory-constraint/,
    )
    await expect(exec({ domain: 'config', action: 'docs', chapter: 'nope' })).rejects.toThrow(/skill-authoring/)
  })

  it('🔴 白空格章节 ⇒ 按"没给"处理（返回目录，不是报错）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: '   ' })) as { chapters: string[] }
    // 2026-11-04：改与登记表对读（同第一条用例的判据变更，此处不再重复注释）
    expect(res.chapters).toEqual(MANUALS.map((m) => m.id))
  })
})
