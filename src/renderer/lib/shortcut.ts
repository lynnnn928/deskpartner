/**
 * 快捷键工具
 *
 * 负责在浏览器 KeyboardEvent 与 Electron globalShortcut accelerator 之间转换。
 * Electron accelerator 语法参考：
 *   Ctrl / Alt / Shift / Super + 主键，主键为字母、数字、F1~F24 或具名键
 */

/** 修饰键 */
const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph']

/** code → Electron 主键名 */
const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/** 从 KeyboardEvent.code 解析主键名，无法识别返回 null */
function resolveMainKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code] ?? null
}

/**
 * 将键盘事件转为 Electron accelerator。
 * 必须包含至少一个修饰键，否则返回 null（单键注册会抢占全局输入）。
 */
export function buildAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.includes(e.key)) return null

  const modifiers: string[] = []
  if (e.ctrlKey) modifiers.push('Ctrl')
  if (e.altKey) modifiers.push('Alt')
  if (e.shiftKey) modifiers.push('Shift')
  if (e.metaKey) modifiers.push('Super')

  if (modifiers.length === 0) return null

  const main = resolveMainKey(e.code)
  if (!main) return null

  return [...modifiers, main].join('+')
}

/** 判断按键事件是否为纯修饰键（录制时应忽略，等待主键） */
export function isModifierKey(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.includes(e.key)
}

/** 格式化展示：Ctrl+Shift+N → Ctrl + Shift + N */
export function formatAccelerator(accelerator: string): string {
  return accelerator.split('+').join(' + ')
}
