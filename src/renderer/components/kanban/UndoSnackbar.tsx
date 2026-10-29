import React, { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useTodoStore } from '../../stores/todo.store'
import { invoke } from '../../lib/ipc-client'
import { Icon } from '../ui/Icon'

/**
 * 撤销提示条（1.0.48 做真）
 *
 * 之前它只是一句「事项已删除」+ 一个点了什么都不做的按钮 ——
 * undoQueue 从来没有调用方往里放东西，删除是**立刻生效**的。
 * 界面上摆一个假的撤销，比没有撤销更糟：它让人放心地按下删除。
 *
 * 现在队列里的每一项都带着**操作前的完整快照**（见 ui.store 的 UndoItem），
 * 撤销 = 把这份快照原样交回主进程（todo:restore），
 * 而不是"新建一条长得一样的" —— 后者会换掉 id，子任务引用全断。
 *
 * 4 秒窗口是刻意的：撤销是给"手滑"留的余地，不是第二份回收站。
 * 倒计时显示出来，是让人知道这个余地正在关上。
 */
export const UndoSnackbar: React.FC = () => {
  const { undoQueue, removeUndoItem, showToast } = useUIStore()
  const { fetchTodos } = useTodoStore()
  const [busy, setBusy] = useState(false)
  /** 剩余秒数：只作显示，真正的过期由 store 里的定时器负责 */
  const [left, setLeft] = useState(4)

  const latest = undoQueue[undoQueue.length - 1]

  useEffect(() => {
    if (!latest) return
    setLeft(4)
    const timer = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(timer)
    // 换一条可撤销项就重新计时；latest 整个对象进依赖会每次渲染都重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id])

  if (!latest) return null

  const handleUndo = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await invoke('todo:restore', { todo: latest.snapshot })
      removeUndoItem(latest.id)
      await fetchTodos()
      /**
       * 撤销**不是全有全无**（1.0.111，卡 `df06e4d7`）：窗口期内被改派给别人的
       * 子事项不会被拨回旧父级 —— 那等于用旧关系覆盖人的新决定。
       *
       * 不说出来才是最坏的：人以为"撤销 = 原样回来"，而丢掉的那几个关联
       * 在界面上一点痕迹都没有（这正是本卡要修的故障形状）。
       * 所以只要回执里有话要说（评论没全回来之外的任何一种），就如实报一句。
       */
      if (result.conflicts.length > 0) {
        const first = result.conflicts[0]
        const more = result.conflicts.length > 1 ? `（共 ${result.conflicts.length} 条）` : ''
        showToast(`已撤销；「${first.title}」未被挪回：${first.reason}${more}`)
      } else if (result.commentsRestored > 0) {
        showToast(`已撤销，${result.commentsRestored} 条评论一并恢复`)
      }
    } catch (err) {
      // 撤销失败必须说出来：此时人以为东西回来了，其实没有
      showToast(err instanceof Error ? `撤销失败：${err.message}` : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 animate-slide-up"
      role="status"
    >
      <div className="frosted-glass rounded-card px-4 py-2 flex items-center gap-3 shadow-float max-w-snackbar">
        <Icon name="clock" size={13} className="text-text-secondary shrink-0" />
        <span className="text-content text-text-primary truncate">{latest.label}</span>
        <span className="font-mono text-label text-text-secondary shrink-0">
          {left}s
        </span>
        <button
          onClick={() => void handleUndo()}
          disabled={busy}
          className="text-content text-accent hover:text-accent/80 font-medium transition-colors
            disabled:opacity-50 shrink-0"
        >
          撤销
        </button>
      </div>
    </div>
  )
}
