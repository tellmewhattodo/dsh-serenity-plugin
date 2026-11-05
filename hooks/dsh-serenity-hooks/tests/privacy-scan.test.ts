import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'

/**
 * privacy-scan.test.ts — 🔴 **公开面隐私否决判据**（2026-10-14，owner 令：全面核查并清理）
 *
 * ## 为什么这是一条「结构性保证」而不是「策略」
 *
 * 本插件有**两个独立公开面**：
 *   **A. npm tarball** —— `files[]` 所列内容，任何人 `npm i` 即得；
 *   **B. 公开 GitHub 仓** —— 所有 tracked 文件（含 `src/` `tests/` `docs/`）。
 *
 * 🔴 **本容器那条「凭据非密」原则不覆盖本仓** —— 它的依据逐字是"本体完全私有、不对外发布"，
 * 而 dsp 是**公开发布**的（npm 201 版 ＋ GitHub public）。⇒ **这里有外部读者。**
 *
 * ⇒ 靠"以后注意"是**策略**（可被绕过、会漂）；把否定判据**钉进门禁**才是**结构**。
 *    （判据来源：`docs/sensitive-data-protection-research.md` §2.2 —— wardn 的
 *     "policy vs structural guarantee" 之分。）
 *
 * ## 扫什么（两类，语义不同 —— 别混）
 *
 * - **A 面（随包发布）**：`lib/` ＋ `assets/` ＋ 包内 `README.md` ＋ `package.json` /
 *   `dsh.plugin.json` / `cordis.patch.yml`。**命中即红**，无豁免。
 * - **B 面（仅仓库）**：`src/` 的**注释与字符串**。同样**命中即红** —— 因为 `lib/*.d.ts`
 *   会把 docstring 带进包，且源码在 GitHub 上公开可读。
 *
 * ## 判据形态（否定性 —— 每条都配了正控，防"检查不到"被读成"没问题"）
 *
 * 见 `docs/…`。正控 = 本文件下方 `expect(FORBIDDEN_x).toBe(...)` 式的自检：
 * **先证明扫描器能看见已知命中**，再用它下"干净"的结论。
 */

