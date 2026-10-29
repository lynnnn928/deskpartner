import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne, EXIT_CODES } from '../../../src/main/cli/commands'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 不变量 6：守卫返回口径唯一（`917390e0` 第 6 条，主用户 10-05 授权直接排期）
 *
 * 卡上写的判据：**硬拦 = 退出码 4 + `guard_blocked`，
 * 软提醒 = 退出码 0 + 顶层 notice**，不得出现 1/error。
 *
 * ## 这一条在写的时候就已经被违反了
 *
 * 守卫错误的归类靠**消息里的守卫号标记**：`/（G[1246]）/`
 * —— 那是个**手写清单**。我 1.0.65 加 G10 时，G10 的报错文本里明明写着
 * `（G10）`，却因为没进那个字符类而被归成 `exit 1 + code="error"`。
 *
 * 后果与卡上写的一致：agent 收到笼统的"出错了"，合理反应是**重试**，
 * 而重试同样会被拒 —— 那不是"暂时失败"，是"这条路走不通"。
 *
 * 修法不是把 `10` 补进字符类（那还是手写清单），而是 `/（G\d+）/`
 * 判据：**识别规则不能是"把现有值列一遍"** ——
 * 那是把"加新守卫时记得改这里"交给人的自觉，而这类设计换个 agent 就不成立。
 */
