import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { STATUSES } from '../../../src/main/cli/commands'
import { STATUS_META } from '../../../src/renderer/lib/constants'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 「已废弃」是正式终态，不是删除、也不是"待做"（`a6032512` 的 e 项）
 *
 * ## 为什么要有这个独立状态
 *
 * `suspended` 的语义是"**还会回来做**"，所以它要求被定期回看。
 * 而"已决定不做"是**有答案的** —— 它不该再出现在任何待办视角里，
 * 却需要一个地方落着，好让"当初为什么不做"**可查**。
 *
 * 实测（1.0.68）：挂起列一度 34 张，混着四种完全不同的东西 ——
 * 「已拍板不做」「等基建」「等你点名」「别的项目的」。
 * **一个状态同时装着"已完成"和"在等人"，于是谁都扫不出来。**
 *
 * 参照 Linear：Rejected / Duplicate → Canceled 并写原因，**不是删掉**。
 *
 * ## 与 `done` 的区别（混用会让完成率失真）
 *
 * `done` = 做完了；`discarded` = 不做了。**都不是"没做"。**
 */
describe('已废弃是正式终态（a6032512 e）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  const seed = (over: Record<string, unknown> = {}) =>
    todos.create({ title: '一件事', projectId: null, createdBy: 'human', ...over } as never)

  it('CLI 接受 discarded 这个状态（否则改了界面也没用）', () => {
    expect(
      STATUSES.includes('discarded' as never),
      'CLI 的 STATUSES 里没有 discarded —— agent 根本设不了'
    ).toBe(true)
  })

  it('界面有它的标签（STATE_META 缺一项就会渲染成 undefined）', () => {
    expect((STATUS_META as Record<string, { label: string }>).discarded).toBeTruthy()
    expect(
      (STATUS_META as Record<string, { label: string }>).discarded.label,
      '标签要读起来像"已有结论"而不是"还没决定"'
    ).toBe('已废弃')
  })

  it('可以正常建一张废弃的卡', () => {
    const t = seed({ status: 'discarded' })
    expect(todos.getById(t.id)!.status).toBe('discarded')
  })

  it('可以正常迁移到废弃（不是只能建出来）', () => {
    const t = seed({ status: 'suspended' })
    todos.update({ id: t.id, status: 'discarded' })
    expect(todos.getById(t.id)!.status).toBe('discarded')
  })

  it.each(['todo', 'in_progress', 'awaiting_review', 'done'])(
    'agent 不得把已废弃事项自行推进到 %s',
    (status) => {
      const t = seed({ status: 'discarded' })
      expect(() => todos.update({ id: t.id, status, actor: 'agent:newmax' } as never)).toThrow('事项已废弃')
      expect(todos.getById(t.id)!.status).toBe('discarded')
    }
  )

  it('人在界面上可以明确重开，agent仍可补充废弃理由', () => {
    const t = seed({ status: 'discarded' })
    todos.update({ id: t.id, title: '补充废弃说明', actor: 'agent:newmax' })
    expect(todos.getById(t.id)!.status).toBe('discarded')
    todos.update({ id: t.id, status: 'todo', source: 'gui', actor: 'human' })
    expect(todos.getById(t.id)!.status).toBe('todo')
  })

  it('迁移要留流转记录（时间线上不能出现一段空白）', () => {
    const t = seed({ status: 'suspended' })
    todos.update({ id: t.id, status: 'discarded', actor: 'agent:alice' })
    const ts = todos.listTransitions(t.id)
    expect(ts.length, '状态迁移必须写流转记录').toBeGreaterThan(0)
    expect(ts.some((x) => x.toStatus === 'discarded'), '要有指向 discarded 的那一行').toBe(true)
  })

  /**
   * 判据：把 `discarded` 当成"未完成"会污染三处数字，
   * 而其中一处（完成率）会让她对工作量算错 —— 与 `84efa995` 是同一类危害。
   */
  it('「未完成」的口径要排除它（三处，逐处钉住）', () => {
    const files = [
      // 文件, 说明
      ['src/renderer/components/kanban/Sidebar.tsx', '侧栏「未完成」计数与项目计数'],
      ['src/renderer/components/stats/StatsView.tsx', '统计里的未完成'],
      ['src/renderer/components/panel/PanelContent.tsx', '面板待办清单'],
      ['src/renderer/lib/due-scope.ts', '今日/逾期视图'],
      ['src/main/services/timer.service.ts', '提醒服务不该再为它响']
    ] as const
    for (const [f, why] of files) {
      const src = readFileSync(join(__dirname, '../../../', f), 'utf-8')
      expect(
        src.includes('discarded'),
        `${f} 没排除 discarded —— ${why}`
      ).toBe(true)
    }
  })

  it('提醒角标那两处也别漏（否则废弃的卡还在提醒人）', () => {
    for (const f of [
      'src/renderer/windows/FloatBall.tsx',
      'src/main/services/timer.service.ts'
    ]) {
      const src = readFileSync(join(__dirname, '../../../', f), 'utf-8')
      expect(src.includes('discarded'), `${f} 没排除 discarded`).toBe(true)
    }
  })

  it('说明书讲清了「挂起 vs 已废弃」的区别', () => {
    const src = readFileSync(join(__dirname, '../../../src/main/cli/agent-guide.ts'), 'utf-8')
    expect(src, '说明书没写这两个状态的分工').toContain('已废弃')
    expect(
      src,
      '要写清"什么时候用哪个"，否则 agent 会继续把"决定不做"塞进挂起'
    ).toMatch(/等条件满足|决定不做/)
    // 不许把 discarded 说成 done
    expect(
      src.includes('discarded') && src.includes('不是 `done`') || src.includes('不是 \\`done\\`'),
      '要点明它与 done 的区别 —— 混用会让完成率失真'
    ).toBe(true)
  })
})
