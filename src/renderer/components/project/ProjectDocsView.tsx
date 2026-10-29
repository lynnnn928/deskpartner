import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke, on } from '../../lib/ipc-client'
import type { Project, ProjectDocContent, ProjectDocEntry, ProjectDocListResult } from '../../types/project'
import { useProjectStore } from '../../stores/project.store'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { Button } from '../ui/Button'
import { TodoStatusPill } from '../ui/Badge'
import { MarkdownContent } from '../ui/MarkdownContent'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { cn } from '../../lib/utils'

interface ProjectDocsViewProps {
  projectId: string
  onOpenOverview: () => void
}

const HANDOFF_KEY = '__handoff__'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatDate(iso: string): string {
  if (!iso) return ''
  return iso.slice(0, 16).replace('T', ' ')
}

/**
 * 本地 HTML 文档按不可信输入处理（卡 46c7d51d）：
 * 1. 剥离全部 <script> 标签；
 * 2. 注入严格 CSP（禁脚本、禁外链请求、禁插件），仅保留内联/嵌入式 CSS 样式与排版；
 * 3. 配合 <iframe sandbox="">（不给 allow-scripts、不给 allow-same-origin）实现双重隔离。
 */
export function sanitizeHtmlForSandbox(raw: string): string {
  const withoutScripts = String(raw ?? '').replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
  const cspMeta =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:;">'
  if (/<head[^>]*>/i.test(withoutScripts)) {
    return withoutScripts.replace(/<head[^>]*>/i, (match) => `${match}${cspMeta}`)
  }
  return `${cspMeta}${withoutScripts}`
}

/**
 * 项目「文档」页签（方案 C：接手说明留库内，项目可选关联本地 Markdown 文档目录做只读索引与渲染；卡 a3bd40d8 / 095b2006）
 */
