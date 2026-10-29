import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne, EXIT_CODES } from '../../../src/main/cli/commands'
import { TodoRepository, ConflictError } from '../../../src/main/database/todo.repository'
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
 * 乐观锁 --if-updated-at（1.0.73，`9947bf5a`）
 *
 * ## 它治的病
 *
 * 多主体同时改同一条时会**互相覆盖，后写的赢且无人察觉**。
 * 本机有四个写入方共写同一份 SQLite 是**当前事实**；
 * `withWriteRetry` 只保证"两个写不打架"，**不保证第二个写的人
 * 看到的是第一个写的结果** —— 它把 A 刚改的内容原样盖掉，谁都不知道。
 *
 * ## 判据（卡上原文）
 *
 * update 可选带 `--if-updated-at`，版本不符则**返回冲突码**，
 * 让调用方自己决定重读还是放弃。
 *
 * ⚠️ 本项目这一层最容易出的错是**"参数收下了却没传下去"**
 * （TESTING.md 点名的类型：tsc 抓不到、repository 单测也走不到）。
 * 所以这份测试的重点是**端到端**：CLI 进 → 库出，看它到底生效没有。
 */
describe('乐观锁 --if-updated-at（9947bf5a）', () => {
  let todos: TodoRepository
  const CRED = { v: '' }

  const mkCtx = (actor = 'agent:alice') =>
    ({
      deps: {
        todoRepo: todos,
        commentRepo: new CommentRepository(),
        memoRepo: new MemoRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        settingsRepo: { get: () => ({}) },
        agentRepo: new AgentRepository(),
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.73', dbPath: ':memory:', schemaVersion: 31, via: 'pipe' },
      interactive: true,
      actor,
      credential: CRED.v
    }) as never

  beforeEach(async () => {
    await runMigrations(db)
    for (const t of [
      'todo_transitions',
      'todo_comments',
      'todos',
      'categories',
      'projects',
      'agent_grants',
      'agents'
    ]) {
      db.exec(`DELETE FROM ${t};`)
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
    /**
     * ⚠️ "另一个写入方"必须**真的注册过**，否则它会先撞身份关卡
     * （`assertRegisteredActor`）—— 于是 B 那次 update 根本没改成，
     * 后续断言变成"我拿一个和被改前相同的版本去改，当然不冲突"，
     * 测试红在一个与本机制无关的地方。本机真实场景里Bob是注册过的。
     */
    const agents = new AgentRepository()
    for (const id of ['agent:alice', 'agent:bob']) {
      agents.register({ id, displayName: id, color: '#111' } as never)
      agents.setApproved(id, true)
    }
    CRED.v = agents.issueCredential('agent:alice')?.token ?? ''
  })

  const seed = (over: Record<string, unknown> = {}) =>
    todos.create({
      title: '一件事',
      projectId: null,
      createdBy: 'agent:alice',
      ...over
    } as never)

  // ── 第一组：版本不符时必须拦下，且不留任何痕迹 ──

  it('版本不符 → 返回冲突码（不是笼统的 1，agent 才知道该重读而非重试）', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', '新标题', '--if-updated-at', '1999-01-01T00:00:00.000Z'
    ])
    expect(r.ok, '版本不符必须被拒').toBe(false)
    expect(
      r.code,
      `冲突应归到独立的退出码 ${EXIT_CODES.conflict}，拿到 1 的 agent 会盲重试 —— ` +
        `而重试会再撞一次，还可能把别人刚改的盖掉`
    ).toBe(EXIT_CODES.conflict)
    expect(r.errorCode, '调用方要能按 code 分流').toBe('conflict')
  })

  it('版本不符 → 一个字段都不写（不留部分改动）', async () => {
    const t = seed()
    const before = todos.getById(t.id)!
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', '不该改上去', '--priority', 'urgent', '--if-updated-at', 'bad'
    ])
    expect(r.ok).toBe(false)
    const after = todos.getById(t.id)!
    expect(after.title, '标题不该动').toBe(before.title)
    expect(after.priority, '优先级也不该动').toBe(before.priority)
    expect(after.updatedAt, '连 updatedAt 都不该动').toBe(before.updatedAt)
  })

  it('版本不符 → 不留流转记录（状态也不该被推）', async () => {
    const t = seed()
    todos.update({ id: t.id, status: 'in_progress' } as never)
    const snapshot = todos.getById(t.id)!.updatedAt
    const transitionsBefore = todos.listTransitions(t.id).length

    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--status', 'awaiting_review', '--if-updated-at', snapshot + 'x'
    ])
    expect(r.ok).toBe(false)
    expect(todos.getById(t.id)!.status, '状态不该被推').toBe('in_progress')
    expect(
      todos.listTransitions(t.id).length,
      '被拒时不该留下流转 —— 动态里凭空多一段过程比报错更难查'
    ).toBe(transitionsBefore)
  })

  it('版本一致 → 正常放行（不做无谓拦截）', async () => {
    const t = seed()
    const seen = todos.getById(t.id)!.updatedAt
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', '改好了', '--if-updated-at', seen
    ])
    expect(r.ok, `版本一致却被拒：${(r as { message?: string }).message}`).toBe(true)
    expect(todos.getById(t.id)!.title).toBe('改好了')
  })

  it('不带 --if-updated-at → 保持原行为（向后兼容，不引入新的失败路径）', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), ['todo', 'update', t.id, '--title', '照旧'])
    expect(r.ok).toBe(true)
    expect(todos.getById(t.id)!.title).toBe('照旧')
  })

  // ── 第二组：真正防住"后写的赢且无人察觉" ──

  it('A 读过之后 B 改了，A 拿着旧版本改 → 拦下（这就是那类病的正面用例）', async () => {
    const t = seed()

    // A 读到版本
    const aSees = todos.getById(t.id)!.updatedAt

    // B 抢先改了（另一次 update，更新时间戳）
    await executeOne(mkCtx('agent:bob'), ['todo', 'update', t.id, '--title', 'B 改的'])
    const bWrote = todos.getById(t.id)!.title
    expect(bWrote).toBe('B 改的')

    // A 拿着"读到的旧版本"来改 —— 若放行，B 的改动就被静默覆盖
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', 'A 覆盖上来', '--if-updated-at', aSees
    ])
    expect(r.ok, 'A 拿着过期版本改，必须拦下').toBe(false)
    expect(r.code).toBe(EXIT_CODES.conflict)
    expect(
      todos.getById(t.id)!.title,
      'B 刚改的内容必须还在 —— 拦住的意义就在这里'
    ).toBe('B 改的')
  })

  it('冲突报错要能自解释：说清"你读到的是 X、现在是 Y、该怎么办"', async () => {
    const t = seed()
    const old = todos.getById(t.id)!.updatedAt
    await executeOne(mkCtx('agent:bob'), ['todo', 'update', t.id, '--title', '别人改的'])

    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', 'x', '--if-updated-at', old
    ])
    const msg = String((r as { message?: string }).message)
    expect(msg, '要说清版本对不上').toMatch(/被别人改过/)
    // 只说"冲突了"没用 —— 调用方得知道该干什么
    expect(msg, '要指路：重读再决定，而不是重试').toMatch(/todo get/)
    expect(msg, '要把两个版本都亮出来，方便比对').toContain(old)
  })

  // ── 第三组：参数面与边界 ──

  /**
   * 这条拦的是"以为带了锁就等于改了"。
   *
   * 判据：`--if-updated-at` 是**前提条件**不是**字段** ——
   * 只带它不带任何真改动，就该报"至少要指定一个要改的字段"。
   * 若把它算进 `changed`，这条命令会返回 ok:true 而数据没动 ——
   * 正是 `todo update` 一直在治的假成功。
   */
  it('只带 --if-updated-at 不带任何字段 → 报错（它是前提条件，不是"改了东西"）', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--if-updated-at', todos.getById(t.id)!.updatedAt
    ])
    expect(r.ok, '没有任何真改动，不该报成功').toBe(false)
    expect(String((r as { message?: string }).message)).toMatch(/至少要指定一个要改的字段/)
  })

  it('--if-updated-at 传空串 → 用法错误（不留下"永远冲突"的谜题）', async () => {
    const t = seed()
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', 'x', '--if-updated-at', ''
    ])
    expect(r.ok).toBe(false)
    expect(r.code, '这是参数用法问题，不是冲突').toBe(EXIT_CODES.usage)
    expect(r.errorCode).toBe('usage_error')
  })

  /**
   * 库里 `updated_at` 混着两种写法（实测本机真实库）：
   * `2026-10-07T09:23:21.587818`（6 位、无 Z）与 `...750Z`（3 位、带 Z）。
   * 所以实现必须是**精确字符串比对** ——
   * 一旦在某处"顺手规范化"成 Date 或补 Z，比对就永远不成立，
   * 而失败方式很安静（每次都报冲突，人以为是"并发太多"）。
   */
  it('6 位微秒、无 Z 的历史时间戳也能精确比对（库里真实存在这种写法）', async () => {
    const t = seed()
    // 直接落一个历史脚本风格的时间戳（Python isoformat）
    const legacy = '2026-10-07T09:23:21.587818'
    db.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(legacy, t.id)

    const ok = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', '按历史时间戳改', '--if-updated-at', legacy
    ])
    expect(ok.ok, '原样传回就该放行 —— 任何解析/规范化都会让这条红').toBe(true)

    const stale = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--title', '不该改', '--if-updated-at', '2026-10-07T09:23:21.587817'
    ])
    expect(stale.ok, '差 1 微秒也是不同版本，必须拦下').toBe(false)
    expect(stale.code).toBe(EXIT_CODES.conflict)
  })

  it('两处锁都在：repository 层直接调用也拦（不只 CLI 层有）', () => {
    const t = seed()
    expect(() =>
      todos.update({ id: t.id, title: 'x', ifUpdatedAt: 'nope' } as never)
    ).toThrow(ConflictError)
    // 且必须是 ConflictError 类型 —— 靠 instanceof 归类，靠文案匹配会在下次润色时静默退化
    try {
      todos.update({ id: t.id, title: 'x', ifUpdatedAt: 'nope' } as never)
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError)
      expect((e as Error).message).toMatch(/被别人改过/)
    }
  })

  /**
   * 冲突必须**先于**守卫判定被认出来。
   *
   * 若反过来（守卫先跑），调用方拿到的会是"守卫拒绝"——
   * 那会骗它"重试无用、等人操作"，而正确动作其实是"重读"。
   * **错误码决定调用方的下一步，不能被抢跑。**
   */
  it('冲突与守卫同时成立时，报冲突而不是守卫（决定调用方下一步的是错误码）', async () => {
    // 造一个 G10 场景（待验收 + 执行者=自己），再带上过期的 if-updated-at
    const t = seed({ status: 'awaiting_review', executedBy: 'agent:alice' })
    const r = await executeOne(mkCtx(), [
      'todo', 'update', t.id, '--status', 'done', '--if-updated-at', 'stale-version'
    ])
    expect(r.ok).toBe(false)
    expect(
      r.errorCode,
      'G10 与冲突同时成立时该报冲突：报 guard 会让 agent 以为"等人操作"，而它该做的是重读'
    ).toBe('conflict')
  })

  /**
   * `withWriteRetry` 只对 SQLITE_BUSY / LOCKED / READONLY 重试，其余直接抛。
   * 这条钉住"冲突不会被误当成可重试错误"——
   * 若被重试，第二次仍会冲突，但若实现写错（比如先写后比），
   * 重试就变成了"把别人的改动反复覆盖"。
   */
  it('冲突不是可重试错误（不会被 withWriteRetry 悄悄重放）', () => {
    const t = seed()
    const old = todos.getById(t.id)!.updatedAt
    todos.update({ id: t.id, title: '别人改的' } as never)
    expect(() =>
      todos.update({ id: t.id, title: 'A 覆盖', ifUpdatedAt: old } as never)
    ).toThrow(ConflictError)
    // 抛出来之后库里仍是别人的内容，没有被重放写坏
    expect(todos.getById(t.id)!.title).toBe('别人改的')
  })
})
