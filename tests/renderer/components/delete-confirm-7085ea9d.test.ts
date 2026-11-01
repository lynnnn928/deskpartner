// @vitest-environment happy-dom
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

import {
  DeleteTodoDialog,
  deleteConfirmCopy
} from '../../../src/renderer/components/kanban/KanbanBoard'

/**
 * 单条事项删除的二次确认（卡 `7085ea9d`）
 *
 * 改之前：看板上点卡片上的垃圾桶 → `handleDelete` 里查一下子任务数，
 * **没有子任务就直接 `doDelete(id)`** —— 手滑一次，一条事项连同它的评论就没了，
 * 而这个仓里没有回收站（撤销条只活在当次会话，关窗即散）。
 *
 * 现在：任何一次单条删除都先弹确认框，写明「删除后不可恢复」；
 * 有子任务时正文照抄通知中心那句子任务去向（`该事项下包含 N 个子任务…`）。
 *
 * 两层验：
 * ① 真渲染确认框（`@testing-library/react` 已在 devDependencies），
 *    点「取消」/ 点「删除」的结果靠**行为**钉住，不靠字符串"看起来对"；
 * ② 源码闸门：确认分支被删掉时测试会红 —— 每条闸门都配一次注入反向验证，
 *    否则闸门本身可能是恒真的。
 */

const ROOT = path.resolve(__dirname, '../../..')
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const BOARD = 'src/renderer/components/kanban/KanbanBoard.tsx'
const board = read(BOARD)

/** 去掉注释再闸门：注释里写着"要确认"不等于代码真会确认 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 取一段源码（从 start 到下一个 end，找不到 end 就取到结尾） */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(end, a + start.length)
  return src.slice(a, b < 0 ? undefined : b)
}

/** 确认框的正文口径（逐字） */
const DANGER_LINE = '删除后不可恢复。'
const CHILD_LINE_3 = '该事项下包含 3 个子任务，需二次确认后删除（删除后子任务将保留为独立事项）。'

const renderDialog = (props: { title?: string; childCount?: number } = {}) => {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const view = render(
    React.createElement(DeleteTodoDialog, {
      title: props.title ?? '整理发版清单',
      childCount: props.childCount ?? 0,
      onCancel,
      onConfirm
    })
  )
  return { onCancel, onConfirm, ...view }
}

