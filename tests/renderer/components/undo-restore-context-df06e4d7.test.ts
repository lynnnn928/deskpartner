import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { useUIStore } from '../../../src/renderer/stores/ui.store'
import type { Todo } from '../../../src/renderer/types/todo'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const STORE = read('src/renderer/stores/ui.store.ts')
const SNACKBAR = read('src/renderer/components/kanban/UndoSnackbar.tsx')
const IPC_TYPES = read('src/renderer/types/ipc.ts')
/** ⚠️ 接线也要读：仓储改了签名、handler 忘了跟着改，两边各自的用例都不会红 */
const IPC_MAIN = read('src/main/ipc.ts')

/**
 * 撤销窗口与撤销反馈（卡 `df06e4d7` 的验收 ④⑤ 里属于**界面**的那一半）
 *
 * 为什么与 `tests/main/database/todo-restore-context-df06e4d7.test.ts` 分家：
 * 那一份钉的是"删了什么、恢复回来什么"（数据层），这一份钉的是
 * "4 秒窗口怎么关的、结果怎么告诉人"（渲染层）。
 * 把 4 秒窗口塞进数据层用例，测出来的是一个那里并不存在的机制。
 *
 * 界面断言走**源码文本闸门**（与 `project-archive-delete-c177e466.test.ts`
 * 同款）：撤销反馈准不准，取决于 `UndoSnackbar` 里那几个具体写法在不在，
 * 靠人记得去点一遍不可靠 —— 而点了也不会留下证据。
 */
describe('撤销窗口与撤销反馈（卡 df06e4d7）', () => {
  beforeEach(() => {
    useUIStore.setState({ undoQueue: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const snapshot = {
    id: 't1',
    title: '被删掉的卡',
    createdAt: '2026-01-01T00:00:00.000Z'
  } as unknown as Todo

  it('④ 撤销窗口仍是 4 秒；过期后队列里没有它，界面上也就无从发起撤销', () => {
    // 窗口长度是产品既有语义（`UndoSnackbar` 的说明写着"不是第二份回收站"），本卡不改它
    expect(STORE, '4 秒窗口被改动了').toContain('const UNDO_TTL_MS = 4000')
    expect(SNACKBAR, '没有可撤销项时什么都不显示 —— 过期后正是这个状态').toContain(
      'if (!latest) return null'
    )

    vi.useFakeTimers()
    useUIStore.getState().pushUndo({ id: 't1', label: '已删除「被删掉的卡」', snapshot })
    expect(useUIStore.getState().undoQueue, '入队了才谈得上撤销').toHaveLength(1)

    // 窗口内：还撤得回来
    vi.advanceTimersByTime(3999)
    expect(useUIStore.getState().undoQueue).toHaveLength(1)

    // 超过窗口：出队 → 没有快照可交回主进程 → "撤销"这件事在界面上不存在了
    vi.advanceTimersByTime(1)
    expect(useUIStore.getState().undoQueue, '4 秒一到就该出队').toHaveLength(0)
  })

  it('⑤ 撤销成功也要读回执：没挪回来的子事项、一并恢复的评论数都要说出来', () => {
    expect(SNACKBAR).toContain("const result = await invoke('todo:restore'")
    expect(SNACKBAR, '有子事项没挪回时必须出声').toContain('result.conflicts.length > 0')
    expect(SNACKBAR, '评论回来了也该说一句（不然"上下文回来了"没人知道）').toContain(
      'result.commentsRestored > 0'
    )
    expect(SNACKBAR, '反馈走既有的 toast，不新造一套').toMatch(/showToast\(`已撤销/)
    expect(IPC_TYPES, '回执类型换了，界面才读得到"哪儿没回来"').toContain(
      "'todo:restore': { input: { todo: Todo }; result: TodoRestoreResult }"
    )

    /**
     * 接线：主进程必须走带回执的那个入口。
     * 只改仓储的话，界面拿到的还是"只有主体"的旧回执 —— 读 conflicts 得到 undefined，
     * 于是"撤销明明成功了，却弹一句撤销失败"。
     */
    const handlerAt = IPC_MAIN.indexOf("ipcMain.handle('todo:restore'")
    expect(handlerAt, '主进程没有注册 todo:restore').toBeGreaterThan(-1)
    const handler = IPC_MAIN.slice(handlerAt, handlerAt + 700)
    expect(handler, 'handler 还在用只回主体的旧入口').toContain('restoreWithReport(todo)')
    expect(handler, 'handler 还在用只回主体的旧入口').not.toMatch(/todoRepo\.restore\(todo\)/)
  })

  it('⑤ 撤销失败仍然说出来；成功才出队（失败还留在那儿，人还能再点一次）', () => {
    expect(SNACKBAR).toContain('撤销失败：')

    const idxInvoke = SNACKBAR.indexOf("await invoke('todo:restore'")
    const idxRemove = SNACKBAR.indexOf('removeUndoItem(latest.id)')
    const idxCatch = SNACKBAR.indexOf('} catch (err) {')

    expect(idxInvoke, '撤销必须真的把快照交回主进程').toBeGreaterThan(-1)
    expect(idxRemove).toBeGreaterThan(idxInvoke)
    expect(idxRemove, '出队要发生在成功分支 —— 失败还留在队列里').toBeLessThan(idxCatch)
    expect(SNACKBAR, '撤销后重新拉数据，评论与父子关系才显示得出来').toContain(
      'await fetchTodos()'
    )
  })
})
