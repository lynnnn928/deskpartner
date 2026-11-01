// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { NotificationsView } from '../../../src/renderer/components/notification/NotificationsView'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'
import {
  DEFAULT_HANDLED_FILTER,
  HANDLED_FILTER_OPTIONS,
  UNHANDLED_LABEL,
  fmtHandledAt,
  handledSummary,
  isHandled,
  processedReaders
} from '../../../src/renderer/components/notification/handled'

/**
 * 备忘的「谁已处理」在界面上看得见（卡 `5fd2b595`）
 *
 * ## 缺口在哪
 *
 * 数据侧早就齐了：`memo ack`（`memo.repository.ts` 的 `ack()`）会调
 * `NotificationRepository.markReadByRef()`，把 `agent:xxx` 追进 `notifications.read_by`、
 * 并把 `read_at` 写成 ack 那一瞬；CLI `notification list` 的 `readBy` / `read_by`
 * 从 1.0.139 起也回。**渲染层一句都没读它** —— `NotificationsView` 只把 `readBy`
 * 当成"我读过没有"的开关（`isUnreadFor`），「谁处理了、什么时候」从来没上过屏幕。
 * 所以是**没渲染**，不是没数据。
 *
 * ## 这一档为什么是"查询条件"而不是渲染判断
 *
 * 卡上第 2 条（筛选加一档「没人接手的」）第一版做在渲染层（`items.filter`），
 * 当场被 `cba46119` 的源码闸门拦下——对一页筛选 = 筛选落在窗口之内，
 * `matched` / `unread` / `byType` 仍是整范围的数、列表只剩子集。
 * 现在是下推：界面只把 `unhandled: true` 交给主进程（`InboxQuery.unhandled`），
 * 三个数与列表同一份 WHERE。本文件因此验的是**发出去的查询**，不是前端过滤。
 *
 * ## 为什么这里真的挂渲染器
 *
 * 仓库里 `@testing-library/react` + happy-dom 早就在用（`vitest.config.ts` 的
 * `environment: 'happy-dom'`、`tests/renderer` 下十来条 `.test.tsx`），
 * 「渲染层没有组件测试库」这句不成立 —— 能真挂就真挂，比字符串断言硬。
 * 源码闸门只用来钉住"删掉就红"的那一半。
 */
const ROOT = path.resolve(__dirname, '../../..')
/** 工作树是 CRLF、仓库里是 LF：断言写 `\n`，读的时候统一 */
const read = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n')

const VIEW = 'src/renderer/components/notification/NotificationsView.tsx'
const REPO = 'src/main/database/notification.repository.ts'

/** 本年度的某个本地时刻 —— 跨年时 `fmtHandledAt` 会补年份，夹具跟着走 */
const thisYear = new Date().getFullYear()
const handledAt = new Date(thisYear, 9, 31, 14, 2).toISOString()
const HANDLED_AT_LABEL = '10-31 14:02'

const nameOf = (reader: string) =>
  ({ 'agent:alice': 'Alice', 'agent:bob': 'Bob' })[reader] ?? reader.replace(/^agent:/, '')

