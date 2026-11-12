// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { NotificationsView } from '../../../src/renderer/components/notification/NotificationsView'
import { useUIStore } from '../../../src/renderer/stores/ui.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'
import fs from 'node:fs'
import path from 'node:path'

const invokeMock = vi.fn()
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

/**
 * 点事项 = 就地展开右栏（卡 `615dd2d9`）
 *
 * 右栏是**窗口级**的（`windows/Kanban.tsx` 的 `kanban-content` 右侧），对窗口里
 * 所有页面都生效 —— 所以这 6 处入口要做的只有一件事：把选中项交给 `openTodoDetail`，
 * 而不是再开一个独立贴右窗口。这条用例盯的正是"到底走了哪条路"。
 */
const row = (over: Record<string, unknown>) => ({
  id: 'notif-1',
  type: 'review',
  title: '待验收：详情外壳再统一一批',
  summary: '跑完了，等你验',
  refId: 'todo-1',
  actor: 'agent:penguin',
  recipient: null,
  status: 'unread',
  readBy: null,
  readAt: null,
  meta: null,
  createdAt: '2026-11-12T09:00:00.000Z',
  projectId: null,
  todoId: 'todo-1',
  ...over
})

function setupInbox(rows: ReturnType<typeof row>[]) {
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'agent:list') return []
    if (channel === 'notification:listWithProject') {
      return {
        matched: rows.length,
        returned: rows.length,
        truncated: false,
        nextOffset: null,
        unread: 0,
        byType: {},
        rows
      }
    }
    return { ok: true }
  })
}

beforeEach(() => {
  invokeMock.mockReset()
  useUIStore.setState({ selectedTodoId: null, mainView: 'notifications' })
  useSettingsStore.setState({ settings: { humanName: '木木' } as never })
})

describe('页面里点事项就展开右栏（卡 615dd2d9）', () => {
  it('通知页：点一条待验收 → 交给 openTodoDetail，不再开独立窗口', async () => {
    setupInbox([row({})])
    const { getByText } = render(<NotificationsView />)
    const title = await waitFor(() => getByText('待验收：详情外壳再统一一批'))
    fireEvent.click(title.closest('button')!)

    await waitFor(() => expect(useUIStore.getState().selectedTodoId).toBe('todo-1'))
    const channels = invokeMock.mock.calls.map((c) => String(c[0]))
    expect(channels).not.toContain('window:showQuickAdd')
    // 标已读照旧（右栏就地展开不影响"点过即已读"）
    expect(channels).toContain('notification:markRead')
  })

  it('待拍板那条也不切页：就地打开右栏，人还在通知里', async () => {
    setupInbox([row({ id: 'notif-2', type: 'decision', title: '待你拍板：附件读内容这一档' })])
    const { getByText } = render(<NotificationsView />)
    const title = await waitFor(() => getByText('待你拍板：附件读内容这一档'))
    fireEvent.click(title.closest('button')!)

    await waitFor(() => expect(useUIStore.getState().selectedTodoId).toBe('todo-1'))
    expect(useUIStore.getState().mainView).not.toBe('board')
  })

  it('窗口级右栏：这 6 处入口都不再自己开窗口（源码闸门）', () => {
    const root = path.resolve(__dirname, '../../..')
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')
    const entries: Array<[string, string]> = [
      ['src/renderer/components/notification/NotificationsView.tsx', "openTodoDetail(n.refId)"],
      ['src/renderer/components/approval/ApprovalView.tsx', 'openTodoDetail(targetTodo.id)'],
      ['src/renderer/components/releases/ReleasesView.tsx', 'openTodoDetail(t.id)'],
      ['src/renderer/components/timeline/TimelineView.tsx', 'openTodoDetail(todo.id)'],
      ['src/renderer/components/project/ProjectOverviewView.tsx', 'openTodoDetail(item.id)'],
      ['src/renderer/components/project/ProjectDocsView.tsx', 'openTodoDetail(t.id)']
    ]
    for (const [file, call] of entries) {
      const src = read(file)
      expect(src, `${file} 没走右栏`).toContain(call)
      expect(src, `${file} 还留着开独立窗口的入口`).not.toContain('window:showQuickAdd')
    }

    /**
     * 右栏必须是**窗口级**：`TodoDetailPanel` 挂在 `kanban-content` 里、不在任何
     * `mainView === ...` 条件内 —— 否则换了页面右栏就不出来，这 6 处改了也白改。
     */
    const kanban = read('src/renderer/windows/Kanban.tsx')
    const contentStart = kanban.indexOf('data-testid="kanban-content"')
    expect(contentStart, 'kanban-content 不见了').toBeGreaterThan(-1)
    const tail = kanban.slice(contentStart)
    expect(tail).toContain('<TodoDetailPanel')
    expect(tail).toContain('{selectedTodoId && (')

    /**
     * 悬浮球面板**保留**开独立窗口（不是漏改）：那个窗口固定 320×420，
     * 右栏最小宽度 360 —— 物理上装不下，且它自己就是一个浮窗。
     */
    const panel = read('src/renderer/components/panel/PanelContent.tsx')
    expect(panel).toContain("invoke('window:showQuickAdd', { todoId: id })")
    const windows = read('src/main/windows.ts')
    expect(windows).toContain('const W = 320')
  })
})
