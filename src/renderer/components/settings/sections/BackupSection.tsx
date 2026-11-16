import React, { useState } from 'react'
import { Section, Row } from '../Section'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { invoke } from '../../../lib/ipc-client'
import type { BackupImportResult } from '../../../types/ipc'

/** 回执里每类文件最多列几个 —— 多了人也不会逐个看，剩下的说个数 */
const RECEIPT_LIST_MAX = 5

/** rel_path → 文件名：回执里给人看的是文件名，不是整条相对路径 */
function fileNameOf(relPath: string): string {
  const parts = relPath.split(/[\\/]/)
  return parts[parts.length - 1] || relPath
}

/** 往回执里追加一类文件（前几个点名，其余只报个数） */
function pushFileList(lines: string[], label: string, files: string[]): void {
  if (!files.length) return
  const head = files.slice(0, RECEIPT_LIST_MAX).map(fileNameOf)
  const rest = files.length - head.length
  lines.push(`　${label}：${head.join('、')}${rest > 0 ? ` 等 ${files.length} 个` : ''}`)
}

/**
 * 把导入回执翻译成人话（1.0.46；1.0.146 起加附件文件与 v6 四张表）
 *
 * 此前这里只有一句 `alert('导入成功')` —— 于是"全部导入成功"和
 * "只导进来 3 个字段、丢了 200 条待办属性"在界面上长得一模一样。
 * Bob演练时正是靠这句回执判断"恢复完成"，实际上库是半空的。
 *
 * 现在必须说清四件事：
 * ① 各表分别进了多少（一个总数说明不了"哪里没进来"）
 * ② 哪些被跳过、为什么（重复导入导致的跳过是正常的，要区分开）
 * ③ 原件备份在哪（导入不可回滚，这是唯一退路）
 * ④ **附件文件**怎么样了（卡 fbcd8c03）：复制几个、跳过几个、缺哪几份、
 *    哪几份内容对不上 —— 这正是"换机后附件打不开"当初看不见的地方
 */
function formatImportResult(result: BackupImportResult): string {
  const lines: string[] = []
  const d = result.detail

  if (d) {
    lines.push('导入结果：')
    lines.push(
      `　项目 ${d.projects} · 分类 ${d.categories} · 事项 ${d.todos} · 身份 ${d.agents} · 备忘 ${d.memos}`
    )
    lines.push(`　档案修订 ${d.profileRevisions} · 协作规则修订 ${d.ruleRevisions}`)
    // v6 那四张表（通知/附件行/文档快照/协议修订）：缺了它们换机后整段历史断掉，
    // 回执里不说，人就看不出"没进来"和"本来就没有"的区别
    lines.push(
      `　通知 ${d.notifications ?? 0} · 附件 ${d.todoAttachments ?? 0} · ` +
        `文档快照 ${d.projectDocRevisions ?? 0} · 协议修订 ${d.protocolRevisions ?? 0}`
    )
  } else {
    lines.push(`导入结果：${result.imported} 项`)
  }

  if (result.reusedCategories) {
    lines.push(
      `　（其中 ${result.reusedCategories} 个分类按名称沿用了已有的，未重复创建）`
    )
  }

  if (result.skippedItems?.length) {
    const head = result.skippedItems.slice(0, 5)
    lines.push('')
    lines.push(`跳过 ${result.skippedItems.length} 项：`)
    for (const item of head) {
      lines.push(`　· [${item.kind}] ${item.title} —— ${item.why}`)
    }
    if (result.skippedItems.length > head.length) {
      lines.push(`　…… 另有 ${result.skippedItems.length - head.length} 项，详见主进程日志`)
    }
  }

  /**
   * 附件文件那一段（卡 fbcd8c03）
   *
   * 只有文件夹导入才有 —— 单份 JSON 里根本没有文件，那时候写一行"复制 0 个"
   * 会让人以为文件都处理过了。
   */
  const files = result.attachmentFiles
  if (files) {
    lines.push('')
    lines.push(
      `附件文件：复制 ${files.copied} 个 · 跳过 ${files.skipped} 个 · ` +
        `缺失 ${files.missing.length} 个 · 校验不符 ${files.mismatched.length} 个`
    )
    pushFileList(lines, '缺失（备份里就没有，换机后打不开）', files.missing)
    pushFileList(lines, '校验不符或路径异常（内容与 sha256 对不上，或路径越出目录，未复制）', files.mismatched)
  }

  if (result.settingsRejected?.length) {
    lines.push('')
    lines.push('设置中未采纳的项：')
    for (const r of result.settingsRejected) {
      lines.push(`　· ${r.key} —— ${r.why}`)
    }
  }

  if (result.preImportBackup) {
    lines.push('')
    lines.push('导入前的数据已自动备份到：')
    lines.push(`　${result.preImportBackup}`)
  }

  return lines.join('\n')
}

