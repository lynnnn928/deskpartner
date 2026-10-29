import { app } from 'electron'

/**
 * 单实例锁
 * 确保应用只有一个实例运行
 */

/** 尝试获取单实例锁 */
export function requestSingleInstanceLock(): boolean {
  return app.requestSingleInstanceLock()
}

/** 当第二个实例启动时的处理 */
export function onSecondInstance(callback: () => void): void {
  app.on('second-instance', () => {
    console.log('[SingleInstance] 检测到第二个实例启动，激活已有实例')
    callback()
  })
}
