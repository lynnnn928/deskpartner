import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { runMigrations } from '../../../src/main/database/migrations'
import { DEFAULT_CATEGORIES } from '../../../src/renderer/lib/constants'

// Mock getDatabase
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

// Mock uuid
let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `cat-uuid-${++uuidCounter}`
}))

describe('CategoryRepository', () => {
  let repo: CategoryRepository

  beforeAll(() => {
    /**
     * 走真实迁移，不要在这里手写 schema 副本。
     *
     * 两个理由：
     * 1. 删除分类会读写 todos 表（把待办迁到默认分类），手写副本根本建不出那张表
     * 2. 迁移加字段时副本不会跟着变 —— todo.repository.test.ts 曾因同样的写法
     *    在迁移 v5 后一次挂掉 22 个用例
     * schema 只应有一处真相，测试也不例外。
     */
    runMigrations(db)
  })

  beforeEach(() => {
    // 先清 todos：删除分类会读写它，残留数据会串到下一个用例
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    uuidCounter = 0
    repo = new CategoryRepository()
  })

  describe('create()', () => {
    it('should create a category with isDefault=false', () => {
      const cat = repo.create({ name: 'Test', color: '#FF0000', sortOrder: 0 })

      expect(cat.id).toBe('cat-uuid-1')
      expect(cat.name).toBe('Test')
      expect(cat.color).toBe('#FF0000')
      expect(cat.isDefault).toBe(false)
      expect(cat.sortOrder).toBe(0)
    })
  })

  describe('update()', () => {
    it('should update name and color', () => {
      const cat = repo.create({ name: 'Old', color: '#FF0000', sortOrder: 0 })
      const updated = repo.update(cat.id, { name: 'New', color: '#00FF00' })

      expect(updated.name).toBe('New')
      expect(updated.color).toBe('#00FF00')
    })

    it('should throw when updating non-existent id', () => {
      expect(() => repo.update('non-existent', { name: 'Nope' })).toThrow(/分类不存在/)
    })

    it('should keep existing values when only partial update', () => {
      const cat = repo.create({ name: 'Original', color: '#FF0000', sortOrder: 0 })
      const updated = repo.update(cat.id, { name: 'Changed' })

      expect(updated.name).toBe('Changed')
      expect(updated.color).toBe('#FF0000')
    })
  })

  describe('delete()', () => {
    it('should delete non-default category', () => {
      const cat = repo.create({ name: 'Custom', color: '#FF0000', sortOrder: 0 })
      const result = repo.delete(cat.id)

      expect(repo.getById(cat.id)).toBeNull()
      expect(result.affectedTodos).toBe(0)
    })

    it('should keep the todo itself when removing one of its tags', () => {
      /**
       * v9 起分类是多值的：删掉一个标签，待办本身必须照常存在
       * （它可能还带着别的标签）。关联记录由外键 CASCADE 清掉。
       *
       * 对比 v9 之前：单值 + NOT NULL，删分类必然失败，所以要先迁移待办。
       */
      const custom = repo.create({ name: 'Custom', color: '#FF0000', sortOrder: 1 })

      const now = new Date().toISOString()
      db.prepare(
        // v9 起 todos 表已无 category_id 列，标签走 todo_categories
        // v12 起多了 type / created_by（owner 列退役）
        `INSERT INTO todos (id, title, description, status, priority, type, created_by,
                            due_at, remind_at, is_pinned, created_at, updated_at, completed_at)
         VALUES (?, ?, NULL, 'todo', 'normal', 'task', 'human', NULL, NULL, 0, ?, ?, NULL)`
      ).run('todo-1', '有条任务', now, now)
      db.prepare(
        'INSERT INTO todo_categories (todo_id, category_id) VALUES (?, ?)'
      ).run('todo-1', custom.id)

      const result = repo.delete(custom.id)

      // 返回受影响条数，调用方才能告诉用户"哪些待办少了这个标签"
      expect(result.affectedTodos).toBe(1)
      expect(repo.getById(custom.id)).toBeNull()

      // 待办还在
      const todo = db.prepare('SELECT id FROM todos WHERE id = ?').get('todo-1') as
        | { id: string }
        | undefined
      expect(todo?.id).toBe('todo-1')

      // 关联已随 CASCADE 清掉
      const link = db
        .prepare('SELECT 1 AS x FROM todo_categories WHERE todo_id = ?')
        .get('todo-1') as { x: number } | undefined
      expect(link).toBeUndefined()
    })

    it('should delete an unused category even when it is the only one', () => {
      // 库里唯一分类且没有待办用它时应该删得掉，
      // 否则会出现"库明明是空的、却删不掉分类"的怪现象
      const only = repo.create({ name: 'OnlyOne', color: '#000000', sortOrder: 0 })
      const result = repo.delete(only.id)

      expect(result.affectedTodos).toBe(0)
      expect(repo.getById(only.id)).toBeNull()
    })

    it('should throw when deleting default category', () => {
      db.prepare(
        `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
      ).run('default-cat', 'Default', '#FF0000', 1, 0)

      expect(() => repo.delete('default-cat')).toThrow(/系统默认分类不可删除/)
    })

    /**
     * ⚠️ 这条用例 1.0.48 起**语义反转**（原为 `should silently return…`）。
     *
     * 旧行为是"查不到就返回 affectedTodos: 0，不报错"，看着宽容，
     * 实际制造了假成功 —— Bob实测（f159d799）：它按看板上的 8 位短号
     * 发 `category rm`，四条全部走完授权流程、授权被记成 consumed、
     * 回执说成功，而**分类一个都没少**。
     *
     * 三重欺骗叠在一起：agent 以为完事、人以为点了允许就生效、
     * 审计账面上授权已经用掉。假成功比报错贵得多，所以改为抛错。
     */
    it('should throw when deleting non-existent id（不再静默假成功）', () => {
      expect(() => repo.delete('non-existent')).toThrow(/分类不存在/)
    })

    /**
     * 短号必须能删（1.0.48 修，同 f159d799 的根因）。
     *
     * 卡片/看板上显示的是 8 位短号，agent 自然会拿它来发命令；
     * 而 delete 原先走 getById 精确匹配 —— 短号查不到。
     */
    it('should delete by id prefix（短号可直接喂命令）', () => {
      db.prepare(
        `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
      ).run('c8fbebbe-1234-5678-9abc-def012345678', '短号靶子', '#1', 0, 0)

      const result = repo.delete('c8fbebbe')
      expect(result.affectedTodos).toBe(0)
      expect(repo.getById('c8fbebbe-1234-5678-9abc-def012345678')).toBeNull()
    })

    it('should throw when id prefix is ambiguous（不随便挑一个删）', () => {
      db.prepare(
        `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
      ).run('abcd1111-0000-0000-0000-000000000000', 'A', '#1', 0, 0)
      db.prepare(
        `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
      ).run('abcd2222-0000-0000-0000-000000000000', 'B', '#2', 0, 1)

      expect(() => repo.delete('abcd')).toThrow(/匹配到 2 个分类/)
      // 两条都还在 —— 歧义时绝不能删掉任何一条
      expect(repo.list().length).toBe(2)
    })

    it('should reject LIKE wildcards in prefix（防一次笔误删库）', () => {
      repo.create({ name: '唯一', color: '#1', sortOrder: 0 })
      // `%` 会拼成 LIKE '%%' 匹配全部行；库里恰好 1 条时旧实现会直接删掉它
      expect(() => repo.delete('%')).toThrow(/不能包含/)
      expect(repo.list().length).toBe(1)
    })
  })

  describe('list()', () => {
    it('should return categories ordered by sortOrder ASC', () => {
      repo.create({ name: 'Third', color: '#3', sortOrder: 2 })
      repo.create({ name: 'First', color: '#1', sortOrder: 0 })
      repo.create({ name: 'Second', color: '#2', sortOrder: 1 })

      const list = repo.list()
      expect(list).toHaveLength(3)
      expect(list[0].name).toBe('First')
      expect(list[1].name).toBe('Second')
      expect(list[2].name).toBe('Third')
    })
  })

  describe('reorder()', () => {
    it('should update sort order based on array index', () => {
      const c1 = repo.create({ name: 'A', color: '#1', sortOrder: 0 })
      const c2 = repo.create({ name: 'B', color: '#2', sortOrder: 1 })

      repo.reorder([c2.id, c1.id])

      const list = repo.list()
      expect(list[0].id).toBe(c2.id)
      expect(list[1].id).toBe(c1.id)
    })
  })

  describe('initializeDefaults()', () => {
    it('should insert default categories when database is empty', () => {
      repo.initializeDefaults()

      const list = repo.list()
      expect(list).toHaveLength(DEFAULT_CATEGORIES.length)
      list.forEach(cat => {
        expect(cat.isDefault).toBe(true)
      })
    })

    it('should not insert when categories already exist', () => {
      repo.create({ name: 'Existing', color: '#FF0000', sortOrder: 0 })
      const countBefore = repo.list().length

      repo.initializeDefaults()

      const countAfter = repo.list().length
      expect(countAfter).toBe(countBefore)
    })
  })
})
