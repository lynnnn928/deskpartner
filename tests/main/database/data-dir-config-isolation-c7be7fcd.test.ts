import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isolationConfigWriteError,
  writeConfiguredDataDir,
  migrateDataDirectory,
  initializeDatabase,
  closeDatabase,
  setActiveDataDir
} from '../../../src/main/database/index'

/**
 * 隔离实例不许改真实应用的数据目录指针（卡 `c7be7fcd`）
 *
 * 2026-11-11 的事故形状：一次隔离环境下的「换数据目录」验证，把**真实安装**的
 * `%APPDATA%\desk-partner\data-dir-config.json` 指到了 scratchpad 里的临时库 ——
 * 下次启动应用就会打开那个库；当天 1.0.144 发版的版本登记因此报身份未注册。
 *
 * 这条用例锁两件事：
 *  ① 隔离态（`DESKPARTNER_DATA_DIR` 生效）且没有显式指针路径 → **拒绝写**，且一个字节都不落；
 *  ② 非隔离态照旧能写（反向验证：别把正常功能一起挡了）。
 */
describe('隔离实例不得改真实数据目录指针（c7be7fcd）', () => {
  const cleanups: string[] = []

  const tmp = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    cleanups.push(dir)
    return dir
  }

  afterEach(() => {
    delete process.env.DESKPARTNER_DATA_DIR
    delete process.env.DESKPARTNER_DATA_DIR_CONFIG
    for (const dir of cleanups.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  })

  it('1. 判据本身：只有「隔离中且没给指针路径」才算违规', () => {
    expect(isolationConfigWriteError({})).toBeNull()
    expect(isolationConfigWriteError({ DESKPARTNER_DATA_DIR: '' })).toBeNull()
    expect(isolationConfigWriteError({ DESKPARTNER_DATA_DIR: '   ' })).toBeNull()
    expect(
      isolationConfigWriteError({ DESKPARTNER_DATA_DIR: 'D:\\iso', DESKPARTNER_DATA_DIR_CONFIG: 'D:\\iso\\cfg.json' })
    ).toBeNull()

    const msg = isolationConfigWriteError({ DESKPARTNER_DATA_DIR: 'D:\\iso' })
    expect(msg).toContain('DESKPARTNER_DATA_DIR_CONFIG')
  })

  it('2. 隔离态拒绝写指针，且不在任何地方落文件', () => {
    const iso = tmp('dp-iso-')
    process.env.DESKPARTNER_DATA_DIR = iso

    expect(() => writeConfiguredDataDir(path.join(iso, 'next'))).toThrow(/DESKPARTNER_DATA_DIR_CONFIG/)
    // 隔离目录里也不该留下指针：拒绝了就是拒绝了，不做"半写"
    expect(fs.readdirSync(iso)).toEqual([])
  })

  it('3. 隔离态给了指针路径就能换目录（指针落进隔离目录）', async () => {
    const iso = tmp('dp-iso-')
    const cfg = path.join(iso, 'data-dir-config.json')
    const next = path.join(iso, 'next')
    process.env.DESKPARTNER_DATA_DIR = iso
    process.env.DESKPARTNER_DATA_DIR_CONFIG = cfg

    writeConfiguredDataDir(next)
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).dataDir).toBe(path.resolve(next))

    // 走整条迁移：隔离态 + 显式指针，应当照常完成
    setActiveDataDir(iso)
    initializeDatabase()
    const res = await migrateDataDirectory(next)
    closeDatabase()
    setActiveDataDir(null)
    expect(res.changed).toBe(true)
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).dataDir).toBe(path.resolve(next))
  })

  it('4. 反向验证：非隔离态照旧能写指针（别把正常功能挡了）', () => {
    const dir = tmp('dp-plain-')
    const cfg = path.join(dir, 'data-dir-config.json')
    process.env.DESKPARTNER_DATA_DIR_CONFIG = cfg

    writeConfiguredDataDir(path.join(dir, 'moved'))
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).dataDir).toBe(path.resolve(dir, 'moved'))
  })
})
