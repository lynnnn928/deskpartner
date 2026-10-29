// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { NotificationsView } from '../../../../src/renderer/components/notification/NotificationsView'
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'

const invokeMock = vi.fn()

vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

function setupMockInbox() {
  invokeMock.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'agent:list':
        return [
          { id: 'agent:penguin', displayName: 'PenguinHarness', approved: true },
          { id: 'agent:bob', displayName: 'Bob', approved: true },
          { id: 'agent:alice', displayName: 'Alice', approved: true }
        ]
      case 'notification:listWithProject':
        return {
          matched: 4,
          returned: 4,
          truncated: false,
          nextOffset: null,
          unread: 2,
          byType: {
            exec_result: { total: 3, unread: 2 },
            memo: { total: 1, unread: 0 }
          },
          rows: [
            {
              id: 'notif-1',
              type: 'exec_result',
              title: '已通过并执行：todo rm「演示：横幅验收（父卡，会被删）」',
              summary: '已按你的允许执行完毕',
              refId: 'grant-1',
              actor: 'agent:penguin',
              recipient: null,
              status: 'unread',
              readBy: null,
              readAt: null,
              meta: '{"ok":true}',
              createdAt: '2026-10-27T11:44:00.000Z',
              projectId: null,
              todoId: null
            },
            {
              id: 'notif-2',
              type: 'exec_result',
              title: '执行失败：todo rm「v111探针（本轮清）撤销恢复」',
              summary:
                '这条还有 1 个子任务，删除会让它们解绑（子任务本身保留，但不再挂在它下面）。确认要删请加 --force；想先看是哪几条，用 `todo children <id>`',
              refId: 'grant-2',
              actor: 'agent:bob',
              recipient: null,
              status: 'read',
              readBy: 'human',
              readAt: '2026-10-26T09:00:00.000Z',
              meta: '{"ok":false}',
              createdAt: '2026-10-26T09:00:00.000Z',
              projectId: null,
              todoId: null
            },
            {
              id: 'notif-3',
              type: 'exec_result',
              title: '已通过并执行：release rm「DeskPartner 9.9.8」',
              summary: '已执行：release rm 9.9.8 --project DeskPartner --yes',
              refId: 'grant-3',
              actor: 'agent:bob',
              recipient: null,
              status: 'read',
              readBy: 'human',
              readAt: '2026-10-21T15:53:00.000Z',
              meta: '{"ok":true}',
              createdAt: '2026-10-21T15:53:00.000Z',
              projectId: null,
              todoId: null
            },
            {
              id: 'notif-4',
              type: 'memo',
              title: '回 ea6011f9：gates.ts 与 no-emoji.test.ts 我这边有在途改动，…',
              summary:
                '回 ea6011f9：gates.ts 与 no-emoji.test.ts 我这边有在途改动，可直接收编，署名随意。',
              refId: 'memo-1',
              actor: 'agent:bob',
              recipient: null,
              status: 'read',
              readBy: 'human',
              readAt: '2026-10-09T00:39:00.000Z',
              meta: null,
              createdAt: '2026-10-09T00:39:00.000Z',
              projectId: null,
              todoId: null
            }
          ]
        }
      case 'notification:markRead':
        return { ok: true }
      default:
        return null
    }
  })
}

describe('NotificationsView 视觉与人话化改造验证', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, humanName: 'Alex' }
    }))
  })

  it('1. 移除顶部「有 N 条通知未归属项目」黄色警告条，采用 5 列纯文字表头与自定义浮层筛选', async () => {
    setupMockInbox()
    const { getByLabelText, getByRole, queryByText } = render(<NotificationsView />)

    await waitFor(() => {
      expect(getByLabelText('通知列表表头')).toBeTruthy()
    })

    // 不再显示无意义的黄色警告横幅
    expect(queryByText(/条通知未归属项目/)).toBeNull()

    const header = getByLabelText('通知列表表头')
    expect(header.textContent).toContain('通知类型')
    expect(header.textContent).toContain('通知内容')
    expect(header.textContent).toContain('来源')
    expect(header.textContent).toContain('状态')
    expect(header.textContent).toContain('时间')

    // 表头不使用原生 <select>
    expect(header.querySelectorAll('select').length).toBe(0)

    // 点击「通知类型」表头展开自定义浮层菜单（role="listbox"）
    const filterBtn = getByLabelText('按通知类型筛选')
    fireEvent.click(filterBtn)
    const listbox = getByRole('listbox', { name: '通知类型筛选项' })
    expect(listbox).toBeTruthy()
  })

  it('2. 彻底消除 todo rm / release rm 等命令前缀与 --force / --yes 底层回执，来源显示 Agent 友好名称', async () => {
    setupMockInbox()
    const { getByText, getAllByText, queryByText } = render(<NotificationsView />)

    await waitFor(() => {
      expect(getByText('已通过并执行：删除事项「演示：横幅验收（父卡，会被删）」')).toBeTruthy()
    })

    // 命令原文已被替换为人话
    expect(getByText('执行失败：删除事项「v111探针（本轮清）撤销恢复」')).toBeTruthy()
    expect(getByText('已通过并执行：删除版本「DeskPartner 9.9.8」')).toBeTruthy()
    expect(queryByText(/todo rm/)).toBeNull()
    expect(queryByText(/release rm/)).toBeNull()

    // 失败项直接在副标题展示人话原因，不暴露 `--force` 与 `todo children`
    expect(
      getByText('该事项下包含 1 个子任务，需二次确认后删除（删除后子任务将保留为独立事项）。')
    ).toBeTruthy()
    expect(queryByText(/--force/)).toBeNull()
    expect(queryByText(/todo children/)).toBeNull()

    // 来源列展示 Agent 显示名称而非裸 id
    expect(getAllByText('PenguinHarness').length).toBeGreaterThanOrEqual(1)
    expect(getAllByText('Bob').length).toBeGreaterThanOrEqual(1)

    // 点击展开成功回执，验证展开详情卡片中不再显示 `已执行：release rm 9.9.8 --project DeskPartner --yes`
    fireEvent.click(getByText('已通过并执行：删除版本「DeskPartner 9.9.8」'))
    expect(queryByText(/--project DeskPartner --yes/)).toBeNull()
    expect(getByText('在审批记录中查看')).toBeTruthy()
  })

  it('3. 备忘展开后展示结构化阅读卡片（发件人、时间、正文框与操作按钮）', async () => {
    setupMockInbox()
    const { getByText } = render(<NotificationsView />)

    await waitFor(() => {
      expect(getByText('回 ea6011f9：gates.ts 与 no-emoji.test.ts 我这边有在途改动，…')).toBeTruthy()
    })

    fireEvent.click(getByText('回 ea6011f9：gates.ts 与 no-emoji.test.ts 我这边有在途改动，…'))
    expect(
      getByText('回 ea6011f9：gates.ts 与 no-emoji.test.ts 我这边有在途改动，可直接收编，署名随意。')
    ).toBeTruthy()
    expect(getByText('转为事项')).toBeTruthy()
    expect(getByText('删除')).toBeTruthy()
  })
})
