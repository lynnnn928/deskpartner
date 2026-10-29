import { describe, it, expect } from 'vitest'
import { assignableExecutors } from '../../../src/renderer/lib/assignable-executors'
import type { Agent } from '../../../src/renderer/types/todo'

/**
 * 执行者候选口径（61172cf3：执行体下拉）
 *
 * 判错的形态不是报错，而是两种安静的错：
 * ① 未批准的 agent 出现在可选项里 —— 下拉绕过了"批准只能由人点"；
 * ② 事项已指派给一个未批准的 agent，"执行者"一栏却没有任何高亮 —— 看起来像没指派。
 */
const agent = (id: string, approved: boolean): Agent => ({ id, approved }) as Agent

describe('assignableExecutors', () => {
  it('只有已批准的 agent 可被新选中，且保持原顺序', () => {
    const out = assignableExecutors(
      [agent('agent:a', true), agent('agent:b', false), agent('agent:c', true)],
      null
    )
    expect(out).toEqual([
      { id: 'agent:a', selectable: true },
      { id: 'agent:c', selectable: true }
    ])
  })

  it('当前执行者未获批准：仍显示，但不可再选', () => {
    const out = assignableExecutors([agent('agent:a', true), agent('agent:b', false)], 'agent:b')
    expect(out).toEqual([
      { id: 'agent:a', selectable: true },
      { id: 'agent:b', selectable: false }
    ])
  })

  it('当前执行者已不在名单里（已撤销或已删除）：同样保持可见', () => {
    const out = assignableExecutors([agent('agent:a', true)], 'agent:gone')
    expect(out).toEqual([
      { id: 'agent:a', selectable: true },
      { id: 'agent:gone', selectable: false }
    ])
  })

  it('当前执行者已批准：不重复追加', () => {
    const out = assignableExecutors([agent('agent:a', true)], 'agent:a')
    expect(out).toEqual([{ id: 'agent:a', selectable: true }])
  })

  it('当前执行者是 human 或空：不追加（human 有固定按钮）', () => {
    expect(assignableExecutors([agent('agent:a', true)], 'human')).toEqual([
      { id: 'agent:a', selectable: true }
    ])
    expect(assignableExecutors([agent('agent:a', true)], undefined)).toEqual([
      { id: 'agent:a', selectable: true }
    ])
  })

  it('名单为空：没有可选项，也不凭空造出来', () => {
    expect(assignableExecutors([], null)).toEqual([])
  })
})
