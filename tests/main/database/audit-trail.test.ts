import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { buildTodoAudit } from '../../../src/main/lib/audit-text'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 留痕的读取侧（1.0.62，接续 68c7ccc1 与 b3ac3d32）
 *
 * ── 为什么这两类现象必须各有一组断言 ──
 *
 * 这两处的失败方式都不是报错，而是**安静地交出一份不完整的档案**：
 *
 * 1. 墓碑（todo_deleted 事件）跟着 events 的 7 天保留策略一起被清掉，
 *    于是 `todo history` 上周还答得出、这周变成 not_found —— 查不到与没删过
 *    在界面上是同一句"待办不存在"，使用者没有任何办法分辨；
 * 2. 改描述写侧的 type 恒为 'todo'、靠 payload.action 区分动作，翻译层若只认
 *    type 就掉进兜底分支，交出一行「某人 · todo」，也就是"写了但读不出"。
 *
 * 两者都属于"担件事做过"与"担得住追问"之间的落差，而这类落差靠读代码看不出来，
 * 只能靠断言把它锁住：一旦将来有人合并了事件类型、或给 events 换了保留策略，
 * 这里应当立刻红。
 *
 * 判据一律取端到端形态：写进 events → prune → 再把能读出来的东西交给人看，
 * 而不是断言某个中间函数的返回值。
 */

const TODO = '11112222-3333-4444-5555-666677778888'

function insertEvent(type: string, actor: string, payload: unknown, createdAt: string): void {
  db.prepare('INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)').run(
    type,
    actor,
    payload === null ? null : JSON.stringify(payload),
    createdAt
  )
}

function now(): string {
  return new Date().toISOString()
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString()
}

function remainingTypes(): string[] {
  return (db.prepare('SELECT type FROM events').all() as { type: string }[]).map((r) => r.type)
}

beforeAll(() => {
  runMigrations(db)
})

beforeEach(() => {
  db.prepare('DELETE FROM events').run()
})

describe('events 的清理不能吃掉墓碑', () => {
  it('按时间过期时，墓碑留下、同期的普通流水被清掉', () => {
    insertEvent('todo_deleted', 'human', { snapshot: { id: TODO } }, daysAgo(100))
    insertEvent('todo', 'human', { todoId: TODO, action: 'status_changed' }, daysAgo(100))

    const removed = new EventsRepository().prune(7, 2000)

    // 反向验证：若墓碑被一并清掉，这里会是 2 —— 数字本身就把现象锁住了
    expect(removed).toBe(1)
    expect(remainingTypes()).toContain('todo_deleted')
    expect(remainingTypes()).not.toContain('todo')
  })

  it('按条数上限挤掉老记录时，最老的墓碑也不能被挤出去', () => {
    insertEvent('todo_deleted', 'human', { snapshot: { id: TODO } }, daysAgo(2))
    for (let i = 0; i < 5; i++) {
      insertEvent('memo', 'human', {}, new Date(Date.now() - i * 1000).toISOString())
    }

    new EventsRepository().prune(7, 2)

    expect(remainingTypes()).toContain('todo_deleted')
  })

  it('删掉的事项在清理之后仍然查得回来（end-to-end）', () => {
    insertEvent(
      'todo_deleted',
      'agent:alice',
      { snapshot: { id: TODO, title: '被删掉的那条需求', status: 'todo' } },
      daysAgo(30)
    )
    new EventsRepository().prune(7, 2000)

    const lines = buildTodoAudit(TODO)
    expect(lines.some((l) => l.kind === '删事项' && l.what.includes('被删掉的那条需求'))).toBe(true)
  })
})

describe('buildTodoAudit 把机器存的东西翻成人话', () => {
  it('改写描述要报出旧文与新文，不许掉进「某人 · todo」的兜底行', () => {
    insertEvent(
      'todo',
      'agent:alice',
      {
        cmd: 'todo update',
        action: 'description_changed',
        id: TODO,
        before: '旧的规格正文',
        after: '新的规格正文',
        mode: 'replace'
      },
      now()
    )

    const lines = buildTodoAudit(TODO)
    const hit = lines.find((l) => l.kind === '改描述')
    expect(hit).toBeTruthy()
    expect(hit!.what).toContain('旧的规格正文')
    expect(hit!.what).toContain('新的规格正文')
    // 反向：兜底分支只能产出「actor · type」，那一行没有任何可追问的信息
    expect(lines.some((l) => l.what === 'agent:alice · todo')).toBe(false)
  })

  it('追加模式如实说"原先没有"，不假装存在一份旧文', () => {
    insertEvent(
      'todo',
      'human',
      {
        cmd: 'todo update',
        action: 'description_changed',
        id: TODO,
        before: null,
        after: '补充一条约束',
        mode: 'append'
      },
      now()
    )

    const hit = buildTodoAudit(TODO).find((l) => l.kind === '改描述')
    expect(hit).toBeTruthy()
    expect(hit!.what).toContain('追加')
    expect(hit!.what).toContain('补充一条约束')
    expect(hit!.what).not.toContain('覆写')
  })

  it('原本没有描述却被整体写入时，如实说"原先没有"，不留一句空引号', () => {
    insertEvent(
      'todo',
      'human',
      {
        cmd: 'todo update',
        action: 'description_changed',
        id: TODO,
        before: '',
        after: '第一版规格',
        mode: 'replace'
      },
      now()
    )

    const hit = buildTodoAudit(TODO).find((l) => l.kind === '改描述')
    expect(hit!.what).toContain('原先没有描述')
    expect(hit!.what).not.toContain('旧文「」')
  })

  it('删评论照样要说清删掉的是哪一句', () => {
    insertEvent(
      'comment_deleted',
      'agent:alice',
      {
        comment: { todoId: TODO, body: '我承诺把 A 改成 B，代价是 C', authorId: 'agent:alice' },
        cascadedReplies: 2
      },
      now()
    )

    const lines = buildTodoAudit(TODO)
    expect(lines.some((l) => l.kind === '删评论' && l.what.includes('我承诺把 A 改成 B'))).toBe(true)
  })
})
