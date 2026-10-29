import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

let seq = 0
vi.mock('uuid', () => ({ v4: () => `tm-uuid-${++seq}` }))

/**
 * 远期提醒为什么必须测
 *
 * Node 的 setTimeout 延时超过 2147483647ms（约 24.8 天）会**溢出并被当作 1ms**。
 * 于是"30 天后提醒"在重启应用后立刻弹出 —— 用户看到的是一条莫名其妙的提醒，
 * 而代码里 delay 算得完全正确，看代码看不出问题。
 *
 * 这类"数值溢出"只有跑一遍才暴露：断言"设了远期提醒之后，
 * 短时间内不该有任何通知发出"。
 */
const { TimerService } = await import('../../../src/main/services/timer.service')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')

describe('TimerService 远期提醒', () => {
  let timer: InstanceType<typeof TimerService>
  let todoRepo: InstanceType<typeof TodoRepository>
  let categoryRepo: InstanceType<typeof CategoryRepository>
  /** @type {{ sendReminder: ReturnType<typeof vi.fn> }} */
  let notifier: { sendReminder: ReturnType<typeof vi.fn> }

  beforeAll(() => {
    runMigrations(db)
    todoRepo = new TodoRepository()
    categoryRepo = new CategoryRepository()
  })

  beforeEach(() => {
    notifier = { sendReminder: vi.fn() }
    timer = new TimerService(
      todoRepo,
      categoryRepo,
      notifier as never
    )
  })

  afterEach(() => {
    // 清掉可能挂着的定时器，避免污染其它用例
    timer.stop?.()
  })

  it('30 天后的提醒不会立刻触发（setTimeout 溢出保护）', async () => {
    const cat = categoryRepo.create({ name: '远期', color: '#111111', sortOrder: 0 })
    const proj = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined

    const todo = todoRepo.create({
      title: '30 天后才该提醒',
      categoryIds: [cat.id],
      projectId: proj?.id ?? null,
      remindAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    })

    timer.scheduleReminder(todo.id, todo.remindAt!)

    // 溢出的话 1ms 就会触发；等 100ms 足以让它现形
    await new Promise((r) => setTimeout(r, 100))
    expect(notifier.sendReminder).not.toHaveBeenCalled()
  })

  it('已过期的提醒仍然立即触发（不能被修坏）', async () => {
    const cat = categoryRepo.create({ name: '过期', color: '#222222', sortOrder: 1 })
    const proj = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined

    const todo = todoRepo.create({
      title: '早就该提醒了',
      categoryIds: [cat.id],
      projectId: proj?.id ?? null,
      remindAt: new Date(Date.now() - 60 * 1000).toISOString()
    })

    timer.scheduleReminder(todo.id, todo.remindAt!)
    await new Promise((r) => setTimeout(r, 50))
    expect(notifier.sendReminder).toHaveBeenCalledTimes(1)
  })
})