describe('① reader 分流：human 是「已看过」，agent:* 才是「已处理」', () => {
  it('同一份 read_by 里，human 不算处理，agent 算', () => {
    const 只有人读过 = { readBy: 'human', readAt: handledAt, status: 'read' }
    expect(processedReaders(只有人读过)).toEqual([])
    expect(isHandled(只有人读过), '主用户自己点开过 ≠ 有人接手了').toBe(false)
    expect(handledSummary(只有人读过, nameOf).text).toBe(UNHANDLED_LABEL)

    const 只有agent = { readBy: 'agent:alice', readAt: handledAt, status: 'read' }
    expect(processedReaders(只有agent)).toEqual(['agent:alice'])
    expect(isHandled(只有agent)).toBe(true)
    expect(handledSummary(只有agent, nameOf).text).toBe(`Alice 已处理 ${HANDLED_AT_LABEL}`)

    // 并集（人看过 + agent 处理过）：处理的是 agent，人那一份只影响"未读"
    const 都干过 = { readBy: 'agent:alice,human', readAt: handledAt, status: 'read' }
    expect(processedReaders(都干过), 'human 不该出现在"谁处理了"里').toEqual(['agent:alice'])
    expect(handledSummary(都干过, nameOf).text).toBe(`Alice 已处理 ${HANDLED_AT_LABEL}`)
  })

  it('多个主体一起处理：都列出来，用顿号连接', () => {
    const n = { readBy: 'agent:alice,human,agent:bob', readAt: handledAt, status: 'read' }
    expect(handledSummary(n, nameOf).text).toBe(`Alice、Bob 已处理 ${HANDLED_AT_LABEL}`)
  })

  it('不裸露 agent:xxx：查不到 displayName 时退回去掉前缀的 id', () => {
    const n = { readBy: 'agent:carol', readAt: handledAt, status: 'read' }
    const text = handledSummary(n, nameOf).text
    expect(text).toBe(`carol 已处理 ${HANDLED_AT_LABEL}`)
    expect(text).not.toContain('agent:')
  })

  it('时间写绝对时刻，不写「刚刚 / 3 小时前」', () => {
    expect(fmtHandledAt(handledAt)).toBe(HANDLED_AT_LABEL)
    expect(
      handledSummary({ readBy: 'agent:alice', readAt: handledAt, status: 'read' }, nameOf).text
    ).not.toContain('前')
    // 跨年补年份
    const 前年 = new Date(thisYear - 2, 9, 31, 14, 2).toISOString()
    expect(fmtHandledAt(前年)).toBe(`${thisYear - 2}-10-31 14:02`)
    expect(fmtHandledAt(null), '没有时间就不编一个').toBeNull()
    expect(fmtHandledAt('不是时间')).toBeNull()
  })

  /**
   * `read_at` 为空却有 agent 读者真的存在：CLI `notification list --ack-mine`
   * 只追加 `read_by`、不动全局位。那时只写「已处理」，**不借 createdAt 充数**。
   */
  it('有时间就写时间，没时间就只写「已处理」', () => {
    expect(
      handledSummary({ readBy: 'agent:alice', readAt: null, status: 'read' }, nameOf).text
    ).toBe('Alice 已处理')
    expect(handledSummary({ readBy: 'agent:alice', status: 'read' }, nameOf).text).toBe('Alice 已处理')
  })
})

describe('② 无人接手：空集 / 仅 human / 历史行 null 都算没人接手', () => {
  it('三种"没人接手"的写法同义', () => {
    for (const readBy of [null, '', 'human']) {
      const n = { readBy, readAt: null, status: 'read' }
      expect(isHandled(n), `readBy=${JSON.stringify(readBy)} 不该算已处理`).toBe(false)
      expect(handledSummary(n, nameOf).text).toBe(UNHANDLED_LABEL)
    }
  })

  /**
   * `read_by` 里有 `agent:*` 却仍然挂着未读位 = 他只是 `notification list --ack-mine` 看过，
   * 没接手。算成「已处理」的话，列表说没人接手、行尾却说别人处理了，两个读数互相打脸
   * （卡 `c13dbb16` 拿这条路径钉的正是"agent 看过 ≠ 我已读过"）。
   */
  it('agent 只是看过（全局位还亮着）→ 仍算没人接手', () => {
    const 只看过 = { readBy: 'agent:alice', readAt: null, status: 'unread' }
    expect(processedReaders(只看过)).toEqual([])
    expect(isHandled(只看过)).toBe(false)
    expect(handledSummary(只看过, nameOf).text).toBe(UNHANDLED_LABEL)
    // 同一个读者，了结之后才算处理
    expect(isHandled({ ...只看过, status: 'read' })).toBe(true)
  })

  it('历史行（read_by 为 NULL）不编造谁读过', () => {
    expect(processedReaders({ readBy: null, status: 'read' })).toEqual([])
    expect(
      handledSummary({ readBy: null, readAt: handledAt, status: 'read' }, nameOf).text
    ).toBe(UNHANDLED_LABEL)
  })
})

