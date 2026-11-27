/**
 * headless-shot-rescue.test.ts —— 锁屏补拍通道的判据（2026-11-28）
 *
 * ## 这份判据守的是**一条会骗人的边界**，不是覆盖率
 *
 * 补拍用的是一个**全新无头实例** ⇒ 同地址、**不同会话状态**（没有登录态、滚动位置、表单输入）。
 * 若回执不写明，调用方会拿着一张"看起来对"的图去对错误的事实下结论 ——
 * 那比不拍更坏：不拍是"没有信息"，误拍是"错误信息"。
 *
 * ⇒ 这里钉两件事：
 *   ① 补拍成功的回执**必须**同时说出「RESCUED」与「不是原页面状态」；
 *   ② 原页面能拍时**绝不**补拍（⛔ 不许把正常路径也走成补拍）。
 *
 * ⚠️ 刻意**不**用假 Chrome 去模拟 CDP 协议（承 `browser-slot-cdp.test.ts` 同款理由：
 *    替身证明不了协议）。这里只钉**回执契约**与**策略分支**这两件不需要真浏览器的事。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 回执渲染（与 `tools/browser-slot/index.ts` 的 `shot` 分支同构）。
 *
 * ⚠️ 为什么在这里复制一份：工具层那段的输入是 `slotShot()` 的返回值，
 *    而真跑它需要真浏览器。把**纯渲染部分**抽出来判，才能在无浏览器时也钉住文案契约。
 *    🔴 若将来工具层改了文案而这里没改，本文件会红 —— 那是**期望**（它逼你同步），
 *       代价是两处要一起改；已在下方用例名里写明这一点。
 */
function renderShotReceipt(r: { rel: string; via: string; ms: number; rescued: boolean }): string {
  if (r.rescued) {
    return (
      `[browser_slot] shot → ${r.rel} [via headless-rescue, ${r.ms}ms]\n` +
      `⚠️ RESCUED, NOT THE ORIGINAL PAGE — the headed window could not produce a frame ` +
      `(screen locked / window occluded), so a separate headless browser opened the same URL and shot that. ` +
      `⇒ Same address, but **different session state**: no login, no scroll position, no form input, ` +
      `no in-memory SPA state. Treat anything state-dependent in this image as unverified.`
    )
  }
  const warn =
    r.via === 'default'
      ? ''
      : ` (⚠️ NON-STANDARD PATH — window was likely locked/occluded; pixels may differ from a normal capture)`
  return `[browser_slot] shot → ${r.rel} [via ${r.via}, ${r.ms}ms]${warn}`
}

describe('补拍回执契约（⛔ 不许静默冒充原页面截图）', () => {
  it('① 🔴 补拍成功 ⇒ 必须同时出现 RESCUED 与「不是原页面状态」两层意思', () => {
    const text = renderShotReceipt({ rel: '_tmp/a.png', via: 'headless-rescue', ms: 1200, rescued: true })
    // 第一层：这张图是补拍的
    expect(text).toContain('RESCUED')
    expect(text).toContain('headless-rescue')
    // 第二层：为什么它不等价 —— 这层最容易被简化掉，单独钉
    expect(text).toMatch(/NOT THE ORIGINAL PAGE/i)
    expect(text).toMatch(/different session state/i)
    // 第三层：要它给出**具体丢什么**（笼统说"可能不同"等于没说）
    for (const lost of ['no login', 'no scroll position', 'no form input']) {
      expect(text, `必须点名丢了什么：${lost}`).toContain(lost)
    }
  })

  it('② 正常路径 ⇒ ❗不得出现 RESCUED（⛔ 不许把正常拍也标成补拍）', () => {
    const text = renderShotReceipt({ rel: '_tmp/a.png', via: 'default', ms: 90, rescued: false })
    expect(text).not.toContain('RESCUED')
    expect(text).toContain('via default')
    // 标准路径不该带任何警告（否则每张图都"有嫌疑"，警告会贬值）
    expect(text).not.toContain('NON-STANDARD')
  })

  it('③ 三条变体路径（非补拍但要警告）⇒ 有警告、无 RESCUED', () => {
    const text = renderShotReceipt({ rel: '_tmp/a.png', via: 'fromSurface=false', ms: 4000, rescued: false })
    expect(text).toContain('NON-STANDARD PATH')
    expect(text).not.toContain('RESCUED')
  })
})

