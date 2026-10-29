import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readCliChain } from './cli-chain'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import {
  CLOSURE_SECTION,
  CLOSURE_SECTION_MARKERS,
  hasClosureSections
} from '../../../src/main/database/closure-structure'

/**
 * 卡 `eec2e1e7`：G5 判据从"有没有评论"升级为"收口结论里有没有结构性要素"。
 *
 * Bob实测的病：**一次批量关 30 张卡，G5 全部放行**，而其中一半当初只有一行字。
 * 本文件钉三件事：
 *   ① 判据本身（四段标记里至少一个）；
 *   ② 它**只有一处**（G5 两个触发点 + `closureByTodo` 共用），且旧判据（数评论条数）已消失；
 *   ③ 批量关多张卡时，缺收口结论的**能逐条看出来**（顶层一次 + `results[i].notice` 点名）。
 *
 * ⚠️ 断言打在**最终信封**（`formatOutcome` 的 stdout）上，不是中间 Outcome ——
 * 提醒跨不过 output 层的话，调用方看不见，测中间对象会假绿。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/** 与 commands.test.ts 同一条坑：只 mock 数据库时 `writeCredential()` 会写真实凭据文件 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const commentRepo = new CommentRepository()

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      memoRepo: { list: () => [], add: () => ({ id: 'm1' }), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: {
        get: () => null,
        list: () => [],
        touch: () => null,
        markWrite: () => null,
        listGrants: () => [],
        findUsableGrant: () => null,
        findAnyUsableGrant: () => null,
        findLatestGrant: () => null,
        consumeGrant: () => null
      },
      events: { append: () => {} },
      telemetry: { record: () => {}, query: () => [], stats: () => null, clear: () => 0 }
    },
    meta: {
      version: '1.0.110',
      dbPath: ':memory:',
      schemaVersion: 45,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    interactive: true,
    actor: 'human',
    ...over
  } as never
}

/** 跑一条命令，回**最终信封** */
async function run(args: string[]) {
  const outcome = await executeOne(makeCtx(), args)
  const { stdout } = formatOutcome(outcome, args, false)
  return JSON.parse(stdout) as {
    ok: boolean
    notice?: string
    code?: number | string
    data?: Record<string, unknown>
  }
}

const FOUR_SECTION_MS =
  `${CLOSURE_SECTION.did}把 X 改成了 Y\n` +
  `${CLOSURE_SECTION.verified}跑了 Z，看到 W\n` +
  `${CLOSURE_SECTION.passCriteria}目标是 T，达成到 T\n`

/**
 * 断言"G5 这一句在不在"而不是"notice 有没有值"：
 * notice 是**多来源合并**的（未读摘要、G8、描述骤降…都往这里写），
 * 拿 `undefined` 当"没提醒"会被旁边那句摘要弄成偶然绿。
 */
const hasG5 = (env: { notice?: string }) => Boolean(env.notice?.includes('G5'))

function seed(title = '普通事项') {
  const cat = categoryRepo.list()[0] ?? categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  return todoRepo.create({ title, categoryIds: [cat.id] })
}

function addComment(todoId: string, body: string, kind: 'comment' | 'reject' = 'comment') {
  return commentRepo.create({ todoId, body, authorType: 'agent', authorId: 'agent:worker', kind })
}

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_comments').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  projectRepo.create({ name: '测试项目' })
})

describe('判据：收口结论里有没有结构性要素（静态可判）', () => {
  it('四段标记里任意一个都算 —— 逐段验，不留"只认一段"的死角', () => {
    for (const marker of CLOSURE_SECTION_MARKERS) {
      expect(hasClosureSections([`${marker}随便写点什么`]), `${marker} 应当算结构性要素`).toBe(true)
    }
    expect(
      CLOSURE_SECTION_MARKERS,
      '判据覆盖的标记就是 todo close 写出去的那四段'
    ).toEqual([
      CLOSURE_SECTION.did,
      CLOSURE_SECTION.verified,
      CLOSURE_SECTION.passCriteria,
      CLOSURE_SECTION.leftover
    ])
  })

  it('空值 / 一句话 / 只有空白 都不算 —— Bob那 30 张里的一半正是这个形状', () => {
    expect(hasClosureSections([null, undefined, '', '   '])).toBe(false)
    expect(hasClosureSections(['做完了'])).toBe(false)
    expect(hasClosureSections(['结论：已按新口径落地'])).toBe(false)
    // 多段里任意一段带标记就算 —— 判定与拼接顺序无关
    expect(hasClosureSections(['做完了', `${CLOSURE_SECTION.did}改了 X`])).toBe(true)
  })
})

