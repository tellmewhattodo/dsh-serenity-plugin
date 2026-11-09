/**
 * 判据**归属**校验 —— ACC 负责判据，守护程序只负责触发
 *
 * ## 改钉记录（出处可查，D184）
 *
 * **原名**：`判据交叉校验：ACC 的 detectInterruptedEnd ≡ 守护 CRO 的判定`
 *
 * **原前提**：ACC 与守护 CRO 各有一份 interrupted 判据的独立实现，
 * 本文件用同一批事件喂两边、断言**判定结果一致**，防它们漂移。
 *
 * 🔴 **原前提被谁取代**（2026-10-23）：
 * owner 令「保守点，只判断 dsh 启动时长这种简单的因素」⇒ 守护程序改成**纯触发器**
 * （400 行 → 166 行，zstd 扫描整段删除，**不再读会话日志**）。
 * ⇒ 守护程序**根本不回答**「有没有待恢复的会话」这个问题，它答的是「宿主启动后第几拍」。
 * ⇒ 旧断言必然红，**且红得与被测判据无关**（它在比较两个不同问题的答案）。
 *
 * ## 现在钉什么：**「两个实现不许重复实现」**（比"必须一样"更硬）
 *
 * 原版只能证明"两份实现此刻相等"（下次改动就可能漂）；新版证明的是"**压根只有一份**"——
 * 那才是不会漂的形态。
 *
 * 规格由 guard 给定（它同意"我改、归属记它名下"），五条：
 * 1. **判据不变性（核心）**：同一快照 ＋ 两份**语义相反**的会话日志 ⇒ CRO 输出**逐字相同**
 * 2. **触发敏感性**：同一日志只改 ticks ⇒ 0 不醒／1 醒／3 不醒
 * 3. **缺字段不崩**：无 `scheduling` ⇒ `wake:false` 且产出可解析 JSON
 * 4. **前置条件显式红**（⛔ 不许静默跳过 —— 初版就栽在这里：4 个用例全绿、一个都没真跑）
 * 5. **路径可覆盖**：`GUARD_CRO_PATH` 环境变量兜底（避免硬编码一条会归档的轨迹路径）
 *
 * ## ⛔ 两条实现者禁令（guard 明确要求）
 *
 * - ⛔ **不许在本文件再抄一份判据**（那会变成第三真相源）
 * - ⛔ **不许用「断言源码不含某关键字」代替行为断言**（文本匹配 ≠ 行为）
 *   🔵 我第一版差点这么做 —— 而且实测证明它没用：我在程序里注入"读会话内容就短路唤醒"
 *      的变异后，行为断言**仍然绿**，因为我喂的字段名是我自己猜的、程序读的是别的。
 *      ⇒ 判据：**只有"同一快照 ＋ 相反日志 ⇒ 输出相同"才能抓到"它又自己判了"**（本文件 §1）。
 *
 * ## D210 那根钉已迁走（**迁，不是删**）
 *
 * `interruptedThenInboxSpliced`（D210 命中格）与它的反向钉已迁入
 * `tests/trajectory/interrupted.test.ts` —— 判据归 ACC，就由 ACC 自己的用例钉。
 * 原先它们只活在本文件 ⇒ 本文件一因职责重组而改动，**唯一的钉就丢了**。
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import * as nodeZlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 路径层级（🔴 数过一次，别再靠感觉）：
 *   tests/trajectory/ ← 本文件
 *   tests/            ← ..1
 *   hooks/dsh-serenity-hooks/ ← ..2
 *   hooks/            ← ..3
 *   dsh-serenity-plugin/ ← ..4
 *   AI_LAB/           ← ..5
 *   CCC 根            ← ..6
 *
 * ⚠️ **实测踩到**：初版只写了 4 级 ⇒ 推导到 `dsh-serenity-plugin` ⇒ CRO 文件不存在
 * ⇒ 测试静默走"跳过"分支 ⇒ **4 个用例全绿但一个都没真跑**（假绿的教科书形态）。
 */
