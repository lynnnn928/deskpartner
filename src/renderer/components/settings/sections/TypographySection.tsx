import React from 'react'
import { Section, Row, Segmented } from '../Section'
import { useSettingsStore } from '../../../stores/settings.store'
import type { FontSizeScale } from '../../../types/enums'

/** 字号设置：采用分段控制器替代下拉选择，与主题/风格预设保持统一 */
export const TypographySection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()

  return (
    <Section title="字号">
      <Row label="全局字号" hint="调整工作台、事项列表与详情面板的基础字号">
        <Segmented
          value={settings.fontSizeScale}
          options={[
            { value: 'small', label: '小' },
            { value: 'normal', label: '标准' },
            { value: 'large', label: '大' }
          ]}
          onChange={(v) => updateSettings({ fontSizeScale: v as FontSizeScale })}
        />
      </Row>
    </Section>
  )
}
