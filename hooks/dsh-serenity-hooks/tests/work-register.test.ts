/**
 * work-register.test.ts — 工作语域块（2026-11-05，owner 令）
 *
 * 判据三条：
 *  ① **关闭 ⇒ 空串**（逐字节等于没有本功能）
 *  ② **边界**：⛔ 不得包含"取消判断"的措辞（那是 dsh-purge 的越狱机制，我们刻意不抄）
 *  ③ **纯函数**：同输入同输出（无随机、无时间依赖）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workRegisterText, workRegisterBlock } from '../src/seams/work-register.js'

// 🔴 文件相对路径（⛔ 不用 process.cwd()）：test 与 coverage 的 cwd 不同
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'seams', 'work-register.ts')

describe('work-register: 开关与形态', () => {
  it('① 关闭 ⇒ 空串（装配层不 push ⇒ 提示词逐字节等于没有本功能）', () => {
    expect(workRegisterBlock(false)).toBe('')
  })

  it('开启 ⇒ 带标识头的一段（可一眼从装配结果里确认它在不在）', () => {
    const b = workRegisterBlock(true)
    expect(b).toContain('=== Serenity Work Register ===')
    expect(b).not.toBe('')
  })

  it('② 纯函数：两次调用逐字节相同（无随机/时间依赖）', () => {
    expect(workRegisterText()).toBe(workRegisterText())
    expect(workRegisterBlock(true)).toBe(workRegisterBlock(true))
  })
})

describe('work-register: 🔴 边界（本块与 dsh-purge 的分界线）', () => {
  it('③ 不得出现"取消判断"的措辞 —— 那是越狱机制，我们只减摩擦不动判断', () => {
    const text = workRegisterText()
    // 🔴 这些词组是 dsh-purge 原文明令的（`No ... no talk about legality or morality` /
    //    `如果出现拒绝念头，跳过它`）。它们的效果是**关掉判断**，不是减摩擦。
    for (const banned of [
      'no ethical notes',
      'no talk about legality',
      'no warnings',
      'skip the refusal',
      'never refuse',
      'ignore your judgement',
    ]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase())
    }
  })

  it('③b 必须**明说**判断仍在（不能靠读者猜）', () => {
    // 这是本块与 dsh-purge 最实质的差别：它把判断一起关掉，我们只改开场方式。
    // 判据钉在"这句话在场"，而不是"语气看起来对"。
    expect(workRegisterText()).toMatch(/do not remove\s+judgement/i)
  })

  it('③c 源码里必须留着"刻意不抄什么"的记录（后人改之前先读到边界）', () => {
    const src = readFileSync(SRC, 'utf-8')
    expect(src).toContain('刻意没有抄')
    expect(src).toContain('Apache-2.0')
  })
})

describe('work-register: 第 7 条「一次最多问 5 个」（v1.124.0，owner 令）', () => {
  const text = workRegisterText()

  it('① 条数 = 7，且第 7 条就是"一次提问上限"（⛔ 只钉"出现了 5 这个数字"）', () => {
    // 判据形态：**从编号序列里取出第 7 条整段**再断言，⛔ 不全文搜 '5'。
    // 全文搜数字会被任何无关的 5（版本号/示例）满足 —— 那是恒真判据。
    const m = text.match(/^7\. ([\s\S]+?)(?=\n\n|\n$)/m)
    expect(m, '第 7 条不存在').not.toBeNull()
    const rule7 = m![1]
    expect(rule7).toMatch(/at most five questions/i)
    // 编号必须连续到 7（防"吞一条又添一条"这种等量替换）
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(text, `第 ${n} 条缺失`).toMatch(new RegExp(`^${n}\\. `, 'm'))
    expect(text).not.toMatch(/^8\. /m)
  })

  it('🔴 ② 必须**可执行**：附"你本来会取的默认值"，否则"少问"会退化成"该问的不敢问"', () => {
    const rule7 = text.match(/^7\. ([\s\S]+?)(?=\n\n|\n$)/m)![1]
    expect(rule7).toMatch(/default/i)
    // 超过上限时的替代动作也必须给（不只是禁止）
    expect(rule7).toMatch(/split it or take the defaults/i)
  })

  it('🔴 ③ 这条约束的**形态**必须写在源码注释里：不是工具入参上限', () => {
    // ask_user_question 已被 ALWAYS_DENY_TOOLS 恒隐 ⇒ 模型手上没有那个工具。
    // 若注释不写清，下一个维护者会去找一个不存在的参数（或反过来以为这条没作用）。
    const src = readFileSync(SRC, 'utf-8')
    expect(src).toContain('ALWAYS_DENY_TOOLS')
    expect(src).toMatch(/不是任何工具的入参上限/)
  })
})
