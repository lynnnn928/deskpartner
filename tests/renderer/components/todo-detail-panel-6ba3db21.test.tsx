import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'

/**
 * 事项详情内嵌右栏（卡 `6ba3db21`）
 *
 * 一期只改看板内这条路：双击卡片 → 右栏就地展开，不再开一个盖住看板的独立窗口。
 *
 * 这里分两层验：
 * ① 行为层：右栏把 id 与关闭动作**原样交给表单**（右栏自己的职责只有这些），
 *    关闭按钮真的会回调；选中态在 store 里开合。
 * ② 源码层：`handleEdit` 不再调 `window:showQuickAdd`，以及表单在内嵌模式下
 *    **不许**留"窗口失焦就关掉"那段（主窗口一失焦就收起详情，等于点哪都没反应）。
 */
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async () => ({ ok: false }))
}))

vi.mock('../../../src/renderer/components/quick-add/QuickAddForm', () => ({
  QuickAddForm: (props: {
    embeddedTodoId?: string | null
    onClose?: () => void
    onOpenTodo?: (id: string) => void
  }) =>
    React.createElement('div', {
      'data-testid': 'stub-quick-add-form',
      'data-todo': props.embeddedTodoId ?? '',
      'data-has-close': String(typeof props.onClose === 'function'),
      'data-has-open': String(typeof props.onOpenTodo === 'function')
    })
}))

import { TodoDetailPanel } from '../../../src/renderer/components/kanban/TodoDetailPanel'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('事项详情内嵌右栏（卡 6ba3db21）', () => {
  beforeEach(() => {
    useUIStore.setState({ selectedTodoId: null })
  })
  afterEach(() => cleanup())

  it('选中态：openTodoDetail / closeTodoDetail 开合', () => {
    useUIStore.getState().openTodoDetail('todo-1')
    expect(useUIStore.getState().selectedTodoId).toBe('todo-1')
    useUIStore.getState().openTodoDetail('todo-2')
    expect(useUIStore.getState().selectedTodoId).toBe('todo-2')
    useUIStore.getState().closeTodoDetail()
    expect(useUIStore.getState().selectedTodoId).toBeNull()
  })

  it('右栏把 todoId 与两个回调原样交给表单，关闭按钮真的会回调', () => {
    const onClose = vi.fn()
    render(
      <TodoDetailPanel todoId="todo-9" onClose={onClose} onOpenTodo={() => undefined} />
    )

    const form = screen.getByTestId('stub-quick-add-form')
    expect(form.getAttribute('data-todo')).toBe('todo-9')
    expect(form.getAttribute('data-has-close')).toBe('true')
    expect(form.getAttribute('data-has-open')).toBe('true')

    fireEvent.click(screen.getByTestId('todo-detail-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc 关闭右栏（在面板这一层听，焦点在空白处也生效）', () => {
    const onClose = vi.fn()
    render(<TodoDetailPanel todoId="todo-3" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('源码闸门：看板内双击改为就地展开，其他入口仍走窗口', () => {
    const board = read('src/renderer/components/kanban/KanbanBoard.tsx')
    const handleEdit = board.slice(board.indexOf('const handleEdit'), board.indexOf('const handleEdit') + 320)
    expect(handleEdit).toContain('openTodoDetail')
    expect(handleEdit, '看板内不该再开独立窗口').not.toContain("invoke('window:showQuickAdd'")

    // 其他页面的入口这一期刻意保留：至少通知页还开着窗口，别一起被改掉
    expect(read('src/renderer/components/notification/NotificationsView.tsx')).toContain(
      'window:showQuickAdd'
    )

    const kanban = read('src/renderer/windows/Kanban.tsx')
    expect(kanban).toContain('<TodoDetailPanel')
    expect(kanban).toContain('selectedTodoId &&')
  })

  it('源码闸门：内嵌模式下不许保留「窗口失焦就关闭」那段', () => {
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')
    const guardAt = form.indexOf('if (embedded) return')
    const blurAt = form.indexOf("window.addEventListener('blur', handleBlur)")
    expect(guardAt, '找不到内嵌守卫').toBeGreaterThan(0)
    expect(blurAt).toBeGreaterThan(guardAt)
    expect(blurAt - guardAt, '守卫必须在同一个 effect 里、紧挨着那段失焦逻辑').toBeLessThan(800)
    // 内嵌时关闭走外层回调，而不是关掉独立窗口
    expect(form).toContain('props.onClose?.()')
  })
})
