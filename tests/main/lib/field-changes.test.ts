import { describe, it, expect } from 'vitest'
import { diffFields, describeFields, FIELD_LABELS, TRACKED_FIELDS_EXPORT } from '../../../src/main/lib/field-changes'

/**
 * 字段变更的留痕判据（1.0.73，主用户提单 `482e4b03`）
 *
 * ── 这组用例要挡住什么 ──
 *
 * 提单要在验收时看到「本次变更 diff」，明说三类：描述追加 / 状态 / 字段。
 * 摸底发现**字段这一路全仓零留痕**：`todo update --priority high` 改完，
 * 库里只有一个 `updated_at` 变了，再没有地方能回答"优先级从哪变成了哪"。
 *
 * 所以本文件测的不是"渲染好不好看"（那个渲染层测），而是
 * **"这次写入到底动了哪几个字段"这个判断本身对不对** ——
 * 判错了不会报错，只会让时间线上安静地少一条 / 多一条，
 * 而验收的人正是靠它决定"要不要放行"。
 */
describe('diffFields：这次到底动了哪些字段（482e4b03）', () => {
  const base = {
    title: '原题',
    priority: 'normal',
    type: 'task',
    projectId: 'p1',
    parentId: null,
    createdBy: 'human',
    executedBy: null,
    verifier: 'human',
    dueAt: null,
    remindAt: null,
    fixedInVersion: null,
    isPinned: false
  }

  it('没有任何字段变化时返回空 —— 不能凭空造出一条"变更"', () => {
    expect(diffFields(base, { ...base })).toEqual([])
  })

  it('识别单个字段的变化，并带上前后值', () => {
    const out = diffFields(base, { ...base, priority: 'high' })
    expect(out).toEqual([{ field: 'priority', before: 'normal', after: 'high' }])
  })

  it('判据是"前后对象比较"，不是"input 带了哪些键"', () => {
    // 调用方传了 priority: 'normal'，而它本来就是 normal —— 这是一次
    // 没有变化的写入。按 input 的键算会记成"normal → normal"，
    // 时间线上多一条什么都没发生的记录，比没有记录更误导。
    const out = diffFields(base, { ...base, priority: 'normal' })
    expect(out).toEqual([])
  })

  it('布尔从 false 变 true 要记（置顶是真变化，不能因为 falsy 当没事发生）', () => {
    const out = diffFields(base, { ...base, isPinned: true })
    expect(out).toEqual([{ field: 'isPinned', before: 'false', after: 'true' }])
  })

  it('清空一个字段（有值 → null）要记，且 after 为 null 而不是空串', () => {
    const out = diffFields({ ...base, dueAt: '2026-10-10T00:00:00.000Z' }, { ...base, dueAt: null })
    expect(out).toEqual([{ field: 'dueAt', before: '2026-10-10T00:00:00.000Z', after: null }])
  })

  it('空串与 null 是同一态（父需求从无到无不该被判成变了）', () => {
    // executedBy 的三态在 repo 里会被归一：undefined/空串 → null。
    // 若不归一化，"回到提出者执行"（null）会与"未提及"（''）判成变化，
    // 而它们最终落库的结果一模一样。
    const out = diffFields({ ...base, parentId: '' }, { ...base, parentId: null })
    expect(out).toEqual([])
  })

  it('一次改多个字段，全部列出（验收时要逐条看的就是这个）', () => {
    const out = diffFields(base, { ...base, priority: 'urgent', type: 'bug', title: '新题' })
    expect(out.map((c) => c.field).sort()).toEqual(['priority', 'title', 'type'])
  })

  it('状态与描述**刻意不在**追踪清单里（它们各有专门的记录路径）', () => {
    // 状态有 todo_transitions（还带 actor / isRejection，events 里这份必然残缺），
    // 描述有 description_changed（带 append/replace 与完整正文）。
    // 这里再记一遍就是两份真相，而且是残缺的那份。
    const out = diffFields(
      { ...base, status: 'todo', description: '旧' },
      { ...base, status: 'done', description: '新' }
    )
    expect(out).toEqual([])
  })

  it('updatedAt 的变化不算字段变更（它是每次写入的副产物）', () => {
    const out = diffFields({ ...base, updatedAt: 't1' }, { ...base, updatedAt: 't2' })
    expect(out).toEqual([])
  })

  it('追踪清单非空且与 FIELD_LABELS 一一对应（标签漏了会渲染成裸字段名）', () => {
    expect(TRACKED_FIELDS_EXPORT.length).toBeGreaterThan(0)
    for (const f of TRACKED_FIELDS_EXPORT) {
      expect(FIELD_LABELS[f], `字段 ${f} 没有中文标签`).toBeTruthy()
    }
  })
})

describe('describeFields：字段变化要说得成人话', () => {
  it('枚举值翻成中文（优先级 / 类型）', () => {
    expect(
      describeFields([
        { field: 'priority', before: 'normal', after: 'high' },
        { field: 'type', before: 'task', after: 'bug' }
      ])
    ).toEqual(['优先级：普通 → 高', '类型：普通事项 → Bug'])
  })

  it('置顶用动词说法，不是 true / false', () => {
    expect(describeFields([{ field: 'isPinned', before: 'false', after: 'true' }])).toEqual([
      '置顶：取消置顶 → 置顶'
    ])
  })

  it('清空显示「（空）」而不是 null 字面量', () => {
    expect(describeFields([{ field: 'dueAt', before: '2026-10-10', after: null }])).toEqual([
      '截止时间：2026-10-10 → （空）'
    ])
  })

  it('认不出的字段原样显示，不静默吞掉（漏了比丑更糟）', () => {
    expect(describeFields([{ field: 'unknownField', before: 'a', after: 'b' }])).toEqual([
      'unknownField：a → b'
    ])
  })
})
