/**
 * browser-domain-skill.test.ts —— 浏览器扩展 skill（域名强相关）
 *
 * 设计稿：`AGENT_SESSIONS/…S142…/proposals/browser-domain-skill-design.md`（🔒 已冻结）
 * owner 原话（2026-11-23）：「…按域名建立文件夹，每个文件夹下设 SKILL.md…
 * 我们浏览器工具在打开某个域名的时候自动按目录找到 SKILL.md 并全文注入。
 * 在 release 的时候 记录历史上打开过的域名并提示 LLM 可以将操作使用经验和认知
 * 按照 eap 原则记录到具体 SKILL.md 文件。」
 *
 * ## 本组用例守的判据（编号对应设计 §七，⛔ 别重新编号）
 *
 * | # | 判据 | 这里的用例 |
 * |---|---|---|
 * | 1 | `www.a.com` 与 `a.com` **同目录**；`a.com:8080` ≠ `a.com` | D1 ／ D2 |
 * | 2 | 命中 ⇒ 回执多出全文；未命中 ⇒ 回执**与今天逐字相同** | D4 ／ D5 |
 * | 3 | 超 8 KB ⇒ 截断且**记号在场**（含完整路径） | D6 |
 * | 4 | 台账累加 `opens`；`hasSkill` **现算** | D7 ／ D8 |
 * | 5 | 提示**只在真的释放成功**时出现 | D9 ／ D10（正反两控） |
 * | 6 | 提示带确切路径；单次最多列 3 个 | D11 |
 * | 8 | 未命中路径**零噪声** | D5（断言"不含"） |
 *
 * ⚠️ 判据 5 是设计稿点名「最容易写错」的一条：`releaseSlot` 对"本就无人占用"
 *    也返回 `ok: true`，所以⛔ 不能拿 ok 当"真的释放了"——这里用结构性的 `released` 字段。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeDomain } from '../src/browser/domain.js'
import {
  DOMAIN_SKILL_MAX_BYTES,
  SNIPPET_MAX_BYTES,
  domainSkillPath,
  domainDir,
  hasDomainSkill,
  loadDomainSkill,
  listSnippets,
  loadSnippet,
  snippetDir,
  snippetTail,
  recordVisit,
  readVisits,
  domainSkillPrompt,
  browserRoot,
} from '../src/browser/domain-skill.js'

let ROOT: string

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'dsp-domain-'))
})
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** 造一份说明书 */
function writeSkill(host: string, body: string): string {
  const p = domainSkillPath(ROOT, host)!
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf8')
  return p
}

