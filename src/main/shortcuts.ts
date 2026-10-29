import { globalShortcut } from 'electron'

/** 全局快捷键服务 */
export class ShortcutService {
  private registeredAccelerator: string | null = null

  /**
   * 注册全局快捷键
   * @param accelerator 快捷键组合，如 'Ctrl+Shift+N'
   * @param callback 快捷键触发的回调
   */
  register(accelerator: string | null, callback: () => void): boolean {
    // 先注销旧的快捷键
    this.unregisterCurrent()

    if (!accelerator) return true

    try {
      const success = globalShortcut.register(accelerator, callback)
      if (success) {
        this.registeredAccelerator = accelerator
        console.log(`[Shortcut] 已注册全局快捷键: ${accelerator}`)
      } else {
        console.warn(`[Shortcut] 快捷键注册失败，可能已被占用: ${accelerator}`)
      }
      return success
    } catch (err) {
      console.error(`[Shortcut] 快捷键注册异常: ${err}`)
      return false
    }
  }

  /** 注销当前已注册的快捷键 */
  unregisterCurrent(): void {
    if (this.registeredAccelerator) {
      try {
        globalShortcut.unregister(this.registeredAccelerator)
        console.log(`[Shortcut] 已注销快捷键: ${this.registeredAccelerator}`)
      } catch (err) {
        console.warn(`[Shortcut] 快捷键注销异常: ${err}`)
      }
      this.registeredAccelerator = null
    }
  }

  /** 注销所有全局快捷键 */
  unregisterAll(): void {
    globalShortcut.unregisterAll()
    this.registeredAccelerator = null
    console.log('[Shortcut] 已注销所有快捷键')
  }
}
