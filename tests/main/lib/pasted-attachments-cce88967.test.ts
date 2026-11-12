import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  addPastedAttachments,
  PASTE_TMP_DIR,
  type AttachmentAdder
} from '../../../src/main/lib/pasted-attachments'
import { AttachmentRepository } from '../../../src/main/database/attachment.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { runMigrations } from '../../../src/main/database/migrations'
import {
  MAX_ATTACHMENT_BYTES,
  attachmentTooLargeReason,
  storeAttachmentFile
} from '../../../src/main/lib/attachments'

const db = new Database(':memory:')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-paste-test-'))

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  getDataDirPath: () => dataDir
}))

/**
 * 粘贴进来的附件（卡 `cce88967`）
 *
 * 剪贴板里的图片只有内存字节，这条路要证明的四件事：
 * ① 字节**真的**变成附件（文件躺在数据目录里、内容与字节一致、kind 按扩展名认出图片）；
 * ② 走的确实是**同一条入库路径**（名字、seq、sha256 与按路径那条口径相同）；
 * ③ 超上限/空内容：明确报错、不落库、**不留残片**（临时目录与附件目录都干净）；
 * ④ 连抛错的时候也要把临时文件收掉。
 *
 * 临时目录里的东西是"谁也认不出的残片"：一旦留下来，数据目录里就多出一份没人引用的
 * 字节，用户既看不到也删不掉。
 */
const tmpDir = path.join(dataDir, PASTE_TMP_DIR)

const tmpLeftovers = (): string[] =>
  fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []

const filesIn = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir) : []

describe('粘贴附件（cce88967）', () => {
  let attachments: AttachmentRepository
  let todos: TodoRepository
  let todoId: string

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM todo_attachments').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES ('c1', '工作', '#5388F6', 1, 0)"
    ).run()
    db.prepare(
      "INSERT INTO projects (id, name, color, archived, sort_order, created_at) VALUES ('p1', 'DeskPartner', '#5388F6', 0, 0, '2026-01-01T00:00:00.000Z')"
    ).run()
    attachments = new AttachmentRepository()
    todos = new TodoRepository()
    todoId = todos.create({ title: '带附件的事', projectId: 'p1' }).id
    fs.rmSync(path.join(dataDir, 'attachments'), { recursive: true, force: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    db.close()
  })

  it('截图字节进来：落成一个图片附件，内容一字不差，临时文件收干净', () => {
    const bytes = Buffer.from('假装是 PNG 的字节')
    const res = addPastedAttachments({
      todoId,
      files: [{ name: '粘贴图片-20261112-131500.png', bytes }],
      dataDir,
      repo: attachments
    })

    expect(res.failed).toEqual([])
    expect(res.added).toHaveLength(1)
    const [a] = res.added
    expect(a.name).toBe('粘贴图片-20261112-131500.png')
    expect(a.kind, '扩展名说是图片，就该按图片存').toBe('image')
    expect(a.mime).toBe('image/png')
    expect(a.bytes).toBe(bytes.length)
    expect(a.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(a.createdBy).toBe('human')
    expect(a.seq).toBe(1)

    // 文件真的躺在数据目录里，字节就是粘进来的那份
    const abs = path.join(dataDir, a.relPath)
    expect(fs.existsSync(abs)).toBe(true)
    expect(fs.readFileSync(abs).equals(bytes)).toBe(true)
    // 库里存的是相对路径（数据目录整体搬走也不指空）
    expect(a.relPath.startsWith('attachments/')).toBe(true)
    expect(tmpLeftovers(), '临时文件用完就该没了').toEqual([])
  })

  it('一次粘两份：各是一条，序号接着排', () => {
    const res = addPastedAttachments({
      todoId,
      files: [
        { name: '粘贴图片-1.png', bytes: Buffer.from('一') },
        { name: '粘贴图片-2.png', bytes: Buffer.from('二') }
      ],
      dataDir,
      repo: attachments
    })

    expect(res.failed).toEqual([])
    expect(res.added.map((a) => a.name)).toEqual(['粘贴图片-1.png', '粘贴图片-2.png'])
    expect(res.added.map((a) => a.seq)).toEqual([1, 2])
    expect(attachments.list(todoId)).toHaveLength(2)
    expect(tmpLeftovers()).toEqual([])
  })

  it('超过 25 MB：明确报错，不落库、不留文件、也不写临时文件', () => {
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1)
    const res = addPastedAttachments({
      todoId,
      files: [{ name: '粘贴图片-超大.png', bytes: huge }],
      dataDir,
      repo: attachments
    })

    expect(res.added).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].name).toBe('粘贴图片-超大.png')
    expect(res.failed[0].reason).toContain('超过 25.0 MB 上限')
    expect(res.failed[0].reason).toContain('粘贴图片-超大.png')
    expect(attachments.list(todoId)).toEqual([])
    expect(filesIn(path.join(dataDir, 'attachments', todoId))).toEqual([])
    expect(tmpLeftovers(), '注定被拒的东西不该先落盘').toEqual([])
  })

  it('空字节：报"没有字节"，不留残片', () => {
    const res = addPastedAttachments({
      todoId,
      files: [{ name: '粘贴图片-空.png', bytes: new Uint8Array(0) }],
      dataDir,
      repo: attachments
    })

    expect(res.added).toEqual([])
    expect(res.failed[0].reason).toContain('没有字节')
    expect(attachments.list(todoId)).toEqual([])
    expect(tmpLeftovers()).toEqual([])
  })

  it('入库这一步抛错：临时文件照样收掉（finally 而不是成功分支）', () => {
    const boom: AttachmentAdder = {
      add: () => {
        throw new Error('事项不存在：x')
      }
    }
    expect(() =>
      addPastedAttachments({
        todoId,
        files: [{ name: '粘贴图片-报错.png', bytes: Buffer.from('x') }],
        dataDir,
        repo: boom
      })
    ).toThrow(/事项不存在/)
    expect(tmpLeftovers(), '抛错时最该收残片').toEqual([])
  })

  it('名字里带路径分隔符：净化后仍然落在数据目录内', () => {
    const res = addPastedAttachments({
      todoId,
      files: [{ name: '../../跑到外面去.png', bytes: Buffer.from('x') }],
      dataDir,
      repo: attachments
    })

    expect(res.added).toHaveLength(1)
    expect(res.added[0].name).toBe('.._.._跑到外面去.png')
    const abs = path.join(dataDir, res.added[0].relPath)
    expect(abs.startsWith(path.join(dataDir, 'attachments'))).toBe(true)
    expect(fs.existsSync(abs)).toBe(true)
  })

  it('与"按路径添加"说的是同一句话（超限措辞只有一份）', () => {
    const src = path.join(dataDir, '大文件.log')
    fs.writeFileSync(src, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1))
    try {
      storeAttachmentFile({ dataDir, todoId, srcPath: src })
      throw new Error('超限却没被拦住')
    } catch (err) {
      expect((err as Error).message).toBe(
        attachmentTooLargeReason(MAX_ATTACHMENT_BYTES + 1, '大文件.log')
      )
    } finally {
      fs.rmSync(src, { force: true })
    }
  })
})
