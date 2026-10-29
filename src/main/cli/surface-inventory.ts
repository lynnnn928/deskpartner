/**
 * Headless 能力清点文档的**渲染器**（卡 `f45a49c1`，第一批）
 *
 * ## 为什么要有这份东西
 *
 * Bob在这个产品上误报过五次以上，根因全是**拿旧契约读新返回**
 * （最近一次：`todo get` 对已删事项回墓碑结构，按老形状读成 `status=undefined`）。
 * 而当时能查的只有散落各处的源码、`dp help`、说明书 —— 没有一份
 * "命令 / 工具 / 权限档 / 返回形状"能逐项对照的清单。
 *
 * ## 判据：能算出来的，不要手写第二份
 *
 * 本文件**不存任何数字**：命令清单来自 `command-table.ts`、关口来自 `gates.ts`、
 * 错误码来自 `error-codes.ts`、MCP 映射来自 `mcp-tools-from-schema.ts` 的
 * `mcpToolName` / `shouldExpose`。产物是 `docs/generated/headless-surface.md`，
 * 由源码侧闸门（`tests/main/cli/headless-surface-f45a49c1.test.ts`）逐字比对，
 * 契约变了而没刷新文档 = 用例红。**唯一更新入口**是
 * `node scripts/update-surface-inventory.mjs`（与 `829ad776` 的命令面基线同一套讲究）。
 *
 * ## 它不回答什么（显式列出，免得被当成"清单里没有 = 产品没有"）
 *
 * - **实际返回的数据长什么样**（顶层键、空值、墓碑结构）：那要真跑，
 *   证据在 `.tmp-check/headless-baseline/headless-baseline-probe.md`，由
 *   `scripts/verify-headless-baseline.mjs` 在隔离夹具上重跑生成。
 * - **仓储归属与界面侧的 IPC 通道**：界面不走 CLI，见基线盘点文档。
 * - 说明书正文：`dp skill` 才是出口，这里不复制。
 */

import { commands } from './command-table'
import { GATES } from './gates'
import { ERROR_CODES } from './error-codes'
import { riskOf } from './command-core'
import { mcpToolName, shouldExpose } from '../../cli/mcp-tools-from-schema'
import type { CommandSpec } from './command-core'

/** 生成文件的落点（相对仓库根） */
export const SURFACE_DOC_PATH = 'docs/generated/headless-surface.md'

export interface WriteReceiptShapeSpec {
  /** 已批准 Agent 在无人值守（interactive=false）夹具下实跑的结果：直通 ok 或门禁拦截码 */
  unattended: 'ok' | 'grant_required' | 'approval_required'
  /** 成功回执（或人手授权放行后）data 的顶层键 */
  keys: readonly string[]
  /** 条件性分支或门禁说明 */
  note?: string
}

/**
 * 38 条非只读命令（write / config / destructive）的实测回执形状表（卡 `cd5f3832`）。
 *
 * 由 `tests/main/cli/write-receipt-shapes-cd5f3832.test.ts` 在隔离夹具上逐条真跑校核：
 * - 漏登记或多余登记 = 红；
 * - `unattended === 'ok'` 的 28 条命令：已批准 Agent 实跑 `data` 顶层键必须与 `keys` 完全一致；
 * - `destructive` / `config` / 提议制命令：无人值守实跑必须命中声明的 `errorCode`（`grant_required` / `approval_required`），
 *   明确标出「需人工授权，无人值守不可达（形状在无人值守下未知）」，并附授权放行后的真实回执键。
 */
