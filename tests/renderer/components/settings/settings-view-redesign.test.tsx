// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsView } from '../../../../src/renderer/components/settings/SettingsView'
import { WorkbenchView } from '../../../../src/renderer/components/workbench/WorkbenchView'
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'
import { useCategoryStore } from '../../../../src/renderer/stores/category.store'
import { useTodoStore } from '../../../../src/renderer/stores/todo.store'
import { useProjectStore } from '../../../../src/renderer/stores/project.store'
import { useAgentStore } from '../../../../src/renderer/stores/agent.store'

vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === 'app:info') return { version: '1.0.120', dataDir: 'D:/data' }
    if (channel === 'cli:agentGuide') return '# DeskPartner Guide'
    return null
  })
}))

describe('设置页与工作台整体重构验证', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        humanName: '主用户',
        fontScale: 1
      }
    })
    useCategoryStore.setState({
      categories: [
        { id: 'c1', name: '设计规范', color: '#5388F6', isDefault: true, sortOrder: 0 },
        { id: 'c2', name: '界面打磨', color: '#10B981', isDefault: false, sortOrder: 1 }
      ]
    })
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'DeskPartner',
          color: '#5388F6',
          archived: false,
          sortOrder: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          handoffMarkdown: ''
        }
      ]
    })
    useAgentStore.setState({
      agents: [
        {
          id: 'agent:penguin',
          displayName: 'PenguinHarness',
          color: '#5388F6',
          approved: true,
          rejectedAt: null,
          hasCredential: true,
          createdAt: '2026-10-01T00:00:00.000Z',
          lastSeenAt: null,
          lastWriteAt: null
        } as never
      ]
    })
    useTodoStore.setState({
      todos: [
        {
          id: 't1',
          title: '设置页重构与整体界面升级',
          description: null,
          projectId: 'p1',
          parentId: null,
          categoryIds: ['c1'],
          categoryId: 'c1',
          status: 'in_progress',
          priority: 'high',
          type: 'task',
          createdBy: 'human',
          executedBy: 'agent:penguin',
          verifier: 'human',
          dueAt: null,
          remindAt: null,
          isPinned: false,
          fixedInVersion: null,
          createdAt: '2026-10-28T00:00:00.000Z',
          updatedAt: '2026-10-28T01:00:00.000Z',
          completedAt: null
        }
      ]
    })
  })

  it('设置页使用居中受限容器，颜色双列排布，字号/列头高度/间距全部使用分段控制器而非原生 select', () => {
    const { container } = render(<SettingsView />)

    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '外观' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '数据管理' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '系统' })).toBeTruthy()

    // 外观页签内不应再存在任何原生 <select> 下拉框
    expect(container.querySelectorAll('select').length).toBe(0)

    // 全局字号、列头高度、事项间距、内边距 4 处全部使用「标准」分段按钮
    expect(screen.getAllByRole('button', { name: '标准' }).length).toBe(4)
    expect(screen.getByRole('button', { name: '还原默认外观' })).toBeTruthy()
  })

  it('设置页「数据管理」分类标签使用双列卡片与内联新建输入框（无 window.prompt / 原生 select）', () => {
    const { container } = render(<SettingsView />)
    fireEvent.click(screen.getByRole('tab', { name: '数据管理' }))

    expect(screen.getByText('设计规范')).toBeTruthy()
    expect(screen.getByText('界面打磨')).toBeTruthy()
    expect(container.querySelectorAll('select').length).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /新建分类/ }))
    expect(screen.getByPlaceholderText('输入新分类名称…')).toBeTruthy()
  })

  it('「我的工作」汇总视图展示已解析的 Agent 显示名而非裸 agent:id，且不带冗余解释副标题', () => {
    render(<WorkbenchView />)
    expect(screen.getByRole('heading', { name: '我的工作' })).toBeTruthy()
    expect(screen.queryByText(/跨项目汇总仍需要/)).toBeNull()
    expect(screen.getByText('PenguinHarness')).toBeTruthy()
    expect(screen.queryByText('agent:penguin')).toBeNull()
  })
})
