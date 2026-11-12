import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createAPI } from './api'

// 通过 contextBridge 安全地暴露 API 到渲染进程
// webUtils 一并递进去：剪贴板里"从资源管理器复制的文件"要靠它换回磁盘路径（卡 cce88967）
contextBridge.exposeInMainWorld('api', createAPI(ipcRenderer, webUtils))