export const WRITE_RECEIPT_SHAPES: Record<string, WriteReceiptShapeSpec> = {
  'todo comment': {
    unattended: 'ok',
    keys: ['ok', 'commentId', 'todoId', 'parentId', 'author', 'createdAt', 'commentCount', 'message']
  },
  'todo reject': {
    unattended: 'ok',
    keys: ['ok', 'todoId', 'status', 'commentId', 'reason', 'rejectedBy', 'message']
  },
  'todo close': {
    unattended: 'ok',
    keys: ['todoId', 'status', 'commentId', 'leftoverNotifiedTo', 'leftoverMemoId', 'message'],
    note: '当 --leftover 填「无」或收口人即执行方时，不返回 leftoverNotifiedTo / leftoverMemoId'
  },
  'todo delete-comment': {
    unattended: 'ok',
    keys: ['ok', 'commentId', 'todoId', 'cascadedReplies', 'commentCount', 'message'],
    note: '删自己写的普通评论属 write 档直通；删他人评论或驳回理由升为 destructive（需人工授权，code=grant_required）'
  },
  'todo add': {
    unattended: 'ok',
    keys: ['id', 'title']
  },
  'todo update': {
    unattended: 'ok',
    keys: [
      'id', 'title', 'fixedInVersion', 'description', 'categoryIds', 'categoryId',
      'projectId', 'parentId', 'status', 'priority', 'type', 'createdBy', 'executedBy',
      'verifier', 'dueAt', 'remindAt', 'isPinned', 'createdAt', 'updatedAt', 'completedAt', 'changed'
    ]
  },
  'todo done': {
    unattended: 'ok',
    keys: [
      'id', 'title', 'fixedInVersion', 'description', 'categoryIds', 'categoryId',
      'projectId', 'parentId', 'status', 'priority', 'type', 'createdBy', 'executedBy',
      'verifier', 'dueAt', 'remindAt', 'isPinned', 'createdAt', 'updatedAt', 'completedAt'
    ]
  },
  'todo pin': {
    unattended: 'ok',
    keys: ['id', 'title', 'isPinned']
  },
  'todo unpin': {
    unattended: 'ok',
    keys: ['id', 'title', 'isPinned']
  },
  'todo rm': {
    unattended: 'grant_required',
    keys: ['id', 'deleted'],
    note: '需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：id deleted）'
  },
  'telemetry clear': {
    unattended: 'grant_required',
    keys: ['removed'],
    note: '需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：removed）'
  },
  'profile propose': {
    unattended: 'ok',
    keys: [
      'id', 'scope', 'projectId', 'blockKey', 'body', 'originalBody', 'baseUpdatedAt',
      'decidedBody', 'proposer', 'status', 'decidedBy', 'decidedAt', 'createdAt'
    ]
  },
  'protocol propose': {
    unattended: 'ok',
    keys: [
      'id', 'scope', 'projectId', 'blockKey', 'body', 'originalBody', 'baseUpdatedAt',
      'decidedBody', 'proposer', 'status', 'decidedBy', 'decidedAt', 'createdAt'
    ]
  },
  'rules propose': {
    unattended: 'ok',
    keys: [
      'id', 'scope', 'projectId', 'category', 'ruleKey', 'proposedEnforcement',
      'originalEnforcement', 'baseUpdatedAt', 'decidedEnforcement', 'proposer',
      'status', 'decidedBy', 'decidedAt', 'createdAt'
    ]
  },
  'project handoff-propose': {
    unattended: 'ok',
    keys: ['project', 'proposal']
  },
  'project handoff-update': {
    unattended: 'approval_required',
    keys: ['project', 'changed', 'revision'],
    note: '默认权限矩阵要求 Agent 走提议（错误信封 code=approval_required, exitCode=4，请用 project handoff-propose；授权直写后键：project changed revision）'
  },
  'todo set-owner': {
    unattended: 'ok',
    keys: ['id', 'title', 'createdBy']
  },
  'project add': {
    unattended: 'ok',
    keys: ['id', 'name', 'color', 'archived', 'sortOrder', 'createdAt', 'handoffMarkdown', 'notice'],
    note: '同名项目复用时返回 id name docsDir(可选) reused'
  },
  'project handoff-rollback': {
    unattended: 'ok',
    keys: ['project', 'changed', 'revision']
  },
  'project archive': {
    unattended: 'ok',
    keys: ['id', 'name', 'archived', 'message']
  },
  'project unarchive': {
    unattended: 'ok',
    keys: ['id', 'name', 'archived', 'message']
  },
  'project rm': {
    unattended: 'grant_required',
    keys: ['deleted', 'projectName', 'removed', 'message'],
    note: '需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted projectName removed message）'
  },
  'release add': {
    unattended: 'ok',
    keys: ['version', 'projectId', 'shippedAt', 'highlights', 'tested', 'linkedTodos', 'note']
  },
  'release update': {
    unattended: 'ok',
    keys: ['version', 'projectId', 'shippedAt', 'summary', 'highlights', 'tested', 'linkedTodos']
  },
  'release rm': {
    unattended: 'grant_required',
    keys: ['deleted', 'orphanTodos'],
    note: '需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted orphanTodos）'
  },
  'memo add': {
    unattended: 'ok',
    keys: ['id', 'author', 'recipient', 'text'],
    note: '传 --reply-to 追加同线程回复时返回 id replyTo replyId author recipient text replies'
  },
  'memo ack': {
    unattended: 'ok',
    keys: ['id', 'status', 'readAt']
  },
  'memo rm': {
    unattended: 'grant_required',
    keys: ['deleted', 'ok'],
    note: '需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted ok）'
  },
  'category add': {
    unattended: 'ok',
    keys: ['id', 'name']
  },
  'category rm': {
    unattended: 'grant_required',
    keys: ['deleted', 'affectedTodos'],
    note: '需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted affectedTodos）'
  },
  'category merge': {
    unattended: 'grant_required',
    keys: ['merged', 'into', 'movedTodos'],
    note: '源分类非空时需人工授权，形状未知（code=grant_required, exitCode=4）；源分类为空（0 条待办）或人工授权后键：merged into movedTodos'
  },
  batch: {
    unattended: 'ok',
    keys: ['total', 'failed', 'allFailed', 'results']
  },
  'ui set': {
    unattended: 'grant_required',
    keys: ['key', 'before', 'after', 'changed', 'note'],
    note: '配置档需人工会话授权，形状未知（无人值守默认 code=grant_required, exitCode=4；会话授权后键：key before after changed note）'
  },
  'ui reset': {
    unattended: 'grant_required',
    keys: ['reset', 'affected', 'settings'],
    note: '配置档需人工会话授权，形状未知（无人值守默认 code=grant_required, exitCode=4；会话授权后键：reset affected settings）'
  },
  'agent register': {
    unattended: 'ok',
    keys: [
      'id', 'displayName', 'color', 'approved', 'rejectedAt', 'hasCredential',
      'createdAt', 'lastSeenAt', 'lastWriteAt', 'lastWriteCmd', 'reused',
      'needsApproval', 'nextSteps', 'humanNotified', 'nextHint'
    ]
  },
  'agent credential': {
    unattended: 'ok',
    keys: ['agentId', 'credentialPath', 'declaredAs', 'otherCredentials', 'note']
  },
  'agent revoke': {
    unattended: 'ok',
    keys: ['agentId', 'scope', 'revokedGrants', 'note']
  },
  'agent purge-credentials': {
    unattended: 'ok',
    keys: ['agentId', 'credentialPath', 'removed', 'wasDefault', 'defaultAfter', 'remaining', 'note']
  }
}

