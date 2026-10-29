import { app } from 'electron'

/** 开机自启服务 */
export class AutoLaunchService {
  /** 设置开机自启 */
  enable(): void {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe')
    })
    console.log('[AutoLaunch] 已启用开机自启')
  }

  /** 取消开机自启 */
  disable(): void {
    app.setLoginItemSettings({
      openAtLogin: false
    })
    console.log('[AutoLaunch] 已取消开机自启')
  }

  /** 查询开机自启状态 */
  isEnabled(): boolean {
    const settings = app.getLoginItemSettings()
    return settings.openAtLogin
  }

  /** 根据开关设置更新开机自启 */
  update(enabled: boolean): void {
    if (enabled) {
      this.enable()
    } else {
      this.disable()
    }
  }
}