describe('③ 档位定义：默认「待接手」，另有一档回到全量', () => {
  it('默认档位与文案', () => {
    expect(DEFAULT_HANDLED_FILTER).toBe('open')
    expect(HANDLED_FILTER_OPTIONS.map((o) => o.label)).toEqual(['待接手', '全部'])
  })
})

// ───────── 渲染：真把界面挂起来看 ---------

const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

type Row = {
  id: string
  type: string
  title: string
  summary?: string
  refId?: string | null
  actor: string | null
  recipient?: string | null
  status?: string
  readBy: string | null
  readAt: string | null
  meta?: string | null
  createdAt?: string
}

const rows: Row[] = [
  // 已被 alice 处理、我也看过
  {
    id: 'n-handled',
    type: 'memo',
    title: '备忘：部署脚本已按你的要求改好',
    refId: 'memo-1',
    actor: 'agent:bob',
    readBy: 'agent:alice,human',
    readAt: handledAt,
    status: 'read'
  },
  // 已被 dave 处理、我还没看过；dave 不在 agent:list 里 → 退回 id 去前缀
  {
    id: 'n-handled-unknown',
    type: 'memo',
    title: '备忘：发布前置检查已跑完',
    refId: 'memo-2',
    actor: 'agent:bob',
    readBy: 'agent:dave',
    readAt: null,
    status: 'read'
  },
  // 没人接手（历史行 read_by 为 NULL）
  {
    id: 'n-open-null',
    type: 'memo',
    title: '备忘：这版接口要不要废弃',
    refId: 'memo-3',
    actor: 'agent:bob',
    readBy: null,
    readAt: null
  },
  // 只有我点开过 —— 仍然是没人接手
  {
    id: 'n-open-human',
    type: 'memo',
    title: '备忘：下周的发布窗口',
    refId: 'memo-4',
    actor: 'agent:bob',
    readBy: 'human',
    readAt: handledAt
  },
  // 非备忘类：不该每条都挂「无人接手」
  {
    id: 'n-reminder',
    type: 'reminder',
    title: '待办提醒：整理评审意见',
    actor: null,
    readBy: null,
    readAt: null
  }
]

/**
 * 主进程那份回执的**替身**：`unhandled` 真的在这里生效（与仓储同一判据），
 * 界面才可能"显示出过滤效果"——它自己是不筛的。
 */
function mockInbox(list: Row[] = rows) {
  const calls: Array<Record<string, unknown>> = []
  invokeMock.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    switch (channel) {
      case 'agent:list':
        return [
          { id: 'agent:alice', displayName: 'Alice', approved: true },
          { id: 'agent:bob', displayName: 'Bob', approved: true }
        ]
      case 'notification:listWithProject': {
        calls.push(payload ?? {})
        const handled = (r: Row) =>
          (r.status ?? 'unread') === 'read' &&
          (r.readBy ?? '').split(',').some((x) => x.startsWith('agent:'))
        const scoped = payload?.unhandled === true ? list.filter((r) => !handled(r)) : list
        return {
          matched: scoped.length,
          returned: scoped.length,
          truncated: false,
          nextOffset: null,
          unread: scoped.filter((r) => !(r.readBy ?? '').includes('human')).length,
          byType: {
            memo: { total: scoped.filter((r) => r.type === 'memo').length, unread: 2 },
            reminder: { total: scoped.filter((r) => r.type === 'reminder').length, unread: 1 }
          },
          rows: scoped.map((r) => ({
            summary: '',
            status: 'unread',
            recipient: null,
            meta: null,
            createdAt: new Date().toISOString(),
            projectId: null,
            todoId: null,
            ...r
          }))
        }
      }
      default:
        return null
    }
  })
  return calls
}

