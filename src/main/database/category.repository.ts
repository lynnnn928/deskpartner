import { NotFoundError, UsageError, GuardError } from '../lib/domain-errors'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from './index'
import type { Category, CategoryCreateInput } from '../../renderer/types/category'
import { DEFAULT_CATEGORIES } from '../../renderer/lib/constants'

/** 分类标签数据仓库 */
export class CategoryRepository {
  private get db() {
    return getDatabase()
  }

  /**
   * 创建分类
   *
   * `id` 可选：默认自己生成，但**导入备份时必须允许指定** ——
   * 备份里的待办引用的是备份文件里的分类 id，导入时若不沿用同一个 id，
   * 待办就只能引用一个库里根本不存在的 id，插 `todo_categories` 时撞外键、
   * 被导入逻辑的 catch 静默吞掉，结果是"带标签的待办一条都进不来"。
   * 与 CreateProjectInput 允许指定 id 是同一个道理。
   *
   * `sortOrder` 可选（1.0.109，卡 `681528e5`）：**不传就由这条写语句取 `MAX+1`**。
   * 此前两个调用方各传"当前条数"——条数不是末尾：删掉或合并掉一个分类，条数会退回
   * 已经用过的值，新建的分类就和别人**撞序**，此后分类列表的顺序由 SQLite 的隐式行为定。
   * 默认值放在写语句里（`COALESCE(?, (SELECT …))`）：一条语句内算完，不与并发写打架；
   * 传了值仍照传的来（备份导入必须保住原来的顺序）。
   *
   * 返回值**回读**入库后的真实值：排序值可能是数据库算的，不能拿"我以为写了多少"当事实。
   */
  create(input: CategoryCreateInput): Category {
    const id = input.id?.trim() || uuidv4()
    this.db
      .prepare(
        `INSERT INTO categories (id, name, color, is_default, sort_order)
         VALUES (?, ?, ?, 0, COALESCE(?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories)))`
      )
      .run(id, input.name, input.color, input.sortOrder ?? null)
    return this.getById(id)!
  }

  /** 更新分类 */
  update(id: string, data: Partial<Pick<Category, 'name' | 'color'>>): Category {
    const existing = this.getById(id)
    if (!existing) {
      throw new NotFoundError(`[CategoryRepository] 分类不存在: ${id}`)
    }

    const updated: Category = {
      ...existing,
      name: data.name ?? existing.name,
      color: data.color ?? existing.color
    }

    this.db
      .prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?')
      .run(updated.name, updated.color, id)

    return updated
  }