describe('G5 两个触发点：同一份文本、同一个结论', () => {
  it('直连：一句话的评论不算收口结论 → 标完成时带 G5 提醒', async () => {
    const t = seed()
    addComment(t.id, '做完了')
    const env = await run(['todo', 'update', t.id, '--status', 'done'])
    expect(env.ok).toBe(true)
    expect(env.notice, '有评论不等于交代过了 —— 这一档必须被念到').toContain('G5')
    expect(todoRepo.getById(t.id)!.status).toBe('done')
  })

  it('直连：带四段标记的评论算收口结论 → 不再提醒', async () => {
    const t = seed()
    addComment(t.id, FOUR_SECTION_MS)
    const env = await run(['todo', 'update', t.id, '--status', 'done'])
    expect(env.ok).toBe(true)
    expect(hasG5(env), '写了四段收口结论还被念 = 误报，agent 会学会无视它').toBe(false)
  })

  it('直连：描述与评论都没有 → 仍然提醒（旧行为不退化）', async () => {
    const t = seed()
    const env = await run(['todo', 'update', t.id, '--status', 'done'])
    expect(env.notice).toContain('G5')
  })

  it('直连：一句自带标记的 --comment 就算收口结论（同一批调用里给的理由也是结论）', async () => {
    const t = seed()
    const env = await run([
      'todo',
      'update',
      t.id,
      '--status',
      'done',
      '--comment',
      `${CLOSURE_SECTION.did}顺手把它关了`
    ])
    expect(hasG5(env), '一次调用里给的 --comment 就是这次的收口结论').toBe(false)
  })

  it('驳回评论不算收口结论（驳回理由是"哪里没做好"，与"为什么算完了"相反）', async () => {
    const t = seed()
    addComment(t.id, `${CLOSURE_SECTION.did}驳回：这一步没做`, 'reject')
    const env = await run(['todo', 'update', t.id, '--status', 'done'])
    expect(env.notice, '拿一句驳回理由冒充收口结论，G5 必须仍然说话').toContain('G5')
  })

  it('todo done 与 todo update --status done 结论一致（两条路不许两个判据）', async () => {
    // 描述与评论都空：两条路都提醒
    const bare1 = seed('空描述 A')
    const bare2 = seed('空描述 B')
    expect(hasG5(await run(['todo', 'done', bare1.id])), 'todo done 这条要提醒').toBe(true)
    expect(
      hasG5(await run(['todo', 'update', bare2.id, '--status', 'done'])),
      'todo update 这条要提醒'
    ).toBe(true)

    // 有收口结论：两条路都不提醒（todo done 此前只看描述，会白念这一档）
    const done1 = seed('有结论 A')
    const done2 = seed('有结论 B')
    addComment(done1.id, FOUR_SECTION_MS)
    addComment(done2.id, FOUR_SECTION_MS)
    expect(
      hasG5(await run(['todo', 'done', done1.id])),
      '描述空但评论里有四段收口 —— todo done 此前会白念一句'
    ).toBe(false)
    expect(hasG5(await run(['todo', 'update', done2.id, '--status', 'done']))).toBe(false)
  })
})

