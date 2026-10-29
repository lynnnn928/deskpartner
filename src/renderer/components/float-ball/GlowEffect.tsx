import React from 'react'

/**
 * 呼吸光晕效果 — 未处理提醒时 `--color-reminder-glow`（#82B1FF）慢闪
 *
 * 1.0.116（验收反馈）：这一格原来是内联样式 `boxShadow: '0 0 12px 3px rgba(130,177,255,0.4)'` ——
 * 几何是 magic number，颜色是**硬编码 rgba**，正好绕开刚做完的颜色通道化：
 * 换光晕色要改组件、主题跟不动，而闸门只扫 class 串（`[...]` 任意值），看不见内联 style。
 * 现在几何与颜色一起在 `--shadow-glow` 里（颜色走通道 + `/40` 的 alpha），这里只留类名。
 */
export const GlowEffect: React.FC = () => {
  return <div className="absolute inset-0 rounded-full animate-glow pointer-events-none shadow-glow" />
}
