import React, { useState } from 'react'
import { PresetSection } from './sections/PresetSection'
import { ColorSection } from './sections/ColorSection'
import { TypographySection } from './sections/TypographySection'
import { FloatBallSection } from './sections/FloatBallSection'
import { KanbanSection } from './sections/KanbanSection'
import { QuickAddSection } from './sections/QuickAddSection'
import { CategorySection } from './sections/CategorySection'
import { TelemetrySection } from './sections/TelemetrySection'
import { BackupSection } from './sections/BackupSection'
import { SystemSection } from './sections/SystemSection'
import { useSettingsStore } from '../../stores/settings.store'
import { Group } from './Section'
import { cn } from '../../lib/utils'

/**
 * 设置页（1.0.48 收敛为三组 tabs）
 *
 * 职责线：**统计页看数据（只读），设置页管数据（开关与危险操作）**。
 * 身份相关（我的名字/谁能写入）在用户页；接入说明作为一次性接入动作收进系统设置。
 * 设置不处理审批，只提供应用配置与复制接入说明的工具。
 *
 * 三组按「你在管什么」切：
 * - 外观：看得见的颜色、字号、三个界面元素的参数
 * - 数据管理：分类标签、备份导出导入、使用数据记录与清空
 * - 系统：自启、快捷键、版本与数据位置
 */
const TABS = [
  { key: 'appearance', label: '外观' },
  { key: 'data', label: '数据管理' },
  { key: 'system', label: '系统' }
] as const
type TabKey = (typeof TABS)[number]['key']

export const SettingsView: React.FC = () => {
  const { resetVisual } = useSettingsStore()
  const [tab, setTab] = useState<TabKey>('appearance')

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full px-6 py-5 flex flex-col gap-4">
        {/* 顶栏：分段页签 + 快捷操作（窗口顶栏已显示「设置」，此处不再重复印可见大标题） */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border">
          <h1 className="sr-only">设置</h1>
          <div
            role="tablist"
            aria-label="设置分类"
            className="inline-flex items-center gap-1 rounded-button bg-surface-subtle p-1 border border-border/70"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'px-3 py-1 rounded-xs text-label transition-colors cursor-pointer',
                  tab === t.key
                    ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'appearance' && (
            <button
              type="button"
              onClick={resetVisual}
              title="将悬浮球、看板、事项、速记弹窗、字号动画与全部自定义颜色恢复为出厂默认；系统设置（开机自启、全局快捷键）不受影响"
              className="px-2.5 py-1 rounded-button border border-border bg-bg-card text-label text-text-secondary hover:text-danger hover:border-danger/40 transition-colors cursor-pointer"
            >
              还原默认外观
            </button>
          )}
        </div>

        {tab === 'appearance' && (
          <div className="flex flex-col gap-4">
            {/*
              外观 tab 的层级（1.0.59）：
              一级 = 预设 / 颜色 / 排版 / 悬浮球 / 卡片与弹窗
              二级 = 颜色下的「品牌色 / 界面 / 文字」、卡片与弹窗下的「看板与卡片 / 速记弹窗」
              此前 8 个标题全是同一副 h3，界面上是一列平铺，扫读找不到想改的项。
            */}
            <PresetSection />
            <Group title="颜色" desc="改动后立即生效；单项可还原为预设色">
              <ColorSection />
            </Group>
            <TypographySection />
            <FloatBallSection />
            <Group title="事项与弹窗">
              <KanbanSection />
              <QuickAddSection />
            </Group>
          </div>
        )}

        {tab === 'data' && (
          <div className="flex flex-col gap-4">
            <CategorySection />
            <BackupSection />
            <TelemetrySection />
          </div>
        )}

        {tab === 'system' && (
          <div className="flex flex-col gap-4">
            <SystemSection />
          </div>
        )}
      </div>
    </div>
  )
}