const CCC_ROOT = join(HERE, '..', '..', '..', '..', '..', '..')

/**
 * 守护程序路径 —— **可被环境变量覆盖**（规格 §5）。
 *
 * 为什么要有这一口：本文件**硬编码依赖一条 CCC 轨迹的路径**（`AGENT_SESSIONS/<guard>/…`）。
 * 那条轨迹一旦归档/搬家，本文件就红 —— 一个**未来的定时炸弹**。
 * ⇒ 留一个覆盖口不改变任何语义，只是"换了个地方也能跑"。
 */
const GUARD_CRO =
  process.env.GUARD_CRO_PATH ??
  join(CCC_ROOT, 'AGENT_SESSIONS', '2026-10-22--guard--中断守护', 'continuous-re-occurrence.ts')

/**
 * 🔴 **bun 的可执行路径必须是「解析出来的绝对路径」，不能是裸名 `'bun'`**（2026-11-09 实测）。
 *
 * **症状**：`dsh-develop test` 跑本文件时，6 条用例全红，报
 * `CRO 没有产出可解析的决策（bun 不可用？程序报错？）: expected '' not to be ''`——
 * 而**同一份程序**用 `run-trajectory-test`（它自己解析 `/home/<user>/.bun/bin/bun`）跑**22/23 绿**。
 *
 * **成因**：`spawnSync('bun', …)` 依赖 `PATH`，而 **vitest 子进程的 PATH 里没有 `~/.bun/bin`**
 * （实测：`PATH` 只含 `node_modules/.bin` 一族加系统目录 ⇒ `spawnSync bun ENOENT`）。
 * ⇒ 那不是"被测程序坏了"，是**读数器找不到解释器**（D252 同族：读数器坏了 ≠ 被测对象坏了）。
 *
 * **口径与 `scripts/dsh-develop.ts` 的 `run-trajectory-test` 一致**：`SERENITY_BUN` 可覆盖，
 * 缺省 `~/.bun/bin/bun`。⛔ 不要退回裸名——那会把"本机 PATH 长什么样"偷偷变成判据的一部分。
 */
const BUN = process.env.SERENITY_BUN ?? join(homedir(), '.bun', 'bin', 'bun')

