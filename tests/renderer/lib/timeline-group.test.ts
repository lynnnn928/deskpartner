import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'
import { buildTimeline } from '../../../src/renderer/lib/timeline-group'
import type { Todo, TodoTransition } from '../../../src/renderer/types/todo'
import type { TodoStatus } from '../../../src/renderer/types/enums'

/**
 * 造一条事项
 *
 * 时间一律用**不带 Z 的本地时间**：带 Z 会被 dayjs 当 UTC 解析，
 * 在 UTC+8 下晚上的记录会被算到第二天，测试结果随机器时区漂。
 */
function make(
  id: string,
  opts: {
    createdAt?: string
    completedAt?: string | null
    status?: TodoStatus
    createdBy?: Todo['createdBy']
    executedBy?: Todo['executedBy']
  } = {}
): Todo {
  const created = opts.createdAt ?? '2026-09-01T10:00:00'
  return {
    id,
    title: id,
    description: null,
    projectId: null,
    parentId: null,
    categoryIds: [],
    categoryId: '',
    status: opts.status ?? 'todo',
    priority: 'normal',
    type: 'task',
    createdBy: opts.createdBy ?? 'human',
    executedBy: opts.executedBy ?? null,
    dueAt: null,
    remindAt: null,
    isPinned: false,
    createdAt: created,
    updatedAt: created,
    completedAt: opts.completedAt ?? null
  }
}

/** 铺平成便于断言的形状：'id:kind' */
const flat = (groups: { items: { todo: Todo; kind: string }[] }[]) =>
  groups.flatMap((g) => g.items.map((e) => `${e.todo.id}:${e.kind}`))

describe('buildTimeline', () => {
  it('每个事项都有一个「新建」节点', () => {
    const groups = buildTimeline([make('a'), make('b')])
    expect(flat(groups).sort()).toEqual(['a:created', 'b:created'])
  })

  it('已完成的事项额外多一个「完成」节点', () => {
    const groups = buildTimeline([
      make('a', { status: 'done', completedAt: '2026-09-10T18:00:00' })
    ])
    expect(flat(groups).sort()).toEqual(['a:completed', 'a:created'])
  })

  it('未完成的事项只有「新建」，不臆造完成节点', () => {
    const groups = buildTimeline([make('a', { status: 'in_progress' })])
    expect(flat(groups)).toEqual(['a:created'])
  })

  it('提议创建的事项节点记为「提议了」', () => {
    const groups = buildTimeline([make('a', { status: 'proposed' })])
    expect(flat(groups)).toEqual(['a:proposed_created'])
  })

  /**
   * v12 起验收口径 = 执行者不是提出者（跨主体交付）：
   * agent 提出的事由别人（或替别人）做完，标「验收通过」；
   * 提出即执行（含 agent 自己提自己做的流水）勾掉就是普通「完成」。
   */
  it('执行者≠提出者的事项完成时记「验收通过」，提出即执行的记「完成了」', () => {
    const agentReportedHumanFixed = make('bug-fix', {
      status: 'done',
      completedAt: '2026-09-10T18:00:00',
      createdBy: 'agent:alice',
      executedBy: 'human'
    })
    const agentSelfDone = make('agent-job', {
      status: 'done',
      completedAt: '2026-09-10T18:30:00',
      createdBy: 'agent:alice'
    })
    const humanDone = make('human-job', { status: 'done', completedAt: '2026-09-10T19:00:00' })

    const groups = buildTimeline([agentReportedHumanFixed, agentSelfDone, humanDone])
    expect(flat(groups).sort()).toEqual(
      [
        'bug-fix:created',
        'bug-fix:review_completed',
        'agent-job:created',
        'agent-job:completed',
        'human-job:completed',
        'human-job:created'
      ].sort()
    )
  })

  /**
   * 这条锁的是"不凭 updatedAt 造完成时间"。
   * 造一个假时间会让时间线出现"三个月前做完、今天才完成"这种自相矛盾。
   */
  it('status=done 但缺 completedAt 时，宁可不显示完成节点', () => {
    const groups = buildTimeline([make('a', { status: 'done', completedAt: null })])
    expect(flat(groups)).toEqual(['a:created'])
  })

  it('按发生时间倒序：最近的节点排最前', () => {
    const groups = buildTimeline([
      make('早', { createdAt: '2026-09-10T09:00:00' }),
      make('晚', { createdAt: '2026-09-10T18:00:00' })
    ])
    expect(flat(groups)).toEqual(['晚:created', '早:created'])
  })

  it('跨天分成多组，最近的组在最前', () => {
    const groups = buildTimeline([
      make('前天', { createdAt: '2026-09-15T10:00:00' }),
      make('今天', { createdAt: '2026-09-17T10:00:00' }),
      make('昨天', { createdAt: '2026-09-16T10:00:00' })
    ])
    expect(groups.map((g) => g.key)).toEqual(['2026-09-17', '2026-09-16', '2026-09-15'])
  })

  it('同一条事项的创建与完成可以落在不同天，各归各组', () => {
    const groups = buildTimeline([
      make('跨天', { createdAt: '2026-09-15T10:00:00', status: 'done', completedAt: '2026-09-17T16:00:00' })
    ])
    expect(groups.map((g) => g.key)).toEqual(['2026-09-17', '2026-09-15'])
    expect(flat(groups)).toEqual(['跨天:completed', '跨天:created'])
  })

  it('空输入返回空数组', () => {
    expect(buildTimeline([])).toEqual([])
  })
})

