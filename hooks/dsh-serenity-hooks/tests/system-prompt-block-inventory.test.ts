/**
 * system-prompt 装配**块清单闭合性**（2026-11-27，butler 报障逼出）
 *
 * ## 这条判据补的是哪一格（先读这一段，否则会以为它是"又一个"提示词测试）
 *
 * 既有 `system-prompt.test.ts` 已经钉住了**具名的那些块**：presence（`toContain`）、
 * 块序（`indexOf` 比较）、关键句、以及两条负控（块内无中文 / 无 emoji）。它对下面两件事**结构性失明**：
 *
 *   ① **多了一个谁也没点名的块** —— 它只检查"我在找的那几个在不在"，从不问"还有没有别的"；
 *   ② **块内顺序** —— 无判据。
 *
 * 🔴 ① 不是假设，它**已经发生过一次**：`src/seams/system-prompt.ts` 头部那段块清单注释
 * （`1. ACC / 2. Metaphor / … / 7b. Tools / 8. Session`，自称"8 块五层"）
 * **已经与真实装配脱节** —— 它不含 Soul、Creed、Work Register；且仍写着 `Serenity Tools`
 * （该标题已于 v1.124.0 改为 `Serenity MSM`，旧标题现在恒不存在）。**没有任何测试因此变红。**
 * ⇒ 这就是"自由新增的块"在真实世界里的形态：**描述装配的那份清单先漂了，而门禁不响**。
 *
 * ## 为什么用「标题集合」而不是「整段文本的哈希/快照」（butler 提议的是后者）
 *
 * 判据是**单侧**的：必须对真实可能的错误变红，且**不得**对无害的措辞修改变红 ——
 * 否则第一次红就会被反射性地重设基线，那正是 `#538`（误报训练人不信闸）。
 *
 * 整段哈希**两头都红**：它无法区分「块内换了一行顺序」与「改了半句话」——
 * 两者对哈希是同一种影响。⇒ 它必然在每次措辞微调时变红，**不满足单侧要求**。
 *
 * 另有一条硬阻塞：装配结果**不是源码的纯函数** —— 它还读
 * `~/.dsh/serenity-hooks.json`（persona / humor / workRegister）、CCC 的 `SKILL.md`、
 * 活跃会话标记、该轨迹的 `PROMPT.md`。⇒ 哈希会随**不同机器的个人配置**变红，
 * 与"我改了一个字"变红**读数上不可分**。
 *
 * ⇒ 采用**标题集合闭合**：只问"出现了哪些 `=== Serenity … ===`"，用 `toEqual` 精确比对。
 *    · 多一个块 ⇒ 集合多一项 ⇒ 红（正是 ① 要的）
 *    · 少一个块 ⇒ 集合少一项 ⇒ 红
 *    · 改措辞（标题不变）⇒ 集合不变 ⇒ **绿**（单侧成立）
 *    · 块内换序 ⇒ 本判据**看不见** —— 如实登记，不用哈希去补（见下"已知缺口"）。
 *
 * **已知缺口（⛔ 别以为本文件管了它）**：块内顺序不由本判据覆盖。若某块的**内部顺序承载语义**，
 * 该块自己按 `creedBlock` 的先例钉**编号序列**（`system-prompt.test.ts` 的 `\n${n}. ` 循环），
 * ⛔ 不要退回到整段哈希。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serenitySystemPrompt } from '../src/seams/system-prompt.js'
import { useSession, resetActiveSessionStore } from '../src/trajectory/core.js'

let dir: string
let cfg: string
let oldEnv: string | undefined

/**
 * 抽出顶层标题序列（⛔ 不去重、⛔ 不排序）——
 * 保留**原始顺序与重复**，这样"同一块被 push 了两次"也会被抓到。
 */
function headingsIn(text: string): string[] {
  return [...text.matchAll(/^=== (Serenity .+?) ===$/gm)].map((m) => m[1]!)
}

/** 合成 CCC：`.serenity` 记号 ＋ 一个顶层入口 skill（与既有用例同形） */
function setupCcc(): void {
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode', 'skills', 'other-serenity'), { recursive: true })
  writeFileSync(
    join(dir, '.opencode', 'skills', 'other-serenity', 'SKILL.md'),
    '---\nname: other-serenity\ndescription: 系统入口\n---\n顶层入口原文内容',
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-inv-'))
  setupCcc()
  // 🔴 **必须钉死全局配置**：本判据断言的是"块集合"，而 persona / humor / workRegister
  //    三个块的条件**全部来自全局配置文件**。不钉 ⇒ 断言会随**跑测这台机器的个人配置**变化
  //    （`personaBlock` 与 `humorBlock` 的启用条件就在里面）。
  //    ⚠️ 这同时解释了既有装配用例为什么能一直在不同机器上过：它们只查具名块，
  //      而缺省下 humor 关（`enabled:false`）、persona 空，故那两块根本不出现。
  cfg = join(dir, 'serenity-hooks.json')
  oldEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = cfg
})

