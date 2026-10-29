import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { executeOne, EXIT_CODES } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const todoRepo = new TodoRepository()

/** 人在终端敲的 ctx：项目删除/归档都是人的动作，这里验命令自己回什么 */
function humanCtx() {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      memoRepo: { list: () => [], add: () => ({}), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: { get: () => null, list: () => [], touch: () => null },
      events: new EventsRepository(),
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 99,
      busyTimeoutMs: 5000,
      channels: ['headless'],
      via: 'headless',
      startedAt: Date.now()
    },
    interactive: true,
    actor: 'human'
  } as never
}

const run = (args: string[]) => executeOne(humanCtx(), args)

/**
 * `project rm` / `project archive` 的命令行契约（卡 `c177e466`）
 *
 * ## 为什么仓储层用例不够
 *
 * 仓储层管的是"删干净了没"，这一层管的是**调用方看到的入口变了没有**。
 * 1.0.111 的改动里有一条是**删参数**（`--to` 没了）—— 它是最容易被骂的那种改动：
 * 旧脚本还会照旧传 `--to`，如果命令"认识但不用"，就是**静默干了比意图更大的事**
 * （把整个项目删了，而调用方以为只是"迁走"）。所以这里钉的是"必须炸出来"。
 *
 * 口径来自主用户 2026-10-09：**界面优先建议归档；永久删除就清空，不保留。**
 */
describe('project rm / project archive 的命令行契约', () => {
  let doomed = ''
  let kept = ''

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    for (const t of ['todos', 'todo_comments', 'todo_categories', 'todo_transitions', 'notifications', 'projects', 'categories']) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    const cat = categoryRepo.create({ name: '默认', color: '#111', sortOrder: 0 })
    doomed = projectRepo.create({ name: '要删的项目' }).id
    kept = projectRepo.create({ name: '留着的项目' }).id
    todoRepo.create({ title: '要删的事', categoryIds: [cat.id], projectId: doomed } as never)
  })

  it('缺 --yes 直接报 usage_error，不替调用方猜', async () => {
    const r = await run(['project', 'rm', doomed])
    expect(r.ok).toBe(false)
    expect(r.code).toBe(EXIT_CODES.usage)
    expect(r.errorCode).toBe('usage_error')
    expect(r.message ?? '').toMatch(/--yes/)
    // 拒绝之后什么都没动
    expect(projectRepo.getById(doomed)).not.toBeNull()
  })

  it('旧的 --to 会被当成未知 flag 拒绝（设计变更要炸出来，不能静默扩大动作）', async () => {
    const r = await run(['project', 'rm', doomed, '--yes', '--to', '留着的项目'])
    expect(r.ok).toBe(false)
    expect(r.code).toBe(EXIT_CODES.usage)
    expect(projectRepo.getById(doomed), '不确定的参数下不许真删').not.toBeNull()
  })

  it('加 --yes 才删：回执逐表报数，别的项目一条不动', async () => {
    const r = await run(['project', 'rm', doomed, '--yes'])
    expect(r.ok).toBe(true)
    // ⚠️ 回执正文在 data.message 里（成功命令的 r.message 是空的）——
    // 别把 run() 的形状当回执形状
    const data = r.data as {
      deleted: string
      projectName: string
      removed: { todos: number }
      message: string
    }
    expect(data.deleted).toBe(doomed)
    expect(data.projectName).toBe('要删的项目')
    expect(data.removed.todos).toBe(1)
    expect(data.message).toContain('其他项目的数据没动')

    expect(projectRepo.getById(doomed)).toBeNull()
    expect(projectRepo.getById(kept)).not.toBeNull()
    expect(todoRepo.list().length).toBe(0)
  })

  it('归档 / 取消归档：同一件事的两半，数据一条不动', async () => {
    const archived = await run(['project', 'archive', doomed])
    expect(archived.ok).toBe(true)
    expect(projectRepo.getById(doomed)?.archived).toBe(true)
    expect(projectRepo.listActive().map((p) => p.id)).not.toContain(doomed)
    // 事项还在，随时可查
    expect(todoRepo.list().length).toBe(1)

    const back = await run(['project', 'unarchive', doomed])
    expect(back.ok).toBe(true)
    expect(projectRepo.getById(doomed)?.archived).toBe(false)
    expect(projectRepo.listActive().map((p) => p.id)).toContain(doomed)
  })

  it('最后一个项目：归档放行，永久删除拒绝（事项必须归项目）', async () => {
    // 先删掉陪跑的那个，只剩一个
    expect((await run(['project', 'rm', kept, '--yes'])).ok).toBe(true)

    const refused = await run(['project', 'rm', doomed, '--yes'])
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(EXIT_CODES.guard)
    expect(refused.message ?? '').toMatch(/最后一个项目/)
    expect(projectRepo.getById(doomed)).not.toBeNull()

    expect((await run(['project', 'archive', doomed])).ok).toBe(true)
    expect(projectRepo.getById(doomed)?.archived).toBe(true)
  })
})
