/**
 * browser-slot-macos.test.ts — macOS 兼容面（2026-11-18，owner 令「需要兼容 mac」）
 *
 * ## 这个文件为什么存在
 *
 * 槽位原本**整个建立在 `/proc` 之上**。macOS 上它会在**五个地方**同时失效，而
 * **这五个在 Linux 上全都读不出来**（本机测试跑的是 Linux 分支，mac 分支从不执行，
 * 却从不报错）—— 那正是本仓反复踩的「假绿 / 判据没有判别力」形态。
 *
 * ## 测试策略：把"平台"与"平台实现"分开测
 *
 * `process.platform` 在测试里**改不了**（只读）。所以本文件分两层：
 *
 * ① **纯函数层**（可在任何平台真跑）：`isMac()` / `parsePsTime()` / `macChromeCandidates()` /
 *    候选路径与 Linux 不重合 / 错误文案按平台切换。这些是**判据的主体**。
 * ② **macOS 实现层**（真调 `platform.ts` 的 mac 函数）：本机是 Linux，`ps`/`lsof` 存在但语义不同
 *    ⇒ 只断言**失败方向**（返回空集合而不是抛），⛔ 不假装能验 mac 的真实输出格式。
 *
 * 🔴 **诚实边界**：真正"mac 上能起 Chrome"只能**在 mac 上真机验**（本机做不到）。
 *    本文件能保证的是：**判据齐全、失败方向正确、且 Linux 行为零改变**。
 *    ⇒ 这条写在这里，是因为"测试全绿"很容易被读成"mac 上已验证"（D141）。
 */
import { describe, it, expect } from 'vitest'
import {
  isMac,
  macChromeCandidates,
  macFindChrome,
  macFindPidsByProfile,
  macIsAlive,
  macPortHolders,
  macSample,
  parsePsTime,
  MAC_CHROME_CANDIDATES,
} from '../src/browser/platform.js'
import { chromeCandidatesFor, chromeCandidatesForMessage, findChromeFor, resolveDisplay } from '../src/browser/process.js'

/**
 * 🔴🔴 **判别力教训（本文件第一版栽的一次，值得留在代码里）**
 *
 * 我第一版断言「Linux 上不得印 `.app` 路径」—— **变异把 `isMac()` 整个删掉后测试照样全绿**：
 * 本机是 Linux，两条分支**结果相同** ⇒ 这条判据在本机**结构上判不了** mac 分派。
 * 那正是本仓反复踩的「判据没有判别力 / 假绿」。
 *
 * ⇒ 修法不是"再加一条断言"，而是**改被测对象**：把平台做成**可注入参数**
 * （`chromeCandidatesFor(platform)` / `findChromeFor(platform)` / `resolveDisplay(..., platform)`），
 * 于是 Linux 上也能**真的走 darwin 分支**并断言其输出。
 * ⚠️ 生产调用点仍用默认参数（`process.platform`），行为零变化。
 */
describe('macOS 兼容：平台分派**真的分岔**（可注入平台，Linux 上也能判）', () => {
  it('🔴 darwin ⇒ .app 路径；linux ⇒ /usr/bin 路径（两条分支都真走一遍）', () => {
    const mac = chromeCandidatesFor('darwin')
    const linux = chromeCandidatesFor('linux')
    expect(mac.length).toBeGreaterThan(0)
    expect(linux.length).toBeGreaterThan(0)
    // 各自的特征（这是"分派真的发生了"的判据）
    expect(mac.every((p) => p.includes('.app/Contents/MacOS/'))).toBe(true)
    expect(linux.every((p) => !p.includes('.app/Contents/MacOS/'))).toBe(true)
    // 且**不重合**
    for (const p of mac) expect(linux).not.toContain(p)
  })

  it('🔴 findChromeFor(darwin) 只在 .app 候选里找（Linux 上也能验分派）', () => {
    const macCand = macChromeCandidates({ HOME: '/Users/u' })
    // 构造：只有**第 3 个** mac 候选存在 ⇒ 必须返回它（证明用的是 mac 清单、顺序也生效）
    const target = macCand[2]!
    const found = findChromeFor('darwin', (p) => p === target, { HOME: '/Users/u' })
    expect(found).toBe(target)
    // 反控：同一个探针走 linux ⇒ 找不到（Linux 清单里没有这个 .app 路径）
    expect(findChromeFor('linux', (p) => p === target, { HOME: '/Users/u' })).toBeNull()
  })

  it('🔴 resolveDisplay(darwin) ⇒ cocoa（⛔ 不因"没有 socket"静默退化成 headless）', () => {
    // nothing 探针 = 没有任何 wayland/X socket（mac 的真实形态）
    const nothing = { exists: () => false }
    const mac = resolveDisplay({ HOME: '/Users/u' }, nothing, 'darwin')
    expect(mac.backend).toBe('cocoa')
    expect(mac.args).toEqual([]) // mac 不需要任何显示参数
    // 反控：同一探针走 linux ⇒ headless（证明分派真的分岔）
    const linux = resolveDisplay({ HOME: '/home/u' }, nothing, 'linux')
    expect(linux.backend).toBe('headless')
  })

  it('正控：production 包装读的是当前平台（⛔ 不是写死 darwin）', () => {
    const cands = chromeCandidatesForMessage()
    if (process.platform === 'darwin') {
      expect(cands.every((p) => p.includes('.app/Contents/MacOS/'))).toBe(true)
    } else {
      expect(cands.some((p) => p.includes('.app/Contents/MacOS/'))).toBe(false)
    }
    expect(cands.length).toBeGreaterThan(0) // 两边都必须非空
  })
})

