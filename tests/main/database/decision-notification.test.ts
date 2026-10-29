import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 「待你拍板」没人通知 + 通知长得都一样（1.0.65 修 `68b9102a`，Carol体验 02）
 *
 * F1：五类通知里**最该主动推的那一类缺席** —— 事项进「待确认」不发任何通知。
 *      而"待确认"顾名思义就是等人表态，没人通知 = 没人知道，
 *      于是 proposed 只会安静堆积（实测 4 条待确认，收件箱零条相关）。
 *
 * F2：115 条 review 的 summary 全空、meta 全 null，只能靠 refId 辨认 ——
 *      通知是**索引**，索引要能回答"谁、哪张卡、为什么"，
 *      否则它只是"又发生了一件事"。
 */
describe('待确认要发通知，且通知要能辨认（68b9102a）', () => {
  let todos: TodoRepository
  let notifications: NotificationRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    new CategoryRepository().create({ name: '默认分类', color: '#5388F6', sortOrder: 0 })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM notifications').run()
    db.prepare('DELETE FROM todos').run()
    todos = new TodoRepository()
    notifications = new NotificationRepository()
  })

  const mk = (title: string, desc?: string) =>
    todos.create({ title, description: desc ?? null, projectId: null } as never)

  it('F1：事项进「待确认」要落一条 decision 通知（此前一条都不发）', () => {
    const t = mk('1.0.65 版本规划')
    todos.update({ id: t.id, status: 'proposed', actor: 'agent:alice' })

    const items = notifications.list(50)
    expect(items.filter((n) => n.type === 'decision'), '待确认必须发通知').toHaveLength(1)
    expect(items[0].refId).toBe(t.id)
  })

  it('F1：通知要说清是"等你拍板"，且带上是谁提的', () => {
    const t = mk('要不要做 GEO')
    todos.update({ id: t.id, status: 'proposed', actor: 'agent:alice' })
    const n = notifications.list(50).find((x) => x.type === 'decision')!
    expect(n.title).toContain('待你拍板')
    expect(n.title).toContain('要不要做 GEO')
    expect(n.actor).toBe('agent:alice')
  })

  it('F1：人自己拖进待确认的不发通知（是她自己的决定，不必通知自己）', () => {
    const t = mk('我自己想清楚的一件事')
    todos.update({ id: t.id, status: 'proposed', source: 'gui', actor: 'human' })
    expect(notifications.list(50).filter((n) => n.type === 'decision')).toHaveLength(0)
  })

  it('F1：只有进待确认才发，离开待确认不发（不制造重复噪音）', () => {
    const t = mk('一件事')
    todos.update({ id: t.id, status: 'proposed', actor: 'agent:alice' })
    const after = notifications.list(50).filter((n) => n.type === 'decision').length
    todos.update({ id: t.id, status: 'todo', source: 'gui', actor: 'human' })
    expect(notifications.list(50).filter((n) => n.type === 'decision')).toHaveLength(after)
  })

  it('F2：delivery 通知的 summary 不再是空串（要能回答"为什么"）', () => {
    const t = mk('加了新命令', '这条命令补上了批处理漏掉的那一步。')
    todos.update({ id: t.id, status: 'awaiting_review', actor: 'agent:alice' })
    const n = notifications.list(50).find((x) => x.type === 'review')!
    expect(n.summary, 'summary 整片为空 → 只能靠 refId 辨认').not.toBe('')
    expect(n.summary).toContain('批处理')
  })

  it('F2：meta 带流转来去，不再整片为 null', () => {
    const t = mk('一件事')
    todos.update({ id: t.id, status: 'awaiting_review', actor: 'agent:alice' })
    const n = notifications.list(50).find((x) => x.type === 'review')!
    expect(n.meta).not.toBeNull()
    expect(JSON.parse(n.meta!)).toMatchObject({ to: 'awaiting_review' })
  })

  it('摘要要压掉换行（收件箱是一行的位置，带换行会撑开列表）', () => {
    const t = mk('多行描述', '第一行\n\n第二行\n第三行')
    todos.update({ id: t.id, status: 'awaiting_review', actor: 'agent:alice' })
    const n = notifications.list(50).find((x) => x.type === 'review')!
    expect(n.summary).not.toContain('\n')
    expect(n.summary).toContain('第一行')
  })

  it('超长描述要截断（否则一条通知能顶满整屏）', () => {
    const t = mk('长描述', '啊'.repeat(500))
    todos.update({ id: t.id, status: 'awaiting_review', actor: 'agent:alice' })
    const n = notifications.list(50).find((x) => x.type === 'review')!
    expect(n.summary.length).toBeLessThanOrEqual(121)
  })

  it('没有描述时 summary 留空串而不是 null（字段形状一致，消费方不用判两种）', () => {
    const t = mk('没写描述')
    todos.update({ id: t.id, status: 'awaiting_review', actor: 'agent:alice' })
    const n = notifications.list(50).find((x) => x.type === 'review')!
    expect(n.summary).toBe('')
  })

  it('decision 与 review 是两类（要的人动作不同，不能合并成一条）', () => {
    const a = mk('等我拍板的事')
    todos.update({ id: a.id, status: 'proposed', actor: 'agent:alice' })
    const b = mk('等我验收的事')
    todos.update({ id: b.id, status: 'awaiting_review', actor: 'agent:alice' })

    const items = notifications.list(50)
    expect(items.filter((n) => n.type === 'decision')).toHaveLength(1)
    expect(items.filter((n) => n.type === 'review')).toHaveLength(1)
  })
})
