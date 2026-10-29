/**
 * CLI 命令的公共基础（拆分卡 bbeb1b51，纯搬移）
 *
 * 从前这些都长在 commands.ts 里。这里放的是**与具体命令无关**的部分：
 * 类型定义、`CliContext` 与依赖袋、身份解析、守卫（G1~G10 的调用判据）、
 * 风险档、参数解析（`parseFlags` 等）、以及软约束那几段提示文案。
 *
 * 依赖方向：text → core → table → {batch, exec, schema}；
 * `commands.ts` 只是把它们再导出一次的门面。
 */

import { writeCredential } from '../../cli/credentials'
import { FILE_FLAGS } from '../../cli/file-flags'
import type { TodoRepository } from '../database/todo.repository'
import { GuardError, NotFoundError, UsageError } from '../lib/domain-errors'
import type { CategoryRepository } from '../database/category.repository'
import { ProjectRepository } from '../database/project.repository'
import type { ReleaseRepository } from '../database/release.repository'
import type { MemoRepository } from '../database/memo.repository'
import type { SettingsRepository } from '../database/settings.repository'
import type { AgentRepository, GrantScope } from '../database/agent.repository'
import { sameTargetSet } from '../database/agent.repository'
// 事项评论（1.0.54）：CLI 侧要写入/读取，同样用值导入
import { CommentRepository } from '../database/comment.repository'
import { hasClosureSections } from '../database/closure-structure'
import type { UsageEvent } from '../database/telemetry.repository'
import { GuardResolver } from '../database/guard-resolver'
import type { PermissionAction } from '../database/rules'
import type { RulesRepository, RulesScope } from '../database/rules.repository'
import type { NotificationRepository } from '../database/notification.repository'
import type { ReminderReceiptRepository } from '../database/reminder-receipt.repository'
import type { ProtocolRepository } from '../database/protocol.repository'
import type { ProfileRepository } from '../database/profile.repository'
import fs from 'node:fs'
import dayjs from 'dayjs'

import { canonicalGrantArgv } from './command-table'

/**
 * 回放能不能用这条授权（`f9cd007e`）
 *
 * 默认要求 argv 逐字一致 —— 「批的是哪条命令，就执行哪条」。
 * 唯一放宽的一档：申请里没有 `--force`、回放时**只多一个** `--force`。
 *
 * 那是「这条还有 1 个子任务，确认要删请加 `--force`」这类二次确认的补票：
 * 命令没变、目标没变，变的只是"用户确认到什么程度"。
 * 而用户在审批页点「允许并强制」时，点的正是那个头。
 *
 * ⚠️ 只能放宽这一种：否则「批准删 A」会重新放开成「删 B」—— v19 那条漏洞的教训。
 */
function grantCoversArgv(storedRaw: string[], requestRaw: string[]): boolean {
  const stored = canonicalGrantArgv(storedRaw)
  const request = canonicalGrantArgv(requestRaw)
  if (JSON.stringify(stored) === JSON.stringify(request)) return true
  if (stored.includes('--force') || !request.includes('--force')) return false
  if (request.length !== stored.length + 1) return false
  const rest = request.filter((x) => x !== '--force')
  return JSON.stringify([...rest].sort()) === JSON.stringify([...stored].sort())
}

/** agent 未经提示就自行转入的状态 → 转出时给出的一句提醒文案 */
export const AWAITING_REVIEW_HINT =
  '提醒：「待验收」意味着请人来验收，请确认你已留下收口结论 —— ' +
  '用 `todo comment <id> --body "做了什么 / 结论 / 有什么坑"` 写一条评论（G3）。' +
  '描述只放原始规格，别再往描述里追加往来（1.0.54 起）。'

/**
 * G5（软约束）：**谁都能把事项送进 done，但必须写清它为什么算完了。**
 *
 * 主用户 2026-09-19 定的口径：与其用硬拦去猜"谁有资格置 done"，
 * 不如把口子放开、只要求说明 —— 判断"该不该完"的权力始终在人手里，
 * 但"为什么算完"这个事实必须落到明面上。
 * 否则过几天回看只剩一个空壳状态，谁也不知道它当初为什么被划掉。
 *
 * 与 G3 同一手法：给提醒而不是拒绝。硬拦会把"顺手勾掉一条"这类正当操作也挡住。
 *
 * ⚠️ **判据 1.0.110 升级过**（收 `eec2e1e7`）：原来只判"有没有评论"，
 * Bob实测**一次批量关 30 张卡全部放行**，而其中一半当初只有一行字。
 * 现在判"收口结论里有没有结构性要素"（`missingClosure`）。
 */
export const DONE_HINT =
  '提醒：把它标为已完成，请留下**带结构性要素**的收口结论（G5）。' +
  '**最省事的做法是 `todo close <id> --did … --verified … --pass-criteria … --leftover …`** —— ' +
  '它把「做了什么 / 怎么验证的 / 什么算通过 / 取舍与遗留」四段一次写全，' +
  '不用你自己组织语言（1.0.67 起）。' +
  '手写也行（`todo comment <id> --body "【做了什么】…"`），但**至少带上四段标记里的一个**：' +
  '一句话的评论（"做完了"）不算收口结论 —— 判据落在内容上，不看评论条数（1.0.110 起）。' +
  '描述只放原始规格，别再往描述里追加往来（1.0.54 起）。' +
  '否则过几天回看只剩一个「已完成」，谁也不知道它为什么算完了。'

/**
 * G5 的判据（1.0.110，收 `eec2e1e7`）：**收口文本里有没有结构性要素**。
 *
 * 收口文本 = 描述 ∪ 非驳回评论正文 —— 与 `todo list --fixed-in` 走的
 * `CommentRepository.closureByTodo` **同一口径、同一个判定函数**
 * （那边在同一轮里改成调 `hasClosureSections`，删掉了只认一段的 SQL LIKE）。
 *
 * ⚠️ 判的是"有没有结构"，不是"写得好不好"：质量判断做不了闸门
 * （"这段像不像交代清楚了"需要人判），所以只要求四段标记里出现**至少一个**。
 * 要求四段全齐会**逼出为过校验写的空壳段落** —— 这正是 1.0.67 做
 * `todo close` 时否掉过的方向（做"让写全成为最短路径"，而不是"多一道检查"）。
 *
 * ⚠️ 驳回评论**不算**收口结论：它是"哪里没做好"，与"为什么算完了"相反。
 */
export function missingClosure(ctx: CliContext, description: string | null, todoId: string): boolean {
  const bodies = ctx.deps.commentRepo
    .listByTodo(todoId)
    .filter((c) => c.kind !== 'reject')
    .map((c) => c.body)
  return !hasClosureSections([description, ...bodies])
}

/**
 * G9（软约束，1.0.63）：**在「待验收」的事项上写了评论，但状态没动**。
 *
 * ── 为什么需要这道闸门 ──
 *
 * 1.0.54 立了规矩「验收必须落到状态上，不能只写评论」，但它只写在说明书正文里，
 * 机制上一句都不拦。qwen 实测（4bdfe62a）当场踩实：对 b3ac3d32 复验不通过，
 * 它只发了一条说明性评论，事项仍留在「待验收」，被主用户当场抓到。
 *
 * 这不是它个人的疏忽 —— **文字规矩守不住是这台机器上反复验证过的事**
 * （同一条规矩它在同一轮里就没守住）。而候选池首尾两列是人机之间的确认关口，
 * 偏偏「不通过」这个结论没有硬拦的必要（写评论本身是正当动作），
 * 所以只能做成软提醒：不拦、不改退出码，只在回执顶层给一句话。
 *
 * ── 判据为什么必须窄 ──
 *
 * "这条评论像不像验收结论"需要判断，不能作为判据；条件本身必须机械可判：
 * ① 目标事项处于 `awaiting_review`；② 发言者**不是执行者**（= 他就是验收方）；
 * ③ 这次调用没有同时改状态（`todo comment` 本来就不改状态）。
 * 三条同时成立才提醒 —— 执行者在待验收的卡上补一句说明、验收方在做别的讨论，
 * 都不该被念。误报面因此很窄，而它省掉的正是"你得自己盯着验收有没有落到状态"。
 */
export const AWAITING_REVIEW_COMMENT_HINT =
  '提醒：这条在「待验收」列，你是验收方，而这次只留了评论、**状态没动**（G9）。' +
  '如果这就是验收结论，请落到状态上 —— ' +
  '**通过：`todo close <id> --did … --verified … --pass-criteria … --leftover …**' +
  '不通过：用 `todo reject <id> --reason "缺什么、要补什么"`（一步到位：写驳回评论 + 退回进行中）。' +
  '只写评论不落状态，执行方不知道自己被驳回了，看板也会把没做完的事说成"等你验收"。' +
  ' [!] **验收按角色，不按身份**（1.0.67 起，`a6032512`）：' +
  '**你只要不是这条的执行者**，`todo update <id> --status done --comment "验收通过：…"` 就能收口。' +
  '而**执行者验收自己做的活仍会被拒**（G10）—— 运动员不当裁判。' +
  '[!] 1.0.65 的文案写的是"只能由人在界面上点"，**1.0.67 之后这句已经不成立**；' +
  '若你在别处仍看到那句，那是漏改的旧文案，以本条为准。'

/**
 * 描述被整体替换且长度骤降时的提醒（1.0.49，修主用户 fa608cb9）
 *
 * 她本人撞出来的事故：给 10 条别人提的事项跑 `todo update --desc` 复测留证，
 * 回执 `ok:true, changed:["description"]`，看起来是普通编辑，
 * 实际把 alice 与主用户写的原始描述整段冲掉了 —— 包括
 * 「1.0.44 已做，请验收」那种带实现细节和验收指路的正文。
 *
 * 三层问题叠在一起，这里一次解决：
 * 1. `--desc` 语义从"替换"改成"追加"（要整体替换必须显式 `--overwrite-desc`）；
 * 2. 描述变更纳入 events（before/after），任何改错都能回滚；
 * 3. 长度骤降时给一条 notice（与 G3/G5 同机制）。
 *
 * 这条文案是第 3 层。它不拦执行 —— 覆写是合法操作，
 * 只是**不能悄悄发生**：调用方得知道"我这一下抹掉了多少字"。
 */
/** 语义化版本比较：a 是否**低于** b（1.0.39 vs 1.0.50）；不规范的输入按"不低"处理，不误报 */
export function isVersionOlder(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10))
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10))
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * notice 是"一组句子"（一行一句）—— **同一句只留一份**（1.0.110，收 `691c3b1e`）。
 *
 * ## 它治的病
 *
 * G8（说明书版本落后）触发时，同一句告警在 batch 的**顶层 notice 里出现两遍**
 * （1.0.74 / 1.0.81 / 1.0.97 三轮实测都一样）：逐条都走 `executeOne`，
 * 行内那份已经带上了它；批跑完汇总成一份回到最外层时，
 * **版本检查在命令之外又做了一遍**，于是又追加一次。
 * `3df42f82` 的 Set 去重发生在追加**之前**，兜不住后追加的这份
 * （`3df42f82` 修的是"每条各追加一次"，这是它之后出现的新形状）。
 *
 * ## 为什么按行去重，而不是只判那一句
 *
 * 顶层 notice 是**多来源合并**出来的（逐条收集 + 各处独立追加），
 * 一句一行就是这个字段的既定形状；同一句重复只可能来自"两条路都算了它"，
 * 不可能来自"本来就要说两遍"。
 * 判据：**合并之后去重，而不是在某个入口上打补丁** —— 补一个入口，
 * 下一个入口再进来时同样的病会再犯一次。
 *
 * ⚠️ 空行**不参与去重、也不被丢掉**：它是段落分隔，不是句子
 * （多条提醒之间、描述变更提醒内部都有空行）。
 * ⚠️ 逐条那份（`results[i].notice`）**原样保留**，不去重 ——
 * 沿用 `3df42f82` 的口径：只提醒不拦，要逐条看的调用方仍拿得到。
 *
 * （导出供闸门用例直接验这条规则。）
 */
export function dedupeNoticeLines(text: string): string {
  const seen = new Set<string>()
  return text
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return true
      if (seen.has(line)) return false
      seen.add(line)
      return true
    })
    .join('\n')
}

export const DESC_SHRINK_HINT =
  '提醒：这次把描述从 %OLD% 字整体替换成 %NEW% 字（原内容的 %PCT%%），' +
  '旧内容已被覆盖。若本意是"补一段"而不是"重写"，请改用默认的追加语义' +
  '（`--desc` 现在默认追加，整体替换需要显式 `--overwrite-desc`）。' +
  '改错了可以从 `todo history` 的变更记录里找回原文（1.0.49 起描述变更入审计）。'

/**
 * 「待确认」事项的描述要素自检（G7 软提醒，1.0.49，主用户 2026-09-24）
 *
 * 起因：她打开看板说"只有 2 件事情需要我确认，但里面只描述了问题，
 * 并没有给出我需要拍板的决策项…我不知道可以怎么给你拍板"。
 * 根因有两层：**写的人不知道该写什么**（没有规范），以及
 * **写歪了也没人提醒**（提交时不校验）。这条补的是第二层。
 *
 * 判据来自她给的三条规范（见仓库 `ISSUE_STYLE.md` 阶段一）：
 * 说清"问题是什么"与"要你定什么"，再给现状/证据/选项/代价/建议/不选会怎样。
 *
 * ⚠️ 为什么是**软提醒**而不是硬拦：
 * 待确认项的价值在于内容，而不在于格式 —— 关键词法会误判
 * （她用自己的话写全了要素，却一个"选项"字样都没出现，是常有的事）。
 * 硬拦会把正当写法挡在门外；软提醒只在"确实缺得离谱"时吱一声，
 * 既不挡路、又让写的人当场知道漏了什么。
 */
const PROPOSED_DESC_ELEMENTS: { key: string; words: string[] }[] = [
  { key: '现状', words: ['现状', '现在'] },
  { key: '证据', words: ['证据', '实测', '行号', ':', '：'] },
  { key: '选项', words: ['选项', '方案', '①', '1)'] },
  { key: '代价', words: ['代价', '成本', '牺牲', '影响'] },
  { key: '建议', words: ['建议', '推荐'] },
  { key: '不选会怎样', words: ['不选', '否则', '维持现状'] }
]

export function proposedDescNotice(desc: string | null | undefined): string | null {
  const d = (desc ?? '').trim()
  if (!d) {
    return (
      '「待确认」事项没有描述：这是给人拍板用的，没有描述对方无法决定。' +
      '请按《事项写法规范》补上——说清「问题是什么」「要你定什么」，' +
      '并给出 现状 / 证据 / 选项 / 代价 / 建议 / 不选会怎样。' +
      '（`todo update <id> --desc "…"` 可补；改写正文记得配 --overwrite-desc）'
    )
  }
  const missing = PROPOSED_DESC_ELEMENTS.filter((e) => !e.words.some((w) => d.includes(w))).map(
    (e) => e.key
  )
  if (missing.length === 0) return null
  return (
    `「待确认」事项的描述里没看到这些要素：${missing.join('、')}。` +
    '待确认项是给人拍板的，建议补齐（现状 / 证据 / 选项 / 代价 / 建议 / 不选会怎样）——' +
    '尤其缺「选项」或「不选会怎样」时，对方通常无法决定。详见仓库 ISSUE_STYLE.md。'
  )
}

/**
 * 未注册身份只能读、不能写（主用户 2026-09-19 定）
 *
 * `created_by` 那种文本是**标注不是身份** —— 任何进程都能自称 `agent:xxx`。
 * 所以：一旦声明了 agent 身份，就必须先在 agents 表里注册过，才允许写入；
 * 否则只能读。
 *
 * `human` 是天然身份，不需要注册（人在界面上操作走的是这条，不该被拦）。
 *
 * ⚠️ 当前边界：默认（不声明身份、落到 human）的写入仍放行 ——
 * 完全杜绝"假冒 human"需要**强制声明调用者**，那是更大的改动，已登记待办。
 */
export function assertRegisteredActor(
  ctx: CliContext,
  actor: string | null | undefined
): void {
  if (!actor || actor === 'human') return
  if (!actor.startsWith('agent:')) return
  if (ctx.deps.agentRepo.get(actor)) return

  /**
   * 用 NotFoundError（退出码 3）而不是笼统的 exit 1：
   * "身份不存在"和"系统出错"对调用方的意义完全不同 —— 前者 named 的目标补一次
   * register 就能重试，后者重试也没用。
   */
  throw new NotFoundError(
    `身份未注册：${actor}。未注册的标识只能读、不能写 —— ` +
      `先跑 \`agent register --id ${actor} --name "展示名"\` 再来写入。`
  )
}

