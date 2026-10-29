import React, { useState } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { RELEASE_DELETE_LIST_LIMIT } from '../../lib/release-delete'

export interface ReleaseDeleteTodo {
  id: string
  title: string
  statusLabel: string
}

interface ReleaseDeleteDialogProps {
  projectName: string
  version: string
  todos: ReleaseDeleteTodo[]
  /** 删除成功/失败由调用方处理；失败时抛错即可，对话框会显示文案 */
  onConfirmDelete: () => Promise<void>
  /** 解除单条事项的版本标记 */
  onUnlink: (todoId: string) => Promise<void>
  /** 一次解除全部（对话框内已二次确认） */
  onUnlinkAll: () => Promise<void>
  /** 到事项页查看关联事项 */
  onViewItems: () => void
  onClose: () => void
  /** 外部传入的失败文案（已转成人话） */
  error?: string | null
  busy?: boolean
}

/**
 * 删除版本登记的确认框（替换原生 window.confirm）。
 *
 * 两种状态：
 * - 仍有关联事项：说明为什么不能删、列出事项、给「逐条解除 / 全部解除 / 去事项页看」三个出口；
 * - 无关联：讲清后果（只删登记、不删事项、不可恢复）再让人确认。
 * 解除标记必须是人点出来的动作，不会在删除时被顺手清空（决策：版本删除选②）。
 */
export const ReleaseDeleteDialog: React.FC<ReleaseDeleteDialogProps> = ({
  projectName, version, todos, onConfirmDelete, onUnlink, onUnlinkAll, onViewItems, onClose, error, busy = false
}) => {
  const [working, setWorking] = useState<string | 'all' | 'delete' | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const blocked = todos.length > 0
  const shown = todos.slice(0, RELEASE_DELETE_LIST_LIMIT)
  const disabled = busy || working !== null

  const run = async (key: string, fn: () => Promise<void>) => {
    setWorking(key)
    setLocalError(null)
    try {
      await fn()
      setConfirmAll(false)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '操作失败，请稍后重试。')
    } finally {
      setWorking(null)
    }
  }

  const message = localError ?? error ?? null

  return (
    <Dialog open onClose={disabled ? () => {} : onClose} className="w-dialog-md max-w-dialog-md max-h-dialog overflow-y-auto">
      <div className="w-full flex flex-col gap-3" role="alertdialog" aria-labelledby="release-delete-title">
        <div>
          <h3 id="release-delete-title" className="text-body font-medium text-text-primary">
            {blocked ? `暂时不能删除版本 ${version}` : `删除版本 ${version}？`}
          </h3>
          <p className="mt-0.5 text-label text-text-secondary">项目「{projectName}」</p>
        </div>

        {blocked ? (
          <>
            <p className="text-label leading-relaxed text-text-primary">
              该版本关联了 <strong>{todos.length}</strong> 条事项，请先解除关联后再删除版本记录（事项本身不会被删除）。
            </p>
            <ul className="flex flex-col gap-1" aria-label="关联事项">
              {shown.map((t) => (
                <li key={t.id} className="flex items-center gap-2 rounded-input border border-border/70 px-2.5 py-1.5">
                  <span className="w-14 shrink-0 text-label text-text-secondary">{t.statusLabel}</span>
                  <span className="min-w-0 flex-1 truncate text-label text-text-primary" title={t.title}>{t.title}</span>
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void run(t.id, () => onUnlink(t.id))}>
                    {working === t.id ? '解除中…' : '解除标记'}
                  </Button>
                </li>
              ))}
              {todos.length > shown.length && (
                <li className="px-1 text-label text-text-secondary">另有 {todos.length - shown.length} 条未列出，可「在事项页查看」或「全部解除」。</li>
              )}
            </ul>
            {confirmAll && (
              <p className="rounded-input border border-amber-200 bg-amber-50 px-3 py-2 text-label text-amber-800">
                将清空这 {todos.length} 条事项的「解决于版本」标记（事项本身不变，此操作留有审计记录）。确认后会自动回到删除确认。
              </p>
            )}
          </>
        ) : (
          <p className="text-label leading-relaxed text-text-primary">
            将删除版本 <strong>{version}</strong> 的登记（版本说明与要点）。当前没有事项关联该版本，<span className="text-text-secondary">事项不会受影响，但登记删除后无法恢复。</span>
          </p>
        )}

        {message && <p role="alert" className="rounded-input border border-red-200 bg-red-50 px-3 py-2 text-label text-red-600">{message}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onClose}>{blocked ? '关闭' : '取消'}</Button>
          {blocked ? (
            <>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={onViewItems}>在事项页查看</Button>
              {confirmAll ? (
                <Button variant="primary" size="sm" disabled={disabled} onClick={() => void run('all', onUnlinkAll)}>
                  {working === 'all' ? '解除中…' : `确认全部解除（${todos.length}）`}
                </Button>
              ) : (
                <Button variant="primary" size="sm" disabled={disabled} onClick={() => setConfirmAll(true)}>全部解除标记…</Button>
              )}
            </>
          ) : (
            <Button variant="danger" size="sm" disabled={disabled} className="border border-red-300" onClick={() => void run('delete', onConfirmDelete)}>
              {working === 'delete' ? '删除中…' : '确认删除版本登记'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
