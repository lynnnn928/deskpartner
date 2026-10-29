import React, { useState } from 'react'
import { Section, Row } from '../Section'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { invoke } from '../../../lib/ipc-client'
import type { IPCResult } from '../../../types/ipc'

/**
 * 把导入回执翻译成人话（1.0.46）
 *
 * 此前这里只有一句 `alert('导入成功')` —— 于是"全部导入成功"和
 * "只导进来 3 个字段、丢了 200 条待办属性"在界面上长得一模一样。
 * Bob演练时正是靠这句回执判断"恢复完成"，实际上库是半空的。
 *
 * 现在必须说清三件事：
 * ① 各表分别进了多少（一个总数说明不了"哪里没进来"）
 * ② 哪些被跳过、为什么（重复导入导致的跳过是正常的，要区分开）
 * ③ 原件备份在哪（导入不可回滚，这是唯一退路）
 */
function formatImportResult(result: IPCResult<'backup:import'>): string {
  const lines: string[] = []
  const d = result.detail

  if (d) {
    lines.push('导入结果：')
    lines.push(
      `　项目 ${d.projects} · 分类 ${d.categories} · 事项 ${d.todos} · 身份 ${d.agents} · 备忘 ${d.memos}`
    )
    lines.push(`　档案修订 ${d.profileRevisions} · 协作规则修订 ${d.ruleRevisions}`)
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

/**
 * 备份导出 / 导入（1.0.48 从「系统」组挪入「数据管理」组）
 *
 * 导入会整库覆盖，是危险操作 —— 所以它留在设置页（操作台），
 * 不进统计页（观察窗）。回执必须说清三件事，见 formatImportResult。
 */
export const BackupSection: React.FC = () => {
  const [importReceipt, setImportReceipt] = useState<string | null>(null)

  const handleExportData = async () => {
    try {
      const json = await invoke('backup:export')
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `desk-partner-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('导出失败:', e)
    }
  }

  const handleImportData = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      try {
        const result = await invoke('backup:import', { data: text })
        setImportReceipt(formatImportResult(result))
      } catch (err) {
        setImportReceipt('导入失败: ' + (err as Error).message)
      }
    }
    input.click()
  }

  return (
    <Section
      title="备份"
      desc="导出是全量 JSON（事项/项目/分类/身份/备忘）；导入前会自动备份当前数据。"
    >
      <Row label="数据导出">
        <Button variant="ghost" size="sm" onClick={handleExportData}>
          导出 JSON
        </Button>
      </Row>
      <Row label="数据导入" hint="导入将覆盖当前数据（导入前会自动备份原数据库）。">
        <Button variant="ghost" size="sm" onClick={handleImportData}>
          导入 JSON
        </Button>
      </Row>

      {importReceipt !== null && (
        <Dialog open onClose={() => setImportReceipt(null)} className="w-dialog-md max-w-dialog-md">
          <div className="flex flex-col gap-3 max-h-scroll-md">
            <h3 className="text-body font-semibold text-text-primary shrink-0">数据导入回执</h3>
            <pre className="flex-1 min-h-0 overflow-y-auto whitespace-pre-wrap text-label text-text-secondary leading-relaxed bg-surface-subtle border border-border rounded-button p-3">
              {importReceipt}
            </pre>
            <div className="flex justify-end shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setImportReceipt(null)}>
                关闭
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Section>
  )
}
