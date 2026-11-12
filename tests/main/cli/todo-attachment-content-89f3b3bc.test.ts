import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne, commands } from '../../../src/main/cli/commands'
import { riskOf, type CliContext } from '../../../src/main/cli/command-core'

const db = new Database(':memory:')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-attach-read-89f3b3bc-'))

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  getDataDirPath: () => DATA_DIR
}))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { EventsRepository } = await import('../../../src/main/database/events.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { AttachmentRepository } = await import('../../../src/main/database/attachment.repository')
const { MAX_TEXT_CHARS } = await import('../../../src/main/lib/attachment-content')

/**
 * `todo attachment`：agent 读一份附件的内容 —— 卡 `89f3b3bc`，1.0.146
 *
 * 主用户 2026-11-12：「bug 截图我挂到事项上，你就能直接去看，那你不读，我附上去干嘛？」
 * 这条用例钉的是"读得到"，以及三种内容各自给什么：
 * 文本给正文、图片给本机路径（MCP 层再把它变成图片内容块）、其它二进制只给路径。
 */
describe('agent 读附件内容（卡 89f3b3bc）', () => {
  const CREDS = new Map<string, string>()
  let todos: TodoRepository
  let agents: AgentRepository
  let attachments: AttachmentRepository
  let todoId: string

  const mk = (actor: string, interactive = false) =>
    ({
      deps: {
        todoRepo: todos,
        attachmentRepo: attachments,
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        memoRepo: new MemoRepository(),
        settingsRepo: { get: () => ({}) },
        agentRepo: agents,
        commentRepo: new CommentRepository(),
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.146', dbPath: ':memory:', schemaVersion: 50, via: 'pipe' },
      interactive,
      actor,
      credential: CREDS.get(actor)
    }) as unknown as CliContext

  const srcFile = (name: string, body: string | Buffer): string => {
    const p = path.join(DATA_DIR, '..', name)
    fs.writeFileSync(p, body)
    return p
  }

  /** 挂一份，返回它的 seq（走仓储，与本卡要验的读命令解耦） */
  const attach = (name: string, body: string | Buffer): number => {
    const res = attachments.add({ todoId, paths: [srcFile(name, body)], actor: 'human' })
    expect(res.failed).toEqual([])
    return res.added[0].seq
  }

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_attachments').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM agents').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    const project = new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
    agents = new AgentRepository()
    attachments = new AttachmentRepository()
    todoId = todos.create({ title: '挂图给我看的卡', projectId: project.id }).id
    agents.register({ id: 'agent:erin', displayName: 'Erin', color: '#111' } as never)
    agents.setApproved('agent:erin', true)
    CREDS.set('agent:erin', agents.issueCredential('agent:erin')?.token ?? '')
    fs.rmSync(path.join(DATA_DIR, 'attachments'), { recursive: true, force: true })
  })

  it('文本附件：正文原样读得出来，absPath 指向数据目录里那一份', async () => {
    const seq = attach('报错日志.log', '第一行：炸了\n第二行：还炸\n')
    const res = await executeOne(mk('human'), ['todo attachment', todoId, '--seq', String(seq)])
    expect(res.ok).toBe(true)
    expect(res.data.view).toBe('text')
    expect(res.data.text).toBe('第一行：炸了\n第二行：还炸\n')
    expect(res.data.totalChars).toBe(String('第一行：炸了\n第二行：还炸\n').length)
    expect(res.data.truncated).toBe(false)
    expect(fs.readFileSync(String(res.data.absPath), 'utf8')).toContain('第一行')
    // 路径落在数据目录的 attachments 下 —— 产物可回读，不是编出来的
    expect(String(res.data.absPath).replace(/\\/g, '/')).toContain(`/attachments/${todoId}/`)
  })

  it('长文本截断并说明还剩多少（64K 字符上限）', async () => {
    const long = 'x'.repeat(MAX_TEXT_CHARS + 500)
    const seq = attach('超长报告.txt', long)
    const res = await executeOne(mk('human'), ['todo attachment', todoId, '--seq', String(seq)])
    expect(res.ok).toBe(true)
    expect(res.data.view).toBe('text')
    expect(res.data.truncated).toBe(true)
    expect(res.data.chars).toBe(MAX_TEXT_CHARS)
    expect(res.data.totalChars).toBe(long.length)
    expect(String(res.data.text).length).toBe(MAX_TEXT_CHARS)
    expect(String(res.data.message)).toContain('截断')
  })

  it('图片附件：给 view=image 与本机路径，不把 base64 塞进回执', async () => {
    // 1x1 的 PNG：能不能"看见"由 MCP 那一层读文件决定，这里验的是口径
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const seq = attach('截图.png', png)
    const res = await executeOne(mk('agent:erin'), ['todo attachment', todoId, '--seq', String(seq)])
    expect(res.ok).toBe(true)
    expect(res.data.view).toBe('image')
    expect(res.data.kind).toBe('image')
    expect(res.data.mime).toBe('image/png')
    expect(Buffer.compare(fs.readFileSync(String(res.data.absPath)), png)).toBe(0)
    // 回执里不该出现 base64/data URL：那会把 CLI 输出撑大，且模型读文本看不见像素
    expect(JSON.stringify(res.data)).not.toContain('base64')
    expect(JSON.stringify(res.data)).not.toContain('data:image')
  })

  it('其它二进制：只给路径，明说读不出文本', async () => {
    const seq = attach('打包产物.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))
    const res = await executeOne(mk('human'), ['todo attachment', todoId, '--seq', String(seq)])
    expect(res.ok).toBe(true)
    expect(res.data.view).toBe('binary')
    expect(res.data.text).toBeUndefined()
    expect(String(res.data.message)).toContain('不读文本')
    expect(fs.existsSync(String(res.data.absPath))).toBe(true)
  })

  it('没有那一份、或者这条卡上压根没有附件，都明确拒', async () => {
    const none = await executeOne(mk('human'), ['todo attachment', todoId, '--seq', '1'])
    expect(none.ok).toBe(false)
    expect(none.errorCode).toBe('usage_error')
    expect(String(none.message)).toContain('没有附件')

    attach('只有第一份.txt', 'x')
    const missing = await executeOne(mk('human'), ['todo attachment', todoId, '--seq', '9'])
    expect(missing.ok).toBe(false)
    expect(missing.errorCode).toBe('usage_error')
    expect(String(missing.message)).toContain('第 9 份')
    // 提示里给出实际有哪些序号，别让人自己猜
    expect(String(missing.message)).toContain('1')
  })

  it('授权档是只读；并且库里路径被外部改成穿越路径时拒绝读', () => {
    const cmd = commands.find((c) => c.name === 'todo attachment')!
    expect(riskOf(cmd)).toBe('read')
    expect(cmd.readOnly).toBe(true)

    const seq = attach('正常.txt', 'x')
    const one = attachments.list(todoId).find((a) => a.seq === seq)!
    db.prepare('UPDATE todo_attachments SET rel_path = ? WHERE id = ?').run(
      '../../../Windows/win.ini',
      one.id
    )
    const tampered = attachments.find(one.id)!
    expect(() => attachments.absolutePath(tampered)).toThrow(/越过了数据目录/)
  })
})
