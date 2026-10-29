/**
 * 项目命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * ⚠️ 为什么这个文件导出**多段**：原表里它们被别的域隔开（不是按域连续排的），
 *    而顺序不能改。各段在 `command-table.ts` 的聚合处按原次序展开：
 *      · projectHandoffCommands
 *      · projectCommands
 */

import { GuardError, NotFoundError, UsageError } from '../../lib/domain-errors'
import { PROJECT_HANDOFF_TEMPLATE } from '../../../renderer/types/project'
import { LIMIT_ZERO_DOC, parseLimit, parseOffset } from '../command-text'
import { FIRST_READ_BUDGET_BYTES, fitToBudget, measureJsonBytes } from '../response-budget'
import { actorOf, assertNoLauncherOnlyFlags, projectNameOf } from '../command-core'
import type { CommandSpec } from '../command-core'

export const projectHandoffCommands: CommandSpec[] = [
  {
    name: 'project handoff-propose',
    dataShape: 'object',
    desc: '向主用户提议修改项目接手说明；提议需在审批页采纳后才会生效',
    args: [
      { flag: '--body', type: 'string', desc: '新的接手说明正文' },
      { flag: '--body-file', type: 'string', desc: '从文件读取接手说明正文（由启动器展开为 --body）' }
    ],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      assertNoLauncherOnlyFlags(flags)
      const body = String(flags['--body'] ?? '')
      if (!body.trim()) throw new UsageError('缺少 --body（多行正文请使用 --body-file）')
      const id = ctx.deps.projectRepo.resolveId(raw)
      const proposal = ctx.deps.projectRepo.proposeHandoff(id, body, actorOf(ctx), {
        version: ctx.meta.version
      })
      return { project: projectNameOf(ctx, id), proposal }
    }
  },
  {
    name: 'project handoff-proposals',
    dataShape: 'array',
    readOnly: true,
    desc: '读取项目接手说明提议；默认只列待审批提议',
    args: [{ flag: '--all', type: 'boolean', desc: '同时列出已采纳和已拒绝的历史提议' }],
    run: (ctx, flags) =>
      ctx.deps.projectRepo.listHandoffProposals(flags['--all'] ? 'all' : 'pending', {
        version: ctx.meta.version
      })
  },
  {
    name: 'project handoff-update',
    dataShape: 'object',
    desc: '主用户直接更新项目接手说明；Agent 应使用 project handoff-propose',
    args: [
      { flag: '--body', type: 'string', desc: '新的接手说明正文' },
      { flag: '--body-file', type: 'string', desc: '从文件读取接手说明正文（由启动器展开为 --body）' },
      { flag: '--expected-revision', type: 'string', desc: '提交时所依据的修订序号；不一致则拒绝覆盖' }
    ],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      assertNoLauncherOnlyFlags(flags)
      const body = String(flags['--body'] ?? '')
      if (!body.trim()) throw new UsageError('缺少 --body（多行正文请使用 --body-file）')
      let expectedRevision: number | undefined
      if (flags['--expected-revision'] !== undefined) {
        expectedRevision = Number(flags['--expected-revision'])
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
          throw new UsageError(`--expected-revision 需要非负整数，收到「${flags['--expected-revision']}」`)
        }
      }
      const actor = actorOf(ctx)
      if (actor.startsWith('agent:')) {
        throw new GuardError('Agent 不能直接更新项目接手说明；请使用 project handoff-propose，等待主用户在审批页采纳')
      }
      const id = ctx.deps.projectRepo.resolveId(raw)
      const result = ctx.deps.projectRepo.saveHandoff(id, body, actor, expectedRevision, {
        version: ctx.meta.version
      })
      if (result.changed) {
        try {
          ctx.deps.events.append('project', actorOf(ctx), { cmd: 'project handoff-update', id })
        } catch {
          /* 广播失败不影响正文保存 */
        }
      }
      return {
        project: projectNameOf(ctx, id),
        changed: result.changed,
        revision: result.revision
          ? { id: result.revision.id, seq: result.revision.seq, kind: result.revision.kind, author: result.revision.author }
          : null
      }
    }
  },
]

