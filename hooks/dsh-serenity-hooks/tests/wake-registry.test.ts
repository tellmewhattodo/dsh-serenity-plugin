/**
 * wake-registry.test.ts — cognitive trajectory 唤醒注册表 + 投递路径（D58，S142 2026-09-13）
 *
 * 覆盖（设计文档 §11 验收 2）：
 *  - 注册表纯逻辑：时刻解析 / 登记校验 / 到期切分（due vs expired）/ 状态推进 / 移除 / 排序
 *  - 目标定位：S### → AGENT_SESSIONS 目录 + SESSION.md
 *  - 投递路径：live 命中（`.bindings.json` 反查 + `agents.get`）→ `followup` 收到唤醒正文；
 *    冷会话且 `sessionController` 缺席 → **响亮报错**（不得静默）；
 *    冷会话且有 `sessionController` → `resolveAgent` 载入后投递（P-1 的冷唤醒正门）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import {
  addWake,
  finalizeWake,
  listWakes,
  loadWakeRegistry,
  newWakeId,
  parseWakeAt,
  purgeFinalizedWakes,
  removeWake,
  splitDueWakes,
  updateWake,
  wakeRegistryPath,
  WAKE_CATCH_UP_MS,
  type WakeEntry,
} from '../src/wake/registry.js'
import { buildWakeText, deliverWake, registerWakeScheduler, resolveWakeTarget, sendToCognitiveTrajectory, wakeSchedulerState, __resetWakeSchedulerStateForTest } from '../src/wake/scheduler.js'
import { listBoundSessionIds } from '../src/trajectory/bound.js'
import { CRO_FILENAME, CRO_HOST_FILENAME } from '../src/cro/core.js'
// 标题判据（D182）：期望值**现算**，不抄字符串——抄一份就是第二真相源
import { namingTitleFor, parseTrajectoryCode } from '../src/trajectory/core.js'
import { croWakeLogPath, loadCroWakeLog } from '../src/cro/log.js'
import { markTurnRunning, __resetCroTurnsForTest } from '../src/cro/turns.js'
import { existsSync, readFileSync } from 'node:fs'
import { projectDirNameForCwd } from '../src/trajectory/interrupted.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/surface/settings.js'

const HOUR = 3_600_000
const DIR_NAME = '2026-09-13--S999--wake-target--auto'

/**
 * 会话日志的项目目录名（`hasSessionLogById` 会遍历 sessions root 下**所有**项目目录，
 * 所以这里的取值不重要，只要是一个目录名即可；用真形态让夹具长得像真的）。
 */
const PROJECT_SLUG = '--home-yh-home-home-serenity--'

let root: string
/** 临时 `DSH_HOME`：把"会话日志在磁盘上"这一维关进沙箱，绝不读本机真实会话 */
let dshHome: string

function writeSessionDir(dirName = DIR_NAME): string {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# SESSION\n', 'utf-8')
  return dir
}

/**
 * 写一条归属（D172：写进**轨迹目录**的 `current.dsh_session_bind`，不再是旁路表）。
 *
 * ⚠️ 语义是"这条轨迹当前由 `sessionId` 承载"——**单槽位**，重复调用即覆盖（不是追加）。
 * 旧夹具靠 `.bindings.json` 的多条记录构造"一条轨迹挂多代载体"，
 * 那在新形态里**结构上不可能**，相关用例已随判决退役。
 *
 * 🔴 **2026-10-20（owner 裁决「死包含归档判断」）后必须同时造出会话日志。**
 *
 * 修之前本夹具只写绑定文件、不建会话日志，而用例把 `agents.get` 桩成 `undefined`
 * （= 非 live）⇒ 按新判据「活 ⟺ ① ∨ (② ∧ 不在归档集)」这条会话是**死的**，
 * 于是 `deliverWake` 走到"无绑定会话记录"那一支，7 条用例同时红。
 *
 * ⚠️ 那不是判据错，是**夹具构造了一个生产中不可能出现的状态**：
 * 一条真实存在的冷会话一定是"进程里没有、但磁盘上有日志"（这正是"冷"的定义）。
 * ⇒ 夹具按真形态补齐 ②（日志），让用例被测的对象回到"冷会话"本身。
 *
 * @param sessionId 绑定到这条轨迹的会话 id
 * @param opts.cold 是否造出"日志在磁盘"（缺省 true = 真实的冷会话形态）
 */
function writeBinding(
  sessionId: string,
  dirName = DIR_NAME,
  at = Date.now(),
  opts: { cold?: boolean } = {},
): void {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'current.dsh_session_bind'),
    JSON.stringify({ sessionId, at, action: 'activate' }),
    'utf-8',
  )
  if (opts.cold !== false) writeSessionLog(sessionId)
}

/**
 * 造出"这条会话的日志在磁盘上"（= 判活判据 ② 的事实来源）。
 *
 * 落点必须与 `hasSessionLogById` 的扫描域一致：
 * `<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd`。
 * 本组用例用 `DSH_HOME` 指向临时目录，**绝不碰真实宿主数据**
 * （⚠️ 别把 `DSH_HOME` 指向 `$HOME`：那会让判据读到本机真实会话，用例互串）。
 *
 * ⚠️ 只造"名字与位置"，不造 zstd 内容：`hasSessionLogById` 只 `stat` 大小、
 *    不解析内容 ⇒ 空文件即可（并且这一点被 `hasSessionLogById` 的实现钉着）。
 */
function writeSessionLog(sessionId: string): void {
  // ⚠️ 目录名的归一化**必须与 `hasSessionLogById` 的约定一致**（它按"含 `session-` 前缀"
  //    判目录名：`sess-cold` ⇒ 去找 `session-sess-cold`）。本夹具用短 id（`sess-cold`）
  //    是为了可读，真实 id 是 `session-<uuid>`（那样归一化是恒等的）。
  //    ⇒ 这里照约定补齐前缀，让夹具长得像真会话目录，而不是绕开判据。
  const dirName = sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
  const dir = join(dshHome, 'sessions', PROJECT_SLUG, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '', 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsp-wake-'))
  dshHome = mkdtempSync(join(tmpdir(), 'dsp-wake-home-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

/**
 * 轮询等待（CRO 集成用例用）：CRO 阶段要**起子进程**，耗时不确定 ⇒ 固定 sleep 会 flaky。
 * @param pred 判据
 * @param ms 上限
 */
async function waitFor(pred: () => boolean, ms = 8_000): Promise<void> {
  const t0 = Date.now()
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25))
}

/** 往轨迹目录里写一份 CRO 程序（`continuous-re-occurrence.ts` = 启用判据） */
function writeCro(dirName: string, source: string): void {
  writeFileSync(join(root, 'AGENT_SESSIONS', dirName, CRO_FILENAME), source, 'utf-8')
}

/**
 * 往轨迹目录里写**机器绑定**声明（owner 令 2026-10-15，D135）。
 *
 * 🔴 **本组用例（CRO 与调度器集成）测的是投递/流水/铁律，不是绑定门** ⇒
 * 它们**必须先过门**才走得到靶子。缺这一步会得到**误导性的红**：
 * 看起来像"投递坏了"，其实是"门把这条轨迹挡了"（本轮实测踩到，5 例同族）。
 * ⇒ 判据：**凡要让 CRO 真跑起来的用例，都要先声明绑定**。
 * @param host 绑给谁；缺省 = 本机真机器名（即"允许本机跑"）
 */
function writeCroHostBinding(host: string = hostname(), dirName = DIR_NAME): void {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, CRO_HOST_FILENAME), `${host}\n`, 'utf-8')
}

/** 一份"吐固定决策"的 CRO 程序（**纯 JS 写在 .ts 里**：多 runner 下都能跑，同 `cro.test.ts` 手法） */
function croProgram(decisionJson: string): string {
  return (
    "let s='';process.stdin.on('data',d=>{s+=d}).on('end',()=>{const o=JSON.parse(s);" +
    `const d=${decisionJson};d.reason=(d.reason||'')+' dir='+o.identity.dirName;` +
    'process.stdout.write(JSON.stringify(d))})'
  )
}

describe('parseWakeAt（RFC3339 或 +Nm/+Nh/+Nd）', () => {
  it('相对写法按单位换算', () => {
    const now = 1_700_000_000_000
    expect(parseWakeAt('+30m', now)).toEqual({ ok: true, ms: now + 30 * 60_000 })
    expect(parseWakeAt('+2h', now)).toEqual({ ok: true, ms: now + 2 * HOUR })
    expect(parseWakeAt('+1d', now)).toEqual({ ok: true, ms: now + 24 * HOUR })
  })

  it('RFC3339 带时区偏移可解析', () => {
    const r = parseWakeAt('2026-09-14T09:00:00+08:00', 0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(new Date(r.ms).toISOString()).toBe('2026-09-14T01:00:00.000Z')
  })

  it('空串/乱串 → 稳定错误（不抛）', () => {
    expect(parseWakeAt('  ', 0).ok).toBe(false)
    expect(parseWakeAt('明天早上', 0).ok).toBe(false)
  })
})

describe('addWake（登记校验 + 落盘）', () => {
  it('正常登记：写文件 + state=pending + id 可读', () => {
    const now = Date.now()
    const res = addWake(root, { target: DIR_NAME, at: '+1h', message: '继续 §30', createdBy: 'S142', nowMs: now })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.state).toBe('pending')
    expect(res.entry.target).toBe(DIR_NAME)
    expect(res.entry.createdBy).toBe('S142')
    const onDisk = loadWakeRegistry(root)
    expect(onDisk.error).toBeNull()
    expect(onDisk.registry.entries).toHaveLength(1)
    expect(wakeRegistryPath(root)).toContain('wake-registry.json')
  })

  it('target / message 为空 → 拒绝', () => {
    expect(addWake(root, { target: '', at: '+1h', message: 'x', createdBy: '', nowMs: Date.now() }).ok).toBe(false)
    expect(addWake(root, { target: DIR_NAME, at: '+1h', message: '  ', createdBy: '', nowMs: Date.now() }).ok).toBe(false)
  })

  it('过去的时刻 → 拒绝（唤醒只允许可预期的未来）', () => {
    const now = Date.now()
    const res = addWake(root, { target: DIR_NAME, at: new Date(now - HOUR).toISOString(), message: 'x', createdBy: '', nowMs: now })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('未来')
  })
})

describe('splitDueWakes（到期切分：due vs expired）', () => {
  const entry = (over: Partial<WakeEntry>): WakeEntry => ({
    id: 'w-x', target: DIR_NAME, at: new Date(0).toISOString(), message: 'm', state: 'pending',
    createdBy: '', createdAt: new Date(0).toISOString(), attempts: 0, lastResult: null, deliveredAt: null,
    ...over,
  })

  it('未到点 → 都不出', () => {
    const now = 1000
    const r = splitDueWakes({ version: 1, entries: [entry({ at: new Date(now + HOUR).toISOString() })] }, now)
    expect(r.due).toHaveLength(0)
    expect(r.expired).toHaveLength(0)
  })

  it('到点且在补跑窗口内 → due', () => {
    const now = 10 * HOUR
    const r = splitDueWakes({ version: 1, entries: [entry({ at: new Date(now - HOUR).toISOString() })] }, now, WAKE_CATCH_UP_MS)
    expect(r.due).toHaveLength(1)
    expect(r.expired).toHaveLength(0)
  })

  it('迟到超过补跑窗口 → expired（不投递，置 missed）', () => {
    const now = 10 * HOUR
    const r = splitDueWakes({ version: 1, entries: [entry({ at: new Date(now - 3 * HOUR).toISOString() })] }, now, WAKE_CATCH_UP_MS)
    expect(r.due).toHaveLength(0)
    expect(r.expired).toHaveLength(1)
  })

  it('非 pending（已投递/已错过）不参与', () => {
    const now = 10 * HOUR
    const at = new Date(now - HOUR).toISOString()
    const r = splitDueWakes({ version: 1, entries: [entry({ at, state: 'delivered' }), entry({ at, state: 'missed' })] }, now)
    expect(r.due).toHaveLength(0)
    expect(r.expired).toHaveLength(0)
  })
})

