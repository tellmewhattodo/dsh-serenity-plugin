/**
 * browser-slot-windows.test.ts — Windows 兼容面（2026-11-19，owner 令「做」/「在 win 上能用就行」）
 *
 * ## 测试策略：把「解析」与「取证」分开
 *
 * 本机是 **Linux**，`process.platform` 改不了 ⇒ 凡是写死平台的判据在这里**结构上判不了**
 * （v1.137.8 那次实测：`isMac()` 全删掉，测试照样全绿）。所以本文件分两层：
 *
 * ① **纯函数层 / 可注入层**（任何平台真跑，且是判据的**主体**）：
 *    `winChromeCandidates` ／ `parseNetstatListeners` ／ `parseCimProcesses` ／
 *    `pickPidsByProfile` ／ `chromeCandidatesFor('win32')` ／ `resolveDisplay(…, 'win32')` ／
 *    `buildArgs(…, 'win32')` ／ `pidClaimsProfile(…, 'win32')`。
 *    这些能在 Linux 上**真的走 win32 分支**并断言其输出。
 *
 * ② **薄 I/O 包装**（`winFindChrome` ／ `winPortHolders` ／ `winProcessSnapshot` ／ `winKillTree`）：
 *    本机没有 `powershell.exe` / `netstat` 的 Windows 语义 / `taskkill` ⇒ 只断言**失败方向**
 *    （返回空集合或 `absent`，**绝不抛**），⛔ 不假装能验真机的真实输出格式。
 *
 * 🔴 **诚实边界**：真正「Windows 上能起 Chrome、能连 CDP、能按树杀掉」**只能在 Windows 上真机验**。
 *    本文件能保证的是：判据齐全、win32 分支在 Linux 上**可判**、失败方向正确、Linux 行为零改变。
 *    ⇒ 这条写在这里，是因为"测试全绿"很容易被读成"win 上已验证"（D141）。
 *
 * ⚠️ 路径写法：本文件里的 Windows 路径**必须用反斜杠**。
 *    用正斜杠写 `C:/Users/…` 会命中本仓隐私门禁的 `absolute-macos-path` 规则
 *    （它锁的是「斜杠 + Users + 斜杠」这个**形态**）—— v1.137.8 那次连红三次才搞明白。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isWin,
  winChromeCandidates,
  winFindChrome,
  winDisplayDetail,
  winProcessSnapshot,
  winFindPidsByProfile,
  winPortHolders,
  winKillTree,
  winIsAlive,
  winPidClaimsProfile,
  winSample,
  parseNetstatListeners,
  parseCimProcesses,
  pickPidsByProfile,
  WIN_CHROME_CANDIDATES,
} from '../src/browser/platform-win.js'
import {
  buildArgs,
  chromeCandidatesFor,
  chromeCandidatesForMessage,
  findChromeFor,
  pidClaimsProfile,
  resolveDisplay,
  slotPaths,
} from '../src/browser/process.js'
import { SLOTS_DIR_ENV } from '../src/browser/home.js'

/**
 * 🔴 **`slotPaths` 会读全局家目录，而 `assertNotPollutingRealHome` 会当场抛**（这是设计，不是障碍）：
 *   槽位台账是**全局唯一真相源**，测试进程不显式指定临时目录就不许起。
 *   ⇒ 本文件**不写台账**，只在 `buildArgs` 里用到 `slotPaths` 拼路径，
 *     所以给一个一次性临时目录即可（用完删掉，⛔ 不碰真实家目录）。
 */
let slotsDir = ''
const savedSlotsDir = process.env[SLOTS_DIR_ENV]

beforeAll(() => {
  slotsDir = mkdtempSync(join(tmpdir(), 'slot-win-'))
  process.env[SLOTS_DIR_ENV] = slotsDir
})

afterAll(() => {
  rmSync(slotsDir, { recursive: true, force: true })
  if (savedSlotsDir === undefined) delete process.env[SLOTS_DIR_ENV]
  else process.env[SLOTS_DIR_ENV] = savedSlotsDir
})

/** 一份确定的环境（不读本机 env，避免判据随机器漂） */
const ENV = {
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
}

