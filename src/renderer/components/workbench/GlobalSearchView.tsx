import React, { useEffect, useMemo, useState } from 'react'
import { invoke } from '../../lib/ipc-client'
import { STATUS_META } from '../../lib/constants'
import type { TodoStatus } from '../../types/enums'
import type { ProjectSearchResult, ProjectSearchSource } from '../../types/project'
import { useProjectStore } from '../../stores/project.store'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { TodoStatusPill } from '../ui/Badge'
import { Icon } from '../ui/Icon'
import { stripMarkdown } from '../../lib/markdown'
import { cn } from '../../lib/utils'

const SOURCE_LABEL: Record<ProjectSearchSource, string> = {
  handoff_markdown: '接手说明',
  todo_title: '事项标题',
  todo_description: '事项描述',
  comment: '评论'
}

interface GlobalSearchViewProps {
  onOpenTodo: (result: ProjectSearchResult) => void
  /**
   * 打开项目（卡 c9dfbc87）。第二参只对「命中接手说明」的那一条有意义：
   * 一份说明在结果里只有**一行**，点进去若不带上关键词，就只剩"打开项目概览"，
   * 命中在哪一段、甚至还在不在，都得自己再找一遍。
   */
  onOpenProject: (projectId: string, handoffQuery?: string) => void
  /** 从别处带来的关键词：挂载时自动搜索一次，用户不必重打。 */
  initialQuery?: string
  /** 预选的项目范围；空数组 = 全部项目。 */
  initialProjectIds?: string[]
}

