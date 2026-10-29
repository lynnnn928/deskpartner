import { describe, it, expect } from 'vitest'
import {
  buildAuditTrail,
  countAwaitingApproval,
  hasEffect,
  isActiveGrant,
  isPendingGrant,
  isRetryableGrant,
  pickGrant
} from '../../../src/renderer/lib/grant-state'
import type { Agent, AgentGrant } from '../../../src/renderer/types/todo'

/** 造一条授权记录；只填影响判定的字段，其余给固定值 */
function make(over: Partial<AgentGrant>): AgentGrant {
  return {
    id: 'g1',
    agentId: 'agent:a',
    scope: 'destructive',
    sessionId: null,
    status: 'pending',
    command: null,
    summary: null,
    targetIds: [],
    requestArgv: [],
    execStatus: null,
    execError: null,
    executedAt: null,
    createdAt: '2026-09-21T10:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
    ...over
  }
}

describe('isPendingGrant：一条申请是不是还在等人表态', () => {
  it('未过期且待表态 → 算', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(isPendingGrant(make({ expiresAt: future }))).toBe(true)
  })

  /**
   * 这条是本次修复的正题：requestGrant 给 pending 也设了 30 分钟寿命
   * （"无人理会的申请不该永远挂在界面上"），界面必须一起判 expiresAt。
   * 只判 status 的话，申请早就凉了红点还亮着 —— 一个不再指向任何事的假信号，
   * 比没有红点更糟：人会学会忽略它。
   */
  it('已过期的 pending → 不算（红点不能永远亮着）', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(isPendingGrant(make({ expiresAt: past }))).toBe(false)
  })

  it('没有 expiresAt 的 pending → 算（老数据没设过期，按仍有效处理）', () => {
    expect(isPendingGrant(make({ expiresAt: null }))).toBe(true)
  })

  it('已批准 / 已拒绝 / 已用掉 / 已收回 → 都不算', () => {
    for (const status of ['granted', 'denied', 'consumed', 'revoked'] as const) {
      const future = new Date(Date.now() + 60_000).toISOString()
      expect(isPendingGrant(make({ status, expiresAt: future }))).toBe(false)
    }
  })
})

/** 造一个 agent 身份；只填影响判定的字段 */
function makeAgent(over: Partial<Agent>): Agent {
  return {
    id: 'agent:a',
    displayName: 'A',
    color: null,
    approved: false,
    hasCredential: false,
    createdAt: '2026-09-21T10:00:00.000Z',
    lastSeenAt: null,
    lastWriteAt: null,
    lastWriteCmd: null,
    ...over
  }
}

describe('countAwaitingApproval：有几个人该去点头的事（1.0.47）', () => {
  const future = new Date(Date.now() + 60_000).toISOString()

  it('没有待办事项 → 0', () => {
    expect(countAwaitingApproval([makeAgent({ approved: true })], [])).toBe(0)
  })

  /**
   * 这条是 1.0.47 的正题：agent 能自己注册之后，它办完手续是**静默等待**的 ——
   * 没有"授权申请"记录。红点若只数申请，人根本不知道有个新身份等他点头，
   * 助手就会一直写不进来。
   */
  it('未批准的身份要算进去（哪怕它没申请过任何授权）', () => {
    expect(countAwaitingApproval([makeAgent({ approved: false })], [])).toBe(1)
  })

  /**
   * 判据必须是 `approved === false`，不能是"有没有凭据" ——
   * 身份可以"注册了但还没领凭据"，那种情况同样在等人点头。
   */
  it('注册了但还没领凭据的身份也算（按 approved 判，不按凭据判）', () => {
    const noCred = makeAgent({ approved: false, hasCredential: false })
    const hasCred = makeAgent({ approved: false, hasCredential: true })
    expect(countAwaitingApproval([noCred, hasCred], [])).toBe(2)
  })

  it('两类事项相加：待批准身份 + 待表态申请', () => {
    const agents = [makeAgent({ id: 'agent:a', approved: false }), makeAgent({ id: 'agent:b', approved: true })]
    const grants = [make({ id: 'g1', expiresAt: future }), make({ id: 'g2', status: 'granted', expiresAt: future })]
    expect(countAwaitingApproval(agents, grants)).toBe(2)
  })

  it('过期的申请不算（与 isPendingGrant 同口径）', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(countAwaitingApproval([], [make({ expiresAt: past })])).toBe(0)
  })
})

const futureIso = () => new Date(Date.now() + 60_000).toISOString()
const pastIso = () => new Date(Date.now() - 60_000).toISOString()

