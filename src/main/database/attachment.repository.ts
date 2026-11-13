import { randomUUID } from 'node:crypto'
import { getDataDirPath, getDatabase } from './index'
import { NotFoundError, UsageError } from '../lib/domain-errors'
import {
  MAX_ATTACHMENT_BYTES,
  removeAttachmentDir,
  removeAttachmentFile,
  resolveRelPath,
  storeAttachmentFile,
  type AttachmentKind
} from '../lib/attachments'

/** 一条事项附件 */
export interface TodoAttachment {
  id: string
  todoId: string
  /** 挂在哪条评论下（1.0.146）：null = 卡片级附件，渲染在附件区而不是评论里 */
  commentId: string | null
  /** 这条事项内的展示序号：删了不回收、不重排（与接手说明/文档快照同源） */
  seq: number
  /** 原始文件名，给人看的 */
  name: string
  ext: string
  kind: AttachmentKind
  mime: string
  bytes: number
  sha256: string
  /** 相对数据目录的路径 */
  relPath: string
  createdBy: string
  createdAt: string
}

interface AttachmentRow {
  id: string
  todo_id: string
  comment_id?: string | null
  seq: number
  name: string
  ext: string
  kind: string
  mime: string
  bytes: number
  sha256: string
  rel_path: string
  created_by: string
  created_at: string
}

const toAttachment = (row: AttachmentRow): TodoAttachment => ({
  id: row.id,
  todoId: row.todo_id,
  commentId: row.comment_id ?? null,
  seq: row.seq,
  name: row.name,
  ext: row.ext,
  kind: row.kind === 'image' ? 'image' : 'file',
  mime: row.mime,
  bytes: row.bytes,
  sha256: row.sha256,
  relPath: row.rel_path,
  createdBy: row.created_by,
  createdAt: row.created_at
})

/**
 * 事项附件仓储（schema v50）
 *
 * 与「项目关联文档目录」的分工要说清，否则很容易混：
 * - **项目文档目录**（`projects.docsDir`）是**引用**外部目录：磁盘为准、外部编辑器改，
 *   应用只读不写，还可能是 git 工作区 —— 那份东西的权威不在我们手里。
 * - **事项附件**是**复制**进数据目录的副本：它是这张卡片自己的东西，
 *   源文件移走删掉都不影响它，数据目录整体搬走也带着它。
 * 一个"跟着磁盘活"，一个"跟着卡片活"，判据是**谁是权威**。
 *
 * 为什么文件复制也放在仓储里：复制与落库要么一起发生、要么都不发生 ——
 * 分开写在 IPC 那一层，"文件拷了、行没插"会留下谁也认不出的残片。
 * 界面与将来的 CLI 都走这里，路径与序号口径只有一份。
 */
export class AttachmentRepository {
  /**
   * 连接**每次取**，不缓存 —— 换数据目录会 closeDatabase() + initializeDatabase()，
   * 缓存下来的那根句柄在那之后是死的（实测报 "database connection is not open"）；
   * 顺带也让单测能在 mock getDatabase() 之后再构造仓储（与 TodoRepository 同源）。
   */
  private get db() {
    return getDatabase()
  }

  /** 列出某条事项的附件（按 seq 升序） */
  list(todoId: string): TodoAttachment[] {
    const rows = this.db
      .prepare('SELECT * FROM todo_attachments WHERE todo_id = ? ORDER BY seq ASC')
      .all(todoId) as AttachmentRow[]
    return rows.map(toAttachment)
  }

  /** 按 id 取一条（取不到返回 null） */
  find(id: string): TodoAttachment | null {
    const row = this.db.prepare('SELECT * FROM todo_attachments WHERE id = ?').get(id) as
      | AttachmentRow
      | undefined
    return row ? toAttachment(row) : null
  }

