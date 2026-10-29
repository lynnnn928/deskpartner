import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  translateAuditEvents,
  mergeTimeline,
  type AuditEventInput
} from '../../../src/main/lib/audit-text'

/**
 * 变更时序的合并与翻译（1.0.62）
 *
 * ── 这组断言在防什么 ──
 *
 * 上一版（1.0.60）把 events 的**读侧**修好了，但只修到 CLI —— `buildTodoAudit`
 * 的消费方全在 `src/main/cli/commands.ts`，渲染层一处都没有。结果就是：
 * 留痕能力在**界面上等于不存在**，人验收不到。这是"写入侧有、读取侧为零"
 * 的第二次发作，只是这次缺的不是"有没有读"，而是"读的人够不够"。
 *
 * 所以这组断言要同时锁住两件事：
 * ① 合并逻辑正确（流转 + 审计是一条线，不是两块）；
 * ② **渲染层真的接上了这条通道**（结构性断言，见文件末尾 describe）——
 *    单测全绿但界面没接入口，正是上一版漏掉的形态。
 */

const TODO = '11112222-3333-4444-5555-666677778888'

function ev(
  type: string,
  actor: string | null,
  payload: unknown,
  createdAt: string
): AuditEventInput {
  return { type, actor, payload, createdAt }
}

const T1 = '2026-09-30T01:00:00.000Z'
const T2 = '2026-09-30T02:00:00.000Z'
const T3 = '2026-09-30T03:00:00.000Z'

describe('translateAuditEvents：把机器存的东西翻成人话', () => {
  it('改描述报出旧文与新文，且不依赖数据库（纯函数）', () => {
    const lines = translateAuditEvents(
      [
        ev(
          'todo',
          'agent:alice',
          {
            cmd: 'todo update',
            action: 'description_changed',
            id: TODO,
            before: '旧的规格正文',
            after: '新的规格正文',
            mode: 'replace'
          },
          T1
        )
      ],
      TODO
    )

    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('改描述')
    expect(lines[0].what).toContain('旧的规格正文')
    expect(lines[0].what).toContain('新的规格正文')
  })

  it('不认识的事件原样列出，不静默丢弃', () => {
    const lines = translateAuditEvents([ev('some_future_event', 'human', { x: 1 }, T1)], TODO)
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('some_future_event')
  })

  it('动作人缺失时显示「未记录」，不猜是谁', () => {
    const lines = translateAuditEvents([ev('some_future_event', null, {}, T1)], TODO)
    expect(lines[0].what).toContain('未记录')
    expect(lines[0].actor).toBe('未记录')
  })

  it('删事项带上当时的状态中文名（不是给用户看 enum）', () => {
    const lines = translateAuditEvents(
      [ev('todo_deleted', 'human', { snapshot: { id: TODO, title: '某需求', status: 'awaiting_review' } }, T1)],
      TODO
    )
    expect(lines[0].what).toContain('待验收')
    expect(lines[0].what).not.toContain('awaiting_review')
  })
})

