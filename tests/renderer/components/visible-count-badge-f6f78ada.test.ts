import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  countVisibleCards,
  visibleCards,
  visibleColumns,
  type BoardVisibility
} from '../../../src/renderer/lib/board-visibility'
import { BOARD_COLUMNS } from '../../../src/renderer/lib/constants'
import { matchesDueScope } from '../../../src/renderer/lib/due-scope'
import {
  matchesTodoFilter,
  matchesViewScope,
  matchesWorkspaceStatus
} from '../../../src/renderer/lib/todo-filter'
import type { Todo } from '../../../src/renderer/types/todo'
import type { TodoStatus } from '../../../src/renderer/types/enums'

/**
 * 角标那个数就是屏幕上的卡片数（f6f78ada）
 *
 * ── 要拦的是什么 ──
 *
 * 角标原来显示「完成 X/Y」，分子分母都按**整个项目**算。它站在「当前工作」这一屏上，
 * 于是同一个项目同时露出三个数（侧栏徽标 97 / 列头合计 99 / 角标分母 515）——
 * 人对着屏幕数卡片永远对不上，而对不上的第一反应是"数字是错的"。
 *
 * 现在它显示「筛选出 N 条」，N = 屏幕上真正渲染出来的卡片数。
 *
 * ── 闸门怎么判 ──
 *
 * ① 可见列跟着范围（当前/已结束/全部）与状态筛选走；
 * ② N 与"逐列渲染出来的卡片数"逐条相等 —— 测试里自己按旧写法重算一遍比对，
 *    不是把实现再抄一次；
 * ③ 两处角标（搜索行 / chips 行）吃窗口层传下来的**同一个** visibleCount，
 *    看板的渲染与计数共用 lib/board-visibility 一份判据；
 * ④ 动态形态不报卡片数（那里报的是事项数），完成率口径整条退场。
 * 每条都写了反向验证（拿掉哪一行会红）。
 */

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const todo = (over: Partial<Todo> & { id: string; status: TodoStatus }): Todo =>
  ({
    title: over.id,
    categoryIds: [],
    createdBy: 'human',
    executedBy: null,
    priority: 'normal',
    type: 'task',
    projectId: 'p1',
    fixedInVersion: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    dueAt: null,
    remindAt: null,
    ...over
  }) as unknown as Todo

const scope = (over: Partial<BoardVisibility> = {}): BoardVisibility => ({
  workspaceMode: 'project',
  workItemScope: 'current',
  filterStatus: null,
  viewScope: 'all',
  filter: {
    keyword: '',
    categoryId: null,
    owner: 'all',
    projectId: null,
    priority: 'all',
    type: 'all',
    fixedIn: undefined
  },
  dueScope: 'all',
  ...over
})

/** 一份"什么样的卡都有"的样本 */
const MIXED: Todo[] = [
  todo({ id: 'k-proposed', status: 'proposed' }),
  todo({ id: 'k-todo', status: 'todo' }),
  todo({ id: 'k-doing', status: 'in_progress' }),
  todo({ id: 'k-review', status: 'awaiting_review' }),
  todo({ id: 'k-suspended', status: 'suspended' }),
  todo({ id: 'k-done', status: 'done' }),
  todo({ id: 'k-discarded', status: 'discarded' }),
  todo({ id: 'k-other-project', status: 'todo', projectId: 'p2' }),
  todo({ id: 'k-other-agent', status: 'todo', createdBy: 'agent:alice' }),
  todo({ id: 'k-due-today', status: 'todo', dueAt: new Date().toISOString() }),
  todo({ id: 'k-bug', status: 'todo', type: 'bug' })
]

