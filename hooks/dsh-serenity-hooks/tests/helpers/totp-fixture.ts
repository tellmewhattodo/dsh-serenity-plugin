/**
 * tests/helpers/totp-fixture.ts — 网关测试共用夹具（2026-11-05，v1.119.0）
 *
 * ## 为什么需要这个文件
 *
 * v1.119.0 起**口令登录整条退役，网关只认 TOTP**（owner 令：加强安全性）。
 * 而此前 20+ 个网关用例都靠 `user=tester&password=pw` 拿会话 —— 它们全部变成 401。
 *
 * 🔴 **处置判据（D274：改钉本意，不放宽到能过）**：
 * 那些用例的**本意**不是"验证口令能登录"，而是"拿一个有效会话，再去测别的东西"
 * （cookie Secure 分支 ／ WS 反代 ／ HTML 注入 ／ workspace 白名单 …）。
 * ⇒ 正确修法 = **把"怎么拿到会话"换成 TOTP**，⛔ 不是把断言的期望值改松。
 * ⇒ 只有"口令登录本身"那几条用例该**删**（对象已不存在），并在下方注明。
 *
 * ## 为什么这不算"测试自证"
 *
 * 这里生成的是**真 TOTP 码**（与生产同一个 `totpCode` 实现），服务端用**真校验器**验。
 * 夹具只负责"喂对东西"，不替服务端做判断。
 */

import { totpCode, base32Encode, TOTP_STEP_SECONDS } from '../../src/gateway/totp.js'
import { hashPassword } from '../../src/kernel/config.js'

/** 与 RFC 6238 测试向量同源的固定 secret（base32） */
export const FIXTURE_TOTP_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

/** 当前时间片的 TOTP 码 */
export function currentTotpCode(secret: string = FIXTURE_TOTP_SECRET): string {
  return totpCode(secret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS))
}

/**
 * 一个"可登录"的账号夹具：**已绑定 TOTP**。
 *
 * 🔴 `passHash` 仍然写（用真 hash），因为数据模型要求它有值 —— 但 v1.119.0 起
 *    **它不参与认证**。写它是为了让夹具与真实配置文件形状一致，⛔ 不是"口令还能用"。
 */
export function totpAccount(user: string, id = 'a1'): {
  id: string
  user: string
  passHash: string
  totpSecret: string
} {
  return { id, user, passHash: hashPassword('pw'), totpSecret: FIXTURE_TOTP_SECRET }
}

/** 登录表单体（TOTP 版）：替代旧的 `user=X&password=Y` */
export function totpLoginBody(user: string, secret: string = FIXTURE_TOTP_SECRET): string {
  return `user=${encodeURIComponent(user)}&code=${currentTotpCode(secret)}`
}
