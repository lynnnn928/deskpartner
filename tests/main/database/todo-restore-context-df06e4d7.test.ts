import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import type { Todo } from '../../../src/renderer/types/todo'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}))

/**
 * 撤销删除要恢复的不只是主体（卡 `df06e4d7`）
 *
 * 卡的验收原文留着对照：
 *  ① 删除带评论的事项后 4 秒内撤销，主体及原评论（作者、时间、回复关系）完整恢复
 *  ② 删除有子事项的父项后撤销，未被重新指派的子项重新关联
 *  ③ 已重新指派的子项不被静默挪回，并得到清晰冲突反馈
 *  ④ 超过撤销期限不恢复
 *  ⑤ 单测覆盖关联数据及失败/重复路径，GUI 回归确认撤销反馈准确
 *
 * 这个文件钉 ①②③⑤ 里**数据层**的那一半。
 * ④ 与 ⑤ 的界面一半**不在这里**，也不该硬塞进来：4 秒窗口由渲染层的撤销队列
 * （`src/renderer/stores/ui.store.ts` 的 `UNDO_TTL_MS`）把关，回执怎么显示由
 * `UndoSnackbar.tsx` 决定 —— 两者都由
 * `tests/renderer/components/undo-restore-context-df06e4d7.test.ts` 锁住。
 * 拿到数据层来测"窗口过期"，测出来的是一个这里根本不存在的机制，那是自欺。
 *
 * ⚠️ 外键按**生产配置**打开（`src/main/database/index.ts` 里 `foreign_keys = ON`）：
 * 这张卡修的正是级联删除与 `ON DELETE SET NULL` 的后果，关掉外键等于把被测对象拿掉。
 * 因此这份夹具**不能**照抄 `todo.repository.test.ts`（那里刻意关外键）。
 */
