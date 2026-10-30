import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import type { ProjectPurgeResult } from '../../../src/renderer/types/project'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 永久删除项目的验收（卡 `c177e466`，口径来自主用户 2026-10-09 拍板）
 *
 * 卡的验收原文留着对照：
 *  ① 归档后项目与全部事项/评论/版本仍可查且可恢复
 *  ② 永久删除后目标项目及其所有项目内记录清零、其他项目数据不变
 *  ③ 故障注入时整个删除事务回滚
 *  ④ 不存在被删除项目遗留的无项目事项
 *  ⑤ 有数据旧库副本与 GUI/仓储测试通过
 *  ⑥ 不把"低于 200ms"当未经测量的承诺
 *
 * 关于 ⑥：这个文件**一条耗时断言都没有**。删多快取决于库多大、磁盘多快，
 * 拿单机一次测量当承诺，是这张卡一开始就在防的那种"看着像证据"的话。
 * 这里只断言**可核对的事实**：谁被清掉了、谁没被动、失败了有没有退回去。
 *
 * 为什么单开一个文件：`project.repository.test.ts` 只钉 `delete()` 的契约
 * （旧契约"先迁走再删"的用例就写在那里，1.0.111 已随口径一起改），
 * 而这里钉的是**验收条件**——逐表清零、别的项目一行不少、注入故障要回滚。
 *
 * 外键按**生产配置**打开（`src/main/database/index.ts` 里 `foreign_keys = ON`）：
 * 关着外键测"清干净了"会变成测试环境的假象（二级级联根本不触发）。
 */
const CAT = 'c1'

/** 回执里的键 → 真实表名，顺序与 `ProjectPurgeResult.removed` 一致 */
const TABLES: Array<[keyof ProjectPurgeResult['removed'], string]> = [
  ['todos', 'todos'],
  ['comments', 'todo_comments'],
  ['transitions', 'todo_transitions'],
  ['todoCategories', 'todo_categories'],
  ['notifications', 'notifications'],
  ['releases', 'releases'],
  ['handoffRevisions', 'project_handoff_revisions'],
  ['handoffProposals', 'project_handoff_proposals'],
  ['collaborationRules', 'collaboration_rules'],
  ['permissionMatrix', 'permission_matrix'],
  ['profileBlocks', 'profile_blocks'],
  ['profileProposals', 'profile_proposals'],
  ['profileRevisions', 'profile_revisions'],
  ['protocolBlocks', 'protocol_blocks'],
  ['protocolProposals', 'protocol_proposals'],
  ['ruleProposals', 'rule_proposals'],
  ['ruleRevisions', 'rule_revisions']
]

/** 只挂在事项上的三张表：它们通过 todo_id 间接属于项目 */
const TODO_SCOPED = new Set(['todo_comments', 'todo_transitions', 'todo_categories'])

const countAll = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

/** 某张表里"属于这个项目"的行数 —— 用来证明删除没有波及别的项目 */
const countForProject = (table: string, projectId: string): number => {
  const sql =
    table === 'todos'
      ? 'SELECT COUNT(*) AS n FROM todos WHERE project_id = ?'
      : TODO_SCOPED.has(table)
        ? `SELECT COUNT(*) AS n FROM ${table} WHERE todo_id IN (SELECT id FROM todos WHERE project_id = ?)`
        : table === 'notifications'
          ? 'SELECT COUNT(*) AS n FROM notifications WHERE ref_id IN (SELECT id FROM todos WHERE project_id = ?)'
          : `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`
  return (db.prepare(sql).get(projectId) as { n: number }).n
}

