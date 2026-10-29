import React from 'react'
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import ReminderBanner from '../../../src/renderer/windows/ReminderBanner'

/**
 * 授权横幅：放得下它自己说的话，且撞守卫后有出路（1.0.117）
 *
 * 卡 `21f171f1`：高度写死 104 + 标题 `line-clamp-2`，长文案和五个按钮挤不下，
 * 目标摘要与回执被切掉 —— 人被要求在一段看不见后半截的文案上点头。
 * 卡 `0dfff6df`：横幅读了 `execution.ok` / `.message` 却**没读 `.canForce`**，
 * 于是"补个 --force 就能继续"这条信息在横幅这条路上没有出口。
 *
 * 判据（都在这一个文件里可观测）：
 *  1. 发起方 / 要动什么 / 目标名三样都在 DOM 里，标题**没有**截断类；
 *  2. 挂载后把自己量到的高度上报主进程（`window:fitReminderBanner`）；
 *  3. 撞守卫时出现能点的「仍然删除」+「取消」，且横幅**不自动收**（收了等于把人晾在半路）；
 *  4. 点它时带的是**同一条申请** + `withForce: true`。
 *
 * happy-dom 没有布局，`getBoundingClientRect` 恒为 0 —— 底部桩掉它，
 * 否则第 2 条会因为"量出来是 0"而永远绿（假闸门）。
 */
const calls: { channel: string; input: unknown }[] = []

type GrantRow = { id: string; agentId: string; scope: string }
const PENDING: GrantRow[] = [{ id: 'g1', agentId: 'agent:qwen', scope: 'destructive' }]

/** 守卫挡下"还有子任务"：补 --force 就能继续（与 payload 无关，按 withForce 分支） */
function mockInvoke(channel: string, input: unknown): unknown {
  calls.push({ channel, input })
  switch (channel) {
    case 'window:fitReminderBanner':
    case 'window:hideReminderBanner':
    case 'window:showKanban':
      return undefined
    case 'agent:listGrants':
      return PENDING
    case 'agent:resolveGrant': {
      const withForce = (input as { withForce?: boolean } | undefined)?.withForce === true
      return {
        grant: { id: 'g1' },
        execution: withForce
          ? {
              ok: true,
              skipped: false,
              message: '已删除「重构发版脚本」（2 个子任务已保留）',
              details: 'todo rm 3f2a --yes --force'
            }
          : {
              ok: false,
              skipped: false,
              message: '删除「重构发版脚本」？其下 2 个子任务将保留为独立事项。',
              details: 'todo rm 3f2a --yes',
              canForce: true
            }
      }
    }
    default:
      return undefined
  }
}

const has = (channel: string) => calls.filter((c) => c.channel === channel)

/**
 * 挂载横幅，并先放过那一拍 hashchange。
 *
 * happy-dom 的 `location.hash` 变更**异步**派发 hashchange；测试在 beforeEach 里改
 * hash、紧接着 render，那个事件会落在点击之后 —— 按"换内容就清回执"的语义把
 * 本次回执清掉（真实复用窗口时这正是期望行为）。所以测试里先等它过去，
 * 否则测到的是事件时序，不是这张卡的缺陷。
 */
async function renderBanner() {
  const utils = render(<ReminderBanner />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return utils
}
const inputsOf = (channel: string) => has(channel).map((c) => c.input)

beforeAll(() => {
  /**
   * happy-dom 没有排版引擎：不桩这一步的话，内容高度永远是 0，
   * "上报了高度"这条断言会以假绿的方式通过。
   */
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 440,
      bottom: 168,
      width: 440,
      height: 168,
      toJSON: () => ({})
    })
  })
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class NoopObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopObserver
  }
})

beforeEach(() => {
  calls.length = 0
  cleanup()
  const qs = new URLSearchParams({
    type: 'grant',
    title: 'qwen 想「删除数据」，等你点头',
    detail: 'todo rm《重构发版脚本》',
    todoId: 'grant:agent:qwen:destructive'
  })
  window.location.hash = `#/reminder-banner?${qs.toString()}`
  ;(window as unknown as { api: unknown }).api = {
    invoke: async (channel: string, input: unknown) => ({
      ok: true,
      data: mockInvoke(channel, input)
    }),
    on: () => () => {}
  }
})

