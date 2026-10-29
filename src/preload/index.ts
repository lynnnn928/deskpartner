import { contextBridge, ipcRenderer } from 'electron'
import { createAPI } from './api'

// 通过 contextBridge 安全地暴露 API 到渲染进程
contextBridge.exposeInMainWorld('api', createAPI(ipcRenderer))