/**
 * CLI 的依赖
 *
 * 三个 repo 直接引用真实类型，**不再手抄一份方法签名**。
 * 手抄的副本一定会漂移：v10 给 repo 加了 resolveId、给待办加了 owner，
 * 抄的那份没跟上，编译期没报错（结构兼容），运行期才炸。
 * 让类型从实现里长出来，加方法/改签名时编译器会直接指出所有调用点。
 */
export interface CliDeps {
  todoRepo: Pick<
    TodoRepository,
    | 'create'
    | 'list'
    | 'getById'
    | 'update'
    | 'delete'
    | 'resolveId'
    | 'childCount'
    | 'listChildren'
    /** todo history：状态流转历史（schema v14，数据与界面同源） */
    | 'listTransitions'
    /** 删除留痕 ③：已删条目的墓碑（2026-09-28） */
    | 'findDeletedSnapshot'
    /** 墓碑全集，供 resolveId(allowDeleted) 做前缀匹配（1.0.60） */
    | 'listDeletedSnapshots'
    /** 被退回、仍归某个身份收口的事项（2026-09-28，B 方案用） */
    | 'listRejectedFor'
    /** 1.0.68 登记前去重（`84efa995`） */
    | 'findSimilar'
    /** 1.0.111 谁不能签这条（卡 `8bf6a932`）：self_verify 的判定与数据层 G10 同源 */
    | 'attributedExecutor'
  >
  categoryRepo: Pick<
    CategoryRepository,
    'list' | 'create' | 'delete' | 'merge' | 'resolveId' | 'getById'
  >
  projectRepo: Pick<
    ProjectRepository,
    | 'create'
    | 'list'
    | 'delete'
    | 'resolveId'
    | 'getById'
    | 'getDetail'
    | 'search'
    | 'searchPage'
    /** 接手说明修订历史（schema v35，36b44adb） */
    | 'listHandoffRevisionSummaries'
    /** 接手状态：事实 / 覆盖声明 / 新鲜度（schema v47，e2a06fd7） */
    | 'getHandoffState'
    | 'buildHandoffFacts'
    | 'getHandoffRevision'
    | 'rollbackHandoff'
    | 'saveHandoff'
    | 'listHandoffProposals'
    | 'proposeHandoff'
    /** 1.0.111 归档 / 取消归档（卡 `c177e466`）：置 archived 标志，数据一条不动 */
    | 'update'
    | 'listProjectDocs'
    | 'readProjectDoc'
  >
  /**
   * 版本对象（1.0.73，主用户 10-07 提的「版本应该不只是一个字段」）
   *
   * `detail` 返回版本 + 它收口的事项；`listByProject` 是"版本跟项目关联"
   * 那条只读路径。两者都是读，放在同一个 Pick 里。
   */
  releaseRepo: Pick<
    ReleaseRepository,
    'create' | 'update' | 'delete' | 'list' | 'getByProjectAndVersion' | 'detail' | 'listByProject' | 'audit'
  >
  memoRepo: Pick<MemoRepository, 'create' | 'reply' | 'list' | 'get' | 'ack' | 'remove' | 'unreadCount'>
  /** R2-3：让 agent 能读/改界面参数（改前过 `commands/ui.ts` 里的 UI_WHITELIST） */
  settingsRepo: Pick<
    SettingsRepository,
    'get' | 'update' | 'resetVisual' | 'resetVisualKey'
  >
  /** R3-1：Agent 身份注册（从标注变成身份）；1.0.35 起含凭据签发与校验 */
  agentRepo: Pick<
    AgentRepository,
    | 'register'
    | 'list'
    | 'get'
    | 'touch'
    | 'setApproved'
    | 'remove'
    | 'issueCredential'
    | 'verifyCredential'
    /** 1.0.36 分级授权：申请 / 查可用授权 / 用掉一次性授权 / 列记录 / 撤销 */
    | 'requestGrant'
    | 'findUsableGrant'
    | 'findAnyUsableGrant'
    /** 1.0.65：最近一条同档授权（不论状态）—— whoami 用它区分"没申请过"与"牌已用掉" */
    | 'findLatestGrant'
    | 'consumeGrant'
    | 'consumeGrant'
    | 'listGrants'
    /** 1.0.107 修 `99be5ae7`：计数与取页同源（同一份 grantWhere），回执才自报得出 matched */
    | 'countGrants'
    | 'revokeGrants'
    /** 1.0.45 批准即执行：按 id 取那一条申请（校验"用户刚点的是哪条"） */
    | 'getGrant'
    /** 1.0.36 审计：记下最近一次写入 */
    | 'markWrite'
  >
  /**
   * 评论（1.0.112，卡 `69788c32`）
   *
   * 命令层此前 10 处自己 `new CommentRepository()` —— 塞进 `deps` 的实例根本
   * 收不到调用（`approved-review-replay.test.ts` 里的 `commentRepo` 就是这么
   * 被绕过的）。改后**唯一**的构造点是接线处：`index.ts` 的两条通道 + `ipc.ts`
   * 的批准回放。
   */
  commentRepo: Pick<
    CommentRepository,
    | 'create'
    | 'listByTodo'
    | 'listWaitingFor'
    | 'resolveId'
    | 'remove'
    | 'closureByTodo'
    | 'countByTodo'
  >
  /** 通知收件箱（同上）：`notification list` 的读窗口、已读位、未读计数都走它 */
  notificationRepo: Pick<
    NotificationRepository,
    'create' | 'listPage' | 'countPage' | 'markReadBy' | 'unreadCount' | 'unreadCountFor'
  >
  /** 会话提醒回执（同上）：`shouldExpand` 每次写命令后判一次、`markSeen` 给 snooze 用 */
  reminderReceiptRepo: Pick<ReminderReceiptRepository, 'shouldExpand' | 'markSeen'>
  /**
   * 协作规则（同上）：**两个用处** —— `rules` 命令族，以及权限判定。
   * `GuardResolver` 只用 `listRules` / `listPermissions`，所以它的构造参数
   * 也收成这两个方法的 Pick —— 依赖给的正好是它要的，不多不少。
   */
  rulesRepo: Pick<RulesRepository, 'listRules' | 'listPermissions' | 'propose' | 'listProposals'>
  /** 协作协议（同上） */
  protocolRepo: Pick<ProtocolRepository, 'list' | 'propose' | 'listProposals'>
  /** 主用户档案（同上） */
  profileRepo: Pick<ProfileRepository, 'list' | 'propose' | 'listProposals'>
  /** 让正在运行的 GUI 察觉到本次写入 */
  events: {
    append: (type: string, actor: string, payload?: Record<string, unknown> | null) => void
  }
  telemetry: {
    record: (input: {
      actor: string
      surface: string
      category: string
      event: string
      ok?: boolean | null
      durationMs?: number | null
      props?: Record<string, unknown> | null
      /**
       * 对话级标识（1.0.49，修 3d6e4395）：把同一轮对话里的多次调用
       * 串到同一个 `session_id` 上。不传则回退到"一个进程一个 uuid"。
       *
       * 类型与 `TelemetryService.record` 的入参**逐字对齐**（含 `| null`），
       * 否则 `ipc.ts` 里把 deps 直传过去时会因 string|null 不兼容而编译失败。
       */
      sessionId?: string | null
    }) => void
    query: (filter: {
      since?: string
      until?: string
      category?: string
      event?: string
      surface?: string
      limit?: number
      /**
       * 跳过排在最前面的 N 条（1.0.109，修 `7f21841f`）。
       *
       * 与 `order` 一起才成立：**先定顺序，再切片**。仓储层下推到 SQL 的
       * `OFFSET`（不是命令层切数组 —— `telemetry export` 读的是最长的表）。
       */
      offset?: number
      /** 取数方向（1.0.37）：默认最新优先，'oldest' 翻旧账 */
      order?: 'newest' | 'oldest'
    }) => UsageEvent[]
    stats: (filter?: {
      since?: string
      until?: string
      category?: string
      event?: string
      surface?: string
      limit?: number
    }) => unknown
    clear: (before?: string) => number
  }
}

export interface CliMeta {
  version: string
  dbPath: string
  schemaVersion: number
  /** SQLite 遇锁等待时间（毫秒），并发正确性的关键参数，要能一眼看到 */
  busyTimeoutMs: number
  /** 本次执行的进程能提供哪些通道，由构建 ctx 的一侧如实填写 */
  channels: Array<'headless' | 'pipe'>
  /** 本次执行实际走的是哪条通道 */
  via: 'headless' | 'pipe'
  /**
   * 进程启动时刻（epoch ms）。
   * 必须在这里传入：一次 CLI 调用的耗时大头是 Electron 启动与数据库初始化，
   * 而这两步发生在 runCli 被调用之前。若只在 runCli 内部计时，
   * 测出来的只有命令执行那几毫秒，对诊断毫无用处。
   */
  startedAt: number
}

export interface CliContext {
  deps: CliDeps
  meta: CliMeta
  /**
   * 调用方重定向进来的 stdin 内容
   *
   * 无头路径下留空即可（命令直接读 process.stdin，stdio 被 inherit 过来了）；
   * 管道路径下必须由服务端填 —— 那时 process.stdin 属于 GUI 进程，
   * 跟调用方毫无关系。
   */
  stdin?: string
  /**
   * 调用方身份（'human' 或 'agent:<id>'）
   *
   * 来源：agent 在自己的环境里 export DESKPARTNER_AGENT=agent:<id>，
   * 或由启动器从 ~/.deskpartner/credentials.json 自动带上（注册过之后就不用管了）。
   * 流转历史的动作人、埋点的 actor 都以它为准 —— 此前这两个地方
   * 一个硬编码 human、一个只认 --created-by（不传就记 NULL），
   * 主用户看到的"这条流转没登记是谁操作的"就是后者。
   */
  actor?: string
  /**
   * 上面的 `actor` 是**调用方显式声明**的身份吗（1.0.46）？
   *
   * 必须与 `actor` 分开记，因为 `actor` 有两种来源，语义完全不同：
   *
   * - **显式声明**：调用方 export `DESKPARTNER_AGENT=agent:x`，
   *   或在命令里带 `--created-by agent:x`。这是"我在自称是它"。
   * - **启动器推断**：本机只有一份凭据时自动带上（1.0.35 的零摩擦设计）。
   *   这是"机器上碰巧有谁"，**不是任何人的自称**。
   *
   * 为什么必须分开：`ambiguous_identity` 这一关要判"调用方是不是自己声明了身份"。
   * 判据若取"解析出来的 actor 是不是 agent"，就会把上面第二种
   * （启动器自动带上）也算成"声明过" —— 于是本机只要落过一份凭据，
   * **多份凭据的拒绝逻辑就会误伤**（实测：`agent credential` 报
   * `ambiguous_identity`，而调用方根本没声明过任何身份）。
   *
   * 这与 1.0.37 修正 `ambiguous_identity` 时的结论同源：
   * **判据是"这次调用有没有声明身份"，不是"本机有什么凭据"**。
   */
  identityDeclared?: boolean
  /** 注册时签发的凭据明文；写命令要出示它（只比对哈希，不落库） */
  credential?: string
  /** 是不是人在终端里敲的（TTY）。未标注按非交互处理 —— 安全默认 */
  interactive?: boolean
  /**
   * 会话 id（DESKPARTNER_SESSION）：把同一轮对话里的多次调用串起来。
   * 分级授权里"仅本次会话有效"就靠它 —— 没有会话概念，
   * 就只能给长期授权，风险档位也就失去了意义。
   */
  session?: string
  /**
   * 本机有多份 agent 凭据、但这次调用没声明身份时的候选列表（1.0.37）。
   *
   * 由启动器发现（它读过凭据文件）后带进来。**只在写命令上据此拒绝**：
   * 读命令不需要身份，拿这个去堵会把 `todo list` 也一并堵死。
   *
   * 为什么必须拦：多份凭据下"随便挑一个"会把这次调用记到别人名下
   * （Bob 32f0bf89 实测：它的调用与授权申请全记在 alice 名下），
   * 而错记的身份事后无法还原 —— 当时不猜是数据不被污染的唯一机会。
   */
  ambiguousIds?: string[]
  /**
   * 「这条调用已经由人点头批准」的内部凭据（1.0.45）。
   *
   * 值是 `agent_grants.id` —— 用户在界面上点「允许」的那一条。
   *
   * ⚠️ **只能由主进程的 IPC 层设置，绝不能来自调用方。**
   * 存在它意味着"人已经在界面上批准过这件事"，所以门禁会直接放行 ——
   * 若它能被 CLI 调用方填，整套分级授权当场失效。
   * 两条 CLI 通道的 ctx 都是白名单构造的（无头走 run.ts、管道走
   * cli-server.service.ts 的报文），**不包含这个字段**，所以填不进来。
   * 将来加字段时务必保持这一点。
   *
   * 为什么需要它：批准即执行时，服务端要以那个 agent 的身份跑这条命令
   * （动作归属不能变成人），但 agent 的凭据明文不在服务端手上、
   * 也不该有。这个标记就是那条通路：**不是它自称有权限，
   * 而是有人真的为这一条点了头**。
   */
  preApprovedGrantId?: string
  /**
   * 只校验、不执行（1.0.65 修 `1e525804`，`batch --dry-run` 专用）
   *
   * 由 `batch` 在逐行校验时设进来，**只影响 batch 内部那一次循环**，
   * 不跨调用。判据位置在 `executeOne` 里：所有校验（必填/枚举/未知 flag/
   * 门禁）都跑完，**在 `cmd.run` 之前**停住并返回"这条能过"。
   *
   * 为什么能这么切：校验与执行本来就是分开的两段，中间没有隐式耦合 ——
   * 校验只读 flags/positional，执行才碰数据。所以"校验过但不执行"
   * 是一个真实存在、且不需要第二套判据的位置。
   *
   * ⚠️ **不要在 batch 外面暴露成通用 flag**：那等于给所有写命令加一个
   * "假装成功"的开关，调用方一旦误用，以为自己做了其实没做。
   * 它只该是 batch 的一个自查参数。
   */
  dryRun?: boolean
  /**
   * 调用方手上那份说明书的版本（DESKPARTNER_SKILL_VERSION，G8 用）。
   *
   * ⚠️ **必须由启动器带进来，不能在这里读 `process.env`**（1.0.57 修）：
   * 管道路径下服务端是**常驻 GUI 进程**，它的环境变量是 GUI 的，
   * 调用方 shell 里声明的那个根本看不见 —— 于是 GUI 一开着，G8 提醒就**静默失效**
   * （Bob实测 52b6b726：声明 1.0.50，回执 notice 为空；加 NO_PIPE=1 才有）。
   * 这与 actor / credential / session / ambiguousIds 是同一类问题，
   * 处理方式也相同：**凡服务端要读的调用方环境，一律由启动器带过来。**
   *
   * 兼容：无头路径（服务端即调用方子进程）仍可从 env 取，但走同一字段，
   * 由构造 ctx 的那一层统一填 —— 不要在命令实现里各自读 env。
   */
  skillVersion?: string
  /**
   * 调用方走的哪张皮（1.0.63）：`cli`（人/脚本直接敲，缺省）或 `mcp`（MCP 工具调用）。
   *
   * 与 skillVersion 同一条规矩：**由启动器带进来，不要在命令实现里读 env** ——
   * 管道路径下服务端是常驻 GUI 进程，看不到调用方的环境。
   * 目前唯一的消费者是 `agent whoami` 的接入指引（据此决定要不要提 MCP），
   * 埋点另走 run.ts / cli-server 的同名判据。
   */
  surface?: string
}

/**
 * 从 ctx 取调用身份；历史调用方（测试、旧入口）没传时按 human 处理。
 * 集中在一个函数里，避免"有的地方 ctx.actor、有的地方 'human'"这种漂移。
 */
export function actorOf(ctx: CliContext): string {
  const a = ctx.actor?.trim()
  return a ? a : 'human'
}

/**
 * 动作人解析：环境变量身份优先；没设时向后兼容旧的 --created-by 声明习惯
 * （agent 曾用它声明"我在操作"，虽然它的本义是"这条是谁提的"）。
 */
export function resolveActor(
  ctx: CliContext,
  createdByFlag?: string | boolean | string[]
): string {
  const viaEnv = actorOf(ctx)
  if (viaEnv !== 'human') return viaEnv
  if (typeof createdByFlag === 'string' && createdByFlag.trim().startsWith('agent:')) {
    return createdByFlag.trim()
  }
  return 'human'
}

