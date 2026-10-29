import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  clearQuickAddDraft,
  clearRejectReason,
  quickAddDraftFromTodo,
  quickAddRouteKey,
  readQuickAddDraft,
  readRejectReason,
  sameQuickAddDraft,
  writeQuickAddDraft,
  writeRejectReason,
  type QuickAddDraft
} from '../../../src/renderer/lib/unsaved-drafts'
import type { QuickAddRoute } from '../../../src/renderer/components/quick-add/useQuickAddRoute'
import type { Todo } from '../../../src/renderer/types/todo'

/**
 * 速记与驳回弹窗不能把没保存的输入静默丢掉（卡 `6a595ad0`）
 *
 * ── 实测先说清"丢在哪一步"（与卡上写的不一样，以实测为准） ──
 *
 * 卡上写的病因是"编辑中切换到另一事项会重置表单"（指 QuickAddForm 里那个
 * `[editingTodoId, todos, categories, projects]` 的装载 effect）。实测下来有两处，
 * 而**主要那一处不在渲染层**：
 *
 * ① 主进程的复用分支每次 `showQuickAdd` 都无条件 `loadQuickAdd` →
 *    `loadFile(index.html, {hash})`。2026-10-22 用离屏 Electron（33.4.11）实测：
 *    `loadFile`/`loadURL` 打到与当前**完全相同**的 URL，也会**整页重载**
 *    （渲染进程里 `window.__typed` 直接没了、`__loads` 归 1）；只改 hash 同样是重载。
 *    于是 QuickAddForm 里"窗口只是隐藏、内容原样留着"的前提根本不成立 ——
 *    "填一半 → 点到看板 → 再点回这条"是把整个页面重建了一遍。
 * ② 装载 effect 会被 store 刷新触发（`todos` 换引用），把正在编辑的表单**静默**
 *    换回库里的值。这条路在同一个窗口里就能复现：`todo:addComment` 也
 *    `broadcastDataChanged('todo')`（ipc.ts:519）→ 广播到 QuickAdd 窗口 →
 *    `fetchTodos` → 装载 effect 重跑。用户只是在自己这条下面发了条评论，
 *    标题里打了一半的字就没了。
 *
 * ── 这个文件守的是什么（以及不守什么） ──
 *
 * 仓库里没有组件级测试环境（没有 @testing-library，`tests/renderer` 全是纯函数与
 * 源码闸门 —— 见 `tests/main/notification-inbox-window-cba46119.test.ts` 里同一句
 * 说明），所以：
 *
 * - 草稿模块 `unsaved-drafts` 的行为**逐条真跑**（写入/恢复/清除/按 id 隔离/
 *   坏数据/存储不可用）—— 那是"文字能不能回来"的实际判据；
 * - 组件与主进程的接线走**源码闸门**（这类"静默丢失"不报错、tsc 绿、跑起来才看得见，
 *   靠人记得去点一遍不可靠）—— 每条都写了反向验证（拿掉哪一行会红）。
 *
 * 真机 GUI 没跑（界面类改动在本批次驱动不了 Electron 真机），需要人手动过一遍的
 * 部分写在卡的评论里。
 */

const ROOT = path.resolve(__dirname, '../../..')
/**
 * 读源码时把行尾统一成 LF：工作树是 CRLF、仓库里是 LF（autocrlf=true），
 * 断言里写的是 `\n` —— 不归一化的话，"改对了"会被行尾判成红（本项目踩过）。
 */
const read = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 草稿落在存储里的键：写死在这里是因为它得跨版本稳定（旧草稿要能被旧版本认出来） */
const QUICK_ADD_DRAFT_KEY = 'deskpartner.quickAdd.draft.'

const editRoute = (todoId: string): QuickAddRoute => ({
  todoId,
  status: null,
  projectId: null,
  commentId: null
})

const newRoute = (status: string | null, projectId: string | null): QuickAddRoute => ({
  todoId: null,
  status,
  projectId,
  commentId: null
})

function todoFixture(patch: Partial<Todo> = {}): Todo {
  return {
    id: 't-a',
    title: '写周报',
    fixedInVersion: null,
    description: null,
    projectId: 'p-1',
    parentId: null,
    categoryIds: ['c-1'],
    categoryId: 'c-1',
    status: 'todo',
    priority: 'normal',
    type: 'task',
    createdBy: 'human',
    executedBy: null,
    verifier: 'human',
    dueAt: null,
    remindAt: null,
    isPinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
    ...patch
  }
}

