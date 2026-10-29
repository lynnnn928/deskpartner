/**
 * 迁移失败硬停（`c5b30fb3` 的②半边）
 *
 * 卡面原话：
 *
 * > 迁移失败硬停（明确报错退出，不带病跑命令）
 *
 * 实测事故里它是**未处理的 Promise 拒绝** —— 进程带着不确定的库状态
 * 继续活着、继续执行。本文件钉两层：
 *
 * 1. **连接层**：迁移失败后 `initializeDatabase()` 不许留下"半初始化"的连接
 *    （此前 `db` 先赋值后迁移，失败后 `if (db) return db` 会把它递给后续调用）；
 * 2. **启动层**：`src/main/index.ts` 必须有硬停边界（明确报错 + `app.exit(1)`），
 *    且 CLI 通道对未处理失败不再"记一笔就放行"。
 *
 * ## 反向验证
 *
 * - 连接层：把 `db = null`（或 close）摘掉 → `getDatabase()` 不再抛
 *   "未初始化"，而是拿到带病连接 → 第一条变红。
 * - 启动层：把 try/catch 或 `.catch(startupFatal)` 或 CLI 硬停摘掉 →
 *   对应的源码契约断言变红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const hoisted = vi.hoisted(() => ({
  dataDir: '',
  migrateImpl: null as null | (() => void)
}))

vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dataDir }
}))

/**
 * 只 mock 掉"迁移这一步"：本文件要验的是**失败之后**连接层的行为，
 * 不是迁移本身（那是 migration-lock-c5b30fb3 的活）。
 */
vi.mock('../../../src/main/database/migrations', () => ({
  runMigrations: () => {
    if (hoisted.migrateImpl) hoisted.migrateImpl()
  }
}))

/** 每条用例独立数据目录 + 重新加载模块（模块级 db 单例要能重置） */
async function loadDbModule(): Promise<typeof import('../../../src/main/database/index')> {
  hoisted.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-hardstop-'))
  vi.resetModules()
  return import('../../../src/main/database/index')
}

describe('迁移失败硬停：不带病跑命令（c5b30fb3）', () => {
  beforeEach(() => {
    hoisted.migrateImpl = null
  })

  it('连接层：迁移失败 ⇒ 错误上抛、连接作废，谁也拿不到半初始化的 db', async () => {
    const mod = await loadDbModule()
    hoisted.migrateImpl = () => {
      throw new Error('模拟迁移失败')
    }

    expect(() => mod.initializeDatabase()).toThrow('模拟迁移失败')

    /**
     * ⭐ 反向验证的核心断言：
     * 摘掉"失败即作废"（close + db = null），这里就会拿到那个
     * **迁移没跑完的连接** —— "带病跑命令"正是从这个口子进来的。
     */
    expect(() => mod.getDatabase()).toThrow('数据库未初始化')

    // 失败后允许重试：第二次（迁移成功）必须正常拿到连接
    hoisted.migrateImpl = null
    const conn = mod.initializeDatabase()
    expect(conn).toBeTruthy()
    expect(mod.getDatabase()).toBe(conn)
  })

  it('连接层：迁移成功 ⇒ getDatabase 返回同一个连接（正常路径不回归）', async () => {
    const mod = await loadDbModule()
    const conn = mod.initializeDatabase()
    expect(mod.getDatabase()).toBe(conn)
  })

  it('启动层：主入口必须有硬停边界（明确报错 + 退出，不是记一笔就放行）', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../src/main/index.ts'),
      'utf-8'
    )

    // ① 硬停函数存在，且真的会退出
    expect(src, 'startupFatal：启动失败必须有统一的硬停出口').toContain(
      'function startupFatal'
    )
    expect(
      src.match(/function startupFatal[\s\S]{0,1200}?app\.exit\(1\)/),
      'startupFatal 必须 app.exit(1) —— 只弹窗/只记日志就是"带病活着"'
    ).not.toBeNull()

    // ② initializeDatabase 的失败必须被接住并送进硬停
    expect(
      src.match(/try\s*\{\s*dbHandle\s*=\s*initializeDatabase\(\)\s*\}\s*catch/),
      'initializeDatabase() 必须包在 try/catch 里（同步抛错不能变未处理拒绝）'
    ).not.toBeNull()
    expect(src).toContain('.catch(startupFatal)')

    // ③ CLI 通道对未处理失败不再"记一笔就放行"（事故原形态就是这）
    const rejectionHandler = src.match(
      /process\.on\('unhandledRejection'[\s\S]*?\n\}\)/
    )
    expect(rejectionHandler, '必须有 unhandledRejection 处理器').not.toBeNull()
    expect(
      rejectionHandler![0],
      'CLI 模式下未处理拒绝必须硬停（否则迁移失败的进程会继续跑命令）'
    ).toContain('if (isCliMode) app.exit(1)')
  })
})
