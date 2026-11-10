/**
 * browser-slot-extend.test.ts — CCC 写扩展的唯一通道（`<CCC>/browser-ext/*.ts`）
 *
 * 🔴🔴 本文件钉的是那条**铁律**：扩展的任何失败，绝不影响 `browser_slot` 的既有动作。
 *    超时 / 非 0 退出 / 输出不是 JSON / spawn 失败 ⇒ **仅结构化失败返回，绝不抛**。
 *
 *    判据来源：`im/hook.ts` 的旁路容忍 ＋ `cro/core.ts` 的同一条铁律。若这里抛出去，
 *    一个 CCC 写错的扩展就能让**别人**的浏览器工具挂掉 —— 而那正是 owner
 *    2026-11-10 要"集中能力"时最不愿意看到的形态（集中 = 单点）。
 *
 * ⚠️ 这里**真 spawn 子进程**（⛔ 不 mock `child_process`）：本机制的契约就是进程边界，
 *    用替身测它等于把被验的那一层整个换掉。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EXT_DIR_REL,
  EXT_TIMEOUT_MS,
  buildExtPayload,
  extDirExists,
  findExtension,
  listExtensions,
  parseExtOutput,
  runExtension,
} from '../src/browser/extend.js'

let ccc = ''

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'slot-ext-'))
})
afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
})

/** 写一个扩展文件 */
function writeExt(name: string, body: string): void {
  const dir = join(ccc, EXT_DIR_REL)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.ts`), body, 'utf8')
}

/** 一个把 stdin 读进来、原样回一条合规 JSON 的最小扩展 */
const ECHO = `
let buf = ''
process.stdin.on('data', (d) => { buf += d.toString() })
process.stdin.on('end', () => {
  const p = JSON.parse(buf)
  console.log('debug line that is not json')
  console.log(JSON.stringify({ ok: true, result: { echo: p.args, slot: p.slot } }))
})
`

describe('扫描（文件在 = 启用，不在 = 禁用；无 enabled 字段、无注册表）', () => {
  it('① 目录不存在 ⇒ 空数组且**不抛**（"还没有扩展"是合法状态，不是错误）', () => {
    expect(extDirExists(ccc)).toBe(false)
    expect(listExtensions(ccc)).toEqual([])
  })

  it('② 只收 .ts/.mjs/.js，且**排除 .test.ts**（否则测试文件会变成可调用的扩展）', () => {
    writeExt('a', ECHO)
    writeExt('b', ECHO)
    const dir = join(ccc, EXT_DIR_REL)
    writeFileSync(join(dir, 'c.mjs'), ECHO, 'utf8')
    writeFileSync(join(dir, 'd.js'), ECHO, 'utf8')
    writeFileSync(join(dir, 'e.test.ts'), ECHO, 'utf8') // ⛔ 不该被收
    writeFileSync(join(dir, 'f.txt'), 'nope', 'utf8') // ⛔ 不是扩展
    expect(listExtensions(ccc).map((e) => e.name)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('③ 列表按名字排序（稳定输出，⛔ 读目录序 —— 那个随文件系统变）', () => {
    writeExt('zeta', ECHO)
    writeExt('alpha', ECHO)
    writeExt('middle', ECHO)
    expect(listExtensions(ccc).map((e) => e.name)).toEqual(['alpha', 'middle', 'zeta'])
  })

  it('④ 扩展名收窄：含路径分隔符/越界字符的名字一律找不到（⛔ 能点读任意文件）', () => {
    writeExt('ok', ECHO)
    expect(findExtension(ccc, 'ok')?.name).toBe('ok')
    for (const bad of ['../ok', 'a/b', 'ok/../../etc/passwd', '', 'x'.repeat(65), 'ok\n']) {
      expect(findExtension(ccc, bad)).toBeNull()
    }
    // 负控：名字合法但文件不存在 ⇒ 也是 null（证明上面不是"所有名字都 null"）
    expect(findExtension(ccc, 'nothere')).toBeNull()
  })
})

describe('🔴 铁律：扩展的失败绝不外溢', () => {
  /**
   * ⚠️ 这三格的判据都必须是**结构性**的（`ok:false` + 具体 code），
   *    不能只写 `expect(...).resolves` —— 那对一个"永远返回 ok:true"的实现也恒真。
   */
  it('⑤ 正常扩展：stdin → stdout 走通，且**调试行不影响解析**（契约 = 最后一个非空行）', async () => {
    writeExt('echo', ECHO)
    const entry = findExtension(ccc, 'echo')!
    const res = await runExtension(entry, buildExtPayload({ name: 'echo', slot: 3, port: 9303, cccRoot: ccc, args: { k: 'v' } }))
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ echo: { k: 'v' }, slot: 3 })
  })

  it('⑥ 非 0 退出 ⇒ ok:false + code=ext-nonzero，**不抛**', async () => {
    writeExt('boom', `process.exit(3)`)
    const res = await runExtension(findExtension(ccc, 'boom')!, {})
    expect(res.ok).toBe(false)
    expect(res.code).toBe('ext-nonzero')
    expect(String(res.error)).toContain('3')
  })

  it('⑦ stdout 不是 JSON ⇒ ok:false + code=ext-bad-output，**不抛**', async () => {
    writeExt('garbage', `console.log('hello world')`)
    const res = await runExtension(findExtension(ccc, 'garbage')!, {})
    expect(res.ok).toBe(false)
    expect(res.code).toBe('ext-bad-output')
  })

  it('⑧ 语法错的扩展 ⇒ 非 0 退出（不抛），且**宿主进程毫发无损**（这就是进程边界的意义）', async () => {
    writeExt('syntax', `this is not valid typescript at all !!!`)
    const res = await runExtension(findExtension(ccc, 'syntax')!, {})
    expect(res.ok).toBe(false)
    // 进程边界：上面这一行返回了，说明宿主没被带走
    expect(typeof process.pid).toBe('number')
  })

  it('⑨ 超时 ⇒ ok:false + code=ext-timeout，且**子进程被 kill**（⛔ 挂着一个永不返回的等待）', async () => {
    writeExt('hang', `setInterval(() => {}, 1000)`)
    const started = Date.now()
    const res = await runExtension(findExtension(ccc, 'hang')!, {}, 400)
    const elapsed = Date.now() - started
    expect(res.ok).toBe(false)
    expect(res.code).toBe('ext-timeout')
    // 负控：真按 timeout 返回，⛔ 干等到默认 45s
    expect(elapsed).toBeLessThan(EXT_TIMEOUT_MS)
    expect(elapsed).toBeLessThan(15_000)
  }, 30_000)

  it('⑩ 扩展自己报 ok:false ⇒ 转成 ext-reported-failure，并把它的原因带出来', async () => {
    writeExt('selfbad', `console.log(JSON.stringify({ ok: false, error: '我做不到' }))`)
    const res = await runExtension(findExtension(ccc, 'selfbad')!, {})
    expect(res.ok).toBe(false)
    expect(res.code).toBe('ext-reported-failure')
    expect(String(res.error)).toContain('我做不到')
  })
})

describe('输出解析（取最后一个非空行 —— 判据是"加一句 debug 不该破坏契约"）', () => {
  it('⑪ 调试输出混在前面 ⇒ 仍能解析出最后那一行 JSON', () => {
    const out = 'loading…\n{"phase":1}\n{"ok":true,"result":42}\n'
    expect(parseExtOutput(out)).toEqual({ ok: true, value: { ok: true, result: 42 } })
  })

  it('⑫ 最后一行不是 JSON ⇒ 往前找（⛔ 只认字面最后一行）', () => {
    expect(parseExtOutput('{"ok":true,"result":1}\ndone\n')).toEqual({ ok: true, value: { ok: true, result: 1 } })
  })

  it('⑬ 裸值/数组/null 都不算本契约（必须是**对象**）', () => {
    for (const bad of ['123', '"str"', 'null', '[1,2]', 'true']) {
      expect(parseExtOutput(bad).ok).toBe(false)
    }
    // 正控：对象就认
    expect(parseExtOutput('{"a":1}').ok).toBe(true)
  })

  it('⑭ 空输出 ⇒ ok:false（⛔ 幻觉出一个空对象）', () => {
    expect(parseExtOutput('').ok).toBe(false)
    expect(parseExtOutput('\n\n  \n').ok).toBe(false)
  })
})

describe('payload 组装（扩展知道得越少越好 —— R↓）', () => {
  it('⑮ 只给 slot/port/cccRoot/args/name/timeout，⛔ 不塞进程表、不塞别人的台账', () => {
    const p = buildExtPayload({ name: 'x', slot: 2, port: 9302, cccRoot: '/ccc/a', args: { z: 1 } })
    expect(Object.keys(p).sort()).toEqual(['args', 'cccRoot', 'name', 'port', 'slot', 'timeoutMs'])
    expect(p.slot).toBe(2)
    expect(p.port).toBe(9302)
    expect(p.timeoutMs).toBe(EXT_TIMEOUT_MS)
    // 负控：没有一个字段名看起来像"槽位全表/台账/进程"
    expect(JSON.stringify(p)).not.toMatch(/leases|pids|sessions|others/i)
  })

  it('⑯ timeoutMs 可覆盖（调用方要短超时的时候）', () => {
    expect(buildExtPayload({ name: 'x', slot: 1, port: 9301, cccRoot: '/c', args: {}, timeoutMs: 1234 }).timeoutMs).toBe(1234)
  })
})
