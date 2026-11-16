import fs from 'node:fs'
import path from 'node:path'
import { resolveRelPath, statFile } from '../lib/attachments'
import type { ExportData, ImportResult } from './backup.service'

/**
 * 备份文件夹（卡 fbcd8c03）：一份 JSON + 附件文件本体
 *
 * ── 为什么不再只有一份 JSON ──
 *
 * v6 起 `auxiliary.todoAttachments` 随备份走，带着 `rel_path` 与 `sha256`，
 * 但**文件本体**留在数据目录的 `attachments/<todoId>/<id><ext>` 里。
 * 换一台机器把 JSON 导回去：附件行全都回来了，点开却一个都打不开 ——
 * 而回执上一切"成功"。备份的意义是"换机还能接着用"，那就得把文件也带走。
 *
 * ── 形状 ──
 *
 * ```
 * desk-partner-backup-2026-11-16/
 *   backup.json                 ← 与老的导出一模一样（旧的单 JSON 仍可导入）
 *   attachments/<todoId>/<id><ext>   ← rel_path 原样，不重排、不重命名
 * ```
 *
 * 路径原样保留是刻意的：库里的行已经写着 `rel_path`，备份里与它同构，
 * 恢复时逐行对照、按 `sha256` 校验即可，不需要第二张映射表。
 */

/** 备份文件夹里的 JSON 文件名（导入时靠它认出"这是个备份文件夹"） */
export const BACKUP_JSON_FILE = 'backup.json'

/** 导出结果：目录在哪、附件复制了几个、缺了哪几个 */
export interface ExportFolderResult {
  dir: string
  attachmentFiles: {
    copied: number
    missing: string[]
  }
}

/** 导入时的附件文件归宿 */
export interface AttachmentFileResult {
  copied: number
  /** 目标已存在且 sha256 相同 —— 重复导入时属正常 */
  skipped: number
  /** 备份里就没有这份文件 */
  missing: string[]
  /** 内容与行里的 sha256 对不上（或 rel_path 越界），一律不复制 */
  mismatched: string[]
}

/** 附件行里我们只认这两个字段：`rel_path` 指文件，`sha256` 判内容 */
function attachmentRowsOf(data: ExportData): Record<string, unknown>[] {
  const rows = data.auxiliary?.todoAttachments
  return Array.isArray(rows) ? rows : []
}

function parseBackupJson(json: string): ExportData {
  try {
    return JSON.parse(json) as ExportData
  } catch {
    throw new Error('[Backup] 备份数据不是有效的 JSON')
  }
}

function relPathOf(row: Record<string, unknown>): string {
  const relPath = row.rel_path
  return typeof relPath === 'string' ? relPath : ''
}

/**
 * 在 parentDir 下建一个**不重名**的备份目录
 *
 * 判据是"绝不覆盖已有目录"：备份是用户手里唯一的那份退路，
 * 同名时覆盖掉上一份，等于在最不该出错的地方悄悄丢一次数据。
 * 所以不用 `existsSync` + `mkdir`（中间还有一段竞态），
 * 而是直接 `mkdir` 不带 recursive —— 已存在会抛 `EEXIST`，按它往后排。
 */
function createUniqueDir(parentDir: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = `desk-partner-backup-${stamp}`
  for (let n = 1; n <= 999; n++) {
    const candidate = path.join(parentDir, n === 1 ? base : `${base}-${n}`)
    try {
      fs.mkdirSync(candidate)
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error(`[Backup] ${parentDir} 下同名备份目录太多，换一个位置再导出`)
}

/**
 * 导出成文件夹：`backup.json` + 附件文件本体
 *
 * 源文件缺失**不中断**：数据目录可能被外部动过（手工删过附件），
 * 那种时候整份备份失败比"少一份附件、但其余都带走"更糟 ——
 * 缺的那几份记进结果，界面上要能看见。
 */
export function exportToFolder(
  backup: { exportData(): string },
  parentDir: string,
  dataDir: string
): ExportFolderResult {
  const json = backup.exportData()
  const dir = createUniqueDir(parentDir)
  fs.writeFileSync(path.join(dir, BACKUP_JSON_FILE), json, 'utf8')

  const missing: string[] = []
  let copied = 0
  const seen = new Set<string>()
  for (const row of attachmentRowsOf(parseBackupJson(json))) {
    const relPath = relPathOf(row)
    if (!relPath || seen.has(relPath)) continue
    seen.add(relPath)
    try {
      const src = resolveRelPath(dataDir, relPath)
      if (!fs.existsSync(src)) {
        missing.push(relPath)
        continue
      }
      const dest = resolveRelPath(dir, relPath)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      copied++
    } catch {
      // rel_path 越界：不读也不写。库里那份数据可以被外部改，不能拿它去拷任意文件
      missing.push(relPath)
    }
  }

  return { dir, attachmentFiles: { copied, missing } }
}

/**
 * 从文件夹导入：先导 JSON，再按 sha256 逐个校验复制附件
 *
 * 顺序是硬约束：**文件复制放在 `importData` 成功之后**。
 * 反过来做，一份导入失败的 JSON 会在数据目录里留下一堆谁也认不出的文件。
 *
 * 每一份附件的归宿只有四种，都要报出来 —— "复制了几个"说明不了
 * "另外几个怎么了"，而换机恢复时人最需要知道的正是后者。
 */
export function importFromFolder(
  backup: { importData(json: string): ImportResult },
  dir: string,
  dataDir: string
): ImportResult {
  const jsonPath = path.join(dir, BACKUP_JSON_FILE)
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`所选文件夹里没有 ${BACKUP_JSON_FILE}，不是备份文件夹：${dir}`)
  }
  const json = fs.readFileSync(jsonPath, 'utf8')

  // 这一步失败就抛出，下面一行附件都不碰
  const result = backup.importData(json)

  const attachmentFiles: AttachmentFileResult = {
    copied: 0,
    skipped: 0,
    missing: [],
    mismatched: []
  }

  for (const row of attachmentRowsOf(parseBackupJson(json))) {
    const relPath = relPathOf(row)
    if (!relPath) continue
    const expected = typeof row.sha256 === 'string' ? row.sha256 : ''

    let src: string
    let dest: string
    try {
      src = resolveRelPath(dir, relPath)
      dest = resolveRelPath(dataDir, relPath)
    } catch {
      // 两边都过一遍：备份侧的越界是"这份备份被人改过"，
      // 数据侧的越界是"这条 rel_path 会写到数据目录之外"。都不复制，都要报
      attachmentFiles.mismatched.push(relPath)
      continue
    }

    if (!fs.existsSync(src)) {
      attachmentFiles.missing.push(relPath)
      continue
    }
    const actual = statFile(src)
    // 行里没写 sha256 的是极老的备份，只能按"存在"处理；写了就必须对得上
    if (expected && actual.sha256 !== expected) {
      attachmentFiles.mismatched.push(relPath)
      continue
    }
    if (fs.existsSync(dest) && statFile(dest).sha256 === actual.sha256) {
      attachmentFiles.skipped++
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    attachmentFiles.copied++
  }

  return { ...result, attachmentFiles }
}