describe('isActiveGrant：这一档现在还有效吗（1.0.48）', () => {
  it('已批准、未过期、没有失败回执 → 有效', () => {
    expect(isActiveGrant(make({ status: 'granted', expiresAt: futureIso() }), 'destructive')).toBe(
      true
    )
  })

  it('长期授权（expiresAt=null）也算有效', () => {
    expect(isActiveGrant(make({ status: 'granted', expiresAt: null }), 'destructive')).toBe(true)
  })

  it('档位不符 → 不算（改界面的授权不能当删除用）', () => {
    expect(isActiveGrant(make({ status: 'granted', scope: 'config' }), 'destructive')).toBe(false)
  })

  it('pending / consumed / denied / revoked → 都不算', () => {
    for (const status of ['pending', 'consumed', 'denied', 'revoked'] as const) {
      expect(isActiveGrant(make({ status, expiresAt: futureIso() }), 'destructive')).toBe(false)
    }
  })

  it('已过期 → 不算', () => {
    expect(isActiveGrant(make({ status: 'granted', expiresAt: pastIso() }), 'destructive')).toBe(
      false
    )
  })

  /**
   * 这条是本次修复的正题（真实库实测：42 条授权里有 5 条是这个形态）。
   *
   * 销账只在命令成功时发生，所以"人点了允许、服务端执行失败"的记录
   * 仍是 `status='granted'` 且未过期。若照 status 直接判，
   * 界面会把一个**失败**的动作显示成「已授权 · 一次性」——
   * 人刚点完「允许并执行」，看到这句就以为事情已经做掉了。
   * 界面替失败的动作报成功，是最坏的一种错。
   */
  it('执行失败（execStatus=error）→ 不算有效，哪怕 status 还是 granted', () => {
    expect(
      isActiveGrant(
        make({ status: 'granted', expiresAt: futureIso(), execStatus: 'error', execError: '失败' }),
        'destructive'
      )
    ).toBe(false)
  })

  it('执行成功但还没销账（execStatus=ok）→ 仍算有效', () => {
    // ok 只在命令成功时写，此时 executeOne 已把它置 consumed；
    // 若出现 granted+ok 的中间态（同一 tick 内被读到），仍按有效处理更安全
    expect(
      isActiveGrant(make({ status: 'granted', expiresAt: futureIso(), execStatus: 'ok' }), 'destructive')
    ).toBe(true)
  })
})

describe('isRetryableGrant：执行失败了但授权还留着（1.0.48）', () => {
  /**
   * 界面必须把这种形态与"未授权"分开说，否则会撒谎两次：
   * 说成"已授权"→ 人以为事情做掉了（其实失败）；
   * 说成"未授权"→ 人以为授权没了（其实还在，agent 随时能重试同一目标）。
   */
  it('granted + error + 未过期 → 是"未成功但可重试"', () => {
    expect(
      isRetryableGrant(
        make({ status: 'granted', expiresAt: futureIso(), execStatus: 'error', execError: 'G4 拦截' })
      )
    ).toBe(true)
  })

  it('没有失败回执 → 不算（那是正常授权，不是可重试）', () => {
    expect(isRetryableGrant(make({ status: 'granted', expiresAt: futureIso() }))).toBe(false)
  })

  it('已过期 → 不算（重试也不会被放行）', () => {
    expect(
      isRetryableGrant(make({ status: 'granted', expiresAt: pastIso(), execStatus: 'error' }))
    ).toBe(false)
  })

  it('已销账（consumed）→ 不算', () => {
    expect(isRetryableGrant(make({ status: 'consumed', execStatus: 'ok' }))).toBe(false)
  })
})

describe('pickGrant：取有效授权，没有则回退最近一条历史（1.0.48）', () => {
  it('没有记录 → 两个都是 null', () => {
    expect(pickGrant([], 'agent:a', 'destructive')).toEqual({ active: null, latest: null })
  })

  it('只看该身份、该档位', () => {
    const grants = [
      make({ id: 'other-agent', agentId: 'agent:b' }),
      make({ id: 'other-scope', scope: 'config' })
    ]
    expect(pickGrant(grants, 'agent:a', 'destructive')).toEqual({ active: null, latest: null })
  })

  it('有有效授权 → active 命中，latest 是最近一条', () => {
    const grants = [
      make({ id: 'old', status: 'consumed', createdAt: '2026-09-20T10:00:00.000Z' }),
      make({
        id: 'live',
        status: 'granted',
        expiresAt: futureIso(),
        createdAt: '2026-09-22T10:00:00.000Z'
      })
    ]
    const r = pickGrant(grants, 'agent:a', 'destructive')
    expect(r.active?.id).toBe('live')
    expect(r.latest?.id).toBe('live')
  })

  /**
   * 这条是缺口本身：界面此前查不到有效授权就一律显示「未授权」，
   * 于是**刚执行失败**的那条掉进兜底文案里 —— 失败原因在界面上彻底消失，
   * 只有 CLI `agent grants` 看得到。回退到 latest 才能把它显示出来。
   */
  it('没有有效授权但有失败历史 → active 为 null，latest 拿得到（人才能核实失败原因）', () => {
    const grants = [
      make({
        id: 'failed',
        status: 'granted',
        expiresAt: futureIso(),
        execStatus: 'error',
        execError: '事项还在「待确认」列，需用户在界面上拍板（G4）',
        createdAt: '2026-09-23T07:15:03.586Z'
      })
    ]
    const r = pickGrant(grants, 'agent:a', 'destructive')
    expect(r.active).toBeNull()
    expect(r.latest?.id).toBe('failed')
    expect(r.latest?.execError).toContain('G4')
  })

  it('多条历史时取创建时间最近的那条（不依赖传入顺序）', () => {
    const grants = [
      make({ id: 'newest', status: 'denied', createdAt: '2026-09-23T10:00:00.000Z' }),
      make({ id: 'middle', status: 'consumed', createdAt: '2026-09-22T10:00:00.000Z' }),
      make({ id: 'oldest', status: 'expired', createdAt: '2026-09-21T10:00:00.000Z' })
    ]
    expect(pickGrant(grants, 'agent:a', 'destructive').latest?.id).toBe('newest')
  })
})

