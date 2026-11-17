import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readTrajectoryConstraintAt,
  readTrajectoryConstraintByCode,
  listTrajectoryConstraints,
  findDirNameByCode,
  trajectoryConstraintForSession,
  TRAJECTORY_CONSTRAINT_FILENAME,
} from '../src/trajectory/policy/profile.js'
import { registerTrajectorySession, unregisterTrajectorySession, resetTrajectorySessions } from '../src/trajectory/policy/window.js'
import { trajectoryDirNameForSession } from '../src/trajectory/policy/window.js'
import { BIND_FILENAME } from '../src/trajectory/bind-file.js'

/**
 * 轨迹约束的唯一判据（owner 2026-10-19 重做令）：**目录下有 `trajectory-constraint.json` 的认知轨迹**。
 *
 * 本文件的判据重心（每条都对应一个真实的失败形态）：
 *  ① **J1 文件存在性**：无该文件 ⇒ null（不是 轨迹约束），且**不产生任何告警**（常态）；
 *  ② **缺省值语义**：`cognitiveTrajectory.*` 缺省为 **true**（工作台就是它自己的身体）；
 *  ③ **坏 JSON ⇒ 按普通轨迹处理 ＋ 响亮告警**（权限面不能带着半份读不懂的配置运行）；
 *  ④ **J2 会话判据两来源并取**：持久绑定窗口期由注册表兜（只取一个就有真 bug）。
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hooks-轨迹约束profile-'))
  writeFileSync(join(root, '.serenity'), 'test')
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  resetTrajectorySessions()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一条轨迹目录，可选写入约束面 */
function mkTraj(code: string, profile?: Record<string, unknown> | null): { dir: string; dirName: string } {
  const dirName = `2026-10-19--${code}--示例`
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), `# SESSION: ${code}\n`, 'utf-8')
  if (profile !== null && profile !== undefined) {
    writeFileSync(join(dir, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify(profile), 'utf-8')
  }
  return { dir, dirName }
}

describe('轨迹约束-profile: J1 —— 判据是「目录里有 trajectory-constraint.json」', () => {
  it('无该文件 ⇒ null（不是 轨迹约束，常态且**不告警**）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('plain')
    expect(readTrajectoryConstraintAt(dir, root)).toBeNull()
    expect(warn, '没有 trajectory-constraint.json 是常态 —— 不该产生任何告警').not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('有该文件 ⇒ 拿到约束面，且带出轨迹编码（身份 = 编码，不是角色名）', () => {
    const { dir, dirName } = mkTraj('my-role', { model: 'p/m', tools: ['read'], msms: ['x'] })
    const p = readTrajectoryConstraintAt(dir, root)
    expect(p).not.toBeNull()
    expect(p!.code).toBe('my-role')
    expect(p!.dirName).toBe(dirName)
    expect(p!.model).toBe('p/m')
    expect(p!.tools).toEqual(['read'])
    expect(p!.msms).toEqual(['x'])
    expect(p!.path.endsWith(TRAJECTORY_CONSTRAINT_FILENAME)).toBe(true)
  })

  it('🔴 删掉该文件 ⇒ 立刻不再判定为 轨迹约束（这是 owner 要的"自动"语义）', () => {
    const { dir } = mkTraj('toggle', { tools: ['read'] })
    expect(readTrajectoryConstraintAt(dir, root)).not.toBeNull()
    rmSync(join(dir, TRAJECTORY_CONSTRAINT_FILENAME))
    expect(readTrajectoryConstraintAt(dir, root)).toBeNull()
  })

  it('非本工具建的目录名（无日期前缀）⇒ 不解析（编码拿不到就不该当 轨迹约束）', () => {
    const dir = join(root, 'AGENT_SESSIONS', 'random-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, TRAJECTORY_CONSTRAINT_FILENAME), '{}', 'utf-8')
    expect(readTrajectoryConstraintAt(dir, root)).toBeNull()
  })
})

describe('轨迹约束-profile: 缺省值与容错', () => {
  it('🔴 cognitiveTrajectory 缺省全 true（工作台就是它自己的 SESSION.md）', () => {
    const { dir } = mkTraj('defaults', {})
    const p = readTrajectoryConstraintAt(dir, root)!
    expect(p.cognitiveTrajectory).toEqual({ session: true, keeper: true, rebuild: true })
  })

  it('显式 false 被尊重（逐项独立）', () => {
    const { dir } = mkTraj('partial', { cognitiveTrajectory: { keeper: false } })
    const p = readTrajectoryConstraintAt(dir, root)!
    expect(p.cognitiveTrajectory).toEqual({ session: true, keeper: false, rebuild: true })
  })

  it('数组里的非字符串项被丢弃（不整份作废）', () => {
    const { dir } = mkTraj('dirty', { tools: ['read', 42, '', null, 'grep'], msms: ['ok', {}] })
    const p = readTrajectoryConstraintAt(dir, root)!
    expect(p.tools).toEqual(['read', 'grep'])
    expect(p.msms).toEqual(['ok'])
  })

  it('model 空白 ⇒ undefined（⇒ 不动会话当前模型，不回退任何缺省）', () => {
    const { dir } = mkTraj('nomodel', { model: '   ' })
    expect(readTrajectoryConstraintAt(dir, root)!.model).toBeUndefined()
  })

  it('🔴 writes：缺省 ⇒ undefined（不收窄）、显式 [] ⇒ 保留空数组（判据是字段在不在）', () => {
    // 与 D181 同一条判据。归一成 `[]` 会把"我没想到写路径这件事"读成"我不许写任何东西"。
    const unset = mkTraj('writes-unset', { tools: ['read'] })
    expect(readTrajectoryConstraintAt(unset.dir, root)!.writes).toBeUndefined()

    const empty = mkTraj('writes-empty', { writes: [] })
    expect(readTrajectoryConstraintAt(empty.dir, root)!.writes).toEqual([])

    const filled = mkTraj('writes-filled', { writes: ['AGENT_SESSIONS/x/', '  _tmp/  '] })
    expect(readTrajectoryConstraintAt(filled.dir, root)!.writes).toEqual(['AGENT_SESSIONS/x/', '_tmp/'])
  })

  it('🔴 坏 JSON ⇒ null ＋ 响亮告警（不带着半份权限面运行）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('broken')
    writeFileSync(join(dir, TRAJECTORY_CONSTRAINT_FILENAME), '{ not json', 'utf-8')
    expect(readTrajectoryConstraintAt(dir, root)).toBeNull()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('解析失败'))).toBe(true)
    warn.mockRestore()
  })

  it('顶层是数组 ⇒ 同样按非 轨迹约束 处理（告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('arrayish')
    writeFileSync(join(dir, TRAJECTORY_CONSTRAINT_FILENAME), '[]', 'utf-8')
    expect(readTrajectoryConstraintAt(dir, root)).toBeNull()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('顶层不是对象'))).toBe(true)
    warn.mockRestore()
  })

  it('🔴 systemPromptFile 越界 ⇒ 只丢那一项，其余约束仍生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('escape', { systemPromptFile: '../../etc/passwd', tools: ['read'] })
    const p = readTrajectoryConstraintAt(dir, root)!
    expect(p.systemPromptFile).toBeUndefined()
    expect(p.tools, '其余约束不得因一个越界路径而失效').toEqual(['read'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('越界'))).toBe(true)
    warn.mockRestore()
  })
})

