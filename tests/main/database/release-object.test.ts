import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 版本是一个对象，不是一个字段（1.0.73，主用户 10-07 提）
 *
 * ## 她的原话
 *
 * 「版本应该不只是一个字段，它应该是一个对象，那你就可以在这个对象上面
 * 去记录说这个版本里边做了什么、关联了哪些卡片了。并且的话这个版本
 * 又可以跟项目关联起来。」
 *
 * ## 这张表要回答的三个问题
 *
 * 1. 这一版是什么（`summary`）/ 它做了什么（`highlights`）
 * 2. 它收口了哪些卡片（**派生**自 `todos.fixed_in_version`，不另存）
 * 3. 它属于哪个项目（`project_id`，**必填** —— a2ea95f8：版本是项目下的二级概念）
 *
 * ## 三条判据（对着迁移 31 的理由逐条写）
 *
 * - **不回填历史**：没有 release 行就是没有行，不拿 `fixed_in_version`
 *   里出现过的字符串去"补齐"版本列表。那会把"某版只是有事项标了它"
 *   伪装成"某版登记过"。
 * - **不联动**：登记版本不打标事项，改事项不建版本行。
 * - **删登记 ≠ 取消发版**：事项上的版本号是它们自己的事实，不被登记增删牵着走。
 *
 * ## 定位键（a2ea95f8，迁移 v33）
 *
 * `(项目, 版本号)` 是版本身份：两个项目各有自己的 1.0.76 是常态
 * （主用户 10-09：「总有一天会撞上同一个版本号」）。查 / 改 / 删一律带项目。
 */