describe('批量关多张卡：缺收口结论的能逐条看出来', () => {
  it('5 张里 3 张只有一句话 → 顶层提醒在，results 里恰好点名那 3 张', async () => {
    const withClosure = [seed('有结论 1'), seed('有结论 2')]
    const without = [seed('一句话 1'), seed('一句话 2'), seed('一句话 3')]
    for (const t of withClosure) addComment(t.id, FOUR_SECTION_MS)
    for (const t of without) addComment(t.id, '做完了')

    const order = [...withClosure, ...without]
    const stdin = order.map((t) => JSON.stringify({ cmd: 'todo done', positional: [t.id] })).join('\n')
    const outcome = await executeOne(makeCtx({ stdin }), ['batch'])
    const { stdout } = formatOutcome(outcome, ['batch'], false)
    const env = JSON.parse(stdout) as {
      ok: boolean
      notice?: string
      data: { results: { ok: boolean; notice?: string }[] }
    }

    expect(env.ok).toBe(true)
    expect(env.notice, '批量关卡也要能看出"这批里有没收口的"').toContain('G5')

    const flagged = env.data.results.map((r, i) => ({ i, missing: Boolean(r.notice?.includes('G5')) }))
    expect(
      flagged.filter((x) => x.missing).map((x) => x.i),
      '被点名的恰好是那 3 张只有一句话的（按提交顺序：2、3、4）'
    ).toEqual([2, 3, 4])
    expect(order.every((t) => todoRepo.getById(t.id)!.status === 'done'), '提醒不拦执行').toBe(true)
  })
})

describe('判据只有一处：G5 与 closureByTodo 同源', () => {
  it('closureByTodo：描述带标记也算，一条评论都没有的卡回 false 而不是"缺键"', () => {
    const inDesc = seed('结论写在描述里')
    todoRepo.update({ id: inDesc.id, description: FOUR_SECTION_MS })
    const bare = seed('什么都没有')
    const map = new CommentRepository().closureByTodo([inDesc.id, bare.id])
    expect(map[inDesc.id].hasClosure, '描述也是书面依据').toBe(true)
    expect(Object.prototype.hasOwnProperty.call(map, bare.id), '不能靠"缺键"表达结论').toBe(true)
    expect(map[bare.id].hasClosure).toBe(false)
  })

  it('todo close 写出去的四段就是判据认的那四段（写与判同一个常量）', async () => {
    const t = seed()
    const env = await run([
      'todo',
      'close',
      t.id,
      '--did',
      '把 X 改了',
      '--verified',
      '跑了本文件',
      '--pass-criteria',
      '四段齐就算过',
      '--leftover',
      '没有遗留'
    ])
    expect(env.ok).toBe(true)
    const body = commentRepo.listByTodo(t.id)[0].body
    for (const marker of CLOSURE_SECTION_MARKERS) {
      expect(body, `todo close 没写 ${marker}，判据就永远判不过`).toContain(marker)
    }
    expect(hasClosureSections([body])).toBe(true)
  })

  it('静态闸门：G5 两处都调 missingClosure，数评论条数的旧判据已消失', () => {
    const src = readCliChain()
    const calls = src.split('missingClosure(').length - 1
    expect(calls, 'missingClosure 的调用点应当是 2 处 G5 + 1 处定义').toBe(3)
    // 归一空白后再比：断言不该被换行/缩进改动弄红
    const flat = src.replace(/\s+/g, ' ')
    expect(
      flat,
      'todo update 那条（G5）必须走共用判据，而不是自己数评论条数'
    ).toContain("patch.status === 'done' && missingClosure(ctx, updated.description, updated.id)")
    expect(
      flat.split('countByTodo(updated.id) === 0').length - 1,
      '数评论条数的旧判据只剩 G3 那一处 —— G5 已升级为结构判据'
    ).toBe(1)
    const gate = readFileSync('src/main/database/closure-structure.ts', 'utf-8')
    expect(
      gate.split('CLOSURE_SECTION_MARKERS').length - 1,
      '标记数组一处定义、一处被扫 —— 改一处即改全部'
    ).toBe(2)
    const repo = readFileSync('src/main/database/comment.repository.ts', 'utf-8')
    expect(repo, 'closureByTodo 也走同一个判据').toContain('hasClosureSections(')
    expect(repo, 'closureByTodo 仍然是一次查询（批量，不是逐条）').toContain('GROUP_CONCAT')
    expect(
      repo,
      '不再用"哪段评论的正文像收口结论"的 SQL 匹配（只认一段，判据必须落在共用函数里）'
    ).not.toContain('body LIKE')
  })
})