/**
 * 提出者的默认值（1.0.73，`63b707ca` 选 ①）
 *
 * ## 它治的病
 *
 * 原先 `todo add` 不传 `--created-by` 时提出者恒落 `human`，
 * 而**同一次调用**的流转记录（`actor`）已经正确落成 `agent:<调用身份>` ——
 * 于是同一条新事项里出现两个自相矛盾的归属：
 * 「**agent 新建了它，但提出者是人**」。
 *
 * 后果不是"不好看"：`--created-by human` 是**看板上区分"用户自己提的"
 * 与"agent 提的"**那个筛选项的口径（主用户用它看"哪些是我自己记的"）。
 * 归属错一次，这个筛选就跟着错一次，而且事后只能靠 `set-owner` **逐条补**。
 *
 * ## 判据：为什么是"有身份才兜底"，而不是"一律落 actor"
 *
 * - **不该一律落 actor**：人自己在界面/终端上跑 `dp todo add` 时
 *   `ctx.actor` 就是 `human`，落 human 本来就是对的；
 *   若把"未声明身份"也塞成某个 agent，等于**替人冒领**。
 * - **该兜底的是"我明明持证调用了，你却记成是人提的"** ——
 *   这正是本机四个 agent 反复踩的那个坑（提单原话："每个 agent 都要重新踩一次"）。
 *
 * 所以判据是：**调用方有可识别的 agent 身份时，提出者默认取它。**
 * 而不是"必须记得传 `--created-by`"—— 那是把正确性交给调用方的自觉，
 * 与产品「规范由机制保证」的主张相反。
 *
 * ⚠️ 只认 `agent:` 前缀（`actorOf` 的约定），不认别的字符串：
 * `created_by` 列的语义就是 `human` / `agent:<id>` 两类（见 TodoOwner）。
 *
 * ⚠️ 连带影响（**已核实，不是推测**）：repo 里 `verifier` 默认取提出者，
 * 于是 agent 自建的卡默认变成"验收者 = 该 agent"。这与 G10
 * 「运动员不当裁判」的关系是**一致的** —— 那条守卫比的是
 * `actor === (executedBy ?? createdBy)`；提出者不再错记成 human，
 * 反而让"自己提、自己执行、自己验收"这种情形能被正确识别并拦下，
 * 而不是因为提出者被错记成 human 而蒙混过关。
 */
export function resolveCreatedBy(
  ctx: CliContext,
  createdByFlag?: string | boolean | string[]
): string | undefined {
  if (typeof createdByFlag === 'string' && createdByFlag.trim()) return createdByFlag.trim()
  const viaEnv = actorOf(ctx)
  return viaEnv.startsWith('agent:') ? viaEnv : undefined
}

/**
 * 冒名治理第 1 层（1.0.109，`b95e6bbb`）：同一次调用给出的两个说法不能互相矛盾
 *
 * ## 治的是什么
 *
 * 启动器把 `--created-by agent:xxx` 当成**身份声明**，再据此去凭据文件里挑那一份
 * 来完成调用（1.0.37 给 bob 补的兼容）。于是调用方声明了 A、又写了
 * `--created-by B` 时，动作人、动态、提出人**整条链**一起记成 B ——
 * 卡「谁提的、谁做的」一起错，而错记的身份事后无法还原
 * （`601f8ee6`：卡是 newmax 建、newmax 执行的，动态里却是 alice）。
 *
 * ## 判据：比的是"这次调用自己给出的两个说法"
 *
 * - `DESKPARTNER_AGENT=agent:a` + `--created-by agent:b` → 两个说法打架 → `usage_error`；
 * - 只传 `--created-by agent:b`（没有环境变量身份）→ actor 就是 b，两个说法一致 → 放行
 *   （那是"以 b 的身份调用"，不是冒名；1.0.37 的兼容路径原样保留）；
 * - `identityDeclared === false`（启动器按本机唯一凭据自动带上）→ 不是任何人的自称 → 放行。
 *
 * 所以它不需要信任任何声明，也不依赖第三个信息源：矛盾就在这次调用内部。
 *
 * ## 边界（诚实说清）
 *
 * - 只拦 `agent:` 之间的不一致：`--created-by human` 仍放行 ——
 *   "agent 代录一条人提的事"是真实用法，本层不管。
 * - 它**不是认证**：抬高的是门槛，不是身份的真伪（本机任何进程都能自己
 *   `export DESKPARTNER_AGENT=agent:别的` 再调用，那是第 3 层的事，本批不动）。
 */
export function assertCreatedByNotImpersonating(ctx: CliContext, createdBy: unknown): void {
  if (!ctx.identityDeclared) return
  const wanted = typeof createdBy === 'string' ? createdBy.trim() : ''
  if (!wanted.startsWith('agent:')) return
  const actor = actorOf(ctx)
  if (wanted === actor) return
  throw new UsageError(
    `--created-by ${wanted} 与这次调用的身份 ${actor} 不一致：提出者该按你自己的说法写。` +
      `要把活派给 ${wanted} 去做，用 \`--executed-by ${wanted}\`（提出者仍记你）；` +
      `确实要代 ${wanted} 登记，就别在这次调用里声明身份（不要 export DESKPARTNER_AGENT），` +
      '让它自己来跑这条命令。'
  )
}

/**
 * 风险档位（1.0.36）
 *
 * 此前只有"读 / 写"两档，等于让人在"全开"和"全关"之间二选一 ——
 * 可"往看板加一条待办"和"把待办删掉"、"改掉整个界面的配色"
 * 根本不是一个量级的事。参考 Claude Code：**同意的有效期按风险分级**
 * （只读免批、文件修改到会话结束、危险操作每次都问）。
 *
 * - read：查询，免批（卡查询只会逼调用方绕路）
 * - write：改待办数据，批准一次长期有效（`agents.approved`）
 * - config：改界面，批准**仅本次会话有效**
 * - destructive：删除，**每次都要**（一次性授权，用掉即止）
 */
export type RiskTier = 'read' | 'write' | 'config' | 'destructive'

/**
 * 命令的档位。**未标注按 write 处理**（要卡）：
 * 与 readOnly 同样的安全默认 —— 漏标只会多卡一次，不会悄悄开一道门。
 */
export function riskOf(cmd: CommandSpec): RiskTier {
  if (cmd.risk) return cmd.risk
  return cmd.readOnly ? 'read' : 'write'
}

/** 门禁结论：outcome 为 null 表示放行 */
export interface GateResult {
  outcome: Outcome | null
  /**
   * 本次放行走的是哪条一次性授权（仅删除档有）。
   * 命令成功后要把它标成已用 —— "允许这一次"用完即止，下次还得问。
   */
  consumableGrantId?: string
}

/**
 * 解析写命令里的 `--project`（1.0.40 收紧）
 *
 * **为什么从"找不到就建"改成"默认报错"**（Bob 2026-09-22 实测报的）：
 *
 * 原设计是"找不到就建"，理由写在注释里——"agent 不该被先建项目再建任务拦住"。
 * 但那个理由在 **project 变成必填项（v17）之后就失效了**：
 * - 以前可选：偶尔写错也无所谓（不写就没有这个维度）；
 * - 现在必填：每次都要写 → 错字概率随调用量线性上升。Bob实测传错一个字母
 *   （DeskPartnr）就静默分叉出一个新项目，待办也进去了，全程无提示。
 * 而项目是**看板的主聚合维度**（"一眼看出谁在忙什么"），分叉的代价比分类大得多：
 * 数据按项目一聚合就散了，且事后很难判断哪些条目属于错字项目。
 *
 * 与 `--category` 的行为对齐：报错 + 列出现有项，让调用方自己决定复用还是新建。
 * 真要新建就显式说 —— `--create-project`，一步不用多跑，但**意图是明确的**。
 * （这和「未知 flag 一律 usage_error」是同一条原则：宁可报错，不要静默扩大行为。）
 */
export function resolveProjectForWrite(
  ctx: CliContext,
  raw: string,
  allowCreate: boolean
): string {
  const name = raw.trim()
  const all = ctx.deps.projectRepo.list()
  const hit = all.find((p) => p.name === name)
  if (hit) return hit.id

  if (allowCreate) return ctx.deps.projectRepo.create({ name }).id

  const available = all.map((p) => p.name).join('、') || '（暂无项目）'
  throw new NotFoundError(
    `项目不存在: ${name}。已有项目：${available}。` +
      `确要新建请加 --create-project（或先 project add）`
  )
}

/**
 * release 命令组的项目定位：名字或 id 前缀（同 todo 的口径），找不到报错并列出现有项目。
 *
 * 不支持"找不到就建"：版本登记是**收口动作**（发完版回来记账），不是开荒 ——
 * 要发版项目得先存在。五处调用（add/list/show/update/rm）各写一份的下场
 * 是错字静默分叉（同 resolveProjectForWrite 的判据）。
 */
export function resolveProjectForRelease(ctx: CliContext, raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) {
    throw new UsageError('--project 不能为空：版本是项目下的二级概念，按 (项目, 版本号) 定位')
  }
  const byName = ctx.deps.projectRepo.list().find((p) => p.name === name)
  if (byName) return byName.id
  try {
    return ctx.deps.projectRepo.resolveId(name)
  } catch {
    const names = ctx.deps.projectRepo.list().map((p) => p.name)
    throw new NotFoundError(
      `项目不存在: ${name}${names.length ? `。已有项目：${names.join('、')}` : '。本机还没有项目'}`
    )
  }
}

/** 项目名（回执/报错里带上"谁的版本"，跨项目同名版本后光有版本号分不出） */
export function projectNameOf(ctx: CliContext, id: string): string {
  return ctx.deps.projectRepo.getById(id)?.name ?? id
}

/**
 * 「只能由启动器展开」的文件入参（1.0.54 起；1.0.73 改为单源）
 *
 * ⚠️ **这里的清单来自 `src/cli/file-flags.ts`，不是本文件自己写的。**
 *
 * 此前它与启动器那张表各写一份，于是 `--comment-file` 声明进 `todo update`
 * 的 args 后**两边都没跟上**：既不展开、也不拦截 ——
 * 服务端收到它时只是"不认识但也不报错"，正文被静默丢弃而调用方拿到 ok:true。
 * 而那正是 1.0.41 修 `--desc-file` 时同一个病（"为了文档目的声明一个 flag，
 * 会顺带把它在别的路径上变成接受但不处理"）的复发。
 *
 * 现在两侧同源：加一个文件入参只需在 `file-flags.ts` 加一行。
 */
const LAUNCHER_ONLY_FLAGS = FILE_FLAGS

/**
 * 保险：服务端不该收到 `--desc-file` / `--body-file` / `--comment-file`
 * （它们由启动器展开）
 *
 * Bob 7f48eb16 实测：batch 通道下 `--desc-file` 被**静默忽略**
 * （回 ok=true 还给 id，但库里描述长度为 0）。
 * 根因是上一版为了 help 可发现性把 `--desc-file` 声明进了服务端 args 表，
 * 于是它从"报未知 flag"（能被发现）变成了"认识但不处理"（静默降级）。
 *
 * 现在启动器已能展开 batch 里的它们，这里再兜一道：
 * **真收到了就明确报错**，不要再让任何路径悄悄降级。
 */
export function assertNoLauncherOnlyFlags(flags: Flags): void {
  for (const { flag, target } of LAUNCHER_ONLY_FLAGS) {
    if (flags[flag] !== undefined) {
      throw new UsageError(
        `${flag} 由启动器展开为 ${target}，服务端不该收到它。` +
          `若你是直接调用服务端（绕过启动器），请改用 ${target}。`
      )
    }
  }
}

/**
 * 把授权申请的目标翻译成人话（1.0.39）
 *
 * 主用户 2026-09-22 指出：横幅只说"alice 想「删除数据」（todo rm）"，
 * **没说删的是什么**。人没法只凭一条命令名决定要不要点头 ——
 * "删一条测试待办"和"删掉看板上最重要的父需求"是两个完全不同的决定。
 *
 * - `todo rm`：把 id 解析成标题 —— id 对人没有意义，标题才有。
 *   解析失败（id 不存在等）就退回原始命令行，**绝不因此抛错**：
 * 这只是给横幅加说明，不能反过来把门禁流程搞挂。
 * - 其他命令：拼一条命令行摘要。
 *
 * v19 起**同时返回目标 id 集合**：摘要只是给人看的文案，执行时还要靠
 * targetIds 校验"批的"和"做的"是不是同一件事（否则「批准删 A」能被用来
 * 删 B —— Bob实测撞到的漏洞）。解析不出目标的命令返回空集合，
 * 表示"这条命令没有目标概念"，不参与校验。
 */
/**
 * 解析出"这次要动什么"：给人看的摘要 + 给机器校验的目标 id 集合
 *
 * 主用户 2026-09-22 指出：横幅只说"alice 想「删除数据」（todo rm）"，
 * **没说删的是什么**。人没法只凭一条命令名决定要不要点头 ——
 * "删一条测试待办"和"删掉看板上最重要的父需求"是两个完全不同的决定。
 *
 * 🚨 **2026-09-23 扩到全部删除档**（修Bob d290ae7b）：
 *
 * 原先只认 `todo rm`，其余命令一律返回 `targetIds: []`。而目标校验有一条
 * "任一方为空即不校验"的豁免 —— 于是 `category rm` / `project rm` 的授权
 * 等于**没有目标约束**，同档位内可以随便换命令用。实测佐证：库里
 * `category rm` 3 条、`project rm` 2 条，`target_ids` **全是空的**。
 *
 * 所以现在**每一条删除档命令都要解析出目标** —— 由下面的
 * `GRANT_TARGET_RESOLVERS` 逐条负责：一张**按命令名索引的表**，不再是一串 if/else。
 *
 * 解析失败（id 不存在等）退回原始命令行，**绝不因此抛错**：
 * 这只是给横幅加说明，不能反过来把门禁流程搞挂。
 * 退回的代价是空目标，而删除档守卫（`assertScopeAllowed`）据此拒绝生成申请 ——
 * 那条守卫才是"批了也做不成的事不要来要授权"的落点。
 */

/** 「这次要动什么」的答案：给人看的摘要 + 给机器校验的目标集合 */
type GrantTarget = { summary: string; targetIds: string[] }

