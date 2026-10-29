// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ChipsBar } from '../../../src/renderer/components/kanban/ChipsBar'
import { SearchBar } from '../../../src/renderer/components/kanban/SearchBar'
import { BatchBar } from '../../../src/renderer/components/kanban/BatchBar'
import { GlobalSearchView } from '../../../src/renderer/components/workbench/GlobalSearchView'
import { ProjectOverviewView } from '../../../src/renderer/components/project/ProjectOverviewView'
import { HandoffRevisionsDrawer } from '../../../src/renderer/components/project/HandoffRevisionsDrawer'
import { useUIStore } from '../../../src/renderer/stores/ui.store'
import { useProjectStore } from '../../../src/renderer/stores/project.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'

const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

describe('项目看板与相关页面设计系统统一验证', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, humanName: 'Alex' }
    }))
    useProjectStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'DeskPartner',
          color: '#5388F6',
          sortOrder: 0,
          archived: false,
          handoffMarkdown: '',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z'
        }
      ],
      loading: false
    } as never)
  })

  it('1. 进入项目空间但未选筛选条件时，ChipsBar 不再把当前项目导航渲染为冗余的「项目 xxx ×」筛选条', () => {
    useUIStore.setState({
      workspaceMode: 'project',
      filterProject: 'p1',
      filterStatus: null,
      filterCategory: null,
      filterOwner: 'all',
      filterPriority: 'all',
      filterType: 'all',
      filterFixedIn: null,
      searchKeyword: '',
      viewScope: 'all'
    })
    const { container } = render(<ChipsBar visibleCount={11} />)
    expect(container.firstChild).toBeNull()
  })

  it('2. SearchBar 与 GlobalSearchView 全部使用自定义下拉与胶囊控件，零原生 <select>', () => {
    useUIStore.setState({
      workspaceMode: 'project',
      filterProject: 'p1'
    })
    const { container: searchContainer } = render(<SearchBar visibleCount={11} />)
    expect(searchContainer.querySelectorAll('select').length).toBe(0)

    const { container: globalSearchContainer } = render(
      <GlobalSearchView onOpenTodo={() => {}} onOpenProject={() => {}} />
    )
    expect(globalSearchContainer.querySelectorAll('select').length).toBe(0)
  })

  it('3. 项目概览与接手说明修订历史抽屉通过 ownerLabel 展示友好名称，不裸露 agent:penguin 或 human', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'project:detail') {
        return {
          project: {
            id: 'p1',
            name: 'DeskPartner',
            color: '#5388F6',
            archived: false,
            handoffMarkdown: '# 说明',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z'
          },
          handoffRevisionCount: 1,
          overview: {
            total: 1,
            statusCounts: {
              proposed: 0,
              todo: 0,
              in_progress: 1,
              awaiting_review: 0,
              suspended: 0,
              done: 0,
              discarded: 0
            },
            items: [
              {
                id: 't1',
                title: '待处理任务示例',
                status: 'in_progress',
                priority: 'normal',
                type: 'task',
                executedBy: 'agent:penguin',
                updatedAt: '2026-10-28T00:00:00.000Z'
              }
            ]
          }
        }
      }
      if (channel === 'release:list') return []
      if (channel === 'project:handoffRevisions') {
        return [
          {
            id: 'r1',
            projectId: 'p1',
            seq: 1,
            body: '# 说明',
            author: 'human',
            kind: 'save',
            sourceSeq: null,
            createdAt: '2026-10-28T00:00:00.000Z',
            isCurrent: true
          }
        ]
      }
      return null
    })

    render(
      <>
        <ProjectOverviewView projectId="p1" onOpenItems={() => {}} onOpenVersions={() => {}} />
        <HandoffRevisionsDrawer projectId="p1" open onClose={() => {}} />
      </>
    )

    await waitFor(() => {
      expect(screen.getByText('待处理任务示例')).toBeTruthy()
      expect(screen.getByText('Alex')).toBeTruthy()
    })

    expect(screen.queryByText('agent:penguin')).toBeNull()
    expect(screen.queryByText('human')).toBeNull()
  })

  it('4. 看板筛选器与批量操作栏字段名对齐详情抽屉（标签/提出者/执行人/解决版本/创建时间/截止时间，卡 dffab894）', () => {
    useUIStore.setState({
      workspaceMode: 'project',
      filterProject: 'p1',
      multiSelectMode: true,
      selectedIds: ['t1']
    })

    const { getByText } = render(
      <>
        <SearchBar visibleCount={11} />
        <BatchBar />
      </>
    )

    // 筛选栏字段与详情抽屉一一对齐，不再使用含糊的「全部分类 / 全部归属 / 全部版本 / 全部时间」
    expect(getByText('全部标签')).toBeTruthy()
    expect(getByText('全部提出者')).toBeTruthy()
    expect(getByText('全部执行人')).toBeTruthy()
    expect(getByText('全部解决版本')).toBeTruthy()
    expect(getByText('全部创建时间')).toBeTruthy()
    expect(getByText('截止时间')).toBeTruthy()

    // 批量栏按钮与详情抽屉术语一致
    expect(getByText('改执行人')).toBeTruthy()
    expect(getByText('改项目')).toBeTruthy()
    expect(getByText('改标签')).toBeTruthy()
  })
})
