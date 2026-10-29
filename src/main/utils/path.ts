import { app } from 'electron'
import path from 'path'
import { DB_FILENAME } from '../../renderer/lib/constants'
import { getDataDirPath } from '../database/index'

/**
 * 获取用户数据目录路径
 */
export function getUserDataPath(): string {
  return getDataDirPath()
}

/**
 * 获取数据库文件路径
 *
 * ⚠️ 唯一真相是 `src/main/database/index.ts` 的 `getDatabasePath()`，
 * 本函数只是它的别名（两边都读 `app.getPath('userData')`）。
 * 历史上这里硬编码过 `'user.db'` 字面量，而常量在别处 —— 两处一旦漂移，
 * "备份哪份、恢复哪份"就会错位。现在统一引用 `DB_FILENAME`。
 */
export function getDatabaseFilePath(): string {
  return path.join(getUserDataPath(), DB_FILENAME)
}

/** 获取资源目录路径（开发环境与生产环境适配） */
export function getResourcesPath(): string {
  // 生产环境下资源在 app.asar.unpacked 或 resources 目录
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources')
  }
  return path.join(app.getAppPath(), 'resources')
}

/** 获取预加载脚本路径 */
export function getPreloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}
