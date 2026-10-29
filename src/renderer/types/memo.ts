/**
 * 备忘（memo）——AI 给人递的纸条，不是待办
 *
 * 与 main 侧 MemoRepository 的 Memo 同形（renderer 类型独立声明，
 * 与 todo.ts / category.ts 的跨层约定一致，避免 renderer 编译单元拉入 main 文件）。
 */
export interface Memo {
  id: string
  /** 归属标注，与 todos.created_by 同约定：human / agent:<id> */
  author: string
  text: string
  /** 关联的待办（可选）；待办删除时置空，备忘本身仍成立 */
  linkedTodoId: string | null
  /** unread | read */
  status: 'unread' | 'read'
  createdAt: string
  readAt: string | null
}