describe('updateWake / removeWake / listWakes', () => {
  it('状态推进 + 移除 + 按 at 升序', () => {
    const now = Date.now()
    const a = addWake(root, { target: DIR_NAME, at: '+2h', message: 'A', createdBy: 'S1', nowMs: now })
    const b = addWake(root, { target: DIR_NAME, at: '+1h', message: 'B', createdBy: 'S2', nowMs: now })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(listWakes(root).entries.map((e) => e.message)).toEqual(['B', 'A'])

    expect(updateWake(root, a.entry.id, { state: 'delivered', attempts: 1, lastResult: '已投递', deliveredAt: new Date().toISOString() }).ok).toBe(true)
    const after = listWakes(root, { pendingOnly: true }).entries
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(b.entry.id)

    expect(removeWake(root, b.entry.id).ok).toBe(true)
    expect(removeWake(root, 'w-none').ok).toBe(false)
    expect(listWakes(root).entries).toHaveLength(1)
  })

  it('newWakeId 形态：w-<当地到分钟>-<4 hex>（D67：UTC → 当地，2026-09-17）', () => {
    const ms = Date.parse('2026-09-13T12:34:56Z')
    const id = newWakeId(ms, () => 0.5)
    expect(id).toMatch(/^w-\d{8}-\d{4}-[0-9a-f]{4}$/)

    // 期望值**独立重推**（不经 `localIdStamp` —— 调它就是把断言写成自证）：由该时刻的当地钟面直接构造
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    const localStamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    expect(id).toBe(`w-${localStamp}-8000`)

    // 🔴 旧版本把期望值**硬编码成 UTC 戳**（`w-20260913-1234-…`）⇒ 本机 +08:00 下必红。
    //    改为"由当地钟面推"，既钉住"已从 UTC 改为当地"，又**不依赖机器时区**（UTC 机器上同样通过）；
    //    非 UTC 机器再补一条**负向断言**，钉死"不再是 UTC 戳"。
    if (d.getTimezoneOffset() !== 0) {
      const utcStamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
      expect(id).not.toContain(`-${utcStamp}-`)
    }
  })
})

describe('resolveWakeTarget（S### → 目录）', () => {
  it('按 S### 与完整目录名都能命中；无 SESSION.md → null', () => {
    writeSessionDir()
    expect(resolveWakeTarget(root, 'S999')?.dirName).toBe(DIR_NAME)
    expect(resolveWakeTarget(root, DIR_NAME)?.dirName).toBe(DIR_NAME)
    expect(resolveWakeTarget(root, 'S404')).toBeNull()
  })
})

describe('deliverWake（live 优先 → 冷唤醒正门）', () => {
  const makeEntry = (): WakeEntry => ({
    id: 'w-1', target: DIR_NAME, at: new Date().toISOString(), message: '继续 §30 实现',
    state: 'pending', createdBy: 'S142', createdAt: new Date().toISOString(),
    attempts: 0, lastResult: null, deliveredAt: null,
  })

  it('live 命中：`.bindings.json` 反查会话 id → agents.get → followup 收到唤醒正文', async () => {
    writeSessionDir()
    writeBinding('sess-live')
    const sent: string[] = []
    const fakeAgent = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    const ctx = { agents: { get: (id: string) => (id === 'sess-live' ? fakeAgent : undefined) } }

    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('live(bound sess-live)')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('继续 §30 实现')
    // 🔴 2026-11-02 §D1（owner Q3「全砍」）：正文**不再含目录名**（那是身份锚定，已砍）。
    //    这里**改为钉本意**：正文必须以**本来源的标记**开头（不冒充其它两种来源）。
    //    ⛔ 不改成一堆 toContain('') 那种假绿（D274）。
    expect(sent[0]).toContain('[认知轨迹唤醒]')
    expect(sent[0]).not.toContain('[即时消息]')
    expect(sent[0]).not.toContain('[CRO 唤起]')
  })

  it('冷会话 + sessionController 缺席 → 响亮报错（不静默、不误报成功）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('sessionController')
    // 🔴 v1.39.3（S142 §0t，2026-09-17 实测缺陷）：这一情形是**环境未就绪**，不是投递失败
    //    ⇒ 必须带 `notReady`，否则调用方（tick）会把它当失败写进条目 ——
    //    每次 `restart-web` 都给"到点条目"伪造一条"失败的投递"（假告警发生器）。
    expect(res.notReady).toBe(true)
    // 文案**不得再猜成因**：旧文写「（headless profile？）」，而真因**常常是重启窗口**
    // —— 假陈述把维护者引偏过一次（所有者 2026-09-17 就是被这条假失败引来的）。
    expect(res.detail).not.toContain('headless profile？')
    expect(res.detail).toContain('宿主尚未就绪')
  })

  it('冷会话 + sessionController 可用 → resolveAgent 载入后投递（P-1 冷唤醒路径）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const sent: string[] = []
    const resumed = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    let asked: string | null = null
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'sessionController'
        ? { resolveAgent: async (id: string) => { asked = id; return { agent: resumed } } }
        : undefined),
    }
    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(true)
    expect(asked).toBe('sess-cold')
    expect(res.detail).toContain('cold-resume(sess-cold)')
    expect(sent[0]).toContain('继续 §30 实现')
  })

  it('无绑定记录 → 报错说明需先 cognitive_trajectory use（目标轨迹无载体）', async () => {
    writeSessionDir()
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await deliverWake(ctx as never, root, makeEntry())
    expect(res.ok).toBe(false)
    // 🔴 2026-10-23 判据更新（D208）：原断言钉的是 `.bindings.json`——
    //    而 D172 之后那是**已退役且不在盘上**的文件名（guard 实测报障：照旧文案会让人去翻
    //    一个不存在的文件）。真相源 = `<轨迹目录>/current.dsh_session_bind`。
    //    ⇒ 钉「指向真相源」而不是钉「某个历史文件名」：后者会把一次正确的修复判成回归。
    expect(res.detail).toContain('current.dsh_session_bind')
    expect(res.detail).not.toContain('.bindings.json')
  })

  it('目标未命中 → 报错', async () => {
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await deliverWake(ctx as never, root, { ...makeEntry(), target: 'S404' })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('未命中')
  })
})

describe('buildWakeText（投递正文：来源标记 + 时间 + 正文）', () => {
  it('含 message 与发起者；**不再**含目录名与 SESSION.md 绝对路径（§D1 已砍身份锚定）', () => {
    const entry: WakeEntry = {
      id: 'w-1', target: DIR_NAME, at: 'x', message: '做 A', state: 'pending', createdBy: 'S142',
      createdAt: 'y', attempts: 0, lastResult: null, deliveredAt: null,
    }
    const text = buildWakeText(entry, { dirName: DIR_NAME, mdPath: '/x/SESSION.md' })
    // 🔴 2026-11-02 §D1（owner Q3「全砍」）：身份锚定整句已删 ⇒ 反向钉住它**真的不在了**。
    //    ⚠️ 反向钉必须有正控配对（D222）：下面三行正向断言若不成立，这个反向钉就只是"什么都没生成"。
    expect(text).not.toContain(DIR_NAME)
    expect(text).not.toContain('/x/SESSION.md')
    // 正控配对：
    expect(text).toContain('做 A')
    expect(text).toContain('S142')
    expect(text).toContain('[认知轨迹唤醒]')
    // 当前时间必须留（v1.39.2 owner 令：冷载入目标上下文里没有任何近期时间锚）
    expect(text).toContain('当前时间：')
  })
})

/**
 * 即时投递（`cognitive_trajectory send-now`；2026-09-16 所有者裁决，**2026-09-17 由 `send-message` 更名**）。
 *
 * **钉住的不变量**：与 `send-later`（原 `wake-later`）**共用取用通路**（live 优先 → 冷载入），
 * 区别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）。
 * 设计稿 = `docs/cognitive-trajectory-send-message-design.md`（v0.2 定稿）。
 */
