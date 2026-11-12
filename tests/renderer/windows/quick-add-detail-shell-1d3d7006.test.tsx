import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'

/**
 * 详情两块外壳长一个样（卡 `1d3d7006`）
 *
 * 同一条事项的详情有两个落点：看板/「我的工作」里的**右栏**，以及从通知、审批、面板、
 * 版本、时间线、项目概览/文档点开时那个**独立贴右窗口**。此前两张外壳各写了一遍标题条、
 * 关闭纽、Esc、未保存提醒 —— 于是"同一个事项，从这里点开是浮窗、从那里点开是右栏"，
 * 未保存保护还时有时无。
 *
 * 这一版（最小版）把外壳收进 `TodoDetailShell`：**行为与视觉对齐**，位置仍不同。
 * 逐页内嵌右栏（选项①的全量）留到 1.0.146。
 *
 * 这里验的是外壳自己那几件职责，以及"抽屉这一侧确实把它用上了"：
 * ① 标题条 + 关闭纽由外壳画，表单自己那枚 ✕ 隐掉（`hostChrome`）；
 * ② 关闭纽 / Esc / 表单里的取消三条路，脏了都先问一句；
 * ③ 「放弃修改」真丢草稿 —— 独立窗口只是 `hide()`、页面不卸载，所以还要让表单重挂；
 * ④ 抽屉仍走 hash 路由（那条路带着 `commentId`，覆盖掉就丢了）；
 * ⑤ 源码闸门：抽屉与右栏都不再自己拼一套外壳。
 */
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async () => ({ ok: false }))
}))

/**
 * 表单替身
 *
 * 把收到的回调记在 data-* 上，另给两个开关：`stub-dirty` 往上抛脏状态、
 * `stub-request-close` 模拟表单里的「取消 / Esc」。外面拦不拦，全靠这两个。
 * `data-instance` 用来验"放弃修改之后表单是不是真的重挂了"。
 */
vi.mock('../../../src/renderer/components/quick-add/QuickAddForm', () => {
  let seq = 0
  return {
    QuickAddForm: (props: {
      embeddedTodoId?: string | null
      hostChrome?: boolean
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
          'data-host-chrome': String(props.hostChrome === true),
          'data-has-close': String(typeof props.onClose === 'function'),
          'data-has-request-close': String(typeof props.onRequestClose === 'function'),
          'data-has-dirty': String(typeof props.onDirtyChange === 'function')
        },
        React.createElement('button', {
          'data-testid': 'stub-dirty',
          onClick: () => props.onDirtyChange?.(true)
        }),
        React.createElement('button', {
          'data-testid': 'stub-request-close',
          onClick: () => props.onRequestClose?.()
        })
      )
    }
  }
})

import { TodoDetailShell } from '../../../src/renderer/components/quick-add/TodoDetailShell'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * 去掉注释再扫
 *
 * 扫源码的闸门只该判**代码**：注释里提到某个名字不算"代码里有"
 * （`verify-gates-reverse.cjs` 里那条 NOISE 用例就是钉这件事的）。
 */
