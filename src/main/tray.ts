import { Tray, Menu, app, nativeImage } from 'electron'
import path from 'path'
import { getResourcesPath } from './utils/path'

/** 系统托盘服务 */
export class TrayService {
  private tray: Tray | null = null
  private onShowKanban: () => void
  private onShowSettings: () => void
  private onQuit: () => void

  constructor(options: {
    onShowKanban: () => void
    onShowSettings: () => void
    onQuit: () => void
  }) {
    this.onShowKanban = options.onShowKanban
    this.onShowSettings = options.onShowSettings
    this.onQuit = options.onQuit
  }

  /** 创建系统托盘 */
  create(): void {
    const icon = this.loadTrayIcon()
    if (icon.isEmpty()) {
      console.error('[Tray] 托盘图标加载失败，通知区域将显示空白')
    }

    // 不做 resize：resources 下的 tray-icon@2x.png 会被 Electron 自动
    // 用于高 DPI 屏，手动缩到 16x16 反而会让高分屏变糊
    this.tray = new Tray(icon)
    this.tray.setToolTip('DeskPartner - 桌面悬浮待办助手')

    this.updateMenu()
  }

  /** 更新右键菜单 */
  updateMenu(): void {
    if (!this.tray) return

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '打开看板',
        click: () => this.onShowKanban()
      },
      {
        label: '设置',
        click: () => this.onShowSettings()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.onQuit()
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  /** 更新托盘图标 */
  updateIcon(iconPath: string): void {
    if (!this.tray) return
    const icon = nativeImage.createFromPath(iconPath)
    this.tray.setImage(icon)
  }

  /** 应用自定义应用名称与图标 */
  applyCustomBranding(options: { appName?: string; appIcon?: string | null }): void {
    if (!this.tray) return
    const displayName = options.appName?.trim() || 'DeskPartner'
    this.tray.setToolTip(`${displayName} - 桌面悬浮待办助手`)

    if (options.appIcon) {
      const custom = nativeImage.createFromDataURL(options.appIcon)
      if (!custom.isEmpty()) {
        this.tray.setImage(custom.resize({ width: 32, height: 32, quality: 'best' }))
        return
      }
    }
    const fallback = this.loadTrayIcon()
    if (!fallback.isEmpty()) {
      this.tray.setImage(fallback)
    }
  }

  /** 销毁托盘 */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  /**
   * 加载托盘图标
   *
   * 按优先级依次尝试，任一可用即返回 —— 早期版本只认 tray-icon.png，
   * 该文件缺失时 nativeImage 会返回空图像，导致通知区域一片空白且毫无提示。
   * 这里加回退与日志，避免同类问题再次静默发生。
   */
  private loadTrayIcon(): Electron.NativeImage {
    const resourcesPath = getResourcesPath()
    for (const name of ['tray-icon.png', 'icon.png']) {
      const iconPath = path.join(resourcesPath, name)
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) {
        const { width, height } = icon.getSize()
        console.log(`[Tray] 已加载托盘图标: ${name} (${width}x${height})`)
        return icon
      }
      console.warn(`[Tray] 图标不可用或为空: ${iconPath}`)
    }
    return nativeImage.createEmpty()
  }
}