/** 摘要里塞不下的超长文本截断（卡 21f171f1：横幅高度已自适应，放宽至 120 字，保证 60~100 字长标题完整不截断） */
function clip(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 单目标命令的统一处理：把 id 前缀解析成完整 id，摘要里带上"它叫什么"。
 *
 * 这里刻意用 `resolveId`（支持前缀）而不是精确匹配：界面上显示的是
 * 8 位短号，agent 自然拿短号来用，精确匹配会解析不出 → 目标落空 →
 * 又回到"没有目标约束"的老路。
 *
 * 返回 null = 解析不出来（id 打错 / 已被删）—— 调用方退回空目标，
 * **不要在这里猜一个目标出来**。
 */
function singleTarget(
  cmd: CommandSpec,
  positional: string[],
  label: string,
  resolve: (raw: string) => string,
  nameOf: (id: string) => string | null
): GrantTarget | null {
  if (!positional.length) return null
  try {
    const id = resolve(positional[0])
    const name = nameOf(id)
    if (name !== null) return { summary: `${cmd.name}「${clip(name)}」`, targetIds: [id] }
    // 名字取不到但 id 解析出来了 —— 仍然记目标，摘要退回 id
    return { summary: `${cmd.name} ${label} ${id}`, targetIds: [id] }
  } catch {
    return null
  }
}

/** todo 系列（rm / update / done / close）共用：位置参数是待办 id 前缀，名字取标题 */
function todoTarget(
  cmd: CommandSpec,
  ctx: CliContext,
  _flags: Flags,
  positional: string[]
): GrantTarget | null {
  return singleTarget(
    cmd,
    positional,
    'id',
    (raw) => ctx.deps.todoRepo.resolveId(raw),
    (id) => ctx.deps.todoRepo.getById(id)?.title ?? null
  )
}

/**
 * 命令名 → 目标解析器。**这是唯一一张表**。
 *
 * 🚨 为什么必须是表（142d0420，2026-10-20 修）：这张表此前是一串 if/else，
 * 而 `release rm` **一个分支都没有** —— 于是它每次都落进末尾兜底（空目标），
 * 撞上"删除档必须有目标"的守卫，**任何版本都删不掉**，报错还说"目标不存在"。
 * 那个失效是静默的：没人能从"目标解析不出来"反推出"其实是漏了分支"，
 * 于是卡上记的现象（"目标解析前丢失版本号位置参数"）与真根因隔了一层。
 *
 * 现在键由 `grantTargetResolverNames()` 暴露给结构闸门
 * （`tests/main/cli/commands.test.ts` 逐条核对全部删除档命令都在表里）：
 * 再漏一条会当场变红，而不是等到"某个东西删不掉"才被发现。
 *
 * 返回 null = 解析不出来。调用方必须据此退回空目标 —— 别在这里兜底造目标。
 */
const GRANT_TARGET_RESOLVERS: Record<
  string,
  (cmd: CommandSpec, ctx: CliContext, flags: Flags, positional: string[]) => GrantTarget | null
> = {
  'todo rm': todoTarget,
  'todo update': todoTarget,
  'todo done': todoTarget,
  'todo close': todoTarget,
  'project rm': (cmd, ctx, _flags, p) =>
    singleTarget(
      cmd,
      p,
      'id',
      (raw) => ctx.deps.projectRepo.resolveId(raw),
      (id) => ctx.deps.projectRepo.getById(id)?.name ?? null
    ),
  'category rm': (cmd, ctx, _flags, p) =>
    singleTarget(
      cmd,
      p,
      'id',
      (raw) => ctx.deps.categoryRepo.resolveId(raw),
      (id) => ctx.deps.categoryRepo.getById(id)?.name ?? null
    ),
  /**
   * 分类合并：目标有**两个** —— 源分类（会被删掉的那个）与目标分类（待办改挂到它）。
   *
   * 摘要写成「源 → 目标」而不是沿用 `singleTarget`：只写一个的话，
   * 人在横幅上看不出"并进哪里"，而"并进哪里"正是判断这次合并该不该点头的全部信息。
   * 两个 id 都进 `targetIds`（v19 的目标校验：批准的是这一对联，不是任意一对）。
   *
   * 这条命令是**动态档位**（源分类空着时只是写档，走不到这里），
   * 但它必须和静态删除档一样有解析分支 —— 结构闸门按"删除档清单"取，
   * 而清单包含 `dynamicRisk` 的命令（142d0420）。
   */
  'category merge': (cmd, ctx, flags, positional) => {
    const endpoints = resolveMergeEndpoints(ctx, flags, positional)
    if (!endpoints.ok) return null
    const nameOf = (id: string) => ctx.deps.categoryRepo.getById(id)?.name ?? id
    return {
      summary: `${cmd.name}「${clip(nameOf(endpoints.fromId))}」→「${clip(nameOf(endpoints.toId))}」`,
      targetIds: [endpoints.fromId, endpoints.toId]
    }
  },
  /**
   * 版本删除：目标是 **(项目, 版本号)** 复合键，不是版本号自己。
   *
   * 版本没有独立 id（「DeskPartner 的 1.0.76」天然唯一，见 ReleaseRepository
   * 的注释），所以 targetIds 记 `项目id:版本号` 这个稳定标识。三件事缺一不可：
   * 位置参数给了版本号、`--project` 定位得到项目、该 (项目, 版本号) 真有登记。
   * 缺任一条就退回空目标，与其它删除命令同一口径：不生成"批了也做不成"的申请。
   *
   * 摘要里同时写项目名与版本号：跨项目可以撞同一个版本号，
   * 只说"删 1.0.76"人分不出删的是哪一个。
   */
  'release rm': (cmd, ctx, flags, positional) => {
    const version = (positional[0] ?? '').trim()
    if (!version) return null
    let projectId: string
    try {
      projectId = resolveProjectForRelease(ctx, flags['--project'])
    } catch {
      // 项目名/id 都定位不出来 —— 和"版本没登记"同样处理：不生成申请
      return null
    }
    if (!ctx.deps.releaseRepo.getByProjectAndVersion(projectId, version)) return null
    return {
      summary: `${cmd.name}「${clip(projectNameOf(ctx, projectId))} ${clip(version, 24)}」`,
      targetIds: [`${projectId}:${version}`]
    }
  },
  'memo rm': (cmd, ctx, _flags, p) =>
    singleTarget(
      cmd,
      p,
      'id',
      // memo 没有 resolveId（repo 层没有这个方法），照 memo rm 自身的口径做前缀匹配
      (raw) => {
        const m = ctx.deps.memoRepo.list().find((x) => x.id.startsWith(raw))
        if (!m) throw new NotFoundError(`备忘不存在: ${raw}`)
        return m.id
      },
      (id) => {
        const m = ctx.deps.memoRepo.get(id)
        if (!m) return null
        // 备忘没有标题，取正文首行当名字
        return (m.text ?? '').split('\n')[0] || null
      }
    ),
  /**
   * 评论删除：目标是一段正文，摘要把"删的是哪条评论"写出来。
   *
   * 不能沿用 `singleTarget`：评论的"名字"是正文首段，不是标题。
   * 解析不出（id 打错 / 已被删）就返回 null —— 与其它删除命令同一口径。
   */
  'todo delete-comment': (cmd, ctx, _flags, positional) => {
    const commentHit = resolveCommentForDelete(ctx, positional[0] ?? '')
    if (!commentHit) return null
    const kindLabel =
      commentHit.kind === 'reject' ? '验收驳回理由' : commentHit.kind === 'rework' ? '返工说明' : '评论'
    return {
      summary: `${cmd.name}「${kindLabel}：${clip(commentHit.body.replace(/\s+/g, ' '))}」`,
      targetIds: [commentHit.id]
    }
  },
  /**
   * 清埋点：目标概念是"时间范围"，没有 id 可解析 —— 摘要里写清范围，
   * 目标集合保持空。它是唯一合法的空目标命令
   * （见 `assertScopeAllowed` 里那条显式豁免，别顺手扩到别的命令上）。
   */
  'telemetry clear': (cmd, _ctx, flags) => {
    const before = flags['--before'] ? String(flags['--before']) : null
    return {
      summary: before ? `${cmd.name}（${before} 之前的全部埋点）` : `${cmd.name}（全部埋点）`,
      targetIds: []
    }
  }
}

/**
 * 表里登记了目标解析的命令名（结构闸门用）
 *
 * 闸门要回答的是"有没有漏"，而"漏"的清单只能来自**实现本身** ——
 * 另写一份名单去核对，等于把漂移从一处搬到另一处（那正是本卡的另一半教训）。
 */
export function grantTargetResolverNames(): string[] {
  return Object.keys(GRANT_TARGET_RESOLVERS)
}

export function summarizeGrantTarget(
  cmd: CommandSpec,
  flags: Flags,
  positional: string[],
  ctx: CliContext
): GrantTarget {
  /**
   * 摘要里重述的命令行：**位置参数从第一个开始，一个都不跳**（142d0420 修）。
   *
   * 此前这里写的是 `positional.slice(1)` —— 那是从 argv 拼接时代带来的习惯
   * （argv[0] 是命令名），但传进来的 `positional` 里**不含命令名**，
   * 于是第一个位置参数被无声丢掉。代价恰好落在最需要它的时刻：
   * `release rm` 的版本号、`memo rm` / `todo rm` 的 id 都是 positional[0]，
   * 目标解析失败时，报错重述的命令行里恰好没有它们 ——
   * 「release rm --project=b3c1bee3 --yes」看起来像调用方没传版本号，
   * 排查方向被引到"位置参数丢了"，而不是"这条命令根本没有解析分支"。
   */
  const tail = [
    ...positional.map((p) => (p.length > 24 ? `${p.slice(0, 24)}…` : p)),
    ...Object.entries(flags).map(([k, v]) => (v === true ? k : `${k}=${String(v)}`))
  ]

  const hit = GRANT_TARGET_RESOLVERS[cmd.name]?.(cmd, ctx, flags, positional)
  // 解析不出来 → 命令行摘要 + 空目标：删除档守卫会据此拒绝生成申请
  if (hit) return hit
  return { summary: `${cmd.name} ${tail.join(' ')}`.trim(), targetIds: [] }
}



/**
 * 解析一条评论（按前缀，与 CLI 全程支持短号同口径）
 *
 * 抽出来是因为 `todo delete-comment` 有三处要用同一份解析结果：
 * ① 档位判定（自删还是删别人的）；② 授权摘要（横幅上要能看出删的是哪一条）；
 * ③ 命令本体。三处各写一遍必然漂移，而漂移的那一处会**静默判错档位**。
 *
 * 返回 null = 解析不出来（id 打错 / 已经被删）。调用方必须显式处理：
 * 这里是"查不到就静默返回空结果"的老坑（f159d799）最容易复发的位置。
 */
function resolveCommentForDelete(ctx: CliContext, input: string): {
  id: string
  todoId: string
  authorId: string | null
  kind: string
  body: string
} | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const hit = ctx.deps.commentRepo.resolveId(raw)
  if (!hit) return null
  return { id: hit.id, todoId: hit.todoId, authorId: hit.authorId, kind: hit.kind, body: hit.body }
}

/**
 * `todo delete-comment` 的档位：**删自己的走写档，删别人的进删除档**
 * （1.0.63，收 dbfbc553 选③）
 *
 * ── 为什么这条命令要单独定档 ──
 *
 * qwen 实测（dbfbc553）：`todo delete-comment` 落在写档 —— 不要 `--yes`、
 * 不生成授权申请，调一次就物理删掉。而 `todo reject` 的驳回理由本身就是
 * 一条 `kind=reject` 的评论，删掉它等于把验收证据从链路上抹掉。
 * 多 agent 共用一块看板已是本机现实，"任何一方能悄悄抹掉另一方的结论"
 * 就是这条缝的后果。
 *
 * ── 为什么不做成"整条命令进删除档" ──
 *
 * agent 收拾自己写错的口误（"我承诺改成 B"发完发现写错）是最常见的用法，
 * 每删一条自己的字就让人点一次头，摩擦远大于收益 —— 而那条评论是它自己写的，
 * 它有权收回。分级判据就是**作者归属**：
 *
 * | 目标 | 档位 | 代价 |
 * | --- | --- | --- |
 * | 自己写的（authorId === 本次调用身份） | 写档 + `--yes` | 自己确认一下，不打扰人 |
 * | 别人写的（人或别的 agent） | 删除档 | 逐次经人点头，绑定目标 |
 *
 * ⚠️ 判据取 `authorId`（具体身份），不取 `authorType`：两个 agent 都是
 * 'agent'，按类型判等于"agent 之间可以互删"，正好漏掉这条缺陷要防的那一半。
 *
 * ⚠️ 解析不出目标时返回 `'write'` 而不是 `'destructive'`：那种情况命令本体
 * 会报 not_found（退出码 3），而报"目标不存在"比报"你没权限"准确得多 ——
 * 后者会让 agent 去申请一次注定执行失败的授权。
 */
/**
 * 解析 `category merge` 的两个端点（1.0.107，修 `28a13efe`）
 *
 * 抽出来是因为**三处要用同一份解析结果**：
 * ① 档位判定（源分类下还有没有待办 → 要不要转删除档）；
 * ② 授权摘要与目标集合（横幅上要能看出"把哪个并进哪里"）；
 * ③ 命令本体。
 * 与 `todo delete-comment` 的 `resolveCommentForDelete` 同一个形状 ——
 * 三处各写一遍必然漂移，而漂移的那一处会**静默判错档位、记错目标**。
 *
 * **不抛错**：解析不出来就回 `{ ok: false, reason, detail }`，由调用方决定怎么说 ——
 * `run` 抛给用户看，档位判定与摘要退回"不是删除档 / 空目标"。
 * 「查不到就静默给个默认答案」才是要防的（`f159d799` 的老坑）。
 *
 * 两种写法**同一套读法**（1.0.108，修 bob 的驳回）：每一端都收名字 / id / id 前缀 ——
 * 见 `resolveCategoryRef`。此前位置参数走 `resolveId`（只认 id 与前缀）、`--from/--to` 走名字
 * 精确匹配，于是"按名字必失败"，而报错还只说"找不到分类" —— 调用方会以为分类不存在，
 * 进而重复创建或放弃（实测：`category merge v108走查探针分类 其他 --yes` → rc=3 not_found）。
 */
type MergeEndpoints =
  | { ok: true; fromId: string; toId: string }
  | {
      ok: false
      /** `not-found` 用 NotFoundError 报，其余（含 `usage`）都用 UsageError —— 与原来的错误分类一致 */
      reason: 'flags-incomplete' | 'ids-missing' | 'usage' | 'not-found'
      detail: string
    }

/**
 * 把**一个**端点解析成分类 id（1.0.108，修 `28a13efe`）。
 *
 * ## 为什么两种写法必须走这一个函数
 *
 * 此前位置参数走 `repo.resolveId`（只认 id 与前缀）、`--from/--to` 走名字精确匹配 ——
 * **同一条命令的两种写法、两套读法**。bob 的实测（1.0.108）：
 *
 *     dp category merge v108走查探针分类 其他 --yes   → rc=3 not_found「找不到分类: v108走查探针分类」
 *     dp category merge <探针的id> 其他 --yes         → rc=3 not_found「找不到分类: 其他」
 *
 * 而 `--project` / `--category` 在别的命令里都认名字。更贵的是那句报错：它说"找不到分类"，
 * 于是 agent 以为分类不存在，重复创建或干脆放弃 —— 而分类明明就在那里。
 *
 * 判据：**同一个参数只有一种读法**（与 `8d78af0d` 那条"同一个参数值只许有一种含义"同源）。
 * 名字、id、id 前缀都收：**名字先试**（agent 记得住标签叫什么，记不住 uuid），
 * 名字不中再按 id / 前缀解析；名字撞多个不猜，直接报错并列出候选 id。
 *
 * ⚠️ 逐个端点解析、报**失败的那一个**：整段 try 包住两个的话，报错文案里的名字可能是
 * 没出错的那一个，排查方向直接被带偏（`todo delete-comment` 的同一个坑）。
 *
 * ⚠️ 不抛错：回 `{ ok:false, reason, detail }`。它同时要服务档位判定（跑在门禁之前），
 * 那里抛错会让命令以一个莫名其妙的错误码失败（见 `categoryMergeRisk`）。
 */
