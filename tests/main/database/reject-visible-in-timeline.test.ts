import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { mergeTimeline } from '../../../src/main/lib/audit-text'
import { buildTimeline, TIMELINE_KIND_LABEL } from '../../../src/renderer/lib/timeline-group'
import type { Todo, TodoTransition } from '../../../src/renderer/types/todo'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 动态里要看得见"驳回"（1.0.72，主用户看动态时指出）
 *
 * ## 她的原话（这次点得比我上一轮准）
 *
 * 「驳回的难点不是说问题在于它留存在评论里，而是说**它发生了状态变更，
 * 而且是以驳回的形式**，这些信息没有体现在动态里。」
 *
 * 上一轮我只改了通知中心的标签（那处也不该写"交付"），但**真正的缺口在这里**：
 * 动态里所有流转节点都叫「推进了」，所以被驳回的卡长成「千wen 推进了 xxx」——
 * **裁决被记成了推进**。
 *
 * ## 判据必须在发生那一刻定死
 *
 * 现有代码早就知道怎么区分：`isRejection()` 拿 `kind='reject'` 评论当权威判据。
 * 但那是**当前状态**：卡被驳回过、后来执行方自己收回重开，反推会误标。
 * 所以给 `todo_transitions` 加 `is_rejection` 列，在 `recordTransition` 写入时定值
 * （两条写入路径都满足"先落评论再流转"，迁移 30 的注释里记了核对结果）。
 *
 * ## 存量一律留 null（未记录），不倒推
 *
 * 动态的全部价值就是可信。老数据倒推出来的"是不是驳回"是编造的 ——
 * 宁可缺一屏不可疑一屏。
 */
