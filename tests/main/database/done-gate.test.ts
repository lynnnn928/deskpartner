import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 末列 done 是软关口（1.0.65 修 `fca59bda`，Carol体验 02 实测）
 *
 * 入口方向本来就有三道硬拦（proposed → todo、直接跳 awaiting_review、
 * 直接跳 done 全被拒、退出码 4），唯独 `awaiting_review → done` 一路走通。
 * 也就是说整个候选池里**唯一能"自己宣布完成"的位置，恰好是不可逆的那一列**。
 *
 * ⚠️ 但修法不是"agent 一律不许置 done"—— 那是砍功能。
 * `todo add --status done`（记工作流水）是本产品的核心用法之一。
 * 本文件同时锁住"该拦的拦住了"和"不该拦的没被误伤"两边。
 */
describe('G10：从「待验收」转「已完成」要有人点头（fca59bda）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    new CategoryRepository().create({ name: '默认分类', color: '#5388F6', sortOrder: 0 })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    todos = new TodoRepository()
  })

  const mk = (over: Partial<{ status: string }> = {}) =>
    todos.create({
      title: '一条待办',
      projectId: null,
      createdBy: 'agent:carol',
      ...over
    } as never)

  /**
   * 1.0.67 语义变更（`a6032512`）：G10 从「按身份定权」改成「按角色定权」
   *
   * 原来：任何 agent 都不能把「待验收」推到「已完成」，只能人点。
   * 实测后果（Carol 10-05）：7 张待验收里 **5 张卡在"等人点完成"**，
   * 而产品负责人只能验界面/体验类 —— 规则在多数场景下**不可执行**。
   *
   * 现在：**运动员不当裁判**。验收者 ≠ 执行者即放行；
   * 自己做完自己验收仍然被拒（下面那条测试正是这个情形，它仍绿）。
   */
  it('换个验收者就能收口：验收者 ≠ 执行者即放行（不再一律等人点）', () => {
    // agent 提、人执行 → 执行者是 carol；让 alice 当验收者
    const t = mk({ status: 'awaiting_review', executedBy: 'human' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    ).not.toThrow()
    expect(todos.getById(t.id)!.status).toBe('done')
  })

  it('显式指定 verifier 后按它判：verifier === 执行者 仍被拒', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'agent:alice', verifier: 'agent:alice' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    ).toThrow(/G10/)
  })

  it('verifier 默认取提出者（agent 提、人执行 → 默认验收者是 agent 自己）', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'human' })
    expect(todos.getById(t.id)!.verifier).toBe('agent:carol')
  })

  it('报错要给出路（换个验收者），不是只说不许', () => {
    const t = mk({ status: 'awaiting_review' })
    try {
      todos.update({ id: t.id, status: 'done', actor: 'agent:carol' })
      throw new Error('本该被拒')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('verifier')
      expect(msg, '报错要指路，不能只说拒绝').toContain('出路')
    }
  })

  it('agent 从「待验收」自行推到「已完成」应被拒（运动员当裁判，Carol的复现路径）', () => {
    const t = mk({ status: 'awaiting_review' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:carol' })
    ).toThrow(/G10|待验收/)
  })

  it('拒绝后状态不变（不留"看起来成功"的半截改动）', () => {
    const t = mk({ status: 'awaiting_review' })
    try {
      todos.update({ id: t.id, status: 'done', actor: 'agent:carol' })
    } catch {
      /* 预期被拒 */
    }
    expect(todos.getById(t.id)!.status).toBe('awaiting_review')
  })

  it('人在界面上确认则放行（source=gui 是"人点头"的唯一凭据）', () => {
    const t = mk({ status: 'awaiting_review' })
    const done = todos.update({ id: t.id, status: 'done', source: 'gui', actor: 'human' })
    expect(done.status).toBe('done')
  })

  // ── 以下三条是"别把功能砍了"的护栏 ──────────────────────────
  it('没进过待验收的（一直待办）→ agent 自己置完成照旧合法（记工作流水）', () => {
    const t = mk({ status: 'todo' })
    const done = todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    expect(done.status, 'todo → done 是核心用法，不能被这道守卫误伤').toBe('done')
  })

  it('进行中 → 完成 也照旧合法（驳回后重做、再收口的主路径）', () => {
    const t = mk({ status: 'in_progress' })
    expect(todos.update({ id: t.id, status: 'done', actor: 'agent:alice' }).status).toBe(
      'done'
    )
  })

  it('一步建到完成（todo add --status done）不受影响', () => {
    const t = todos.create({
      title: '我做完的事',
      projectId: null,
      status: 'done',
      createdBy: 'agent:alice'
    } as never)
    expect(t.status).toBe('done')
  })

  it('守卫不误伤从「待验收」移回别处的流转（不是所有离开都算宣布完成）', () => {
    const t = mk({ status: 'awaiting_review' })
    // 执行方自己收回重开观察期：合法，与"宣布完成"是两件事
    expect(
      todos.update({ id: t.id, status: 'in_progress', actor: 'agent:alice' }).status
    ).toBe('in_progress')
  })

  it('G4 与 G10 各管一段，互不越界（待确认 → 待验收 仍由 G4 拦）', () => {
    const t = mk({ status: 'proposed' })
    expect(() => todos.update({ id: t.id, status: 'todo', actor: 'agent:alice' })).toThrow(
      /G4/
    )
  })
})
