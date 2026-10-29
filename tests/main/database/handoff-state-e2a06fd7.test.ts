import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import {
  HANDOFF_STALE_AFTER_DAYS,
  markHandoffDirty
} from '../../../src/main/database/handoff-state'

/**
 * 卡 `e2a06fd7`：接手状态模型（自动事实 / 覆盖声明 / 新鲜度）。
 *
 * ## 病
 *
 * 接手说明是一段无人负责的 Markdown：DeskPartner 的说明写着 1.0.97 / schema v42，
 * 而实际已是 1.0.124 —— 落后十二个版本，首读的人看不出来（卡 `607871b2` 的现场证据）。
 *
 * ## 本文件钉四件事
 *
 * ① **三态可区分**：fresh / review_required / stale，且每条都带"为什么"；
 * ② **快照是保存那一刻的事实**：版本、schema、主线都记进去，旧行没有就是"无法核对"；
 * ③ **待复核按项目一条、按原因去重**：同一批不重复写，内容保存后自动清掉；
 * ④ **触发器不改正文**：发布与提议被拒只标标记，叙述权仍归人。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const projectRepo = new ProjectRepository()
const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const releaseRepo = new ReleaseRepository()

let projectId = ''
let categoryId = ''

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM project_handoff_revisions').run()
  db.prepare('DELETE FROM project_handoff_proposals').run()
  db.prepare('DELETE FROM releases').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.initializeDefaults()
  categoryId = categoryRepo.list()[0].id
  projectId = projectRepo.create({ name: '状态模型项目' }).id
})

function addTodo(title: string, status: 'todo' | 'in_progress' | 'awaiting_review' | 'proposed' | 'done', priority: 'urgent' | 'high' | 'normal' = 'normal') {
  return todoRepo.create({
    title,
    categoryIds: [categoryId],
    projectId,
    status,
    priority,
    skipGuards: true
  }).id
}

describe('接手状态的判据（卡 e2a06fd7）', () => {
  it('没有说明 → stale，理由说清楚"还没有"', () => {
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.state).toBe('stale')
    expect(state.freshness.reasons).toEqual(['还没有接手说明'])
    expect(state.handoff.coverage).toBeNull()
  })

  it('保存一版 → 覆盖声明记下当时的版本 / schema / 主线；状态 fresh', () => {
    const mainId = addTodo('主线事项', 'todo', 'high')
    projectRepo.saveHandoff(projectId, '项目背景与当前主线', 'agent:writer', undefined, {
      version: '1.0.1'
    })
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.state).toBe('fresh')
    expect(state.freshness.reasons).toEqual([])
    expect(state.handoff.coverage).toMatchObject({ version: '1.0.1', mainTodoId: mainId })
    expect(state.handoff.confirmedBy).toBe('agent:writer')
    expect(state.facts.schemaVersion).toBe(DB_VERSION)
    expect(state.facts.openTotal).toBe(1)

    const rev = projectRepo.listHandoffRevisions(projectId)[0]
    expect(rev.confirmedBy).toBe('agent:writer')
  })

  it('版本变了 → review_required，理由点名两侧版本', () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.2' })
    expect(state.freshness.state).toBe('review_required')
    expect(state.freshness.reasons.join(' / ')).toContain('1.0.1')
    expect(state.freshness.reasons.join(' / ')).toContain('1.0.2')
  })

  it('主线换了 → review_required，理由说"从谁到谁"', () => {
    addTodo('老主线', 'todo', 'high')
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })
    addTodo('新主线', 'in_progress', 'urgent')
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.state).toBe('review_required')
    expect(state.freshness.reasons.join(' / ')).toContain('主线换了')
    expect(state.freshness.reasons.join(' / ')).toContain('新主线')
  })

  it('旧版说明（没有事实快照）→ review_required，不假装能核对', () => {
    // create 时带说明：会写一条基线修订，但没有 facts_snapshot（等同 v47 之前的行）
    const legacy = projectRepo.create({ name: '旧项目', handoffMarkdown: '很久以前写的说明' }).id
    const state = projectRepo.getHandoffState(legacy, { version: '1.0.1' })
    expect(state.freshness.state).toBe('review_required')
    expect(state.freshness.reasons.join(' / ')).toContain('没有事实快照')
    expect(state.handoff.coverage).toBeNull()
  })

  it('待复核标记：同一批只写一次；内容保存后自动清掉', () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })
    expect(markHandoffDirty(db, projectId, '发布了 1.0.2')).toBe(true)
    expect(markHandoffDirty(db, projectId, '发布了 1.0.2'), '同一批变化不该再写一条').toBe(false)
    const marked = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(marked.freshness.state).toBe('review_required')
    expect(marked.freshness.reasons).toContain('发布了 1.0.2')
    expect(marked.freshness.dirty?.reasons).toEqual(['发布了 1.0.2'])

    projectRepo.saveHandoff(projectId, '背景（已更新）', 'human', undefined, { version: '1.0.1' })
    const cleared = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(cleared.freshness.dirty).toBeNull()
    expect(cleared.freshness.state).toBe('fresh')
  })

  it('待复核挂过 7 天 → stale（挂着没人管本身是状态，要说出来）', () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })
    const old = new Date(Date.now() - (HANDOFF_STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000)
    markHandoffDirty(db, projectId, '发布了 0.9.0', old)
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.state).toBe('stale')
    expect(state.freshness.reasons.join(' / ')).toContain('超过 7 天')
  })

  it('发布 → 自动标"待复核"，且不改正文', () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })
    releaseRepo.create({ version: '1.0.2', projectId, summary: '发一版' })
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.state).toBe('review_required')
    expect(state.freshness.reasons.join(' / ')).toContain('发布了 1.0.2')
    expect(projectRepo.getById(projectId)?.handoffMarkdown).toBe('背景')
  })

  it('项目级协作方式变化 → 标待复核；全局变化不标（卡 233cd5f6）', () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })

    new ProtocolRepository().save({ scope: 'project', projectId }, 'roles', '项目里的角色分工', 'human')
    let state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.reasons.join(' / ')).toContain('项目协作协议有更新（roles）')

    projectRepo.saveHandoff(projectId, '背景（改过）', 'human', undefined, { version: '1.0.1' })
    new RulesRepository().saveRule({ scope: 'project', projectId }, 'G10', 'notice', 'human')
    state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.reasons.join(' / ')).toContain('项目协作规则有更新（G10）')

    projectRepo.saveHandoff(projectId, '背景（再改）', 'human', undefined, { version: '1.0.1' })
    new ProfileRepository().save({ scope: 'project', projectId }, 'boundaries', '项目边界', 'human')
    state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.reasons.join(' / ')).toContain('项目档案有更新（boundaries）')

    // 全局变化与这个项目的接手说明无关：保存后不该再亮
    projectRepo.saveHandoff(projectId, '背景（清标记）', 'human', undefined, { version: '1.0.1' })
    new ProtocolRepository().save({ scope: 'global' }, 'roles', '全局角色分工', 'human')
    state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.dirty).toBeNull()
  })

  it('提议带事实快照与来源事项；被拒后仍留待复核', () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '1.0.1' })
    const mainId = addTodo('提议时的主线', 'in_progress', 'high')
    const proposal = projectRepo.proposeHandoff(projectId, '新的说明', 'agent:writer', {
      version: '1.0.1'
    })
    expect(proposal.factsSnapshot?.version).toBe('1.0.1')
    expect(proposal.factsSnapshot?.mainTodo?.id).toBe(mainId)
    expect(proposal.sourceTodoIds).toContain(mainId)

    // 提议挂起期间版本与主线变化：listHandoffProposals 同时带回提交时快照与当前事实（卡 b83f9476）
    const nextMainId = addTodo('后来新加的紧急主线', 'in_progress', 'urgent')
    const listed = projectRepo.listHandoffProposals('pending', { version: '1.0.2' })
    expect(listed).toHaveLength(1)
    expect(listed[0].factsSnapshot?.version).toBe('1.0.1')
    expect(listed[0].factsSnapshot?.mainTodo?.id).toBe(mainId)
    expect(listed[0].currentFacts?.version).toBe('1.0.2')
    expect(listed[0].currentFacts?.mainTodo?.id).toBe(nextMainId)

    projectRepo.decideHandoffProposal(proposal.id, 'rejected', 'human', undefined, {
      version: '1.0.1'
    })
    const state = projectRepo.getHandoffState(projectId, { version: '1.0.1' })
    expect(state.freshness.state).toBe('review_required')
    expect(state.freshness.reasons.join(' / ')).toContain('提议被拒')
  })
})