afterEach(() => {
  if (oldEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldEnv
  // 🔴 `useSession` 写的是**模块级内存 Map** ⇒ 不重置会污染后续用例
  //    （本仓 `osp-alignment.test.ts` 同款，见其 `resetActiveSessionStore` 用法）
  resetActiveSessionStore()
  rmSync(dir, { recursive: true, force: true })
})

describe('system-prompt 装配：块清单闭合（多一个/少一个都必须红）', () => {
  it('🔴 缺省配置：装配出的标题序列**恰好**是这九个，且按此序', () => {
    // 缺省态：workRegister 缺省**开**（config.ts:150），humor 缺省关，persona 空，
    //        无 `.serenity-safe-on` ⇒ Safe Mode 不出现；无 `localstore.json` ⇒ Localstore 不出现；
    //        无活跃会话 ⇒ Session 不出现；未传 dirName ⇒ 无 Trajectory Prompt。
    //        `sessionBlock` / 状态块 / SKILL 段各自的条件彼此独立 ⇒ 这里的集合是确定的。
    const text = serenitySystemPrompt(dir)
    expect(headingsIn(text)).toEqual([
      'Serenity Soul',
      'Serenity ACC',
      'Serenity Operator Creed',
      'Serenity Metaphor',
      'Serenity Principles',
      'Serenity CCE',
      'Serenity EAP',
      'Serenity Work Register',
      'Serenity MSM',
    ])
    // 正控：SKILL 段**没有标题标记**（注入的是 SKILL.md 原文）⇒ 它天然抓不到，
    // 故单独钉一次，避免"SKILL 被整段丢掉而集合不变"这种假绿。
    expect(text).toContain('顶层入口原文内容')
  })

  it('🔴 条件块全开：新增的四块按序入列，且**不多出**任何未点名的块', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    writeFileSync(
      cfg,
      JSON.stringify({
        persona: { mode: 'big-fish', overrideText: 'You are a big fish.' },
        humor: { enabled: true, bits: ['a piece of stand-up'] },
      }),
    )
    const text = serenitySystemPrompt(dir, 'scope-x', undefined, 'session-x')
    expect(headingsIn(text)).toEqual([
      'Serenity Soul',
      'Serenity ACC',
      'Serenity Operator Creed',
      'Serenity Metaphor',
      'Serenity Principles',
      'Serenity CCE',
      'Serenity EAP',
      // humor 在 EAP 之后、persona 之前（先立标准，再路过闲笔，最后谈表达）
      'Serenity Humor',
      'Serenity Persona',
      'Serenity Work Register',
      // 运行时状态块：Safe Mode 在前、Localstore 在后（state 由二者 join 而来）
      'Serenity Safe Mode',
      'Serenity Localstore',
      'Serenity MSM',
    ])
  })

  it('🔴 反面钉：`Serenity Tools` 这个旧标题**必须不存在**（合成一组时最容易"顺手"复活它）', () => {
    // 单靠上一个用例的 toEqual 已经能抓到它，这条是给失败信息用的：
    // 一旦有人把标题改回去，报错会直接说是哪一格坏了，而不是让人对着一长串 diff 找。
    const text = serenitySystemPrompt(dir)
    expect(headingsIn(text)).not.toContain('Serenity Tools')
  })
})

/**
 * 🔴 **头注里那份块清单本身，也要有闸**（2026-11-27，butler 的追问逼出的第二层）
 *
 * 上一个 describe 钉住的是**装配产物**。但**头注**是同一事实的**第二份手写副本** ——
 * 而它已经漂过：曾经漏掉 Soul／Creed／Work Register，且仍写着 `Serenity Tools`（v1.124.0 已改），
 * **当时没有任何测试变红**（它只是注释）。同一形态当夜出现两次，两次都是我造成的。
 *
 * ⇒ 判据：**头注里点名的标题集合，必须与装配产物的标题集合完全相等**（双向）。
 *
 * 单侧性（⛔ 别让这条变成"改一个字就红"的仪式）：
 *   · 只提取**反引号里的 `=== Serenity … ===`** ⇒ 散文措辞怎么改都不影响；
 *   · 只有**增删块／改名块**才会红 —— 那正是我们要它红的事。
 *
 * 🔴 这条刻意**不**断言注释里的散文内容（为什么加这一块、版本号、口径说明）——
 *    那些是知识，不是契约。钉散文＝每次改措辞都红＝第一次红就被无视（同 #538）。
 */
