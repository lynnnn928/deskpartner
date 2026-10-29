import React from 'react'
import { useUIStore } from '../../stores/ui.store'
import { Icon } from '../ui/Icon'

/**
 * 全局轻提示（1.0.48）
 *
 * 补的是一类此前**完全看不见**的失败：IPC 抛错只在 console.error 里留一行，
 * 界面上什么都没有 —— 人看到的是"我点了，没反应"，既不知道失败，
 * 也不知道该重试还是放弃。写操作失败尤其不能沉默。
 *
 * 刻意做成最小的一条：只说结果，不带按钮、不阻塞操作、几秒自己走。
 * 它不是对话框 —— 对话框要求人当场处理，而这类失败只需要让人知道。
 */
export const Toast: React.FC = () => {
  const toast = useUIStore((s) => s.toast)
  const clearToast = useUIStore((s) => s.clearToast)

  if (!toast) return null

  return (
    <div className="absolute bottom-4 left-4 z-50 animate-slide-up max-w-toast" role="alert">
      <button
        onClick={clearToast}
        title="知道了"
        className="frosted-glass rounded-card px-4 py-2 flex items-center gap-2 shadow-float
          border border-red-500/30 text-left"
      >
        <Icon name="alertTriangle" size={13} className="text-red-500 shrink-0" />
        <span className="text-content text-text-primary">{toast}</span>
      </button>
    </div>
  )
}