describe('永久删除项目：清空、可核对、可回滚（卡 c177e466）', () => {
  let projects: ProjectRepository
  let todos: TodoRepository
  let comments: CommentRepository
  let notifications: NotificationRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    // 清理要跨表删（子表引用父表），先关外键、清完再按生产配置打开
    db.pragma('foreign_keys = OFF')
    for (const [, table] of TABLES) db.prepare(`DELETE FROM ${table}`).run()
    db.prepare('DELETE FROM events').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    db.pragma('foreign_keys = ON')

    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, '工作', '#5388F6', 1, 0)"
    ).run(CAT)

    projects = new ProjectRepository()
    todos = new TodoRepository()
    comments = new CommentRepository()
    notifications = new NotificationRepository()
  })

  /** 给项目造一份"什么都有"的数据：事项 + 评论 + 流转 + 通知 */
  const seed = (projectId: string, tag: string) => {
    const todo = todos.create({ title: `${tag} 的事`, categoryIds: [CAT], projectId })
    comments.create({ todoId: todo.id, body: `${tag} 的评论` })
    // 推进一次状态：落一条 todo_transitions（这张表**没有外键**，级联删不掉）
    todos.update({ id: todo.id, status: 'in_progress', actor: 'agent:dave' })
    notifications.create({ type: 'review', title: `${tag} 的通知`, refId: todo.id })
    return todo
  }

  // ── ① 归档：是"让项目消失"的那条路，必须可逆 ──
  it('归档后项目与全部事项/评论/版本仍可查，取消归档即回到候选', () => {
    const p = projects.create({ name: '归档我' })
    const todo = seed(p.id, '归档前')
    projects.saveHandoff(p.id, '# 接手说明\n归档前的版本', 'human')

    projects.update({ id: p.id, archived: true })

    expect(projects.listActive().map((x) => x.id)).not.toContain(p.id)
    expect(projects.list().map((x) => x.id)).toContain(p.id)
    expect(todos.getById(todo.id)?.projectId).toBe(p.id)
    expect(comments.countByTodo(todo.id)).toBe(1)
    expect(projects.listHandoffRevisionSummaries(p.id).length).toBeGreaterThan(0)

    projects.update({ id: p.id, archived: false })
    expect(projects.listActive().map((x) => x.id)).toContain(p.id)
  })

  // ── ② 永久删除：逐表清零，别的项目一行不少 ──
  it('永久删除：项目内逐表清零、别的项目数据不变，回执报数与总行数对得上', () => {
    const doomed = projects.create({ name: '要永久删的' })
    const kept = projects.create({ name: '留着的' })

    const doomedFirst = seed(doomed.id, '被删')
    seed(doomed.id, '被删二')
    const keptTodo = seed(kept.id, '留着')
    projects.saveHandoff(doomed.id, '# 被删项目的接手说明', 'human')

    const beforeTotals = TABLES.map(([, table]) => countAll(table))
    const beforeKept = TABLES.map(([, table]) => countForProject(table, kept.id))

    const result = projects.delete(doomed.id)

    // 1) 每一张表的总行数都恰好减少"回执里报的那个数"（报数不是装饰）
    TABLES.forEach(([key, table], index) => {
      expect(countAll(table), `${table} 总行数应减少 removed.${key}=${result.removed[key]}`).toBe(
        beforeTotals[index] - result.removed[key]
      )
    })
    expect(result.removed.todos).toBe(2)
    expect(result.removed.comments).toBe(2)
    expect(result.removed.notifications).toBe(2)
    expect(result.removed.handoffRevisions).toBe(1)
    // 流转条数取决于中间推进了几次，这里只要求"真的清掉了那张表里的东西"
    expect(result.removed.transitions).toBeGreaterThan(0)

    // 2) 留着的那个项目一行没少
    TABLES.forEach(([, table], index) => {
      expect(countForProject(table, kept.id), `${table} 里别的项目的数据被动了`).toBe(beforeKept[index])
    })
    expect(todos.getById(keptTodo.id)).not.toBeNull()
    expect(comments.countByTodo(keptTodo.id)).toBe(1)

    // 3) 被删的那个项目连壳都不剩
    expect(projects.getById(doomed.id)).toBeNull()
    expect(todos.getById(doomedFirst.id)).toBeNull()
  })

  // ── ③ 故障注入：删一半比不删更糟，所以整个事务必须回滚 ──
  it('故障注入：删除事务整体回滚，摘掉故障后同一个调用能成功', () => {
    const doomed = projects.create({ name: '要删但会失败' })
    projects.create({ name: '陪跑的' })
    const todo = seed(doomed.id, '会被回滚')
    projects.saveHandoff(doomed.id, '# 会被回滚的接手说明', 'human')

    const eventsBefore = countAll('events')
    const todosBefore = countAll('todos')

    db.exec(
      "CREATE TEMP TRIGGER c177e466_block_project_delete BEFORE DELETE ON projects " +
        "BEGIN SELECT RAISE(ABORT, '注入的故障：本事务不许删项目'); END;"
    )
    try {
      expect(() => projects.delete(doomed.id)).toThrow(/注入的故障/)
    } finally {
      db.exec('DROP TRIGGER c177e466_block_project_delete')
    }

    // 事务里每一步都要退回去：项目、事项、评论、接手说明版本、墓碑
    expect(projects.getById(doomed.id)).not.toBeNull()
    expect(todos.getById(todo.id)).not.toBeNull()
    expect(comments.countByTodo(todo.id)).toBe(1)
    expect(projects.listHandoffRevisionSummaries(doomed.id).length).toBeGreaterThan(0)
    expect(countAll('todos')).toBe(todosBefore)
    expect(countAll('events')).toBe(eventsBefore)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'project_deleted'").get() as { n: number }).n
    ).toBe(0)

    /**
     * 反向验证：摘掉注入的故障以后，**同一个调用真的能成功**。
     * 没有这一步，"它抛错了"也可能是因为别的原因也失败 —— 那就等于没测。
     */
    projects.delete(doomed.id)
    expect(projects.getById(doomed.id)).toBeNull()
    expect(todos.getById(todo.id)).toBeNull()
  })

  // ── ④ 不留无项目事项（旧实现把 project_id 置空，正是要堵的死数据）──
  it('删完不留无项目事项，父子事项一起清', () => {
    const doomed = projects.create({ name: '要删的' })
    projects.create({ name: '陪跑的' })
    const parent = todos.create({ title: '父事项', categoryIds: [CAT], projectId: doomed.id })
    todos.create({ title: '子事项', categoryIds: [CAT], projectId: doomed.id, parentId: parent.id })

    projects.delete(doomed.id)

    expect(db.prepare('SELECT COUNT(*) AS n FROM todos WHERE project_id IS NULL').get()).toEqual({ n: 0 })
    expect(countAll('todos')).toBe(0)
  })

  // ── 留痕：删项目是这个应用里破坏面最大的动作，事后要能回答"删了什么" ──
  it('留痕：events 里有一条 project_deleted，含项目名与逐表条数', () => {
    const doomed = projects.create({ name: '留痕给我' })
    projects.create({ name: '陪跑的' })
    seed(doomed.id, '一条')

    const result = projects.delete(doomed.id)

    const row = db
      .prepare("SELECT actor, payload FROM events WHERE type = 'project_deleted' ORDER BY id DESC LIMIT 1")
      .get() as { actor: string; payload: string }
    const payload = JSON.parse(row.payload) as {
      projectId: string
      projectName: string
      removed: ProjectPurgeResult['removed']
    }
    expect(payload.projectId).toBe(doomed.id)
    expect(payload.projectName).toBe('留痕给我')
    expect(payload.removed).toEqual(result.removed)
  })

  // ── 最后一个项目：删不得（事项必须归项目），归档不设这个限 ──
  it('最后一个项目拒绝删除并指向归档，归档本身不受限', () => {
    const only = projects.create({ name: '独苗' })
    todos.create({ title: '一条', categoryIds: [CAT], projectId: only.id })

    expect(() => projects.delete(only.id)).toThrow(/最后一个项目/)
    expect(projects.getById(only.id)).not.toBeNull()
    expect(countAll('todos')).toBe(1)

    // 出口是归档：项目还在（历史事项挂得住），只是不进新建候选
    projects.update({ id: only.id, archived: true })
    expect(projects.listActive()).toEqual([])
    expect(projects.list().map((x) => x.id)).toEqual([only.id])
  })
})