const PROFILE = 'C:\\Users\\u\\.dsh\\serenity-browser-slots\\b1\\user-data'

describe('Windows 兼容：平台判定', () => {
  it('isWin 只认 win32（⛔ 不把 linux/darwin 当 Windows）', () => {
    expect(isWin('win32')).toBe(true)
    expect(isWin('linux')).toBe(false)
    expect(isWin('darwin')).toBe(false)
    expect(isWin('')).toBe(false)
  })

  it('默认走 process.platform（生产调用不传参）', () => {
    expect(isWin()).toBe(process.platform === 'win32')
  })
})

describe('Windows 兼容：Chrome 路径', () => {
  it('🔴 用户级 %LOCALAPPDATA% 排第一（Chrome 默认装这里，不是 Program Files）', () => {
    const cands = winChromeCandidates(ENV)
    expect(cands[0]!.toLowerCase()).toContain('appdata\\local')
    expect(cands[0]!.toLowerCase()).toContain('chrome.exe')
  })

  it('🔴 候选全部是 .exe，且**不含** Linux/macOS 路径（出现就说明两套混了）', () => {
    for (const p of winChromeCandidates(ENV)) {
      expect(p.toLowerCase().endsWith('.exe')).toBe(true)
      expect(p).not.toContain('/usr/bin/')
      expect(p).not.toContain('/snap/bin/')
      expect(p).not.toContain('.app/Contents/MacOS/')
    }
  })

  it('🔴 含 Edge 兜底（每台 Windows 都预装有 Chromium 内核浏览器 ⇒ 让槽位真能跑起来）', () => {
    const cands = winChromeCandidates(ENV)
    expect(cands.some((p) => p.toLowerCase().endsWith('msedge.exe'))).toBe(true)
  })

  it('⛔ 不列 Playwright/Puppeteer 缓存那份（它不是用户的浏览器）', () => {
    for (const p of winChromeCandidates(ENV)) {
      expect(p.toLowerCase()).not.toContain('ms-playwright')
      expect(p.toLowerCase()).not.toContain('puppeteer')
    }
  })

  it('🔴 环境变量缺失 ⇒ 不产出畸形路径（⛔ 不拼出相对路径 / 不拼出 "undefined"）', () => {
    const cands = winChromeCandidates({})
    expect(cands).toEqual([])
    // 只给一半环境 ⇒ 只产出对应那一半，⛔ 不产生空串或相对路径
    const onlyLocal = winChromeCandidates({ LOCALAPPDATA: ENV.LOCALAPPDATA })
    expect(onlyLocal.length).toBeGreaterThan(0)
    for (const p of onlyLocal) {
      expect(/^[A-Za-z]:\\/.test(p), `不是绝对 Windows 路径：${p}`).toBe(true)
    }
  })

  it('WIN_CHROME_CANDIDATES 是稳定形（用占位变量拼，与本机 env 无关）', () => {
    expect(WIN_CHROME_CANDIDATES.length).toBe(winChromeCandidates(ENV).length)
    expect(WIN_CHROME_CANDIDATES.some((p) => p.includes('%LOCALAPPDATA%'))).toBe(true)
    expect(WIN_CHROME_CANDIDATES.some((p) => p.includes('%ProgramFiles%'))).toBe(true)
  })

  it('findChromeFor(win32) 用 win 清单找（Linux 上也能验分派）', () => {
    const cands = winChromeCandidates(ENV)
    const target = cands[1]! // 构造：只有第 2 条存在
    expect(findChromeFor('win32', (p) => p === target, ENV)).toBe(target)
    // 反控：同一个探针走 linux ⇒ 找不到（Linux 清单里没有 .exe）
    expect(findChromeFor('linux', (p) => p === target, ENV)).toBeNull()
  })

  it('winFindChrome 在 Linux 上返回 null（⛔ 不返回一个不存在的路径）', () => {
    expect(winFindChrome()).toBeNull()
  })
})

