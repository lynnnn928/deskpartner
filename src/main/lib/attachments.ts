import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

/**
 * 事项附件的存放与命名（**纯文件层，不 import electron**）
 *
 * 为什么单独一层：仓储与 IPC 都要用它，而单测跑在 node 下 ——
 * 主进程里能用 `nativeImage` 的地方只有 IPC 那一层，缩略图/预览不进这里。
 *
 * 口径（主用户 2026-11-11）：附件是**复制**进数据目录的，不是引用外部路径。
 * 卡片自己的东西要跟着卡片活：源文件被移走或删掉后，附件仍然打得开；
 * 备份数据目录时也一起带走。代价是占磁盘，且源文件后续改动不会同步过来。
 */

/** 数据目录下的附件根目录名 */
export const ATTACHMENTS_DIR = 'attachments'

/**
 * 单个附件的大小上限（25 MB）
 *
 * 上限是为了两件事：预览要把图片读成 `data:` URL 进渲染进程，几十 MB 的图会卡住界面；
 * 数据目录整体备份（用户手动拷走）时也不该被单个附件拖住。超限**明确报错**，
 * 不做静默截断 —— 截断后的附件是"看起来存上了、打开是坏的"，比拒绝更糟。
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export type AttachmentKind = 'image' | 'file'

/**
 * 超上限时给人的那句话
 *
 * 两个入口都要说同一句话：按路径添加（复制前预检）与粘贴字节（落临时文件前预检）。
 * 措辞写两遍迟早漂，而且"到底算不算超"的判据只有一个 —— 这里就是它。
 */
export function attachmentTooLargeReason(bytes: number, name: string): string {
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
  return `附件超过 ${mb(MAX_ATTACHMENT_BYTES)} MB 上限（${mb(bytes)} MB）：${name}`
}

/** 按扩展名认的图片类型 —— 认不出就是普通文件 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.svg': 'image/svg+xml'
}

export interface AttachmentFileMeta {
  name: string
  ext: string
  kind: AttachmentKind
  mime: string
  bytes: number
  sha256: string
  /** 相对数据目录的路径（`attachments/<todoId>/<id><ext>`），存库的就是它 */
  relPath: string
  id: string
}

/** 扩展名（小写、带点）；没有扩展名返回空串 */
export function extOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  // 只留下"正常的"扩展名：点后面必须是字母数字，且不超过 8 个字符
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''
}

/** 由扩展名定 kind 与 mime；认不出按普通文件处理 */
export function classifyByName(name: string): { kind: AttachmentKind; mime: string } {
  const ext = extOf(name)
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] }
  return { kind: 'file', mime: FILE_MIME[ext] ?? 'application/octet-stream' }
}

/**
 * 文件名净化：附件名只用来显示
 *
 * 去掉路径分隔符与控制字符（名字里带 `/` 会让 `path.join` 跑到别的目录去），
 * 折叠空白，并限制长度 —— 显示用的名字没必要跟磁盘上的真实名字一样长。
 */
export function safeAttachmentName(raw: string): string {
  const cleaned = (raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return '未命名文件'
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned
}

/** 某条事项的附件目录（绝对路径） */
export function attachmentDirOf(dataDir: string, todoId: string): string {
  return path.join(dataDir, ATTACHMENTS_DIR, todoId)
}

/**
 * 相对路径 → 绝对路径，并**挡住目录穿越**
 *
 * rel_path 是我们自己写进去的，但库里那份数据可以被外部改（用户直接开 SQLite 改库），
 * 拿它去 `shell.openPath` 之前必须确认它还在数据目录里 —— 否则一句 `../../..`
 * 就能让界面替人打开任意文件。
 */
export function resolveRelPath(dataDir: string, relPath: string): string {
  const root = path.resolve(dataDir)
  const abs = path.resolve(root, relPath)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('附件路径越过了数据目录，已拒绝打开')
  }
  return abs
}

/** 算文件的 sha256 与体积 */
export function statFile(file: string): { bytes: number; sha256: string } {
  const bytes = fs.statSync(file).size
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  return { bytes, sha256 }
}

/**
 * 把一个外部文件复制进数据目录，返回落库需要的元信息
 *
 * 预检（存在、是普通文件、不超上限）在复制**之前**做完：复制半个大文件再报错，
 * 会在数据目录里留下一个谁也不认识的残片。
 */
export function storeAttachmentFile(opts: {
  dataDir: string
  todoId: string
  srcPath: string
  /** 可注入，测试里定 id；正常走随机 */
  id?: string
}): AttachmentFileMeta {
  const { dataDir, todoId, srcPath } = opts
  const src = path.resolve(srcPath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(src)
  } catch {
    throw new Error(`附件不存在或读不到：${srcPath}`)
  }
  if (!stat.isFile()) throw new Error(`只能关联文件，不能关联目录：${srcPath}`)
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(attachmentTooLargeReason(stat.size, path.basename(srcPath)))
  }

  const id = opts.id ?? randomUUID()
  const name = safeAttachmentName(path.basename(src))
  const ext = extOf(name)
  const { kind, mime } = classifyByName(name)
  const dir = attachmentDirOf(dataDir, todoId)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${id}${ext}`)
  fs.copyFileSync(src, dest)
  const { bytes, sha256 } = statFile(dest)

  return {
    id,
    name,
    ext,
    kind,
    mime,
    bytes,
    sha256,
    relPath: [ATTACHMENTS_DIR, todoId, `${id}${ext}`].join('/')
  }
}

/** 删掉一个附件文件（连空的目录一起收掉）；不存在就算成功 */
export function removeAttachmentFile(dataDir: string, relPath: string): void {
  const abs = resolveRelPath(dataDir, relPath)
  try {
    fs.rmSync(abs, { force: true })
  } catch {
    /* 文件已经不在了，正是想要的结果 */
  }
  try {
    const dir = path.dirname(abs)
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* 目录里还有别的东西，留着 */
  }
}

/** 事项被删除时，把它的附件目录整个收掉 */
export function removeAttachmentDir(dataDir: string, todoId: string): void {
  try {
    fs.rmSync(attachmentDirOf(dataDir, todoId), { recursive: true, force: true })
  } catch {
    /* 收不掉不影响删事项本身 */
  }
}

/** 给人看的大小文案 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