function handledLines(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="memo-handled"]')).map(
    (el) => el.textContent ?? ''
  )
}

describe('①③ 界面：默认只看待接手（查询下推）、行上写清谁处理的', () => {
  let calls: Array<Record<string, unknown>>

  beforeEach(() => {
    invokeMock.mockReset()
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, humanName: 'Alex' }
    }))
    calls = mockInbox()
  })

  it('默认档位是「待接手」，且它是发给主进程的查询条件（不是前端筛）', async () => {
    const view = render(React.createElement(NotificationsView))
    await waitFor(() => expect(view.getByLabelText('通知列表表头')).toBeTruthy())

    const group = view.getByRole('group', { name: '按接手状态筛选' })
    const openChip = within(group).getByRole('button', { name: '待接手' })
    expect(openChip.getAttribute('aria-pressed')).toBe('true')
    expect(within(group).getByRole('button', { name: '全部' })).toBeTruthy()

    // 查询里带着这一档 —— 判据在主进程的 WHERE（InboxQuery.unhandled）
    expect(calls[0]).toMatchObject({ reader: 'human', unhandled: true })

    // 已处理的两条不在默认视图里
    expect(view.queryByText('备忘：部署脚本已按你的要求改好')).toBeNull()
    expect(view.queryByText('备忘：发布前置检查已跑完')).toBeNull()
  })

  it('备忘行上给出「谁 + 什么时候」，没接手的写「无人接手」', async () => {
    const view = render(React.createElement(NotificationsView))
    await waitFor(() => expect(view.getByLabelText('通知列表表头')).toBeTruthy())

    // 默认视图里只剩没人接手的
    expect(view.getByText('备忘：这版接口要不要废弃')).toBeTruthy()
    expect(view.getByText('备忘：下周的发布窗口')).toBeTruthy()
    expect(handledLines()).toEqual([UNHANDLED_LABEL, UNHANDLED_LABEL])
    // 非备忘类不挂这句 —— 每条都来一行只是噪点
    expect(view.getByText('待办提醒：整理评审意见')).toBeTruthy()
  })

  it('切到「全部」= 不带这一档（回到全量），已接手的行上写着谁处理的', async () => {
    const view = render(React.createElement(NotificationsView))
    await waitFor(() => expect(view.getByLabelText('通知列表表头')).toBeTruthy())
    const group = view.getByRole('group', { name: '按接手状态筛选' })

    calls.length = 0
    fireEvent.click(within(group).getByRole('button', { name: '全部' }))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))

    expect(calls[calls.length - 1]).not.toHaveProperty('unhandled')
    expect(calls[calls.length - 1]).toMatchObject({ reader: 'human' })

    await waitFor(() => expect(view.getByText('备忘：部署脚本已按你的要求改好')).toBeTruthy())
    const lines = handledLines()
    // 友好名 + 绝对时间；查不到 displayName 的退回 id 去前缀，不露 agent:
    expect(lines).toContain(`Alice 已处理 ${HANDLED_AT_LABEL}`)
    expect(lines).toContain('dave 已处理')
    expect(lines.join(' ')).not.toContain('agent:')
  })

  it('再点回「待接手」：已处理的重新消失（两档都可用，不是单向）', async () => {
    const view = render(React.createElement(NotificationsView))
    await waitFor(() => expect(view.getByLabelText('通知列表表头')).toBeTruthy())
    const group = view.getByRole('group', { name: '按接手状态筛选' })

    fireEvent.click(within(group).getByRole('button', { name: '全部' }))
    await waitFor(() => expect(view.getByText('备忘：部署脚本已按你的要求改好')).toBeTruthy())

    fireEvent.click(within(group).getByRole('button', { name: '待接手' }))
    await waitFor(() =>
      expect(view.queryByText('备忘：部署脚本已按你的要求改好')).toBeNull()
    )
    expect(view.getByText('待办提醒：整理评审意见')).toBeTruthy()
  })

  it('展开备忘，详情里也写着处理状态（不用回去看行尾）', async () => {
    const view = render(React.createElement(NotificationsView))
    await waitFor(() => expect(view.getByLabelText('通知列表表头')).toBeTruthy())
    fireEvent.click(
      within(view.getByRole('group', { name: '按接手状态筛选' })).getByRole('button', {
        name: '全部'
      })
    )
    await waitFor(() => expect(view.getByText('备忘：部署脚本已按你的要求改好')).toBeTruthy())

    fireEvent.click(view.getByText('备忘：部署脚本已按你的要求改好'))
    expect(view.getByText('处理：')).toBeTruthy()
    expect(view.getByText(`Alice 已处理 ${HANDLED_AT_LABEL}`)).toBeTruthy()
  })

  it('全被接手时不谎称「暂无通知」', async () => {
    invokeMock.mockReset()
    mockInbox(rows.filter((r) => r.id.startsWith('n-handled')))
    const view = render(React.createElement(NotificationsView))
    await waitFor(() => expect(view.getByLabelText('通知列表表头')).toBeTruthy())

    expect(view.getByText('没有待接手的')).toBeTruthy()
    expect(view.queryByText('暂无通知')).toBeNull()
  })
})

