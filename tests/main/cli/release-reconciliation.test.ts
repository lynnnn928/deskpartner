import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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
 * 发版对账要能回答"验了哪些"（`40294c81`）
 *
 * ## 它治的病
 *
 * `--fixed-in <版本>` 只回答"**改了哪些**"，不回答"**验了哪些**"——
 * 而发版决策必须把两件事一起看。以前只能逐条 `todo get` 读评论（N 条 = N 次调用）。
 *
 * ## 为什么这条功能直接支撑主用户的验收纪律
 *
 * 她 10-06 说：**「待验收列表里没有标注版本，我就不验收」**。
 * 做成字段后，这条纪律**可以机检** —— 不用人扫列表。
 *
 * ## 判据是"有没有收口结论"，不是"有没有评论"
 *
 * Bob实测：批量关 30 张卡，G5 全部放行，而**其中一半当初只有一行字**。
 * **有评论 ≠ 交代过了** —— 所以判据落在 `todo close` 写的四段标记上。
 */
describe('发版对账带验收状态（40294c81）', () => {
  let todos: TodoRepository
  let comments: CommentRepository
  let agents: AgentRepository
  const CRED = { v: '' }

  const mkCtx = () =>
    ({
      deps: {
        todoRepo: todos,
        commentRepo: comments,
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        memoRepo: new MemoRepository(),
        settingsRepo: { get: () => ({}) },
        agentRepo: agents,
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.68', dbPath: ':memory:', schemaVersion: 26, via: 'pipe' },
      interactive: false,
      actor: 'agent:alice',
      credential: CRED.v
    }) as never

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    for (const t of [
      'todos',
      'todo_comments',
      'todo_transitions',
      'memos',
      'events',
      'notifications',
      'categories',
      'projects',
      'agents'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
    comments = new CommentRepository()
    agents = new AgentRepository()
    agents.register({ id: 'agent:alice', displayName: 'WB', color: '#111' } as never)
    agents.setApproved('agent:alice', true)
    CRED.v = agents.issueCredential('agent:alice')?.token ?? ''
  })

  const seed = (over: Record<string, unknown> = {}) =>
    todos.create({
      title: '一件事',
      projectId: null,
      createdBy: 'agent:alice',
      fixedInVersion: '1.0.68',
      ...over
    } as never)

  /** `todo close` 写的那种四段评论 */
  const writeClosure = (todoId: string) =>
    comments.create({
      todoId,
      body: '【做了什么】X\n【验证】跑了 Y\n【什么算通过】Z\n【取舍与遗留】无',
      authorType: 'agent',
      authorId: 'agent:alice',
      kind: 'comment'
    } as never)

  const listByVersion = () =>
    executeOne(mkCtx(), ['todo', 'list', '--fixed-in', '1.0.68', '--status', 'any']) as Promise<{
      data?: Array<{ id: string; acceptance?: { status: string; hasClosure: boolean; rejected: boolean } }>
    }>

  it('已完成且有收口结论 → closed', async () => {
    const t = seed({ status: 'done' })
    writeClosure(t.id)
    const r = await listByVersion()
    expect(r.data![0].acceptance!.status).toBe('closed')
    expect(r.data![0].acceptance!.hasClosure).toBe(true)
  })

  it('已完成但只有一句评论 → no-closure（这正是Bob那 30 张里的一半）', async () => {
    const t = seed({ status: 'done' })
    comments.create({
      todoId: t.id,
      body: '做完了',
      authorType: 'agent',
      authorId: 'agent:alice',
      kind: 'comment'
    } as never)
    const r = await listByVersion()
    expect(
      r.data![0].acceptance!.status,
      '有评论不等于交代过了 —— 这一档必须能被区分出来'
    ).toBe('no-closure')
  })

  it('已完成但一条评论都没有 → 也是 no-closure', async () => {
    seed({ status: 'done' })
    const r = await listByVersion()
    expect(r.data![0].acceptance!.status).toBe('no-closure')
  })

  it('还在待验收 → pending（差一次验收）', async () => {
    seed({ status: 'awaiting_review' })
    const r = await listByVersion()
    expect(r.data![0].acceptance!.status).toBe('pending')
  })

  it('有驳回记录会单独标出来（发版时值得多看一眼的那类）', async () => {
    const t = seed({ status: 'done' })
    writeClosure(t.id)
    comments.create({
      todoId: t.id,
      body: '哪里没做好',
      authorType: 'human',
      authorId: 'human',
      kind: 'reject'
    } as never)
    const r = await listByVersion()
    expect(r.data![0].acceptance!.rejected).toBe(true)
  })

  it('不带 --fixed-in 时不给这个字段（平时不需要，别加噪音与多余查询）', async () => {
    const t = seed({ status: 'done' })
    writeClosure(t.id)
    const r = (await executeOne(mkCtx(), ['todo', 'list', '--status', 'any'])) as {
      data?: Array<Record<string, unknown>>
    }
    expect(
      r.data![0].acceptance,
      '字段要出现在用得到它的地方，不是"看起来完整"的地方'
    ).toBeUndefined()
  })

  it('一次调用就够（批量判据，不是逐条查）', async () => {
    for (let i = 0; i < 5; i++) seed({ status: 'done', title: `第 ${i} 件` })
    const r = await listByVersion()
    expect(r.data!).toHaveLength(5)
    expect(r.data!.every((x) => x.acceptance?.status === 'no-closure')).toBe(true)
  })

  it('闭口ByTodo 的判据：只看四段标记，不看评论条数', () => {
    const t = seed({ status: 'done' })
    // 三条普通评论，不含四段标记
    for (const body of ['做了一点', '又做了一点', '差不多了']) {
      comments.create({
        todoId: t.id,
        body,
        authorType: 'agent',
        authorId: 'agent:alice',
        kind: 'comment'
      } as never)
    }
    const map = comments.closureByTodo([t.id])
    expect(map[t.id].hasClosure, '三条评论但没一句交代清楚 = 没有收口结论').toBe(false)
    // 补一条四段的
    writeClosure(t.id)
    expect(comments.closureByTodo([t.id])[t.id].hasClosure).toBe(true)
  })

  it('空入参不炸（发版时按版本筛可能一条都没有）', () => {
    expect(comments.closureByTodo([])).toEqual({})
  })
})