const codeOf = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('详情外壳：抽屉与右栏是同一份（卡 1d3d7006）', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('外壳画标题条与关闭纽，表单自己那枚隐掉（hostChrome）', () => {
    render(<TodoDetailShell todoId="todo-d1" onClose={() => undefined} />)

    expect(screen.getByText('事项详情')).toBeTruthy()
    expect(screen.getByTestId('todo-detail-close')).toBeTruthy()

    const form = screen.getByTestId('stub-quick-add-form')
    expect(form.getAttribute('data-host-chrome'), '外层有标题条 = 表单那枚 ✕ 隐掉').toBe('true')
    expect(form.getAttribute('data-has-request-close')).toBe('true')
    expect(form.getAttribute('data-has-dirty')).toBe('true')
  })

  it('抽屉这一侧不接管路由：表单仍按 hash 走（commentId 那条路不能丢）', () => {
    render(<TodoDetailShell todoId="todo-d2" onClose={() => undefined} />)
    expect(
      screen.getByTestId('stub-quick-add-form').getAttribute('data-todo'),
      '独立窗口留空 embeddedTodoId'
    ).toBe('')
  })

  it('干净的详情：关起来不拦', () => {
    const onClose = vi.fn()
    render(<TodoDetailShell todoId="todo-d3" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('todo-detail-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('放弃未保存的修改？')).toBeNull()
  })

  it('脏了：关闭纽先问一句，「继续编辑」不关，「放弃修改」才关', () => {
    const onClose = vi.fn()
    render(<TodoDetailShell todoId="todo-d4" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('stub-dirty'))

    fireEvent.click(screen.getByTestId('todo-detail-close'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()

    fireEvent.click(screen.getByTestId('todo-detail-keep-editing'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('放弃未保存的修改？')).toBeNull()

    fireEvent.click(screen.getByTestId('todo-detail-close'))
    fireEvent.click(screen.getByTestId('todo-detail-discard'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('脏了：Esc 也先问一句，确认框开着时 Esc 只关框（= 继续编辑）', () => {
    const onClose = vi.fn()
    render(<TodoDetailShell todoId="todo-d5" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('stub-dirty'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('放弃未保存的修改？')).toBeNull()
  })

  it('脏了：表单里的「取消 / Esc」（onRequestClose）走同一道拦截', () => {
    const onClose = vi.fn()
    render(<TodoDetailShell todoId="todo-d6" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('stub-dirty'))
    fireEvent.click(screen.getByTestId('stub-request-close'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()
  })

  /**
   * 独立窗口与右栏在这一点上真的不同：右栏一关就卸载，表单的内存状态跟着没了；
   * 窗口只是 `hide()`，页面还活着。所以「放弃修改」除了清草稿，还得让表单重挂 ——
   * 否则下次打开还会看到那段"已经放弃"的字，而且照样算脏。
   */
  it('「放弃修改」：草稿真的没了，表单也重挂（独立窗口页面不卸载）', () => {
    const key = 'deskpartner.quickAdd.draft.edit:todo-d7'
    window.sessionStorage.setItem(key, JSON.stringify({ title: '改了一半' }))
    const onClose = vi.fn()
    render(<TodoDetailShell todoId="todo-d7" onClose={onClose} />)

    const first = screen.getByTestId('stub-quick-add-form').getAttribute('data-instance')
    fireEvent.click(screen.getByTestId('stub-dirty'))
    fireEvent.click(screen.getByTestId('todo-detail-close'))
    fireEvent.click(screen.getByTestId('todo-detail-discard'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(key), '按钮写着"放弃"，草稿就不能留着').toBeNull()
    expect(
      screen.getByTestId('stub-quick-add-form').getAttribute('data-instance'),
      '表单要重挂：光清草稿的话，内存里那份半成品下次打开还在'
    ).not.toBe(first)
  })

  it('换了一条事项：新那条干净，关起来不弹确认', () => {
    const onClose = vi.fn()
    const { rerender } = render(<TodoDetailShell todoId="todo-d8" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('stub-dirty'))

    rerender(<TodoDetailShell todoId="todo-d9" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('todo-detail-close'))
    expect(screen.queryByText('放弃未保存的修改？')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('源码闸门：抽屉不自己画标题条 / 关闭纽 / 确认框，卡片外观只在共用外壳里', () => {
    const drawer = codeOf(read('src/renderer/windows/QuickAdd.tsx'))

    expect(drawer, '抽屉要用共用外壳').toContain('<TodoDetailShell')
    expect(drawer, '确认框该在外壳里').not.toContain('放弃未保存的修改？')
    expect(drawer, '关闭纽只该有一枚，且在外壳里').not.toContain('todo-detail-close')
    expect(drawer, '卡片外观不再自己拼').not.toContain('rounded-card')
    expect(drawer, '抽屉仍然只负责把宽度同步给主进程').toContain('window:resizeQuickAdd')
    expect(drawer, '关掉这个窗口 = 隐藏它').toContain('window:hideQuickAdd')

    // 右栏那一侧走的是同一份外壳
    expect(read('src/renderer/components/kanban/TodoDetailPanel.tsx')).toContain('<TodoDetailShell')
  })
})