/** 导出回执：导出到哪个目录、附件复制了几个、缺了几个（缺的是哪几个） */
function formatExportResult(result: {
  dir: string
  attachmentFiles: { copied: number; missing: string[] }
}): string {
  const lines = [`导出完成：${result.dir}`]
  lines.push(
    `　附件文件：复制 ${result.attachmentFiles.copied} 个 · 缺 ${result.attachmentFiles.missing.length} 个`
  )
  pushFileList(lines, '缺的文件（备份里就没有，换机后打不开）', result.attachmentFiles.missing)
  return lines.join('\n')
}

/**
 * 备份导出 / 导入（1.0.48 从「系统」组挪入「数据管理」组）
 *
 * 导入会整库覆盖，是危险操作 —— 所以它留在设置页（操作台），
 * 不进统计页（观察窗）。回执必须说清四件事，见 formatImportResult。
 *
 * 1.0.146（卡 fbcd8c03）：导出从"下载一份 JSON"改成"写一个文件夹"。
 * 附件文件本体的分量就在这里 —— 只给 JSON 时，换一台机器导回去，
 * 卡片上的附件行全在、点开一个都打不开。老的单 JSON 备份另留一个入口，
 * 它们仍然要能导入。
 */
export const BackupSection: React.FC = () => {
  const [receipt, setReceipt] = useState<{ title: string; body: string } | null>(null)

  const fail = (title: string, action: string, err: unknown) => {
    setReceipt({ title, body: `${action}失败：${(err as Error).message}` })
  }

  const handleExportFolder = async () => {
    try {
      const result = await invoke('backup:exportFolder')
      // 取消选目录是人的决定，不是失败 —— 不弹回执
      if (result.canceled) return
      setReceipt({ title: '数据导出回执', body: formatExportResult(result) })
    } catch (e) {
      console.error('导出失败:', e)
      fail('数据导出回执', '导出', e)
    }
  }

  const handleImportFolder = async () => {
    try {
      const result = await invoke('backup:importFolder')
      if (result.canceled) return
      setReceipt({ title: '数据导入回执', body: formatImportResult(result) })
    } catch (e) {
      fail('数据导入回执', '导入', e)
    }
  }

  /** 老路：单份 JSON。文件本来就不在里面，导入后附件可能显示缺文件 */
  const handleImportLegacyJson = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      try {
        const result = await invoke('backup:import', { data: text })
        setReceipt({ title: '数据导入回执', body: formatImportResult(result) })
      } catch (err) {
        fail('数据导入回执', '导入', err)
      }
    }
    input.click()
  }

  return (
    <Section
      title="备份"
      desc="导出一个文件夹：backup.json 加附件文件原样复制；导入前会自动备份当前数据。"
    >
      <Row
        label="数据导出"
        hint="备份文件夹里有 backup.json 与 attachments/，换机时把整个文件夹拷走即可。"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={handleExportFolder}
          data-testid="backup-export-folder"
        >
          导出文件夹
        </Button>
      </Row>
      <Row label="数据导入" hint="选备份文件夹。导入将覆盖当前数据（导入前会自动备份原数据库）。">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleImportFolder}
          data-testid="backup-import-folder"
        >
          导入备份文件夹
        </Button>
      </Row>
      <Row
        label="旧版备份"
        hint="只有一份 JSON 的老备份仍可导入 —— 附件文件不随 JSON 走，导进来后可能显示缺文件。"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={handleImportLegacyJson}
          data-testid="backup-import-legacy"
        >
          导入旧版 JSON
        </Button>
      </Row>

      {receipt !== null && (
        <Dialog open onClose={() => setReceipt(null)} className="w-dialog-md max-w-dialog-md">
          <div className="flex flex-col gap-3 max-h-scroll-md">
            <h3 className="text-body font-semibold text-text-primary shrink-0">{receipt.title}</h3>
            <pre
              data-testid="backup-receipt"
              className="flex-1 min-h-0 overflow-y-auto whitespace-pre-wrap text-label text-text-secondary leading-relaxed bg-surface-subtle border border-border rounded-button p-3"
            >
              {receipt.body}
            </pre>
            <div className="flex justify-end shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setReceipt(null)}>
                关闭
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Section>
  )
}
