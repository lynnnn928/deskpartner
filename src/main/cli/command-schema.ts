/**
 * `schema` 的渲染（拆分卡 bbeb1b51，纯搬移）
 *
 * 由命令表生成 schema —— **不维护第二份手工文档**。
 */

import { GATES } from './gates'
import { ERROR_CODES } from './error-codes'

import { PRIORITIES, STATUSES, TYPES } from './command-text'
import { riskOf } from './command-core'
import { commands } from './command-table'

/** 由命令定义生成 schema —— 不维护第二份手工文档 */
export function buildSchema() {
  return {
    cli: 'deskpartner',
    alias: ['dp'],
    output: {
      rule: 'stdout 非 TTY 时输出 JSON；人在终端直接调用时输出可读文本',
      success: { ok: true, data: '<结果>' },
      failure: { ok: false, code: '<错误码>', message: '<说明>' },
      /**
       * `data` 的形状（1.0.110，收 `07a244d9`）—— **逐条命令不同**，所以答案在
       * `commands[].dataShape` 里，不在这句总则里。
       *
       * 为什么总则不能给一个答案：说明书的"data 始终是数组"只对 list 类成立，
       * 而单条 / 聚合类是对象 —— 一句话概括不了，硬概括就是在制造"文档这么教、
       * 实现那么做"。**能机读的那一份（`dataShape`）才是判据。**
       */
      data: {
        where: '成功响应（ok:true）的 data 键',
        shape: '数组或对象，逐条命令不同 —— 见 commands[].dataShape（取 array / object）',
        coverage: "只对信封类命令存在；output 为 'text'（skill）或 'ndjson'（telemetry export）的命令没有信封 data，形状由 output 回答",
        rule: 'list / search / proposals 类回数组（计数在 meta 里而不是 data 里 —— 老脚本按数组解析不受影响）；单条与聚合类回对象'
      },
      /**
       * notice：命令成功、但有 agent 该知道的事（G3 / G5 两道软闸门走这里）
       *
       * Bob实测（47494248）：提醒真的会发，位置是 stdout JSON 的**顶层键**，
       * 但 schema 里 notice 出现 0 次 —— 按契约写解析的 agent 只取 data，
       * 提醒永远看不见，两道软闸门对它等于不存在。而它们恰好是唯一管住
       * "随意宣布完成"的机制。契约里没有的字段，等于没有。
       */
      notice: {
        where: '成功响应（ok:true）的顶层可选键，失败响应里不会出现',
        when: [
          '把事项转进 awaiting_review，但既没写描述也没留评论（G3）',
          '把事项标为 done，但描述与评论里都没有带四段标记的收口结论（G5）',
          '整体替换描述且长度骤降到 30% 以下（1.0.49）'
        ],
        mustDo: '收到就原样回显给用户（或写进你自己的上下文），不要丢掉 —— 它是软提醒，不拦截但要求你说明',
        example:
          '提醒：把它标为已完成，请留下带结构性要素的收口结论（G5）—— ' +
          '最省事的是 `todo close <id> --did … --verified … --pass-criteria …`，' +
          '手写则至少带一个四段标记（如 `【做了什么】…`）'
      }
    },
    exitCodes: {
      0: '成功',
      1: '一般错误（数据层异常等非分类错误）',
      2: '用法错误（参数缺失 / 枚举非法 / 时间无法解析）',
      3: '目标不存在（id 或名字没找到）',
      4: '守卫拒绝（见下方 gates；重试无用，需等用户操作或改用合法路径）',
      /**
       * 5 = 乐观锁冲突（1.0.73，`9947bf5a`）
       *
       * 与 1 分开的理由：**对它的正确反应与"一般错误"完全不同。**
       * 拿到 1 会盲重试，而重试每次都会撞同一个冲突、
       * 还会把别人刚改的内容再盖一遍 —— 那正是这套机制要防的事。
       * 拿到 5 该做的是**重读、看别人改了什么、再决定**。
       */
      5: '冲突（你要改的这条在你读到之后被别人改过；什么都没写入。请重读而不是重试）'
    },
    /**
     * 守卫清单（1.0.72 修 `917390e0` 的 #5 / #6，qwen 驳回）
     *
     * 此前关口只存在于说明书那张 Markdown 表里 —— qwen 实测在 schema 全文搜
     * G10 得到 0 次。而 agent 唯一会主动读的就是 schema，文档它不会去找。
     * 于是"有哪些关口、触发后怎么办"对机器不可见，agent 只能撞一次错一次。
     *
     * ⚠️ 这里**不手写第二遍**：`GATES` 是唯一定义处（`src/main/cli/gates.ts`），
     * 说明书那节也从它渲染。手写的那份已经与实装相反过一次（G10 的"必须人点头"
     * 早已在 1.0.67 改成"验收者 ≠ 执行者"），而 markdown 表格不会报错。
     *
     * 字段设计取舍：
     * - `enforcement` 用 block/authorize/notice 三值枚举 —— 调用方最需要判断的是
     *   "撞了之后该重试吗"，这三者答案分别是"不"、"不（已自动发起申请）"、"要"。
     * - `exitCode: 0` 的软提醒也列出来，否则调用方会以为"没拦就是没这回事"。
     */
    gates: GATES,
    /**
     * 错误码清单（1.0.73，续做 `3c522bdb` 第 2 点）
     *
     * 与 `gates` 同源的病：`errorCode` 是调用方唯一能可靠分流的信号
     * （退出码只有 0~5 六档，而"守卫拒绝"底下有七八种含义完全不同的事），
     * 但它此前**只以字符串字面量散在本文件各处**，schema 里一个都没有 ——
     * agent 拿到 `identity_pending` 时只能按字面猜是"等批准"还是"去注册"。
     *
     * ⚠️ 同样**不手写第二遍**：`ERROR_CODES` 是唯一定义处
     * （`src/main/cli/error-codes.ts`）。代码里用了却不在清单里的，
     * 由 `tests/main/cli/error-codes-single-source.test.ts` 的源码扫描拦下。
     */
    errorCodes: ERROR_CODES,
    enums: {
      status: STATUSES,
      priority: PRIORITIES,
      type: TYPES
    },
    timeFormats: [
      'ISO 8601（2026-09-20T18:00:00+08:00）',
      'today / tomorrow',
      '+3d / +2h',
      'MM-DD HH:mm / YYYY-MM-DD HH:mm（时分省略则按 18:00）'
    ],
    onboarding: ['deskpartner schema', 'deskpartner doctor', 'deskpartner todo list'],
    /**
     * 面向 AI agent 的指引
     *
     * 放在 schema 里而不是另外写文档：agent 唯一会主动读的就是 schema，
     * 文档它不会去找。"agent 不知道什么时候该用"是这套 CLI 最容易失效的地方 ——
     * 能力做得再全，它想不到用就等于没有。
     */
    agentGuide: {
      whenToUse: [
        '用户明确要求记录、添加、查看、完成或删除待办时',
        '用户说"帮我记一下 …""加个待办""我还有什么没做"这类话时',
        '你完成了一件有意义的事之后 —— 这是共享工作台，不只是用户的待办列表，',
        '也是 agent 的工作交接面。做完的事也要记，否则就丢掉了"一件事怎么被完成"的全貌'
      ],
      whenNotToUse: [
        '不要记录过程性动作（读了文件、搜了资料、跑了测试）—— 那些是手段不是事情；' +
          '判断标准是"这件事单独说给别人听，有意义吗"',
        '不要凭猜测删除或修改 —— 这类操作先跟用户确认'
      ],
      rules: [
        '调用前先跑 `schema` 拿最新接口，不要凭记忆写参数',
        '删除必须带 --yes；不带会被拒绝（退出码 2）',
        '一次要写多条时用 batch（NDJSON 走 stdin），比循环调用快很多',
        '--title 写清做了什么、一行能看懂；--desc 放为什么做、结论、坑',
        '不要把整段对话粘进 --title',
        /**
         * 这条是被真实教训换来的：记错了就删掉重建，看起来干净，
         * 但新 id 会让项目、父需求、子任务的引用全部落空。
         * agent 又特别容易走"删了重建"这条路，因为它手边没有界面可点。
         */
        '记错了用 `todo update` 改，不要删了重建 —— 重建会换 id，' +
          '已挂在这条上的项目/父需求/子任务引用会全部断掉',
        /**
         * done 语义（统一口径，此前 SKILL/schema/examples 三处打架，Bob实测指出）：
         * 两个合法场景，一个禁止场景。
         */
        'done 的边界：你**自己登记并已做完**的事可以置 done（todo add --status done 或 todo done <id>），' +
          '这是记工作流水；用户创建的执行事项、以及父需求，**不要自行置 done** —— ' +
          '完成与否由用户或验收流程决定',
        /**
         * 版本归属（v24）：「这一版解决了哪些问题」靠它回答，不靠口头汇报。
         * 发版是你的动作，所以标版本也该由你做 —— 不标的话，
         * 用户只能靠翻 README 或问你，而两者都不是可靠来源。
         */
        '发版收口时，把这一版修好的事项标上版本：todo update <id> --fixed-in 1.0.59；' +
          '之后 `todo list --fixed-in 1.0.59` 就是这一版的改动清单。' +
          '标版本**不改变状态**（done 仍需验收），它只是把"这条属于哪一次发布"记下来。' +
          '发版前核对还有哪些没标：todo list --fixed-in unset'
      ],
      candidatePool: {
        concept:
          '看板上有两列缓冲：「待确认」(proposed) 和「待验收」(awaiting_review)。' +
          '它们是人机之间的确认关口：agent 不能自行把事项放进已确认的执行流，' +
          '**也不能验收自己做的活**（运动员不当裁判，1.0.67 起按角色定权）。',
        rule: [
          '你建议用户做某件事、但用户还没点头时：todo add --status proposed，让它在「待确认」列等人拍板',
          '「待确认」里的事项：放行只能由人在界面上做（G4 硬拦）；' +
          '**提议人可以撤回或降级自己提的那条**（1.0.68 放开），但不能替别人拍板',
          '父需求下的子任务全部做完后：todo update <父需求id> --status awaiting_review，放进「待验收」列请人验收；描述里写清做了什么、结论、坑',
          '验收通过转 done：**验收者（≠ 执行者）可以直接做**（1.0.67 起按角色定权，G10 只拦"执行者验收自己"）；' +
          'agent 不得把**自己执行**的父需求置为 done',
          '父需求还在「待确认」时不能创建子任务（G1 硬拦）；先等用户确认'
        ]
      },
      /**
       * 探针与验证：绝不在用户的真实看板里造数据（1.0.65 补，主用户 10-05 决策「采纳A」）
       *
       * 🚨 **为什么这一节必须写在说明书里，而不是只写在实现里**：
       * 隔离设施早就有了（`DESKPARTNER_DATA_DIR` + `scripts/lib/isolated-app.mjs`），
       * 但 10-05 实测发现：**外部 agent 不知道它存在** ——
       * Carol（agent:bob / agent:carol）在真实库里删自己的探针，
       * 库里的 `todo_deleted` 事件最近一次是当天 04:24，actor 是 `agent:bob`。
       * 对照：我的 destructive 授权最近一条是 **09-30**（A 方案对我完全生效）。
       *
       * **判据：能力存在 ≠ 对方知道它存在。** 说明书是 agent 唯一的入口，
       * 没写在这里的能力，对外部 agent 等于不存在。
       * （这也是本文件头的原则：这份内容是唯一真相，补充都改这里。）
       */
      sandbox: {
        concept:
          '看板是**用户的真实工作面**，不是你的试验田。' +
          '造探针、验证、演练一律在一次性副本上做 —— 跑完把整个目录扔掉，' +
          '不需要向用户申请任何删除授权。',
        rule: [
          /**
           * 关键：副本是**整个数据目录**，不是"另一条记录"。
           * 逐条 `todo rm` 清理是错的做法 —— 删掉的每一条都要一次性删除授权
           * （destructive 档，用掉即止），实测累计 86 条、其中 15 条过期未处理，
           * 而它们删掉的只是几分钟前自己造的探针。
           */
          '验证/探针：把 `DESKPARTNER_DATA_DIR` 指向一次性目录，' +
            '并配 `DESKPARTNER_NO_PIPE=1`（否则会连上用户正在跑的实例、写进真实库），' +
            '跑完把**整个目录**一起删 —— 删目录不需要任何授权',

          '只读操作（list / doctor / get）不需要隔离：它们本来就不写',

          /**
           * 真的需要在真实库上验证写入时，**用 proposed 而不是 todo**：
           * 进「待确认」列等人看一眼，比"造完自己删"干净得多。
           */
          '要在真实库上写点东西观察效果：用 `--status proposed`，让用户自己决定去留',

          '[!] **别用标题正则去生产库里捞探针删**（如 `__CLI_TEST_` / `__DBG_` / `【e2e】`）。' +
            '那意味着探针一开始就写进了用户的看板 —— ' +
            '他会在自己的待办里看到 `__e2e__xxx` 这种东西，而删除还要另要一次授权',

          '探针前缀（`__CLI_TEST_` / `__DBG_` / `【e2e】`）只允许出现在一次性副本里。' +
            '如果你在用户的真实看板上看到了自己的探针残留，那是我的失误，请直接告诉我'
        ]
      },
      ownership: {
        rule: [
          '登记你自己做的事时，**不必再手动传 `--created-by`**（1.0.73 起）：你持 agent 身份调用，提出者默认取你的身份',
          '执行者默认即提出者（提出即执行）；"agent 报 bug 给用户修"这类场景才显式传 --executed-by',
          '不带身份调用（人自己在终端敲）提出者仍是 human —— 那才是"用户自己提的待办"',
          '要**代录**别人的事项（如代用户记一条）才显式传 --created-by（`human` 不受限）；--owner 是旧参数名，等价',
          '[!] **声明了身份时不许填别的 agent**：`--created-by agent:别人` 会报 usage_error —— ' +
            '那是冒名（动作人、动态、提出人整条链会一起记错）。要把活派出去请用 --executed-by',
          '查询时 --created-by human 只看用户提出的，--created-by agent 看所有 agent 的'
        ],
        boundary:
          '这是归属标注，不是身份认证 —— 本机任何进程都能自称某个 agent。' +
          '它解决"这条是谁提的、该给谁看"；' +
          '"声明了身份却又填别人"这种自相矛盾会被拦下，但**换一份凭据自称**仍拦不住' +
          '（那要 harness 从外部注入身份，在 DeskPartner 之外）。'
      },
      storyLayer: {
        concept:
          '分类（category）就是 story 层：一个方向 / 一个议题；' +
          '待办（todo）是它下面的具体执行。两层用一个外键关联，任务本身是扁平的。',
        rule: [
          '一个对话里发散了几个方向，就建几个分类，别把不同方向的事堆在同一层',
          '用 `category add --name "竞争调研"` 建方向，再用 --category 把待办挂上去',
          '查某个方向做了哪些事：todo list --category "竞争调研"'
        ]
      },
      examples: [
        'category add --name "竞争调研"',
        'todo add --title "给张总回邮件" --created-by agent:alice --priority high --due tomorrow',
        // 候选池：提议一件事，等人确认
        'todo add --title "调研 TAPD 迁移方案" --created-by agent:alice --status proposed',
        'todo update <id> --status todo   // 用户认可后转正',
        'todo add --title "..." --created-by agent:alice --status done',
        // 报 bug 给用户修：提出者是 agent、执行者是用户
        'todo add --title "导出按钮无响应" --created-by agent:alice --executed-by human --type bug --status proposed',
        'todo list --status todo --created-by human --limit 20',
        // 1.0.63：默认只回未完成的；要全量显式 --status any
        'todo list --status any --limit 50',
        'todo list --status todo,in_progress',
        'todo list --executed-by agent:alice',
        'todo list --updated-since 2026-09-30 --sort updated',
        'todo list --type bug',
        'todo list --category "竞争调研"',
        // 版本归属（v24）：发版收口时标版本，之后按版本筛就是改动清单
        'todo update <id> --fixed-in 1.0.59',
        'todo list --fixed-in 1.0.59',
        'todo list --fixed-in unset',
        'todo done <id>',
        // 状态回退：从 done 改回来，这是唯一的出口
        'todo update <id> --status todo',
        'todo update <id> --title "新标题" --priority high',
        'todo update <id> --due clear'
      ]
    },
    /**
     * 风险档位（1.0.36）
     *
     * 写进 schema 而不是只写在门禁里：**每档要什么手续，agent 应该开工前就知道**。
     * 否则它只能先撞一次墙（退出码 4 + grant_required）才明白自己缺什么。
     */
    riskTiers: {
      read: '查询，免批 —— 不需要身份也能调用',
      write:
        '改待办数据，需要"已批准 + 有效凭据"，批准一次长期有效' +
        '（**能执行别的命令的入口也按这一档算**，如 `batch` —— 它能执行写命令，' +
        '所以不因"这一行长什么样"而免批）',
      config: '改界面（ui set / ui reset），需要单独授权，**仅本次会话有效**',
      destructive:
        '删除（todo rm / memo rm / project rm / category rm / telemetry clear），需要单独授权，**一次性，用掉即止**。' +
        '另有两条**按目标升级**到这一档：`todo delete-comment` 删别人写的评论、`category merge` 的源分类下还有待办',
      howToGetHigherTier:
        '被拒时会自动生成一条授权申请（errorCode=grant_required，data 里有申请 id）；' +
        '请提醒用户在 主窗口 → 审批页 → 等你点头 里点「允许」。' +
        '[!] **用户一点允许，服务端会立刻执行这件事，不需要你再重试** —— ' +
        '重复执行只会撞上"授权已被消费"。也可以用 `agent whoami` 提前自检各档状态。'
    },
    commands: commands.map((c) => ({
      name: c.name,
      desc: c.desc,
      risk: riskOf(c),
      /**
       * 输出形态（1.0.107，修 `f99178d7`）—— 命令表里早就声明了（`CommandSpec.output`）、
       * `Outcome` 也带出来了，却**没进 schema**。看不到它的调用方只能猜：
       * MCP 层就按"凡输出皆 JSON 信封"处理，于是 `skill`（Markdown）与
       * `telemetry export`（NDJSON）一调就 `bad_output`。
       *
       * 判据：**声明了却没有出口，等于没声明。** 这里把它带出去，
       * 让 MCP 侧按它选"信封解析 / 逐行解析 / 原样透传"，不再维护第二份名单。
       */
      output: c.output ?? 'json',
      /**
       * 回执 `data` 的形状（1.0.110，收 `07a244d9`）—— 与 `output` 同理：
       * 命令表声明过了就得带出去（"声明了却没有出口，等于没声明"）。
       *
       * 只出现在**信封类**命令上：`output` 为 `text` / `ndjson` 的命令没有信封 `data`，
       * 形状由 `output` 回答，这里再给一次就是同一个事实两处声明。
       * 闸门：`tests/main/cli/receipt-contract-self-report.test.ts`
       * （漏声明要红、多声明也要红、真跑一遍还要与声明一致）。
       */
      ...(c.dataShape ? { dataShape: c.dataShape } : {}),
      /**
       * 默认口径（1.0.110，收 `516a74d4`）—— 不传参数时默认回多少条、默认带不带描述。
       *
       * 只给**真有默认**的命令：绝大多数命令没有条数上界，给每条都补一个 `null`
       * 只是噪音（同 `stdin` 的处理）。取值来自命令自己用的常量，这里不另写数字。
       *
       * ⚠️ 这是 **CLI 直连**的默认；MCP 侧按通道政策另兜一个（`DEFAULT_ROW_LIMIT`，50），
       * 两条路各说各的没有错 —— 谁在跑，以回执里的实际值为准。
       */
      ...(c.defaults ? { defaults: c.defaults } : {}),
      /**
       * 「这个命令从 stdin 读记录」（1.0.107，修 `0a9f42f8`）—— 与 `output` 同理：
       * 命令表声明过了，schema 就得带出去，否则通道只能猜（MCP 侧此前连猜都没得猜，
       * 它的工具一次也送不进记录）。
       * 只有声明的命令才带这个键：绝大多数命令没有 stdin，不必给每条都加一个 null。
       */
      ...(c.stdin ? { stdin: c.stdin } : {}),
      /**
       * 只读标记（1.0.65 修 `1e525804`）—— 与 `risk` 同源派生。
       *
       * 此前 schema 只给 `risk`、help/用法只给 `readOnly`，两处口径不一致：
       * 调用方想自动挑出"可以自由调用、不用申请授权"的工具集时，
       * 只能自己写 `risk === 'read'` 的翻译，而漏一处就静默错一批。
       *
       * ⚠️ 两份字段**必须都从 `riskOf(c)` 推**，不能一处读 `cmd.readOnly`、
       * 一处读 `cmd.risk`：那等于把本卡要消灭的"两处口径"又造回来，
       * 而且它只在某条命令漏标 `readOnly` 时才发作 —— 平时看不出来。
       * 真值只有门禁用的那一份，派生值必须指向它。
       */
      readOnly: riskOf(c) === 'read',
      positional: c.positional ?? null,
      args: c.args
    }))
  }
}