describe('单条删除：确认之前不碰数据（卡 7085ea9d）', () => {
  it('弹出确认框时一次都没删', () => {
    const { onConfirm } = renderDialog()
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('点「删除」才删，且只删这一次', () => {
    const { onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('点「取消」等于没删', () => {
    const { onCancel, onConfirm } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('默认焦点不在「删除」上（焦点给「取消」，回车不会删）', () => {
    const { onConfirm } = renderDialog()
    const cancel = screen.getByRole('button', { name: '取消' })
    const confirm = screen.getByRole('button', { name: '删除' })
    expect(document.activeElement).toBe(cancel)
    expect(document.activeElement).not.toBe(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('确认按钮是危险色，取消是中性色', () => {
    renderDialog()
    const confirm = screen.getByRole('button', { name: '删除' })
    const cancel = screen.getByRole('button', { name: '取消' })
    // dangerSolid：实心红（与批量删除那条同款）
    expect(confirm.className).toContain('bg-red-600')
    expect(cancel.className).not.toContain('red')
  })
})

describe('文案：说清后果，也照抄既有口径（卡 7085ea9d）', () => {
  it('没有子任务时只说一件事：删了就回不来', () => {
    const { container } = renderDialog({ childCount: 0 })
    const text = container.textContent ?? ''
    expect(text).toContain(DANGER_LINE)
    expect(text).not.toContain('子任务')
  })

  it('带子任务时写明子任务的去向 + 仍要说不可恢复', () => {
    const { container } = renderDialog({ childCount: 3 })
    const text = container.textContent ?? ''
    expect(text).toContain(CHILD_LINE_3)
    expect(text).toContain(DANGER_LINE)
  })

  it('标题带上事项名，人才知道自己删的是哪一条', () => {
    const { container } = renderDialog({ title: '整理发版清单' })
    expect(container.textContent).toContain('删除「整理发版清单」？')
  })

  it('正文是纯函数给的，两句话的措辞逐字固定', () => {
    expect(deleteConfirmCopy(0)).toEqual({ childrenLine: null, irreversibleLine: DANGER_LINE })
    expect(deleteConfirmCopy(3)).toEqual({ childrenLine: CHILD_LINE_3, irreversibleLine: DANGER_LINE })
    // 1 条、100 条都同一套说法，只有数字变
    expect(deleteConfirmCopy(1).childrenLine).toBe(
      '该事项下包含 1 个子任务，需二次确认后删除（删除后子任务将保留为独立事项）。'
    )
    expect(deleteConfirmCopy(100).childrenLine).toContain('100 个子任务')
  })
})

/**
 * 源码闸门 —— 每条都配一次注入反向验证。
 *
 * 返回问题清单（空 = 过）。注入后的源码必须让它非空，
 * 否则说明这条闸门压根测不出东西。
 */
const sourceGateProblems = (src: string): string[] => {
  const code = stripComments(src)
  const problems: string[] = []

  // 点「删除」必须停在确认框前：handleDelete 里不许出现 doDelete
  const handleDelete = between(code, 'const handleDelete', 'const confirmDelete')
  if (!handleDelete.includes('setDeletePrompt(')) problems.push('handleDelete 没有停到确认框')
  if (handleDelete.includes('doDelete(')) problems.push('handleDelete 直接删了')

  // 确认才删
  const confirmDelete = between(code, 'const confirmDelete', '/**')
  if (!confirmDelete.includes('doDelete(deletePrompt.id)')) problems.push('confirmDelete 没有真正删除')

  // 弹窗必须由确认框状态挂出来，且确认走 confirmDelete
  if (!code.includes('<DeleteTodoDialog')) problems.push('没有挂确认框组件')
  if (!code.includes('onConfirm={confirmDelete}')) problems.push('确认没有接到 confirmDelete')

  // 文案：不可恢复 + 子任务去向（照抄通知中心口径）
  if (!code.includes(DANGER_LINE)) problems.push('没写「删除后不可恢复」')
  if (!code.includes('该事项下包含')) problems.push('没写子任务的去向')

  // 默认焦点不能落在删除按钮上
  if (!code.includes('cancelRef.current?.focus()')) problems.push('没有把焦点放到取消上')

  return problems
}

describe('源码闸门 + 注入反向验证（卡 7085ea9d）', () => {
  it('真实源码零问题', () => {
    expect(sourceGateProblems(board)).toEqual([])
  })

  it('注入：把确认分支换成直接删 → 必须红', () => {
    const mutated = board.replace(
      "setDeletePrompt({ id, title: todo?.title ?? '这条事项', childCount })",
      'await doDelete(id)'
    )
    // 注入本身要生效，否则"反向验证"验证的是空气
    expect(mutated).not.toBe(board)
    expect(sourceGateProblems(mutated).join(' / ')).toContain('直接删')
  })

  it('注入：删掉「删除后不可恢复」→ 必须红', () => {
    const mutated = board.replace(`irreversibleLine: '${DANGER_LINE}'`, "irreversibleLine: ''")
    expect(mutated).not.toBe(board)
    expect(sourceGateProblems(mutated).join(' / ')).toContain('不可恢复')
  })

  it('注入：删掉焦点初始化 → 必须红（默认焦点会落在删除上）', () => {
    const mutated = board.replace('cancelRef.current?.focus()', 'void 0')
    expect(mutated).not.toBe(board)
    expect(sourceGateProblems(mutated).join(' / ')).toContain('焦点')
  })

  it('注入：不挂确认框 → 必须红', () => {
    // 整块摘掉（改名而不是加前缀：闸门用的是 includes，前缀还会命中）
    const mutated = board.replaceAll('DeleteTodoDialog', 'SomethingElse')
    expect(mutated).not.toBe(board)
    expect(sourceGateProblems(mutated).join(' / ')).toContain('确认框组件')
  })
})

describe('本卡只管单条删除：批量那条不动（卡 7085ea9d）', () => {
  const batch = read('src/renderer/components/kanban/BatchBar.tsx')

  it('BatchBar 自己的确认分支还在原样', () => {
    expect(batch).toContain('确认删除后无法恢复')
    expect(batch).toContain('确认删除 ${selectedIds.length} 条')
  })

  it('单条确认框没有被批量那条复用/接管（各管各的）', () => {
    expect(batch).not.toContain('DeleteTodoDialog')
    expect(board).not.toContain('batchDelete')
  })
})
