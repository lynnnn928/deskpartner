import type { IpcRenderer, WebUtils } from 'electron'
import type { IPCChannels, IPCChannelName, IPCInput, IPCResult } from '../renderer/types/ipc'

/**
 * 创建暴露给渲染进程的类型安全 API
 * 所有 IPC 调用都经过此层，确保通道名和参数类型正确
 */
export function createAPI(ipcRenderer: IpcRenderer, webUtils: WebUtils) {
  return {
    /**
     * 调用主进程 IPC handler（请求-响应模式）
     * 返回 { ok, data?, error? } 格式的响应
     */
    invoke: async <K extends IPCChannelName>(
      channel: K,
      ...args: IPCInput<K> extends void ? [] : [IPCInput<K>]
    ): Promise<{ ok: boolean; data?: IPCResult<K>; error?: string }> => {
      return ipcRenderer.invoke(channel, ...args)
    },

    /**
     * 监听主进程推送的事件
     * 返回清理函数用于取消监听
     */
    on: <K extends IPCChannelName>(
      channel: K,
      callback: (data: IPCResult<K>) => void
    ): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: IPCResult<K>) => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      // 返回取消监听函数
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },

    /**
     * 移除指定通道的所有监听器
     */
    removeAllListeners: (channel: IPCChannelName): void => {
      ipcRenderer.removeAllListeners(channel)
    },

    /**
     * 剪贴板里那份东西在磁盘上的真实路径（卡 `cce88967`）
     *
     * 从资源管理器复制文件粘进来时，剪贴板给的是 `File` 对象；Electron 32 起
     * `File.path` 没了，只能靠 `webUtils.getPathForFile` 换回路径（在主世界里算，
     * 所以必须从 preload 转一手）。
     *
     * **截图没有路径** —— 它是内存字节，这里返回空串，界面据此分流走"传字节"那条。
     * 取不到也不该把粘贴弄崩：一律退化成空串。
     */
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  }
}

/** 暴露到 window.api 的类型定义，供渲染进程使用 */
export type PreloadAPI = ReturnType<typeof createAPI>
