import type { IpcRenderer } from 'electron'
import type { IPCChannels, IPCChannelName, IPCInput, IPCResult } from '../renderer/types/ipc'

/**
 * 创建暴露给渲染进程的类型安全 API
 * 所有 IPC 调用都经过此层，确保通道名和参数类型正确
 */
export function createAPI(ipcRenderer: IpcRenderer) {
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
    }
  }
}

/** 暴露到 window.api 的类型定义，供渲染进程使用 */
export type PreloadAPI = ReturnType<typeof createAPI>