describe('时间范围', () => {
  // 用相对今天的日期构造，避免写死日期后随时间失效
  const at = (offsetDays: number, hour = 10) =>
    dayjs().startOf('day').add(offsetDays, 'day').add(hour, 'hour').format('YYYY-MM-DDTHH:mm:ss')

  it('all 不做任何过滤', () => {
    const groups = buildTimeline(
      [make('今天', { createdAt: at(0) }), make('半年前', { createdAt: at(-180) })],
      [],
      { key: 'all' }
    )
    expect(flat(groups)).toHaveLength(2)
  })

  it('today 只留今天的节点', () => {
    const groups = buildTimeline(
      [make('今天', { createdAt: at(0) }), make('昨天', { createdAt: at(-1) })],
      [],
      { key: 'today' }
    )
    expect(flat(groups)).toEqual(['今天:created'])
  })

  /**
   * 这条锁边界：下界那天的记录必须算进来。
   * 用 isAfter 判定会把第 7 天 00:00 之后的记录漏掉一部分，
   * 表现是"近 7 天"里数量对不上，很难发现。
   */
  it('7d 含今天与前 6 天，且边界那天整天都算', () => {
    const groups = buildTimeline(
      [
        make('今天', { createdAt: at(0) }),
        make('第6天', { createdAt: at(-6) }),
        make('第7天', { createdAt: at(-7) }),
        make('第8天', { createdAt: at(-8) })
      ],
      [],
      { key: '7d' }
    )
    expect(flat(groups).sort()).toEqual(['今天:created', '第6天:created'])
  })

  it('30d 含今天与前 29 天', () => {
    const groups = buildTimeline(
      [
        make('第29天', { createdAt: at(-29) }),
        make('第30天', { createdAt: at(-30) })
      ],
      [],
      { key: '30d' }
    )
    expect(flat(groups)).toEqual(['第29天:created'])
  })

  it('custom 按 from / to 两头夹', () => {
    const groups = buildTimeline(
      [
        make('范围外早', { createdAt: at(-10) }),
        make('范围内', { createdAt: at(-5) }),
        make('范围外晚', { createdAt: at(-1) })
      ],
      [],
      { key: 'custom', from: at(-6).slice(0, 10), to: at(-3).slice(0, 10) }
    )
    expect(flat(groups)).toEqual(['范围内:created'])
  })

  it('custom 只填一端也算数', () => {
    const onlyFrom = buildTimeline(
      [make('早', { createdAt: at(-10) }), make('近', { createdAt: at(-2) })],
      [],
      { key: 'custom', from: at(-5).slice(0, 10) }
    )
    expect(flat(onlyFrom)).toEqual(['近:created'])

    const onlyTo = buildTimeline(
      [make('早', { createdAt: at(-10) }), make('近', { createdAt: at(-2) })],
      [],
      { key: 'custom', to: at(-5).slice(0, 10) }
    )
    expect(flat(onlyTo)).toEqual(['早:created'])
  })

  it('范围过滤作用在节点时间上：同一事项的创建与完成可以只留下一个', () => {
    const groups = buildTimeline(
      [
        make('跨范围', {
          createdAt: at(-40),
          status: 'done',
          completedAt: at(0)
        })
      ],
      [],
      { key: '7d' }
    )
    // 创建在 40 天前被滤掉，完成在范围内留下
    expect(flat(groups)).toEqual(['跨范围:completed'])
  })
})

