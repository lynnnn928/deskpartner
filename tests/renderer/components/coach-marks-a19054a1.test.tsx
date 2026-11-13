// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { CoachMarkHost } from '../../../src/renderer/components/onboarding/CoachMark'
import {
  COACH_MARKS,
  EMPTY_SEEN,
  pickCoachMark,
  rememberOnboardingJump,
  resetCoaches,
  type CoachConditions
} from '../../../src/renderer/lib/coach-marks'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useTodoStore } from '../../../src/renderer/stores/todo.store'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

/**
 * 就地提示（卡 `a19054a1`）
 *
 * 1.0.147 按评审（`claude-opus-5-5`）改，钉这六件事：
 * ① 触发条件来自真实状态，不成立就不出现（不造假数据、不硬闯）；
 * ② 锚点不存在时**不渲染**——气泡指着空气比不弹更糟；
 * ③ 关掉就记着，同一条不会再出现；「跳过引导」之后一条都不再出现；
 * ④ 气泡不再自带 `n/3`：同一窗口只留清单那一个进度数，标题用清单的步骤名；
 * ⑤ 清单能自己指路时（当前行在视口里）气泡 1 不说话，同一件事不说两遍；
 * ⑥ 站在审批页 / 从清单跳去用户页时，气泡指到那一颗真按钮上。
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
const mountAnchor = (
  attrs: Record<string, string>,
  rect?: Partial<DOMRect>
): HTMLDivElement => {
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

const baseConditions: CoachConditions = {
  pendingApproval: false,
  approvalPage: false,
  checklistQuiet: true,
  jumpedToAbout: false,
  jumpedToProtocol: false,
  firstProposed: false,
  decidingProposed: false
}
const ROOT = join(__dirname, '../../..')

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  useAgentStore.setState({ agents: [], loading: false })
  useTodoStore.setState({ todos: [] })
  useUIStore.setState({ selectedTodoId: null, mainView: 'board' })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('就地提示：选哪一处', () => {
  it('所有条件都不成立时不出提示', () => {
    expect(pickCoachMark(baseConditions, EMPTY_SEEN)).toBeNull()
  })

  it('有助手在等我批准 → 指审批导航项', () => {
    const mark = pickCoachMark({ ...baseConditions, pendingApproval: true }, EMPTY_SEEN)
    expect(mark?.id).toBe('approval')
    expect(mark?.anchor).toBe('[data-coach-target="approval-nav"]')
    // 标题就是清单里那一步的名字，不再另起一套说法
    expect(mark?.title).toBe('批准它的身份')
  })

  /** 评审第 18 条：清单当前行就在视口里时，卡内的「前往审批」已经在说同一件事 */
  it('清单自己在指路时，审批气泡不说话；清单收起或被滚走才轮到它', () => {
    expect(
      pickCoachMark({ ...baseConditions, pendingApproval: true, checklistQuiet: false }, EMPTY_SEEN)
    ).toBeNull()
    expect(
      pickCoachMark({ ...baseConditions, pendingApproval: true, checklistQuiet: true }, EMPTY_SEEN)?.id
    ).toBe('approval')
  })

  /** 评审第 19 条：人已经站在审批页了，该指的是那一行的「批准」 */
  it('站在审批页时，气泡指「批准」按钮而不是导航项', () => {
    const mark = pickCoachMark(
      { ...baseConditions, pendingApproval: true, approvalPage: true, checklistQuiet: false },
      EMPTY_SEEN
    )
    expect(mark?.id).toBe('approve-button')
    expect(mark?.anchor).toBe('[data-coach-target="approve-button"]')
  })

  /** 评审第 22 条：用户页那两条只在"从清单跳过来"时出现 */
  it('从清单跳到关于我 / 协作协议时，各出一条气泡', () => {
    expect(pickCoachMark({ ...baseConditions, jumpedToAbout: true }, EMPTY_SEEN)?.id).toBe('about-save')
    expect(pickCoachMark({ ...baseConditions, jumpedToProtocol: true }, EMPTY_SEEN)?.id).toBe(
      'protocol-confirm'
    )
  })

  it('批准那一步关过了，就轮到列表里那条待确认事项', () => {
    const mark = pickCoachMark(
      { ...baseConditions, pendingApproval: true, firstProposed: true },
      { seen: { approval: true, 'approve-button': true }, skipped: false }
    )
    expect(mark?.id).toBe('proposed')
  })

  it('跳过引导之后一条都不再出现', () => {
    expect(
      pickCoachMark(
        { ...baseConditions, pendingApproval: true, firstProposed: true, decidingProposed: true },
        { seen: {}, skipped: true }
      )
    ).toBeNull()
  })

  it('六处提示各锚在一个真实控件上，没有一条指向坐标，也没有一条带 n/3', () => {
    expect(COACH_MARKS).toHaveLength(6)
    for (const mark of COACH_MARKS) {
      expect(mark.anchor.startsWith('[data-coach-target=')).toBe(true)
      expect(mark).not.toHaveProperty('step')
    }
  })

  /**
   * 主用户 2026-11-13 的原话：「我看不出需要把状态从待确认改到待办才算成」。
   * 所以正文都得写出**要你做什么 + 点了会怎样**，不是一句口号：
   * 状态那一处必须点名两个状态和「提交保存」，否则人改了状态不保存，还是没成。
   */
  it('正文都写清要做什么，状态那一处点名「待确认→待办」与提交保存', () => {
    const byId = Object.fromEntries(COACH_MARKS.map((mark) => [mark.id, mark.body]))
    expect(byId.approval).toContain('点「批准」')
    expect(byId.approval).toContain('才能写项目资料')
    expect(byId['approve-button']).toContain('批完回「我的工作」')
    expect(byId['about-save']).toContain('保存并确认')
    expect(byId['protocol-confirm']).toContain('按默认内容确认')
    expect(byId.proposed).toContain('点开这一行')
    expect(byId.proposed).toContain('不会开工')
    expect(byId.decide).toContain('「待确认」改成「待办」')
    expect(byId.decide).toContain('提交保存')
    expect(byId.decide).toContain('助手才会开工')
  })

  /**
   * 正文 45 字上限（评审 round 2 第三节）：`approval` 46 字、`decide` 63 字都超了。
   * 这一条把它们钉在同一个数上 —— 以后再想加一句话，先想清楚删掉哪一句。
   */
  it('六处正文都不超过 45 字、标题不超过 8 字（一个字符算一个字）', () => {
    const chars = (text: string): number => [...text].length
    for (const mark of COACH_MARKS) {
      expect(chars(mark.body), `${mark.id} 正文 ${chars(mark.body)} 字`).toBeLessThanOrEqual(45)
      expect(chars(mark.title), `${mark.id} 标题 ${chars(mark.title)} 字`).toBeLessThanOrEqual(8)
    }
  })

  /** 评审 round 2 第三节第 3 条：`decide` 63 字 → 29 字 */
  it('状态那一处气泡已压到上限内，且仍点名两个状态与提交保存', () => {
    const decide = COACH_MARKS.find((mark) => mark.id === 'decide')
    expect([...(decide?.body ?? '')].length).toBeLessThanOrEqual(45)
    expect(decide?.body).toContain('「待确认」改成「待办」')
    expect(decide?.body).toContain('提交保存')
    expect(decide?.body).toContain('助手才会开工')
  })

  /**
   * 选择器写对不等于挂上去了：锚点名必须真的出现在那几处控件上，
   * 宿主也必须真的挂在看板窗口里。少一处，气泡就永远等不到锚点、
   * 静默不出现 —— 这种缺陷 tsc 与上面的选路用例都抓不到。
   */
  it('六处锚点与宿主真的挂在界面上', () => {
    const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
    expect(read('src/renderer/components/kanban/Sidebar.tsx')).toContain("'approval-nav'")
    expect(read('src/renderer/components/approval/ApprovalView.tsx')).toContain(
      'data-coach-target="approve-button"'
    )
    expect(read('src/renderer/components/user/UserView.tsx')).toContain("'about-save'")
    expect(read('src/renderer/components/user/UserView.tsx')).toContain('data-coach-target="protocol-confirm"')
    expect(read('src/renderer/components/workbench/WorkbenchView.tsx')).toContain(
      'data-coach-target="todo-row"'
    )
    expect(read('src/renderer/components/quick-add/QuickAddForm.tsx')).toContain(
      'data-coach-target="status-actions"'
    )
    expect(read('src/renderer/windows/Kanban.tsx')).toContain('<CoachMarkHost />')
  })

  it('resetCoaches 既有界面入口，也会清掉"从清单跳过来"的会话标记', () => {
    rememberOnboardingJump('about')
    resetCoaches()
    expect(window.sessionStorage.getItem('deskpartner.onboardingJump.v1')).toBeNull()
    expect(readFileSync(join(ROOT, 'src/renderer/components/user/UserView.tsx'), 'utf8')).toContain(
      'data-testid="onboarding-replay"'
    )
  })
})

