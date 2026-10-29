import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { StatusBadge } from '../../../../src/renderer/components/ui/Badge'

/**
 * 卡 `6ae61278`：「需二次确认」徽标被压成竖排一字一行。
 *
 * ## 根因（不是观感问题）
 *
 * 徽标在待审批卡片里处于 `flex items-center gap-2 min-w-0` 这一行，左边是可 `truncate`
 * 的标题。徽标本身没有 `whitespace-nowrap` / `shrink-0`，于是 flex 先把它压窄、
 * 浏览器再按字断行 —— 「需二次确认」排成五列。它是"待表态 vs 待补确认"**唯一的
 * 视觉出口**，读不成字等于新契约的可辨识度白做一半。
 *
 * ## 为什么修在共享组件上
 *
 * 同一天立的「同物同形」契约（`d930dfb5`）要求徽标走共享组件；就地给这一处写
 * `whitespace-nowrap` 是第二套判据 —— 别处同病还在，只是没人截图。
 * 判据因此落在 `<StatusBadge>` 本身：**任何徽标都不许被压成一列**。
 *
 * ⚠️ happy-dom 没有布局引擎，"看起来是竖排"没法直接断言。可判的是成因：
 * 徽标 class 串里必须有 `whitespace-nowrap` + `shrink-0`，且审批页那枚必须走共享组件。
 * 真实观感在发版后按卡面判据用眼睛看（要造一条需二次确认的授权，本轮现场卡是现成素材）。
 */
const ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

describe('徽标不许被压缩换行（卡 6ae61278）', () => {
  it('共享徽标自带 whitespace-nowrap + shrink-0 —— 五个 tone 都一样', () => {
    for (const tone of ['neutral', 'accent', 'success', 'warning', 'danger'] as const) {
      const { unmount } = render(<StatusBadge tone={tone}>需二次确认</StatusBadge>)
      const el = screen.getByText('需二次确认')
      expect(el.className, `${tone} 档缺 whitespace-nowrap`).toContain('whitespace-nowrap')
      expect(el.className, `${tone} 档缺 shrink-0`).toContain('shrink-0')
      unmount()
    }
  })

  it('审批页那枚徽标走共享组件与统一文案，不就地散写样式', () => {
    const src = read('src/renderer/components/approval/ApprovalView.tsx')
    expect(src).toContain("<StatusBadge tone={g.scope === 'config' ? 'warning' : 'danger'}>")
    expect(src).toContain('{grantBadgeLabel(g.scope, needsForceConfirm)}')
    // 就地压宽度的写法（max-w-* / w-*）正是把字挤成列的那条路
    expect(src).not.toMatch(/<StatusBadge[^>]*\b(max-w-|w-)\S/)
  })
})
