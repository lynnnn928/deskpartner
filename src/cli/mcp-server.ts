/**
 * MCP Server（通道 C，1.0.59，主用户拍板优先的 bf736527）
 *
 * 让任意 MCP 客户端（Claude Desktop / Codex / 任何支持 MCP 的 agent 宿主）
 * 原生读写看板，不必先学我们的私有 CLI 与 DESKPARTNER_* 约定。
 * 与 CLI 的关系是**并存的第二张皮**：同一批能力，两种暴露方式，
 * 不替换、不迁移 —— CLI 保留（人、脚本、我们自己都在用）。
 *
 * ── 为什么这个进程必须是纯 Node，而不是 DeskPartner.exe --mcp ──
 *
 * 实测（Windows，Electron 33）：主进程的 stdin 管道**数据不流动** ——
 * 写进去的字节永远等不到 'data' 事件、紧接着就是 'end'（探针实测）。
 * MCP 的 stdio transport 整个建立在读 stdin 上，此路不通。
 * 解法：本文件打成纯 Node bundle（out/cli/mcp.cjs），
 * 由 MCP 客户端经 mcp.cmd（设 ELECTRON_RUN_AS_NODE=1 借 DeskPartner.exe 当 node）
 * 或系统 node 启动 —— RunAsNode 模式下 stdin 完全正常（dp.cmd 同款机制）。
 *
 * ── 数据访问：每个工具 spawn 一次 deskpartner.cjs ──
 *
 * 工具只负责把结构化参数拼成 argv，然后交给同目录的启动器子进程执行。
 * 这带来两个结构性好处：
 * 1. **门禁/守卫零复制**：启动器 →（管道优先、无头兜底）→ executeOne，
 *    持证/批准/分级授权/G1-G8/审计/notice 与 CLI 调用走**完全同一条链**，
 *    不存在"换了入口就绕开判据"的第二套实现。
 * 2. **身份链路白嫖**：MCP 客户端在 env 里配 DESKPARTNER_AGENT=agent:<id>，
 *    启动器自动带上该身份的凭据（注册过之后零配置）——与 CLI 的零摩擦同源。
 *
 * 代价：GUI 没在跑时每次调用冷启动 Electron（秒级）。MCP 是交互频率低的场景，
 * 可接受；GUI 在跑时走常驻管道，毫秒级。
 *
 * ── 并发：工具调用串行排队 ──
 *
 * MCP 协议允许并发调用工具；并发 spawn 意味着多个进程同时写 SQLite。
 * busyTimeout 能兜住读，但"两条写互相等锁"白浪费时间且徒增排查面 ——
 * 这里用一条 Promise 队列把调用串行化，正确性优先，吞吐损失可忽略。
 *
 * ── 接入层（1.0.63，9fde5666 选①）──
 *
 * 1.0.59~1.0.62 这一层只有传输、没有接入：握手正常、7 个工具列得出来，
 * 但 initialize 无 instructions、工具无 annotations、写工具无身份入参、
 * 读默认无界（一次全库 45 万字符）、埋点与 CLI 混在一起。
 * 结果是"只有机器猜得到的通道"—— 现补齐下面四件事：
 *   - `MCP_INSTRUCTIONS`：把关口模型/身份/描述与评论的分工写进 initialize；
 *   - 工具 `annotations`：宿主据此区分读写、决定要不要弹确认；
 *   - 写工具 `actor` 入参 + add_todo 补 status/type/created_by：多凭据机器上
 *     写路径不再只剩"去改服务进程环境"这一条不可执行的路；
 *   - 读默认有界（brief + limit）、埋点带 `surface`、补 `create_project`。
 */
import { spawn } from 'node:child_process'
import {
  buildToolRoutes,
  DEFAULT_ROW_LIMIT,
  generateMcpTools,
  toArgv as schemaToArgv,
  RECORDS_PARAM,
  type OutputKind,
  type SchemaCommand
} from './mcp-tools-from-schema'
import path from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { GATES } from '../main/cli/gates'

// CJS bundle 里 import.meta.url 为空（esbuild 会警告），launcher 同款用 __dirname；
// 单测经 vitest 以 ESM 跑本模块（只为拿工具表），那里没有 __dirname，给个占位即可
const HERE = typeof __dirname !== 'undefined' ? __dirname : '.'
const LAUNCHER = path.join(HERE, 'deskpartner.cjs')
const CALL_TIMEOUT_MS = 120_000

/**
 * 读命令的默认条数上限（1.0.63）。
 *
 * 此前不带参数的一次 list_todos 返回 456,206 字符（全库 + 完整描述），
 * 宿主上下文会被直接撑满 —— 而绝大多数调用只想"看一眼还没做的"。
 * 默认有界，且**显式传 limit 仍然优先**（要看更多就自己传）。
 *
 * ⚠️ 数值与 `mcp-tools-from-schema.DEFAULT_ROW_LIMIT` **是同一个**（1.0.107，
 * 修 `7e321f6d` 时并成一份）："通道侧默认回多少条"只该有一个答案。
 * 留两个常量迟早会有两个不同的值，而那时哪份生效取决于命令是手工工具
 * 还是生成工具 —— 没人查得出来。
 */
const DEFAULT_LIMIT = DEFAULT_ROW_LIMIT

/**
 * initialize 的 instructions：MCP 读者拿到的唯一"说明书"。
 *
 * 宿主的模型在第一次握手时就会读到它，所以这里只放**它会立刻踩到的规矩**：
 * 身份怎么来、哪些状态它推不动、描述与评论怎么分工、清单默认口径。
 * 不放命令清单（工具 schema 自带描述），也不重复 CLI 的长文档。
 *
 * ── 1.0.73：关口那段改为**从 `GATES` 渲染**（续做 `3c522bdb`）──
 *
 * 此前这段是手写的，于是它成了"三份各说各话的真相"里的第二份
 * （`gates.ts` 文件头列的 ①②③）：加一道关口要改三处，实际经常只改一处。
 * 实测证据就在提单里 —— 1.0.65 新增的 G9/G10 在这一段里**一个字都没有**，
 * 而它们恰好是 agent 最容易撞上的两道。
 *
 * ⚠️ `GATES` 是纯数据模块（`src/main/cli/gates.ts`，零依赖），
 * esbuild 会把整个数组打进来 —— 不会牵连 Electron 或数据库层。
 */
