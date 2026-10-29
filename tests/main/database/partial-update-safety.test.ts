import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const dir = path.resolve('.tmp-check/partial-update-safety')
fs.mkdirSync(dir, { recursive: true })
const db = new Database(path.join(dir, `fixture-${process.pid}.db`))
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
let second: Database.Database

beforeAll(() => {
  runMigrations(db)
  db.pragma('journal_mode = WAL')
  new CategoryRepository().initializeDefaults()
  second = new Database(db.name)
  second.pragma('busy_timeout = 0')
})
afterAll(() => { second.close(); db.close() })

describe('局部字段写入与校验写锁', () => {
  it('改标题的 SQL 不带置顶、描述、状态等未提交字段', () => {
    const repo = new TodoRepository()
    const project = new ProjectRepository().create({ name: `SQL-${Date.now()}` })
    const t = repo.create({ title: '原题', projectId: project.id, description: '规格', isPinned: true })
    const prepare = vi.spyOn(db, 'prepare')
    try {
      repo.update({ id: t.id, title: '新题', actor: 'human' })
      const sql = prepare.mock.calls.map(([s]) => s).find((s) => s.startsWith('UPDATE todos SET'))!
      const set = sql.split(' WHERE ')[0]
      expect(set).toContain('title = ?')
      expect(set).not.toContain('is_pinned')
      expect(set).not.toContain('description')
      expect(set).not.toContain('status =')
      expect(repo.getById(t.id)).toMatchObject({ title: '新题', isPinned: true, description: '规格' })
    } finally { prepare.mockRestore() }
  })
  it('读取守卫快照时已持有写锁；另一连接不能插入修改，后续修改仍可保留双方字段', () => {
    const repo = new TodoRepository()
    const project = new ProjectRepository().create({ name: `并发-${Date.now()}` })
    const t = repo.create({ title: '原题', projectId: project.id })
    const read = repo.getById.bind(repo)
    let probed = false
    const spy = vi.spyOn(repo, 'getById').mockImplementation((id) => {
      const snapshot = read(id)
      if (!probed) {
        probed = true
        expect(() => second.prepare('UPDATE todos SET is_pinned = 1 WHERE id = ?').run(id)).toThrow(/locked|busy/i)
      }
      return snapshot
    })
    try { repo.update({ id: t.id, title: '新题', actor: 'human' }) }
    finally { spy.mockRestore() }
    expect(probed).toBe(true)
    second.prepare('UPDATE todos SET is_pinned = 1 WHERE id = ?').run(t.id)
    repo.update({ id: t.id, priority: 'high', actor: 'human' })
    expect(repo.getById(t.id)).toMatchObject({ title: '新题', isPinned: true, priority: 'high' })
  })
})