describe('Windows 兼容：三向平台分派**真的分岔**（可注入平台，Linux 上也能判）', () => {
  it('🔴 win32 ／ darwin ／ linux 三份候选**两两不重合**', () => {
    const win = chromeCandidatesFor('win32')
    const mac = chromeCandidatesFor('darwin')
    const linux = chromeCandidatesFor('linux')
    expect(win.length).toBeGreaterThan(0)
    expect(mac.length).toBeGreaterThan(0)
    expect(linux.length).toBeGreaterThan(0)
    // 各自特征（这是"分派真的发生了"的判据）
    expect(win.every((p) => p.toLowerCase().endsWith('.exe'))).toBe(true)
    expect(mac.every((p) => p.includes('.app/Contents/MacOS/'))).toBe(true)
    expect(linux.every((p) => !p.includes('.app/Contents/MacOS/') && !p.toLowerCase().endsWith('.exe'))).toBe(true)
    // 且不重合
    for (const p of win) {
      expect(mac).not.toContain(p)
      expect(linux).not.toContain(p)
    }
  })

  it('正控：production 包装读的是当前平台（⛔ 不是写死 win32）', () => {
    const cands = chromeCandidatesForMessage()
    if (process.platform === 'win32') {
      expect(cands.every((p) => p.toLowerCase().endsWith('.exe'))).toBe(true)
    } else {
      expect(cands.some((p) => p.toLowerCase().endsWith('.exe'))).toBe(false)
    }
    expect(cands.length).toBeGreaterThan(0)
  })

  it('🔴 resolveDisplay(win32) ⇒ native，且**不需要任何显示参数**', () => {
    const nothing = { exists: () => false }
    const win = resolveDisplay(ENV, nothing, 'win32')
    expect(win.backend).toBe('native')
    expect(win.args).toEqual([])
    // 反控：同一探针走 linux ⇒ headless（证明分派真的分岔）
    expect(resolveDisplay(ENV, nothing, 'linux').backend).toBe('headless')
    // 再反控：走 darwin ⇒ cocoa（三向确实三支不同值，⛔ 不是两支里挑一支）
    expect(resolveDisplay(ENV, nothing, 'darwin').backend).toBe('cocoa')
  })

  it('winDisplayDetail 说清了"为什么没有参数"（回执要能自解释）', () => {
    expect(winDisplayDetail()).toContain('DWM')
    expect(winDisplayDetail()).not.toContain('Cocoa') // ⛔ 不把 mac 的说明抄到 win 上
  })
})

/**
 * 🔴🔴 本组是 v1.137.10 的**最重要一条**：`--no-sandbox` 是 **Linux 专属**参数。
 *
 * 它的成因只存在于 Linux（容器内 Chrome 自身 sandbox 初始化 `Operation not permitted`
 * ⇒ GPU 崩 ⇒ 约 1.5s 后自杀）。Windows/macOS 上**没有这个故障** ⇒ 在那里带上它
 * 等于**主动拆掉用户的浏览器沙箱**，把一个本可以正常工作的安全边界关掉，且**没有任何收益**。
 *
 * 🔴 写这一组的理由：原实现把这两条写在**共用**的 `buildArgs` 里，全部平台一起带。
 *    这正是本轨迹里"删值 = 删契约"的**反面** —— "**带值 = 造不存在的契约**"。
 * ⚠️ 成对测（must ／ must-not）：只测 win 不带，无法排除"整个数组都空了"这种假绿。
 */