export const MCP_INSTRUCTIONS = `DeskPartner 看板：人与多个 agent 共享的待办工作台（本地 SQLite，同一台机器）。
你通过下列工具读写它。几条必须知道的规矩：

【身份】写操作需要身份，读操作不需要。
- 首选：宿主的 MCP 配置里设 DESKPARTNER_AGENT=agent:<你的名字>（启动器自动带凭据）。
- 或：写工具传 actor（如 agent:alice）—— 不改服务进程环境也能指定这次调用是谁。
- 首次接入三步：agent register → agent credential → 人到界面「审批」页批准；
  用 agent whoami 自检（会逐档告诉你缺哪一级）。
- 多份凭据又不声明身份时，写命令一律 ambiguous_identity（只读不拦）。

【关口】六列（**传 status 用括号里的英文值**）：
  待确认 proposed → 待办 todo → 进行中 in_progress →（挂起 suspended）→ 待验收 awaiting_review → 已完成 done
${renderGatesBrief()}

【写什么】
- description 只放原始规格。进度、问答、收口结论一律走 comment_todo，别追进描述。
- 新建事项必须带 project（不存在会报错并列出现有项目 —— 先 create_project 或 list_projects）。

【读默认有界】list_todos 默认只回未完成（排除 done）、默认 brief、默认最多 ${DEFAULT_LIMIT} 条。
要全量传 status:"any"；要更多传 limit。列表里 description 只回前 80 字（descriptionTruncated=true 表示被截断）；单条全文、评论与流转用 get_todo。回执里的 notice 在顶层、清单计数在 meta（matched/returned/byStatus）。
非 json 输出同样默认有界：逐行导出类（export_telemetry）不传 limit 时默认最多 ${DEFAULT_ROW_LIMIT} 条
（batch 里的同一条命令也按这个默认跑；整批另有总量上界，超了回执带 truncated / skipped、剩余记录没执行）。
（CLI 直连不受这条限制，重定向成文件仍是全量）；要看更多就显式传 limit。get_guide 的说明书正文原样透传、不截断。

【接入后的读取顺序】先用 get_profile 认识主用户（不要推断缺失信息），再用 get_protocol 读取全局协作协议；进入项目后传 project 参数读取项目范围。随后用 get_project 读项目接手说明和状态计数（默认不给事项清单，要清单加 limit），search_project 找历史决定和评论，最后用 list_todos(status:"any", brief:true) 看完整事项范围。\n【申请与审批】新身份、写入授权及档案/协议/接手说明修改提议由主用户在 DeskPartner「审批」页处理。接手说明用 propose_handoff 提交，用 list_handoff_proposals 查询状态；update_handoff 仅供主用户直接保存。注册不等于已获写权限；提议批准前不生效。协议是可编辑约定，不能覆盖 schema.gates 的代码硬关口。`

/**
 * 从 `GATES` 渲染一段**紧凑的**关口摘要，给 MCP instructions 用。
 *
 * 为什么单独写一个渲染函数而不是复用 `renderGatesTable`：
 * 那个出的是给人读的 markdown 表格（含"该怎么做"整句），塞进 initialize
 * 会让握手报文长出一大截；而 MCP 读者需要的是"哪几道会硬拦、撞了怎么办"
 * 这两件事。**同一个数据源，两种详略** —— 关键是都从 `GATES` 来。
 *
 * 只列 `block` 与 `authorize`（会真的拦住你），软提醒在末尾一句带过。
 *
 * ⚠️ 状态名（`proposed` 等）必须写出来：MCP 调用方传的是**英文枚举值**，
 * 只给中文列名它就得自己猜"待确认"对应哪个字符串 —— 而那正是
 * `status` 参数最容易传错的地方。（这条是被既有测试逼出来的：
 * `mcp-server.test.ts` 断言 instructions 必须含 `proposed`。）
 */
function renderGatesBrief(): string {
  const hard = GATES.filter((g) => g.enforcement === 'block' || g.enforcement === 'authorize')
  const soft = GATES.filter((g) => g.enforcement === 'notice')
  const lines = ['会拦住你的（重试无用，必须换路径）：']
  for (const g of hard) {
    const signal = `退出码 ${g.exitCode}${g.errorCode ? ` / ${g.errorCode}` : ''}`
    lines.push(`- ${g.id}：${g.what}（${signal}）。${g.doThis}`)
  }
  lines.push(`软提醒（不拦，但要在回执顶层 notice 里看到并转达）：${soft.map((g) => g.id).join('/')}`)
  return lines.join('\n')
}

/** 一个 MCP 工具 = 一条 CLI 命令的映射声明 */
interface ToolMapping {
  name: string
  description: string
  input: Record<string, z.ZodTypeAny>
  /**
   * 工具注解（1.0.63）：宿主靠它区分"能不能重试/要不要弹确认"。
   * 全部工具都声明，缺省由宿主自己猜 —— 猜错的代价是写操作被当成读静默放行。
   */
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
  }
  /**
   * 这个工具是否接受 `actor` 入参（写工具才有；1.0.63 补）。
   *
   * `actor` **不进 argv** —— 它是"这次调用以谁的身份"，由 handler 落到子进程环境
   * `DESKPARTNER_AGENT`。为什么不做成 `--created-by`：两者语义不同
   * （actor = 谁在操作，created_by = 这条是谁提的），而且 comment 命令没有
   * `--created-by` 这个 flag。走环境变量三个写工具就统一了。
   */
  actor?: boolean
  /**
   * 这个工具的 stdout 形态（1.0.107，修 `f99178d7` / `a18681ae`）。
   *
   * 由**命令自己声明**（`schema.commands[].output`），MCP 侧据此选读法：
   * `json` 按信封解析、`ndjson` 逐行解析、`text` 原样透传。缺省按 `json`。
   */
  outputKind?: OutputKind
  /**
   * 这个工具要把 `RECORDS_PARAM` 里的记录写进命令的 stdin（1.0.107，修 `0a9f42f8`）。
   *
   * 由**命令自己声明**（`schema.commands[].stdin`）派生，与 `outputKind` 同源：
   * MCP 侧没有管道，不给这条路，工具表里就会挂着一个"批量工具"却一次也送不进内容。
   */
  stdinKind?: 'ndjson'
  /**
   * 逐行输出（`ndjson`）的工具在调用方没给条数时**兜上 `DEFAULT_ROW_LIMIT`** 的那个入参名
   * （1.0.107，修 `7e321f6d`）。
   *
   * 由**命令自己声明**（`schema.commands[].output` + 它的 `--limit`）派生，与 `outputKind` 同源：
   * 命令说"我逐行吐"，通道就得给宿主一个上界 —— 不给的话，回执多大由数据量决定，
   * 而数据量恰恰是调用方看不见的东西（实测一次无参 `export_telemetry` 回 459KB）。
   */
  defaultLimitKey?: string
  /**
   * 把校验过的参数拼成 CLI argv。
   * 只做机械拼接，**不做业务校验** —— 枚举、必填、存在性全部交给命令层，
   * 那里已有判据与错误文案，这里再写一份就是第二套判据（迟早漂移）。
   */
  toArgv: (p: Record<string, unknown>) => string[]
}

/** 有值才拼进 argv；undefined/null 一律不拼 */
function opt(argv: string[], flag: string, v: unknown): void {
  if (v === undefined || v === null) return
  argv.push(flag, String(v))
}

