import React, { useEffect } from 'react'
import FloatBall from './windows/FloatBall'
import Panel from './windows/Panel'
import QuickAdd from './windows/QuickAdd'
import Kanban from './windows/Kanban'
import Onboarding from './windows/Onboarding'
import Welcome from './windows/Welcome'
import ReminderBanner from './windows/ReminderBanner'
import { useTheme } from './hooks/useTheme'
import { useTodoStore } from './stores/todo.store'
import { useCategoryStore } from './stores/category.store'
import { useProjectStore } from './stores/project.store'
import { useAgentStore } from './stores/agent.store'
import { useSettingsStore } from './stores/settings.store'

/** 根据 URL hash 路由到不同窗口页面 */
const WindowRouter: React.FC = () => {
  // hash 格式: #/float-ball, #/quick-add?todoId=xxx, #/kanban, #/settings
  // slice(1) 去掉 # 得到 /quick-add?todoId=xxx，再去掉前导 / 和 query string
  const fullPath = window.location.hash.slice(1).replace(/^\//, '') || 'float-ball'
  const route = fullPath.split('?')[0]

  switch (route) {
    case 'float-ball':
      return <FloatBall />
    case 'panel':
      return <Panel />
    case 'quick-add':
      return <QuickAdd />
    case 'kanban':
      return <Kanban />
    /** 1.0.48：设置/统计独立窗口退役，收编为主窗口内容区视图（#/kanban?view=…） */
    /** 首次启动引导：只出现一次，问人的名字 */
    case 'onboarding':
      return <Onboarding />
    /** 首次见面引导（1.0.64）：只出现一次，讲"怎么把 AI 接进来" */
    case 'welcome':
      return <Welcome />
    /** 顶部提醒横幅：待办提醒从屏幕上方弹出（红底警示），替代系统通知 */
    case 'reminder-banner':
      return <ReminderBanner />
    default:
      return <FloatBall />
  }
}

const App: React.FC = () => {
  // 初始化全局 hooks（主题、数据加载）
  useTheme()

  const fetchTodos = useTodoStore((s) => s.fetchTodos)
  const fetchCategories = useCategoryStore((s) => s.fetchCategories)
  const fetchProjects = useProjectStore((s) => s.fetchProjects)
  const fetchSettings = useSettingsStore((s) => s.fetchSettings)
  // agent 名单是显示名的权威来源（1.0.65 修 4050942e）：漏拉不会报错，
  // 只是全站退回那张兜底表 —— 于是同一个 agent 又出现两个名字。
  const fetchAgents = useAgentStore((s) => s.fetchAgents)

  // 项目必须一起拉：卡片的项目色带、表单里的项目选择器都读这个 store。
  // 漏掉它不会报错，只是"项目永远为空"——静默的功能缺失最难查。
  useEffect(() => {
    fetchTodos()
    fetchCategories()
    fetchProjects()
    fetchSettings()
    fetchAgents()
  }, [fetchTodos, fetchCategories, fetchProjects, fetchSettings, fetchAgents])

  return <WindowRouter />
}

export default App
