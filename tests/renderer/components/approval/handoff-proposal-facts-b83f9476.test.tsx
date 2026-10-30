// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ApprovalView } from '../../../../src/renderer/components/approval/ApprovalView'
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'
import { useTodoStore } from '../../../../src/renderer/stores/todo.store'
import { useProjectStore } from '../../../../src/renderer/stores/project.store'

/**
 * 卡 `b83f9476`：接手提议带事实快照与来源事项，复核界面并排看"提议依据的事实"与"当前事实"。
 */
const invokeMock = vi.fn()

vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

describe('接手提议复核界面：提议依据的事实 vs 当前事实并排视图（卡 b83f9476）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, humanName: '主用户' }
    }))
    useProjectStore.setState((state) => ({
      ...state,
      projects: [{ id: 'proj-1', name: 'DeskPartner', color: '#5388F6', archived: false, sortOrder: 0, createdAt: '2026-10-01T00:00:00.000Z', handoffMarkdown: '旧说明' }]
    }))
    useTodoStore.setState((state) => ({
      ...state,
      todos: [
        {
          id: 'ce43b4ba-1111-2222-3333-444455556666',
          title: 'work next 选工作入口',
          description: '',
          status: 'in_progress',
          priority: 'high',
          type: 'task',
          categoryIds: [],
          categoryId: null,
          projectId: 'proj-1',
          parentId: null,
          createdBy: 'agent:carol',
          executedBy: 'agent:carol',
          verifier: 'human',
          fixedInVersion: null,
          dueAt: null,
          remindAt: null,
          isPinned: false,
          createdAt: '2026-10-28T00:00:00.000Z',
          updatedAt: '2026-10-28T01:00:00.000Z',
          completedAt: null
        }
      ]
    }))
  })

  it('并排展示「提议依据的事实」（含版本/schema/计数/主线/来源事项）与「当前事实」，并在事实变化时给出提示', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'agent:list':
          return [{ id: 'agent:carol', displayName: 'Carol', approved: true }]
        case 'agent:listGrants':
        case 'profile:proposals':
        case 'protocol:proposals':
        case 'rules:proposals':
          return []
        case 'project:list':
          return [{ id: 'proj-1', name: 'DeskPartner', archived: false }]
        case 'project:handoffProposals':
          return [
            {
              id: 'prop-1',
              projectId: 'proj-1',
              body: '# 新接手说明\n已升到 1.0.124',
              originalBody: '# 旧接手说明\n1.0.97',
              currentBody: '# 旧接手说明\n1.0.97',
              baseRevision: 4,
              decidedBody: null,
              proposer: 'agent:carol',
              status: 'pending',
              decidedBy: null,
              decidedAt: null,
              createdAt: '2026-10-28T10:00:00.000Z',
              stale: false,
              factsSnapshot: {
                version: '1.0.124',
                schemaVersion: 46,
                statusCounts: {
                  proposed: 2,
                  todo: 5,
                  in_progress: 1,
                  suspended: 0,
                  awaiting_review: 3,
                  done: 500,
                  discarded: 20
                },
                openTotal: 11,
                mainTodo: {
                  id: 'ce43b4ba-1111-2222-3333-444455556666',
                  title: 'work next 选工作入口',
                  status: 'in_progress',
                  updatedAt: '2026-10-28T01:00:00.000Z'
                }
              },
              currentFacts: {
                version: '1.0.125',
                schemaVersion: 47,
                statusCounts: {
                  proposed: 2,
                  todo: 4,
                  in_progress: 0,
                  suspended: 0,
                  awaiting_review: 4,
                  done: 501,
                  discarded: 20
                },
                openTotal: 10,
                mainTodo: {
                  id: '607871b2-aaaa-bbbb-cccc-ddddeeeeffff',
                  title: '接手说明自动更新伞卡',
                  status: 'todo',
                  updatedAt: '2026-10-28T12:00:00.000Z'
                }
              },
              sourceTodoIds: ['ce43b4ba-1111-2222-3333-444455556666']
            }
          ]
        case 'approval:listHistory':
          return { total: 0, offset: 0, limit: 20, rows: [] }
        default:
          return null
      }
    })

    const { getByTestId } = render(<ApprovalView />)
    const compare = await waitFor(() => getByTestId('handoff-facts-compare'))
    const text = compare.textContent ?? ''

    expect(text).toContain('提议依据的事实')
    expect(text).toContain('1.0.124 · schema v46')
    expect(text).toContain('ce43b4ba work next 选工作入口')
    expect(text).toContain('来源事项：ce43b4ba work next 选工作入口')

    expect(text).toContain('当前事实')
    expect(text).toContain('1.0.125 · schema v47')
    expect(text).toContain('607871b2 接手说明自动更新伞卡')
    expect(text).toContain('提议后事实有变化')
  })

  it('未过期时正文只渲染 2 列（不重复展示相同的修改前内容）且左右等高；stale 时才展开 3 列', async () => {
    let staleFlag = false
    invokeMock.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'agent:list':
          return [{ id: 'agent:carol', displayName: 'Carol', approved: true }]
        case 'agent:listGrants':
        case 'profile:proposals':
        case 'protocol:proposals':
        case 'rules:proposals':
          return []
        case 'project:list':
          return [{ id: 'proj-1', name: 'DeskPartner', archived: false }]
        case 'project:handoffProposals':
          return [
            {
              id: 'prop-2',
              projectId: 'proj-1',
              body: '# 新接手说明',
              originalBody: '# 基准说明',
              currentBody: staleFlag ? '# 后来被别人改过的当前说明' : '# 基准说明',
              baseRevision: 4,
              decidedBody: null,
              proposer: 'agent:carol',
              status: 'pending',
              decidedBy: null,
              decidedAt: null,
              createdAt: '2026-10-28T10:00:00.000Z',
              stale: staleFlag
            }
          ]
        case 'approval:listHistory':
          return { total: 0, offset: 0, limit: 20, rows: [] }
        default:
          return null
      }
    })

    const { container, unmount } = render(<ApprovalView />)
    await waitFor(() => expect(container.textContent).toContain('当前生效内容'))
    expect(container.textContent).not.toContain('提议基准内容')
    const textarea = container.querySelector('textarea')
    expect(textarea?.className).toContain('flex-1')
    expect(textarea?.className).toContain('min-h-80')
    unmount()

    staleFlag = true
    const { container: c2 } = render(<ApprovalView />)
    await waitFor(() => expect(c2.textContent).toContain('提议基准内容'))
    expect(c2.textContent).toContain('当前生效内容')
  })
})