describe('sendToCognitiveTrajectory（即时投递：与 wake 共用取用通路）', () => {
  it('live 命中 ⇒ followup 收到**即时消息**正文（不是唤醒正文）', async () => {
    writeSessionDir()
    writeBinding('sess-live')
    const sent: string[] = []
    const fakeAgent = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    const ctx = { agents: { get: (id: string) => (id === 'sess-live' ? fakeAgent : undefined) } }

    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, '现在就做这件事', 'S142')
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('live(bound sess-live)')
    expect(sent).toHaveLength(1)
    // 正文要点：来自谁 / 是**即时消息** / 原样带上 message
    expect(sent[0]).toContain('[即时消息]')
    expect(sent[0]).toContain('S142')
    expect(sent[0]).toContain('现在就做这件事')
    // 🔴 2026-11-02 §D2（owner Q3「全砍」）：身份锚定整句已删 ⇒ 反向钉住目录名不再出现。
    //    ⚠️ 配正控（D222）：上面三条正向断言成立 ⇒ 这个反向钉才有意义。
    expect(sent[0]).not.toContain(DIR_NAME)
    // 🔴 关键区分：**不得**把它说成"到点唤醒"（那是错的事实）。
    // ⚠️ 判据形态订正（本轮实测踩到）：**不能用 `not.toContain('到点')`** —— 本正文里那句
    //    "（**不是**到点唤醒）"自身就含"到点" ⇒ 该断言是**假阳性**，会把我方措辞当违规。
    //    ⇒ 改用**精确判别符**：唤醒正文的头部标识 `[认知轨迹唤醒]`（`buildWakeText` 第一行）。
    expect(sent[0]).not.toContain('[认知轨迹唤醒]')
    expect(sent[0]).not.toContain('登记于')
  })

  it('非 live ⇒ 走 sessionController 冷载入（**等效于直接 wake**，但不等 tick）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const sent: string[] = []
    const resumed = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    let asked: string | null = null
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'sessionController'
        ? { resolveAgent: async (id: string) => { asked = id; return { agent: resumed } } }
        : undefined),
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, 'S999', '给冷会话的一句话', 'S142')
    expect(res.ok).toBe(true)
    expect(asked).toBe('sess-cold')
    expect(res.detail).toContain('cold-resume(sess-cold)')
    expect(sent[0]).toContain('给冷会话的一句话')
  })

  it('冷会话 + sessionController 缺席 ⇒ 响亮报错（不静默、不误报成功）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('sessionController')
  })

  it('无绑定记录 + create 可用 ⇒ **不再报错**，改为自动创建（语义已变，见 🆕 组）', async () => {
    writeSessionDir()
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    // ⚠️ 2026-10-16 起：无绑定**本身**不再是终局错误（`send-now` 会去建载体）；
    //    此处 `get()` 全缺 ⇒ 连 sessionController 都没有 ⇒ 仍报错，但**文案改指向 create 不可用**，
    //    且**照旧告诉调用方 `use` 是另一条路**（不把"没有"说成"做不到"）。
    expect(res.detail).toContain('sessionController.create')
    expect(res.detail).toContain('use')
  })

  // ── 🆕 2026-10-16（owner 令）：目标**没有活跃 dsh 会话** ⇒ 就地创建并注入 ──
  // 触发条件 = 「无绑定记录」（`.bindings.json` 里一条都没有）——这是**结构性判据**
  // （`acquireWakeAgent` 直接标出的 `noBinding`），**不是**匹配错误文案（见 D131 的教训）。
  it('🆕 无绑定 ⇒ **自动创建会话并绑定**，然后照常投递（正文里带"已自动创建"）', async () => {
    writeSessionDir()
    // 🔴 夹具补齐（本用例特有）：`appendBound` 靠 `cccRootForCwd` 上溯 `.serenity` 定位 CCC 根，
    //    而这些用例的 root 原本只是个裸 tmpdir（其余用例都直接手写 `.bindings.json`，绕开了这一步）。
    //    本用例要让**产品代码自己**去写绑定 ⇒ 夹具必须长成**真 CCC 的样子**（生产里 root 就是 CCC）。
    writeFileSync(join(root, '.serenity'), 'wake-test\n')
    const sent: string[] = []
    // 🔴 **必须同时提供 `steer`**（A96 修的正是这条用例的缺口）。
    // 改之前夹具**只有 `followup`**：自建载体的 status 因开场白变成 running ⇒ 产品代码走 `steer`
    // ⇒ 而夹具没有 `steer` ⇒ 抛错被 catch **退回 followup** ⇒ 两条进同一个数组、顺序恰好正确 ⇒ **绿**。
    // 真机上同样的调用真的走了 `steer`（next-step 整队认领、先于 next-turn）⇒ 顺序是倒的。
    // ⇒ 夹具缺的那两个成员**正好把被测路径换成了另一条**（D144 同族，更隐蔽）。
    // 现在把它补全：`steer` 单独记账，且 `status: 'running'` 重现"刚投完开场白"那一刻的真实状态。
    const steered: string[] = []
    const madeAgent = {
      status: 'running',
      followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') },
      steer: (m: { content: Array<{ text?: string }> }) => { steered.push(m.content[0]?.text ?? '') },
    }
    let created: { cwd?: string; workspaceId?: string } | null = null
    let resolvedId: string | null = null
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'sessionController'
        ? {
            create: async (req: { cwd?: string; workspaceId?: string }) => { created = req; return { sessionId: 'sess-created' } },
            resolveAgent: async (id: string) => { resolvedId = id; return { agent: madeAgent } },
          }
        : name === 'workspaceRegistry'
          // 🔴 2026-10-18：工作区在册 ⇒ 产品代码应当走 **workspaceId** 分支（= 用户同一形态）
          ? { list: () => [{ id: 'ws-ccc', path: root, sessionIds: [], attachSession: async () => {} }] }
          : undefined),
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, '给从未激活的轨迹', 'S142')
    expect(res.ok).toBe(true)
    // ① 🔴 **必须用 workspaceId**（= 用户操作的同一条分支；宿主管工作区归属）
    //    ⛔ 不能传 cwd：那条分支**不挂工作区**，正是本缺陷的根因。
    expect(created).toEqual({ workspaceId: 'ws-ccc' })
    // ② 拿 agent 走的是刚建出来的那个 id
    expect(resolvedId).toBe('sess-created')
    // ③ 绑定**真写进去了**（否则下一条消息还是找不到它 = "建了但永远用不上"）
    expect(listBoundSessionIds(root, DIR_NAME)).toContain('sess-created')
    // ④ 回执里明说"自动创建"，且正文照常送达
    expect(res.detail).toContain('auto-create(sess-created')
    // ⑤ 🔴 D171：自建后**先投一条"用户形态"开场白**，再投正文 ⇒ 共 2 条，且**顺序固定**。
    //    判据不能只写"长度 2"（那是弱断言：把两条都换成正文也过）。
    //    ⇒ 钉住**两条各是什么**：第 0 条是开场白（带自证标记），第 1 条才是正文。
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('[ACC 代用户开场]')
    expect(sent[0]).not.toContain('给从未激活的轨迹')
    expect(sent[1]).toContain('给从未激活的轨迹')
    // ⑥ 回执要如实说出开场白投没投（静默失败 = 以后查不到为什么没标题）
    expect(res.detail).toContain('opening-as-user')
    // ⑦ 🔴🔴 **A96 的承重判据：刚建出来的载体，任务必须走 `followup` 而绝不走 `steer`。**
    //    为什么这条才是真正的靶子：`steer` 落 `next-step`（每 step 整队认领，且宿主 `claim()`
    //    **先取 next-step**），而 anchor 与开场白落 `next-turn`（每 turn 只认 1 条）
    //    ⇒ 一旦任务走了 `steer`，它就会**插到所有 anchor 前面**、在 turn 1 就干完活。
    //    ⛔ 不能只断言 `sent` 里有两条：把实测的 `status:'running'` 留下，`sent` 仍然是两条
    //    （因为 catch 把 steer 失败退回 followup）—— 那正是旧夹具骗过我们的方式。
    expect(steered).toEqual([])
    expect(res.detail).toContain('刚建的载体')
  })

  /**
   * 🔴 **2026-10-21（owner 报「send-now 创建的会话标题不规范，看着碍眼」）**
   *
   * ## 现象
   * 宿主的自动取名器只拿到**开场白**当素材，于是标题被切成
   * `激活 <职能>会话` —— 既没有轨迹编码，也没有真正的职能描述。
   *
   * ## 根因（是"修 bug 制造了新 bug"，不是漏做）
   * ③b 投开场白**是为了让会话有标题**（宿主只认 `source.kind==='user'`），
   * 结果它成了**唯一的取名素材**。
   *
   * ## 修法与判据
   * 用宿主自己的 `sessionTitle.rename` 把标题**钉住**（`source:{kind:'user'}`
   * ⇒ abort 在飞的自动生成，且此后不再排自动取名）。
   * 🔴 **判据不是"标题好看"，而是"与 `use` 派生的一致"**（D182：设定不因入口而异）
   * ⇒ 断言直接调 `namingTitleFor` 现算期望值，**不抄一份字符串**（抄了就成了第二真相源）。
   */
  it('🔴 send-now 建的载体**标题必须被钉住**，且与 `use` 派生的一致（不是开场白切片）', async () => {
    writeSessionDir()
    writeFileSync(join(root, '.serenity'), 'wake-test\n')
    const madeAgent = {
      session: { id: 'sess-created', append: () => {} },
      followup: () => {},
    }
    /** 记录宿主 `sessionTitle.rename` 的调用（这就是"标题被钉住"的唯一机械判据） */
    const renames: Array<{ session: unknown; title: string }> = []
    const sessionTitle = {
      // 🔴 必须是**方法**（内部用 this）—— 解构裸调用会丢 this（v1.23.2 的坑）
      rename(session: unknown, title: string) { renames.push({ session, title }) },
    }
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => {
        if (name === 'sessionController') {
          return {
            create: async () => ({ sessionId: 'sess-created' }),
            resolveAgent: async () => ({ agent: madeAgent }),
          }
        }
        if (name === 'workspaceRegistry') {
          return { list: () => [{ id: 'ws-ccc', path: root, sessionIds: [], attachSession: async () => {} }] }
        }
        if (name === 'sessionTitle') return sessionTitle
        return undefined
      },
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, '正文', 'S142')
    expect(res.ok).toBe(true)

    // ① 标题**真的被写了**（一次，且写在那条刚建的会话上）
    expect(renames).toHaveLength(1)
    expect(renames[0]!.session).toBe(madeAgent.session)

    // ② 🔴 **与 `use` 派生的一致** —— 期望值现算，不写死字符串。
    //    `DIR_NAME` 无 S### 编码 ⇒ `namingTitleFor` 回退目录名（这正是既有 `use` 的行为）。
    const expected = namingTitleFor({
      sessionId: parseTrajectoryCode(DIR_NAME) ?? DIR_NAME,
      dirName: DIR_NAME,
      mdPath: join(root, 'AGENT_SESSIONS', DIR_NAME, 'SESSION.md'),
    })
    expect(renames[0]!.title).toBe(expected)

    // ③ **反向钉**：绝不能是开场白切片那种形状。
    //    只写"不等于 expected"还不够 —— 必须钉住"它不含为标题而生的那句动词短语"，
    //    否则将来有人把 expected 改坏成开场白切片，这条仍会绿。
    expect(renames[0]!.title).not.toContain('激活')
    expect(renames[0]!.title).not.toContain('[ACC 代用户开场]')

    // ④ 回执如实说出标题写没写（D186：不许不出声）
    expect(res.detail).toContain('titled')
  })

  it('sessionTitle 服务缺席 ⇒ 投递照常成功，但回执**响亮**说明标题没写', async () => {
    writeSessionDir()
    writeFileSync(join(root, '.serenity'), 'wake-test\n')
    const madeAgent = { session: { id: 'sess-created' }, followup: () => {} }
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'sessionController'
        ? {
            create: async () => ({ sessionId: 'sess-created' }),
            resolveAgent: async () => ({ agent: madeAgent }),
          }
        : name === 'workspaceRegistry'
          ? { list: () => [{ id: 'ws-ccc', path: root, sessionIds: [], attachSession: async () => {} }] }
          : undefined), // ← sessionTitle 刻意缺席
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, '正文', 'S142')
    // 🔴 标题是观感，**不许**因为拿不到服务就把一条能送达的消息判成失败
    expect(res.ok).toBe(true)
    // 但必须出声 —— 否则"标题没写"会表现成"这条轨迹就叫这名字"
    expect(res.detail).toContain('⚠️ 标题未写')
  })

  it('🆕 该目录**尚无工作区登记** ⇒ 退回 cwd 建会话，并由我们自己补挂（兜底，不是主路径）', async () => {
    writeSessionDir()
    writeFileSync(join(root, '.serenity'), 'wake-test\n')
    const madeAgent = { followup: () => {} }
    let created: { cwd?: string; workspaceId?: string } | null = null
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => (name === 'sessionController'
        ? {
            create: async (req: { cwd?: string; workspaceId?: string }) => { created = req; return { sessionId: 'sess-c2' } },
            resolveAgent: async () => ({ agent: madeAgent }),
          }
        : name === 'workspaceRegistry'
          ? { list: () => [] } // 空注册表 = 该目录还没被宿主登记过
          : undefined),
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(true)
    // 查不到工作区 ⇒ 退回 cwd（保住"落进同一个 CCC"这个底线）
    expect(created).toEqual({ cwd: root })
    expect(res.detail).toContain('via-cwd+attach')
  })

  /**
   * 🔴 **2026-10-17 缺陷（owner 报「目标没有活跃会话时，新建的会话工作区绑定不正确」）**
   *
   * 根因（宿主源码取证，**不是推断**）：
   *   `sessionController.create()` 的 `attachSession` **只在 `workspaceId` 分支里执行** ——
   *   `dsh-api-session-controller/lib/index.js` 的 `create()` 中：
   *     · `if (request.workspaceId !== void 0) { workspace = ...get(id) ... }`
   *     · `const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd`
   *     · `if (workspace !== void 0) { await workspace.attachSession(sessionId) }`  ← **只有这条分支挂工作区**
   *   ⇒ 我们传的是 `{ cwd: root }`（无 `workspaceId`）⇒ 会话**建出来了但从不登记进任何工作区**。
   *
   * 现场实证（本机真实数据）：`send-now` 自动建出的那条会话
   *   （note = `auto-created by send-now`）的 header `cwd` 确实指向某个 CCC 根，
   *   **却不在**该工作区的 `sessionIds` 里
   *   （同 CCC 的另外两条会话都在）⇒ UI 里它不属于那个工作区。
   *
   * 判据（本项目既有纪律「判据必须能被独立印证」）：**建完之后必须显式 `attachSession`**，
   *   且**按 cwd 找对工作区**（不能拿到第一个就挂）。
   */
  it('🔴 无绑定 ⇒ 自动建会话**必须选中 cwd 所属的工作区**（不是"拿第一个"）', async () => {
    writeSessionDir()
    writeFileSync(join(root, '.serenity'), 'wake-test\n')
    const madeAgent = { followup: () => {} }
    let createdReq: { cwd?: string; workspaceId?: string } | null = null
    const wsHome = { id: 'ws-home', path: root, sessionIds: ['sess-existing'], attachSession: async () => {} }
    // 干扰项：**另一个工作区**排在前面。若实现"拿第一个"，会选中它 —— 会话就落到错的 CCC。
    const wsOther = { id: 'ws-other', path: '/somewhere/else', sessionIds: [], attachSession: async () => {} }
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => {
        if (name === 'sessionController') {
          return {
            create: async (req: { cwd?: string; workspaceId?: string }) => { createdReq = req; return { sessionId: 'sess-created' } },
            resolveAgent: async () => ({ agent: madeAgent }),
          }
        }
        if (name === 'workspaceRegistry') return { list: () => [wsOther, wsHome] }
        return undefined
      },
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, '给从未激活的轨迹', 'S142')
    expect(res.ok).toBe(true)
    // 🔴 选中 (root 对应的) ws-home，而**不是**排在前面的 ws-other
    expect(createdReq).toEqual({ workspaceId: 'ws-home' })
  })

  it('🔴 兜底路径的工作区挂载失败 ⇒ **不吞**：回执里明说（建会话与绑定本身成功）', async () => {
    writeSessionDir()
    writeFileSync(join(root, '.serenity'), 'wake-test\n')
    const madeAgent = { followup: () => {} }
    // 让注册表在**第一次读**时为空（迫使走 cwd 兜底），之后返回一个 attachSession 会抛的工作区。
    // —— 这样才测得到"兜底那条路失败时不吞原因"。
    let firstList = true
    const wsHome = {
      id: 'ws-home',
      path: root,
      sessionIds: [],
      attachSession: async () => { throw new Error('workspace store locked') },
    }
    const ctx = {
      agents: { get: () => undefined },
      get: (name: string) => {
        if (name === 'sessionController') {
          return {
            create: async () => ({ sessionId: 'sess-created' }),
            resolveAgent: async () => ({ agent: madeAgent }),
          }
        }
        if (name === 'workspaceRegistry') {
          return {
            list: () => {
              if (firstList) { firstList = false; return [] }
              return [wsHome]
            },
          }
        }
        return undefined
      },
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    // 消息照常投递（工作区挂载不是投递前提）——但必须如实报出
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('workspace store locked')
  })

  it('🆕 无绑定但 sessionController.create 缺席 ⇒ 报错（不静默、不误报成功）', async () => {
    writeSessionDir()
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('sessionController.create')
  })

  it('🆕 create 抛错 ⇒ 报错带原因（不静默吞掉）', async () => {
    writeSessionDir()
    const ctx = {
      agents: { get: () => undefined },
      get: () => ({ create: async () => { throw new Error('db locked') } }),
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('就地创建会话失败')
    expect(res.detail).toContain('db locked')
  })

  it('🔴 反侧：**有绑定但冷载入失败** ⇒ 不建新会话（那不是"没载体"，是"载体此刻取不到"）', async () => {
    writeSessionDir()
    writeBinding('sess-cold')
    let createCalled = false
    const ctx = {
      agents: { get: () => undefined },
      get: () => ({
        create: async () => { createCalled = true; return { sessionId: 'x' } },
        resolveAgent: async () => { throw new Error('load boom') },
      }),
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(createCalled).toBe(false)
    expect(res.detail).toContain('冷会话载入失败')
  })

  it('目标未命中 ⇒ 报错', async () => {
    const ctx = { agents: { get: () => undefined }, get: () => undefined }
    const res = await sendToCognitiveTrajectory(ctx as never, root, 'S404', 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('未命中')
  })

  it('followup 抛错 ⇒ ok:false 且留原因（不静默吞掉）', async () => {
    writeSessionDir()
    writeBinding('sess-boom')
    const ctx = {
      agents: {
        get: (id: string) => (id === 'sess-boom'
          ? { followup: () => { throw new Error('driver down') } }
          : undefined),
      },
    }
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, 'x', 'S142')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('投递失败')
    expect(res.detail).toContain('driver down')
  })

  it('🔴 **不落注册表**（所有者 2026-09-16 裁 (A)）—— 唤醒注册表保持"未来时刻表"单一语义', async () => {
    writeSessionDir()
    writeBinding('sess-live')
    const ctx = {
      agents: { get: (id: string) => (id === 'sess-live' ? { followup: () => {} } : undefined) },
    }
    const before = listWakes(root).entries.length
    const res = await sendToCognitiveTrajectory(ctx as never, root, DIR_NAME, '不留痕的一句话', 'S142')
    expect(res.ok).toBe(true)
    expect(listWakes(root).entries.length).toBe(before)
  })
})

describe('🔴 回归钉：即时投递**不得**靠放宽 addWake 来实现（两者语义分界不许被抹平）', () => {
  it('addWake 仍然拒绝 at ≤ now（"时刻必须在未来"）', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    // 过去的绝对时刻
    expect(addWake(root, { target: DIR_NAME, at: '2026-09-16T11:00:00Z', message: 'x', createdBy: 'S142', nowMs: now }).ok).toBe(false)
    // 恰好现在
    expect(addWake(root, { target: DIR_NAME, at: '2026-09-16T12:00:00Z', message: 'x', createdBy: 'S142', nowMs: now }).ok).toBe(false)
    // 拒绝理由必须点名"未来"（不是含糊的解析失败）
    const r = addWake(root, { target: DIR_NAME, at: '2026-09-16T11:00:00Z', message: 'x', createdBy: 'S142', nowMs: now })
    expect(r.ok === false && r.error).toContain('未来')
    // 正控：真正未来的仍可登记（证明上面的 false 不是解析器坏了）
    expect(addWake(root, { target: DIR_NAME, at: '+1h', message: 'x', createdBy: 'S142', nowMs: now }).ok).toBe(true)
  })
})

