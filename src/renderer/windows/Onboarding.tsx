import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settings.store'
import { invoke } from '../lib/ipc-client'

/**
 * 首次启动：问一次「怎么称呼你」
 *
 * 为什么要有这一步：agent 注册时都得报一个展示名（agent register --name "Bob"），
 * 唯独人是硬编码的 `human`，界面上一律显示成「我」。看板给自己看没问题，
 * **动态页**就有歧义了 —— 动态是人和 agent 都读的时间线，
 * 「我验收通过了」这句话对 agent 来说主语是空的，它不知道这个「我」是谁。
 *
 * 为什么是"问一次"而不是设置里放一个框等人发现：
 * 名字这种东西没人会主动去找设置改，而它又决定了动态里所有记录读起来对不对。
 * 放在第一次见面时问，成本最低。
 *
 * 为什么允许跳过：不填名字不该成为使用软件的门槛。
 * 跳过 = 明确决定"就叫我『我』"，写入 humanNameAsked=true，之后不再打扰。
 */
const Onboarding: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  /**
   * 落库后立刻关掉自己。
   *
   * 关窗走 window:control 而不是另开一条 hide 通道：这个窗口只出现一次，
   * 不值得为此多一个 IPC 契约（每加一条都要在类型、闸门脚本、主进程三处同步）。
   */
  const finish = async (value: string) => {
    if (saving) return
    setSaving(true)
    try {
      await updateSettings({ humanName: value.trim(), humanNameAsked: true })
      await invoke('window:control', { action: 'close' })
    } catch {
      // 写失败就停在这儿让人再点一次，不要静默关掉（关了就等于永远不再问）
      setSaving(false)
    }
  }

  // Esc = 跳过，与「就叫『我』」等价
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void finish('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving])

  return (
    <div className="window-frame bg-bg-primary h-full w-full flex flex-col min-h-0 px-6 py-6 select-none">
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-3">
        <h1 className="text-title">第一次见面，怎么称呼你？</h1>
        <p className="text-label text-text-secondary leading-relaxed">
          设置你的显示名称，用于看板归属与协作动态。
        </p>

        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void finish(draft)
          }}
          placeholder="Alex"
          maxLength={20}
          className="mt-1 w-full h-10 px-3 rounded-input border border-border bg-transparent
            text-body outline-none placeholder:text-text-secondary/50 focus:border-accent transition-colors"
        />

        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={() => void finish(draft)}
            disabled={saving || !draft.trim()}
            className="h-9 px-4 rounded-input bg-accent text-white text-label
              disabled:opacity-40 transition-opacity"
          >
            保存
          </button>
          <button
            onClick={() => void finish('')}
            disabled={saving}
            className="h-9 px-3 rounded-input text-label text-text-secondary
              hover:text-text-primary transition-colors"
          >
            跳过
          </button>
        </div>

        {settings && settings.humanNameAsked && (
          <p className="text-label text-text-secondary/70">
            当前：{settings.humanName || '「我」'}
          </p>
        )}
      </div>
    </div>
  )
}

export default Onboarding
