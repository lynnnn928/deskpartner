/**
 * 分类命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 */

import { NotFoundError, UsageError } from '../../lib/domain-errors'
import { categoryMergeRisk, resolveMergeEndpoints } from '../command-core'
import type { CommandSpec } from '../command-core'
import { confirmationCommands, normalizeGrantArgv } from '../command-table'

export const categoryCommands: CommandSpec[] = [
  {
    name: 'category list',
    dataShape: 'array',
    readOnly: true,
    desc: '列出所有分类（分类即 story 层：一个方向 / 一个议题）',
    args: [],
    run: (ctx) =>
      ctx.deps.categoryRepo.list().map((c) => ({
        id: c.id,
        name: c.name,
        isDefault: c.isDefault,
        sortOrder: c.sortOrder
      }))
  },
  {
    name: 'category add',
    dataShape: 'object',
    desc: '新建分类 —— agent 用它创建 story（一个方向 / 一个议题）',
    args: [
      { flag: '--name', type: 'string', required: true, desc: '分类名，如"竞争调研"' },
      { flag: '--color', type: 'string', desc: '颜色，如 #5388F6；不传用默认蓝' }
    ],
    run: (ctx, flags) => {
      const name = String(flags['--name'] || '').trim()
      if (!name) throw new UsageError('--name 不能为空')

      const cats = ctx.deps.categoryRepo.list()
      if (cats.some((c) => c.name === name)) {
        throw new UsageError(`分类已存在: ${name}`)
      }

      const created = ctx.deps.categoryRepo.create({
        name,
        color: flags['--color'] ? String(flags['--color']) : '#5388F6'
        /**
         * `sortOrder` 不再自己算（1.0.109，卡 `681528e5`）：`cats.length` 是"条数"不是"末尾"，
         * 删过 / 合并过分类之后会退回已经用过的值、与已有的撞序。省略即由仓储取 MAX+1。
         */
      })
      return { id: created.id, name: created.name }
    }
  },
  {
    name: 'category rm',
    dataShape: 'object',
    risk: 'destructive',
    // v9 起分类多值，删标签不动待办本身，只是让它们少了这个标签。
    // 想把待办改挂到别的标签，用 category merge。
    desc: '删除分类；其下待办保留，仅失去这个标签（系统默认分类不可删）',
    args: [
      {
        flag: '--yes',
        type: 'boolean',
        desc: '确认删除。CLI 不做交互式提问，缺这个参数直接报错'
      }
    ],
    positional: { name: 'id', required: true, desc: '分类 ID（支持前缀短号，如卡片上的 8 位）' },
    run: (ctx, flags, positional) => {
      const id = positional[0]
      if (!id) throw new UsageError('缺少分类 id')
      if (!flags['--yes']) {
        throw new UsageError('删除分类需要确认，请加 --yes')
      }
      /**
       * ⚠️ 必须走 resolveId（1.0.48 修，Bob f159d799）。
       *
       * 原先直接把参数交给 repo，而 repo 用 getById 精确匹配 ——
       * 传短号（`category rm c8fbebbe`）时查不到，且旧实现**静默返回 0**，
       * 于是：退出码 0、授权被消费、回执说成功，分类一条没删。
       * 三重欺骗叠在一起（agent 以为完事 / 人以为生效 / 审计说用掉了）。
       *
       * 这里也把"不存在"转成 NotFoundError（exit 3），让失败有明确的
       * 错误码可依 —— 假成功比报错贵得多。
       */
      let resolved: string
      try {
        resolved = ctx.deps.categoryRepo.resolveId(id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('不存在')) throw new NotFoundError(`分类不存在: ${id}`)
        throw new UsageError(msg)
      }

      const result = ctx.deps.categoryRepo.delete(resolved)
      // 把迁移条数告诉调用方：用户需要知道"那些任务去哪了"
      return { deleted: resolved, affectedTodos: result.affectedTodos }
    }
  },
  {
    name: 'category merge',
    dataShape: 'object',
    risk: 'write',
    /**
     * 档位**由目标决定**（1.0.107，修 `28a13efe`）：源分类下还有待办时转成删除档，
     * 空的源分类仍按写档直接执行。判据与理由见 `categoryMergeRisk`。
     *
     * 这也解决卡上点的第二处不自洽 —— 它此前声明 write 档，却被列在
     * `normalizeGrantArgv` 的 `needsConfirmation` 集合里（那是删除档才用得上的集合，
     * 而那个函数按**静态**档位判，所以那条登记一直不生效）。
     * 1.0.107（`b3fe692e`）已把那份手写名单换成从命令表推导（`confirmationCommands`），
     * "走不到的登记"这一类从此不可能再出现。
     *
     * ⚠️ 补 `--yes` 这次**没有**改 `normalizeGrantArgv`，走的是"已批准的执行放行 `--yes`"
     * 那条（见 `run` 里的 `preApprovedGrantId`），与 `todo delete-comment` 同一个形状。
     * 理由：授权记录里的 argv 必须是**真正会被执行的东西** —— 批准后回放时调用方
     * 本来就没带 `--yes`（那是"我确认要删"的语义，属于批准方的话），
     * 所以该放行的是执行，而不是给账面凭空补一个参数。
     */
    dynamicRisk: categoryMergeRisk,
    desc:
      '把 A 合并进 B：A 下所有待办改挂到 B，然后删掉 A（收拾同义标签用）。' +
      'A / B 写名字、id 或 id 前缀都行。' +
      'A 下还有待办时算删除档、需人点头；A 是空的则按写档直接执行',
    args: [
      {
        flag: '--yes',
        type: 'boolean',
        desc: '确认合并。这是不可逆操作，缺这个参数直接报错'
      },
      {
        flag: '--from',
        type: 'string',
        desc: '源分类：名字 / id / id 前缀都行（与 --to 配套，可替代位置参数）'
      },
      {
        flag: '--to',
        type: 'string',
        desc: '目标分类：名字 / id / id 前缀都行（与 --from 配套）'
      }
    ],
    /**
     * 刻意标成**可选**：这条命令既接受位置参数（两个 id），
     * 也接受 --from/--to 按名字指定。标 required 的话，框架会在
     * 解析 flags 之前就拦下"没给位置参数"的调用，
     * 按名字的用法就永远走不到 —— 报"缺少 ids"这种误导性错误。
     * 必填性由命令内部按实际给法校验，报错才能说清缺的是什么。
     */
    positional: {
      name: 'ids',
      required: false,
      /**
       * **两个** —— 全仓唯一一条吃多个位置参数的命令（`category merge <源> <目标>`）。
       *
       * 不声明的话，多给判据会按默认的 1 把它自己合法的第二个 id 当成"多余参数"拒掉
       * （1.0.107，修 `350f9631`）。这条字段也是"默认 1"能被安全采用的前提：
       * 唯一的例外被显式写出来，而不是靠某个特殊的命令名兜着。
       */
      arity: 2,
      desc: '两个分类：源 目标（名字、id、id 前缀都行）。也可改用 --from / --to'
    },
    run: (ctx, flags, positional) => {
      /**
       * `--yes` 是**没走批准流程时的确认**（1.0.107，修 `28a13efe`）。
       *
       * 源分类下还有待办时这条会转成删除档、由**人的点头**充当确认；
       * 而服务端回放这次执行时，argv 里没有 `--yes` —— 它是调用方在被批准前
       * 不会带、也不该带的东西。不放行的话就成了"批了也做不成"。
       * 与 `todo delete-comment` 同一个形状（那边也是 `!ctx.preApprovedGrantId`）。
       *
       * 没有放宽安全性：伪的 `preApprovedGrantId` 在门禁那一步就被拒
       * （`assertScopeAllowed` 要拿它去核一条真正 granted 的申请）。
       */
      if (!flags['--yes'] && !ctx.preApprovedGrantId) {
        throw new UsageError('合并分类需要确认，请加 --yes')
      }

      /**
       * 两种写法都支持，**读法同一套**（1.0.108，修 `28a13efe`）：
       * - 位置参数 `category merge <源> <目标>`
       * - `--from "竞争调研" --to "竞品调研"`
       * 每一端都收名字 / id / id 前缀 —— 见 `resolveCategoryRef`（此前两种写法两套读法，
       * 按名字必失败）。`positional` 的说明里也写着同一件事，别只改一处。
       *
       * 解析抽到 `resolveMergeEndpoints`（档位判定与授权摘要也要用同一份结果），
       * 这里只负责把失败原因翻成对应的错误类型。
       */
      const endpoints = resolveMergeEndpoints(ctx, flags, positional)
      if (!endpoints.ok) {
        if (endpoints.reason === 'not-found') throw new NotFoundError(endpoints.detail)
        throw new UsageError(endpoints.detail)
      }
      const { fromId, toId } = endpoints

      const result = ctx.deps.categoryRepo.merge(fromId, toId)
      return {
        merged: result.merged.name,
        into: ctx.deps.categoryRepo.list().find((c) => c.id === toId)?.name ?? toId,
        movedTodos: result.movedTodos
      }
    }
  },
]
