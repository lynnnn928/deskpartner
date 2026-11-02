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
 * ① 行为层：右栏把 id 与三个回调**原样交给表单**（右栏自己的职责只有这些），
 *    关闭按钮真的会回调；选中态在 store 里开合；有未保存改动时三条关闭路径
 *    都先弹确认；拖左缘真的改宽度并记住；关掉后焦点回到那张卡片。
 * ② 源码层：`handleEdit` 不再调 `window:showQuickAdd`；表单在内嵌模式下
 *    **不许**留"窗口失焦就关掉"那段（主窗口一失焦就收起详情，等于点哪都没反应）；
 *    表单里的「取消 / Esc」必须走"请求关闭"这条路，而不是自己决定关。
 */
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async () => ({ ok: false }))
}))

/**
 * 表单替身
 *
 * 除了把收到的回调记在 data-* 上，还额外给两个开关：`stub-dirty` 往上抛脏状态、
 * `stub-request-close` 模拟表单里的「取消 / Esc」。右栏拦不拦，全靠这两个。
 */
vi.mock('../../../src/renderer/components/quick-add/QuickAddForm', () => {
  /**
   * 每次"挂载"发一个序号（卡 `82e4b1f6`）
   *
   * 右栏在详情里点父子事项时是**就地换 id**、面板不卸载；判"表单有没有重挂"只能
   * 看实例换没换 —— 用 data-instance 记下来，比断言源码字符串更接近真实行为。
   */
  let seq = 0
  return {
    QuickAddForm: (props: {
      embeddedTodoId?: string | null
      onClose?: () => void
      onOpenTodo?: (id: string) => void
      onRequestClose?: () => void
      onDirtyChange?: (dirty: boolean) => void
    }) => {
      const [instance] = React.useState(() => ++seq)
      return React.createElement(
        'div',
        {
          'data-testid': 'stub-quick-add-form',
          'data-instance': String(instance),
          'data-todo': props.embeddedTodoId ?? '',
          'data-has-close': String(typeof props.onClose === 'function'),
          'data-has-open': String(typeof props.onOpenTodo === 'function'),
          'data-has-request-close': String(typeof props.onRequestClose === 'function'),
          'data-has-dirty': String(typeof props.onDirtyChange === 'function')
        },
        React.createElement('button', {
          'data-testid': 'stub-dirty',
          onClick: () => props.onDirtyChange?.(true)
        }),
        React.createElement('button', {
          'data-testid': 'stub-clean',
          onClick: () => props.onDirtyChange?.(false)
        }),
        React.createElement('button', {
          'data-testid': 'stub-request-close',
          onClick: () => props.onRequestClose?.()
        })
      )
    }
  }
})

import { TodoDetailPanel } from '../../../src/renderer/components/kanban/TodoDetailPanel'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const WIDTH_KEY = 'deskpartner.detailPanelWidth'