describe('撤销删除恢复评论与父子关系（卡 df06e4d7）', () => {
  let todos: TodoRepository
  let comments: CommentRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM events').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES ('c1', '工作', '#5388F6', 1, 0)"
    ).run()
    db.prepare(
      "INSERT INTO projects (id, name, color, archived, sort_order, created_at) VALUES ('p1', 'DeskPartner', '#5388F6', 0, 0, '2026-01-01T00:00:00.000Z')"
    ).run()
    uuidCounter = 0
    todos = new TodoRepository()
    comments = new CommentRepository()
  })

  /** 删除**之前**取的那份快照 —— 界面上撤销按钮带着的就是它 */
  const snapOf = (id: string): Todo => {
    const todo = todos.getById(id)
    if (!todo) throw new Error(`夹具写错了：${id} 不存在，取不到撤销快照`)
    return todo
  }

  const makeTodo = (title: string, parentId?: string): Todo =>
    todos.create({ title, projectId: 'p1', categoryIds: ['c1'], parentId })

  it('① 删除带评论的事项后撤销：评论连 id、作者、时间、楼中楼关系一起回来', () => {
    const t = makeTodo('带讨论的卡')
    const top = comments.create({
      todoId: t.id,
      body: '顶层：先说结论',
      authorType: 'agent',
      authorId: 'agent:qwen'
    })
    comments.create({
      todoId: t.id,
      body: '回复：补一条证据',
      parentId: top.id,
      authorType: 'human',
      recipient: 'agent:qwen',
      kind: 'reject'
    })
    const before = comments.listByTodo(t.id)
    const snapshot = snapOf(t.id)

    todos.delete(t.id, 'gui', 'human')

    // 删除这一刻上下文是真的没了 —— 这就是本卡要修的故障现场本身
    expect(comments.countByTodo(t.id), '评论随事项级联删除').toBe(0)
    // 墓碑是唯一还留得住它们的地方
    expect(todos.findDeletedSnapshot(t.id)!.comments, '删除时要把评论存进墓碑').toHaveLength(2)

    const result = todos.restoreWithReport(snapshot)

    expect(result.todo.id, '恢复的是原 id，不是新建一条').toBe(t.id)
    expect(result.commentsRestored).toBe(2)
    expect(
      comments.listByTodo(t.id),
      '评论整条回来：id / 正文 / 作者 / 时间 / 楼中楼 / 收件人 / 种类'
    ).toEqual(before)
    // 单独再钉一次"楼中楼没断"：只比条数的话，回复被挂成顶层照样绿
    expect(comments.listByTodo(t.id)[1].parentId).toBe(top.id)
  })

  it('② 删除有子事项的父项后撤销：未被改派的子项重新关联', () => {
    const parent = makeTodo('父需求')
    const a = makeTodo('子 A', parent.id)
    const b = makeTodo('子 B', parent.id)
    const snapshot = snapOf(parent.id)

    todos.delete(parent.id, 'gui', 'human')

    // ON DELETE SET NULL：子事项不跟着消失，但会变成孤儿散在看板上
    expect(todos.getById(a.id)!.parentId).toBeNull()
    expect(todos.getById(b.id)!.parentId).toBeNull()
    expect(
      todos.findDeletedSnapshot(parent.id)!.childIds.slice().sort(),
      '删除时要把子事项 id 存进墓碑'
    ).toEqual([a.id, b.id].sort())

    const result = todos.restoreWithReport(snapshot)

    expect(result.childrenRelinked.slice().sort()).toEqual([a.id, b.id].sort())
    expect(todos.getById(a.id)!.parentId).toBe(parent.id)
    expect(todos.listChildren(parent.id).map((c) => c.id).sort()).toEqual([a.id, b.id].sort())
    expect(result.conflicts, '没有人改派 → 不该报冲突').toEqual([])
  })

  it('③ 窗口期内被改派的子事项：保留新关系，并作为冲突报回来（不静默挪回）', () => {
    const parent = makeTodo('父需求')
    const kept = makeTodo('还挂着的', parent.id)
    const moved = makeTodo('已被改派的', parent.id)
    const other = makeTodo('新父级')
    const snapshot = snapOf(parent.id)

    todos.delete(parent.id, 'gui', 'human')
    // 4 秒还没到，有人把它改派给了别的父级 —— 那是个**新决定**
    todos.update({ id: moved.id, parentId: other.id })

    const result = todos.restoreWithReport(snapshot)

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].id).toBe(moved.id)
    expect(result.conflicts[0].title, '冲突要说得出是哪一条').toBe('已被改派的')
    expect(result.conflicts[0].reason, '原因里要有新父级 id，人才知道去哪儿找它').toContain(
      other.id
    )
    // 新关系保留：撤销不能拿旧关系覆盖人的新决定
    expect(todos.getById(moved.id)!.parentId).toBe(other.id)
    // 没被碰过的那条照常挂回来 —— 有冲突不等于整次撤销作废
    expect(result.childrenRelinked).toEqual([kept.id])
    expect(todos.getById(kept.id)!.parentId).toBe(parent.id)
    expect(todos.getById(parent.id), '主体照常回来').not.toBeNull()
  })

  it('③ 子事项本身已被删除：撤销照常成功，冲突里说清是哪一种"回不来"', () => {
    const parent = makeTodo('父需求')
    const gone = makeTodo('后来一起没了的子事项', parent.id)
    const snapshot = snapOf(parent.id)

    todos.delete(parent.id, 'gui', 'human')
    // 解绑之后它成了顶层，可以被单独删掉 —— 这才是真实顺序
    todos.delete(gone.id, 'gui', 'human')

    const result = todos.restoreWithReport(snapshot)

    expect(result.todo.id).toBe(parent.id)
    expect(result.childrenRelinked).toEqual([])
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].id).toBe(gone.id)
    expect(result.conflicts[0].reason).toContain('已不存在')
  })

  it('⑤ 重复撤销是幂等的：不重复插评论、不把已挂回的算成冲突、不报错', () => {
    const t = makeTodo('被撤两次的卡')
    comments.create({ todoId: t.id, body: '一条评论', authorType: 'human' })
    const child = makeTodo('子', t.id)
    const snapshot = snapOf(t.id)

    todos.delete(t.id, 'gui', 'human')
    const first = todos.restoreWithReport(snapshot)
    const second = todos.restoreWithReport(snapshot)

    expect(first.commentsRestored).toBe(1)
    expect(first.childrenRelinked).toEqual([child.id])
    // 第二次：主体已在库里 → 走 update 分支，一条评论都不再插
    expect(second.commentsRestored).toBe(0)
    expect(second.childrenRelinked).toEqual([])
    expect(second.conflicts, '已经挂在旧父级下不算冲突').toEqual([])
    expect(comments.countByTodo(t.id), '评论条数没有翻倍').toBe(1)
    expect(todos.getById(child.id)!.parentId).toBe(t.id)
  })

  it('⑤ 老墓碑（payload 里没有 comments / childIds）：只恢复主体，不报错、不假装恢复了上下文', () => {
    const t = makeTodo('1.0.111 之前被删掉的卡')
    comments.create({ todoId: t.id, body: '这条评论在旧版本里就已经没了', authorType: 'human' })
    const snapshot = snapOf(t.id)

    /**
     * 手工造一条**老形状**的墓碑：只有 snapshot + transitions（这张卡之前
     * `delete()` 写的就是这个形状），库里也没有对应的行。
     * 这是老库副本里真实存在的形态 —— 恢复逻辑必须吃得下，不能因为缺字段报错。
     */
    db.prepare(
      "INSERT INTO events (type, actor, payload, created_at) VALUES ('todo_deleted', 'agent:old', ?, ?)"
    ).run(
      JSON.stringify({ snapshot, transitions: todos.listTransitions(t.id) }),
      '2026-01-01T00:00:00.000Z'
    )
    // 行的消失走真实那条路（外键级联），但墓碑保持"老形状"
    db.prepare('DELETE FROM todos WHERE id = ?').run(t.id)

    const tomb = todos.findDeletedSnapshot(t.id)!
    expect(tomb.comments, '老墓碑读出来是空数组，不是 undefined').toEqual([])
    expect(tomb.childIds).toEqual([])

    const result = todos.restoreWithReport(snapshot)

    expect(result.todo.id).toBe(t.id)
    expect(result.commentsRestored, '没有评论数据可恢复 → 0，且不报错').toBe(0)
    expect(result.conflicts).toEqual([])
    expect(comments.countByTodo(t.id)).toBe(0)
  })

  it('⑤ 撤销"拖错列"（事项还在库里）：不重复插评论、不误报冲突', () => {
    const t = makeTodo('只是状态被改回')
    comments.create({ todoId: t.id, body: '一条评论', authorType: 'human' })
    const snapshot = snapOf(t.id)
    // 界面上的撤销不只来自删除：拖错列、驳回退回也往同一个队列里放快照
    todos.update({ id: t.id, status: 'in_progress', source: 'gui' })

    const result = todos.restoreWithReport(snapshot)

    expect(todos.getById(t.id)!.status, '按快照回原状态').toBe('todo')
    expect(result.commentsRestored, '记录从没被删过 → 不该再插一遍').toBe(0)
    expect(comments.countByTodo(t.id)).toBe(1)
    expect(result.conflicts).toEqual([])
  })

  it('⑤ 流转链本来就没随删除消失 —— 所以这一卡不需要重插流转', () => {
    const t = makeTodo('走过几列的卡')
    todos.update({ id: t.id, status: 'in_progress', source: 'gui' })
    const before = todos.listTransitions(t.id).map((x) => x.id)
    const snapshot = snapOf(t.id)

    todos.delete(t.id, 'gui', 'human')

    // `todo_transitions.todo_id` 上**没有外键**（见 migrations 里那张建表语句），
    // 删除不会动它 —— 这是"卡上说要恢复可恢复的流转快照，实测无需动"的依据
    expect(todos.listTransitions(t.id).map((x) => x.id)).toEqual(before)

    const result = todos.restoreWithReport(snapshot)
    const after = todos.listTransitions(t.id).map((x) => x.id)

    expect(before.every((id) => after.includes(id)), '撤销后原有流转一条不少').toBe(true)
    // 只多一条：恢复动作本身也是"从无到有"的一次流转（create 记的）
    expect(after).toHaveLength(before.length + 1)
    expect(result.todo.id).toBe(t.id)
  })

  it('撤销回执的形状就是界面要用的那份：todo + 评论数 + 挂回的 + 冲突', () => {
    const t = makeTodo('回执形状')
    comments.create({ todoId: t.id, body: '一条', authorType: 'human' })
    const snapshot = snapOf(t.id)

    todos.delete(t.id, 'gui', 'human')
    const result = todos.restoreWithReport(snapshot)

    // 旧签名照旧可用（`restore` 仍返回 Todo）—— 既有调用点与用例不必跟着改
    expect(todos.restore(snapshot).id).toBe(t.id)
    expect(Object.keys(result).sort()).toEqual([
      'childrenRelinked',
      'commentsRestored',
      'conflicts',
      'todo'
    ])
  })
})
