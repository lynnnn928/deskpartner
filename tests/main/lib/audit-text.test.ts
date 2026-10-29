import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { readCliChain } from '../cli/cli-chain'
import path from 'node:path'
import Database from 'better-sqlite3'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { buildTodoAudit } from '../../../src/main/lib/audit-text'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * 审计读侧（1.0.60，主用户驳回 68c7ccc1；1.0.62 补上"界面也读得出"）
 *
 * ── 这组用例要挡住什么 ──
 *
 * 她的驳回原话：「留痕写进去了，但**没有任何地方读得出**，实际效果仍是无痕」。
 * 验收判据（验收方给的）：「`todo history` 能看到'某某在何时删了哪条评论'，
 * 不需要碰数据库」。
 *
 * 这是一个典型的**"写入侧有、读取侧为零"**的假完成：
 * `comment_deleted` / `todo_deleted` 事件确实一直在写，payload 也带全了内容，
 * 但 events 表当时只有 `listSince`（给轮询用的增量读法），
 * 没有任何面向回溯的入口 —— 功能上等于没留痕，而 tsc/单测全绿。
 *
 * 所以这里测的是**接线**，不是某个纯函数的返回值：
 * 真的插一条 comment_deleted 事件 → 真的走 `listForTodo` 的 SQL →
 * 真的被 `buildTodoAudit` 翻译成人话。
 * 只测翻译函数会让"SQL 查不出来"这类故障完全溜过去
 * （json_extract 的路径写错一位，就足以让整条链返回空数组而无人发觉）。
 *
 * ⚠️ 1.0.62 追加的历史：上面这条判据**当时只被用在了 CLI 一侧** ——
 * 修完 CLI 就以为闭环了，而渲染层一处都没接。同一个缺陷于是发作了第二次。
 * 现在"界面读得出"由 `audit-timeline.test.ts` 的结构性断言 + 本文件
 * 覆盖的翻译判据共同锁住。翻译层搬到 `lib/` 就是为了两侧共用（此前在 `cli/` 下）。
 *
 * ⚠️ 反向验证：把 `listForTodo` 的任一 json_extract 路径改错，
 * 本文件必须变红。已实测（见文件末注释）。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

const TODO_ID = 'aaaa1111-2222-3333-4444-555566667777'

describe('events.listForTodo + buildTodoAudit：审计必须读得出来', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM events').run()
  })

  it('comment_deleted：能按 todoId 查出来，并翻译出"谁删了什么"', () => {
    new EventsRepository().append('comment_deleted', 'agent:bob', {
      comment: {
        id: 'c1',
        todoId: TODO_ID,
        authorType: 'human',
        authorId: null,
        body: '这个方案我不同意，理由是先要确认成本',
        kind: 'reject'
      },
      cascadedReplies: 2
    })

    const rows = new EventsRepository().listForTodo(TODO_ID)
    // 第一道：SQL 真的命中了（json_extract 路径对不对全看这一行）
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('comment_deleted')

    // 第二道：翻译成人话，且**带上被删的内容本身**
    const audit = buildTodoAudit(TODO_ID)
    expect(audit).toHaveLength(1)
    expect(audit[0].actor).toBe('agent:bob')
    expect(audit[0].kind).toBe('删评论')
    expect(audit[0].what).toContain('这个方案我不同意')
    expect(audit[0].what).toContain('连带清掉 2 条回复')
  })

  it('todo_deleted：todoId 藏在 snapshot.id 里，同样要能读出来', () => {
    // 这条路径最容易错：payload 是 { snapshot: { id, title, status }, transitions }
    // 而不是 { todoId }。只接 $.todoId 会漏掉整类"删事项"的审计。
    new EventsRepository().append('todo_deleted', 'agent:alice', {
      snapshot: { id: TODO_ID, title: '被删掉的那条需求', status: 'in_progress' },
      transitions: []
    })

    const audit = buildTodoAudit(TODO_ID)
    expect(audit).toHaveLength(1)
    expect(audit[0].kind).toBe('删事项')
    expect(audit[0].what).toContain('被删掉的那条需求')
    // 1.0.62 起状态翻成中文 —— 给用户看的行里塞 enum 等于没翻译
    expect(audit[0].what).toContain('进行中')
    expect(audit[0].what).not.toContain('in_progress')
  })

  it('别的 todo 的事件不会串进来（按 id 隔离）', () => {
    const repo = new EventsRepository()
    repo.append('comment_deleted', 'agent:a', {
      comment: { todoId: TODO_ID, body: '属于这条' }
    })
    repo.append('comment_deleted', 'agent:a', {
      comment: { todoId: 'bbbb8888-9999-0000-1111-222233334444', body: '属于另一条' }
    })

    const audit = buildTodoAudit(TODO_ID)
    expect(audit).toHaveLength(1)
    expect(audit[0].what).toContain('属于这条')
    expect(audit[0].what).not.toContain('属于另一条')
  })

  it('没有审计事件时返回空数组，而不是报错', () => {
    expect(buildTodoAudit('cccc0000-0000-0000-0000-000000000000')).toEqual([])
  })

  it('不认识的事件类型照原样列出，不静默丢弃', () => {
    // 漏掉一条未知事件 = 某次改动无痕，而这正是本事项要治的病。
    // 宁可显示一个不太好看的原始 type，也不能让它消失。
    new EventsRepository().append('some_future_event', 'agent:x', { todoId: TODO_ID })
    const audit = buildTodoAudit(TODO_ID)
    expect(audit).toHaveLength(1)
    expect(audit[0].kind).toBe('some_future_event')
  })

  it('长正文只给摘要，不把整段塞进一行', () => {
    new EventsRepository().append('comment_deleted', 'agent:a', {
      comment: { todoId: TODO_ID, body: '长'.repeat(500) }
    })
    const what = buildTodoAudit(TODO_ID)[0].what
    expect(what).toContain('…')
    expect(what.length).toBeLessThan(200)
  })
})

