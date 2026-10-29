import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeApproved, executeOne } from '../../../src/main/cli/commands'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 批准回放撞上"需要 --force"的二次确认（卡 `f9cd007e`）
 *
 * ## 现场（1.0.111，2026-10-22）
 *
 * agent 发 `todo rm a50de325 --yes`（该卡有 1 个子任务）→ 生成授权申请 →
 * 主用户在审批页点「允许并执行」→ 回放被守卫挡下：
 * 「确认要删请加 --force」—— **那句话是给 agent 看的指令，她在界面上补不上**。
 * 结果是：她点了一次头，事没做成，而下一步该怎么办没人告诉她。
 *
 * ## 判据（卡面原文）
 *
 * 拿一张有子任务的卡发删除授权 → 用户点允许后，
 * **要么删除真的发生，要么授权仍然有效并明确告诉她下一步**；
 * 不能出现「点了、失败了、批准也没了」这一种。
 *
 * ## 这条用例钉的三件事
 *
 * 1. 回放因守卫失败**不消耗**授权（真库里 446527da 证实当时确实是这个行为，
 *    缺的是第 2、3 条）；
 * 2. 同一条授权**允许补一个 `--force`** 再回放一次 —— 只补这一个、别的参数一动就作废；
 * 3. 补上之后真的删掉，那时授权才被销账（不出现"批一次、动两次"）。
 *
 * ⭐ 反向验证：把 `grantCoversArgv` 里的 `--force` 放宽去掉 → 第 2 条红（回放仍是 grant_required）；
 * 把成功路径的销账改成"任何路径都销账" → 第 1 条红。
 */
describe('批准回放撞 --force：不消耗授权，允许补一次强制（f9cd007e）', () => {
  let todos: TodoRepository
  let agents: AgentRepository
  let comments: CommentRepository
  let credential = ''

  const AGENT = 'agent:bob'

  const mkCtx = (extra: Record<string, unknown> = {}) =>
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
      meta: { version: 'test', dbPath: ':memory:', schemaVersion: 99, via: 'pipe' },
      actor: AGENT,
      credential,
      ...extra
    }) as never

  beforeAll(() => runMigrations(db))

  beforeEach(() => {
    for (const table of [
      'todos',
      'todo_comments',
      'todo_transitions',
      'agent_grants',
      'notifications',
      'memos',
      'events',
      'categories',
      'projects'
    ]) {
      db.prepare(`DELETE FROM ${table}`).run()
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    agents = new AgentRepository()
    agents.register({ id: AGENT, displayName: 'Q', color: '#111' } as never)
    agents.setApproved(AGENT, true)
    credential = agents.issueCredential(AGENT)?.token ?? ''
    todos = new TodoRepository()
    comments = new CommentRepository()
  })

  /** 一张有待办子任务的卡 —— 正是 `todo rm` 会要 `--force` 的那个形状 */
  const parentWithChild = () => {
    const parent = todos.create({ title: '父', projectId: null, createdBy: AGENT } as never)
    todos.create({ title: '子', projectId: null, parentId: parent.id, createdBy: AGENT } as never)
    return parent
  }

  const requestRmGrant = (todoId: string) => {
    const grant = agents.requestGrant({
      agentId: AGENT,
      scope: 'destructive',
      command: 'todo rm',
      summary: '删掉这张卡',
      targetIds: [todoId],
      // 与真库里的申请同形（446527da）：删除档在申请时由服务端补上 --yes
      requestArgv: ['todo rm', todoId, '--yes']
    })
    agents.resolveGrant(grant.id, true) // 人在审批页点了「允许并执行」
    return agents.getGrant(grant.id)!
  }

  it('点允许后被子任务守卫挡下：授权仍是 granted（没被这次失败吃掉）', async () => {
    const t = parentWithChild()
    const grant = requestRmGrant(t.id)

    const r = await executeApproved(mkCtx(), grant.requestArgv, { agentId: AGENT, grantId: grant.id })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('--force')
    // 卡还在，什么都没删 —— 失败不该有副作用
    expect(todos.getById(t.id)).not.toBeNull()
    // ⭐ 判据：点了、失败了，但批准还在
    expect(agents.getGrant(grant.id)!.status, '回放失败不许消耗人的点头').toBe('granted')
  })

  it('补一个 --force 再回放：同一条授权放行，卡真的删掉，授权这才销账', async () => {
    const t = parentWithChild()
    const grant = requestRmGrant(t.id)

    const first = await executeApproved(mkCtx(), grant.requestArgv, { agentId: AGENT, grantId: grant.id })
    expect(first.ok).toBe(false)

    const forced = await executeApproved(mkCtx(), [...grant.requestArgv, '--force'], {
      agentId: AGENT,
      grantId: grant.id
    })
    expect(forced.ok, JSON.stringify(forced)).toBe(true)
    expect(todos.getById(t.id)).toBeNull()
    expect(agents.getGrant(grant.id)!.status, '做成之后才销账').toBe('consumed')
  })

  it('补 --force 不是万能通行证：顺手改目标就作废（批准的仍是那一条）', async () => {
    const t = parentWithChild()
    const other = todos.create({ title: '另一张', projectId: null, createdBy: AGENT } as never)
    const grant = requestRmGrant(t.id)

    const r = await executeApproved(mkCtx(), ['todo rm', other.id, '--force'], {
      agentId: AGENT,
      grantId: grant.id
    })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('grant_required')
    expect(todos.getById(other.id), '不能换个目标就删').not.toBeNull()
    expect(todos.getById(t.id)).not.toBeNull()
  })

  it('补 --force 只放宽一步：再加别的参数也作废', async () => {
    const t = parentWithChild()
    const grant = requestRmGrant(t.id)
    const r = await executeApproved(mkCtx(), [...grant.requestArgv, '--force', '--yes', '--force'], {
      agentId: AGENT,
      grantId: grant.id
    })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('grant_required')
  })

  it('没有子任务时一次就成（这条放宽不该改变正常路径）', async () => {
    const plain = todos.create({ title: '干净的卡', projectId: null, createdBy: AGENT } as never)
    const grant = requestRmGrant(plain.id)
    const r = await executeApproved(mkCtx(), grant.requestArgv, { agentId: AGENT, grantId: grant.id })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(todos.getById(plain.id)).toBeNull()
    expect(agents.getGrant(grant.id)!.status).toBe('consumed')
  })

  it('agent 自己重试仍走门禁（没有人工批准的 force 不放行）', async () => {
    const t = parentWithChild()
    const r = await executeOne(mkCtx(), ['todo', 'rm', t.id, '--force'])
    // 删除档在门禁层先要授权：没有 preApprovedGrantId 就是 grant_required
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('grant_required')
    expect(todos.getById(t.id)).not.toBeNull()
  })
})
