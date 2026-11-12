import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne, commands } from '../../../src/main/cli/commands'
import { riskOf, type CliContext } from '../../../src/main/cli/command-core'

const db = new Database(':memory:')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-attach-cli-89f3b3bc-'))

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
const { MAX_ATTACHMENT_TOTAL_BYTES } = await import('../../../src/renderer/lib/constants')

/**
 * agent 用附件：`todo attachments`（读元数据）+ `todo attach`（挂一份）
 * —— 卡 `89f3b3bc`，1.0.146
 *
 * 授权档是**日常写入**（2026-11-12 主用户拍板）：已批准的 agent 凭身份就能挂，
 * 不逐条审批。这条用例把这个"档"本身也钉住 —— 哪天有人把它升成 destructive，
 * 表现为"每次都要人点头"，那不是她的决定。
 *
 * 两条上限（单份 25 MB、这条事项总量 200 MB）都在**复制之前**判：超了磁盘上
 * 不该留下半个文件。
 */
describe('agent 用附件（卡 89f3b3bc）', () => {
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
    todoId = todos.create({ title: '带附件的卡', projectId: project.id }).id
    agents.register({ id: 'agent:erin', displayName: 'Erin', color: '#111' } as never)
    agents.setApproved('agent:erin', true)
    CREDS.set('agent:erin', agents.issueCredential('agent:erin')?.token ?? '')
    fs.rmSync(path.join(DATA_DIR, 'attachments'), { recursive: true, force: true })
  })

  it('`todo attachments`：没挂东西时说没有，挂上后名字/大小/归属都读得出来', async () => {
    const empty = await executeOne(mk('human'), ['todo attachments', todoId])
    expect(empty.ok).toBe(true)
    expect(empty.data.count).toBe(0)
    expect(empty.data.totalBytes).toBe(0)
    expect(empty.data.message).toContain('没有附件')

    await executeOne(mk('agent:erin'), ['todo attach', todoId, '--path', srcFile('交付说明.txt', '内容一二三')])
    const listed = await executeOne(mk('human'), ['todo attachments', todoId])
    expect(listed.ok).toBe(true)
    expect(listed.data.count).toBe(1)
    const one = listed.data.attachments[0]
    expect(one.name).toBe('交付说明.txt')
    expect(one.bytes).toBe(Buffer.from('内容一二三').length)
    expect(one.kind).toBe('file')
    expect(one.createdBy).toBe('agent:erin')
    // 相对数据目录的路径：换数据目录也不指空（与界面同一口径）
    expect(String(one.relPath).startsWith('attachments/')).toBe(true)
    expect(String(one.message ?? listed.data.message)).toMatch(/共 |KB|B/)
  })

  it('`todo attach`：真的把文件复制进数据目录（不是引用原路径）', async () => {
    const src = srcFile('截图说明.txt', 'hello')
    const res = await executeOne(mk('agent:erin'), ['todo attach', todoId, '--path', src])
    expect(res.ok).toBe(true)
    expect(Object.keys(res.data).sort()).toEqual(
      [
        'bytes', 'createdAt', 'createdBy', 'id', 'kind', 'message',
        'mime', 'name', 'relPath', 'seq', 'sha256', 'todoId'
      ].sort()
    )

    const abs = path.join(DATA_DIR, String(res.data.relPath))
    expect(fs.existsSync(abs)).toBe(true)
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello')
    // 源文件删掉之后附件仍在（复制而不是引用）
    fs.rmSync(src)
    expect(fs.existsSync(abs)).toBe(true)
  })

  it('挂不上的三种都明说原因，且磁盘上不留半个文件', async () => {
    const missing = await executeOne(mk('human', true), [
      'todo attach',
      todoId,
      '--path',
      path.join(DATA_DIR, '不存在.txt')
    ])
    expect(missing.ok).toBe(false)
    expect(missing.errorCode).toBe('usage_error')
    expect(String(missing.message)).toContain('不存在或读不到')

    const big = await executeOne(mk('human', true), [
      'todo attach',
      todoId,
      '--path',
      srcFile('太大.bin', Buffer.alloc(25 * 1024 * 1024 + 1, 1))
    ])
    expect(big.ok).toBe(false)
    expect(String(big.message)).toContain('超过 25.0 MB 上限')

    const dir = path.join(DATA_DIR, '一个目录')
    fs.mkdirSync(dir, { recursive: true })
    const notFile = await executeOne(mk('human', true), ['todo attach', todoId, '--path', dir])
    expect(notFile.ok).toBe(false)
    expect(String(notFile.message)).toContain('不能关联目录')

    expect(attachments.list(todoId)).toEqual([])
    const dirOnDisk = path.join(DATA_DIR, 'attachments', todoId)
    expect(fs.existsSync(dirOnDisk) ? fs.readdirSync(dirOnDisk) : []).toEqual([])
  })

  it('这条事项装不下时也拒（总量上限 200 MB，账目在库里）', async () => {
    // 真造 200 MB 太慢：垫一行等价的大数目即可（判据只看 totalBytes 这个和）
    db.prepare(
      `INSERT INTO todo_attachments
         (id, todo_id, seq, name, ext, kind, mime, bytes, sha256, rel_path, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'seed',
      todoId,
      1,
      '垫账.bin',
      '.bin',
      'file',
      'application/octet-stream',
      MAX_ATTACHMENT_TOTAL_BYTES - 1024 * 1024,
      'x'.repeat(64),
      `attachments/${todoId}/seed.bin`,
      'human',
      '2026-01-01T00:00:00.000Z'
    )

    const res = await executeOne(mk('human', true), [
      'todo attach',
      todoId,
      '--path',
      srcFile('再来一份.bin', Buffer.alloc(2 * 1024 * 1024, 0))
    ])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
    expect(String(res.message)).toContain('附件总量超过 200.0 MB 上限')
    expect(attachments.list(todoId)).toHaveLength(1)
  })

  it('事项不存在时明确报错', async () => {
    const res = await executeOne(mk('human', true), ['todo attach', '不存在的id', '--path', srcFile('a.txt', 'x')])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
  })

  it('没注册的身份挂不上：未注册的标识只能读，不能写', async () => {
    const ghost = mk('agent:ghost')
    // 连凭据都没有：这道闸在命令之前就把调用拦下了
    const res = await executeOne(ghost, ['todo attach', todoId, '--path', srcFile('幽灵.txt', 'x')])
    expect(res.ok).toBe(false)
    expect(attachments.list(todoId)).toEqual([])
  })

  it('授权档：挂附件是日常写入（凭身份直通，不逐条审批），读元数据是只读', async () => {
    const byName = (n: string) => commands.find((c) => c.name === n)!
    const attach = byName('todo attach')
    const list = byName('todo attachments')
    expect(riskOf(attach), '200-11-12 主用户拍板：日常写入档').toBe('write')
    expect(riskOf(list)).toBe('read')
    expect(list.readOnly).toBe(true)

    // 已批准的 agent 不申请任何授权就能挂上（挂上了才算数）
    const res = await executeOne(mk('agent:erin'), ['todo attach', todoId, '--path', srcFile('直通.txt', 'ok')])
    expect(res.ok).toBe(true)
    expect(attachments.list(todoId)).toHaveLength(1)
  })
})
