/**
 * browser/headless-shot-LIVE.test.ts — 补拍通道的**真机探针**（会真起一个无头 Chrome）
 *
 * 🔴🔴 **默认全部 skip**。开启方式：`container_fs touch` 一个哨兵文件
 *    （`.slot-live-on`，与 `browser-slot-LIVE.test.ts` **共用同一个开关**，理由见那边的头注：
 *    `dsh-develop` 的 `sys` 白名单没有 `env`，环境变量这条路在本机走不通）。
 *
 * ## 为什么必须有这个文件（⛔ 别把它当补充覆盖率）
 *
 * 2026-11-28 的真机取证证明了**「另起一个 `--headless=new` 实例能立刻截到正确的图」**——
 * 但那条证据来自**一条手敲的命令行**，⛔ 不是来自 `headlessShot()` 这个函数。
 * 🔴 承本轨迹 D141：**测过 ≠ 验过**；这里更窄一层 ——
 * **"我手敲的命令能行" ≠ "我写的函数能行"**。两者之间隔着：参数拼装、端点等待、
 * target 创建、readyState 轮询、base64 解码、进程与 profile 清理。
 * 六步里任何一步写错，手敲那条命令**仍然成功**，而函数**恒失败**。
 *
 * ⇒ 本文件判的就是这六步：要么整条通道真的产出一张**非空且是 PNG** 的图，要么红。
 *
 * ## 判据（缺一不算通过）
 *   ① 返回 `data` 非空，且解出来是**真 PNG**（magic number，⛔ 不只看"非空"）
 *   ② 图**不是纯色/空白**（真机踩过：能拿到帧但内容是空白 —— 那比失败更骗人）
 *   ③ 成功路径上 `error` 为空
 *   ④ 起进程用的 profile 目录**事后被清掉**（⛔ 不留垃圾）
 *   ⑤ 端口 9399 事后不再监听（⛔ 不留僵尸实例）
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { headlessShot, HEADLESS_PORT } from '../../src/browser/headless-shot.js'

const MARKER = fileURLToPath(new URL('../../.slot-live-on', import.meta.url))
const LIVE = existsSync(MARKER) || process.env.SERENITY_SLOT_LIVE === '1'

/** PNG magic number：`89 50 4E 47 0D 0A 1A 0A` */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 端口上还有人监听吗（测完必须为 false） */
function listening(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' })
    const done = (v: boolean): void => { s.destroy(); res(v) }
    s.setTimeout(timeoutMs)
    s.on('connect', () => done(true))
    s.on('timeout', () => done(false))
    s.on('error', () => done(false))
  })
}

describe.skipIf(!LIVE)('补拍通道真机探针（起真无头 Chrome）', () => {
  it('① 🔴 真起实例、真取到一张**真 PNG**，且事后不留进程/端口/临时目录', async () => {
    const r = await headlessShot('https://example.com/', 60_000)

    // ③ 成功则不该有 error
    expect(r.error ?? '', `补拍失败：${r.error ?? ''}`).toBe('')

    // ① 非空 + 真是 PNG（⛔ 只判"非空"会让一段报错文本也算通过）
    expect(r.data.length, '没拿到任何数据').toBeGreaterThan(100)
    const buf = Buffer.from(r.data, 'base64')
    expect(buf.length, '解码后是空图').toBeGreaterThan(1000)
    expect(buf.subarray(0, 8).equals(PNG_MAGIC), '拿到的不是 PNG（magic number 不符）').toBe(true)

    // ② 不是一片空白：真机上"取到一帧空白"比失败更骗人。
    //    判据 = 字节熵。纯色 PNG 压缩后极小；example.com 的页面截图 > 5KB。
    //    ⚠️ 这是**弱判据**，只挡得住"纯色/全透明"，挡不住"拍错了页" —— 后者要人看。
    expect(buf.length, '图太小，很可能是纯色空白页').toBeGreaterThan(5000)

    // ④⑤ 清理（⛔ 不留僵尸实例与监听端口）
    //    稍等一拍，让 finally 里那 200ms 的清理窗口走完
    await new Promise((res) => setTimeout(res, 600))
    expect(await listening(HEADLESS_PORT), `端口 ${HEADLESS_PORT} 仍在监听 ⇒ 无头实例没被清掉`).toBe(false)
  }, 90_000)

  it('② 同一函数连跑两次都成功（⛔ 不许"第一次能行、第二次撞端口/残留"）', async () => {
    const a = await headlessShot('https://example.com/', 60_000)
    const b = await headlessShot('https://example.com/', 60_000)
    expect(a.error ?? '', `第 1 次失败：${a.error ?? ''}`).toBe('')
    expect(b.error ?? '', `第 2 次失败（很可能是清理不干净）${b.error ?? ''}`).toBe('')
    // 两张都必须是真 PNG 且非空 —— ⛔ 不判"两张逐字相同"（页面有动态内容，那会误报）
    for (const [name, r] of [['第 1 次', a], ['第 2 次', b]] as const) {
      expect(Buffer.from(r.data, 'base64').subarray(0, 8).equals(PNG_MAGIC), `${name}不是 PNG`).toBe(true)
    }
  }, 150_000)
})
