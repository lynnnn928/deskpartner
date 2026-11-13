// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { ApprovalView } from '../../../../src/renderer/components/approval/ApprovalView'
import { OnboardingChecklist } from '../../../../src/renderer/components/workbench/OnboardingChecklist'
import { useAgentStore } from '../../../../src/renderer/stores/agent.store'
import { useProjectStore } from '../../../../src/renderer/stores/project.store'
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'
import { useTodoStore } from '../../../../src/renderer/stores/todo.store'
import { useUIStore } from '../../../../src/renderer/stores/ui.store'

/**
 * 批准之后不是终点站（卡 `aa5f5222`）
 *
 * 主用户 2026-11-13 实测：「审批完之后就断在这里了，对于刚安装这个应用的用户来说，
 * 会一脸懵」—— 点完「批准」，申请从队列里消失、记录里多一行「已批准 / 已生效」，
 * 然后没有一句"接下来去哪"。
 *
 * 这里钉三件事：
 * ① 批准成功当场要有一份回执：谁被批了 + 下一步是哪一行（必须取清单当前行）；
 * ② 那颗「回「我的工作」」真的落到看板，并把清单当前行指出来（不写死是哪一行）；
 * ③ 没有其它待处理申请时，原标题「待审批 · 当前无待处理申请」换成
 *    「这里没有别的了，回「我的工作」继续」，且带同一个入口。
 */
const invokeMock = vi.fn()

vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const PROJECT_WITH_HANDOFF = {
  id: 'p1',
  name: 'DeskPartner',
  archived: false,
  color: '#5388F6',
  handoffMarkdown: '# 项目接手说明\n把文档收成一本',
  createdAt: '',
  updatedAt: ''
}

const agentOf = (approved: boolean) => ({
  id: 'agent:rookie',
  displayName: 'Rookie',
  color: null,
  approved,
  rejectedAt: null,
  hasCredential: true,
  createdAt: '2026-11-13T13:26:52.464Z',
  lastSeenAt: '2026-11-13T13:26:52.464Z',
  lastWriteAt: null,
  lastWriteCmd: null
})

/** 批准之后库里的样子：同一个身份 approved=true（invoke 桩按这个状态回答） */
let approvedNow = false

beforeEach(() => {
  approvedNow = false
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'agent:list':
        return [agentOf(approvedNow)]
      case 'agent:setApproved':
        approvedNow = true
        return { ok: true }
      case 'agent:listGrants':
        return []
      case 'profile:proposals':
      case 'protocol:proposals':
      case 'project:handoffProposals':
      case 'rules:proposals':
        return []
      case 'project:list':
        return [PROJECT_WITH_HANDOFF]
      case 'profile:get':
        return { scope: 'global', blocks: [{ blockKey: 'basics', body: '', confirmed: false }] }
      case 'protocol:get':
        return { scope: 'global', blocks: [] }
      case 'approval:listHistory':
        return { total: 0, offset: 0, limit: 20, rows: [] }
      default:
        return null
    }
  })
  useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
  useProjectStore.setState({ projects: [PROJECT_WITH_HANDOFF] as never })
  useTodoStore.setState({ todos: [] as never })
  useUIStore.setState({
    mainView: 'approval',
    workspaceMode: 'workbench',
    selectedTodoId: null,
    onboardingChecklistDismissed: false,
    onboardingChecklistReopened: false,
    onboardingFocusStep: null
  })
  useSettingsStore.setState({
    settings: { humanName: 'L', humanNameAsked: true, appName: 'DeskPartner', appIcon: null } as never
  })
})

afterEach(() => {
  cleanup()
})

describe('审批页批准之后要给下一步（卡 aa5f5222）', () => {
  it('批准成功当场给回执：谁被批了 + 下一步是清单当前行', async () => {
    render(<ApprovalView />)

    await waitFor(() => expect(screen.getByText('Rookie 申请接入')).toBeTruthy())
    fireEvent.click(screen.getByText('批准'))

    await waitFor(() => expect(screen.getByTestId('approval-approved-receipt')).toBeTruthy())

    const receipt = screen.getByTestId('approval-approved-receipt')
    expect(receipt.textContent).toContain('已批准「Rookie」')
    /**
     * 项目接手说明已填、协议与档案还没确认 → 清单当前行是「写下关于我」。
     * 这一句**不许写死**：同一个回执换一套真实状态就该说另一行
     * （清单的步骤顺序在 `lib/onboarding.ts`，这里断的是它算出来的那一行）。
     */
    expect(receipt.textContent).toContain('下一步：写下关于我')
    expect(invokeMock).toHaveBeenCalledWith('agent:setApproved', { id: 'agent:rookie', approved: true })
  })

  it('回执里那颗按钮真的回看板，并把清单当前行指出来', async () => {
    render(<ApprovalView />)

    await waitFor(() => expect(screen.getByText('Rookie 申请接入')).toBeTruthy())
    fireEvent.click(screen.getByText('批准'))
    await waitFor(() => expect(screen.getByTestId('approval-back-to-work')).toBeTruthy())

    fireEvent.click(screen.getByTestId('approval-back-to-work'))

    const ui = useUIStore.getState()
    expect(ui.mainView).toBe('board')
    expect(ui.workspaceMode).toBe('workbench')
    // 清单可能被收起过：回来时要摊开，否则"回我的工作"会落在一张没有清单的页面上
    expect(ui.onboardingChecklistDismissed).toBe(false)
    // 一次性锚：哪一行该滚进视口，由清单自己算完就清掉
    expect(ui.onboardingFocusStep).toBe('basics')
  })

  it('清单接到锚就把当前行滚进视口', async () => {
    const scrollSpy = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useUIStore.setState({ mainView: 'board', onboardingFocusStep: 'basics', onboardingChecklistDismissed: false })

    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-row-basics')).toBeTruthy())

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled(), { timeout: 2000 })
    // 用完就清：下次进页面不该再跳一次
    await waitFor(() => expect(useUIStore.getState().onboardingFocusStep).toBeNull(), { timeout: 4000 })
  })

  it('没有其它待处理申请时，右上那句换成"这里没有别的了"并带同一个返回入口', async () => {
    approvedNow = true
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })

    render(<ApprovalView />)

    await waitFor(() => expect(screen.getByTestId('approval-nothing-else')).toBeTruthy())
    // 原来那句把人钉在"什么也没发生"上，现在必须说出往哪走
    expect(screen.queryByText('当前无待处理申请')).toBeNull()
    expect(screen.getByTestId('approval-nothing-else').textContent).toContain('这里没有别的了')

    fireEvent.click(screen.getByText('回「我的工作」继续'))
    expect(useUIStore.getState().mainView).toBe('board')
    expect(useUIStore.getState().workspaceMode).toBe('workbench')
  })
})
