import React, { useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { invoke } from '../../lib/ipc-client'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { useOnboardingStatus } from '../../lib/use-onboarding-status'
import { useCliAccess } from '../../lib/use-cli-access'
import { buildMigratePrompt } from '../../lib/onboarding-prompts'
import { cn } from '../../lib/utils'

/**
 * 首屏上手清单（卡 `a19054a1`）
 *
 * 为什么是常驻条而不是空态里的一块：
 * 空态只在"一条事项都没有"时出现，而助手一提事项空态就消失 ——
 * 引导会跟着一起消失。放在列表上方、与空态解耦，才不受数据影响。
 *
 * 为什么判据全从真实数据推算（`useOnboardingStatus`）：
 * 不另存"引导进度"，就不会出现"标记说看过、实际没做过"的假状态。
 *
 * 只列 4 步：接入 → 批准 → 确认约定 → 首个项目与事项闭环。
 * 拍板与验收在最后一步里由助手登记的事项驱动，不单独占一行：
 * 它们不是"看一遍就会"的动作，而是要在真卡片上做一次。
 */
export interface OnboardingChecklistProps {
  /** 收起状态下用户仍能看到入口（点了重新展开） */
  forceOpen?: boolean
}

export const OnboardingChecklist: React.FC<OnboardingChecklistProps> = () => {
  const { status, coreDone, doneCount, reload } = useOnboardingStatus()
  const setMainView = useUIStore((s) => s.setMainView)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const cliAccess = useCliAccess()
  /** 用户主动收起；与"全绿后自动收起"分开记，否则自动收起之后再也点不开 */
  const [dismissed, setDismissed] = useState(false)
  const [reopened, setReopened] = useState(false)
  const [name, setName] = useState(settings?.humanName ?? '')
  const [copied, setCopied] = useState(false)

  const nameMissing = !settings?.humanNameAsked
  const autoHidden = coreDone && !nameMissing
  const hidden = dismissed || (autoHidden && !reopened)

  const copyPrompt = async (): Promise<void> => {
    const text = buildMigratePrompt(cliAccess)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 剪贴板不可用时保持原样，用户可以用「快速上手」页的按钮 */
    }
  }

  const confirmProtocol = async (): Promise<void> => {
    try {
      const res = (await invoke('protocol:get')) as unknown as { blocks?: Array<{ blockKey: string; body: string }> } | null
      await Promise.all(
        (res?.blocks ?? []).map((block) =>
          invoke('protocol:set', { blockKey: block.blockKey, body: block.body, confirmed: true })
        )
      )
      reload()
    } catch {
      /* 失败就保持未确认，去用户页看具体报错 */
    }
  }

  const commitName = (): void => {
    const trimmed = name.trim()
    void updateSettings({ humanName: trimmed, humanNameAsked: true }).then(() => reload())
  }

  if (hidden) {
    return (
      <button
        type="button"
        data-testid="onboarding-checklist-collapsed"
        onClick={() => {
          setReopened(true)
          setDismissed(false)
        }}
        className="self-start inline-flex items-center gap-1.5 text-caption text-text-secondary hover:text-text-primary cursor-pointer"
      >
        <Icon name="checkCircle" size={13} />
        接入完成 · 查看上手清单（{doneCount}/5）
      </button>
    )
  }

  const rows: Array<{
    key: string
    title: string
    hint: string
    done: boolean
    optional?: boolean
    action: { label: string; onClick: () => void } | null
  }> = [
    {
      key: 'agent',
      title: '接入你的 AI 助手',
      hint: '复制开场提示词，粘给你自己在用的 AI 助手；它会读本机接入地址并申请注册。',
      done: status.hasRegisteredAgent,
      action: { label: copied ? '已复制' : '复制开场提示词', onClick: () => void copyPrompt() }
    },
    {
      key: 'approved',
      title: '批准它的身份',
      hint: '批准之后它才能写入；在你点头之前，它只能读。',
      done: status.hasApprovedCredential,
      action: { label: '前往审批', onClick: () => setMainView('approval') }
    },
    {
      key: 'protocol',
      title: '确认协作约定',
      hint:
        status.globalProtocolConfirmed
          ? '已确认，助手会按这份约定跟你配合。'
          : '出厂协议已经写好五条规则，确认一次即可；想改可以去用户页。',
      done: status.globalProtocolConfirmed,
      action: status.globalProtocolConfirmed ? null : { label: '一键确认', onClick: () => void confirmProtocol() }
    },
    {
      key: 'handoff',
      title: '让助手建第一个项目',
      hint: '它会提议接手说明并登记事项；你在待确认里拍板一次，再在待验收里核对一次。',
      done: status.projectHandoffConfirmed,
      action: { label: '让助手建项目', onClick: () => void copyPrompt() }
    }
  ]

  return (
    <section
      data-testid="onboarding-checklist"
      className="rounded-card border border-border bg-bg-card shadow-sm overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border bg-surface-subtle">
        <div className="min-w-0">
          <div className="text-content font-semibold text-text-primary">
            {coreDone ? '接入完成' : '先把助手接进来'}
          </div>
          <p className="text-caption text-text-secondary mt-0.5">
            DeskPartner 是你和 AI 助手共用的工作台：你定方向、拍板、验收，它读项目背景、执行、留痕交付。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-caption text-text-secondary font-mono">{doneCount}/5</span>
          <button
            type="button"
            aria-label="收起上手清单"
            data-testid="onboarding-checklist-collapse"
            onClick={() => setDismissed(true)}
            className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-black/5 hover:text-text-primary cursor-pointer"
          >
            <Icon name="chevronLeft" size={14} className="rotate-90" />
          </button>
        </div>
      </div>

      <div className="divide-y divide-border/60">
        {nameMissing && (
          <div className="flex items-center gap-2 px-4 py-2.5" data-testid="onboarding-name-row">
            <span className="text-caption text-text-secondary shrink-0">怎么称呼你</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="用于看板归属与协作动态"
              className="h-8 flex-1 min-w-0 px-2.5 rounded-button border border-border bg-bg-card text-label text-text-primary outline-none focus:border-accent"
            />
            <Button variant="ghost" size="sm" className="border border-border bg-surface-subtle px-2.5" onClick={commitName}>
              保存
            </Button>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.key} className="flex items-start gap-3 px-4 py-2.5" data-testid={`onboarding-row-${row.key}`}>
            <span
              className={cn(
                'mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                row.done ? 'bg-accent text-white' : 'border border-border text-transparent'
              )}
            >
              <Icon name="check" size={11} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-label font-medium', row.done ? 'text-text-secondary' : 'text-text-primary')}>
                {row.title}
              </div>
              <p className="text-caption text-text-secondary leading-relaxed">{row.hint}</p>
            </div>
            {row.action && !row.done && (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`onboarding-action-${row.key}`}
                className="shrink-0 border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary"
                onClick={row.action.onClick}
              >
                {row.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