describe('授权横幅（21f171f1）：三样信息都读得到，高度跟着内容走', () => {
  it('发起方 / 要动什么 / 目标名都在 DOM 里', () => {
    render(<ReminderBanner />)
    expect(screen.getByText('qwen 想「删除数据」，等你点头')).toBeTruthy()
    expect(screen.getByText('todo rm《重构发版脚本》')).toBeTruthy()
    expect(screen.getByText('操作申请')).toBeTruthy()
  })

  it('标题不再 line-clamp（截掉的那一截恰好是目标名）', () => {
    const { container } = render(<ReminderBanner />)
    /**
     * 扫**整棵 DOM**而不是只看根节点：line-clamp 恰恰是挂在标题那个 div 上的，
     * 而标题不会再被 DOM 结构保证位置 —— 反向验证时只查根节点会漏判（本轮实测）。
     */
    expect(container.innerHTML).not.toContain('line-clamp')
    const root = container.querySelector('[role="alert"]') as HTMLElement
    // 根节点是内容高度，不是 h-full：h-full 时永远无法量出"内容有多高"
    expect(root.className).not.toContain('h-full')
    expect(root.className).toContain('w-full')
  })

  it('挂载后把量到的高度上报主进程（透明窗口不能猜一个够大的固定高度）', () => {
    render(<ReminderBanner />)
    const reported = inputsOf('window:fitReminderBanner') as { height: number }[]
    expect(reported.length, '没有上报高度，窗口就还是写死的那 104').toBeGreaterThan(0)
    expect(reported[0].height).toBe(168)
  })
})

describe('授权横幅（0dfff6df）：撞守卫要有出路，且不能把人晾在半路', () => {
  it('撞守卫后出现「仍然删除」+「取消」，且过了自动收的那一窗它还在（等着人点）', async () => {
    /**
     * 为什么真等 2.9 秒而不是用假时钟：vitest 的假时钟连 `queueMicrotask`
     * 一起接管，act 的异步刷新会被冻住；而只 spy `setTimeout` 又会把
     * React 自己的调度一起拦住（两种写法本轮都实测红过）。
     *
     * 反正判据就是"过了自动收起的时间窗，横幅和按钮还在" ——
     * 那就老老实实等过这一窗，结论才站得住。
     */
    await renderBanner()
    await act(async () => {
      ;(screen.getByText('允许一次') as HTMLButtonElement).click()
    })
    // 横幅这条路现在读得到 canForce（此前只读 ok / message）
    // 回执要经过"查待表态 → 表态 → 执行回执"两段 await，act 一次 flush 不够
    await waitFor(() => expect(screen.getByText(/子任务将保留为独立事项/)).toBeTruthy())
    expect(screen.getByText('仍然删除')).toBeTruthy()
    /** 确认框要成对：只有"仍然删除"、没有退路，读起来就是在催人删 */
    expect(screen.getByText('取消'), '确认框没有退路').toBeTruthy()
    expect(screen.queryByText('关闭'), '取消位上还是"关闭"').toBeNull()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2900))
    })
    /** 关键：回执自动收起会把按钮一起收走 —— 那等于"告诉你有出路，然后关上" */
    expect(has('window:hideReminderBanner').length, '撞守卫后横幅还是自动收了').toBe(0)
    expect(screen.getByText('仍然删除')).toBeTruthy()
  })

  it('点「仍然删除」带的是同一条申请 + withForce:true', async () => {
    await renderBanner()
    await act(async () => {
      ;(screen.getByText('允许一次') as HTMLButtonElement).click()
    })
    await waitFor(() => expect(screen.getByText('仍然删除')).toBeTruthy())
    calls.length = 0
    await act(async () => {
      ;(screen.getByText('仍然删除') as HTMLButtonElement).click()
    })
    const resolves = inputsOf('agent:resolveGrant') as {
      grantId: string
      allow: boolean
      withForce?: boolean
    }[]
    expect(resolves.length).toBe(1)
    /**
     * grantId 必须是**失败的那一条**：撞守卫之后授权仍是 granted，
     * 已经不在 pending 列表里 —— 靠"再查一次最新申请"会查空。
     */
    expect(resolves[0]).toMatchObject({ grantId: 'g1', allow: true, withForce: true })
  })

  it('不需要补 flag 的成功回执：给的是人话，不是命令行原文', async () => {
    await renderBanner()
    await act(async () => {
      ;(screen.getByText('允许一次') as HTMLButtonElement).click()
    })
    await waitFor(() => expect(screen.getByText('仍然删除')).toBeTruthy())
    await act(async () => {
      ;(screen.getByText('仍然删除') as HTMLButtonElement).click()
    })
    await waitFor(() => expect(screen.getByText(/已删除「重构发版脚本」/)).toBeTruthy())
    expect(screen.queryByText(/已执行：todo rm/)).toBeNull()
  })

  it('点击「去审批」打开主窗口的审批页（view: approval，而非旧的 user 页）', async () => {
    await renderBanner()
    calls.length = 0
    await act(async () => {
      ;(screen.getByText('去审批') as HTMLButtonElement).click()
    })
    const kanbanCalls = inputsOf('window:showKanban')
    expect(kanbanCalls).toEqual([{ view: 'approval' }])
  })
})
