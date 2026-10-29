import { describe, it, expect } from 'vitest'
import { buildReviewDiff } from '../../../src/main/lib/review-diff'

/**
 * 「本次变更」聚合的判据（1.0.73，主用户提单 `482e4b03`）
 *
 * ── 这组用例要挡住什么 ──
 *
 * 提单原文：「agent 提交待验收时，生成"本次变更"（描述追加 / 状态 / 字段）
 * 的 diff 视图，人可逐条批注后通过/驳回」。
 *
 * 要害在**边界**：这是"**这一次交付**改了什么"，不是"这条事项的全部历史"。
 * 边界划错的两种方式都不会报错：
 * - 划宽了 → 把上一轮交付、乃至几个月前别人做的事也算成"本次"，
 *   人要在一堆无关变更里找这次的三条；
 * - 划窄了 → agent 刚改的描述落选，人看到的"本次变更"是空的，
 *   于是以为它什么都没做就交付了 —— 而它是真做了。
 *
 * 本项目已经因为同一类问题栽过：`is_rejection` 当初靠毫秒差判断先后，
 * 结果真驳回被判成"自己收回"（评论 `.142` / 流转 `.143`）。
 * 所以这里对"边界不赌毫秒"有专门一条。
 */
describe('buildReviewDiff：本次变更的边界与归并（482e4b03）', () => {
  const T = (n: number): string => `2026-10-07T10:00:${String(n).padStart(2, '0')}.000Z`

  /** 一次「进入待验收」流转 */
  const arrive = (at: string) => ({
    fromStatus: 'in_progress',
    toStatus: 'awaiting_review',
    actor: 'agent:alice',
    createdAt: at,
    isRejection: null
  })

  const descEvent = (at: string, after: string, appendedFrom?: number) => ({
    type: 'todo',
    actor: 'agent:alice',
    payload: {
      action: 'description_changed',
      before: null,
      after,
      mode: 'append',
      ...(appendedFrom !== undefined ? { appendedFrom } : {})
    },
    createdAt: at
  })

  const fieldEvent = (at: string, changes: { field: string; before: string | null; after: string | null }[]) => ({
    type: 'todo',
    actor: 'agent:alice',
    payload: { action: 'fields_changed', changes },
    createdAt: at
  })

  it('从没进过待验收 → null（不渲染空框，"没交付过"≠"什么都没改"）', () => {
    expect(
      buildReviewDiff({
        events: [descEvent(T(5), 'aaa', 0)],
        transitions: [{ fromStatus: 'todo', toStatus: 'in_progress', actor: 'human', createdAt: T(1) }]
      })
    ).toBeNull()
  })

  it('边界是"最近一次进入待验收"：它之前的不算本次', () => {
    const out = buildReviewDiff({
      events: [
        descEvent(T(1), '上一轮就写好的东西', 0), // 在进入待验收之前 → 不该出现
        descEvent(T(20), '这次交付新增的说明', 0)
      ],
      transitions: [arrive(T(10))]
    })
    expect(out).not.toBeNull()
    expect(out!.length).toBe(1)
    expect(out![0].lines!.map((l) => l.text)).toEqual(['这次交付新增的说明'])
  })

  it('多次进入待验收时，取**最近一次**作为边界（被驳回后重交）', () => {
    const out = buildReviewDiff({
      events: [descEvent(T(5), '第一次交付前写的', 0), descEvent(T(30), '重交时补的', 0)],
      transitions: [
        arrive(T(10)),
        // 被驳回
        { fromStatus: 'awaiting_review', toStatus: 'in_progress', actor: 'human', createdAt: T(15), isRejection: true },
        arrive(T(25))
      ]
    })
    expect(out!.length).toBe(1)
    expect(out![0].lines!.map((l) => l.text)).toEqual(['重交时补的'])
  })

  it('边界不赌毫秒：与"进入待验收"同一时刻的审计事件不算本次（它是提交动作，不是提交内容）', () => {
    const out = buildReviewDiff({
      // 同一时刻：宁可漏一条同毫秒的描述追加，也不要把"提交动作"本身
      // 当成"提交内容"列给人看
      events: [descEvent(T(10), '与提交同毫秒追加的', 0)],
      transitions: [arrive(T(10))]
    })
    expect(out).toEqual([])
  })

  it('描述追加：用 appendedFrom 切出**新增部分**，不重放全文', () => {
    const out = buildReviewDiff({
      events: [descEvent(T(20), '原文\n\n---\n补充：新增这一行', '原文\n\n---\n补充：'.length)],
      transitions: [arrive(T(10))]
    })
    expect(out![0].kind).toBe('desc')
    expect(out![0].summary).toContain('追加了描述')
    // 只出现新增那部分，原文不重复出现
    expect(out![0].lines!.map((l) => l.text)).toEqual(['新增这一行'])
    expect(out![0].lines!.every((l) => l.type === 'add')).toBe(true)
  })

  it('描述追加：老事件没有 appendedFrom → 退回全文，并**如实说明**为什么', () => {
    const out = buildReviewDiff({
      events: [descEvent(T(20), '第一行\n第二行')], // 故意不传 appendedFrom
      transitions: [arrive(T(10))]
    })
    expect(out![0].summary).toContain('老记录没有追加起点')
    expect(out![0].summary).toContain('以下为全文')
    expect(out![0].lines!.length).toBe(2)
  })

  it('描述替换：before / after 都展示（能看出被拿掉了什么）', () => {
    const out = buildReviewDiff({
      events: [
        {
          type: 'todo',
          actor: 'agent:alice',
          payload: { action: 'description_changed', before: '旧规格', after: '新规格', mode: 'replace' },
          createdAt: T(20)
        }
      ],
      transitions: [arrive(T(10))]
    })
    const texts = out![0].lines!.map((l) => l.text)
    expect(texts).toContain('旧规格')
    expect(texts).toContain('新规格')
  })

  it('字段变更：保留结构化 before/after（渲染层要用它，不靠解析 summary）', () => {
    const out = buildReviewDiff({
      events: [fieldEvent(T(20), [{ field: 'priority', before: 'normal', after: 'high' }])],
      transitions: [arrive(T(10))]
    })
    expect(out![0].kind).toBe('field')
    expect(out![0].fields).toEqual([{ field: 'priority', before: 'normal', after: 'high' }])
  })

  it('状态变更：带上 from/to 与驳回标记', () => {
    const out = buildReviewDiff({
      events: [],
      transitions: [
        arrive(T(10)),
        {
          fromStatus: 'awaiting_review',
          toStatus: 'in_progress',
          actor: 'human',
          createdAt: T(20),
          isRejection: true
        }
      ]
    })
    expect(out!.length).toBe(1)
    expect(out![0].kind).toBe('status')
    expect(out![0].status).toEqual({ from: 'awaiting_review', to: 'in_progress', isRejection: true })
    expect(out![0].summary).toContain('驳回')
  })

  it('isRejection 为 null（老数据）不能说成驳回 —— 缺失与否定不是一回事', () => {
    const out = buildReviewDiff({
      events: [],
      transitions: [
        arrive(T(10)),
        { fromStatus: 'awaiting_review', toStatus: 'in_progress', actor: 'human', createdAt: T(20), isRejection: null }
      ]
    })
    expect(out![0].status!.isRejection).toBe(false)
    expect(out![0].summary).not.toContain('驳回')
  })

  it('三类混在一起时按时间升序，同一时刻审计在前、流转在后', () => {
    const out = buildReviewDiff({
      events: [descEvent(T(30), 'abc', 0), fieldEvent(T(20), [{ field: 'priority', before: 'a', after: 'b' }])],
      transitions: [
        arrive(T(10)),
        { fromStatus: 'awaiting_review', toStatus: 'in_progress', actor: 'human', createdAt: T(30), isRejection: true }
      ]
    })
    // T20 字段 → T30 描述 / T30 流转；同一时刻审计在前
    expect(out!.map((i) => i.kind)).toEqual(['field', 'desc', 'status'])
  })

  it('排序不依赖调用方给的顺序（换个取数实现也不该错）', () => {
    // 故意把流转倒序给进去
    const out = buildReviewDiff({
      events: [],
      transitions: [
        { fromStatus: 'awaiting_review', toStatus: 'done', actor: 'human', createdAt: T(30), isRejection: null },
        arrive(T(10))
      ]
    })
    expect(out![0].status!.to).toBe('done')
  })
})
