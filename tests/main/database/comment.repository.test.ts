import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}))

/**
 * 事项评论（schema v23）：把"往来"从 description 里剥出来。
 *
 * 覆盖：写入/读取、楼中楼回复、计数、以及**级联清理**——
 * 事项被删时评论要跟着走（否则留下指向空气的评论）。
 */
describe('CommentRepository（v23 事项评论）', () => {
  let comments: CommentRepository
  let todos: TodoRepository
  let todoId: string

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES ('c1', '工作', '#5388F6', 1, 0)"
    ).run()
    db.prepare(
      "INSERT INTO projects (id, name, color, archived, sort_order, created_at) VALUES ('p1', 'DeskPartner', '#5388F6', 0, 0, '2026-01-01T00:00:00.000Z')"
    ).run()
    uuidCounter = 0
    comments = new CommentRepository()
    todos = new TodoRepository()
    todoId = todos.create({ title: '被测事项', projectId: 'p1' }).id
  })

  it('创建评论：默认为普通评论、human 作者；空正文抛错', () => {
    const c = comments.create({ todoId, body: '  进度：已完成解析  ' })
    expect(c.body).toBe('进度：已完成解析') // 两端空白被裁掉
    expect(c.kind).toBe('comment')
    expect(c.authorType).toBe('human')
    expect(c.parentId).toBeNull()

    expect(() => comments.create({ todoId, body: '   ' })).toThrow()
  })

  it('agent 评论带 authorType/authorId；驳回评论带 kind=reject', () => {
    const c = comments.create({
      todoId,
      body: '按钮位置不对',
      authorType: 'agent',
      authorId: 'agent:bob',
      kind: 'reject'
    })
    expect(c.authorType).toBe('agent')
    expect(c.authorId).toBe('agent:bob')
    expect(c.kind).toBe('reject')
  })

  it('楼中楼：parentId 指向被回复的评论', () => {
    const top = comments.create({ todoId, body: '顶层评论' })
    const reply = comments.create({ todoId, body: '回复它', parentId: top.id })
    expect(reply.parentId).toBe(top.id)

    const list = comments.listByTodo(todoId)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(top.id) // 旧→新
    expect(list[1].parentId).toBe(top.id)
  })

  it('listByTodo 按事项隔离：别的事件的评论不会串进来', () => {
    const other = todos.create({ title: '另一条', projectId: 'p1' }).id
    comments.create({ todoId, body: 'A 的评论' })
    comments.create({ todoId: other, body: 'B 的评论' })

    expect(comments.listByTodo(todoId)).toHaveLength(1)
    expect(comments.listByTodo(todoId)[0].body).toBe('A 的评论')
  })

  it('countByTodo 与 countsByTodo（看板批量取数）口径一致', () => {
    const other = todos.create({ title: '另一条', projectId: 'p1' }).id
    comments.create({ todoId, body: '1' })
    comments.create({ todoId, body: '2' })
    comments.create({ todoId: other, body: '3' })

    expect(comments.countByTodo(todoId)).toBe(2)
    const counts = comments.countsByTodo([todoId, other])
    expect(counts[todoId]).toBe(2)
    expect(counts[other]).toBe(1)
    // 没有评论的事项不出现在映射里（调用方按 ?? 0 处理）
    const empty = todos.create({ title: '空', projectId: 'p1' }).id
    expect(comments.countsByTodo([empty])[empty]).toBeUndefined()
    expect(comments.countsByTodo([])).toEqual({})
  })

  it('删除单条评论；回复随父外键级联', () => {
    const top = comments.create({ todoId, body: '父' })
    comments.create({ todoId, body: '子', parentId: top.id })
    expect(comments.listByTodo(todoId)).toHaveLength(2)

    comments.remove(top.id)
    // 父删了，子靠 ON DELETE CASCADE 一起走 —— 不留孤儿
    expect(comments.listByTodo(todoId)).toHaveLength(0)
  })

  it('事项被删时评论级联清理（不留指向空气的评论）', () => {
    comments.create({ todoId, body: '会被带走' })
    expect(comments.countByTodo(todoId)).toBe(1)

    todos.delete(todoId)
    expect(comments.listByTodo(todoId)).toHaveLength(0)
  })

  it('removeByTodo 一次清空某条事项的评论', () => {
    comments.create({ todoId, body: '1' })
    comments.create({ todoId, body: '2' })
    expect(comments.removeByTodo(todoId)).toBe(2)
    expect(comments.countByTodo(todoId)).toBe(0)
  })

  /**
   * resolveId：CLI 的 `todo delete-comment <短号>` 靠它找回完整 id。
   *
   * 这里刻意断言"查不到返回 null"而不是空对象 —— 教训（f159d799）：
   * 凡是"查不到就静默返回空结果"的写操作，最后都会变成
   * "退出码 0 + 回执说成功 + 一条没删"的假成功。
   */
  it('resolveId 支持完整 id 与前缀', () => {
    const c = comments.create({ todoId, body: '目标' })
    expect(comments.resolveId(c.id)?.id).toBe(c.id)
    expect(comments.resolveId(c.id.slice(0, 8))?.id).toBe(c.id)
  })

  it('resolveId 查不到返回 null；空串同样', () => {
    expect(comments.resolveId('不存在的id')).toBeNull()
    expect(comments.resolveId('')).toBeNull()
  })

  it('resolveId 前缀命中多条时不猜（返回 null）', () => {
    // 造两条同前缀的 id：测试环境的 id 由 mock 决定，这里直接写库控制
    db.prepare(
      "INSERT INTO todo_comments (id, todo_id, parent_id, author_type, author_id, body, kind, created_at) VALUES ('dup-aaaa', ?, NULL, 'human', 'human', 'A', 'comment', '2026-01-01T00:00:00.000Z')"
    ).run(todoId)
    db.prepare(
      "INSERT INTO todo_comments (id, todo_id, parent_id, author_type, author_id, body, kind, created_at) VALUES ('dup-bbbb', ?, NULL, 'human', 'human', 'B', 'comment', '2026-01-01T00:00:01.000Z')"
    ).run(todoId)

    expect(comments.resolveId('dup-')).toBeNull()
    expect(comments.resolveId('dup-aaaa')?.body).toBe('A')
  })
})