function resolveCategoryRef(
  ctx: CliContext,
  raw: string
): { ok: true; id: string } | { ok: false; reason: 'usage' | 'not-found'; detail: string } {
  const want = raw.trim()
  if (!want) {
    return { ok: false, reason: 'usage', detail: '分类不能为空（名字、id、id 前缀都行）' }
  }

  const cats = ctx.deps.categoryRepo.list()
  const byName = cats.filter((c) => c.name === want)
  if (byName.length === 1) return { ok: true, id: byName[0].id }
  if (byName.length > 1) {
    return {
      ok: false,
      reason: 'usage',
      detail:
        `分类名「${want}」有 ${byName.length} 个同名分类，不敢替你挑一个 —— ` +
        `请改用 id：${byName.map((c) => c.id).join('、')}`
    }
  }

  try {
    return { ok: true, id: ctx.deps.categoryRepo.resolveId(want) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    /**
     * 报错要能**指路**：三种写法都收，所以"找不到"之后要把这件事说出来 ——
     * 只写「找不到分类: X」正是让调用方以为分类不存在的那句话（见上面的实测）。
     * 前缀撞多条时 `resolveId` 自己会给"请写更长一些"，那是准确的，原样透出。
     */
    return msg.includes('不存在')
      ? {
          ok: false,
          reason: 'not-found',
          detail: `找不到分类: ${want}（名字、id、id 前缀都接受；不确定就先 category list 看一眼）`
        }
      : { ok: false, reason: 'usage', detail: msg }
  }
}

/** 两端各解析一次，报**失败的那一端**（顺带说清是哪一端的格式位置） */
function resolveMergePair(
  ctx: CliContext,
  a: string,
  b: string,
  labelA: string,
  labelB: string
): MergeEndpoints {
  const from = resolveCategoryRef(ctx, a)
  if (!from.ok) return { ok: false, reason: from.reason, detail: `${labelA}：${from.detail}` }
  const to = resolveCategoryRef(ctx, b)
  if (!to.ok) return { ok: false, reason: to.reason, detail: `${labelB}：${to.detail}` }
  return { ok: true, fromId: from.id, toId: to.id }
}

export function resolveMergeEndpoints(
  ctx: CliContext,
  flags: Flags,
  positional: string[]
): MergeEndpoints {
  const fromRaw = flags['--from'] !== undefined ? String(flags['--from']) : ''
  const toRaw = flags['--to'] !== undefined ? String(flags['--to']) : ''
  if (fromRaw || toRaw) {
    if (!fromRaw.trim() || !toRaw.trim()) {
      return {
        ok: false,
        reason: 'flags-incomplete',
        detail: '--from 与 --to 必须同时给出（两端各一个分类：名字、id、id 前缀都行）'
      }
    }
    return resolveMergePair(ctx, fromRaw, toRaw, '--from', '--to')
  }

  if (positional.length < 2) {
    return {
      ok: false,
      reason: 'ids-missing',
      detail:
        '需要两个分类：category merge <源> <目标> --yes（名字、id、id 前缀都行；' +
        '也可以用 --from / --to 指定）'
    }
  }
  /**
   * 位置参数同样走 `resolveCategoryRef`（1.0.48 起它认短号，1.0.108 起还认名字）。
   * 不解析的话 merge 会在 repo 层拿短号精确匹配查不到 —— 与 `category rm` 同一个坑。
   */
  return resolveMergePair(
    ctx,
    positional[0],
    positional[1],
    '第一个参数（源分类）',
    '第二个参数（目标分类）'
  )
}

/**
 * `category merge` 的档位**由目标决定**（1.0.107，修 `28a13efe`）
 *
 * ## 为什么要动态
 *
 * 这条命令声明的是 write 档，而它的产物是"源分类消失" —— 与 `category rm`
 * （destructive 档）做的是同一个动作的另一半。后果是：只有常规写入批准的 agent
 * 能把一个**还有待办在用的分类**合并掉，全程没有人点头、授权记录里也没有
 * "把哪个并进了哪里"。这是 `28a13efe` 报的档位错位。
 *
 * ## 判据：源分类下**还有没有待办**
 *
 * - 还有待办 → 合并等于**不可逆地抹掉一个有人用过的标签**（待办本身会改挂到 B，
 *   但 A 这个名字没了、也没有任何地方记着它曾经存在）→ 删除档，等人点头。
 * - 源分类是空的（只有它自己的名字）→ 这就是一次**标签整理**，绝大多数合并都长这样，
 *   不该为此打扰人 → 保持写档。
 *
 * 这正是 `todo delete-comment` 用过的形状（写档默认 + 按目标升级），不需要新机制。
 *
 * ## 卡上还提了一条："源分类是默认分类"也升级 —— 实现里**故意不采纳**
 *
 * `CategoryRepository.merge` 对默认分类**直接拒**（`GuardError: 系统默认分类不可被合并掉`）。
 * 把它也算成删除档，只会让人为一件注定失败的事点一次头 ——
 * 那正是 `assertScopeAllowed` 里"不能为一件注定失败的事去要授权"要防的。
 * 同理：源与目标同一个、源不存在、参数拼不出来，都退回 write，让命令自己报错
 * （`GuardError` / `UsageError` 比"你没权限"准确）。
 *
 * ## 必须有它自己的目标解析分支
 *
 * 挂上 `dynamicRisk` 就进了"删除档命令"的清单，而 `commands.test.ts` 里那条结构闸门
 * （142d0420 建的）要求清单里每条都有目标解析分支 —— 见 `GRANT_TARGET_RESOLVERS`。
 *
 * ⚠️ 纯函数、不抛错：它跑在门禁**之前**，抛错会让命令以一个莫名其妙的错误码失败。
 */
export function categoryMergeRisk(ctx: CliContext, flags: Flags, positional: string[]): RiskTier {
  const endpoints = resolveMergeEndpoints(ctx, flags, positional)
  if (!endpoints.ok) return 'write'
  const { fromId, toId } = endpoints
  if (fromId === toId) return 'write'
  try {
    const from = ctx.deps.categoryRepo.getById(fromId)
    if (!from || from.isDefault) return 'write'
    return ctx.deps.todoRepo.list({ categoryId: fromId }).length > 0 ? 'destructive' : 'write'
  } catch {
    return 'write'
  }
}

export function commentDeleteRisk(ctx: CliContext, _flags: Flags, positional: string[]): RiskTier {
  const hit = resolveCommentForDelete(ctx, positional[0] ?? '')
  if (!hit) return 'write'
  return hit.authorId && hit.authorId === actorOf(ctx) ? 'write' : 'destructive'
}

/** 根据命令和目标解析协作规则权限动作。 */
function permissionActionFor(
  ctx: CliContext,
  cmd: CommandSpec,
  flags: Flags,
  positional: string[]
): { action: PermissionAction; scope: RulesScope } | null {
  const name = cmd.name
  let action: PermissionAction | null = null
  if (name === 'todo add') action = 'create_todo'
  else if (name === 'todo comment') action = 'comment_todo'
  else if (name === 'batch') action = 'batch_todo'
  else if (name === 'release add') action = 'release_add'
  else if (name === 'release update') action = 'release_update'
  else if (name === 'release rm') action = 'release_delete'
  else if (name === 'ui set' || name === 'ui reset') action = 'ui_config'
  else if (name === 'rules propose') action = 'rules_propose'
  /**
   * 档案与协议的两条提议命令（1.0.107，修 `1d378b70`）。
   *
   * 矩阵里早就写着 `update_profile` / `update_protocol`（对 all_agents 默认
   * `require_approval`），而这两条命令**一个映射都没有** —— 于是主用户在界面上把它们
   * 设成 deny 也拦不住 agent：动作名在、命令在，中间那根线没接。
   *
   * 穷尽性由 `tests/main/cli/permission-action-coverage-1d378b70.test.ts` 钉住：矩阵里
   * 每个动作都必须能被某条真实命令触发到 `permission_denied`，新增动作不接线就变红。
   */
  else if (name === 'profile propose') action = 'update_profile'
  else if (name === 'protocol propose') action = 'update_protocol'
  else if (name === 'project handoff-update') action = 'update_handoff'
  else if (name === 'todo rm') action = 'delete_todo'
  else if (name === 'project rm') action = 'delete_project'
  else if (name === 'memo rm') action = 'delete_memo'
  else if (name === 'todo update' || name === 'todo done' || name === 'todo close') {
    action = name === 'todo update' ? 'update_todo' : 'change_todo_status'
    const rawId = positional[0]
    const todo = rawId ? (() => {
      try { return ctx.deps.todoRepo.getById(ctx.deps.todoRepo.resolveId(rawId)) } catch { return null }
    })() : null
    const requested = typeof flags['--status'] === 'string' ? flags['--status'] : null
    if (requested) {
      /**
       * 「离开待确认」与数据层的 G4 是同一件事：**替人拍板**。
       *
       * ⚠️ 但**提议人撤回/降级自己的提议不是这一档**（G4 的放行路径之一，
       * `e0ec5f32`，1.0.68 主用户拍板）。此前这里对所有"离开 proposed"一律映射成
       * `move_out_of_proposed`（对 agent 默认 deny），于是数据层明明允许的撤回
       * 在 CLI 上永远走不通，回执还指向协作规则配置 —— 而根因是这层映射过宽。
       * 两道门单看都对、合起来把提议人自己锁在外面，是组合矩阵（卡 `3792a5cc`）
       * 扫出来的第一处。
       */
      const proposerWithdraw =
        todo?.status === 'proposed' &&
        actorOf(ctx) === todo.createdBy &&
        (requested === 'todo' || requested === 'suspended')
      action = todo?.status === 'proposed' && requested !== 'proposed' && !proposerWithdraw
        ? 'move_out_of_proposed'
        : 'change_todo_status'
    }
    /**
     * G10 是**身份规则**，不是路径规则（`a7ad343f`）
     *
     * 协作规则的原文是「执行者不能验收自己做的事」，没有附加「仅当卡在待验收时」。
     * 而此前这里按**边**执法：只有 `awaiting_review → done` 映射到 `self_verify`，
     * 于是执行者只要不把卡推进待验收，直接 `todo close` / `todo update --status done`
     * 就能自证收口 —— 而且走的是**正常用法**（说明书推荐的 `todo close` 一步收口恰好在这条边上）。
     *
     * 所以判据改成「这次调用的**结果是 done**」，起点在哪一列不管：
     * - `todo close` / `todo done`：结果恒为 done；
     * - `todo update --status done`：`--status` 就是结果。
     *
     * ⚠️ 只覆盖 `change_todo_status`，不覆盖 `move_out_of_proposed`：
     * 后者是另一道门（G4「替人拍板」），映射更具体，不该被这条盖掉；
     * 而待确认的卡本来就到不了 done（数据层 G4 先拦），没有漏口。
     */
    const resultStatus =
      requested ?? (name === 'todo close' || name === 'todo done' ? 'done' : null)
    if (
      todo &&
      action === 'change_todo_status' &&
      resultStatus === 'done' &&
      actorOf(ctx) === ctx.deps.todoRepo.attributedExecutor(todo)
    ) {
      action = 'self_verify'
    }
  }
  if (!action) return null

  let projectId: string | null = null
  const projectRaw = typeof flags['--project'] === 'string' ? flags['--project'] : undefined
  const targetRaw = positional[0]
  try {
    if (projectRaw) projectId = ctx.deps.projectRepo.resolveId(projectRaw)
    else if (name.startsWith('project ') && targetRaw) projectId = ctx.deps.projectRepo.resolveId(targetRaw)
    else if (targetRaw && name.startsWith('todo ')) {
      const todo = ctx.deps.todoRepo.getById(ctx.deps.todoRepo.resolveId(targetRaw))
      projectId = todo?.projectId ?? null
    }
  } catch {
    // 目标解析由命令本体负责；权限检查无法确定项目时退回全局规则。
  }
  return { action, scope: projectId ? { scope: 'project', projectId } : { scope: 'global' } }
}

/**
 * 调用方准入：写命令必须"持证 + 已批准"，或确实是人在终端敲
 *
 * 返回 GateResult：outcome 为 null = 放行，否则是拒绝
 * （调用方照着 message 里的命令就能自救）。
 *
 * 四条判据的取舍：
 * 1. **只读一律放行** —— 查询不该有摩擦，卡住查询只会逼调用方绕路。
 * 2. **人在终端敲（interactive）放行** —— TTY 是"有人在"的可靠信号，
 *    它同时也意味着"这次调用的责任人就在屏幕前"。
 * 3. **无人值守的调用必须有凭据且已批准** —— 只声明身份不算（那是自称），
 *    要能出示注册时签发的凭据；批准由人在界面完成，agent 自己批准自己不算。
 * 4. **改界面 / 删除还要额外的一次性授权** —— 这两档的破坏力与"加一条待办"
 *    不是一个量级，长期授权等于把最危险的两件事一次性托付出去。
 */
export function assertCallerAllowed(
  ctx: CliContext,
  cmd: CommandSpec,
  /** 本次动作的目标（v19）：摘要给人看，targetIds 供执行时一致性校验 */
  target?: { summary: string; targetIds: string[] },
  /** 完整 argv（v20）：透传给 assertScopeAllowed，写进授权申请 */
  requestArgv?: string[],
  /** 已解析参数，用于协作权限矩阵按动作与项目作用域判定 */
  flags: Flags = {},
  positional: string[] = []
): GateResult {
  if (riskOf(cmd) === 'read') return { outcome: null }

  if (isInteractive(ctx)) return { outcome: null }

  /**
   * 人已在界面上点头的那条申请（1.0.45「批准即执行」）。
   *
   * 判在 interactive 之后、凭据校验之前：这次调用**不是 agent 发起的**，
   * 而是主进程替人执行他自己刚批准的动作 —— 所以它既不需要 TTY，
   * 也不需要 agent 的凭据与 approved。依据是 ctx.preApprovedGrantId，
   * 而那个字段只能由主进程 IPC 层设置（两条 CLI 通道的 ctx 都不含它）。
   *
   * 分级授权仍会在 assertScopeAllowed 里按"用户刚点的那一条"复核一次。
   */
  if (ctx.preApprovedGrantId) return assertScopeAllowed(ctx, cmd, target, requestArgv)

  /**
   * 本机有多份凭据、这次又没声明身份 → 拒绝，并列出可选身份（1.0.37）。
   *
   * 必须拦在"自称 human"之前：那种情况下 actor 取不到值、会落进下一个分支
   * 被报成 identity_required（"你先去注册"）—— 可它其实早就注册过了，
   * 只是启动器没敢替它挑凭据。指错路比不指路更浪费时间。
   *
   * 读命令在上面的 riskOf 判断里已经返回，走不到这里。
   *
   * ⚠️ 判据必须是"**这次调用没声明身份**"，而不是"本机有多份凭据"。
   * 启动器眼下确实只在未声明时才带 ambiguousIds，但门禁不该依赖调用方的自觉 ——
   * 声明过身份却还被报"你有两个身份我分不清"，会让人以为声明没生效、
   * 转头去折腾环境变量，而真正的原因（缺凭据）反而看不到。
   *
   * ⚠️ **「办手续」类命令跳过这一关**（1.0.46 修）。
   * 不跳的话会死锁：本机凭据 ≥2 份时，这一关要求"必须声明身份"才肯放行，
   * 而办手续的命令（`agent register` / `agent credential`）恰恰是要**取得**身份，
   * 两条命令都走不通（实测环境无法恢复）。理由见 humanSelfService 的注释。
   */
  const declaredActor = actorOf(ctx)
  const ambiguous = declaredActor.startsWith('agent:')
    ? undefined
    : ctx.ambiguousIds?.filter((s) => s.trim())
  if (ambiguous?.length && !cmd.humanSelfService) {
    /**
     * 文案按**接入面**分流（1.0.73 修 `3c522bdb` 第 4 点）
     *
     * 此前只教两条：`export DESKPARTNER_AGENT` 与 `--created-by`。
     * 而走 MCP 接入的调用方**两条都做不到** —— 它改不了宿主服务进程的环境变量，
     * 命令行参数也无从传递。它唯一能做的（写工具传 `actor`）恰恰没写在报错里。
     * 于是 agent 拿着一条做不到的指引反复折腾，或干脆当成产品缺陷提回来。
     *
     * 判据：**报错要给出调用方真能执行的那一步**，而不是"对我最方便的那一步"。
     */
    const fix =
      ctx.surface === 'mcp'
        ? `在你调用的那个写工具上带 \`actor\` 入参，例如 \`actor: "${ambiguous[0]}"\` ——\n` +
          `这次调用就记到它名下（不必改宿主的环境变量，那也不是你能改的）。`
        : `  export DESKPARTNER_AGENT=${ambiguous[0]}\n` +
          `也可以在命令里带 --created-by ${ambiguous[0]}（启动器会据此选凭据）。`
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'ambiguous_identity',
        message:
          `本机有 ${ambiguous.length} 个 agent 凭据（${ambiguous.join('、')}），` +
          `但这次调用没声明身份，无法判断该用哪一份。
` +
          `为避免把你的操作记到别的 agent 名下，这里不替你猜。请声明后重试：
` +
          fix
      }
    }
  }

  const actor = declaredActor

  /**
   * 「办手续」类命令到这里就放行（1.0.46 修，1.0.47 起 agent 也能走）。
   *
   * 下面的 `identity_required` 要求"非交互调用必须声明 agent 身份"，
   * 可这三条命令（register / credential / revoke）**恰恰是用来取得身份的**：
   * 报错文案写着"先 `agent register`"，调用方照做后撞上的还是同一句话 ——
   * 自我指涉的循环（实测：脚本里调 `agent register` 被拒，环境恢复不了）。
   *
   * 放行的安全性：目标由 `--id` 显式给出，不依赖"这次调用是谁"，
   * 也不写待办数据；真正决定"能不能写你的数据"的闸门仍是界面上的「批准」。
   */
  if (cmd.humanSelfService) return { outcome: null }

  // 无人值守却自称 human：最常见的"冒名"形态，直接指路注册
  if (!actor.startsWith('agent:')) {
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'identity_required',
        message:
          `无人值守的调用（非终端）不能匿名写入：本次动作人会被记成 human，` +
          `等于把这件事挂在用户名下。
` +
          `若是 agent：先 \`agent register --id agent:<你的名字> --name "展示名"\`，` +
          `再 \`agent credential --id agent:<你的名字>\` 领凭据（此后由启动器自动携带），` +
          `最后请用户在界面上批准。
` +
          `若是你在终端操作：这次调用被判定为非交互（stdout 不是 TTY），请直接在终端里敲。`
      }
    }
  }

  const agent = ctx.deps.agentRepo.get(actor)
  if (!agent) {
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'identity_unregistered',
        message: `身份未注册：${actor}。先跑 \`agent register --id ${actor} --name "展示名"\``
      }
    }
  }

  if (!agent.approved) {
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'identity_pending',
        message:
          `身份 ${actor} 还没被批准写入（已注册，等用户点头）。
` +
          `**这一步 agent 自己做不到** —— 请让用户在「主窗口 → 审批页 → 待批准身份」里点「批准」` +
          `（谁能往他的看板写东西，只能由他决定）。` +
          `注册时界面已经弹过一次横幅提醒，你不用重复注册、也不必重试这条命令。`
      }
    }
  }

  /**
   * 迁移：1.0.35 之前注册、且当时已被批准的身份没有凭据。
   *
   * 旧规则里"批准"就是人点过头（界面上的 approved），那一票在旧语义下
   * 等价于"可以写"。升级时不能因为换了把锁就把已经授权的人锁在外面 ——
   * 这里给它补发一份凭据并落盘，一次性升级到持证状态，之后走正常校验。
   * **仅限已批准的**：未批准的新身份仍必须走完注册→领凭据→人批准三步。
   */
  if (!agent.hasCredential) {
    const issued = ctx.deps.agentRepo.issueCredential(actor)
    if (issued) writeCredential(actor, issued.token)
    return assertScopeAllowed(ctx, cmd, undefined, requestArgv)
  }

  // 持证校验：注册只说明"有这么个名字"，凭据才说明"这次调用确实来自它"
  const token = ctx.credential?.trim()
  if (!token) {
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'credential_missing',
        message:
          `身份 ${actor} 未出示凭据。跑一次 \`agent credential --id ${actor}\` 领凭据，` +
          `之后每次调用由启动器自动携带（不用再记着 export）。`
      }
    }
  }
  if (!ctx.deps.agentRepo.verifyCredential(actor, token)) {
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'credential_invalid',
        message:
          `凭据无效（与库中 ${actor} 的记录不符）。跑 \`agent credential --id ${actor}\` 重发一份 —— ` +
          `重发后旧凭据立即失效。`
      }
    }
  }

  // 权限矩阵必须真正参与执行，不能停留在 GUI 可编辑的“展示配置”。
  const permission = permissionActionFor(ctx, cmd, flags, positional)
  if (permission) {
    const decision = new GuardResolver(ctx.deps.rulesRepo).checkPermission(
      permission.action,
      actor,
      permission.scope
    )
    if (decision === 'deny') {
      return {
        outcome: {
          ok: false,
          code: EXIT_CODES.guard,
          errorCode: 'permission_denied',
          message: `协作规则禁止身份 ${actor} 执行「${permission.action}」。请让主用户在协作规则配置中调整。`
        }
      }
    }
    if (decision === 'require_approval' && permission.action === 'update_handoff') {
      return {
        outcome: {
          ok: false,
          code: EXIT_CODES.guard,
          errorCode: 'approval_required',
          message: `修改项目接手说明需要审批：请使用 \`project handoff-propose\` 提交提议，等待主用户在审批页采纳。`
        }
      }
    }
  }

  return assertScopeAllowed(ctx, cmd, target, requestArgv)
}

