/**
 * 派活送达（卡 `8a671976`）
 *
 * ## 要治的病
 *
 * `52cd076c` 只补了「收口时通知执行方」。而**派活那一刻**没有任何动作：
 * 一张卡被新建并指派给某个 agent（或中途改派）之后，被指派的那位
 * 只有自己跑 `work next`、或翻看板才会发现"这活是我的"。
 *
 * ## 这里钉住的判据
 *
 * 1. 新建派活：带 `--executed-by` 时，被指派者的**收件箱**里就有"谁把哪张卡派给了我"；
 * 2. 改派：`todo update --executed-by` 换人也要送达；
 * 3. 防刷屏：同一张卡重复派给同一人只留一条未读 —— 判据在**数据层**，不靠调用方自觉；
 * 4. 自己派给自己不通知；
 * 5. 派给 human 不落单条，走 `work next` 的 `waitingForHuman` 汇总；
 * 6. 派活的人能在 `work next.dispatched` 上对账：对方读了没有。
 *
 * 断言一律落在**真实 CLI 回执 + 库里的通知行**上，不测内部函数。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const db = new Database(':memory:')

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { executeOne } from '../../../src/main/cli/command-exec'
import type { CliContext } from '../../../src/main/cli/command-core'

function makeCtx(actor: string): CliContext {
  return {
    actor,
    identityDeclared: true,
    credentialVerified: true,
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo: new ProjectRepository(),
      settingsRepo: new SettingsRepository(),
      agentRepo: new AgentRepository(),
      releaseRepo: new ReleaseRepository(),
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      memoRepo: new MemoRepository(),
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
    },
    meta: {
      version: '1.0.139',
      dbPath: ':memory:',
      schemaVersion: 48,
      busyTimeoutMs: 5000,
      channels: ['pipe', 'headless'],
      via: 'pipe',
      startedAt: Date.now()
    },
    interactive: true
  } as unknown as CliContext
}

interface Delivery {
  to: string
  via: 'notification' | 'aggregate'
  created: boolean
  notificationId: string | null
}

/** 库里这张卡上所有通知（不经过任何读侧过滤，专门验"写了几条"） */
interface NotificationRow {
  id: string
  type: string
  actor: string | null
  recipient: string | null
  ref_id: string | null
}

function notificationRowsFor(todoId: string): NotificationRow[] {
  return db
    .prepare('SELECT id, type, actor, recipient, ref_id FROM notifications WHERE ref_id = ?')
    .all(todoId) as NotificationRow[]
}