/**
 * 回执 `data` 的形状列。
 *
 * ⚠️ `output` 为 `text` / `ndjson` 的命令**没有信封**，`dataShape` 对它们本就无意义 ——
 * 写成"未知"会把"结构上不存在"误报成"没盘点到"。这两类分开说。
 */
function dataShapeCell(c: CommandSpec): string {
  const output = c.output ?? 'json'
  if (output === 'text') return '无信封（正文）'
  if (output === 'ndjson') return '无信封（NDJSON 逐行）'
  return c.dataShape ? `\`${c.dataShape}\`` : '**未声明 ← 未知**'
}

/** 「必需参数」列：只列必填，不把整串参数搬进来（参数细节看 `dp help <命令>`） */
function requiredArgsCell(c: CommandSpec): string {
  const required = c.args.filter((a) => a.required).map((a) => `\`${a.flag}\``)
  return required.length ? required.join(' ') : '—'
}

/** 位置参数列：`id`（必填）/ `topic`（可选）/ — */
function positionalCell(c: CommandSpec): string {
  if (!c.positional) return '—'
  return `\`${c.positional.name}\`（${c.positional.required ? '必填' : '可选'}）`
}

/** MCP 列：暴露就写工具名，不暴露就写明它由排除表挡下（不是"没能力"） */
function mcpCell(c: CommandSpec): string {
  return shouldExpose(c.name) ? `\`${mcpToolName(c.name)}\`` : '不暴露（排除表）'
}

/**
 * 清单里的"未知"必须自己数出来，而不是只写一句"其余未盘点"。
 *
 * 判据：**空缺只有被点名才算盘点过**。这里点名两类：
 * ① 信封类命令漏声明 `dataShape`（调用方无从知道 `data` 是数组还是对象）；
 * ② 没有信封的命令（形状由 `output` 决定，问 `dataShape` 是问错了地方）。
 */
