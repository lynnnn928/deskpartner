// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { CoachMarkHost } from '../../../src/renderer/components/onboarding/CoachMark'
import { pickCoachMark, COACH_MARKS, EMPTY_SEEN } from '../../../src/renderer/lib/coach-marks'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useTodoStore } from '../../../src/renderer/stores/todo.store'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

/**
 * 就地提示（卡 `a19054a1`）
 *
 * 钉四件事：
 * ① 触发条件来自真实状态，不成立就不出现（不造假数据、不硬闯）；
 * ② 锚点不存在时**不渲染**——气泡指着空气比不弹更糟；
 * ③ 关掉就记着，同一条不会再出现；「跳过引导」之后一条都不再出现；
 * ④ 计数按步骤走（1/3、2/3…），与三步因果链对得上。
 */
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: async () => null,
  on: () => () => {}
}))

const agentOf = (approved: boolean) => ({
  id: 'bob',
  displayName: 'Bob',
  color: null,
  approved,
  rejectedAt: null,
  hasCredential: approved,
  createdAt: '2026-11-13T00:00:00.000Z',
  lastSeenAt: null,
  lastWriteAt: null,
  lastWriteCommand: null
})

const todoOf = (id: string, status: string) => ({
  id,
  title: '整理文档',
  status,
  priority: 'medium',
  projectId: 'p1',
  createdBy: 'agent:bob',
  executedBy: 'agent:bob'
})

/** happy-dom 不排版：锚点要自己桩一份尺寸，否则量到 0 就永远等不到 */
const mountAnchor = (attrs: Record<string, string>, rect?: Partial<DOMRect>): HTMLDivElement => {
  const el = document.createElement('div')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  const box = {
    left: 120,
    top: 160,
    width: 140,
    height: 28,
    right: 260,
    bottom: 188,
    x: 120,
    y: 160,
    ...rect
  }
  el.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect
  document.body.appendChild(el)
  return el
}

const baseConditions = { pendingApproval: false, firstProposed: false, decidingProposed: false }
const ROOT = join(__dirname, '../../..')