/**
 * 时钟武装门（**F 段缺陷回归钉**，2026-09-14）。
 *
 * 缺陷（实测）：CCC 根只能从 live 会话反推，而宿主刚重启时 live 会话必为空；
 * 旧实现把"有 live CCC"当**武装前置条件** ⇒ 启动瞬间落空即**永久不武装**
 * （`session/created` 只覆盖"新建会话"，不覆盖"浏览器恢复旧会话"）。
 * 实测证据：2026-09-14T16:30Z 重启后零 tick 达 6.6h，注册表条目超窗仍 `pending`。
 * ⇒ 修复：**全局闸开即武装**；"有无 live CCC"降级为 tick 内的廉价判定。
 */
describe('registerWakeScheduler（时钟武装门 + 进程态可观测）', () => {
  let listeners: Record<string, Array<() => void>>
  let disposers: Array<() => void>
  let timer: { fn: () => void } | null
  let liveSessions: unknown[]

  beforeEach(() => {
    listeners = {}
    disposers = []
    timer = null
    liveSessions = []
    __resetWakeSchedulerStateForTest()
    __setSimpleSourceForTest(() => defaultSimpleSettings())
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void) => {
      timer = { fn }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => { timer = null })
  })

  afterEach(() => {
    __resetWakeSchedulerStateForTest()
    __setSimpleSourceForTest(null)
    vi.restoreAllMocks()
  })

  function makeCtx(): unknown {
    return {
      sessions: { list: () => liveSessions },
      agents: { get: () => undefined },
      get: () => undefined,
      on: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn) },
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  it('🔴 2026-09-21 砍闸回归钉：旧键 `wakeSchedulerEnabled=false` **残留在配置里也照样武装**', () => {
    // 所有者令（逐字）：「send-later 的开关不再重要了，砍掉」⇒ 该键**已不存在**，旧配置里的残留值**静默忽略**。
    // 这条钉锁两件事：① 闸**真的没有了**（不会被残留的旧值关掉 —— 否则"整条链静默停摆"会重演）
    //                ② 兼容（不因残留键报错/降级/告警噪声）
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), wakeSchedulerEnabled: false }))
    registerWakeScheduler(makeCtx() as never)
    expect(timer).not.toBeNull() // 仍武装
    expect(wakeSchedulerState().armed).toBe(true)
  })

  it('无闸 ⇒ 恒武装；`enabled` 字段恒 true（保留只为沿用工厂快照形状，不再是闸值）', () => {
    __setSimpleSourceForTest(() => defaultSimpleSettings())
    registerWakeScheduler(makeCtx() as never)
    expect(timer).not.toBeNull()
    expect(wakeSchedulerState().enabled).toBe(true)
  })

  // ⚠️ 2026-09-21 移除两条旧钉：「闸显式关 → 不武装」「S-1 两闸解耦（关 autopilot 不关本闸）」
  //    —— **主语已消失**（本钟无闸；且 ACC 侧 autopilot 在 v1.35.0 整段退场后，"两闸"只剩一座，
  //    现整座移除）。按本仓先例（A15：「主语消失 ⇒ 销项」）删除而非留成空转断言。
  //    它们的**意图**由上面第一条钉继承：唤醒调度器**不得**再有任何"能被误关"的开关。

  it('🔴 全局闸开 + **零 live 会话** → 仍武装（修复前此处永久不武装）', async () => {
    registerWakeScheduler(makeCtx() as never) // liveSessions = []
    expect(timer).not.toBeNull()
    const st0 = wakeSchedulerState()
    expect(st0.armed).toBe(true)
    expect(st0.armedAt).not.toBeNull()
    // v1.35（C2 块 C1）：CCC 枚举改**并集**（含持久来源），故"无 CCC 可扫"的判定下沉到
    // runWakeTick 内部 ⇒ 这次 tick **真执行了**（计 ticks），只是提前 return 并把原因留痕。
    // 语义澄清：`ticks` = "真执行过的 tick"，不是"真投递过的 tick"。
    await new Promise((r) => setTimeout(r, 20)) // runWakeTick 为 async（并集枚举含 await）
    const st = wakeSchedulerState()
    expect(st.ticks).toBe(1)
    expect(st.lastSkipReason).toContain('无已知 CCC 可扫')
  })

  it('live 会话出现后 tick 真执行并清空 skip 原因（末次 tick 状态）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    const ctx = makeCtx()
    registerWakeScheduler(ctx as never) // 启动即 tick 一次（此时无 live ⇒ skip，ticks=1）
    // 🔴 2026-11-02 §A3「跳拍而非排队」：必须**等启动那一拍真的跑完**再走下一拍。
    //    修前这里是"两拍一起排队"——旧语义下第二拍会在链尾等着；新语义下它会因
    //    "上一拍仍在飞"而被**丢弃**（那正是 §A3 要的）。⇒ 本用例的意图（"live 出现后
    //    下一拍真执行并清 skip 原因"）不变，只是取拍方式要改成**逐拍串行**。
    await new Promise((r) => setTimeout(r, 20))
    liveSessions = [{ id: 's1', header: { cwd: root } }]
    ;(timer as unknown as { fn: () => void }).fn()
    await new Promise((r) => setTimeout(r, 20))
    const st = wakeSchedulerState()
    // 两次 tick：启动那次（空转，留痕）+ 本次（有 CCC，清空 skip 原因）
    expect(st.ticks).toBe(2)
    expect(st.lastTickAt).not.toBeNull()
    expect(st.lastSkipReason).toBeNull()
  })

  it('🔴 到期条目被真投递 → 收到正文，且**投递后条目被清除**（owner 2026-09-19 裁「直接删」）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    // 把条目改成"已到期"（不改系统时钟）
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() })
    // 投递前：确实在表里（否则下面的"清除了"就没有对照）
    expect(listWakes(root).entries.map((e) => e.id)).toContain(added.entry.id)
    const sent: string[] = []
    const ctx = {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: (id: string) => (id === 'sess-live' ? { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } } : undefined) },
      get: () => undefined,
      on: () => undefined,
      effect: () => undefined,
    }
    registerWakeScheduler(ctx as never) // 启动即 tick 一次
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('到点干活')
    // 🔴 行为变更钉（§0Q 甲案）：终态条目**不再留在表里** ⇒ 注册表只保在办项（表不再只增）
    expect(listWakes(root).entries, '投递成功后该条应已被清除').toHaveLength(0)
  })

  it('🔴 超窗条目 → 置 missed 后**同样被清除**（终态一律不留行）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '过期活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    // 拨到**超出补跑窗口**（2h + 1m）
    updateWake(root, added.entry.id, { at: new Date(Date.now() - (WAKE_CATCH_UP_MS + 60_000)).toISOString() })
    // ⚠️ 必须让本 CCC **可被发现**（tick 只扫"已知 CCC"——来源是 live 会话/工作区）：
    //    否则 roots 为空 ⇒ 整个 tick 空转，本用例会假红（首跑即踩此坑）。
    const ctx = {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: () => undefined },
      get: () => undefined,
      on: () => undefined,
      effect: () => undefined,
    }
    registerWakeScheduler(ctx as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(listWakes(root).entries, '超窗结案后该条应已被清除').toHaveLength(0)
  })

  it('🔴 启动窗口（宿主服务未就绪）⇒ 条目**不被记失败**：state/attempts/lastResult 全不动', async () => {
    // 复现 2026-09-17 21:09 的真实现场：`dsh web` 刚重启 ⇒ 时钟武装时**立刻跑一次 tick**，
    // 而那一拍早于懒服务 `sessionController` 就绪、也早于会话恢复。
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-cold')
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() }) // 改成已到期
    const ctx = {
      // CCC 可被发现（另有 live 会话在同 CCC 里）——但**目标**会话没加载，且懒服务缺席：
      sessions: { list: () => [{ id: 'sess-other', header: { cwd: root } }] },
      agents: { get: () => undefined },
      get: () => undefined, // ← sessionController 缺席（启动窗口的实况）
      on: () => undefined,
      effect: () => undefined,
    }
    registerWakeScheduler(ctx as never) // 启动即 tick 一次
    await new Promise((r) => setTimeout(r, 30))
    const e = listWakes(root).entries[0]!
    expect(e.state).toBe('pending') // 仍待投（不是"投失败"）
    expect(e.attempts).toBe(0) // 🔴 不计次 —— 修复前这里会被加成 1（假失败）
    expect(e.lastResult).toBeNull() // 🔴 不留假陈述 —— 修复前会写入"sessionController 不可用"
    expect(e.deliveredAt).toBeNull()
  })

  it('卸载（disposer）→ 时钟停止且进程态复位（不留"看着还在跑"的假象）', () => {
    registerWakeScheduler(makeCtx() as never)
    expect(wakeSchedulerState().armed).toBe(true)
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    expect(timer).toBeNull()
    expect(wakeSchedulerState().armed).toBe(false)
    expect(wakeSchedulerState().armedAt).toBeNull()
  })
})