// ───────── 源码闸门 + 注入反向验证 ---------

/**
 * 闸门写成函数：真源码必须 0 问题，改动过的副本必须被认出来。
 * 只写 `expect(源码).toContain(...)` 的闸门没法自证「它认得出违规」——
 * 本项目被恒真闸门坑过一次（`verify-gates-reverse`）。
 */
function viewProblems(view: string): string[] {
  const problems: string[] = []
  if (!view.includes("from './handled'")) problems.push('没有接入接手状态的判据模块')
  if (!view.includes('data-testid="memo-handled"')) problems.push('行上没有渲染「谁已处理」')
  if (!view.includes('handledSummary(n, resolveActorDisplay)'))
    problems.push('处理者没走友好名解析（会裸露 agent:xxx，或绕过 displayName）')
  if (view.includes('{n.readBy}')) problems.push('把 read_by 原文直接打到了界面上')
  // 这一档必须下推成查询参数；在渲染侧筛一页就是 cba46119 那个坑
  if (!view.includes("handledFilter === 'open' ? { unhandled: true } : {}"))
    problems.push('「待接手」没有作为查询条件发给主进程')
  if (!view.includes('useState<HandledFilter>(DEFAULT_HANDLED_FILTER)'))
    problems.push('默认档位不是 DEFAULT_HANDLED_FILTER（卡的诉求：默认只看没人接手的）')
  if (!view.includes('HANDLED_FILTER_OPTIONS.map')) problems.push('档位选择器不见了')
  // 行尾锚定：`const visible = items.filter(...)` 这种"前缀一样"的改法也得认出来
  if (!/const visible = items\s*$/m.test(view)) problems.push('列表不再是主进程给的那一页')
  if (view.includes('items.filter')) problems.push('在渲染侧筛一页 —— 筛选落在窗口之内')
  return problems
}

/** 仓储那半：这一档真的在 SQL 里，三个数也共用同一份 WHERE */
function repoProblems(repo: string): string[] {
  const problems: string[] = []
  if (!repo.includes('unhandled?: boolean')) problems.push('InboxQuery 没有 unhandled 这一档')
  if (!repo.includes("where.push(`(n.status <> 'read' OR n.read_by IS NULL OR n.read_by = '' OR n.read_by = 'human')`)"))
    problems.push('WHERE 里没有"没人接手"的判据')
  if (!repo.includes('...(query.unhandled ? { unhandled: true } : {})'))
    problems.push('byType / 页头未读没有跟着这一档走（三个数会与列表不同源）')
  if (!/unreadSystemCount\(reader\?: string\)[\s\S]{0,600}unhandled: true/.test(repo))
    problems.push('角标没有按「待接手 ∩ 我未读」数 —— agent 处理过的东西仍在报警')
  return problems
}

