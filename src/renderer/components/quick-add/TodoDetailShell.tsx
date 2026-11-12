import React, { useCallback, useEffect, useState } from 'react'
import { QuickAddForm } from './QuickAddForm'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { clearQuickAddDraftForTodo } from '../../lib/unsaved-drafts'
import { cn } from '../../lib/utils'

/**
 * 事项详情的外壳（卡 `1d3d7006`）
 *
 * ── 为什么要有这一层 ──
 *
 * 同一条事项的详情有两个落点：看板/「我的工作」里就地展开的**右栏**（`TodoDetailPanel`），
 * 和从通知、审批、面板、版本、时间线、项目概览/文档里点开时那个**独立贴右窗口**
 * （`windows/QuickAdd.tsx` 的抽屉形态）。两张外壳此前各写了一遍标题条、关闭按钮、
 * Esc、未保存提醒 —— 于是"同一个事项，从这里点开是浮窗、从那里点开是右栏"，
 * 未保存保护也时有时无（卡里那两个"不选会怎样"就是这个）。
 *
 * 这里把外壳收成一份：标题条（标题 + 关闭纽）、Esc、脏了先拦、放弃确认框、卡片外观。
 * 两处形态再各自套一层薄壳，把**真正不同的那一处**留给调用方：
 * 宽度怎么来、关掉之后是"从看板收起来"还是"把窗口藏起来"、关掉后焦点还给谁。
 *
 * ── 为什么不是把整页内嵌（卡里的选项①）──
 *
 * 那要给 6 个页面各加一套右栏容器与宽度联动，改动面大；这一版先统一外壳行为与视觉，
 * 逐页内嵌留到 1.0.146 —— 那时每页挂的宿主照样能用这一层。
 */

/**
 * 卡片外观：右栏与独立窗口共用一份，调用方只加自己的定位类
 *
 * 两块形态的差别应该只剩"摆在哪儿"，而不是"长什么样"：这正是卡里说的视觉对齐。
 */
export const DETAIL_CARD_CLASS =
  'relative shrink-0 min-h-0 flex flex-col rounded-card border border-border bg-bg-card shadow-card overflow-hidden'

/**
 * 左缘的拖宽把手：外观共用，"宽度怎么算"归调用方
 *
 * 右栏自己记宽度（localStorage），独立窗口要把宽度同步给主进程的窗口边界 ——
 * 那是两种形态真正的区别，把手本身长得一样。
 */
export const DETAIL_DRAG_HANDLE_CLASS =
  'absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-transparent hover:bg-accent/20 transition-colors'

export interface TodoDetailShellProps {
  /** 这一屏看的是哪一条（标题条、表单重挂都以它为准） */
  todoId: string
  /**
   * 内嵌形态直接把 id 交给表单（右栏就这么用）。
   *
   * 独立窗口**必须留空**，让表单继续走 hash 路由：窗口那条路还带着 `commentId`
   * （从搜索命中评论进来时要定位到那条），覆盖掉路由就把它丢了。
   */
  embeddedTodoId?: string | null
  /** 真的关：右栏从看板收起来 / 独立窗口隐藏 */
  onClose: () => void
  /** 详情里点父子事项：就地在同一个外壳里换一条（独立窗口留空则退回开窗口那条路） */
  onOpenTodo?: (id: string) => void
  /** 卡片自己的定位类（右栏自留边距；独立窗口贴着窗口的留白） */
  className?: string
  style?: React.CSSProperties
  testId?: string
  /** 标题条之前的插槽：拖宽把手 */
  children?: React.ReactNode
}

