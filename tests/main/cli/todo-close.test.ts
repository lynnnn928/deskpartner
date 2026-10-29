import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readCliChain } from './cli-chain'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne, commands } from '../../../src/main/cli/commands'
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
 * `todo close`：让"写全四段"成为最短路径（`47d6ad52`，Bob建议②，主用户 10-06 拍板选②）
 *
 * ## 它治的病
 *
 * Bob实测：**一次批量关 30 张卡，G5 全部放行** —— 每张都有评论，
 * 但**其中一半当初只有一行字**。软提醒只查"有没有评论"，等于不校验。
 *
 * 三个选项里：①要求评论含四个标记词 → **逼出为过校验而写的空壳段落**；
 * ③维持现状 → 规范靠自觉守不住；**②让 CLI 组装正文** →
 * "写全"比"不写"更省事，agent 不必自己组织语言。
 *
 * 与「权限必须由机制强制，不由调用方自觉」同源。
 */
const HUMAN = 'human'

describe('todo close（47d6ad52）', () => {
  let todos: TodoRepository
  let comments: CommentRepository
  let agents: AgentRepository

  /**
   * 凭据按 actor 取（issueCredential 的 token 在 beforeEach 里生成）。
   *
   * ⚠️ 1.0.116 起 `todo close` 多了个身份前提（卡 `a7ad343f`）：
   * **执行者不能自己收口**，从哪一列出发都一样。所以这份用例里的收口动作
   * 由 `agent:reviewer` 来做，卡本身仍由 `agent:qwen` 提出 —— 这样被测的
   * 还是"四段正文 / 必填 / 状态推进"，不被身份规则挡住。
   */
  const CREDS = new Map<string, string>()

  const mk = (actor = 'agent:reviewer') =>
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
      meta: { version: '1.0.67', dbPath: ':memory:', schemaVersion: 26, via: 'pipe' },
      interactive: false,
      actor,
      /** 凭据要走 ctx 传（`ctx.credential`），不是环境变量 */
      credential: actor === HUMAN ? undefined : CREDS.get(actor)
    }) as never

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of ['todos', 'todo_comments', 'todo_transitions', 'notifications', 'events']) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
    comments = new CommentRepository()
    agents = new AgentRepository()
    /**
     * ⚠️ 必须先注册：`interactive:false` 的写调用会查 `agentRepo.get(actor)`，
     * 没注册就返回 `identity_unregistered`（退出码 4）——
     * **那与本命令无关，却让 5 条用例集体红，报错指向"缺 --did"**。
     * 判据：测试红且报错指向一个与被测行为无关的方向时，先查前置条件。
     */
    /**
     * 注册**并批准**。
     *
     * ⚠️ 我为了这条断言连栽三次前置条件，每次报错都指向别处：
     * ① `interactive:false` + actor=human → 「不能匿名写入」
     * ② actor=agent 但没注册     → 「identity_unregistered」
     * ③ 注册了但没批准           → 「还没被批准写入」
     * 三条都与"必填校验 / 四段正文"无关，却让 5 条用例集体红。
     *
     * 判据：**测试红且报错指向一个与被测行为无关的方向时，先查前置条件**，
     * 别急着改被测代码。（与 10-04 那次「拿过时数据下判断」同源。）
     */
    agents.register({ id: 'agent:qwen', displayName: 'Bob', color: '#111' } as never)
    agents.setApproved('agent:qwen', true)
    // 第四道：还要领凭据（未出示凭据 → `未出示凭据`）。
    // ⚠️ 四道前置条件（匿名/注册/批准/凭据）各让 5 条用例红过一次，报错都指向别处。
    // **把它们一次配齐**，比逐个撞过去快得多 —— 这就是我 10-05 犯过的错
    // （「没读完整提单就开始写」的同款：没把前置条件一次列全）。
    CREDS.set('agent:qwen', agents.issueCredential('agent:qwen')?.token ?? '')
    // 收口方：与提出者不同一个人，才过得了 G10（1.0.116 起按身份判）
    agents.register({ id: 'agent:reviewer', displayName: '验收', color: '#111' } as never)
    agents.setApproved('agent:reviewer', true)
    CREDS.set('agent:reviewer', agents.issueCredential('agent:reviewer')?.token ?? '')
  })

  const seed = (over: Record<string, unknown> = {}) =>
    todos.create({ title: '一条待办', projectId: null, createdBy: 'agent:qwen', ...over } as never)

  const close = (id: string, extra: string[] = []) =>
    executeOne(mk(), [
      'todo',
      'close',
      id,
      '--did',
      '做了 X',
      '--verified',
      '跑了 Y，看到 Z',
      '--pass-criteria',
      '目标达成即算过',
      ...extra
    ])

  it('命令存在，且是写档（要授权）', () => {
    const c = commands.find((x) => x.name === 'todo close')
    expect(c, 'todo close 没注册').toBeTruthy()
    expect(c!.risk, '漏标 risk 会被按更严的一档猜，但人看不见').toBe('write')
  })

  it('三个必填缺一不可', async () => {
    const t = seed()
    for (const missing of ['--did', '--verified', '--pass-criteria']) {
      const argv = ['todo', 'close', t.id, '--did', 'x', '--verified', 'y', '--pass-criteria', 'z']
      const i = argv.indexOf(missing)
      argv.splice(i, 2)
      const r = await executeOne(mk(), argv)
      expect(r.ok, `缺 ${missing} 竟然放过了`).toBe(false)
      expect(String((r as { message?: string }).message)).toContain(missing)
    }
  })

  it('--leftover 可留空，但留空会给提醒', async () => {
    const t = seed()
    const withL = await close(t.id, ['--leftover', '有坑'])
    expect(withL.ok).toBe(true)
    expect(withL.notice ?? '', '填了就不该提醒').toBe('')

    const t2 = seed()
    const withoutL = await close(t2.id)
    expect(withoutL.ok).toBe(true)
    expect(withoutL.notice ?? '', '留空要提醒——否则"遗留没人知道"').toContain('取舍与遗留')
  })

  it('写出的评论含四段标记（这是它存在的全部意义）', async () => {
    const t = seed()
    await close(t.id, ['--leftover', '遗留：文档没同步'])
    const list = comments.listByTodo(t.id)
    expect(list.length).toBe(1)
    const body = list[0].body
    for (const seg of ['【做了什么】', '【验证】', '【什么算通过】', '【取舍与遗留】']) {
      expect(body, `缺段落标记 ${seg}`).toContain(seg)
    }
    expect(body).toContain('做了 X')
    expect(body).toContain('文档没同步')
  })

  it('状态推进到已完成', async () => {
    // 从「进行中」由**验收者**收口（1.0.116 起执行者自己从任何一列收口都会被 G10 拦，
    // 拦法见 guard-combination-matrix 那一组）
    const t = seed({ status: 'in_progress' })
    await close(t.id)
    expect(todos.getById(t.id)!.status).toBe('done')
  })

  it('执行者验收自己会被拒（1.0.67 角色定权，close 不绕过）', async () => {
    // 注册 + 批准 + 领凭据（⚠️ 少任何一步都会被身份关卡先拦，
    // 而那条报错与"验收自己被拒"完全无关 —— 我在这上面栽了五次）
    agents.register({ id: 'agent:alice', displayName: 'WB', color: '#111' } as never)
    agents.setApproved('agent:alice', true)
    const c2 = agents.issueCredential('agent:alice')?.token ?? ''
    const t = seed({
      status: 'awaiting_review',
      createdBy: 'agent:alice',
      executedBy: 'agent:alice'
    })
    const r = await executeOne(
      { ...(mk('agent:alice') as object), credential: c2 } as never,
      ['todo', 'close', t.id, '--did', 'x', '--verified', 'y', '--pass-criteria', 'z']
    )
    expect(r.ok, '运动员当裁判竟然放过了').toBe(false)
    expect(r.code).toBe(4)
    expect(comments.listByTodo(t.id)).toEqual([])
    expect(todos.getById(t.id)!.status).toBe('awaiting_review')
  })

  it('评论已写入后状态存储失败，评论和事件全部回滚', async () => {
    const t = seed({ status: 'in_progress' })
    const beforeEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get()
    const beforeTransitions = db.prepare('SELECT COUNT(*) AS n FROM todo_transitions').get()
    const update = vi.spyOn(todos, 'update').mockImplementationOnce(() => {
      throw new Error('故障注入：状态写入失败')
    })
    try {
      const r = await close(t.id)
      expect(r.ok).toBe(false)
      expect(comments.listByTodo(t.id)).toEqual([])
      expect(todos.getById(t.id)!.status).toBe('in_progress')
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(beforeEvents)
      expect(db.prepare('SELECT COUNT(*) AS n FROM todo_transitions').get()).toEqual(beforeTransitions)
    } finally {
      update.mockRestore()
    }
  })

  it('验收别人（≠ 执行者）能收口', async () => {
    agents.register({ id: 'agent:alice', displayName: 'WB', color: '#111' } as never)
    agents.setApproved('agent:alice', true)
    const c2 = agents.issueCredential('agent:alice')?.token ?? ''
    const t = seed({ status: 'awaiting_review', createdBy: 'agent:alice', executedBy: 'human' })
    const r = await executeOne(
      { ...(mk('agent:alice') as object), credential: c2 } as never,
      ['todo', 'close', t.id, '--did', 'x', '--verified', 'y', '--pass-criteria', 'z']
    )
    expect(r.ok, `验收别人应放行（≠执行者）：${(r as { message?: string }).message ?? ''}`).toBe(true)
    expect(todos.getById(t.id)!.status).toBe('done')
  })

  it.each(['proposed', 'discarded'])(
    '%s 状态收口被拒后，不留下伪成功评论和审计',
    async (status) => {
      const t = seed({ status })
      comments.create({ todoId: t.id, body: '原有讨论', authorType: 'agent', authorId: 'agent:qwen', kind: 'comment' })
      const beforeComments = comments.listByTodo(t.id)
      const beforeEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get()
      const beforeTransitions = db.prepare('SELECT COUNT(*) AS n FROM todo_transitions').get()
      const beforeNotifications = db.prepare('SELECT COUNT(*) AS n FROM notifications').get()
      const r = await close(t.id)
      expect(r.ok).toBe(false)
      expect(r.code).toBe(4)
      expect(todos.getById(t.id)!.status).toBe(status)
      expect(comments.listByTodo(t.id)).toEqual(beforeComments)
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(beforeEvents)
      expect(db.prepare('SELECT COUNT(*) AS n FROM todo_transitions').get()).toEqual(beforeTransitions)
      expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual(beforeNotifications)
    }
  )

  it('父事项仍有未完成子项时，收口拒绝且不写结论', async () => {
    const parent = seed({ status: 'in_progress', type: 'feature' })
    seed({ parentId: parent.id, status: 'todo' })
    const r = await close(parent.id)
    expect(r.ok).toBe(false)
    expect(r.code).toBe(4)
    expect(comments.listByTodo(parent.id)).toEqual([])
    expect(todos.getById(parent.id)!.status).toBe('in_progress')
  })

  it('不存在的 id 报 not_found（不是"什么都没发生"）', async () => {
    const r = await close('ffffffff')
    expect(r.ok).toBe(false)
  })

  it('G5 提示要指路到 todo close（软提醒的最短路）', () => {
    // ⚠️ 读源码断言，不 import 那个常量 —— 常量没导出的话 import 会失败，
    // 而我第一版用 `require` + `typeof === 'object'`，那是**恒真断言**。
    const src = readCliChain()
    const i = src.indexOf('const DONE_HINT')
    expect(i, '找不到 DONE_HINT').toBeGreaterThan(-1)
    const j = src.indexOf('\n\n', i)
    const hint = src.slice(i, j)
    expect(hint, 'G5 提示没提 todo close → agent 不知道有这条捷径').toContain('todo close')
  })

  it('说明书要讲清 todo close 的用法', () => {
    const src = readFileSync('src/main/cli/agent-guide.ts', 'utf-8')
    expect(src, '说明书没写 todo close —— agent 不知道有这条捷径').toContain('todo close')
  })
})


