import { app } from 'electron'
import fs from 'node:fs'
import path from 'path'
import Database from 'better-sqlite3'
import { runMigrations } from './migrations'
import { DB_FILENAME } from '../../renderer/lib/constants'

let db: Database.Database | null = null
let initialUserDataDir: string | null = null
let activeDataDir: string | null = null

const DATA_DIR_CONFIG_FILENAME = 'data-dir-config.json'

/** 记录启动时未经改写的默认 userData 目录，保证指针文件位置恒定 */
export function captureInitialUserDataDir(dir?: string): string {
  if (!initialUserDataDir) {
    initialUserDataDir = dir ?? app.getPath('userData')
  }
  return initialUserDataDir
}

export function getDataDirConfigPath(): string {
  const override = process.env.DESKPARTNER_DATA_DIR_CONFIG?.trim()
  if (override) return path.resolve(override)
  const base = initialUserDataDir ?? app.getPath('userData')
  return path.join(base, DATA_DIR_CONFIG_FILENAME)
}

export function readConfiguredDataDir(): string | null {
  try {
    const cfgPath = getDataDirConfigPath()
    if (!fs.existsSync(cfgPath)) return null
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { dataDir?: unknown }
    if (typeof parsed?.dataDir === 'string' && parsed.dataDir.trim()) {
      return path.resolve(parsed.dataDir.trim())
    }
    return null
  } catch {
    return null
  }
}

export function writeConfiguredDataDir(targetDir: string): void {
  const cfgPath = getDataDirConfigPath()
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ dataDir: path.resolve(targetDir), updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  )
}

export function setActiveDataDir(dir: string | null): void {
  activeDataDir = dir ? path.resolve(dir) : null
}

/** 获取当前生效的数据存储目录 */
export function getDataDirPath(): string {
  return activeDataDir ?? app.getPath('userData')
}

/** 获取数据库文件路径 */
export function getDatabasePath(): string {
  return path.join(getDataDirPath(), DB_FILENAME)
}

/**
 * 修改数据存储目录并将当前 SQLite 数据库及历史自动备份迁移至新目录
 */
export async function migrateDataDirectory(
  targetDir: string
): Promise<{ changed: boolean; dataDir: string; previousDir: string }> {
  const trimmed = targetDir.trim()
  if (!trimmed) throw new Error('目标数据目录不能为空')
  const nextDir = path.resolve(trimmed)
  const prevDir = path.resolve(getDataDirPath())
  if (path.relative(prevDir, nextDir) === '') {
    return { changed: false, dataDir: prevDir, previousDir: prevDir }
  }

  fs.mkdirSync(nextDir, { recursive: true })
  const probeFile = path.join(nextDir, `.dp-write-probe-${process.pid}-${Date.now()}`)
  fs.writeFileSync(probeFile, 'ok', 'utf8')
  fs.unlinkSync(probeFile)

  const nextDbPath = path.join(nextDir, DB_FILENAME)
  const currentDb = getDatabase()
  await currentDb.backup(nextDbPath)

  try {
    for (const entry of fs.readdirSync(prevDir)) {
      if (entry.startsWith(`${DB_FILENAME}.`) && entry.includes('backup')) {
        const srcFile = path.join(prevDir, entry)
        const dstFile = path.join(nextDir, entry)
        if (!fs.existsSync(dstFile) && fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, dstFile)
        }
      }
    }
  } catch {
    /* 历史备份文件复制失败不阻塞主库迁移 */
  }

  writeConfiguredDataDir(nextDir)
  closeDatabase()
  activeDataDir = nextDir
  try {
    app.setPath('userData', nextDir)
  } catch {
    /* whenReady 之后以 activeDataDir 为准 */
  }
  initializeDatabase()
  return { changed: true, dataDir: nextDir, previousDir: prevDir }
}

/** 初始化数据库连接 */
export function initializeDatabase(): Database.Database {
  if (db) return db

  const dbPath = getDatabasePath()
  const conn = new Database(dbPath)

  // 启用 WAL 模式提升并发读写性能
  conn.pragma('journal_mode = WAL')
  // 启用外键约束
  conn.pragma('foreign_keys = ON')

  /**
   * 遇到锁时的等待时间（毫秒）
   *
   * better-sqlite3 也有 5000ms 的默认值，但那是**库的实现细节**，
   * 依赖它等于把并发行为的正确性押在第三方默认值不会变上。
   * v2 的核心场景是"多个 Agent 同时调 CLI"= 多进程同时写库，
   * 这个值是并发正确性的关键参数，必须写死在我们自己的代码里。
   */
  conn.pragma('busy_timeout = 5000')

  /**
   * 迁移失败：**关连接、清句柄、把错抛给启动层硬停**（`c5b30fb3`）。
   *
   * 此前是 `db = new Database(...)` 先赋值、`runMigrations(db)` 后执行 ——
   * 迁移一失败，模块级 `db` 就停在"半初始化"状态，而 `initializeDatabase()`
   * 开头的 `if (db) return db` 会把它原样递给后续调用方（**带病跑命令**的口子）。
   * 现在：失败 = 这个连接作废，谁也拿不到它；错误原样上抛（MigrationError
   * 自带失败步骤与备份路径），由 `src/main/index.ts` 明确报错 + 退出。
   */
  try {
    runMigrations(conn)
  } catch (err) {
    try {
      conn.close()
    } catch {
      /* 尽力关；关不掉也不该盖过真正的迁移错误 */
    }
    db = null
    throw err
  }
  db = conn

  console.log(`[Database] 初始化完成: ${dbPath}`)
  return db
}

/** 获取当前数据库连接（需先调用 initializeDatabase） */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('[Database] 数据库未初始化，请先调用 initializeDatabase()')
  }
  return db
}

/** 关闭数据库连接 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    console.log('[Database] 连接已关闭')
  }
}
