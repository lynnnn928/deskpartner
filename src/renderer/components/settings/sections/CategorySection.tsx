import React, { useState } from 'react'
import { Section } from '../Section'
import { Icon } from '../../ui/Icon'
import { Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { cn } from '../../../lib/utils'
import { useCategoryStore } from '../../../stores/category.store'
import { useTodoStore } from '../../../stores/todo.store'
import type { Category } from '../../../types/category'

/**
 * 分类管理：改名 / 改色 / 合并 / 删除
 *
 * **合并是这里最重要的一个动作**，理由见 F2-P0-20：
 * 多个 agent 各建各的标签时，"竞争调研"和"竞品调研"会同时存在。
 * 只能删不能并的话，用户删掉一个，其下待办就变成没标签的孤儿；
 * 而逐个把待办改挂过去，在几十条的量级上根本没人会做。
 */
export const CategorySection: React.FC = () => {
  const { categories, updateCategory, deleteCategory, mergeCategory, createCategory } =
    useCategoryStore()
  const { todos } = useTodoStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  /** 每个分类挂了多少条待办；删/并之前要让人看见影响面 */
  const countOf = (id: string) => todos.filter((t) => t.categoryIds.includes(id)).length

  const startEdit = (cat: Category) => {
    setEditingId(cat.id)
    setDraftName(cat.name)
    setError('')
    setNotice('')
  }

  const commitName = async (cat: Category) => {
    const name = draftName.trim()
    if (!name) {
      setError('分类名不能为空')
      return
    }
    if (name !== cat.name && categories.some((c) => c.name === name)) {
      setError(`已存在同名分类「${name}」，请直接合并`)
      return
    }
    await updateCategory(cat.id, { name })
    setEditingId(null)
    setError('')
  }

  /**
   * 删除分类：有影响面（其下有待办）时先弹自绘确认框。
   * 1.0.48 前用 window.confirm —— 原生弹窗样式管不了，也过不了「全界面组件一种话」。
   */
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)

  const handleDelete = (cat: Category) => {
    if (countOf(cat.id) > 0) {
      setDeleteTarget(cat)
      return
    }
    void doDelete(cat)
  }

  const doDelete = async (cat: Category) => {
    try {
      await deleteCategory(cat.id)
      setNotice(`已删除「${cat.name}」`)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleMerge = async (from: Category, toId: string) => {
    if (!toId) return
    try {
      const moved = await mergeCategory(from.id, toId)
      const to = categories.find((c) => c.id === toId)
      setMergingId(null)
      setError('')
      setNotice(`已把「${from.name}」并入「${to?.name ?? ''}」，${moved} 条事项改挂`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    if (categories.some((c) => c.name === name)) {
      setError(`已存在同名分类「${name}」`)
      return
    }
    try {
      await createCategory({
        name,
        color: '#5388F6'
        // sortOrder 省略：仓储按 MAX+1 追加到末尾（1.0.109，卡 681528e5）
      })
      setNewName('')
      setCreating(false)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Section
      title="分类标签"
      desc="点击名称可重命名，点击色点可换色；支持将同义标签合并。"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {categories.map((cat) => {
          const n = countOf(cat.id)
          const isEditing = editingId === cat.id
          const isMerging = mergingId === cat.id
          const others = categories.filter((c) => c.id !== cat.id)

          return (
            <div
              key={cat.id}
              className="rounded-button border border-border/70 bg-surface-subtle px-3 py-2 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                {/*
                  改色：直接点色块，用原生取色器。
                  onChange 在拖动取色时会连续触发，所以这里**不 await 也不报错提示** ——
                  等它 setValue 完再允许用户继续拖，颜色面板会卡住。
                  颜色是幂等写入，最后一次生效即可。
                */}
                <input
                  type="color"
                  value={cat.color}
                  onChange={(e) => {
                    void updateCategory(cat.id, { color: e.target.value.toUpperCase() })
                  }}
                  title="修改颜色"
                  aria-label={`${cat.name}颜色`}
                  className="w-5 h-5 rounded-full border border-border cursor-pointer bg-transparent p-0 shrink-0"
                />

                {isEditing ? (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => void commitName(cat)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitName(cat)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    maxLength={20}
                    className="flex-1 min-w-0 px-2 py-0.5 rounded-input border border-accent bg-bg-card
                      text-content text-text-primary outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(cat)}
                    title="点击改名"
                    className="flex-1 min-w-0 text-left text-content text-text-primary truncate
                      hover:text-accent transition-colors cursor-pointer"
                  >
                    {cat.name}
                  </button>
                )}

                {cat.isDefault && (
                  <span
                    className="px-1.5 py-0.5 rounded-xs bg-surface-muted text-caption text-text-secondary shrink-0"
                    title="系统默认分类不可删除"
                  >
                    默认
                  </span>
                )}

                <span
                  className="text-caption font-mono text-text-secondary shrink-0"
                  title="关联事项数"
                >
                  {n}
                </span>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setMergingId(isMerging ? null : cat.id)
                      setError('')
                    }}
                    title="合并到另一个分类"
                    className={cn(
                      'p-1 rounded transition-colors cursor-pointer',
                      isMerging ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-accent'
                    )}
                  >
                    <Icon name="gitBranch" size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(cat)}
                    disabled={cat.isDefault}
                    title={cat.isDefault ? '系统默认分类不可删除' : '删除分类'}
                    className={cn(
                      'p-1 rounded transition-colors',
                      cat.isDefault
                        ? 'text-text-secondary/25 cursor-not-allowed'
                        : 'text-text-secondary hover:text-danger cursor-pointer'
                    )}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>

              {/* 合并目标选择：只在点开时出现，平时不占地方 */}
              {isMerging && (
                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-border/50 text-label">
                  <span className="text-text-secondary shrink-0">并入目标分类</span>
                  <Select
                    value=""
                    placeholder="选择目标分类…"
                    options={others.map((o) => ({
                      value: o.id,
                      label: o.name,
                      color: o.color
                    }))}
                    onChange={(val) => void handleMerge(cat, val)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {creating ? (
        <div className="flex items-center gap-2 pt-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') {
                setCreating(false)
                setNewName('')
              }
            }}
            placeholder="输入新分类名称…"
            maxLength={20}
            className="h-8 w-56 px-2.5 rounded-input border border-accent bg-bg-card text-label text-text-primary outline-none"
          />
          <Button size="sm" variant="primary" onClick={() => void handleCreate()}>
            添加
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(false)
              setNewName('')
            }}
          >
            取消
          </Button>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(true)
              setError('')
            }}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="plus" size={12} />
              新建分类
            </span>
          </Button>
        </div>
      )}

      {error && <p className="text-label text-danger">{error}</p>}
      {notice && <p className="text-label text-text-secondary">{notice}</p>}

      {deleteTarget && (
        <Dialog open onClose={() => setDeleteTarget(null)}>
          <div className="w-88 p-4 flex flex-col gap-3">
            <h3 className="text-body font-medium text-text-primary">
              删除分类「{deleteTarget.name}」？
            </h3>
            <p className="text-label text-text-secondary leading-relaxed">
              关联的 <span className="text-accent font-medium">{countOf(deleteTarget.id)}</span> 条事项将移除该分类标签。
            </p>
            <div className="flex justify-end gap-2 mt-1">
              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button size="sm" onClick={() => void doDelete(deleteTarget)}>
                删除
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Section>
  )
}