/**
 * CRO 与调度器的**集成**（S142 §7.9，设计 §5/§6）——
 * 这里测的不是"CRO 逻辑对不对"（`cro.test.ts` 已测），而是**它与既有链路的关系**：
 *   · 🔴 设计 §5 的机械判据：**故意报错的 CRO 程序，不得影响既有投递**
 *   · 设计 §6.1：CRO 判定为真 ⇒ 走投递（真起子进程 + 真投递 → 收到 CRO 正文）
 *   · 设计 §6.3：**CRO 不写唤醒表**（判定为真也不给表增加/清除任何一行）
 *
 * ⚠️ 每个用例都必须让本 CCC **可被发现**（`sessions.list` 给 cwd = root），
 *    否则 `roots` 为空 ⇒ 整个 tick 空转，用例会**假红**（本仓已踩过此坑，见上文同款注释）。
 */
describe('🔴 CRO 与调度器集成（设计 §5 铁律 / §6.3 不落表）', () => {
  let disposers: Array<() => void>
  let timer: { fn: () => void } | null

  beforeEach(() => {
    disposers = []
    timer = null
    __resetWakeSchedulerStateForTest()
    __resetCroTurnsForTest()
    __setSimpleSourceForTest(() => defaultSimpleSettings())
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void) => {
      timer = { fn }
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => {
      timer = null
    })
  })

  afterEach(() => {
    __resetWakeSchedulerStateForTest()
    __resetCroTurnsForTest()
    __setSimpleSourceForTest(null)
    vi.restoreAllMocks()
  })

  /** 一个"CCC 可被发现 + 目标会话 live + 收集投递正文"的 ctx */
  function croCtx(sent: string[]): unknown {
    const agent = { followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') } }
    return {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: (id: string) => (id === 'sess-live' ? agent : undefined) },
      get: () => undefined,
      on: () => undefined,
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  it('🔴 铁律：**故意报错**的 CRO 程序 ⇒ 既有投递链路一切正常（设计 §5 的机械判据）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, "throw new Error('cro boom')\n") // 🔴 半成品：跑起来就报错
    writeCroHostBinding() // 机器绑定门：本用例测铁律 ⇒ 先过门（否则测的是门）
    const added = addWake(root, { target: DIR_NAME, at: '+5m', message: '到点干活', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    updateWake(root, added.entry.id, { at: new Date(Date.now() - 60_000).toISOString() }) // 改成已到期
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never) // 启动即 tick 一次
    await waitFor(() => sent.length > 0)
    // 🔴 **同步点必须在 tick 收尾**，不能只等"副作用出现了"：
    //    `lastTickLog` 是 **body 跑完之后**才写回的（`clock-runtime` 的 tick 外壳），
    //    而到点投递（副作用）发生在 body **中途** ⇒ 只等 `sent` 会读到**上一拍的日志**（实测假红一次）。
    //    这与 v1.42.0 那条「tick 类用例必须先让被测 CCC 可被发现」同族：**都是测试脚手架的同步问题**。
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).length > 0)
    // ① 既有链路**照常工作**：到点条目仍被投递
    expect(sent, 'CRO 报错绝不能让到点唤醒投不出去').toHaveLength(1)
    expect(sent[0]).toContain('到点干活')
    // ② 条目照常结案清除（既有语义不受影响）
    expect(listWakes(root).entries).toHaveLength(0)
    // ③ CRO 的失败**被看见**（不是静默吞掉）——留痕在 tick 日志里
    const log = (wakeSchedulerState().lastTickLog ?? []).join('\n')
    expect(log).toContain('CRO')
    expect(log).toContain('跳过本轮')
  }, 20_000)

  it('🟢 CRO 判定为真 ⇒ 真起子进程并投递 CRO 正文（快照确实经 stdin 到达程序）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    // reason 里回填 `dir=o.identity.dirName` ⇒ 若 stdin 没送到，这一条就取不到值
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"你的 SESSION.md 已很大，请先压缩再继续。"}'))
    writeCroHostBinding()
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => sent.length > 0)
    expect(sent, 'CRO 判定为真应投递一条').toHaveLength(1)
    expect(sent[0]).toContain('CRO 唤起') // 正文**自我表明**来源（不是唤醒正文、不是即时消息）
    expect(sent[0]).toContain('你的 SESSION.md 已很大') // 提示词透传
    expect(sent[0]).toContain(`dir=${DIR_NAME}`) // 🔴 快照经 stdin 真到达了程序
    expect(sent[0]).not.toContain('[认知轨迹唤醒]') // 不得冒充"到点唤醒"
  }, 20_000)

  it('🔴 CRO **不写唤醒表**（设计 §6.3）：判定为真 ⇒ 投递，但表里一行都不增不减', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"该干活了"}'))
    writeCroHostBinding()
    // 一条**未到期**的在办条目：它是"表内容"的对照物（既不该被 CRO 清掉，也不该被 CRO 补写）
    const keep = addWake(root, { target: DIR_NAME, at: '+5m', message: '稍后再干', createdBy: 'S142', nowMs: Date.now() })
    expect(keep.ok).toBe(true)
    if (!keep.ok) return
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => sent.length > 0)
    expect(sent).toHaveLength(1) // CRO 的投递发生了
    const entries = listWakes(root).entries
    expect(entries.map((e) => e.id)).toEqual([keep.entry.id]) // 表内容**逐字未变**
    expect(entries[0]!.state).toBe('pending')
    expect(entries[0]!.attempts).toBe(0) // 也没被 CRO 误记为"投过"
  }, 20_000)

  it('不唤起（wake:false）⇒ 不投递任何消息（**常态是不打扰**）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":false,"reason":"天还没亮"}'))
    writeCroHostBinding()
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 8_000)
    expect(sent).toHaveLength(0)
    // 汇总行仍如实报告"评估了 1 条、唤起 0"
    const log = (wakeSchedulerState().lastTickLog ?? []).join('\n')
    expect(log).toContain('CRO 评估 1 条（唤起 0')
  }, 20_000)

  /** 一个"CCC 可被发现 + 目标**无 live 载体** + 无 sessionController"的 ctx（投递走 notReady 分支） */
  function croCtxNoTarget(): unknown {
    return {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] }, // CCC 仍可被发现
      agents: { get: () => undefined }, // 但没有活着的 agent
      get: () => undefined, // 也没有 sessionController（冷载入通道缺席）
      on: () => undefined,
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  /** 一个"目标 live 但投递动作抛错"的 ctx（**真失败**，非 notReady） */
  function croCtxThrowOnDeliver(): unknown {
    const agent = {
      followup: () => {
        throw new Error('followup boom')
      },
    }
    return {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: (id: string) => (id === 'sess-live' ? agent : undefined) },
      get: () => undefined,
      on: () => undefined,
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  it('🟢 **成功唤起 ⇒ 落一条流水**（真 tick ⇒ 真子进程 ⇒ 真投递 ⇒ 真落盘）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"该整理日志了","reason":"心跳到点"}'))
    writeCroHostBinding()
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    expect(sent).toHaveLength(1)
    // 🔴 判据 = **磁盘上的档**（不是返回值）：固定名文件就在该轨迹目录里
    const path = croWakeLogPath(root, DIR_NAME)
    expect(existsSync(path), 'CRO 唤起的流水必须落在轨迹目录的固定名文件里').toBe(true)
    // 🔴 走模块自己的读取器（纯文本形态只有它认得对）：**不另写一份解析**
    const entries = loadCroWakeLog(root, DIR_NAME).log.entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(true)
    // ⚠️ 用 toContain 而非全等：`croProgram` 会把 `dir=<目录名>` 接在 reason 后（证明 stdin 真到达程序）
    expect(String(entries[0]!.reason)).toContain('心跳到点')
    expect(String(entries[0]!.detail)).toContain('已投递')
    expect(typeof entries[0]!.tick).toBe('number')
    expect(entries[0]!.promptDigest).toMatchObject({ length: 6, head: '该整理日志了' })
  }, 30_000)

  it('🔴 **投递失败 ⇒ 也落一条（ok:false + 原因）**（所有者令「失败成功都记录」）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"叫我"}'))
    writeCroHostBinding()
    registerWakeScheduler(croCtxThrowOnDeliver() as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    const path = croWakeLogPath(root, DIR_NAME)
    expect(existsSync(path), '失败也是一次"唤起尝试" ⇒ 必须留痕').toBe(true)
    const entries = loadCroWakeLog(root, DIR_NAME).log.entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(String(entries[0]!.detail)).toContain('followup boom') // 原因可重建（不是空串）
    // 既有链路照常：CRO 的失败没有连累任何东西
    expect(listWakes(root).entries).toHaveLength(0)
  }, 30_000)

  /**
   * 🔴🔴 **D209（2026-10-23 guard 实测报障，owner 认这是最痛的点）**：
   * `notReady` **不再是"不记录"，而是记成第三态 `not-ready`**。
   *
   * ## 旧行为错在哪（这一格原来钉的正是它）
   * 原断言是 `existsSync(...).toBe(false)` —— 它把「**不能记成失败**」（对的）
   * 落实成了「**整条不记**」（错的）。后果是**最坏的那种静默**：
   * CRO 判定正确、`wake:true` 发出、投递被 `sessionController` 未就绪挡住，
   * 而该轨迹的 `cro-wake-log.log` **一个字都没有**
   * ⇒ 读日志的人只能得到「CRO 从没工作过」，而真相是「工作了、投递被挡」。
   *
   * 🔴 **判据（D186 的又一次应用）：可以不算失败，但不许不出声。**
   * ⇒ 三态必须**各自可分**：`ok` ／ `fail` ／ `not-ready`。
   *    ⛔ 折进 `ok:true` = 假成功；折进 `fail` = 假失败（违反 `:171` 语义）。
   */
  it('🔴 D209 `notReady`（环境未就绪）⇒ **落一条 `not-ready`**（不算失败，但必须可见）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"叫我"}'))
    writeCroHostBinding()
    registerWakeScheduler(croCtxNoTarget() as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    // ① tick 日志里看得到"投递未成功"
    const log = (wakeSchedulerState().lastTickLog ?? []).join('\n')
    expect(log).toContain('投递未成功')
    // ② 🔴 流水档**必须存在**（这就是 D209 的靶子：以前它是 false）
    expect(existsSync(croWakeLogPath(root, DIR_NAME)), 'notReady 也必须留痕，否则等于 CRO 没工作过').toBe(true)
    const entries = loadCroWakeLog(root, DIR_NAME).log.entries
    expect(entries).toHaveLength(1)
    // ③ 三态可分辨：`ok` 为 false，但 **`notReady` 为 true**
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.notReady, '必须与真正的 fail 区分开（否则读日志的人分不出该重试还是该修）').toBe(true)
    // ④ 落盘的**纯文本行**同样要能表达第三态
    //    （读侧若只认 ok/fail，这行会被当坏行**静默丢弃** —— 那等于又静默了一次）
    expect(readFileSync(croWakeLogPath(root, DIR_NAME), 'utf-8')).toContain('\tnot-ready\t')
  }, 30_000)

  it('🔴 D209 `notReady` 与**真失败**在流水里是两种标记（同一份档里可比对）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"叫我"}'))
    writeCroHostBinding()
    // 先落一条 not-ready（notReady 分支）
    registerWakeScheduler(croCtxNoTarget() as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    // 再落一条真失败（followup 抛错）。
    // ⚠️ **必须重置进程态 + 重建时钟**：`registerWakeScheduler` 只在**首次**装配时武装，
    //    第二次调用不会自动再 tick 一次（调度器是幂等的）。不重置 ⇒ 第二格**永远不会跑**
    //    ⇒ 本用例会红在"没有 fail 行"，而真因是**第二格根本没执行**（D205 同族：先让格子成立）。
    __resetWakeSchedulerStateForTest()
    // 换一个新的 tick 来源：直接制造一条真失败
    registerWakeScheduler(croCtxThrowOnDeliver() as never)
    // 触发一次 tick（与既有用例同一条路：启动即 tick 一次）
    await waitFor(
      () => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')),
      20_000,
    )
    const text = readFileSync(croWakeLogPath(root, DIR_NAME), 'utf-8')
    expect(text, '未就绪标 not-ready').toContain('\tnot-ready\t')
    expect(text, '真失败仍标 fail').toContain('\tfail\t')
  }, 30_000)

  /**
   * 🔴🔴 **A102（2026-10-23）推翻了本条的原前提 —— 按 D184 改钉，不是放宽。**
   *
   * ## 原前提（v1.87.x 及以前）
   * 「不唤起（`wake:false`）⇒ **不产生流水档**（没有尝试就没有记录）」。
   * 它隐含的假设是：**流水只记"尝试"**。
   *
   * ## 原前提被谁取代
   * 实测（guard 轨迹，真机）：该轨迹的 `cro-wake-log.log` **永久停在 `01:40:55`**，
   * 而它**此后每个 tick 都在被评估**、只是判定为"不打扰"
   * ⇒ owner 据此得出「守卫从那以后就没工作过」，**与事实相反**。
   * ⇒ 病根就是本用例钉住的那条：`no-wake` **一个字都不落盘**
   * ⇒ **「我判了、只是不叫」与「我根本没被评估」在读数上完全一样**。
   *
   * ## 新判据（D209 同族第三条）
   * **可以不出声地判"不打扰"，但"判过"本身要留痕。**
   * ⇒ 四态：`ok` ／ `fail` ／ `not-ready` ／ `no-wake`。
   * ⚠️ 「没有 CRO 文件的轨迹不建档」那条**仍然成立**（见 `appendCroWakeLog` 的注释：
   *    只有真的发生过一次判定才建/写该档）—— 那是**另一格**，别和本条混。
   */
  it('🔴 A102 不唤起（wake:false）⇒ **落一条 `no-wake`**（判了就要留痕，但不是失败）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":false,"reason":"没事"}'))
    writeCroHostBinding()
    const sent: string[] = []
    registerWakeScheduler(croCtx(sent) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    // ① 档必须存在（这句是本条改钉的核心：原断言是 `.toBe(false)`）
    expect(existsSync(croWakeLogPath(root, DIR_NAME)), 'no-wake 也是"判过" ⇒ 必须留痕').toBe(true)
    // ② 四态可分辨：不是 ok、也不是 fail，而是 noWake
    const entries = loadCroWakeLog(root, DIR_NAME).log.entries
    expect(entries.length).toBeGreaterThan(0)
    const last = entries[entries.length - 1]!
    expect(last.ok, '不唤起不是成功').toBe(false)
    expect(last.noWake, '必须与真失败区分开 —— 否则每次不叫都像在报错，会把真失败淹掉').toBe(true)
    expect(last.notReady, '也不能混进 not-ready（那是"投递被挡"）').toBeUndefined()
    // ③ 理由要可重建（不能是空串）
    expect(String(last.reason)).toContain('没事')
    // ④ 落盘的纯文本行同样要能表达第四态（读侧不认 ⇒ 整行被当坏行静默丢弃 = 又静默了一次）
    expect(readFileSync(croWakeLogPath(root, DIR_NAME), 'utf-8')).toContain('\tno-wake\t')
    // ⑤ 🔴 它**不能**触发任何投递（这是「不叫」的定义）
    expect(sent).toHaveLength(0)
  }, 30_000)

  it('🔴 A102 `no-wake` 与 `fail`／`not-ready` 在流水里是**三种不同标记**（可逐条比对）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCro(DIR_NAME, croProgram('{"wake":false,"reason":"不打扰"}'))
    writeCroHostBinding()
    registerWakeScheduler(croCtx([]) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    expect(readFileSync(croWakeLogPath(root, DIR_NAME), 'utf-8')).toContain('\tno-wake\t')
  }, 30_000)

  it('🔴 没有 CRO 文件的轨迹 ⇒ **仍然不建档**（A102 没有推翻这一格）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCroHostBinding()
    // 刻意不写 CRO 程序：该轨迹根本不在 CRO 名单里 ⇒ 谈不上"判过"
    registerWakeScheduler(croCtx([]) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')), 20_000)
    expect(existsSync(croWakeLogPath(root, DIR_NAME)), '没有 CRO ⇒ 没有判定 ⇒ 不该建空档').toBe(false)
  }, 30_000)

  // ── 🆕 2026-10-23：CRO 投递面的**载体自举**及其闸门（guard 实测报障后补）──────────────
  //
  // ## 缺陷（真实代价，不是假想）
  //   一条「生来就是为了被自己的 CRO 叫醒」的轨迹是**程序化 `create` 出来的** ⇒ 没有载体
  //   ⇒ `acquireWakeAgent` 给 `noBinding` ⇒ `deliverCroWake` 直接返回 error
  //   ⇒ **第一次自唤醒在物理上不可能**，而那恰恰是最需要被叫醒的一刻。
  //   实测证据：`cro-wake-log.log` 首行 `fail … 无绑定会话记录`，而那一轮 CRO 判定完全正确。
  //
  // ## 为什么不能照搬 `send-now` 的自举
  //   `send-now` 的自举理由是「完成一次**人/agent 的**意图」（一次性）；
  //   CRO 是**每 5min 自动重判**，若无条件自建 ⇒ 载体反复膨胀。
  //   ⇒ 本路径只认 `carrierState === 'never'`，下面两条用例分别钉住它的两侧。

  /** 一个带 `sessionController`（能建会话）的 CRO ctx；`createCalls` 供"有没有建"这条判据读 */
  function croCtxCanCreate(sent: string[], createCalls: string[]): unknown {
    const agent = {
      session: { id: 'sess-born', append: () => {} },
      followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') },
    }
    return {
      sessions: { list: () => [{ id: 'sess-live', header: { cwd: root } }] },
      agents: { get: () => undefined }, // 没有任何活着的 agent ⇒ 才有 `noBinding` 之后的自举可言
      get: (name: string) => {
        if (name === 'sessionController') {
          return {
            create: async () => { createCalls.push('create'); return { sessionId: 'sess-born' } },
            resolveAgent: async () => ({ agent }),
          }
        }
        if (name === 'workspaceRegistry') {
          return { list: () => [{ id: 'ws-ccc', path: root, sessionIds: [], attachSession: async () => {} }] }
        }
        return undefined
      },
      on: () => undefined,
      effect: (cb: () => () => void) => { disposers.push(cb()) },
    }
  }

  /**
   * 🟢 **`carrierState === 'never'` ⇒ 自动建载体并投递成功**（"从未有过"这一侧）。
   *
   * 🔴 **判据打在副作用上，不打在返回值上**（D144/D157 同族）：
   * 真正只有"成功"才会产生的东西是 **`current.dsh_session_bind` 出现在盘上**，
   * 以及流水档里那条 `ok:true`。只断言"投出去了"证明不了载体被建过。
   */
  it('🟢 CRO 载体自举：`never`（从未有过载体）⇒ **自动创建并绑定**，随后照常投递', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    // ⛔ 刻意**不写** `current.dsh_session_bind`：这就是"从未有过载体"的真形态
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"该自检了"}'))
    writeCroHostBinding()
    const sent: string[] = []
    const createCalls: string[] = []
    registerWakeScheduler(croCtxCanCreate(sent, createCalls) as never)

    await waitFor(
      () => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')),
      30_000,
    )

    // ① 自举**确实发生了**（不是靠"没报错"推出来的）
    expect(createCalls, 'never ⇒ 允许建一次载体').toHaveLength(1)
    // ② 🔴 **只有成功才会留下的痕迹**：绑定文件落盘，且指向刚建的会话
    const bindPath = join(root, 'AGENT_SESSIONS', DIR_NAME, 'current.dsh_session_bind')
    expect(existsSync(bindPath), '自举成立的定义就是"绑定真写进去了"（否则下一条消息还是找不到它）').toBe(true)
    expect(readFileSync(bindPath, 'utf-8')).toContain('sess-born')

    // ③ 投递成立：第 0 条是自建载体的开场白（D171），第 1 条才是 CRO 正文 ⇒ 顺序固定
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('[ACC 代用户开场]')
    expect(sent[1]).toContain('CRO 唤起')
    expect(sent[1]).toContain('该自检了')

    // ④ 流水档如实记成功（失败成功都记录 = owner 令）
    const entries = loadCroWakeLog(root, DIR_NAME).log.entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(true)
  }, 40_000)

  /**
   * 🔴 **`carrierState === 'occupied'`（有过载体、那个会话现在不在了）⇒ 一律不建**。
   *
   * 这是自举的**闸门本身**：CRO 每 5min 重判一次，若 `occupied` 也自建，
   * 一条载体退役的轨迹会**每 5 分钟长出一个新载体**。
   * ⇒ 判据 = **`create` 一次都没被调用** ＋ 绑定文件**逐字未变** ＋ 流水如实报错并指名是哪一半。
   */
  it('🔴 CRO 载体自举的闸门：`occupied`（有过但会话不在了）⇒ **不建**，如实报错', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    // 🔴 夹具必须先造出**一个真实存在的 sessions root**（`writeSessionLog('sess-other')`），
    //    否则 `hasSessionLogById` 走到它的 **fail-closed** 分支：
    //      `if (!existsSync(sessionRoot)) return true`  （root 整个不在 ⇒ 当作"在"）
    //    ⇒ 那条本该判死的 `sess-gone` 会被判活 ⇒ 本用例变成"冷载入成功并投递"，测的就不是闸门。
    //    （这是它在生产里的真形态：宿主有别的会话、而这一条真没了。）
    //    ⚠️ 实测代价：第一版夹具少这一行，用例红在 `sent` 而不是红在闸门 —— 读数与本意无关。
    writeSessionLog('sess-other')
    // 有过载体：声明指向 `sess-gone`，但**不造它的会话日志**（= 那个会话真的不在了 ⇒ occupied）
    writeBinding('sess-gone', DIR_NAME, Date.now(), { cold: false })
    const bindPath = join(root, 'AGENT_SESSIONS', DIR_NAME, 'current.dsh_session_bind')
    const bindBefore = readFileSync(bindPath, 'utf-8')
    writeCro(DIR_NAME, croProgram('{"wake":true,"prompt":"叫我"}'))
    writeCroHostBinding()
    const sent: string[] = []
    const createCalls: string[] = []
    registerWakeScheduler(croCtxCanCreate(sent, createCalls) as never)

    await waitFor(
      () => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('CRO 评估')),
      30_000,
    )

    // ① 🔴 闸门承重判据：**一次都没建**
    expect(createCalls, 'occupied ⇒ 禁止自建（否则每 5min 长一个载体）').toHaveLength(0)
    // ② 绑定声明**逐字未变**（不是"看起来还在"，是字节相等）
    expect(readFileSync(bindPath, 'utf-8')).toBe(bindBefore)
    // ③ 没有投递发生
    expect(sent).toHaveLength(0)
    // ④ 🔴 **不许不出声**（D186）：流水里必须有一条失败，且**指名是哪一半**
    //    ——「有过载体」与「从未有过」是两种完全不同的处置方向，不能共用一句文案。
    const entries = loadCroWakeLog(root, DIR_NAME).log.entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(String(entries[0]!.detail)).toContain('sess-gone') // 指名那个不在了的会话
    expect(String(entries[0]!.detail)).toContain('拒绝自动新建载体')
  }, 40_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// 🆕 2026-09-25 ⑤ 第 29 件：`wake/registry.ts` 的**读面容错 / 写面失败 / 结案清理**三面
