import React, { useCallback, useEffect, useRef, useState } from 'react'
import { EdgeHide } from '../components/float-ball/EdgeHide'
import { useTodoStore } from '../stores/todo.store'
import { useSettingsStore } from '../stores/settings.store'
import { invoke } from '../lib/ipc-client'
import { countAwaitingApproval } from '../lib/grant-state'

/** 悬浮球窗口入口 */
const FloatBall: React.FC = () => {
  const { settings } = useSettingsStore()

  /**
   * 悬浮球的屏幕坐标
   *
   * 放在 ref 里：它只在点开的那一刻被读一次，进 state 会让每次拖动
   * 都重渲染整个球。由 EdgeHide 在位置变化时回填。
   */
  const anchorRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const handleAnchorChange = useCallback((anchor: { x: number; y: number }) => {
    anchorRef.current = anchor
  }, [])

  /**
   * 开关悬浮面板（F2-P0-19）
   *
   * 用 toggle 而不是 show：面板开着时再点球应该收起，
   * 而"现在到底开没开"只有主进程知道（面板失焦会自己收，
   * 悬浮球这边记一份布尔值必然对不上）。
   */
  const handleTogglePanel = useCallback(() => {
    invoke('window:togglePanel', { anchor: anchorRef.current })
  }, [])

  const handleShowKanban = useCallback(() => {
    invoke('window:showKanban')
  }, [])

  const handleShowSettings = useCallback(() => {
    invoke('window:showSettings')
  }, [])

  /** 退出应用，而不是只关掉悬浮球窗口 */
  const handleQuit = useCallback(() => {
    invoke('app:quit')
  }, [])

  // 检查是否有未处理提醒
  const hasTodoUnread = useTodoStore((s) =>
    s.todos.some(
      (t) =>
        t.remindAt && t.status !== 'done' && t.status !== 'discarded' && new Date(t.remindAt) <= new Date()
    )
  )

  /**
   * 有没有 agent 在等批准（1.0.37）
   *
   * 主用户反馈"界面上没有看到任何审批提醒" —— 横幅只在申请的那一刻弹，
   * 人不在电脑前就错过了。红点是"错过之后还看得见"的那一层：
   * 它一直挂着，直到申请被处理掉。
   *
   * 5 秒轮询：申请由 agent 在终端触发，主进程不广播这类事件，
   * 悬浮球只能自己问（与设置页同一手法、同一节奏）。
   *
   * ⚠️ 1.0.47 起还要数**待批准的身份**：agent 能自己注册了，办完就静默等着，
   * 没有"申请"记录 —— 只数申请的话人会完全不知道。口径见 countAwaitingApproval。
   */
  const [pendingGrants, setPendingGrants] = useState(0)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const [agents, grants, profileProposals, protocolProposals, handoffProposals, ruleProposals] = await Promise.all([
          invoke('agent:list'),
          invoke('agent:listGrants', { activeOnly: true, limit: 0 }),
          invoke('profile:proposals'),
          invoke('protocol:proposals'),
          invoke('project:handoffProposals'),
          invoke('rules:proposals')
        ])
        if (alive) setPendingGrants(countAwaitingApproval(agents, grants, profileProposals.length, protocolProposals.length, handoffProposals.length, ruleProposals.length))
      } catch {
        /* 读不到就当没有，别让悬浮球报错 */
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const hasUnread = hasTodoUnread || pendingGrants > 0

  return (
    <div className="w-screen h-screen bg-transparent overflow-hidden">
      <EdgeHide
        onClick={handleTogglePanel}
        onDoubleClick={handleShowKanban}
        onAnchorChange={handleAnchorChange}
        onShowKanban={handleShowKanban}
        onShowSettings={handleShowSettings}
        onQuit={handleQuit}
        hasUnread={hasUnread}
        edgeHideEnabled={settings.floatBallEdgeHide}
      />
    </div>
  )
}

export default FloatBall