describe('mergeTimeline：流转与留痕是一条线，不是两块', () => {
  it('两种来源按时间交错成一条时序', () => {
    const audit = translateAuditEvents(
      [
        ev(
          'todo',
          'agent:alice',
          { action: 'description_changed', id: TODO, before: '旧', after: '新', mode: 'replace' },
          T1
        ),
        ev(
          'comment_deleted',
          'human',
          { comment: { todoId: TODO, body: '我承诺改 A', authorId: 'agent:alice' } },
          T3
        )
      ],
      TODO
    )
    const transitions = [
      { fromStatus: 'todo', toStatus: 'in_progress', actor: 'agent:alice', createdAt: T2 }
    ]

    const merged = mergeTimeline(audit, transitions)

    expect(merged).toHaveLength(3)
    // 旧→新：改描述 → 推状态 → 删评论（真实因果：先改规格、再动手、后清理）
    expect(merged.map((m) => m.kind)).toEqual(['改描述', '流转', '删评论'])
  })

  it('流转也翻成人话，并且带上状态的中文名', () => {
    const merged = mergeTimeline([], [
      { fromStatus: 'awaiting_review', toStatus: 'in_progress', actor: 'human', createdAt: T1 }
    ])

    expect(merged[0].kind).toBe('流转')
    expect(merged[0].what).toContain('待验收')
    expect(merged[0].what).toContain('进行中')
    expect(merged[0].what).not.toContain('awaiting_review')
  })

  it('新建那一步（fromStatus 为 null）说「新建」，不显示 null', () => {
    const merged = mergeTimeline([], [
      { fromStatus: null, toStatus: 'todo', actor: 'human', createdAt: T1 }
    ])
    expect(merged[0].what).toContain('新建')
    expect(merged[0].what).not.toContain('null')
  })

  it('同一毫秒时不按时间戳乱序：审计在前、流转在后（稳定序）', () => {
    // 真实场景：点「完成」会同时写状态流转与取消提醒，两者时间戳可能完全相同。
    // 同毫秒必须落在一个**确定**的顺序上，不能随 sort 实现漂——
    // 约定的顺序是「审计在前、流转在后」（真实因果常是"先改了内容、再推状态"）。
    const audit = translateAuditEvents([ev('memo', 'human', {}, T1)], TODO)
    const transitions = [
      { fromStatus: 'in_progress', toStatus: 'done', actor: 'human', createdAt: T1 }
    ]

    const merged = mergeTimeline(audit, transitions)
    expect(merged.map((m) => m.kind)).toEqual(['memo', '流转'])
    expect(merged.map((m) => m.timelineSeq)).toEqual([0, 1])
  })

  it('审计线本身是「新→旧」时也要翻成正序（真实数据形态）', () => {
    // `listForTodo` 给的是 ORDER BY id DESC —— 最近发生了什么在前。
    // 若合并时直接沿用下标，同一毫秒的两条审计会保持"新的在前"，方向反了。
    const audit = translateAuditEvents(
      [
        ev('todo', 'human', { action: 'description_changed', id: TODO, before: 'B', after: 'C', mode: 'replace' }, T2),
        ev('todo', 'human', { action: 'description_changed', id: TODO, before: 'A', after: 'B', mode: 'replace' }, T2)
      ],
      TODO
    )

    const merged = mergeTimeline(audit, [])
    // T2 那一对同毫秒，必须翻回"先 A→B 再 B→C"。用旧文区分（两条的新文会重叠）
    expect(merged[0].what).toContain('旧文「A」')
    expect(merged[1].what).toContain('旧文「B」')
  })

  it('timelineSeq 是连续序号，展示层照它排即可', () => {
    const audit = translateAuditEvents([ev('a1', 'human', {}, T1)], TODO)
    const transitions = [{ fromStatus: null, toStatus: 'todo', actor: 'human', createdAt: T2 }]

    const merged = mergeTimeline(audit, transitions)
    expect(merged.map((m) => m.timelineSeq)).toEqual([0, 1])
  })

  it('单步流转也合并进来（过滤与否是展示层的取舍，翻译层不做减法）', () => {
    const merged = mergeTimeline([], [
      { fromStatus: null, toStatus: 'todo', actor: 'human', createdAt: T1 }
    ])
    expect(merged).toHaveLength(1)
  })

  it('空输入返回空，不抛错', () => {
    expect(mergeTimeline([], [])).toEqual([])
  })
})

/**
 * 结构性闸门：界面真的接上了这条通道
 *
 * 这是本文件的重点。上一版的教训是"单测全绿、CLI 全通，但界面没接入口"——
 * 那种缺陷**任何叶子函数测试都抓不到**，只能靠读源码断言"关系"。
 *
 * 反向验证：把 QuickAddForm 里的 `invoke('todo:timeline', ...)` 改回
 * `invoke('todo:listTransitions', ...)`，最后一条断言应当变红。
 */