describe('事项详情内嵌右栏（卡 6ba3db21）', () => {
  beforeEach(() => {
    useUIStore.setState({ selectedTodoId: null })
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('选中态：openTodoDetail / closeTodoDetail 开合', () => {
    useUIStore.getState().openTodoDetail('todo-1')
    expect(useUIStore.getState().selectedTodoId).toBe('todo-1')
    useUIStore.getState().openTodoDetail('todo-2')
    expect(useUIStore.getState().selectedTodoId).toBe('todo-2')
    useUIStore.getState().closeTodoDetail()
    expect(useUIStore.getState().selectedTodoId).toBeNull()
  })

  it('右栏把 todoId 与回调原样交给表单，关闭按钮真的会回调', () => {
    const onClose = vi.fn()
    render(<TodoDetailPanel todoId="todo-9" onClose={onClose} onOpenTodo={() => undefined} />)

    const form = screen.getByTestId('stub-quick-add-form')
    expect(form.getAttribute('data-todo')).toBe('todo-9')
    expect(form.getAttribute('data-has-close')).toBe('true')
    expect(form.getAttribute('data-has-open')).toBe('true')
    expect(form.getAttribute('data-has-request-close')).toBe('true')
    expect(form.getAttribute('data-has-dirty')).toBe('true')

    // 没改过 = 干净，关闭不该拦
    fireEvent.click(screen.getByTestId('todo-detail-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc 关闭右栏（在面板这一层听，焦点在空白处也生效）', () => {
    const onClose = vi.fn()
    render(<TodoDetailPanel todoId="todo-3" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  describe('有未保存的修改时，三条关闭路径都要先问一句', () => {
    it('关闭按钮：先弹确认，「继续编辑」不关，「放弃修改」才关', () => {
      const onClose = vi.fn()
      render(<TodoDetailPanel todoId="todo-5" onClose={onClose} />)

      fireEvent.click(screen.getByTestId('stub-dirty'))

      fireEvent.click(screen.getByTestId('todo-detail-close'))
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()

      fireEvent.click(screen.getByTestId('todo-detail-keep-editing'))
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.queryByText('放弃未保存的修改？')).toBeNull()

      // 回来后表单还是脏的：再关一次，这次放弃
      fireEvent.click(screen.getByTestId('todo-detail-close'))
      fireEvent.click(screen.getByTestId('todo-detail-discard'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('表单里的「取消 / Esc」走同一道拦截（onRequestClose）', () => {
      const onClose = vi.fn()
      render(<TodoDetailPanel todoId="todo-6" onClose={onClose} />)

      fireEvent.click(screen.getByTestId('stub-dirty'))
      fireEvent.click(screen.getByTestId('stub-request-close'))
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()
    })

    it('面板级 Esc：脏了弹确认，确认框开着时 Esc 只关框', () => {
      const onClose = vi.fn()
      render(<TodoDetailPanel todoId="todo-7" onClose={onClose} />)

      fireEvent.click(screen.getByTestId('stub-dirty'))
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()

      // 第二下 Esc 等于「继续编辑」——右栏不能跟着关掉
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.queryByText('放弃未保存的修改？')).toBeNull()
    })

    it('改回原样（干净）之后关起来又不用问了', () => {
      const onClose = vi.fn()
      render(<TodoDetailPanel todoId="todo-8" onClose={onClose} />)

      fireEvent.click(screen.getByTestId('stub-dirty'))
      fireEvent.click(screen.getByTestId('todo-detail-close'))
      expect(onClose).not.toHaveBeenCalled()

      // 确认框开着的时候把改动撤回（比如点「放弃草稿」）—— 再关就不该拦
      fireEvent.click(screen.getByTestId('todo-detail-keep-editing'))
      fireEvent.click(screen.getByTestId('stub-clean'))
      fireEvent.click(screen.getByTestId('todo-detail-close'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('拖左缘真的改宽度，收了手才落 localStorage', () => {
    render(<TodoDetailPanel todoId="todo-drag" onClose={() => undefined} />)
    const panel = screen.getByTestId('todo-detail-panel')
    expect(panel.style.width).toBe('480px')

    const handle = panel.querySelector('[role="separator"]') as HTMLElement
    expect(handle).toBeTruthy()

    fireEvent.pointerDown(handle, { clientX: 1000 })
    fireEvent.pointerMove(window, { clientX: 900 })
    // 面板贴右：向左拖 = 变宽
    expect(screen.getByTestId('todo-detail-panel').style.width).toBe('580px')
    // 拖动过程中不写存储：每帧写一次只会把主线程堵在存储上
    expect(window.localStorage.getItem(WIDTH_KEY)).toBeNull()

    fireEvent.pointerMove(window, { clientX: 100 })
    expect(screen.getByTestId('todo-detail-panel').style.width).toBe('760px')

    fireEvent.pointerUp(window)
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('760')
  })

  it('上一次拖的宽度下次打开还在', () => {
    window.localStorage.setItem(WIDTH_KEY, '600')
    render(<TodoDetailPanel todoId="todo-w" onClose={() => undefined} />)
    expect(screen.getByTestId('todo-detail-panel').style.width).toBe('600px')
  })

  it('关掉右栏后焦点回到那张卡片', () => {
    const card = document.createElement('div')
    card.setAttribute('data-todo-id', 'todo-focus')
    card.tabIndex = -1
    document.body.appendChild(card)
    const focusSpy = vi.spyOn(card, 'focus')

    const { unmount } = render(<TodoDetailPanel todoId="todo-focus" onClose={() => undefined} />)
    unmount()

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(focusSpy.mock.calls[0]?.[0]).toEqual({ preventScroll: true })
  })

  it('卡片不在了（被筛掉 / 换了视图）就退回打开前那个元素', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const focusSpy = vi.spyOn(opener, 'focus')

    const { unmount } = render(<TodoDetailPanel todoId="todo-missing" onClose={() => undefined} />)
    unmount()

    expect(focusSpy).toHaveBeenCalledTimes(1)
  })

  it('详情里点父子事项就地换了一条，关掉后焦点回**最后看的那条**的卡片', () => {
    for (const id of ['todo-parent', 'todo-child']) {
      const el = document.createElement('div')
      el.setAttribute('data-todo-id', id)
      el.tabIndex = -1
      document.body.appendChild(el)
    }
    const child = document.querySelector('[data-todo-id="todo-child"]') as HTMLElement
    const childFocus = vi.spyOn(child, 'focus')

    const { rerender, unmount } = render(<TodoDetailPanel todoId="todo-parent" onClose={() => undefined} />)
    rerender(<TodoDetailPanel todoId="todo-child" onClose={() => undefined} />)
    unmount()

    expect(childFocus).toHaveBeenCalledTimes(1)
  })

  describe('换了一条事项（卡 82e4b1f6：详情里点父子事项就地切换）', () => {
    it('表单跟着重挂：不会顶着上一条的内容', () => {
      const onClose = vi.fn()
      const { rerender } = render(<TodoDetailPanel todoId="todo-a" onClose={onClose} />)
      const first = screen.getByTestId('stub-quick-add-form')
      const firstInstance = first.getAttribute('data-instance')

      rerender(<TodoDetailPanel todoId="todo-b" onClose={onClose} />)

      const second = screen.getByTestId('stub-quick-add-form')
      expect(second.getAttribute('data-todo')).toBe('todo-b')
      expect(
        second.getAttribute('data-instance'),
        '换一条必须重新挂载 —— 否则装载守卫会让新条目顶着上一条的字'
      ).not.toBe(firstInstance)
    })

    it('旧那条的脏状态不带过来：新那条干净，关起来不弹确认', () => {
      const onClose = vi.fn()
      const { rerender } = render(<TodoDetailPanel todoId="todo-a" onClose={onClose} />)
      fireEvent.click(screen.getByTestId('stub-dirty'))

      rerender(<TodoDetailPanel todoId="todo-b" onClose={onClose} />)
      fireEvent.click(screen.getByTestId('todo-detail-close'))

      expect(screen.queryByText('放弃未保存的修改？')).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('「放弃修改」真的丢掉这条的草稿（卡 77aedd14）', () => {
    const key = 'deskpartner.quickAdd.draft.edit:todo-draft'
    window.sessionStorage.setItem(key, JSON.stringify({ title: '改了一半' }))
    const onClose = vi.fn()

    render(<TodoDetailPanel todoId="todo-draft" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('stub-dirty'))
    fireEvent.click(screen.getByTestId('todo-detail-close'))
    fireEvent.click(screen.getByTestId('todo-detail-discard'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(
      window.sessionStorage.getItem(key),
      '按钮写着"放弃"，草稿就不能留着 —— 否则下次打开原文又回来'
    ).toBeNull()
  })

  it('源码闸门：右栏里的表单按 todoId 重挂（内嵌切换 = 窗口形态的整页重载）', () => {
    const panel = read('src/renderer/components/kanban/TodoDetailPanel.tsx')
    expect(panel).toContain('key={todoId}')
  })

  it('源码闸门：右栏跟着背后那块看板收（卡 5fe4aaad）', () => {
    const kanban = read('src/renderer/windows/Kanban.tsx')
    expect(kanban, '换项目 / 换工作台就收起详情').toMatch(
      /useEffect\(\(\) => \{\s*closeTodoDetail\(\)\s*\}, \[filterProject, workspaceMode, closeTodoDetail\]\)/
    )
    const store = read('src/renderer/stores/ui.store.ts')
    expect(store, '离开看板视图就清掉选中项').toMatch(
      /set\(view === 'board' \? \{ mainView: view \} : \{ mainView: view, selectedTodoId: null \}\)/
    )
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

  it('源码闸门：卡片带 data-todo-id 且能接住焦点（焦点才回得去）', () => {
    const card = read('src/renderer/components/kanban/TodoCard.tsx')
    expect(card).toContain('data-todo-id={todo.id}')
    expect(card).toContain('tabIndex={multiSelectMode ? -1 : attributes.tabIndex}')
    expect(card).toContain('focus:ring-accent')
  })

  it('源码闸门：表单只上报「有人想关 / 改没改」，拦不拦由右栏决定', () => {
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')
    expect(form).toContain('onDirtyChange?.(dirty)')
    expect(form).toContain('props.onRequestClose()')

    const cancelAt = form.indexOf('const handleCancel = () => {')
    expect(cancelAt).toBeGreaterThan(0)
    expect(form.slice(cancelAt, cancelAt + 120), '「取消」必须走请求关闭，不能自己关').toContain(
      'requestClose()'
    )
    expect(form.slice(cancelAt, cancelAt + 120)).not.toContain('closeDetail()')
  })
})
