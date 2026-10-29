import React, { useState } from 'react'
import { Section, Row } from '../Section'
import { Switch } from '../../ui/Switch'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { useSettingsStore } from '../../../stores/settings.store'
import { invoke } from '../../../lib/ipc-client'

/**
 * 使用数据（遥测开关与清空，1.0.48 收敛）
 *
 * 统计可视化在侧边栏「统计」里（一等入口），这里只剩**操作**：
 * 记不记录、清不清空 —— 设置管数据（操作台），统计看数据（观察窗）。
 * 「打开使用数据」跳转按钮同期退役（一个目的地一个入口）；
 * 清空从统计页迁入（危险操作不去"看"的地方）。
 *
 * 界面上刻意写明"数据去了哪里"：只写本地、不会自动上传。
 * 用户有权知道，也应该能一键关掉并清空。
 */
export const TelemetrySection: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()
  const [confirmClear, setConfirmClear] = useState(false)
  const [cleared, setCleared] = useState(false)

  const handleClear = async () => {
    try {
      await invoke('telemetry:clear', {})
      setCleared(true)
      window.setTimeout(() => setCleared(false), 2500)
    } catch (e) {
      console.error('清空失败:', e)
    } finally {
      setConfirmClear(false)
    }
  }

  return (
    <Section title="使用数据">
      <Row
        label="记录使用数据"
        hint="只保存在本机数据库；仅检查更新时访问 GitHub Releases，不上传任何数据"
      >
        <Switch
          checked={settings.telemetryEnabled}
          onChange={(v) => updateSettings({ telemetryEnabled: v })}
        />
      </Row>
      <Row label="清空使用数据" hint="不可撤销；不影响事项、项目等正式数据">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
            清空
          </Button>
          {cleared && <span className="text-label text-success">已清空</span>}
        </div>
      </Row>

      {confirmClear && (
        <Dialog open onClose={() => setConfirmClear(false)}>
          <div className="w-88 flex flex-col gap-3">
            <h3 className="text-body font-semibold text-text-primary">清空使用数据？</h3>
            <p className="text-label text-text-secondary leading-relaxed">
              本地已记录的使用数据将被清空，此操作不可撤销（不影响事项、项目等正式数据）。
            </p>
            <div className="flex justify-end gap-2 mt-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                取消
              </Button>
              <Button variant="dangerSolid" size="sm" onClick={() => void handleClear()}>
                确认清空
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Section>
  )
}
