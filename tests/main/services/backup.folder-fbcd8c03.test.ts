/**
 * 备份带上附件文件本体：导出成文件夹，导入按 sha256 逐个校验（卡 fbcd8c03）
 *
 * ── 缺陷 ──
 * 备份此前只有一份 JSON：附件**行**在（v6 起 `auxiliary.todoAttachments` 带 `rel_path`、
 * `sha256`），而文件本体留在数据目录 `attachments/` 里。换机后把 JSON 导回去，
 * 卡片上的附件行全都回来了，点开一个都打不开 —— 回执上还写着"成功"。
 *
 * ── 这里钉住什么 ──
 * ① 导出成文件夹：`backup.json` + `attachments/<todoId>/<id><ext>` 原样复制；
 * ② 导入按 sha256 校验：一致才复制；篡改、缺失、`rel_path` 越界各有归宿，
 *    且**不写到数据目录之外**；
 * ③ 导出目录重名时另起一个（`-2`、`-3`…），**绝不覆盖**已有目录；
 * ④ 旧的单 JSON 导入路径保持不变：文件本来就不随 JSON 走，行能回来、文件不会凭空出现。
 *
 * ⚠️ 夹具照 `backup.four-tables-7c347b4b.test.ts`：库走 `:memory:` + `getDatabase` 打桩，
 * 附件文件走真实的临时目录 —— 这条用例的整个意义就是"文件是不是真的被复制了"，
 * 文件层不能打桩。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'

let db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  // 导入前的原件备份依赖真实库文件；这里没有文件，拷不到就跳过（不阻断导入）
  getDatabasePath: () => '/fake/user-data/user.db'
}))

const { BackupService } = await import('../../../src/main/services/backup.service')
const { exportToFolder, importFromFolder, BACKUP_JSON_FILE } = await import(
  '../../../src/main/services/backup-folder'
)
const { storeAttachmentFile, statFile, ATTACHMENTS_DIR } = await import(
  '../../../src/main/lib/attachments'
)
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')

interface SeededRow {
  id: string
  relPath: string
  sha256: string
  bytes: number
}

/** 一条附件行（落库口径与 `todo_attachments` 一致） */
function insertAttachmentRow(
  todoId: string,
  seq: number,
  meta: { id: string; name: string; ext: string; kind: string; mime: string; bytes: number; sha256: string; relPath: string }
): void {
  db.prepare(
    `INSERT INTO todo_attachments
      (id, todo_id, comment_id, seq, name, ext, kind, mime, bytes, sha256, rel_path, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'human', '2026-11-16T00:00:00.000Z')`
  ).run(
    meta.id,
    todoId,
    seq,
    meta.name,
    meta.ext,
    meta.kind,
    meta.mime,
    meta.bytes,
    meta.sha256,
    meta.relPath
  )
}

