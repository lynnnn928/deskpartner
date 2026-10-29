import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { useUIStore } from '../../stores/ui.store'
import { useTodoStore } from '../../stores/todo.store'
import { useProjectStore } from '../../stores/project.store'
import { useCategoryStore } from '../../stores/category.store'
import { useSettingsStore } from '../../stores/settings.store'
import { invoke } from '../../lib/ipc-client'
import { shortId, cn } from '../../lib/utils'
import { PRIORITY_META, PRIORITY_ORDER, TYPE_META, TYPE_ORDER } from '../../lib/constants'
import { ownerLabel } from '../../lib/todo-filter'
import type { TodoPriority, TodoType } from '../../types/enums'
import type { TodoOwner, Agent } from '../../types/todo'
import type { BatchFailure } from '../../stores/todo.store'

/**
 * 批量操作条与批量修改弹窗（对齐详情抽屉字段术语与弹窗设计规范）
 *
 * 六种动作：改类型 / 改优先级 / 改执行人 / 改项目 / 改标签 / 删除。
 * 弹窗内直接渲染单选/多选面板，不再嵌套会溢出弹窗边界的浮层下拉菜单或详情页左标签属性行。
 */
type BatchAction = 'type' | 'priority' | 'executedBy' | 'project' | 'category' | 'delete'

const ACTIONS: { key: BatchAction; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'type', label: '改类型', icon: 'layers' },
  { key: 'priority', label: '改优先级', icon: 'alertTriangle' },
  { key: 'executedBy', label: '改执行人', icon: 'user' },
  { key: 'project', label: '改项目', icon: 'folder' },
  { key: 'category', label: '改标签', icon: 'tag' },
  { key: 'delete', label: '删除', icon: 'trash' }
]

