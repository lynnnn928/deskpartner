import React, { useEffect, useState } from 'react'
import { Section, Row, Segmented } from '../Section'
import { Slider } from '../../ui/Slider'
import { useSettingsStore } from '../../../stores/settings.store'
import { DEFAULT_BG_OPACITY } from '../../../lib/constants'

/**
 * 基础预设：主题模式、整体风格，以及磨砂底色的不透明度覆盖
 *
 * ── 磨砂底色这一项为什么长这样（1.0.59，主用户拍板「显式调过才覆盖预设」）──
 *
 * 默认值是 `bgOpacityOverride = null`（跟随预设），此时**不写行内样式**，
 * 值由 themes/*.css 的预设决定 —— 全库只有一条来源。
 * 用户拖滑块才写入并覆盖预设；旁边的「跟随预设」把它置回 null，覆盖消失。
 *
 * ── 滑块显示的"预设值"必须实时读，不能硬编码（1.0.60 修）──
 *
 * 这段注释原先就写着"不硬编码 0.88"，**代码却正是硬编码的**
 * （`useState(0.88)`）：覆盖状态下 effect 提前 return，于是
 * "已覆盖预设（预设值 88%）"里的 88% 永远来自那个常量、**从不读 CSS**。
 * 1.0.60 把 japanese 预设从 0.88 改成 0.96 之后，这个提示会当场显示错数字
 * —— 硬编码的"当前预设值"就是第二条来源：没人核对、然后漂移。
 *
 * 正确做法：在**不写行内**的前提下量真实生效值 —— 临时摘掉行内覆盖、
 * 读 computed、再原样写回。这样读到的就是"假如跟随预设会得到几"。
 */
export const PresetSection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()
  const override = settings.bgOpacityOverride
  const isOverridden = override !== null && override !== undefined

  /**
   * 跟随预设时的实际值（从 CSS 读，不写死）。
   * `null` = 还没量到（首帧），此时滑块用占位值渲染，下一帧就被真实值替换。
   */
  const [presetValue, setPresetValue] = useState<number | null>(null)

  useEffect(() => {
    /**
     * ⚠️ 放进 rAF 里读，不能直接在 effect 里同步读。
     *
     * React 的 effect 是**子先父后**：本组件的 effect 会早于 `App` 里的
     * `useTheme()` effect 执行。而 `data-preset` 属性与行内覆盖都是由
     * `useTheme` 写的 —— 同步读会读到**上一个预设**的值（切换预设时尤其明显）。
     * rAF 在绘制前执行，那时 DOM 上的属性和样式都已落定。
     */
    const raf = requestAnimationFrame(() => {
      const root = document.documentElement
      const had = root.style.getPropertyValue('--frosted-bg-opacity')
      // 覆盖态下必须临时摘掉，否则读到的是行内覆盖值而不是预设值
      if (had) root.style.removeProperty('--frosted-bg-opacity')
      const raw = getComputedStyle(root).getPropertyValue('--frosted-bg-opacity')
      if (had) root.style.setProperty('--frosted-bg-opacity', had)

      const n = Number.parseFloat(raw)
      if (Number.isFinite(n)) setPresetValue(n)
    })
    return () => cancelAnimationFrame(raf)
  }, [override, settings.stylePreset, settings.theme])

  /** 首帧占位（仅用于让滑块有值可渲染，毫秒级后即被真实值覆盖） */
  const PLACEHOLDER_OPACITY = 0.9
  const effective = isOverridden ? (override as number) : (presetValue ?? PLACEHOLDER_OPACITY)

  return (
    <Section title="基础预设" desc="切换预设后，未自定义的色值会自动适配，仍可继续微调">
      <Row label="主题模式">
        <Segmented
          value={settings.theme}
          options={[
            { value: 'light', label: '浅色', icon: 'sun' },
            { value: 'dark', label: '深色', icon: 'moon' }
          ]}
          onChange={(value) => updateSettings({ theme: value })}
        />
      </Row>
      <Row label="风格预设">
        <Segmented
          value={settings.stylePreset}
          options={[
            // 1.0.65：她要求「把名字从四个字改成两个字，一个叫磨砂，一个叫留白」。
            // 判据：名字要说清它买到什么 —— "极简""日系"是风格描述，而这两个预设
            // 真正的差别只有磨砂底色浓淡一项，四字名把差异藏起来了。
            // ⚠️ 底层值 frosted / japanese 不改：那是 DB 里存的值，
            // 改它等于让所有已有记录的 stylePreset 读不到。
            { value: 'frosted', label: '磨砂', icon: 'layoutWindow' },
            { value: 'japanese', label: '留白', icon: 'leaf' }
          ]}
          onChange={(value) => updateSettings({ stylePreset: value })}
        />
      </Row>

      <Row
        label="磨砂底色"
        hint={
          isOverridden
            ? `已自定义（预设值 ${
                presetValue === null ? '…' : Math.round(presetValue * 100)
              }%）`
            : '当前跟随风格预设，拖动滑块即覆盖它'
        }
      >
        <div className="flex items-center justify-end gap-3 w-full">
          <Slider
            value={Math.round(effective * 100)}
            min={Math.round(DEFAULT_BG_OPACITY.min * 100)}
            max={Math.round(DEFAULT_BG_OPACITY.max * 100)}
            step={5}
            onChange={(v) => updateSettings({ bgOpacityOverride: v / 100 })}
            showValue
          />
          {isOverridden && (
            <button
              type="button"
              onClick={() => updateSettings({ bgOpacityOverride: null })}
              title="把值交还给风格预设（行内覆盖消失）"
              className="shrink-0 px-2 py-1 rounded-button text-label text-text-secondary hover:text-accent transition-colors"
            >
              跟随预设
            </button>
          )}
        </div>
      </Row>
    </Section>
  )
}
