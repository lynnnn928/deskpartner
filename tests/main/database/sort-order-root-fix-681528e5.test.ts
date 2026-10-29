/**
 * B 组治根：`sort_order` 的来源从「条数」改成 `MAX+1`（卡 `681528e5`）
 *
 * ## 它治的病
 *
 * 新建分类 / 项目时，`sort_order` 取的是**当前条数**：
 *
 * | 位置 | 旧写法 |
 * |---|---|
 * | `commands.ts`（`category add`） | `sortOrder: cats.length` |
 * | `CategorySection.tsx`（设置页新建） | `sortOrder: categories.length` |
 * | `project.repository.ts`（`create` 默认值） | `input.sortOrder ?? this.list().length` |
 *
 * 条数不是"末尾"。删掉或合并掉一个之后，条数会退回**已经用过的值** ——
 * 新条目就和老条目**撞序**，此后列表顺序由 SQLite 的隐式行为定：
 * 分类顺序、项目清单（新建事项的候选）都会抖。
 *
 * 治根的做法：默认值放在**写语句里**算（`COALESCE(?, (SELECT MAX(sort_order)+1))`）——
 * 一条语句内完成，不与并发写打架；传了值仍照传的来（备份导入要保住原顺序）；
 * 返回值**回读**入库后的真实值。
 *
 * ## 读的那一侧也要兜底
 *
 * 历史库里**已经**有撞值的行，只修写入修不了老数据。所以
 * `category.list()` 与 `project.list()` 的 `sort_order` 排序都补了 `, id ASC`。
 *
 * ## 本文件怎么证明"以前是错的"
 *
 * 治根那几条在旧写法下必然红（条数会给出与已有值相同的数）；读那几条都跑
 * **两种插入序**要求结论一致 —— 改前两种插入序结果不同。
 *
 * ⚠️ **只有 Top-N 那一条不判别**（注入实验测出来的，记在这里免得下次被它骗）：
 * `GROUP BY cmd, code ORDER BY n DESC` 的输出里，同票数的行**今天**就是按分组键
 * （cmd）升序出来的 —— 实测：先插 `todo rm` 再插 `project rm`，两类各 1 票时
 * 无兜底键的输出仍是 `project rm | todo rm`。所以摘掉兜底键，那条断言照样绿。
 * 它记录的是"我们要的顺序"，**真正把兜底键钉住的是同一文件里的源码闸门**。
 * 留着它的理由：顺序若要过别的实现（换 SQLite 版本 / 换执行计划）就会分叉，
 * 这条能立刻指出"输出顺序变了"。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TelemetryRepository } from '../../../src/main/database/telemetry.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

let categories: CategoryRepository
let projects: ProjectRepository
let telemetry: TelemetryRepository

describe('sort_order 治根（681528e5）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    db.exec('DELETE FROM usage_events')
    categories = new CategoryRepository()
    projects = new ProjectRepository()
    telemetry = new TelemetryRepository()
  })

  it('分类：删掉中间一个之后再建，取 MAX+1 而不是"条数"', () => {
    const a = categories.create({ name: '甲', color: '#1' })
    const b = categories.create({ name: '乙', color: '#2' })
    const c = categories.create({ name: '丙', color: '#3' })
    expect([a.sortOrder, b.sortOrder, c.sortOrder], '不传就是追加到末尾').toEqual([0, 1, 2])

    categories.delete(b.id)
    const d = categories.create({ name: '丁', color: '#4' })

    /** 旧写法给的是 2（= 当前条数），与「丙」撞序 */
    expect(d.sortOrder, '条数不是末尾：删过之后条数会退回用过的值').toBe(3)
    expect(
      categories.list().map((x) => x.sortOrder),
      '顺序值不许重复'
    ).toEqual([0, 2, 3])
  })

  it('分类：显式传 sortOrder 仍照办（备份导入要保住原顺序）', () => {
    const imported = categories.create({ name: '导入的', color: '#1', sortOrder: 7 })
    expect(imported.sortOrder).toBe(7)
    expect(imported, '返回值是回读出来的真实值').toMatchObject({ sortOrder: 7 })
    expect(categories.list().map((x) => x.sortOrder)).toEqual([7])
  })

  it('分类：历史数据撞序时，list() 按 id 稳定，且与插入序无关', () => {
    const insert = (id: string, name: string): void => {
      db.prepare(
        `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, '#1', 0, 5)`
      ).run(id, name)
    }

    /** 两条 sort_order 一模一样：这是历史数据的形态，读的一侧要能兜住 */
    insert('zz-cat', '乙')
    insert('aa-cat', '甲')
    expect(categories.list().map((x) => x.id), '同序时按 id 升序').toEqual(['aa-cat', 'zz-cat'])

    db.prepare('DELETE FROM categories').run()
    insert('aa-cat', '甲')
    insert('zz-cat', '乙')
    expect(categories.list().map((x) => x.id), '插入序反过来，结论必须一样').toEqual([
      'aa-cat',
      'zz-cat'
    ])
  })

  it('项目：删掉中间一个之后再建，取 MAX+1 而不是"条数"', () => {
    const a = projects.create({ name: '甲' })
    const b = projects.create({ name: '乙' })
    const c = projects.create({ name: '丙' })
    expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([0, 1, 2])

    projects.delete(b.id)
    const d = projects.create({ name: '丁' })

    expect(d.sortOrder, '条数不是末尾：删过之后条数会退回用过的值').toBe(3)
    expect(projects.list().map((x) => x.sortOrder)).toEqual([0, 2, 3])
  })

  it('项目：历史数据撞序时，list() 按 id 稳定，且与插入序无关', () => {
    const insert = (id: string, name: string): void => {
      db.prepare(
        `INSERT INTO projects (id, name, color, archived, sort_order, created_at, handoff_markdown)
         VALUES (?, ?, '#1', 0, 5, '2026-10-21T00:00:00.000Z', '')`
      ).run(id, name)
    }

    insert('zz-proj', '乙')
    insert('aa-proj', '甲')
    expect(projects.list().map((x) => x.id), '同序时按 id 升序').toEqual(['aa-proj', 'zz-proj'])

    db.prepare('DELETE FROM projects').run()
    insert('aa-proj', '甲')
    insert('zz-proj', '乙')
    expect(projects.list().map((x) => x.id), '插入序反过来，结论必须一样').toEqual([
      'aa-proj',
      'zz-proj'
    ])
  })

  it('项目：显式传 sortOrder 仍照办（备份导入要保住原顺序）', () => {
    const imported = projects.create({ name: '导入的', sortOrder: 9 })
    expect(imported.sortOrder).toBe(9)
    expect(projects.getById(imported.id)!.sortOrder, '库里存的与返回的一致').toBe(9)
  })

  it('Top-N：同票数时按命令名兜底（记录我们要的顺序；钉住它的是源码闸门）', () => {
    /**
     * 这里的行序**会传出去**：`stats()` 的结果按行序建 `byCmd` / `byErrorCode`，
     * JSON 的键顺序就是它 —— 同票数时谁在前，不该由 SQLite 的心情定。
     *
     * ⚠️ 本用例**不判别**（见文件头）：SQLite 今天给出的同票数顺序本就是按 cmd 升序
     * （分组先按分组键排出，`ORDER BY n DESC` 的排序在同票上保持了这个顺序），
     * 所以摘掉兜底键这条照样绿。它守的是"输出顺序变了要有人知道"。
     */
    const seed = (cmds: string[]): void => {
      db.exec('DELETE FROM usage_events')
      for (const cmd of cmds) {
        telemetry.record({
          sessionId: 's1',
          actor: 'human',
          surface: 'cli',
          category: 'cli',
          event: 'invoke',
          ok: false,
          durationMs: null,
          props: { cmd, errorCode: 'usage_error' }
        })
      }
    }
    const keys = (): string[] => Object.keys(telemetry.stats().errors.byCmd)

    seed(['todo rm', 'project rm'])
    expect(keys(), '同票数（各 1 次）时按命令名升序').toEqual(['project rm', 'todo rm'])

    seed(['project rm', 'todo rm'])
    expect(keys(), '插入序反过来，结论必须一样').toEqual(['project rm', 'todo rm'])
  })

  it('源码闸门：默认值只有一个来源，三处子句都带兜底键', () => {
    const categorySrc = read('src/main/database/category.repository.ts')
    const projectSrc = read('src/main/database/project.repository.ts')
    const telemetrySrc = read('src/main/database/telemetry.repository.ts')

    /** 治根：默认值在写语句里算 */
    for (const [name, src] of [
      ['category.repository.ts', categorySrc],
      ['project.repository.ts', projectSrc]
    ] as [string, string][]) {
      expect(src, `${name}: sort_order 的默认值必须由写语句取 MAX+1`).toContain(
        'COALESCE(?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM'
      )
    }

    /** 读：三处子句都带兜底次序键 */
    expect(categorySrc).toContain('ORDER BY sort_order ASC, id ASC')
    expect(projectSrc).toContain('ORDER BY archived ASC, sort_order ASC, id ASC')
    expect(telemetrySrc, '同票数的 Top-N 要按名字兜底').toContain(
      'GROUP BY cmd, code ORDER BY n DESC, cmd ASC, code ASC'
    )

    /**
     * 全仓不再有"自己算条数当顺序"的写法。
     * 注释行先剥掉：卡号说明里就写着 `cats.length` 这个词，不该被判违规。
     */
    const bad: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        read(path.relative(root, full).replace(/\\/g, '/'))
          .split(/\r?\n/)
          .forEach((line, i) => {
            const t = line.trim()
            if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
            if (/sortOrder:[^\n]*\.length/.test(line)) {
              bad.push(`${path.relative(root, full).replace(/\\/g, '/')}:${i + 1}`)
            }
          })
      }
    }
    walk(path.join(root, 'src'))
    expect(bad, '默认值只有一个来源：别再拿条数当顺序').toEqual([])
  })
})