//
// 挑靶依据 = **先逐行读覆盖率报告的 `cstat-no`/`cbranch-no` 判可达性**（别按 branch% 排序硬上）。
// 🔴 本件最值钱的一处：`purgeFinalizedWakes` 的**真写盘路径从未被执行过** —— 它正是
//    「owner 2026-09-19 裁『直接删』」把那张只增的表（实测 308 KB / 143+ 条）刹住的那条路。
// 🔴 失败路径一律用**真实故障形态**注入（㊾）：盘上损坏的 JSON ／ 路径被占成目录 —— **不用 mock**。
// ─────────────────────────────────────────────────────────────────────────────

/** 往盘上直接写一份注册表正文（构造"手改过的表""路径被占"等形态；`body` 原样落盘） */
function writeRegistryRaw(body: string): string {
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  writeFileSync(wakeRegistryPath(root), body, 'utf-8')
  return wakeRegistryPath(root)
}

/** 一条形状合法的条目（直接拼 JSON —— 本块测的是**读入侧**，要能表达"手改"的各种坏形状） */
function rawEntry(id: string, state = 'pending', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    target: DIR_NAME,
    at: new Date(Date.now() + HOUR).toISOString(),
    message: `m-${id}`,
    state,
    createdBy: 'S142',
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastResult: null,
    deliveredAt: null,
    ...extra,
  }
}

