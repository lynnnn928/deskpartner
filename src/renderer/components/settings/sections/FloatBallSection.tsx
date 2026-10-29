import React from 'react'
import { Section, Row } from '../Section'
import { ColorField } from '../ColorField'
import { Slider } from '../../ui/Slider'
import { Switch } from '../../ui/Switch'
import { useSettingsStore } from '../../../stores/settings.store'
import { DEFAULT_FLOAT_BALL } from '../../../lib/constants'

/** 悬浮球外观与行为 */
export const FloatBallSection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()

  /** null = 跟随全局强调色（默认）；有值 = 用户自定义 */
  const followsAccent = settings.floatBallColor === null
  const isCustomColor =
    settings.floatBallColor !== null &&
    settings.floatBallColor.toUpperCase() !== DEFAULT_FLOAT_BALL.color.toUpperCase()

  return (
    <Section title="悬浮球">
      <Row label="大小">
        <Slider
          value={settings.floatBallSize}
          min={36}
          max={64}
          step={2}
          onChange={(v) => updateSettings({ floatBallSize: v })}
          showValue
        />
      </Row>
      {/*
        文案必须带「悬浮球」（1.0.59）：此前只写「不透明度」，
        与磨砂底色那一项在视觉上无法区分 —— 主用户 2026-09-29 正是因此
        把这里误认为"窗口磨砂底色可调"，进而以为那一版该有的能力没做。
        同一个词在两个不同对象上出现，就是会认错。
      */}
      <Row label="悬浮球不透明度" hint="100% 为完全不透明">
        <Slider
          value={Math.round(settings.floatBallOpacity * 100)}
          min={30}
          max={100}
          step={5}
          onChange={(v) => updateSettings({ floatBallOpacity: v / 100 })}
          showValue
        />
      </Row>

      <Row
        label="跟随全局强调色"
        hint="关闭后可单独设置悬浮球颜色"
      >
        <Switch
          checked={followsAccent}
          onChange={(v) => updateSettings({ floatBallColor: v ? null : DEFAULT_FLOAT_BALL.color })}
        />
      </Row>

      <ColorField
        label="球体颜色"
        value={settings.floatBallColor ?? DEFAULT_FLOAT_BALL.color}
        isCustom={isCustomColor}
        onChange={(value) => updateSettings({ floatBallColor: value })}
        onReset={() => updateSettings({ floatBallColor: DEFAULT_FLOAT_BALL.color })}
      />

      <Row label="贴边隐藏">
        <Switch
          checked={settings.floatBallEdgeHide}
          onChange={(v) => updateSettings({ floatBallEdgeHide: v })}
        />
      </Row>
      <Row label="显示图标">
        <Switch
          checked={settings.floatBallShowIcon}
          onChange={(v) => updateSettings({ floatBallShowIcon: v })}
        />
      </Row>
      <Row label="提醒光晕">
        <Switch
          checked={settings.floatBallShowGlow}
          onChange={(v) => updateSettings({ floatBallShowGlow: v })}
        />
      </Row>
    </Section>
  )
}
