import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { runMigrations } from '../../../src/main/database/migrations'

// Mock getDatabase
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

// Mock uuid to return predictable IDs
let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}))

describe('TodoRepository', () => {
  let repo: TodoRepository

  beforeAll(() => {
    // 走真实迁移，而不是在这里抄一份 schema 副本。
    // 之前就是抄的副本：迁移 v5 加了 description / priority / due_at，
    // 这里的手写 CREATE TABLE 没跟上，导致整个文件 22 个用例一次性全红。
    // schema 只应有一处真相，测试也不例外。
    runMigrations(db)

    // better-sqlite3 默认开启外键，而真实 schema 里 todos.category_id 引用 categories.id。
    // 本文件测的是仓储自身的逻辑，用例里用的 'cat-1' 等分类并不真实存在
    // （还有一条用例专门验证 categoryId 默认空串），开着外键会全部插不进去。
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    // 删除留痕的墓碑也要清：mock 的 uuid 每个用例都从 1 重数，
    // 不清的话上个用例留下的墓碑会被下个用例的同 id 撞上（假失败）
    db.prepare("DELETE FROM events WHERE type = 'todo_deleted'").run()
    uuidCounter = 0
    repo = new TodoRepository()
  })

  describe('v12: type / createdBy / executedBy', () => {
    it('create 默认 type=task、executedBy=null（提出即执行）', () => {
      db.prepare('INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)').run('cat-seed', '默认', '#5388F6')
      const todo = repo.create({ title: '默认形态', categoryIds: ['cat-seed'] })
      expect(todo.type).toBe('task')
      expect(todo.createdBy).toBe('human')
      expect(todo.executedBy).toBeNull()
    })

    it('create 显式传 type 与 executedBy 时如实落库', () => {
      db.prepare('INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)').run('cat-seed', '默认', '#5388F6')
      const todo = repo.create({
        title: '导出按钮无响应',
        categoryIds: ['cat-seed'],
        type: 'bug',
        createdBy: 'agent:alice',
        executedBy: 'human'
      })
      expect(todo.type).toBe('bug')
      expect(todo.createdBy).toBe('agent:alice')
      expect(todo.executedBy).toBe('human')

      const back = repo.getById(todo.id)
      expect(back?.type).toBe('bug')
      expect(back?.createdBy).toBe('agent:alice')
      expect(back?.executedBy).toBe('human')
    })

    it('create 非法 type 抛错', () => {
      db.prepare('INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)').run('cat-seed', '默认', '#5388F6')
      expect(() =>
        repo.create({ title: 'x', categoryIds: ['cat-seed'], type: 'story' as never })
      ).toThrow(/非法的事项类型/)
    })

    it('update 三态：undefined 保持 / null 清空指派 / 值指派', () => {
      db.prepare('INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)').run('cat-seed', '默认', '#5388F6')
      const todo = repo.create({ title: 'x', categoryIds: ['cat-seed'], createdBy: 'agent:a', executedBy: 'human' })

      // undefined = 未提及（保持）
      const kept = repo.update({ id: todo.id, title: '改标题而已' })
      expect(kept.executedBy).toBe('human')
      // null = 明确清掉指派，回到提出者执行
      const cleared = repo.update({ id: todo.id, executedBy: null })
      expect(cleared.executedBy).toBeNull()
      // 值 = 重新指派
      const reassigned = repo.update({ id: todo.id, executedBy: 'agent:b' })
      expect(reassigned.executedBy).toBe('agent:b')
    })

    it('update 非法 type 抛错', () => {
      db.prepare('INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)').run('cat-seed', '默认', '#5388F6')
      const todo = repo.create({ title: 'x', categoryIds: ['cat-seed'] })
      expect(() => repo.update({ id: todo.id, type: 'story' as never })).toThrow(/非法的事项类型/)
    })
  })

  describe('create()', () => {
    it('should create a todo with default values', () => {
      const todo = repo.create({ title: 'Test todo', categoryIds: ['cat-1'] })

      expect(todo.id).toBe('test-uuid-1')
      expect(todo.title).toBe('Test todo')
      expect(todo.categoryIds).toEqual(['cat-1'])
      expect(todo.status).toBe('todo')
      expect(todo.isPinned).toBe(false)
      expect(todo.completedAt).toBeNull()
      expect(todo.createdAt).toBeTruthy()
      expect(todo.updatedAt).toBeTruthy()
    })

    it('should store remindAt when provided', () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString()
      const todo = repo.create({ title: 'Remind me', categoryIds: ['cat-1'], remindAt: futureDate })

      expect(todo.remindAt).toBe(futureDate)
    })

    it('should default remindAt to null when not provided', () => {
      const todo = repo.create({ title: 'No reminder', categoryIds: ['cat-1'] })
      expect(todo.remindAt).toBeNull()
    })

    it('should fall back to the first category when categoryId is not provided', () => {
      // 不指定分类时取第一个分类，而不是留空。
      //
      // 这里原先断言的是"默认为空字符串"，但那个行为在生产环境必然失败：
      // category_id 是 NOT NULL 且有外键约束，空字符串会撞出
      // "FOREIGN KEY constraint failed" —— 报错完全看不出真实原因。
      // 本文件为了方便造数据关掉了外键（见 beforeAll），所以那条旧断言能通过，
      // 属于"测试保护了 bug"，已随之修正。
      db.prepare(
        'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)'
      ).run('cat-seed', '默认', '#5388F6')

      const todo = repo.create({ title: 'No category' })
      expect(todo.categoryIds).toEqual(['cat-seed'])
    })

    it('should throw a clear error when no category exists at all', () => {
      // 一个分类都没有时，不能悄悄写个非法值进去，
      // 要报出能看懂的原因（beforeEach 清空了 categories）
      expect(() => repo.create({ title: 'No category' })).toThrow(/还没有任何分类/)
    })

    it('should create a todo directly in the given status', () => {
      // status 曾经被写死成 'todo'，导致 CreateTodoInput.status 声明了却不生效。
      // 表现是"从看板某列新增的任务仍落在待办列"。
      db.prepare(
        'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)'
      ).run('cat-seed', '默认', '#5388F6')

      const todo = repo.create({ title: 'In progress', categoryIds: ['cat-seed'], status: 'in_progress' })
      expect(todo.status).toBe('in_progress')
      expect(todo.completedAt).toBeNull()
    })

    it('should set completedAt when created directly as done', () => {
      db.prepare(
        'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)'
      ).run('cat-seed', '默认', '#5388F6')

      const todo = repo.create({ title: 'Already done', categoryIds: ['cat-seed'], status: 'done' })
      expect(todo.status).toBe('done')
      // 直接建成已完成时若不落完成时间，逾期判断等逻辑会读到不一致的状态
      expect(todo.completedAt).toBeTruthy()
    })

    it('should reject an invalid status', () => {
      db.prepare(
        'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)'
      ).run('cat-seed', '默认', '#5388F6')

      expect(() =>
        repo.create({ title: 'Bad', categoryIds: ['cat-seed'], status: 'nope' as never })
      ).toThrow(/非法的状态/)
    })

    it('候选池状态 proposed / awaiting_review 是合法状态，可直接创建', () => {
      db.prepare(
        'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)'
      ).run('cat-seed', '默认', '#5388F6')

      const p = repo.create({ title: '提议', categoryIds: ['cat-seed'], status: 'proposed' })
      expect(p.status).toBe('proposed')
      expect(p.completedAt).toBeNull()

      const a = repo.create({
        title: '待验收',
        categoryIds: ['cat-seed'],
        status: 'awaiting_review'
      })
      expect(a.status).toBe('awaiting_review')
      expect(a.completedAt).toBeNull()
    })
  })

  describe('候选池守卫（G1/G2/G4）', () => {
    function seedCategory() {
      db.prepare(
        'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, 1, 0)'
      ).run('cat-seed', '默认', '#5388F6')
    }

    it('G4：CLI（不标 source）把 proposed 挪出「待确认」被拒绝（Bob实测的绕过路径）', () => {
      seedCategory()
      const p = repo.create({ title: '提议', categoryIds: ['cat-seed'], status: 'proposed' })

      expect(() => repo.update({ id: p.id, status: 'todo' })).toThrow(/G4/)
      expect(() => repo.update({ id: p.id, status: 'awaiting_review' })).toThrow(/G4/)
      expect(() => repo.update({ id: p.id, status: 'done' })).toThrow(/G4/)
      expect(() => repo.update({ id: p.id, status: 'suspended' })).toThrow(/G4/)
      // 事项确实没被动过
      expect(repo.getById(p.id)?.status).toBe('proposed')
    })

    it('G4：界面路径（source: gui）拍板拖拽被放行——候选池"提议→人确认"闭环（主用户撞的回归）', () => {
      seedCategory()
      const p = repo.create({ title: '提议', categoryIds: ['cat-seed'], status: 'proposed' })

      const moved = repo.update({ id: p.id, status: 'todo', source: 'gui' })
      expect(moved.status).toBe('todo')
      // 人也能直接驳回为挂起（1.0.25 拍板的驳回语义=转挂起）
      const p2 = repo.create({ title: '提议2', categoryIds: ['cat-seed'], status: 'proposed' })
      expect(repo.update({ id: p2.id, status: 'suspended', source: 'gui' }).status).toBe(
        'suspended'
      )
    })

    it('G4：source 显式传 cli 与不传同罪——调用方不能自标放行', () => {
      seedCategory()
      const p = repo.create({ title: '提议', categoryIds: ['cat-seed'], status: 'proposed' })
      expect(() => repo.update({ id: p.id, status: 'todo', source: 'cli' })).toThrow(/G4/)
    })

    it('G4：非 proposed 事项的状态迁移不受影响（守卫只管候选池那道闸）', () => {
      seedCategory()
      const t = repo.create({ title: '普通待办', categoryIds: ['cat-seed'] })
      const moved = repo.update({ id: t.id, status: 'in_progress' })
      expect(moved.status).toBe('in_progress')
    })

    /**
     * 删除维度：只拦状态迁移却不拦删除的话，agent 可以 rm 掉人还没拍板的条目、
     * 再另建一条，关口等于形同虚设。Bob 2026-09-18 实测：
     * todo update 被 exit 4 硬拦，todo rm 同一个 id 却直接 deleted:true。
     */
    it('G4：删除同样要过闸——agent 不能 rm 掉「待确认」列的条目', () => {
      seedCategory()
      const p = repo.create({ title: '提议', categoryIds: ['cat-seed'], status: 'proposed' })

      expect(() => repo.delete(p.id)).toThrow(/G4/)
      expect(() => repo.delete(p.id, 'cli')).toThrow(/G4/)
      // 被拦下之后条目必须还在
      expect(repo.getById(p.id)).not.toBeNull()
    })

    it('G4：界面路径删除「待确认」条目放行——人有权清掉自己队列里的提议', () => {
      seedCategory()
      const p = repo.create({ title: '提议', categoryIds: ['cat-seed'], status: 'proposed' })

      expect(() => repo.delete(p.id, 'gui')).not.toThrow()
      expect(repo.getById(p.id)).toBeNull()
    })

    it('G4：非 proposed 条目的删除不受影响', () => {
      seedCategory()
      const t = repo.create({ title: '普通待办', categoryIds: ['cat-seed'] })
      expect(() => repo.delete(t.id)).not.toThrow()
      expect(repo.getById(t.id)).toBeNull()
    })

    /**
     * 状态迁移历史（v14）：动态里"流转过程"的数据来源。
     * 之前只有新建和完成两个点，中间的流转全丢失 —— 补的就是这一段。
     */
    it('状态迁移：新建 + 每一次流转都记一条，且带动作人', () => {
      seedCategory()
      const t = repo.create({ title: '流转冒烟', categoryIds: ['cat-seed'], status: 'proposed' })
      // 新建本身已记一条（fromStatus 为 null），后面的流转应在此基础上累加
      const base = repo.listTransitions(t.id).length
      expect(base).toBeGreaterThanOrEqual(1)

      repo.update({ id: t.id, status: 'todo', source: 'gui', actor: 'human' })
      repo.update({ id: t.id, status: 'in_progress', source: 'gui', actor: 'human' })
      repo.update({ id: t.id, status: 'suspended', source: 'gui', actor: 'human' })
      repo.update({ id: t.id, status: 'done', source: 'gui', actor: 'human' })

      const trs = repo.listTransitions(t.id)
      // 全库共用一份内存库，历史迁移会混进来 —— 断言"本次新增了 4 条流转"而不是绝对总数
      expect(trs.length - base).toBe(4)
      // 中间过程没丢：待办→进行中→挂起→已完成
      expect(trs.map((x) => x.toStatus).slice(-4)).toEqual([
        'todo',
        'in_progress',
        'suspended',
        'done'
      ])
      const last = trs[trs.length - 1]
      expect(last.fromStatus).toBe('suspended')
      expect(last.toStatus).toBe('done')
      expect(last.actor).toBe('human')
    })

    it('改标题 / 改优先级不记迁移 —— 那些不是流转，不该污染动态', () => {
      seedCategory()
      const t = repo.create({ title: 'x', categoryIds: ['cat-seed'] })
      const base = repo.listTransitions(t.id).length
      repo.update({ id: t.id, title: '改了个标题' })
      repo.update({ id: t.id, priority: 'high' })

      // 改标题/优先级不该新增迁移
      expect(repo.listTransitions(t.id).length).toBe(base)
    })

    it('动作人没传就如实记 null，不猜', () => {
      seedCategory()
      const t = repo.create({ title: '无动作人', categoryIds: ['cat-seed'] })
      repo.update({ id: t.id, status: 'done', source: 'gui' })

      const trs = repo.listTransitions(t.id)
      const last = trs[trs.length - 1]
      expect(last.toStatus).toBe('done')
      expect(last.actor).toBeNull()
    })

    it('G1：父需求还在「待确认」时，创建子任务被拒绝', () => {
      seedCategory()
      const parent = repo.create({
        title: '未确认的父需求',
        categoryIds: ['cat-seed'],
        status: 'proposed'
      })

      expect(() =>
        repo.create({ title: '子任务', categoryIds: ['cat-seed'], parentId: parent.id })
      ).toThrow(/G1/)
    })

    it('G1：父需求确认（转 todo）后，子任务可以创建', () => {
      seedCategory()
      const parent = repo.create({
        title: '已确认的父需求',
        categoryIds: ['cat-seed'],
        status: 'proposed'
      })
      // G4 生效后 repo 层不再放行 proposed→todo —— 这里直接以 todo 状态
      // 重建一条等价父需求来验证 G1 的放行分支（该迁移由人走界面 IPC 通道）
      const confirmed = repo.create({
        title: '已确认的父需求',
        categoryIds: ['cat-seed'],
        status: 'todo'
      })

      const child = repo.create({
        title: '子任务',
        categoryIds: ['cat-seed'],
        parentId: confirmed.id
      })
      expect(child.parentId).toBe(confirmed.id)
    })

    it('G1：通过 update 把子任务改挂到未确认父需求上，同样被拒绝', () => {
      seedCategory()
      const parent = repo.create({
        title: '未确认的父需求',
        categoryIds: ['cat-seed'],
        status: 'proposed'
      })
      const loose = repo.create({ title: '散任务', categoryIds: ['cat-seed'] })

      expect(() => repo.update({ id: loose.id, parentId: parent.id })).toThrow(/G1/)
    })

    it('G2：父需求转「待验收」但有未完成子任务时被拒绝', () => {
      seedCategory()
      const parent = repo.create({ title: '父需求', categoryIds: ['cat-seed'] })
      repo.create({ title: '子任务A', categoryIds: ['cat-seed'], parentId: parent.id })
      const b = repo.create({
        title: '子任务B',
        categoryIds: ['cat-seed'],
        parentId: parent.id,
        status: 'done'
      })

      // A 还没完成 → 拒绝
      expect(() => repo.update({ id: parent.id, status: 'awaiting_review' })).toThrow(/G2/)

      // 全部完成后放行（父需求本身是 todo，G4 不涉及）
      repo.update({ id: b.id, status: 'done' })
      const children = repo.list().filter((t) => t.parentId === parent.id)
      for (const c of children) {
        if (c.status !== 'done') repo.update({ id: c.id, status: 'done' })
      }
      const ok = repo.update({ id: parent.id, status: 'awaiting_review' })
      expect(ok.status).toBe('awaiting_review')
    })

    it('G2：无子任务的父需求可直接转「待验收」', () => {
      seedCategory()
      const parent = repo.create({ title: '没有子任务的父需求', categoryIds: ['cat-seed'] })
      const ok = repo.update({ id: parent.id, status: 'awaiting_review' })
      expect(ok.status).toBe('awaiting_review')
    })
  })

  describe('update()', () => {
    it('should update fields and change updatedAt', async () => {
      const created = repo.create({ title: 'Original', categoryIds: ['cat-1'] })
      await new Promise(r => setTimeout(r, 10))

      const updated = repo.update({ id: created.id, title: 'Updated' })

      expect(updated.title).toBe('Updated')
      expect(updated.updatedAt).not.toBe(created.updatedAt)
      expect(updated.categoryIds).toEqual(['cat-1'])
    })

    it('should set completedAt when status changes to done', () => {
      const created = repo.create({ title: 'Todo', categoryIds: ['cat-1'] })
      const updated = repo.update({ id: created.id, status: 'done' })

      expect(updated.status).toBe('done')
      expect(updated.completedAt).not.toBeNull()
    })

    it('should clear completedAt when status changes from done to other', () => {
      const created = repo.create({ title: 'Todo', categoryIds: ['cat-1'] })
      repo.update({ id: created.id, status: 'done' })
      const updated = repo.update({ id: created.id, status: 'todo' })

      expect(updated.status).toBe('todo')
      expect(updated.completedAt).toBeNull()
    })

    it('should throw when updating non-existent id', () => {
      expect(() => repo.update({ id: 'non-existent', title: 'Nope' })).toThrow(/待办事项不存在/)
    })

    it('should update isPinned', () => {
      const created = repo.create({ title: 'Pin me', categoryIds: ['cat-1'] })
      const updated = repo.update({ id: created.id, isPinned: true })

      expect(updated.isPinned).toBe(true)
    })
  })

  describe('delete()', () => {
    it('should delete a todo and getById returns null', () => {
      const created = repo.create({ title: 'Delete me', categoryIds: ['cat-1'] })
      repo.delete(created.id)

      expect(repo.getById(created.id)).toBeNull()
    })
  })

  describe('list()', () => {
    it('should return all todos ordered by isPinned DESC, createdAt DESC', () => {
      const t1 = repo.create({ title: 'First', categoryIds: ['cat-1'] })
      const t2 = repo.create({ title: 'Second', categoryIds: ['cat-1'] })
      repo.update({ id: t2.id, isPinned: true })

      const list = repo.list()

      expect(list).toHaveLength(2)
      expect(list[0].id).toBe(t2.id)
      expect(list[1].id).toBe(t1.id)
    })

    it('should filter by status', () => {
      repo.create({ title: 'Todo1', categoryIds: ['cat-1'] })
      const t2 = repo.create({ title: 'Todo2', categoryIds: ['cat-1'] })
      repo.update({ id: t2.id, status: 'done' })

      const list = repo.list({ status: 'done' })
      expect(list).toHaveLength(1)
      expect(list[0].title).toBe('Todo2')
    })

    it('should filter by keyword (fuzzy match title)', () => {
      repo.create({ title: 'Buy groceries', categoryIds: ['cat-1'] })
      repo.create({ title: 'Read book', categoryIds: ['cat-1'] })

      const list = repo.list({ keyword: 'grocer' })
      expect(list).toHaveLength(1)
      expect(list[0].title).toBe('Buy groceries')
    })

    it('should filter by categoryId', () => {
      repo.create({ title: 'Work task', categoryIds: ['cat-work'] })
      repo.create({ title: 'Life task', categoryIds: ['cat-life'] })

      const list = repo.list({ categoryId: 'cat-work' })
      expect(list).toHaveLength(1)
      expect(list[0].categoryIds).toEqual(['cat-work'])
    })

    it('should combine multiple filters', () => {
      repo.create({ title: 'Work todo', categoryIds: ['cat-work'] })
      const t2 = repo.create({ title: 'Work done', categoryIds: ['cat-work'] })
      repo.update({ id: t2.id, status: 'done' })

      const list = repo.list({ categoryId: 'cat-work', status: 'done' })
      expect(list).toHaveLength(1)
      expect(list[0].title).toBe('Work done')
    })
  })

  describe('getById()', () => {
    it('should return Todo when exists', () => {
      const created = repo.create({ title: 'Find me', categoryIds: ['cat-1'] })
      const found = repo.getById(created.id)

      expect(found).not.toBeNull()
      expect(found!.title).toBe('Find me')
    })

    it('should return null when not exists', () => {
      expect(repo.getById('non-existent')).toBeNull()
    })
  })

  describe('batchUpdateStatus()', () => {
    it('should batch update status with completedAt for done', () => {
      const t1 = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      const t2 = repo.create({ title: 'B', categoryIds: ['cat-1'] })

      repo.batchUpdateStatus([t1.id, t2.id], 'done')

      const found1 = repo.getById(t1.id)
      const found2 = repo.getById(t2.id)

      expect(found1!.status).toBe('done')
      expect(found1!.completedAt).not.toBeNull()
      expect(found2!.status).toBe('done')
      expect(found2!.completedAt).not.toBeNull()
    })

    it('should set completedAt to null for non-done status', () => {
      const t1 = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      repo.batchUpdateStatus([t1.id], 'in_progress')

      const found = repo.getById(t1.id)
      expect(found!.status).toBe('in_progress')
      expect(found!.completedAt).toBeNull()
    })
  })

  describe('getPendingReminders()', () => {
    it('should return todos with remind_at > now and not done', () => {
      const future = new Date(Date.now() + 86400000).toISOString()
      repo.create({ title: 'Future', categoryIds: ['cat-1'], remindAt: future })
      repo.create({ title: 'No remind', categoryIds: ['cat-1'] })

      const pending = repo.getPendingReminders()
      expect(pending).toHaveLength(1)
      expect(pending[0].title).toBe('Future')
    })

    it('should not return done todos even with future remind_at', () => {
      const future = new Date(Date.now() + 86400000).toISOString()
      const t = repo.create({ title: 'Done', categoryIds: ['cat-1'], remindAt: future })
      repo.update({ id: t.id, status: 'done' })

      expect(repo.getPendingReminders()).toHaveLength(0)
    })
  })

  describe('getOverdueReminders()', () => {
    it('should return todos with remind_at <= now and not done', () => {
      const past = new Date(Date.now() - 86400000).toISOString()
      repo.create({ title: 'Overdue', categoryIds: ['cat-1'], remindAt: past })

      const overdue = repo.getOverdueReminders()
      expect(overdue).toHaveLength(1)
      expect(overdue[0].title).toBe('Overdue')
    })

    it('should not return done todos even with past remind_at', () => {
      const past = new Date(Date.now() - 86400000).toISOString()
      const t = repo.create({ title: 'Done overdue', categoryIds: ['cat-1'], remindAt: past })
      repo.update({ id: t.id, status: 'done' })

      expect(repo.getOverdueReminders()).toHaveLength(0)
    })
  })

  describe('详细字段（描述 / 优先级 / 截止时间）', () => {
    it('创建时未指定则取默认值 normal / null / null', () => {
      const todo = repo.create({ title: 'Plain', categoryIds: ['cat-1'] })

      expect(todo.priority).toBe('normal')
      expect(todo.description).toBeNull()
      expect(todo.dueAt).toBeNull()
    })

    it('创建时写入并读回详细字段', () => {
      const due = new Date(Date.now() + 86400000).toISOString()
      const created = repo.create({
        title: 'Detailed',
        categoryIds: ['cat-1'],
        description: '一段描述',
        priority: 'urgent',
        dueAt: due
      })

      const got = repo.getById(created.id)
      expect(got?.description).toBe('一段描述')
      expect(got?.priority).toBe('urgent')
      expect(got?.dueAt).toBe(due)
    })

    it('空描述会被归一化为 null，而不是存空串', () => {
      const todo = repo.create({ title: 'Empty desc', categoryIds: ['cat-1'], description: '   ' })
      expect(todo.description).toBeNull()
    })

    it('更新时未提及的字段保持原值', () => {
      const t = repo.create({
        title: 'Keep',
        categoryIds: ['cat-1'],
        description: '原描述',
        priority: 'high'
      })

      const updated = repo.update({ id: t.id, title: '改了标题' })

      expect(updated.title).toBe('改了标题')
      expect(updated.description).toBe('原描述')
      expect(updated.priority).toBe('high')
    })

    it('更新时显式 null 会清空字段', () => {
      const t = repo.create({
        title: 'Clear',
        categoryIds: ['cat-1'],
        description: '待清空',
        dueAt: new Date().toISOString()
      })

      const updated = repo.update({ id: t.id, description: null, dueAt: null })

      expect(updated.description).toBeNull()
      expect(updated.dueAt).toBeNull()
    })

    it('非法优先级会被拒绝，不写入脏数据', () => {
      expect(() =>
        repo.create({ title: 'Bad', categoryIds: ['cat-1'], priority: 'p1' as never })
      ).toThrow(/非法的优先级/)

      const t = repo.create({ title: 'Good', categoryIds: ['cat-1'] })
      expect(() => repo.update({ id: t.id, priority: 'p1' as never })).toThrow(/非法的优先级/)
    })
  })

  /**
   * 批量改 / 批量删（2026-09-24 主用户拍板的批量能力）
   *
   * 最要紧的一条：**一条失败不能拖垮整批**，而且必须说得出是哪条、为什么。
   * 原先那种"单事务打包"的写法（batchUpdateStatus）做不到这一点 ——
   * 整批回滚之后回执只说"整体失败"，人只能一条条试，批量等于白做。
   */
  /**
   * 删除留痕（2026-09-28 主用户拍板：① 快照进 events + ③ history 返回墓碑）
   *
   * 删除是最不可逆的动作，而此前删完之后 `todo history` 只回"待办不存在" ——
   * 谁删的、删之前是什么状态，一个都答不上来。误删/争议/审计全靠这一条。
   */
  describe('删除留痕（快照进 events + 墓碑可查）', () => {
    it('删掉之后还能查出是谁删的、当时什么状态', () => {
      const t = repo.create({ title: '会被删掉的', categoryIds: ['cat-1'], status: 'in_progress' })

      repo.delete(t.id, 'gui', 'human')

      // ① 快照写进 events
      const tomb = repo.findDeletedSnapshot(t.id)
      expect(tomb).not.toBeNull()
      expect(tomb!.actor).toBe('human')
      expect(tomb!.snapshot.title).toBe('会被删掉的')
      expect(tomb!.snapshot.status).toBe('in_progress')
      expect(tomb!.deletedAt).toBeTruthy()
    })

    it('没删过的 id 查不到墓碑（不能拿别的条目的快照凑数）', () => {
      const t = repo.create({ title: '活着', categoryIds: ['cat-1'] })
      expect(repo.findDeletedSnapshot(t.id)).toBeNull()
      // 陌生 id 也一样
      expect(repo.findDeletedSnapshot('not-exist-id')).toBeNull()
    })

    it('前缀相同的另一个 id 不会被误认成同一条', () => {
      const a = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      const b = repo.create({ title: 'B', categoryIds: ['cat-1'] })
      repo.delete(a.id, 'gui', 'human')
      // B 还活着，不该因为 id 前缀相近就拿到 A 的墓碑
      expect(repo.findDeletedSnapshot(b.id)).toBeNull()
      expect(repo.findDeletedSnapshot(a.id)!.snapshot.title).toBe('A')
    })

    /**
     * 🚨 这一条锁的是 **1.0.60 才暴露的真因**（主用户驳回 b3ac3d32）。
     *
     * 上面那些用例全绿，但"删除留痕"在真实使用里**根本不成立** ——
     * 因为 `todo history` 的第一行是 `resolveId(input)`，而已删条目的 id
     * 在 `todos` 表里已不存在 → 抛 "待办不存在"，**墓碑分支永远走不到**。
     *
     * 这类缺陷的通用形状：**被测的是"零件"，坏的是"接线"**。
     * 所以这里必须从 `resolveId` 这个**调用链起点**开始断言，
     * 而不是再测一遍 `findDeletedSnapshot`。
     */
    it('resolveId 带 allowDeleted 时能解析已删 id（墓碑分支的入口，1.0.60）', () => {
      const t = repo.create({ title: '删了就查得到', categoryIds: ['cat-1'] })
      repo.delete(t.id, 'gui', 'human')

      // 入口能解析 —— 没有这一条，commands.ts 里的墓碑分支是死代码
      expect(repo.resolveId(t.id, { allowDeleted: true })).toBe(t.id)
      // 前缀也认
      expect(repo.resolveId(t.id.slice(0, 8), { allowDeleted: true })).toBe(t.id)
    })

    it('不带 allowDeleted 时行为不变：写路径照旧拒绝已删 id', () => {
      const t = repo.create({ title: '不许拿它做写操作', categoryIds: ['cat-1'] })
      repo.delete(t.id, 'gui', 'human')

      /**
       * ⚠️ 这条是**防扩散**断言：墓碑解析只在只读路径开启。
       * 若哪天有人把 allowDeleted 变成默认，update/comment/rm 拿到已删 id
       * 就会绕进下游的诡异报错，而不是干脆的"待办不存在"。
       */
      expect(() => repo.resolveId(t.id)).toThrow(/待办不存在/)
    })

    it('删→撤销→再删：墓碑取最新一条，不误报"匹配到多条"', () => {
      const t = repo.create({ title: '删两次', categoryIds: ['cat-1'] })
      repo.delete(t.id, 'gui', 'human')

      // 撤销放回（GUI 的撤销通道），再删一次 → 同一条会有两个墓碑
      const tomb = repo.findDeletedSnapshot(t.id)!
      expect(repo.resolveId(t.id, { allowDeleted: true })).toBe(t.id)
      repo.restore(tomb.snapshot as never)
      repo.delete(t.id, 'gui', 'agent:bob')

      // 实测真库 b28c7053 就是这个形状（events 3130 / 3135）：
      // 不去重的话前缀解析会回"匹配到 2 条已删待办，请写更长一些" ——
      // 而用户写满整个 id 也还是 2 条，是条死胡同。
      expect(repo.resolveId(t.id, { allowDeleted: true })).toBe(t.id)
      expect(repo.resolveId(t.id.slice(0, 8), { allowDeleted: true })).toBe(t.id)
      expect(repo.findDeletedSnapshot(t.id)!.actor).toBe('agent:bob')
    })
  })

  describe('batchUpdate / batchDelete（逐条执行 + 汇总回执）', () => {
    it('批量改优先级：全部成功', () => {
      const a = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      const b = repo.create({ title: 'B', categoryIds: ['cat-1'] })

      const r = repo.batchUpdate([a.id, b.id], { priority: 'high', source: 'gui' })

      expect(r.updated).toEqual([a.id, b.id])
      expect(r.failed).toHaveLength(0)
      expect(repo.getById(a.id)!.priority).toBe('high')
      expect(repo.getById(b.id)!.priority).toBe('high')
    })

    it('一张失败不拖垮其余：成功的照旧落库，失败的带回标题与原因', () => {
      const ok = repo.create({ title: '能改的', categoryIds: ['cat-1'] })
      // 不存在的那条会抛「待办事项不存在」
      const r = repo.batchUpdate([ok.id, 'not-exist-id'], { priority: 'high', source: 'gui' })

      expect(r.updated).toEqual([ok.id])
      expect(r.failed).toHaveLength(1)
      expect(r.failed[0].id).toBe('not-exist-id')
      // 关键：失败项要带**原因**，否则界面只能说"有一条没成"
      expect(r.failed[0].reason).toMatch(/不存在/)
      expect(repo.getById(ok.id)!.priority).toBe('high')
    })

    it('批量删：删掉存在的，不存在的进 failed', () => {
      const a = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      const b = repo.create({ title: 'B', categoryIds: ['cat-1'] })

      const r = repo.batchDelete([a.id, b.id, 'ghost'], 'gui')

      expect(r.deleted).toEqual([a.id, b.id])
      expect(r.failed.map((f) => f.id)).toEqual(['ghost'])
      expect(repo.getById(a.id)).toBeNull()
    })

    it('批量改走的是 update()，守卫照常生效（G4：待确认列不能由 agent 代转）', () => {
      const p = repo.create({ title: '待确认的', categoryIds: ['cat-1'], status: 'proposed' })

      // 不带 source:'gui' = agent 路径 → G4 应当拦下
      const r = repo.batchUpdate([p.id], { status: 'todo' })

      expect(r.updated).toHaveLength(0)
      expect(r.failed).toHaveLength(1)
      expect(r.failed[0].reason).toMatch(/待确认/)
      // 被拦下 = 真的没改
      expect(repo.getById(p.id)!.status).toBe('proposed')
    })
  })

  /**
   * v24「解决于版本」（主用户 2026-09-29）
   *
   * 这一组锁的是**三态语义**（undefined 保持 / null 清空 / 字符串标注）。
   * 三态是这次唯一容易写错的地方：库里 NULL 与"未标注"是同一个意思，
   * 但调用方传 undefined（没提这件事）与 null（明确要清掉）是两回事 ——
   * 混掉之后「改个标题顺手把版本号抹掉」会静默发生。
   */
  describe('v24: fixedInVersion（解决于版本）', () => {
    it('create 不传 = 未标注（null）', () => {
      const t = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      expect(t.fixedInVersion).toBeNull()
      expect(repo.getById(t.id)!.fixedInVersion).toBeNull()
    })

    it('update 传版本号 = 标注，且能从库里读回', () => {
      const t = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      repo.update({ id: t.id, fixedInVersion: '1.0.59' })
      expect(repo.getById(t.id)!.fixedInVersion).toBe('1.0.59')
    })

    it('update 不传该字段 = 保持原值（改标题不该顺手抹掉版本号）', () => {
      const t = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      repo.update({ id: t.id, fixedInVersion: '1.0.59' })
      repo.update({ id: t.id, title: '改了标题' })
      expect(repo.getById(t.id)!.fixedInVersion).toBe('1.0.59')
    })

    it('update 传 null = 明确清空（标错了要能回退）', () => {
      const t = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      repo.update({ id: t.id, fixedInVersion: '1.0.59' })
      repo.update({ id: t.id, fixedInVersion: null })
      expect(repo.getById(t.id)!.fixedInVersion).toBeNull()
    })

    it('传空白串等于清空 —— 不让"名字是空白的版本"进库', () => {
      // 否则按版本筛选时下拉里会冒出一个看不见字的选项
      const t = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      repo.update({ id: t.id, fixedInVersion: '1.0.59' })
      repo.update({ id: t.id, fixedInVersion: '   ' })
      expect(repo.getById(t.id)!.fixedInVersion).toBeNull()
    })

    it('list 的 fixedInVersion 筛选：unset / any / 精确三档', () => {
      const unset = repo.create({ title: '没标', categoryIds: ['cat-1'] })
      const a = repo.create({ title: '标 1.0.58', categoryIds: ['cat-1'] })
      const b = repo.create({ title: '标 1.0.59', categoryIds: ['cat-1'] })
      repo.update({ id: a.id, fixedInVersion: '1.0.58' })
      repo.update({ id: b.id, fixedInVersion: '1.0.59' })

      const ids = (f: { fixedInVersion?: string }) =>
        repo
          .list(f)
          .map((t) => t.id)
          .sort()

      expect(ids({ fixedInVersion: 'unset' })).toEqual([unset.id])
      expect(ids({ fixedInVersion: 'any' })).toEqual([a.id, b.id].sort())
      expect(ids({ fixedInVersion: '1.0.59' })).toEqual([b.id])
      // 不传该筛选 = 不限，三条都在
      expect(repo.list().length).toBe(3)
    })

    it('删除后撤销（restore）保住版本号 —— 快照要整条回插，不是只回标题', () => {
      const t = repo.create({ title: 'A', categoryIds: ['cat-1'] })
      repo.update({ id: t.id, fixedInVersion: '1.0.59' })
      const snap = repo.getById(t.id)!
      repo.delete(t.id, 'gui', 'human')
      repo.restore(snap)
      expect(repo.getById(t.id)!.fixedInVersion).toBe('1.0.59')
    })
  })
})