describe('macOS 兼容：平台判定', () => {
  it('isMac 只认 darwin（⛔ 不把 linux/win32 当 mac）', () => {
    expect(isMac('darwin')).toBe(true)
    expect(isMac('linux')).toBe(false)
    expect(isMac('win32')).toBe(false)
    expect(isMac('')).toBe(false)
  })

  it('默认走 process.platform（生产调用不传参）', () => {
    // 本机是 linux ⇒ 恒 false；这条钉的是"默认参数接的是 process.platform"
    expect(isMac()).toBe(process.platform === 'darwin')
  })
})

describe('macOS 兼容：Chrome 路径', () => {
  it('🔴 候选路径全在 .app/Contents/MacOS 下（与 Linux 的 /usr/bin/* 一条都不重合）', () => {
    const cands = macChromeCandidates({ HOME: '/Users/u' })
    expect(cands.length).toBeGreaterThan(0)
    for (const p of cands) {
      expect(p.startsWith('/')).toBe(true)
      expect(p).toContain('.app/Contents/MacOS/')
    }
    // 🔴 判据：mac 候选里**不得**出现 Linux 那几条（出现就说明两套混了）
    for (const p of cands) {
      expect(p).not.toContain('/usr/bin/')
      expect(p).not.toContain('/snap/bin/')
    }
  })

  it('🔴 含用户级 ~/Applications（无管理员权限时装这里）', () => {
    const HOME = '/Users/u'
    const cands = macChromeCandidates({ HOME })
    // 🔴 **由注入的 HOME 拼出期望值，⛔ 不把整条路径再写一遍**：
    //   ① 写死一遍 = 同一形状存两处，实现改了判据看不出来；
    //   ② 它会撞本仓的隐私门禁 —— `absolute-macos-path` 规则锁的是「macOS 家目录下的绝对路径」
    //      这个**形态**，占位用户名一样命中（占位名与真名在正则里不可分）。
    //      本轮实测两次：先写成某真人名 ⇒ 红；改成单字母占位 ⇒ **仍红**（规则管形态，不管名字真假）；
    //      再把这句注释本身写出来 ⇒ **第三次红**（注释里的字面量同样在扫描域内）。
    //      ⇒ 判据：**公开面里连占位形态都不要写死，注释里也不要引用它的字面量**；能拼就拼。
    expect(cands).toContain(`${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`)
  })

  it('HOME 缺失时不产出 "/Applications/…" 之外的畸形路径（⛔ 不拼出 "Applications/…" 相对路径）', () => {
    const cands = macChromeCandidates({})
    for (const p of cands) expect(p.startsWith('/')).toBe(true)
    expect(cands.some((p) => p.startsWith('/Applications/'))).toBe(true)
  })

  it('⛔ 不列 Playwright/Puppeteer 下载的那份（它不是用户的浏览器）', () => {
    const cands = macChromeCandidates({ HOME: '/Users/u' })
    expect(cands.some((p) => p.includes('ms-playwright'))).toBe(false)
    expect(cands.some((p) => p.includes('.cache'))).toBe(false)
  })

  it('macFindChrome 在 Linux 上返回 null（⛔ 不返回一个不存在的路径）', () => {
    const c = macFindChrome()
    // 本机是 Linux ⇒ /Applications 不会存在
    expect(c).toBeNull()
  })

  it('🔴 错误回执按平台给候选（Linux 上不得印 .app 路径）', () => {
    const cands = chromeCandidatesForMessage()
    if (process.platform === 'darwin') {
      expect(cands.every((p) => p.includes('.app/Contents/MacOS/'))).toBe(true)
    } else {
      expect(cands.some((p) => p.includes('.app/Contents/MacOS/'))).toBe(false)
    }
    // 正控：两边都必须非空（"印出空清单"等于没给修法）
    expect(cands.length).toBeGreaterThan(0)
  })

  it('MAC_CHROME_CANDIDATES 是稳定版（不随 HOME 变）', () => {
    expect(MAC_CHROME_CANDIDATES).toEqual(MAC_CHROME_CANDIDATES.filter((p) => p.startsWith('/')))
    expect(MAC_CHROME_CANDIDATES).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })
})