describe('wake-registry: 读面容错 / 写面失败 / 结案清理（⑤ 第 29 件）', () => {
  it('① 盘上的 JSON 损坏 ⇒ `loadWakeRegistry` 回空表 ＋ error，**不抛**', () => {
    writeRegistryRaw('{ this is not json')
    const r = loadWakeRegistry(root)
    expect(r.error).toContain('唤醒注册表解析失败')
    expect(r.registry.entries).toEqual([])
  })

  it('② 坏表之下：五个动作各自回**稳定错误**（不抛、不半改、一个字节都不许改）', () => {
    const path = writeRegistryRaw('{ nope')
    const before = readFileSync(path, 'utf-8')
    expect(addWake(root, { target: DIR_NAME, at: '+1h', message: 'x', createdBy: 'S142', nowMs: Date.now() }).ok).toBe(false)
    expect(updateWake(root, 'w-any', { state: 'delivered' }).ok).toBe(false)
    expect(removeWake(root, 'w-any').ok).toBe(false)
    expect(finalizeWake(root, 'w-any', 'delivered', 'x').ok).toBe(false)
    const purged = purgeFinalizedWakes(root)
    expect(purged.ok).toBe(false)
    expect(purged.purged).toBe(0)
    expect(readFileSync(path, 'utf-8'), '读不出来 ⇒ 一个字节都不许改').toBe(before)
  })

  it('③ 手改容错：`entries` 非数组 ⇒ 空表；坏条目被丢而合法条留存；未知 state 回落 pending', () => {
    writeRegistryRaw(JSON.stringify({ version: 1, entries: 'nope' }))
    expect(loadWakeRegistry(root).registry.entries).toEqual([])

    writeRegistryRaw(
      JSON.stringify({
        version: 1,
        entries: [
          null,
          42,
          'str', // 非对象 ⇒ 丢
          { target: DIR_NAME }, // 缺 id ⇒ 丢
          { id: 'w-no-target' }, // 缺 target ⇒ 丢
          { id: 'w-no-at', target: DIR_NAME }, // 缺 at ⇒ 丢
          rawEntry('w-ok'),
          rawEntry('w-bad-state', 'nonsense'),
        ],
      }),
    )
    const { registry, error } = loadWakeRegistry(root)
    expect(error).toBeNull()
    expect(registry.entries.map((e) => e.id)).toEqual(['w-ok', 'w-bad-state'])
    expect(registry.entries[1]!.state, '未知 state 不丢条目，回落 pending').toBe('pending')
  })

  it('④ 字段默认值：`createdBy`/`createdAt` 非串 ⇒ `\'\'`；`attempts` 非数或非有限 ⇒ `0`', () => {
    writeRegistryRaw(
      JSON.stringify({
        version: 1,
        entries: [rawEntry('w-def', 'pending', { createdBy: 7, createdAt: null, attempts: '3' })],
      }),
    )
    const a = loadWakeRegistry(root).registry.entries[0]!
    expect(a.createdBy).toBe('')
    expect(a.createdAt).toBe('')
    expect(a.attempts).toBe(0)
    expect(a.lastResult).toBeNull()
    expect(a.deliveredAt).toBeNull()

    // 🔴 `Number.isFinite` 那一侧：JSON **源码里**写 `1e999` ⇒ 解析成 Infinity（`JSON.stringify` 做不到这点，它会写成 null）
    writeRegistryRaw(
      JSON.stringify({ version: 1, entries: [rawEntry('w-inf', 'pending', { attempts: '__INF__' })] }).replace('"__INF__"', '1e999'),
    )
    expect(loadWakeRegistry(root).registry.entries[0]!.attempts, 'Infinity 不算一次尝试').toBe(0)
  })

  it('⑤ 注册表路径被**占成目录** ⇒ load 报错而非抛（真实"路径被占"形态）', () => {
    mkdirSync(wakeRegistryPath(root), { recursive: true })
    const r = loadWakeRegistry(root)
    expect(r.error).toContain('唤醒注册表解析失败')
    expect(r.registry.entries).toEqual([])
  })

  it('⑥ 写盘失败（tmp 路径被占成目录）⇒ addWake 回 ok:false，且**不留下半个表**', () => {
    mkdirSync(`${wakeRegistryPath(root)}.tmp`, { recursive: true })
    const res = addWake(root, { target: DIR_NAME, at: '+1h', message: 'x', createdBy: 'S142', nowMs: Date.now() })
    expect(res.ok).toBe(false)
    expect(existsSync(wakeRegistryPath(root)), '写失败不得留下一个"看起来已登记"的表').toBe(false)
  })

  it('⑦ 写盘失败 ⇒ updateWake 回 ok:false，且盘上那条**逐字未变**', () => {
    const body = JSON.stringify({ version: 1, entries: [rawEntry('w-1')] })
    const path = writeRegistryRaw(body)
    mkdirSync(`${path}.tmp`, { recursive: true })
    expect(updateWake(root, 'w-1', { state: 'delivered', attempts: 1 }).ok).toBe(false)
    expect(readFileSync(path, 'utf-8'), '失败不得"看起来已改"').toBe(body)
  })

  it('⑧ 写盘失败 ⇒ removeWake 回 ok:false，且那条**仍在盘上**', () => {
    const body = JSON.stringify({ version: 1, entries: [rawEntry('w-1')] })
    const path = writeRegistryRaw(body)
    mkdirSync(`${path}.tmp`, { recursive: true })
    const res = removeWake(root, 'w-1')
    expect(res.ok).toBe(false)
    expect(res.removed).toBeNull()
    expect(readFileSync(path, 'utf-8')).toBe(body)
  })

  it('⑨ 写盘失败 ⇒ finalizeWake 回 ok:false，且那条**仍在盘上**（结案不能"半结"）', () => {
    const body = JSON.stringify({ version: 1, entries: [rawEntry('w-1')] })
    const path = writeRegistryRaw(body)
    mkdirSync(`${path}.tmp`, { recursive: true })
    const res = finalizeWake(root, 'w-1', 'delivered', '已投递')
    expect(res.ok).toBe(false)
    expect(res.removed).toBeNull()
    expect(readFileSync(path, 'utf-8')).toBe(body)
  })

  it('⑩ 写盘失败 ⇒ purge 回 ok:false 且 `purged:0`（**不许只报"清掉了"而没落盘**）', () => {
    const body = JSON.stringify({ version: 1, entries: [rawEntry('w-p'), rawEntry('w-d', 'delivered')] })
    const path = writeRegistryRaw(body)
    mkdirSync(`${path}.tmp`, { recursive: true })
    expect(purgeFinalizedWakes(root)).toEqual({ ok: false, error: expect.stringContaining('唤醒注册表写入失败'), purged: 0 })
    expect(readFileSync(path, 'utf-8')).toBe(body)
  })

  it('⑪ finalizeWake 命中 ⇒ 返回带终态与结果的 removed，**表里不留行**（owner「直接删」）', () => {
    const added = addWake(root, { target: DIR_NAME, at: '+1h', message: '结案我', createdBy: 'S142', nowMs: Date.now() })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.entry.id : ''
    const res = finalizeWake(root, id, 'delivered', '已投递')
    expect(res.ok).toBe(true)
    expect(res.removed?.id).toBe(id)
    expect(res.removed?.state).toBe('delivered') // 终态只在返回值上留痕
    expect(res.removed?.lastResult).toBe('已投递')
    expect(loadWakeRegistry(root).registry.entries, '终态条目不得留在表里').toHaveLength(0)
  })

  it('⑫ purge 真清理 ⇒ 盘上只剩 pending（**这条写盘路径此前从未被执行过**）', () => {
    writeRegistryRaw(
      JSON.stringify({
        version: 1,
        entries: [rawEntry('w-p1'), rawEntry('w-p2'), rawEntry('w-d', 'delivered'), rawEntry('w-m', 'missed'), rawEntry('w-c', 'cancelled')],
      }),
    )
    const res = purgeFinalizedWakes(root)
    expect(res.ok).toBe(true)
    expect(res.purged).toBe(3)
    expect(loadWakeRegistry(root).registry.entries.map((e) => e.id), '终态三个清掉、在办两个留下').toEqual(['w-p1', 'w-p2'])
    expect(readFileSync(wakeRegistryPath(root), 'utf-8'), '真写盘（不是只在内存里过滤）').toContain('w-p2')
  })

  it('⑬ 无终态条目 ⇒ `purged:0` 且**不写盘**（避免无谓 IO 的承诺）', () => {
    const body = JSON.stringify({ version: 1, entries: [rawEntry('w-p1')] })
    const path = writeRegistryRaw(body)
    expect(purgeFinalizedWakes(root)).toEqual({ ok: true, error: null, purged: 0 })
    expect(readFileSync(path, 'utf-8'), '无可清 ⇒ 逐字不动').toBe(body)

    // 连"表都不存在"时也不该凭空建一个
    rmSync(path)
    expect(purgeFinalizedWakes(root).purged).toBe(0)
    expect(existsSync(path), '空转不得建空表').toBe(false)
  })

  it('⑭ 未知 id ⇒ 稳定错误码（finalizeWake / updateWake 都不新建、不静默成功）', () => {
    const f = finalizeWake(root, 'w-nope', 'missed', 'x')
    expect(f.ok).toBe(false)
    expect(f.error).toBe('wake_not_found: w-nope')
    expect(f.removed).toBeNull()

    const u = updateWake(root, 'w-nope', { state: 'delivered' })
    expect(u.ok).toBe(false)
    expect(u.error).toBe('wake_not_found: w-nope')
    expect(loadWakeRegistry(root).registry.entries, '报错不得顺带建条目').toHaveLength(0)
  })

  it('⑮ `at` 无法解析 ⇒ addWake 原样透出解析错误（`!parsed.ok` 分支）', () => {
    const res = addWake(root, { target: DIR_NAME, at: 'tomorrow-ish', message: 'x', createdBy: 'S142', nowMs: Date.now() })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('时刻无法解析')
  })
})