describe('角标那个数就是屏幕上的卡片数（f6f78ada）', () => {
  it('① 可见列跟着工作空间范围与状态筛选走', () => {
    expect(visibleColumns(scope())).toEqual(['proposed', 'todo', 'in_progress', 'awaiting_review'])
    expect(visibleColumns(scope({ workItemScope: 'ended' }))).toEqual(['suspended', 'done', 'discarded'])
    expect(visibleColumns(scope({ workItemScope: 'all' }))).toEqual(BOARD_COLUMNS)
    expect(visibleColumns(scope({ filterStatus: 'todo' }))).toEqual(['todo'])
    expect(visibleColumns(scope({ filterStatus: 'done' })), '当前工作里没有完成列').toEqual([])
    // 反向验证：把 visibleColumns 里的 matchesWorkspaceStatus 摘掉 → 第一条会多出 suspended/done/discarded。
  })

  it('② N 与"逐列渲染出来的卡片数"逐条相等（换几组筛选都对得上）', () => {
    /** 旧写法：按列渲染那条链自己重算一遍（不引用被测函数） */
    const render = (v: BoardVisibility): number =>
      BOARD_COLUMNS
        .filter((status) => matchesWorkspaceStatus(status, v.workspaceMode, v.workItemScope))
        .filter((status) => !v.filterStatus || status === v.filterStatus)
        .reduce(
          (n, status) =>
            n +
            MIXED.filter((t) => t.status === status)
              .filter((t) => matchesWorkspaceStatus(t.status, v.workspaceMode, v.workItemScope))
              .filter((t) => matchesViewScope(t, v.viewScope))
              .filter((t) => matchesTodoFilter(t, v.filter))
              .filter((t) => matchesDueScope(t, v.dueScope)).length,
          0
        )

    const cases: Array<[string, BoardVisibility]> = [
      ['当前工作', scope()],
      ['全部', scope({ workItemScope: 'all' })],
      ['已结束', scope({ workItemScope: 'ended' })],
      ['状态=待办', scope({ filterStatus: 'todo' })],
      ['状态=已完成', scope({ filterStatus: 'done' })],
      ['视角=某个 agent', scope({ viewScope: 'agent:alice' })],
      ['今天', scope({ dueScope: 'today' })],
      ['关键字', scope({ filter: { ...scope().filter, keyword: 'k-bug' } })],
      ['项目', scope({ filter: { ...scope().filter, projectId: 'p2' } })],
      ['全部+我的+逾期', scope({ workItemScope: 'all', viewScope: 'mine', dueScope: 'overdue' })]
    ]
    for (const [label, v] of cases) {
      expect(countVisibleCards(MIXED, v), `${label} 这一档数字与卡片对不上`).toBe(render(v))
    }
    // 反向验证：把 isCardVisible 里的 matchesDueScope 摘掉 → 「今天」那一档红。
  })

  it('② 几个具体数：当前工作 8 张、全部 11 张、已结束 3 张、完成列 0 张', () => {
    expect(countVisibleCards(MIXED, scope())).toBe(8)
    expect(countVisibleCards(MIXED, scope({ workItemScope: 'all' }))).toBe(11)
    expect(countVisibleCards(MIXED, scope({ workItemScope: 'ended' }))).toBe(3)
    // 「当前工作」+ 状态=已完成：没有这一列，所以是 0，不是"项目里所有已完成"
    expect(countVisibleCards(MIXED, scope({ filterStatus: 'done' }))).toBe(0)
    expect(countVisibleCards(MIXED, scope({ filter: { ...scope().filter, projectId: 'p2' } }))).toBe(1)
    expect(visibleCards(MIXED, scope()).map((t) => t.id)).not.toContain('k-done')
    // 反向验证：把可见列那层判断摘掉 → 第一条变成 11（把完成/挂起/废弃也数进去）。
  })

  it('③ 两处角标同一句话、同一个数（都由窗口层传下来）', () => {
    const chips = stripComments(read('src/renderer/components/kanban/ChipsBar.tsx'))
    const search = stripComments(read('src/renderer/components/kanban/SearchBar.tsx'))
    const kanban = stripComments(read('src/renderer/windows/Kanban.tsx'))

    for (const [name, src] of [
      ['ChipsBar', chips],
      ['SearchBar', search]
    ] as Array<[string, string]>) {
      expect(src.includes('筛选出 {visibleCount} 条'), `${name} 的角标不是「筛选出 N 条」`).toBe(true)
      expect(src.includes('visibleCount?: number'), `${name} 没从窗口层收 visibleCount`).toBe(true)
      expect(src.includes('完成 '), `${name} 还留着完成率口径`).toBe(false)
    }
    // 窗口层：同一个数传给两处，且只在看板形态传
    expect(kanban).toContain('<SearchBar autoFocus visibleCount={boardVisibleCount} />')
    expect(kanban).toContain('<ChipsBar visibleCount={boardVisibleCount} />')
    expect(kanban).toContain(
      "const boardVisibleCount = showItemTools && boardView === 'kanban' ? visibleCount : undefined"
    )
    // 反向验证：任一处改回自己 filter(...) 数卡片（不接 visibleCount）→ 本条红。
  })

  it('③ 看板的渲染与计数共用同一份判据（不再各写一条链）', () => {
    const board = stripComments(read('src/renderer/components/kanban/KanbanBoard.tsx'))
    expect(board).toContain('useBoardVisibility()')
    expect(board).toContain('visibleColumns(visibility, COLUMNS)')
    expect(board).toContain('visibleCards(getTodosByStatus(status), visibility, COLUMNS)')
    expect(board, '列序仍要是那份单源').toContain('COLUMNS: TodoStatus[] = BOARD_COLUMNS')
    for (const gone of [
      'matchesTodoFilter',
      'matchesViewScope',
      'matchesWorkspaceStatus',
      'matchesDueScope'
    ]) {
      expect(board.includes(gone), `KanbanBoard 又自己写了一份 ${gone}`).toBe(false)
    }
    // 反向验证：把列内 todos 换回自己那串 filter → 上面的断言红。
  })

  it('④ 动态形态不报卡片数（那里报的是事项数）', () => {
    const chips = stripComments(read('src/renderer/components/kanban/ChipsBar.tsx'))
    const search = stripComments(read('src/renderer/components/kanban/SearchBar.tsx'))
    expect(chips).toContain('visibleCount !== undefined')
    expect(search).toContain('{isTimeline && matched.length > 0 && (')
    expect(search).toContain('条事项')
    // 反向验证：把窗口层的 boardView === 'kanban' 条件摘掉 → 动态里也会显示卡片数。
  })

  it('④ 完成率口径整条退场（模块不再存在，没人再引用它）', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/renderer/lib/completion.ts'))).toBe(false)
    for (const f of [
      'src/renderer/components/kanban/ChipsBar.tsx',
      'src/renderer/components/kanban/SearchBar.tsx'
    ]) {
      expect(read(f).includes('completionStats')).toBe(false)
    }
  })
})