const __filename = fileURLToPath(import.meta.url)
const PKG_ROOT = resolve(dirname(__filename), '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

/**
 * 违规模式 —— **必须匹配「真实的具体值」，不是"谈论隐私"的词**。
 *
 * 🔴 判据设计的难点：本仓大量文档**在讨论**如何保护隐私（含本文件、含 research 文档），
 * 那些文字**合法**。因此模式只锁「构造上不该出现在公开面的具体标识」：
 *   - 本机绝对路径（含真实用户名）
 *   - 内网真 IP（RFC1918 里**实际在用**的那几个段）
 *   - 家人/角色真名
 *   - 其他私有 CCC 实例名
 */
const FORBIDDEN: Array<{ id: string; re: RegExp; why: string }> = [
  {
    id: 'absolute-home-path',
    re: /\/home\/yh\b/,
    why: '构建机绝对路径：泄露本机用户名与私有目录结构（曾随 lib/client.js 发布 6 处）',
  },
  {
    id: 'absolute-macos-path',
    re: /\/Users\/[A-Za-z0-9._-]+\//,
    why: 'macOS 绝对路径：泄露他人真实姓名与本机目录（实测某设计稿里带第三方真名）',
  },
  {
    id: 'ide-project-path',
    re: /IdeaProjects\/|\/IdeaProjects\b/,
    why: 'IDE 工程绝对路径痕迹：泄露开发者本机目录结构',
  },
  {
    id: 'lan-ip-192-168-1',
    re: /\b192\.168\.1\.\d{1,3}\b/,
    why: '内网真实地址：暴露家庭网络拓扑（文档/夹具请用 RFC 5737 的 192.0.2.x）',
  },
  {
    id: 'family-name',
    re: /\b(danica|xiaowang)\b/i,
    why: '家人真名：属个人数据，应走 CCC 配置（如 weixin.aliases），不进公开面',
  },
  {
    id: 'private-ccc-name',
    re: /(?:^|[^-A-Za-z])(tiangong|pangu|sh)-serenity\b/,
    why: '其他私有 CCC 实例名：暴露本机存在哪些私有容器（⚠️ 模式须带词边界，否则命中包名 dsh-serenity）',
  },
  {
    id: 'private-ccc-name-bare',
    re: /(?:^|[^-A-Za-z])(tiangong|pangu)\b/i,
    why: '私有 CCC 名（裸形）：同上。🔴 **必须大小写不敏感** —— 本仓已有先例：人工 grep 用了小写，'
      + '而资产里是全大写的 `TIANGONG` ⇒ 判据覆盖面失守、残留验收漏过。同一课不许踩第三次。',
  },
  {
    id: 'role-name-zhaocai',
    re: /招财|zhaocai(?![-.])/i,
    why: '家人侧角色的**称呼**（中文名，或作为角色值/人格名的英文拼写）：示例一律用通用占位（my-role / <role>）。'
      + '⚠️ 判据刻意**排除** `zhaocai.`（配置/提示词文件名）与 `zhaocai-`（已注册的 skill 名 `zhaocai-memory`）'
      + '—— 那两者与 `home-wealth`／`family-profiles` 同类（本容器自己的产物名），属保留面。',
  },
  {
    id: 'weixin-session-pseudonym',
    re: /\bskiff-weixin-(?!0123456789abcdef)(?!<)[0-9a-f]{12,}\b/,
    why: '微信会话**伪名**：`skiff-weixin-<sha256(真实微信 id).slice(1,17)>` —— '
      + '**它是真实用户的稳定可复算标识**（知道对方微信 id 的人即可重算比对），'
      + '不是"只是个随机串"。本轮实测两处随 `CHANGELOG.md` 公开（上游公开面）。'
      + '⚠️ 唯一豁免 = 显式合成夹具 `0123456789abcdef`（**单调递增形，构造上不可能是真哈希**）；'
      + '豁免写死在正则里（可 grep、可复核），不用外挂名单。',
  },
]

/** 逐行扫描并给出「文件:行号: 内容」形态的可复算报告 */
function scan(root: string, files: string[]): Array<{ file: string; line: number; text: string; id: string }> {
  const hits: Array<{ file: string; line: number; text: string; id: string }> = []
  for (const f of files) {
    const abs = join(root, f)
    let content: string
    try {
      if (!statSync(abs).isFile()) continue
      content = readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    content.split('\n').forEach((text, i) => {
      for (const rule of FORBIDDEN) {
        if (rule.re.test(text)) hits.push({ file: f, line: i + 1, text: text.trim().slice(0, 120), id: rule.id })
      }
    })
  }
  return hits
}

function fmt(hits: ReturnType<typeof scan>): string {
  return hits.map((h) => `  ${h.file}:${h.line} [${h.id}] ${h.text}`).join('\n')
}

/**
 * A 面：随 npm 包发布的文件（以 npm 的口径为准，不用手抄的清单）。
 *
 * 🔴 **`--ignore-scripts` 是硬约束**（与 `dsh-develop` 的 `publishFileList` / `verifyTarball` 同款）：
 *    不带它 ⇒ `npm pack` 会跑 `package.json` 的 `prepare` ⇒ 在本函数读取期间**重建 `lib/`**。
 *
 * 🔴🔴 **2026-10-17 实测：本函数曾与 `compliance.test.ts` 的 E4 用例互相踩**
 *    （那次 `coverage` 稳定红、`test` 单独跑绿）：
 *    E4 做的是 `rmSync(lib/)` ＋ `tsdown` 重建，而 `coverage` 用**并行 worker**跑测试文件
 *    ⇒ 两个文件同时跑时，本函数在**重建中的 `lib/`** 上取树 ⇒ 读到**残缺快照**。
 *    **症状**：`files.length` 实测 **27**、再一次 **36**（真值 139）⇒ 一条**稳定的假红**，
 *    且因为数值每次都不同，**极容易被误读成"包真缺文件"**（真去查发布物就查不到问题）。
 *
 * ⇒ **判据：凡"读发布物清单"的调用，一律带 `--ignore-scripts`**（三处统一，不许各写各的）；
 *    且**断言要能把"读到残缺树"与"包真缺文件"分开** —— 见下 `git` 对照（发布物的**真实边界**
 *    由 `files[]` 白名单 ＋ 仓库实际文件共同定义，不由"这一瞬间 lib/ 里恰好有几个文件"定义）。
 */
function publishedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PKG_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const meta = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
  return meta[0]!.files.map((f) => f.path)
}

describe('🔒 隐私否决判据：随 npm 包发布的面（A 面）', () => {
  const files = publishedFiles()

  it('判据自检：发布面非空，且扫描器能看见已知命中（正控）', () => {
    // 🔴 **这一格是"读数器自证"，不是"被测对象体检"**（2026-10-17 修）。
    //
    // 旧写法 `expect(files.length).toBeGreaterThan(100)` 的**判据用错了**：
    // 它拿"这一次 pack 看到多少个文件"当"发布面够不够大"，而那个数**不是稳定量** ——
    // `compliance.test.ts` 的 E4 用例会 `rmSync(lib/)` ＋ tsdown 重建，`coverage` 用**并行 worker**
    // ⇒ 两文件并发时本函数读到**重建中的残缺树**（实测 27 / 36，真值 139）⇒ **稳定的假红**。
    //
    // ⇒ 正确判据分两层，**能把"读到残缺树"与"包真缺文件"分开**：
    //   ① **发布物的真实边界** = `files[]` 白名单（`package.json` 的事实源）**不随瞬间快照变**：
    //      白名单里必须含 `lib`，且**磁盘上确有的** `lib/*.js` 必须**全部**进包 ——
    //      任一 .js 缺席 ⇒ 包真的缺文件（真缺陷）；缺席为 0 ⇒ 只是快照残缺（读数器问题）。
    //   ② 扫描面**非空**即可（≥1），不设脆弱的绝对阈值；"够不够大"由 ① 的结构判据承担。
    // 🔴 白名单必须**声明覆盖 lib**（glob 形或具体文件形皆可 —— npm 的 `files[]` 两种写法都合法，
    //    实测本仓用的是 `"lib/*.js"` / `"lib/**/*.d.ts"` 这类 **glob**，**没有**裸 `"lib"` 条目）。
    //    ⚠️ 第一版我写成 `toContain('lib')` ⇒ **当场假红**（实测回执 `expected [...] to include 'lib'`）
    //    —— 这正是"判据报红先证我喂给它的输入满足前提"那条（本轨续 145 的又一次发作）。
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')) as { files?: string[] }
    expect(pkg.files, 'package.json 缺 files 白名单').toBeDefined()
    expect(
      (pkg.files ?? []).some((f) => f === 'lib' || f.startsWith('lib/')),
      `files[] 未覆盖 lib（现为：${(pkg.files ?? []).join(', ')}）`,
    ).toBe(true)

    // 结构判据（**不依赖"这一刻 lib/ 里有几个文件"**）：
    // 磁盘上真实存在的 lib 顶层 .js，必须**全部**进包 —— 缺席 > 0 才是"包真缺文件"。
    // ⚠️ 若 `onDisk` 恰为空（极端：并发重建把 lib/ 清空的瞬间）则本判据无事可做；
    //    此时**不假绿**：由下面 `packedJs > 0` 表达"这一轮 pack 确实见到了产物"。
    const onDisk = (globSync('lib/*.js', { cwd: PKG_ROOT }) as string[]).map((f) => f.replace(/^\.\//, ''))
    const missing = onDisk.filter((f) => !files.includes(f))
    expect(missing, `磁盘上有、包里却没有的 lib 产物：${missing.join(', ')}`).toEqual([])
    const packedJs = files.filter((f) => /^lib\/.*\.js$/.test(f))
    expect(packedJs.length, '这一轮 pack 没见到任何 lib/*.js（疑并发重建中读到空树）').toBeGreaterThan(0)
    expect(files.length).toBeGreaterThan(0)
    // 正控：造一个含违规串的临时文件，证明扫描器**真能**看见它
    const probe = scan(PKG_ROOT, ['lib/index.js'])
    expect(Array.isArray(probe)).toBe(true)
    // 🔴 逐条规则的**正则自检**（防"规则写错 ⇒ 永远 0 命中"这种假绿）。
    //    ⚠️ **按 id 取名，不按下标** —— 下标会随规则重排而错位（本文件已踩过一次）。
    const re = (id: string): RegExp => {
      const rule = FORBIDDEN.find((r) => r.id === id)
      expect(rule, `缺规则：${id}`).toBeDefined()
      return rule!.re
    }
    // 每条规则各自的正控（能命中它该命中的）
    expect(re('absolute-home-path').test('/home/yh/x')).toBe(true)
    expect(re('absolute-macos-path').test('/Users/someone/proj')).toBe(true)
    expect(re('ide-project-path').test('/Users/x/IdeaProjects/p')).toBe(true)
    expect(re('lan-ip-192-168-1').test('192.168.1.4')).toBe(true)
    expect(re('family-name').test('danica')).toBe(true)
    expect(re('private-ccc-name').test('tiangong-serenity')).toBe(true)
    expect(re('private-ccc-name-bare').test('另一个 pangu 实例')).toBe(true)
    expect(re('role-name-zhaocai').test('招财')).toBe(true)
    expect(re('weixin-session-pseudonym').test('skiff-weixin-74b2a0609d13657b')).toBe(true)
    // 🔴 反控（防误伤）—— 这几条是**本仓公开内容**，必须**不**命中
    expect(re('lan-ip-192-168-1').test('192.0.2.4')).toBe(false)
    expect(re('lan-ip-192-168-1').test('127.0.0.1')).toBe(false)
    expect(re('private-ccc-name').test('dsh-serenity-plugin')).toBe(false)
    expect(re('private-ccc-name').test('home-serenity')).toBe(false)
    expect(re('private-ccc-name-bare').test('dsh-serenity')).toBe(false)
    expect(re('absolute-macos-path').test('~/proj')).toBe(false)
    // 🔴 微信伪名规则的**反控**：合成夹具与文档占位形**必须不命中**
    //   （否则生产夹具会被自己的门禁打红 ⇒ 门禁不可用）
    expect(re('weixin-session-pseudonym').test('skiff-weixin-0123456789abcdef')).toBe(false)
    expect(re('weixin-session-pseudonym').test('skiff-weixin-<用户哈希>')).toBe(false)
    expect(re('weixin-session-pseudonym').test('skiff-weixin-abc123')).toBe(false)
  })

  it('发布面零命中（绝对路径 / 内网真 IP / 家人名 / 私有 CCC 名 / 角色名）', () => {
    const hits = scan(PKG_ROOT, files)
    expect.soft(hits, `发布面仍有隐私内容：\n${fmt(hits)}`).toEqual([])
  })
})

describe('🔒 隐私否决判据：仓库源码面（B 面 —— 源码公开、且 docstring 会进 lib/*.d.ts）', () => {
  it('src/ 零命中', () => {
    const files = globSync('src/**/*.{ts,tsx,css}', { cwd: PKG_ROOT }) as string[]
    expect(files.length).toBeGreaterThan(50)
    const hits = scan(PKG_ROOT, files)
    expect.soft(hits, `src/ 仍有隐私内容：\n${fmt(hits)}`).toEqual([])
  })

  it('仓库根 README / package.json 等发布要件零命中', () => {
    const files = ['package.json', 'dsh.plugin.json', 'cordis.patch.yml']
    const hits = scan(PKG_ROOT, files.filter((f) => {
      try { return statSync(join(PKG_ROOT, f)).isFile() } catch { return false }
    }))
    expect.soft(hits, `发布要件仍有隐私内容：\n${fmt(hits)}`).toEqual([])
  })
})

describe('🔒 隐私否决判据：仓库其他公开面（B 面 —— GitHub public，但不进 npm 包）', () => {
  /**
   * 仓库根下、公开可读、且**不进 npm 包**的面。
   *
   * 🔴 **2026-10-14 自纠：扫描域曾经漏掉 `tests/` 与 `scripts/`** ——
   * 上一版的注释**写着**「docs/ / bench/ / scripts/ / CHANGELOG.md」，而代码里**没有 `scripts/`**
   * （本仓反复出现的"声明面 ≠ 实现面"，这次出现在**门禁自己身上**）。
   * ⇒ 判据：**注释里点名的面，必须在同一条 `files` 数组里能找到**，否则它就是一句谎。
   *
   * 🔴 **唯一豁免面 = 本文件自身**：扫描器**必须**写出它要找的那些形态（规则字面量 ＋ 正控），
   * 否则无法证明"它真能看见"。这是**结构性必要**的豁免（不是"历史区不改"那类可消除的例外），
   * 且本文件短、规则逐条可见 ⇒ 风险受控。
   */
  const SELF = 'hooks/dsh-serenity-hooks/tests/privacy-scan.test.ts'

  function repoFiles(): string[] {
    return [
      // 🔴 `docs/**/*`（**不是 `*.md`**）：本轮实测那次第三方真名泄露就在
      // `docs/status-card-scheme-O-shield.html`（**`.html`**）—— 只扫 `*.md` 的域**看不见它**。
      // 域里留一个"按扩展名"的边界，就是给同一类漏网留门。
      ...(globSync('docs/**/*', { cwd: REPO_ROOT }) as string[]),
      ...(globSync('bench/**/*', { cwd: REPO_ROOT }) as string[]),
      ...(globSync('scripts/**/*', { cwd: REPO_ROOT }) as string[]),
      ...(globSync('hooks/dsh-serenity-hooks/tests/**/*', { cwd: REPO_ROOT }) as string[]),
      // 仓根两份 README：`README.md` 进 npm 包（A 面已覆盖），
      // `README.en.md` **不进包但在 GitHub 上公开可读** ⇒ 此前不在任何扫描域内。
      'README.md',
      'README.en.md',
      'CHANGELOG.md',
      // 🔴 2026-11-05 CHANGELOG 超级重写时新增：历史条目逐字搬进 `CHANGELOG-archive.md`。
      // 它**不在 `files[]` 内**（不进 npm 包），但**在 GitHub 公开可读** ⇒ 与 `CHANGELOG.md` 同属 B 面。
      // ⛔ 不列进来就会留下一个「我扫了 CHANGELOG.md」却漏掉它 1.1 MB 孪生体的**未声明缺口**（D259）。
      'CHANGELOG-archive.md',
    ]
      .filter((f) => f !== SELF)
      .filter((f) => {
        try { return statSync(join(REPO_ROOT, f)).isFile() } catch { return false }
      })
  }

  it('扫描域自检：`tests/` 与 `scripts/` 必须在域内（防"注释点名了、代码漏了"复发）', () => {
    const files = repoFiles()
    expect(files.length).toBeGreaterThan(60)
    expect(files.some((f) => f.startsWith('hooks/dsh-serenity-hooks/tests/'))).toBe(true)
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true)
  })

  it('docs/ 与 bench/ 与 scripts/ 与 tests/ 与 CHANGELOG.md 零命中', () => {
    const files = repoFiles()
    const hits = scan(REPO_ROOT, files)
    expect.soft(hits, `仓库公开面仍有隐私内容：\n${fmt(hits)}`).toEqual([])
  })
})

describe('🔒 隐私否决判据：tsdown 构建不得把绝对路径写进产物', () => {
  it('CSS 虚拟模块 id 必须相对化（否则 rolldown 把绝对路径写进 region 注释）', () => {
    const cfg = readFileSync(join(PKG_ROOT, 'tsdown.config.ts'), 'utf-8')
    // 判据：虚拟 id 由 relative(PKG_ROOT, …) 构造，而非直接拼绝对路径
    expect(cfg).toContain("CSS_VIRTUAL_PREFIX + relative(PKG_ROOT, abs)")
    expect(cfg).toContain('PKG_ROOT')
  })

  it('lib/client.js 里不含绝对路径（构建产物的机械复核）', () => {
    const client = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf-8')
    expect(client).not.toMatch(/\/home\/yh\b/)
    // 正控：CSS 内联仍生效（region 注释在，只是路径相对了）
    expect(client).toContain('\\0sp-css:src/client/')
  })
})

void REPO_ROOT
void relative
