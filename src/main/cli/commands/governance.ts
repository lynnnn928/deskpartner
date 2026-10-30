/**
 * 协作约定（档案 / 协议 / 规则）命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * ⚠️ 为什么这个文件导出**多段**：原表里它们被别的域隔开（不是按域连续排的），
 *    而顺序不能改。各段在 `command-table.ts` 的聚合处按原次序展开：
 *      · protocolGetCommands
 *      · profileCommands
 *      · protocolProposalCommands
 *      · rulesCommands
 */

import { NotFoundError, UsageError } from '../../lib/domain-errors'
import { GATES } from '../gates'
import { actorOf } from '../command-core'
import type { CliContext, CommandSpec } from '../command-core'

function resolveGovernanceProjectId(ctx: CliContext, raw: unknown): string {
  const ref = String(raw ?? '').trim()
  const hit = ctx.deps.projectRepo.list().find((item) => item.id === ref || item.name === ref)
  if (hit) return hit.id
  try {
    return ctx.deps.projectRepo.resolveId(ref)
  } catch (err) {
    if (err instanceof UsageError) throw err
    throw new NotFoundError(`项目不存在：${String(raw)}`)
  }
}
import { PROFILE_BLOCK_KEYS } from '../../database/profile.repository'
import { PROTOCOL_BLOCK_KEYS } from '../../database/protocol.repository'

function buildProposalDiffSummary(originalBody: string, proposedBody: string, append: boolean) {
  const origLines = originalBody.trim() ? originalBody.trim().split(/\r?\n/) : []
  const propLines = proposedBody.trim() ? proposedBody.trim().split(/\r?\n/) : []
  const origSet = new Set(origLines)
  const propSet = new Set(propLines)
  const addedLines = propLines.filter((l) => !origSet.has(l))
  const removedLines = origLines.filter((l) => !propSet.has(l))
  return {
    mode: append ? ('append' as const) : ('replace' as const),
    originalLineCount: origLines.length,
    proposedLineCount: propLines.length,
    addedCount: addedLines.length,
    removedCount: removedLines.length,
    addedLines,
    removedLines
  }
}

export const protocolGetCommands: CommandSpec[] = [
  {
    name: 'protocol get',
    dataShape: 'object',
    readOnly: true,
    desc: '读取用户页协作协议（全局或指定项目）',
    args: [{ flag: '--project', type: 'string', desc: '项目名或项目 ID；不传读取全局' }],
    run: (ctx, flags) => {
      const repo = ctx.deps.protocolRepo
      const rawProject = flags['--project']
      if (rawProject) {
        const projectId = resolveGovernanceProjectId(ctx, rawProject)
        return { scope: 'project', projectId, blocks: repo.list({ scope: 'project', projectId }), gates: GATES }
      }
      return { scope: 'global', blocks: repo.list({ scope: 'global' }), gates: GATES }
    }
  },
]