describe('system-prompt 头注：块清单与装配产物必须一致（注释也是第二真相源）', () => {
  /** 取头注（文件开头那块 JSDoc 结束标记之前）里被反引号包住的全部块标题 */
  function titlesNamedInHeaderComment(): string[] {
    const src = readFileSync(new URL('../src/seams/system-prompt.ts', import.meta.url), 'utf8')
    // ⚠️ 这个结束标记只能写成字符串，⛔ 不能把它的字面形态写进本文件的注释 ——
    //    注释里出现它会把本函数自己的 JSDoc **提前关闭**（本文件已踩：连报两次
    //    Transform failed，第二次的 "Unterminated string literal" 真因就是这个）。
    const headerEnd = src.indexOf('*/')
    if (headerEnd < 0) throw new Error('找不到头注结束标记 —— 判据的取数域失效了，⛔ 别让它静默变空')
    const header = src.slice(0, headerEnd)
    // ⚠️ 目标标题在头注里被反引号包住，而反引号**不能出现在正则字面量或注释里**
    //    （解析器会把它当成模板串开头；本文件已连踩两次，esbuild 当场报 Transform failed）。
    //    ⇒ 用 fromCharCode 取那个字符，再用 RegExp 构造器 —— ⛔ 别改回字面量。
    const BT = String.fromCharCode(96)
    const named = new RegExp('=== (Serenity [^' + BT + ']+?) ===', 'g')
    return [...header.matchAll(named)].map((m) => m[1]!)
  }

  it('🔴 头注点名的标题集合 == 产物的标题集合（缺一个、多一个、写错一个都必须红）', () => {
    // 产物侧取**条件全开**的那一轮（头注描述的是完整清单，含条件块）
    writeFileSync(join(dir, '.serenity-safe-on'), 'now')
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    writeFileSync(
      cfg,
      JSON.stringify({
        persona: { mode: 'big-fish', overrideText: 'You are a big fish.' },
        humor: { enabled: true, bits: ['a piece of stand-up'] },
      }),
    )
    const emitted = new Set(headingsIn(serenitySystemPrompt(dir, 'scope-x', undefined, 'session-x')))

    // `=== Serenity Session ===` 只在**有活跃会话**时出现 ⇒ 按 `osp-alignment.test.ts:212-217` 同款建：
    // 先落一份 SESSION.md（`useSession` 会真去盘上找这个会话，⛔ 光写内存 Map 不够）
    const sessDir = '2026-01-01--S001--probe'
    mkdirSync(join(dir, 'AGENT_SESSIONS', sessDir), { recursive: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS', sessDir, 'SESSION.md'), '# test')
    useSession(dir, 'S001', 'scope-sess')
    for (const h of headingsIn(serenitySystemPrompt(dir, 'scope-sess', undefined, 'session-x'))) emitted.add(h)

    // 轨迹块只有传了 dirName 才出现，而头注里点了它 ⇒ 判据要按"可能出现的全集"比
    const trajProbe = mkdtempSync(join(tmpdir(), 'sp-traj-'))
    try {
      writeFileSync(join(trajProbe, '.serenity'), 'test')
      mkdirSync(join(trajProbe, 'AGENT_SESSIONS', '2026-01-01--S001--x'), { recursive: true })
      writeFileSync(
        join(trajProbe, 'AGENT_SESSIONS', '2026-01-01--S001--x', 'PROMPT.md'),
        '# 轨迹章程\n正文',
      )
      mkdirSync(join(trajProbe, '.opencode', 'skills', 'other-serenity'), { recursive: true })
      writeFileSync(
        join(trajProbe, '.opencode', 'skills', 'other-serenity', 'SKILL.md'),
        '---\nname: other-serenity\ndescription: 系统入口\n---\n顶层入口原文内容',
      )
      const withTraj = serenitySystemPrompt(trajProbe, 'scope-x', '2026-01-01--S001--x', 'session-x')
      for (const h of headingsIn(withTraj)) emitted.add(h)
    } finally {
      rmSync(trajProbe, { recursive: true, force: true })
    }

    const named = titlesNamedInHeaderComment()
    expect(named.length, '头注里一个标题都没抓到 ⇒ 取数域坏了（防"两边都是空集"假绿）').toBeGreaterThan(5)
    // ⚠️ 反引号里的 `=== Serenity … ===` 是**模式**（省略号），不是某个真标题 ⇒ 过滤掉省略号项。
    const namedReal = named.filter((h) => !h.includes('…'))
    expect([...new Set(namedReal)].sort()).toEqual([...emitted].sort())
  })
})
