import type { BrowserWindow } from 'electron'
import type { Todo } from '../../renderer/types/todo'
import type { Category } from '../../renderer/types/category'
import { NotificationRepository } from '../database/notification.repository'

/** 顶部提醒横幅要显示的内容 */
export interface ReminderBannerPayload {
  todoId: string
  title: string
  categoryName: string
}

/**
 * 提醒服务
 *
 * 1.0.34 起不再用 Windows 系统通知（Notification）：它的弹出位置（右下角）
 * 和底色都由系统决定，代码控制不了 —— 主用户要求提醒从**屏幕上方**弹出、
 * 警告类的底色用**红色**，自绘横幅才能做到。
 * 横幅窗口由 WindowManager 创建（showReminderBanner），这里只负责组装内容
 * 与维护"用户没处理"的未读推送。
 */
export class NotificationService {
  /** 窗口引用获取函数，用于推送事件到渲染进程 */
  private getWindows: () => {
    floatBall?: BrowserWindow | null
    quickAdd?: BrowserWindow | null
    kanban?: BrowserWindow | null
    settings?: BrowserWindow | null
  }

  /** 显示顶部提醒横幅（由 WindowManager 提供） */
  private showBanner: (payload: ReminderBannerPayload) => void

  /** 提醒触发的回调（用于更新 todo 状态等） */
  private onReminderAction?: (action: string, todoId: string) => void

  constructor(options: {
    getWindows: () => {
      floatBall?: BrowserWindow | null
      quickAdd?: BrowserWindow | null
      kanban?: BrowserWindow | null
      settings?: BrowserWindow | null
    }
    /** 显示顶部横幅；缺了就退回只推未读事件（横幅窗口建不起来时的兜底） */
    showBanner?: (payload: ReminderBannerPayload) => void
    onReminderAction?: (action: string, todoId: string) => void
  }) {
    this.getWindows = options.getWindows
    this.showBanner = options.showBanner ?? (() => {})
    this.onReminderAction = options.onReminderAction
  }

  /** 发送待办提醒：顶部横幅（红底，见 ReminderBanner 组件） */
  sendReminder(todo: Todo, category: Category): void {
    this.showBanner({
      todoId: todo.id,
      title: todo.title,
      categoryName: category.name ?? ''
    })
    /**
     * 通知中心（1.0.48）：横幅是 push、收件箱是留底 —— 同源不重复计数：
     * 横幅本身不计数，未读数永远只数 notifications 表。
     * 人不在电脑前时横幅会过期，收件箱里的这条还在。
     */
    try {
      new NotificationRepository().create({
        type: 'reminder',
        title: `到点了：${todo.title}`,
        refId: todo.id
      })
    } catch (e) {
      console.warn('[Notification] 提醒索引写入失败:', e instanceof Error ? e.message : e)
    }
    console.log(`[Notification] 已弹出提醒横幅: ${todo.title}`)
  }

  /** 推送未处理提醒到渲染进程（用户点「知道了」关掉横幅时走这里） */
  pushUnreadReminder(todo: Todo): void {
    const windows = this.getWindows()
    const payload = {
      todoId: todo.id,
      title: todo.title,
      categoryName: ''
    }

    // 向所有窗口推送提醒事件
    for (const win of Object.values(windows)) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('event:reminderTriggered', payload)
      }
    }
  }
}