export const ProjectDocsView: React.FC<ProjectDocsViewProps> = ({ projectId, onOpenOverview }) => {
  const projects = useProjectStore((s) => s.projects)
  const updateProject = useProjectStore((s) => s.updateProject)
  const fetchProjects = useProjectStore((s) => s.fetchProjects)
  const todos = useTodoStore((s) => s.todos)
  const showToast = useUIStore((s) => s.showToast)

  const project: Project | undefined = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  )

  const [docList, setDocList] = useState<ProjectDocListResult | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string>(HANDOFF_KEY)
  const [docContent, setDocContent] = useState<ProjectDocContent | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const [pickingDir, setPickingDir] = useState(false)

  const loadList = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await invoke('project:listDocs', { id: projectId })
      setDocList(res)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '读取项目文档目录失败')
    } finally {
      setLoadingList(false)
    }
  }, [projectId, showToast])

  useEffect(() => {
    setSelectedKey(HANDOFF_KEY)
    setDocContent(null)
    setFilterQuery('')
    void loadList()
    const unsubscribe = on('event:dataChanged', (ev) => {
      if (ev.type === 'project') void loadList()
    })
    return unsubscribe
  }, [loadList])

  useEffect(() => {
    if (selectedKey === HANDOFF_KEY) {
      setDocContent(null)
      setDocError(null)
      return
    }
    let cancelled = false
    setLoadingDoc(true)
    setDocError(null)
    invoke('project:readDoc', { id: projectId, file: selectedKey })
      .then((res) => {
        if (!cancelled) setDocContent(res)
      })
      .catch((err) => {
        if (!cancelled) {
          setDocContent(null)
          setDocError(err instanceof Error ? err.message : '读取文档失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDoc(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, selectedKey])

  const filteredDocs: ProjectDocEntry[] = useMemo(() => {
    const all = docList?.docs ?? []
    const q = filterQuery.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (d) => d.title.toLowerCase().includes(q) || d.file.toLowerCase().includes(q)
    )
  }, [docList, filterQuery])

  const referencingTodos = useMemo(() => {
    if (selectedKey === HANDOFF_KEY || !docContent) return []
    const fileNorm = docContent.file.toLowerCase()
    const nameNorm = docContent.name.toLowerCase()
    return todos.filter((t) => {
      if (t.projectId !== projectId) return false
      const haystack = `${t.title}\n${t.description ?? ''}`.toLowerCase()
      return haystack.includes(fileNorm) || haystack.includes(nameNorm)
    })
  }, [todos, projectId, selectedKey, docContent])

  const handlePickDocsDir = async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const updated = await invoke('project:pickDocsDir', { id: projectId })
      if (!updated) return
      await fetchProjects()
      await loadList()
      showToast('已关联项目文档目录')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '关联文档目录失败')
    } finally {
      setPickingDir(false)
    }
  }

  const handleUnlinkDocsDir = async (): Promise<void> => {
    try {
      await updateProject({ id: projectId, docsDir: null })
      setSelectedKey(HANDOFF_KEY)
      await loadList()
      showToast('已取消关联本地文档目录')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '取消关联失败')
    }
  }

  const handleOpenExternal = async (file?: string): Promise<void> => {
    try {
      await invoke('project:openDocExternal', { id: projectId, ...(file ? { file } : {}) })
    } catch (err) {
      showToast(err instanceof Error ? err.message : '外部打开失败')
    }
  }

  const handleCopyPath = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制${label}`)
    } catch {
      showToast('复制失败')
    }
  }

  const hasDocsDir = Boolean(docList?.docsDir)
  const dirAvailable = Boolean(docList?.available)

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-primary" data-testid="project-docs-view">
      {pickingDir && (
        <div
          data-testid="project-docs-modal-lock"
          className="fixed inset-0 z-50 bg-black/20 flex items-center justify-center cursor-wait select-none"
        >
          <div className="px-4 py-2.5 rounded-card bg-bg-card border border-border shadow-float text-label text-text-primary font-medium">
            请在弹出的系统窗口中选择文档目录…
          </div>
        </div>
      )}

      {/* 顶部文档目录状态栏 */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 px-6 py-3 border-b border-border bg-bg-card/60">
        <div className="flex items-center gap-2 min-w-0">
          <Icon name="fileText" size={14} className="text-text-secondary shrink-0" />
          <span className="text-label text-text-secondary shrink-0">本地文档目录：</span>
          {hasDocsDir ? (
            <span
              className="text-caption font-mono text-text-primary truncate max-w-xl"
              title={docList?.docsDir ?? ''}
              data-testid="project-docs-dir-path"
            >
              {docList?.docsDir}
            </span>
          ) : (
            <span className="text-label text-text-secondary">
              未关联（接手说明保存在数据库内；关联本地文件夹后可只读索引与阅读项目 Markdown 文档）
            </span>
          )}
          {hasDocsDir && !dirAvailable && (
            <span className="px-2 py-0.5 rounded-tag bg-warning/10 border border-warning/30 text-caption text-warning">
              目录不可访问，请重新选择
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            disabled={pickingDir}
            onClick={() => void handlePickDocsDir()}
            data-testid="project-docs-pick-btn"
          >
            {hasDocsDir ? '更换目录' : '关联文档目录'}
          </Button>
          {hasDocsDir && dirAvailable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleOpenExternal()}
            >
              打开文件夹
            </Button>
          )}
          {hasDocsDir && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadList()}
              >
                刷新
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleUnlinkDocsDir()}
                data-testid="project-docs-unlink-btn"
              >
                取消关联
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 左右分栏：左侧文档清单，右侧阅读区 */}
      <div className="flex-1 min-h-0 flex">
        {/* 左侧栏 */}
        <aside className="w-72 shrink-0 border-r border-border bg-bg-card/40 flex flex-col min-h-0">
          <div className="p-3 border-b border-border/60">
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="筛选文档标题或路径…"
              aria-label="筛选文档标题或路径"
              className="w-full h-8 px-2.5 rounded-input border border-border bg-bg-primary text-label text-text-primary placeholder:text-text-secondary/60 focus:outline-none focus:border-accent"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
            {/* 置顶：库内项目接手说明 */}
            <button
              type="button"
              onClick={() => setSelectedKey(HANDOFF_KEY)}
              data-testid="project-doc-item-handoff"
              className={cn(
                'w-full text-left px-3 py-2 rounded-input transition-colors cursor-pointer flex flex-col gap-1',
                selectedKey === HANDOFF_KEY
                  ? 'bg-accent/10 text-text-primary border border-accent/30'
                  : 'hover:bg-surface-subtle text-text-primary border border-transparent'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-content font-normal text-text-primary truncate">
                  项目接手说明
                </span>
                <span className="px-1.5 py-0.5 rounded-xs bg-surface-muted text-caption text-text-secondary shrink-0">
                  库内
                </span>
              </div>
              <span className="text-caption text-text-secondary truncate">
                随 SQLite 备份与修订历史保存
              </span>
            </button>

            <div className="pt-2 pb-1 px-2 flex items-center justify-between">
              <span className="text-caption text-text-secondary">
                目录文档（{filteredDocs.length}）
              </span>
            </div>

            {loadingList ? (
              <div className="px-3 py-4 text-label text-text-secondary">正在读取目录索引…</div>
            ) : !hasDocsDir ? (
              <div className="px-3 py-4 text-label text-text-secondary">
                点击右上角「关联文档目录」，即可在此浏览项目仓库或资料夹下的 `.md` 与 `.html` 文档（只读，不修改原文件）。
              </div>
            ) : !dirAvailable ? (
              <div className="px-3 py-4 text-label text-warning">
                关联的目录不存在或已移动，请点击「更换目录」重新选择。
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="px-3 py-4 text-label text-text-secondary">
                {filterQuery.trim() ? '没有匹配的文档' : '该目录下暂无 .md 或 .html 文档'}
              </div>
            ) : (
              filteredDocs.map((doc) => (
                <button
                  key={doc.file}
                  type="button"
                  onClick={() => setSelectedKey(doc.file)}
                  data-testid={`project-doc-item-${doc.file}`}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-input transition-colors cursor-pointer flex flex-col gap-0.5',
                    selectedKey === doc.file
                      ? 'bg-accent/10 text-text-primary border border-accent/30'
                      : 'hover:bg-surface-subtle text-text-primary border border-transparent'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-content font-normal text-text-primary truncate">
                      {doc.title}
                    </span>
                    {doc.kind === 'html' && (
                      <span className="px-1.5 py-0.5 rounded-xs bg-surface-muted text-caption text-text-secondary font-mono shrink-0">
                        HTML
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-caption text-text-secondary font-mono">
                    <span className="truncate">{doc.file}</span>
                    <span className="shrink-0">{formatBytes(doc.bytes)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* 右侧阅读区 */}
        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6">
          {selectedKey === HANDOFF_KEY ? (
            <div className="max-w-3xl mx-auto space-y-4">
              <div className="flex items-center justify-between gap-3 pb-3 border-b border-border">
                <div>
                  <h2 className="text-content font-semibold text-text-primary">
                    项目接手说明（库内权威来源）
                  </h2>
                  <p className="text-label text-text-secondary mt-0.5">
                    保存在数据库内，具备修订历史、提议审批与新鲜度检测；CLI 可用 `dp project get` 读取。
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={onOpenOverview}>
                  去概览编辑 / 看修订
                </Button>
              </div>

              {project?.handoffMarkdown?.trim() ? (
                <div className="p-5 rounded-card border border-border bg-bg-card">
                  <MarkdownContent content={project.handoffMarkdown} />
                </div>
              ) : (
                <EmptyState
                  title="暂无接手说明内容"
                  description="可在项目「概览」页编辑保存，或由 Agent 通过 project handoff-propose 提交提议。"
                />
              )}
            </div>
          ) : loadingDoc ? (
            <div className="max-w-3xl mx-auto py-12 text-label text-text-secondary">
              正在读取文档内容…
            </div>
          ) : docError ? (
            <div className="max-w-3xl mx-auto py-12">
              <EmptyState title="无法读取文档" description={docError} />
            </div>
          ) : docContent ? (
            <div className={cn(docContent.kind === 'html' ? 'max-w-5xl' : 'max-w-3xl', 'mx-auto space-y-6')}>
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-border">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-content font-semibold text-text-primary">
                      {docContent.title}
                    </h2>
                    {docContent.kind === 'html' && (
                      <span className="px-1.5 py-0.5 rounded-xs bg-surface-muted text-caption text-text-secondary font-mono shrink-0">
                        HTML 沙箱只读
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-caption text-text-secondary font-mono">
                    <span>{docContent.file}</span>
                    <span>·</span>
                    <span>{formatBytes(docContent.bytes)}</span>
                    <span>·</span>
                    <span>更新于 {formatDate(docContent.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopyPath(docContent.file, '相对路径')}
                  >
                    复制路径
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleOpenExternal(docContent.file)}
                  >
                    系统程序打开
                  </Button>
                </div>
              </div>

              {docContent.kind === 'html' ? (
                <div
                  className="rounded-card border border-border bg-bg-card overflow-hidden"
                  data-testid="project-doc-html-container"
                >
                  <iframe
                    title={docContent.title}
                    sandbox=""
                    srcDoc={sanitizeHtmlForSandbox(docContent.content)}
                    data-testid="project-doc-html-sandbox"
                    className="w-full min-h-screen border-0 bg-white"
                  />
                </div>
              ) : (
                <div
                  className="p-5 rounded-card border border-border bg-bg-card"
                  data-testid="project-doc-markdown-body"
                >
                  <MarkdownContent content={docContent.content} />
                </div>
              )}

              {/* 引用本文档的事项 */}
              <div className="p-4 rounded-card border border-border bg-bg-card/60 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-content font-semibold text-text-primary">
                    引用本文档的事项（{referencingTodos.length}）
                  </span>
                  <span className="text-caption text-text-secondary">
                    在事项描述中写入 `{docContent.file}` 即可自动关联
                  </span>
                </div>
                {referencingTodos.length === 0 ? (
                  <p className="text-label text-text-secondary">
                    当前项目暂无事项提及此文档路径。
                  </p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {referencingTodos.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => void invoke('window:showQuickAdd', { todoId: t.id, projectId })}
                        className="w-full py-2 px-2 text-left hover:bg-surface-subtle rounded-input transition-colors flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-caption text-text-secondary font-mono shrink-0">
                            #{t.id.slice(0, 8)}
                          </span>
                          <span className="text-content font-normal text-text-primary truncate">
                            {t.title}
                          </span>
                        </div>
                        <TodoStatusPill status={t.status} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  )
}
