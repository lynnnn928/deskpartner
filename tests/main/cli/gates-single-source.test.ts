import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { GATES, gateById, renderGatesTable } from '../../../src/main/cli/gates'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 关口清单进 schema（1.0.72 修 `917390e0` 的 #5 / #6，qwen 驳回）
 *
 * qwen 实测的驳回理由成立且本版复现：关口只存在于说明书那张 Markdown 表里，
 * `schema` 全文搜 G10 得 0 次。而 agent 唯一会主动读的是 schema。
 *
 * 修法不是"把表抄进 schema"—— 那会多一份真相，而手写那份已经与实装相反过一次
 * （G10 的"必须人点头"在 1.0.67 已改成"验收者 ≠ 执行者"）。
 * 而是 `GATES` 一份定义，schema 与说明书都从它渲染。
 */
function makeCtx() {
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo: new ProjectRepository(),
      memoRepo: { list: () => [], add: () => ({ id: 'm1' }), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: {
        get: () => null,
        register: () => null,
        list: () => [],
        touch: () => null,
        setApproved: () => null,
        remove: () => null,
        issueCredential: () => null,
        verifyCredential: () => false,
        requestGrant: () => ({ id: 'g1' }),
        findUsableGrant: () => null,
        findAnyUsableGrant: () => null,
        findLatestGrant: () => null,
        consumeGrant: () => null,
        listGrants: () => [],
        revokeGrants: () => 0,
        getGrant: () => null,
        markWrite: () => null
      },
      settingsRepoOverrides: {},
      notificationRepo: { list: () => [], add: () => null, listFor: () => [], markReadBy: () => null },
      commentRepo: { list: () => [], listWaitingFor: () => [], add: () => null },
      eventsRepo: { add: () => null, list: () => [] },
      telemetryRepo: { add: () => null },
      memoReadRepo: {}
    },
    flags: {},
    isInteractive: false,
    env: {},
    dryRun: false
  } as never
}

describe('关口清单是唯一真相（917390e0 #5/#6）', () => {
  beforeAll(() => {
    runMigrations(db)
  })
  beforeEach(() => {
    db.exec('DELETE FROM todos')
  })

  it('schema 输出里带 gates，且条数与定义一致（qwen 搜 G10 得 0 次的那个缺口）', async () => {
    const r = (await executeOne(makeCtx(), ['schema'])) as {
      ok: boolean
      data: { gates?: { id: string }[] }
    }
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.data.gates), 'schema 里没有 gates 键 —— agent 拿不到关口清单').toBe(true)
    expect(r.data.gates!.length).toBe(GATES.length)
    expect(r.data.gates!.length).toBeGreaterThan(0)
  })

  it('G10 必须在 schema 里，且写的是角色定权（不是"必须人点头"）', async () => {
    const r = (await executeOne(makeCtx(), ['schema'])) as {
      data: { gates: { id: string; what: string; notes?: string }[] }
    }
    const g10 = r.data.gates.find((g) => g.id === 'G10')
    expect(g10, 'schema 里找不到 G10').toBeTruthy()
    // 这条是 1.0.67 的语义变更点，抄旧注释就会写成"一律只能人点"（与实装相反）
    expect(g10!.what, 'G10 的描述与 1.0.67 之后的实装不符').toContain('执行者')
    expect(g10!.what).not.toContain('人点')
  })

  it('每条关口都有可编程信号：强度 / 退出码 / 该做什么', () => {
    for (const g of GATES) {
      expect(['block', 'authorize', 'notice'], `${g.id} 的 enforcement 非法`).toContain(g.enforcement)
      expect(typeof g.exitCode, `${g.id} 缺 exitCode`).toBe('number')
      expect(g.doThis.trim().length, `${g.id} 没写"该怎么做" —— agent 撞了不知道怎么办`).toBeGreaterThan(0)
      expect(g.what.trim().length, `${g.id} 没写守什么`).toBeGreaterThan(0)
    }
  })

  /**
   * 软提醒的退出码必须是 0，硬拦必须是 4 —— 写反了 agent 就会重试一个
   * 不可能成功的操作，或反过来不敢重试。
   */
  it('强度与退出码必须自洽（软提醒=0，硬拦/转授权=4，项目必填=2）', () => {
    for (const g of GATES) {
      if (g.enforcement === 'notice') {
        expect(g.exitCode, `${g.id} 是软提醒，退出码必须是 0`).toBe(0)
        expect(g.errorCode, `${g.id} 软提醒不该有 errorCode`).toBeNull()
      }
      if (g.enforcement === 'block' || g.enforcement === 'authorize') {
        expect(g.exitCode, `${g.id} 是硬拦/转授权，退出码不该是 0`).not.toBe(0)
        expect(g.errorCode, `${g.id} 硬拦必须给 errorCode（否则脚本无法按类型分流）`).toBeTruthy()
      }
    }
  })

  it('G11/G12 这类不存在的关口不许进清单（代码注释里提过"将来自动生效"）', () => {
    const ids = GATES.map((g) => g.id)
    expect(ids, '清单里出现了代码里不存在的关口 —— 那是一条假承诺').not.toContain('G11')
    expect(ids).not.toContain('G12')
  })

  it('gateById 能按编号取到，供文案与测试引用（避免各处硬写字符串）', () => {
    expect(gateById('G10')?.enforcement).toBe('block')
    expect(gateById('G3')?.enforcement).toBe('notice')
    expect(gateById('G99')).toBeUndefined()
  })

  /**
   * 说明书那节必须**从 GATES 渲染**，不是手写第二遍。
   *
   * 判据：手写的那份已经与实装相反过一次，而 markdown 表格不会报错。
   * 这条断言盯的是"渲染"这个动作 —— 渲染函数坏掉时说明书会缺整张表。
   */
  it('说明书从 GATES 渲染（不是手写第二遍）', () => {
    const guide = buildAgentGuide('C:/x/dp.cmd', '9.9.9')
    for (const g of GATES) {
      // 每条关口的核心语义都要出现在说明书里
      const key = g.what.slice(0, 8)
      expect(guide.includes(key), `说明书缺关口 ${g.id}：${g.what}`).toBe(true)
    }
  })

  it('渲染进模板字符串时反引号被转义（否则生成的 SKILL.md 直接语法错误）', () => {
    const raw = renderGatesTable()
    expect(raw, '裸反引号进模板字符串会提前闭合模板').toContain('`notice`')
    const escaped = renderGatesTable({ escapeBackticks: true })
    expect(escaped).not.toContain('`notice`')
    expect(escaped).toContain('\\`notice\\`')
  })
})
