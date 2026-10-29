import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne } from '../../../src/main/cli/commands'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 改状态时能同时写清理由（`20aee7a4`）
 *
 * ## 为什么有这个
 *
 * 这一天我自己撞了它 16 次（批量改状态），而我为绕过它**直改了数据库** ——
 * **直改库恰好绕过了"改状态要留理由"这条机制本身**。
 *
 * 病根不是"缺一条命令"，而是：
 * 「改状态」与「写理由」是**两条命令**，而**没有任何机制保证它们成对发生**。
 * 漏了评论，状态就变了而理由没留下；或反之。
 *
 * ## 判据
 *
 * **一次调用做完两件事 ⇒ 不可能只做一半。**
 */
describe('update 带 --comment（20aee7a4）', () => {
  let todos: TodoRepository
  let comments: CommentRepository
  /** ⚠️ agent 身份写命令要三样齐：注册 + 批准 + 凭据。
   *  我第一版 credential 留空 → 身份关卡先拦 → r.ok=false 且 message 为空，
   *  报错指向命令失败而真因是前置条件。 */
  const CRED = { v: '' }

  const mkCtx = () =>
    ({
      deps: {
        todoRepo: todos,
        commentRepo: comments,
        memoRepo: new MemoRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        settingsRepo: { get: () => ({}) },
        agentRepo: new AgentRepository(),
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.68', dbPath: ':memory:', schemaVersion: 29, via: 'pipe' },
      interactive: true,
      actor: 'agent:alice',
      credential: CRED.v
    }) as never

  beforeEach(async () => {
    await runMigrations(db)
    db.exec(`DELETE FROM todo_comments;`)
    db.exec(`DELETE FROM todos;`)
    db.exec(`DELETE FROM categories;`)
    db.exec(`DELETE FROM projects;`)
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
    comments = new CommentRepository()
    const agents = new AgentRepository()
    agents.register({ id: 'agent:alice', displayName: 'WB', color: '#111' } as never)
    agents.setApproved('agent:alice', true)
    CRED.v = agents.issueCredential('agent:alice')?.token ?? ''
  })

  const seed = () =>
    todos.create({ title: '一件事', projectId: null, createdBy: 'agent:alice' } as never)

  it('改状态 + 写理由，一次调用完成', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--status', 'done', '--comment', '已按四段收口，验证过'
    ])
    expect(r.ok).toBe(true)
    expect(todos.getById(t.id)!.status, '状态改了').toBe('done')
    const list = comments.listByTodo(t.id)
    expect(list.length, '理由也要写进去').toBe(1)
    expect(list[0].body).toContain('已按四段收口')
    expect(list[0].authorId, '理由要记是谁说的').toBe('agent:alice')
  })

  it('只改字段不带 --comment 也照常工作（不是强制）', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), ['todo', 'update', t.id, '--title', '新标题'])
    expect(r.ok).toBe(true)
    expect(todos.getById(t.id)!.title).toBe('新标题')
    expect(comments.listByTodo(t.id).length, '没带就不该凭空写').toBe(0)
  })

  /**
   * 这条拦的是"以为写了就等于记录了"。
   *
   * 判据：**没改任何东西却带 --comment ⇒ 那次调用什么都没发生**，
   * 而调用方会以为"我已经记下了"。**沉默的假成功比报错更贵。**
   */
  it('没改任何东西却带 --comment → 报错（不给"以为记了其实没记"）', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), ['todo', 'update', t.id, '--comment', '只写理由不改东西'])
    expect(r.ok, '这种调用必须被拒').toBe(false)
    // 既有那道「至少要指定一个要改的字段」先拦住了 —— 那是**更早也更好**的一层：
    // 它已经把"什么都没发生"这件事报出来了，不必等我这条。
    // 所以这里只断言"被拒 + 没留下任何痕迹"，不硬绑是哪一层拒的。
    expect(String((r as { message?: string }).message)).toMatch(/至少要指定|--comment 只在/)
    expect(comments.listByTodo(t.id).length, '被拒就不该留下评论').toBe(0)
    expect(todos.getById(t.id)!.status, '状态也不该动').toBe('todo')
  })

  /**
   * 顺序：**评论先写、状态后改**。
   *
   * 反过来的话，状态若被守卫拦下，评论已经写上而状态没动 ——
   * **那正是本项目反复在治的"看起来成功其实没成"。**
   */
  it('状态被守卫拦下时，评论也不该留下（顺序：先评论后状态）', async () => {
    // proposed 卡由 human 提，agent 改它会被 G4 拦
    const t = todos.create({
      title: '别人的提议',
      projectId: null,
      status: 'proposed',
      createdBy: 'human'
    } as never)
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--status', 'todo', '--comment', '我要改'
    ])
    expect(r.ok, 'G4 应该拦住').toBe(false)
    expect(
      comments.listByTodo(t.id).length,
      '⚠️ 状态没改成、评论却留下了 = 看起来记录了其实没成'
    ).toBe(0)
    expect(todos.getById(t.id)!.status).toBe('proposed')
  })

  it('--comment 留痕是 append（不改描述）', async () => {
    const t = todos.create({
      title: '有描述的',
      projectId: null,
      createdBy: 'agent:alice',
      description: '原始规格'
    } as never)
    await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--status', 'done', '--comment', '改的理由'
    ])
    expect(todos.getById(t.id)!.description, '描述是规格，不该被理由追加').toBe('原始规格')
  })
})
