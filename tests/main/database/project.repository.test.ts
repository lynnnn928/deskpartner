import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
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
 * 一个真实存在的分类 id
 *
 * CreateTodoInput 不传 categoryIds 时会回退到"第一个分类"，
 * 而库里一个分类都没有时仓储直接抛错。这里插一条真的，
 * 让用例专注在四字段本身，不被这条回退逻辑干扰。
 */
const CAT = 'c1'

describe('项目与四字段', () => {
  let projects: ProjectRepository
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    /**
     * 默认关外键：todos.category_id 引用 categories，
     * 开着连普通用例都插不进去（见 todo.repository.test.ts 的同款处理）。
     *
     * 但**凡是测外键语义本身的用例**（删项目/删父需求后子事项怎么变），
     * 必须在用例内临时打开 —— 关着外键时 ON DELETE SET NULL 根本不触发，
     * 测出来的"没置空"是测试环境的假象，不是代码的问题。
     */
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    // 本文件默认关外键，删项目不会级联；修订行（v35）要手动清，否则重置后的 uuid 计数会撞上残留 id
    db.prepare('DELETE FROM project_handoff_revisions').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, '工作', '#5388F6', 1, 0)"
    ).run(CAT)
    uuidCounter = 0
    projects = new ProjectRepository()
    todos = new TodoRepository()
  })

  describe('ProjectRepository.create()', () => {
    it('should create a project with defaults', () => {
      const p = projects.create({ name: 'DeskPartner' })
      expect(p.name).toBe('DeskPartner')
      expect(p.archived).toBe(false)
      expect(p.color).toBeTruthy()
    })

    it('should reject empty name', () => {
      expect(() => projects.create({ name: '   ' })).toThrow()
    })

    it('should increment sortOrder', () => {
      const a = projects.create({ name: 'A' })
      const b = projects.create({ name: 'B' })
      expect(b.sortOrder).toBeGreaterThan(a.sortOrder)
    })
  })

  /**
   * 1.0.111 改口径（卡 `c177e466`，源自主用户 2026-10-09 拍板）：
   * **永久删除 = 清空整个项目数据，不迁移、不保留**。
   *
   * 旧契约是"先迁走再删"，这里曾经就有两条用例在钉它。它有两个毛病：
   * 默认落点是"除自己以外的第一个项目"，于是**不选承接项目也能删**；
   * 而"迁不走"时事项的 project_id 会变成 null，与"事项必须归项目"冲突。
   * 让项目从列表里消失而数据留着的那条路是**归档**（可逆），不是删除。
   *
   * 更细的验收（逐表清零、故障回滚、无遗留无项目事项）在
   * `project-purge-c177e466.test.ts` 里，这里只钉契约本身。
   */
  describe('ProjectRepository.delete()', () => {
    it('删项目时其下事项跟着一起删，不留无归属事项', () => {
      const p = projects.create({ name: 'P' })
      projects.create({ name: '别的项目' })
      const t = todos.create({ title: 'task', categoryIds: [CAT], projectId: p.id })
      expect(todos.getById(t.id)?.projectId).toBe(p.id)

      const result = projects.delete(p.id)
      expect(result.projectName).toBe('P')
      expect(result.removed.todos).toBe(1)

      expect(todos.getById(t.id)).toBeNull()
      expect(projects.getById(p.id)).toBeNull()
      // "无项目事项"正是旧实现制造出来的死数据，这里必须一条不剩
      expect(db.prepare('SELECT COUNT(*) AS n FROM todos WHERE project_id IS NULL').get()).toEqual({ n: 0 })
    })

    it('其他项目的数据一条不动（删的是这一个，不是一片）', () => {
      const doomed = projects.create({ name: '被删的' })
      const kept = projects.create({ name: '留着的' })
      const survivor = todos.create({ title: '留下的事', categoryIds: [CAT], projectId: kept.id })
      todos.create({ title: '要删的事', categoryIds: [CAT], projectId: doomed.id })

      const result = projects.delete(doomed.id)

      expect(result.removed.todos).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS n FROM todos').get()).toEqual({ n: 1 })
      expect(todos.getById(survivor.id)?.projectId).toBe(kept.id)
      expect(projects.getById(kept.id)).not.toBeNull()
    })

    it('本机只剩一个项目时拒绝删除，并指向归档', () => {
      const p = projects.create({ name: '唯一的项目' })
      todos.create({ title: 'task', categoryIds: [CAT], projectId: p.id })

      expect(() => projects.delete(p.id)).toThrow(/最后一个项目/)
      // 拒绝之后什么都没动
      expect(projects.getById(p.id)).not.toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS n FROM todos').get()).toEqual({ n: 1 })
    })

    it('空项目是最后一个时同样被拒（判据是项目数，不是它有没有事项）', () => {
      const p = projects.create({ name: '空项目' })
      expect(() => projects.delete(p.id)).toThrow(/最后一个项目/)
      expect(projects.getById(p.id)).not.toBeNull()
    })

    it('归档是"数据留着"的那条路：不进候选，但可查、可恢复', () => {
      const p = projects.create({ name: '要归档的' })
      const t = todos.create({ title: 'task', categoryIds: [CAT], projectId: p.id })

      projects.update({ id: p.id, archived: true })
      expect(projects.listActive().map((x) => x.id)).not.toContain(p.id)
      expect(projects.getById(p.id)).not.toBeNull()
      expect(todos.getById(t.id)?.projectId).toBe(p.id)

      projects.update({ id: p.id, archived: false })
      expect(projects.listActive().map((x) => x.id)).toContain(p.id)
    })
  })

  describe('ProjectRepository.resolveId()', () => {
    it('完整 id 直接命中', () => {
      const p = projects.create({ name: 'P' })
      expect(projects.resolveId(p.id)).toBe(p.id)
    })

    it('id 前缀能定位（人几乎总是截前 8 位）', () => {
      const p = projects.create({ name: 'P' })
      expect(projects.resolveId(p.id.slice(0, 8))).toBe(p.id)
    })

    it('不存在时抛错而不是静默返回', () => {
      expect(() => projects.resolveId('00000000')).toThrow()
    })

    it('前缀撞到多个时抛错，不随便挑一个', () => {
      // 可控 uuid：两条都以 test-uuid- 开头
      projects.create({ name: 'A' })
      projects.create({ name: 'B' })
      expect(() => projects.resolveId('test-uuid-')).toThrow(/匹配到 2 个/)
    })
  })

  describe('ProjectRepository.delete() 用短 id', () => {
    /**
     * ⚠️ 本文件把 uuid 固定成 `test-uuid-N`，于是两个项目的 8 位前缀**必然相同**
     * （都是 `test-uui`）—— 想在这里演"8 位前缀唯一命中"是做不到的，
     * 真去传那个前缀反而会撞上 resolveId 的"匹配到 2 个"报错。
     *
     * 前缀解析本身在 `resolveId()` 那组用例、以及用真 uuid 的
     * `grant-replay-cluster.test.ts`（id 前缀 / 项目名 / 短名不误吃）里覆盖；
     * 这里只保住"删一个、库里真的少一个"，并留一个陪跑项目（删最后一个会被拒）。
     */
    it('短 id 删除真的落到库里', () => {
      projects.create({ name: '陪跑' })
      const p = projects.create({ name: 'P' })
      projects.delete(p.id)
      expect(projects.getById(p.id)).toBeNull()
    })
  })

  describe('ProjectRepository.listActive()', () => {
    it('should exclude archived', () => {
      const a = projects.create({ name: 'A' })
      projects.create({ name: 'B' })
      projects.update({ id: a.id, archived: true })
      expect(projects.listActive().map((p) => p.name)).toEqual(['B'])
    })
  })

  describe('项目接手说明与动态概览', () => {
    it('新项目说明默认为空，可读写清空并从仓储回读', () => {
      const p = projects.create({ name: '接手项目' })
      expect(p.handoffMarkdown).toBe('')

      const markdown = '# 接手入口\n\n关键决定见 `docs/DECISIONS.md`。\n'
      projects.update({ id: p.id, handoffMarkdown: markdown })
      expect(projects.getById(p.id)?.handoffMarkdown).toBe(markdown)

      projects.update({ id: p.id, handoffMarkdown: '' })
      expect(projects.getById(p.id)?.handoffMarkdown).toBe('')
    })

    it('详情状态计数与入口由项目内当前事项计算，角色不从 Markdown 读取', () => {
      const p = projects.create({ name: '动态项目', handoffMarkdown: '状态说明：永远是空的' })
      const other = projects.create({ name: '边界外项目' })
      const statuses = [
        'proposed',
        'todo',
        'in_progress',
        'suspended',
        'awaiting_review',
        'done',
        'discarded'
      ] as const
      for (const status of statuses) {
        todos.create({
          title: `当前 ${status}`,
          categoryIds: [CAT],
          projectId: p.id,
          status,
          createdBy: 'agent:runner',
          executedBy: status === 'in_progress' ? 'human' : null,
          verifier: 'agent:reviewer',
          skipGuards: true
        })
      }
      todos.create({ title: '不属于本项目', categoryIds: [CAT], projectId: other.id })

      const detail = projects.getDetail(p.id)!
      expect(detail.project.handoffMarkdown).toBe('状态说明：永远是空的')
      expect(detail.overview.total).toBe(7)
      expect(detail.overview.statusCounts).toEqual({
        proposed: 1,
        todo: 1,
        in_progress: 1,
        suspended: 1,
        awaiting_review: 1,
        done: 1,
        discarded: 1
      })
      const inProgress = detail.overview.items.find((item) => item.status === 'in_progress')!
      expect(inProgress.executedBy).toBe('human')
      expect(inProgress.verifier).toBe('agent:reviewer')
      const todo = detail.overview.items.find((item) => item.status === 'todo')!
      expect(todo.executedBy).toBe('agent:runner')
      expect(projects.getDetail('missing')).toBeNull()
    })
  })

  describe('项目范围全文检索', () => {
    it('覆盖 Markdown、标题、描述、评论及全部状态，但严格限制项目边界', () => {
      const p = projects.create({ name: '检索项目', handoffMarkdown: '# 项目 needle\n入口记录' })
      const other = projects.create({ name: '另一个项目' })
      const todo = todos.create({
        title: 'todo needle 标题',
        description: 'todo 描述里的 needle',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'todo'
      })
      const inProgress = todos.create({
        title: '进行中事项',
        description: '执行上下文 needle',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'in_progress'
      })
      const review = todos.create({
        title: 'needle 待验收事项',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'awaiting_review'
      })
      const proposed = todos.create({
        title: 'needle 待确认事项',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'proposed'
      })
      const suspended = todos.create({
        title: '挂起 needle',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'suspended'
      })
      const discarded = todos.create({
        title: '废弃 needle',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'discarded'
      })
      const done = todos.create({
        title: '完成事项',
        categoryIds: [CAT],
        projectId: p.id,
        status: 'done'
      })
      const outside = todos.create({
        title: '外项目 needle',
        categoryIds: [CAT],
        projectId: other.id,
        status: 'done'
      })
      const comments = new CommentRepository()
      const matchedComment = comments.create({
        todoId: done.id,
        body: '收口评论 needle；保留原文上下文',
        authorType: 'agent',
        authorId: 'agent:reviewer'
      })
      comments.create({ todoId: outside.id, body: '外项目评论 needle' })

      const hits = projects.search(p.id, 'needle')
      expect(new Set(hits.map((hit) => hit.source))).toEqual(
        new Set(['handoff_markdown', 'todo_title', 'todo_description', 'comment'])
      )
      expect(hits.some((hit) => hit.todoId === todo.id && hit.todoStatus === 'todo')).toBe(true)
      expect(hits.some((hit) => hit.todoId === inProgress.id && hit.todoStatus === 'in_progress')).toBe(true)
      expect(hits.some((hit) => hit.todoId === suspended.id && hit.todoStatus === 'suspended')).toBe(true)
      expect(hits.some((hit) => hit.todoId === discarded.id && hit.todoStatus === 'discarded')).toBe(true)
      expect(hits.some((hit) => hit.todoId === review.id && hit.todoStatus === 'awaiting_review')).toBe(true)
      expect(hits.some((hit) => hit.todoId === proposed.id && hit.todoStatus === 'proposed')).toBe(true)
      expect(hits.some((hit) => hit.todoId === done.id && hit.todoStatus === 'done')).toBe(true)
      expect(hits.some((hit) => hit.todoId === outside.id)).toBe(false)
      const commentHit = hits.find((hit) => hit.commentId === matchedComment.id)!
      expect(commentHit).toMatchObject({
        source: 'comment',
        todoId: done.id,
        todoTitle: done.title,
        todoStatus: 'done',
        commentId: matchedComment.id,
        author: 'agent:reviewer',
        createdAt: matchedComment.createdAt
      })
      expect(commentHit.snippet).toContain('收口评论 needle')
    })

    it('把 % 和 _ 当普通字符，且拒绝空查询', () => {
      const p = projects.create({ name: '字面检索项目' })
      const literal = todos.create({
        title: 'literal %_ marker',
        categoryIds: [CAT],
        projectId: p.id
      })
      todos.create({
        title: 'literal XX marker',
        categoryIds: [CAT],
        projectId: p.id
      })
      expect(projects.search(p.id, '%_').map((hit) => hit.todoId)).toEqual([literal.id])
      expect(() => projects.search(p.id, '  ')).toThrow(/关键字不能为空/)
    })
  })

  describe('四字段（项目 / 父需求 / 分类 / 提出者）', () => {
    it('四个字段彼此正交：改一个不影响其他', () => {
      const p = projects.create({ name: 'P' })
      const story = todos.create({
        title: 'story',
        categoryIds: [CAT],
        projectId: p.id,
        createdBy: 'agent:alice'
      })
      expect(story.parentId).toBeNull()

      const task = todos.create({
        title: 'task',
        categoryIds: [CAT],
        projectId: p.id,
        parentId: story.id,
        createdBy: 'human'
      })

      expect(task.projectId).toBe(p.id)
      expect(task.parentId).toBe(story.id)
      expect(task.categoryIds).toEqual([CAT])
      expect(task.createdBy).toBe('human')

      // 只改提出者，其余不动
      const updated = todos.update({ id: task.id, createdBy: 'agent:codex' })
      expect(updated.createdBy).toBe('agent:codex')
      expect(updated.projectId).toBe(p.id)
      expect(updated.parentId).toBe(story.id)
      expect(updated.categoryIds).toEqual([CAT])
    })

    it('删除父需求后，子事项提升为顶层而不是一起消失', () => {
      // 同样是外键 SET NULL 语义，临时开外键
      db.pragma('foreign_keys = ON')
      try {
        const p = projects.create({ name: 'P' })
        const story = todos.create({ title: 'story', categoryIds: [CAT], projectId: p.id })
        const task = todos.create({
          title: 'task',
          categoryIds: [CAT],
          projectId: p.id,
          parentId: story.id
        })

        todos.delete(story.id)

        const after = todos.getById(task.id)
        expect(after).not.toBeNull()
        expect(after?.parentId).toBeNull()
        // 项目归属不受影响 —— 删掉的是层级，不是容器
        expect(after?.projectId).toBe(p.id)
      } finally {
        db.pragma('foreign_keys = OFF')
      }
    })

    it('回读时四个字段与写入一致（真的落库，不是只在内存）', () => {
      const p = projects.create({ name: 'P' })
      const created = todos.create({
        title: 'x',
        description: 'agent 写的说明',
        categoryIds: [CAT],
        projectId: p.id,
        createdBy: 'agent:e2ebot'
      })

      const back = todos.getById(created.id)
      expect(back?.projectId).toBe(p.id)
      expect(back?.createdBy).toBe('agent:e2ebot')
      expect(back?.description).toBe('agent 写的说明')
      expect(back?.categoryIds).toEqual([CAT])
    })
  })
})