/**
 * 分级授权（1.0.36）：改界面 / 删除两档要**单次点头**
 *
 * 主用户拍的是"读写改删四档 + 撤销与审计"，不做信任升级 ——
 * 也就是：权限不会因为"最近都没出事"而自动变宽，只会因为人点头才变宽。
 *
 * 为什么这两档不能并进"批准"：批准是一次性、长期有效的开关，
 * 而改界面（动的是人的视觉环境）与删除（数据没了就没了）
 * 的风险与"加一条待办"差一个量级。Claude Code 的做法是
 * **同意的有效期按风险分级**：文件修改到会话结束、危险操作每次都问。
 *
 * 这里的两档：
 * - config（改界面）：授权**仅本次会话有效**（8 小时 + 会话绑定，取更严的那个）
 * - destructive（删除）：**一次性**，用掉即止，下次还得问
 *
 * 无人值守的调用没法"弹窗问"（agent 面前没有人），所以做法是：
 * 被拒时**落下一条待表态的授权申请**，人在设置页看到并点头，agent 重试即可。
 * 申请本身也就是审计记录 —— 谁、什么时候、想干什么、批了没有，全在表里。
 */
export function assertScopeAllowed(
  ctx: CliContext,
  cmd: CommandSpec,
  /** 本次动作的目标（v19）：摘要给人看，targetIds 用于执行时的一致性校验 */
  target?: { summary: string; targetIds: string[] },
  /**
   * 本次调用的完整 argv（v20）：写进授权申请，供「批准即执行」重建动作。
   *
   * 主用户 2026-09-22 判定的架构问题：批准之后 agent 得回来重试，
   * 而它可能早已离线（授权也就白批了）。修法是让服务端在用户点头时
   * **直接执行** —— 那就必须把这条命令完整记下来，光有 `todo rm` 不够，
   * 「删哪一条」全在参数里。
   */
  requestArgv?: string[]
): GateResult {
  const risk = riskOf(cmd)
  // 批准回放必须先于 write 档提前返回校验；非空 ID 本身不是批准事实。
  if (ctx.preApprovedGrantId) {
    const g = ctx.deps.agentRepo.getGrant(ctx.preApprovedGrantId)
    const wants = target?.targetIds ?? []
    const reviewReplay = ['todo update', 'todo done', 'todo close'].includes(cmd.name)
    const expectedScope = risk === 'config' ? 'config' : 'destructive'
    const usable =
      g !== null &&
      g.status === 'granted' &&
      (!g.expiresAt || g.expiresAt > new Date().toISOString()) &&
      g.agentId === actorOf(ctx) &&
      g.command === cmd.name &&
      g.scope === expectedScope &&
      (!reviewReplay || (wants.length === 1 && g.targetIds.length === 1)) &&
      sameTargetSet(g.targetIds, wants) &&
      Array.isArray(requestArgv) &&
      g.requestArgv.length > 0 &&
      grantCoversArgv(g.requestArgv, requestArgv)
    if (usable) {
      return { outcome: null, consumableGrantId: g.scope === 'destructive' ? g.id : undefined }
    }
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.guard,
        errorCode: 'grant_required',
        message: `授权申请 ${ctx.preApprovedGrantId} 不能用于这次动作（状态、有效期、身份、命令、目标或参数不符）。请重新申请，由用户确认具体动作。`
      }
    }
  }
  if (risk !== 'config' && risk !== 'destructive') return { outcome: null }

  const scope: GrantScope = risk === 'config' ? 'config' : 'destructive'
  const actor = actorOf(ctx)
  const session = ctx.session?.trim() || null
  const wants = target?.targetIds ?? []

  /**
   * 删除档必须有可确认的目标，否则**不进申请流程**（1.0.49 修，实测踩中）
   *
   * 背景：`summarizeGrantTarget` 在 id 解析不出来时（待办已删、id 打错）
   * 会退回"原始命令行 + 空目标"，且它刻意不抛错（它本是给横幅写说明的）。
   * 问题是它的 `targetIds` 同时**是安全校验的输入**，于是这条缝会连出两个后果：
   *
   * ① 人白点一次：申请照旧生成，她点头、服务端执行、报「待办不存在」。
   *    实测就是这一条 —— 目标早被删掉，界面却又弹了一次申请。
   * ② 更糟：空目标命中"任一方为空即不校验"的豁免，把 v19 刚堵上的
   *    「批准删 A 却能删 B」从这条缝里重新打开。
   *
   * 所以拿不到目标就直接告诉调用方"对象不在了"，语义上也更对：
   * **不能为一件注定失败的事去要授权**。
   *
   * `telemetry clear` 是唯一合法的空目标命令（它的目标是时间范围，没有 id）。
   * 将来若新增无目标的删除命令，必须在这里显式加白名单 —— 这是有意的摩擦，
   * 强迫"要不要豁免目标校验"成为一个被看见的决定。
   */
  if (scope === 'destructive' && cmd.name !== 'telemetry clear' && wants.length === 0) {
    return {
      outcome: {
        ok: false,
        code: EXIT_CODES.notFound,
        /**
         * 结构化错误码（142d0420 修）。
         *
         * 这里此前只有数字退出码、没有 `errorCode`，于是 JSON 信封里的
         * `code` 字段**整段消失**（output.ts 是 `code: outcome.errorCode`）——
         * 回执成了 `{ok:false, message:...}`，调用方只能按文案猜。
         * 而"写入失败以结构化 code 为准，不按错误文案猜"是本项目自己的纪律
         * （1.0.91 起），这条恰好是它最该生效的场合：报错文案里的目标
         * 是从命令行拼回来的，而调用方恰恰要判断"是我参数写错了，还是对象没了"。
         */
        errorCode: 'not_found',
        message:
          `目标不存在或解析不出来，无法发起删除申请：${target?.summary ?? cmd.name}。` +
          `请确认对象还在，再重新申请（不生成申请 —— 批了也做不成）。`
      }
    }
  }

  /**
   * 已由人点头的那条申请（1.0.45）：批准即执行走这里。
   *
   * 依据必须是**用户刚点的那一条**，而不是"当前有可用授权"这个状态 ——
   * 人可能为 A 批过一次（还在有效期内），又刚为 B 点了允许，只判状态
   * 就会挑中那条 A 的授权，又回到"批的与做的不一致"。
   *
   * ⚠️ 这里**直接按 id 取那条记录来校验**，不走 `findUsableGrant`。
   * 后者带一个 `(session_id IS NULL OR session_id = ?)` 条件 —— 那是为
   * "agent 拿自己的会话重试"设计的；而代人执行时调用方是主进程，
   * 根本没有会话 id，于是 `session_id = NULL` 会把一条正常绑了会话的
   * 授权判成不可用（实测：人明明批了，却收到 grant_required）。
   *
   * 校验四件事，缺一不可：
   * - 状态是 granted（不是 pending / denied / consumed / 已过期）
   * - 身份与本次动作一致（别人的授权不能拿来用）
   * - **命令一致**（1.0.49 补）：授权记的是 `todo rm`，就不能用来跑 `category rm`。
   *   和 `findUsableGrant` 同一条规则 —— 命令名永远知道，不设空值豁免。
   * - 目标集合与申请时相同（v19 那条漏洞的教训：授权链路上少校验一步，
   *   就等于「批准删 A」可以删 B）
   */

  // 带上命令与目标：授权只在「同一条命令 + 同一批目标」上算数（v19 堵目标、1.0.49 堵命令）
  const usable = ctx.deps.agentRepo.findUsableGrant(actor, scope, session, cmd.name, wants)

  if (usable) {
    // 删除档用掉即止：把 id 带出去，等命令真的成功了才置 consumed
    return { outcome: null, consumableGrantId: scope === 'destructive' ? usable.id : undefined }
  }

  /**
   * 先看一眼"是不是已经有待表态的申请了"，再让 requestGrant 去复用/新建。
   *
   * 这一步不是多余的：requestGrant 会把同 (身份, 档位, 会话) 的重复申请**合并**成一条，
   * 所以"合并了"和"刚建的"从返回值上分不出来。而下面的横幅事件只在**新申请**时发 ——
   * 一个循环重试十次的 agent 会合并成一条申请（这是对的），
   * 但要是每次都发一遍事件，人就会被同一个横幅弹十次，那比没有提醒更烦。
   */
  const alreadyPending = ctx.deps.agentRepo
    .listGrants({ agentId: actor, scope, status: 'pending', activeOnly: true })
    .some((g) => {
      if ((g.sessionId ?? null) !== (session ?? null)) return false
      /**
       * 目标不同的**不算**"已有申请"（v19）：那条不会被复用，
       * requestGrant 会另落一条新的，所以事件必须发 —— 否则她看到的是
       * 一条针对 A 的旧横幅，而 agent 实际在等的是 B 的批准。
       */
      if (g.targetIds.length > 0 && wants.length > 0) {
        return sameTargetSet(g.targetIds, wants)
      }
      return true
    })

  const pending = ctx.deps.agentRepo.requestGrant({
    agentId: actor,
    scope,
    command: cmd.name,
    /**
     * 摘要同时写进**授权记录**（v18）。
     *
     * 主用户 2026-09-22 报的"审批详情里没有说明删除的事项是哪个"，
     * 根因就是上一版只把 summary 写进了下面的事件表（横幅读它），
     * 而设置页读的是授权记录 —— 两个消费者读两份数据，必然对不上。
     * 授权记录本身是审计凭据，它就该自己说清"申请的是什么"。
     */
    summary: target?.summary ?? null,
    // 目标集合（v19）：执行时据此校验，防"批准删 A 却用来删 B"
    targetIds: wants,
    // 完整命令行（v20）：批准即执行时靠它重建这次动作
    ...(requestArgv?.length ? { requestArgv } : {}),
    sessionId: session
  })

  /**
   * 落一条事件，让**正在跑的 GUI** 把横幅弹出来（1.0.37）
   *
   * 主用户的反馈是"界面上没有看到任何审批提醒"—— 而 agent 此刻正卡在这条命令上等人点头。
   * 光在设置页里挂个红点是不够的：那是"你去找它"，而这里是"它来告诉你"。
   *
   * 为什么绕事件表而不是直接调窗口管理器：这条命令可能跑在**另一个进程**里
   * （无头通道），本进程根本没有窗口可弹。事件表是两条通道共用的既成机制
   * （ChangeBroadcastService 已在轮询），复用它，两种情形都能覆盖。
   */
  if (!alreadyPending) {
    ctx.deps.events.append('grant', 'cli', {
      grantId: pending.id,
      agentId: actor,
      scope,
      command: cmd.name,
      /**
       * 申请目标的可读摘要（1.0.39）。
       *
       * 主用户指出横幅"没说删除什么" —— 人没法只凭命令名决定要不要点头。
       *
       * ⚠️ 这条注释在 v19 之后**改过一次结论**（原文写的是"summary 只是说明、
       * 不是授权依据 —— 批准的对象始终是 (agentId, scope)"）。那个说法当时成立，
       * 但Bob随后实测证明它是**危险的**：既然授权只认 (agentId, scope)，
       * 她批准"删 A"之后，同一条授权就能被拿去删 B（实测退出码 0、deleted:true）。
       * 摘要写得越清楚，这个漏洞越有欺骗性 —— 人以为自己批的是定点手术。
       *
       * 所以现在分两层：
       * - `summary` 仍是**说明**（给人看，丢了/错了只影响看得多明白）；
       * - `targetIds` 是**授权依据**（v19 起参与执行校验，批的与做的不一致就拒）。
       */
      ...(target?.summary ? { summary: target.summary } : {})
    })
  }

  const what = scope === 'config' ? '改界面' : '删除数据'
  const how = scope === 'config' ? '仅本次会话有效' : '一次性，用掉即止'
  return {
    outcome: {
      ok: false,
      code: EXIT_CODES.guard,
      errorCode: 'grant_required',
      message:
        `${cmd.name} 属于「${what}」档，需要用户单独点头（${how}）—— ` +
        `写入批准只覆盖"改待办"，不覆盖这一档。
` +
        /**
         * ⚠️ 这段文案在 1.0.45 之后改过一次结论。
         *
         * 原文写的是「请提醒用户在设置里点允许，**然后重试这条命令**」——
         * 那是"批准只发许可证"时代的说法。现在用户点「允许并执行」时
         * 服务端会**当场把这件事做掉**（主用户 2026-09-22 的架构判断），
         * 所以 agent 不需要、也不该再重试：它重试反而会撞上
         * "授权已被消费"（一次性授权在执行那一刻就销账了）。
         *
         * 留着旧文案的代价是真实的：agent 照做就会得到一条令人困惑的
         * grant_required，然后去申请第二次批准 —— 而事情其实已经做完了。
         */
        `已生成授权申请（id: ${pending.id}）。请提醒用户在 主窗口 → 审批页 → 等你点头 里点「允许」——` +
        `**用户一点允许，服务端就会立刻执行这件事，你不需要再重试**。
` +
        `如果你确实重试了却仍被拦，多半是用户还没点头（或已经拒绝）。` +
        `界面还会弹一条顶部横幅（无需你去催）；想提前知道自己有没有这一档权限：\`agent whoami\`（自检会列出各档状态）。`
    }
  }
}

/** 这次调用是不是"有人在终端敲" */
export function isInteractive(ctx: CliContext): boolean {
  // 未标注一律按非交互：安全默认 —— 漏传只会多卡一次，不会悄悄放行
  return ctx.interactive === true
}