/** 只读工具注解：可安全重试、宿主不必弹确认 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
/** 写工具注解：会改数据（不销毁数据）、重复调用不保证等价 */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }

/** 工具表：只读为主 + 写 3 个 + 建项目 1 个（1.0.63 补 create_project）+ 接手说明修订 3 个（读 2 写 1，36b44adb） */
export const TOOLS: ToolMapping[] = [
  {
    name: 'list_todos',
    description:
      '查询待办（可按状态/优先级/类型/关键字/提出者/执行者/分类/项目/解决于版本过滤）。' +
      '**默认只回未完成的**（open 四列，排除 done/suspended/discarded）—— 要真全量传 status: "any"。' +
      'status 可逗号多值（如 "todo,in_progress"），也可用 "open"（旧名 "unfinished"）表达"未完成的并集"。' +
      'search 匹配标题或描述；created_by/executed_by 可传 human、agent 或完整 agent:<id>，' +
      'executed_by 还可传 "unset" 看没有显式指派的；' +
      'fixed_in 传版本号看该版收口了哪些，unset=未标注，any=已标注；' +
      'updated_since 看该时间之后被改动过的（ISO 或 YYYY-MM-DD）；' +
      '**要翻页就传 offset**（回执里的 nextOffset 是下一页的偏移），别靠放大 limit 看全貌；' +
      '**不传 project 就是跨项目（全机）查询** —— 回执 meta.projectScope 会说明这一页来自哪几个项目，' +
      '只看某一个项目就传 project',
    annotations: READ_ONLY,
    input: {
      status: z.string().optional().describe('单值/逗号多值/open（=unfinished，默认）/any（真全量）'),
      priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
      type: z.enum(['task', 'feature', 'bug']).optional(),
      search: z.string().optional().describe('关键字，匹配标题或描述'),
      created_by: z.string().optional().describe('human / agent / agent:<id>'),
      executed_by: z.string().optional().describe('human / agent / agent:<id> / unset'),
      category: z.string().optional().describe('分类名，可逗号多值'),
      project: z
        .string()
        .optional()
        .describe('项目名，可逗号多值；不传 = 全机（跨项目）查询，回执 meta.projectScope 会自报范围'),
      fixed_in: z.string().optional().describe('版本号（如 1.0.63）/ unset / any'),
      updated_since: z.string().optional().describe('该时间之后被改动过的（ISO 或 YYYY-MM-DD）'),
      limit: z.number().int().nonnegative().optional().describe(`条数上限（不传默认 ${DEFAULT_LIMIT}）；0 = 全量（不做条数收窄）`),
      /**
       * 分页偏移（1.0.107，修 `3675f993`）：CLI 侧 `todo list` 补了 `--offset`，
       * 通道这边必须一起给 —— 否则"继续读取"在 MCP 那条路上仍然做不到，
       * 而 `list_todos` 的说明本来就是照 CLI 的说明写的（两个出口是同一件事）。
       */
      offset: z.number().int().nonnegative().optional().describe('分页偏移（默认 0）；上一页回执里的 nextOffset 就是这一页该传的值'),
      brief: z
        .boolean()
        .optional()
        .describe(
          '省略描述，输出更短（不传默认就省略）。回执 meta.fields 会自报本次口径：' +
            'omitted（本条默认）或 preview —— CLI 直连默认是 preview，' +
            '所以两条通道的回执字节数不同，不是数据少了'
        )
    },
    toArgv: (p) => {
      const argv = ['todo', 'list']
      opt(argv, '--status', p.status)
      opt(argv, '--priority', p.priority)
      opt(argv, '--type', p.type)
      opt(argv, '--search', p.search)
      opt(argv, '--created-by', p.created_by)
      opt(argv, '--executed-by', p.executed_by)
      opt(argv, '--category', p.category)
      opt(argv, '--project', p.project)
      opt(argv, '--fixed-in', p.fixed_in)
      opt(argv, '--updated-since', p.updated_since)
      /**
       * 默认有界（1.0.63）：显式传的 limit 优先，否则兜一个 DEFAULT_LIMIT。
       * 与 brief 一样是**默认值不是硬上限** —— 调用方要看更多就自己传。
       */
      argv.push('--limit', String(typeof p.limit === 'number' ? p.limit : DEFAULT_LIMIT))
      // brief 同理：不传就当 true（列表默认只给"看一眼"够用的字段）
      /**
       * 分页偏移：**传了才拼**（不传就是 CLI 的默认 0）。
       * 与 `--limit`/`--brief` 的"兜底"不同 —— 0 自带"从头开始"的语义，
       * 没必要往每条调用里塞一个 `--offset 0`。
       */
      opt(argv, '--offset', p.offset)
      if (p.brief !== false) argv.push('--brief')
      return argv
    }
  },
  {
    name: 'get_todo',
    description: '读一条待办的完整详情：规格描述 + 评论线程 + 流转历史（含驳回理由）',
    annotations: READ_ONLY,
    input: { id: z.string().describe('待办 id，支持 8 位短号') },
    toArgv: (p) => ['todo', 'get', String(p.id)]
  },
  {
    name: 'list_projects',
    description: '列出现有项目（看板的顶层容器）。新建事项前用它确认项目名，或直接用 create_project 建',
    annotations: READ_ONLY,
    input: {},
    toArgv: () => ['project', 'list']
  },
  {
    name: 'get_project',
    description:
      '读取项目接手说明与状态计数（默认不返回事项清单，体积小）；传 limit 才给有界事项入口。返回 total/returned/truncated/nextOffset',
    annotations: READ_ONLY,
    input: {
      id: z.string().describe('项目 id、短 id 或完整名称'),
      limit: z.number().int().nonnegative().optional().describe('事项入口条数上限；0 = 全量（不做条数收窄）；不传则不返回事项清单'),
      offset: z.number().int().nonnegative().optional().describe('事项入口分页偏移（默认 0）')
    },
    toArgv: (p) => {
      const argv = ['project', 'get', String(p.id)]
      opt(argv, '--limit', p.limit)
      opt(argv, '--offset', p.offset)
      return argv
    }
  },
  {
    name: 'search_project',
    description:
      '在指定项目内有界搜索接手说明、事项标题/描述和评论正文；包括已完成、挂起、已废弃事项。命中在 data（数组）里，计数与翻页在顶层 meta（matched/returned/truncated/nextOffset）。% 与 _ 按普通字符处理',
    annotations: READ_ONLY,
    input: {
      id: z.string().describe('项目 id、短 id 或完整名称'),
      query: z.string().describe('非空普通关键词'),
      limit: z.number().int().nonnegative().optional().describe('返回条数上限（默认 20）；0 = 全量（不做条数收窄）'),
      offset: z.number().int().nonnegative().optional().describe('结果分页偏移（默认 0）')
    },
    toArgv: (p) => {
      const argv = ['project', 'search', String(p.id), `--query=${String(p.query)}`]
      opt(argv, '--limit', p.limit)
      opt(argv, '--offset', p.offset)
      return argv
    }
  },
  {
    name: 'list_handoff_revisions',
    description:
      '列出项目接手说明的修订历史（最新在前，最多保留最近 50 版；只有序号/作者/时间/种类/长度/首行摘要，不含全文）。' +
      '覆盖写错了想找回旧内容时先用它，再用 get_handoff_revision 取某一版全文',
    annotations: READ_ONLY,
    input: {
      id: z.string().describe('项目 id、短 id 或完整名称'),
      limit: z.number().int().nonnegative().optional().describe('最多几条（不传 = 全部）；0 = 全量（不做条数收窄）')
    },
    toArgv: (p) => {
      const argv = ['project', 'handoff-history', String(p.id)]
      opt(argv, '--limit', p.limit)
      return argv
    }
  },
  {
    name: 'get_handoff_revision',
    description: '读取接手说明某一版修订的全文',
    annotations: READ_ONLY,
    input: {
      id: z.string().describe('项目 id、短 id 或完整名称'),
      revision: z.string().describe('修订序号（如 "3"）或修订 id / id 前缀')
    },
    toArgv: (p) => ['project', 'handoff-revision', String(p.id), `--revision=${String(p.revision)}`]
  },
  {
    name: 'rollback_handoff',
    description:
      '把项目接手说明回滚到某一版：该版全文会作为**新的一次保存**写回（留痕为「回滚」，不删中间版本）。' +
      '该版内容已等于当前说明时不写（回执 changed=false）',
    annotations: WRITE,
    actor: true,
    input: {
      id: z.string().describe('项目 id、短 id 或完整名称'),
      revision: z.string().describe('要回滚到的修订序号（如 "3"）或修订 id / id 前缀'),
      actor: z
        .string()
        .optional()
        .describe('这次调用以谁的身份（如 agent:alice）—— 不改服务进程环境也能指定')
    },
    toArgv: (p) => ['project', 'handoff-rollback', String(p.id), `--revision=${String(p.revision)}`]
  },
  {
    name: 'update_handoff',
    description: '主用户直接更新项目接手说明；Agent 应使用 propose_handoff 提交提议并等待审批',
    annotations: WRITE,
    actor: true,
    input: {
      id: z.string().describe('项目 id、短 id 或完整名称'),
      body: z.string().describe('新的接手说明正文'),
      expected_revision: z.number().int().nonnegative().optional().describe('读取时看到的修订序号') ,
      actor: z.string().optional().describe('这次调用以谁的身份')
    },
    toArgv: (p) => {
      const argv = ['project', 'handoff-update', String(p.id), `--body=${String(p.body)}`]
      opt(argv, '--expected-revision', p.expected_revision)
      return argv
    }
  },
  {
    name: 'list_agents',
    description: '列出已注册的 agent 身份（人机协作时知道都有谁）',
    annotations: READ_ONLY,
    input: {},
    toArgv: () => ['agent', 'list']
  },
  {
    name: 'add_todo',
    description:
      '新建待办。title 与 project 必填；project 必须是已有项目名（不存在会报错并提示先建）。' +
      'status 可用 proposed 提一条「待确认」的提议（等人放行），或 done 补记已完成的事。' +
      'desc 是规格描述（不是往来讨论，往来用 comment_todo）',
    annotations: WRITE,
    actor: true,
    input: {
      title: z.string().describe('标题，单行，≤200 字'),
      project: z.string().describe('项目名（必须已存在，或先用 create_project 建）'),
      desc: z.string().optional().describe('规格描述'),
      category: z.string().optional(),
      priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
      type: z.enum(['bug', 'feature', 'task']).optional().describe('报缺陷传 bug，提需求传 feature'),
      status: z
        .enum(['proposed', 'todo', 'in_progress', 'suspended', 'awaiting_review', 'done'])
        .optional()
        .describe('初始状态，默认 todo；向人提议传 proposed，补记已完成传 done'),
      created_by: z.string().optional().describe('提出者，如 agent:<你的名字>（不传默认 human）'),
      due: z.string().optional().describe('ISO / today / tomorrow / +3d / 09-20 18:00'),
      remind: z.string().optional().describe('提醒时间，与 due 同一套解析；到点在界面弹提醒'),
      parent: z.string().optional().describe('父需求 id（挂子任务用）'),
      actor: z
        .string()
        .optional()
        .describe('这次调用以谁的身份（如 agent:alice）—— 不改服务进程环境也能指定')
    },
    toArgv: (p) => {
      const argv = ['todo', 'add', '--title', String(p.title), '--project', String(p.project)]
      opt(argv, '--desc', p.desc)
      opt(argv, '--category', p.category)
      opt(argv, '--priority', p.priority)
      opt(argv, '--type', p.type)
      opt(argv, '--status', p.status)
      opt(argv, '--created-by', p.created_by)
      opt(argv, '--due', p.due)
      opt(argv, '--remind', p.remind)
      opt(argv, '--parent', p.parent)
      return argv
    }
  },
  {
    name: 'update_todo',
    description:
      '修改待办：改标题/描述/优先级/归属，或推进状态。' +
      '状态机：todo → in_progress → awaiting_review；done 由验收方标；' +
      'proposed 是人 gates 的候选池（agent 推不进也拉不出，G4）',
    annotations: WRITE,
    actor: true,
    input: {
      id: z.string(),
      title: z.string().optional(),
      desc: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'awaiting_review', 'suspended']).optional(),
      priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
      project: z.string().optional(),
      category: z.string().optional(),
      due: z.string().optional().describe('传 clear 清空截止时间'),
      remind: z.string().optional().describe('提醒时间；传 clear 清空'),
      fixed_in: z.string().optional().describe('标「解决于版本」；传 clear 清掉标注'),
      created_by: z.string().optional().describe('改提出者（记错人时的补救）'),
      actor: z
        .string()
        .optional()
        .describe('这次调用以谁的身份（如 agent:alice）—— 不改服务进程环境也能指定')
    },
    toArgv: (p) => {
      const argv = ['todo', 'update', String(p.id)]
      opt(argv, '--title', p.title)
      opt(argv, '--desc', p.desc)
      opt(argv, '--status', p.status)
      opt(argv, '--priority', p.priority)
      opt(argv, '--project', p.project)
      opt(argv, '--category', p.category)
      opt(argv, '--due', p.due)
      opt(argv, '--remind', p.remind)
      opt(argv, '--fixed-in', p.fixed_in)
      opt(argv, '--created-by', p.created_by)
      return argv
    }
  },
  {
    name: 'comment_todo',
    description:
      '给待办留一条评论（往来讨论都走评论，不动规格描述）。' +
      '收口结论也用评论写 —— description 只放原始规格',
    annotations: WRITE,
    actor: true,
    input: {
      id: z.string(),
      body: z.string().describe('评论正文'),
      reply_to: z.string().optional().describe('要回复的那条评论的 id/短号'),
      actor: z
        .string()
        .optional()
        .describe('这次调用以谁的身份（如 agent:alice）—— 不改服务进程环境也能指定')
    },
    toArgv: (p) => {
      const argv = ['todo', 'comment', String(p.id), '--body', String(p.body)]
      opt(argv, '--reply-to', p.reply_to)
      return argv
    }
  },
  {
    name: 'create_project',
    description:
      '新建一个项目（看板顶层容器）。同名已有会复用而不是重复建；新项目会自动生成接手说明模板。' +
      'add_todo 撞到"项目不存在"时用它补救 —— 这是那个报错在 MCP 语境里唯一可执行的出口',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    /**
     * `actor: true` + `actor` 入参（1.0.107，修 `1c1cedb0`）。
     *
     * 这是手工表里**最后一个**没有身份入参的写工具。实测 1.0.107 产物：
     * 31 个写工具（`readOnlyHint=false`）里 30 个有、只有它没有 ——
     * 于是 `create_project { actor }` 撞「未知入参：actor」，多凭据机器上
     * 只能退回改服务进程环境，而那条路正是 1.0.63 的注释自己点过名「不可执行」的。
     *
     * 为什么它会漏：身份的规矩**生成那条路**有（`generateMcpTools` 里
     * `!isRead` 就补 actor），**手工这条路**没有 —— 手工表靠人记得改。
     * 补它的同时把规矩变成闸门（见 `mcp-dispatch-coverage.test.ts`），
     * 否则下一个手工写工具还会漏。
     *
     * ⚠️ 形状与别的写工具一字不差，两处缺一不成立：
     * `actor: true` 决定 handler 读不读它，`input.actor` 决定客户端传它
     * 会不会被 `unknownInputKeys` 拒掉。两者都只影响 `input`，`argv` 不变
     * —— 身份走子进程的 `DESKPARTNER_AGENT`，绝不伪装成 CLI flag。
     */
    actor: true,
    input: {
      name: z.string().describe('项目名，如 "DeskPartner"'),
      color: z.string().optional().describe('颜色，如 #5388F6；不传用默认蓝'),
      actor: z
        .string()
        .optional()
        .describe('这次调用以谁的身份（如 agent:alice）—— 不改服务进程环境也能指定')
    },
    toArgv: (p) => {
      const argv = ['project', 'add', '--name', String(p.name)]
      opt(argv, '--color', p.color)
      return argv
    }
  }
]

