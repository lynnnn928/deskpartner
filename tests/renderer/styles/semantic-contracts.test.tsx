// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { stripMarkdown } from '../../../src/renderer/lib/markdown'
import { MarkdownContent } from '../../../src/renderer/components/ui/MarkdownContent'
import { TodoStatusPill, TodoPriorityBadge } from '../../../src/renderer/components/ui/Badge'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('三层设计系统：语义角色层与四大交互契约闸门（卡 d930dfb5）', () => {
  it('1. 同物同形契约：我的工作、项目概览、版本关联事项、全局搜索统一使用 <TodoStatusPill>，不再手写同色灰底或纯灰字', () => {
    for (const rel of [
      'src/renderer/components/workbench/WorkbenchView.tsx',
      'src/renderer/components/project/ProjectOverviewView.tsx',
      'src/renderer/components/releases/ReleasesView.tsx',
      'src/renderer/components/workbench/GlobalSearchView.tsx'
    ]) {
      const src = stripComments(read(rel))
      expect(src, `${rel} 必须使用统一的 <TodoStatusPill>`).toContain('<TodoStatusPill')
    }

    const workbench = stripComments(read('src/renderer/components/workbench/WorkbenchView.tsx'))
    expect(workbench, '我的工作不得再用把待确认/待办混成同一 neutral 灰底的 STATUS_TONE').not.toContain('STATUS_TONE')
    expect(workbench, '我的工作优先级必须使用统一的 <TodoPriorityBadge>').toContain('<TodoPriorityBadge')

    const { container } = render(
      <>
        <TodoStatusPill status="proposed" />
        <TodoStatusPill status="todo" />
        <TodoPriorityBadge priority="urgent" />
      </>
    )
    expect(screen.getByText('待确认')).toBeTruthy()
    expect(screen.getByText('待办')).toBeTruthy()
    expect(screen.getByText('紧急')).toBeTruthy()
    const dots = container.querySelectorAll('span[style*="background-color"]')
    expect(dots.length).toBe(3)
  })

  it('2. 读写分离契约：详情抽屉与项目概览接入 <MarkdownContent> 阅读视图，通知/动态/搜索摘要经 stripMarkdown 清洗源码符号', () => {
    expect(stripComments(read('src/renderer/components/quick-add/QuickAddForm.tsx'))).toContain(
      '<MarkdownContent'
    )
    expect(stripComments(read('src/renderer/components/project/ProjectOverviewView.tsx'))).toContain(
      '<MarkdownContent'
    )
    for (const rel of [
      'src/renderer/components/notification/NotificationsView.tsx',
      'src/renderer/components/timeline/TimelineView.tsx',
      'src/renderer/components/workbench/GlobalSearchView.tsx'
    ]) {
      expect(stripComments(read(rel)), `${rel} 摘要预览必须调用 stripMarkdown`).toContain(
        'stripMarkdown('
      )
    }

    expect(
      stripMarkdown('## 一、筛选器\n存量 **40 多个组件** 仅覆盖 `935ea1e9` <!-- 注释 -->')
    ).toBe('一、筛选器 存量 40 多个组件 仅覆盖 935ea1e9')

    render(
      <MarkdownContent
        content={'# 标题一\n- [x] 已完成项\n- 普通项含 **加粗** 与 `code`'}
      />
    )
    expect(screen.getByText('标题一')).toBeTruthy()
    expect(screen.getByText('已完成项')).toBeTruthy()
    expect(screen.getByText('加粗').tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
  })

  it('3. 行动即达与状态机契约：审批历史失败行直接露出二次确认按钮；从项目动态切回「我的工作」重置 boardView 防空白', () => {
    const approval = stripComments(read('src/renderer/components/approval/ApprovalView.tsx'))
    expect(approval).toContain('const needsRowForceConfirm =')
    expect(approval).toContain('{needsRowForceConfirm && (')

    // 模拟先在项目动态页将 boardView 设为 timeline，再点击「我的工作」或切换到另一个项目
    useUIStore.setState({ workspaceMode: 'project', boardView: 'timeline' })
    useUIStore.getState().enterWorkbench()
    expect(useUIStore.getState().workspaceMode).toBe('workbench')
    expect(useUIStore.getState().boardView).toBe('kanban')

    useUIStore.setState({ workspaceMode: 'project', filterProject: 'p1', boardView: 'timeline' })
    useUIStore.getState().enterProject('p2')
    expect(useUIStore.getState().filterProject).toBe('p2')
    expect(useUIStore.getState().boardView).toBe('kanban')
  })

  it('4. 心智模型隔离契约：用户页协作规则与系统内置规则不再向界面文本节点渲染裸 rule.key / gate.id（G1~G10）', () => {
    const userView = stripComments(read('src/renderer/components/user/UserView.tsx'))
    expect(userView).not.toContain('>{rule.key}<')
    expect(userView).not.toContain('>{gate.id}<')
    expect(userView).toContain('HUMAN_GATE_COPY')
    expect(userView).toContain("invoke('protocol:revisions'")
  })

  it('5. 卡片三段式布局、Agent 团队三列权限条、快速上手并列三步与系统设置去重（1.0.123 / 走查修复收口）', () => {
    const todoCard = stripComments(read('src/renderer/components/kanban/TodoCard.tsx'))
    expect(todoCard).toContain('#{shortId(todo.id)}')

    const roster = stripComments(read('src/renderer/components/user/AgentRosterSection.tsx'))
    expect(roster).toContain('humanizeWriteCmd(')
    expect(roster).toContain('whitespace-nowrap')

    const settingsView = stripComments(read('src/renderer/components/settings/SettingsView.tsx'))
    expect(settingsView, '设置页系统 Tab 不再重复挂载 AgentAccessSection').not.toContain('<AgentAccessSection')

    const systemSection = stripComments(read('src/renderer/components/settings/sections/SystemSection.tsx'))
    expect(systemSection).toContain('label="数据存储目录"')
    expect(systemSection).toContain('打开目录')
    expect(systemSection).toContain('变更目录')
    expect(systemSection).not.toContain('DESKPARTNER_DATA_DIR')
    expect(systemSection, '设置页系统分区不再重复放置快速上手入口').not.toContain('label="快速上手"')

    const accessSection = stripComments(read('src/renderer/components/settings/sections/AgentAccessSection.tsx'))
    expect(accessSection).toContain('前往快速上手')
    expect(accessSection).not.toContain('查看源码')
    expect(accessSection).not.toContain('max-h-96')

    const overview = stripComments(read('src/renderer/components/project/ProjectOverviewView.tsx'))
    expect(overview).toContain('今日工作动态')
    expect(overview).toContain('近 7 天工作动态')
    expect(overview).toContain('编辑项目')
    expect(overview).toContain('项目规则与协议')

    const quickstart = stripComments(read('src/renderer/components/onboarding/QuickStartView.tsx'))
    expect(quickstart).toContain('一张图看懂 DeskPartner 如何协同工作')
    expect(quickstart).toContain('三步接入你的 AI 助手')
    expect(quickstart).toContain('访问产品官网')
    expect(quickstart).toContain('查看在线使用手册')
    expect(quickstart, '2~6 章手册已迁到官网，客户端不再有左侧二级章节栏').not.toContain('帮助与产品手册目录')

    const stats = stripComments(read('src/renderer/components/stats/StatsView.tsx'))
    expect(stats).toContain('周期吞吐量')
    expect(stats).toContain('中位交付周期')
    expect(stats).toContain('存量状态结构分布')
    expect(stats).toContain('effectiveExecutor(')
  })
})
