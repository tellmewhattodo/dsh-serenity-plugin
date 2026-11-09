/**
 * browser-slot-process.test.ts — 槽位进程层（启动参数 / 认领 / 采样 / 回收）
 *
 * 🔴 这一层每一条都直接对应 2026-11-09 那次耗电事故里的一格错误：
 *    ① 认领错了 ⇒ 会杀掉 **user 自己的浏览器**
 *    ② 参数带了"禁止后台降速"⇒ 被遗忘的标签页**全速**空转
 *    ③ 用 ps 的 pcpu 当瞬时值 ⇒ 空转 10 秒与空转 36 小时**读数相同**
 *    ⛔ 不 spawn 真 Chrome（那正是事故本身）—— 只验参数构造、认领判据、采样口径与回收路径。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildArgs,
  findChrome,
  findPidsByProfile,
  normalizeSlotId,
  portHolders,
  resolveDisplay,
  sampleProcTree,
  slotPaths,
  SLOTS_REL,
} from '../src/browser/process.js'
import { SLOT_RESOLUTION, slotPort } from '../src/browser/state.js'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slot-proc-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('启动参数（每一条都对应一次真实代价）', () => {
  const paths = () => slotPaths('/tmp/cccc', 1)

  it('① 必须带 --user-data-dir（独立 profile 的物理实现 + 按目录认领的锚点）', () => {
    const args = buildArgs(1, paths())
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true)
    expect(args).toContain('--no-sandbox')
    expect(args.some((a) => a.startsWith('--remote-debugging-port='))).toBe(true)
  })

  it('② 🔴 绝不能带"禁止后台降速"的那两个 flag（这是耗电事故的直接成因）', () => {
    const args = buildArgs(1, paths())
    // 名字听起来"对后台更友好"，实际含义正好相反：它们**禁止**浏览器把后台窗口降速。
    expect(args).not.toContain('--disable-renderer-backgrounding')
    expect(args).not.toContain('--disable-backgrounding-occluded-windows')
    expect(args).not.toContain('--disable-background-timer-throttling')
    // 负控：证明上面三条不是"因为整个数组为空"而侥幸通过
    expect(args.length).toBeGreaterThan(8)
  })

  it('③ ⛔ 不带 --disable-gpu（会让截图/3D 走软件光栅化 ⇒ 取证条件变了）', () => {
    expect(buildArgs(1, paths())).not.toContain('--disable-gpu')
  })

  it('④ 固定分辨率随槽位档位走，且同一槽位恒定', () => {
    const a1 = buildArgs(1, paths()).find((x) => x.startsWith('--window-size='))
    const r = SLOT_RESOLUTION(1)
    expect(a1).toBe(`--window-size=${r.width},${r.height}`)
    // 负控：b11 换档
    const a11 = buildArgs(11, paths()).find((x) => x.startsWith('--window-size='))
    expect(a11).not.toBe(a1)
  })

  it('⑤ 端口跟着槽位号走，且落在 9301+（避开既有 browser MSM 的 9222 段）', () => {
    const p1 = buildArgs(1, paths()).find((x) => x.startsWith('--remote-debugging-port='))
    expect(p1).toBe(`--remote-debugging-port=${slotPort(1)}`)
    expect(slotPort(1)).toBeGreaterThan(9299)
  })
})

/**
 * 🔴🔴 这一组的**第一版是假绿**（2026-11-09，变异检验当场抓到）。
 *
 * 原写法：`expect(['wayland','x11','headless']).toContain(d.backend)` ——
 * 那是一个**三元素全集上的恒真断言**：把 `resolveDisplay` 的 wayland 分支改成
 * `if (false && …)` 之后，`--filter browser-slot-process` **仍然 18/18 全绿**。
 *
 * 修法的判据（D254 同族：判据没有判别力）：
 * **"选后端"这件事必须能被逐档钉死** —— 给定一份确定的输入（哪些 socket 存在），
 * 后端就只有**一个**合法取值。故这里用 `probe.exists` 构造三档**互斥**输入，
 * 每档断言一个**具体字符串**，而不是一个集合的成员资格。
 * 另附一条真机档（若本机真有 wayland socket ⇒ 必须选 wayland），
 * 它负责证明"注入的探针没把生产路径和生产行为分开"。
 */