  /**
   * 把 id 或 id 前缀解析成完整 id（1.0.48）
   *
   * 为什么必须有：`todo rm` 一直支持短号（`resolveId` 走前缀匹配），
   * 而 `category rm` 直接拿参数去 `getById` —— 精确匹配。于是Bob实测的
   * 那一幕（f159d799）出现了：它按卡片/看板上的 8 位短号发 `category rm`，
   * 四条全部走完授权流程、授权被记成 consumed、回执说成功，
   * **而分类一个都没少**。
   *
   * 根因不是"短号解析没做"，是 `delete()` 查不到时**静默返回 affectedTodos: 0**
   * 而不是报错 —— 假成功比报错贵得多：agent 以为做完了、
   * 人以为点了允许就生效了、审计账面上授权已经用掉了，三处同时被欺骗。
   *
   * 与 `TodoRepository.resolveId` 保持同一套语义（含危险字符拦截、
   * 前缀撞多条时报歧义而不是随便挑一个），免得两条命令对同一个输入
   * 给出不同结论。
   */
  resolveId(idOrPrefix: string): string {
    const hit = this.getById(idOrPrefix)
    if (hit) return hit.id

    // LIKE 的通配符不能出现在前缀里：`%` 会匹配全部行，库里恰好只有 1 条时
    // 就变成"一次笔误删掉仅有的数据"（同 todo.repository 的教训）
    if (/[%_\\]/.test(idOrPrefix)) {
      throw new UsageError(`[CategoryRepository] id 前缀不能包含 % _ \\ 这些字符: ${idOrPrefix}`)
    }

    const matches = this.db
      .prepare('SELECT id FROM categories WHERE id LIKE ?')
      .all(idOrPrefix + '%') as Array<{ id: string }>

    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new UsageError(
        `[CategoryRepository] id 前缀 "${idOrPrefix}" 匹配到 ${matches.length} 个分类，请写更长一些`
      )
    }
    throw new NotFoundError(`[CategoryRepository] 分类不存在: ${idOrPrefix}`)
  }

  /**
   * 删除分类（系统默认分类不可删除）
   *
   * v9 起分类是多值的，所以**删标签不再需要迁移待办** ——
   * 去掉一个标签，待办本身照常存在（它可能还带着别的标签）。
   * 关联记录由 `todo_categories` 的外键 CASCADE 自动清掉。
   *
   * 对比 v9 之前：那时分类是单值且 NOT NULL，删分类必然失败
   * （外键动作 SET NULL 会被 NOT NULL 拒绝），所以要先迁移待办。
   *
   * ⚠️ 查不到时**抛错**，不返回 0（1.0.48 修，Bob f159d799）。
   * 原实现 `if (!existing) return { affectedTodos: 0 }` 看着"宽容"，
   * 实际制造了假成功：调用方拿到正常返回值、退出码 0、授权被消费，
   * 而目标一条没动。传短号是触发它最常见的路径（getById 是精确匹配）。
   *
   * @returns 受影响的待办条数（有多少条待办失去了这个标签），供调用方提示
   */
  delete(id: string): { affectedTodos: number } {
    const resolved = this.resolveId(id)
    const existing = this.getById(resolved)
    if (!existing) {
      // resolveId 已经保证存在，走到这里说明并发删除；仍然明确报错
      throw new NotFoundError(`[CategoryRepository] 分类不存在: ${id}`)
    }

    if (existing.isDefault) {
      throw new GuardError('[CategoryRepository] 系统默认分类不可删除')
    }

    const { n: affected } = this.db
      .prepare(
        'SELECT COUNT(DISTINCT todo_id) AS n FROM todo_categories WHERE category_id = ?'
      )
      .get(resolved) as { n: number }

    this.db.prepare('DELETE FROM categories WHERE id = ?').run(resolved)
    return { affectedTodos: affected }
  }

  /**
   * 获取所有分类（按 sortOrder 排序）
   *
   * `, id ASC` 是兜底次序键（1.0.109，卡 `681528e5`）：历史库里**已经**有撞值的行
   * （来源是 `create` 修掉的那个"条数"），读的这一侧也得有定数 —— 只修写入，老数据照样抖。
   */
  list(): Category[] {
    const rows = this.db
      .prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC')
      .all() as Record<string, unknown>[]
    return rows.map(this.mapRow)
  }

  /**
   * 把 fromId 合并进 toId
   *
   * 合并 = 把 A 的所有待办转挂到 B 名下，然后删掉 A。
   *
   * **为什么必须有它**：多个 agent 各自往里记东西时，会各建各的标签
   * —— "竞争调研" 和 "竞品调研" 是同一个意思的两个标签。
   * 只能删不能并的话，用户要么忍受标签爆炸，要么删掉一个、
   * 那些待办就变成没标签的孤儿。合并是收拾同义标签的唯一手段。
   *
   * **多值下的关键细节**：v9 起一条待办可以挂多个标签，所以 A∪B 的交集
   * 会产生重复关联。`INSERT OR IGNORE` 正是为此 —— 靠
   * `todo_categories(todo_id, category_id)` 的主键把重复挡掉，
   * 既不用先查一遍，也不会因为重复键让整个事务回滚。
   *
   * 若没有这条联合主键（或者用 `INSERT` 不加 OR IGNORE），
   * 合并任何一条"同时带着 A 和 B"的待办都会直接报错，
   * 而这种待办恰恰是合并时最常见的。
   *
   * @returns 转移了多少条待办、被删掉的分类
   */
  merge(fromId: string, toId: string): { movedTodos: number; merged: Category } {
    if (fromId === toId) {
      throw new UsageError('[CategoryRepository] 不能把分类合并到它自己')
    }

    const from = this.getById(fromId)
    const to = this.getById(toId)
    if (!from) throw new NotFoundError(`[CategoryRepository] 要合并的分类不存在: ${fromId}`)
    if (!to) throw new NotFoundError(`[CategoryRepository] 目标分类不存在: ${toId}`)
    if (from.isDefault) {
      throw new GuardError('[CategoryRepository] 系统默认分类不可被合并掉')
    }

    const run = this.db.transaction(() => {
      // 先看有多少条待办会真正"改挂"（只带 A 不带 B 的那些）
      const { n: moved } = this.db
        .prepare(
          `SELECT COUNT(DISTINCT todo_id) AS n FROM todo_categories WHERE category_id = ?`
        )
        .get(fromId) as { n: number }

      /**
       * OR IGNORE 是这里的关键：
       * 同时带着 A 和 B 的待办，转挂时会撞上联合主键，
       * IGNORE 让它安静跳过，而不是让整批写入失败。
       */
      this.db
        .prepare(
          `INSERT OR IGNORE INTO todo_categories (todo_id, category_id)
           SELECT todo_id, ? FROM todo_categories WHERE category_id = ?`
        )
        .run(toId, fromId)

      this.db.prepare('DELETE FROM categories WHERE id = ?').run(fromId)
      return moved
    })

    const movedTodos = run()
    return { movedTodos, merged: from }
  }

  /** 重置分类排序 */
  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
    const transaction = this.db.transaction(() => {
      ids.forEach((id, index) => {
        stmt.run(index, id)
      })
    })
    transaction()
  }

  /** 根据 ID 获取分类 */
  getById(id: string): Category | null {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRow(row) : null
  }

  /** 初始化默认分类（首次启动时调用） */
  initializeDefaults(): void {
    const existing = this.list()
    if (existing.length > 0) return

    const stmt = this.db.prepare(
      `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
    )
    const transaction = this.db.transaction(() => {
      DEFAULT_CATEGORIES.forEach((cat, index) => {
        const id = uuidv4()
        stmt.run(id, cat.name, cat.color, 1, cat.sortOrder ?? index)
      })
    })
    transaction()
  }

  /** 将数据库行映射为 Category 对象 */
  private mapRow(row: Record<string, unknown>): Category {
    return {
      id: row.id as string,
      name: row.name as string,
      color: row.color as string,
      isDefault: Boolean(row.is_default),
      sortOrder: row.sort_order as number
    }
  }
}
