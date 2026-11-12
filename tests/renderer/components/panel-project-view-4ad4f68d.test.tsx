// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { PanelContent } from '../../../src/renderer/components/panel/PanelContent'
import {
  stageQuickAddTitle,
  takeStagedQuickAddTitle
} from '../../../src/renderer/lib/quick-add-handoff'
import { useTodoStore } from '../../../src/renderer/stores/todo.store'
import { useProjectStore } from '../../../src/renderer/stores/project.store'
import { useCategoryStore } from '../../../src/renderer/stores/category.store'
import type { Todo } from '../../../src/renderer/types/todo'

/**
 * 悬浮球面板：项目即视图、最新在前、能展开完整登记（卡 `4ad4f68d`）
 *
 * 三件事都是"接线"性质 —— 错了不报错，跑起来才看得见：
 * ① 项目按钮原来只管新增归属，清单与统计仍是全局的；
 * ② 排序方向（正序改倒序）；
 * ③ 面板那一句要能带去完整卡片，且不重复消费。
 */
const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

const makeTodo = (over: Partial<Todo> & { id: string }): Todo => ({
  title: over.id,
  description: null,
  status: 'todo',
  priority: 'normal',
  type: 'task',
  categoryIds: ['cat-1'],
  categoryId: 'cat-1',
  projectId: null,
  parentId: null,
  createdBy: 'human',
  executedBy: null,
  verifier: 'human',
  fixedInVersion: null,
  dueAt: null,
  remindAt: null,
  isPinned: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  ...over
} as Todo)

/** 今天完成的那条（要落在"今天"里，底部那句才数得到） */
const TODAY = new Date().toISOString()

const todos: Todo[] = [
  makeTodo({ id: 'deskpartner-新', projectId: 'proj-a', createdAt: '2026-10-30T00:00:00.000Z', title: '最近记的一条' }),
  makeTodo({ id: 'deskpartner-旧', projectId: 'proj-a', createdAt: '2026-10-02T00:00:00.000Z', title: '早先记的一条' }),
  makeTodo({ id: 'zhibi-一', projectId: 'proj-b', createdAt: '2026-10-15T00:00:00.000Z', title: '知彼项目的事' }),
  makeTodo({ id: '无归属一', projectId: null, createdAt: '2026-10-20T00:00:00.000Z', title: '没有项目的事' }),
  makeTodo({
    id: 'deskpartner-已完成',
    projectId: 'proj-a',
    status: 'done',
    completedAt: TODAY,
    createdAt: '2026-10-31T00:00:00.000Z',
    title: '今天做完的一条'
  }),
  makeTodo({
    id: '归档里的事',
    projectId: 'proj-archived',
    createdAt: '2026-10-29T00:00:00.000Z',
    title: '归档项目里的旧事项'
  })
]