describe('闸门：渲染层不能只剩流转、丢掉落痕', () => {
  const root = resolve(__dirname, '../../..')
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

  /**
   * 剥掉注释再断言（2026-10-07 修）
   *
   * 原闸门直接扫整份源码，于是**注释里提到那个词**也会被判违规。
   * 实测踩中：给 QuickAddForm 写「本次变更」的说明注释时，
   * 顺手写了「下面那块答『这条事项一路怎么走过来的』」——
   * 闸门立刻变红，而代码一行没动。这类**假红**比漏判更坏：
   * 它逼下一个人去改注释措辞（把话说得含糊）来哄闸门，
   * 而闸门要防的"翻译搬回渲染层"这件事本身，一点没变。
   *
   * 与 `review-diff-wiring.test.ts` 的 `stripComments()` 同一个判据：
   * **凡扫描源码的闸门，一律先剥注释**——否则它守的是文字，不是行为。
   */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSX {/* */}）
      .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 http:// 那种）

  /** 读源码并剥注释 —— 结构性断言一律用它，别直接用 read() */
  const readCode = (rel: string): string => stripComments(read(rel))

  it('详情抽屉调用的是合并时序通道，不是只有流转的那条', () => {
    const src = readCode('src/renderer/components/quick-add/QuickAddForm.tsx')
    expect(src).toContain("invoke('todo:timeline'")
  })

  it('渲染层不再自己拼「从哪来到哪去」的句子（翻译只有一份，在主进程）', () => {
    const src = readCode('src/renderer/components/quick-add/QuickAddForm.tsx')
    // 断言的是**意图**（拿 what 渲染），不是某一个字面量 ——
    // 早先写死 `{t.what}`，后来渲染层为了换掉 `human` 改成
    // `humanizeActor(t.what, ...)`，闸门就假红了。闸门该拦的是"翻译搬回渲染层"。
    expect(src).toMatch(/humanizeActor\(t\.what|t\.what/)
    expect(src).not.toContain('怎么走过来的')
    // 反向：若有人把翻译搬回渲染层，必然要在组件里出现状态标签拼装
    expect(src).not.toMatch(/STATUS_META\[t\.fromStatus/)
  })

  it('主进程有对应的读 handler（typeof 只写不读同样等于没做）', () => {
    const src = readCode('src/main/ipc.ts')
    expect(src).toContain("ipcMain.handle('todo:timeline'")
    expect(src).toContain('mergeTimeline(')
  })

  it('IPC 契约里登记了这条通道', () => {
    const src = readCode('src/renderer/types/ipc.ts')
    expect(src).toContain("'todo:timeline'")
  })

  it('两侧的 TimelineEntry 字段集合一致（各声明各的，用断言锁不漂移）', () => {
    const mainSrc = read('src/main/lib/audit-text.ts')
    const rendererSrc = read('src/renderer/types/todo.ts')

    // 从 interface 声明里抓字段名；`extends` 的另一半递归并进来 ——
    // 主进程那边是 `TimelineEntry extends TodoAuditLine`，只看自己的花括号会漏掉
    // at/actor/kind/what 四个字段，断言会变成假绿
    const fieldsOf = (src: string, name: string): string[] => {
      const m = src.match(new RegExp(`interface ${name}(?:\\s+extends\\s+(\\w+))?\\s*\\{([\\s\\S]*?)\\n\\}`))
      if (!m) throw new Error(`没找到 interface ${name}`)
      const own = [...m[2].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1])
      return (m[1] ? [...own, ...fieldsOf(src, m[1])] : own).sort()
    }

    expect(fieldsOf(rendererSrc, 'TimelineEntry')).toEqual(fieldsOf(mainSrc, 'TimelineEntry'))
  })
})