interface InvokeResult {
  ok: boolean
  data?: unknown
  notice?: string
  code?: number
  errorCode?: string
  message?: string
  /**
   * 子进程的**原始 stdout**（只有 `rawOutput` 工具会走到这里）。
   *
   * `skill` 这类命令输出 YAML+Markdown，本来就不是 JSON 信封；
   * 按信封解析只会得到 `bad_output`，还把正文塞进 `message`。
   */
  rawText?: string
}

/**
 * 子进程环境：把 actor 落成 `DESKPARTNER_AGENT`、并**恒定**声明 `DESKPARTNER_SURFACE=mcp`（1.0.63）。
 *
 * 单独抽出来是为了**可测**：actor → env 这一跳没有 argv 可断言，
 * 埋进 spawn 里就只能靠真起进程才能验；抽成纯函数后一条断言就够，
 * 也不会因为将来重构 spawn 参数而静默失效。
 *
 * ⚠️ surface 必须**无条件**设置，不能挂在 `if (actor)` 里面 ——
 * 只读工具没有 actor 入参，把它写进条件分支的话，
 * "MCP 调用"这条统计恰好只在读写混合时才准，读调用又混回 cli。
 */
export const MCP_SURFACE = 'mcp'
export function buildChildEnv(
  actor: string | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(actor ? { DESKPARTNER_AGENT: actor } : {}),
    DESKPARTNER_SURFACE: MCP_SURFACE
  }
}

