// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PanelContent } from '../../../src/renderer/components/panel/PanelContent'
import { WorkbenchView } from '../../../src/renderer/components/workbench/WorkbenchView'
import { SystemSection } from '../../../src/renderer/components/settings/sections/SystemSection'
import { Sidebar } from '../../../src/renderer/components/kanban/Sidebar'
import { FloatBallCore } from '../../../src/renderer/components/float-ball/FloatBallCore'
import { AgentAccessSection } from '../../../src/renderer/components/settings/sections/AgentAccessSection'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import { useTodoStore } from '../../../src/renderer/stores/todo.store'
import { useProjectStore } from '../../../src/renderer/stores/project.store'
import { useCategoryStore } from '../../../src/renderer/stores/category.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'
import {
  initializeDatabase,
  closeDatabase,
  setActiveDataDir,
  getDataDirPath,
  migrateDataDirectory,
  readConfiguredDataDir
} from '../../../src/main/database/index'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

describe('主用户 4 项反馈改进回归验证（卡 4f98a045）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
    useCategoryStore.setState({
      categories: [{ id: 'cat-1', name: '日常', color: '#5388F6', sortOrder: 0, createdAt: '2026-10-01T00:00:00.000Z' }]
    })
    useProjectStore.setState({
      projects: [
        { id: 'proj-active', name: 'DeskPartner', color: '#5388F6', archived: false, sortOrder: 0, createdAt: '2026-10-01T00:00:00.000Z', handoffMarkdown: '' },
        { id: 'proj-second', name: 'Alex个人安排', color: '#F59E0B', archived: false, sortOrder: 1, createdAt: '2026-10-01T00:00:00.000Z', handoffMarkdown: '' },
        { id: 'proj-archived', name: '已归档测试项目', color: '#10B981', archived: true, sortOrder: 2, createdAt: '2026-10-01T00:00:00.000Z', handoffMarkdown: '' }
      ]
    })
    useTodoStore.setState({
      todos: [
        {
          id: 'todo-active-1',
          title: '正在推进的正常事项',
          description: '',
          status: 'todo',
          priority: 'normal',
          type: 'task',
          categoryIds: ['cat-1'],
          categoryId: 'cat-1',
          projectId: 'proj-active',
          parentId: null,
          createdBy: 'human',
          executedBy: 'human',
          verifier: 'human',
          fixedInVersion: null,
          dueAt: null,
          remindAt: null,
          isPinned: false,
          createdAt: '2026-10-28T00:00:00.000Z',
          updatedAt: '2026-10-28T01:00:00.000Z',
          completedAt: null
        },
        {
          id: 'todo-archived-1',
          title: '归档项目里的旧事项',
          description: '',
          status: 'todo',
          priority: 'normal',
          type: 'task',
          categoryIds: ['cat-1'],
          categoryId: 'cat-1',
          projectId: 'proj-archived',
          parentId: null,
          createdBy: 'human',
          executedBy: 'human',
          verifier: 'human',
          fixedInVersion: null,
          dueAt: null,
          remindAt: null,
          isPinned: false,
          createdAt: '2026-10-28T00:00:00.000Z',
          updatedAt: '2026-10-28T02:00:00.000Z',
          completedAt: null
        }
      ]
    })
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, humanName: 'Alex' }
    }))
  })

  it('1. 悬浮面板快捷登记自动挂靠当前选中项目并支持切换项目，且不显示归档项目的事项', async () => {
    const createTodoSpy = vi.fn().mockResolvedValue({})
    useTodoStore.setState({ createTodo: createTodoSpy })

    const { container, getByPlaceholderText, getByTestId, getByText } = render(<PanelContent />)

    // 归档项目的事项不出现在悬浮面板中
    expect(container.textContent).toContain('1 项事项')
    expect(container.textContent).toContain('正在推进的正常事项')
    expect(container.textContent).not.toContain('归档项目里的旧事项')

    // 默认挂靠第一个未归档项目 DeskPartner，点击可切换到「Alex个人安排」
    const trigger = getByTestId('panel-project-trigger')
    expect(trigger.textContent).toContain('DeskPartner')
    fireEvent.click(trigger)
    fireEvent.click(getByText('Alex个人安排'))
    expect(trigger.textContent).toContain('Alex个人安排')

    const input = getByPlaceholderText('记一件事，回车保存')
    fireEvent.change(input, { target: { value: '买咖啡豆' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(createTodoSpy).toHaveBeenCalledTimes(1))
    expect(createTodoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '买咖啡豆',
        createdBy: 'human',
        projectId: 'proj-second'
      })
    )
  })

  it('2. 归档项目下的事项不再出现在「我的工作」汇总视图中', () => {
    const { container } = render(<WorkbenchView />)
    expect(container.textContent).toContain('DeskPartner')
    expect(container.textContent).toContain('正在推进的正常事项')
    expect(container.textContent).not.toContain('已归档测试项目')
    expect(container.textContent).not.toContain('归档项目里的旧事项')
  })

  it('3. 永久删除项目的弹出确认框包含「归档项目」按钮（侧栏与项目概览两处一致）', () => {
    const root = path.resolve(__dirname, '../../..')
    const sidebarSrc = fs.readFileSync(path.join(root, 'src/renderer/components/kanban/Sidebar.tsx'), 'utf8')
    const overviewSrc = fs.readFileSync(path.join(root, 'src/renderer/components/project/ProjectOverviewView.tsx'), 'utf8')

    const sidebarDialogSlice = sidebarSrc.slice(sidebarSrc.indexOf('永久删除项目「'))
    expect(sidebarDialogSlice).toContain('归档项目')
    expect(sidebarDialogSlice).toContain('永久删除')

    const overviewDialogSlice = overviewSrc.slice(overviewSrc.indexOf('永久删除项目「'))
    expect(overviewDialogSlice).toContain('归档项目')
    expect(overviewDialogSlice).toContain('永久删除')
  })

  it('4. 设置页数据存储目录显示「变更目录」：选择目录期间按钮仅置灰不变字，选定目录后才变为「迁移中…」并完成数据迁移', async () => {
    let resolvePick!: (v: { canceled: boolean; targetDir: string | null }) => void
    let resolveMigrate!: (v: { changed: boolean; dataDir: string; previousDir: string }) => void

    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'app:info') return Promise.resolve({ version: '1.0.126', dataDir: 'C:\\OldDataDir' })
      if (channel === 'app:pickDataDir') {
        return new Promise((r) => {
          resolvePick = r
        })
      }
      if (channel === 'app:changeDataDir') {
        return new Promise((r) => {
          resolveMigrate = r
        })
      }
      return Promise.resolve(null)
    })

    const { container, getByText } = render(<SystemSection />)
    await waitFor(() => expect(container.textContent).toContain('C:\\OldDataDir'))
    expect(container.textContent).not.toContain('复制路径')

    const changeBtn = getByText('变更目录') as HTMLButtonElement
    fireEvent.click(changeBtn)

    // 第一阶段：弹出目录选择框期间，按钮置灰（disabled），但文字仍保持「变更目录」，不提前显示「迁移中…」，且出现模态锁定层阻止其它操作
    await waitFor(() => expect(changeBtn.disabled).toBe(true))
    expect(changeBtn.textContent).toBe('变更目录')
    expect(container.textContent).not.toContain('迁移中…')
    expect(container.querySelector('[data-testid="system-modal-lock"]')).toBeTruthy()

    // 第二阶段：用户确认选择了新目录后，按钮才变成「迁移中…」
    resolvePick({ canceled: false, targetDir: 'D:\\NewDataDir' })
    await waitFor(() => expect(changeBtn.textContent).toBe('迁移中…'))
    expect(changeBtn.disabled).toBe(true)

    // 迁移完成：恢复为可点击的「变更目录」并展示迁移成功提示
    resolveMigrate({ changed: true, dataDir: 'D:\\NewDataDir', previousDir: 'C:\\OldDataDir' })
    await waitFor(() => expect(container.textContent).toContain('D:\\NewDataDir'))
    expect(container.textContent).toContain('已迁移至 D:\\NewDataDir')
    expect(changeBtn.textContent).toBe('变更目录')
    expect(changeBtn.disabled).toBe(false)

    // 真实 SQLite 数据库迁移验证
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-migrate-dir-'))
    const dirA = path.join(tmpBase, 'dir-a')
    const dirB = path.join(tmpBase, 'dir-b')
    const cfgFile = path.join(tmpBase, 'data-dir-config.json')
    fs.mkdirSync(dirA, { recursive: true })
    process.env.DESKPARTNER_DATA_DIR_CONFIG = cfgFile

    try {
      closeDatabase()
      setActiveDataDir(dirA)
      initializeDatabase()
      const projectRepo = new ProjectRepository()
      const created = projectRepo.create({ name: '迁移前创建的项目', handoffMarkdown: '# 说明' })
      fs.writeFileSync(path.join(dirA, 'user.db.v46-backup-test'), 'backup-bytes', 'utf8')

      const res = await migrateDataDirectory(dirB)
      expect(res.changed).toBe(true)
      expect(getDataDirPath()).toBe(path.resolve(dirB))
      expect(readConfiguredDataDir()).toBe(path.resolve(dirB))
      expect(fs.existsSync(path.join(dirB, 'user.db'))).toBe(true)
      expect(fs.existsSync(path.join(dirB, 'user.db.v46-backup-test'))).toBe(true)

      // 切换后直接通过同一个 Repository 读取新目录下的数据库，数据完整保留
      expect(projectRepo.getById(created.id)?.name).toBe('迁移前创建的项目')
    } finally {
      closeDatabase()
      setActiveDataDir(null)
      delete process.env.DESKPARTNER_DATA_DIR_CONFIG
      try {
        fs.rmSync(tmpBase, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('5. 设置页支持修改应用名称与应用图标，实时作用于侧边栏、窗口标题与悬浮球，并可一键恢复默认', async () => {
    const customIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    invokeMock.mockImplementation(async (channel: string, payload?: Record<string, unknown>) => {
      if (channel === 'app:info') return { version: '1.0.126', dataDir: 'C:\\DataDir' }
      if (channel === 'app:pickAppIcon') return { canceled: false, dataUrl: customIcon }
      if (channel === 'settings:update') {
        const next = { ...useSettingsStore.getState().settings, ...payload }
        return { settings: next }
      }
      return []
    })

    const { getByTestId, getByText } = render(<SystemSection />)
    const nameInput = getByTestId('app-name-input') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '主用户工作台' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })

    await waitFor(() => expect(useSettingsStore.getState().settings.appName).toBe('主用户工作台'))

    fireEvent.click(getByText('更换图标'))
    await waitFor(() => expect(useSettingsStore.getState().settings.appIcon).toBe(customIcon))

    // 验证侧边栏与悬浮球实时反映自定义名称与图标
    const sidebar = render(<Sidebar />)
    expect(sidebar.container.textContent).toContain('主用户工作台')
    expect(document.title).toBe('主用户工作台')
    const sidebarIcon = sidebar.getByTestId('sidebar-app-icon') as HTMLImageElement
    expect(sidebarIcon.getAttribute('src')).toBe(customIcon)

    const ball = render(<FloatBallCore onClick={() => {}} onDoubleClick={() => {}} onContextMenu={() => {}} />)
    const ballImg = ball.container.querySelector('img') as HTMLImageElement
    expect(ballImg.getAttribute('src')).toBe(customIcon)

    // 验证 SettingsRepository 持久化与还原
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-branding-'))
    try {
      closeDatabase()
      setActiveDataDir(tmpDir)
      initializeDatabase()
      const settingsRepo = new SettingsRepository()
      expect(settingsRepo.get().appName).toBe('')
      expect(settingsRepo.get().appIcon).toBeNull()

      settingsRepo.update({ appName: '主用户工作台', appIcon: customIcon })
      expect(settingsRepo.get().appName).toBe('主用户工作台')
      expect(settingsRepo.get().appIcon).toBe(customIcon)

      // 还原默认外观不应冲掉系统级的自定义应用名称与图标
      const afterReset = settingsRepo.resetVisual()
      expect(afterReset.appName).toBe('主用户工作台')
      expect(afterReset.appIcon).toBe(customIcon)
    } finally {
      closeDatabase()
      setActiveDataDir(null)
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('6. 接入说明导出版本记录与过期提醒（卡 3559c27d 选项②）及系统弹窗绑定父窗口模态置顶', async () => {
    // 确认主进程 showOpenDialog 传入了 ownerWin，保证弹窗置于主窗口顶层且系统级模态锁定
    const ipcSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/main/ipc.ts'), 'utf8')
    expect(ipcSrc).toContain('dialog.showOpenDialog(ownerWin, dialogOpts)')

    // 模拟此前在 v1.0.120 导出过说明，当前应用已升至 v1.0.128
    useSettingsStore.setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        lastSkillExportedVersion: '1.0.120',
        lastSkillExportedAt: '2026-10-20T08:30:00.000Z'
      }
    }))

    invokeMock.mockImplementation(async (channel: string, payload?: Record<string, unknown>) => {
      if (channel === 'app:info') return { version: '1.0.128', dataDir: 'C:\\DataDir' }
      if (channel === 'cli:agentGuide') return '---\nskill_version: "1.0.128"\n---\n# 接入说明正文'
      if (channel === 'settings:update') {
        const next = { ...useSettingsStore.getState().settings, ...payload }
        return { settings: next }
      }
      return null
    })

    const { getByTestId, queryByTestId } = render(<AgentAccessSection />)
    await waitFor(() => expect(getByTestId('skill-stale-notice')).toBeTruthy())
    expect(getByTestId('skill-stale-notice').textContent).toContain('v1.0.120')
    expect(getByTestId('skill-stale-notice').textContent).toContain('v1.0.128')

    // 当记录版本与当前版本一致时，过期警告消失，转为普通最近导出记录
    useSettingsStore.setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        lastSkillExportedVersion: '1.0.128',
        lastSkillExportedAt: '2026-10-29T04:00:00.000Z'
      }
    }))
    await waitFor(() => expect(queryByTestId('skill-stale-notice')).toBeNull())
    expect(getByTestId('skill-export-record').textContent).toContain('v1.0.128')
  })
})
