import React from 'react'
import { Section } from '../Section'
import { ColorField } from '../ColorField'
import { useSettingsStore } from '../../../stores/settings.store'
import { DEFAULT_COLORS } from '../../../lib/constants'
import type { CustomColors } from '../../../types/settings'

interface ColorMeta {
  key: keyof CustomColors
  label: string
}

/** 可自定义的色值清单，key 必须与 --color-{kebab-case} 变量后缀对应 */
const COLOR_GROUPS: { title: string; items: ColorMeta[] }[] = [
  {
    title: '品牌色',
    items: [
      { key: 'accent', label: '主题强调色' },
      { key: 'success', label: '成功点缀' },
      { key: 'reminderGlow', label: '提醒光晕' }
    ]
  },
  {
    title: '界面',
    items: [
      { key: 'bgPrimary', label: '界面底色' },
      { key: 'border', label: '边框与分割线' }
    ]
  },
  {
    title: '文字',
    items: [
      { key: 'textPrimary', label: '一级正文' },
      { key: 'textSecondary', label: '二级辅助文字' },
      { key: 'textDone', label: '已完成弱化文字' }
    ]
  }
]

const DEFAULTS = DEFAULT_COLORS as unknown as Record<string, string>

/** 自定义颜色面板：双列紧凑网格呈现，所有色值实时生效，可单项重置 */
export const ColorSection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()
  const custom = settings.customColors ?? {}

  const setColor = (key: keyof CustomColors, value: string) => {
    const patch: Partial<CustomColors> = {}
    patch[key] = value
    updateSettings({ customColors: patch })
  }

  const resetColor = (key: keyof CustomColors) => {
    const patch: Partial<CustomColors> = {}
    patch[key] = undefined
    updateSettings({ customColors: patch })
  }

  return (
    <>
      {COLOR_GROUPS.map((group) => (
        <Section key={group.title} title={group.title} level={2}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {group.items.map((item) => (
              <ColorField
                key={item.key}
                label={item.label}
                value={custom[item.key] ?? DEFAULTS[item.key]}
                isCustom={!!custom[item.key]}
                onChange={(value) => setColor(item.key, value)}
                onReset={() => resetColor(item.key)}
              />
            ))}
          </div>
        </Section>
      ))}
    </>
  )
}
