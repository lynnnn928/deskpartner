// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { ApprovalView } from '../../../../src/renderer/components/approval/ApprovalView'
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'
import { useTodoStore } from '../../../../src/renderer/stores/todo.store'
import { useProjectStore } from '../../../../src/renderer/stores/project.store'

const invokeMock = vi.fn()

vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

function setupMockData(overrides?: {
  grants?: unknown[]
  historyRows?: unknown[]
}) {
  invokeMock.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'agent:list':
        return [
          { id: 'agent:penguin', displayName: 'PenguinHarness', approved: true },
          { id: 'agent:bob', displayName: 'Bob', approved: true }
        ]
      case 'agent:listGrants':
        return overrides?.grants ?? []
      case 'profile:proposals':
      case 'protocol:proposals':
      case 'project:handoffProposals':
      case 'rules:proposals':
        return []
      case 'project:list':
        return [{ id: 'proj-1', name: 'DeskPartner', archived: false }]
      case 'approval:listHistory':
        return {
          total: (overrides?.historyRows ?? []).length || 3,
          offset: 0,
          limit: 20,
          rows: overrides?.historyRows ?? [
            {
              id: 'hist-1',
              type: 'grant',
              agentId: 'agent:penguin',
              agentName: 'PenguinHarness',
              projectId: 'proj-1',
              createdAt: '2026-10-27T11:43:00.000Z',
              activityAt: '2026-10-27T11:44:00.000Z',
              decision: 'approved',
              decidedBy: 'human',
              decidedAt: '2026-10-27T11:44:00.000Z',
              scope: 'destructive',
              // 注意真实库中 rm 与 「 之间没有空格
              summary: 'todo rm「演示：横幅验收（父卡，会被删）」',
              originalBody: null,
              proposedBody: null,
              decidedBody: null,
              execution: 'success',
              execError: null,
              execSummary: '已按你的允许执行完毕',
              requestArgv: ['todo', 'rm', '8e447160', '--yes', '--force']
            },
            {
              id: 'hist-2',
              type: 'protocol',
              agentId: 'agent:bob',
              agentName: 'agent:bob',
              projectId: 'proj-1',
              createdAt: '2026-10-22T00:11:00.000Z',
              activityAt: '2026-10-22T00:11:00.000Z',
              decision: 'rejected',
              decidedBy: 'human',
              decidedAt: '2026-10-22T00:11:00.000Z',
              scope: 'project',
              summary: '协议提议 · roles',
              originalBody: '旧分工',
              proposedBody: '新分工',
              decidedBody: null,
              execution: 'not_required',
              execError: null,
              execSummary: null,
              requestArgv: []
            },
            {
              id: 'hist-3',
              type: 'grant',
              agentId: 'agent:bob',
              agentName: 'Bob',
              projectId: 'proj-1',
              createdAt: '2026-10-27T09:09:00.000Z',
              activityAt: '2026-10-27T09:09:00.000Z',
              decision: 'approved',
              decidedBy: 'human',
              decidedAt: '2026-10-27T09:09:00.000Z',
              scope: 'destructive',
              summary: 'todo rm「【现场】父探针：删它会提示要补 --force（本轮清）」',
              originalBody: null,
              proposedBody: null,
              decidedBody: null,
              execution: 'failure',
              execError: '这条还有 1 个子任务，删除会让它们解绑。确认要删请加 --force；想先看是哪几条，用 `todo children <id>`',
              execSummary: null,
              requestArgv: ['todo', 'rm', 'b8a4da16-e22f-4eab-bd9b-b71def0a90a9', '--yes']
            }
          ]
        }
      default:
        return null
    }
  })
}