  /**
   * 关联若干外部文件：**先复制进数据目录，再落库**
   *
   * 逐个文件独立成败：一个超大文件不该让整批都被拒。返回成功的那几条，
   * 失败的信息由调用方（IPC）汇总成人能看懂的一句话。
   */
  add(input: {
    todoId: string
    paths: string[]
    actor: string
    /** 挂到某条评论下（1.0.146）：评论必须属于同一条事项，否则会挂错卡 */
    commentId?: string | null
  }): { added: TodoAttachment[]; failed: Array<{ path: string; reason: string }> } {
    const { todoId, paths, actor } = input
    const commentId = input.commentId ?? null
    const exists = this.db.prepare('SELECT 1 FROM todos WHERE id = ?').get(todoId)
    if (!exists) throw new NotFoundError(`事项不存在：${todoId}`)
    if (!paths.length) throw new UsageError('没有选择任何文件')
    if (commentId) {
      const row = this.db.prepare('SELECT todo_id FROM todo_comments WHERE id = ?').get(commentId) as
        | { todo_id: string }
        | undefined
      if (!row) throw new NotFoundError(`评论不存在：${commentId}`)
      if (row.todo_id !== todoId) {
        throw new UsageError('这条评论不属于该事项，附件不能挂到别的事项的评论上')
      }
    }

    const dataDir = getDataDirPath()
    const added: TodoAttachment[] = []
    const failed: Array<{ path: string; reason: string }> = []

    /**
     * 这条事项当前已占用的字节数（卡 `fc11793f`）：总量上限要在**复制之前**判，
     * 所以先取一次，再随每一份成功挂上的累加 —— 否则同一批里前几份就能把它撑破。
     */
    let usedBytes = this.totalBytes(todoId)

    for (const src of paths) {
      let meta
      try {
        meta = storeAttachmentFile({ dataDir, todoId, srcPath: src, usedBytes })
      } catch (err) {
        failed.push({ path: src, reason: err instanceof Error ? err.message : String(err) })
        continue
      }
      try {
        const row = this.db.transaction(() => {
          const { m } = this.db
            .prepare('SELECT MAX(seq) AS m FROM todo_attachments WHERE todo_id = ?')
            .get(todoId) as { m: number | null }
          const seq = (m ?? 0) + 1
          const now = new Date().toISOString()
          this.db
            .prepare(
              `INSERT INTO todo_attachments
                 (id, todo_id, comment_id, seq, name, ext, kind, mime, bytes, sha256, rel_path, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              meta.id,
              todoId,
              commentId,
              seq,
              meta.name,
              meta.ext,
              meta.kind,
              meta.mime,
              meta.bytes,
              meta.sha256,
              meta.relPath,
              actor,
              now
            )
          return { seq, now }
        })()
        usedBytes += meta.bytes
        added.push({
          id: meta.id,
          todoId,
          commentId,
          seq: row.seq,
          name: meta.name,
          ext: meta.ext,
          kind: meta.kind,
          mime: meta.mime,
          bytes: meta.bytes,
          sha256: meta.sha256,
          relPath: meta.relPath,
          createdBy: actor,
          createdAt: row.now
        })
      } catch (err) {
        // 落库失败就把刚拷进去的文件收掉，别留残片
        removeAttachmentFile(dataDir, meta.relPath)
        failed.push({ path: src, reason: err instanceof Error ? err.message : String(err) })
      }
    }

    return { added, failed }
  }

  /** 解除关联：先删行再删文件（行删掉了、文件还在只是占地方；反过来则是"库里指着不存在的文件"） */
  remove(input: { id: string; actor?: string }): { removed: TodoAttachment } {
    const found = this.find(input.id)
    if (!found) throw new NotFoundError(`附件不存在：${input.id}`)
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM todo_attachments WHERE id = ?').run(input.id)
    })
    tx()
    removeAttachmentFile(getDataDirPath(), found.relPath)
    return { removed: found }
  }

  /** 事项被删掉时收走它的附件（todos 的外键是 CASCADE，这里只负责文件） */
  removeAllForTodo(todoId: string): number {
    const rows = this.list(todoId)
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM todo_attachments WHERE todo_id = ?').run(todoId)
    })
    tx()
    removeAttachmentDir(getDataDirPath(), todoId)
    return rows.length
  }

  /**
   * 附件的本机绝对路径（卡 `89f3b3bc`，1.0.146 补的读内容）
   *
   * 库里存相对路径是为了数据目录整体搬家不破；出去给调用方（agent 读内容、
   * MCP 取图片）时再拼回绝对路径。转换只此一处 —— 与界面里的
   * `resolveRelPath(…) + nativeImage` 同一条防线（`../` 穿越在这里被拒）。
   */
  absolutePath(a: TodoAttachment): string {
    return resolveRelPath(getDataDirPath(), a.relPath)
  }

  /** 这张事项的附件总体积（界面上用来提示"附件占了多少"） */
  totalBytes(todoId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM todo_attachments WHERE todo_id = ?')
      .get(todoId) as { total: number }
    return row.total
  }

  /** 新建附件 id（测试与批量导入用；正常路径由 add 内部生成） */
  static newId(): string {
    return randomUUID()
  }
}

/** 上限值透出给界面做前置提示，避免"点了才发现太大" */
export { MAX_ATTACHMENT_BYTES }
