/**
 * browser-slot-LIVE.test.ts — 浏览器槽位**真机探针**（会真起一个 Chrome）
 *
 * 🔴🔴 **默认全部 skip**。开启方式：`SERENITY_SLOT_LIVE=1 dsh-develop test --filter browser-slot-LIVE`
 *
 * 为什么默认 skip：CI/门禁里起真浏览器会让"全绿"变成一个**环境依赖**的读数
 * （容器里没有 Chrome、或 /dev/shm 不够，都会让门禁红在一个与被测代码无关的地方）。
 * ⇒ 探针要能被**单独点名跑**，⛔ 不是混在 3424 条里。
 *
 * 判据（缺一不算通过，且每一条都对应本次事故里的一格错误）：
 *   ① 进程起来了且 CDP **稳定**（就绪后再等 2.5s —— 容器内 Chrome 常"起来了又死"）
 *   ② 认领得住：按 profile 目录找得到它，命令行带**本槽位专属** user-data-dir
 *   ③ profile 目录真被写出（独立 profile 不是空话）
 *   ④ 窗口尺寸 = 槽位固定分辨率；且**不带**"禁止后台降速"的两个 flag（耗电事故那一条）
 *   ⑤ 台账记下 sessionId/pid，状态 leased（⛔ 不是 orphaned/stale）
 *   ⑥ release 后：进程消失 ＋ 端口沉默 ＋ 台账条目消失 ＋ **profile 保留**（登录态不丢）
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireSlot, listSlots, releaseSlot, waitSlotReady } from '../src/browser/service.js'
import { findPidsByProfile, slotPaths } from '../src/browser/process.js'
import { SLOT_RESOLUTION, slotPort } from '../src/browser/state.js'
import { readLedger } from '../src/browser/ledger.js'

/**
 * 🔴 **开关 = 一个哨兵文件**（⛔ 不是环境变量）。
 *
 * 为什么换成文件：本容器的 `dsh-develop sys` 白名单里没有 `env`/`node`，
 * 而 `dsh-develop test` 又不透传环境变量 ⇒ **环境变量这条路在这台机器上走不通**。
 * 判据：一个"要手动开"的开关必须**在当前环境里真的能被打开**，
 * 否则它不是开关，是一句注释（同族：预设的回退条件必须真的会开火）。
 *
 * 开：`container_fs touch AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/.slot-live-on`
 * 关：删掉它。默认（文件不存在）⇒ 全部 skip。
 */
const MARKER = fileURLToPath(new URL('../.slot-live-on', import.meta.url))
const LIVE = existsSync(MARKER) || process.env.SERENITY_SLOT_LIVE === '1'
/**
 * CCC 根：**从本文件向上找 `.serenity` 标记**，⛔ 不写死家目录。
 *
 * 🔴 为什么不用字面量（2026-11-09，隐私门当场打红）：本仓 B 面是 **GitHub public**，
 *    而 `privacy-scan` 的 `absolute-home-path` 规则会命中任何写死的家目录路径 ——
 *    那条规则是对的，本文件当时就带着一条（D145 第三次，同一形状）。
 *    修法不是加白名单，是**让路径自己长出来**：向上找到 `.serenity` 即 CCC 根
 *    （该标记是 CCC 的既有契约，`dashboard health` 的 P1_rooted 也按它判）。
 *    ⇒ 换机器 / 换用户名 / CI 上跑，这个值都自动正确。
 */
function findCccRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.serenity'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`未找到 CCC 根：从 ${from} 向上 12 层都没有 .serenity 标记`)
}
const ROOT = process.env.SERENITY_SLOT_LIVE_ROOT ?? findCccRoot(dirname(fileURLToPath(import.meta.url)))
const SESSION = 'live-check-session'
const TRAJ = 'live-check-traj'

describe.skipIf(!LIVE)('浏览器槽位 · 真机探针（SERENITY_SLOT_LIVE=1 才跑）', () => {
  it(
    '①~⑥ acquire → 验 → release 全链',
    async () => {
      let slot = 0
      const log: string[] = []
      const say = (s: string): void => {
        log.push(s)
        console.log(s)
      }
      try {
        const acq = await acquireSlot({ root: ROOT, sessionId: SESSION, trajectory: TRAJ })
        slot = acq.slot
        say('\n=== acquire ===\n' + acq.detail)
        expect(acq.ok).toBe(true)

        // ① CDP 就绪且**稳定**
        const ready = await waitSlotReady(ROOT, slot)
        say('\n=== wait CDP ===\n' + ready.detail)
        expect(ready.ok).toBe(true)

        // ② 认领
        const paths = slotPaths(ROOT, slot)
        const pids = findPidsByProfile(paths.profile)
        say(`\n=== 认领 ===\npids=${pids.join(',')} profile=${paths.profile}`)
        expect(pids.length).toBeGreaterThan(0)

        // ③ 独立 profile
        expect(existsSync(paths.profile)).toBe(true)
        expect(readdirSync(paths.profile).length).toBeGreaterThan(0)

        // ④ 命令行逐字核对
        const cmd = readFileSync(`/proc/${pids[0]}/cmdline`, 'utf8')
        const r = SLOT_RESOLUTION(slot)
        expect(cmd).toContain(paths.profile)
        expect(cmd).toContain(`--window-size=${r.width},${r.height}`)
        expect(cmd).toContain('--no-sandbox')
        // 🔴 耗电事故那一条：绝不能带"禁止后台降速"
        expect(cmd).not.toContain('--disable-renderer-backgrounding')
        expect(cmd).not.toContain('--disable-backgrounding-occluded-windows')

        // ⑤ 台账归属 + 状态
        const lease = readLedger(ROOT).leases[String(slot)]
        expect(lease?.sessionId).toBe(SESSION)
        expect(lease?.pid ?? 0).toBeGreaterThan(0)
        const v = listSlots(ROOT).views.find((x) => x.slot === slot)!
        say(`\n=== list ===\n${v.label} state=${v.state} cpu=${v.cpuPct}% rss=${v.rssMb}M res=${v.resolution}`)
        expect(v.state).toBe('leased')

        // 第二条独立证据：端口直读
        const res = await fetch(`http://127.0.0.1:${slotPort(slot)}/json/version`)
        const body = (await res.json()) as { Browser?: string }
        say(`Browser = ${body.Browser}`)
        expect(typeof body.Browser).toBe('string')
      } finally {
        // ⑥ **无论上面成败都必须 release** —— 这正是本次事故的教训
        if (slot > 0) {
          const paths = slotPaths(ROOT, slot)
          const before = findPidsByProfile(paths.profile).length
          const rel = releaseSlot(ROOT, SESSION, slot)
          say('\n=== release ===\n' + rel.detail)
          await new Promise((x) => setTimeout(x, 1500))
          const after = findPidsByProfile(paths.profile).length
          say(`进程数 before=${before} after=${after}`)
          expect(after).toBe(0)
          expect(readLedger(ROOT).leases[String(slot)]).toBeUndefined()
          expect(existsSync(paths.profile)).toBe(true) // 登录态保留
          let dead = false
          try {
            await fetch(`http://127.0.0.1:${slotPort(slot)}/json/version`, { signal: AbortSignal.timeout(1500) })
          } catch {
            dead = true
          }
          expect(dead).toBe(true)
        }
        say('\n======== 全链通过 ========')
      }
    },
    120_000,
  )
})