/**
 * `records` → NDJSON 文本（1.0.107，修 `0a9f42f8`）。
 *
 * 每项两种形态都会收：**字符串**原样当一行（调用方可能已经拼好了 JSON），
 * **对象**则 `JSON.stringify` 成一行。
 *
 * ⚠️ 这里**不做业务校验**：行的结构对不对由命令自己判（它本来就逐行校验、
 * 把每行的结果放回 `data.results`）。在这里再写一份就是第二套判据，
 * 而本文件反复在治的正是这个病。
 *
 * 末尾补一个换行：`readStdin` 按行切，最后一行没换行也认，补上更稳
 * （与别的文本工具一致）。
 *
 * 空数组 / 没传 → `undefined`，即"没有东西要喂"：调用方会拿到命令自己的
 * 「stdin 为空」回执，比伪造一个空 stdin 更准确。
 */
export function recordsToNdjson(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  return v.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
}

/**
 * 调一次启动器子进程，拿回 CLI 的 JSON 回执。
 *
 * ⚠️ 输出格式约定：非 TTY 下启动器输出 JSON（launcher/output 的同一契约）。
 * 本进程由 MCP 客户端 spawn，stdout 是管道 → 子进程继承的也是管道 → 必为 JSON。
 *
 * `rawText = true` 时**允许 stdout 不是 JSON**（1.0.107，修 `a18681ae`）：
 * `skill` 输出的是 YAML 前置 + Markdown 正文，硬按信封解析永远 `bad_output`。
 * 只有 `rawOutput` 工具会传它，且仍**优先尝试 JSON** —— 命令真出错时
 * 回的是标准错误信封，那封信封必须原样带回去，不能被当成"正文"吞掉。
 *
 * `stdinText`：要写进子进程 stdin 的内容（1.0.107，修 `0a9f42f8`）。
 * 不传时 stdin 仍是 `'ignore'`（**子进程直接 EOF，绝不挂住等输入**）——
 * 这是 1.0.97 就定下的：读不到输入的 CLI 必须立刻报错，不能让调用方干等。
 * 只有声明了 `stdin` 的命令（`batch`）才会传它。
 *
 * ⚠️ 两条 spawn 分支只为**保住旧行为**：没有内容要送时 stdin 仍是 `'ignore'`
 * （子进程直接 EOF，见上）。
 *
 * 合并成一条 `stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']`
 * 是不行的：第一项成了联合类型，它既不满足 `StdioNull` 也不满足 `StdioPipe`，
 * 于是**没有任何 `SpawnOptionsWithStdioTuple` 重载匹配得上**，落到通用的
 * `SpawnOptions` 重载 —— `child.stdout` 也跟着退成 `Readable | null`，
 * 下面三行 `setEncoding` / `on('data')` 全报 TS18047（运行时行为并没变，
 * 是类型掉了）。同理，把它提成变量也没用。
 */
