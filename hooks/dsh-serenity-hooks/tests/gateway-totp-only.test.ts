/**
 * gateway-totp-only.test.ts — 🔴 v1.119.0 **口令登录退役**的机械判据（2026-11-05 owner 令）
 *
 * owner 原话：「砍掉账号密码登录，只允许 authenticator 登录 ⋯ 原因是加强安全性」。
 *
 * ## 为什么这条判据要单独一件
 *
 * 它是**反向钉**：钉住"某个东西**不在**"。这类判据最容易变成恒真（D258：删掉生产者后
 * 「不含某已删东西」的断言全部退化为恒真）⇒ 必须**同时**证明靶子在场时才报红。
 *
 * ## 判据强度（如实标注，不要读过头）
 *
 * 本件是**源码级**判据（扫 server.ts 的文本），不是运行态判据。
 * 运行态那半边在 `gateway.test.ts` 的「登录面集成 ④」：
 * **口令字段即使正确也必须 401** —— 那一条才是真正跑过 HTTP 的。
 * ⇒ 两条合起来才完整：本件防"有人把代码加回去"，那条防"加回去了会放行"。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 🔴 用**文件相对**路径，⛔ 不用 process.cwd()：`test` 与 `coverage` 的 cwd 不同
//    （一个是仓根、一个是包目录）⇒ 用 cwd 的版本只在其中一种下成立，另一种 ENOENT。
const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', 'src', 'gateway')
const SERVER = join(SRC, 'server.ts')

/**
 * 剥掉注释，只留**代码**。
 *
 * 🔴 为什么必须剥（本件第一版就栽在这）：判据钉的是"`passOk` 不参与判定"，
 * 而我在源码里写了「⛔ 不要恢复 `passOk`」这类**说明性注释** —— 那是**记录**，
 * 不是代码。不剥注释 ⇒ 判据变红在"我写了注释"上，与意图相反（D275：钉赋值/调用式，⛔ 不钉名字）。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 `http://` 这类）
}

describe('v1.119.0: 网关只允许 TOTP 登录（口令退役）', () => {
  it('server.ts 的**代码**里不存在 `passOk` 这个判定标识符（口令参与判定的唯一形态）', () => {
    const code = codeOnly(readFileSync(SERVER, 'utf-8'))
    expect(code).not.toMatch(/\bpassOk\b/)
  })

  it('🔴 判别力自证：把 `passOk` 加回**代码**一行 ⇒ 上一条必须能抓到（否则是恒真判据）', () => {
    const code = codeOnly(readFileSync(SERVER, 'utf-8'))
    const mutated = `${code}\nconst passOk = true\n`
    expect(mutated).toMatch(/\bpassOk\b/)
  })

  it('登录页不再有密码输入框（界面层也要一致，不能只砍后端）', () => {
    const auth = readFileSync(join(SRC, 'auth.ts'), 'utf-8')
    expect(auth).not.toContain('type="password"')
    // 正控：验证码输入框必须在（证明这段 HTML 确实存在，而不是整页没渲染）
    expect(auth).toContain('name="code"')
    expect(auth).toContain('Authenticator 验证码')
  })
})