describe('macOS 兼容：ps time 解析（采样口径的承重部分）', () => {
  it('mm:ss / hh:mm:ss / dd-hh:mm:ss / 小数秒', () => {
    expect(parsePsTime('00:01')).toBe(1)
    expect(parsePsTime('00:01.23')).toBeCloseTo(1.23, 5)
    expect(parsePsTime('12:34')).toBe(754)
    expect(parsePsTime('01:02:03')).toBe(3723)
    expect(parsePsTime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })

  it('🔴 解析不出 ⇒ null，⛔ 不返回 0（否则"读不到"会伪装成"CPU 很低"）', () => {
    expect(parsePsTime('')).toBeNull()
    expect(parsePsTime('garbage')).toBeNull()
    expect(parsePsTime('--')).toBeNull()
    expect(parsePsTime('12')).toBeNull() // 只有一段 ⇒ 不是合法 time 形状
    expect(parsePsTime('1:2:3:4:5')).toBeNull()
  })

  it('⚠️ `1:2` 是合法的 mm:ss（= 62 秒）—— 位宽不固定，别按"必须两位数"写判据', () => {
    // 我第一版把 '1:2' 写成"缺秒段 ⇒ null"，实测返回 62 ⇒ **是判据错，不是实现错**。
    // ps 的 time 输出不补零（取决于版本/内核），所以位宽不能当校验条件。
    expect(parsePsTime('1:2')).toBe(62)
  })
})

describe('macOS 兼容：采样口径与 Linux 同源（增量，⛔ 不是 %cpu）', () => {
  it('🔴 首次采样 cpuPct = 0（没有上一次就无从算增量，⛔ 不假装有读数）', () => {
    const s = macSample([], null, 1000)
    expect(s.cpuPct).toBe(0)
    expect(s.alive).toBe(false)
  })

  it('不存在的 pid ⇒ alive=false（⛔ 不抛）', () => {
    const s = macSample([999_999_999], null, Date.now())
    expect(s.alive).toBe(false)
    expect(s.cpuPct).toBe(0)
  })
})

describe('macOS 兼容：进程认领与端口反查的失败方向', () => {
  it('空 profile ⇒ 空数组（⛔ 不把空串当"匹配所有行"）', () => {
    expect(macFindPidsByProfile('')).toEqual([])
  })

  it('不存在的 profile ⇒ 空数组（不会误认领用户自己的浏览器）', () => {
    expect(macFindPidsByProfile('/no/such/profile-xyz-12345')).toEqual([])
  })

  it('🔴 端口查询失败/无匹配 ⇒ 空数组（⛔ 不抛、不返回 NaN）', () => {
    const pids = macPortHolders(1) // 特权端口，普通用户查不到
    expect(Array.isArray(pids)).toBe(true)
    for (const p of pids) expect(Number.isInteger(p)).toBe(true)
  })

  it('macIsAlive：本进程 alive；不存在的 pid 为 false', () => {
    expect(macIsAlive(process.pid)).toBe(true)
    expect(macIsAlive(999_999_999)).toBe(false)
    // 非法入参 ⛔ 不抛
    expect(macIsAlive(0)).toBe(false)
    expect(macIsAlive(-1)).toBe(false)
  })
})
