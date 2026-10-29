import React, { useMemo, useState } from 'react'
import { DndContext, DragOverlay } from '@dnd-kit/core'
import { KanbanColumn } from './KanbanColumn'
import { UndoSnackbar } from './UndoSnackbar'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useDragSort, onBoardError } from '../../hooks/useDragSort'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { invoke } from '../../lib/ipc-client'
// 没保存的理由先存哪儿（卡 6a595ad0）
import { clearRejectReason, readRejectReason, writeRejectReason } from '../../lib/unsaved-drafts'
import type { TodoStatus } from '../../types/enums'
import { cn } from '../../lib/utils'
import { BOARD_COLUMNS } from '../../lib/constants'
import { useBoardVisibility } from '../../hooks/useBoardVisibility'
import { visibleCards, visibleColumns } from '../../lib/board-visibility'

/**
 * 看板列序单源在 lib/constants.ts 的 BOARD_COLUMNS（53d252ea）——
 * 渲染与拖拽判定（useDragSort）共用一份，漏改一处的下场是
 * "废弃列渲染出来了却拖不进卡"。
 *
 * 七列：候选池两列（待确认 / 待验收）夹在执行流两侧，
 * 顺序即工作流的推进方向：提议 → 确认 → 执行 → （挂起）→ 验收 → 归档；
 * 「已废弃」是终态归档区（"不做了"的结论），固定排在 done 之后
 * （主用户 2026-10-08 拍板：「就是在完成列的后面给一列废弃列，可以在界面上看得到的」）。
 */
const COLUMNS: TodoStatus[] = BOARD_COLUMNS