export const TodoDetailShell: React.FC<TodoDetailShellProps> = ({
  todoId,
  embeddedTodoId,
  onClose,
  onOpenTodo,
  className,
  style,
  testId = 'todo-detail-panel',
  children
}) => {
  /** 表单里有没有未保存的改动 —— 关这一屏要不要先问一句，全看它 */
  const [dirty, setDirty] = useState(false)
  /** 「放弃未保存的修改？」开着的时候，关闭动作先落到这个框上 */
  const [confirmOpen, setConfirmOpen] = useState(false)
  /**
   * 表单重挂计数（「放弃修改」用）
   *
   * 右栏关掉就卸载，表单的内存状态一起没了；独立窗口只是 `hide()`，页面还活着 ——
   * 只清草稿、不重挂的话，用户下次打开还会看到那段"已经放弃"的字，而且照样算脏。
   * 换个 key 就是同义的重挂（与"换一条事项"用的是同一招）。
   */
  const [resetSeq, setResetSeq] = useState(0)

  /**
   * 换了一条事项 = 换了一次编辑（卡 `82e4b1f6`）
   *
   * 旧那条的脏状态不属于新这条：留着会让关掉时白弹一次确认框。
   */
  useEffect(() => {
    setDirty(false)
    setConfirmOpen(false)
  }, [todoId])

  /**
   * 请求关闭：有未保存的改动先问一句
   *
   * 关闭按钮、Esc、表单里的「取消」都汇到这里 —— 三条路各写一遍"脏了就拦"，
   * 迟早漏一条，而漏掉的那条就是丢改动的那条。
   */
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmOpen(true)
      return
    }
    onClose()
  }, [dirty, onClose])

  /**
   * Esc 关这一屏
   *
   * 为什么在外壳这一层听，而不是只靠表单里的 onKeyDown：
   * 表单的键盘处理挂在它自己的容器上，焦点落在详情空白处时收不到。
   * 外壳是这一层的"可关闭容器"，Esc 在这里兜底最稳；表单里那一份照旧 ——
   * 两处都走 requestClose，重复触发只是多弹一次同一个确认框（幂等）。
   *
   * 确认框开着时 Esc 只关框（=「继续编辑」），不会连详情一起关掉。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmOpen) {
        setConfirmOpen(false)
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmOpen, requestClose])

  return (
    <>
      <aside
        data-testid={testId}
        style={style}
        className={cn(DETAIL_CARD_CLASS, className)}
      >
        {children}
        <div className="shrink-0 flex items-center justify-between pl-3 pr-2 py-1.5 border-b border-border">
          <span className="text-caption text-text-secondary">事项详情</span>
          <button
            type="button"
            onClick={requestClose}
            data-testid="todo-detail-close"
            aria-label="关闭详情"
            title="关闭（Esc）"
            className={cn(
              'w-6 h-6 flex items-center justify-center rounded-button transition-colors',
              'text-text-secondary hover:bg-black/5 hover:text-text-primary'
            )}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
        {/* 滚动由表单自己那层负责：底部操作栏要留在滚动层外面，才能整条铺到卡片边缘 */}
        <div className="flex-1 min-h-0 flex flex-col">
          <QuickAddForm
            key={`${todoId}#${resetSeq}`}
            embeddedTodoId={embeddedTodoId}
            hostChrome
            onClose={onClose}
            onOpenTodo={onOpenTodo}
            onRequestClose={requestClose}
            onDirtyChange={setDirty}
          />
        </div>
      </aside>
      {/*
        放弃未保存的修改

        关掉这一屏，表单里那段没提交的东西就没了 —— 而「关闭」这个动作本身
        读不出这个代价。所以只在真的改过（dirty）时才多这一步：干净的详情
        关起来不该被拦。
      */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <div className="flex w-full flex-col gap-3" role="alertdialog" aria-labelledby="discard-draft-title">
          <h3 id="discard-draft-title" className="text-body font-medium text-text-primary">
            放弃未保存的修改？
          </h3>
          <p className="text-label leading-relaxed text-text-secondary">
            这条事项的改动还没保存，关掉后就没有了。
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              data-testid="todo-detail-keep-editing"
              onClick={() => setConfirmOpen(false)}
            >
              继续编辑
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="todo-detail-discard"
              onClick={() => {
                /**
                 * 「放弃修改」必须真的丢（卡 `77aedd14` / `1d3d7006`）
                 *
                 * 表单在"有改动"时每次渲染都往 sessionStorage 写一份草稿；
                 * 只关这一屏、不清草稿，下次打开会把原文原样恢复出来 ——
                 * 那和这个按钮说的话正相反，等于给了一个假确认。
                 * 独立窗口页面不卸载，光清草稿还不够，得让表单重挂（见 resetSeq）。
                 */
                clearQuickAddDraftForTodo(todoId)
                setConfirmOpen(false)
                setDirty(false)
                setResetSeq((n) => n + 1)
                onClose()
              }}
            >
              放弃修改
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
