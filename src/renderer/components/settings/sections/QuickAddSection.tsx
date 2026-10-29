import React from 'react'
import { Section, Row, Segmented } from '../Section'
import { Slider } from '../../ui/Slider'
import { useSettingsStore } from '../../../stores/settings.store'
import type { SpacingPreset } from '../../../types/enums'

/** 速记弹窗外观 */
export const QuickAddSection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()

  return (
    <Section title="速记弹窗" level={2}>
      <Row label="弹窗圆角">
        <Slider
          value={settings.quickAddBorderRadius}
          min={12}
          max={24}
          step={1}
          onChange={(v) => updateSettings({ quickAddBorderRadius: v })}
          showValue
        />
      </Row>
      <Row label="内边距">
        <Segmented
          value={settings.quickAddPadding}
          options={[
            { value: 'compact', label: '紧凑' },
            { value: 'standard', label: '标准' },
            { value: 'spacious', label: '宽松' }
          ]}
          onChange={(v) => updateSettings({ quickAddPadding: v as SpacingPreset })}
        />
      </Row>
    </Section>
  )
}