describe('派活送达（卡 8a671976）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec(`
      DELETE FROM todos;
      DELETE FROM projects;
      DELETE FROM categories;
      DELETE FROM memos;
      DELETE FROM notifications;
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
    `)
    const agents = new AgentRepository()
    for (const id of ['agent:alice', 'agent:bob', 'agent:carol', 'agent:dave']) {
      agents.register({ id, displayName: id.slice(6) })
      agents.setApproved(id, 'human')
    }
    // 分类留空时 repo 会回退到第一个分类，先给一个免得落到"没有分类"的分支
    new CategoryRepository().create({ name: '工作', color: '#3b82f6' })
    // 事项必填项目（1.0.40 起）：夹具先建一个，免得每条用例都报缺参
    new ProjectRepository().create({ name: '派活测试' })
  })

  it('1. 新建派活：被指派的 agent 不跑 work next，也能在收件箱里看到谁把哪张卡派给了我', async () => {
    const alice = makeCtx('agent:alice')
    const bob = makeCtx('agent:bob')

    const created = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '核对导出清单',
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { id: string; title: string; assignmentDelivered?: Delivery } }

    expect(created.ok).toBe(true)
    const id = created.data.id
    // 回执当场告诉派活的人"送到了"，且给的就是库里那一行（不是另写一条）
    expect(created.data.assignmentDelivered).toMatchObject({ to: 'agent:bob', via: 'notification' })
    const rows = notificationRowsFor(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(created.data.assignmentDelivered?.notificationId)

    // 被指派的人只查收件箱（不跑 work next）就能知道这件事与派活的人
    const inbox = (await executeOne(bob, ['notification', 'list', '--to-me', '--unread'])) as {
      ok: boolean
      data: { notifications: Array<{ type: string; title: string; summary: string; refId: string; actor: string; recipient: string }> }
    }
    expect(inbox.ok).toBe(true)
    expect(inbox.data.notifications).toHaveLength(1)
    const notice = inbox.data.notifications[0]
    expect(notice.type).toBe('reminder')
    expect(notice.recipient).toBe('agent:bob')
    expect(notice.actor).toBe('agent:alice')
    // refId 指向那张卡：点开能回链
    expect(notice.refId).toBe(id)
    expect(notice.title).toContain('核对导出清单')
    expect(notice.summary).toContain('agent:alice')
    expect(notice.summary).toContain(id.slice(0, 8))
  })

  it('2. 改派：todo update --executed-by 换人时，新执行方收到一条，原执行方不再收到', async () => {
    const alice = makeCtx('agent:alice')
    const bob = makeCtx('agent:bob')
    const carol = makeCtx('agent:carol')

    const created = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '整理回归清单',
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { id: string } }
    const id = created.data.id

    const moved = (await executeOne(alice, [
      'todo',
      'update',
      id.slice(0, 8),
      '--executed-by',
      'agent:carol'
    ])) as { ok: boolean; data: { executedBy: string; assignmentDelivered?: Delivery } }
    expect(moved.ok).toBe(true)
    expect(moved.data.executedBy).toBe('agent:carol')
    expect(moved.data.assignmentDelivered).toMatchObject({ to: 'agent:carol', via: 'notification' })
    expect(moved.data.assignmentDelivered?.notificationId).toBeTruthy()

    const carolInbox = (await executeOne(carol, ['notification', 'list', '--to-me', '--unread'])) as {
      data: { notifications: Array<{ refId: string; actor: string; recipient: string }> }
    }
    expect(carolInbox.data.notifications).toHaveLength(1)
    expect(carolInbox.data.notifications[0]?.refId).toBe(id)
    expect(carolInbox.data.notifications[0]?.actor).toBe('agent:alice')

    // bob 那条还在（他没读过），但不会因为这次改派多出一条新的
    const bobRows = notificationRowsFor(id).filter((r) => r.recipient === 'agent:bob')
    expect(bobRows).toHaveLength(1)
  })

  it('3. 防刷屏：同一张卡重复派给同一人只记一条（判据在数据层，不靠调用方自觉）', async () => {
    const alice = makeCtx('agent:alice')

    const created = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '反复改派的那张卡',
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { id: string } }
    const id = created.data.id
    const rowsAfterCreate = notificationRowsFor(id)
    expect(rowsAfterCreate).toHaveLength(1)
    const bobRowId = rowsAfterCreate[0]?.id

    // bob → carol → bob：绕一圈回到 bob。bob 那条**还没读**，所以不再写第二条
    await executeOne(alice, ['todo', 'update', id.slice(0, 8), '--executed-by', 'agent:carol'])
    const back = (await executeOne(alice, [
      'todo',
      'update',
      id.slice(0, 8),
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { assignmentDelivered?: Delivery } }

    // 回执里给回的是**同一条**通知（去重生效的证据：行 id 没变），库里也不新增
    expect(back.data.assignmentDelivered).toMatchObject({ to: 'agent:bob', via: 'notification' })
    expect(back.data.assignmentDelivered?.notificationId).toBe(bobRowId)
    const rows = notificationRowsFor(id)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.recipient === 'agent:bob')).toHaveLength(1)
    expect(rows.filter((r) => r.recipient === 'agent:carol')).toHaveLength(1)
  })

  it('4. 自己派给自己不通知', async () => {
    const alice = makeCtx('agent:alice')

    const created = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '我自己要做的事',
      '--executed-by',
      'agent:alice'
    ])) as { ok: boolean; data: { id: string; assignmentDelivered?: Delivery } }

    expect(created.ok).toBe(true)
    expect(created.data.assignmentDelivered).toBeUndefined()
    expect(notificationRowsFor(created.data.id)).toHaveLength(0)

    // 改派那条路同样：把执行方从别人改回自己也不通知
    const other = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '先派给别人再收回',
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { id: string } }
    const takeBack = (await executeOne(alice, [
      'todo',
      'update',
      other.data.id.slice(0, 8),
      '--executed-by',
      'agent:alice'
    ])) as { ok: boolean; data: { assignmentDelivered?: Delivery } }
    expect(takeBack.data.assignmentDelivered).toBeUndefined()
    expect(notificationRowsFor(other.data.id).filter((r) => r.recipient === 'agent:alice')).toHaveLength(0)
  })

  it('5. 派给 human 不落单条通知，按 work next 的 waitingForHuman 口径归集', async () => {
    const alice = makeCtx('agent:alice')
    const human = makeCtx('human')

    const created = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '请主用户定稿首屏文案',
      '--executed-by',
      'human'
    ])) as { ok: boolean; data: { id: string; assignmentDelivered?: Delivery } }

    expect(created.data.assignmentDelivered).toMatchObject({
      to: 'human',
      via: 'aggregate',
      notificationId: null
    })
    // 不单条轰炸：库里一条通知都没写
    expect(notificationRowsFor(created.data.id)).toHaveLength(0)

    const work = (await executeOne(human, ['work', 'next'])) as {
      ok: boolean
      data: {
        waitingForHuman: {
          assignedToHumanTodos: number
          assignedTodos: Array<{ todoId: string; title: string; status: string; from: string }>
        }
      }
    }
    expect(work.ok).toBe(true)
    expect(work.data.waitingForHuman.assignedToHumanTodos).toBe(1)
    expect(work.data.waitingForHuman.assignedTodos).toHaveLength(1)
    expect(work.data.waitingForHuman.assignedTodos[0]).toMatchObject({
      todoId: created.data.id,
      title: '请主用户定稿首屏文案',
      status: 'todo',
      from: 'agent:alice'
    })
  })

  it('6. 主用户/发起方在 work next 对账：我派出去的活，对方读了没有', async () => {
    const alice = makeCtx('agent:alice')
    const bob = makeCtx('agent:bob')

    const created = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '补一版导出脚本',
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { id: string } }
    const id = created.data.id

    type Dispatched = {
      total: number
      delivered: number
      pending: number
      items: Array<{ todoId: string; title: string; to: string; delivered: boolean }>
    }
    const before = (await executeOne(alice, ['work', 'next'])) as {
      ok: boolean
      data: { dispatched: Dispatched; nextSteps: string[] }
    }
    expect(before.ok).toBe(true)
    expect(before.data.dispatched).toMatchObject({ total: 1, delivered: 0, pending: 1 })
    expect(before.data.dispatched.items[0]).toMatchObject({
      todoId: id,
      title: '补一版导出脚本',
      to: 'agent:bob',
      delivered: false
    })
    // 还没送到要在 nextSteps 里说出来，不能只在数字里躺着
    expect(before.data.nextSteps.join('\n')).toContain('还没看那条通知')

    // 执行方确认了那条派活通知（agent 侧的"读过"按 read_by 记）
    const ack = (await executeOne(bob, ['notification', 'list', '--to-me', '--ack-mine'])) as { ok: boolean }
    expect(ack.ok).toBe(true)

    const after = (await executeOne(alice, ['work', 'next'])) as {
      ok: boolean
      data: { dispatched: Dispatched }
    }
    expect(after.data.dispatched).toMatchObject({ total: 1, delivered: 1, pending: 0 })
    expect(after.data.dispatched.items[0]?.delivered).toBe(true)
  })

  it('7. 已经收口的事登记执行者不算派活：记流水不推「派活给你」', async () => {
    const alice = makeCtx('agent:alice')

    // `todo add --status done` 是记一笔工作流水：执行者 = 谁干的，不是派给谁
    const logged = (await executeOne(alice, [
      'todo',
      'add',
      '--project',
      '派活测试',
      '--title',
      '昨晚的导出脚本跑完了',
      '--status',
      'done',
      '--executed-by',
      'agent:bob'
    ])) as { ok: boolean; data: { id: string; assignmentDelivered?: Delivery } }

    expect(logged.ok).toBe(true)
    expect(logged.data.assignmentDelivered).toBeUndefined()
    expect(notificationRowsFor(logged.data.id)).toHaveLength(0)
  })

  it('8. 界面快速添加（主进程直接 todoRepo.create，不经命令层）同样送达，主用户能对上账', async () => {
    const human = makeCtx('human')
    const bob = makeCtx('agent:bob')
    const project = new ProjectRepository().list()[0]

    // 界面这条路不带 actor：主进程 'todo:create' 就是 `todoRepo.create(input)`
    const todo = human.deps.todoRepo.create({
      title: '界面里派出去的活',
      projectId: project?.id,
      executedBy: 'agent:bob'
    })

    const rows = notificationRowsFor(todo.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'reminder',
      actor: 'human',
      recipient: 'agent:bob',
      ref_id: todo.id
    })

    // 执行方不跑 work next，收件箱里就有
    const inbox = (await executeOne(bob, ['notification', 'list', '--to-me', '--unread'])) as {
      data: { notifications: Array<{ refId: string; actor: string }> }
    }
    expect(inbox.data.notifications).toHaveLength(1)
    expect(inbox.data.notifications[0]?.refId).toBe(todo.id)
    expect(inbox.data.notifications[0]?.actor).toBe('human')

    // 主用户对上账：我派出去这件，对方还没读
    const work = (await executeOne(human, ['work', 'next'])) as {
      data: {
        dispatched: { total: number; delivered: number; pending: number; items: Array<{ todoId: string; to: string }> }
      }
    }
    expect(work.data.dispatched).toMatchObject({ total: 1, delivered: 0, pending: 1 })
    expect(work.data.dispatched.items[0]).toMatchObject({ todoId: todo.id, to: 'agent:bob' })
  })

  it('9. 界面改派（todoRepo.update + actor:human）送达；重复派给同一人不新增，改别处不推通知', async () => {
    const human = makeCtx('human')
    const project = new ProjectRepository().list()[0]
    const todo = human.deps.todoRepo.create({
      title: '界面里改派',
      projectId: project?.id,
      executedBy: 'agent:bob'
    })
    expect(notificationRowsFor(todo.id)).toHaveLength(1)

    human.deps.todoRepo.update({ id: todo.id, executedBy: 'agent:carol', actor: 'human' })
    const afterMove = notificationRowsFor(todo.id)
    expect(afterMove).toHaveLength(2)
    expect(afterMove.filter((r) => r.recipient === 'agent:carol')).toHaveLength(1)

    // 绕回 bob：他那条还没读，数据层判定"已有未读"，不写第二条
    human.deps.todoRepo.update({ id: todo.id, executedBy: 'agent:bob', actor: 'human' })
    // 与执行者无关的更新不该推通知
    human.deps.todoRepo.update({ id: todo.id, title: '界面里改派（改名）', actor: 'human' })
    const after = notificationRowsFor(todo.id)
    expect(after).toHaveLength(2)
    expect(after.filter((r) => r.recipient === 'agent:bob')).toHaveLength(1)
  })

  it('10. 备份导入（skipGuards）不送达：恢复的是历史，不该逐卡推送', async () => {
    const human = makeCtx('human')
    const project = new ProjectRepository().list()[0]
    const todo = human.deps.todoRepo.create({
      title: '导入回来的旧卡',
      projectId: project?.id,
      createdBy: 'agent:alice',
      executedBy: 'agent:bob',
      skipGuards: true
    })
    expect(notificationRowsFor(todo.id)).toHaveLength(0)
  })
})