/** 造一条流转记录 */
function tr(
  todoId: string,
  from: TodoStatus | null,
  to: TodoStatus,
  createdAt: string,
  actor: string | null = 'human'
): TodoTransition {
  return { id: `${todoId}-${from}-${to}-${createdAt}`, todoId, fromStatus: from, toStatus: to, actor, createdAt }
}

describe('中间流转节点（v14）', () => {
  it('中间流转出现在动态里，kind=transitioned', () => {
    const groups = buildTimeline(
      [make('a', { status: 'in_progress' })],
      [tr('a', 'todo', 'in_progress', '2026-09-10T14:00:00', 'agent:alice')]
    )
    expect(flat(groups)).toEqual(['a:transitioned', 'a:created'])
  })

  /** 头（新建）与尾（done）已有专属节点，两边都显示同一件事就出现两遍 */
  it('from=null 的新建流转不重复显示', () => {
    const groups = buildTimeline(
      [make('a')],
      [tr('a', null, 'todo', '2026-09-10T14:00:00')]
    )
    expect(flat(groups)).toEqual(['a:created'])
  })

  it('转入 done 的流转不重复显示（完成节点已覆盖）', () => {
    const groups = buildTimeline(
      [make('a', { status: 'done', completedAt: '2026-09-10T18:00:00' })],
      [tr('a', 'awaiting_review', 'done', '2026-09-10T18:00:00')]
    )
    expect(flat(groups).sort()).toEqual(['a:completed', 'a:created'])
  })

  it('被筛掉或已删除的事项，其流转一并跳过（不出孤儿节点）', () => {
    const groups = buildTimeline(
      [make('a')],
      [
        tr('a', 'todo', 'in_progress', '2026-09-10T14:00:00'),
        tr('ghost', 'todo', 'in_progress', '2026-09-10T15:00:00')
      ]
    )
    expect(flat(groups)).toEqual(['a:transitioned', 'a:created'])
  })

  it('同一条事项的多次流转各自成节点', () => {
    const groups = buildTimeline(
      [make('a', { status: 'awaiting_review' })],
      [
        tr('a', 'todo', 'in_progress', '2026-09-10T14:00:00'),
        tr('a', 'in_progress', 'awaiting_review', '2026-09-10T16:00:00')
      ]
    )
    expect(flat(groups)).toEqual(['a:transitioned', 'a:transitioned', 'a:created'])
  })

  it('时间范围过滤同样作用在流转节点上', () => {
    const at = (offsetDays: number, hour = 10) =>
      dayjs().startOf('day').add(offsetDays, 'day').add(hour, 'hour').format('YYYY-MM-DDTHH:mm:ss')
    const groups = buildTimeline(
      [make('今天', { createdAt: at(0) }), make('上周', { createdAt: at(-9) })],
      [
        // 流转发生在当天 18 点，比创建（10 点）晚，倒序时应排最前
        tr('今天', 'todo', 'in_progress', at(0, 18)),
        tr('上周', 'todo', 'in_progress', at(-9))
      ],
      { key: '7d' }
    )
    expect(flat(groups)).toEqual(['今天:transitioned', '今天:created'])
  })

  it('按流转时间参与全局倒序', () => {
    const groups = buildTimeline(
      [make('a', { createdAt: '2026-09-10T09:00:00', status: 'in_progress' })],
      [tr('a', 'todo', 'in_progress', '2026-09-10T18:00:00')]
    )
    // 流转（18 点）比新建（9 点）晚，排最前
    expect(flat(groups)).toEqual(['a:transitioned', 'a:created'])
  })
})