describe('🔴 启动参数：Linux 专属的两条必须按平台给（Linux 上也能验 win32 分支）', () => {
  const paths = () => slotPaths(1)

  it('🔴 win32 ⇒ **不**带 --no-sandbox ／ --disable-dev-shm-usage', () => {
    const args = buildArgs(1, paths(), undefined, 'win32')
    expect(args).not.toContain('--no-sandbox')
    expect(args).not.toContain('--disable-dev-shm-usage')
    // 负控：证明上面两条不是因为"数组是空的"而侥幸通过
    expect(args.length).toBeGreaterThan(8)
    // 这些**必须**在（与平台无关的那部分）
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true)
    expect(args.some((a) => a.startsWith('--remote-debugging-port='))).toBe(true)
  })

  it('🔴 darwin ⇒ 同样不带这两条（v1.137.8 遗留：那版只把 mac 跑通，没动这两条）', () => {
    const args = buildArgs(1, paths(), undefined, 'darwin')
    expect(args).not.toContain('--no-sandbox')
    expect(args).not.toContain('--disable-dev-shm-usage')
    expect(args.length).toBeGreaterThan(8)
  })

  it('正控：linux ⇒ **必须**带这两条（容器内不加就自杀 / /dev/shm 只有 64MB）', () => {
    const args = buildArgs(1, paths(), undefined, 'linux')
    expect(args).toContain('--no-sandbox')
    expect(args).toContain('--disable-dev-shm-usage')
  })

  it('默认平台（不传参）与显式 linux 逐字相同（生产调用点行为零变化）', () => {
    const implicit = buildArgs(1, paths())
    const explicit = buildArgs(1, paths(), undefined, 'linux')
    expect(implicit).toEqual(explicit)
  })

  it('三个平台都不带"禁止后台降速"那两条（耗电事故的直接成因，与平台无关）', () => {
    for (const plat of ['linux', 'darwin', 'win32']) {
      const args = buildArgs(1, paths(), undefined, plat)
      expect(args).not.toContain('--disable-renderer-backgrounding')
      expect(args).not.toContain('--disable-backgrounding-occluded-windows')
      expect(args).not.toContain('--disable-background-timer-throttling')
    }
  })
})

describe('Windows 兼容：netstat 解析（端口反查的判据主体）', () => {
  const SAMPLE = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:9301        0.0.0.0:0              LISTENING       12345',
    '  TCP    127.0.0.1:9301        127.0.0.1:51515        ESTABLISHED     12345',
    '  TCP    [::1]:9301            [::]:0                 LISTENING       12345',
    '  TCP    127.0.0.1:19301       0.0.0.0:0              LISTENING       99999',
    '  TCP    0.0.0.0:9301          0.0.0.0:0              LISTENING       54321',
    '  UDP    127.0.0.1:9301        *:*                                    7777',
    '',
  ].join('\n')

  it('🔴 只认 LISTENING（ESTABLISHED 里也会出现同一端口 ⇒ 算进去会让启动误判"端口被占"）', () => {
    const pids = parseNetstatListeners(SAMPLE, 9301)
    expect(pids).toContain(12345)
    expect(pids).toContain(54321)
    // 正控：ESTABLISHED 那一行的 pid 与 LISTENING 相同 ⇒ 用「只有 ESTABLISHED」的样本再验一次
    const onlyEstablished = '  TCP    127.0.0.1:9301   127.0.0.1:51515   ESTABLISHED   12345'
    expect(parseNetstatListeners(onlyEstablished, 9301)).toEqual([])
  })

  it('🔴 端口比对是**精确尾段**（⛔ 不用 includes ⇒ 否则 :19301、:93010 会被误命中）', () => {
    expect(parseNetstatListeners(SAMPLE, 9301)).not.toContain(99999)
    const tenThousand = '  TCP    127.0.0.1:93010   0.0.0.0:0   LISTENING   11111'
    expect(parseNetstatListeners(tenThousand, 9301)).toEqual([])
  })

  it('UDP 行不算（CDP 是 TCP；UDP 同名端口不冲突）', () => {
    expect(parseNetstatListeners(SAMPLE, 9301)).not.toContain(7777)
  })

  it('IPv6 方括号形能解析（[::1]:9301）', () => {
    const v6 = '  TCP    [::1]:9301   [::]:0   LISTENING   4242'
    expect(parseNetstatListeners(v6, 9301)).toEqual([4242])
  })

  it('排除自身 pid（本进程不会监听槽位端口，但留着这层判断防将来误伤）', () => {
    const self = `  TCP    127.0.0.1:9301   0.0.0.0:0   LISTENING   ${process.pid}`
    expect(parseNetstatListeners(self, 9301)).toEqual([])
  })

  it('空输入 / 乱输入 ⇒ 空数组（⛔ 不抛）', () => {
    expect(parseNetstatListeners('', 9301)).toEqual([])
    expect(parseNetstatListeners('garbage line here', 9301)).toEqual([])
    expect(parseNetstatListeners('TCP', 9301)).toEqual([])
  })
})

