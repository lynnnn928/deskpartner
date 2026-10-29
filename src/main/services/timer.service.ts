import { TodoRepository } from '../database/todo.repository'
import { CategoryRepository } from '../database/category.repository'
import type { NotificationService } from './notification.service'
import type { Todo } from '../../renderer/types/todo'

/**
 * Node setTimeout 的最大安全延时（32 位有符号毫秒上限）
 *
 * 超过这个值会被当作 1ms 处理 —— 不是"等很久"，而是"立刻触发"。
 */
const MAX_TIMEOUT_DELAY_MS = 2147483647

/** 定时提醒调度器
 * 管理所有待办事项的提醒定时器
 */
export class TimerService {
  /** 待触发的定时器映射：todoId → NodeJS.Timeout */
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private todoRepo: TodoRepository,
    private categoryRepo: CategoryRepository,
    private notificationService: NotificationService
  ) {}

  /** 应用启动时恢复所有未触发的提醒 */
  start(): void {
    // 恢复未触发的提醒
    const pending = this.todoRepo.getPendingReminders()
    for (const todo of pending) {
      this.scheduleReminder(todo.id, todo.remindAt!)
    }

    // 处理过期的提醒（立即触发）
    const overdue = this.todoRepo.getOverdueReminders()
    for (const todo of overdue) {
      console.log(`[Timer] 待办「${todo.title}」的提醒已过期，立即触发`)
      this.triggerReminder(todo)
    }

    console.log(
      `[Timer] 启动完成，已恢复 ${pending.length} 个未触发提醒，触发 ${overdue.length} 个过期提醒`
    )
  }

  /** 注册一个提醒定时器 */
  scheduleReminder(todoId: string, remindAt: string): void {
    // 先取消已有的定时器
    this.cancelReminder(todoId)

    const remindTime = new Date(remindAt).getTime()
    const now = Date.now()
    const delay = remindTime - now

    if (delay <= 0) {
      // 已过期，立即触发
      const todo = this.todoRepo.getById(todoId)
      if (todo) {
        this.triggerReminder(todo)
      }
      return
    }

    /**
     * 超过这个值的 delay 会**溢出并被当成 1ms** —— 设"30 天后提醒"，
     * 重启应用就会立刻弹窗。24.8 天是 Node 的 setTimeout 上限
     * （32 位有符号毫秒）。
     */
    const capped = Math.min(delay, MAX_TIMEOUT_DELAY_MS)
    const needsRelay = delay > MAX_TIMEOUT_DELAY_MS

    const timer = setTimeout(() => {
      /**
       * 接力（1.0.38）：还没到点就重新排一次。
       *
       * 光把 delay 夹到上限是不够的 —— 那会让一个 30 天后的提醒
       * 在第 24.8 天就响，等于提前 5 天打扰。这里改成睡满上限后醒来
       * 重新算剩余时间，层层递减，直到真正到期才触发。
       */
      if (needsRelay) {
        this.scheduleReminder(todoId, remindAt)
        return
      }

      const todo = this.todoRepo.getById(todoId)
      if (todo && todo.status !== 'done' && todo.status !== 'discarded') {
        this.triggerReminder(todo)
      }
      this.timers.delete(todoId)
    }, capped)

    this.timers.set(todoId, timer)
    console.log(
      `[Timer] 已注册提醒: ${todoId}，${Math.round(delay / 1000)}秒后触发` +
        (needsRelay ? `（超过 ${MAX_TIMEOUT_DELAY_MS}ms，分 ${Math.ceil(delay / MAX_TIMEOUT_DELAY_MS)} 段接力）` : '')
    )
  }

  /** 取消一个提醒定时器 */
  cancelReminder(todoId: string): void {
    const timer = this.timers.get(todoId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(todoId)
    }
  }

  /** 延后提醒（稍后提醒） */
  snoozeReminder(todoId: string, minutes: number): void {
    this.cancelReminder(todoId)

    const remindAt = new Date(Date.now() + minutes * 60 * 1000).toISOString()
    /**
     * 复用 scheduleReminder（1.0.38）：它内部有溢出保护，
     * 这里再手写一遍 setTimeout 就会出现"延后很久反而不生效"的另一处漏洞。
     */
    this.scheduleReminder(todoId, remindAt)
    console.log(`[Timer] 已延后提醒: ${todoId}，${minutes}分钟后触发`)
  }

  /** 获取所有待触发的提醒 todoId 列表 */
  getPendingReminders(): string[] {
    return Array.from(this.timers.keys())
  }

  /** 应用退出时清理所有定时器 */
  stop(): void {
    for (const [todoId, timer] of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
    console.log('[Timer] 已清理所有定时器')
  }

  /** 触发提醒通知 */
  private triggerReminder(todo: Todo): void {
    // 检查待办是否已完成
    if (todo.status === 'done') {
      console.log(`[Timer] 待办「${todo.title}」已完成，跳过提醒`)
      return
    }

    // 获取分类信息
    const category = this.categoryRepo.getById(todo.categoryId)

    // 发送通知
    this.notificationService.sendReminder(
      todo,
      category ?? { id: '', name: '未分类', color: '#CBD5E1', isDefault: true, sortOrder: 0 }
    )

    console.log(`[Timer] 已触发提醒: ${todo.title}`)
  }
}
