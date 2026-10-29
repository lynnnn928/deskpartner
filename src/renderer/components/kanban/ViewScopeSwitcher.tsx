import React, { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { invoke } from '../../lib/ipc-client'
import { cn } from '../../lib/utils'
import type { Agent } from '../../types/todo'

/**
 * 视角切换器（cc7df746）
 *
 * 「我的 / 全部 / 各个 agent」—— 回答的是"现在在看谁的事"。
 *
 * 与筛选栏里的「处理人」不是一回事，别合并：
 * - 处理人筛的是**提出者**（谁记的），精确等于某个身份；
 * - 视角看的是**相关性**：提出者与执行者任一命中就算。
 *   agent 报给你的 bug（它提的、派给你修）在「我的」里必须出现，
 *   否则"别人派给我的活"这个最重要的场景就永远看不到。
 *
 * 选项不写死：每个**已注册**的 agent 自动获得自己的视角。
 * 今天注册了Bob，明天就该多出一档 —— 写死就得为每个新 agent 改前端。
 */
export const ViewScopeSwitcher: React.FC = () => {
  const viewScope = useUIStore((s) => s.viewScope)
  const setViewScope = useUIStore((s) => s.setViewScope)
  const { settings } = useSettingsStore()
  const [agents, setAgents] = useState<Agent[]>([])

  /**
   * 跟着窗口生命周期拉一次即可：注册新 agent 是低频动作，
   * 而每次渲染都拉会让顶部栏在切换形态时闪一下。
   * 拉不到就退化成"只有我的 / 全部"——视角少一档，不该整个不可用。
   */
  useEffect(() => {
    let alive = true
    void invoke('agent:list')
      .then((list) => {
        if (alive) setAgents(list ?? [])
      })
      .catch(() => {
        if (alive) setAgents([])
      })
    return () => {
      alive = false
    }
  }, [])

  const myName = settings?.humanName?.trim() || '我的'

  const options: Array<{ key: string; label: string; color?: string | null }> = [
    { key: 'mine', label: myName },
    { key: 'all', label: '全部' },
    ...agents.map((a) => ({ key: a.id, label: a.displayName, color: a.color }))
  ]

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {options.map((o) => {
        const active = viewScope === o.key
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => setViewScope(o.key)}
            aria-pressed={active}
            title={
              o.key === 'mine'
                ? '我提的 + 指派给我的'
                : o.key === 'all'
                  ? '全部事项'
                  : `${o.label} 提出的 + 指派给它的`
            }
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-tag text-label transition-colors',
              active
                ? 'bg-accent/15 text-accent font-medium'
                : 'text-text-secondary hover:bg-black/5 hover:text-text-primary'
            )}
          >
            {o.color && (
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: o.color }}
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
