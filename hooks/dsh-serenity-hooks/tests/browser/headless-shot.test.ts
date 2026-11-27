/**
 * browser/headless-shot.test.ts — 补拍通道的**拒绝面**（2026-11-28）
 *
 * ## 本文件存在的原因（先记清楚，别把它当凑覆盖率的）
 *
 * `src↔tests` 镜像门禁（P2-2）要求每个 `src/` 业务模块有测试引用。`headless-shot.ts`
 * 诞生时只有 `headless-shot-rescue.test.ts` 钉**回执契约**与**策略方向**，
 * 而那个文件**不 import 本模块**（它复制渲染逻辑、读源码断言）⇒ 镜像门禁红。
 * ⇒ 本文件补的是**被漏掉的那一面**：本模块自己的两道前置拒绝。
 *
 * ## 判什么、⛔ 不判什么
 *
 * 判（纯逻辑，无浏览器也能判）：
 *   ① 找不到 Chrome ⇒ 拒绝，且**拒的是 Chrome**（不是"地址为空"）
 *   ② 地址是空 / `about:blank` ⇒ 拒绝，且报错里**带原始值**
 *   ③ 两道都过 ⇒ 放行并交回 chrome 路径
 *   ④ `headlessShot()` 在拒绝路径上**永不抛**，只返回 `{data:'', error}`（契约：调用方只判 `data===''`）
 *   ⑤ 补拍端口**不在槽位端口区间内**（撞上真槽位 = 抢别人的浏览器）
 *
 * ⛔ 不判：真起 Chrome、真连 CDP、真截到图。
 *    那需要真浏览器，且**替身证明不了协议**（承 `browser-slot-cdp.test.ts` 头注、判据 D141）。
 *    真机那一层由 owner 侧锁屏实测覆盖（2026-11-28，见 `headless-shot.ts` 文件头注）。
 */
import { describe, expect, it } from 'vitest'
import { headlessShot, shotPreflight, HEADLESS_PORT } from '../../src/browser/headless-shot.js'
import { BASE_PORT } from '../../src/browser/state.js'

describe('补拍前置拒绝：找不到 Chrome', () => {
  it('① 🔴 Chrome 缺失 ⇒ 拒绝，且原因说的是 Chrome（⛔ 不说成"地址为空"）', () => {
    const r = shotPreflight(null, 'https://example.com/')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.data).toBe('')
    expect(r.error).toContain('Chrome')
    // 负控：这句里不该出现地址相关的措辞（否则两个因在文案上分不开）
    expect(r.error).not.toContain('地址')
  })

  it('② 🔴 次序承重：Chrome 缺失**且**地址也为空 ⇒ 仍报 Chrome', () => {
    // 这条是"读数器坏了 vs 被测对象坏了"的同族：
    // 没装浏览器的机器上，若先判地址，会把"没有浏览器"读成"调用方传错了 url" ⇒ 修错方向。
    const r = shotPreflight(null, '')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error).toContain('Chrome')
  })
})

describe('补拍前置拒绝：地址不可用', () => {
  it('③ 空串 ⇒ 拒绝，且报错里带「空」这个说明（⛔ 不许只给一个不指明处）', () => {
    const r = shotPreflight('/usr/bin/google-chrome', '')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.data).toBe('')
    expect(r.error).toContain('空')
  })

  it('④ `about:blank` ⇒ 拒绝，且报错**逐字带上原始值**（否则收到的人不知道该改哪个入参）', () => {
    const r = shotPreflight('/usr/bin/google-chrome', 'about:blank')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error).toContain('about:blank')
  })

  it('⑤ 正常的 http(s) 地址 ⇒ 放行，并**原样交回** chrome 路径', () => {
    for (const url of ['https://example.com/', 'http://127.0.0.1:3080/x']) {
      const r = shotPreflight('/opt/google/chrome/chrome', url)
      expect(r.ok, `${url} 应被放行`).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.chrome).toBe('/opt/google/chrome/chrome')
    }
  })
})

describe('headlessShot 的对外契约：拒绝时不抛，只返回空 data', () => {
  it('⑥ 🔴 拒绝路径返回 `{data:"", error}` 且**永不抛**（调用方只判 data）', async () => {
    // 直接调真身。`about:blank` 在**前置**就被拒 ⇒ 不起进程、不建 profile。
    const r = await headlessShot('about:blank')
    expect(r.data).toBe('')
    expect(typeof r.error).toBe('string')
    // 哨兵（判据 ⑮）：别让"两个字段都空"也算绿
    expect((r.error ?? '').length).toBeGreaterThan(10)
  })

  it('⑦ 空串地址同样走拒绝路径（⛔ 不许退化成"去开一个空白页"）', async () => {
    const r = await headlessShot('')
    expect(r.data).toBe('')
    expect((r.error ?? '').length).toBeGreaterThan(10)
  })
})

describe('补拍端口不得落在槽位端口区间（否则抢别人的浏览器）', () => {
  it('⑧ 🔴 补拍端口不在任何槽位端口上（槽位 = BASE_PORT 起的 20 个）', () => {
    // 20 个槽位是台账硬上限（`home.ts`／`ledger.ts` 都写死 20）。
    const SLOT_PORTS = Array.from({ length: 20 }, (_, i) => BASE_PORT + i)
    // 哨兵（判据 ⑮）：区间必须先"真的是那段"，否则下面的 not.toContain 在空区间上恒绿
    expect(SLOT_PORTS.length, '槽位端口区间取空了 ⇒ 本断言会假绿').toBe(20)
    expect(SLOT_PORTS[0]).toBe(9301)
    expect(SLOT_PORTS.includes(HEADLESS_PORT), `补拍端口 ${HEADLESS_PORT} 落在槽位区间内 ⇒ 会抢真槽位的浏览器`).toBe(
      false,
    )
    // 正控：区间**确实**能命中一个槽位端口（证明上面那条不是"什么都不包含")
    expect(SLOT_PORTS.includes(9301)).toBe(true)
  })
})