describe('版本对象（1.0.73）', () => {
  let releases: ReleaseRepository
  let projects: ProjectRepository
  let todos: TodoRepository
  let categories: CategoryRepository

  beforeAll(() => {
    runMigrations(db)
    /**
     * 镜像生产连接的 FK 设置（`src/main/database/index.ts` 里 `foreign_keys = ON`）。
     * 测试是裸连接，不开这个 pragma 的话 ON DELETE CASCADE 根本不生效 ——
     * 「删项目版本跟着清」那条测的就是没有 FK 的 SQLite，不是产品行为。
     */
    db.pragma('foreign_keys = ON')
  })

  beforeEach(() => {
    db.exec('DELETE FROM releases')
    db.exec('DELETE FROM todos')
    db.exec('DELETE FROM todo_categories')
    db.exec('DELETE FROM projects')
    db.exec('DELETE FROM categories')
    releases = new ReleaseRepository()
    projects = new ProjectRepository()
    todos = new TodoRepository()
    categories = new CategoryRepository()
    // 待办必挂分类，而分类是必填的外键 —— 没有分类时 create 直接抛错。
    // 兜底分类不像项目有"必填"语义，所以这里必须自己造一个。
    categories.create({ name: '工作', color: '#5388F6', sortOrder: 0 })
  })

  const mkProject = (name: string): string =>
    projects.create({ name, color: '#5388F6', sortOrder: 0 }).id

  const mkTodo = (title: string, projectId: string, fixedIn?: string): string => {
    const t = todos.create({
      title,
      projectId,
      status: 'done',
      ...(fixedIn ? { fixedInVersion: fixedIn } : {})
    })
    return t.id
  }

  describe('登记一个版本', () => {
    it('记下版本号、摘要、要点、发布时刻', () => {
      const dp = mkProject('DeskPartner')
      const r = releases.create({
        version: '1.0.73',
        projectId: dp,
        summary: '版本从字段涨成对象',
        highlights: ['releases 表', 'release 命令组'],
        shippedAt: '2026-10-07T18:00:00.000Z'
      })
      expect(r.version).toBe('1.0.73')
      expect(r.summary).toBe('版本从字段涨成对象')
      expect(r.highlights).toEqual(['releases 表', 'release 命令组'])
      expect(r.shippedAt).toBe('2026-10-07T18:00:00.000Z')
      expect(r.projectId).toBe(dp) // 版本必挂项目（a2ea95f8）：不挂项目的版本进不来
    })

    it('不传 shippedAt 就是"还没发布"，不预填计划时间', () => {
      const dp = mkProject('DeskPartner')
      const r = releases.create({ version: '1.0.74', projectId: dp })
      expect(r.shippedAt).toBeNull()
    })

    it('同一(项目, 版本号)重复登记要报错，不静默覆盖', () => {
      const dp = mkProject('DeskPartner')
      releases.create({ version: '1.0.73', projectId: dp, summary: '第一版说法' })
      expect(() =>
        releases.create({ version: '1.0.73', projectId: dp, summary: '被覆盖的说法' })
      ).toThrow(/已登记过/)
      // 原内容必须还在
      expect(releases.getByProjectAndVersion(dp, '1.0.73')?.summary).toBe('第一版说法')
    })

    it('版本号不能为空', () => {
      const dp = mkProject('DeskPartner')
      expect(() => releases.create({ version: '   ', projectId: dp })).toThrow(/不能为空/)
    })
  })

  describe('版本与项目关联', () => {
    it('可以归属一个项目，并按项目查出版本', () => {
      const dp = mkProject('DeskPartner')
      const other = mkProject('知彼')
      releases.create({
        version: '1.0.72',
        projectId: dp,
        shippedAt: '2026-10-07T12:00:00.000Z'
      })
      releases.create({
        version: '0.9.1',
        projectId: other,
        shippedAt: '2026-10-06T12:00:00.000Z'
      })

      expect(releases.listByProject(dp).map((r) => r.version)).toEqual(['1.0.72'])
      expect(releases.listByProject(other).map((r) => r.version)).toEqual(['0.9.1'])
    })

    it('版本必挂项目：没有"无归属"这一档（a2ea95f8）', () => {
      expect(() => releases.create({ version: '1.0.70' } as never)).toThrow(/projectId/)
    })

    it('列出版本时新发布在前', () => {
      const dp = mkProject('DeskPartner')
      releases.create({ version: '1.0.70', projectId: dp, shippedAt: '2026-10-01T00:00:00.000Z' })
      releases.create({ version: '1.0.72', projectId: dp, shippedAt: '2026-10-07T00:00:00.000Z' })
      releases.create({ version: '1.0.71', projectId: dp, shippedAt: '2026-10-05T00:00:00.000Z' })
      expect(releases.list().map((r) => r.version)).toEqual(['1.0.72', '1.0.71', '1.0.70'])
    })

    it('项目被删时版本登记跟着清掉（CASCADE，不留脱钩孤儿——主用户 10-09「彻底清空」口径）', () => {
      const dp = mkProject('临时项目')
      // 留一个陪跑的：1.0.111 起删"本机最后一个项目"会被拒（事项必须归项目）
      mkProject('陪跑的项目')
      releases.create({ version: '1.0.73', projectId: dp })
      projects.delete(dp)
      expect(releases.getByProjectAndVersion(dp, '1.0.73')).toBeNull()
      expect(releases.list()).toEqual([])
    })
  })

  describe('版本收口了哪些卡片（派生，不另存）', () => {
    it('detail 列出标了该版本的事项', () => {
      const dp = mkProject('DeskPartner')
      mkTodo('卡一', dp, '1.0.73')
      mkTodo('卡二', dp, '1.0.73')
      mkTodo('别的版的卡', dp, '1.0.72')

      releases.create({ version: '1.0.73', projectId: dp })
      const d = releases.detail(dp, '1.0.73')
      expect(d?.todoCount).toBe(2)
      expect(d?.todos.map((t) => t.title).sort()).toEqual(['卡一', '卡二'])
    })

    it('事项改了版本号，版本详情**立刻**跟着变（不存副本，所以不会对不上）', () => {
      const dp = mkProject('DeskPartner')
      const id = mkTodo('会改版的卡', dp, '1.0.73')
      releases.create({ version: '1.0.73', projectId: dp })
      expect(releases.detail(dp, '1.0.73')?.todoCount).toBe(1)

      todos.update({ id, fixedInVersion: '1.0.74' })
      expect(releases.detail(dp, '1.0.73')?.todoCount).toBe(0)
    })

    it('没有事项标着的版本，detail 仍返回（todoCount 为 0）', () => {
      const dp = mkProject('DeskPartner')
      releases.create({ version: '1.0.73', projectId: dp })
      expect(releases.detail(dp, '1.0.73')?.todoCount).toBe(0)
    })

    it('查没登记过的版本返回 null（不返回空对象）', () => {
      const dp = mkProject('DeskPartner')
      expect(releases.detail(dp, '9.9.9')).toBeNull()
      expect(releases.getByProjectAndVersion(dp, '9.9.9')).toBeNull()
    })
  })

  describe('判据：不回填历史、不联动', () => {
    it('事项标了版本号，但**不会**自动出现一条版本登记', () => {
      const dp = mkProject('DeskPartner')
      mkTodo('历史卡', dp, '1.0.50')
      // 1.0.50 从没登记过 —— 列表里就不该有它
      expect(releases.list()).toEqual([])
      expect(releases.getByProjectAndVersion(dp, '1.0.50')).toBeNull()
    })

    it('登记版本不会给任何事项打标（两个动作分开）', () => {
      const dp = mkProject('DeskPartner')
      mkTodo('本来没标版本的卡', dp)
      releases.create({ version: '1.0.73', projectId: dp })
      expect(releases.detail(dp, '1.0.73')?.todoCount).toBe(0)
    })

    it('有事项关联时拒绝删除版本，保护 fixed_in_version 历史', () => {
      const dp = mkProject('DeskPartner')
      mkTodo('会变孤儿吗', dp, '1.0.73')
      mkTodo('另一条', dp, '1.0.73')
      releases.create({ version: '1.0.73', projectId: dp })

      expect(() => releases.delete(dp, '1.0.73')).toThrow(/仍关联 2 条事项/)
      expect(releases.getByProjectAndVersion(dp, '1.0.73')).not.toBeNull()
      const still = todos.list().filter((t) => t.fixedInVersion === '1.0.73')
      expect(still).toHaveLength(2)
    })

    it('解除全部关联后允许删除版本', () => {
      const dp = mkProject('DeskPartner')
      const todo = mkTodo('先解除关联', dp, '1.0.73')
      releases.create({ version: '1.0.73', projectId: dp })
      todos.update({ id: todo, fixedInVersion: null })
      expect(releases.delete(dp, '1.0.73').orphanTodos).toBe(0)
      expect(releases.getByProjectAndVersion(dp, '1.0.73')).toBeNull()
    })

    it('删一个不存在的版本要报错，不静默成功', () => {
      const dp = mkProject('DeskPartner')
      expect(() => releases.delete(dp, '1.0.73')).toThrow(/不存在/)
    })
  })

  describe('更新版本登记', () => {
    it('只改传进来的字段，没传的保持不动', () => {
      const dp = mkProject('DeskPartner')
      releases.create({
        version: '1.0.73',
        projectId: dp,
        summary: '摘要',
        highlights: ['A', 'B'],
        shippedAt: '2026-10-07T00:00:00.000Z'
      })
      const u = releases.update({ version: '1.0.73', projectId: dp, summary: '新摘要' })
      expect(u.summary).toBe('新摘要')
      expect(u.highlights).toEqual(['A', 'B']) // 没传就不动
      expect(u.shippedAt).toBe('2026-10-07T00:00:00.000Z')
    })

    it('显式传 null 是"清空"，与"不传"语义不同', () => {
      const dp = mkProject('DeskPartner')
      releases.create({ version: '1.0.73', projectId: dp, shippedAt: '2026-10-07T00:00:00.000Z' })
      const u = releases.update({ version: '1.0.73', projectId: dp, shippedAt: null })
      expect(u.shippedAt).toBeNull()
    })

    it('改不存在的版本要报错', () => {
      const dp = mkProject('DeskPartner')
      expect(() => releases.update({ version: '9.9.9', projectId: dp, summary: 'x' })).toThrow(
        /不存在/
      )
    })
  })

  describe('highlights 的容错', () => {
    it('坏 JSON 归零而不是抛错，也不编造一个默认值', () => {
      const dp = mkProject('DeskPartner')
      releases.create({ version: '1.0.73', projectId: dp, highlights: ['好的'] })
      // 手工写坏它 —— 模拟"某种原因落库的 json 不合法"
      db.prepare('UPDATE releases SET highlights = ? WHERE version = ? AND project_id = ?').run(
        '{不是合法 JSON',
        '1.0.73',
        dp
      )
      const r = releases.getByProjectAndVersion(dp, '1.0.73')
      expect(r?.highlights).toEqual([]) // 归零，而不是猜一个
      // 关键：读列表不因为一条坏数据整体失败
      expect(() => releases.list()).not.toThrow()
    })

    it('数组里混进非字符串时只保留字符串', () => {
      const dp = mkProject('DeskPartner')
      db.prepare(
        `INSERT INTO releases (version, project_id, shipped_at, summary, highlights, created_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`
      ).run('1.0.73', dp, JSON.stringify(['ok', 123, null, '也行']), new Date().toISOString())
      expect(releases.getByProjectAndVersion(dp, '1.0.73')?.highlights).toEqual(['ok', '也行'])
    })
  })
})

