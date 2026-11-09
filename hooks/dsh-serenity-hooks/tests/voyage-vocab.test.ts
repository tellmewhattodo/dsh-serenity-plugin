/**
 * voyage-vocab.test.ts — 航行页词表**运行时注入**（owner 2026-10-18 报的缺陷）
 *
 * 报的现象：「为什么我在别的 CCC 点开显示的还是我们 home-serenity 的信息」「动画也有这个毛病」。
 * 根因：资产里的 `var VOCAB = {...}` 是**构建期扫描容器写死的常量** ⇒ 一份静态资产
 * 只能属于一个 CCC。
 *
 * 本文件守三条判据（与源码文件头一一对应）：
 *  ① **只替换那一行** —— 资产其余字节不得变（它是 3000+ 行的渲染程序）
 *  ② **读不出来就走原样** —— 锚认不出 / 原 VOCAB 坏 ⇒ 返回入参本身，不报错（装饰页不该打不开）
 *  ③ **`zh` 保留** —— 中文隐喻词属资产自身，不来自容器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { injectVoyageVocab, scanVoyageLiveVocab } from '../src/surface/voyage/vocab.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'voyage-vocab-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个最小 CCC 骨架（技能 / 本体 / 注册表 / 轨迹） */
function makeCcc(skills: string[], modeled: string[], msms: string[], trajectories: string[]): void {
  const sk = join(root, '.opencode', 'skills')
  for (const s of skills) {
    mkdirSync(join(sk, s), { recursive: true })
    writeFileSync(join(sk, s, 'SKILL.md'), `# ${s}\n`)
  }
  for (const m of modeled) {
    mkdirSync(join(sk, m), { recursive: true })
    writeFileSync(join(sk, m, 'SKILL.md'), `# ${m}\n`)
    writeFileSync(join(sk, m, 'skill.ttl'), '@prefix : <#> .\n')
  }
  const ref = join(sk, 'home-serenity', 'references')
  mkdirSync(ref, { recursive: true })
  // 🔴🔴 **必须用真实注册表形态**（`{version, description, entries:[…]}`）。
  // 2026-11-09 的教训：夹具原本写的是 `{msms:[…]}` —— 一个**真实世界里不存在**的形态，
  // 于是"只读 raw.msms"的实现全绿，而真机上 `counts.msm` 恒 0（图上写「0 工具」）。
  // ⇒ 夹具与真身同形，是这条判据有判别力的**前提**（D274：改钉本意，不放宽到能过）。
  // ⚠️ 真身形态见 `src/tools/msm/service.ts` 的 `parseRegistry` / `writeRegistry`。
  writeFileSync(
    join(ref, 'mech-registry.json'),
    JSON.stringify({
      version: 1,
      description: 'MSM registry (managed by acc-msm / dsh-serenity-hooks)',
      entries: msms.map((name) => ({ name, path: `.opencode/skills/x/scripts/${name}.ts` })),
    }),
  )
  for (const t of trajectories) mkdirSync(join(root, 'AGENT_SESSIONS', t), { recursive: true })
  // 归档区与日志区不是轨迹（与轨迹层同判据）
  mkdirSync(join(root, 'AGENT_SESSIONS', '_archived'), { recursive: true })
  mkdirSync(join(root, 'AGENT_SESSIONS', '_weixin-logs'), { recursive: true })
}

const ASSET = [
  '<html>',
  '<script>',
  'var other = 1;',
  'var VOCAB = {"skills":["STALE-A"],"msms":["STALE-B"],"zh":["寰宇","宁静"],"onto":["old"],"counts":{"skill":1,"msm":1,"onto":1,"axiom":9,"repo":7,"session":3}};',
  'var WORDS = [];',
  '</script>',
  '</html>',
].join('\n')