const zstd = (nodeZlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync

/**
 * 把事件序列写成**真 zstd 多帧**会话日志，返回可用于喂 CRO 的环境。
 *
 * 🔴 **mtime 必须回拨**（2026-10-23 实测；否则用例会**假红/假绿**都出现过）：
 * 旧版程序有一条 live 保护（日志 mtime 在 90s 内 ⇒ 视为"可能在跑"⇒ 本轮跳过）。
 * 新版触发器**不读日志**，但夹具仍按"一条几分钟前停在那里的会话"这个**真形态**造 ——
 * 这样万一日后有人把判据放回程序里，本夹具也不会因为"刚写出来的文件"而给出假读数。
 */
function stageLog(events: Array<Record<string, unknown>>): { dshHome: string; cccRoot: string; cleanup: () => void } {
  if (zstd === undefined) throw new Error('本机 Node 无 zstdCompressSync')
  const root = mkdtempSync(join(tmpdir(), 'cro-attribution-'))
  const ccc = join(root, 'ccc')
  const slug = `--${ccc.split('/').filter(Boolean).join('-')}--`
  const dir = join(root, '.dsh', 'sessions', slug, 'session-target')
  mkdirSync(dir, { recursive: true })
  const frames = events.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(logPath, Buffer.concat(frames))
  const t = new Date(Date.now() - 10 * 60 * 1000) // 10 分钟前：远超任何"刚写过"阈值
  utimesSync(logPath, t, t)
  return { dshHome: join(root, '.dsh'), cccRoot: ccc, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 一次 CRO 调用的**原始输出**（保持原文，供"逐字相同"断言） */
function croRaw(staged: { dshHome: string; cccRoot: string }, snapshot: Record<string, unknown>): string {
  const res = spawnSync(BUN, [GUARD_CRO], {
    input: JSON.stringify({
      identity: { dirName: 'guard', code: 'guard', cccRoot: staged.cccRoot },
      time: { nowMs: Date.now() },
      binding: { liveSessionIds: [], runningSessionIds: [] },
      ...snapshot,
    }),
    encoding: 'utf-8',
    env: { ...process.env, DSH_HOME: staged.dshHome },
    timeout: 30_000,
  })
  return (res.stdout ?? '').trim()
}

/** 解析后的 wake 值；输出不可解析 ⇒ `null`（由调用方显式判红，不许静默放过） */
function parseWake(raw: string): boolean | null {
  if (raw === '') return null
  try {
    return (JSON.parse(raw) as { wake?: boolean }).wake === true
  } catch {
    return null
  }
}

/** 造一份 staged 日志并跑一次 CRO，返回原始输出（用完即清） */
function runWithLog(events: Array<Record<string, unknown>>, snapshot: Record<string, unknown>): string {
  const staged = stageLog(events)
  try {
    return croRaw(staged, snapshot)
  } finally {
    staged.cleanup()
  }
}

// ── 两份**语义相反**的会话日志（本文件不解释它们"为什么"命中，那是 ACC 自己的用例的事）──
const LOG_INTERRUPTED_TAIL = [
  { type: 'turn/start', time: 1000, data: { turn: 5 } },
  { type: 'step/start', time: 1001, data: { turn: 5, step: 1 } },
  { type: 'turn/end', time: 1002, data: { turn: 5, reason: { kind: 'interrupted' } } },
  { type: 'session/end-seed', time: 1003, data: {} },
]

const LOG_COMPLETED_TAIL = [
  { type: 'turn/start', time: 1000, data: { turn: 5 } },
  { type: 'turn/end', time: 1002, data: { turn: 5, reason: { kind: 'completed' } } },
  { type: 'session/end-seed', time: 1003, data: {} },
]

describe('判据归属：ACC 判「有没有待恢复的会话」／守护程序判「要不要醒」', () => {
  /** 🔴 规格 §4：前置条件**单独一条**，⛔ 不许静默跳过（初版就在这里假绿过） */
  it('前置条件：守卫程序必须能被找到（找不到 ⇒ 本条显式失败，不许静默跳过）', () => {
    expect(
      existsSync(GUARD_CRO),
      `守卫程序缺失：${GUARD_CRO}\n` +
        '（若该轨迹已被归档/删除 ⇒ 请更新 GUARD_CRO_PATH 或删除本文件；⛔ 不要改成静默跳过）',
    ).toBe(true)
  })

  /**
   * 🔴🔴 **规格 §1 —— 本文件的核心那一条。**
   *
   * 同一份快照，分别喂**语义相反**的两份日志（甲：末轮 interrupted ／ 乙：正常完成）：
   * ⇒ **CRO 的输出必须逐字相同**（wake 与 reason 都同）。谁再把判据复算进程序里，这条立刻红。
   *
   * ## 🔴 快照为什么取 **窗口外（ticks=3 ⇒ 第 4 拍）**——这一格是变异检验逼出来的
   *
   * 我第一版取的是 `ticks=1`（窗口内 ⇒ 本来就该 wake:true）。**那次变异检验假绿了**：
   * 我在程序里注入"真去读日志、判出 interrupted 就唤醒"的变异 ⇒ **测试仍然全绿** ——
   * 因为两份日志的 tick 都是 1，输出本来**都是 true**，注入的变异根本**改变不了**结果。
   * ⇒ **判据（D222 同族）：不变性断言必须放在"两份输入本会产生不同结果"的那一格上。**
   *   窗口内两边都唤醒 ⇒ 观察不到差异；**窗口外两边都该沉默** ⇒ 谁偷读日志、谁就当场暴露。
   *
   * ⚠️ 这也解释了为什么"wake 相同"不够：本格真正的观察量是**沉默的一致性**。
   */
  it('🔴 判据不变性：同一快照 ＋ 语义相反的两份日志 ⇒ CRO 输出**逐字相同**（窗口外）', () => {
    // ticks=3 ⇒ 当前第 4 拍 ⇒ **已过唤醒窗口** ⇒ 两份日志都该沉默
    const snapshot = { scheduling: { scheduler: { ticks: 3 } } }
    const rawA = runWithLog(LOG_INTERRUPTED_TAIL, snapshot)
    const rawB = runWithLog(LOG_COMPLETED_TAIL, snapshot)

    expect(rawA, 'CRO 没有产出可解析的决策（bun 不可用？程序报错？）').not.toBe('')
    expect(rawB).not.toBe('')
    expect(
      parseWake(rawA),
      '窗口外却唤醒了 ⇒ 它按日志内容（interrupted）自己判了 —— 判据被重复实现',
    ).toBe(false)
    expect(
      rawA,
      '同一快照下，"命中"与"不命中"两种日志产出了不同输出 ⇒ 守护程序又在自己判 interrupted 了' +
        `（职责边界被破坏）。甲=${rawA} ／ 乙=${rawB}`,
    ).toBe(rawB)
  })

  /**
   * 🔴 **同一条不变性的另一侧：窗口内也必须是"纯触发"**。
   *
   * 与上一条互补：窗口内两份日志**都该唤醒**（因为唤不唤醒只由拍数决定）。
   * ⚠️ 单独一条的价值：如果哪天有人把窗口逻辑写错成"永不唤醒"，上一条会绿（都是 false），
   *    而本条会红 —— **两条一起才把"由拍数决定"这件事钉成双向**。
   */
  it('🔴 判据不变性（另一侧）：窗口内 ＋ 两份语义相反的日志 ⇒ **都唤醒**（唤不唤醒只由拍数决定）', () => {
    const snapshot = { scheduling: { scheduler: { ticks: 1 } } }
    expect(parseWake(runWithLog(LOG_INTERRUPTED_TAIL, snapshot)), '窗口内应当唤醒').toBe(true)
    expect(parseWake(runWithLog(LOG_COMPLETED_TAIL, snapshot)), '窗口内应当唤醒（与日志内容无关）').toBe(true)
  })

  /** 🔴 规格 §2：触发敏感性 —— 同一日志，只改 ticks */
  it('🔴 触发敏感性：ticks 0 ⇒ 不醒 ／ 1 ⇒ 醒 ／ 3 ⇒ 不醒', () => {
    const at = (ticks: number): boolean | null =>
      parseWake(runWithLog(LOG_COMPLETED_TAIL, { scheduling: { scheduler: { ticks } } }))

    const t0 = at(0) // 当前第 1 拍 = 启动即跑那拍，宿主未就绪
    const t1 = at(1) // 当前第 2 拍 = 主唤起窗口
    const t3 = at(3) // 当前第 4 拍 = 已过窗口
    expect(t0, 'CRO 没有产出可解析的决策').not.toBeNull()
    expect(t1, 'CRO 没有产出可解析的决策').not.toBeNull()
    expect(t3, 'CRO 没有产出可解析的决策').not.toBeNull()
    expect(t0, '第 1 拍（宿主未就绪）不该醒').toBe(false)
    expect(t1, '第 2 拍是主唤起窗口，必须醒').toBe(true)
    expect(t3, '第 4 拍已过窗口，不该醒').toBe(false)
  })

  /** 🔴 规格 §3：缺字段不崩 */
  it('🔴 缺字段不崩：快照无 `scheduling` ⇒ wake:false 且产出可解析 JSON', () => {
    const raw = runWithLog(LOG_COMPLETED_TAIL, {})
    expect(raw, '缺字段时没有产出任何东西（应当给一个可解析的 JSON 决策）').not.toBe('')
    const wake = parseWake(raw)
    expect(wake, `缺字段时输出不可解析：${raw}`).not.toBeNull()
    expect(wake, '缺 ticks 时不该醒（fail-closed）').toBe(false)
  })

  /**
   * 🔴🔴 **2026-10-24 改钉（D184：改判据必须能说出原前提被谁取代）**
   *
   * **原名**：`护栏：本轨迹正在跑 ⇒ 不自我唤醒（即便正在唤醒窗口内）`
   * **原前提**：「在跑」= 这条轨迹正在干活 ⇒ 别自唤醒（免得自我打断）。
   *
   * 🔴 **原前提被什么取代**（guard 2026-10-24 实测 + 源码坐标）：
   * 宿主**重启后会重发 `agent/created`** ⇒ `cro/turns.ts` 的 `markTurnRunning` 又被打上，
   * 而那一轮**早已随旧进程死掉** ⇒ `agent/turn-stopping` **永不到** ⇒ 标记活到 30min TTL。
   * ⇒ 那个「在跑」信号在重启后**只证明"载体存在过"，不证明"正在干活"**。
   * ⇒ 拿它否决 ⇒ **守卫在重启后恰好聋 30 分钟**（owner 看到的"又"就是这个）。
   *
   * 🔵 **2026-10-24 D243 补记**：上面那条**假信号的产生源**已在 `cro/turns.ts` 侧拔掉
   * （`agent/created` 不再置位，只认 `agent/status=running`）⇒ 守卫**不再**收到那种假信号。
   * ⚠️ **但这条用例照样保留、照样钉反向命题** —— 它现在挡的不再是"已修的缺陷"，
   * 而是**"有人为了'更严格'把 running 否决加回来"** 这个未来改动；那种改动在
   * *真*在跑但 *假* 报 running 的一切形态下仍会重演同样的 30 分钟聋。
   *
   * 🔴 **代价不对称**（guard 的判据，我方同意）：
   * 误否决 = 聋 30 分钟 ｜ 误唤醒 = 多醒一次（权威判据复读幂等 ⇒ 实测良性）。
   * ⇒ **观测量 ≠ 判据**：`running` 只能记进判定流水与提示词，**不得否决窗口内的唤起**。
   *
   * ⚠️ **这条用例必须留着**（哪怕它现在钉的是**反向**命题）——
   * 否则有人把护栏加回来 ⇒ 又一次聋 30 分钟，**而没有任何一条用例会红**。
   *
   * @see 现在的行为：窗口内在跑 ⇒ **仍然醒**（跑信号不否决）
   */
  it('🔴 在跑信号**不得**否决刚启动窗口内的唤起（重启后 running 只证明"载体存在过"）', () => {
    const raw = runWithLog(LOG_INTERRUPTED_TAIL, {
      scheduling: { scheduler: { ticks: 1 } },
      binding: { liveSessionIds: ['sess-x'], runningSessionIds: ['sess-x'] },
    })
    const wake = parseWake(raw)
    expect(wake, 'CRO 没有产出可解析的决策').not.toBeNull()
    expect(
      wake,
      '窗口内被在跑信号否决了 ⇒ 宿主重启后会重发 agent/created ⇒ 守卫将聋 30 分钟',
    ).toBe(true)
  })

  /**
   * ⛔ **与上一条成对的反向钉**：放宽"在跑不否决"**只能是窗口内**，
   * 不许把窗口外也一起放开 —— 那会让它每拍都醒（退化成噪声源）。
   */
  it('🔴 反向钉：窗口**外**＋在跑信号 ⇒ 仍然不醒（放宽不得越出窗口）', () => {
    const raw = runWithLog(LOG_INTERRUPTED_TAIL, {
      scheduling: { scheduler: { ticks: 3 } },
      binding: { liveSessionIds: ['sess-x'], runningSessionIds: ['sess-x'] },
    })
    const wake = parseWake(raw)
    expect(wake, 'CRO 没有产出可解析的决策').not.toBeNull()
    expect(wake, '过了窗口还在跑 ⇒ 不该醒').toBe(false)
  })
})