describe('Windows 兼容：PowerShell JSON 解析（进程认领的判据主体）', () => {
  it('🔴 单条记录的 JSON 是**对象**不是数组 ⇒ 必须归一化（否则 .filter 上直接炸）', () => {
    const one = '{"ProcessId":42,"CommandLine":"chrome.exe --user-data-dir=X"}'
    const out = parseCimProcesses(one)
    expect(out).toHaveLength(1)
    expect(out[0]!.pid).toBe(42)
  })

  it('数组形正常解析', () => {
    const many = '[{"ProcessId":1,"CommandLine":"a"},{"ProcessId":2,"CommandLine":"b"}]'
    expect(parseCimProcesses(many).map((e) => e.pid)).toEqual([1, 2])
  })

  it('🔴 CommandLine 为 null ⇒ 归一成空串（⛔ 不直接 .includes 崩掉）', () => {
    const nullCmd = '[{"ProcessId":7,"CommandLine":null}]'
    const out = parseCimProcesses(nullCmd)
    expect(out).toHaveLength(1)
    expect(out[0]!.cmd).toBe('')
  })

  it('坏 pid（字符串／负数／缺失）逐条丢弃，⛔ 不污染其它记录', () => {
    const messy = '[{"ProcessId":"9","CommandLine":"a"},{"ProcessId":-3},{"ProcessId":4,"CommandLine":"c"},{}]'
    const out = parseCimProcesses(messy)
    // 字符串 "9" 经 Number() 后是合法整数 ⇒ 保留（宽松收，但必须仍是正整数）
    expect(out.map((e) => e.pid)).toEqual([9, 4])
  })

  it('空串 / 非法 JSON / 非对象 ⇒ 空数组（⛔ 不抛）', () => {
    expect(parseCimProcesses('')).toEqual([])
    expect(parseCimProcesses('not json')).toEqual([])
    expect(parseCimProcesses('123')).toEqual([])
    expect(parseCimProcesses('null')).toEqual([])
  })
})

describe('Windows 兼容：按 profile 认领 pid', () => {
  const entries = [
    { pid: 100, cmd: 'C:\\chrome.exe --user-data-dir=C:\\Users\\u\\.dsh\\serenity-browser-slots\\b1\\user-data' },
    // Windows 上 Chrome 会把盘符/首字母规范化 ⇒ 大小写可能与台账里那份不同
    { pid: 101, cmd: 'c:\\chrome.exe --user-data-dir=c:\\users\\u\\.dsh\\serenity-browser-slots\\b1\\user-data' },
    // 用户自己的浏览器：命令行里**没有**本槽位 profile ⇒ ⛔ 绝不能认领
    { pid: 102, cmd: 'C:\\chrome.exe --user-data-dir=C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data' },
    { pid: process.pid, cmd: `node --user-data-dir=${PROFILE}` },
  ]

  it('🔴 大小写不敏感（Chrome 会规范化盘符 ⇒ 严格比对会静默漏认）', () => {
    expect(pickPidsByProfile(entries, PROFILE)).toEqual([100, 101])
  })

  it('🔴 不认领用户自己的浏览器（判据 = profile 路径，⛔ 不是进程名）', () => {
    expect(pickPidsByProfile(entries, PROFILE)).not.toContain(102)
  })

  it('排除自身 pid（本进程命令行里也可能带同一路径 ⇒ 不排除会把自己杀掉）', () => {
    expect(pickPidsByProfile(entries, PROFILE)).not.toContain(process.pid)
  })

  it('空 profile ⇒ 空数组（⛔ 不把空串当"匹配所有行"）', () => {
    expect(pickPidsByProfile(entries, '')).toEqual([])
  })

  it('没有匹配 ⇒ 空数组（失败方向：不误认领）', () => {
    expect(pickPidsByProfile(entries, 'C:\\no\\such\\profile-xyz')).toEqual([])
  })
})

