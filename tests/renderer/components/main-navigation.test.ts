import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const kanban = read('src/renderer/windows/Kanban.tsx')
const sidebar = read('src/renderer/components/kanban/Sidebar.tsx')
const navMatch = kanban.match(/<nav aria-label="主导航"[\s\S]*?<\/nav>/)

describe('主导航与项目空间信息架构', () => {
  it('项目内保留概览、事项、动态、版本四个入口，不再提供独立接手弹窗入口', () => {
    expect(navMatch).not.toBeNull()
    const nav = navMatch?.[0] ?? ''
    for (const label of ['概览', '事项', '动态', '版本', '全局搜索']) expect(nav).toContain(label)
    expect(kanban).toContain("import { ProjectOverviewView } from '../components/project/ProjectOverviewView'")
    expect(kanban).not.toContain('ProjectHandoffDialog')
    expect(kanban).not.toContain('项目接手')
    expect(kanban).not.toContain('projectPickerOpen')
    expect(kanban).toContain("<ReleasesView projectId={workspaceMode === 'project' ? filterProject : null} />")
  })

  it('顶层只留一个跨项目的「全局搜索」；搜索与筛选/新增/批量属于事项页，在页内范围条上', () => {
    const topbar = kanban.slice(kanban.indexOf('titlebar-no-drag flex items-center gap-1'), kanban.indexOf('<WindowControls />'))
    expect(topbar).toContain('全局搜索')
    expect(topbar).toContain("workspaceMode === 'workbench'")
    expect(topbar).not.toContain('搜索与筛选')
    expect(topbar).not.toContain('+ 新增')
    expect(topbar).not.toContain('批量')
    const scopeBar = kanban.slice(kanban.indexOf('aria-label="项目内容范围"'), kanban.indexOf('{showItemTools && panelOpen && ('))
    expect(scopeBar).toContain('{showItemTools && (')
    expect(scopeBar).toContain('搜索与筛选')
    expect(scopeBar).toContain('+ 新增')
    expect(scopeBar).toContain('批量')
    expect(sidebar).not.toContain('ProjectHandoffDialog')
    expect(sidebar).not.toContain('接手说明与项目搜索')
    expect(kanban).not.toContain('title="筛选"')
    expect(kanban).not.toContain('aria-label="搜索"')
  })

  it('项目概览不显示事项范围、项目筛选和通用事项工具栏', () => {
    expect(kanban).toContain("const showItemTools = showProjectTab && projectTab === 'items'")
    expect(kanban).toContain("inBoard && workspaceMode === 'all'")
    expect(kanban).not.toContain("workspaceMode === 'all' && projectTab")
    expect(kanban).toContain('{showProjectScope && (')
    expect(kanban).toContain('{showItemTools && panelOpen && (')
    expect(kanban).toContain('{showItemTools && <ChipsBar visibleCount={boardVisibleCount} />}')
    expect(kanban).toContain('{showItemTools && <BatchBar />}')
  })

  it('项目概览直接编辑接手说明、查看修订历史；搜索不再挤在概览里', () => {
    const overview = read('src/renderer/components/project/ProjectOverviewView.tsx')
    expect(overview).toContain('项目接手说明')
    expect(overview).toContain('接手说明已保存')
    expect(overview).toContain('<HandoffRevisionsDrawer')
    expect(overview).not.toContain('searchOnly')
    expect(overview).not.toContain('project:search')
    expect(overview).toContain('查看版本记录')
    expect(overview).not.toContain('接手说明与搜索')
  })

  it('项目内「全局搜索」页签复用跨项目搜索，可预选项目并带入关键词', () => {
    expect(kanban).toContain("['search', '全局搜索', 'search']")
    expect(kanban).toMatch(/projectTab === 'search' && selectedProject && \(\s*<GlobalSearchView/)
    expect(kanban).toContain('initialProjectIds={projectSearchIds}')
    expect(kanban).toContain('setProjectSearchIds(filterProject ? [filterProject] : [])')
    const search = read('src/renderer/components/workbench/GlobalSearchView.tsx')
    expect(search).toContain('initialQuery')
    expect(search).toContain('initialProjectIds')
    expect(search).toContain("invoke('project:searchAll'")
  })

  it('项目概览版本摘要进入版本记录，而不是事项列表', () => {
    const overview = read('src/renderer/components/project/ProjectOverviewView.tsx')
    expect(overview).toContain('onOpenVersions')
    expect(overview).toContain('查看版本记录')
    expect(overview).not.toContain('查看项目事项')
  })

  it('项目版本跳转显式进入对应项目并展示所有状态的关联事项', () => {
    const releases = read('src/renderer/components/releases/ReleasesView.tsx')
    expect(releases).toContain('enterProject(detail.projectId)')
    expect(releases).toContain('viewItemsInBoard')
    expect(releases).toContain("setWorkItemScope('all')")
    expect(releases).toContain('setFilterFixedIn(detail.version)')
    expect(releases).not.toContain('setFilterProject(detail.projectId)')
  })

  it('项目事项的版本筛选只列当前项目的版本', () => {
    const search = read('src/renderer/components/kanban/SearchBar.tsx')
    expect(search).toContain('collectFixedVersions(workspaceMode === \'project\' && filterProject ? todos.filter')
  })

  it('侧栏方案 B：工作台含我的工作/通知/审批/统计，项目独立分组，设置在底部用户区', () => {
    expect(sidebar).toContain('<NavSection label="工作台">')
    expect(sidebar).toContain('<NavSection label="项目">')
    expect(sidebar).not.toContain('<NavSection label="系统">')
    expect(sidebar).toContain('我的工作')
    expect(sidebar).toContain('通知')
    expect(sidebar).toContain('审批')
    expect(sidebar).toContain('统计')
    // 设置以独立 ⚙ 按钮常驻底部用户区，不再占工作台/系统组
    expect(sidebar).toContain('title="设置"')
    expect(sidebar).toContain("nav('settings')")
    expect(sidebar).not.toContain('smartView')
    expect(sidebar).not.toContain('workspaceView')
    expect(sidebar).not.toContain('已完成')
    expect(sidebar).not.toContain('已挂起')
    expect(sidebar).not.toContain('已废弃')
    expect(sidebar).not.toContain('全量事项')
  })

  it('进入项目和返回工作台都是明确的导航动作', () => {
    expect(sidebar).toContain('onClick={() => enterProject(project.id)}')
    expect(sidebar).toContain('onClick={enterWorkbench}')
    expect(sidebar).toContain("workspaceMode === 'project' && filterProject === project.id")
  })

  it('我的工作只在工作台显示用户或 Agent 视角切换', () => {
    expect(kanban).toContain("workspaceMode === 'workbench'")
    expect(kanban).toContain('<ViewScopeSwitcher />')
    expect(sidebar).toContain('我的工作')
  })

  it('我的工作使用独立行动汇总，不复用项目看板', () => {
    expect(kanban).toContain("import { WorkbenchView } from '../components/workbench/WorkbenchView'")
    expect(kanban).toContain("workspaceMode === 'workbench' && boardView === 'kanban' && <WorkbenchView />")
  })

  it('项目动态与项目通知有不同的视觉和语义提示', () => {
    const notifications = read('src/renderer/components/notification/NotificationsView.tsx')
    expect(kanban).toContain('时间线：记录项目发生过什么。')
    expect(kanban).toContain('收件箱：查看需要你知道或处理的项目消息。')
    expect(notifications).toContain('project-notification-inbox')
    expect(notifications).toContain('notification-row-unread')
  })

  it('版本删除用自定义对话框：列出关联事项并提供解除/查看出口，不再用原生 confirm', () => {
    const releases = read('src/renderer/components/releases/ReleasesView.tsx')
    const dialog = read('src/renderer/components/releases/ReleaseDeleteDialog.tsx')
    expect(releases).not.toContain('window.confirm')
    expect(releases).toContain('<ReleaseDeleteDialog')
    expect(releases).toContain('friendlyReleaseDeleteError')
    expect(dialog).toContain('暂时不能删除版本')
    expect(dialog).toContain('解除标记')
    expect(dialog).toContain('全部解除标记')
    expect(dialog).toContain('在事项页查看')
  })

  it('新建项目对话框的接手说明够大且可调整高度', () => {
    expect(sidebar).toContain('rows={14}')
    expect(sidebar).toContain('resize-y')
    // 1.0.114（卡 2f6f8082）：`min-h-[240px]` / `max-w-[720px]` 已收进令牌，判据不变 ——
    // 文本域仍有 240px 的起手高度、对话框仍限宽 720（且自带 92vw 夹）
    expect(sidebar).toContain('min-h-60')
    expect(sidebar).toContain('max-w-dialog-lg')
  })
})
