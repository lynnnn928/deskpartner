import { describe, it, expect } from 'vitest'
import {
  matchesTodoFilter,
  matchesWorkspaceStatus,
  collectFixedVersions,
  UNSET_FIXED,
  ANY_FIXED,
  type TodoFilter
} from '../../../src/renderer/lib/todo-filter'
import type { Todo } from '../../../src/renderer/types/todo'

/**
 * 「解决于版本」筛选（v24，主用户 2026-09-29）
 *
 * 她提的两个问题 ——「当前版本准备处理哪些」/「发布后具体解决了哪些」——
 * 都由这一个筛选项回答。锁住它，等于锁住"版本与事项的映射"这条链。
 *
 * 用 Pick<真实类型> 而不是造一个假对象：字段改名时这里会编译报错，
 * 而造假的字面量只会静默漂移。
 */
function todo(fixedInVersion: string | null): Pick<Todo, 'fixedInVersion'> {
  return { fixedInVersion }
}

/**
 * 这些用例只关心 fixedIn，其余字段给个"不挡路"的最小值。
 * 用 as unknown as Todo 是刻意的：一旦 matchesTodoFilter 开始依赖别的新字段，
 * 这个哨兵会立刻以 undefined 比较的形式暴露出来，而不是假装通过。
 */
function full(fixedInVersion: string | null): Todo {
  return {
    id: 'abcdefgh',
    title: 'x',
    fixedInVersion,
    description: null,
    projectId: null,
    parentId: null,
    categoryIds: [],
    categoryId: '',
    status: 'todo',
    priority: 'normal',
    type: 'task',
    createdBy: 'human',
    executedBy: null,
    dueAt: null,
    remindAt: null,
    isPinned: false,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    completedAt: null
  }
}

const base: TodoFilter = { keyword: '', categoryId: null, owner: 'all' }

describe('matchesWorkspaceStatus —— 工作空间集合', () => {
  it('current 只包含四类当前工作', () => {
    const current = ['proposed', 'todo', 'in_progress', 'awaiting_review']
    for (const status of current) expect(matchesWorkspaceStatus(status as any, 'project', 'current')).toBe(true)
    for (const status of ['suspended', 'done', 'discarded']) {
      expect(matchesWorkspaceStatus(status as any, 'project', 'current')).toBe(false)
    }
  })

  it('已结束集合与全量入口只打开对应范围', () => {
    for (const status of ['done', 'suspended', 'discarded']) {
      expect(matchesWorkspaceStatus(status as any, 'project', 'ended')).toBe(true)
    }
    expect(matchesWorkspaceStatus('todo', 'project', 'ended')).toBe(false)
    expect(matchesWorkspaceStatus('done', 'all', 'current')).toBe(true)
  })
})

describe('matchesTodoFilter —— 按版本筛选（v24）', () => {
  it('不传 fixedIn = 不限（三种数据都留着）', () => {
    expect(matchesTodoFilter(full('1.0.58'), base)).toBe(true)
    expect(matchesTodoFilter(full(null), base)).toBe(true)
  })

  it('具体版本号：只命中该版本', () => {
    const f = { ...base, fixedIn: '1.0.59' }
    expect(matchesTodoFilter(full('1.0.59'), f)).toBe(true)
    // 关键：**不**因为"1.0.58 也是版本"就命中 —— 否则筛选毫无意义
    expect(matchesTodoFilter(full('1.0.58'), f)).toBe(false)
    expect(matchesTodoFilter(full(null), f)).toBe(false)
  })

  it('unset：只命中未标注的（发版前核对"修完了却没标版本"靠它）', () => {
    const f = { ...base, fixedIn: UNSET_FIXED }
    expect(matchesTodoFilter(full(null), f)).toBe(true)
    expect(matchesTodoFilter(full('1.0.59'), f)).toBe(false)
  })

  it('any：只命中已标注的', () => {
    const f = { ...base, fixedIn: ANY_FIXED }
    expect(matchesTodoFilter(full('1.0.59'), f)).toBe(true)
    expect(matchesTodoFilter(full(null), f)).toBe(false)
  })

  it('筛选的版本号不是库里存在的版本时，回空而不是全部', () => {
    // 版本号不是库里的实体（没有版本表），传一个没发过的版本号应返回空列表。
    // 回归点：如果实现写成"命中不了就跳过这个条件"，就会静默返回全部 ——
    // 那时筛一个不存在的版本会看到满屏卡片，比报错更误导。
    expect(matchesTodoFilter(full('1.0.59'), { ...base, fixedIn: '9.9.9' })).toBe(false)
  })
})

describe('collectFixedVersions（版本选项从数据里提取）', () => {
  it('去重且跳过未标注', () => {
    const got = collectFixedVersions([
      todo('1.0.59'),
      todo('1.0.59'),
      todo('1.0.58'),
      todo(null)
    ])
    expect(got).toEqual(['1.0.59', '1.0.58'])
  })

  it('按点分段数值降序，不是字典序', () => {
    // 字典序会把 1.0.10 排在 1.0.9 前面 —— 人一眼就看出不对。
    // 这条用例就是为这个 bug 存在的。
    const got = collectFixedVersions([todo('1.0.9'), todo('1.0.10'), todo('1.0.59')])
    expect(got).toEqual(['1.0.59', '1.0.10', '1.0.9'])
  })

  it('非标准格式不丢，排在标准版本之后', () => {
    const got = collectFixedVersions([todo('1.1-beta'), todo('1.0.59')])
    expect(got).toContain('1.1-beta')
    expect(got[got.length - 1]).toBe('1.1-beta')
  })

  it('没有已标注的版本时回空数组（下拉只显示两个哨兵项）', () => {
    expect(collectFixedVersions([todo(null)])).toEqual([])
  })
})
