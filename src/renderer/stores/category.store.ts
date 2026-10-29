import { create } from 'zustand'
import type { Category, CategoryCreateInput } from '../types/category'
import { invoke, on } from '../lib/ipc-client'

/** 分类颜色缺失时的兜底色（中性灰） */
const FALLBACK_CATEGORY_COLOR = '#CBD5E1'

interface CategoryState {
  categories: Category[]
  loading: boolean

  fetchCategories: () => Promise<void>
  createCategory: (input: CategoryCreateInput) => Promise<Category>
  updateCategory: (id: string, data: Partial<Pick<Category, 'name' | 'color'>>) => Promise<Category>
  deleteCategory: (id: string) => Promise<void>
  /** 把 fromId 并进 toId；返回转挂了多少条待办 */
  mergeCategory: (fromId: string, toId: string) => Promise<number>
  reorderCategories: (ids: string[]) => Promise<void>

  /** 按 id 取分类名称，找不到返回空串 */
  getCategoryName: (id: string) => string
  /** 按 id 取分类颜色，找不到返回兜底色 */
  getCategoryColor: (id: string) => string
}

export const useCategoryStore = create<CategoryState>()((set, get) => ({
  categories: [],
  loading: false,

  fetchCategories: async () => {
    set({ loading: true })
    try {
      const categories = await invoke('category:list')
      set({ categories, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  createCategory: async (input) => {
    const category = await invoke('category:create', input)
    set((s) => ({ categories: [...s.categories, category] }))
    return category
  },

  updateCategory: async (id, data) => {
    const updated = await invoke('category:update', { id, ...data })
    set((s) => ({
      categories: s.categories.map((c) => (c.id === updated.id ? updated : c))
    }))
    return updated
  },

  deleteCategory: async (id) => {
    await invoke('category:delete', { id })
    set((s) => ({ categories: s.categories.filter((c) => c.id !== id) }))
  },

  mergeCategory: async (fromId, toId) => {
    const result = await invoke('category:merge', { fromId, toId })
    set((s) => ({ categories: s.categories.filter((c) => c.id !== fromId) }))
    return result.movedTodos
  },

  reorderCategories: async (ids) => {
    await invoke('category:reorder', { ids })
  },

  getCategoryName: (id) => get().categories.find((c) => c.id === id)?.name ?? '',
  getCategoryColor: (id) =>
    get().categories.find((c) => c.id === id)?.color ?? FALLBACK_CATEGORY_COLOR
}))

// 监听数据变更
if (typeof window !== 'undefined' && window.api) {
  on('event:dataChanged', (data) => {
    if (data.type === 'category') {
      useCategoryStore.getState().fetchCategories()
    }
  })
}
