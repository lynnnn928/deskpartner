import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AttachmentRepository } from '../../../src/main/database/attachment.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { runMigrations } from '../../../src/main/database/migrations'
import { MAX_ATTACHMENT_BYTES } from '../../../src/main/lib/attachments'

const db = new Database(':memory:')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-attach-test-'))

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  getDataDirPath: () => dataDir
}))

/**
 * 事项附件（schema v50）
 *
 * 覆盖四件容易做错的事：
 * ① 文件**真的**被复制进数据目录（源文件删掉后附件仍在）；
 * ② 超上限/目录 这类预检失败**不留残片**（不落库、不落文件）；
 * ③ 删除与事项删除都要**连文件一起收**；
 * ④ 库里存的是**相对数据目录**的路径（数据目录换了也不指空）。
 */
describe('AttachmentRepository（v50 事项附件）', () => {
  let attachments: AttachmentRepository
  let todos: TodoRepository
  let todoId: string
  let srcDir: string

  const makeSrc = (name: string, body: string | Buffer): string => {
    const file = path.join(srcDir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    return file
  }

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM todo_attachments').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES ('c1', '工作', '#5388F6', 1, 0)"
    ).run()
    db.prepare(
      "INSERT INTO projects (id, name, color, archived, sort_order, created_at) VALUES ('p1', 'DeskPartner', '#5388F6', 0, 0, '2026-01-01T00:00:00.000Z')"
    ).run()
    attachments = new AttachmentRepository()
    todos = new TodoRepository()
    todoId = todos.create({ title: '带附件的事', projectId: 'p1' }).id
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-attach-src-'))
    fs.rmSync(path.join(dataDir, 'attachments'), { recursive: true, force: true })
  })

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(srcDir, { recursive: true, force: true })
    db.close()
  })

  it('添加图片：复制进数据目录、落库字段齐、序号递增', () => {
    const png = makeSrc('截图.png', Buffer.from('假装是 PNG'))
    const one = attachments.add({ todoId, paths: [png], actor: 'human' })
    expect(one.failed).toEqual([])
    expect(one.added).toHaveLength(1)

    const [a] = one.added
    expect(a.kind).toBe('image')
    expect(a.mime).toBe('image/png')
    expect(a.name).toBe('截图.png')
    expect(a.seq).toBe(1)
    expect(a.bytes).toBe(Buffer.from('假装是 PNG').length)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)

    const second = attachments.add({ todoId, paths: [png], actor: 'human' })
    expect(second.added[0].seq).toBe(2)

    // 文件确实躺在数据目录里，且路径是相对的
    expect(a.relPath.startsWith('attachments/')).toBe(true)
    expect(a.relPath).not.toContain(dataDir)
    expect(fs.existsSync(path.join(dataDir, a.relPath))).toBe(true)
  })

  it('复制而不是引用：源文件删掉后附件仍在', () => {
    const file = makeSrc('交付.pdf', Buffer.from('PDF 内容'))
    const [a] = attachments.add({ todoId, paths: [file], actor: 'human' }).added
    fs.rmSync(file)
    expect(fs.existsSync(path.join(dataDir, a.relPath))).toBe(true)
    expect(fs.readFileSync(path.join(dataDir, a.relPath), 'utf8')).toBe('PDF 内容')
  })

  it('超上限与目录：进 failed，不落库也不留文件', () => {
    const big = makeSrc('太大.log', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1))
    const dir = path.join(srcDir, '一个目录')
    fs.mkdirSync(dir, { recursive: true })
    const res = attachments.add({ todoId, paths: [big, dir], actor: 'human' })

    expect(res.added).toEqual([])
    expect(res.failed).toHaveLength(2)
    expect(res.failed[0].reason).toMatch(/上限/)
    expect(res.failed[1].reason).toMatch(/不能关联目录/)
    expect(attachments.list(todoId)).toEqual([])
    // 数据目录里不该留下半个文件
    const dirOnDisk = path.join(dataDir, 'attachments', todoId)
    expect(fs.existsSync(dirOnDisk) ? fs.readdirSync(dirOnDisk) : []).toEqual([])
  })

  it('一批里成功与失败并存：成功的照常落库', () => {
    const ok = makeSrc('好的.txt', 'ok')
    const missing = path.join(srcDir, '不存在.txt')
    const res = attachments.add({ todoId, paths: [ok, missing], actor: 'human' })
    expect(res.added).toHaveLength(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].reason).toMatch(/不存在或读不到/)
    expect(attachments.list(todoId)).toHaveLength(1)
  })

  it('移除附件：行与文件一起走', () => {
    const [a] = attachments.add({
      todoId,
      paths: [makeSrc('图.png', 'x')],
      actor: 'human'
    }).added
    const abs = path.join(dataDir, a.relPath)
    expect(fs.existsSync(abs)).toBe(true)

    attachments.remove({ id: a.id, actor: 'human' })
    expect(attachments.list(todoId)).toEqual([])
    expect(fs.existsSync(abs)).toBe(false)
    // 目录空了就顺手收掉，不留空壳
    expect(fs.existsSync(path.dirname(abs))).toBe(false)
  })

  it('删除事项：附件行与文件一起收（文件不归外键管）', () => {
    const [a] = attachments.add({
      todoId,
      paths: [makeSrc('图.png', 'x')],
      actor: 'human'
    }).added
    const abs = path.join(dataDir, a.relPath)
    const removed = attachments.removeAllForTodo(todoId)
    expect(removed).toBe(1)
    expect(fs.existsSync(abs)).toBe(false)
    expect(attachments.list(todoId)).toEqual([])
  })

  it('事项不存在时明确报错，不写任何东西', () => {
    expect(() =>
      attachments.add({ todoId: '不存在', paths: [makeSrc('a.txt', 'x')], actor: 'human' })
    ).toThrow(/事项不存在/)
  })

  it('总体积按事项汇总', () => {
    attachments.add({ todoId, paths: [makeSrc('a.txt', '12345')], actor: 'human' })
    attachments.add({ todoId, paths: [makeSrc('b.txt', '123')], actor: 'human' })
    expect(attachments.totalBytes(todoId)).toBe(8)
  })
})
