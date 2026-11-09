/**
 * voyage-theme-wiring.test.ts — 蓝图档的**接线判据**（S142，2026-11-09，v1.126.0）
 *
 * ## 守的是什么
 * owner 2026-11-09 报「浅色主题下这个动画很突兀」⇒ 定稿「深色 = 写实电影质感 ／
 * 浅色 = 工程蓝图线稿」两套完整语汇。这一改动**天然分成两半，各自单测都能绿，
 * 缺了接线就整体失效**：
 *
 * | 半 | 位置 | 单独能测吗 |
 * |---|---|---|
 * | ① 资产侧支持 `?theme=blueprint` | `assets/serenity-voyage.html` | 只能测"代码在" |
 * | ② 客户端**按主题把参数带上去** | `src/client/SafeModePanel.tsx` ＋ `voyage-theme.ts` | ⬅ 本文件主线 |
 *
 * 🔴 **失效形态全是"页面不报错、断言全绿、效果完全没有"**（本仓反复踩）：
 *   · 资产支持了、客户端从不带参数 ⇒ 浅色下永远是深色作品，**零报错**
 *   · 客户端带了参数、但判据源用了 `prefers-color-scheme` ⇒
 *     在「设置浅色 + 系统深色」这一档**判反**，且只在部分用户机器上错（D297）
 *   · 参数带了、`key` 没带 ⇒ 面板打开期间切主题，画面停在旧语汇上，
 *     与"参数没传"在观感上不可分
 * ⇒ 三条各自都要有判据，任一条缺失都会漏掉一整类。
 *
 * ⚠️ 为什么用源码形态 + 纯函数单测，而不是渲染测试：本仓 client 侧**没有 DOM 测试环境**
 *   （无 jsdom / react-dom 运行期），与 `client-popover-clip-guard.test.ts` 同一套既有办法。
 *   真实观感留给真机（D141 / D149：测过 ≠ 验过）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_DARK_ATTR, themeKeyPart, themeParamFor } from '../src/client/voyage-theme.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'src', 'client')
const tsx = readFileSync(join(clientDir, 'SafeModePanel.tsx'), 'utf-8')
const themeTs = readFileSync(join(clientDir, 'voyage-theme.ts'), 'utf-8')
const asset = readFileSync(join(root, 'assets', 'serenity-voyage.html'), 'utf-8')

/** 剥掉注释后再判"有没有用某个 API"——注释里合法地写着禁令的说明文字 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

/** 取 `<iframe …/>` 那一段源码（只在这一段里断言，避免命中面板别处） */
function iframeTag(): string {
  const m = /<iframe[\s\S]*?\/>/.exec(tsx)
  if (!m) throw new Error('iframe 不在（面板形态变了 ⇒ 这条判据必须先更新）')
  return m[0]
}

describe('蓝图档 ①：参数映射（纯函数，这才是"带什么"的唯一真相源）', () => {
  it('深色 ⇒ 不带参数（资产默认档就是深色，⛔ 不传一个"显式但无意义"的值）', () => {
    expect(themeParamFor(true)).toBe('')
  })

  it('浅色 ⇒ 带 `&theme=blueprint`（带 & 前缀，因为调用点已经有一个 ?）', () => {
    // 🔴 判据逐字钉住**这两个字面量**，包括 & 而不是 ? ——
    //    若这里返回 `?theme=blueprint`，拼出来是 `?…?theme=`，资产的正则 `[?&]theme=`
    //    **仍然命中** ⇒ 缺陷静默生效、没有报错。所以判据只能钉字面量。
    expect(themeParamFor(false)).toBe('&theme=blueprint')
  })

  it('key 分格：两态必须不同（否则"切主题重建"这件事不存在）', () => {
    expect(themeKeyPart(true)).not.toBe(themeKeyPart(false))
    expect(themeKeyPart(true)).toBe('dark')
    expect(themeKeyPart(false)).toBe('light')
  })

  it('判据源常量 = 宿主真实属性名（防拼写漂移）', () => {
    // 与 client-css-theme-gate.test.ts 的 DARK_SELECTOR 同一个名字；两处必须一起改
    expect(HOST_DARK_ATTR).toBe('data-ds-dark-theme')
  })
})

