import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { effectiveExecutor } from '../../../src/renderer/lib/assignable-executors'
import type { Todo } from '../../../src/renderer/types/todo'

/**
 * 详情页要说清"谁去做"，卡面保持干净（b95e6bbb 第 2 层）
 *
 * ── 要拦的是什么 ──
 *
 * `executedBy` 空着的语义是"提出即执行"（执行者 = 提出者），不是"没有执行者"。
 * 但界面上哪儿都不显示它，于是空着就被读成"这条没人管" —— 8f881db6 正是这么读错的：
 * 那张卡的提出人没错，错的是**看不见执行人**。
 *
 * ── 判据 ──
 *
 * ① 实际执行人只算一处（`effectiveExecutor` = `executedBy ?? createdBy`，
 *    与主进程侧 G10 自验守卫同一个表达式）；
 * ② 详情页显示它，"提出即执行"时把话说明白；
 * ③ **卡面不新增** —— 卡上仍只在"指派给了别人"时才显示执行者。
 */

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const todo = (over: Partial<Todo>): Todo => ({ createdBy: 'human', executedBy: null, ...over }) as Todo

describe('实际执行人（b95e6bbb）', () => {
  it('① executedBy 空着 = 提出即执行：执行人取提出者', () => {
    expect(effectiveExecutor(todo({ createdBy: 'agent:newmax', executedBy: null }))).toBe(
      'agent:newmax'
    )
    expect(effectiveExecutor(todo({ createdBy: 'human' }))).toBe('human')
    // 反向验证：把 `?? todo.createdBy` 改成 `?? 'human'` → 第一条红。
  })

  it('① 指派给别人时取执行者（提出者不参与）', () => {
    expect(
      effectiveExecutor(todo({ createdBy: 'agent:newmax', executedBy: 'agent:alice' }))
    ).toBe('agent:alice')
    // 提出即执行写成显式的同一个人，也是同一个人
    expect(
      effectiveExecutor(todo({ createdBy: 'agent:newmax', executedBy: 'agent:newmax' }))
    ).toBe('agent:newmax')
  })

  it('② 详情页显示执行人，并把"提出即执行"说明白', () => {
    const form = stripComments(read('src/renderer/components/quick-add/QuickAddForm.tsx'))
    expect(form).toContain('执行人：')
    expect(form).toContain('effectiveExecutor({ createdBy: owner, executedBy })')
    expect(form, '空着的执行者要说清语义，否则又会被读成"没人管"').toContain('默认由提出者执行')
    expect(form).toContain('{editingTodoId && (')
    // 反向验证：把这一行摘掉 → 本条红（"看不见执行人"的病就回到原点）。
  })

  it('③ 卡面保持干净：仍只在"指派给别人"时才显示执行者', () => {
    const card = stripComments(read('src/renderer/components/kanban/TodoCard.tsx'))
    expect(card).toContain('const isExecutedByOther = !!executedBy && executedBy !== todo.createdBy')
    expect(card).toContain('isExecutedByOther && (')
    // 卡面上没有"执行人"这一行常显
    expect(card.includes('执行人：'), '卡面不该新增执行人显示 —— 详情页才是它的位置').toBe(false)
    // 反向验证：把 TodoCard 的 isExecutedByOther 判定改成永真 → 本条红。
  })
})