describe('④ 源码闸门：删掉渲染 / 退回前端筛选 / 角标不跟这一档，都必须认得出', () => {
  it('真源码 0 问题（界面 + 仓储）', () => {
    const view = read(VIEW)
    const repo = read(REPO)
    expect(view.length).toBeGreaterThan(10000)
    expect(repo.length).toBeGreaterThan(20000)
    expect(viewProblems(view)).toEqual([])
    expect(repoProblems(repo)).toEqual([])
  })

  it('反：把行上那段渲染删掉 → 红', () => {
    const view = read(VIEW)
    const 删掉渲染 = view
      .split('\n')
      .filter((line) => !line.includes('data-testid="memo-handled"'))
      .join('\n')
    expect(删掉渲染).not.toBe(view)
    expect(viewProblems(删掉渲染)).toContain('行上没有渲染「谁已处理」')
  })

  it('反：绕开友好名直接渲染读者原文 → 红', () => {
    const view = read(VIEW)
    const 裸露 = view.replace('{handled.text}', '{n.readBy}')
    expect(裸露).not.toBe(view)
    expect(viewProblems(裸露)).toContain('把 read_by 原文直接打到了界面上')
  })

  it('反：退回"在界面里筛一页"→ 红', () => {
    const view = read(VIEW)
    const 窗口筛选 = view.replace('const visible = items', 'const visible = items.filter(() => true)')
    expect(窗口筛选).not.toBe(view)
    expect(viewProblems(窗口筛选)).toContain('列表不再是主进程给的那一页')
    expect(viewProblems(窗口筛选)).toContain('在渲染侧筛一页 —— 筛选落在窗口之内')
  })

  it('反：档位不发给主进程（留在前端）→ 红', () => {
    const view = read(VIEW)
    const 只在前端 = view.replace(
      "handledFilter === 'open' ? { unhandled: true } : {}",
      '{}'
    )
    expect(只在前端).not.toBe(view)
    expect(viewProblems(只在前端)).toContain('「待接手」没有作为查询条件发给主进程')
  })

  it('反：角标不吃这一档 → 红（红点会为 agent 处理掉的东西继续报警）', () => {
    const repo = read(REPO)
    const 角标不跟 = repo.replace(
      /unreadSystemCount\(reader\?: string\): number \{[\s\S]*?\n  \}/,
      'unreadSystemCount(reader?: string): number {\n    return 0\n  }'
    )
    expect(角标不跟).not.toBe(repo)
    expect(repoProblems(角标不跟)).toContain(
      '角标没有按「待接手 ∩ 我未读」数 —— agent 处理过的东西仍在报警'
    )
  })
})

/**
 * 红点口径（卡 `5fd2b595` 第 3 条）：`c13dbb16` 之后侧栏角标就带着
 * `reader: GUI_READER` 了；本卡要的是它再收一层「待接手」（判据在主进程）。
 * 这里钉住**界面那一半**（带主体），行为那一半在
 * `tests/main/notification-unhandled-5fd2b595.test.ts`。
 */
function badgeProblems(sidebar: string): string[] {
  const at = sidebar.indexOf("invoke('notification:unreadCount'")
  if (at < 0) return ['找不到 notification:unreadCount 调用点']
  return sidebar.slice(at, at + 240).includes('reader: GUI_READER')
    ? []
    : ['角标没带 reader —— 退回全局已读位就会被别的写方吃掉']
}

describe('③ 红点：侧栏角标带主体（行为面见主侧用例）', () => {
  it('真源码带主体，拿掉就红', () => {
    const sidebar = read('src/renderer/components/kanban/Sidebar.tsx')
    expect(sidebar.length).toBeGreaterThan(10000)
    expect(badgeProblems(sidebar)).toEqual([])
    expect(badgeProblems(sidebar.replace('{ reader: GUI_READER }', ''))).not.toEqual([])
  })
})