describe('悬浮球面板：项目即视图 / 最新在前 / 完整登记（卡 4ad4f68d）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
    useCategoryStore.setState({
      categories: [
        { id: 'cat-1', name: '日常', color: '#5388F6', sortOrder: 0, createdAt: '2026-10-01T00:00:00.000Z' }
      ]
    })
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-a',
          name: 'DeskPartner',
          color: '#5388F6',
          archived: false,
          sortOrder: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          handoffMarkdown: ''
        },
        {
          id: 'proj-b',
          name: '知彼',
          color: '#F59E0B',
          archived: false,
          sortOrder: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
          handoffMarkdown: ''
        },
        {
          id: 'proj-archived',
          name: '已归档',
          color: '#10B981',
          archived: true,
          sortOrder: 2,
          createdAt: '2026-10-01T00:00:00.000Z',
          handoffMarkdown: ''
        }
      ]
    })
    useTodoStore.setState({ todos, createTodo: vi.fn().mockResolvedValue({}), updateTodo: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('默认视图是第一个在办项目：清单只剩它的事，数量与它一致', () => {
    const { container, getByTestId } = render(<PanelContent />)

    expect(getByTestId('panel-project-trigger').textContent).toContain('DeskPartner')
    // 只有 DeskPartner 下两条未完成的（今天做完那条不算、知彼那条不算、归档那条约不算）
    expect(getByTestId('panel-count').textContent).toContain('2 项事项')
    expect(container.textContent).toContain('最近记的一条')
    expect(container.textContent).toContain('早先记的一条')
    expect(container.textContent).not.toContain('知彼项目的事')
    expect(container.textContent).not.toContain('归档项目里的旧事项')
  })

  it('切项目 = 切视图：清单与「今天完成」都跟着换', () => {
    const { container, getByTestId, getAllByTestId } = render(<PanelContent />)
    expect(getByTestId('panel-done-today').textContent).toContain('今天完成 1 件')

    fireEvent.click(getByTestId('panel-project-trigger'))
    const zhibi = getAllByTestId('panel-project-option').find((b) => b.textContent?.includes('知彼'))
    expect(zhibi).toBeTruthy()
    fireEvent.click(zhibi as HTMLElement)

    expect(getByTestId('panel-project-trigger').textContent).toContain('知彼')
    expect(getByTestId('panel-count').textContent).toContain('1 项事项')
    expect(container.textContent).toContain('知彼项目的事')
    expect(container.textContent).not.toContain('最近记的一条')
    // 今天完成的是 DeskPartner 那条，知彼视图里该是 0
    expect(getByTestId('panel-done-today').textContent).toContain('今天完成 0 件')
  })

  it('列表按时间倒序：最新记的排在最上面', () => {
    const { container } = render(<PanelContent />)
    const text = container.textContent ?? ''
    const newest = text.indexOf('最近记的一条')
    const oldest = text.indexOf('早先记的一条')
    expect(newest).toBeGreaterThan(-1)
    expect(oldest).toBeGreaterThan(-1)
    expect(newest).toBeLessThan(oldest)
  })

  it('「未归属项目」只在真有这种事项时出现，且只装它们', () => {
    const { getByTestId, getAllByTestId, container } = render(<PanelContent />)
    fireEvent.click(getByTestId('panel-project-trigger'))
    const options = getAllByTestId('panel-project-option').map((b) => b.textContent ?? '')
    expect(options.some((t) => t.includes('未归属项目'))).toBe(true)

    fireEvent.click(getAllByTestId('panel-project-option').find((b) => b.textContent?.includes('未归属项目')) as HTMLElement)
    expect(getByTestId('panel-count').textContent).toContain('1 项事项')
    expect(container.textContent).toContain('没有项目的事')
    expect(container.textContent).not.toContain('最近记的一条')
  })

  it('没有未归属事项时，菜单里也不留那一档', () => {
    useTodoStore.setState({ todos: todos.filter((t) => t.projectId !== null) })
    const { getByTestId, getAllByTestId } = render(<PanelContent />)
    fireEvent.click(getByTestId('panel-project-trigger'))
    const options = getAllByTestId('panel-project-option').map((b) => b.textContent ?? '')
    expect(options.some((t) => t.includes('未归属项目'))).toBe(false)
  })

  it('在「未归属项目」视图里新增：落到第一个在办项目，视图跟着切过去', async () => {
    const createTodoSpy = vi.fn().mockResolvedValue({})
    useTodoStore.setState({ createTodo: createTodoSpy })
    const { getByTestId, getAllByTestId, getByPlaceholderText } = render(<PanelContent />)

    fireEvent.click(getByTestId('panel-project-trigger'))
    fireEvent.click(getAllByTestId('panel-project-option').find((b) => b.textContent?.includes('未归属项目')) as HTMLElement)

    const input = getByPlaceholderText('记一件事，回车保存')
    fireEvent.change(input, { target: { value: '顺手记一条' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(createTodoSpy).toHaveBeenCalledTimes(1))
    expect(createTodoSpy).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-a' }))
    expect(getByTestId('panel-project-trigger').textContent).toContain('DeskPartner')
  })

  it('「完整登记」：把敲进去的那一句交接给完整卡片，并带上当前项目', async () => {
    const { getByTestId, getByPlaceholderText } = render(<PanelContent />)
    const input = getByPlaceholderText('记一件事，回车保存') as HTMLInputElement
    fireEvent.change(input, { target: { value: '要带过去的一句话' } })
    fireEvent.click(getByTestId('panel-expand-full'))

    expect(invokeMock).toHaveBeenCalledWith('window:showQuickAdd', { projectId: 'proj-a' })
    expect(window.localStorage.getItem('deskpartner.quickAdd.stagedTitle')).toBe('要带过去的一句话')
    // 这一句已经交出去了，面板里不留第二份（留着会让人以为记了两遍）
    expect(input.value).toBe('')
  })
})

describe('跨窗口交接那一句（卡 4ad4f68d）', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('取走即清：只生效一次，不会在几天后的卡片里冒出来', () => {
    stageQuickAddTitle('  只有这一句  ')
    expect(takeStagedQuickAddTitle()).toBe('只有这一句')
    expect(takeStagedQuickAddTitle()).toBe('')
  })

  it('空字符串不留痕（不占键、也不会把标题清成空白）', () => {
    stageQuickAddTitle('   ')
    expect(window.localStorage.getItem('deskpartner.quickAdd.stagedTitle')).toBeNull()
  })

  it('完整卡片那边要真的取用它，且算进"干净"的基准（否则一打开就说有未保存修改）', () => {
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')
    expect(form).toContain('takeStagedQuickAddTitle()')
    const resetAt = form.indexOf('const resetForm = ()')
    const slice = form.slice(resetAt, form.indexOf('}, [editingTodoId])', resetAt))
    expect(slice, '交接来的那一句进标题').toContain('setTitle(stagedTitle)')
    expect(slice, '也要写进 baseline').toContain('title: stagedTitle')
  })
})
