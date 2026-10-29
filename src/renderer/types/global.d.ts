import type { PreloadAPI } from '../preload/api'

/** 暴露到 window.api 的类型声明 */
declare global {
  interface Window {
    api: PreloadAPI
  }
}
