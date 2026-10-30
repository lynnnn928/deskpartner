/**
 * 版本命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 */

import { NotFoundError, UsageError } from '../../lib/domain-errors'
import type { ReleaseRepository } from '../../database/release.repository'
import { projectNameOf, resolveProjectForRelease, toArray } from '../command-core'
import type { CommandSpec } from '../command-core'

export const releaseCommands: CommandSpec[] = [
  {
    name: 'release add',
    dataShape: 'object',
    desc:
      '登记一个版本（版本对象）—— 记下"这版做了什么"，之后按版本号就能查出它收口了哪些卡片',
    args: [
      { flag: '--version', type: 'string', required: true, desc: '版本号，如 1.0.73' },
      {
        flag: '--project',
        type: 'string',
        required: true,
        desc: '这版属于哪个项目（名字或 id 前缀）。**必填** —— 版本是项目下的二级概念，不挂项目的版本不登记'
      },
      {
        flag: '--summary',
        type: 'string',
        desc: '这版在讲什么，一段话。与事项的 description 同理：这是**规格/摘要**，不是往来'
      },
      {
        flag: '--highlight',
        type: 'string',
        repeat: true,
        desc: '这版解决了什么，一条。**可重复传**（每次一条），按传入顺序存'
      },
      {
        flag: '--shipped-at',
        type: 'string',
        desc: '发布时刻（ISO 8601）。不传 = 还没发布 —— 不预填计划时间，那是编造'
      },
      {
        flag: '--tested',
        type: 'enum',
        enum: ['yes', 'no', 'skipped'],
        desc:
          '这版发版前跑没跑测试：yes=跑了且过 / no=跑了没过 / skipped=--skip-tests 跳过（没过测试闸门）。' +
          '不传 = 不知道（NULL）—— 历史行与手工登记不猜、不编造'
      }
    ],
    run: (ctx, flags) => {
      const version = String(flags['--version'] ?? '').trim()
      if (!version) throw new UsageError('--version 不能为空')

      // highlights 可能有多个：把 flags 里重复出现的 --highlight 收成数组
      const highlights = toArray(flags['--highlight']).map((s) => s.trim()).filter(Boolean)

      // --project 必填（版本是项目下的二级概念）：不传就停在入口，别猜归属
      const projectId = resolveProjectForRelease(ctx, flags['--project'])

      const release = ctx.deps.releaseRepo.create({
        version,
        projectId,
        ...(flags['--summary'] !== undefined ? { summary: String(flags['--summary']) } : {}),
        ...(highlights.length ? { highlights } : {}),
        ...(flags['--shipped-at'] !== undefined
          ? { shippedAt: String(flags['--shipped-at']).trim() || null }
          : {}),
        ...(flags['--tested'] !== undefined
          ? { tested: String(flags['--tested']) as 'yes' | 'no' | 'skipped' }
          : {})
      })

      /**
       * ⚠️ 回执要自报"这一版关联了多少卡片在等你标版本"
       *
       * 登记版本与"把卡片标上版本号"是**两个动作**（见迁移 31 的判据：
       * 不联动，免得"谁改了归属"查不出来）。但 agent 容易以为登记完就完事了，
       * 于是这里顺手把这版关联的事项数列出来 —— 看得见，才接得上下一步。
       */
      const detail = ctx.deps.releaseRepo.detail(projectId, version)
      return {
        version: release.version,
        projectId: release.projectId,
        shippedAt: release.shippedAt,
        highlights: release.highlights,
        // 自报测试事实（065dcde4）：验收方 dp release show 即可核对，不用问发版的人
        tested: release.tested,
        linkedTodos: detail?.todoCount ?? 0,
        note:
          '登记完成（项目接手说明已自动标为待复核）。下一步：① 把卡片归到这一版：todo update <id> --fixed-in ' +
          release.version +
          '；② 若本次发版改变了项目方向、关键决定、工作入口或当前主线，请用 project handoff-propose <项目名> --body-file <文件> 更新接手说明（切勿把发版日志或状态计数手抄进说明）'
      }
    }
  },
  {
    name: 'release list',
    dataShape: 'array',
    readOnly: true,
    desc: '列出登记过的版本（新发布在前）',
    args: [
      {
        flag: '--project',
        type: 'string',
        desc: '只看某个项目发过的版（名字或 id 前缀）'
      }
    ],
    run: (ctx, flags) => {
      // --project 是筛选（可选）：传了才定位；不传 = 跨项目全量
      let projectId: string | undefined
      if (flags['--project'] !== undefined && String(flags['--project']).trim()) {
        projectId = resolveProjectForRelease(ctx, flags['--project'])
      }

      const rows = projectId === undefined ? ctx.deps.releaseRepo.list() : ctx.deps.releaseRepo.listByProject(projectId)
      return rows.map((r) => {
        const detail = ctx.deps.releaseRepo.detail(r.projectId, r.version)
        return {
          version: r.version,
          projectId: r.projectId,
          shippedAt: r.shippedAt,
          summary: r.summary,
          highlights: r.highlights,
          tested: r.tested,
          todoCount: detail?.todoCount ?? 0
        }
      })
    }
  },
  {
    name: 'release show',
    dataShape: 'object',
    readOnly: true,
    desc: '看一个版本登记了什么，以及它收口了哪些卡片（按 (项目, 版本号) 定位）',
    args: [
      {
        flag: '--project',
        type: 'string',
        required: true,
        desc: '哪个项目的版本（名字或 id 前缀）—— 两个项目可以各有自己的 1.0.76'
      }
    ],
    positional: { name: 'version', required: true, desc: '版本号，如 1.0.73' },
    run: (ctx, flags, positional) => {
      const version = (positional[0] ?? '').trim()
      if (!version) throw new UsageError('缺少版本号')
      const projectId = resolveProjectForRelease(ctx, flags['--project'])
      const detail = ctx.deps.releaseRepo.detail(projectId, version)
      if (!detail) {
        /**
         * ⚠️ 找不到时**报错并列出现有版本**，不返回空对象
         *
         * 空对象会让调用方以为"这个版本存在但什么也没记"，
         * 与"这个版本根本没登记过"是两件事 —— 而后者才是常见情形
         * （比如查一个只被事项标过、没登记过历史的版本）。
         * 报错文案里说明这一点，调用方就知道该怎么补。
         *
         * 列已登记版本时**带项目名**（a2ea95f8）：两个项目各有 1.0.76 后，
         * 光说"已登记 1.0.76"分不出是哪个项目的。
         */
        const known = ctx.deps.releaseRepo
          .list()
          .map((r) => `${projectNameOf(ctx, r.projectId)}/${r.version}`)
        throw new NotFoundError(
          `版本 ${version} 在该项目下没有登记过（注意：事项可以标版本号而不要求版本被登记）。` +
            (known.length ? `已登记：${known.join('、')}` : '还没有任何版本被登记')
        )
      }
      return detail
    }
  },
  {
    name: 'release audit',
    dataShape: 'object',
    readOnly: true,
    desc:
      '发版对账：这一版关联了哪些卡、窗口里有没有已经做完却没标版本的卡（差集非空即对不上账）',
    args: [
      {
        flag: '--project',
        type: 'string',
        required: true,
        desc: '对账哪个项目（名字或 id 前缀）'
      },
      {
        flag: '--version',
        type: 'string',
        desc: '对账哪个版本；不传 = 这个项目最新登记的一版'
      }
    ],
    run: (ctx, flags) => {
      const projectId = resolveProjectForRelease(ctx, flags['--project'])
      const version = typeof flags['--version'] === 'string' ? flags['--version'].trim() : ''
      return ctx.deps.releaseRepo.audit(projectId, version || undefined)
    }
  },
  {
    name: 'release update',
    dataShape: 'object',
    desc: '改版本登记的内容（摘要 / 发布时刻 / 要点）—— 按 (项目, 版本号) 定位',
    args: [
      {
        flag: '--summary',
        type: 'string',
        desc: '这版在讲什么。传空串 = 清空'
      },
      {
        flag: '--project',
        type: 'string',
        required: true,
        desc: '定位：哪个项目的版本（名字或 id 前缀）。(项目, 版本号) 是版本的身份，**不支持改归属** —— 要挪项目就删了重建'
      },
      { flag: '--shipped-at', type: 'string', desc: '发布时刻（ISO 8601）；传 clear 清空' },
      {
        flag: '--tested',
        type: 'string',
        desc: '测试事实：yes / no / skipped；传 clear 清空（回到"不知道"）'
      },
      {
        flag: '--highlight',
        type: 'string',
        repeat: true,
        desc: '替换要点：**可重复传**，整组替换（不是追加）。不传 = 不动'
      }
    ],
    positional: { name: 'version', required: true, desc: '版本号' },
    run: (ctx, flags, positional) => {
      const version = (positional[0] ?? '').trim()
      if (!version) throw new UsageError('缺少版本号')
      // --project 是**定位键**：两个项目各有自己的 1.0.76，不定位就不知道改谁
      const projectId = resolveProjectForRelease(ctx, flags['--project'])
      if (!ctx.deps.releaseRepo.getByProjectAndVersion(projectId, version)) {
        throw new NotFoundError(`版本不存在: ${projectNameOf(ctx, projectId)} 下的 ${version}`)
      }

      const patch: Parameters<ReleaseRepository['update']>[0] = { version, projectId }

      if (flags['--summary'] !== undefined) {
        const s = String(flags['--summary'])
        patch.summary = s.trim() ? s : null
      }
      if (flags['--shipped-at'] !== undefined) {
        const raw = String(flags['--shipped-at']).trim()
        patch.shippedAt = !raw || raw === 'clear' ? null : raw
      }
      if (flags['--tested'] !== undefined) {
        const raw = String(flags['--tested']).trim()
        if (!raw || raw === 'clear') {
          patch.tested = null
        } else if (raw === 'yes' || raw === 'no' || raw === 'skipped') {
          patch.tested = raw
        } else {
          throw new UsageError(`--tested 只认 yes / no / skipped / clear，收到: ${raw}`)
        }
      }
      if (flags['--highlight'] !== undefined) {
        patch.highlights = toArray(flags['--highlight']).map((s) => s.trim()).filter(Boolean)
      }

      const updated = ctx.deps.releaseRepo.update(patch)
      const detail = ctx.deps.releaseRepo.detail(projectId, updated.version)
      return {
        version: updated.version,
        projectId: updated.projectId,
        shippedAt: updated.shippedAt,
        summary: updated.summary,
        highlights: updated.highlights,
        tested: updated.tested,
        linkedTodos: detail?.todoCount ?? 0
      }
    }
  },
  {
    name: 'release rm',
    dataShape: 'object',
    risk: 'destructive',
    desc:
      '删掉版本登记（事项上的版本号不受影响 —— 删的是"这次的登记"，不是"这版发过"）',
    args: [
      {
        flag: '--yes',
        type: 'boolean',
        desc: '确认删除。CLI 不做交互式提问，缺这个参数直接报错'
      },
      {
        flag: '--project',
        type: 'string',
        required: true,
        desc: '定位：哪个项目的版本（名字或 id 前缀）—— 两个项目各有自己的 1.0.76'
      }
    ],
    positional: { name: 'version', required: true, desc: '版本号' },
    run: (ctx, flags, positional) => {
      const version = (positional[0] ?? '').trim()
      if (!version) throw new UsageError('缺少版本号')
      if (!flags['--yes']) throw new UsageError('删除版本登记需要确认，请加 --yes')
      const projectId = resolveProjectForRelease(ctx, flags['--project'])
      const result = ctx.deps.releaseRepo.delete(projectId, version)
      return {
        deleted: result.deleted,
        orphanTodos: result.orphanTodos,
        ...(result.orphanTodos > 0
          ? {
              note:
                `还有 ${result.orphanTodos} 条事项标着 ${version}，它们不受影响（仍显示该版本号）—— ` +
                '要一并清掉请逐条 todo update <id> --fixed-in clear'
            }
          : {})
      }
    }
  },
]
