import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import {
  DEFAULT_FLOAT_BALL,
} from '../../../src/renderer/lib/constants'

// Mock getDatabase
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

describe('SettingsRepository', () => {
  let repo: SettingsRepository

  beforeAll(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM settings').run()
    repo = new SettingsRepository()
  })

  describe('get()', () => {
    it('should return defaults for empty database', () => {
      const settings = repo.get()

      expect(settings.theme).toBe('light')
      expect(settings.stylePreset).toBe('frosted')
      expect(settings.floatBallSize).toBe(DEFAULT_FLOAT_BALL.size)
      expect(settings.floatBallOpacity).toBe(DEFAULT_FLOAT_BALL.opacity)
      expect(settings.autoStart).toBe(false)
      expect(settings.fontSizeScale).toBe('normal')
      expect(settings.customColors).toEqual({})
    })
  })

  /**
   * 首次见面引导只看一次（1.0.64）
   *
   * 这组断言锁住的是**行为契约**，不是字段存在：默认没看过 → 看过一次后
   * 必须一直是 true。写成 false 的话用户每次启动都被弹一遍 —— 那正是
   * 设计时明确否掉的形态（X 表达"这次不看"，不等于"永远不看"）。
   */
  describe('welcomeShown（首次见面引导只弹一次）', () => {
    it('默认 false —— 新装或老库升级上来都还没看过', () => {
      expect(repo.get().welcomeShown).toBe(false)
    })

    it('置 true 后持久化，重启（重新 get）仍为 true', () => {
      repo.update({ welcomeShown: true })
      expect(repo.get().welcomeShown).toBe(true)

      // 模拟"下次启动"：新建一个仓库实例从同一个库读
      const reopened = new SettingsRepository()
      expect(reopened.get().welcomeShown).toBe(true)
    })

    it('改别的设置不会把它带回 false（否则引导会复活）', () => {
      repo.update({ welcomeShown: true })
      repo.update({ theme: 'dark', autoStart: true })
      expect(repo.get().welcomeShown).toBe(true)
    })

    it('库里的值是字符串 "true"/"false" 时都能正确解析', () => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'welcomeShown',
        'true'
      )
      expect(repo.get().welcomeShown).toBe(true)

      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'welcomeShown',
        'false'
      )
      expect(repo.get().welcomeShown).toBe(false)
    })

    it('库里存了非法值时不抛错，回退 false（不能让界面拿不到设置）', () => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'welcomeShown',
        'yes-please'
      )
      expect(repo.get().welcomeShown).toBe(false)
    })
  })

  describe('update()', () => {
    it('should partially update settings, keeping others unchanged', () => {
      const original = repo.get()
      const updated = repo.update({ theme: 'dark' })

      expect(updated.theme).toBe('dark')
      expect(updated.stylePreset).toBe(original.stylePreset)
      expect(updated.autoStart).toBe(original.autoStart)
    })

    it('should merge customColors with existing', () => {
      repo.update({ customColors: { accent: '#FF0000' } })
      const updated = repo.update({ customColors: { success: '#00FF00' } })

      expect(updated.customColors.accent).toBe('#FF0000')
      expect(updated.customColors.success).toBe('#00FF00')
    })

    it('should persist updates across get() calls', () => {
      repo.update({ theme: 'dark', autoStart: true })
      const settings = repo.get()

      expect(settings.theme).toBe('dark')
      expect(settings.autoStart).toBe(true)
    })
  })

  describe('resetVisual()', () => {
    it('should reset visual params but keep system settings', () => {
      repo.update({
        theme: 'dark',
        stylePreset: 'japanese',
        autoStart: true,
        globalShortcut: 'Ctrl+Alt+T',
        floatBallSize: 100,
        floatBallOpacity: 0.8,
        customColors: { accent: '#FF0000' }
      })

      const reset = repo.resetVisual()

      expect(reset.stylePreset).toBe('frosted')
      expect(reset.floatBallSize).toBe(DEFAULT_FLOAT_BALL.size)
      expect(reset.floatBallOpacity).toBe(DEFAULT_FLOAT_BALL.opacity)
      expect(reset.customColors).toEqual({})

      expect(reset.autoStart).toBe(true)
      expect(reset.globalShortcut).toBe('Ctrl+Alt+T')
    })
  })
})