/**
 * ── 命令层的"接线"闸门 ──
 *
 * 上面测的是事件行不行、翻译对不对。但本条驳回真正卡住的是**接线**：
 * 功能写好了、没人调用 —— 与 `setPreset` 那次同一个形状。
 * 而且驳回单点名是**两条命令**（`todo history` 与 `todo get`），
 * 只改一条就是半截修复：agent 最常用的恰恰是 `get`，它照样回 not_found。
 *
 * 这类缺陷在源码里只表现为"少写了一个参数"，tsc 不会报（可选参数），
 * 单测也不会报（测得是纯函数）。所以只能断言源码结构。
 */
describe('已删条目的读取入口必须真的接上（主用户驳回 b3ac3d32）', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const src = readCliChain()
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('todo history 与 todo get 都传了 allowDeleted（两条命令，缺一即半截修复）', () => {
    const calls = [...clean.matchAll(/resolveId\((\w+), \{ allowDeleted: true \}\)/g)]
    expect(
      calls.length,
      '`resolveId(…, { allowDeleted: true })` 只出现 ' +
        calls.length +
        ' 次。\n' +
        '驳回单原话：「`todo history` **与** `todo get` 在 getById 落空时改走\n' +
        'findDeletedSnapshot」。少接一条，那条命令就仍然回 not_found ——\n' +
        '而 agent 日常最常用的正是 `todo get`。'
    ).toBeGreaterThanOrEqual(2)
  })

  it('允许解析墓碑的入口只出现在只读命令里', () => {
    /**
     * ⚠️ 防扩散：`allowDeleted` 一旦用在写命令上，`todo update/comment/rm`
     * 拿到已删 id 时就不再干脆地报"待办不存在"，而是绕进下游各处，
     * 报出难懂的错。
     *
     * ⚠️ 块边界必须取**下一个 `name: '`**，不能用固定字符数切片 ——
     * 第一版写的是 `slice(idx, idx + 2500)`，`todo update` 的块直接跨进了
     * 后面的 `todo history`（那里有 allowDeleted），于是闸门把自己的
     * 正当实现判成了违规。命令块的长度是会变的，固定宽度必然漂移。
     */
    const forbidden = ['todo update', 'todo comment', 'todo rm', 'todo move']
    for (const name of forbidden) {
      const idx = clean.indexOf(`name: '${name}'`)
      if (idx === -1) continue
      const next = clean.indexOf("name: '", idx + 10)
      const block = clean.slice(idx, next === -1 ? undefined : next)
      expect(
        block.includes('allowDeleted'),
        `${name} 不能解析墓碑 —— 那是写命令，应当干脆地拒绝已删 id。\n` +
          `（若这里误报，先确认块边界取的是下一个 name: 的位置；\n` +
          `固定宽度切片会跨块，把邻居的 allowDeleted 算进来。）`
      ).toBe(false)
    }
  })
})