describe('蓝图档 ②：iframe 真的把参数带上去了（接线，不是能力）', () => {
  it('src 里拼的是 `themeParamFor(…)`，⛔ 不是写死的字符串', () => {
    // 回归形态 = 有人觉得"就一句"直接把 `&theme=blueprint` 写进模板 ⇒ 深色档也会带上它，
    // 夜里看变成白纸（而单测全绿，因为没人测"深色时不该带"）
    expect(iframeTag()).toMatch(/themeParamFor\(/)
  })

  it('key 里也带主题分格（否则切主题时不重建 ⇒ 画面停在旧语汇）', () => {
    expect(iframeTag()).toMatch(/themeKeyPart\(/)
  })

  it('主题值来自那个读宿主属性的 hook，⛔ 不是常量、不是 props', () => {
    expect(tsx).toMatch(/useHostDarkTheme\(\)/)
    expect(iframeTag()).toMatch(/hostDark/)
  })
})

describe('蓝图档 ③：判据源必须是宿主的**输出**，⛔ 不是输入（D297）', () => {
  it('读的是 `body[data-ds-dark-theme]` 属性（hook 在面板里，常量在 voyage-theme）', () => {
    // 常量侧：只声明属性名
    expect(themeTs).toContain(`export const HOST_DARK_ATTR = '${HOST_DARK_ATTR}'`)
    // 行为侧：hook 真的用 hasAttribute 去读它（⛔ 不是读 media query，那是 ③② 那条）
    expect(tsx).toMatch(/hasAttribute\(HOST_DARK_ATTR\)/)
    // 负控：属性名不得在面板里被写字面量（否则常量一改就漏改一处）
    expect(stripComments(tsx)).not.toContain(`'${HOST_DARK_ATTR}'`)
  })

  it('客户端代码里不得出现 prefers-color-scheme / matchMedia', () => {
    // 🔴 断言前先剥注释：注释里写「⛔ 不用 prefers-color-scheme」是**禁令的说明**，
    //    不剥会把说明文字判成违规（本族已在 client-css-theme-gate 上红过一次）。
    for (const [name, src] of [
      ['voyage-theme.ts', themeTs],
      ['SafeModePanel.tsx', tsx],
    ] as const) {
      const code = stripComments(src)
      // 负控的负控：注释必须真的被剥掉了，否则这条断言可能因为"整段被剥空"而恒绿
      expect(code.length, `${name} 剥注释后不可能是空的`).toBeGreaterThan(200)
      expect(code, `${name} 不得用宿主输入当主题判据`).not.toMatch(/prefers-color-scheme/)
      expect(code, `${name} 不得用 matchMedia 嗅探主题`).not.toMatch(/matchMedia/)
    }
  })

  it('③-control 检测器自身有判别力（正控：注释不算、真代码必须被抓）', () => {
    // 同 D253：恒绿的检测器会让「我没用」与「用了但没检测到」publish 成同一输出。
    // 两档对照：① 只在注释里出现 ⇒ 剥完必须**抓不到**（否则说明说明文字被判成违规）
    //           ② 真代码里出现 ⇒ 剥完必须**抓到**（否则说明剥多了、检测器恒绿）
    const onlyInComment = stripComments('/** ⛔ 不用 prefers-color-scheme（注释里合法） */\nconst ok = 1')
    expect(onlyInComment).not.toMatch(/prefers-color-scheme/)
    expect(onlyInComment).toMatch(/const ok = 1/)

    const inRealCode = stripComments('const x = window.matchMedia("(prefers-color-scheme: dark)").matches')
    expect(inRealCode).toMatch(/prefers-color-scheme/)
    expect(inRealCode).toMatch(/matchMedia/)
  })
})

describe('蓝图档 ④：资产侧确实支持该参数（两半互为前提，缺一整体失效）', () => {
  it('资产解析 `theme=blueprint` 并给 body 挂 class', () => {
    // 用字面量比而不是正则：`[?&]` 本身就是要匹配的源码字符
    expect(asset).toContain('var BLUEPRINT = /[?&]theme=blueprint/.test(location.search)')
    expect(asset).toContain("document.body.classList.add('blueprint')")
  })

  it('资产的页面级样式在位（纸底 + 网格 + 颗粒关闭）', () => {
    expect(asset).toContain('body.blueprint{ background:#f7fafd; }')
    expect(asset).toMatch(/body\.blueprint \.veil/)
    expect(asset).toMatch(/body\.blueprint \.grain\{ opacity:0; \}/)
  })

  it('换观感函数在位，且后期管线在该档被关掉', () => {
    expect(asset).toContain('function applyBlueprint(root)')
    // 🔴 `&& !BLUEPRINT` 是必须的：更早那句初值会被 §10 那句重新赋值覆盖，
    //    漏了它蓝图档照样跑 bloom（平涂语汇与电影感后期互斥）
    expect(asset).toMatch(/POSTFX_ENABLED = !!PostFX && !BLUEPRINT/)
    // 负控：不得退回"漏掉 !BLUEPRINT"的旧写法
    expect(asset).not.toMatch(/POSTFX_ENABLED = !!PostFX;\s*$/m)
  })

  it('读数句柄在位（真机验收要靠它取 meshes / edges / skipped）', () => {
    expect(asset).toContain('window.__blueprint = {')
  })
})
