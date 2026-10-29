import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Todo, CreateTodoInput, UpdateTodoInput } from '../types/todo'
import type { TodoStatus } from '../types/enums'
import { invoke, on } from '../lib/ipc-client'

/** 批量执行里没成的那条：带上标题与原因，"哪几条没成"才说得清 */
export interface BatchFailure {
  id: string
  title: string
  reason: string
}

interface TodoState {  todos: Todo[]
  loading: boolean
  error: string | null

  // 操作
  fetchTodos: (filter?: { status?: TodoStatus; categoryId?: string; keyword?: string }) => Promise<void>
  createTodo: (input: CreateTodoInput) => Promise<Todo>
  updateTodo: (input: UpdateTodoInput) => Promise<Todo>
  deleteTodo: (id: string) => Promise<void>
  batchUpdateStatus: (ids: string[], status: TodoStatus) => Promise<void>
  /**
   * 批量改 / 批量删（2026-09-24 主用户拍板）
   *
   * 返回值**必须原样带回界面**：批量最容易糊掉的就是"哪几条没成" ——
   * 所以不在这里乐观更新，服务端说成了哪几条就是哪几条，失败的连原因一起交给调用方。
   */
  batchUpdate: (
    ids: string[],
    patch: Omit<UpdateTodoInput, 'id'>
  ) => Promise<{ updated: string[]; failed: BatchFailure[] }>
  batchDelete: (ids: string[]) => Promise<{ deleted: string[]; failed: BatchFailure[] }>

  // 乐观更新辅助
  setTodos: (todos: Todo[]) => void
}

export const useTodoStore = create<TodoState>()(
  subscribeWithSelector((set, get) => ({
    todos: [],
    loading: false,
    error: null,

    fetchTodos: async (filter) => {
      set({ loading: true, error: null })
      try {
        const todos = await invoke('todo:list', filter ?? {})
        set({ todos, loading: false })
      } catch (e) {
        set({ error: (e as Error).message, loading: false })
      }
    },

    createTodo: async (input) => {
      const todo = await invoke('todo:create', input)
      set((s) => ({ todos: [...s.todos, todo] }))
      return todo
    },

    updateTodo: async (input) => {
      const updated = await invoke('todo:update', input)
      set((s) => ({
        todos: s.todos.map((t) => (t.id === updated.id ? updated : t))
      }))
      return updated
    },

    deleteTodo: async (id) => {
      await invoke('todo:delete', { id })
      set((s) => ({ todos: s.todos.filter((t) => t.id !== id) }))
    },

    batchUpdateStatus: async (ids, status) => {
      await invoke('todo:batchUpdateStatus', { ids, status })
      set((s) => ({
        todos: s.todos.map((t) => (ids.includes(t.id) ? { ...t, status } : t))
      }))
    },

    batchUpdate: async (ids, patch) => {
      const r = await invoke('todo:batchUpdate', { ids, patch })
      // 主进程已广播 dataChanged，这里再拉一次是为了让调用方能立刻拿到一致的数据
      await get().fetchTodos()
      return r
    },

    batchDelete: async (ids) => {
      const r = await invoke('todo:batchDelete', { ids })
      await get().fetchTodos()
      return r
    },

    setTodos: (todos) => set({ todos })
  }))
)

// 监听主进程数据变更事件，自动刷新
if (typeof window !== 'undefined' && window.api) {
  on('event:dataChanged', (data) => {
    if (data.type === 'todo') {
      useTodoStore.getState().fetchTodos()
    }
  })
}
