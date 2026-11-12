// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import React from 'react'
import { QuickAddForm } from '../../../src/renderer/components/quick-add/QuickAddForm'
import { useTodoStore } from '../../../src/renderer/stores/todo.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'

/**
 * 详情指向的事项已经不在时，别再摆一张能填的空表（卡 `bfdc8cc1`）
 *
 * 通知里的 refId 指向的事项被删掉之后，点开仍然进详情：装载逻辑是 `todos.find(...)`，
 * 找不到就什么都不做 —— 于是标题、描述、状态全空，底部还有「提交保存」，
 * 填完才以 not_found 收场。这里钉住两件事：
 * ① 找不到（且 store 已经加载完、主进程也说没有）→ 只给一句说明，**不渲染保存**；
 * ② 分得清"还没加载完"：loading 时不许提前判死，事项就在 store 里时也不许误判。
 */
const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const todoOf = (id: string, title: string) =>
  ({
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'normal',
    type: 'task',
    createdBy: 'human',
    projectId: 'p1',
    categoryIds: [],
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z'
  }) as never

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'todo:getById':
        return null
      case 'agent:list':
      case 'todo:timeline':
      case 'todo:comments':
      case 'todo:attachments':
        return []
      case 'app:info':
        return { version: '1.0.146' }
      default:
        return null
    }
  })
  useTodoStore.setState({ todos: [], loading: false })
  useSettingsStore.setState({ settings: { humanName: 'Alex' } as never })
})

afterEach(() => cleanup())

describe('详情指向的事项已经不在（bfdc8cc1）', () => {
  it('找不到那一条：给一句说明，不渲染「提交保存」', async () => {
    render(<QuickAddForm embeddedTodoId="gone-0001" />)
    await waitFor(() => expect(screen.getByTestId('todo-detail-missing')).toBeTruthy())
    expect(screen.getByText('这条事项已经不存在')).toBeTruthy()
    expect(screen.queryByText('提交保存')).toBeNull()
    expect(screen.queryByText('取消')).toBeNull()
    // 也不能再摆出一张空标题输入框等人填
    expect(document.querySelector('[data-testid="todo-detail-missing"] input')).toBeNull()
  })

  it('事项就在 store 里：正常渲染表单，不误判成"已经不在"', async () => {
    useTodoStore.setState({ todos: [todoOf('alive-01', '这条还在')], loading: false })
    render(<QuickAddForm embeddedTodoId="alive-01" />)
    await waitFor(() => expect(screen.queryByTestId('todo-detail-missing')).toBeNull())
    expect(screen.getByText('提交保存')).toBeTruthy()
    // 主进程那条路根本不该被问到（store 里明明有）
    expect(invokeMock.mock.calls.map((c) => String(c[0]))).not.toContain('todo:getById')
  })

  it('store 还在加载：先别下结论（不许闪一句"已经不存在"）', async () => {
    useTodoStore.setState({ todos: [], loading: true })
    render(<QuickAddForm embeddedTodoId="late-001" />)
    // 给他一点时间，确认不会在加载期间判死
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByTestId('todo-detail-missing')).toBeNull()
    expect(invokeMock.mock.calls.map((c) => String(c[0]))).not.toContain('todo:getById')
  })

  it('新建模式不受影响（没有 id 就不该问"这条在不在"）', async () => {
    render(<QuickAddForm />)
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByTestId('todo-detail-missing')).toBeNull()
    expect(invokeMock.mock.calls.map((c) => String(c[0]))).not.toContain('todo:getById')
  })
})
