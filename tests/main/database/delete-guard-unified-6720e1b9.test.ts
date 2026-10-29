import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { ENTITIES_WITH_PROPOSED } from '../../../src/main/database/proposed-guards'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 删除守卫共用层（`6720e1b9`）：有「待确认」态的实体统一拦，无的不误拦
 *
 * ## 它治的病
 *
 * G4 断言此前是 TodoRepository 私有方法，安全口径按实体分裂：todo rm 有守卫、
 * project rm 没有。但照提单选项①「所有实体统一」也会出病：category / release
 * 这类**没有待确认态**的实体被挂上「删除前确认」等于拦空气。
 *
 * ## 判据（修正版①'）
 *
 * 1. 守卫提共用层 `proposed-guards.ts`，单一实现；
 * 2. **按「实体有没有未确认态」决定挂不挂**，单源 `ENTITIES_WITH_PROPOSED`；
 * 3. 结构闸门：清单里每个实体的 delete 必须调共用守卫 —— 这是提单
 *    「不选会怎样：新增实体时继续漏挂」的正面反制。
 *
 * 反向验证（已实测）：把 todo.repository delete 调用点的守卫摘掉 → 闸门用例红；
 * 把 project.repository delete 里塞进守卫调用 → 「不误拦」用例红（若守卫生效）。
 */
describe('删除守卫共用层：有未确认态实体统一拦截、无未确认态不误拦（6720e1b9）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM releases').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    todos = new TodoRepository()
  })

  it('单源清单不许空：有未确认态的实体必须登记在 ENTITIES_WITH_PROPOSED', () => {
    expect(ENTITIES_WITH_PROPOSED).toContain('todo')
  })

  it('【结构闸门】清单里每个实体的 delete 都必须调共用守卫（防新增漏挂）', () => {
    const files: Record<string, string> = {
      todo: 'todo.repository.ts'
    }
    for (const entity of ENTITIES_WITH_PROPOSED) {
      const file = files[entity]
      expect(file, `实体 ${entity} 没有映射到 repository 文件 —— 闸门清单缺项`).toBeTruthy()
      const src = readFileSync(join(process.cwd(), 'src', 'main', 'database', file), 'utf8')
      // delete 函数体里必须调到共用守卫（删掉调用这条就红）
      const deleteIdx = src.indexOf('  delete(')
      expect(deleteIdx, `${file} 找不到 delete 函数`).toBeGreaterThan(-1)
      const body = src.slice(deleteIdx, deleteIdx + 1200)
      expect(
        body,
        `${entity} 的 delete 没调共用守卫 —— 新增实体继续漏挂的正是这个形状`
      ).toContain('assertConfirmedBeforeLeavingProposed')
    }
  })

  it('【结构闸门】共用实现只许有一份：repository 不许养私有第二实现', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'main', 'database', 'todo.repository.ts'),
      'utf8'
    )
    // 从共用层 import（而不是自己实现一份）
    expect(src).toContain("from './proposed-guards'")
    // 私有实现不许回来
    expect(src).not.toContain('private assertConfirmedBeforeLeavingProposed')
  })

  it('逐实体实测同一条删除路径：proposed todo 被拦、其余照常删得动', () => {
    // ① proposed todo → 拦（守卫在）
    const t = todos.create({
      title: '待确认的',
      projectId: null,
      status: 'proposed',
      createdBy: 'agent:qwen'
    } as never)
    expect(() => todos.delete(t.id, 'cli', 'agent:alice')).toThrow(/G4/)

    // ② 非 proposed todo → 删得动（守卫不误伤正常删除）
    const t2 = todos.create({ title: '普通的', projectId: null, status: 'todo' } as never)
    expect(() => todos.delete(t2.id, 'cli', 'agent:alice')).not.toThrow()

    // ③ project（无待确认态）→ 删得动，不被误拦
    // ⚠️ 1.0.111 起"本机最后一个项目"会被拒（事项必须归项目），所以留一个陪跑的
    const projectRepo = new ProjectRepository()
    const p = projectRepo.create({ name: '要删的项目' })
    projectRepo.create({ name: '陪跑的项目' })
    expect(() => projectRepo.delete(p.id)).not.toThrow()

    // ④ category（无待确认态）→ 删得动
    const cats = new CategoryRepository()
    const c = cats.create({ name: '要删的分类', color: '#222', sortOrder: 1 })
    expect(() => cats.delete(c.id)).not.toThrow()

    // ⑤ release（无待确认态）→ 删得动（a2ea95f8：版本必挂项目，删除按 (项目, 版本号) 定位）
    // 项目自建（不复用 ③ 的 p —— 它在 ③ 已删，挂上去就是悬空引用）
    const rel = new ReleaseRepository()
    const rp = new ProjectRepository().create({ name: '版本挂靠的项目' })
    rel.create({ version: '9.9.9', summary: '测试用', projectId: rp.id })
    expect(() => rel.delete(rp.id, '9.9.9')).not.toThrow()
  })
})
