/**
 * usage-stats-branches.test.ts — 🔴 **⑤ 第 69 件**：`src/surface/usage.ts` 的
 * **条目字段级容错 / 顶层键缺失 / 桶非对象 / firstAt 空串自愈**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（07:2x 那一跑，第 68 件之后）**成对读**（纪律 16）实测：
 * `surface/usage.ts` = 语句 **100%（285/285）**／分支 **85.93%（55/64）**／函数 11/11
 * —— **`src/**` 中分支覆盖率最低且尚未做过**的文件。
 * 🔵 **它的形态很典型（正是 ⑤ 换挡后要抓的对象）**：**每一行都跑过，但过半分支的另一侧从没走过**。
 * 🔵 **贴 objective**：本模块是**「清理/精简的依据」**（文件头逐字：让「这东西还有人用吗」
 * 不再靠翻会话记录猜）⇒ 它的读数**写坏了没人会立刻发现**，只会让清理决策建立在错数上。
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯ ＋ ㉔ 逐【分支】而非逐文件）
 * grep `usage-stats.js` ⇒ import 点 = `seams/cognitive-trajectory-lifecycle.ts` ／ `seams/system-prompt.ts`；
 * 测试只有 **`usage-stats.test.ts`（245 行 / 19 用例）**，逐块读过其覆盖面
 * （**本件不重做其中任何一条**）：落点与初态 ／ 自增语义（firstAt 不漂 / 重启续算 / 分桶）／
 * 两个 skill 口径不混 ／ **只记名字不记参数**（敏感值不入盘）／ 容错与原子写（损坏自愈 / 容忍手改 /
 * 不留 `.tmp` / 写盘失败不抛）／ 纯函数（键合法性 / 上线 / `bumpBucket` 不改入参 ／**键数上界**）。
 *
 * ## 🔵 缺口形态（判据 = coverage 报告 9 处 `cbranch-no`，逐条映射回源行）
 * | 源行 | 分支 | 可达性判定 |
 * |---|---|---|
 * | `:106` `typeof c.firstAt === 'string' ? c.firstAt : ''` | **else** | ✅ **可达** —— count 合法但 `firstAt` 非字符串 |
 * | `:107` `typeof c.lastAt === 'string' ? c.lastAt : firstAt` | **else** | ✅ **可达** —— 同上；且**回退到 firstAt**（不是空串） |
 * | `:114` `if (!value \|\| typeof value !== 'object') return out` | **早退** | ✅ **可达** —— 桶**整个不是对象**（`msm: "str"` / `null`） |
 * | `:131` `parsed.skill ?? {}` | undefined 侧 | ✅ **可达** —— 文件**没有 `skill` 键** |
 * | `:135` `typeof parsed.updatedAt === 'string' ? … : isoLocal(0)` | **else** | ✅ **可达** —— `updatedAt` 非字符串 |
 * | `:164` `firstAt: prev.firstAt \|\| at` | **falsy 侧** | ✅ **可达** —— 已存条目的 `firstAt` 是**空串**（手改/旧档）⇒ 应**补成当前时刻** |
 * | `:142` `(err as Error)?.message ?? err` | 右支 | ⛔ **非 Error 抛出族** —— `JSON.parse` 只抛 `Error` |
 * | `:226` 同上（写盘失败文案） | 右支 | ⛔ **非 Error 抛出族** —— fs 调用只抛 `Error` |
 * | `:216` `if (outcome.recorded === null) return outcome` | — | ⛔ **支配性守卫族** —— 两个公开入口在**进 `writeThrough` 之前**就已把 `NOTHING` 返回（见下"取证"） |
 * ⇒ 本件补 **6 处可达**；**3 处不可达如实登记、不涂绿**（纪律 ⑧）。
 *
 * ## 🔴 本件为何要紧（三处都是"容忍手改"承诺的执行点，而它们的另一侧从没走过）
 * ① **`:106`/`:107`** 是 `asCounter` 的**字段级归一** —— 既有用例只覆盖到 `:105`（`count` 非法 ⇒
 *    整条丢弃），**而"count 合法、时间戳非法"这一档从未被走过** ⇒ 把那两个三元删掉/写反，
 *    **既有测试全绿**，而手改档（真实形态：用户手工编辑 `_tmp/acc-usage.json`）会拿到
 *    `undefined` 时间戳 ⇒ 账本里出现 `"firstAt": undefined`（JSON 里**该键直接消失**）。
 * ② **`:114`** 是 `asBucket` 的**桶级守卫** —— 既有"容忍手改"用例写的是 `msm: { alsoBad: null }`
 *    （**是对象**，逐键过滤）⇒ **"桶整个不是对象"这一档没走过** ⇒ 删掉它 ⇒ `Object.entries("str")`
 *    得**字符索引** ⇒ 账本里凭空多出一堆单字符键（**精确重现第 66 件在 `localstore-ops` 见过的形态**）。
 * ③ **`:164` 的 `|| at`** 是"**旧档里 firstAt 为空串**"时的自愈点 —— 写成 `prev.firstAt` 直传 ⇒
 *    首次计入时刻**永远空着**，而下游读它的人无从判断"这条是什么时候开始的"。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面与正控方向成对测**：每条容错臂都配"合法档必须原样保留"。
 * · **⑱ 可选字段用 `in`**：`firstAt` 缺失 vs `firstAt: undefined` 是两回事。
 * · **⑧ 不声称一个我没挣到的覆盖** ⇒ 3 处不可达在文件头登记（各带族名）。
 * · **⑭ 变异一次才配声称承重**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  USAGE_STATS_SUBDIR,
  bumpBucket,
  loadUsageStats,
  recordToolUsage,
  usageStatsPath,
} from '../src/surface/usage.js'

let root = ''
let path = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acc-usage-br-'))
  path = usageStatsPath(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 直接往盘上写一份账本（模拟"手改档"——本件的主要故障形态） */