describe('不变量 6：守卫返回口径唯一', () => {
  let todos: TodoRepository

  const mkCtx = (actor = 'human'): never =>
    ({
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
        commentRepo: new CommentRepository(),
        notificationRepo: new NotificationRepository(),
        reminderReceiptRepo: new ReminderReceiptRepository(),
        rulesRepo: new RulesRepository(),
        protocolRepo: new ProtocolRepository(),
        profileRepo: new ProfileRepository(),
        memoRepo: { list: () => [], add: () => ({}), get: () => null },
        settingsRepo: { get: () => ({}) },
        agentRepo: new AgentRepository(),
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.66', dbPath: ':memory:', schemaVersion: 25, via: 'pipe' },
      interactive: true,
      actor
    }) as never

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of [
      'todos',
      'todo_comments',
      'todo_transitions',
      'events',
      'notifications',
      'agent_grants',
      'projects',
      'categories'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  /** 四个硬拦守卫，各自造出真实的触发条件 */
  const guardCases = () => [
    {
      label: 'G1 父需求还在待确认时建子任务',
      run: async () => {
        const p = todos.create({ title: 'P1', projectId: null, status: 'proposed' } as never)
        // ⚠️ `--project` 是必填的（1.0.37 起）—— 漏了它会先撞参数校验（usage_error），
        // 那样测的就不是 G1 了。第一版就是这么写错的：拿到 exit 2 以为 G1 没归 guard。
        return executeOne(mkCtx(), ['todo', 'add', '--title', '子', '--parent', p.id, '--project', 'P'])
      }
    },
    {
      /**
       * 1.0.68 语义变更（`e0ec5f32`）：G4 放开了一条 ——
       * **提议人可把自己的 proposed 降级为待办 / 撤回（挂起）**，
       * 因为"收回自己的请求"与"替别人拍板"是两件不同的事。
       *
       * ⚠️ 因此这条样例必须改成「**移别人的**卡」才测得到 G4。
       * 原样例建的卡 createdBy 默认 human，而 mkCtx() 的 actor 也是 human
       * —— 那正好命中新放行通道，于是 G4 不再触发。
       * 我第一版没改样例，3 条不变量集体红，而报错指向"errorCode=undefined"，
       * 像是守卫坏了、其实是我在测一个已不存在的场景。
       *
       * 判据：**守卫语义变了，测它的样例也要跟着换。**
       */
      label: 'G4 把别人的事项移出待确认',
      run: async () => {
        const p = todos.create({
          title: 'P2',
          projectId: null,
          status: 'proposed',
          createdBy: 'agent:bob'
        } as never)
        return executeOne(mkCtx('human'), ['todo', 'update', p.id, '--status', 'todo'])
      }
    },
    {
      label: 'G6 父需求有未完成子卡时归档',
      run: async () => {
        const p = todos.create({ title: 'P3', projectId: null, status: 'in_progress' } as never)
        todos.create({ title: '子', projectId: null, parentId: p.id } as never)
        return executeOne(mkCtx(), ['todo', 'update', p.id, '--status', 'done'])
      }
    },
    {
      label: 'G10 待验收 → 已完成',
      run: async () => {
        const p = todos.create({ title: 'P4', projectId: null, status: 'awaiting_review' } as never)
        return executeOne(mkCtx(), ['todo', 'update', p.id, '--status', 'done'])
      }
    }
  ]

  it('四个硬拦守卫都被真正触发（先确认拦得住，否则后面测的是"没拦"）', async () => {
    for (const c of guardCases()) {
      const r = await c.run()
      expect(r.ok, `${c.label} 竟然放过了`).toBe(false)
    }
  })

  it('硬拦的退出码一律是 4（不得出现 1 —— 那会让调用方以为重试有用）', async () => {
    for (const c of guardCases()) {
      const r = await c.run()
      expect(r.code, `${c.label} 返回了 ${r.code}（errorCode=${r.errorCode}）`).toBe(
        EXIT_CODES.guard
      )
    }
  })

  it('硬拦的 errorCode 一律是 guard_blocked（调用方按 code 分流要有一张表）', async () => {
    for (const c of guardCases()) {
      const r = await c.run()
      expect(r.errorCode, `${c.label} 的 errorCode 是 ${r.errorCode}`).toBe('guard_blocked')
    }
  })

  it('G10 也要归 guard_blocked（1.0.65 修：守卫号正则曾漏了它）', async () => {
    const p = todos.create({ title: 'AR', projectId: null, status: 'awaiting_review' } as never)
    const r = await executeOne(mkCtx(), ['todo', 'update', p.id, '--status', 'done'])
    expect(r.code).toBe(EXIT_CODES.guard)
    expect(r.errorCode).toBe('guard_blocked')
  })

  /**
   * 防"下次加守卫又漏"：识别规则不能是手写清单。
   * 判据 —— **G11 这种还不存在的守卫号也必须能被认出**。
   */
  it('守卫号识别不依赖手写清单：G11 这种未来守卫也能被认出', () => {
    const mark = /（G\d+）/
    expect(mark.test('（G11）'), 'G11 未被识别 → 下次加守卫还会踩同一个坑').toBe(true)
    expect(mark.test('（G10）')).toBe(true)
    expect(mark.test('（G2）')).toBe(true)
    // 而非守卫消息不该被误判成守卫
    expect(mark.test('待办不存在: xxx')).toBe(false)
    expect(mark.test('缺少必填参数 --title')).toBe(false)
  })

  it('软提醒不改退出码（0 + 顶层 notice），只有硬拦才 4', async () => {
    const p = todos.create({ title: '软', projectId: null, status: 'awaiting_review' } as never)
    const r = await executeOne(mkCtx('agent:x'), ['todo', 'comment', p.id, '--body', '只留评论'])
    expect(r.code ?? EXIT_CODES.ok).toBe(EXIT_CODES.ok)
    expect((r as { notice?: string }).notice ?? '', 'G9 软提醒应落在顶层 notice').toContain(
      'G9'
    )
  })

  it('同一失败在直连与 batch 下 errorCode 一致（卡上第 6 条的后半句）', async () => {
    const p = todos.create({ title: '批', projectId: null, status: 'awaiting_review' } as never)
    const direct = await executeOne(mkCtx(), ['todo', 'update', p.id, '--status', 'done'])
    const batch = await executeOne(
      {
        ...(mkCtx() as object),
        stdin: JSON.stringify({
          cmd: 'todo update',
          positional: [p.id],
          args: { '--status': 'done' }
        })
      } as never,
      ['batch']
    )
    const row = (batch as { data?: { results?: { errorCode?: string }[] } }).data?.results?.[0]
    expect(row?.errorCode, 'batch 里同一失败的 errorCode 与直连不一致').toBe(direct.errorCode)
  })
})
