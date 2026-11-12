/**
 * 收件人由**写入端指名**（卡 `497c9949`）
 *
 * ## 卡上报的病
 *
 * `--to-me` 的口径曾是 `recipient IS NULL OR recipient = ?` —— "没指定收件人的也算给我"。
 * 而写通知的地方大多不填收件人，于是"给我的"等于"给所有人的"：实测 245 条里 222 条
 * 谁都算我的，未读数对每个身份都一样大，收件箱失去意义。
 *
 * ## 判据
 *
 * 1. **该谁看由写入端决定**：「待你拍板」→ 主用户（`human`）、驳回 → 执行者、
 *    交付待验收的流水 → 仍留广播；
 * 2. 读侧 `--to-me` **只认指名**；广播不被藏起来 —— **不带 `--to-me` 就是全量**
 *    （界面一直走这个口径，人看到的还是全部动态）；
 * 3. 每一条都验"谁该有 / 谁不该有"两面：只验"该有"的话，一个恒真的过滤器也能过。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository, type AppNotification } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

let ctx: never
let repo: NotificationRepository
let todoRepo: TodoRepository
let commentRepo: CommentRepository

const runAs = (actor: string, args: string[]) =>
  executeOne({ ...(ctx as unknown as Record<string, unknown>), actor } as never, args)

type Receipt = { ok: boolean; data?: unknown; message?: string }
const idsOf = (receipt: Receipt): string[] =>
  ((receipt.data as { notifications?: Array<{ id: string }> })?.notifications ?? []).map((n) => n.id)

const allNotifications = (): AppNotification[] => repo.listPage({}).rows

describe('通知收件人：写入端指名（497c9949）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of ['todos', 'todo_comments', 'memos', 'notifications', 'projects', 'categories']) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    const projects = new ProjectRepository()
    projects.create({ name: 'P' })
    repo = new NotificationRepository()
    todoRepo = new TodoRepository()
    commentRepo = new CommentRepository()
    // 写命令要求身份已注册（未注册只能读）——把用例要用的三个身份登记上
    const agents = new AgentRepository()
    for (const [id, name] of [
      ['agent:dave', '戴夫'],
      ['agent:carol', '卡萝'],
      ['agent:bob', '鲍勃']
    ]) {
      agents.register({ id, displayName: name })
    }

    ctx = {
      deps: {
        todoRepo,
        categoryRepo: new CategoryRepository(),
        projectRepo: projects,
        commentRepo,
        notificationRepo: new NotificationRepository(),
        reminderReceiptRepo: new ReminderReceiptRepository(),
        rulesRepo: new RulesRepository(),
        protocolRepo: new ProtocolRepository(),
        profileRepo: new ProfileRepository(),
        memoRepo: new MemoRepository(),
        settingsRepo: { get: () => ({}) },
        // 真仓储而不是桩：状态流转要按身份判权（桩缺 get 会直接炸）
        agentRepo: new AgentRepository(),
        events: { append: () => {} },
        telemetry: { record: () => {}, query: () => [] }
      },
      meta: { version: '1.0.145', dbPath: ':memory:', schemaVersion: 50, via: 'headless' },
      interactive: true,
      actor: 'agent:dave'
    } as never
  })

  /** 造一张卡（默认执行者是 agent:dave），返回 id */
  const makeTodo = async (title: string): Promise<string> => {
    const created = (await runAs('agent:dave', [
      'todo',
      'add',
      '--title',
      title,
      '--project',
      'P',
      '--executed-by',
      'agent:dave'
    ])) as Receipt
    expect(created.ok, created.message ?? '').toBe(true)
    return (created.data as { id: string }).id
  }

  it('1. 「待你拍板」指名主用户：human 的收件箱里有它，agent 的没有', async () => {
    const created = (await runAs('agent:dave', [
      'todo',
      'add',
      '--title',
      '等我拍板的事',
      '--project',
      'P',
      '--status',
      'proposed'
    ])) as Receipt
    expect(created.ok, created.message ?? '').toBe(true)

    const decisions = allNotifications().filter((n) => n.type === 'decision')
    expect(decisions, '进「待确认」要发一条待拍板通知').toHaveLength(1)
    expect(decisions[0].recipient, '指名给主用户，不按 verifier 字段猜').toBe('human')

    const humanInbox = (await runAs('human', [
      'notification',
      'list',
      '--to-me',
      '--type',
      'decision',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(humanInbox)).toContain(decisions[0].id)

    const agentInbox = (await runAs('agent:dave', [
      'notification',
      'list',
      '--to-me',
      '--type',
      'decision',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(agentInbox), '没指名给它的不该出现在它的收件箱').not.toContain(decisions[0].id)
  })

  it('2. 交付待验收仍是广播：谁的 --to-me 里都没有它，但不带 --to-me 看得到', async () => {
    const id = await makeTodo('一件交付')
    const moved = (await runAs('agent:dave', [
      'todo',
      'update',
      id,
      '--status',
      'awaiting_review'
    ])) as Receipt
    expect(moved.ok, moved.message ?? '').toBe(true)

    const reviews = allNotifications().filter((n) => n.type === 'review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].recipient, '流水留广播').toBeNull()

    const mine = (await runAs('agent:dave', [
      'notification',
      'list',
      '--to-me',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(mine)).not.toContain(reviews[0].id)

    const all = (await runAs('agent:dave', [
      'notification',
      'list',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(all), '广播没被藏起来：默认口径是全量').toContain(reviews[0].id)
  })

  it('3. 驳回指名执行者：执行者的收件箱里有它，别人的没有', async () => {
    const id = await makeTodo('要被退回的事')
    await runAs('agent:dave', ['todo', 'update', id, '--status', 'awaiting_review'])
    // 驳回的权威判据是那条 kind=reject 评论（见 todo.repository 的 isRejection）
    commentRepo.create({ todoId: id, kind: 'reject', body: '结论不对，重做' })
    const rejected = (await runAs('human', [
      'todo',
      'update',
      id,
      '--status',
      'in_progress'
    ])) as Receipt
    expect(rejected.ok, rejected.message ?? '').toBe(true)

    const rejection = allNotifications().find((n) => n.title.includes('退回'))
    expect(rejection, '退回要留一条通知').toBeTruthy()
    expect(rejection?.recipient, '指名给执行者').toBe('agent:dave')

    const executorInbox = (await runAs('agent:dave', [
      'notification',
      'list',
      '--to-me',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(executorInbox)).toContain(rejection?.id as string)

    const otherInbox = (await runAs('agent:carol', [
      'notification',
      'list',
      '--to-me',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(otherInbox), '别人的收件箱里不该有').not.toContain(rejection?.id as string)
  })

  it('4. 备忘（memo）本来就指名：口径没被这次改动带歪', async () => {
    const added = (await runAs('agent:dave', [
      'memo',
      'add',
      '--to',
      'agent:carol',
      '--text',
      '给你的纸条'
    ])) as Receipt
    expect(added.ok, added.message ?? '').toBe(true)

    const carol = (await runAs('agent:carol', [
      'notification',
      'list',
      '--to-me',
      '--type',
      'memo',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(carol).length).toBeGreaterThan(0)

    const bob = (await runAs('agent:bob', [
      'notification',
      'list',
      '--to-me',
      '--type',
      'memo',
      '--limit',
      '0'
    ])) as Receipt
    expect(idsOf(bob), '没指名给 bob').toHaveLength(0)
  })
})
