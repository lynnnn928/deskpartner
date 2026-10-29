import { describe, expect, it, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import '../../../src/main/cli/commands'
import { UI_WHITELIST } from '../../../src/main/cli/commands/ui'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const ROOT = path.resolve(__dirname, '../../..')

/**
 * 卡 `e5c23a1e`：材料缺口剩两项（② 行为清点 + ④ 设计令牌与 UI_WHITELIST 参数契约表）
 *
 * 1. 缺口 ② 行为清点已由 `docs/generated/headless-surface.md`（卡 `f45a49c1`）交付并受源码闸门保护；
 * 2. 缺口 ④ 设计令牌参数契约表落在 `docs/DESIGN.md` 的「可调界面参数契约表（UI_WHITELIST）」，
 *    本用例守住 `UI_WHITELIST` 全部参数名、说明、类型/范围及 `SettingsRepository` 默认值与文档表格零漂移。
 */
describe('材料缺口收口：行为清点与 UI_WHITELIST 参数契约表（e5c23a1e）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  it('缺口 ②：行为清点生成物 docs/generated/headless-surface.md 存在且包含全量命令与关口表', () => {
    const surfacePath = path.join(ROOT, 'docs/generated/headless-surface.md')
    expect(fs.existsSync(surfacePath)).toBe(true)
    const content = fs.readFileSync(surfacePath, 'utf8')
    expect(content).toContain('# Headless 能力清点（生成文件）')
    expect(content).toContain('## 2. 命令清单')
    expect(content).toContain('## 3. 关口（守卫与门禁）')
  })

  it('缺口 ④：docs/DESIGN.md 完整记载 UI_WHITELIST 全部 17 项参数、范围与默认值，且与源码一致', () => {
    const designDoc = fs.readFileSync(path.join(ROOT, 'docs/DESIGN.md'), 'utf8')
    const defaults = new SettingsRepository().get()

    expect(UI_WHITELIST.length).toBeGreaterThanOrEqual(17)

    for (const spec of UI_WHITELIST) {
      // 1. 参数名与中文说明必须在契约表中
      expect(designDoc, `DESIGN.md 缺少参数 ${spec.key}`).toContain(`| \`${spec.key}\` |`)
      expect(designDoc, `DESIGN.md 缺少参数 ${spec.key} 的说明 ${spec.desc}`).toContain(spec.desc)

      // 2. 类型与合法范围必须在契约表中
      if (spec.kind === 'enum') {
        expect(designDoc, `DESIGN.md 缺少枚举 ${spec.key} 的可选值`).toContain(spec.values.join(' / '))
      } else if (spec.kind === 'number') {
        expect(designDoc, `DESIGN.md 缺少数值 ${spec.key} 的范围`).toContain(`${spec.min}~${spec.max}`)
      }

      // 3. 默认值必须与 SettingsRepository 默认值一致
      const defaultVal = defaults[spec.key]
      const expectedDefaultStr = defaultVal === null ? '`null`' : `\`${String(defaultVal)}\``
      const rowLine = designDoc
        .split(/\r?\n/)
        .find((line) => line.includes(`| \`${spec.key}\` |`))
      expect(rowLine, `找不到 ${spec.key} 的表格行`).toBeTruthy()
      expect(rowLine, `${spec.key} 的默认值与 SettingsRepository 不一致`).toContain(expectedDefaultStr)
    }

    // 4. 覆盖陷阱（bgOpacityOverride 与 floatBallColor 的 null 跟随语义）必须写明
    expect(designDoc).toContain('覆盖陷阱')
    expect(designDoc).toContain('--frosted-bg-opacity')
    expect(designDoc).toContain('UI_EXCLUDED')
  })
})
