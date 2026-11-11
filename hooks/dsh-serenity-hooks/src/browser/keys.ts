/**
 * browser/keys.ts — 键盘按键的**纯判定**（"Meta+A" → CDP dispatchKeyEvent 参数）。
 *
 * 🔴 为什么单独一个文件、且必须纯：**按键是最容易"看起来成功"的动作**。
 *    发错一个字段，页面只是"没反应" —— 没有报错、没有异常、也没有任何读数与"按对了但没效果"区分。
 *    所以这张映射表必须能被逐条单测，且键名解析失败必须**拒绝**而不是猜。
 *
 * ⛔ 刻意不做的事：
 *   · ⛔ 不支持"任意字符 → 键码"的猜法（Unicode 文本走 `Input.insertText`，不猜键位）
 *   · ⛔ 不接受裸字符串走 `key` 字段却不给 `code`（Chrome 对 `code` 缺失的按键行为随版本漂）
 */

/** CDP `Input.dispatchKeyEvent` 的修饰位（与 DOM 的 KeyboardEvent.modifier 一致） */
export const MODIFIERS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const
export type ModifierName = keyof typeof MODIFIERS

/** 一个可发送的按键（三个字段缺一不可，见文件头判据） */
export interface KeyStroke {
  /** 形如 `Enter` `a` `ArrowDown` —— 写进 CDP 的 `key` */
  key: string
  /** 形如 `Enter` `KeyA` `ArrowDown` —— 写进 CDP 的 `code` */
  code: string
  /** 修饰位掩码（0 = 无修饰） */
  modifiers: number
  /** 同时按下的物理键 `windowsVirtualKeyCode`（Enter/方向键等需要它才会触发默认行为） */
  windowsVirtualKeyCode?: number
}

/** 常用键：键名（大小写照收）→ code ＋ VK。⛔ 只收"有明确 VK 且会触发默认行为"的那些。 */
const NAMED: Record<string, { code: string; vk?: number; cdkey?: string }> = {
  enter: { code: 'Enter', vk: 13, cdkey: 'Enter' },
  return: { code: 'Enter', vk: 13, cdkey: 'Enter' },
  tab: { code: 'Tab', vk: 9, cdkey: 'Tab' },
  escape: { code: 'Escape', vk: 27, cdkey: 'Escape' },
  esc: { code: 'Escape', vk: 27, cdkey: 'Escape' },
  backspace: { code: 'Backspace', vk: 8, cdkey: 'Backspace' },
  delete: { code: 'Delete', vk: 46, cdkey: 'Delete' },
  space: { code: 'Space', vk: 32, cdkey: ' ' },
  arrowup: { code: 'ArrowUp', vk: 38, cdkey: 'ArrowUp' },
  arrowdown: { code: 'ArrowDown', vk: 40, cdkey: 'ArrowDown' },
  arrowleft: { code: 'ArrowLeft', vk: 37, cdkey: 'ArrowLeft' },
  arrowright: { code: 'ArrowRight', vk: 39, cdkey: 'ArrowRight' },
  home: { code: 'Home', vk: 36, cdkey: 'Home' },
  end: { code: 'End', vk: 35, cdkey: 'End' },
  pageup: { code: 'PageUp', vk: 33, cdkey: 'PageUp' },
  pagedown: { code: 'PageDown', vk: 34, cdkey: 'PageDown' },
}

/**
 * 解析一个按键描述：`Enter` ／ `Meta+A` ／ `Control+Shift+Enter` ／ `a`。
 *
 * 判据（每条都是"宁可拒绝"）：
 *   ① 修饰名只认 `Alt` `Control` `Meta` `Shift`（大小写不敏感）；⛔ 不认 `Cmd`/`Ctrl` 这类别名 ——
 *      别名一旦猜错，`Cmd+A` 会变成无修饰的 `A`（全选变打字），**而那没有任何信号**。
 *   ② 单字符 ⇒ 字母/数字才认（`a`→`KeyA` ／ `1`→`Digit1`）；其余单字符（中文/emoji/标点）
 *      ⇒ **拒绝**并指路 `--text`（走 insertText）。判据：键位表里没有的东西，"按"它只是碰运气。
 *   ③ 解析不出 ⇒ 返回 `null`（调用方据此拒绝并列出可用键名），⛔ 不回落成"`key` 直接用原始串"。
 */
export function parseKeyStroke(desc: string): KeyStroke | null {
  const raw = desc.trim()
  if (!raw) return null

  const parts = raw.split('+').map((s) => s.trim()).filter((s) => s !== '')
  if (parts.length === 0) return null

  // 最后一段是主键，前面全是修饰名
  const mainRaw = parts[parts.length - 1]!
  let modifiers = 0
  for (const mod of parts.slice(0, -1)) {
    const name = (Object.keys(MODIFIERS) as ModifierName[]).find((m) => m.toLowerCase() === mod.toLowerCase())
    if (!name) return null // ① 别名一律拒绝
    modifiers |= MODIFIERS[name]
  }

  const named = NAMED[mainRaw.toLowerCase()]
  if (named) {
    return {
      key: named.cdkey ?? mainRaw,
      code: named.code,
      modifiers,
      ...(named.vk !== undefined ? { windowsVirtualKeyCode: named.vk } : {}),
    }
  }

  // 单字符：只认 A-Z / 0-9（大小写都映射到同一个物理键，是否大写由 Shift 修饰位表达）
  if ([...mainRaw].length === 1) {
    const ch = mainRaw
    if (/^[a-zA-Z]$/.test(ch)) {
      return { key: ch, code: `Key${ch.toUpperCase()}`, modifiers }
    }
    if (/^[0-9]$/.test(ch)) {
      return { key: ch, code: `Digit${ch}`, modifiers }
    }
    return null // ② 中文/标点/emoji ⇒ 拒绝，走 --text
  }

  return null // ③
}

/** 可用键名（拒绝时列给调用方；⛔ 不列单字符 —— 那是规则不是枚举） */
export function listNamedKeys(): string[] {
  return [...new Set(Object.values(NAMED).map((n) => n.cdkey ?? n.code))].sort()
}