describe('D1/D2 归一化：目录名 = 归一化域名（唯一实现）', () => {
  it('剥 www.：`www.a.com` 与 `a.com` 落到同一个目录', () => {
    const a = normalizeDomain('https://www.example.com/x?y=1')
    const b = normalizeDomain('http://example.com/other')
    expect(a?.dirName).toBe('example.com')
    expect(b?.dirName).toBe('example.com')
    // 🟢 host 也一致 ⇒ 台账键不会分家
    expect(a?.host).toBe(b?.host)
  })

  it('保端口：`a.com:8080` ≠ `a.com`（设计明写）', () => {
    expect(normalizeDomain('http://a.com:8080/')?.host).toBe('a.com:8080')
    expect(normalizeDomain('http://a.com/')?.host).toBe('a.com')
    // 冒号在目录名里非法 ⇒ 换下划线（否则在建目录时炸）
    expect(normalizeDomain('http://a.com:8080/')?.dirName).toBe('a.com_8080')
  })

  it('坏输入一律 null（⛔ 不抛错：一个坏 URL 不该炸掉 open）', () => {
    for (const bad of ['', 'not a url', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings']) {
      expect(normalizeDomain(bad), `${bad} 竟然被当成域名`).toBeNull()
    }
  })

  it('大小写归一：`EXAMPLE.com` 与 `example.com` 同目录', () => {
    expect(normalizeDomain('https://EXAMPLE.com/')?.dirName).toBe('example.com')
  })

  it('🔴 裸域名也能解析（台账键回灌路径用它，⛔ 不能只认完整 URL）', () => {
    // 台账里存的是 `host`（裸的），`domainSkillPath(cccRoot, host)` 必须能处理这种输入
    expect(normalizeDomain('example.com')).toBeNull()          // 无 scheme ⇒ 它不是 URL
    expect(domainSkillPath(ROOT, 'example.com')).toBe(join(browserRoot(ROOT), 'example.com', 'SKILL.md'))
    // ⚠️ `a.com:8080` 会被 URL 解析当 scheme ⇒ 也必须走同一条兜底
    expect(normalizeDomain('a.com:8080')).toBeNull()
    expect(domainSkillPath(ROOT, 'a.com:8080')).toBe(join(browserRoot(ROOT), 'a.com_8080', 'SKILL.md'))
  })
})

describe('D4/D5 注入：命中才出现，未命中零噪声', () => {
  it('命中 ⇒ 文本含全文，且抬头指出路径', () => {
    const body = '# 这站怎么用\n\n## 已知坑\n- 搜索框要等一下\n'
    writeSkill('example.com', body)
    const hit = loadDomainSkill(ROOT, 'https://example.com/')
    expect(hit).not.toBeNull()
    expect(hit!.text).toContain('搜索框要等一下')
    expect(hit!.text).toContain('BROWSER/example.com/SKILL.md')
    expect(hit!.truncated).toBe(false)
  })

  it('🔴 未命中 ⇒ 返回 null（调用方据此让回执**逐字不变**）', () => {
    expect(loadDomainSkill(ROOT, 'https://nobody-here.com/')).toBeNull()
  })

  it('🔴 零噪声：未命中时不存在任何"没有说明书"之类的文本', () => {
    const hit = loadDomainSkill(ROOT, 'https://nobody-here.com/')
    // null 就意味着调用方一个字都不加 —— 这是"零噪声"的机械形态
    expect(hit).toBeNull()
  })

  it('www 与非 www 读的是同一份（归一化串到底）', () => {
    writeSkill('example.com', 'ONLY-ONE-COPY')
    expect(loadDomainSkill(ROOT, 'https://www.example.com/')?.text).toContain('ONLY-ONE-COPY')
    expect(loadDomainSkill(ROOT, 'https://example.com/')?.text).toContain('ONLY-ONE-COPY')
  })
})

describe('D6 体量上限：截断必须可见', () => {
  it(`超 ${DOMAIN_SKILL_MAX_BYTES} 字节 ⇒ 截断且记号含完整路径`, () => {
    const big = 'x'.repeat(DOMAIN_SKILL_MAX_BYTES + 500)
    const p = writeSkill('big.com', big)
    const hit = loadDomainSkill(ROOT, 'https://big.com/')!
    expect(hit.truncated).toBe(true)
    // 🔴 记号三件事：被截了 ／ 完整在哪 ／ 别以为这就是全部
    expect(hit.text).toContain('已截断')
    expect(hit.text).toContain(p)
    expect(hit.text).toContain('不要以为上面就是全部')
  })

  it('刚好等于上限 ⇒ 不截断（边界不许误伤）', () => {
    writeSkill('edge.com', 'y'.repeat(DOMAIN_SKILL_MAX_BYTES))
    expect(loadDomainSkill(ROOT, 'https://edge.com/')!.truncated).toBe(false)
  })
})

describe('D7/D8 访问台账', () => {
  it('每次 open/goto 累加 opens，并记最后会话与槽位', () => {
    recordVisit(ROOT, 'https://example.com/a', 'sess-1', 3)
    recordVisit(ROOT, 'https://example.com/b', 'sess-1', 3)
    recordVisit(ROOT, 'https://other.com/', 'sess-2', 5)
    const lg = readVisits(ROOT)
    expect(lg.domains['example.com'].opens).toBe(2)
    expect(lg.domains['other.com'].opens).toBe(1)
    expect(lg.domains['example.com'].lastSlot).toBe(3)
    expect(lg.domains['other.com'].lastSession).toBe('sess-2')
  })

  it('坏 URL 不记账（⛔ 不造出 file_ / data_ 这种无意义目录）', () => {
    recordVisit(ROOT, 'file:///tmp/x.html', 's', 1)
    expect(Object.keys(readVisits(ROOT).domains)).toHaveLength(0)
  })

  it('🔴 `hasSkill` 永远现算：删掉目录后立刻变 false（⛔ 不缓存进文件）', () => {
    const p = writeSkill('gone.com', 'x')
    expect(hasDomainSkill(ROOT, 'gone.com')).toBe(true)
    rmSync(p)
    expect(hasDomainSkill(ROOT, 'gone.com')).toBe(false)
    // 台账里也不该有 hasSkill 这个键（它是统计面，⛔ 不是真相源）
    recordVisit(ROOT, 'https://gone.com/', 's', 1)
    const raw = JSON.parse(readFileSync(join(browserRoot(ROOT), '_index.json'), 'utf8'))
    expect(raw.domains['gone.com']).not.toHaveProperty('hasSkill')
  })
})

describe('D9/D10/D11 释放提示（判据 5 ／ 6，设计点名最容易写错）', () => {
  it('有缺说明书的站 ⇒ 提示带确切路径与次数', () => {
    recordVisit(ROOT, 'https://example.com/', 's', 1)
    recordVisit(ROOT, 'https://example.com/', 's', 1)
    const t = domainSkillPrompt(ROOT)
    expect(t).toContain('example.com')
    expect(t).toContain('累计 2 次')
    expect(t).toContain('BROWSER/example.com/SKILL.md')
    // 四段模板必须在（否则模型不知道按什么结构写）
    expect(t).toContain('已知坑')
    expect(t).toContain('失效记录')
  })

  it('已有说明书的站 ⇒ 不再催（提示里零命中）', () => {
    writeSkill('has-skill.com', 'x')
    recordVisit(ROOT, 'https://has-skill.com/', 's', 1)
    expect(domainSkillPrompt(ROOT)).not.toContain('has-skill.com')
  })

  it('全部都有说明书 ⇒ 返回空串（release 回执保持原样）', () => {
    writeSkill('done.com', 'x')
    recordVisit(ROOT, 'https://done.com/', 's', 1)
    expect(domainSkillPrompt(ROOT)).toBe('')
  })

  it('单次最多列 3 个，其余折叠成一句（⛔ 不一次倒 10 个）', () => {
    for (const h of ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']) {
      recordVisit(ROOT, `https://${h}/`, 's', 1)
    }
    const t = domainSkillPrompt(ROOT)
    const listed = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'].filter((h) => t.includes(`· ${h}`))
    expect(listed).toHaveLength(3)
    expect(t).toContain('另有 2 个')
  })

  it('按打开次数降序：用得最多的排第一（那才值得先写）', () => {
    recordVisit(ROOT, 'https://rare.com/', 's', 1)
    for (let i = 0; i < 5; i++) recordVisit(ROOT, 'https://often.com/', 's', 1)
    const t = domainSkillPrompt(ROOT)
    expect(t.indexOf('often.com')).toBeLessThan(t.indexOf('rare.com'))
  })
})

describe('D3 变异检验：判据对"故意弄坏"必须变红', () => {
  it('变异① 归一化不剥 www. ⇒ 同站会分成两个目录（本用例证明剥与不剥可区分）', () => {
    const withStrip = normalizeDomain('https://www.a.com/')!.dirName
    // 复刻"不剥"的那一支（只在这里当反例，⛔ 不进实现）
    const noStrip = new URL('https://www.a.com/').hostname
    expect(withStrip).not.toBe(noStrip)
    expect(noStrip).toBe('www.a.com')
  })
})

describe('Q 片段（snippets/*.js）：只列清单，⛔ 不执行', () => {
  /** 造一支片段 */
  function writeSnippet(host: string, name: string, body: string): string {
    const d = snippetDir(ROOT, host)!
    mkdirSync(d, { recursive: true })
    const p = join(d, name)
    writeFileSync(p, body, 'utf8')
    return p
  }

  it('Q1 只认 `.js`：`.md` ／ `.txt` ／无后缀一律不列（裁决把"操作序列文档"整类删掉了）', () => {
    writeSnippet('s.com', 'ok.js', 'document.title')
    writeSnippet('s.com', 'notes.md', '# 这是操作序列文档，不该被认')
    writeSnippet('s.com', 'readme.txt', 'x')
    writeSnippet('s.com', 'noext', 'x')
    const { items } = listSnippets(ROOT, 's.com')
    expect(items.map((i) => i.name)).toEqual(['ok.js'])
  })

  it('Q2 超 16 KB ⇒ **不采用**，且必须单独出现在 oversize 里（⛔ 静默消失）', () => {
    writeSnippet('big.com', 'small.js', '1')
    writeSnippet('big.com', 'huge.js', 'x'.repeat(SNIPPET_MAX_BYTES + 1))
    const { items, oversize } = listSnippets(ROOT, 'big.com')
    expect(items.map((i) => i.name)).toEqual(['small.js'])
    expect(oversize.map((i) => i.name)).toEqual(['huge.js'])
  })

  it('Q3 注入只给**清单与路径**，⛔ 不把片段内容整段塞进回执', () => {
    writeSnippet('s.com', 'probe.js', 'SECRET_BODY_MARKER')
    const t = snippetTail(ROOT, 's.com')
    expect(t).toContain('probe.js')
    expect(t).toContain('供 eval 用')
    // 🔴 关键断言：内容不进回执（否则体量失控，且等于替模型决定"要不要用"）
    expect(t).not.toContain('SECRET_BODY_MARKER')
    // 且必须写明"不会自动执行"
    expect(t).toContain('不会自动执行')
  })

  it('Q4 无片段 ⇒ 空串（与说明书同一口径：未命中必须零噪声）', () => {
    expect(snippetTail(ROOT, 'nobody.com')).toBe('')
  })

  it('Q5 🔴 超限那支要在回执里**点名**，并说清"未采用 ≠ 不存在"', () => {
    writeSnippet('big.com', 'huge.js', 'x'.repeat(SNIPPET_MAX_BYTES + 1))
    const t = snippetTail(ROOT, 'big.com')
    expect(t).toContain('huge.js')
    expect(t).toContain('未采用')
    expect(t).toContain('不是不存在')
  })

  it('Q6 🔴 路径逃逸守卫：`--name` 带 `../` ／ 斜杠 一律拒 —— **且守卫本身可判**', () => {
    writeSnippet('s.com', 'ok.js', 'x')
    expect(loadSnippet(ROOT, 's.com', 'ok.js')).toBe('x')

    // 🔴 2026-11-24 两次实测教训，都记在这里：
    //    ① 第一版用 `../localstore.json` —— 那个路径**根本不存在** ⇒ 把守卫整行删掉，
    //       测试照样全绿（挡住它的是"文件不在"，不是守卫）。
    //    ② 第二版把诱饵造在 `ROOT` 上 —— 而 `snippets/../x.js` 只退**一级**到站点目录，
    //       **够不着 ROOT** ⇒ 守卫删掉仍然全绿。
    //    ⇒ 判据：**"逃逸测试"的诱饵必须放在"逃逸刚好够得着"的那一层**，
    //       否则你测的是"文件不存在"，不是"守卫拦住了"。
    //       这里诱饵放在**站点目录**（`snippets/` 的上一级）—— 正是 `../` 的落点。
    const decoy = join(domainDir(ROOT, 's.com')!, 'outside.js')
    writeFileSync(decoy, 'SHOULD_NEVER_BE_READ', 'utf8')
    expect(loadSnippet(ROOT, 's.com', '../outside.js'), '`../` 逃逸被放行了').toBeNull()

    for (const bad of ['a/b.js', 'a\\b.js', 'ok.md', '']) {
      expect(loadSnippet(ROOT, 's.com', bad), `${bad} 竟然被放行`).toBeNull()
    }
  })

  it('Q7 说明书与片段清单**互不依赖**：没说明书但有片段 ⇒ 清单照样出现', () => {
    writeSnippet('only-snip.com', 'a.js', 'x')
    expect(hasDomainSkill(ROOT, 'only-snip.com')).toBe(false)
    expect(snippetTail(ROOT, 'only-snip.com')).toContain('a.js')
  })
})