/**
 * 审计流水（1.0.60，主用户驳回 10f0a5d6）
 *
 * 她的驳回原话：「这块现在做的很混乱，应该作为审计留痕才对的，
 * 可能后端有做，但是前端不好，**只有最新一条的执行记录**。」
 *
 * 这组用例锁的是**"摊开"而不是"压扁"**这个行为差异：
 * `pickGrant` 每档只给一条（回答"现在能不能干"），
 * `buildAuditTrail` 必须把全部记录都留着（回答"过去发生过什么"）。
 * 用同一条造出来的数组同时喂给两者，直接对比 —— 区别一眼可见。
 */
describe('buildAuditTrail：审计流水必须摊开而不是压扁', () => {
  it('同一条记录：pickGrant 只给最新一条，审计流水全部保留', () => {
    const grants = [
      make({
        id: 'g1',
        status: 'denied',
        createdAt: '2026-09-20T10:00:00.000Z',
        resolvedAt: '2026-09-20T10:00:00.000Z'
      }),
      make({
        id: 'g2',
        status: 'consumed',
        createdAt: '2026-09-21T10:00:00.000Z',
        resolvedAt: '2026-09-21T10:00:00.000Z'
      }),
      make({
        id: 'g3',
        status: 'denied',
        createdAt: '2026-09-22T10:00:00.000Z',
        resolvedAt: '2026-09-22T10:00:00.000Z'
      })
    ]
    // 压扁：只剩一条（pickGrant 按 createdAt 取最近 —— 它回答"现在能不能干"）
    expect(pickGrant(grants, 'agent:a', 'destructive').latest?.id).toBe('g3')
    // 摊开：三条都在 —— 这正是被驳回的"只有最新一条"
    const trail = buildAuditTrail(grants)
    expect(trail).toHaveLength(3)
    expect(trail.map((e) => e.grant.id)).toEqual(['g3', 'g2', 'g1'])
  })

  it('按时间倒序：表过态的用 resolvedAt，没表态的用 createdAt', () => {
    const grants = [
      // 申请得最早、处理得最晚 —— 排序必须按"事情何时落定"，不是何时申请
      make({
        id: 'resolved-late',
        status: 'denied',
        createdAt: '2026-09-20T10:00:00.000Z',
        resolvedAt: '2026-09-25T10:00:00.000Z'
      }),
      make({
        id: 'never-resolved',
        status: 'pending',
        createdAt: '2026-09-22T10:00:00.000Z'
      })
    ]
    expect(buildAuditTrail(grants).map((e) => e.grant.id)).toEqual([
      'resolved-late',
      'never-resolved'
    ])
  })

  /**
   * 这条是**反向验证**的对象：把 sort 去掉、或把它从头改成升序，
   * 本用例必须变红。只测"长度对"会让顺序错位悄悄溜过去。
   */
  it('顺序错了要能测出来：时间戳倒序，不是按数组顺序原样返回', () => {
    const grants = [
      make({ id: 'old', status: 'denied', resolvedAt: '2026-09-01T10:00:00.000Z' }),
      make({ id: 'new', status: 'denied', resolvedAt: '2026-09-30T10:00:00.000Z' })
    ]
    const ids = buildAuditTrail(grants).map((e) => e.grant.id)
    expect(ids).toEqual(['new', 'old'])
    expect(ids).not.toEqual(['old', 'new'])
  })

  it('limit 截断；传 0 表示不限', () => {
    const grants = Array.from({ length: 5 }, (_, i) =>
      make({
        id: `g${i}`,
        status: 'denied',
        resolvedAt: `2026-09-2${i}T10:00:00.000Z`
      })
    )
    expect(buildAuditTrail(grants, 2)).toHaveLength(2)
    expect(buildAuditTrail(grants, 0)).toHaveLength(5)
  })
})

describe('hasEffect：这条记录有没有真的改动过数据', () => {
  it('执行成功 → 有后果', () => {
    expect(hasEffect(make({ status: 'granted', execStatus: 'ok' }))).toBe(true)
  })

  it('已用掉 → 有后果（不管执行成败，动作确实发生过）', () => {
    expect(hasEffect(make({ status: 'consumed', execStatus: 'ok' }))).toBe(true)
  })

  it('被拒 / 过期 / 还没表态 → 没发生实际后果', () => {
    expect(hasEffect(make({ status: 'denied' }))).toBe(false)
    expect(hasEffect(make({ status: 'expired' }))).toBe(false)
    expect(hasEffect(make({ status: 'pending' }))).toBe(false)
  })
})