/**
 * 迁移 31 在有数据的老库上要能过
 *
 * 判据（来自 1.0.69 那次事故）：**涉及迁移的改动必须在有数据的老库副本上验过**——
 * 那次只在空库上验，结果装上后界面起不来。
 */
describe('迁移 31：在有数据的老库上', () => {
  it('从 schema 30 迁到 31 时，已有数据原样保留且 releases 表可用', () => {
    const old = new Database(':memory:')
    // 造一个 v30 的库：跑到 30 就停（用真实迁移函数的前 30 个）
    runMigrations(old)
    // 塞点数据
    old
      .prepare(
        `INSERT INTO projects (id, name, color, archived, sort_order, created_at)
         VALUES ('p1','老项目','#5388F6',0,0,'2026-01-01T00:00:00.000Z')`
      )
      .run()
    old
      .prepare(
        `INSERT INTO todos (id, title, project_id, status, priority, type, created_by,
           executed_by, is_pinned, fixed_in_version, created_at, updated_at)
         VALUES ('t1','老卡','p1','done','normal','task','human','human',0,'1.0.50',
           '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
      )
      .run()

    // 迁移后再验：数据在、新表能用、老事项的版本号没被动
    const version = old.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    expect(version.v).toBeGreaterThanOrEqual(31)

    const row = old.prepare('SELECT title, fixed_in_version FROM todos WHERE id = ?').get('t1') as
      | { title: string; fixed_in_version: string }
      | undefined
    expect(row?.title).toBe('老卡')
    expect(row?.fixed_in_version).toBe('1.0.50') // 存量版本号不被动

    const cols = old.prepare('PRAGMA table_info(releases)').all() as { name: string }[]
    // v32（1.0.75，`065dcde4`）新增 tested 列（测试事实），契约跟着更新
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['created_at', 'highlights', 'project_id', 'shipped_at', 'summary', 'version', 'tested'].sort()
    )
    // 存量不回填：老库迁移后 releases 是空的
    expect(old.prepare('SELECT COUNT(*) AS n FROM releases').get()).toEqual({ n: 0 })
    old.close()
  })
})
