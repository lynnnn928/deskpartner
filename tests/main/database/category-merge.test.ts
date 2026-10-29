import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `cat-uuid-${++uuidCounter}`
}))

/** 插一条待办；v9 起标签走 todo_categories，todos 表本身没有分类列 */
function insertTodo(id: string) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO todos (id, title, description, status, priority, type, created_by,
                        due_at, remind_at, is_pinned, created_at, updated_at, completed_at)
     VALUES (?, ?, NULL, 'todo', 'normal', 'task', 'human', NULL, NULL, 0, ?, ?, NULL)`
  ).run(id, `待办 ${id}`, now, now)
}

function tag(todoId: string, categoryId: string) {
  db.prepare(
    'INSERT OR IGNORE INTO todo_categories (todo_id, category_id) VALUES (?, ?)'
  ).run(todoId, categoryId)
}

function tagsOf(todoId: string): string[] {
  const rows = db
    .prepare('SELECT category_id FROM todo_categories WHERE todo_id = ? ORDER BY category_id')
    .all(todoId) as Array<{ category_id: string }>
  return rows.map((r) => r.category_id)
}

describe('CategoryRepository.merge()', () => {
  let repo: CategoryRepository

  beforeAll(() => {
    // 走真实迁移：schema 只应有一处真相，手写副本会在加字段后成片失效
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    uuidCounter = 0
    repo = new CategoryRepository()
  })

  it('把待办从源分类转挂到目标分类，并删掉源分类', () => {
    const a = repo.create({ name: '竞争调研', color: '#1', sortOrder: 0 })
    const b = repo.create({ name: '竞品调研', color: '#2', sortOrder: 1 })
    insertTodo('t1')
    tag('t1', a.id)

    const result = repo.merge(a.id, b.id)

    expect(result.movedTodos).toBe(1)
    expect(repo.getById(a.id)).toBeNull()
    expect(repo.getById(b.id)).not.toBeNull()
    expect(tagsOf('t1')).toEqual([b.id])
  })

  /**
   * 这条是合并最容易写错的地方。
   * 一条待办同时带着 A 和 B 时，转挂会撞上 (todo_id, category_id) 联合主键。
   * 用 INSERT 不加 OR IGNORE 会直接抛错，整个事务回滚 ——
   * 而这种"两边都挂着"的待办恰恰是合并时最常见的情形。
   */
  it('待办同时带着两个标签时不报错，也不会产生重复关联', () => {
    const a = repo.create({ name: 'A', color: '#1', sortOrder: 0 })
    const b = repo.create({ name: 'B', color: '#2', sortOrder: 1 })
    insertTodo('t1')
    tag('t1', a.id)
    tag('t1', b.id)

    expect(() => repo.merge(a.id, b.id)).not.toThrow()

    // 只剩目标标签，不能出现 [B, B]
    const tags = tagsOf('t1')
    expect(tags).toEqual([b.id])
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('待办带的其它标签不受影响', () => {
    const a = repo.create({ name: 'A', color: '#1', sortOrder: 0 })
    const b = repo.create({ name: 'B', color: '#2', sortOrder: 1 })
    const c = repo.create({ name: 'C', color: '#3', sortOrder: 2 })
    insertTodo('t1')
    tag('t1', a.id)
    tag('t1', c.id)

    repo.merge(a.id, b.id)

    expect(tagsOf('t1').sort()).toEqual([b.id, c.id].sort())
    // C 不该被牵连
    expect(repo.getById(c.id)).not.toBeNull()
  })

  it('待办本身不会被删掉，只是换标签', () => {
    const a = repo.create({ name: 'A', color: '#1', sortOrder: 0 })
    const b = repo.create({ name: 'B', color: '#2', sortOrder: 1 })
    insertTodo('t1')
    tag('t1', a.id)

    repo.merge(a.id, b.id)

    const todo = db.prepare('SELECT id FROM todos WHERE id = ?').get('t1')
    expect(todo).toBeDefined()
  })

  it('空分类也能合并，不报错', () => {
    const a = repo.create({ name: '没人用', color: '#1', sortOrder: 0 })
    const b = repo.create({ name: 'B', color: '#2', sortOrder: 1 })

    const result = repo.merge(a.id, b.id)

    expect(result.movedTodos).toBe(0)
    expect(repo.getById(a.id)).toBeNull()
  })

  it('不能合并到自己', () => {
    const a = repo.create({ name: 'A', color: '#1', sortOrder: 0 })
    expect(() => repo.merge(a.id, a.id)).toThrow(/不能把分类合并到它自己/)
  })

  it('源或目标不存在时报错，而不是静默成功', () => {
    const a = repo.create({ name: 'A', color: '#1', sortOrder: 0 })

    expect(() => repo.merge(a.id, '不存在')).toThrow(/目标分类不存在/)
    expect(() => repo.merge('不存在', a.id)).toThrow(/要合并的分类不存在/)
    // 失败的合并不能把源分类弄没了
    expect(repo.getById(a.id)).not.toBeNull()
  })

  it('系统默认分类不可被合并掉', () => {
    db.prepare(
      'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run('default-cat', '默认', '#1', 1, 0)
    const b = repo.create({ name: 'B', color: '#2', sortOrder: 1 })

    expect(() => repo.merge('default-cat', b.id)).toThrow(/系统默认分类不可被合并掉/)
    expect(repo.getById('default-cat')).not.toBeNull()
  })

  /**
   * 外键语义必须在用例内临时打开：单测默认 foreign_keys = OFF，
   * 关着时 CASCADE 根本不触发，测出来的"没删掉"是环境假象。
   */
  it('开启外键时，删除源分类不会连带删掉待办', () => {
    db.pragma('foreign_keys = ON')
    try {
      const a = repo.create({ name: 'A', color: '#1', sortOrder: 0 })
      const b = repo.create({ name: 'B', color: '#2', sortOrder: 1 })
      insertTodo('t1')
      tag('t1', a.id)

      repo.merge(a.id, b.id)

      const todo = db.prepare('SELECT id FROM todos WHERE id = ?').get('t1')
      expect(todo).toBeDefined()
      expect(tagsOf('t1')).toEqual([b.id])
    } finally {
      db.pragma('foreign_keys = OFF')
    }
  })
})