describe('就地提示：真的画出来', () => {
  it('锚点在页面上、清单又不在指路时气泡出现，且不再显示 n/3', async () => {
    mountAnchor({ 'data-coach-target': 'approval-nav' })
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<CoachMarkHost />)
    const bubble = await waitFor(() => screen.getByTestId('coach-mark'))
    expect(bubble.textContent).toContain('批准它的身份')
    expect(screen.queryByTestId('coach-mark-step')).toBeNull()
  })

  /** 清单当前行在视口里：卡里的「前往审批」已经在指路，气泡不能再冒出来说一遍 */
  it('清单当前行还在视口里时，同一个窗口不冒第二条指路', async () => {
    mountAnchor({ 'data-coach-target': 'approval-nav' })
    mountAnchor({ 'data-testid': 'onboarding-checklist' }, { top: 80, bottom: 380, height: 300, width: 640, right: 780 })
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<CoachMarkHost />)
    await new Promise((r) => setTimeout(r, 400))
    expect(screen.queryByTestId('coach-mark')).toBeNull()
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

  it('详情里开着待确认事项时，气泡指向状态按钮', async () => {
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
  })

  it('站在审批页时，气泡指向那一行的「批准」按钮', async () => {
    mountAnchor({ 'data-coach-target': 'approve-button' })
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    useUIStore.setState({ mainView: 'approval' })
    render(<CoachMarkHost />)
    const bubble = await waitFor(() => screen.getByTestId('coach-mark'))
    expect(bubble.textContent).toContain('点这里批准')
    expect(bubble.textContent).toContain('批完回「我的工作」')
  })

  it('从清单跳到关于我时，气泡指向「保存并确认」', async () => {
    mountAnchor({ 'data-coach-target': 'about-save' })
    rememberOnboardingJump('about')
    useUIStore.setState({ mainView: 'user' })
    render(<CoachMarkHost />)
    const bubble = await waitFor(() => screen.getByTestId('coach-mark'))
    expect(bubble.textContent).toContain('写下关于我')
  })

  /**
   * 1.0.147 走查实测：气泡指在用户页的「保存并确认」上，切回「我的工作」之后
   * 那颗按钮已经不在了，气泡却还挂在原来的坐标 —— 一块空白上浮着一个气泡。
   * 锚点走了，气泡就必须走。
   */
  it('锚点从页面上消失后，气泡跟着收起来', async () => {
    const anchor = mountAnchor({ 'data-coach-target': 'about-save' })
    rememberOnboardingJump('about')
    useUIStore.setState({ mainView: 'user' })
    render(<CoachMarkHost />)
    await waitFor(() => screen.getByTestId('coach-mark'))
    anchor.remove()
    await waitFor(() => expect(screen.queryByTestId('coach-mark')).toBeNull(), { timeout: 3000 })
  })
})