export const profileCommands: CommandSpec[] = [
  {
    name: 'profile get',
    dataShape: 'object',
    readOnly: true,
    desc: '读取主用户档案（全局或指定项目；项目只覆盖授权边界与完成标准）',
    args: [{ flag: '--project', type: 'string', desc: '项目名或项目 ID；不传读取全局' }],
    run: (ctx, flags) => {
      const repo = ctx.deps.profileRepo
      const rawProject = flags['--project']
      if (rawProject) {
        const projectId = resolveGovernanceProjectId(ctx, rawProject)
        return { scope: 'project', projectId, blocks: repo.list({ scope: 'project', projectId }) }
      }
      return { scope: 'global', blocks: repo.list({ scope: 'global' }) }
    }
  },
  {
    name: 'profile propose',
    dataShape: 'object',
    desc: '向主用户提议修改用户档案；提议不会直接生效',
    args: [
      { flag: '--project', type: 'string', desc: '项目名或项目 ID；不传为全局档案' },
      /**
       * 枚举而不是自由文本（卡 `6441d809`）：合法值只有 `PROFILE_BLOCK_KEYS` 那四个。
       * 此前声明成 string，传错区块要跑到仓储才炸，回的是 `error`（退出码 1）而不是
       * `usage_error`（退出码 2）—— 按退出码分流的调用方会把它判成"数据层异常"。
       */
      { flag: '--block', type: 'enum', enum: PROFILE_BLOCK_KEYS, required: true, desc: '档案区块' },
      { flag: '--body', type: 'string', required: true, desc: '提议内容' },
      { flag: '--append', type: 'boolean', desc: '追加模式：在当前已生效正文末尾换行追加 --body，免去手抄整段原文' },
      { flag: '--withdraw', type: 'string', desc: '撤回本人刚提交且尚处于 pending 的提议（传提议 id 或前缀；不许撤他人或已处理的提议）' }
    ],
    run: (ctx, flags) => {
      const repo = ctx.deps.profileRepo
      if (flags['--withdraw'] !== undefined) {
        const withdrawId = typeof flags['--withdraw'] === 'string' ? flags['--withdraw'].trim() : ''
        if (!withdrawId) throw new UsageError('--withdraw 需要传入待撤回的用户档案提议 id（支持前缀）')
        return { ...repo.withdrawProposal(withdrawId, actorOf(ctx)), withdrawn: true }
      }
      const blockKey = String(flags['--block'] ?? '') as import('../../database/profile.repository').ProfileBlockKey
      const rawProject = flags['--project'] ? String(flags['--project']) : undefined
      const projectId = rawProject ? resolveGovernanceProjectId(ctx, rawProject) : undefined
      const scope = projectId ? ({ scope: 'project' as const, projectId }) : ({ scope: 'global' as const })
      const append = Boolean(flags['--append'])
      const rawBody = String(flags['--body'] ?? '')
      let nextBody = rawBody
      if (append) {
        const existing = (repo.list(scope).find((b) => b.blockKey === blockKey)?.body ?? '').trim()
        nextBody = existing ? `${existing}\n${rawBody.trim()}` : rawBody.trim()
      }
      const proposal = repo.propose(scope, blockKey, nextBody, actorOf(ctx))
      return {
        ...proposal,
        diffSummary: buildProposalDiffSummary(proposal.originalBody ?? '', proposal.body ?? '', append)
      }
    }
  },
  {
    name: 'profile proposals',
    dataShape: 'array',
    readOnly: true,
    desc: '读取用户档案提议及其当前状态；默认只列待审批提议',
    args: [{ flag: '--all', type: 'boolean', desc: '同时列出已批准和已拒绝的历史提议' }],
    run: (ctx, flags) => ctx.deps.profileRepo.listProposals(flags['--all'] ? 'all' : 'pending')
  },
]

export const protocolProposalCommands: CommandSpec[] = [
  {
    name: 'protocol propose',
    dataShape: 'object',
    desc: '向主用户提议修改协作协议；提议不会直接生效',
    args: [
      { flag: '--project', type: 'string', desc: '项目名或项目 ID；不传为全局协议' },
      { flag: '--block', type: 'enum', enum: PROTOCOL_BLOCK_KEYS, required: true, desc: '协议区块' },
      { flag: '--body', type: 'string', required: true, desc: '提议内容' },
      { flag: '--append', type: 'boolean', desc: '追加模式：在当前已生效正文末尾换行追加 --body，免去手抄整段原文' },
      { flag: '--withdraw', type: 'string', desc: '撤回本人刚提交且尚处于 pending 的提议（传提议 id 或前缀；不许撤他人或已处理的提议）' }
    ],
    run: (ctx, flags) => {
      const repo = ctx.deps.protocolRepo
      if (flags['--withdraw'] !== undefined) {
        const withdrawId = typeof flags['--withdraw'] === 'string' ? flags['--withdraw'].trim() : ''
        if (!withdrawId) throw new UsageError('--withdraw 需要传入待撤回的协作协议提议 id（支持前缀）')
        return { ...repo.withdrawProposal(withdrawId, actorOf(ctx)), withdrawn: true }
      }
      const blockKey = String(flags['--block'] ?? '') as import('../../database/protocol.repository').ProtocolBlockKey
      const rawProject = flags['--project'] ? String(flags['--project']) : undefined
      const projectId = rawProject ? resolveGovernanceProjectId(ctx, rawProject) : undefined
      const scope = projectId ? ({ scope: 'project' as const, projectId }) : ({ scope: 'global' as const })
      const append = Boolean(flags['--append'])
      const rawBody = String(flags['--body'] ?? '')
      let nextBody = rawBody
      if (append) {
        const existing = (repo.list(scope).find((b) => b.blockKey === blockKey)?.body ?? '').trim()
        nextBody = existing ? `${existing}\n${rawBody.trim()}` : rawBody.trim()
      }
      const proposal = repo.propose(scope, blockKey, nextBody, actorOf(ctx))
      return {
        ...proposal,
        diffSummary: buildProposalDiffSummary(proposal.originalBody ?? '', proposal.body ?? '', append)
      }
    }
  },
  {
    name: 'protocol proposals',
    dataShape: 'array',
    readOnly: true,
    desc: '读取协作协议提议及其当前状态；默认只列待审批提议',
    args: [{ flag: '--all', type: 'boolean', desc: '同时列出已批准和已拒绝的历史提议' }],
    run: (ctx, flags) => ctx.deps.protocolRepo.listProposals(flags['--all'] ? 'all' : 'pending')
  },
]