beforeEach(() => {
  window.localStorage.clear()
  useAgentStore.setState({ agents: [], loading: false })
  useTodoStore.setState({ todos: [] })
  useUIStore.setState({ selectedTodoId: null })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('就地提示：选哪一处', () => {
  it('三个条件都不成立时不出提示', () => {
    expect(pickCoachMark(baseConditions, EMPTY_SEEN)).toBeNull()
  })

  it('有助手在等我批准 → 指审批导航项', () => {
    const mark = pickCoachMark({ ...baseConditions, pendingApproval: true }, EMPTY_SEEN)
    expect(mark?.id).toBe('approval')
    expect(mark?.anchor).toBe('[data-coach-target="approval-nav"]')
  })

  it('批准那一步关过了，就轮到列表里那条待确认事项', () => {
    const mark = pickCoachMark(
      { ...baseConditions, pendingApproval: true, firstProposed: true },
      { seen: { approval: true }, skipped: false }
    )
    expect(mark?.id).toBe('proposed')
    expect(mark?.step).toBe(2)
  })

  it('跳过引导之后一条都不再出现', () => {
    expect(
      pickCoachMark({ pendingApproval: true, firstProposed: true, decidingProposed: true }, { seen: {}, skipped: true })
    ).toBeNull()
  })

  it('三处提示各锚在一个真实控件上，没有一条指向坐标', () => {
    expect(COACH_MARKS).toHaveLength(3)
    for (const mark of COACH_MARKS) {
      expect(mark.anchor.startsWith('[data-coach-target=')).toBe(true)
    }
  })

  /**
   * 主用户 2026-11-13 的原话：「我看不出需要把状态从待确认改到待办才算成」。
   * 所以三处正文都得写出**要你做什么 + 点了会怎样**，不是一句口号：
   * 状态那一处必须点名两个状态和「提交保存」，否则人改了状态不保存，还是没成。
   */
  it('三处正文都写清要做什么，状态那一处点名「待确认→待办」与提交保存', () => {
    const byId = Object.fromEntries(COACH_MARKS.map((mark) => [mark.id, mark.body]))
    expect(byId.approval).toContain('点「批准」')
    expect(byId.approval).toContain('才能登记事项')
    expect(byId.proposed).toContain('点开这一行')
    expect(byId.proposed).toContain('不会开工')
    expect(byId.decide).toContain('「待确认」改成「待办」')
    expect(byId.decide).toContain('提交保存')
    expect(byId.decide).toContain('助手才会开工')
  })

  /**
   * 选择器写对不等于挂上去了：锚点名必须真的出现在那三处控件上，
   * 宿主也必须真的挂在看板窗口里。少一处，气泡就永远等不到锚点、
   * 静默不出现 —— 这种缺陷 tsc 与上面的选路用例都抓不到。
   */
  it('三处锚点与宿主真的挂在界面上', () => {
    const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
    expect(read('src/renderer/components/kanban/Sidebar.tsx')).toContain("'approval-nav'")
    expect(read('src/renderer/components/workbench/WorkbenchView.tsx')).toContain(
      'data-coach-target="todo-row"'
    )
    expect(read('src/renderer/components/quick-add/QuickAddForm.tsx')).toContain(
      'data-coach-target="status-actions"'
    )
    expect(read('src/renderer/windows/Kanban.tsx')).toContain('<CoachMarkHost />')
  })
})

describe('就地提示：真的画出来', () => {
  it('锚点在页面上时气泡出现，计数是 1/3', async () => {
    mountAnchor({ 'data-coach-target': 'approval-nav' })
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<CoachMarkHost />)
    const bubble = await waitFor(() => screen.getByTestId('coach-mark'))
    expect(bubble.textContent).toContain('你的助手在门外')
    expect(screen.getByTestId('coach-mark-step').textContent).toBe('1/3')
  })

  it('锚点不在页面上时什么都不画（气泡不能指着空气）', async () => {
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<CoachMarkHost />)
    // 给轮询几次机会：锚点确实没有，就该一直不出现
    await new Promise((r) => setTimeout(r, 500))
    expect(screen.queryByTestId('coach-mark')).toBeNull()
  })

  it('点「知道了」之后消失，并记住关过（重挂也不再出现）', async () => {
    mountAnchor({ 'data-coach-target': 'approval-nav' })
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<CoachMarkHost />)
    await waitFor(() => screen.getByTestId('coach-mark'))
    fireEvent.click(screen.getByTestId('coach-mark-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('coach-mark')).toBeNull())

    cleanup()
    render(<CoachMarkHost />)
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.queryByTestId('coach-mark')).toBeNull()
  })

  it('「跳过引导」之后连后面那条也不再出现', async () => {
    mountAnchor({ 'data-coach-target': 'approval-nav' })
    mountAnchor({ 'data-coach-target': 'todo-row', 'data-todo-status': 'proposed' })
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    useTodoStore.setState({ todos: [todoOf('t1', 'proposed')] as never })
    render(<CoachMarkHost />)
    await waitFor(() => screen.getByTestId('coach-mark'))
    fireEvent.click(screen.getByTestId('coach-mark-skip'))

    cleanup()
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<CoachMarkHost />)
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.queryByTestId('coach-mark')).toBeNull()
  })

  it('详情里开着待确认事项时，气泡指向状态按钮（3/3）', async () => {
    mountAnchor({ 'data-coach-target': 'status-actions' })
    // 列表里那条已经指过了：轮到详情里的状态按钮
    window.localStorage.setItem(
      'deskpartner.coachMarks.v1',
      JSON.stringify({ seen: { proposed: true }, skipped: false })
    )
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useTodoStore.setState({ todos: [todoOf('t1', 'proposed')] as never })
    useUIStore.setState({ selectedTodoId: 't1' })
    render(<CoachMarkHost />)
    const bubble = await waitFor(() => screen.getByTestId('coach-mark'))
    expect(bubble.textContent).toContain('这一下由你定')
    expect(screen.getByTestId('coach-mark-step').textContent).toBe('3/3')
  })
})