export function invokeCli(
  argv: string[],
  actor?: string,
  rawText = false,
  stdinText?: string
): Promise<InvokeResult> {
  return new Promise((resolve) => {
    const child =
      stdinText === undefined
        ? spawn(process.execPath, [LAUNCHER, ...argv], {
            env: buildChildEnv(actor),
            // 没有内容要送：stdin 直接 'ignore'，子进程读到 EOF 立刻报"stdin 为空"
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          })
        : spawn(process.execPath, [LAUNCHER, ...argv], {
            env: buildChildEnv(actor),
            // 有记录要送（batch）：开管道，下面把 NDJSON 写进去并 end()
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          })
    /**
     * 写完就 end()。子进程可能先退出（如身份没批就被拒、或在读 stdin 之前就报错），
     * 那时写入会 EPIPE —— 那是**预期**，不能让它变成未捕获的流错误把 MCP 进程带走。
     */
    if (stdinText !== undefined) child.stdin?.on('error', () => {})
    child.stdin?.end(stdinText)
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        ok: false,
        code: 1,
        errorCode: 'timeout',
        message: `CLI 子进程 ${CALL_TIMEOUT_MS / 1000}s 未返回（${argv.join(' ')}）`
      })
    }, CALL_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (out += c))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (err += c))
    const finish = () => {
      clearTimeout(timer)
      const trimmed = out.trim()
      if (!trimmed) {
        resolve({
          ok: false,
          code: 1,
          errorCode: 'empty_output',
          message: `CLI 子进程无输出（exit=${child.exitCode}）。stderr: ${err.slice(0, 400)}`
        })
        return
      }
      try {
        resolve(JSON.parse(trimmed) as InvokeResult)
      } catch {
        /**
         * rawOutput 工具：解析不出 JSON 是**预期**，原样把 stdout 交上去。
         * 注意顺序 —— **先试 JSON**：命令真失败时回的是标准错误信封，
         * 那封信封必须带走，不能被当成"正文"。
         */
        if (rawText) {
          resolve({ ok: true, code: 0, rawText: trimmed })
          return
        }
        resolve({
          ok: false,
          code: 1,
          errorCode: 'bad_output',
          message: `CLI 子进程输出不是 JSON：${trimmed.slice(0, 200)}`
        })
      }
    }
    child.on('close', finish)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 1, errorCode: 'spawn_error', message: e.message })
    })
  })
}

/** 串行队列：MCP 并发请求逐个执行，杜绝多进程同时写库 */
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

/**
 * 工具表降级时**必须让调用方看见**的那句话（1.0.107，修 `02ccb7ea`）。
 *
 * ## 为什么不能只写日志
 *
 * 原先取不到 schema 只往 stderr 打一行「退回手工表」。宿主看不见 stderr：
 * `tools/list` 照常成功返回，接入方**无从发现**工具面从几十个塌成十几个。
 * 于是它按记忆里的工具名发调用，得到一片 `not_found` —— 最难查的一类故障：
 * 每一处看起来都正常，只有合起来是错的。
 *
 * 判据：**降级要么别发生，要么必须出现在调用方能读到的地方。**
 * 这里出现在两处，因为两处都是"宿主一定会读"的：
 * ① 每个工具自己的 `description`（`tools/list` 里逐条可见）；
 * ② `initialize` 的 `instructions`（握手时模型即读到）。
 *
 * ⚠️ 刻意**不**改成"生成失败就起不来"：那会把"加了新命令"变成"整个 MCP 挂掉"，
 * 比降级更糟（本文件既有注释已论证过）。可见的降级胜过不可见的可用性。
 */
export const DEGRADED_NOTE =
  '[降级] 工具表生成失败，本表是**手工兜底**的一小部分 —— 其余命令在 MCP 侧不出现。' +
  '别把"工具没出现"当成"产品没有这个能力"：先调 `get_guide` 读说明书，' +
  '或用 CLI 跑 `schema`（`node "$DESKPARTNER_CLI" schema`）核对，或重试一次连接。'

/** 降级时给出的工具表：手工那份，逐条打上降级标记（别静默） */
function degradedTools(reason: string): ToolMapping[] {
  return TOOLS.map((t) => ({
    ...t,
    description: `[降级·工具表不完整] ${t.description}\n\n${DEGRADED_NOTE}\n原因：${reason}`
  }))
}

/**
 * 把工具注册到一个 McpServer 上。
 *
 * 抽成独立函数是为了**可测**：这段"接线"（SDK 回调签名 → toArgv → 子进程）
 * 是 1.0.59 那次 P0 丢包事故的现场，而它此前完全没有测试覆盖 ——
 * 原单测只对着 `TOOLS[i].toArgv` 断言，整条接线被绕开，
 * 所以 `({ arguments: args })` 这种解构错误对它是不可见的。
 *
 * `invoke` 可注入：测试传一个假的，就能用 SDK 的内存传输真实走一遍 handler，
 * 断言"客户端传了 limit=1，真的拼出了 --limit 1"。
 */
/**
 * 从 `dp schema` 生成 MCP 工具表（1.0.68，修 `69b9b651`）
 *
 * ## 为什么要有
 *
 * 工具表一直是**手工挑出来的 8 个**，而 CLI 有 44 条命令。
 * 实测后果（10-07 核代码）：
 * - 1.0.67 的 `todo close`（四段收口）**MCP 侧没有** ——
 *   而"待验收要有收口结论"是验收纪律，**从 MCP 接入的 agent 做不出收口**
 * - 1.0.68 的 5 件（收口 / 通知判据 / 去重 / 对账 / 废弃列）**一件都没暴露**
 *
 * 判据：**产品能算出来的，不该让每个 agent 手工算一遍**
 * （与 `84efa995` 去重那条同源）。
 * 而这条路本来就在脚下 —— 工具执行已经是"spawn 一次 CLI"，
 * **把工具表也变成 CLI 的派生物，两边就同源了。**
 *
 * ## 取不到 schema 时**退回手工那 10 个**
 *
 * ⚠️ **绝不能因为生成失败就让 MCP 起不来** ——
 * 那会让"加了新命令"变成"整个 MCP 挂掉"，比现状更糟。
 * 退化路径要能跑通，且**要让调用方知道**（返回值里带 `source`）。
 *
 * @param invoke 注入是为了测试（真接 invokeCli 会 spawn 子进程）
 */
