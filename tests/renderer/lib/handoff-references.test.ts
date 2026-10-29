import { describe, expect, it } from 'vitest'
import { extractHandoffTodoReferences, resolveHandoffTodoReferences } from '../../../src/renderer/lib/handoff-references'

const items = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', title: '事项 A', status: 'in_progress' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', title: '事项 B', status: 'done' },
  { id: 'aaaaaaaa-3333-4333-8333-333333333333', title: '事项 A2', status: 'todo' }
]

describe('项目接手说明中的事项引用', () => {
  it('只提取显式 #短号和 #完整 UUID，并去重', () => {
    expect(extractHandoffTodoReferences('看 #aaaaaaaa，详情 #bbbbbbbb-2222-4222-8222-222222222222；数字 20261017 和裸串 aaaaaaaa 不算。#AAAAAAAA'))
      .toEqual(['aaaaaaaa', 'bbbbbbbb-2222-4222-8222-222222222222'])
    expect(extractHandoffTodoReferences('#aaaaaaaaX 不是完整短号')).toEqual([])
  })

  it('唯一命中时返回实时事项，短号歧义时不猜', () => {
    expect(resolveHandoffTodoReferences('#bbbbbbbb', items)).toEqual([
      { reference: 'bbbbbbbb', item: items[1], ambiguous: false }
    ])
    expect(resolveHandoffTodoReferences('#aaaaaaaa', items)).toEqual([
      { reference: 'aaaaaaaa', item: null, ambiguous: true }
    ])
  })

  it('完整 UUID 精确命中，未找到时明确返回未解析', () => {
    expect(resolveHandoffTodoReferences('#aaaaaaaa-1111-4111-8111-111111111111 #cccccccc', items)).toEqual([
      { reference: 'aaaaaaaa-1111-4111-8111-111111111111', item: items[0], ambiguous: false },
      { reference: 'cccccccc', item: null, ambiguous: false }
    ])
  })
})
