import { GuardError } from '../lib/domain-errors'
import { GuardResolver } from './guard-resolver'
/**
 * G4 候选池守卫（共用层）——「离开待确认」由人完成
 *
 * ## 为什么在共用层（6720e1b9）
 *
 * 此前这道断言是 `TodoRepository` 的私有方法，只挂在 todo 一家的
 * update / delete 上。同类删除操作的安全口径按实体分裂：todo 有、project 没有。
 * 提到共用层后，**有「待确认」（proposed）态的实体统一走这一份**，
 * 新增实体时走 `ENTITIES_WITH_PROPOSED` 单源 + 结构闸门防漏挂
 * （见 tests/main/database/delete-guard-unified-6720e1b9.test.ts）。
 *
 * ## 放行路径（每条都是"人已拍板"的等价物）
 *
 * 1. `source === 'gui'`：人在界面上操作（渲染进程只被人操作）
 * 2. `preApprovedGrantId`：**人已批准这个具体动作**（f5e76697）——
 *    088282b2（主用户 2026-09-28 拍板）承诺「删除可发起申请、人批准后当场执行」，
 *    而此前批准回放仍会被这道断言拦下（假承诺）。授权绑目标（v19）：
 *    批的是 A 就只放行 A，凭证的范围核对在门禁层（assertScopeAllowed）已完成。
 * 3. 提议人撤回/降级自己的提议（`e0ec5f32`）：收回自己的请求 ≠ 替别人拍板。
 *
 * M4.5 起通过 GuardResolver 按配置决定行为（block/notice/off）。
 */

/** 有「待确认」（proposed）态、delete/update 需要 G4 守卫的实体（单源）。
 *  新增带 proposed 态的实体时必须登记到这里 —— 结构闸门会按这份清单检查守卫挂载。 */
export const ENTITIES_WITH_PROPOSED = ['todo'] as const

/** 延迟创建：模块顶层 new 会在测试 mock getDatabase() 之前就触发 db 访问 */
let _guardResolver: GuardResolver | null = null
function getGuardResolver(): GuardResolver {
  if (!_guardResolver) _guardResolver = new GuardResolver()
  return _guardResolver
}

export function assertConfirmedBeforeLeavingProposed(
  current: { status: string; createdBy?: string | null; projectId?: string | null },
  /** null = 删除：没有目标状态，但同样是「离开本列」 */
  nextStatus: string | null,
  source?: 'gui' | 'cli',
  /** 动作人：1.0.68 起允许提议人撤回自己提的卡（`e0ec5f32`） */
  actor?: string | null,
  /**
   * 人已批准这次动作的凭证 id（executeApproved 回放时带上）。
   * 有值 = 这个动作已经过人拍板，G4 的要求已满足（f5e76697）。
   */
  preApprovedGrantId?: string
): void {
  if (current.status !== 'proposed' || nextStatus === 'proposed') return
  // 人在界面上拍板：候选池设计里合法的放行路径
  if (source === 'gui') return
  // 人已批准这个具体动作 = G4 要的拍板。授权绑目标（v19），批 A 只放行 A。
  if (preApprovedGrantId) return

  /**
   * 提议人可以把自己的 proposed 降级为「待办」或「挂起」（= 撤回，`e0ec5f32`）。
   * 刻意收窄：只允许降级/撤回（todo / suspended），不许往右推
   * （降级不等于批准：往 todo 之后走仍要人拍板）。
   */
  const proposer = current.createdBy
  if (actor && actor === proposer) {
    const downgrade = nextStatus === 'todo' || nextStatus === 'suspended'
    if (downgrade) return
  }

  // M4.5：通过 GuardResolver 按配置决定行为
  const scope = current.projectId
    ? { scope: 'project' as const, projectId: current.projectId }
    : { scope: 'global' as const }
  getGuardResolver().assert(
    nextStatus === null ? 'G4-delete' : 'G4-status',
    scope,
    '[TodoRepository] 事项还在「待确认」列，需用户在界面上拍板后才能移出（G4）— ' +
      'agent 侧请等待确认，不要代转状态。\n' +
      '  只有**提议人自己**可以把它降级为「待办」或撤回（挂起）' +
      '（那不构成批准）；放行别人的「待确认」仍需人在界面上点。',
    '[G4] 事项还在「待确认」列，建议等用户确认后再移出'
  )
}
