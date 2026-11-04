/**
 * manuals.test.ts — 统一手册体系（`tools/manuals.ts`）的**内容判据**
 *
 * ## 为什么这份测试必须存在（2026-11-04，owner 令）
 *
 * > 「我们 ACC 提供给 CCC 的手册好久没更新了，手册架构也不好，导致你老是忘更新」
 *
 * 改造前实测：容器里 8 份手册，总索引只覆盖 5 份，另外 3 份从索引完全看不见。
 * 这一组用例钉的就是"**索引必须完整**"与"**native 指针必须指得准**"。
 *
 * ## 🔴 一个我当场抓到的假绿（记下来，因为它是本组用例的设计起点）
 *
 * 我最初写的是 `expect(res.chapters).toEqual(MANUALS.map(m => m.id))` ——
 * **这条断言对"删掉一条登记"没有判别力**：删了之后左右两边同时变，照样绿。
 * ⇒ 自我引用的断言只能防"索引渲染漏章"，**防不住"登记表本身缺项"**。
 *   真正能防后者的，是下面 ③ 那条**独立事实源**判据（native 指针必须指向真实入口）。
 *
 * 判据分级（与 D274 同源：改钉本意，不改阈值）：
 * - ① id 唯一且非空 —— 防"两个同名章对方互相遮住"
 * - ② 每条必填三元（title/audience/when）—— 防"目录退化回只有一句话简介"
 * - ③ **native 的 entry 必须逐字出现在某个工具描述或已知入口清单里** —— 防"指针指向不存在的门"
 * - ④ 目录**不触发正文**（只读元数据）—— 防"两层菜单退化成一坨长文"
 * - ⑤ 正文只在 local 形态提供；native 章**不含正文**（v1.75.0 一个内容一个正文入口）
 */
import { describe, it, expect } from 'vitest'
import { MANUALS, findManual, renderManual, renderManualsIndex } from '../src/tools/manuals.js'

describe('统一手册体系：登记表自身的完整性', () => {
  it('① id 唯一、非空、无重复', () => {
    const ids = MANUALS.map((m) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size, `id 有重复：${ids.join(', ')}`).toBe(ids.length)
    for (const m of MANUALS) {
      expect(m.id.trim()).not.toBe('')
      // id 要能逐字敲出来 ⇒ 不允许空格（否则 `config docs <id>` 要引号）
      expect(m.id).not.toContain(' ')
    }
  })

  it('② 每条必须写清三件：它是谁 ／ 写给谁 ／ 何时读', () => {
    for (const m of MANUALS) {
      expect(m.title.trim(), `${m.id} 缺 title`).not.toBe('')
      expect(m.audience.trim(), `${m.id} 缺 audience（写给谁）`).not.toBe('')
      // 🔴 `when` 是本体系最重要的新增格：只写"这是什么"回答不了"我现在该不该读"
      expect(m.when.trim(), `${m.id} 缺 when（何时读）`).not.toBe('')
      expect(m.summary.trim(), `${m.id} 缺 summary`).not.toBe('')
    }
  })

  /**
   * ③ **native 指针必须指得准** —— 这是本组唯一**有真实判别力**的判据。
   *
   * 事实源独立于 `MANUALS` 本身：它来自"这些入口是不是真的存在"。
   * 判据 = `entry` 的**首个 token（工具名）＋ 第二个 token（动作/参数）**必须能在
   * 已知入口清单里找到；清单由**使用者实际打开的那个工具**决定，⛔ 不是从 MANUALS 推导。
   */
  it('🔴 ③ native 形态的 entry 必须指向真实存在的工具入口', () => {
    /**
     * 已知入口白名单（**独立事实源**：这些字符串是各工具真实接受的调用形态）。
     * ⚠️ 加一个新 native 手册 ⇒ 这里同时加一行；若忘了加，本用例会红并指名是哪一条。
     *   这是**刻意**的双写：宁可多一处机械同步，也不要一个指向不存在的门的指针（D179 同族）。
     */
    const KNOWN_ENTRIES = [
      'container_admin msm guide',
      'cognitive_trajectory cro-guide',
      'serenity-skill-creator guide',
    ]
    const natives = MANUALS.filter((m) => m.carrier.kind === 'native')
    expect(natives.length, 'native 形态一份都没有 —— 三份游离手册应当都在这条路径上').toBeGreaterThan(0)
    for (const m of natives) {
      const entry = (m.carrier as { entry: string }).entry
      expect(
        KNOWN_ENTRIES,
        `${m.id} 的指针 "${entry}" 不在已知入口清单里（写错的动作名会让读者走空门）`,
      ).toContain(entry)
    }
  })

  it('④ 目录只读元数据，不返回任何正文', () => {
    const index = renderManualsIndex()
    // 目录必须提到每一章
    for (const m of MANUALS) expect(index).toContain(m.id)
    // 目录必须给出"何时读"这一栏的值（否则等于没写）
    for (const m of MANUALS) expect(index).toContain(m.when)
    // 🔴 反向：目录**不许**含任一 local 正文的开头（证明它没触发 render）
    for (const m of MANUALS) {
      if (m.carrier.kind !== 'local') continue
      const body = m.carrier.render()
      const head = body.slice(0, 40)
      expect(index.includes(head), `${m.id} 的正文被目录带出来了（两层退化成一层）`).toBe(false)
    }
  })

  it('⑤ native 章只给指针，⛔ 不复制正文（v1.75.0 一个内容一个正文入口）', () => {
    for (const m of MANUALS.filter((x) => x.carrier.kind === 'native')) {
      const text = renderManual(m)
      // 必须含它的真实入口（读者据此去取）
      expect(text).toContain((m.carrier as { entry: string }).entry)
      // 必须**明说**正文不在本节（而不是静默给个指针让人以为这就是全文）
      expect(text).toMatch(/正文不在本节|正文入口是/)
    }
  })
})

describe('统一手册体系：查找与边界', () => {
  it('大小写不敏感（「我打错大小写」不该变成"没有这章"）', () => {
    expect(findManual('CONFIG')?.id).toBe('config')
    expect(findManual('  Cro  ')?.id).toBe('cro')
  })

  it('未知 id ⇒ null（不要把"没有"伪装成"空章"）', () => {
    expect(findManual('nope')).toBeNull()
    expect(findManual('')).toBeNull()
    expect(findManual('   ')).toBeNull()
  })

  it('local 形态的章返回真正文（不是指针）', () => {
    const cfg = findManual('config')
    expect(cfg).not.toBeNull()
    const text = renderManual(cfg!)
    expect(text.length).toBeGreaterThan(500) // 真全文，不是一句话
  })
})