/** 接续包的下一步：按新鲜度与截断状态给真实入口，别让人猜 */
function buildNextSteps(projectRef: string, freshness: 'fresh' | 'review_required' | 'stale', truncated: boolean): string {
  const steps: string[] = []
  if (freshness !== 'fresh') {
    steps.push(
      `说明需要复核：先看 project handoff-history ${projectRef}；改法用 project handoff-propose（agent）或 project handoff-update（人）`
    )
  }
  if (truncated) {
    steps.push(`说明全文：project handoff-revision ${projectRef} <seq>（本回执 handoff.revisionSeq 就是<seq>）`)
  }
  steps.push(
    `要事项清单加 --limit N（如 --limit 20）；按状态查用 todo list --project "<项目名>" --status <状态>；搜历史决定用 project search "<项目名>" --query "<关键词>"`
  )
  return steps.join('；')
}

export const projectCommands: CommandSpec[] = [
  {
    name: 'project add',
    dataShape: 'object',
    desc: '新建项目（顶层容器）—— agent 用它开一个新项目；同名项目复用时传 --docs-dir 可直接关联或清空本地文档目录',
    args: [
      { flag: '--name', type: 'string', required: true, desc: '项目名，如"DeskPartner"' },
      { flag: '--color', type: 'string', desc: '颜色，如 #5388F6；不传用默认蓝' },
      { flag: '--docs-dir', type: 'string', desc: '关联本地 Markdown 文档目录（只读索引与渲染；传 clear 取消关联）' }
    ],
    run: (ctx, flags) => {
      const name = String(flags['--name'] || '').trim()
      if (!name) throw new UsageError('--name 不能为空')
      const hasDocsDirFlag = flags['--docs-dir'] !== undefined
      const rawDocsDir = hasDocsDirFlag ? String(flags['--docs-dir']).trim() : ''
      const nextDocsDir =
        !rawDocsDir || rawDocsDir === 'clear' || rawDocsDir === 'unset' ? null : rawDocsDir

      // 同名复用而不是新建，防止 agent 各建各的导致项目泛滥
      const hit = ctx.deps.projectRepo.list().find((p) => p.name === name)
      if (hit) {
        if (hasDocsDirFlag) {
          const updated = ctx.deps.projectRepo.update({
            id: hit.id,
            docsDir: nextDocsDir,
            actor: actorOf(ctx)
          })
          return {
            id: updated.id,
            name: updated.name,
            docsDir: updated.docsDir ?? null,
            reused: true
          }
        }
        return { id: hit.id, name: hit.name, reused: true }
      }

      const project = ctx.deps.projectRepo.create({
        name,
        handoffMarkdown: PROJECT_HANDOFF_TEMPLATE,
        actor: actorOf(ctx),
        ...(flags['--color'] ? { color: String(flags['--color']) } : {}),
        ...(hasDocsDirFlag ? { docsDir: nextDocsDir } : {})
      })
      return {
        ...project,
        notice: '项目已创建，并已生成接手说明模板；请补充项目目标、当前决定、工作入口和下一步。'
      }
    }
  },
  {
    name: 'project list',
    dataShape: 'array',
    readOnly: true,
    desc: '列出所有项目',
    args: [],
    run: (ctx) =>
      ctx.deps.projectRepo.list().map((p) => ({
        id: p.id,
        name: p.name,
        archived: p.archived
      }))
  },
  {
    name: 'project get',
    dataShape: 'object',
    readOnly: true,
    desc:
      '读取项目接续包：实时事实 / 接手说明的覆盖声明与新鲜度 / 状态计数；' +
      '默认不返回事项清单（加 --limit 才给）；接手说明超出首读体量时只给预览与读全文的入口',
    args: [
      { flag: '--limit', type: 'string', desc: `事项入口条数上限；${LIMIT_ZERO_DOC}；不传则不返回事项清单` },
      { flag: '--offset', type: 'string', desc: '事项入口分页偏移（默认 0）' },
      {
        flag: '--handoff-full',
        type: 'boolean',
        desc: '返回接手说明全文（默认超 2000 字只给预览；全文也可以走 project handoff-revision）'
      }
    ],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      const limit = parseLimit(flags['--limit'], 'project get')
      /**
       * 偏移交给族内唯一一处（1.0.109，修 `7f21841f`）。
       *
       * 此前这里有个**本地**的 `parseNonNegative`（跟 `parseOffset` 同一件事、
       * 第三份写法）：`Number(flags[flag])` 之后只判整数非负，于是裸传 `--offset`
       * 会落成布尔 `true` → `Number(true) === 1`，静默从第 2 条开始。
       */
      const offset = parseOffset(flags['--offset'], 'project get')
      const id = ctx.deps.projectRepo.resolveId(raw)
      const detail = ctx.deps.projectRepo.getDetail(id, {
        ...(limit !== undefined && limit > 0 ? { limit } : {}),
        offset
      })
      if (!detail) throw new NotFoundError(`项目不存在: ${raw}`)

      /**
       * 接续包（卡 `e2a06fd7` / `caa0d1c1`）：除了项目本身，还要回答三件事 ——
       * **现在的事实是什么**（facts）、**这一版说明自称覆盖什么**（handoff.coverage）、
       * **它还靠不靠得住**（freshness 三态 + 原因）。判定全在仓储层，命令只负责装盘。
       */
      const state = ctx.deps.projectRepo.getHandoffState(id, { version: ctx.meta.version })
      const full = Boolean(flags['--handoff-full'])
      const body = detail.project.handoffMarkdown
      const items = limit === undefined ? [] : detail.overview.items
      const budgetLimit = FIRST_READ_BUDGET_BYTES - 64

      /** 默认只给前 2000 字；放不下就再缩，缩到 0 还不行才动事项清单 */
      const bodyCaps = full ? [body.length] : [Math.min(body.length, 2000), 500, 0]

      const assemble = (bodyChars: number, itemCount: number) => {
        const keptItems = items.slice(0, itemCount)
        const truncated = !full && bodyChars < body.length
        return {
          project: { ...detail.project, handoffMarkdown: body.slice(0, bodyChars) },
          overview: {
            ...detail.overview,
            items: keptItems,
            returned: keptItems.length,
            truncated: limit === undefined ? detail.overview.total > 0 : detail.overview.truncated
          },
          handoffRevisionCount: detail.handoffRevisionCount,
          facts: state.facts,
          handoff: {
            ...state.handoff,
            truncated,
            readFull: truncated
              ? `dp project handoff-revision ${raw} ${state.handoff.revisionSeq ?? ''}`.trim()
              : null
          },
          freshness: state.freshness,
          nextSteps: buildNextSteps(raw, state.freshness.state, truncated)
        }
      }

      let payload = assemble(body.length, items.length)
      let bytes = measureJsonBytes(payload)
      if (bytes > budgetLimit) {
        for (const cap of bodyCaps) {
          const fit = fitToBudget(budgetLimit, items.length, (dropped) =>
            assemble(cap, Math.max(0, items.length - dropped))
          )
          if (!fit.overBudget) {
            payload = assemble(cap, Math.max(0, items.length - fit.dropped))
            bytes = measureJsonBytes(payload)
            break
          }
        }
      }
      return {
        ...payload,
        budget: { limitBytes: FIRST_READ_BUDGET_BYTES, bytes, overBudget: bytes > FIRST_READ_BUDGET_BYTES }
      }
    }
  },
  {
    name: 'project search',
    dataShape: 'array',
    readOnly: true,
    desc: '在指定项目中按普通关键词有界搜索接手说明、所有状态事项的标题/描述及评论正文（data 是命中数组，计数与翻页在顶层 meta）',
    args: [
      { flag: '--query', type: 'string', required: true, desc: '非空关键词；% 和 _ 按普通字符处理' },
      { flag: '--limit', type: 'string', desc: `返回条数上限（默认 20）；${LIMIT_ZERO_DOC}` },
      { flag: '--offset', type: 'string', desc: '结果分页偏移（默认 0）' }
    ],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      const query = String(flags['--query'] ?? '').trim()
      if (!query) throw new UsageError('--query 不能为空')
      // 偏移交给族内唯一一处（1.0.109，修 `7f21841f`）：裸传不再静默变成 1
      const offset = parseOffset(flags['--offset'], 'project search')
      /**
       * `--limit 0` 在这条命令上曾被 `searchPage` 的 `Math.max(1, …)` **静默夹成 1 条**
       * （`8d78af0d`）：同一个 0，这里回 1 条、`todo list` 回全量。解析交给族内唯一一处。
       */
      const limit = parseLimit(flags['--limit'], 'project search') ?? 20
      const id = ctx.deps.projectRepo.resolveId(raw)
      /**
       * 计数与命中分开（1.0.107，修 `9bf9f667`）：`data` 回到**命中数组**。
       *
       * 1.0.106 给这条命令补 `--limit` / `--offset` 时，顺手把 `data` 从数组换成了
       * `{results, matched, returned, truncated, nextOffset}`。翻页本身是对的，
       * 但**形状变更没有任何通告**：按数组解析的老脚本拿到对象后 `for` / `map`
       * 静默走空、不报错 —— 比报错更难查。
       *
       * 这正是 `Outcome.meta` 注释里那句设计承诺要挡的事："data 是数组时
       * **必须继续是数组**"（改成对象会让调用方遍历为空、且不报错）。
       *
       * 计数同时挪到**顶层 `meta`**，键名与 `todo list` 一致
       *（matched/returned/truncated/nextOffset）—— 同一类信息在两条命令里
       * 落在同一层级，调用方不必再记住"这条在 data、那条在 meta"。
       */
      const page = ctx.deps.projectRepo.searchPage(id, query, { limit, offset })
      return {
        __meta: {
          matched: page.matched,
          returned: page.returned,
          truncated: page.truncated,
          nextOffset: page.nextOffset
        },
        data: page.results
      }
    }
  },
  {
    name: 'project handoff-history',
    dataShape: 'object',
    readOnly: true,
    desc:
      '列出项目接手说明的修订历史（最新在前；不含全文，只有序号/作者/时间/种类/长度/首行摘要）。' +
      '最多保留最近 50 版。要看某一版全文用 `project handoff-revision`',
    args: [{ flag: '--limit', type: 'string', desc: `最多几条（默认全部，最多 50 版）；${LIMIT_ZERO_DOC}` }],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      // 解析交给族内唯一一处（`8d78af0d`）：`--limit 0` 与不传同义（全部，最多 50 版）
      const limit = parseLimit(flags['--limit'], 'project handoff-history')
      const id = ctx.deps.projectRepo.resolveId(raw)
      const revisions = ctx.deps.projectRepo.listHandoffRevisionSummaries(id, limit)
      return {
        project: projectNameOf(ctx, id),
        total: ctx.deps.projectRepo.getDetail(id)?.handoffRevisionCount ?? revisions.length,
        returned: revisions.length,
        revisions
      }
    }
  },
  {
    name: 'project handoff-revision',
    dataShape: 'object',
    readOnly: true,
    desc: '读取接手说明某一版修订的全文（用 `project handoff-history` 先看有哪些版）',
    args: [
      {
        flag: '--revision',
        type: 'string',
        required: true,
        desc: '修订序号（如 3，或写成 #3）或修订 id / id 前缀'
      }
    ],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      const ref = String(flags['--revision'] ?? '').trim()
      if (!ref) throw new UsageError('缺少 --revision（修订序号或 id）')
      const id = ctx.deps.projectRepo.resolveId(raw)
      const revision = ctx.deps.projectRepo.getHandoffRevision(id, ref)
      if (!revision) throw new NotFoundError(`接手说明修订不存在: ${ref}（先跑 project handoff-history 看序号）`)
      return revision
    }
  },
  {
    name: 'project handoff-rollback',
    dataShape: 'object',
    desc:
      '把接手说明回滚到某一版：该版全文会作为**新的一次保存**写回（留痕为「回滚」，不删任何中间版本）。' +
      '该版内容已等于当前说明时不写，回执 changed=false',
    args: [
      {
        flag: '--revision',
        type: 'string',
        required: true,
        desc: '要回滚到的修订序号（如 3，或写成 #3）或修订 id / id 前缀'
      }
    ],
    positional: { name: 'id', required: true, desc: '项目 id、短 id 或完整名称' },
    run: (ctx, flags, positional) => {
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少项目 id 或名称')
      const ref = String(flags['--revision'] ?? '').trim()
      if (!ref) throw new UsageError('缺少 --revision（修订序号或 id）')
      const id = ctx.deps.projectRepo.resolveId(raw)
      if (!ctx.deps.projectRepo.getHandoffRevision(id, ref)) {
        throw new NotFoundError(`接手说明修订不存在: ${ref}（先跑 project handoff-history 看序号）`)
      }
      const result = ctx.deps.projectRepo.rollbackHandoff(id, ref, actorOf(ctx), {
        version: ctx.meta.version
      })
      if (result.changed) {
        try {
          // 让常驻 GUI 刷新接手说明（项目类变更）；广播失败不能让回滚本身失败
          ctx.deps.events.append('project', actorOf(ctx), { cmd: 'project handoff-rollback', id })
        } catch {
          /* ignore */
        }
      }
      return {
        project: projectNameOf(ctx, id),
        changed: result.changed,
        revision: result.revision
          ? {
              id: result.revision.id,
              seq: result.revision.seq,
              kind: result.revision.kind,
              sourceSeq: result.revision.sourceSeq,
              author: result.revision.author
            }
          : null,
        ...(result.changed ? {} : { note: '该版内容已等于当前接手说明，未写入新修订' })
      }
    }
  },
  {
    /**
     * `project archive` / `project unarchive`（1.0.111，卡 `c177e466`）
     *
     * 2026-10-09 主用户拍的口径：**界面优先建议归档**，永久删除才是"清空、不保留"。
     * 归档必须是**可逆**的，否则"首选"只是个更好听的说法 —— 所以两个方向都给：
     * 归档只是置一个标志位（数据一条不动、接手说明与版本都在），取消归档即回到候选。
     *
     * 风险档按写处理：它改的是项目清单（新建事项的候选），但不动任何一条数据。
     */
    name: 'project archive',
    dataShape: 'object',
    risk: 'write',
    desc:
      '归档项目：**可逆**，数据一条不动，只是不再出现在新建事项的候选里 —— ' +
      '要"让项目消失但不丢数据"就用这条，别用 project rm',
    args: [],
    positional: { name: 'id', required: true, desc: '项目 ID（支持前缀）' },
    run: (ctx, _flags, positional) => {
      const id = positional[0]
      if (!id) throw new UsageError('缺少项目 id')
      const project = ctx.deps.projectRepo.update({
        id: ctx.deps.projectRepo.resolveId(id),
        archived: true,
        actor: actorOf(ctx)
      })
      return {
        id: project.id,
        name: project.name,
        archived: project.archived,
        message: '已归档：事项、评论、接手说明、版本登记都还在，`project unarchive <id>` 可恢复。'
      }
    }
  },
  {
    name: 'project unarchive',
    dataShape: 'object',
    risk: 'write',
    desc: '取消归档：把项目放回新建事项的候选（归档的另一半，没有它"可逆"就是空话）',
    args: [],
    positional: { name: 'id', required: true, desc: '项目 ID（支持前缀）' },
    run: (ctx, _flags, positional) => {
      const id = positional[0]
      if (!id) throw new UsageError('缺少项目 id')
      const project = ctx.deps.projectRepo.update({
        id: ctx.deps.projectRepo.resolveId(id),
        archived: false,
        actor: actorOf(ctx)
      })
      return { id: project.id, name: project.name, archived: project.archived, message: '已取消归档。' }
    }
  },
  {
    /**
     * 永久删除项目（1.0.111 改口径，卡 `c177e466`）
     *
     * ⚠️ **`--to` 没了**（1.0.111）。旧语义是"其下事项不跟着删，先迁到别的项目"，
     * 默认落点是"除自己以外的第一个项目" —— 于是**不选承接项目也能删**，
     * 而且会把事项的 project_id 置空，与"事项必须归项目"冲突。
     * 2026-10-09 的口径是：**永久删除 = 清空整个项目数据，不保留**。
     *
     * 报错面向还在传 `--to` 的调用方：那是**设计变更**，不是参数写错。
     */
    name: 'project rm',
    dataShape: 'object',
    risk: 'destructive',
    desc:
      '**永久删除**项目：项目内的事项、评论、流转、通知、版本登记、接手说明与提议一并清掉，' +
      '不可恢复。只想让项目"消失"请用 `project archive`（可逆）',
    args: [
      {
        flag: '--yes',
        type: 'boolean',
        desc: '确认删除。CLI 不做交互式提问，缺这个参数直接报错'
      }
    ],
    positional: { name: 'id', required: true, desc: '项目 ID（也接受项目名，名字前缀唯一时同样可用）' },
    run: (ctx, flags, positional) => {
      const id = positional[0]
      if (!id) throw new UsageError('缺少项目 id')
      if (!flags['--yes']) throw new UsageError('删除项目需要确认，请加 --yes')
      // 支持 id 前缀（前 8 位就够定位），回显真实完整 id 便于后续引用
      const fullId = ctx.deps.projectRepo.resolveId(id)
      const result = ctx.deps.projectRepo.delete(fullId)
      return {
        deleted: fullId,
        projectName: result.projectName,
        removed: result.removed,
        message:
          `已永久删除「${result.projectName}」：项目内 ${result.removed.todos} 条事项及其 ` +
          `评论 ${result.removed.comments} / 流转 ${result.removed.transitions} / 通知 ${result.removed.notifications} ` +
          `一并清掉，其他项目的数据没动。`
      }
    }
  },
]