export async function buildToolsFromSchema(
  invoke: (argv: string[]) => Promise<InvokeResult> = invokeCli
): Promise<{ tools: ToolMapping[]; source: 'schema' | 'fallback'; reason?: string }> {
  try {
    const res = await invoke(['schema'])
    if (!res.ok) {
      const reason = `取 schema 失败（code=${res.code} ${res.errorCode ?? ''}）`
      return { tools: degradedTools(reason), source: 'fallback', reason }
    }
    const data = res.data as { commands?: SchemaCommand[] } | undefined
    const cmds = data?.commands
    if (!Array.isArray(cmds) || cmds.length === 0) {
      const reason = 'schema 里没有 commands'
      return { tools: degradedTools(reason), source: 'fallback', reason }
    }

    /**
     * 反向表从**同一份 schema** 派生（1.0.107，修 `251eb399`）——
     * 不再让"命令→工具名"与"工具名→命令"各写一份；两份必然漂，
     * 实测漂出 9 个派发不出去的工具。
     */
    const routes = buildToolRoutes(cmds)
    const generated = generateMcpTools(cmds, z)

    /**
     * 关键：**既有 10 个手工工具的定义优先**。
     *
     * ⚠️ 名字与参数一字不能改 —— 已有接入方在用（qwen 就是）。
     * 而且它们手写的 `description` 比 schema 的 `desc` 更详细
     *（写了默认值、多值语法、`unset` 这些坑），**丢掉是能力回退**。
     * 所以是"**生成 + 既有覆盖**"，不是"替换"。
     */
    const legacyByName = new Map(TOOLS.map((t) => [t.name, t]))
    const merged: ToolMapping[] = []
    for (const g of generated) {
      const legacy = legacyByName.get(g.name)
      if (legacy) {
        merged.push(legacy)
      } else {
        merged.push({
          name: g.name,
          description: g.description,
          input: g.input as Record<string, z.ZodTypeAny>,
          annotations: g.annotations as ToolMapping['annotations'],
          actor: g.actor,
          outputKind: g.outputKind,
          // 条数上界同样从命令声明带过来 —— 少这一跳，无参 export_telemetry 又会灌满宿主上下文
          defaultLimitKey: g.defaultLimitKey,
          // 「记录写进 stdin」同样从命令声明带过来，少这一跳 batch 就又送不进内容
          stdinKind: g.stdinKind,
          toArgv: (p) => schemaToArgv(g.name, p, routes)
        })
      }
    }
    // schema 里没生成出来、但手工表里有的（被过滤规则挡掉的）也保留 ——
    // 别因为规则调整就把人已经接进来的能力掐掉
    for (const t of TOOLS) {
      if (!merged.some((m) => m.name === t.name)) merged.push(t)
    }
    return { tools: merged, source: 'schema' }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { tools: degradedTools(reason), source: 'fallback', reason }
  }
}

export function registerTools(
  server: McpServer,
  // 第三个入参是"允许 stdout 不是 JSON"，只有 rawOutput 工具会传 true
  // 第四个入参是要写进子进程 stdin 的内容（`batch` 的记录），只有 stdinKind 工具会传
  invoke: (
    argv: string[],
    actor?: string,
    rawText?: boolean,
    stdinText?: string
  ) => Promise<InvokeResult> = invokeCli,
  /** 工具表；不给就用静态 TOOLS（1.0.68 起由 buildToolsFromSchema 传入） */
  toolList: ToolMapping[] = TOOLS
): void {
  for (const tool of toolList) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        /**
         * ⚠️ 用 `z.looseObject` 而不是裸 shape（1.0.63）。
         *
         * 裸 shape 会被 SDK 规整成**严格对象**：校验时把没声明的键直接丢掉，
         * 于是 handler 永远看不到多余入参 —— 客户端传 `actor` 时"不报错也不生效"，
         * agent 以为设上了，实际按未声明身份执行（qwen 实测报的就是这个）。
         * looseObject 保留未知键，交给下面的 handler 显式拒绝并列出合法入参。
         */
        inputSchema: z.looseObject(tool.input),
        // 注解给宿主看：读工具可重试、写工具要当心。缺省时宿主只能猜。
        annotations: tool.annotations
      },
      // ⚠️ 回调签名的第一个入参**就是 arguments 本身**（`(args, extra)`）。
      // SDK 的类型是 BaseToolCallback = (args: ShapeOutput<Args>, extra) => …
      // 曾写成 `async ({ arguments: args }) =>` —— 解构一个不存在的属性，
      // args 恒为 undefined，每个工具都按空参执行（1.0.59 被验收方判 P0 阻断）。
      // 危险点是它**不报错**：无参工具正常、带参工具返回"数据不对但信封合法"，
      // 所以单测只看 isError=false 抓不到，必须断言"传了 limit:1 就只回 1 条"。
      async (args) => {
        const given = (args ?? {}) as Record<string, unknown>
        /**
         * 逐行输出的工具**默认有界**（1.0.107，修 `7e321f6d`）。
         *
         * 只在调用方**没给**这个参数时兜上；给了就一律照它的来 —— 默认有界，不是硬上限。
         * 落在这层而不是 `toArgv` 里：`toArgv` 是"参数 → argv"的机械映射，
         * 而"这一次回执最多多大"是**接入层的政策** —— 与 actor 走环境变量、
         * records 走 stdin 同理，都不是 CLI 的参数，也不该进授权记录里的 argv。
         *
         * 判据：**这条通道与 CLI 直连的差别，不能只体现在回执体积上。**
         * 不兜这一下，无参调用就由数据量决定回执多大（实测 459KB），
         * 而数据量是调用方看不见的东西 —— 它连"该传 limit"都无从知道。
         */
        const params =
          tool.defaultLimitKey && given[tool.defaultLimitKey] === undefined
            ? { ...given, [tool.defaultLimitKey]: DEFAULT_ROW_LIMIT }
            : given
        /**
         * actor 是从参数里**取出来**、不当 argv 拼 —— 见 ToolMapping.actor。
         * 只有声明了 actor 的工具读它；其余工具的 schema 里没有这个键，
         * 客户端传了也会被 SDK 按未知入参拒掉（不会静默吞）。
         */
        const actor = tool.actor ? str(params.actor) : undefined
        /**
         * 批量容器：把 `records` 拼成 NDJSON，等下写进子进程 stdin（1.0.107，修 `0a9f42f8`）。
         *
         * 在这里拼而不是在 `toArgv` 里：`records` **不是 argv** ——
         * 它走的是另一条路（子进程的 stdin），与 actor 走环境变量同理。
         * 声明了 `stdinKind` 的工具才取它；别的工具的 schema 里没有这个键，
         * 客户端传了会被 `unknownInputKeys` 显式拒掉（不会静默吞）。
         */
        const stdinText =
          tool.stdinKind === 'ndjson' ? recordsToNdjson(params[RECORDS_PARAM]) : undefined

        const result = await enqueue(async () => {
          /**
           * 未知入参先拦下（1.0.63）：SDK 会静默丢掉多余的键 ——
           * 传了却不生效比报错更难查，这里必须显式拒绝并列出合法入参。
           */
          const unknown = unknownInputKeys(tool, params)
          if (unknown.length) {
            return {
              ok: false,
              code: 2,
              errorCode: 'usage_error',
              message:
                `未知入参：${unknown.join(', ')} —— 已忽略会让你误以为设置生效了，所以直接拒绝。` +
                `本工具支持的入参：${Object.keys(tool.input).join(', ')}`
            } satisfies InvokeResult
          }
          let argv: string[]
          try {
            argv = tool.toArgv(params)
          } catch (err) {
            return {
              ok: false,
              code: 2,
              errorCode: 'usage_error',
              message: err instanceof Error ? err.message : String(err)
            } satisfies InvokeResult
          }
          return invoke(
            argv,
            actor,
            tool.outputKind !== undefined && tool.outputKind !== 'json',
            stdinText
          )
        })

        /**
         * `text`（`skill` 的 YAML + Markdown）：原样透传正文 ——
         * 不套 JSON 信封，更不能把正文当错误信息发回去（`a18681ae`）。
         * 见 `InvokeResult.rawText`。
         */
        if (tool.outputKind === 'text' && result.ok && result.rawText !== undefined) {
          return {
            content: [{ type: 'text' as const, text: result.rawText }],
            isError: false
          }
        }

        /**
         * `ndjson`（`telemetry export`）：**每行一条**，不能当单份信封解析
         * —— `f99178d7`：出多行即 `bad_output`，只有恰好一行时才"成功"。
         *
         * 这里逐行解析、聚成一封标准信封，让调用方拿到的形状与别的工具一致，
         * 条数也从 `data.count` 直接可读（卡上判据：返回条数与 limit 一致）。
         * 单行解析失败**不丢数据**：原样保留该行字符串，由调用方判断。
         */
        if (tool.outputKind === 'ndjson' && result.ok && result.rawText !== undefined) {
          const lines = result.rawText.split(/\r?\n/).filter((l) => l.trim() !== '')
          const records: unknown[] = lines.map((l) => {
            try {
              return JSON.parse(l) as unknown
            } catch {
              return l
            }
          })
          const envelope: InvokeResult = {
            ok: true,
            data: {
              count: records.length,
              records,
              note: 'CLI 直连时这条命令逐行输出 NDJSON；MCP 侧聚成了 records 数组，条数见 count。'
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
            isError: false
          }
        }

        /**
         * 返回体保持为合法 JSON 信封（与 CLI 回执同构）。
         * notice 已在顶层字段中，不能再把提示文本拼到 JSON 前面，
         * 否则 MCP 客户端无法直接 JSON.parse(content[0].text)。
         */
        const text = JSON.stringify(result, null, 2)
        return {
          content: [{ type: 'text' as const, text }],
          isError: !result.ok
        }
      }
    )
  }
}