describe('scanVoyageLiveVocab：从 CCC 实况读词表', () => {
  it('技能／本体／MSM／轨迹数各自来自正确的来源', () => {
    makeCcc(['a', 'b'], ['a'], ['msm-x', 'msm-y'], ['2026-01-01--S001--x', '2026-01-02--S002--y'])
    const v = scanVoyageLiveVocab(root)
    expect(v.skills).toEqual(['a', 'b'])
    expect(v.onto).toEqual(['a']) // 只有带 skill.ttl 的
    expect(v.msms).toEqual(['msm-x', 'msm-y'])
    expect(v.counts.skill).toBe(2)
    expect(v.counts.msm).toBe(2)
    expect(v.counts.onto).toBe(1)
    // 🔴 归档区与日志区不得计进轨迹数（与 readAllSessions 的 `_` 跳过同判据）
    expect(v.counts.session).toBe(2)
  })

  it('🔴 空 CCC ⇒ 全空但**不抛**（装饰页不该因缺目录打不开）', () => {
    const v = scanVoyageLiveVocab(root)
    expect(v).toEqual({
      skills: [],
      msms: [],
      onto: [],
      counts: { skill: 0, msm: 0, onto: 0, session: 0 },
    })
  })

  it('注册表坏 JSON ⇒ msms 空、其余照常（单项独立容错）', () => {
    makeCcc(['a'], [], [], [])
    writeFileSync(join(root, '.opencode', 'skills', 'home-serenity', 'references', 'mech-registry.json'), '{bad')
    const v = scanVoyageLiveVocab(root)
    expect(v.skills).toEqual(['a']) // 不受牵连
    expect(v.msms).toEqual([])
  })

  /**
   * 🔴🔴 2026-11-09 真机首读抓到的缺陷（v1.127.1 回归）。
   *
   * 现象：真机蓝图标题栏显示 `SN-42-00` / `42 技能 / 0 工具`，而同一份资产 `file://`
   * 直开（走构建期常量）显示 `SN-38-100`。**不是崩溃，是图上写了个假数字** ——
   * 而这正是标注层最怕的形态（`§8c` 的硬约束是"每个数字都必须是真的"）。
   *
   * 根因：`scanMsmNames` 只读 `raw.msms`，真实注册表的顶层键却是 `entries`。
   * ⚠️ 同一仓库里**已经犯过一次**（`ontology/engine.ts` 的 `readMechRegistry`，
   * 注释写着「顶层键找错 ⇒ entries = raw」）⇒ 这是**漏修的第二处**。
   *
   * 🔴 为什么原来的夹具抓不到：它写 `{msms:[…]}` —— 真实世界里不存在的形态。
   * ⇒ 本组**专门钉真实形态**，并做两个方向的检查（下面那条变异正控）。
   */
  it('🔴 真实注册表形态（`entries` 顶层键）下 MSM 数必须读得出来', () => {
    makeCcc(['a'], [], ['msm-x', 'msm-y', 'msm-z'], [])
    const v = scanVoyageLiveVocab(root)
    expect(v.msms).toEqual(['msm-x', 'msm-y', 'msm-z'])
    expect(v.counts.msm).toBe(3)
    // 反向：绝不能是"读不到就静默 0" —— 那个 0 会原样写进图上
    expect(v.counts.msm).not.toBe(0)
  })

  it('兼容旧/外部形态（顶层 `msms`）—— 两个键都认，且 entries 优先', () => {
    makeCcc(['a'], [], [], [])
    const p = join(root, '.opencode', 'skills', 'home-serenity', 'references', 'mech-registry.json')
    writeFileSync(p, JSON.stringify({ msms: [{ name: 'legacy-only' }] }))
    expect(scanVoyageLiveVocab(root).msms).toEqual(['legacy-only'])
    // 两者都在 ⇒ entries 赢（v1 包装形是当前真身）
    writeFileSync(p, JSON.stringify({ entries: [{ name: 'from-entries' }], msms: [{ name: 'from-msms' }] }))
    expect(scanVoyageLiveVocab(root).msms).toEqual(['from-entries'])
  })
})

describe('injectVoyageVocab：只改那一行（判据 ①③）', () => {
  it('替换 VOCAB 行；其余字节**逐个**不变', () => {
    const out = injectVoyageVocab(ASSET, { skills: ['live-a'], msms: ['live-m'], onto: [], counts: { skill: 1 } })
    // ① 其余行原样
    expect(out.split('\n').filter((l) => !l.startsWith('var VOCAB ='))).toEqual(
      ASSET.split('\n').filter((l) => !l.startsWith('var VOCAB =')),
    )
    // ② VOCAB 行换了内容
    expect(out).toContain('"live-a"')
    expect(out).not.toContain('STALE-A')
    expect(out).not.toContain('STALE-B')
  })

  it('🔴 `zh` **必须保留**（中文隐喻词属资产自身，不来自容器）', () => {
    const out = injectVoyageVocab(ASSET, { skills: [], msms: [], onto: [], counts: {} })
    expect(out, 'zh 被冲掉 ⇒ 星场会少一层中文词').toContain('"zh":["寰宇","宁静"]')
  })

  it('counts 合并而非替换：资产里特有的键（axiom/repo）保留', () => {
    const out = injectVoyageVocab(ASSET, { skills: [], msms: [], onto: [], counts: { skill: 5, session: 42 } })
    expect(out).toContain('"axiom":9') // 资产原有、实况没提供的 ⇒ 保留
    expect(out).toContain('"repo":7')
    expect(out).toContain('"skill":5') // 实况覆盖
    expect(out).toContain('"session":42')
  })
})

describe('injectVoyageVocab：失败就走原样（判据 ②）', () => {
  it('live=null ⇒ 与入参**逐字节相同**', () => {
    const live = { skills: ['x'], msms: [], onto: [], counts: {} }
    expect(injectVoyageVocab(ASSET, null)).toBe(ASSET)
    // 正控：非 null 时确实变了 ⇒ 上面那条不是因为"什么都不做"恒过
    expect(injectVoyageVocab(ASSET, live)).not.toBe(ASSET)
  })

  it('锚认不出（资产里没有那一行）⇒ 原样返回，不报错', () => {
    const noVocab = '<html>\n<script>var x = 1;</script>\n</html>'
    expect(injectVoyageVocab(noVocab, { skills: ['x'], msms: [], onto: [], counts: {} })).toBe(noVocab)
  })

  it('原 VOCAB 不是合法 JSON ⇒ 原样返回（不去"修"它）', () => {
    const broken = 'var VOCAB = {skils:[};\n'
    expect(injectVoyageVocab(broken, { skills: ['x'], msms: [], onto: [], counts: {} })).toBe(broken)
  })

  it('payload 含 `$` 时不被当成替换串（函数式 replace 的正控）', () => {
    // 用字符串式 replace 会把 `$&` 展开成匹配到的整段 ⇒ 这条会当场抓到
    const out = injectVoyageVocab(ASSET, { skills: ['a$&b'], msms: [], onto: [], counts: {} })
    expect(out).toContain('a$&b')
  })
})
