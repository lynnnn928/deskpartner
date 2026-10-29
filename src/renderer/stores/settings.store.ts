import { create } from 'zustand'
import type { AppSettings } from '../types/settings'
import { invoke, on } from '../lib/ipc-client'
import {
  DEFAULT_BG_OPACITY,
  DEFAULT_FLOAT_BALL,
  DEFAULT_KANBAN,
  DEFAULT_QUICK_ADD,
  DEFAULT_TELEMETRY
} from '../lib/constants'

const defaultSettings: AppSettings = {
  theme: 'light',
  stylePreset: 'frosted',
  floatBallSize: DEFAULT_FLOAT_BALL.size,
  floatBallOpacity: DEFAULT_FLOAT_BALL.opacity,
  floatBallColor: null,
  floatBallEdgeHide: DEFAULT_FLOAT_BALL.edgeHide,
  floatBallShowIcon: DEFAULT_FLOAT_BALL.showIcon,
  floatBallShowGlow: DEFAULT_FLOAT_BALL.showGlow,
  floatBallPosition: null,
  // null = 跟随风格预设（1.0.59）；默认不写行内，避免"两条来源"
  bgOpacityOverride: DEFAULT_BG_OPACITY.override,
  kanbanAlwaysOnTop: DEFAULT_KANBAN.alwaysOnTop,
  kanbanWindowBounds: null,
  kanbanBorderRadius: DEFAULT_KANBAN.borderRadius,
  kanbanColumnHeaderHeight: DEFAULT_KANBAN.columnHeaderHeight,
  cardBorderRadius: DEFAULT_KANBAN.cardBorderRadius,
  cardSpacing: DEFAULT_KANBAN.cardSpacing,
  cardActionsAlwaysVisible: DEFAULT_KANBAN.cardActionsAlwaysVisible,
  quickAddBorderRadius: DEFAULT_QUICK_ADD.borderRadius,
  quickAddPadding: DEFAULT_QUICK_ADD.padding,
  fontSizeScale: 'normal',
  autoStart: false,
  autoCheckUpdate: true,
  globalShortcut: null,
  telemetryEnabled: DEFAULT_TELEMETRY.enabled,
  customColors: {},
  humanName: '',
  humanNameAsked: false,
  /** 1.0.64：首次见面引导只看一次（入口常驻用户页，不需要反复弹） */
  welcomeShown: false,
  appName: '',
  appIcon: null,
  lastSkillExportedVersion: null,
  lastSkillExportedAt: null
}

interface SettingsState {
  settings: AppSettings
  loading: boolean
  /** 最近一次设置变更的副作用告警（如全局快捷键被占用），下次成功变更时自动清空 */
  warning: string | null

  fetchSettings: () => Promise<void>
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>
  resetVisual: () => Promise<void>
  clearWarning: () => void
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  settings: defaultSettings,
  loading: false,
  warning: null,

  fetchSettings: async () => {
    set({ loading: true })
    try {
      const settings = await invoke('settings:get')
      set({ settings, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  updateSettings: async (partial) => {
    const result = await invoke('settings:update', partial)
    set({ settings: result.settings, warning: result.warning ?? null })
  },

  resetVisual: async () => {
    const updated = await invoke('settings:resetVisual')
    set({ settings: updated, warning: null })
  },

  clearWarning: () => set({ warning: null })
}))

// 监听设置变更
if (typeof window !== 'undefined' && window.api) {
  on('event:dataChanged', (data) => {
    if (data.type === 'settings') {
      useSettingsStore.getState().fetchSettings()
    }
  })
}
