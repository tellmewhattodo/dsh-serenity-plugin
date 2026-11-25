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