/**
 * 🔴🔴 **A104-C′（2026-10-23，owner 点头）：容器级「被重启打断的会话」兜底。**
 *
 * ## 为什么这是一条**必须存在**的机制（不是"多一层保险"）
 * 实测盲窗：`08:02` 一次重启打断了一个会话，此后 **13 分钟无人拉起**；
 * 真回放证明 `08:07:30`／`08:12:40` 两个 tick **都本应命中**，而**实际都没叫**
 * ⇒ **「守护程序自己修好」≠「一定有人拉起」**。
 *
 * ## 本组钉的是三件（缺一件这个兜底就不成立）
 *  ① **它会扫到**（不被"本轨迹在跑/无线程绑定/阈值保护"之类的轨迹级条件挡住）
 *  ② **它会注入**（只扫不动没有用 —— 这是 owner 点名要我区分的那一格）
 *  ③ **它不会碰 live 会话**（否则同一会话被重复注入）
 */
describe('🔴 A104-C′ 容器级中断兜底（每 tick 自带「发现 ＋ 注入」）', () => {
  const INTERRUPTED_ID = 'session-dead-beef-0001'

  /** 造一份**真 zstd、真内容**的会话日志：末轮 `turn/end[interrupted]` 且其后无 `turn/start` */
  function writeInterruptedLog(sessionId: string, opts: { withNewTurn?: boolean } = {}): void {
    // 🔴 **扫描域必须与实现算出来的目录名逐字一致**：兜底用的是
    //    `sessionsRootDir() + '/' + projectDirNameForCwd(root)`，而 `root` 是**本用例的临时目录**
    //    ⇒ 目录名是 `--tmp-dsp-wake-XXXX--`，**不是**本文件顶部的 `PROJECT_SLUG`（那是另一个夹具用的）。
    //    ⚠️ 写错这一格的症状是**看起来像缺陷**：「注入 0 条」而真因是**夹具放在了实现不会去读的地方**
    //    （同族 D205/实测：先让被测格子成立，再判实现）。
    const slug = projectDirNameForCwd(root)
    const dir = join(dshHome, 'sessions', slug, sessionId)
    mkdirSync(dir, { recursive: true })
    const base = Date.now() - 60_000
    const events: unknown[] = [
      { type: 'turn/start', time: base, data: { turn: 7 } },
      { type: 'step/start', time: base + 10, data: { turn: 7, step: 1 } },
      { type: 'turn/end', time: base + 20, data: { turn: 7, reason: { kind: 'interrupted' } } },
      { type: 'session/end-seed', time: base + 30, data: {} },
    ]
    if (opts.withNewTurn) {
      // 🔴 2026-10-24：新一轮必须**真跑完**（有 turn/end）才算"已接续"。
      //    只加 `turn/start` 而不管它有没有收尾 ⇒ 那个形态恰恰是**新的中断**（turn 开了没收）。
      //    见该用处的改钉注释（D184）。
      events.push({ type: 'turn/start', time: base + 40, data: { turn: 8 } })
      events.push({ type: 'turn/end', time: base + 50, data: { turn: 8, reason: { kind: 'completed' } } })
    }
    const body = Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
    // ⚠️ 必须真 zstd 帧：`readTailEvents` 靠帧魔数定位，纯文本会被判"读不到事件"
    //    （写错这一格的症状是**用例假绿**——扫描返回空 ⇒ 看起来"没东西要恢复"）
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(body))
  }

  /** 一个能让兜底真正跑到"注入"的 ctx（注意 `agents.get` 对目标返回 undefined ⇒ 走冷载入） */
  function safetyCtx(sent: string[], runningIds: string[] = []): unknown {
    const agent = {
      session: { id: INTERRUPTED_ID, append: () => {} },
      followup: (m: { content: Array<{ text?: string }> }) => { sent.push(m.content[0]?.text ?? '') },
    }
    // 🔴 **A105 改判（2026-10-23）：排除判据从「live」改为「在跑」，夹具必须跟着换语义。**
    //
    //    修前本参数叫 `liveIds`，靠**把目标塞进 `sessions.list()`** 来模拟"它在跑"。
    //    但 A105 的结论是 `live ≠ 在跑`：`sessions.list()` 答的是「宿主认不认识这个会话」
    //    （载入状态），而排除要的是「此刻有没有轮次在跑」（轮次状态，`cro/turns.ts` 的表）。
    //    ⚠️ **继续用 `sessions.list()` 模拟"在跑"会让这条反向钉假绿**：
    //    实现已不看那张表 ⇒ 无论塞不塞，目标都会被注入 ⇒ `sent` 非空 ⇒ 用例红得莫名其妙；
    //    反过来若实现被改回看 live 表，本条又会"恰好"通过 ⇒ **两个方向都测不出真东西**。
    //    ⇒ 现在改用真机制：`markTurnRunning(id)` 置位（并配 `__resetCroTurnsForTest()` 清态）。
    for (const id of runningIds) markTurnRunning(id, Date.now(), 1)
    const sessions = {
      list: () => [{ id: 'sess-for-discovery', header: { cwd: root } }],
    }
    return {
      sessions,
      agents: { get: () => undefined }, // 冷会话：进程里没有
      get: (name: string) => {
        if (name === 'sessions') return sessions
        if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
        return undefined
      },
      on: () => undefined,
      effect: () => undefined,
    }
  }

  it('🔴 会扫到并注入：被打断的会话即使没有任何轨迹叫它，容器也会拉起', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    // ⚠️ 刻意**不写 CRO 程序**：本用例要证的是"不依赖任何轨迹级唤起来源"
    writeCroHostBinding()
    writeInterruptedLog(INTERRUPTED_ID)
    const sent: string[] = []
    __resetWakeSchedulerStateForTest() // 同族：不重置 ⇒ 不武装 ⇒ 本用例不跑 tick
    __resetCroTurnsForTest() // 🔴 A105：轮次表是进程级的 ⇒ 不清会让上一条用例的"在跑"漏进来
    registerWakeScheduler(safetyCtx(sent) as never)
    await waitFor(() => sent.length > 0, 20_000)
    expect(sent, '被打断的会话必须被注入一次续跑').toHaveLength(1)
    expect(sent[0]).toContain('中断续跑')
    expect(sent[0]).toContain(INTERRUPTED_ID)
    // tick 日志里也要能看见（否则"它到底动没动"又只能靠猜）
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('中断兜底')), 20_000)
  }, 30_000)

  it('🔴 反向钉：**此刻在跑轮次**的会话不碰（否则同一会话会被重复注入）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCroHostBinding()
    writeInterruptedLog(INTERRUPTED_ID)
    const sent: string[] = []
    // 🔴🔴 **必须先重置进程态**：`registerWakeScheduler` **只在首次装配时武装**
    //    （调度器幂等；本文件另一处注释已写明这条，我第一版就踩了它）。
    //    ⚠️ 不重置的后果是**假绿**：本用例根本没跑 tick ⇒ `sent` 恒空 ⇒
    //    "live 不碰"看起来通过了，其实**什么都没验证**。
    //    实测证据：我第一次跑变异检验（把 `liveIds` 换成空集）时本条**仍然绿** —— 那正是这个陷阱。
    __resetWakeSchedulerStateForTest()
    // 🔴 A105：清轮次表，再用**真机制**标记目标"此刻在跑"（不是塞进 sessions.list）
    __resetCroTurnsForTest()
    // 把目标会话标记为"在跑" ⇒ 兜底必须跳过它
    registerWakeScheduler(safetyCtx(sent, [INTERRUPTED_ID]) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).length > 0, 20_000)
    expect(sent, '该会话正在跑轮次，兜底不得再注入一次').toHaveLength(0)
  }, 30_000)

  /**
   * 🔴🔴 **2026-10-24 改钉（D184：必须说出原前提被谁取代）**
   *
   * **原名**：`反向钉：末轮之后已有新 turn/start ⇒ 不算"停在这里"，不注入`
   * **原前提**：判据 = "最后一条 `turn/end` 的 kind" ⇒ 只要它之后又出现 `turn/start`，
   * 就说明"那一轮已被接续"，于是不该再拉起。
   *
   * 🔴 **原前提被谁取代**（owner 2026-10-24：「我要求你抓到非工具调用的中断」＋
   * 「扫到的五个大概率也就是需要唤醒的，问题是判断逻辑有问题」）：
   * 判据改问 **「最后一轮有没有收完」**。于是
   * `turn/end[interrupted] → end-seed → turn/start(8)`（**turn 8 之后什么都没有**）
   * 这个形态**恰恰就是新的中断** —— turn 8 开了、一个字都没写就死了。
   * ⇒ 旧断言把「新一轮刚开就死」误当成「已接续」，**正是"啥都扫不到"的成因之一**。
   * ⇒ 新钉：**只有那一轮真的跑完了（有 `turn/end`）才算已接续。**
   *
   * ⚠️ **"会不会重复拉起正在跑的会话"由另一条判据兜住**：
   * 见上一条「此刻在跑轮次的会话不碰」（`liveIds` 排除）。
   * 两条分工：本条目判**日志形态**，上一条判**进程状态**。
   */
  it('🔴 反向钉：新一轮**真跑完了**（有 turn/end）⇒ 不算"停在这里"，不注入', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCroHostBinding()
    writeInterruptedLog(INTERRUPTED_ID, { withNewTurn: true }) // 新一轮已完整收尾
    const sent: string[] = []
    // 🔴 同上：不重置 ⇒ 本用例**根本没跑 tick** ⇒ 假绿
    __resetWakeSchedulerStateForTest()
    __resetCroTurnsForTest() // 🔴 A105：同上，防跨用例污染
    registerWakeScheduler(safetyCtx(sent) as never)
    await waitFor(() => (wakeSchedulerState().lastTickLog ?? []).length > 0, 20_000)
    expect(sent, '新一轮已完整收尾 ⇒ 不是"被打断停住"，不许重复拉起').toHaveLength(0)
  }, 30_000)

  /**
   * 🔴🔴 **A106：无命中时也必须留一行**（本族第五格）。
   *
   * 修前 `if (scan.sessions.length === 0) return` ⇒ 宿主日志里**一个字都没有** ⇒
   * **「我扫了、没东西」与「我没被跑」在读数上完全一样**（D216 同族第四次）。
   *
   * ⚠️ 本条的判别力**全在"能区分这两种状态"上**：
   *  - 正向：无靶时**有**一行含「命中 0」的日志；
   *  - 反向钉（下一条）：这行必须**带拍号**，否则一堆无拍号的行仍然不可归因。
   */
  it('🔴 A106：兜底无命中也要出声（带扫描读数 ＋ 拍号）', async () => {
    writeFileSync(join(root, '.serenity'), '')
    writeSessionDir()
    writeBinding('sess-live')
    writeCroHostBinding()
    // ⚠️ 刻意**不写**任何 interrupted 日志 ⇒ 扫描域为空 ⇒ 走"无命中"分支
    const sent: string[] = []
    __resetWakeSchedulerStateForTest()
    __resetCroTurnsForTest()
    registerWakeScheduler(safetyCtx(sent) as never)
    await waitFor(
      () => (wakeSchedulerState().lastTickLog ?? []).some((l) => l.includes('中断兜底')),
      20_000,
    )
    const lines = (wakeSchedulerState().lastTickLog ?? []).filter((l) => l.includes('中断兜底'))
    expect(lines.length, '无命中时一行都没有 ⇒ 与"没被跑"不可分').toBeGreaterThan(0)
    const summary = lines.find((l) => l.includes('命中 0'))
    expect(summary, `无命中没写「命中 0」：${lines.join(' / ')}`).toBeDefined()
    // 拍号：必须写清是哪一拍，且标注属于哪种拍（guard 明确要求）
    expect(summary, '这行没带拍号 ⇒ 一堆无拍号的行仍然不可归因').toContain('tick=')
    expect(summary, '这行没说明是哪一种拍（启动首拍/刚启动窗口/常规 tick）').toMatch(
      /启动首拍|刚启动窗口|常规 tick/,
    )
    expect(sent, '无靶时不该注入任何东西').toHaveLength(0)
  }, 30_000)
})