describe('备份文件夹：附件文件随行（fbcd8c03）', () => {
  let backup: InstanceType<typeof BackupService>
  let todoRepo: InstanceType<typeof TodoRepository>
  let categoryRepo: InstanceType<typeof CategoryRepository>
  let projectRepo: InstanceType<typeof ProjectRepository>
  let workRoot: string

  beforeAll(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-backup-folder-'))
    runMigrations(db)
    todoRepo = new TodoRepository()
    categoryRepo = new CategoryRepository()
    projectRepo = new ProjectRepository()
    backup = new BackupService(
      todoRepo,
      categoryRepo,
      new SettingsRepository(),
      projectRepo,
      new MemoRepository(),
      new AgentRepository()
    )
  })

  beforeEach(() => {
    freshLibrary()
  })

  afterAll(() => {
    fs.rmSync(workRoot, { recursive: true, force: true })
  })

  /** 换一台干净的机器：新库 + 新数据目录 */
  function freshLibrary(): void {
    db = new Database(':memory:')
    runMigrations(db)
    categoryRepo.initializeDefaults()
  }

  function makeDataDir(label: string): string {
    return fs.mkdtempSync(path.join(workRoot, `${label}-`))
  }

  /**
   * 造一条带两份**真实**附件文件的事项
   *
   * 文件用 `storeAttachmentFile` 落进数据目录（与界面加附件同一条路），
   * 行用 SQL 插 —— 仓储的 `add()` 自己去取数据目录，这里的数据目录是临时的。
   */
  function seedWithAttachments(dataDir: string): SeededRow[] {
    const project = projectRepo.create({ name: '附件往返项目' })
    const todo = todoRepo.create({ title: '带附件的事项', projectId: project.id })
    const inbox = makeDataDir('inbox')
    const specs = [
      { name: '截图.png', body: Buffer.from('PNG-BYTES-2026-11-16') },
      { name: '日志.txt', body: Buffer.from('第一行\n第二行\n') }
    ]
    return specs.map((spec, index) => {
      const srcPath = path.join(inbox, spec.name)
      fs.writeFileSync(srcPath, spec.body)
      const meta = storeAttachmentFile({ dataDir, todoId: todo.id, srcPath })
      insertAttachmentRow(todo.id, index + 1, meta)
      return { id: meta.id, relPath: meta.relPath, sha256: meta.sha256, bytes: meta.bytes }
    })
  }

  const countRows = (): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM todo_attachments').get() as { c: number }).c

  it('导出成文件夹：backup.json 与 attachments/ 原样复制，字节与 sha256 都对得上', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')

    const result = exportToFolder(backup, parentDir, dataDir)

    expect(path.dirname(result.dir)).toBe(parentDir)
    expect(path.basename(result.dir)).toMatch(/^desk-partner-backup-\d{4}-\d{2}-\d{2}$/)

    const jsonPath = path.join(result.dir, BACKUP_JSON_FILE)
    expect(fs.existsSync(jsonPath), '导出文件夹里没有 backup.json').toBe(true)
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      auxiliary: { todoAttachments: Array<{ rel_path: string }> }
    }
    expect(parsed.auxiliary.todoAttachments).toHaveLength(2)

    expect(result.attachmentFiles.copied).toBe(2)
    expect(result.attachmentFiles.missing).toEqual([])
    for (const row of rows) {
      const copied = path.join(result.dir, row.relPath)
      expect(fs.existsSync(copied), `附件没复制进备份目录：${row.relPath}`).toBe(true)
      expect(statFile(copied).sha256).toBe(row.sha256)
      expect(statFile(copied).bytes).toBe(row.bytes)
    }
  })

  it('换一个空数据目录与新库导入：附件行与文件都回来了', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')
    const { dir } = exportToFolder(backup, parentDir, dataDir)

    // 换机：新库 + 空数据目录
    freshLibrary()
    const targetDataDir = makeDataDir('target')
    const result = importFromFolder(backup, dir, targetDataDir)

    expect(countRows()).toBe(rows.length)
    expect(result.attachmentFiles?.copied).toBe(rows.length)
    expect(result.attachmentFiles?.skipped).toBe(0)
    expect(result.attachmentFiles?.missing).toEqual([])
    expect(result.attachmentFiles?.mismatched).toEqual([])
    for (const row of rows) {
      const target = path.join(targetDataDir, row.relPath)
      expect(fs.existsSync(target), `导入后附件文件不在：${row.relPath}`).toBe(true)
      expect(statFile(target).sha256).toBe(row.sha256)
      expect(statFile(target).bytes).toBe(row.bytes)
    }
  })

  it('重复导入同一份备份：附件文件不重复复制，记为 skipped', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')
    const { dir } = exportToFolder(backup, parentDir, dataDir)

    freshLibrary()
    const targetDataDir = makeDataDir('target')
    importFromFolder(backup, dir, targetDataDir)
    const again = importFromFolder(backup, dir, targetDataDir)

    // 目标已有同内容文件 → 跳过（覆盖写一遍除了费 io 没别的好处）
    expect(again.attachmentFiles?.copied).toBe(0)
    expect(again.attachmentFiles?.skipped).toBe(rows.length)
    expect(countRows()).toBe(rows.length)
  })

  it('备份里的附件被篡改（sha256 不符）→ 记为 mismatched 且不复制', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')
    const { dir } = exportToFolder(backup, parentDir, dataDir)

    // 改一个字节就行：校验要按内容，不是按"文件在不在"
    fs.writeFileSync(path.join(dir, rows[0].relPath), Buffer.from('tampered'))

    freshLibrary()
    const targetDataDir = makeDataDir('target')
    const result = importFromFolder(backup, dir, targetDataDir)

    expect(result.attachmentFiles?.mismatched).toEqual([rows[0].relPath])
    expect(result.attachmentFiles?.copied).toBe(rows.length - 1)
    expect(fs.existsSync(path.join(targetDataDir, rows[0].relPath))).toBe(false)
    // 另一份没被牵连
    expect(fs.existsSync(path.join(targetDataDir, rows[1].relPath))).toBe(true)
  })

  it('备份里少了一个附件文件 → 记为 missing，其余照常导入', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')
    const { dir } = exportToFolder(backup, parentDir, dataDir)

    fs.rmSync(path.join(dir, rows[0].relPath))

    freshLibrary()
    const targetDataDir = makeDataDir('target')
    const result = importFromFolder(backup, dir, targetDataDir)

    expect(result.attachmentFiles?.missing).toEqual([rows[0].relPath])
    expect(result.attachmentFiles?.copied).toBe(rows.length - 1)
    expect(countRows()).toBe(rows.length)
  })

  it('归档时就缺源文件：导出不中断，记进 missing', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    // 源文件被手工删掉（数据目录被外部动过）—— 导出不能因此整份失败
    fs.rmSync(path.join(dataDir, rows[0].relPath))

    const parentDir = makeDataDir('out')
    const result = exportToFolder(backup, parentDir, dataDir)

    expect(result.attachmentFiles.copied).toBe(rows.length - 1)
    expect(result.attachmentFiles.missing).toEqual([rows[0].relPath])
    // JSON 照写：附件缺文件不该让整份备份变成空的
    expect(fs.existsSync(path.join(result.dir, BACKUP_JSON_FILE))).toBe(true)
  })

  it('备份里的 rel_path 越界（../）→ 拒绝，且不往数据目录之外写文件', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')
    const { dir } = exportToFolder(backup, parentDir, dataDir)

    // 库里那份数据被外部改过：rel_path 指向备份目录外面
    const jsonPath = path.join(dir, BACKUP_JSON_FILE)
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      auxiliary: { todoAttachments: Array<{ rel_path: string }> }
    }
    parsed.auxiliary.todoAttachments[0].rel_path = '../leak.txt'
    fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2))
    // 越界路径上真的放一份文件：万一实现的校验漏了，它会被复制出去
    fs.writeFileSync(path.join(parentDir, 'leak.txt'), Buffer.from('leak'))

    freshLibrary()
    const targetDataDir = makeDataDir('target')
    const result = importFromFolder(backup, dir, targetDataDir)

    expect(result.attachmentFiles?.mismatched).toEqual(['../leak.txt'])
    expect(result.attachmentFiles?.copied).toBeLessThan(rows.length)
    // 数据目录的上一级（= 真的会写出去的地方）没有多出东西
    expect(fs.existsSync(path.join(path.dirname(targetDataDir), 'leak.txt'))).toBe(false)
    expect(fs.existsSync(path.join(targetDataDir, '..', 'leak.txt'))).toBe(false)
  })

  it('目标目录重名：另起一个 -2，已有目录一个文件都不动', () => {
    const dataDir = makeDataDir('src')
    seedWithAttachments(dataDir)
    const parentDir = makeDataDir('out')

    const first = exportToFolder(backup, parentDir, dataDir)
    fs.writeFileSync(path.join(first.dir, 'sentinel.txt'), 'keep')
    const second = exportToFolder(backup, parentDir, dataDir)

    expect(second.dir).not.toBe(first.dir)
    expect(path.basename(second.dir)).toBe(`${path.basename(first.dir)}-2`)
    expect(fs.readFileSync(path.join(first.dir, 'sentinel.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(second.dir, 'sentinel.txt'))).toBe(false)
  })

  it('所选文件夹里没有 backup.json → 明确报错，且不碰数据库', () => {
    const emptyDir = makeDataDir('empty')
    expect(() => importFromFolder(backup, emptyDir, makeDataDir('target'))).toThrow(/backup\.json/)
    expect(countRows()).toBe(0)
  })

  it('旧的单 JSON 导入路径不受影响：行回来了，文件不随 JSON 走', () => {
    const dataDir = makeDataDir('src')
    const rows = seedWithAttachments(dataDir)
    const json = backup.exportData()

    freshLibrary()
    const targetDataDir = makeDataDir('target')
    const result = backup.importData(json)

    expect(countRows()).toBe(rows.length)
    // 单 JSON 没有附件文件那一段（该字段只有文件夹导入才有）
    expect(result.attachmentFiles).toBeUndefined()
    expect(fs.existsSync(path.join(targetDataDir, ATTACHMENTS_DIR))).toBe(false)
  })
})