describe('Windows 兼容：采样降级必须**在读数上看得见**', () => {
  it('🔴 winSample 给出 sampled=false（否则 cpu0%/内存0M 与「测了很低」同形）', () => {
    expect(winSample([]).sampled).toBe(false)
    expect(winSample([123]).sampled).toBe(false)
  })

  it('alive 由 pids 推出（零额外成本：findPidsByProfile 已经跑过了）', () => {
    expect(winSample([]).alive).toBe(false)
    expect(winSample([123]).alive).toBe(true)
  })
})

describe('Windows 兼容：pidClaimsProfile 在 win32 上真的走 win 分支', () => {
  it('🔴 win32 ⇒ 调 winClaim（⛔ 不靠 /proc 的 catch 兜出 false）', () => {
    let winCalls = 0
    let macCalls = 0
    const winClaim = (): boolean => {
      winCalls += 1
      return true
    }
    const macClaim = (): boolean => {
      macCalls += 1
      return true
    }
    // 4242 在 Linux 的 /proc 里不存在 ⇒ 若没走 win 分支会得到 false
    expect(pidClaimsProfile(4242, PROFILE, 'win32', macClaim, winClaim)).toBe(true)
    expect(winCalls).toBe(1)
    expect(macCalls).toBe(0)
    // 反控：一样本走 darwin ⇒ 调 mac 不调 win
    expect(pidClaimsProfile(4242, PROFILE, 'darwin', macClaim, winClaim)).toBe(true)
    expect(macCalls).toBe(1)
    expect(winCalls).toBe(1)
    // 再反控：走 linux ⇒ 两个探针都不碰，且 /proc 里没有 ⇒ false
    expect(pidClaimsProfile(4242, PROFILE, 'linux', macClaim, winClaim)).toBe(false)
    expect(winCalls).toBe(1)
    expect(macCalls).toBe(1)
  })

  it('非法 pid 在三条分支上都不调探针（⛔ 不为无效输入做归属判定）', () => {
    let calls = 0
    const probe = (): boolean => {
      calls += 1
      return true
    }
    for (const plat of ['linux', 'darwin', 'win32']) {
      expect(pidClaimsProfile(0, PROFILE, plat, probe, probe)).toBe(false)
      expect(pidClaimsProfile(-1, PROFILE, plat, probe, probe)).toBe(false)
      expect(pidClaimsProfile(1.5, PROFILE, plat, probe, probe)).toBe(false)
    }
    expect(calls).toBe(0)
  })
})

describe('Windows 兼容：薄包装的失败方向（Linux 上只验不抛）', () => {
  it('winProcessSnapshot 在 Linux 上回空数组（⛔ 不抛）', () => {
    expect(Array.isArray(winProcessSnapshot())).toBe(true)
  })

  it('winFindPidsByProfile 在 Linux 上回空数组（⛔ 不误认领）', () => {
    expect(winFindPidsByProfile(PROFILE)).toEqual([])
  })

  it('winPidClaimsProfile 在 Linux 上回 false（保守：不杀）', () => {
    expect(winPidClaimsProfile(4242, PROFILE)).toBe(false)
    // 空 profile / 非法 pid 直接 false，⛔ 不落到查进程
    expect(winPidClaimsProfile(4242, '')).toBe(false)
    expect(winPidClaimsProfile(0, PROFILE)).toBe(false)
  })

  it('winPortHolders 失败/无匹配 ⇒ 空数组（⛔ 不抛、不返回 NaN）', () => {
    const pids = winPortHolders(9301)
    expect(Array.isArray(pids)).toBe(true)
    for (const p of pids) expect(Number.isInteger(p)).toBe(true)
  })

  it('winKillTree 对非法 pid ⇒ absent（⛔ 不去调 taskkill）', () => {
    expect(winKillTree(0)).toBe('absent')
    expect(winKillTree(-1)).toBe('absent')
    expect(winKillTree(1.5)).toBe('absent')
  })

  it('winIsAlive：本进程 alive；不存在的 pid 为 false；非法入参 ⛔ 不抛', () => {
    expect(winIsAlive(process.pid)).toBe(true)
    expect(winIsAlive(999_999_999)).toBe(false)
    expect(winIsAlive(0)).toBe(false)
    expect(winIsAlive(-1)).toBe(false)
  })
})