/** 取一个可能为空串的字符串参数 */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/**
 * 找出客户端传了、而工具没声明的入参（1.0.63）。
 *
 * ⚠️ SDK **不会**为未知入参报错 —— 它按 inputSchema 取需要的键，
 * 多余的键直接丢掉。qwen 实测传 `actor:"agent:bob"` 就是"不报错也不生效"：
 * agent 以为身份设上了，实际按未声明身份执行。这类"传了却不生效"的静默失败
 * 比报错难查得多（与 tsc 抓不到的参数丢包同源），必须在接线层自己拦。
 */
function unknownInputKeys(tool: ToolMapping, params: Record<string, unknown>): string[] {
  const declared = new Set(Object.keys(tool.input))
  return Object.keys(params).filter((k) => !declared.has(k))
}

/**
 * 造一个带 instructions 与全部工具的 McpServer。
 *
 * 抽出来是为了**可测**：instructions 只在 initialize 结果里出现，
 * 若把它写死在 `runMcpServer` 里（那个函数一上来就连 stdio），
 * 单测就只能去断言常量字符串、验证不到"SDK 真的把它带出去了"。
 * 这里把创建与启动分开，测试可以建完直接读 `client.getInstructions()`。
 */
/**
 * 建 MCP Server（1.0.68 起**从 `dp schema` 生成工具表**，见 `buildToolsFromSchema`）
 *
 * ⚠️ **改成 async 是有意的**：工具表现在要先 spawn 一次 CLI 取 schema，
 * 而 SDK 的 `registerTool` 是同步调用 —— 那就只能在这层 await。
 * 调用方（`runMcpServer`）本来就是 async，不受影响。
 *
 * **取不到 schema 会退回手工那 10 个**（`buildToolsFromSchema` 内已处理），
 * 并把原因打到 stderr —— **MCP 不会因为生成失败而起不来**。
 */
export async function createMcpServer(
  version: string,
  invoke?: typeof invokeCli
): Promise<McpServer> {
  // invoke 可选（测试会传），而 buildToolsFromSchema 需要一个确定非空的实现
  const inv = invoke ?? invokeCli
  /**
   * ⚠️ **先建工具表、再建 server**（1.0.107，修 `02ccb7ea`）。
   *
   * 原先是反的，于是"工具表降级了"这件事只能进 stderr —— 宿主看不见。
   * 先算出来，才能把降级写进 initialize 的 instructions：
   * 那是唯一一处"宿主一定会读到"的通道。
   */
  const built = await buildToolsFromSchema(inv)
  process.stderr.write(
    `[mcp] 工具表来源：${built.source}` +
      (built.source === 'schema' ? `（${built.tools.length} 个）\n` : `（退回手工表：${built.reason}）\n`)
  )
  /**
   * instructions 写进 initialize 结果（1.0.63）：宿主模型握手时即读到规矩，
   * 不必先问"这个看板的关口模型是什么"再犯错一次。见 MCP_INSTRUCTIONS。
   * 降级时叠加 `DEGRADED_NOTE` —— 见那里的论证。
   */
  const instructions =
    built.source === 'fallback' ? `${MCP_INSTRUCTIONS}\n\n${DEGRADED_NOTE}` : MCP_INSTRUCTIONS
  const server = new McpServer({ name: 'deskpartner', version }, { instructions })
  registerTools(server, invoke, built.tools)
  return server
}

/** 启动 MCP server（stdio 长驻）。onClose：客户端断开后的收尾（由入口注入） */
export async function runMcpServer(opts: {
  version: string
  onClose: () => void
}): Promise<void> {
  const server = await createMcpServer(opts.version)

  process.stderr.write(
    `[mcp] deskpartner MCP server ready (v${opts.version}, launcher=${LAUNCHER})\n`
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  /**
   * 收尾信号用 transport.onclose：客户端断开的权威通知。
   * （SDK 在 stdin end / 出错时都会触发 close。）
   */
  const prevClose = transport.close.bind(transport)
  transport.close = async () => {
    await prevClose()
    opts.onClose()
  }
}