function writeRaw(body: unknown): void {
  mkdirSync(join(root, USAGE_STATS_SUBDIR), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
}

function read(): ReturnType<typeof JSON.parse> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

// ── A. 条目字段级容错（`:106` / `:107`）──

describe('usage-stats 退化面：`asCounter` 的**字段级**归一（`:106`/`:107` 的 else 侧）', () => {
  it('🔴 `:106`/`:107` count **合法**但时间戳非字符串 ⇒ 条目**必须保留**（不得整条丢弃）', () => {
    // 🔴 既有"容忍手改"用例只覆盖到 `:105`（count 非法 ⇒ 丢整条）⇒ **这一档从没走过**。
    //    真实形态：用户手工编辑 `_tmp/acc-usage.json`，把时间戳误删/写成数字。
    writeRaw({
      version: 1,
      updatedAt: '2026-09-22T10:00:00+08:00',
      skill: { loads: { keepme: { count: 5, firstAt: 12345, lastAt: null } }, injections: {} },
      msm: {},
    })
    const { stats, error } = loadUsageStats(root)
    expect(error, '不该报解析错（这是可容忍形态）').toBeNull()
    // 🔴 判据一：**条目必须还在**（count 合法 ⇒ 不能丢）
    expect(stats.skill.loads['keepme'], 'count 合法 ⇒ 条目必须保留').toBeDefined()
    expect(stats.skill.loads['keepme']!.count, 'count 原样保留').toBe(5)
    // 🔴 判据二：`firstAt` 非字符串 ⇒ 归一为**空串**（不是 undefined、不是 12345）
    expect(stats.skill.loads['keepme']!.firstAt, '非字符串 ⇒ 空串').toBe('')
    // 🔴 判据三（`:107` 的要害）：`lastAt` 非字符串 ⇒ **回退到 firstAt**，不是空串
    expect(stats.skill.loads['keepme']!.lastAt, 'lastAt 非字符串 ⇒ 回退 firstAt').toBe('')
  })

  it('🔴 `:107` 的**回退方向**：firstAt 合法、lastAt 非法 ⇒ lastAt 必须是**那个合法的 firstAt**', () => {
    // 🔵 上一条两者都非法 ⇒ 归一回空串，**区分不出**"回退到 firstAt"与"归回空串"。
    //    ⇒ 本条把 firstAt 造成合法值，才能钉住 `? c.lastAt : firstAt` 的**右侧真的是 firstAt**。
    writeRaw({
      version: 1,
      updatedAt: 'x',
      skill: { loads: { k: { count: 3, firstAt: '2026-01-01T00:00:00+08:00' } }, injections: {} },
      msm: {},
    })
    const c = loadUsageStats(root).stats.skill.loads['k']!
    expect(c.firstAt).toBe('2026-01-01T00:00:00+08:00')
    expect(c.lastAt, '🔴 缺失的 lastAt 必须继承 firstAt（不是空串）').toBe(c.firstAt)
  })

  it('🔵 正控（同夹具）：**两个时间戳都合法** ⇒ 原样保留（证明上面两条的归一不是恒发生）', () => {
    writeRaw({
      version: 1,
      updatedAt: 'x',
      skill: { loads: { k: { count: 2, firstAt: 'F', lastAt: 'L' } }, injections: {} },
      msm: {},
    })
    const c = loadUsageStats(root).stats.skill.loads['k']!
    expect(c.firstAt, '合法值不得被覆盖').toBe('F')
    expect(c.lastAt).toBe('L')
  })
})

// ── B. 桶级守卫与顶层键缺失（`:114` / `:131` / `:135`）──

describe('usage-stats 退化面：桶**整个不是对象** / 顶层 `skill` 键缺失 / `updatedAt` 非法', () => {
  it('🔴 `:114` 桶**不是对象**（字符串/数字/null）⇒ 空桶，且**绝不**产生字符索引键', () => {
    // 🔴 既有"容忍手改"用例写的是 `msm: { alsoBad: null }` —— 那**是对象**，走的是逐键过滤。
    //    "桶整个不是对象"**没走过** ⇒ 删掉 `:114` ⇒ `Object.entries("str")` 得字符索引
    //    ⇒ 账本里凭空多出一堆单字符键（**与第 66 件在 `localstore-ops` 见到的形态一模一样**）。
    writeRaw({ version: 1, updatedAt: 'x', skill: { loads: 'oops', injections: 42 }, msm: null })
    const { stats, error } = loadUsageStats(root)
    expect(error).toBeNull()
    expect(stats.skill.loads, '字符串桶 ⇒ 空桶').toEqual({})
    expect(stats.skill.injections, '数字桶 ⇒ 空桶').toEqual({})
    expect(stats.msm, 'null 桶 ⇒ 空桶').toEqual({})
    // 🔴 要害：**不得出现字符索引键**（`{0:'o',1:'o',2:'p',3:'s'}`）
    expect(Object.keys(stats.skill.loads), '不得把字符串切成字符索引').toEqual([])
  })

  it('🔴 `:131` 顶层**没有 `skill` 键** ⇒ 走 `?? {}` ⇒ 两个桶都空（且不抛）', () => {
    // 真实形态：旧版本/手写的最小账本只写了 `msm`。
    writeRaw({ version: 1, updatedAt: 'x', msm: { keep: { count: 1, firstAt: 'f', lastAt: 'f' } } })
    const { stats, error } = loadUsageStats(root)
    expect(error).toBeNull()
    expect(stats.skill.loads).toEqual({})
    expect(stats.skill.injections).toEqual({})
    // 🔵 正控方向：同档里**存在的** `msm` 必须照常读出（否则"空"可能是因为整档没读进来）
    expect(stats.msm['keep']!.count, 'msm 桶不受影响').toBe(1)
  })

  it('🔴 `:135` `updatedAt` **非字符串 / 缺失** ⇒ 回退 `isoLocal(0)`（不得是 undefined）', () => {
    for (const bad of [{ version: 1, updatedAt: 123, msm: {} }, { version: 1, msm: {} }]) {
      writeRaw(bad)
      const { stats } = loadUsageStats(root)
      // 🔴 用 `in`（纪律 ⑱）：`updatedAt: undefined` 与"该键存在"是两回事
      expect('updatedAt' in stats, '该键必须在场').toBe(true)
      expect(typeof stats.updatedAt, '必须是字符串').toBe('string')
      expect(stats.updatedAt, '不得渲染成 undefined 字样').not.toContain('undefined')
    }
  })

  it('🔵 正控：**合法 `updatedAt`** 原样保留；`version` 恒被重写成当前版本', () => {
    writeRaw({ version: 999, updatedAt: '2026-09-22T10:00:00+08:00', skill: { loads: {}, injections: {} }, msm: {} })
    const { stats } = loadUsageStats(root)
    expect(stats.updatedAt, '合法值不得被覆盖').toBe('2026-09-22T10:00:00+08:00')
    expect(stats.version, '版本号由本模块说了算').toBe(1)
  })
})

// ── C. firstAt 空串的自愈（`:164`）──

describe('usage-stats 退化面：`:164` 已存条目的 `firstAt` 是**空串** ⇒ 必须补成当前时刻', () => {
  it('🔴 `bumpBucket` 直调：`prev.firstAt === ""` ⇒ 新 `firstAt` = 本次时刻（不是空串）', () => {
    // 🔴 为何要紧：`firstAt` 是"这条是什么时候开始的"的**唯一来源**。写成 `prev.firstAt` 直传
    //    ⇒ 旧档（或被 `:106` 归一过的条目）**永远保留空串** ⇒ 下游无从判断起点。
    const before = { k: { count: 1, firstAt: '', lastAt: 'old' } }
    const after = bumpBucket(before, 'k', 'NOW')
    expect(after['k']!.count).toBe(2)
    expect(after['k']!.firstAt, '🔴 空串 ⇒ 补成本次时刻').toBe('NOW')
    expect(after['k']!.lastAt).toBe('NOW')
  })

  it('🔴 端到端：盘上是空串 `firstAt` ⇒ 记一次后**补齐**（走真读写链，不只是纯函数）', () => {
    writeRaw({
      version: 1,
      updatedAt: 'x',
      skill: { loads: {}, injections: {} },
      msm: { legacy: { count: 7, firstAt: '', lastAt: '' } },
    })
    const r = recordToolUsage(root, 'msm', { name: 'legacy' }, Date.parse('2026-09-26T10:00:00+08:00'))
    expect(r.ok).toBe(true)
    const c = read().msm['legacy']
    expect(c.count, '旧计数必须续算').toBe(8)
    expect(c.firstAt, '🔴 空串必须被补齐（不得留空）').not.toBe('')
    expect(c.lastAt).not.toBe('')
  })

  it('🔵 正控：**非空** `firstAt` ⇒ 绝不漂（既有承诺，此处作对照证明上一条的"补"只发生在空串档）', () => {
    const before = { k: { count: 1, firstAt: 'ORIGINAL', lastAt: 'old' } }
    const after = bumpBucket(before, 'k', 'NOW')
    expect(after['k']!.firstAt, '非空 ⇒ 一个字都不许动').toBe('ORIGINAL')
    expect(after['k']!.lastAt).toBe('NOW')
  })
})
