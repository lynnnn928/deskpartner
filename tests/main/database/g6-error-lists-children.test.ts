import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * G6 报错要说出是哪几个子卡（1.0.65，修 `c1d69263`）
 *
 * 此前只报"还有 N 个子任务未完成"。批量清账时（实测一次关 30 张卡），
 * 那正是最需要知道"该动哪几张"的时刻 —— 而要再跑一次 `todo children` 才看得到。
 *
 * 判据：**报错要给出下一步能直接用的信息，不是让人再查一遍。**
 * 与 `cd854e3a`（默认口径要自报）、batch 的 `executed:false` 同源：
 * **出口要说清它到底做了什么、没做什么。**
 */
describe('G6 报错列出子卡（c1d69263）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    todos = new TodoRepository()
  })

  const parent = () => todos.create({ title: '父卡', projectId: null, status: 'in_progress' } as never)

  const errOf = (fn: () => void): string => {
    try {
      fn()
    } catch (e) {
      return (e as Error).message
    }
    throw new Error('预期被 G6 拦下，但它放过了')
  }

  it('报错里带出子卡的 id 前缀', () => {
    const p = parent()
    const kid = todos.create({ title: '写文档', projectId: null, parentId: p.id } as never)
    const msg = errOf(() => todos.update({ id: p.id, status: 'done' }))
    expect(msg).toContain(kid.id.slice(0, 8))
  })

  it('报错里带出子卡标题（只有 id 的话还得再查一次）', () => {
    const p = parent()
    todos.create({ title: '写那份文档', projectId: null, parentId: p.id } as never)
    const msg = errOf(() => todos.update({ id: p.id, status: 'done' }))
    expect(msg).toContain('写那份文档')
  })

  it('带出子卡状态：awaiting_review 与 todo 该做的事不同', () => {
    const p = parent()
    todos.create({ title: '已交付待验收', projectId: null, parentId: p.id, status: 'awaiting_review' } as never)
    todos.create({ title: '还没动手', projectId: null, parentId: p.id, status: 'todo' } as never)
    const msg = errOf(() => todos.update({ id: p.id, status: 'done' }))
    expect(msg).toContain('awaiting_review')
    expect(msg).toContain('todo')
  })

  it('多个子卡都列出来（不是一个）', () => {
    const p = parent()
    for (const t of ['子一', '子二', '子三']) {
      todos.create({ title: t, projectId: null, parentId: p.id } as never)
    }
    const msg = errOf(() => todos.update({ id: p.id, status: 'done' }))
    expect(msg).toContain('子一')
    expect(msg).toContain('子二')
    expect(msg).toContain('子三')
    expect(msg).toContain('3 个')
  })

  it('超过 10 条时截断并指路（报错不该变成一屏清单）', () => {
    const p = parent()
    for (let i = 0; i < 14; i++) {
      todos.create({ title: `子${i}`, projectId: null, parentId: p.id } as never)
    }
    const msg = errOf(() => todos.update({ id: p.id, status: 'done' }))
    expect(msg).toContain('14 个')
    expect(msg).toContain('另有 4 条')
    expect(msg).toContain('todo children')
  })

  it('子卡全 done 时不拦（别把正常路径也堵了）', () => {
    const p = parent()
    const kid = todos.create({ title: '做完了', projectId: null, parentId: p.id, status: 'done' } as never)
    expect(() => todos.update({ id: p.id, status: 'done' })).not.toThrow()
    expect(todos.getById(p.id)!.status).toBe('done')
    expect(kid.status).toBe('done')
  })

  it('仍然拦得住（加了详情不等于放行）', () => {
    const p = parent()
    todos.create({ title: '还没做', projectId: null, parentId: p.id } as never)
    expect(() => todos.update({ id: p.id, status: 'done' })).toThrow(/G6/)
  })
})
