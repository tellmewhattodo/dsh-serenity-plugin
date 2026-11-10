/**
 * browser-slot-home.test.ts — 槽位体系的**全局**家目录（跨 CCC 唯一）
 *
 * 🔴🔴 这个文件钉的是 owner 2026-11-10 那条令的机械判据：
 *    「20 个槽位是所有 CCC 共用的，状态管理要全局」
 *
 *    原缺陷的形状：台账在 `<CCC 根>/.opencode/browser-slots.json` = **每个 CCC 各一份**，
 *    而端口 9301–9320 与 Chrome 进程是**全机唯一**的。
 *    ⇒ 两个 CCC 各自认为 b1 空闲 ⇒ 抢同一端口，**且两份台账都自洽、没有任何读数显示冲突**。
 *
 *    判据（比修法值钱）：**资源的唯一性必须由状态载体的唯一性保证**，
 *    ⛔ 不能靠"每个使用者各自记一份再指望它们对得上"。
 */

import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SLOTS_DIR_ENV, slotsHomeDir } from '../src/browser/home.js'
import { SLOTS_DIR_NAME } from '../src/browser/process.js'

describe('槽位家目录（唯一性由这个函数保证）', () => {
  it('① 默认落点 = `~/.dsh/serenity-browser-slots`（宿主存储家，天然跨 CCC）', () => {
    expect(slotsHomeDir({})).toBe(join(homedir(), '.dsh', SLOTS_DIR_NAME))
    expect(SLOTS_DIR_NAME).toBe('serenity-browser-slots')
  })

  it('② 🔴 传任何第二个参数（例如某个 CCC 根）都不改变结果 —— 跨 CCC 唯一的机械保证', () => {
    // ⚠️ 这条**不能**用 `slotsHomeDir.length` 判：`env = process.env` 是**默认值**，
    //    而 JS 里带默认值的形参**不计入** `Function.length` ⇒ 那个写法恒为 0，是**假绿**。
    //    （本文件第一版正是这么写的，当场红 — 红在对的方向：读数器与问题不匹配，D252 同族。）
    // ⇒ 真判据：塞一个"看起来该被尊重"的根进去，结果必须**一字不变**。
    const a = slotsHomeDir({})
    const asIfRoot = (slotsHomeDir as unknown as (...xs: unknown[]) => string)({}, '/ccc/alpha')
    expect(asIfRoot).toBe(a)
    expect(slotsHomeDir({})).toBe(a)
  })

  it('③ 环境变量可覆盖（测试隔离靠它，⛔ 不是"可选功能"）', () => {
    expect(slotsHomeDir({ [SLOTS_DIR_ENV]: '/tmp/slots-x' })).toBe('/tmp/slots-x')
    expect(SLOTS_DIR_ENV).toBe('SERENITY_BROWSER_SLOTS_DIR')
  })

  it('④ 空串/纯空白的覆盖值 ⇒ 回落默认（⛔ 把家目录解析成空路径）', () => {
    // 判据：`SERENITY_BROWSER_SLOTS_DIR=` 在 shell 里很容易被写成空串，
    // 而 `join('', 'ledger.json')` = 相对路径 ⇒ 台账会落在**进程 cwd** 里，
    // 那是一个随启动目录而变的路径 —— 比原缺陷更坏（更隐蔽）。
    expect(slotsHomeDir({ [SLOTS_DIR_ENV]: '' })).toBe(join(homedir(), '.dsh', SLOTS_DIR_NAME))
    expect(slotsHomeDir({ [SLOTS_DIR_ENV]: '   ' })).toBe(join(homedir(), '.dsh', SLOTS_DIR_NAME))
  })

  it('⑤ 落点名不含任何 CCC 特征（⛔ 放谁家就等于让那个 CCC 当"主"）', () => {
    const p = slotsHomeDir({})
    expect(p).not.toMatch(/home-serenity|AGENT_SESSIONS|\.opencode/i)
    expect(p.startsWith(homedir())).toBe(true)
  })

  it('⑥ 🔴 测试进程里**不覆盖就直接抛** —— 这是"测试不许污染唯一真相源"的机械保证', () => {
    // 判据来源 = 一次真实污染（2026-11-10）：一个没跟着迁移的旧测试仍在调
    //   `writeLedger(root, …)`，而新签名只有形参 ⇒ 多传的 root 被 JS **静默忽略**
    //   ⇒ 测试夹具落进了真实台账 ⇒ 之后 reap 拿着脏 pid 去杀了陌生进程。
    // ⇒ 唯一的机械保证：测试进程不给出覆盖值就**起不来**。
    expect(() => slotsHomeDir({ VITEST: 'true' })).toThrow(/SERENITY_BROWSER_SLOTS_DIR/)
    expect(() => slotsHomeDir({ VITEST_WORKER_ID: '1' })).toThrow()
    // 正控：给了覆盖值就正常返回（证明上面不是"任何调用都抛"）
    expect(slotsHomeDir({ VITEST: 'true', [SLOTS_DIR_ENV]: '/tmp/ok' })).toBe('/tmp/ok')
    // 负控：不在测试进程里 ⇒ 不抛（生产路径不受影响）
    expect(() => slotsHomeDir({})).not.toThrow()
  })
})