describe('动态里看得见驳回（1.0.72）', () => {
  let todos: TodoRepository
  let comments: CommentRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.exec('DELETE FROM todo_transitions; DELETE FROM todo_comments; DELETE FROM todos; DELETE FROM categories;')
    todos = new TodoRepository()
    comments = new CommentRepository()
  })

  const mkTodo = (title = '被驳回的卡'): Todo => {
    // color / sortOrder 是 NOT NULL，不给会在造数据时就炸 ——
    // 踩过一次：`NOT NULL constraint failed: categories.color`
    const cat = new CategoryRepository()
    let c = cat.list()[0]
    if (!c) c = cat.create({ name: `分类${Date.now()}`, color: '#1', sortOrder: 0 })
    const proj = new ProjectRepository()
    let p = proj.list()[0]
    if (!p) p = proj.create({ name: `项目${Date.now()}`, color: '#2' })
    return todos.create({ title, projectId: p.id, categoryIds: [c.id] }) as Todo
  }

  /**
   * 模拟 `todo reject`：先落 reject 评论，再流转。
   *
   * ⚠️ 踩过两次才写对：方法名是 `create` 不是 `add`，
   * 作者字段是 `authorId` / `authorType` 不是 `author` ——
   * 写错时 `comments.add` 抛 "not a function"，而那报错**指向测试自己**，
   * 不会让人怀疑"实现的判据写错了"。
   */
  const rejectIt = (t: Todo): void => {
    comments.create({
      todoId: t.id,
      authorType: 'agent',
      authorId: 'agent:carol',
      kind: 'reject',
      body: '结论不成立'
    })
    todos.update({ id: t.id, status: 'in_progress' })
  }

  /** 模拟执行方自己收回重开：只改状态，不写评论 */
  const withdrawIt = (t: Todo): void => {
    todos.update({ id: t.id, status: 'in_progress' })
  }

  const trOf = (t: Todo): TodoTransition[] => todos.listTransitions(t.id)
  const backFlow = (t: Todo) =>
    trOf(t).find((x) => x.fromStatus === 'awaiting_review' && x.toStatus === 'in_progress')

  it('前置：迁移已加 is_rejection 列', () => {
    const cols = (db.prepare('PRAGMA table_info(todo_transitions)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols, '迁移没跑 —— is_rejection 列不存在，后面全部无从谈起').toContain('is_rejection')
  })

  it('驳回（先落 reject 评论再流转）被记成 isRejection=true', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'awaiting_review' })
    rejectIt(t)
    expect(backFlow(t)?.isRejection, '有 reject 评论却没有被记成驳回').toBe(true)
  })

  it('执行方自己收回重开被记成 isRejection=false（不是"未知"）', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'awaiting_review' })
    withdrawIt(t)
    const tr = backFlow(t)
    expect(tr?.isRejection, '自己收回不是驳回').toBe(false)
    // 关键：不是 null。false 与 null 必须能分开 ——
    // 把 false 写成 null 会让"不是驳回"变成"不知道"，界面无从表达
    expect(tr?.isRejection).not.toBeNull()
  })

  /**
   * 判据：事实定死在发生那一刻。
   *
   * 这条是本设计的核心 —— 若改成"查询时看这张卡有没有 reject 评论"，
   * 下面这个场景就会误标：先驳回一次、之后执行方自己收回重开，
   * 那第二条真实动作是"自己收回"，却被说成"又被驳回了"。
   */
  it('卡曾被驳回后再自行收回，第二条不被误标成驳回', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'awaiting_review' })
    rejectIt(t) // 第一次：真驳回
    todos.update({ id: t.id, status: 'awaiting_review' }) // 再交回
    withdrawIt(t) // 第二次：执行方自己收回（此时卡上仍有那条 reject 评论）

    const flows = trOf(t).filter((x) => x.fromStatus === 'awaiting_review' && x.toStatus === 'in_progress')
    expect(flows.length, '应有两条退回流转').toBe(2)
    expect(flows[0].isRejection, '第一次是真驳回').toBe(true)
    expect(
      flows[1].isRejection,
      '第二次是自行收回 —— 若为 true 说明判据是"反推当前状态"，正是本条要防的'
    ).toBe(false)
  })

  it('其他流转不沾这个字段（待办→进行中 之类是 0 而不是 null）', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'in_progress' })
    const tr = trOf(t).find((x) => x.fromStatus === 'todo' && x.toStatus === 'in_progress')
    expect(tr?.isRejection, '只有待验收→进行中才需要判别，其余一律为 0').toBe(false)
  })

  it('动态里出现「驳回了」这个节点，而不再是「推进了」', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'awaiting_review' })
    rejectIt(t)

    const groups = buildTimeline([t], trOf(t))
    const kinds = groups.flatMap((g) => g.items.map((i) => i.kind))
    expect(kinds, '动态里没有 rejected 节点').toContain('rejected')
    expect(TIMELINE_KIND_LABEL.rejected, '驳回的文案要说清是裁决').toBe('驳回了')
    expect(
      groups.flatMap((g) => g.items).find((i) => i.kind === 'rejected')?.transition,
      '驳回节点必须仍带 from/to —— 状态箭头是这条动态的信息本体'
    ).toMatchObject({ fromStatus: 'awaiting_review', toStatus: 'in_progress' })
  })

  it('自行收回的退回仍显示「推进了」（不误标）', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'awaiting_review' })
    withdrawIt(t)
    const groups = buildTimeline([t], trOf(t))
    const kinds = groups.flatMap((g) => g.items.map((i) => i.kind))
    expect(kinds, '自行收回不该被标成驳回').not.toContain('rejected')
    expect(kinds).toContain('transitioned')
  })

  /**
   * 老数据（is_rejection 为 null）不许被说成"不是驳回"。
   *
   * 这是"缺失与否定不是一回事"的直接落点 ——
   * 写成 `Boolean(row.is_rejection)` 会让老数据全变 false，
   * 动态看上去与修之前没区别，而实际上是把"不知道"说成了"不是"。
   */
  it('老数据的 null 保持 null（不倒推、不说成 false）', () => {
    const t = mkTodo()
    todos.update({ id: t.id, status: 'awaiting_review' })
    rejectIt(t)
    // 模拟"这条流转发生在加列之前"：把列抹成 NULL
    db.prepare('UPDATE todo_transitions SET is_rejection = NULL WHERE todo_id = ?').run(t.id)
    const tr = trOf(t).find((x) => x.fromStatus === 'awaiting_review')
    expect(tr?.isRejection, '老数据被抹掉了 — 迁移里说了不倒推，这里就不该有值').toBeNull()
  })

  it('详情抽屉的人话也不说"推到"（两个界面口径必须一致）', () => {
    const merged = mergeTimeline([], [
      {
        fromStatus: 'awaiting_review',
        toStatus: 'in_progress',
        actor: 'agent:carol',
        createdAt: '2026-10-07T10:00:00.000Z',
        isRejection: true
      }
    ])
    expect(merged[0].what, '详情页与动态对同一次驳回说了两套话').toContain('驳回了')

    const normal = mergeTimeline([], [
      {
        fromStatus: 'todo',
        toStatus: 'in_progress',
        actor: 'agent:alice',
        createdAt: '2026-10-07T10:00:00.000Z',
        isRejection: false
      }
    ])
    expect(normal[0].what).toContain('推到')
  })

  /**
   * 防第三次疏漏：手工挑字段的映射点。
   *
   * 同一个疏漏出现了三次（`ipc.ts` 的 todo:timeline、`commands.ts` 的
   * `todo history`、以及最初迁移后的读取）——
   * 症状都是「字段在、类型在、就是不生效」，tsc 全过。
   *
   * 判据：**加了字段就要有一条断言从出口读出它**。
   * 这条测试直接读源码，盯住那两个 `map()` 里有没有把字段带过去。
   */
  /**
   * 防第三次疏漏：手工挑字段的映射点。
   *
   * 同一个疏漏出现了**四次**（`ipc.ts` 的 `todo:timeline`、
   * `commands.ts` 的 `todo history`、`todo get`，以及最初迁移后的读取）。
   * 症状统一是「字段在、类型在、就是不生效」，tsc 全过、不报错。
   *
   * ## 写这条断言时被它抓到过一次
   *
   * 第一版断言只查 `indexOf` 命中的**第一处**，于是它绿了 ——
   * 而真正漏的是同文件里的**第二处**（`todo get` 的输出也带流转）。
   * 判据：**要查就查全部**。"找到一个"和"都覆盖了"是两件事，
   * 而前者会给出后者的假安全感 —— 与我上一轮在 `help` 上犯的错同源
   * （一份语义三个出口，只测了自己动过的那两个）。
   */
  it('所有手工挑流转字段的映射点都带上了 isRejection（防漏）', () => {
    const root = join(__dirname, '../../../src/main')
    const files = [
      { path: 'ipc.ts', marker: 'fromStatus: t.fromStatus' },
      { path: 'cli/commands/todo.ts', marker: 'from: t.fromStatus' }
    ]

    let checked = 0
    for (const f of files) {
      const src = readFileSync(join(root, f.path), 'utf-8')
      let at = src.indexOf(f.marker)
      expect(at, `${f.path} 里找不到流转映射点 —— 代码结构变了，这条要跟着改`).toBeGreaterThan(-1)

      // ⚠️ 必须遍历**全部**命中处：只查第一处会漏掉同文件里的其他出口
      while (at !== -1) {
        checked++
        const block = src.slice(at, at + 600)
        expect(
          block,
          `${f.path} 第 ${checked} 处流转映射漏了 isRejection —— 字段在库里但没传出去，` +
            '症状是"不报错、但不生效"'
        ).toContain('isRejection')
        at = src.indexOf(f.marker, at + 1)
      }
    }
    expect(
      checked,
      `只找到 ${checked} 个映射点 —— 手工挑字段的地方不止一处（ipc 1 处 + commands 2 处）`
    ).toBeGreaterThanOrEqual(3)
  })
})
