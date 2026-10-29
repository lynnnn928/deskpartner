import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'

/**
 * 回执提醒的**去重**与 **snooze**（卡 `48f4e326`）
 *
 * ## 治的病（Bob 1.0.106 实测）
 *
 * 「同一会话同摘要只展开一次」看着已经做了，但它有一条前置：**调用方得声明
 * `DESKPARTNER_SESSION`**。没声明就每条命令重复推 —— 而绝大多数调用方不声明，
 * 于是这条机制默认关着。实测原文：连续两条命令的 notice 完全相同（各 223 字节），
 * 照旧每条重复推「38 条指派 + 未读纸条」。
 *
 * 另一半是**没有出口**：调用方看完了想说"这批我知道了，别再推"，没有地方可说。
 *
 * ## 判据（卡上写的两条，一条一个用例组）
 *
 * 1. 不声明会话连跑两次 → 第二次不再展开；内容一变立刻重推（**不是静音**）；
 * 2. `reminder snooze` 之后同一批不再出现，而新出现的纸条/指派照旧推。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const ME = 'agent:me'

const todoRepo = new TodoRepository()
const projectRepo = new ProjectRepository()

function mkCtx(): never {
  return {
    deps: {
      todoRepo,
      categoryRepo: new CategoryRepository(),
      projectRepo,
      memoRepo: { list: () => [], add: () => ({}), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: new AgentRepository(),
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      releaseRepo: new ReleaseRepository(),
      events: new EventsRepository(),
      telemetry: { record: () => {}, stats: () => {}, query: () => {}, clear: () => {} }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 99,
      busyTimeoutMs: 5000,
      channels: ['headless' as const],
      via: 'headless' as const,
      startedAt: Date.now()
    },
    // 交互式：本文件测的是提醒本身，不该被门禁挡住（门禁另有用例）
    interactive: true,
    actor: ME
    /** ⚠️ 刻意**不带** session —— "不声明会话"正是本卡要修的那个默认情形 */
  } as never
}

const run = (args: string[]) => executeOne(mkCtx(), args)

/** 一条写命令（回执顶部就是提醒该出现的地方） */
/**
 * ⚠️ 用 `todo comment` 而不是 `todo add` 当那条"写命令"。
 *
 * 理由是自洽性：`todo add` 建出来的卡 **提出者=我**，而 `todosForExecutor` 把
 * "提出即执行"也算作指派给我的活 —— 于是每跑一次写命令，摘要就变一次，
 * 去重永远轮不到生效（我第一版就是这么写的，四条用例全红，而红在"测试自己
 * 每轮都在改被观察的对象"）。评论则不动这三个来源中的任何一个。
 */
const writeCmd = () => ['todo', 'comment', targetId, '--body', '记录一笔']

const noticesOf = (r: unknown): string => String((r as { notice?: string }).notice ?? '')

let todos: TodoRepository
/** 供评论用的目标卡（不属于我、不指派给我） */
let targetId = ''

function assignOne(title: string) {
  return todos.create({ title, projectId: null, createdBy: 'agent:someone', executedBy: ME } as never)
}

beforeAll(() => runMigrations(db))

beforeEach(() => {
  for (const t of ['todos', 'todo_transitions', 'todo_comments', 'notifications', 'projects', 'categories']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  db.prepare('DELETE FROM cli_reminder_receipts').run()
  new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
  projectRepo.create({ name: 'P' })
  todos = new TodoRepository()
  targetId = todos.create({
    title: '供评论的卡',
    projectId: null,
    createdBy: 'agent:someone'
  } as never).id
})

describe('48f4e326 未声明会话时的提醒去重', () => {
  it('连跑两次写命令：第一次推，第二次不推（不再每条重复）', async () => {
    assignOne('指派给我的卡')
    const first = await run(writeCmd())
    expect(noticesOf(first), '第一次应当带着"指派给你"的摘要').toContain('指派给你')
    const second = await run(writeCmd())
    expect(noticesOf(second), '第二次推送了逐字相同的摘要 —— 这正是Bob实测的那个症状').not.toContain(
      '指派给你'
    )
  })

  it('内容一变立刻重新推（去重只压"一字未变的同一批"，不是静音）', async () => {
    assignOne('第一张')
    expect(noticesOf(await run(writeCmd()))).toContain('指派给你')
    expect(noticesOf(await run(writeCmd()))).not.toContain('指派给你')
    // 多了一张指派给我的卡 → 摘要是新的 → 必须重新推
    assignOne('第二张')
    const third = await run(writeCmd())
    expect(noticesOf(third), '新增指派之后必须重新提醒').toContain('指派给你')
    expect(noticesOf(third), '摘要里应当体现新数量').toContain('2 条')
  })

  it('不同身份互不压制', async () => {
    assignOne('给 me 的')
    expect(noticesOf(await run(writeCmd()))).toContain('指派给你')
    const other = executeOne(
      { ...(mkCtx() as object), actor: 'agent:other' } as never,
      writeCmd()
    )
    const r = await other
    // agent:other 没有指派给它的卡，摘要为空；关键是 me 的记账没有把别人一起压掉
    expect(noticesOf(r)).not.toContain('指派给你')
    const meAgain = await run(writeCmd())
    expect(noticesOf(meAgain)).not.toContain('指派给你')
  })
})

describe('48f4e326 reminder snooze', () => {
  it('snooze 之后同一批不再出现，新出现的内容照旧推', async () => {
    assignOne('第一张')
    expect(noticesOf(await run(writeCmd()))).toContain('指派给你')

    const snooze = (await run(['reminder', 'snooze'])) as {
      ok: boolean
      data: { snoozed: boolean; firstTime: boolean; summary: string }
    }
    expect(snooze.ok).toBe(true)
    expect(snooze.data.snoozed).toBe(true)
    expect(snooze.data.summary, 'snooze 记的必须是**当前这批**的原文').toContain('指派给你')

    // 同一批：不再出现
    expect(noticesOf(await run(writeCmd()))).not.toContain('指派给你')

    // 新出现一张 → 重新推（snooze 不会把后来的活一起吞掉）
    assignOne('第二张')
    expect(noticesOf(await run(writeCmd()))).toContain('指派给你')
  })

  it('同一批重复 snooze：第二次报"此前已记过"，不是又标记一批', async () => {
    assignOne('第一张')
    const first = (await run(['reminder', 'snooze'])) as { data: { firstTime: boolean } }
    const second = (await run(['reminder', 'snooze'])) as { data: { firstTime: boolean; snoozed: boolean } }
    expect(first.data.firstTime).toBe(true)
    expect(second.data.snoozed).toBe(true)
    expect(second.data.firstTime).toBe(false)
  })

  it('没有提醒可压时如实说"没有"，不假装标记成功', async () => {
    const r = (await run(['reminder', 'snooze'])) as { ok: boolean; data: { snoozed: boolean; reason: string } }
    expect(r.ok).toBe(true)
    expect(r.data.snoozed).toBe(false)
    expect(r.data.reason).toContain('没有')
  })

  it('snooze 是读档命令：不改已读位、不产生通知', async () => {
    assignOne('第一张')
    const before = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }
    await run(['reminder', 'snooze'])
    const after = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }
    expect(after.n, 'snooze 不该写通知').toBe(before.n)
  })
})
