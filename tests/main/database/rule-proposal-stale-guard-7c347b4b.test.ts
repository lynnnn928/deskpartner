/**
 * 协作规则提议的采纳必须比对基准版本（卡 7c347b4b，评审第 2 条）
 *
 * ── 缺陷 ──
 * `propose()` 把 `base_updated_at` 存成**提交时刻**（`nowVersion()`），而采纳时
 * 完全不比对（`decideProposal` 直接调 `saveRule`）。于是：
 * 提议 → 别人改了同一条规则 → 采纳，**别人那次改动被静默盖掉**，
 * 回执上还是一次"成功"。
 *
 * 档案（`profile.repository.ts`）和协议（`protocol.repository.ts`）采纳时都做了
 * "基准版本 vs 当前版本"的比对，冲突直接拒绝 —— 规则这条抄漏了。
 *
 * 这里钉住三件事：
 * ① 提议后规则被别人改过 → 采纳被拒，别人的改动留在库里；
 * ② 没人动过 → 采纳照常成功（不能修成"一律拒绝"）；
 * ③ 提议时目标层还没有覆盖（基准是空档）→ 之后别人补上了，同样算冲突。
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'

let activeDb: Database.Database
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => activeDb
}))

const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-rule-stale-'))

afterAll(() => {
  try {
    if (activeDb?.open) activeDb.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 临时 fixture 清理失败不掩盖断言 */
  }
})

function freshDb(): Database.Database {
  const source = new Database(':memory:')
  runMigrations(source)
  activeDb = source
  return source
}

const enforcementOf = (repo: InstanceType<typeof RulesRepository>, scope: any, key: string) =>
  repo.listRules(scope).find((r) => r.key === key)?.enforcement

describe('协作规则提议：采纳前比对基准版本', () => {
  it('提议后规则被别人改过 → 采纳被拒，别人的改动保留', () => {
    freshDb()
    const repo = new RulesRepository()

    repo.saveRule({ scope: 'global' }, 'G10', 'notice', 'human:alice')
    const proposal = repo.propose({ scope: 'global' }, 'G10', 'off', 'agent:test')

    // 有人（主用户）在提议之后又改了同一条规则
    repo.saveRule({ scope: 'global' }, 'G10', 'block', 'human:bob')

    expect(() => repo.decideProposal(proposal.id, 'approved', 'human:alice')).toThrow(/已发生变化/)
    // 别人的改动不能被盖掉
    expect(enforcementOf(repo, { scope: 'global' }, 'G10')).toBe('block')
    // 提议仍是待处理：人要能重新核对后再决定
    expect(repo.listProposals('pending').map((p) => p.id)).toContain(proposal.id)
  })

  it('没人动过 → 采纳照常成功', () => {
    freshDb()
    const repo = new RulesRepository()

    repo.saveRule({ scope: 'global' }, 'G10', 'notice', 'human:alice')
    const proposal = repo.propose({ scope: 'global' }, 'G10', 'off', 'agent:test')

    const decided = repo.decideProposal(proposal.id, 'approved', 'human:alice')
    expect(decided.status).toBe('approved')
    expect(enforcementOf(repo, { scope: 'global' }, 'G10')).toBe('off')
  })

  it('提议时该层还没有覆盖 → 别人随后补了覆盖，同样算冲突', () => {
    freshDb()
    const repo = new RulesRepository()
    const project = new ProjectRepository().create({ name: '规则冲突项目' })
    const scope = { scope: 'project' as const, projectId: project.id }

    // 项目层没有任何覆盖，基准是空档
    const proposal = repo.propose(scope, 'G10', 'off', 'agent:test')
    repo.saveRule(scope, 'G10', 'notice', 'human:bob')

    expect(() => repo.decideProposal(proposal.id, 'approved', 'human:alice')).toThrow(/已发生变化/)
    expect(enforcementOf(repo, scope, 'G10')).toBe('notice')
  })
})