/** 铺平成 'id:kind:actor'，主语断言用 */
const flatActor = (groups: { items: { todo: Todo; kind: string; actor: string | null }[] }[]) =>
  groups.flatMap((g) => g.items.map((e) => `${e.todo.id}:${e.kind}:${e.actor ?? 'null'}`))

describe('节点主语（v14：优先流转记录的 actor）', () => {
  /**
   * 31 版实测踩中的歪处：agent 交付的事项由人在界面上点验收（流转 actor=human），
   * 动态却显示"Alice 验收通过了" —— 主语按执行者猜，真正的验收人反而看不见。
   */
  it('完成节点主语 = 转 done 流转的 actor（人验收 agent 交付 → 我）', () => {
    const groups = buildTimeline(
      [
        make('a', {
          status: 'done',
          completedAt: '2026-09-20T09:23:15',
          createdBy: 'human',
          executedBy: 'agent:alice'
        })
      ],
      [tr('a', 'awaiting_review', 'done', '2026-09-20T09:23:15', 'human')]
    )
    expect(flatActor(groups)).toEqual(['a:review_completed:human', 'a:created:human'])
  })

  it('agent 自己置 done → 主语是 agent', () => {
    const groups = buildTimeline(
      [
        make('a', {
          status: 'done',
          completedAt: '2026-09-20T09:00:00',
          createdBy: 'agent:alice'
        })
      ],
      [tr('a', 'in_progress', 'done', '2026-09-20T09:00:00', 'agent:alice')]
    )
    expect(flatActor(groups)).toEqual(['a:completed:agent:alice', 'a:created:agent:alice'])
  })

  it('旧数据没有流转记录 → 回落 执行者??提出者', () => {
    const groups = buildTimeline([
      make('a', {
        status: 'done',
        completedAt: '2026-09-10T18:00:00',
        createdBy: 'human',
        executedBy: 'agent:alice'
      })
    ])
    expect(flatActor(groups)).toEqual(['a:review_completed:agent:alice', 'a:created:human'])
  })

  it('转 done 的流转存在但 actor 为空 → 同样回落执行者??提出者', () => {
    const groups = buildTimeline(
      [
        make('a', {
          status: 'done',
          completedAt: '2026-09-10T18:00:00',
          createdBy: 'human',
          executedBy: 'agent:alice'
        })
      ],
      [tr('a', 'awaiting_review', 'done', '2026-09-10T18:00:00', null)]
    )
    expect(flatActor(groups)).toEqual(['a:review_completed:agent:alice', 'a:created:human'])
  })

  it('重开再完成：主语取最后一次转 done 的 actor', () => {
    const groups = buildTimeline(
      [
        make('a', {
          status: 'done',
          completedAt: '2026-09-20T18:00:00',
          createdBy: 'human'
        })
      ],
      [
        tr('a', 'todo', 'done', '2026-09-10T10:00:00', 'agent:alice'),
        tr('a', 'done', 'todo', '2026-09-15T10:00:00', 'human'),
        tr('a', 'todo', 'done', '2026-09-20T18:00:00', 'human')
      ]
    )
    // 两次 to=done 的流转被完成节点覆盖；done→todo 的重开是一条中间流转
    expect(flatActor(groups)).toEqual([
      'a:completed:human',
      'a:transitioned:human',
      'a:created:human'
    ])
  })

  /** "agent 报 bug 给我修"：新建的主语是 agent（提出者），不是我（执行者） */
  it('新建节点主语 = 提出者，不受执行者影响', () => {
    const groups = buildTimeline(
      [make('a', { createdBy: 'agent:alice', executedBy: 'human' })],
      [tr('a', null, 'todo', '2026-09-10T10:00:00', 'agent:alice')]
    )
    expect(flatActor(groups)).toEqual(['a:created:agent:alice'])
  })

  it('新建节点没有流转记录 → 回落提出者', () => {
    const groups = buildTimeline([
      make('a', { createdBy: 'agent:alice', executedBy: 'human' })
    ])
    expect(flatActor(groups)).toEqual(['a:created:agent:alice'])
  })
})
