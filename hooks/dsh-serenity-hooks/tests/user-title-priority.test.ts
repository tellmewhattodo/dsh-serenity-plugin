/**
 * user-title-priority.test.ts — 🔴 用户自定义标题优先，不覆盖（owner 2026-11-25 需求）
 *
 * ## 需求原话
 *
 * 「就是上下文交接以后我得重命名会被覆盖」
 * 「按理说自己重命名的应该是优先级最高的吧」
 *
 * ## 判据为什么不能看宿主的 `source.kind === 'user'`
 *
 * 宿主 `sessionTitle.rename()` —— **我们自己改名走的也是它** —— 落盘来源**恒为** `user`：
 *
 *     session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
 *
 * ⇒ 若拿"来源=user"当"人改的"，**我们自己每次 regenerate 都会被自己挡住**，
 *   摘要再也更新不了 —— 那是把功能焊死，不是尊重用户。
 *
 * ## 所以判据认**形状**
 *
 * 我们生成的标题必然以 `<S编号>-<日期>` 开头 ⇒ 当前标题不符合这个形状 ⟺ 用户改过。
 */
import { describe, expect, it } from 'vitest'
import { shouldKeepUserTitle, namingTitleFor, readCurrentTitle, type ActiveSessionInfo } from '../src/trajectory/core.js'

const info: ActiveSessionInfo = {
  sessionId: 'S142',
  dirName: '2026-08-24--S142--dsh-serenity-plugin 长期维护',
  mdPath: '/x/SESSION.md',
}

describe('shouldKeepUserTitle — 形状判据', () => {
  it('C1 用户改成完全不同的名字 ⇒ 保留（⛔ 不覆盖）', () => {
    expect(shouldKeepUserTitle('我的私人笔记本', 'S142-2026-08-24')).toBe(true)
  })

  it('C2 当前就是我们上一轮写的「编号-日期-概括」⇒ 允许覆盖（换新概括）', () => {
    expect(shouldKeepUserTitle('S142-2026-08-24-旧概括', 'S142-2026-08-24')).toBe(false)
  })

  it('C3 当前正是「编号-日期」（无概括那一版）⇒ 允许覆盖', () => {
    expect(shouldKeepUserTitle('S142-2026-08-24', 'S142-2026-08-24')).toBe(false)
  })

  it('C4 用户在我们的标题后面又加了字（S142-2026-08-24-我自己起的名）⇒ 保留', () => {
    // 这一格刻意钉住：形状前缀 + `-` 开头**与我们生成的一致**，因此**会被判成我们的**
    // —— 这是形状判据的已知边界，本用例把它写成**契约**而不是假装不存在。
    // 若要区分"用户在我们的名字上改字"，需要额外记住自己上次写过什么（另一版的事）。
    expect(shouldKeepUserTitle('S142-2026-08-24-我自己起的名', 'S142-2026-08-24')).toBe(false)
  })

  it('C5 尚无标题（空串/纯空白）⇒ **允许写**（这是命名，不是覆盖）', () => {
    expect(shouldKeepUserTitle(undefined, 'S142-2026-08-24')).toBe(false)
    expect(shouldKeepUserTitle('', 'S142-2026-08-24')).toBe(false)
    expect(shouldKeepUserTitle('   ', 'S142-2026-08-24')).toBe(false)
  })

  it('C6 前缀为空（无从判断）⇒ 允许写（按旧行为，不引入回归）', () => {
    expect(shouldKeepUserTitle('任意名字', '')).toBe(false)
  })

  it('C7 前缀相似但不同的编号（S1420 vs S142）⇒ 保留（不得被子串误命中）', () => {
    expect(shouldKeepUserTitle('S1420-2026-08-24-别的轨迹', 'S142-2026-08-24')).toBe(true)
  })

  it('C8 首尾空白不影响判断', () => {
    expect(shouldKeepUserTitle('  S142-2026-08-24-概括  ', 'S142-2026-08-24')).toBe(false)
    expect(shouldKeepUserTitle('  用户自己起的  ', 'S142-2026-08-24')).toBe(true)
  })
})

/**
 * 🔴🔴 2026-11-25 真机回归（owner：「新建轨迹自动命名坏了」）—— 这一组是本轮**新增**的，
 * 也是当初那 12 条用例**结构上看不见**的一格。
 *
 * ## 当初错在哪（必须留住，否则还会再犯）
 *
 * v1.139.4 初版的判据**只有形状一维**：「不符合 `<S编号>-<日期>` 就当作人改过」。
 * 它默认了一个**未经验证的前提**：会话上出现的标题只有两种来源 —— 我们写的、人写的。
 *
 * 真机推翻了它：宿主 `dsh-session-title` **自带自动命名**（首条 user 消息时 append），
 * 两种机器来源：
 *   · `source.kind = 'fallback'` —— 取首条消息前若干词（确定性兜底）
 *   · `source.kind = 'provider'` —— 装了 LLM 标题 provider 时由模型生成
 * 这两类**都不是人改的**。旧判据把宿主自动起的名当成"用户的自定义标题"⇒ 一律保留
 * ⇒ **我们永远不改名** ⇒ 侧栏一直显示宿主那串自动名字。
 *
 * ⇒ 判据必须是**二维**的：① 谁写的（source，用来**排除**机器生成）
 *   ② 是不是我们写的（形状，用来识别我们上一轮写的）。
 *
 * ⚠️ 注意 `source.kind === 'user'` **仍然不能**当作"人改的"——我们自己 rename 也标 user
 *    （见本文件头注）。所以 source 这一维**只用来排除 fallback/provider**，正着用不能用。
 */
