import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}))

/**
 * 通知中心（schema v21）：仓储本身 + 三个写入口的联动。
 *
 * 覆盖的五类之三在本文件：memo（备忘产生/ack/remove 联动）、
 * review（agent 推进待验收）。reminder / grant / exec_result 的生产者
 * 在 service 与 ipc 层，由对应层的测试覆盖。
 */
describe('NotificationRepository（v21 统一通知模型）', () => {
  let notifications: NotificationRepository
  let memos: MemoRepository
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM notifications').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES ('c1', '工作', '#5388F6', 1, 0)"
    ).run()
    db.prepare(
      "INSERT INTO projects (id, name, color, archived, sort_order, created_at) VALUES ('p1', 'DeskPartner', '#5388F6', 0, 0, '2026-01-01T00:00:00.000Z')"
    ).run()
    uuidCounter = 0
    notifications = new NotificationRepository()
    memos = new MemoRepository()
    todos = new TodoRepository()
  })

  describe('create / list / unreadCount', () => {
    it('新建的通知恒为未读，列表新→旧', () => {
      notifications.create({ type: 'reminder', title: '到点了：写周报' })
      notifications.create({ type: 'review', title: 'Bob 交付了「删除不留痕」，待验收' })

      const list = notifications.list()
      expect(list).toHaveLength(2)
      expect(list[0].title).toContain('Bob') // 后建的在前
      expect(list.every((n) => n.status === 'unread')).toBe(true)
      expect(notifications.unreadCount()).toBe(2)
    })

    it('空标题抛错（索引没有内容等于噪音）', () => {
      expect(() => notifications.create({ type: 'memo', title: '  ' })).toThrow()
    })
  })

  /**
   * 退役类型（1.0.55，主用户驳回 2ccc6fc6）
   *
   * 她的原话：「审批通知还在通知里，应该迁移到审批中」。
   * 审批有自己的入口（队列 + 日志）+ 顶部横幅，收件箱再存一份就是
   * "同一件事两个目的地"；而且审批面点完「允许」后没人标那条通知已读，
   * 未读角标**永远消不掉** —— 这正是下面第一条要锁住的坑。
   */
  describe('退役类型（grant）不再进收件箱', () => {
    it('列表与未读计数都要排除退役类型（否则角标永远消不掉）', () => {
      notifications.create({ type: 'grant', title: '某人 想「删除数据」，等你点头' })
      notifications.create({ type: 'review', title: '交付了，待验收' })

      const list = notifications.list()
      expect(list.map((n) => n.type)).toEqual(['review'])
      // 关键：那条 grant 虽然还在库里且 status='unread'，
      // 计数必须当它不存在 —— 否则审批点完「允许」角标依旧亮着。
      expect(notifications.unreadCount()).toBe(1)
    })

    it('审批点完「允许」后，角标不再残留（grant 不再参与计数）', () => {
      notifications.create({ type: 'grant', title: '审批 1' })
      // 模拟：审批面做出了决定，但**没有任何代码去标这条通知已读**
      // （真实情况就是如此 —— 审批走 agentRepo，不认识 notifications 表）
      expect(notifications.unreadCount(), '退役前会残留 1，退役后应为 0').toBe(0)
    })

    it('pruneRetired 清掉历史行，且不误伤在用的类型', () => {
      notifications.create({ type: 'grant', title: '历史审批 1' })
      notifications.create({ type: 'grant', title: '历史审批 2' })
      notifications.create({ type: 'reminder', title: '提醒 1' })
      notifications.create({ type: 'memo', title: '纸条 1' })

      expect(notifications.pruneRetired()).toBe(2)

      const list = notifications.list()
      expect(list.map((n) => n.type).sort()).toEqual(['memo', 'reminder'])
      // 幂等：再清一次没有可清的了
      expect(notifications.pruneRetired()).toBe(0)
    })

    it('退役不影响显式传入退役类型的 markAllRead（历史数据兜底）', () => {
      // 列表已排除，但若调用方明确指定 grant（如旧版本残留的 IPC 调用），
      // 仍应正常执行而不是报错 —— 兼容性考虑，不是功能承诺。
      notifications.create({ type: 'grant', title: '历史审批' })
      expect(notifications.markAllRead('grant')).toBe(1)
    })
  })

  describe('已读口径', () => {
    it('markRead 幂等；markAllRead 一次清空', () => {
      const a = notifications.create({ type: 'memo', title: '纸条 A' })
      notifications.create({ type: 'memo', title: '纸条 B' })

      expect(notifications.markRead(a.id)).toBe(true)
      expect(notifications.markRead(a.id)).toBe(false) // 重复已读 = 无变化
      expect(notifications.unreadCount()).toBe(1)

      expect(notifications.markAllRead()).toBe(1)
      expect(notifications.unreadCount()).toBe(0)
    })

    it('markReadByRef：源记录在别处被读，索引同步熄灭，并把读的人记进 read_by', () => {
      notifications.create({ type: 'memo', title: '纸条', refId: 'memo-1' })
      expect(notifications.markReadByRef('memo-1', 'agent:alice')).toBe(1)
      expect(notifications.unreadCount()).toBe(0)
      // 15557194：只写全局位、不写 read_by 就是"清了又亮"的那个 bug
      expect(notifications.list()[0].readBy ?? '').toContain('agent:alice')
      // 幂等：重复同步不该把集合越写越长
      notifications.create({ type: 'memo', title: '纸条2', refId: 'memo-2' })
      const before = notifications.markReadByRef('memo-2', 'agent:alice')
      expect(before).toBe(1)
      expect(notifications.list().find((n) => n.refId === 'memo-2')?.readBy).toBe('agent:alice')
    })

    /**
     * 1.0.49 通知分类筛选：筛选状态下「本类已读」只清这一类。
     *
     * 为什么必须有这条：筛选后按钮在"全部已读"和"本类已读"之间切换，
     * 若后端不认 type、照旧一次清空，人手边只有审批却被连提醒一起消掉 ——
     * 动作范围超出看得见的范围，且**没有任何报错**。
     */
    it('markAllRead(type)：只清指定类，别类原样未读', () => {
      notifications.create({ type: 'reminder', title: '提醒 1' })
      notifications.create({ type: 'memo', title: '纸条 1' })
      notifications.create({ type: 'memo', title: '纸条 2' })
      notifications.create({ type: 'exec_result', title: '回执 1' })

      expect(notifications.markAllRead('memo')).toBe(2)

      const list = notifications.list()
      const byType = (t: string) => list.filter((n) => n.type === t)
      expect(byType('memo').every((n) => n.status === 'read')).toBe(true)
      expect(byType('reminder').every((n) => n.status === 'unread')).toBe(true)
      expect(byType('exec_result').every((n) => n.status === 'unread')).toBe(true)
      expect(notifications.unreadCount()).toBe(2)
    })

    it('markAllRead(null / undefined)：回到"一次清空"的旧语义', () => {
      notifications.create({ type: 'reminder', title: '提醒 1' })
      notifications.create({ type: 'memo', title: '纸条 1' })

      expect(notifications.markAllRead(null)).toBe(2)
      expect(notifications.unreadCount()).toBe(0)
    })

    it('markAllRead(type)：该类没有未读时返回 0，不误伤别类', () => {
      notifications.create({ type: 'reminder', title: '提醒 1' })

      expect(notifications.markAllRead('review')).toBe(0)
      expect(notifications.unreadCount()).toBe(1)
    })
  })

  describe('removeByRef：源没了，索引不指向空气', () => {
    it('按 refId 删除全部相关行', () => {
      notifications.create({ type: 'memo', title: '纸条 1', refId: 'memo-1' })
      notifications.create({ type: 'memo', title: '纸条 2', refId: 'memo-2' })
      expect(notifications.removeByRef('memo-1')).toBe(1)
      expect(notifications.list().map((n) => n.title)).toEqual(['纸条 2'])
    })
  })

  describe('备忘联动（生产者：memo）', () => {
    it('新建未读备忘 → 收件箱多一行；已读历史（导入）不进', () => {
      memos.create({ author: 'agent:alice', text: '看板的已完成列空了，可以归档一批' })
      memos.create({ author: 'agent:alice', text: '历史导入的已读纸条', status: 'read' })

      const list = notifications.list()
      expect(list).toHaveLength(1)
      expect(list[0].type).toBe('memo')
      expect(list[0].actor).toBe('agent:alice')
    })

    it('备忘 ack → 通知同步已读，且记下读的人（15557194）；备忘删除 → 通知一并撤', () => {
      const memo = memos.create({ author: 'agent:alice', text: '一张纸条' })
      expect(notifications.unreadCount()).toBe(1)

      memos.ack(memo.id, 'agent:alice')
      expect(notifications.unreadCount()).toBe(0)
      // 全局已读但 read_by 空 = 主用户那边"清了又亮"：他按自己的 read_by 算仍是未读
      expect(notifications.list()[0].readBy ?? '').toContain('agent:alice')

      memos.remove(memo.id)
      expect(notifications.list()).toHaveLength(0)
    })
  })

  describe('项目归属与读状态范围', () => {
    it('按事项项目反查通知，并且项目全部已读不影响系统通知', () => {
      const projectTodo = todos.create({ title: '项目事项', projectId: 'p1', createdBy: 'agent:alice' })
      const projectNotice = notifications.create({ type: 'reminder', title: '项目提醒', refId: projectTodo.id })
      const systemNotice = notifications.create({ type: 'reminder', title: '系统提醒' })

      const rows = notifications.listWithProject()
      expect(rows.find((row) => row.id === projectNotice.id)?.projectId).toBe('p1')
      expect(rows.find((row) => row.id === systemNotice.id)?.projectId).toBeNull()
      expect(notifications.markProjectRead('p1')).toBe(1)
      expect(notifications.listWithProject().find((row) => row.id === projectNotice.id)?.status).toBe('read')
      expect(notifications.listWithProject().find((row) => row.id === systemNotice.id)?.status).toBe('unread')
      expect(notifications.unreadSystemCount()).toBe(1)
    })

    it('执行回执可通过 meta.projectId 保留项目归属', () => {
      const row = notifications.create({
        type: 'exec_result',
        title: '已通过并执行',
        refId: 'grant-1',
        meta: { ok: true, projectId: 'p1' }
      })
      expect(notifications.listWithProject().find((item) => item.id === row.id)?.projectId).toBe('p1')
      expect(notifications.unreadSystemCount()).toBe(0)
    })

    it('项目列表在数据库侧隔离项目，不受全局 limit 截断影响', () => {
      const currentTodo = todos.create({ title: '当前项目事项', projectId: 'p1', createdBy: 'agent:alice' })
      const otherTodo = todos.create({ title: '另一个项目事项', projectId: 'p2', createdBy: 'agent:alice' })
      const currentNotice = notifications.create({ type: 'reminder', title: '当前项目提醒', refId: currentTodo.id })
      const otherNotice = notifications.create({ type: 'reminder', title: '另一个项目提醒', refId: otherTodo.id })
      const systemNotice = notifications.create({ type: 'reminder', title: '系统提醒' })

      const rows = notifications.listWithProject(1, 'p1')
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(currentNotice.id)
      expect(rows.some((row) => row.id === otherNotice.id || row.id === systemNotice.id)).toBe(false)
    })
  })

  describe('交付联动（生产者：流转到待验收）', () => {
    it('agent 推进 awaiting_review → 收件箱有「交付待验收」；人自己推的不发', () => {
      const t1 = todos.create({ title: 'agent 干完的活', projectId: 'p1', createdBy: 'agent:alice' })
      todos.update({ id: t1.id, status: 'awaiting_review', actor: 'agent:alice' })

      const t2 = todos.create({ title: '人自己的活', projectId: 'p1', createdBy: 'human' })
      todos.update({ id: t2.id, status: 'awaiting_review', actor: 'human' })

      const list = notifications.list()
      expect(list).toHaveLength(1)
      expect(list[0].type).toBe('review')
      expect(list[0].title).toContain('agent 干完的活')
      expect(list[0].actor).toBe('agent:alice')
    })
  })
})