export const BatchBar: React.FC = () => {
  const multiSelectMode = useUIStore((s) => s.multiSelectMode)
  const selectedIds = useUIStore((s) => s.selectedIds)
  const toggleMultiSelect = useUIStore((s) => s.toggleMultiSelect)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const showToast = useUIStore((s) => s.showToast)

  const todos = useTodoStore((s) => s.todos)
  const batchUpdate = useTodoStore((s) => s.batchUpdate)
  const batchDelete = useTodoStore((s) => s.batchDelete)
  const { projects } = useProjectStore()
  const { categories } = useCategoryStore()
  const { settings } = useSettingsStore()

  const [action, setAction] = useState<BatchAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<BatchFailure[] | null>(null)

  // 各动作的取值
  const [type, setType] = useState<TodoType>('task')
  const [priority, setPriority] = useState<TodoPriority>('normal')
  const [executedBy, setExecutedBy] = useState<TodoOwner | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [tagSearch, setTagSearch] = useState('')

  const [agents, setAgents] = useState<Agent[]>([])
  useEffect(() => {
    if (action !== 'executedBy') return
    let alive = true
    void invoke('agent:list')
      .then((list) => alive && setAgents((list ?? []).filter((a) => a.approved)))
      .catch(() => alive && setAgents([]))
    return () => {
      alive = false
    }
  }, [action])

  const selected = useMemo(
    () => todos.filter((t) => selectedIds.includes(t.id)),
    [todos, selectedIds]
  )
  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )
  const filteredCategories = useMemo(() => {
    const q = tagSearch.trim().toLowerCase()
    return q ? categories.filter((c) => c.name.toLowerCase().includes(q)) : categories
  }, [categories, tagSearch])

  if (!multiSelectMode) return null

  const close = () => {
    setAction(null)
    setFailures(null)
    setTagSearch('')
  }

  const finish = (failed: BatchFailure[], okCount: number, verb: string) => {
    if (failed.length === 0) {
      showToast(`已${verb} ${okCount} 条`)
      clearSelection()
      close()
      return
    }
    setFailures(failed)
  }

  const apply = async () => {
    if (busy) return
    if (
      action === 'project' &&
      (!projectId || !activeProjects.some((project) => project.id === projectId))
    ) {
      showToast('请选择一个有效的目标项目')
      return
    }
    setBusy(true)
    try {
      if (action === 'delete') {
        const r = await batchDelete(selectedIds)
        finish(r.failed, r.deleted.length, '删除')
      } else {
        const patch =
          action === 'type'
            ? { type }
            : action === 'priority'
              ? { priority }
              : action === 'executedBy'
                ? { executedBy }
                : action === 'project'
                  ? { projectId }
                  : { categoryIds }
        const r = await batchUpdate(selectedIds, patch)
        finish(r.failed, r.updated.length, '更新')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '批量操作失败')
    } finally {
      setBusy(false)
    }
  }

  const actionLabel = ACTIONS.find((a) => a.key === action)?.label ?? ''

  const toggleCategory = (id: string) => {
    setCategoryIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  return (
    <>
      {/* 批量工具栏：常驻在内容区顶部 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface-subtle shrink-0">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-bg-card border border-border text-label text-text-primary font-medium">
          已选 <span className="font-mono font-semibold text-accent">{selectedIds.length}</span> 条
        </span>
        <span className="text-caption text-text-secondary hidden sm:inline">
          点击下方事项即可勾选或取消
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5 flex-wrap">
          {ACTIONS.map((a) => {
            const disabled =
              selectedIds.length === 0 || (a.key === 'project' && activeProjects.length === 0)
            return (
              <button
                key={a.key}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (
                    a.key === 'project' &&
                    !activeProjects.some((project) => project.id === projectId)
                  ) {
                    setProjectId(activeProjects[0]?.id ?? null)
                  }
                  setAction(a.key)
                }}
                title={
                  selectedIds.length === 0
                    ? '先勾选要操作的事项'
                    : a.key === 'project' && activeProjects.length === 0
                      ? '当前没有可选项目'
                      : a.label
                }
                className={cn(
                  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-label border transition-colors',
                  disabled
                    ? 'text-text-secondary/40 border-border/50 bg-bg-card/50 cursor-not-allowed'
                    : a.key === 'delete'
                      ? 'text-danger border-danger/30 bg-bg-card hover:bg-danger/10 cursor-pointer'
                      : 'text-text-primary border-border bg-bg-card hover:bg-surface-muted cursor-pointer'
                )}
              >
                <Icon name={a.icon} size={12} />
                {a.label}
              </button>
            )
          })}
          <Button variant="ghost" size="sm" onClick={toggleMultiSelect}>
            退出批量
          </Button>
        </div>
      </div>

      {/* 批量动作对话框：弹窗内直接渲染选项列表，不套会溢出的下拉框 */}
      {action && !failures && (
        <Dialog open onClose={close}>
          <div className="w-dialog-sm flex flex-col gap-3.5">
            <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-border/60">
              <div className="flex items-baseline gap-2">
                <h3 className="text-body font-semibold text-text-primary">{actionLabel}</h3>
                <span className="text-caption font-mono text-text-secondary">
                  已选 {selectedIds.length} 条事项
                </span>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="关闭"
                className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors cursor-pointer"
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            {action === 'type' && (
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="选择事项类型">
                {TYPE_ORDER.map((t) => {
                  const active = type === t
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setType(t)}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 rounded-button border text-label transition-colors cursor-pointer',
                        active
                          ? 'border-accent bg-accent/10 text-text-primary font-semibold'
                          : 'border-border/70 bg-bg-card text-text-secondary hover:bg-surface-subtle hover:text-text-primary'
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: TYPE_META[t].color }}
                        />
                        {TYPE_META[t].label}
                      </span>
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}

            {action === 'priority' && (
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="选择优先级">
                {PRIORITY_ORDER.map((p) => {
                  const active = priority === p
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPriority(p)}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 rounded-button border text-label transition-colors cursor-pointer',
                        active
                          ? 'border-accent bg-accent/10 text-text-primary font-semibold'
                          : 'border-border/70 bg-bg-card text-text-secondary hover:bg-surface-subtle hover:text-text-primary'
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: PRIORITY_META[p].color }}
                        />
                        {PRIORITY_META[p].label}
                      </span>
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}

            {action === 'executedBy' && (
              <div
                className="flex flex-col gap-1.5 max-h-60 overflow-y-auto pr-0.5"
                role="radiogroup"
                aria-label="选择执行人"
              >
                {[
                  { value: '__same__', label: '不单独指派（默认由提出者执行）', icon: 'user' as const },
                  { value: 'human', label: ownerLabel('human', settings?.humanName), icon: 'user' as const },
                  ...agents.map((a) => ({
                    value: a.id,
                    label: a.displayName,
                    color: a.color ?? undefined,
                    icon: 'bot' as const
                  }))
                ].map((opt) => {
                  const currentVal = executedBy ?? '__same__'
                  const active = currentVal === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() =>
                        setExecutedBy(opt.value === '__same__' ? null : (opt.value as TodoOwner))
                      }
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 rounded-button border text-label transition-colors cursor-pointer',
                        active
                          ? 'border-accent bg-accent/10 text-text-primary font-semibold'
                          : 'border-border/70 bg-bg-card text-text-secondary hover:bg-surface-subtle hover:text-text-primary'
                      )}
                    >
                      <span className="inline-flex items-center gap-2 truncate">
                        {'color' in opt && opt.color ? (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: opt.color }}
                          />
                        ) : (
                          <Icon name={opt.icon} size={12} className="shrink-0 text-text-secondary" />
                        )}
                        <span className="truncate">{opt.label}</span>
                      </span>
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )}

            {action === 'project' && (
              <div className="flex flex-col gap-2">
                <p className="text-caption text-text-secondary">
                  将选中的 {selectedIds.length} 条事项迁移至以下目标项目：
                </p>
                <div
                  className="flex flex-col gap-1.5 max-h-60 overflow-y-auto pr-0.5"
                  role="radiogroup"
                  aria-label="选择目标项目"
                >
                  {activeProjects.map((project) => {
                    const active = projectId === project.id
                    return (
                      <button
                        key={project.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setProjectId(project.id)}
                        className={cn(
                          'w-full flex items-center justify-between px-3 py-2 rounded-button border text-label transition-colors cursor-pointer',
                          active
                            ? 'border-accent bg-accent/10 text-text-primary font-semibold'
                            : 'border-border/70 bg-bg-card text-text-secondary hover:bg-surface-subtle hover:text-text-primary'
                        )}
                      >
                        <span className="inline-flex items-center gap-2 truncate">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: project.color }}
                          />
                          <span className="truncate">{project.name}</span>
                        </span>
                        {active && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {action === 'category' && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption text-text-secondary">
                    点击选择要应用到这 {selectedIds.length} 条事项的标签（已选 {categoryIds.length} 个）
                  </span>
                  {categoryIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCategoryIds([])}
                      className="text-caption text-accent hover:underline cursor-pointer"
                    >
                      清空已选
                    </button>
                  )}
                </div>
                {categories.length > 6 && (
                  <div className="relative">
                    <Icon
                      name="search"
                      size={12}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
                    />
                    <input
                      type="text"
                      value={tagSearch}
                      onChange={(e) => setTagSearch(e.target.value)}
                      placeholder="搜索标签…"
                      className="w-full h-7 pl-7 pr-2.5 rounded-button border border-border bg-bg-card text-label text-text-primary outline-none focus:border-accent"
                    />
                  </div>
                )}
                <div className="max-h-56 overflow-y-auto rounded-card border border-border bg-surface-subtle p-2.5 flex flex-wrap gap-1.5">
                  {filteredCategories.map((cat) => {
                    const active = categoryIds.includes(cat.id)
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleCategory(cat.id)}
                        className={cn(
                          'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-label border transition-colors cursor-pointer',
                          active
                            ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-sm'
                            : 'bg-bg-card/60 text-text-secondary border-border/70 hover:text-text-primary hover:bg-bg-card'
                        )}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: cat.color }}
                        />
                        {cat.name}
                      </button>
                    )
                  })}
                  {filteredCategories.length === 0 && (
                    <span className="text-caption text-text-secondary py-2 px-1">
                      没有匹配的标签
                    </span>
                  )}
                </div>
              </div>
            )}

            {action === 'delete' && (
              <div className="flex flex-col gap-2.5">
                <p className="text-label text-text-secondary leading-relaxed">
                  即将删除以下 <span className="text-text-primary font-semibold">{selectedIds.length}</span> 条事项，
                  <span className="text-danger font-medium">确认删除后无法恢复</span>：
                </p>
                <ul className="max-h-56 overflow-y-auto border border-border rounded-card bg-surface-subtle divide-y divide-border/60">
                  {selected.map((t) => (
                    <li key={t.id} className="px-3 py-2 flex items-center gap-2 text-label">
                      <span className="font-mono text-caption text-text-secondary/75 shrink-0">
                        #{shortId(t.id)}
                      </span>
                      <span className="truncate text-text-primary">{t.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <Button variant="ghost" size="sm" onClick={close}>
                取消
              </Button>
              <Button
                variant={action === 'delete' ? 'dangerSolid' : 'primary'}
                size="sm"
                disabled={busy}
                onClick={() => void apply()}
              >
                {busy ? '处理中…' : action === 'delete' ? `确认删除 ${selectedIds.length} 条` : '应用修改'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* 结果回执：失败的逐条说清"哪条、为什么" */}
      {failures && (
        <Dialog open onClose={close}>
          <div className="w-dialog-sm flex flex-col gap-3">
            <h3 className="text-body font-semibold text-text-primary">
              部分事项未完成（{failures.length} 条）
            </h3>
            <ul className="max-h-64 overflow-y-auto border border-border rounded-card bg-surface-subtle divide-y divide-border/60">
              {failures.map((f) => (
                <li key={f.id} className="px-3 py-2 flex flex-col gap-0.5">
                  <span className="text-label text-text-primary flex items-center gap-2">
                    <span className="font-mono text-caption text-text-secondary/75 shrink-0">
                      #{shortId(f.id)}
                    </span>
                    <span className="truncate font-medium">{f.title}</span>
                  </span>
                  <span className="text-caption text-danger leading-relaxed">{f.reason}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={close}>
                知道了
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  )
}
