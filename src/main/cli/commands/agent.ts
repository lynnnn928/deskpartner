/**
 * 身份命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 */

import {
  writeCredential,
  credentialsPath,
  listCredentialIds,
  readCredentials,
  removeCredential
} from '../../../cli/credentials'
import { NotFoundError, UsageError } from '../../lib/domain-errors'
import { AGENT_GRANTS_DEFAULT_LIMIT, LIMIT_ZERO_DOC, parseLimit } from '../command-text'
import { actorOf, describeScope, inspectScope, isInteractive } from '../command-core'
import type { CommandSpec } from '../command-core'

export const agentCommands: CommandSpec[] = [
  {
    /**
     * R3-1：Agent 身份注册
     *
     * `created_by` 这种文本是**标注不是身份** —— 任何进程都能自称 `agent:xxx`。
     * 注册之后，"这台机器上有哪些 agent"才有据可查，视角切换与跨边界判断
     * 才有落脚点（R3-2 / R3-3 都依赖这一层）。
     *
     * 刻意不强制：未注册照样能写，只是"没有身份"。
     */
    name: 'agent register',
    dataShape: 'object',
    humanSelfService: true,
    desc: '注册一个 agent 身份（重复调用只更新展示信息，不改注册时间）',
    args: [
      { flag: '--id', type: 'string', required: true, desc: '标识，如 agent:bob（与 --created-by 同形）' },
      { flag: '--name', type: 'string', required: true, desc: '展示名，如 Bob' },
      { flag: '--color', type: 'string', desc: '主题色，如 #7F77DD' }
    ],
    run: (ctx, flags) => {
      const id = String(flags['--id'] ?? '').trim()
      const name = String(flags['--name'] ?? '').trim()
      if (!id) throw new UsageError('--id 不能为空')
      if (!name) throw new UsageError('--name 不能为空')

      const color = flags['--color'] === undefined ? null : String(flags['--color']).trim()
      const known = ctx.deps.agentRepo.get(id)
      const agent = ctx.deps.agentRepo.register({ id, displayName: name, color })

      /**
       * 接入的第一步就必须让人知道（1.0.63）
       *
       * ── 为什么注册要主动通知 ──
       *
       * 1.0.47 起注册与领凭据都是**自助**的，agent 办完这两步就静默等着 ——
       * 它没有"授权申请"记录，也不卡在任何一条命令上。若只靠人自己去用户页翻，
       * 新成员会一直躺在"等你点头"里没人理，而它自己以为"我等就是了"。
       * 这正是"人机交接面"该补的一环：**它来了，得有人说一声**。
       *
       * 与授权申请（`grant`）走同一个机制（events 表 + GUI 轮询弹横幅），
       * 但用**独立的 type**：申请是"它卡在那条命令上等你"，
       * 注册是"它刚到场、还没干活"，两者的横幅文案与去处分组都不同，
       * 混在一个 type 里会让横幅分不清自己代表哪种等待。
       *
       * ⚠️ 只在**首次**注册时发。重复注册只是更新展示名（1.0.35 的既定语义），
       * 它早就躺在"等你点头"里了，再来一条通知等于催命。
       *
       * ⚠️ 通知失败不能连累注册本身：注册已经落库了，让调用方看到报错会误以为
       * 没注册成功、转头重试 —— 而它其实成功了。写在 nextSteps.notifiedHuman 里
       * 如实告知（没有就已读不写）。
       */
      let notifiedHuman = false
      if (!known) {
        try {
          ctx.deps.events.append('agent_register', actorOf(ctx), {
            agentId: id,
            displayName: agent.displayName,
            createdAt: agent.createdAt
          })
          notifiedHuman = true
        } catch (err) {
          console.error(
            '[agent register] 通知事件写入失败:',
            err instanceof Error ? err.message : String(err)
          )
        }
      }

      /**
       * 交接口诀：**每一步都告诉它下一步敲什么**。
       *
       * 旧回执只回一个 agent 对象，调用方得自己从 hasCredential/approved
       * 两个布尔值推理"我卡在哪"—— 而推理错的代价是它去重复注册、
       * 或者干脆以为办完了开始写、然后撞 identity_pending。
       */
      return {
        ...agent,
        reused: Boolean(known),
        needsApproval: !agent.approved,
        nextSteps: known
          ? [
              { step: '1/3 注册身份', status: 'done' },
              {
                step: '2/3 领凭据',
                status: agent.hasCredential ? 'done' : 'todo',
                ...(agent.hasCredential ? {} : { command: `agent credential --id ${id}` })
              },
              {
                step: '3/3 等人批准写入',
                status: agent.approved ? 'done' : 'waiting',
                ...(agent.approved ? {} : { who: 'human' })
              }
            ]
          : [
              { step: '1/3 注册身份', status: 'done' },
              { step: '2/3 领凭据', status: 'todo', command: `agent credential --id ${id}` },
              { step: '3/3 等人批准写入', status: 'waiting', who: 'human' }
            ],
        ...(notifiedHuman
          ? {
              humanNotified:
                `已在界面上提醒用户：「${agent.displayName} 已接入，等你批准」` +
                '（顶部横幅 + 主窗口「审批」页的「待批准身份」）。你不用反复催，也不必重发注册。'
            }
          : {}),
        nextHint: known
          ? '这个身份已存在，本次只更新了展示信息（注册时间不变）。'
          : `接着跑 \`agent credential --id ${id}\` 领凭据；批准由用户点头，你只要等。` +
            '查自己卡在哪一步：`agent whoami`（不带参数 = 自检）。'
      }
    }
  },
  {
    name: 'agent list',
    dataShape: 'array',
    readOnly: true,
    desc: '列出已注册的 agent 身份（按注册时间正序）',
    args: [],
    run: (ctx) => ctx.deps.agentRepo.list()
  },
  {
    name: 'agent whoami',
    dataShape: 'object',
    readOnly: true,
    desc: '查某个标识有没有身份；不带 id 时查**本次调用**的身份与能不能写（自检用）',
    args: [],
    positional: { name: 'id', required: false, desc: '标识，如 agent:bob；支持前缀；省略则查当前调用身份' },
    run: (ctx, _flags, positional) => {
      const input = (positional[0] || '').trim()

      /**
       * 不带 id = 自检：这次调用是谁、持不持证、能不能写。
       *
       * agent 最常问的问题就是"我现在到底有没有身份"，而此前它只能
       * 靠报错反推（先撞一次墙才知道）。把结论直接给出来，
       * 比让它从三张表里自己推理可靠得多。
       */
      if (!input) {
        const actor = actorOf(ctx)
        const hit = ctx.deps.agentRepo.get(actor)
        const token = ctx.credential?.trim() || ''
        const credentialState = !token
          ? 'missing'
          : ctx.deps.agentRepo.verifyCredential(actor, token)
            ? 'valid'
            : 'invalid'
        const approved = Boolean(hit?.approved)
        const verified = credentialState === 'valid'
        return {
          actor,
          interactive: isInteractive(ctx),
          registered: Boolean(hit),
          approved,
          hasCredential: Boolean(hit?.hasCredential),
          credential: credentialState,
          /** 直接给结论，别让调用方自己拼三条判据 */
          canWrite: isInteractive(ctx) || (approved && verified),
          /**
           * 分级授权的自检（1.0.36）：先撞墙才知道自己没权限，是最差的反馈方式
           * （agent 会在任务做到一半时才发现改不了界面）。把三档结论一次给全，
           * 它就能在开工前决定要不要先请人授权。
           */
          scopes: {
            read: true,
            write: isInteractive(ctx) || (approved && verified),
            config: describeScope(ctx, 'config'),
            destructive: describeScope(ctx, 'destructive')
          },
          /**
           * 真实可用性（1.0.65 修 `b74d9fb3`）。
           *
           * `scopes` 那一列回答"有没有这一档"，本段回答"**这一档现在能不能用**"
           * —— 两者在"上一次执行失败"和"授权已用掉"这两种情形下会分叉：
           * 前者 `scopes.destructive` 仍是 `once`（牌还在），
           * 但 agent 若只看那一列，会以为"我还能删"，于是照着错误的结论往下走。
           *
           * 三态：
           * - `granted` 已批准且可用；
           * - `retryable` 已批准但上一次执行失败 —— 可重试同一件事；
           * - `unavailable` 已被消费 / 撤销 / 过期 / 拒绝 —— 这条牌不再算数。
           *
           * `detail` 是给人看的那句话（为什么不可用 / 上次错在哪），
           * `state` 是给程序分支用的。**别只读 state 就当结论** ——
           * 两者并存正是因为"能不能重试"这件事必须连原因一起看。
           */
          scopeDetails: {
            config: inspectScope(ctx, 'config'),
            destructive: inspectScope(ctx, 'destructive')
          },
          /**
           * 多份凭据、这次没声明身份（1.0.37）。
           *
           * 自检必须把这条说出来：否则 agent 看到 actor 是 human、
           * canWrite 是 false，会以为自己没注册，转头去重新注册 ——
           * 而真正的原因是本机有多个身份、启动器不替它猜。
           */
          ...(ctx.ambiguousIds?.length
            ? {
                ambiguousIdentity: {
                  candidates: ctx.ambiguousIds,
                  fix: `export DESKPARTNER_AGENT=${ctx.ambiguousIds[0]}`
                }
              }
            : {}),
          ...(hit
            ? {}
            : {
                /**
                 * "身份不明确"时不能说"你没注册"—— 那会把 agent 指去重新注册，
                 * 而它其实早就注册过了，缺的只是**这次调用声明是谁**。
                 * 指错路比不指路更浪费时间（实测：自检里同时给出
                 * ambiguousIdentity 和"先 agent register"的 note，后者是错的）。
                 */
                note: ctx.ambiguousIds?.length
                  ? '本次调用没声明身份，而本机有多个 agent 凭据 —— 启动器不会替你猜，' +
                    '写命令会被 `ambiguous_identity` 拦下。按上面的 `ambiguousIdentity.fix` 声明后重试即可。'
                  : '未注册的 agent 身份**只能读、不能写**。' +
                    '先 `agent register --id ' + actor + ' --name "展示名"`（这条你可以自己跑，' +
                    '1.0.47 起注册与领凭据都是自助的），' +
                    '再 `agent credential --id ' + actor + '` 领凭据，最后请用户在界面上批准。'
              }),
          /**
           * MCP 接入的自检提示（1.0.63）
           *
           * 走 MCP 的调用方在工具清单里找不到 `agent register` / `agent credential`
           * —— 那两条**故意不暴露成工具**（它们要落到凭据文件，属于接入动作，
           * 不是干活动作）。但这不意味着它没法自助：用同一份启动器跑一次命令行即可。
           * 不写清这一点，接入方会以为是功能缺失，转头去问人。
           */
          ...(ctx.surface === 'mcp'
            ? {
                mcpNote:
                  '你是通过 MCP 接入的：身份用 env 的 DESKPARTNER_AGENT 或写工具的 `actor` 入参声明；' +
                  '`agent register` 与 `agent credential` 这两步工具面里没有（它们要落凭据文件，' +
                  '属于接入动作不是干活动作），用同一份启动器的命令行各跑一次即可 —— ' +
                  '之后 MCP 这边会自动带上身份与凭据。'
              }
            : {}),
          ...(hit && !approved
            ? {
                /**
                 * 已注册、等人批准（1.0.63 修了这条文案的两处失真）
                 *
                 * 1. **入口写错了**：原文案说「设置 → Agent 接入」，而 1.0.60 起
                 *    这块整体迁到了「审批」页的「待批准身份」—— 照旧文案去找，
                 *    人会在一个已经不存在的入口里翻。
                 * 2. **没说清"你该做什么"**：agent 看到 pending 会去重试写命令
                 *    （重试无用，只多一次 identity_pending），或者反复发注册。
                 *    注册那一刻已经落了一条通知事件，界面会弹横幅 ——
                 *    正确动作就是**等**，这句话得写出来。
                 */
                pending: '已注册但尚未批准写入 —— 你在等用户点头，不需要重试写命令、也不必重复注册。',
                nextStep:
                  '用户侧的入口：主窗口「审批」页 → 待批准身份（注册时界面已弹横幅提示过一次）。' +
                  '用户点「批准」之后你就能写了，届时 `agent whoami` 的 canWrite 会变成 true。'
              }
            : {}),
          ...(approved && !verified
            ? { pending: '已批准，但本次调用没带有效凭据 —— 跑 `agent credential --id ' + actor + '` 领一份' }
            : {})
        }
      }

      // id 不是 todo，没有 resolveId；这里按前缀匹配一次，找不到就当未注册
      let hit = ctx.deps.agentRepo.get(input)
      if (!hit) {
        const all = ctx.deps.agentRepo.list()
        const matched = all.filter((a) => a.id.startsWith(input))
        if (matched.length === 1) hit = matched[0]
        else if (matched.length > 1) {
          throw new UsageError(`「${input}」匹配到多个身份，请写全：${matched.map((a) => a.id).join(', ')}`)
        }
      }

      if (!hit) {
        return {
          id: input,
          registered: false,
          /**
           * 文案必须与写入路径的实际行为一致。
           *
           * 旧文案写「未注册也能写待办」—— Bob实测（9e0396b1）：它照这句省掉了注册，
           * 第一次 todo add 就被硬拒（退出码 3）。同一版本里 whoami 和写入路径
           * 说的是相反的话，agent 信了更宽松的那句，然后在最不该撞墙的时刻撞墙。
           */
          note:
            '未注册的 agent 身份**只能读、不能写** —— 用它执行 todo add / update / done / rm ' +
            '会被拒绝（退出码 3、errorCode not_found）。先 `agent register --id ' +
            input +
            ' --name "展示名"` 注册再来写入。注：human 是天然身份，不需要注册。'
        }
      }

      // 查过就算一次心跳
      ctx.deps.agentRepo.touch(hit.id)

      /**
       * 查**指定身份**时也要给各档状态（2026-09-22 修，Bob 156fa923 实测报的）。
       *
       * 自检分支（不带 id）早就有 scopes，但带 id 的分支只 `{...hit}` 展开
       * agent 记录 —— 而 grant_required 的文案里写着「跑 agent whoami
       * 自检会列出各档状态」，于是 agent 照做、拿到一份**没有档位字段**的输出，
       * 还得退回去用命令撞墙。承诺的能力必须真的存在（同 9e0396b1 那条教训：
       * 文案与实现不一致，agent 会信更宽松/更具体的那句，然后在最坏的时刻撞墙）。
       *
       * 与自检分支的差别要分清：自检答的是「**这次调用**能不能干」，
       * 这里答的是「**这个身份**手里有什么」—— 后者才是被别人查时的语义。
       * 所以给的是记录状态（含 expiresAt，调用方据此判断还有多久），
       * read/write 两档因为免批，直接给结论而不是去翻不存在的申请记录。
       */
      const scopeState = (s: 'read' | 'write' | 'config' | 'destructive') => {
        if (s === 'read') return { status: 'exempt', note: '读命令免批准' } as const
        if (s === 'write') {
          return Boolean(hit.approved) && Boolean(hit.hasCredential)
            ? ({ status: 'exempt', note: '写命令免长期批准（该身份已批准且有凭据）' } as const)
            : ({ status: 'blocked', note: '该身份未批准或缺凭据，不能写入' } as const)
        }
        // config / destructive 是一次性/会话级授权，看最新一条申请记录
        const latest = ctx.deps.agentRepo.listGrants({
          agentId: hit.id,
          scope: s,
          limit: 1
        })[0]
        if (!latest) return { status: 'none', note: '还没申请过这一档' } as const
        /**
         * 带上**执行回执**（1.0.48，主用户本轮定的判据）。
         *
         * 原先只给 status —— 而"批准即执行"之后，`status='granted'`
         * 有两种截然不同的含义：还没人点头、以及**人点了头但执行失败**。
         * 后者的一次性授权不销账（销账只在成功时发生），所以状态看起来
         * 与"刚获批"一模一样。agent 查 whoami 得到 `granted`，
         * 无从知道自己上次为什么没做成，只能在上下文里翻早先那条命令输出
         * ——而那段可能早就被裁掉了。
         *
         * 补上后，人与 agent 看的是同一份事实：界面上显示"上次执行失败：…"，
         * agent 这里也拿到同一句 execError。两侧对齐，对话才不会各说各话。
         */
        return {
          status: latest.status, // pending / granted / consumed / denied / revoked / expired
          requestId: latest.id,
          ...(latest.expiresAt ? { expiresAt: latest.expiresAt } : {}),
          ...(latest.summary ? { summary: latest.summary } : {}),
          ...(latest.execStatus ? { execStatus: latest.execStatus } : {}),
          ...(latest.execError ? { execError: latest.execError } : {}),
          ...(latest.executedAt ? { executedAt: latest.executedAt } : {})
        }
      }

      return {
        ...hit,
        registered: true,
        scopes: {
          read: scopeState('read'),
          write: scopeState('write'),
          config: scopeState('config'),
          destructive: scopeState('destructive')
        }
      }
    }
  },
  {
    /**
     * 领凭据（1.0.35）
     *
     * 注册只是"有了一个名字"，写入时仍无法证明"这次调用确实来自它" ——
     * 任何进程都能自称 agent:xxx。凭据把身份从**自称**升级成**持证**：
     * 明文只在返回时出现一次，库里只存哈希，文件落在用户主目录。
     *
     * 落盘而不是让人/agent 每次 export：让调用方"记得声明"是最不可靠的一环
     * （实测 1147 条 CLI 调用里 1142 条因此记成了 human）。
     * 落到 ~/.deskpartner/credentials.json 之后，启动器每次自动带上，
     * agent 只在第一次需要人帮它办手续。
     */
    name: 'agent credential',
    dataShape: 'object',
    humanSelfService: true,
    desc: '签发（或重发）某个 agent 身份的凭据，并落到 ~/.deskpartner/credentials.json',
    args: [
      { flag: '--id', type: 'string', required: true, desc: '身份，如 agent:bob' }
    ],
    run: (ctx, flags) => {
      const id = String(flags['--id'] ?? '').trim()
      if (!id) throw new UsageError('--id 不能为空')
      if (!ctx.deps.agentRepo.get(id)) {
        throw new NotFoundError(`身份未注册: ${id}。先 \`agent register --id ${id} --name "展示名"\``)
      }

      const issued = ctx.deps.agentRepo.issueCredential(id)
      if (!issued) throw new NotFoundError(`身份未注册: ${id}`)
      writeCredential(issued.agentId, issued.token)

      const total = listCredentialIds()
      return {
        agentId: id,
        credentialPath: credentialsPath(),
        /**
         * 落盘后的提示要区分单份/多份（1.0.37）。
         * 多份时"自动携带"不再成立 —— 启动器不知道这次是谁在调，需要显式声明。
         * 还说"自动带"会让 agent 以为万事大吉，然后在写命令上撞 ambiguous_identity。
         */
        ...(total.length > 1
          ? {
              declaredAs: id,
              otherCredentials: total.filter((x) => x !== id),
              note:
                `凭据已落盘。本机现在有 ${total.length} 份凭据，所以**不会自动挑**：` +
                `调用前请声明身份 —— export DESKPARTNER_AGENT=${id}` +
                `（或在命令里带 --created-by ${id}）。` +
                `不声明时写命令会被拒（ambiguous_identity），避免记到别的 agent 名下。` +
                `还需要用户在界面上点「批准」才能写入 —— 拿到身份不等于拿到写权限。`
            }
          : {
              note:
                '凭据已落盘，之后每次调用由启动器自动携带（不用再记着 export）；' +
                '重发后旧凭据立即失效。还需要用户在界面上点「批准」才能写入 —— ' +
                '拿到身份不等于拿到写权限。'
            })
      }
    }
  },
  {
    /**
     * 授权记录（1.0.36 撤销与审计）
     *
     * "谁能写入"只回答了一半问题 —— 另一半是**谁被允许过什么、什么时候、批了没有**。
     * 写命令的档位里，改界面与删除是要逐次点头的，那些点头都落在这张表里；
     * 把它开出来，人和 agent 才能查账，而不是只看到"它现在能不能写"这一个瞬时态。
     */
    name: 'agent grants',
    dataShape: 'object',
    /** 默认口径声明（收 `516a74d4`）：不传 --limit 时默认只回这么多条 */
    defaults: { limit: AGENT_GRANTS_DEFAULT_LIMIT },
    readOnly: true,
    desc: '列出授权记录：谁申请过改界面/删除、批了没、什么时候、用掉没有（撤销与审计）',
    args: [
      { flag: '--id', type: 'string', desc: '只看某个身份，如 agent:bob；支持前缀' },
      {
        flag: '--status',
        type: 'enum',
        enum: ['any', 'pending', 'granted', 'consumed', 'denied', 'revoked', 'expired'] as const,
        desc:
          '只看某状态，取值：any / pending / granted / consumed / denied / revoked / expired。' +
          'pending = 等人表态。expired 是呈现态（到点自动失效的 pending/granted），' +
          '筛 pending / granted 时会自动排除它们 —— 筛选与展示口径一致。' +
          '**不传 = 只看还有效的**，要连历史一起看传 --status any'
      },
      {
        flag: '--active',
        type: 'boolean',
        desc: '只看还有效的（pending / granted 且未过期）—— 1.0.107 起这也是**默认**口径'
      },
      {
        flag: '--limit',
        type: 'string',
        desc: `返回条数上限。**不传 = 默认最多 ${AGENT_GRANTS_DEFAULT_LIMIT} 条**；传 ${LIMIT_ZERO_DOC}`
      }
    ],
    run: (ctx, flags) => {
      const raw = flags['--id']
      let agentId: string | undefined
      if (raw !== undefined) {
        const input = String(raw).trim()
        const hit = ctx.deps.agentRepo.get(input)
        if (hit) {
          agentId = hit.id
        } else {
          const matched = ctx.deps.agentRepo.list().filter((a) => a.id.startsWith(input))
          if (!matched.length) throw new NotFoundError(`身份未注册: ${input}`)
          if (matched.length > 1) {
            throw new UsageError(`「${input}」匹配到多个身份，请写全：${matched.map((a) => a.id).join(', ')}`)
          }
          agentId = matched[0].id
        }
      }

      /**
       * 默认口径：**只看还有效的**（1.0.107，修 `99be5ae7`）
       *
       * 此前这条命令没有 `--limit`、默认也不设边界：实测默认回 81 条 / 66,409 字节，
       * 而其中 **0 条**是活着的授权 —— 全是 expired / consumed 的历史。
       * "还挂着哪些有效授权"是这条命令的主要用途，而它恰恰是那份默认输出里最不显眼的部分。
       *
       * 口径与 `todo list` 一致：**默认收窄到常用的那部分 + 默认有界 + 在回执里自报**，
       * 全量留给显式参数（`--status any` / `--limit 0`）。
       * 判据：**默认值可以窄，但不能是哑的** —— 说出口的默认必须能在回执里读到。
       */
      const statusRaw = flags['--status'] as
        | 'any'
        | 'pending'
        | 'granted'
        | 'consumed'
        | 'denied'
        | 'revoked'
        | 'expired'
        | undefined
      const status = statusRaw === 'any' || statusRaw === undefined ? undefined : statusRaw
      const activeOnly = flags['--active'] === true || statusRaw === undefined
      /** 调用方自己点了口径就不再替他声明默认（同 `todo list`：那是他的口径，不该啰嗦） */
      const declaredDefault = statusRaw === undefined && flags['--active'] !== true

      const limitGiven = flags['--limit'] !== undefined
      // 解析交给族内唯一一处（`8d78af0d`）：非负整数、0 = 全量、非法报 usage_error
      const limit = parseLimit(flags['--limit'], 'agent grants') ?? AGENT_GRANTS_DEFAULT_LIMIT

      const filter = {
        ...(agentId ? { agentId } : {}),
        ...(status ? { status } : {}),
        ...(activeOnly ? { activeOnly: true } : {})
      }
      /**
       * ⚠️ 计数与取页必须**同源**（共用同一份 `grantWhere`）：不同源的话，
       * "一共多少"和"这一页"会各按各的筛选算，`truncated` 就成了猜的。
       */
      const matched = ctx.deps.agentRepo.countGrants(filter)
      const grants = ctx.deps.agentRepo.listGrants({ ...filter, ...(limit > 0 ? { limit } : {}) })
      const truncated = limit > 0 && matched > grants.length

      /** 这句话**按真实参数生成**（同 `2e948042` / `3675f993`）：写死就会在传了参数时变成假话 */
      const limitClaim = !limitGiven
        ? `默认最多 ${limit} 条`
        : limit > 0
          ? `本次最多 ${limit} 条`
          : '本次为全量'

      return {
        /**
         * 计数进 `meta`（1.0.107，修 `99be5ae7`）。
         *
         * ⚠️ `data` 的形状**一个字没动**（仍是 `{count, note, grants}`）：
         * `count` 一直是"本次回了几条"，改它的含义就是一次无声的破坏性变更
         * （正是 `9bf9f667` 报的那类事）。"一共有多少条符合"放在 `meta.matched` 里。
         */
        __meta: {
          matched,
          returned: grants.length,
          truncated,
          ...(declaredDefault
            ? {
                defaultScope:
                  `只看还有效的（pending / granted 且未过期）；${limitClaim}；` +
                  '要连历史一起看传 --status any'
              }
            : {})
        },
        data: {
          count: grants.length,
          note:
            'scope=config 是改界面（本会话有效）、destructive 是删除（一次性，用掉即止）；' +
            'status=pending 的说明它已申请、正在等人表态。',
          grants
        }
      }
    }
  },
  {
    /**
     * 撤销（1.0.36）
     *
     * 只增不减的权限系统不算权限系统：批准错了、agent 变可疑了、
     * 或者只是想收回"改界面"，都得有一步就能做到的出口。
     *
     * 为什么限人执行：让 agent 自己撤销对自己的限制毫无意义，
     * 而让它撤销**别人**的限制更要命 —— 与注册/领凭据同一个道理。
     * 已经发生的（consumed/denied）不动：那是历史，撤回它等于改账本。
     */
    name: 'agent revoke',
    dataShape: 'object',
    humanSelfService: true,
    desc: '收回某个身份的授权（默认收回改界面与删除两档；--write 连带收回写入批准）',
    args: [
      { flag: '--id', type: 'string', required: true, desc: '身份，如 agent:bob' },
      {
        flag: '--scope',
        type: 'enum',
        enum: ['all', 'config', 'destructive'] as const,
        desc: '只收一档；默认 all'
      },
      { flag: '--write', type: 'boolean', desc: '连带收回写入批准（等于直接把它停掉）' }
    ],
    run: (ctx, flags) => {
      const id = String(flags['--id'] ?? '').trim()
      if (!ctx.deps.agentRepo.get(id)) throw new NotFoundError(`身份未注册: ${id}`)

      const scope = (flags['--scope'] as 'all' | 'config' | 'destructive' | undefined) ?? 'all'
      const revoked = ctx.deps.agentRepo.revokeGrants(id, scope === 'all' ? undefined : scope)

      let approved: boolean | undefined
      if (flags['--write'] === true) {
        const a = ctx.deps.agentRepo.setApproved(id, false)
        approved = a ? a.approved : undefined
      }

      return {
        agentId: id,
        scope,
        revokedGrants: revoked,
        ...(approved === undefined ? {} : { approved }),
        note:
          '只收回还没用掉的授权（pending / granted）；已经用掉的（consumed）是历史，不改。' +
          '重新给权限只要在界面上再点一次「允许」。'
      }
    }
  },
  {
    /**
     * 本机凭据清单（卡 `5074766a`，1.0.116）
     *
     * ## 它治的病
     *
     * 凭据文件与数据库是两份账，而在此之前**没有任何产品出口能看见前者的内容**：
     * `agent list` 列的是库里的身份，`agent credential --id` 只能签发。
     * 于是「文件里有 6 份、库里只有 5 个身份」这种事，只有拆开 JSON 的人才看得见
     * —— 而启动器的规矩是「多份又没声明身份就不猜」，多出来的那份会让每个调用方
     * 都被要求显式声明身份，却没人知道多的是哪一条、该不该删。
     *
     * ## 判据
     *
     * 1. 只读：列身份、签发时间、是否还在册、是不是默认 —— **不返回凭据本身**
     *    （那份 token 是能直接冒充身份的私钥，打进回执/日志就是泄漏）；
     * 2. `registered: false` 的就是孤儿，与 `agent list` 对得上账；
     * 3. 回执带 `path`：`count: 0` 时人得能自己去看那份文件是不是真的空。
     */
    name: 'agent credentials',
    dataShape: 'array',
    readOnly: true,
    desc: '列出本机凭据文件里的身份（含已不在册的孤儿），标明注册状态与默认身份 —— 不含凭据本身',
    args: [],
    run: (ctx) => {
      const file = readCredentials()
      const ids = Object.keys(file.profiles).sort()
      const rows = ids.map((id) => ({
        agentId: id,
        issuedAt: file.profiles[id]?.issuedAt ?? null,
        registered: Boolean(ctx.deps.agentRepo.get(id)),
        isDefault: file.default === id
      }))
      const orphans = rows.filter((r) => !r.registered).map((r) => r.agentId)
      return {
        __meta: {
          path: credentialsPath(),
          count: rows.length,
          orphanCount: orphans.length,
          ...(orphans.length
            ? {
                orphans,
                hint:
                  `这 ${orphans.length} 份凭据对应的身份已不在库里（跑 \`agent list\` 对账）。` +
                  '它们永远过不了校验，但会让「本机有多份凭据」成立、逼每个调用方都声明身份 —— ' +
                  '清理走 `agent purge-credentials --id <身份> --yes`'
              }
            : {})
        },
        data: rows
      }
    }
  },
  {
    /**
     * 孤儿凭据清理（卡 `5074766a`，1.0.116）
     *
     * ## 为什么与 `agent revoke` 分开
     *
     * 两件事的语义不同：`revoke` 收的是**库里的权限**（身份还在，权限没了），
     * 而这里删的是**本地文件里一条已经无害的凭据**（身份都不在了，权限无从谈起）。
     * 合成一条会让「我到底收回了什么」说不清；而且 `revoke` 要求身份在册，
     * 孤儿恰恰过不了那条前置 —— 这两件事本来就落在两张表上。
     *
     * ## 为什么归「办手续」类（`humanSelfService`）而不是删除档
     *
     * 删除档要的是「人给一次性的破坏性授权」，针对的是**能改数据**的动作。
     * 这里改的是凭据文件，且**只在身份不在册时才受理** —— 而那种凭据在任何一条
     * 写路径上都过不了校验（`assertCallerAllowed` 先查身份，查不到就
     * `identity_unregistered`），删它不减少任何可用能力，只减少身份歧义。
     * 做成删除档的代价是「清理一件无害的垃圾要先请人点一次允许」，而它要防的误删
     * （删到还在用的身份）已经由「不在册才受理」这条前置堵死了。
     *
     * 剩下两道显式动作：删除必须带 `--yes`（不传只报错、不动文件），
     * 已注册身份一律不受理（提示走 `agent revoke`）。
     */
    name: 'agent purge-credentials',
    dataShape: 'object',
    humanSelfService: true,
    desc: '删掉一条「已不在册」身份的本地凭据（孤儿清理）；已注册身份不受理，收回权限请用 agent revoke',
    args: [
      { flag: '--id', type: 'string', required: true, desc: '身份，如 agent:qwen' },
      { flag: '--yes', type: 'boolean', desc: '确认删除（必填；不传只报错，不动文件）' }
    ],
    run: (ctx, flags) => {
      const id = String(flags['--id'] ?? '').trim()
      if (!id) throw new UsageError('--id 不能为空')

      const file = readCredentials()
      const present = Object.keys(file.profiles).sort()
      if (!Object.prototype.hasOwnProperty.call(file.profiles, id)) {
        throw new NotFoundError(
          `本机没有这个身份的凭据：${id}。现有：${present.length ? present.join('、') : '（一份都没有）'}`
        )
      }

      /**
       * 已注册身份一律不受理 —— 这是这条命令唯一的安全边界。
       *
       * 删它在技术上只是「让对方下次调用报 credential_missing、再领一份」，
       * 但那是**破坏一个还在用的接入方**，而清理孤儿的目的是删垃圾。
       * 收权限请走 `agent revoke`：那条改的是库、可查账。
       */
      if (ctx.deps.agentRepo.get(id)) {
        throw new UsageError(
          `身份 ${id} 仍在册，这条命令不受理。要收回它的权限用 \`agent revoke --id ${id}\`；` +
            '删本地凭据只会让它的下一次调用报 credential_missing，权限一点没少。'
        )
      }

      if (flags['--yes'] !== true) {
        throw new UsageError(
          `删凭据要显式确认：加 --yes。将删除的是 ${id}（不在册），本机现有 ${present.length} 份。` +
            '不确定删哪条先跑 `agent credentials`'
        )
      }

      const result = removeCredential(id)
      return {
        agentId: id,
        credentialPath: credentialsPath(),
        removed: result.removed,
        /** 删掉的若是默认身份，回执要说清它的去向（否则人不知道下一次未声明身份会落到谁） */
        wasDefault: result.wasDefault,
        defaultAfter: result.defaultAfter,
        remaining: result.remaining,
        note:
          result.remaining > 0
            ? `已从凭据文件删掉 ${id}，本机还剩 ${result.remaining} 份。` +
              '库里没有任何变化（这个身份本来就不在册）。'
            : `已从凭据文件删掉 ${id}，本机现在没有凭据了 —— ` +
              '要用某个身份，先 `agent register` 再 `agent credential`。'
      }
    }
  }
]