export const rulesCommands: CommandSpec[] = [
  {
    name: 'rules get',
    dataShape: 'object',
    readOnly: true,
    desc: '读取协作规则配置（流转规则 / 权限矩阵 / 提醒）；权限矩阵仅 GUI 可改',
    args: [{ flag: '--project', type: 'string', desc: '项目名或项目 ID；不传读取全局' }],
    run: (ctx, flags) => {
      const repo = ctx.deps.rulesRepo
      const rawProject = flags['--project']
      if (rawProject) {
        const projectId = resolveGovernanceProjectId(ctx, rawProject)
        const scope = { scope: 'project' as const, projectId }
        return {
          scope: 'project',
          projectId,
          rules: repo.listRules(scope),
          permissions: repo.listPermissions(scope)
        }
      }
      return {
        scope: 'global',
        rules: repo.listRules({ scope: 'global' }),
        permissions: repo.listPermissions({ scope: 'global' })
      }
    }
  },
  {
    name: 'rules propose',
    dataShape: 'object',
    desc: '向主用户提议修改协作规则；提议需在审批页采纳后才生效。权限矩阵不接受提议',
    args: [
      { flag: '--project', type: 'string', desc: '项目名或项目 ID；不传为全局规则' },
      { flag: '--rule', type: 'string', required: true, desc: '规则编号：G1 / G2 / G4-status / G4-delete / G6 / G10 / G3 / G5 / G7 / G8 / G9' },
      { flag: '--enforcement', type: 'string', required: true, desc: '强度：block / authorize / notice / off' },
      { flag: '--withdraw', type: 'string', desc: '撤回本人刚提交且尚处于 pending 的提议（传提议 id 或前缀；不许撤他人或已处理的提议）' }
    ],
    run: (ctx, flags) => {
      const repo = ctx.deps.rulesRepo
      if (flags['--withdraw'] !== undefined) {
        const withdrawId = typeof flags['--withdraw'] === 'string' ? flags['--withdraw'].trim() : ''
        if (!withdrawId) throw new UsageError('--withdraw 需要传入待撤回的协作规则提议 id（支持前缀）')
        return { ...repo.withdrawProposal(withdrawId, actorOf(ctx)), withdrawn: true }
      }
      const ruleKey = String(flags['--rule'] ?? '')
      const enforcement = String(flags['--enforcement'] ?? '') as import('../../database/rules').RuleEnforcement
      const rawProject = flags['--project'] ? String(flags['--project']) : undefined
      const projectId = rawProject ? resolveGovernanceProjectId(ctx, rawProject) : undefined
      return repo.propose(
        projectId ? { scope: 'project', projectId } : { scope: 'global' },
        ruleKey,
        enforcement,
        actorOf(ctx)
      )
    }
  },
  {
    name: 'rules proposals',
    dataShape: 'array',
    readOnly: true,
    desc: '读取协作规则提议；默认只列待审批提议',
    args: [{ flag: '--all', type: 'boolean', desc: '同时列出已采纳和已拒绝的历史提议' }],
    run: (ctx, flags) => ctx.deps.rulesRepo.listProposals(flags['--all'] ? 'all' : 'pending')
  },
]