describe('shouldKeepUserTitle — 第二维：排除宿主自动生成的标题（真机回归）', () => {
  const P = 'S142-2026-08-24'

  it('C15 host fallback 标题（首条消息前几词）⇒ 必须允许我们改名（⛔ 不保留）', () => {
    // 真机形态：宿主取首条用户消息开头当标题，如「在 dsh 中配置 Ollama 订阅」
    expect(shouldKeepUserTitle('在 dsh 中配置 Ollama 订阅', P, 'fallback')).toBe(false)
  })

  it('C16 host provider 标题（LLM 生成）⇒ 必须允许我们改名', () => {
    expect(shouldKeepUserTitle('Ollama 订阅配置讨论', P, 'provider')).toBe(false)
  })

  it('C17 真实人工改的标题（source=user 且形状不符）⇒ 仍要保留（⛔ 别把它一起放开）', () => {
    expect(shouldKeepUserTitle('我的私人笔记本', P, 'user')).toBe(true)
  })

  it('C18 source 缺失（旧服务/替身）⇒ 退回纯形状判据，行为与 v1.139.4 一致', () => {
    expect(shouldKeepUserTitle('我的私人笔记本', P, undefined)).toBe(true)
    expect(shouldKeepUserTitle(`${P}-新概括`, P, undefined)).toBe(false)
  })

  it('C19 我们自己写的标题 + source=user（我们 rename 就标 user）⇒ 允许覆盖', () => {
    expect(shouldKeepUserTitle(`${P}-旧概括`, P, 'user')).toBe(false)
  })

  it('C20 fallback 但**恰好**等于我们的前缀 ⇒ 仍然允许写（两维都不拦）', () => {
    expect(shouldKeepUserTitle(P, P, 'fallback')).toBe(false)
  })
})

describe('readCurrentTitle — 必须把 source 一并读出来', () => {
  it('C21 宿主快照含 source ⇒ 透出 sourceKind', () => {
    const titles = { get: () => ({ title: '宿主自动名', source: { kind: 'fallback' } }) }
    expect(readCurrentTitle(titles, {})).toEqual({
      state: 'ok',
      title: '宿主自动名',
      sourceKind: 'fallback',
    })
  })

  it('C22 快照无 source ⇒ 不给 sourceKind 键（⛔ 不给一个假的默认值）', () => {
    const titles = { get: () => ({ title: '某标题' }) }
    const r = readCurrentTitle(titles, {})
    expect(r.state).toBe('ok')
    expect('sourceKind' in r).toBe(false)
  })

  it('C23 source.kind 非字符串 ⇒ 不透出（脏数据不参与判据）', () => {
    const titles = { get: () => ({ title: '某标题', source: { kind: 123 } }) }
    const r = readCurrentTitle(titles, {})
    expect('sourceKind' in r).toBe(false)
  })
})

describe('readCurrentTitle — 「读口缺失」与「读到空标题」必须分开', () => {
  it('C11 服务没有 `get` ⇒ unreadable（结构上无法判断）', () => {
    expect(readCurrentTitle({}, {})).toEqual({ state: 'unreadable' })
    expect(readCurrentTitle(undefined, {})).toEqual({ state: 'unreadable' })
  })

  it('C12 有 `get` 但会话尚无标题 ⇒ ok + undefined（这是"命名"不是"覆盖"）', () => {
    const titles = { get: () => undefined }
    expect(readCurrentTitle(titles, {})).toEqual({ state: 'ok', title: undefined })
  })

  it('C13 `get` 抛错 ⇒ unreadable（不把异常当"没有标题"，否则会覆盖用户标题）', () => {
    const titles = {
      get: () => {
        throw new Error('boom')
      },
    }
    expect(readCurrentTitle(titles, {})).toEqual({ state: 'unreadable' })
  })

  it('C14 读到用户标题 ⇒ ok + 内容（调用方据此保留）', () => {
    const titles = { get: () => ({ title: '我的私人笔记本' }) }
    expect(readCurrentTitle(titles, {})).toEqual({ state: 'ok', title: '我的私人笔记本' })
  })
})

describe('namingTitleFor — 前缀与全标题同源', () => {
  it('C9 不传 summary 即得前缀（判据与生成共用一条派生路径）', () => {
    expect(namingTitleFor(info)).toBe('S142-2026-08-24')
    expect(namingTitleFor(info, '新阶段')).toBe('S142-2026-08-24-新阶段')
  })

  it('C10 非 S### 会话回退目录名 —— 此时形状判据仍自洽', () => {
    const issue: ActiveSessionInfo = { sessionId: 'apaas-26817', dirName: '2026-11-17--apaas-26817', mdPath: '/x' }
    const prefix = namingTitleFor(issue)
    expect(prefix).toBe('2026-11-17--apaas-26817')
    // 我们从不给这类会话生成标题 ⇒ 当前标题只要不是这个目录名，就该保留
    expect(shouldKeepUserTitle('2026-11-17--apaas-26817', prefix)).toBe(false)
    expect(shouldKeepUserTitle('用户起的名', prefix)).toBe(true)
  })
})