/**
 * 策略分支：什么时候才允许补拍。
 *
 * 🔴 这是**方向**判据：补拍是一条"更弱的证据"，只能作为最后手段。
 *    若哪天有人把顺序反过来（先补拍、失败再试原页），这里必须红。
 */
describe('补拍策略：原页面优先，补拍只能是最后手段', () => {
  type Attempt = { headed: 'ok' | 'noframe'; url: string }

  /** 与 `service.ts` 的 `slotShot()` 同构的分支（纯逻辑，不起浏览器） */
  function decide(a: Attempt): 'direct' | 'rescue' | 'rescue-impossible' {
    if (a.headed === 'ok') return 'direct'
    if (a.url === '') return 'rescue-impossible'
    return 'rescue'
  }

  it('④ 原页面能拍 ⇒ 走 direct（⛔ 绝不再补拍）', () => {
    expect(decide({ headed: 'ok', url: 'https://x/' })).toBe('direct')
  })

  it('⑤ 原页面取不到帧 ⇒ 才补拍', () => {
    expect(decide({ headed: 'noframe', url: 'https://x/' })).toBe('rescue')
  })

  it('⑥ 取不到帧**且**读不到地址 ⇒ 明确失败，⛔ 不许瞎补一张 about:blank', () => {
    expect(decide({ headed: 'noframe', url: '' })).toBe('rescue-impossible')
  })
})

/**
 * 🔴 **把"文案副本"钉回源头**（承判据 ⑮ 的同族：副本会漂，而漂了没有信号）
 *
 * 上面 `renderShotReceipt()` 是工具层那段的一份**复制品** —— 为的是能在无浏览器时判文案契约。
 * 但复制品最大的风险是「我改了真身，副本还绿着」。⇒ 这条用例直接读**工具层源码**，
 * 断言那三个承重词确实在真身里。
 *
 * ⚠️ 它判的是「真身含这些词」，⛔ 不是「真身与副本逐字相同」——
 *    逐字比对会让任何措辞微调都红（那是本仓明令禁止的"误报训练人不信闸"，`#538`）。
 */
describe('工具层真身必须与判据同源（防副本漂移）', () => {
  const SRC = readFileSync(new URL('../src/tools/browser-slot/index.ts', import.meta.url), 'utf8')

  it('⑦ 真身里确实写了 RESCUED ＋ 原页面不等价 ＋ 点名丢失的状态', () => {
    // 取出 shot 分支（从 `if (r.rescued)` 到下一个 `const warn`）
    const start = SRC.indexOf('if (r.rescued)')
    expect(start, '① 找不到 r.rescued 分支 —— 工具层结构变了，本判据的取数域失效').toBeGreaterThan(-1)
    const end = SRC.indexOf('const warn', start)
    expect(end, '② 找不到分支结尾 —— 取数域失效').toBeGreaterThan(start)
    const branch = SRC.slice(start, end)

    // 哨兵：先证明"我读到了一段真东西"（承 ⑮）
    expect(branch.length, '分支太短 ⇒ 取数域可能取空了').toBeGreaterThan(200)

    expect(branch).toContain('RESCUED')
    expect(branch).toMatch(/NOT THE ORIGINAL PAGE/i)
    expect(branch).toMatch(/different session state/i)
    for (const lost of ['no login', 'no scroll position', 'no form input']) {
      expect(branch, `真身里少了「${lost}」—— 副本与真身已漂`).toContain(lost)
    }
  })
})
