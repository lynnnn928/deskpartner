import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

/**
 * 卡 `52cd076c`：验收收口后执行方零通知 —— 写在 `--leftover` 里的交办不能变成死信。
 */
describe('todo close --leftover 自动通知执行方（52cd076c）', () => {
  let todos: TodoRepository
  let comments: CommentRepository
  let notifications: NotificationRepository
  let memos: MemoRepository
  let agents: AgentRepository
  let projects: ProjectRepository
  let reviewerToken = ''
  let executorToken = ''
  let projectId = ''

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec(`
      DELETE FROM notifications;
      DELETE FROM memos;
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM categories;
      DELETE FROM projects;
      DELETE FROM agents;
    `)
    todos = new TodoRepository()
    comments = new CommentRepository()
    notifications = new NotificationRepository()
    memos = new MemoRepository()
    agents = new AgentRepository()
    projects = new ProjectRepository()

    new CategoryRepository().create({ id: 'cat-1', name: '其他', color: '#888' })
    projectId = projects.create({ name: 'DeskPartner' }).id

    agents.register({ id: 'agent:bob', displayName: 'Bob', color: '#06B6D4' } as never)
    agents.setApproved('agent:bob', true)
    reviewerToken = agents.issueCredential('agent:bob')?.token ?? ''

    agents.register({ id: 'agent:carol', displayName: 'Carol', color: '#8B5CF6' } as never)
    agents.setApproved('agent:carol', true)
    executorToken = agents.issueCredential('agent:carol')?.token ?? ''
  })

  function mkCtx(actor: string, credential: string) {
    return {
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: projects,
        memoRepo: memos,
        settingsRepo: { get: () => ({}) },
        agentRepo: agents,
        commentRepo: comments,
        notificationRepo: notifications,
        events: new EventsRepository(),
        telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
      },
      meta: {
        version: '1.0.129',
        dbPath: ':memory:',
        schemaVersion: 47,
        busyTimeoutMs: 5000,
        channels: ['headless' as const],
        via: 'headless' as const,
        startedAt: Date.now()
      },
      interactive: false,
      actor,
      credential
    } as never
  }

  it('验收方收口且 --leftover 非空时，自动通知执行方（todo inbox / memo / review 通知三处可见）', async () => {
    const t = todos.create({
      title: '备忘回复闭环',
      projectId,
      categoryIds: ['cat-1'],
      status: 'awaiting_review',
      createdBy: 'agent:bob',
      executedBy: 'agent:carol',
      verifier: 'agent:bob'
    })

    const closeRes = await executeOne(mkCtx('agent:bob', reviewerToken), [
      'todo',
      'close',
      t.id,
      '--did',
      '备忘加回复线程',
      '--verified',
      '1.0.128 真包实测通过',
      '--pass-criteria',
      '三条完成判据成立',
      '--leftover',
      '请顺手清掉收件箱里标了「本轮清」的两条探针备忘'
    ])
    expect(closeRes.ok).toBe(true)
    const data = closeRes.data as {
      todoId: string
      leftoverNotifiedTo?: string
      leftoverMemoId?: string
    }
    expect(data.leftoverNotifiedTo).toBe('agent:carol')
    expect(data.leftoverMemoId).toBeTruthy()

    // 1. 执行方跑 todo inbox 能看到这条收口遗留评论
    const inboxRes = await executeOne(mkCtx('agent:carol', executorToken), [
      'todo',
      'inbox',
      '--replied-only'
    ])
    expect(inboxRes.ok).toBe(true)
    const inboxItems = (inboxRes.data as { items: Array<{ todoId: string; body: string }> }).items
    expect(inboxItems.some((x) => x.todoId === t.id && x.body.includes('本轮清'))).toBe(true)

    // 2. 执行方跑 memo list --to-me --unread 能看到遗留备忘，且可同线程回复
    const memoRes = await executeOne(mkCtx('agent:carol', executorToken), [
      'memo',
      'list',
      '--to-me',
      '--unread'
    ])
    expect(memoRes.ok).toBe(true)
    const memoRows = memoRes.data as Array<{ id: string; text: string; linkedTodoId: string }>
    expect(memoRows.length).toBe(1)
    expect(memoRows[0].id).toBe(data.leftoverMemoId)
    expect(memoRows[0].linkedTodoId).toBe(t.id)
    expect(memoRows[0].text).toContain('本轮清')

    // 3. 执行方跑 notification list --to-me --type memo 能看到关联该事项的未读通知（不受 done 态 STALE_REVIEW 过滤）
    const notifRes = await executeOne(mkCtx('agent:carol', executorToken), [
      'notification',
      'list',
      '--to-me',
      '--type',
      'memo'
    ])
    expect(notifRes.ok).toBe(true)
    const notifRows = (notifRes.data as { notifications: Array<{ refId: string; summary: string }> }).notifications
    expect(notifRows.some((n) => n.refId === data.leftoverMemoId && n.summary.includes('本轮清'))).toBe(true)
  })

  it('--leftover 留空时不额外发遗留备忘或遗留通知（防止把已完成变成噪音源）', async () => {
    const t = todos.create({
      title: '枚举强校验',
      projectId,
      categoryIds: ['cat-1'],
      status: 'awaiting_review',
      createdBy: 'agent:bob',
      executedBy: 'agent:carol',
      verifier: 'agent:bob'
    })

    const closeRes = await executeOne(mkCtx('agent:bob', reviewerToken), [
      'todo',
      'close',
      t.id,
      '--did',
      '参数改枚举',
      '--verified',
      '单测 5/5 通过',
      '--pass-criteria',
      '非法值回 usage_error'
    ])
    expect(closeRes.ok).toBe(true)
    const data = closeRes.data as { leftoverNotifiedTo?: string }
    expect(data.leftoverNotifiedTo).toBeUndefined()

    const memoRows = memos.list({ recipientFor: 'agent:carol', unreadOnly: true })
    expect(memoRows).toHaveLength(0)
  })
})