describe('ApprovalView 视觉与交互收口（6 项用户反馈验证）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, humanName: 'Alex' }
    }))
    useProjectStore.setState((state) => ({
      ...state,
      projects: [{ id: 'proj-1', name: 'DeskPartner', color: '#5388F6', archived: false, createdAt: '', updatedAt: '' }]
    }))
    useTodoStore.setState((state) => ({
      ...state,
      todos: [
        {
          id: 'd40438f0-6f72-421c-a427-fad7c044b365',
          title: '【审批预览】测试父事项',
          description: '这是待删除事项的详细描述内容',
          status: 'todo',
          priority: 'high',
          type: 'task',
          projectId: 'proj-1',
          categoryId: null,
          categoryIds: [],
          parentId: null,
          createdBy: 'agent:penguin',
          executedBy: 'agent:penguin',
          verifier: 'human',
          dueAt: null,
          remindAt: null,
          fixedInVersion: null,
          isPinned: false,
          createdAt: '2026-10-27T15:57:00.000Z',
          updatedAt: '2026-10-27T15:57:00.000Z',
          completedAt: null
        }
      ]
    }))
  })

  it('1. 彻底消除 todo rm 等命令前缀与原始报错：无空格的 todo rm「…」也转为「删除事项「…」」，展开详情不露命令行与 --force', async () => {
    setupMockData()
    const { getByText, queryByText } = render(<ApprovalView />)

    await waitFor(() => {
      expect(getByText('删除事项「演示：横幅验收（父卡，会被删）」')).toBeTruthy()
    })

    // 界面上不再出现裸 `todo rm`
    expect(queryByText(/^todo rm/)).toBeNull()

    // 展开失败项，验证展开面板里也不出现 `$ todo rm` 或 `确认要删请加 --force`
    fireEvent.click(getByText('删除事项「【现场】父探针：删它会提示要补 --force（本轮清）」'))
    expect(queryByText(/确认要删请加 --force/)).toBeNull()
    expect(queryByText(/todo children/)).toBeNull()
    expect(queryByText(/b8a4da16-e22f-4eab/)).toBeNull()
  })

  it('2. 待审批事项支持点击「查看详情」展开查看目标事项描述、状态，并可打开事项详情抽屉', async () => {
    setupMockData({
      grants: [
        {
          id: 'grant-pending-1',
          agentId: 'agent:penguin',
          scope: 'destructive',
          status: 'pending',
          command: 'todo rm',
          summary: 'todo rm「【审批预览】测试父事项」',
          targetIds: ['d40438f0-6f72-421c-a427-fad7c044b365'],
          requestArgv: ['todo', 'rm', 'd40438f0', '--yes'],
          createdAt: '2026-10-27T15:57:00.000Z',
          expiresAt: null
        }
      ]
    })
    const { getByText, queryByText } = render(<ApprovalView />)

    await waitFor(() => {
      expect(getByText('删除事项「【审批预览】测试父事项」')).toBeTruthy()
    })

    // 待审批卡片副标题不再暴露 `todo rm d40438f0 --yes`
    expect(queryByText(/todo rm d40438f0/)).toBeNull()

    // 卡 66be78f4：首次同意那条按钮按档位叫「允许一次」（删除档是一次性授权），
    // 且不许再出现「允许并执行」这种把副作用塞进按钮名的写法
    expect(getByText('允许一次')).toBeTruthy()
    expect(queryByText('允许并执行')).toBeNull()

    // 点击「查看详情」展开目标事项内容
    fireEvent.click(getByText('查看详情'))
    expect(getByText('这是待删除事项的详细描述内容')).toBeTruthy()

    // 点击「打开事项详情」唤起右侧详情抽屉
    fireEvent.click(getByText('打开事项详情'))
    expect(invokeMock).toHaveBeenCalledWith('window:showQuickAdd', {
      todoId: 'd40438f0-6f72-421c-a427-fad7c044b365'
    })
  })

  it('3. 审批记录表格具备 7 列纯文字表头（申请类型独立成列），且使用自定义浮层菜单替代原生 <select>', async () => {
    setupMockData()
    const { getByLabelText, getByRole, getAllByText, queryByText } = render(<ApprovalView />)

    await waitFor(() => {
      expect(getByLabelText('审批记录表头')).toBeTruthy()
      expect(getAllByText('操作授权').length).toBeGreaterThanOrEqual(2)
    })

    const header = getByLabelText('审批记录表头')
    expect(header.textContent).toContain('申请类型')
    expect(header.textContent).toContain('申请内容')
    expect(header.textContent).toContain('所属范围')
    expect(header.textContent).toContain('申请人')
    expect(header.textContent).toContain('审批结果')
    expect(header.textContent).toContain('执行结果')
    expect(header.textContent).toContain('时间')

    // 表头不再使用 Windows 原生 <select>
    expect(header.querySelectorAll('select').length).toBe(0)

    // 行内第一列直接用纯文字显示申请类型（操作授权 / 协议修改）
    expect(getAllByText('操作授权').length).toBeGreaterThanOrEqual(2)
    expect(getAllByText('协议修改').length).toBeGreaterThanOrEqual(1)

    // 审批结果与执行结果各自独立展示，不再合并为易换行的「已批准 · 已执行」
    expect(queryByText('已批准 · 已执行')).toBeNull()
    expect(getAllByText('已批准').length).toBeGreaterThanOrEqual(2)
    expect(getAllByText('已执行').length).toBeGreaterThanOrEqual(1)
    expect(getAllByText('执行失败').length).toBeGreaterThanOrEqual(1)

    // 点击表头自定义筛选按钮展开浮层菜单（role="listbox"），选择「已拒绝」后触发筛选并回显
    const decisionFilterBtn = getByLabelText('按审批结果筛选')
    expect(header.contains(decisionFilterBtn)).toBe(true)
    fireEvent.click(decisionFilterBtn)

    const listbox = getByRole('listbox', { name: '审批结果筛选项' })
    expect(listbox).toBeTruthy()
    const rejectedOption = Array.from(listbox.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent?.includes('已拒绝')
    ) as HTMLElement
    expect(rejectedOption).toBeTruthy()
    fireEvent.click(rejectedOption)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'approval:listHistory',
        expect.objectContaining({ decision: 'rejected' })
      )
    })
    expect(header.textContent).toContain('· 已拒绝')
  })

  it('4. 横幅点「允许一次」撞上二次确认后，切到审批页仍可在待审批队列看到该条目并执行「仍然删除」或「放弃」（卡 fe05ce28）', async () => {
    setupMockData({
      grants: [
        {
          id: 'grant-force-pending-1',
          agentId: 'agent:bob',
          scope: 'destructive',
          status: 'granted',
          execStatus: 'error',
          execError:
            '这条还有 1 个子任务，删除会让它们解绑（子任务本身保留，但不再挂在它下面）。确认要删请加 --force；想先看是哪几条，用 `todo children <id>`',
          command: 'todo rm',
          summary: 'todo rm「【现场4长标题】这是一条专门用来验证六十四字超长标题在首屏与审批页均完整显示且可续办的父探针事项」',
          targetIds: ['d40438f0-6f72-421c-a427-fad7c044b365'],
          requestArgv: ['todo', 'rm', 'd40438f0', '--yes'],
          createdAt: '2026-10-28T02:57:00.000Z',
          expiresAt: new Date(Date.now() + 3600_000).toISOString()
        }
      ]
    })

    const { getByText, getAllByText } = render(<ApprovalView />)

    await waitFor(() => {
      expect(getByText('需二次确认')).toBeTruthy()
      expect(
        getByText('删除事项「【现场4长标题】这是一条专门用来验证六十四字超长标题在首屏与审批页均完整显示且可续办的父探针事项」')
      ).toBeTruthy()
    })

    // 待处理卡片直接提供「放弃」与「仍然删除」按钮
    fireEvent.click(getAllByText('仍然删除')[0])
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('agent:resolveGrant', {
        grantId: 'grant-force-pending-1',
        allow: true,
        longTerm: false,
        withForce: true
      })
    })

    fireEvent.click(getAllByText('放弃')[0])
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('agent:resolveGrant', {
        grantId: 'grant-force-pending-1',
        allow: false,
        longTerm: false,
        withForce: false
      })
    })
  })
})
