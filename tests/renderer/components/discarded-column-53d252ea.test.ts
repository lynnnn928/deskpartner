import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BOARD_COLUMNS } from '../../../src/renderer/lib/constants'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

/**
 * 界面上要有「已废弃」列（53d252ea）
 *
 * ── 要拦的是什么 ──
 *
 * 卡一旦置废弃，界面上没有任何入口能看到它（只有命令行 --status any 才列得出）。
 * 主用户 2026-10-08：「到现在为止我在界面上都没有看到废弃列这个事情」，
 * 并钉死形态：「废弃列就是给一列，不是收进挂起列的分区，
 * 就是在完成列的后面给一列废弃列，可以在界面上看得到的。」
 *
 * 撞的原则：低噪音可以，但不能完全隐藏 —— 「需要时能拿到」；
 * 废弃卡彻底隐身也踩「审计留痕：删除不留痕」一族。
 *
 * ── 闸门怎么判 ──
 *
 * 列序单源（lib/constants.ts BOARD_COLUMNS）+ 主面板可达性 + 数字口径三段一起钉
 * （原来第三段钉的是"完成率分母不含已废弃"；角标随 f6f78ada 改成「筛选出 N 条」后，
 * 这一段钉的是"两处数字同源、不各写一份"——同一件事，只是换了个数字）。
 * 状态入口不再放在侧栏；侧栏只负责导航，已废弃通过事项页的范围/状态筛选进入。
 * 每条都写了反向验证（拿掉哪一行会红），防止"看着全绿其实没测到"。
 */

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('界面上要有「已废弃」列（53d252ea）', () => {
  it('基础数据解析成功（防止闸门因路径变化而假通过）', () => {
    const board = read('src/renderer/components/kanban/KanbanBoard.tsx')
    expect(board.length).toBeGreaterThan(800)
    expect(board).toContain('BOARD_COLUMNS')
    expect(BOARD_COLUMNS.length).toBe(7)
  })

  it('① 列序单源里 discarded 固定排在 done 之后（拍板原话：完成列的后面）', () => {
    expect(BOARD_COLUMNS, 'done 之后必须紧跟 discarded').toEqual([
      'proposed',
      'todo',
      'in_progress',
      'suspended',
      'awaiting_review',
      'done',
      'discarded'
    ])
    // 反向验证：把 BOARD_COLUMNS 里的 'discarded' 摘掉 → 长度与顺序断言当场红。
  })

  it('① 渲染与拖拽判定都吃这一份单源（各写一份会漏改）', () => {
    const board = stripComments(read('src/renderer/components/kanban/KanbanBoard.tsx'))
    const dnd = stripComments(read('src/renderer/hooks/useDragSort.ts'))
    expect(
      board.includes('COLUMNS: TodoStatus[] = BOARD_COLUMNS'),
      'KanbanBoard 没有使用单源 BOARD_COLUMNS —— 列序又会漂成两份'
    ).toBe(true)
    expect(
      dnd.includes('BOARD_COLUMNS'),
      'useDragSort 没有使用单源 BOARD_COLUMNS —— 废弃列会渲染出来却拖不进卡'
    ).toBe(true)
    // 两处都不得再各自内联数组
    expect(board.includes("'proposed'"), 'KanbanBoard 不该再内联列数组').toBe(false)
    expect(dnd.includes("'proposed'"), 'useDragSort 不该再内联列数组').toBe(false)
    // 反向验证：任一处改回内联数组（删 import 用法）→ 对应断言红。
  })

  it('② 侧栏不再承载状态入口，已废弃通过主面板状态筛选进入', () => {
    const sidebar = stripComments(read('src/renderer/components/kanban/Sidebar.tsx'))
    expect(sidebar.includes('SMART_ITEMS')).toBe(false)
    expect(sidebar.includes("label: '已废弃'")).toBe(false)
    expect(sidebar.includes('status === \'discarded\'')).toBe(false)
  })

  it('② 选中「已废弃」状态筛选时进入已结束范围', () => {
    const store = useUIStore.getState()
    store.setFilterStatus('discarded')
    const s = useUIStore.getState()
    expect(s.workItemScope).toBe('ended')
    expect(s.filterStatus, '精确状态筛选要落到 filterStatus').toBe('discarded')
    expect(s.mainView, '状态筛选要回到看板').toBe('board')
    store.setFilterStatus(null)
    expect(useUIStore.getState().filterStatus).toBeNull()
    // 反向验证：删掉 setFilterStatus 的范围联动 → workItemScope 断言红。
  })

  it('③ 数字只有一条口径（SearchBar/ChipsBar 都吃窗口层传下来的 visibleCount，不各写一份）', () => {
    for (const f of [
      'src/renderer/components/kanban/SearchBar.tsx',
      'src/renderer/components/kanban/ChipsBar.tsx'
    ]) {
      const src = stripComments(read(f))
      expect(src.includes('visibleCount'), `${f} 没吃窗口层那份可见卡片数`).toBe(true)
      expect(
        src.includes("t.status === 'done'"),
        `${f} 又手写了一份计数口径 —— 两份就会漂开`
      ).toBe(false)
      expect(
        src.includes('completionStats('),
        `${f} 还留着一份完成率口径 —— 它已随 f6f78ada 退场`
      ).toBe(false)
    }
    // 反向验证：任一处改回自己 filter(...) 数卡片 → 本条红。
  })

  it('④ 废弃列不给「+ 添加任务」入口（不做了的结论不能凭空新建）', () => {
    const col = stripComments(read('src/renderer/components/kanban/KanbanColumn.tsx'))
    expect(
      col.includes("status !== 'done' && status !== 'discarded'"),
      'KanbanColumn 给废弃列留了新增入口 —— 「不做了」的列里凭空新建一条是自相矛盾'
    ).toBe(true)
    // 反向验证：改回只判 `status !== 'done'` → 本条红。
  })
})
