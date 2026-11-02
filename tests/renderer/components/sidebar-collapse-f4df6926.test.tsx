import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import React from 'react'

/**
 * 侧栏收起态（卡 `f4df6926`）
 *
 * 这一条守的是"收起之后还能不能用"：入口还在、当前项还能认出来、能一键展开。
 * 展开态那棵树是 1.0.114 定稿的，收起态刻意写成独立分支，所以这里分别验两棵树
 * 各自有一个开关按钮，且点了真的会翻状态。
 */
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async () => ({ ok: false }))
}))

import { Sidebar } from '../../../src/renderer/components/kanban/Sidebar'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

const setCollapsed = (value: boolean) =>
  useUIStore.setState({ sidebarCollapsed: value, mainView: 'board' })

describe('左侧边栏收起（卡 f4df6926）', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setCollapsed(false)
  })

  afterEach(() => cleanup())

  it('store：默认展开，toggle 会翻转并写进 localStorage', () => {
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarCollapsed).toBe(true)
    expect(window.localStorage.getItem('deskpartner.sidebarCollapsed')).toBe('1')
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    expect(window.localStorage.getItem('deskpartner.sidebarCollapsed')).toBe('0')
  })

  it('收起态：只剩图标轨道，四个工作台入口仍可点，且能一键展开', async () => {
    setCollapsed(true)
    await act(async () => {
      render(<Sidebar />)
    })

    expect(screen.getByTestId('sidebar-rail')).toBeTruthy()
    for (const label of ['我的工作', '通知', '审批', '统计']) {
      expect(screen.getByRole('button', { name: label }), label).toBeTruthy()
    }
    // 展开态的分组标题与项目名不再出现（收起态靠悬停标题给名字）
    expect(screen.queryByText('工作台')).toBeNull()

    fireEvent.click(screen.getByTestId('sidebar-expand-btn'))
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
  })

  it('展开态：有折叠按钮，点了切到收起态', async () => {
    setCollapsed(false)
    await act(async () => {
      render(<Sidebar />)
    })

    const btn = screen.getByTestId('sidebar-collapse-btn')
    expect(screen.queryByTestId('sidebar-rail')).toBeNull()
    fireEvent.click(btn)
    expect(useUIStore.getState().sidebarCollapsed).toBe(true)
  })
})