export const KanbanBoard: React.FC<{ onOpenProjectSearch?: (query?: string) => void }> = ({ onOpenProjectSearch }) => {
  const { sensors, handleDragEnd, getTodosByStatus } = useDragSort()
  const { updateTodo, deleteTodo } = useTodoStore()
  const pushUndo = useUIStore((s) => s.pushUndo)
  const removeUndoItem = useUIStore((s) => s.removeUndoItem)
  const showToast = useUIStore((s) => s.showToast)
  /** 驳回理由弹框（1.0.54）：拖「待验收→进行中」时由 useDragSort 置入 */
  const pendingReject = useUIStore((s) => s.pendingReject)
  const setPendingReject = useUIStore((s) => s.setPendingReject)
  const searchKeyword = useUIStore((s) => s.searchKeyword)
  /** 在项目空间里新建的卡要落在当前项目上（handleAdd） */
  const filterProject = useUIStore((s) => s.filterProject)
  const collapsedColumns = useUIStore((s) => s.collapsedColumns)
  const workspaceMode = useUIStore((s) => s.workspaceMode)
  const toggleColumn = useUIStore((s) => s.toggleColumn)
  const { settings } = useSettingsStore()

  /**
   * 删父任务的二次确认：挂了子任务时先问一句再删。
   * 只在这一次删除期间存在，不落库、不进 store —— 它是一次性的询问，不是状态。
   */
  const [unlinkPrompt, setUnlinkPrompt] = useState<{
    id: string
    title: string
    count: number
  } | null>(null)

  const handleEdit = (id: string) => {
    // 通过 IPC 让主进程打开 QuickAdd 窗口并传入 todoId
    invoke('window:showQuickAdd', { todoId: id })
  }

  /**
   * 删除的统一出口：先留快照，再删（1.0.48 真撤销）
   *
   * 快照必须在删除**之前**取 —— 删完 store 里就没这条了，
   * 而主进程没有回收站，交不回去的东西就真的没了。
   */
  const doDelete = async (id: string) => {
    const todo = useTodoStore.getState().todos.find((t) => t.id === id)
    if (todo) {
      pushUndo({ id, label: `已删除「${todo.title}」`, snapshot: todo })
    }
    try {
      await deleteTodo(id)
    } catch (err) {
      // 删不掉却不吭声，人只会以为已经删了
      removeUndoItem(id)
      showToast(err instanceof Error ? `删除失败：${err.message}` : '删除失败')
    }
  }

  const handleDelete = async (id: string) => {
    /**
     * 删父任务会让它的子任务**解绑**（parent_id 外键是 ON DELETE SET NULL）：
     * 子任务不会消失，但会变成孤儿散在看板上，再也看不出原本属于谁。
     * 这个后果对人来说是意外 —— 所以删之前先说清楚，而不是删完才解释。
     * （主用户 2026-09-19 提的：提示一句"关联的 N 个子任务会解绑"的二次确认）
     */
    let children = 0
    try {
      children = await invoke('todo:childCount', { id })
    } catch {
      // 查不到就当没有子任务 —— 计数失败不该挡住删除
    }

    if (children > 0) {
      const todo = useTodoStore.getState().todos.find((t) => t.id === id)
      setUnlinkPrompt({ id, title: todo?.title ?? '这条事项', count: children })
      return
    }

    await doDelete(id)
  }

  const confirmUnlinkDelete = () => {
    if (!unlinkPrompt) return
    void doDelete(unlinkPrompt.id)
    setUnlinkPrompt(null)
  }

  /**
   * 确认驳回（1.0.54）：写 reject 评论 + 退回「进行中」。
   *
   * 顺序是先写评论再流转 —— 这样即使流转被守卫拒了，理由也已经留下；
   * 而流转本身会触发 C 通知（meta.rejected），执行方的回执提醒随之生效。
   * 失败要把卡片放回原列，不留"看起来拖过去了"的假象。
   */
  const confirmReject = async (reason: string) => {
    const pending = pendingReject
    if (!pending) return
    const text = reason.trim()
    if (!text) return
    try {
      await invoke('todo:addComment', { todoId: pending.id, body: text, kind: 'reject' })
      await updateTodo({ id: pending.id, status: 'in_progress' })
      pushUndo({
        id: pending.id,
        label: '已驳回并退回进行中',
        snapshot: pending.snapshot
      })
      showToast('已驳回，理由记入评论并通知执行方')
      // 理由已经落成评论了，草稿再留一份就是"下次打开又冒出来"（卡 6a595ad0）
      clearRejectReason(pending.id)
    } catch (err) {
      setDragError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingReject(null)
    }
  }

  const handlePin = async (id: string) => {
    const todo = useTodoStore.getState().todos.find((t) => t.id === id)
    if (todo) {
      await updateTodo({ id, isPinned: !todo.isPinned })
    }
  }

  /**
   * 在指定列内新增
   *
   * 带上 status，主进程会把它编进弹窗的 hash，
   * 新任务就落在这一列，不用先建成"待办"再拖过来。
   */
  const handleAdd = (status: TodoStatus) => {
    invoke('window:showQuickAdd', {
      status,
      projectId: workspaceMode === 'project' ? filterProject ?? undefined : undefined
    })
  }

  /**
   * 可见性口径与角标数字都来自 hooks/useBoardVisibility（f6f78ada）——
   * 列、卡片、角标、空态四处共用同一份判断，不再各写一条链。
   * 列序仍用本文件那份单源 COLUMNS（= BOARD_COLUMNS）。
   */
  const { visibility, visibleCount } = useBoardVisibility()
  const columns = useMemo(() => visibleColumns(visibility, COLUMNS), [visibility])

  const openProjectSearch = onOpenProjectSearch ?? (() => undefined)

  /**
   * 拖拽被守卫拒绝时的提示条。
   *
   * 只在挂载期订阅，卸载即取消 —— hook 里拿不到 React 生命周期，
   * 所以通道放在 useDragSort 侧，这里负责显示。
   */
  const [dragError, setDragError] = React.useState<string | null>(null)
  React.useEffect(() => {
    const off = onBoardError((msg) => {
      setDragError(msg)
      window.setTimeout(() => {
        setDragError((cur) => (cur === msg ? null : cur))
      }, 4000)
    })
    return off
  }, [])

  return (
    /**
     * 必须是 flex-1 而不是 h-full。
     *
     * h-full = 父容器高度的 100%，而父容器里已经有一个标题栏 ——
     * 两者相加就超出窗口，最外层又是 overflow-hidden，
     * 结果是**列底部的「+ 添加任务」被裁掉**（看板最下面那条一直是缺的）。
     * flex-1 + min-h-0 才是"占满剩余空间"：min-h-0 不能省，
     * flex 子项默认 min-height:auto，内容会把容器顶开而不是收缩。
     *
     * 搜索筛选栏不在这里 —— 它上移到了窗口层，因为看板与动态两种形态共用它。
     */
    <div
      className="flex flex-col flex-1 min-h-0"
      style={{ borderRadius: settings.kanbanBorderRadius }}
    >
      {/*
        列用固定宽（w-60 shrink-0）而不是 flex-1。
        flex-1 是"四列永远摊满一行"：窗口不够宽时每列被压扁，
        而外层 overflow-x-auto 永远等不到溢出 —— 横向滚动名存实亡。
        固定宽 + shrink-0 让列在窄窗口下真的溢出，横向滚动才成立；
        列数增多（如候选池六列）时同样靠它撑出滚动区。
      */}
      {searchKeyword.trim() && visibleCount === 0 && (
        <div className="mx-3 mt-3 rounded-card border border-border bg-bg-card px-4 py-4 text-center" role="status">
          <p className="text-label text-text-secondary">没有匹配的事项。</p>
          {workspaceMode === 'project' && onOpenProjectSearch && (
            <button type="button" onClick={() => openProjectSearch(searchKeyword.trim())} className="mt-2 text-label text-accent hover:underline">
              在项目记录中搜索接手说明、评论和历史事项
            </button>
          )}
        </div>
      )}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd} collisionDetection={undefined}>
        <div className="flex-1 flex gap-3 p-3 overflow-x-auto overflow-y-hidden min-h-0">
          {/*
            状态类智能视图（待确认/待验收/已完成）：只渲染目标列。
            其余五列渲染出来也是全空，还会诱导人往禁行的列里拖。
            列宽仍是固定 240px，单列视图靠左排，不强行拉宽（宽度即"一列"这个语义）。
          */}
          {columns.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              todos={visibleCards(getTodosByStatus(status), visibility, COLUMNS)}
              collapsed={collapsedColumns.includes(status)}
              onToggle={toggleColumn}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onPin={handlePin}
              onAdd={handleAdd}
            />
          ))}
        </div>
        <DragOverlay>
          <div className="w-64 h-20 bg-bg-card/80 rounded-card shadow-drag border border-accent/30" />
        </DragOverlay>
      </DndContext>

      {/* 撤销删除提示条 */}
      <UndoSnackbar />

      {/*
        删父任务的二次确认：子任务不会跟着消失，只会解绑成孤儿。
        这个后果必须在删之前说，而不是删完再解释。
      */}
      {unlinkPrompt && (
        <Dialog open onClose={() => setUnlinkPrompt(null)}>
          <div className="w-88 flex flex-col gap-3">
            <h3 className="text-body font-semibold text-text-primary">
              删除「{unlinkPrompt.title}」？
            </h3>
            <p className="text-label text-text-secondary leading-relaxed">
              其下 <span className="text-accent font-medium">{unlinkPrompt.count}</span> 个子任务将保留为独立事项。
            </p>
            <div className="flex justify-end gap-2 mt-1">
              <Button variant="ghost" size="sm" onClick={() => setUnlinkPrompt(null)}>
                取消
              </Button>
              <Button variant="dangerSolid" size="sm" onClick={confirmUnlinkDelete}>
                删除
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/*
        驳回理由弹框（1.0.54）：拖「待验收 → 进行中」时弹出。
        理由必填 —— 一句话说清"哪里没做好"，否则执行方只能盲改，
        这正是本功能要消灭的情形（见 todo.repository 的驳回通知注释）。
      */}
      {pendingReject && (
        <Dialog
          open
          /**
           * 遮罩点击走这里（见 ui/Dialog）—— 理由已经随手落在草稿里（卡 6a595ad0），
           * 所以照旧关掉就好：再拖一次这张卡，理由会原样回来。
           * 这里**不许**清草稿：点遮罩多半是"先不看这个"，不是"这段理由不要了"。
           */
          onClose={() => setPendingReject(null)}
        >
          <RejectPrompt
            todoId={pendingReject.id}
            title={pendingReject.title}
            onCancel={() => setPendingReject(null)}
            onConfirm={(reason) => void confirmReject(reason)}
          />
        </Dialog>
      )}

      {/*
        拖拽被拒提示条：候选池守卫（G1/G2）在主进程挡下非法迁移时，
        卡片回滚到原列，同时这里说明原因 —— 没有 explanation 的回滚
        会被当成"拖拽坏了"。
      */}
      {dragError && (
        <div
          className={cn(
            'absolute bottom-4 left-1/2 -translate-x-1/2 z-50 animate-slide-up',
            'frosted-glass rounded-card px-4 py-2 shadow-float max-w-notice'
          )}
          role="alert"
        >
          <span className="text-content text-text-primary">{dragError}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 驳回理由输入框（1.0.54）
 *
 * 拖「待验收 → 进行中」时弹出。为什么不让它直接流转、事后再说理由：
 * 事后写理由等于"先退回去，再解释" —— 执行方可能已经重开了，
 * 而理由本该是**要不要退、退回去干什么**的依据，必须在流转前给。
 *
 * 理由必填（确定按钮在空输入时禁用）：驳回理由说不清，退回就没有意义。
 */
const RejectPrompt: React.FC<{
  /** 理由按这条事项留草稿（卡 6a595ad0），所以要把 id 传进来 */
  todoId: string
  title: string
  onCancel: () => void
  onConfirm: (reason: string) => void
}> = ({ todoId, title, onCancel, onConfirm }) => {
  /**
   * 理由随手落一份草稿（卡 6a595ad0）
   *
   * 此前 reason 只活在这个弹窗自己的 state 里，而遮罩一点就是 onClose →
   * 弹窗卸载 → 写了一半的理由跟着没了：没有提示，也没有任何地方能找回来。
   * 现在每敲一个字就按 todoId 记一份，关掉（遮罩 / 取消）之后再拖一次这张卡，
   * 理由原样回来，并明说这是上次那段。
   *
   * 清除点只有两个：**提交成功**（它已经落成评论了）和用户点「放弃这段理由」。
   * 取消刻意不清 —— 它是"这次先不驳回"，不等于"这段理由不要了"。
   */
  const [reason, setReason] = React.useState(() => readRejectReason(todoId))
  const [restored, setRestored] = React.useState(() => readRejectReason(todoId).trim().length > 0)
  const canSubmit = reason.trim().length > 0
  /** 每次输入都写穿到草稿：等到卸载时再存就晚了（关掉的路径不止一条） */
  const edit = (v: string) => {
    setReason(v)
    writeRejectReason(todoId, v)
  }
  return (
    <div className="w-dialog-sm flex flex-col gap-3">
      <h3 className="text-body font-semibold text-text-primary">驳回「{title}」</h3>
      <p className="text-label text-text-secondary leading-relaxed">
        请填写退回原因，将作为评论通知执行方。
      </p>
      <textarea
        autoFocus
        value={reason}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
            e.preventDefault()
            onConfirm(reason)
          }
        }}
        placeholder="哪里没做好 / 要改什么……（⌘/Ctrl + Enter 提交）"
        rows={4}
        maxLength={2000}
        className="w-full bg-transparent border border-border rounded-input px-2 py-1.5
          text-label outline-none resize-y placeholder:text-text-secondary/60
          focus:border-accent transition-colors"
      />
      {/*
        恢复提示：只说"还在"不够 —— 要让人知道这不是他刚打的字，
        并且给一条明确的退路把它彻底丢掉（卡 6a595ad0 要的"明确放弃"）。
      */}
      {restored && reason.trim().length > 0 && (
        <p className="text-label text-text-secondary flex items-center gap-2">
          上次没提交的理由还在
          <button
            type="button"
            onClick={() => {
              edit('')
              clearRejectReason(todoId)
              setRestored(false)
            }}
            className="text-accent hover:underline"
          >
            放弃这段理由
          </button>
        </p>
      )}
      <div className="flex justify-end gap-2 mt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" disabled={!canSubmit} onClick={() => onConfirm(reason)}>
          确认退回
        </Button>
      </div>
    </div>
  )
}