/** 跨项目关键词搜索：结果来自同一条 project:searchAll 仓储路径，并显示明确来源。 */
export const GlobalSearchView: React.FC<GlobalSearchViewProps> = ({ onOpenTodo, onOpenProject, initialQuery = '', initialProjectIds = [] }) => {
  const projects = useProjectStore((state) => state.projects)
  const [query, setQuery] = useState(initialQuery)
  const [projectIds, setProjectIds] = useState<string[]>(initialProjectIds)
  const [status, setStatus] = useState<TodoStatus | ''>('')
  const [results, setResults] = useState<ProjectSearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 产出这批结果的关键词。**不能拿输入框里的 query 顶替**：用户改了输入框却还没按
   * 搜索时，屏幕上这批结果仍是上一次那个词搜出来的，点开却按新词定位 —— 那就成了
   * "跳到别的地方"，而不是"定位到刚看到的这处命中"。
   */
  const [searchedTerm, setSearchedTerm] = useState('')

  const visibleResults = useMemo(
    () => (status ? (results ?? []).filter((result) => result.todoStatus === status) : results ?? []),
    [results, status]
  )

  const runSearch = async (raw: string, ids: string[]) => {
    const term = raw.trim()
    if (!term) {
      setResults(null)
      setError('请输入关键词；空查询不会返回全量数据')
      return
    }
    setLoading(true)
    setError(null)
    setSearchedTerm(term)
    try {
      setResults(await invoke('project:searchAll', { query: term, ...(ids.length ? { projectIds: ids } : {}) }))
    } catch (err) {
      setResults(null)
      setError(err instanceof Error ? err.message : '全局搜索失败')
    } finally {
      setLoading(false)
    }
  }

  const search = (event: React.FormEvent) => {
    event.preventDefault()
    void runSearch(query, projectIds)
  }

  useEffect(() => {
    if (initialQuery.trim()) void runSearch(initialQuery, initialProjectIds)
    // 仅挂载时执行：关键词由入口带入，之后由用户自己控制
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )

  const toggleProject = (id: string) => {
    setProjectIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-4xl mx-auto flex flex-col gap-4">
        <form onSubmit={search} className="rounded-card border border-border bg-bg-card p-5 shadow-sm flex flex-col gap-3.5">
          <div className="flex flex-wrap gap-2.5 items-center">
            <div className="relative min-w-56 flex-1">
              <Icon
                name="search"
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="跨项目搜索接手说明、事项标题、描述与评论…"
                aria-label="全局搜索关键词"
                className="w-full h-8 pl-8 pr-3 rounded-button border border-border bg-surface-subtle text-content text-text-primary outline-none focus:bg-bg-card focus:border-accent transition-colors"
              />
            </div>
            <Select
              value={status}
              ariaLabel="按事项状态筛选"
              options={[
                { value: '', label: '全部状态' },
                ...(Object.keys(STATUS_META) as TodoStatus[]).map((key) => ({
                  value: key,
                  label: STATUS_META[key].label,
                  color: `var(${STATUS_META[key].colorVar})`
                }))
              ]}
              onChange={(val) => setStatus(val as TodoStatus | '')}
            />
            <Button type="submit" variant="primary" size="md" disabled={loading}>
              {loading ? '搜索中…' : '搜索'}
            </Button>
          </div>

          <div className="flex items-start gap-2.5 pt-2 border-t border-border/60" aria-label="全局搜索项目多选">
            <span className="text-caption font-medium text-text-secondary shrink-0 pt-1">
              项目范围
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setProjectIds([])}
                aria-pressed={projectIds.length === 0}
                className={cn(
                  'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                  projectIds.length === 0
                    ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-sm'
                    : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-surface-subtle'
                )}
              >
                全部项目
              </button>
              {activeProjects.map((project) => {
                const selected = projectIds.includes(project.id)
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    aria-pressed={selected}
                    className={cn(
                      'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                      selected
                        ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-sm'
                        : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-surface-subtle'
                    )}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    {project.name}
                  </button>
                )
              })}
            </div>
          </div>
          {error && <p className="text-label text-danger">{error}</p>}
        </form>

        {results === null ? (
          <div className="rounded-card border border-dashed border-border bg-bg-card/50 p-8 text-center text-label text-text-secondary">
            输入关键词后按回车或点击「搜索」，可跨项目查找接手说明、事项标题、描述与评论记录。
          </div>
        ) : visibleResults.length === 0 ? (
          <div className="rounded-card border border-border bg-bg-card p-8 text-center text-label text-text-secondary">
            没有找到匹配记录。{status ? '试试切换为「全部状态」。' : ''}
          </div>
        ) : (
          <section className="flex flex-col gap-2" aria-live="polite">
            <div className="text-caption font-mono text-text-secondary px-0.5">
              显示 {visibleResults.length} / {results.length} 处命中
            </div>
            {visibleResults.map((result, index) => (
              <button
                key={`${result.projectId}:${result.source}:${result.commentId ?? result.todoId ?? 'handoff'}:${index}`}
                type="button"
                onClick={() => {
                  if (result.todoId) {
                    onOpenTodo(result)
                    return
                  }
                  if (!result.projectId) return
                  // 接手说明的命中：关键词跟着一起走，概览页才知道要选中哪一段（卡 c9dfbc87）
                  onOpenProject(result.projectId, result.source === 'handoff_markdown' ? searchedTerm : undefined)
                }}
                className="w-full rounded-card border border-border bg-bg-card px-4 py-3 text-left hover:border-accent/50 hover:bg-surface-subtle transition-colors cursor-pointer shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-tag bg-surface-subtle border border-border/70 text-caption font-medium text-text-primary">
                    {SOURCE_LABEL[result.source]}
                  </span>
                  <span className="text-caption font-medium text-text-secondary">
                    {result.projectName ?? '未知项目'}
                  </span>
                  {result.todoTitle && (
                    <span className="min-w-0 flex-1 truncate font-normal text-content text-text-primary">
                      {result.todoTitle}
                    </span>
                  )}
                  {result.todoStatus && (
                    <TodoStatusPill status={result.todoStatus} />
                  )}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-label leading-relaxed text-text-secondary line-clamp-3">
                  {stripMarkdown(result.snippet)}
                </p>
                {result.source === 'comment' && (
                  <p className="mt-1 text-caption text-text-secondary/70">
                    {result.author ?? '未知作者'} · {result.createdAt ? new Date(result.createdAt).toLocaleString() : '时间未记录'} · 点击定位原评论
                  </p>
                )}
                {result.source === 'handoff_markdown' && (
                  <p className="mt-1 text-caption text-text-secondary/70">
                    点击打开项目概览的接手说明，并选中「{searchedTerm}」所在的那一段
                  </p>
                )}
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}