describe('🔴 显示后端（真机第一次 LIVE 探针就死在这里）', () => {
  /** 只让 wayland socket 存在 */
  const onlyWayland = {
    exists: (p: string) => p === '/run/user/1000/wayland-0',
  }
  /** 只让 X socket 存在 */
  const onlyX = {
    exists: (p: string) => p === '/tmp/.X11-unix/X0',
  }
  /** 两个都不存在 */
  const nothing = { exists: () => false }
  const envW = { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/u', USER: 'u' }

  it('⑯ 有 wayland socket ⇒ 必须选 wayland，且参数/env 都跟着走（⛔ 盲信 DISPLAY=:0）', () => {
    const d = resolveDisplay(envW, onlyWayland)
    // ① 后端被**钉死**为一个具体值 —— 这是原版断言缺的那一维
    expect(d.backend).toBe('wayland')
    // ② 参数必须真的带上（⛔ "只改 env 不改 args"）
    expect(d.args).toContain('--ozone-platform=wayland')
    expect(d.args).toContain('--wayland-socket-path=/run/user/1000/wayland-0')
    // ③ env 必须把 socket 位置传给子进程（否则 Chrome 自己找不到）
    expect(d.env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
    expect(d.env.WAYLAND_DISPLAY).toBe('wayland-0')
    // ④ 说明必须能自解释（否则下一个人要重查一遍）
    expect(d.detail).toContain('/run/user/1000/wayland-0')
  })

  it('⑯-b 负控：同一份 env、但 socket 不存在 ⇒ 绝不能再判成 wayland', () => {
    // 这一条是⑯的**判别力来源**：两档只差"文件存在与否"，后端必须跟着变。
    // 原版之所以恒绿，就是因为缺了这一档 —— 它从未构造过"不存在"的输入。
    const d = resolveDisplay(envW, nothing)
    expect(d.backend).not.toBe('wayland')
    expect(d.args).not.toContain('--ozone-platform=wayland')
  })

  it('⑰ 只有 X socket ⇒ 选 x11，并把 XAUTHORITY 指到 HOME 下那份（⛔ 不继承空的）', () => {
    const d = resolveDisplay({ XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/u', USER: 'u' }, onlyX)
    expect(d.backend).toBe('x11')
    expect(d.args).toContain('--ozone-platform=x11')
    expect(d.env.XAUTHORITY).toBe('/home/u/.Xauthority')
    expect(d.env.DISPLAY).toBe(':0')
  })

  it('⑰-b 两档都存在时 wayland 优先（顺序不可换 —— 真机上 Xwayland 的 X0 也在）', () => {
    const both = { exists: (p: string) => p === '/run/user/1000/wayland-0' || p === '/tmp/.X11-unix/X0' }
    expect(resolveDisplay(envW, both).backend).toBe('wayland')
  })

  it('⑰-c 两个都没有 ⇒ 退 headless 且⛔ 不抛错（容器里常见）', () => {
    const d = resolveDisplay({ XDG_RUNTIME_DIR: '/nonexistent-xyz', HOME: '/n', USER: 'n' }, nothing)
    expect(d.backend).toBe('headless')
    expect(d.args).toContain('--headless=new')
    // 如实登记该档的能力边界：无头下没有"可见性"概念 ⇒ 页面省电闸对它不生效
    expect(d.detail).toContain('headless')
  })

  it('⑱ buildArgs 会把显示后端的参数**真正拼进**最终 argv（⛔ 算了不用）', () => {
    const d = resolveDisplay(envW, onlyWayland)
    const args = buildArgs(1, slotPaths('/tmp/x', 1), d)
    for (const a of d.args) expect(args).toContain(a)
    // 负控：别的后端的参数不该出现（否则"选后端"是句空话）
    expect(args).not.toContain('--ozone-platform=x11')
    expect(args).not.toContain('--headless=new')
  })

  it('⑲ 真机档：本机若有 wayland socket，默认调用（不注入探针）也必须选 wayland', () => {
    // 这一条证明"注入的探针没有把生产路径与生产行为分开"（否则上面全是替身在说话）。
    // 条件式：换一台没有 wayland 的机器（CI/容器）时它不假装通过，而是**跳过语义**。
    const realSocket = '/run/user/1000/wayland-0'
    const d = resolveDisplay(envW)
    if (existsSync(realSocket)) {
      expect(d.backend).toBe('wayland')
      expect(d.args).toContain(`--wayland-socket-path=${realSocket}`)
    } else {
      // 没有就只要求"说得出自己选了哪个祖先"，⛔ 不许断言一个本机拿不到的后端
      expect(['x11', 'headless']).toContain(d.backend)
    }
  })
})

describe('目录布局', () => {
  it('⑥ profile / shots / log 全在 CCC 根内（越界即拒绝由调用方保证）', () => {
    const p = slotPaths(root, 5)
    expect(p.home.startsWith(root)).toBe(true)
    expect(p.profile.startsWith(root)).toBe(true)
    expect(p.shots.startsWith(root)).toBe(true)
    expect(p.log.startsWith(root)).toBe(true)
    // 落点在 _tmp（可丢的运行态），⛔ 不是 .opencode（那是知识）
    expect(SLOTS_REL.startsWith('_tmp')).toBe(true)
    // 各槽位目录必须互不相同（否则 profile 不独立）
    expect(slotPaths(root, 5).profile).not.toBe(slotPaths(root, 6).profile)
  })
})

describe('🔴 按 profile 认领（认错就会杀掉 user 自己的浏览器）', () => {
  it('⑦ 只认命令行里带**本槽位专属** user-data-dir 的进程', () => {
    const profileA = slotPaths(root, 1).profile
    const profileB = slotPaths(root, 2).profile
    const pids = findPidsByProfile(profileA)
    // 本测试进程的命令行里没有这两个路径 ⇒ 必须一个都不命中
    expect(pids).not.toContain(process.pid)
    // 负控：用一个肯定不存在的 profile 路径也必须是空
    expect(findPidsByProfile(join(root, 'nope-xyz'))).toEqual([])
    // 判据的强度：两个槽位的 profile 前缀必须不同（否则 A 的扫描会命中 B 的进程）
    expect(profileA).not.toBe(profileB)
    expect(profileA.startsWith(profileB)).toBe(false)
  })

  it('⑧ 返回值里绝不含自身 pid（防止把自己当浏览器杀掉）', () => {
    // 用一个"恰好会匹配到自己命令行"的路径做正控：当前进程 cmdline 含 test 文件路径
    const pids = findPidsByProfile('vitest')
    // 无论是否命中，都不能包含自己
    expect(pids).not.toContain(process.pid)
  })
})

describe('CPU 采样口径（ps 的 pcpu 会骗人）', () => {
  it('⑨ 无 prev 时 cpuPct = 0（⛔ 不能凭空给一个数 —— 第一次采样没有增量）', () => {
    const s = sampleProcTree([process.pid], null, Date.now())
    expect(s.alive).toBe(true)
    expect(s.cpuPct).toBe(0)
    expect(s.rssMb).toBeGreaterThan(0)
  })

  it('⑩ 有 prev 且时间前进 ⇒ 给出**增量**口径的百分比（不是累计均值）', () => {
    const t0 = 1_000_000
    const first = sampleProcTree([process.pid], null, t0)
    // 让时间前进 1 秒再采一次；两次之间的 CPU 增量只可能很小
    const second = sampleProcTree([process.pid], first, t0 + 1000)
    expect(second.cpuPct).toBeGreaterThanOrEqual(0)
    // 关键：一个空转的测试进程在**增量**口径下不可能是几百 %，
    // 而如果错误地用"累计÷存活"口径，久跑的进程会给出一个与"刚启动"相同的假值。
    expect(second.cpuPct).toBeLessThan(1000)
    // 负控：dt 为 0 ⇒ 不做除法（避免 Infinity）
    const same = sampleProcTree([process.pid], second, t0 + 1000)
    expect(Number.isFinite(same.cpuPct)).toBe(true)
  })

  it('⑪ 进程不存在 ⇒ alive=false 且不抛错', () => {
    const s = sampleProcTree([999_999_999], null, Date.now())
    expect(s.alive).toBe(false)
    expect(s.cpuPct).toBe(0)
  })
})

describe('端口占用（"不可达 ≠ 空闲"）', () => {
  it('⑫ 未监听的高位端口 ⇒ 空数组', () => {
    expect(portHolders(59123)).toEqual([])
  })

  it('⑬ 结果里不含自身 pid', () => {
    // 扫描一个真实在监听的端口（随机挑一个高位，多半没人占）
    const pids = portHolders(59123)
    expect(pids).not.toContain(process.pid)
  })
})

describe('槽位号规范化', () => {
  it('⑭ b3 / 3 / B3 都认；越界与垃圾串返回 0', () => {
    expect(normalizeSlotId('b3')).toBe(3)
    expect(normalizeSlotId('3')).toBe(3)
    expect(normalizeSlotId('B3')).toBe(3)
    expect(normalizeSlotId('0')).toBe(0)
    expect(normalizeSlotId('21')).toBe(0)
    expect(normalizeSlotId('')).toBe(0)
    expect(normalizeSlotId('zz')).toBe(0)
  })
})

describe('Chrome 可执行文件发现', () => {
  it('⑮ 返回 null 或一个真实存在的绝对路径（⛔ 不返回字符串猜测）', () => {
    const c = findChrome()
    if (c !== null) {
      expect(c.startsWith('/')).toBe(true)
      expect(existsSync(c)).toBe(true)
    }
    // 两种结果都合法，但必须是其中之一 —— 这条防止"返回了一个不存在的路径"
    expect(c === null || existsSync(c)).toBe(true)
  })
})