/**
 * 某一档权限的自检结论（whoami 用）
 *
 * `granted` = 已批准且**确实可用**；
 * `retryable` = 已批准但**上一次执行失败** —— 授权还在，可重试同一件事；
 * `unavailable` = 已被消费 / 已撤销 / 已过期 —— 这条授权不再算数。
 *
 * ⚠️ 加 `retryable` 与 `unavailable` 的原因（1.0.65 修 `b74d9fb3`）：
 * 此前只回"有没有一条 granted 记录"，于是**凭据已被消费、上次回放已报错**
 * 的情形照样报 `destructive=once`。agent 读到的结论是"我还能删"，
 * 于是照着这个结论把流程往下走，直到真删时才撞墙 ——
 * 而它本来有机会在开工前就看见"上一条失败了"。
 *
 * 一律报"可用"比报错更糟：它让 agent 做出**错误决策**而不只是撞一次墙。
 * 这也正是当初给 `whoami` 补档位字段的同一条理由（`156fa923`）——
 * 字段齐了不等于结论对，结论必须跟着真实状态走。
 */
type ScopeState = 'granted' | 'retryable' | 'unavailable' | 'n/a' | 'no'

export function inspectScope(
  ctx: CliContext,
  scope: 'config' | 'destructive'
): { state: ScopeState; detail: string | null } {
  // 人在终端敲：两档都不卡（责任人在屏幕前）
  if (isInteractive(ctx)) return { state: 'n/a', detail: null }
  const actor = actorOf(ctx)
  if (!actor.startsWith('agent:')) return { state: 'no', detail: null }

  const session = ctx.session?.trim() || null
  const g = ctx.deps.agentRepo.findAnyUsableGrant(actor, scope, session)
  if (!g) {
    /**
     * 没有"可用"记录时，仍要看一眼**最近一条**同档授权是什么下场。
     * 少了这一步，"我用掉了唯一一次删除授权"和"我从没申请过"返回同一个 no，
     * agent 分不出该重新申请还是该走别的路。
     */
    const latest = ctx.deps.agentRepo.findLatestGrant(actor, scope)
    if (!latest) return { state: 'no', detail: null }
    const why: Partial<Record<typeof latest.status, string>> = {
      consumed: '这一档的一次性授权已被用掉，需要重新申请',
      revoked: '授权已被撤销，需要重新申请',
      expired: '授权已过期，需要重新申请',
      denied: '上一次申请被拒绝，需要重新申请'
    }
    const reason = why[latest.status]
    if (reason) return { state: 'unavailable', detail: reason }
    // pending = 人还没点头，那本来就"没有可用授权"，不必额外解释
    return { state: 'no', detail: null }
  }

  /**
   * 找到了 granted 记录，但它**上一次执行是失败的** —— 这一档不是不能用，
   * 而是"你上次用它没成功"。如实说出来，agent 才能决定先重试还是先排查。
   */
  if (g.execStatus === 'error') {
    return {
      state: 'retryable',
      detail:
        '已批准，但上一次执行失败（授权仍然有效，可重试同一件事）：' +
        (g.execError ?? '未记录原因')
    }
  }

  return { state: 'granted', detail: null }
}

/**
 * 某一档权限现在是什么状态（whoami 自检用，给 agent 看的那句结论）
 *
 * 给的是**结论**而不是"有没有授权记录"：后者还要调用方自己判有效期、
 * 判会话、判用没用掉 —— 每多一步判断就多一处可能判错的地方，
 * 而判错的后果是它以为自己有权限、做到一半才撞墙。
 *
 * ⚠️ `scopes.*` 这一列是**给人看的既有口径，保持原样**（yes/session/once/no/n/a），
 * 免得已经按它写分支的 agent 脚本集体改版。真实可用性由新增的
 * `scopeDetails` 承担 —— 两份信息并存，各管一件事，别把语义塞进同一列。
 */
export function describeScope(
  ctx: CliContext,
  scope: 'config' | 'destructive'
): 'yes' | 'session' | 'once' | 'no' | 'n/a' {
  const { state } = inspectScope(ctx, scope)
  // 'retryable' 仍算"有这一档"：授权确实还在，重试是允许的
  if (state === 'granted' || state === 'retryable') {
    const g = ctx.deps.agentRepo.findAnyUsableGrant(
      actorOf(ctx),
      scope,
      ctx.session?.trim() || null
    )
    if (!g) return 'no'
    return scope === 'config' ? (g.sessionId ? 'session' : 'yes') : 'once'
  }
  if (state === 'n/a') return 'n/a'
  // 'no' 与 'unavailable' 在这一列都回 no，差别由 scopeDetails 说明
  return 'no'
}



/**
 * 标题的形状校验：单行、限长。
 *
 * 此前什么样的标题都照收（bob 实测报的）：带换行的标题会把卡片和
 * 流式布局撑破，超长标题在卡片上被截得只剩省略号、列表里又得横向滚动。
 * 上限 200：一条标题该是一句话的事，细节属于 --desc。
 */
export const TITLE_MAX_LENGTH = 200

export function assertValidTitle(title: string): void {
  if (/[\r\n]/.test(title)) {
    throw new UsageError('标题不能包含换行；多行内容请写进 --desc')
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw new UsageError(`标题太长（${title.length} 字符，上限 ${TITLE_MAX_LENGTH}）；细节请写进 --desc`)
  }
}

export interface ArgSpec {
  flag: string
  type: 'string' | 'enum' | 'boolean'
  required?: boolean
  enum?: readonly string[]
  /**
   * 允许逗号分隔的多值（1.0.63）。
   *
   * 为什么要在声明里表达而不是各命令自己 split：多值的**解析与校验**
   * 必须和单值走同一条路，否则同一个值单传合法、并进逗号里就绕过了校验。
   * 读命令里 `--status` 最需要它（"待办+进行中"这种并集此前无法表达，
   * 只能拉全库自己过滤）；`--category` / `--project` 之类也天然是多值语义。
   *
   * 声明了 multi 的 flag：分隔、去空、去重、逐值过 enum 校验都在 parseFlags 里完成，
   * run 函数拿到的就是已规整的逗号串。
   */
  multi?: boolean
  /**
   * 允许同一个 flag 重复出现，收集成数组（1.0.73，`release add --highlight`）。
   *
   * ## 为什么不用 `multi`（逗号分隔）
   *
   * `multi` 的分隔符是逗号，而**它的语义是"一个 flag 多个值"**
   * （`--status todo,done` 是一次参数给两个枚举）—— 适合短枚举，
   * 不适合自由文本：`release add --highlight "修了 A、B 两个坑，顺带清了 C"`
   * 会被逗号切开，变成三条互不相干的要点。
   *
   * `repeat` 保持每条文本原样（含逗号、含空格），由调用方**重复传 flag** 表达多条：
   * `--highlight "第一条" --highlight "第二条"`。判据：**分隔符不该由产品猜**，
   * 自由文本里的逗号是内容，不是语法。
   */
  repeat?: boolean
  desc: string
}

/**
 * 把参数值规整成字符串
 *
 * 为什么需要它：`--desc ""` 这种"传空串表示清空"的写法，
 * 空串在跨越进程边界时会被某些调用方（PowerShell、部分 shell）
 * 整个吞掉，到这边只剩一个裸 `--desc`，被 parseFlags 判成布尔 true。
 * 直接 String(true) 会把描述写成字符串 "true" —— 数据脏了，而调用方毫不知情。
 *
 * 真值 true = 参数在、值丢了 = 传的是空串。这两种情况都按空串处理，
 * 比写出一个 "true" 离谱值要好得多。
 */
export function strValue(v: string | boolean | string[] | undefined): string {
  if (v === undefined || v === true) return ''
  if (v === false) return ''
  /**
   * 数组只可能出现在 `repeat: true` 的 flag 上（1.0.73）。
   * 对单值语义的调用方而言，读到数组 = 用错了 flag ——
   * 取最后一条而不是静默返回 ''：空串会让"清空"之类的动作**真的执行**，
   * 而调用方本意不是清空。这与上面"值丢了按空串处理"的取舍不同：
   * 那里是**已知的传输损失**，这里是**调用方用错**，不能替它猜。
   */
  if (Array.isArray(v)) return v.length ? v[v.length - 1] : ''
  return v
}

/**
 * 解析出来的参数值。
 *
 * `string[]` 只出现在 `repeat: true` 的 flag 上（1.0.73）——
 * 它必须与单值走**同一个 channels**（都从 `flags` 取），
 * 否则 run 函数要同时接两个来源，而"两个来源"正是本项目反复在治的病根
 * （一份语义两个出口，迟早有一处漏改）。调用方用 `toArray(...)` 取值。
 */
type Flags = Record<string, string | boolean | string[]>

/**
 * 取一个可重复 flag 的值，**一律得到数组**（1.0.73）
 *
 * 兼容三种真实形状：`string[]`（repeat flag 的正常形态）、
 * `string`（旧调用方或手工构造 flags 时传单值）、`undefined`（没传）。
 * 后两者归成 `[v]` 与 `[]` —— 判据：**调用方不该关心它传了几次**，
 * 只关心"给了我几条"。让每个命令各自处理这三种形状，
 * 就会长出 N 份互不一致的兼容代码（本项目反复在治的病根）。
 */
export function toArray(v: string | boolean | string[] | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'boolean') return []
  return [v]
}

/**
 * 所有命令都认的 flag（不写进各命令的 args，否则 34 条命令要重复声明 34 遍）。
 * `--help` 在 run.ts 里已被提前拦下，这里保留是防止别的入口绕过来时被误判成未知参数。
 */
export const GLOBAL_FLAGS = new Set(['--help', '-h'])

export interface CommandSpec {
  /** 完整命令名，如 'todo add' */
  name: string
  desc: string
  args: ArgSpec[]
  /**
   * 位置参数声明。`required` 与 `arity` 治的是**两件事**，别混：
   *
   * - `required`：**少给**了要不要拦（如 `todo get` 不给 id）；
   * - `arity`：**多给**了算不算错（默认 1，见 `maxPositionalArgs`）。
   *
   * 为什么默认是"多给就错"而不是"多给就丢"（1.0.107，修 `350f9631`）：
   * 丢掉的参数让回执**看着正常**（`agent grants zzz` 回全部 81 条、exit 0、
   * ok:true），调用方据此以为筛选生效了 —— 静默的数据错误比一次可诊断的失败贵。
   * 吃两个的要显式写 `arity: 2`（`category merge` 的两个 id、`help` 的两个词命令名）。
   */
  positional?: { name: string; required?: boolean; desc: string; arity?: number }
  /**
   * 只读命令：不改动数据，因此**不需要身份**也能调用。
   *
   * 刻意做成"显式声明只读"而不是"显式声明写入"：漏标时按写入处理（要卡），
   * 反过来漏标则等于悄悄开了一道门。安全默认必须是"要卡"。
   */
  readOnly?: boolean
  /**
   * 「办手续」类命令（agent register / credential / revoke）。
   *
   * 🚨 **1.0.47 语义变更：agent 可以自己办手续了，人只负责审批。**
   *
   * 此前这三条是 `humanOnly` —— 拦住"agent 自己声明身份去办手续"，
   * 理由是"它能注册一个名字、再自己批准"。**但那个理由站不住**：
   * `agent:setApproved` 只注册在 IPC 上（`assertFromSettings` 限设置页发起），
   * CLI 侧**根本没有对应命令**，agent 无论如何都批准不了自己。
   * 这道闸门防的是一个不会发生的场景，却把真实用户挡在外面。
   *
   * 主用户 2026-09-23 判定：「必须允许 agent 自带身份办手续，人做审批。
   * 你现在的机制默认用户是开发者，会用命令系统，但现实用户更多是不会开发的普通人。」
   * —— 原设计要求 agent"先 unset DESKPARTNER_AGENT 再重跑"，这是开发者才会做的事；
   * 普通用户看到的是"我的助手说它注册不了"，而他完全不知道环境变量是什么。
   *
   * 现在的分工：**手续 agent 自己办，审批权牢牢在人手里**。
   * 安全性没有降低 —— 因为真正决定"能不能写你的数据"的从来不是这三条命令，
   * 而是界面上的 `approved`：
   * - `agent register` 只产出一个名字，`approved=0`，一个字都写不进来；
   * - `agent credential` 只签发凭据，凭据不通过审批照样被 `identity_pending` 拦；
   * - `agent revoke` 只能**收窄**权限（最坏是把自己锁上），不可能提权。
   *
   * ⚠️ 配套（必须同时满足，否则"人做审批"落空）：
   * 1. 待批准的身份要能被看见 —— 界面红点必须把"未批准的 agent"也算进去
   *    （此前只数授权申请，agent 自己注册完人根本不知道有东西等他点头）；
   * 2. 批准入口只有界面（`agent:setApproved` 仅 IPC），CLI 不提供 —— 这条不变。
   *
   * ⚠️ 仍然要跳过 `ambiguous_identity` 与 `identity_required` 两关（1.0.46 的修复保留）：
   * 这两关防的是"写操作被记到别人名下"，而这三条命令**操作对象是显式传进来的 `--id`**，
   * 不依赖"这次调用是谁"，也不写任何待办数据 —— 没有认错人/冒名的风险。
   */
  humanSelfService?: boolean
  /**
   * 风险档位（1.0.36 分级授权）。未标注 = 按 `readOnly` 推：
   * 只读命令是 read，其余是 write。**漏标按更严的一档处理**。
   */
  risk?: RiskTier
  /**
   * 档位**由目标决定**时用它（1.0.63，收 dbfbc553 选③）
   *
   * ── 为什么需要"动态档位" ──
   *
   * 四档授权是按**命令**分的（`todo rm` 是删除档、`ui set` 是改界面档），
   * 但同一条命令对着不同目标时，破坏力可以差一个量级：
   * `todo delete-comment` 删掉自己写错的一条，和删掉**别人写的驳回理由**，
   * 完全是两件事 —— 后者是把验收证据从链路上抹掉，多 agent 共用一块看板时
   * 等于任何一方都能悄悄抹掉另一方的结论（qwen 实测报的 dbfbc553）。
   *
   * 静态 `risk` 做不到这件事：标 write 则删证据不设防，标 destructive
   * 则连自己收拾自己的口误都要人点一次头。所以把判定推迟到**知道目标之后**。
   *
   * ⚠️ 实现方式是"给门禁换一个 risk 值"（executeOne 里浅拷贝 cmd），
   * 不是给门禁加一条新分支 —— 这样 `assertScopeAllowed` / `summarizeGrantTarget` /
   * `normalizeGrantArgv` 全部沿用既有逻辑，不会长出第二条判据。
   *
   * ⚠️ **判定函数必须是纯的、且不得抛错**：它跑在门禁之前，
   * 抛错会让命令以一个莫名其妙的错误码失败。解析不出目标时返回 `'write'`
   * 并让命令自己报 not_found（"查不到"比"你没权限"更准确）。
   */
  dynamicRisk?: (ctx: CliContext, flags: Flags, positional: string[]) => RiskTier
  /**
   * 输出形态。默认走统一的 JSON 信封；
   * - 'ndjson'：结果是数组，按行输出纯 NDJSON（便于重定向/流式处理）
   * - 'text'：结果是字符串，原样输出（如 Markdown，不能被 JSON 包住）
   */
  output?: 'json' | 'ndjson' | 'text'
  /**
   * 回执 `data` 的形状（1.0.110，收 `07a244d9`）。
   *
   * ## 治的病：形状没处事先知道，只能按键试错
   *
   * 说明书里有一句设计承诺 ——「计数在 `meta` 里而不是 `data` 里，
   * 是为了让 `data` 始终是数组（老脚本按数组解析不受影响）」。
   * 但实测只有 **list 类**命令成立：`todo get` / `todo children` / `project get` /
   * `notification list` 的 `data` 是**对象**，而 schema 里一个字都没说 ——
   * 调用方只能逐条跑一遍看它是 `[]` 还是 `{}`，写紧凑化／计数小工具时逐命令分支
   * （PenguinHarness 评测会话 2026-10-15 · 报告 §4.2 P10 · 1.0.97 实测报的）。
   *
   * ## 为什么是"声明形状"而不是"统一形状"
   *
   * 卡上给了三条路，选中间那条：
   * - 只写文档 —— 零代码，但调用方仍要读文档，且**文档不会报错**（本仓库为此修过多次）；
   * - **声明 + 闸门** —— 可机读、可断言、可随版本验证；
   * - 统一成一种（如数组塞进 `data.items`）—— **破坏性变更**：
   *   本机既有脚本按 `Array.isArray(data)` 走，会先坏掉。留作更大版本的事。
   *
   * ## 只对信封类命令有意义
   *
   * `output: 'text'`（`skill`）与 `'ndjson'`（`telemetry export`）**没有信封 `data`**，
   * 形状由 `output` 本身回答（原文 / 逐行记录），所以**不许**在这里再声明一次 ——
   * 同一个事实两处声明，迟早有一处漂。
   *
   * 闸门（`tests/main/cli/receipt-contract-self-report.test.ts`）三头都管：
   * 信封类命令漏声明要红、非信封类命令声明了也要红，
   * 并且**对着 fixture 把每条命令真跑一遍**，比 `Array.isArray(data)` 与声明是否一致
   * —— 声明漂了有人知道，而不是等接入方撞上。
   */
  dataShape?: 'array' | 'object'
  /**
   * 默认口径的可机读声明（1.0.110，收 `516a74d4`）。
   *
   * ## 治的病：默认值只在句子里，不在契约里
   *
   * `todo list` 的默认口径此前散在几处**字符串**里（命令行为、`--limit` 的参数说明、
   * 回执那句 `defaultScope`），而两侧真正剩下的差别是「**默认带不带描述**」：
   * CLI 直连默认带上（截到 `LIST_DESC_PREVIEW_CHARS` 字），MCP 的 `list_todos`
   * 默认替调用方兜 `--brief` —— 同一份库，一次回有描述、一次没有，
   * **而回执里没有任何字段说这件事**，字节数差出一大截也没解释。
   *
   * 判据与 `defaultScope` / `projectScope` 同源：**默认口径变了就在契约里说清**。
   * 这里是契约为**默认**（不传参数时）的那一份；这一次**实际**用的口径在回执
   * `meta.fields` 里 —— 调用方显式传了 `--brief` 就与默认不同，两者不是一回事。
   *
   * ⚠️ 只声明**真实存在的默认**，且值必须取自那条命令自己用的常量
   * （`TODO_LIST_DEFAULT_LIMIT` / `AGENT_GRANTS_DEFAULT_LIMIT` 之类）——
   * 在这里另抄一个数字，就是给"两处口径漂了"留位置。
   * ⚠️ 这是**通道无关**的默认：MCP 侧按通道政策另兜一个（`DEFAULT_ROW_LIMIT`，50），
   * 两者不是同一个决定（见 `TODO_LIST_DEFAULT_LIMIT` 的注释）。谁在跑，以回执里的实际值为准。
   */
  defaults?: {
    /** 不传 `--limit` 时默认最多几条（0 = 不收窄，没有条数上界） */
    limit?: number
    /** 不传 `--brief` 时描述字段怎么给（取值与回执 `meta.fields` 同一套） */
    fields?: {
      description: 'preview' | 'omitted'
      previewChars: number
    }
  }
  /**
   * 这个命令**从 stdin 读记录**（1.0.107，修 `0a9f42f8`）。
   *
   * 声明它 = 「本命令是批量容器」。别的通道（MCP）据此给它一个"把记录送进去"的入口 ——
   * 与 `output` 同一个形状：**能力由命令自己声明，通道按声明派生**，
   * 不在通道里再写一份「哪些命令吃 stdin」的名单（那份名单迟早漂，本仓库反复在治这个病）。
   *
   * `batch` 是唯一的例子：CLI 侧用管道喂 NDJSON，而 MCP 没有管道，
   * 于是生成工具表时补一个 `records` 数组入参、由 handler 拼成 NDJSON 写进子进程 stdin。
   * 没有这一条时，MCP 的工具表里挂着一个"批量工具"，而它一次都送不进内容
   * （实测：`invokeCli` 的 `stdio[0]` 是 `'ignore'`，子进程 stdin 直接 EOF，
   * 调它只能回「stdin 为空」或格式说明）。
   */
  stdin?: 'ndjson'
  run: (ctx: CliContext, flags: Flags, positional: string[]) => unknown | Promise<unknown>
}

