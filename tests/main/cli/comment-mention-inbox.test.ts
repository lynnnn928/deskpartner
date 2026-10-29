import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 评论能 @ 定向给某个 agent（`b097ca99` 的「叫醒」，多 agent 协作第 3 环）
 *
 * ## 核 10-07 实测出来的真缺口
 *
 * `todo_comments` 表**有 `parent_id`**（能回复某条评论），
 * 但**没有 `recipient`** —— 所以：
 * - `comment --reply-to <某条>` = **我知道有这条评论，才回它**（pull）
 * - `comment --to agent:x` = **你在评论上留话，他能被动看到**（push）
 *
 * 提单原话：「**投递（pull）已有但坏了；叫醒（push）确实没有。**」
 * ①②（memo 拆列 / 通知定向）修的是 pull 的坏，**这一条是 push**。
 *
 * ## 关键判断：push 要有**查询面**，否则等于没做
 *
 * `comment --to` 写进去只是**存**了。
 * 若没有"按人查出我在哪些事上被点名了"，agent 每轮还是只能全量拉回来自己认
 * —— **和通知那个洞同源**（10-07 才补上）。
 * 所以加了 `todo inbox` 独立命令。
 */
describe('评论 @ 定向 + 我的 inbox（b097ca99 第 3 环）', () => {
  let comments: CommentRepository
  let todos: TodoRepository
  const CRED = { v: '' }

  const mkCtx = (actor: string) =>
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
      actor,
      credential: CRED.v
    }) as never

  beforeAll(async () => {
    await runMigrations(db)
  })

  beforeEach(() => {
    db.exec(`DELETE FROM todo_comments;`)
    db.exec(`DELETE FROM todos;`)
    db.exec(`DELETE FROM categories;`)
    db.exec(`DELETE FROM projects;`)
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    comments = new CommentRepository()
    todos = new TodoRepository()
    CRED.v = ''
  })

  const seedTodo = (title = '一件事') =>
    todos.create({ title, projectId: null, createdBy: 'agent:alice' } as never)

  it('迁移给 todo_comments 加了 recipient 列', () => {
    const cols = db.prepare('PRAGMA table_info(todo_comments)').all().map((r) => (r as { name: string }).name)
    expect(cols, 'recipient 没加 —— @ 了某人也没地方记').toContain('recipient')
  })

  /**
   * 这条是**本环的核心判据**，也是最容易静默失败的地方：
   * 我今天已在 memos / notifications 上各栽过一次"改了对象漏了 INSERT 参数"，
   * 症状都是**那列全 null 而 tsc 全过**（SQL 列名不参与类型检查）。
   * 所以这里**显式从库里读出来**。
   */
  it('`--to` 真的落库了（不是只在对象里）', async () => {
    const t = seedTodo()
    const r = await executeOne(mkCtx('agent:alice'), [
      'todo', 'comment', t.id, '--body', '这版你看下', '--to', 'agent:qwen'
    ])
    expect(r.ok).toBe(true)
    const row = db
      .prepare('SELECT recipient FROM todo_comments WHERE todo_id = ?')
      .get(t.id) as { recipient: string | null }
    expect(
      row.recipient,
      '库里 recipient 是 null —— INSERT 漏了参数（tsc 查不出来，SQL 列名不参与类型检查）'
    ).toBe('agent:qwen')
  })

  it('不传 `--to` 时 recipient 落 null（不编造收件人）', async () => {
    const t = seedTodo()
    await executeOne(mkCtx('agent:alice'), ['todo', 'comment', t.id, '--body', '自言自语'])
    const row = db
      .prepare('SELECT recipient FROM todo_comments WHERE todo_id = ?')
      .get(t.id) as { recipient: string | null }
    expect(row.recipient).toBeNull()
  })

  it('`--reply-to` 与 `--to` 是两件事（前者要我知道有那条，后者是我叫醒他）', async () => {
    const t = seedTodo()
    const first = await executeOne(mkCtx('agent:alice'), [
      'todo', 'comment', t.id, '--body', '先说这句', '--to', 'agent:qwen'
    ])
    const parentId = (first.data as { commentId: string }).commentId
    // 回复它：parentId 指回原评论
    await executeOne(mkCtx('agent:qwen'), [
      'todo', 'comment', t.id, '--body', '收到', '--reply-to', parentId
    ])
    const all = comments.listByTodo(t.id)
    expect(all.find((c) => c.body === '先说这句')?.recipient, '原评论的收件人').toBe('agent:qwen')
    expect(
      all.find((c) => c.body === '收到')?.parentId,
      '回复要接上 parentId（那是 pull 那一侧）'
    ).toBe(parentId)
  })

  it('`listWaitingFor` 只给 @ 了某人的（别人的不给我）', () => {
    const t = seedTodo()
    comments.create({
      todoId: t.id,
      body: '给你的',
      authorType: 'agent',
      authorId: 'agent:alice',
      recipient: 'agent:qwen'
    } as never)
    comments.create({
      todoId: t.id,
      body: '给他的',
      authorType: 'agent',
      authorId: 'agent:qwen',
      recipient: 'agent:alice'
    } as never)
    expect(comments.listWaitingFor('agent:qwen').map((c) => c.body)).toEqual(['给你的'])
  })

  /**
   * 核心：**我回过了就不再算"等我回应"**。
   * 判据来源：通知那个洞的同类 —— 状态/标记必须能区分"读过了"与"处理完了"。
   */
  it('`repliedOnly` 排除我已回过的（每轮开工该看的是"还没接的"）', () => {
    const t = seedTodo()
    const asked = comments.create({
      todoId: t.id,
      body: '你怎么看',
      authorType: 'agent',
      authorId: 'agent:alice',
      recipient: 'agent:qwen'
    } as never)
    comments.create({
      todoId: t.id,
      parentId: asked.id,
      body: '我看完了',
      authorType: 'agent',
      authorId: 'agent:qwen'
    } as never)
    expect(comments.listWaitingFor('agent:qwen').length, '默认给全部 @ 过的').toBe(1)
    expect(
      comments.listWaitingFor('agent:qwen', { repliedOnly: true }).length,
      '我回过了 ⇒ 不该再出现在"等我回应"里'
    ).toBe(0)
  })

  it('`todo inbox` 命令能按人列出（push 的查询面）', async () => {
    const t = seedTodo('等你决定的事')
    await executeOne(mkCtx('agent:alice'), [
      'todo', 'comment', t.id, '--body', '卡在这里了', '--to', 'agent:qwen'
    ])
    const r = (await executeOne(mkCtx('agent:qwen'), ['todo', 'inbox'])) as {
      data: { total: number; items: Array<{ todoTitle: string; from: string; repliedByMe: boolean }> }
    }
    expect(r.data.total, 'qwen 那边该看到一条被 @ 的').toBe(1)
    expect(r.data.items[0].from, '要能看到是谁 @ 的').toBe('agent:alice')
    expect(r.data.items[0].repliedByMe, '还没回过').toBe(false)
    expect(r.data.items[0].todoTitle, '要能看到是哪件事').toBe('等你决定的事')
  })

  it('`todo inbox --replied-only` 只给还没回的', async () => {
    const t = seedTodo()
    const a = await executeOne(mkCtx('agent:alice'), [
      'todo', 'comment', t.id, '--body', 'A 要你看', '--to', 'agent:qwen'
    ])
    const parentId = (a.data as { commentId: string }).commentId
    await executeOne(mkCtx('agent:qwen'), [
      'todo', 'comment', t.id, '--body', 'A 我回了', '--reply-to', parentId
    ])
    // 再 @ 一次但没回
    await executeOne(mkCtx('agent:alice'), [
      'todo', 'comment', t.id, '--body', 'B 还没回', '--to', 'agent:qwen'
    ])
    const r = (await executeOne(mkCtx('agent:qwen'), [
      'todo', 'inbox', '--replied-only'
    ])) as { data: { total: number } }
    expect(r.data.total, '只剩 B 那条').toBe(1)
  })
})