describe('轨迹约束-profile: 按编码 / 全量枚举', () => {
  it('findDirNameByCode 只做精确匹配（不做模糊 —— 路由要确定性）', () => {
    const { dirName } = mkTraj('exact')
    expect(findDirNameByCode(root, 'exact')).toBe(dirName)
    expect(findDirNameByCode(root, 'exa'), '前缀不算命中').toBeNull()
    expect(findDirNameByCode(root, 'EXACT'), '大小写敏感').toBeNull()
  })

  it('readTrajectoryConstraintByCode：命中 轨迹约束 / 普通轨迹返回 null', () => {
    mkTraj('withprofile', { tools: ['read'] })
    mkTraj('noprofile')
    expect(readTrajectoryConstraintByCode(root, 'withprofile')?.tools).toEqual(['read'])
    expect(readTrajectoryConstraintByCode(root, 'noprofile')).toBeNull()
    expect(readTrajectoryConstraintByCode(root, 'ghost')).toBeNull()
  })

  it('listTrajectoryConstraints：只列有 trajectory-constraint.json 的活跃轨迹（跳过 _ 前缀与无约束面者）', () => {
    mkTraj('a-profile', { tools: ['read'] })
    mkTraj('b-plain')
    // 归档区里的不算
    const arch = join(root, 'AGENT_SESSIONS', '_archived', '2026-01-01--old--x')
    mkdirSync(arch, { recursive: true })
    writeFileSync(join(arch, TRAJECTORY_CONSTRAINT_FILENAME), '{}', 'utf-8')
    expect(listTrajectoryConstraints(root).map((p) => p.code)).toEqual(['a-profile'])
  })

  it('无 AGENT_SESSIONS 目录 ⇒ 空数组（不抛）', () => {
    const bare = mkdtempSync(join(tmpdir(), 'hooks-bare-'))
    expect(listTrajectoryConstraints(bare)).toEqual([])
    expect(findDirNameByCode(bare, 'x')).toBeNull()
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('轨迹约束-profile: J2 —— 会话级判据（两来源并取）', () => {
  it('🔴 注册表已登记但持久绑定还没落盘（窗口期）⇒ 仍判为 轨迹约束', () => {
    const { dirName } = mkTraj('window', { tools: ['read'] })
    registerTrajectorySession('sess-window', dirName, root)
    // 不给 boundDirName（模拟"绑定还没落盘"）
    expect(trajectoryConstraintForSession(root, 'sess-window')?.code).toBe('window')
  })

  it('调用方已解析出绑定 ⇒ 直接用（不查注册表）', () => {
    const { dirName } = mkTraj('bound', { tools: ['read'] })
    expect(trajectoryConstraintForSession(root, 'sess-unregistered', dirName)?.code).toBe('bound')
  })

  it('都拿不到 ⇒ null（普通轨迹，零约束）', () => {
    mkTraj('nobody')
    expect(trajectoryConstraintForSession(root, 'sess-none')).toBeNull()
    expect(trajectoryConstraintForSession(root, undefined)).toBeNull()
    expect(trajectoryConstraintForSession(root, '')).toBeNull()
  })

  it('登记过但轨迹已被删/归档 ⇒ null（载体没了就不再是 轨迹约束，不静默沿用）', () => {
    const { dirName } = mkTraj('gone', { tools: ['read'] })
    registerTrajectorySession('sess-gone', dirName, root)
    rmSync(join(root, 'AGENT_SESSIONS', dirName), { recursive: true, force: true })
    expect(trajectoryConstraintForSession(root, 'sess-gone')).toBeNull()
  })

  it('解绑后 ⇒ null（不会挂着旧身份）', () => {
    const { dirName } = mkTraj('unbind', { tools: ['read'] })
    registerTrajectorySession('sess-unbind', dirName, root)
    expect(trajectoryConstraintForSession(root, 'sess-unbind')).not.toBeNull()
    unregisterTrajectorySession('sess-unbind')
    expect(trajectoryConstraintForSession(root, 'sess-unbind')).toBeNull()
  })

  it('轨迹存在但没有 trajectory-constraint.json ⇒ null（登记过也不是 轨迹约束）', () => {
    const { dirName } = mkTraj('plain-registered')
    registerTrajectorySession('sess-plain', dirName, root)
    expect(trajectoryConstraintForSession(root, 'sess-plain')).toBeNull()
  })

  /**
   * 🔴🔴 **2026-11-17 真机缺陷的回归钉（某条长期存活轨迹拿到白名单外的工具）**
   *
   * ## 这一格为什么此前从来没被测到
   * 上面六条用例**全部**走的是"内存已登记"或"调用方外部传了 boundDirName"。
   * 而本 bug 的真身**只在跨进程边界上出现**：宿主重启 ⇒ 内存 Map 清空 ⇒
   * 老会话没有任何路径重新登记（`registerTrajectorySession` 只在建/恢复轨迹会话时调）。
   * ⇒ **只造内存态的测试，永远抓不到它**（这正是 `D-16` 那类「改坏会红吗」的问题）。
   *
   * ## 状态怎么表达
   * · **内存里没有** —— 不调 `registerTrajectorySession`（并且 `beforeEach` 已 `resetTrajectorySessions()`）；
   * · **但持久绑定在** —— 真写一份 `current.dsh_session_bind` 到轨迹目录（D172 的真相源形态）。
   * 两者同时成立 = 重启后的真实形态。
   *
   * ## 变异判据
   * 删掉 `resolveDirNameForSession` 里的 ② 持久绑定回落 ⇒ 本用例**精确红**（返回 null）。
   */
  it('🔴 内存无登记 + 持久绑定在（= 宿主重启后的真实形态）⇒ **仍判为 轨迹约束**', () => {
    const { dirName, dir } = mkTraj('restarted', { tools: ['read'], writes: ['_tmp/'] })
    // 只写持久绑定，⛔ 不登记内存 —— 模拟"进程重启过、这条老会话没被重新登记"
    writeFileSync(
      join(dir, BIND_FILENAME),
      JSON.stringify({ version: 1, sessionId: 'sess-restarted', dirName, action: 'activate' }),
      'utf-8',
    )
    // 正控：内存确实是空的（否则本用例会在"内存已登记"这条岔路上假绿）
    expect(trajectoryDirNameForSession('sess-restarted')).toBeNull()
    const p = trajectoryConstraintForSession(root, 'sess-restarted')
    expect(p, '重启后必须靠持久绑定认出归属，否则白名单整个静默失效').not.toBeNull()
    expect(p!.code).toBe('restarted')
    // 两个白名单都要回来（tools 与 writes 同一条判断链 ⇒ 必须一起验）
    expect(p!.tools).toEqual(['read'])
    expect(p!.writes).toEqual(['_tmp/'])
  })

  it('🔴 配对反控：持久绑定指向**别的** sessionId ⇒ 本会话仍判 null（不串味）', () => {
    const { dirName, dir } = mkTraj('otherholder', { tools: ['read'] })
    writeFileSync(
      join(dir, BIND_FILENAME),
      JSON.stringify({ version: 1, sessionId: 'someone-else', dirName, action: 'activate' }),
      'utf-8',
    )
    expect(trajectoryConstraintForSession(root, 'sess-not-me')).toBeNull()
  })
})
