/** 分类标签 */
export interface Category {
  id: string
  name: string
  color: string
  isDefault: boolean
  sortOrder: number
}

/**
 * 新建分类的入参（1.0.109，卡 `681528e5`）
 *
 * `sortOrder` **可以不传**：省略即由仓储按 `MAX(sort_order)+1` 追加到末尾。
 * 别传 `list().length` —— 那是"条数"不是"末尾"，删过 / 合并过分类之后就会与已有的撞值。
 */
export type CategoryCreateInput = Omit<Category, 'id' | 'isDefault' | 'sortOrder'> & {
  id?: string
  sortOrder?: number
}
