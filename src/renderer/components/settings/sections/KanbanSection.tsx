import React from 'react'
import { Section, Row, Segmented } from '../Section'
import { Slider } from '../../ui/Slider'
import { Switch } from '../../ui/Switch'
import { useSettingsStore } from '../../../stores/settings.store'
import type { SpacingPreset } from '../../../types/enums'

/** 看板与卡片 */
export const KanbanSection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()

  return (
    <Section title="看板与事项" level={2}>
      <Row label="看板圆角">
        <Slider
          value={settings.kanbanBorderRadius}
          min={14}
          max={28}
          step={1}
          onChange={(v) => updateSettings({ kanbanBorderRadius: v })}
          showValue
        />
      </Row>
      <Row label="列头高度">
        <Segmented
          value={settings.kanbanColumnHeaderHeight}
          options={[
            { value: 'compact', label: '偏小' },
            { value: 'standard', label: '标准' },
            { value: 'spacious', label: '偏高' }
          ]}
          onChange={(v) => updateSettings({ kanbanColumnHeaderHeight: v as SpacingPreset })}
        />
      </Row>
      <Row label="事项圆角">
        <Slider
          value={settings.cardBorderRadius}
          min={8}
          max={20}
          step={1}
          onChange={(v) => updateSettings({ cardBorderRadius: v })}
          showValue
        />
      </Row>
      <Row label="事项间距">
        <Segmented
          value={settings.cardSpacing}
          options={[
            { value: 'compact', label: '紧凑' },
            { value: 'standard', label: '标准' },
            { value: 'spacious', label: '宽松' }
          ]}
          onChange={(v) => updateSettings({ cardSpacing: v as SpacingPreset })}
        />
      </Row>
      <Row label="快捷操作常驻">
        <Switch
          checked={settings.cardActionsAlwaysVisible}
          onChange={(v) => updateSettings({ cardActionsAlwaysVisible: v })}
        />
      </Row>
      <Row label="窗口置顶" hint="看板已打开时即时生效">
        <Switch
          checked={settings.kanbanAlwaysOnTop}
          onChange={(v) => updateSettings({ kanbanAlwaysOnTop: v })}
        />
      </Row>
    </Section>
  )
}