function coverage(cmdList: readonly CommandSpec[]) {
  const envelope = cmdList.filter((c) => (c.output ?? 'json') === 'json')
  const missingShape = envelope.filter((c) => !c.dataShape)
  const nonEnvelope = cmdList.filter((c) => (c.output ?? 'json') !== 'json')
  const notExposed = cmdList.filter((c) => !shouldExpose(c.name))
  return { envelope, missingShape, nonEnvelope, notExposed }
}

/** 渲染整份清单 —— 纯函数，同样的源码永远得到同样的字节 */
export function buildSurfaceInventoryMarkdown(): string {
  const cmdList = commands as readonly CommandSpec[]
  const { missingShape, nonEnvelope, notExposed } = coverage(cmdList)
  const exposed = cmdList.filter((c) => shouldExpose(c.name))
  const reads = cmdList.filter((c) => riskOf(c) === 'read')
  const writes = cmdList.filter((c) => riskOf(c) === 'write')
  const configs = cmdList.filter((c) => riskOf(c) === 'config')
  const destructives = cmdList.filter((c) => riskOf(c) === 'destructive')

  const lines: string[] = []

  lines.push('# Headless 能力清点（生成文件）')
  lines.push('')
  lines.push('> 本文件由 `node scripts/update-surface-inventory.mjs` 生成，**禁止手工编辑**。')
  lines.push('> 唯一来源：`src/main/cli/command-table.ts`（命令）、`gates.ts`（关口）、')
  lines.push('> `error-codes.ts`（错误码）、`src/cli/mcp-tools-from-schema.ts`（MCP 映射与排除表）。')
  lines.push('> 源码侧闸门：`tests/main/cli/headless-surface-f45a49c1.test.ts`（逐字比对）。')
  lines.push('> 实际返回形状不在这里 —— 见 `docs/reviews/2026-10-28-headless-baseline-probe.md`。')
  lines.push('')
  lines.push('## 1. 规模')
  lines.push('')
  lines.push('| 项 | 数量 |')
  lines.push('|---|---:|')
  lines.push(`| CLI 命令 | **${cmdList.length}** |`)
  lines.push(`| MCP 工具（命令表 − 排除表 ${notExposed.length} 条） | **${exposed.length}** |`)
  lines.push(`| 读档（免身份，可自由重试） | ${reads.length} |`)
  lines.push(`| 写档（需已批准 + 有效凭据） | ${writes.length} |`)
  lines.push(`| 配置档（仅本次会话有效） | ${configs.length} |`)
  lines.push(`| 删除档（一次性授权，用掉即止） | ${destructives.length} |`)
  lines.push(`| 关口 | **${GATES.length}** |`)
  lines.push(`| 稳定错误码 | ${ERROR_CODES.length} |`)
  lines.push('')
  lines.push('## 2. 命令清单')
  lines.push('')
  lines.push(
    '列含义：**风险档** = 这一条要什么手续（`read` 免身份 / `write` 需凭据 / ' +
      '`config` 仅本次会话 / `destructive` 一次性授权）；**data** = 成功回执里 `data` ' +
      '的形状（`array` / `object`，信封类才有）；**MCP** = 这个能力能不能从 MCP 调。'
  )
  lines.push('')
  lines.push('| # | 命令 | 风险档 | 出参 | data | MCP 工具 | 位置参数 | 必填参数 |')
  lines.push('|---:|---|---|---|---|---|---|---|')
  cmdList.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | \`${c.name}\` | ${riskOf(c)} | ${c.output ?? 'json'} | ` +
        `${dataShapeCell(c)} | ${mcpCell(c)} | ${positionalCell(c)} | ${requiredArgsCell(c)} |`
    )
  })
  lines.push('')
  const writeCmdList = cmdList.filter((c) => !c.readOnly)
  lines.push(`## 2b. 写入型命令回执形状（${writeCmdList.length} 条，卡 cd5f3832）`)
  lines.push('')
  lines.push(
    '判据：在隔离夹具中以已批准身份（`agent:probe`，`approved=1`，`interactive=false`）逐条实跑；' +
      '`destructive` 与 `config` 等无人值守不可达的命令明确标「**需人工授权，形状未知**」及返回的错误信封，' +
      '同时附人工授权放行后的真实顶层键（由 `tests/main/cli/write-receipt-shapes-cd5f3832.test.ts` 双路径锁死）。'
  )
  lines.push('')
  lines.push('| # | 命令 | 风险档 | 声明 | 无人值守实跑 | 回执顶层键 / 错误信封与边界 |')
  lines.push('|---:|---|---|---|---|---|')
  writeCmdList.forEach((c, idx) => {
    const spec = WRITE_RECEIPT_SHAPES[c.name]
    const keysFormatted = spec ? spec.keys.map((k) => `\`${k}\``).join(' ') : '**未登记**'
    const statusCell =
      !spec
        ? '**未知**'
        : spec.unattended === 'ok'
          ? '直通（`ok=true`）'
          : `**需人工授权，形状未知**（\`${spec.unattended}\`）`
    const detailCell =
      !spec
        ? '**缺失 ← 应判红**'
        : spec.unattended === 'ok'
          ? `${keysFormatted}${spec.note ? `（${spec.note}）` : ''}`
          : `${spec.note ?? ''}；授权后顶层键：${keysFormatted}`
    lines.push(
      `| ${idx + 1} | \`${c.name}\` | ${riskOf(c)} | ${dataShapeCell(c)} | ${statusCell} | ${detailCell} |`
    )
  })
  lines.push('')
  lines.push('## 3. 关口（守卫与门禁）')
  lines.push('')
  lines.push('判据：`enforcement` 决定调用方该做什么 —— `block` 重试无用、`authorize` 去申请、`notice` 只是提醒。')
  lines.push('')
  lines.push('| 编号 | 守什么 | 强度 | 退出码 | errorCode | 实装位置 |')
  lines.push('|---|---|---|---:|---|---|')
  for (const g of GATES) {
    lines.push(
      `| ${g.id} | ${g.what} | ${g.enforcement} | ${g.exitCode} | ` +
        `${g.errorCode ? `\`${g.errorCode}\`` : '—'} | ${g.implementedAt ? `\`${g.implementedAt}\`` : '**未实装**'} |`
    )
  }
  lines.push('')
  lines.push('## 4. 错误码')
  lines.push('')
  lines.push('判据：`重试` 一列回答"原地再来一次有没有用" —— `false` 换路或等人、`read` 是重读而不是重试。')
  lines.push('')
  lines.push('| errorCode | 含义 | 退出码 | 重试 | 该做什么 |')
  lines.push('|---|---|---:|---|---|')
  for (const spec of ERROR_CODES) {
    lines.push(
      `| \`${spec.code}\` | ${spec.what} | ${spec.exitCode} | ${String(spec.retry)} | ${spec.fix} |`
    )
  }
  lines.push('')
  lines.push('## 5. 未知 / 不在本清单里的')
  lines.push('')
  lines.push('盘点口径：**空缺只有被点名才算盘点过。**')
  lines.push('')
  if (missingShape.length) {
    lines.push(
      `- **信封类命令漏声明 \`dataShape\`（${missingShape.length} 条，形状无从知道）**：` +
        missingShape.map((c) => `\`${c.name}\``).join('、')
    )
  } else {
    lines.push('- 信封类命令的 `dataShape`：**无空缺**（逐条已声明，闸门盯着）。')
  }
  lines.push(
    `- **没有信封 \`data\` 的命令（${nonEnvelope.length} 条）**：` +
      nonEnvelope.map((c) => `\`${c.name}\`（${c.output}）`).join('、') +
      ' —— 形状由出参形态回答，别去读 `data`。'
  )
  lines.push(
    `- **不暴露给 MCP 的命令（${notExposed.length} 条）**：` +
      notExposed.map((c) => `\`${c.name}\``).join('、') +
      ' —— 是排除表的选择（自检类 / 人类界面类），不代表产品没这个能力。'
  )
  lines.push(
    '- **实际返回的形状（顶层键、空值、墓碑结构）**：不在本文件。' +
      '它是跑出来的，证据见 `docs/reviews/2026-10-28-headless-baseline-probe.md`，' +
      '重跑命令 `node scripts/verify-headless-baseline.mjs`。'
  )
  lines.push(
    '- **界面侧的 IPC 通道与页面行为**：本文件只盘点 CLI/MCP 这条面。' +
      '页面 ↔ 能力映射见 `docs/architecture/2026-10-28-gui-page-capability-map.md`。'
  )
  lines.push('')

  return lines.join('\n')
}
