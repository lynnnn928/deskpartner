import type { IPCChannelName, IPCInput, IPCResult } from '../types/ipc'

/**
 * IPC 错误类型
 */
export class IPCError extends Error {
  constructor(
    public channel: string,
    message: string
  ) {
    super(`[IPC] ${channel}: ${message}`)
    this.name = 'IPCError'
  }
}

/**
 * 类型安全的 IPC 客户端（渲染进程侧）
 * 通过 window.api.invoke 调用主进程，自动解包响应
 *
 * 参数约定：直接传该通道的 input 类型，无需额外包装。
 * 无参通道（input 为 void）可省略第二个参数。
 */
export function invoke<K extends IPCChannelName>(channel: K): Promise<IPCResult<K>>
export function invoke<K extends IPCChannelName>(
  channel: K,
  input: IPCInput<K>
): Promise<IPCResult<K>>
export async function invoke<K extends IPCChannelName>(
  channel: K,
  ...args: unknown[]
): Promise<IPCResult<K>> {
  const response = await window.api.invoke(channel, ...(args as never[]))

  if (!response.ok) {
    throw new IPCError(channel, response.error ?? '未知错误')
  }

  return response.data as IPCResult<K>
}

/**
 * 监听主进程推送的事件
 * 返回清理函数
 */
export function on<K extends IPCChannelName>(
  channel: K,
  callback: (data: IPCResult<K>) => void
): () => void {
  return window.api.on(channel, callback)
}

/**
 * 移除指定通道的所有监听器
 */
export function removeAllListeners(channel: IPCChannelName): void {
  window.api.removeAllListeners(channel)
}

/**
 * 批量监听多个事件，返回统一的清理函数
 */
export function onMultiple(
  listeners: Array<{ channel: IPCChannelName; callback: (data: unknown) => void }>
): () => void {
  const cleanups = listeners.map(({ channel, callback }) =>
    window.api.on(channel, callback)
  )
  return () => {
    cleanups.forEach((cleanup) => cleanup())
  }
}