const draftOf = (patch: Partial<QuickAddDraft> = {}): QuickAddDraft => ({
  ...quickAddDraftFromTodo(todoFixture()),
  ...patch
})

describe('速记与驳回弹窗的未保存输入（卡 6a595ad0）', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  /** 闸门自己先证明活着：路径写错时它会安静地"全绿"，那是最难查的失效形态 */
  it('基础数据解析成功（防止闸门因路径变化而假通过）', () => {
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')
    const board = read('src/renderer/components/kanban/KanbanBoard.tsx')
    const windows = read('src/main/windows.ts')
    expect(form.length).toBeGreaterThan(5000)
    expect(board.length).toBeGreaterThan(3000)
    expect(windows.length).toBeGreaterThan(10000)
    expect(form).toContain('useQuickAddRoute')
    expect(board).toContain('pendingReject')
    expect(windows).toContain('showQuickAdd')
  })

  // ───────────── 判据①：编辑中的内容不被替换 / 不被关闭（含失焦隐藏再回来） ─────────────

  it('①同一条再打开：主进程不再重新加载页面（实测重载会把填了一半的内容清掉）', () => {
    const win = stripComments(read('src/main/windows.ts'))
    expect(
      win,
      '复用分支必须按路由判断要不要加载 —— 无条件 loadQuickAdd 就是"每次打开都整页重载"'
    ).toContain(
      'if (\n        this.quickAddRouteOf(targetId, status, projectId, commentId) !== this.quickAddLoadedRoute\n      ) {'
    )
    expect(
      win,
      '加载过哪条路由要记下来，否则下次没法判断"变没变"'
    ).toContain('this.quickAddLoadedRoute = route')
    // 路由真的变了才加载：加载本身要还在（不能把这一句一起删了）
    expect(win).toContain('this.loadQuickAdd(win, targetId, status, projectId, commentId)')
    // 隐藏路径不许碰页面：hide 只是 hide，"关掉弹窗"不该等于"丢内容"
    const hideStart = win.indexOf('hideQuickAdd(): void {')
    expect(hideStart, '找不到 hideQuickAdd').toBeGreaterThan(-1)
    const hideBody = win.slice(hideStart, hideStart + 300)
    expect(hideBody, 'hideQuickAdd 里不该出现加载/重载').not.toContain('loadQuickAdd')
    expect(hideBody, 'hideQuickAdd 里不该出现加载/重载').not.toContain('loadRoute')
    // 反向验证：把那个 if 去掉（变回无条件 loadQuickAdd）→ 本条红。
  })

  it('①装载不再覆盖"有未保存修改"的表单（store 一刷新就会重跑这条 effect）', () => {
    const form = stripComments(read('src/renderer/components/quick-add/QuickAddForm.tsx'))
    expect(
      form,
      '装载前必须问一句"用户改过没有" —— 不问就是静默换回库里的旧值'
    ).toContain('if (dirtyRef.current) return')
    expect(form, '要有基准快照（判"改没改"就靠它）').toContain('const [baseline, setBaseline] = useState<QuickAddDraft | null>(null)')
    expect(form, '"此刻"的脏值要给装载 effect 读').toContain('dirtyRef.current = dirty')
    expect(form, '装载/恢复草稿/放弃草稿共用一条铺值路径').toContain('const applySnapshot = (s: QuickAddDraft) => {')
    // 反向验证：把 `if (dirtyRef.current) return` 删掉 → 本条红。
  })

  it('①换一条事项再回来：草稿能恢复，并且明说是"没保存的"、给了明确退路', () => {
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')
    const code = stripComments(form)
    expect(code, '装载时先看有没有草稿').toContain('const draft = readQuickAddDraft(routeParams)')
    expect(code, '草稿优先于库里的值').toContain('const loaded = draft ?? quickAddDraftFromTodo(todo)')
    expect(code, '有改动就落草稿（换一条是整页重载，内存里的活不过去）').toContain(
      'if (dirty) writeQuickAddDraft(routeParams, formNow)'
    )
    expect(code, '提交成功后草稿要清').toContain('clearQuickAddDraft(routeParams)')
    expect(form, '恢复出来的内容要说明来源（否则会被当成"库里就是这些"）').toContain(
      '已恢复上次没保存的修改（未提交）'
    )
    expect(form, '要给一条明确的退路').toContain('放弃这些修改')
    expect(code, '放弃 = 清草稿 + 回到库里那份').toContain('const discardDraft = () => {')
    // 反向验证：把提示行那段 JSX 删掉 → 本条红（"不吭声地恢复"正是卡里说的静默）。
  })

  it('①取消（关闭弹窗）不清草稿：取消是"先不编辑"，不是"这些字不要了"', () => {
    const code = stripComments(read('src/renderer/components/quick-add/QuickAddForm.tsx'))
    expect(code).toMatch(/const handleCancel = \(\) => \{\s*\n\s*invoke\('window:hideQuickAdd'\)\s*\n\s*\}/)
    const cancel = code.slice(code.indexOf('const handleCancel'))
    expect(cancel.slice(0, 200), 'handleCancel 里不该清草稿').not.toContain('clearQuickAddDraft')
    // 反向验证：在 handleCancel 里加一句 clearQuickAddDraft → 本条红。
  })

  it('①空表单失焦仍然自动让位（卡上的口径④：不改成"有内容就压在看板上"）', () => {
    const code = stripComments(read('src/renderer/components/quick-add/QuickAddForm.tsx'))
    expect(code, '失焦依然无条件收起，不按"空不空"分叉').toMatch(
      /if \(Date\.now\(\) - mountedAt < 300\) return\s*\n\s*invoke\('window:hideQuickAdd'\)/
    )
    // 反向验证：把失焦处理改成"有内容就不收起" → 本条红。
  })

  // ───────────── 判据②：驳回理由不丢 ─────────────

  it('②驳回理由按 todoId 留草稿：遮罩关掉再拖一次，理由原样回来', () => {
    const board = stripComments(read('src/renderer/components/kanban/KanbanBoard.tsx'))
    expect(board, '打开时把这条的理由读回来').toContain('React.useState(() => readRejectReason(todoId))')
    expect(board, '每一次输入都写穿到草稿（等到卸载再存就晚了）').toMatch(
      /const edit = \(v: string\) => \{\s*\n\s*setReason\(v\)\s*\n\s*writeRejectReason\(todoId, v\)/
    )
    expect(board, '输入框要走那条写穿').toContain('onChange={(e) => edit(e.target.value)}')
    expect(board, '要告诉用户这是上次那段').toContain('上次没提交的理由还在')
    expect(board, '要给"明确放弃"的入口').toContain('放弃这段理由')
    expect(board, '理由要按这条事项记，所以 id 得传进弹窗').toContain('todoId={pendingReject.id}')
    // 反向验证：把 onChange 改回 `setReason(e.target.value)` → 本条红。
  })

  it('②遮罩点击（onClose）不许清理由：那多半是"先不看这个"，不是"理由不要了"', () => {
    const board = stripComments(read('src/renderer/components/kanban/KanbanBoard.tsx'))
    const start = board.indexOf('{pendingReject && (')
    expect(start, '找不到驳回弹窗').toBeGreaterThan(-1)
    const block = board.slice(start, board.indexOf('</Dialog>', start))
    expect(block, '关掉弹窗仍然只是关掉').toContain('onClose={() => setPendingReject(null)}')
    expect(block, '关掉弹窗不许顺手动草稿').not.toContain('clearRejectReason')
    // 反向验证：在 onClose 里加 clearRejectReason → 本条红。
  })

  it('②提交成功才清草稿（它已经落成评论了）', () => {
    const board = stripComments(read('src/renderer/components/kanban/KanbanBoard.tsx'))
    const start = board.indexOf('const confirmReject = async')
    const body = board.slice(start, board.indexOf('const handlePin', start))
    expect(body).toContain('clearRejectReason(pending.id)')
    // 清草稿必须在"评论 + 流转"都成了之后
    expect(body.indexOf('clearRejectReason(pending.id)')).toBeGreaterThan(
      body.indexOf("await invoke('todo:addComment'")
    )
    // 反向验证：把这一句挪到 try 之前（失败也清）→ 与上面那条顺序断言冲突。
  })

  it('①提交成功后编辑模式不清空表单（"清空 + 等装载重跑"赌输就是打开看到空抽屉）', () => {
    const code = stripComments(read('src/renderer/components/quick-add/QuickAddForm.tsx'))
    const start = code.indexOf('clearQuickAddDraft(routeParams)')
    expect(start, '找不到提交成功后的草稿清理').toBeGreaterThan(-1)
    const block = code.slice(start, start + 600)
    expect(block, '编辑模式保留刚提交的内容').toContain('if (editingTodoId) {')
    expect(block, '基准置空 = 干净').toContain('setBaseline(null)')
    expect(block, '新增模式仍然回到空表单（记完一条接着记下一条）').toContain('resetForm()')
    // 反向验证：把 setBaseline(null) 换回 resetForm() → 本条红。
  })

  // ───────────── 判据③：成功提交只产生一条驳回评论 + 正确退回状态 ─────────────

  it('③驳回只写一条 reject 评论，并把状态退回进行中', () => {
    const board = stripComments(read('src/renderer/components/kanban/KanbanBoard.tsx'))
    const start = board.indexOf('const confirmReject = async')
    const body = board.slice(start, board.indexOf('const handlePin', start))
    expect(body.match(/kind: 'reject'/g)?.length, '一次驳回只该有一条 reject 评论').toBe(1)
    expect(body.match(/todo:addComment/g)?.length, '只该调一次写评论').toBe(1)
    expect(body).toMatch(/updateTodo\(\{ id: pending\.id, status: 'in_progress' \}\)/)
    expect(board.match(/kind: 'reject'/g)?.length, '整个看板文件里只该有这一处 reject 评论').toBe(1)
    // 反向验证：再补一条 addComment（比如"先流转再写理由"）→ 本条红。
  })

  // ───────────── 草稿模块的实际行为（真跑，不是读源码） ─────────────

  it('草稿按"哪一次打开"分开记：编辑按事项，新增按列 + 项目', () => {
    expect(quickAddRouteKey(editRoute('t-a'))).toBe('edit:t-a')
    expect(quickAddRouteKey(editRoute('t-b'))).not.toBe(quickAddRouteKey(editRoute('t-a')))
    expect(quickAddRouteKey(newRoute('todo', 'p-1'))).not.toBe(
      quickAddRouteKey(newRoute('in_progress', 'p-1'))
    )
    expect(quickAddRouteKey(newRoute('todo', 'p-1'))).not.toBe(
      quickAddRouteKey(newRoute('todo', 'p-2'))
    )
  })

  it('草稿写进 sessionStorage（不是内存）：换一条事项是整页重载，内存里的活不过去', () => {
    writeQuickAddDraft(editRoute('t-a'), draftOf({ title: '改了一半的标题' }))
    // "整页重载"在这个环境里等价于：只留得下存储里的东西
    const raw = window.sessionStorage.getItem(QUICK_ADD_DRAFT_KEY + 'edit:t-a')
    expect(raw, '草稿必须落在会话存储里，否则整页重载就一起没了').not.toBeNull()
    expect(raw).toContain('改了一半的标题')
    expect(readQuickAddDraft(editRoute('t-a'))?.title, '同一条回来要能读回原样').toBe('改了一半的标题')
  })

  it('一条事项的草稿不会串到另一条上', () => {
    writeQuickAddDraft(editRoute('t-a'), draftOf({ title: 'A 的草稿' }))
    expect(readQuickAddDraft(editRoute('t-b')), 'B 不该看见 A 的字').toBeNull()
    writeQuickAddDraft(editRoute('t-b'), draftOf({ title: 'B 的草稿' }))
    expect(readQuickAddDraft(editRoute('t-a'))?.title).toBe('A 的草稿')
    expect(readQuickAddDraft(editRoute('t-b'))?.title).toBe('B 的草稿')
    // 清掉一条不影响另一条
    clearQuickAddDraft(editRoute('t-a'))
    expect(readQuickAddDraft(editRoute('t-a'))).toBeNull()
    expect(readQuickAddDraft(editRoute('t-b'))?.title).toBe('B 的草稿')
  })

  it('判"改没改"：多值标签按内容比，不看数组引用', () => {
    const base = draftOf()
    const cloned: QuickAddDraft = { ...base, categoryIds: [...base.categoryIds] }
    expect(sameQuickAddDraft(base, cloned), '同样的内容不该被判成有修改').toBe(true)
    expect(sameQuickAddDraft(base, { ...base, title: '改了一个字' })).toBe(false)
    expect(sameQuickAddDraft(base, { ...base, categoryIds: ['c-2'] })).toBe(false)
    expect(sameQuickAddDraft(base, { ...base, description: '补了一段说明' })).toBe(false)
    // 只改了展开态也算改过（展开本身就是用户动作，不该被"重填"抹掉）
    expect(sameQuickAddDraft(base, { ...base, showDetail: !base.showDetail })).toBe(false)
  })

  it('装载基准与库里那条对得上：有详情/归属的那几个展开口径沿用原来那套', () => {
    const bare = quickAddDraftFromTodo(todoFixture({ categoryIds: [], categoryId: '' }))
    expect(bare.description, 'null 描述要落成空串（受控输入不能是 null）').toBe('')
    expect(bare.showDetail, '没有详情时不该展开').toBe(false)
    expect(bare.showOptions, '没有提醒 / 标签 / agent 归属时不该展开').toBe(false)
    expect(bare.status).toBe('todo')
    expect(bare.owner).toBe('human')
    expect(bare.executedBy).toBeNull()

    const plain = quickAddDraftFromTodo(todoFixture())
    expect(plain.showOptions, '挂了标签就要展开归属行（原口径之一）').toBe(true)

    const rich = quickAddDraftFromTodo(
      todoFixture({ description: '一段说明', dueAt: '2026-11-01', createdBy: 'agent:x' })
    )
    expect(rich.showDetail, '已有详细信息的任务，编辑时直接展开').toBe(true)
    expect(rich.showOptions, 'agent 提的事要展开归属行').toBe(true)
    expect(rich.owner).toBe('agent:x')
  })

  it('驳回理由：按 todoId 分开记，清干净就等于没有', () => {
    expect(readRejectReason('t-a'), '没写过就是空').toBe('')
    writeRejectReason('t-a', '这里没做完')
    writeRejectReason('t-b', '另一个理由')
    expect(readRejectReason('t-a')).toBe('这里没做完')
    expect(readRejectReason('t-b')).toBe('另一个理由')
    clearRejectReason('t-a')
    expect(readRejectReason('t-a')).toBe('')
    expect(readRejectReason('t-b'), '清一条不碰另一条').toBe('另一个理由')
    // 填了又删干净 = 没有理由（否则"空理由"会被当成一段没提交的输入冒出来）
    writeRejectReason('t-b', '')
    expect(readRejectReason('t-b')).toBe('')
  })

  it('坏数据与存储不可用都不许把界面弄崩（草稿只是多一层保险）', () => {
    // 不是 JSON / 形状不对（旧版本写的、手改过的）：当作没有草稿，而不是把表单带崩
    window.sessionStorage.setItem(QUICK_ADD_DRAFT_KEY + 'edit:t-a', '{不是 JSON')
    expect(readQuickAddDraft(editRoute('t-a'))).toBeNull()
    window.sessionStorage.setItem(QUICK_ADD_DRAFT_KEY + 'edit:t-a', JSON.stringify({ title: 1 }))
    expect(readQuickAddDraft(editRoute('t-a'))).toBeNull()
    // 状态认不出来同样不算数：它会喂给编辑模式那行状态按钮（STATUS_META 查不到就崩）
    window.sessionStorage.setItem(
      QUICK_ADD_DRAFT_KEY + 'edit:t-a',
      JSON.stringify({ ...draftOf(), status: '不存在的状态' })
    )
    expect(readQuickAddDraft(editRoute('t-a'))).toBeNull()

    // 存储本身取不到（隐私模式/沙箱）：读写都必须安静地退化成"没有草稿"
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled')
      }
    })
    try {
      expect(() => writeQuickAddDraft(editRoute('t-c'), draftOf())).not.toThrow()
      expect(readQuickAddDraft(editRoute('t-c'))).toBeNull()
      expect(() => writeRejectReason('t-c', '理由')).not.toThrow()
      expect(readRejectReason('t-c')).toBe('')
      expect(() => clearQuickAddDraft(editRoute('t-c'))).not.toThrow()
      expect(() => clearRejectReason('t-c')).not.toThrow()
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original)
      else Reflect.deleteProperty(window, 'sessionStorage')
    }
  })
})