/**
 * 从 stdin 读取全部内容
 *
 * 用同步 readSync 直接读 fd 0，而不是监听 'data'/'end' 事件：
 * 实测在 Electron 下管道关闭时 'end' 未必可靠触发，会读到空内容
 * （表现为 batch 永远报"stdin 为空"）。同步读是 CLI 工具的常规做法。
 *
 * 无管道输入时直接报错，绝不让进程挂住等输入。
 */
export function readStdin(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')

  if (process.stdin.isTTY) {
    throw new UsageError('batch 需要从 stdin 读取 NDJSON，请用管道传入，例如 deskpartner batch < cmds.ndjson')
  }

  const chunks: Buffer[] = []
  const buf = Buffer.alloc(65536)
  let idle = 0

  for (;;) {
    let n = 0
    try {
      n = fs.readSync(0, buf, 0, buf.length, null)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EAGAIN') {
        // 管道暂时没数据；空转几轮后再放弃，避免死循环
        if (++idle > 200) break
        continue
      }
      if (code === 'EOF') break
      throw err
    }
    if (n === 0) break
    idle = 0
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }

  return Buffer.concat(chunks).toString('utf8')
}

/** 用法错误（退出码 2） */
export { UsageError } from '../lib/domain-errors'
/** 目标不存在（退出码 3） */
export { NotFoundError } from '../lib/domain-errors'
/**
 * 守卫拒绝（退出码 4）—— 候选池 G1/G2/G4/G6 等业务规则拦下的操作。
 *
 * Bob反馈：守卫拒绝和"目标不存在"同落 exit 1，agent 无法按码分流
 * （是 id 写错了该重试，还是规则不允许该死心，行为完全不同）。
 * 独立退出码 + 独立 errorCode 后，agent 见码即知因。
 */
export { GuardError } from '../lib/domain-errors'

/**
 * 把 SQL 层的错误翻译成人话
 *
 * SQLite 的原话（`FOREIGN KEY constraint failed`、`UNIQUE constraint failed: todos.id`）
 * 是给写这条 SQL 的人看的，不是给用命令的人看的：既不说哪个字段出错，也不说该怎么改。
 * 它一旦穿透到 stdout，agent 拿到的是一条既无法自愈也无法分类的消息。
 *
 * 这里做兜底：认得出就翻译成 actionable 的中文，认不出原样保留
 * （宁可让用户看到技术细节，也不要用一句含糊的话把真错误盖掉）。
 */
function translateDbError(raw: string): string {
  if (raw.includes('FOREIGN KEY constraint failed')) {
    return (
      '引用了不存在的对象（外键约束失败）：多半是某个 id 类参数传了不存在的值，' +
      '或要删除的东西还被别处引用着。用对应的 list 命令先查准确认。' +
      `（原始信息：${raw}）`
    )
  }
  if (raw.includes('UNIQUE constraint failed')) {
    return `这条已经存在了（唯一约束冲突${raw.includes('todos.id') ? '：id 重复' : ''}），不要重复创建。（原始信息：${raw}）`
  }
  if (raw.includes('NOT NULL constraint failed')) {
    return `必填字段缺失（${raw}）。对照 help 里的参数清单看漏了哪个。（原始信息：${raw}）`
  }
  if (raw.includes('SQLITE_BUSY') || raw.includes('database is locked')) {
    return '另一个 DeskPartner 进程正占着任务库，稍后重试。（原始信息：' + raw + '）'
  }
  return raw
}

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 3,
  /** 守卫拒绝：G1/G2/G4 等候选池规则（非用法错误，重试无用） */
  guard: 4,
  /**
   * 乐观锁冲突（1.0.73，`9947bf5a`）：你要改的这条，在你读到它之后被别人改过。
   *
   * ⚠️ **它必须独立于 1（一般错误）**：两者的正确反应完全不同 ——
   * 拿到 1 的 agent 会盲重试，而盲重试每次都会撞同一个冲突，
   * 还会把别人刚改的内容再盖一遍（正是本机制要防的事）。
   * 拿到 5 的正确动作是**重读、再决定**，不是重试同一条命令。
   */
  conflict: 5
} as const

/** 时间解析：ISO 8601 + 少量简写，刻意不做完整自然语言解析 */
export function parseTime(input: string): string | null {
  const s = input.trim()
  if (!s) return null

  const now = dayjs()
  const lower = s.toLowerCase()
  // today/tomorrow 语义是"那天 18:00"，毫秒一并清零（Bob反馈：18:00:00.506Z 带随机毫秒）
  if (lower === 'today') return now.hour(18).minute(0).second(0).millisecond(0).toISOString()
  if (lower === 'tomorrow') {
    return now
      .add(1, 'day')
      .hour(18)
      .minute(0)
      .second(0)
      .millisecond(0)
      .toISOString()
  }

  const rel = /^\+(\d+)([dh])$/.exec(lower)
  if (rel) {
    const n = Number(rel[1])
    const base = rel[2] === 'd' ? now.add(n, 'day') : now.add(n, 'hour')
    // 相对小时保留时刻感，只清毫秒；相对天数按 18:00 约定
    return (rel[2] === 'd'
      ? base.hour(18).minute(0).second(0).millisecond(0)
      : base.millisecond(0)
    ).toISOString()
  }

  // MM-DD HH:mm / YYYY-MM-DD HH:mm
  const short = /^(\d{4}-)?(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s)
  if (short) {
    const year = short[1] ? Number(short[1].slice(0, 4)) : now.year()
    const d = dayjs()
      .year(year)
      .month(Number(short[2]) - 1)
      .date(Number(short[3]))
      .hour(short[4] ? Number(short[4]) : 18)
      .minute(short[5] ? Number(short[5]) : 0)
      .second(0)
    return d.isValid() ? d.toISOString() : null
  }

  const d = dayjs(s)
  return d.isValid() ? d.toISOString() : null
}

/**
 * R2-3：agent 可改的界面参数白名单
 *
 * 收录判据只有一条 —— **纯视觉**：改坏了人一眼能看出来，且下一次界面渲染就生效，
 * 不需要任何系统服务配合，也不碰数据。
 *
 * 刻意不开放的（不是漏做，是拒绝）：
 * - `autoStart` / `globalShortcut`：系统级（开机自启、全局快捷键），改完要注册服务才生效，
 *   无头 CLI 模式下根本执行不了，会让 agent 以为改成功了其实没改。
 * - `telemetryEnabled`：隐私开关。让 agent 能关掉对自己行为的记录，这个口子不能开。
 * - `kanbanAlwaysOnTop` / `kanbanWindowBounds` / `floatBallPosition`：窗口行为与坐标，
 *   会直接干扰人正在做的事 —— 界面怎么摆是人的地盘。
 * - `customColors`：嵌套对象，改错一处很难定位，先不放开。
 */

export interface Outcome {
  ok: boolean
  data?: unknown
  code?: number
  errorCode?: string
  message?: string
  /** 命令声明的输出形态，供上层决定怎么打印 */
  output?: CommandSpec['output']
  /**
   * 非致命提醒（G3）：命令成功了，但有 agent 该知道的事。
   * JSON 信封里原样带出；agent 应把它转述给用户或记入自己的上下文。
   */
  notice?: string
  /**
   * 列表类命令的计数摘要（1.0.63）—— `{ total, matched, truncated, byStatus }`。
   *
   * 为什么单开一个顶层键、而不是把计数塞进 `data`：
   * `data` 是数组时**必须继续是数组**。改成 `{items:[...], total:N}` 会让所有
   * 按数组解析的调用方（脚本 `for row in data`、宿主按 list 取值）静默拿到
   * 一个对象 —— 不报错，但遍历为空，比报错更难查。计数是"关于这个数组的元信息"，
   * 放顶层才是它的位置。老调用方不看 `meta` 也不受影响。
   */
  meta?: Record<string, unknown>
  /**
   * batch 全败时「第一条失败」的摘要（1.0.72 修 `10fcb47f` D2）：`{ code, message }`。
   *
   * 给只看顶层的调用方一个不必下钻 data.results 的分流入口：
   * "这批失败了"看 errorCode（batch_all_failed），"第一条为什么"看这里。
   *
   * ⚠️ output.ts 的失败信封必须把它序列化出去（1.0.73 修 `51958ed9`）——
   * 此前只在 executeOne 的返回里有，失败信封只序列化 ok/code/message/data，
   * 三处文档（docs/RELEASES.md、README、commands.ts 注释）承诺的字段实际拿不到。
   */
  firstFailure?: { code: string; message: string }
}

/**
 * 解析参数
 *
 * specs 用来识别布尔标志：布尔标志**不能**吞掉后一个 token，
 * 否则 `todo rm --yes <id>` 会把 id 当成 --yes 的值，
 * 结果既丢了位置参数、又让布尔判断失真（只有写成 `<id> --yes` 才碰巧能用）。
 */
export function parseFlags(args: string[], specs: ArgSpec[] = []) {
  const flags: Flags = {}
  const positional: string[] = []
  const boolFlags = new Set(specs.filter((s) => s.type === 'boolean').map((s) => s.flag))
  /**
   * 本命令"认识"的 flag：声明过的 + 全局的。
   *
   * 判断后一个 token 是不是值，用它而不是"是否以 -- 开头"——
   * Bob 21bd6f34：agent 报缺陷时标题里带 `--xxx` 是常态，
   * 老规则（下一个 token 以 -- 开头就当 flag）会把 `--title "--help 未注册"`
   * 落成 title=true（静默改值、不报错），落库后标题变成字符串 "true"。
   * 新规则：**只有下一个 token 是本命令认识的 flag 时才不当值**；
   * 形如 "--help 未注册" 这种长得像 flag 但并不是的，一律当值。
   */
  const knownFlags = new Set([...specs.map((s) => s.flag), ...GLOBAL_FLAGS])
  /**
   * 可重复的 flag（`repeat: true`）：同一个 flag 出现多次要**攒成数组**，
   * 而不是后者覆盖前者。
   *
   * 覆盖式赋值在这里是静默丢数据：`--highlight A --highlight B` 只会留下 B，
   * 而调用方以为两条都记上了 —— 与 `todo update` 那种"最后一次生效"的语义不同，
   * 这里多条是**并列的内容**，不是同一个设置项的连续修改。
   *
   * 收集在 `repeated` 里、末尾统一回写到 `flags`，是为了让 run 函数
   * **只从 `flags` 取值**（一个出口）—— 多一个来源就多一处会被漏改的地方。
   */
  const repeatFlags = new Set(specs.filter((s) => s.repeat).map((s) => s.flag))
  const repeated: Record<string, string[]> = {}

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    // -h 是唯一的短 flag；其余短横线开头的（如负数、日期 -1d）都按位置参数走
    if (a.startsWith('--') || a === '-h') {
      const eq = a.indexOf('=')
      if (eq > -1) {
        const key = a.slice(0, eq)
        const raw = a.slice(eq + 1)
        if (repeatFlags.has(key)) repeated[key] = [...(repeated[key] ?? []), raw]
        else flags[key] = boolFlags.has(key) ? raw !== 'false' : raw
      } else if (boolFlags.has(a)) {
        flags[a] = true
      } else if (repeatFlags.has(a)) {
        /**
         * 可重复 flag 的取值必须与单值同路：`--highlight A` 里 A 是值，
         * 不是"下一个 flag"。再往下走一个 token，把它收进 `repeated`。
         */
        if (args[i + 1] !== undefined && !knownFlags.has(args[i + 1])) {
          repeated[a] = [...(repeated[a] ?? []), args[i + 1]]
          i++
        } else {
          // `--highlight` 后面没有值：留一条空串，交给命令层按"空要点"报 usage
          repeated[a] = [...(repeated[a] ?? []), '']
        }
      } else if (args[i + 1] !== undefined && !knownFlags.has(args[i + 1])) {
        /**
         * 这里判 `!== undefined` 而不是判真值 —— 空串是合法参数值。
         *
         * `todo update <id> --desc ""` 是"清空描述"的标准写法，
         * 判真值会让空串落进 else 变成布尔 true，清空的语义就丢了。
         */
        flags[a] = args[i + 1]
        i++
      } else {
        flags[a] = true
      }
    } else {
      positional.push(a)
    }
  }
  // 末尾把攒好的数组回写到 `flags` —— run 函数只从一个地方取值
  for (const [k, v] of Object.entries(repeated)) flags[k] = v
  /**
   * 多值 flag 的规整（1.0.63）：去空白、去空项、去重，再以逗号回写。
   *
   * 放在这里而不是让 run 函数各自 split：拿到 `--status "todo, ,todo, done"` 这种
   * 调用方随手写出来的东西时，归一化只该有一处判据。规整成规范串后，
   * enum 逐值校验（executeOne 里）与 run 里的一致性比较都能直接依赖它。
   */
  for (const spec of specs) {
    if (!spec.multi) continue
    const val = flags[spec.flag]
    if (typeof val !== 'string') continue
    const parts = Array.from(new Set(val.split(',').map((s) => s.trim()).filter(Boolean)))
    flags[spec.flag] = parts.join(',')
  }
  return { flags, positional, repeated }
}
