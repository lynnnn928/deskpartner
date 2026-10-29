/**
 * MCP 工具映射的回归测试（1.0.59，bf736527）
 *
 * MCP server 的架构是「每个工具转发给 executeOne 拼出的一条 CLI 命令」——
 * 门禁/守卫/审计全部白嫖现有命令层，所以这里**不测业务行为**（那是命令表测试的职责），
 * 只测这一层自己拥有的东西：**参数 → argv 的拼接**。
 *
 * 这一层的典型失效模式是「参数收下了却没拼进 argv」：
 * MCP 客户端看到 schema 里有 status 字段、传了值，结果工具悄悄忽略 ——
 * tsc 抓不到（都是 unknown→string 的合法转换）、命令层也测不到（根本没收到那个 flag）。
 * 只有对着映射表逐个断言「传了 X 就必须出现 --x」才拦得住。
 */
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const { TOOLS, createMcpServer } = await import('../../../src/cli/mcp-server')
/** 通道侧默认条数上界：断言里用常量，不抄数字（抄了就会在改值时静默失效） */
const { DEFAULT_ROW_LIMIT } = await import('../../../src/cli/mcp-tools-from-schema')

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`工具 ${name} 不存在`)
  return t
}

/**
 * 参数里出现的每个键都必须落进 argv —— 「收下却没用」是这一层最危险的静默失败。
 *
 * 两类例外（与 CLI 参数模型一致）：
 * - positional：位置参数（id），不出现在任何 flag 后面，只断言值在 argv 里；
 * - booleanFlags：布尔开关（--brief），出现但不带值 —— 带了值反而会被 CLI 吃成参数。
 */
function expectEveryKeyMapped(
  name: string,
  params: Record<string, unknown>,
  opts: { positional?: string[]; booleanFlags?: string[] } = {}
) {
  const t = tool(name)
  const argv = t.toArgv(params)
  const positional = new Set(opts.positional ?? [])
  const booleans = new Set(opts.booleanFlags ?? [])
  for (const key of Object.keys(params)) {
    if (positional.has(key)) {
      expect(argv, `[${name}] 位置参数 ${key} 的值必须在 argv 里`).toContain(String(params[key]))
      continue
    }
    // 键名转 flag：下划线转横线（created_by → --created-by）
    const flag = `--${key.replace(/_/g, '-')}`
    const idx = argv.indexOf(flag)
    if (idx === -1) {
      throw new Error(`[${name}] 参数 ${key} 没有映射进 argv（收下了却没用）：${JSON.stringify(argv)}`)
    }
    if (booleans.has(key)) {
      // 布尔开关不带值：值位置要么是下一个 flag、要么到头
      expect(argv[idx + 1], `[${name}] ${flag} 是布尔开关，不该带值`).toBeUndefined()
      continue
    }
    expect(argv[idx + 1], `[${name}] ${flag} 后面跟的值不对`).toBe(String(params[key]))
  }
  return argv
}

describe('MCP 工具 → CLI argv 映射（bf736527）', () => {
  it('工具清单 = 只读为主的最小可用面（13 个：8 读 + 4 写 + 1 建项目；接手说明修订历史 3 个：2 读 1 写）', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'list_todos',
      'get_todo',
      'list_projects',
      'get_project',
      'search_project',
      'list_handoff_revisions',
      'get_handoff_revision',
      'rollback_handoff',
      'update_handoff',
      'list_agents',
      'add_todo',
      'update_todo',
      'comment_todo',
      'create_project'
    ])
  })

  it('接手说明修订三件套：参数全部映射成 CLI 的 project handoff-* 命令（36b44adb）', () => {
    const list = expectEveryKeyMapped(
      'list_handoff_revisions',
      { id: 'DeskPartner', limit: 5 },
      { positional: ['id'] }
    )
    expect(list.slice(0, 3)).toEqual(['project', 'handoff-history', 'DeskPartner'])
    expect(list[list.indexOf('--limit') + 1]).toBe('5')

    const get = tool('get_handoff_revision').toArgv({ id: 'DeskPartner', revision: '#3' })
    expect(get).toEqual(['project', 'handoff-revision', 'DeskPartner', '--revision=#3'])

    const rb = tool('rollback_handoff').toArgv({ id: 'DeskPartner', revision: '2' })
    expect(rb).toEqual(['project', 'handoff-rollback', 'DeskPartner', '--revision=2'])
  })

  it('list_todos：全参数都映射，且按 CLI 的 flag 名（下划线转横线）', () => {
    const argv = expectEveryKeyMapped('list_todos', {
      status: 'in_progress',
      priority: 'high',
      type: 'bug',
      search: '透明度',
      created_by: 'agent:alice',
      category: '共享能力',
      project: 'DeskPartner',
      fixed_in: '1.0.59',
      limit: 20,
      offset: 20,
      brief: true
    }, { booleanFlags: ['brief'] })
    expect(argv[0]).toBe('todo')
    expect(argv[1]).toBe('list')
    // brief 是布尔 flag，不带值
    expect(argv.lastIndexOf('--brief')).toBe(argv.length - 1)
  })

  /**
   * 默认有界（1.0.63，9fde5666）—— 一次 list_todos 不带参数曾返回 456,206 字符，
   * 宿主上下文直接被撑满。所以**即使调用方什么都没传**，也必须兜上 limit 与 brief。
   * 关键判据：它们出现，且 limit 是个数（不是空 flag）。
   */
  it('list_todos：不传 limit/brief 时也兜默认（否则一次全库 45 万字符）', () => {
    const argv = tool('list_todos').toArgv({ status: 'todo' })
    expect(argv).toEqual(['todo', 'list', '--status', 'todo', '--limit', '50', '--brief'])
  })

  it('list_todos：显式传的 limit 优先于默认（默认是兜底不是硬上限）', () => {
    const argv = tool('list_todos').toArgv({ limit: 5 })
    expect(argv[argv.indexOf('--limit') + 1]).toBe('5')
  })

  it('list_todos：显式 brief:false 才要描述（默认省略）', () => {
    const withDesc = tool('list_todos').toArgv({ brief: false })
    expect(withDesc).not.toContain('--brief')
    const def = tool('list_todos').toArgv({})
    expect(def).toContain('--brief')
  })

  it('get_todo：id 落在位置参数', () => {
    expect(tool('get_todo').toArgv({ id: '52b6b726' })).toEqual(['todo', 'get', '52b6b726'])
  })

  it('get_project：项目 id 落在位置参数，读取 Markdown 与动态概览', () => {
    expect(tool('get_project').toArgv({ id: 'project-123' })).toEqual([
      'project', 'get', 'project-123'
    ])
  })

  it('search_project：项目边界与关键词都映射到 CLI 命令', () => {
    expect(tool('search_project').toArgv({ id: 'project-123', query: '%_needle' })).toEqual([
      'project', 'search', 'project-123', '--query=%_needle'
    ])
  })

  it('add_todo：title/project 必现且在前，其余可选拼在后面', () => {
    const argv = expectEveryKeyMapped('add_todo', {
      title: '标题',
      project: 'DeskPartner',
      desc: '规格描述',
      category: '共享能力',
      priority: 'high',
      due: '+3d',
      parent: '3f5c65f3'
    })
    expect(argv.slice(0, 4)).toEqual(['todo', 'add', '--title', '标题'])
    expect(argv).toContain('--project')
  })

  /**
   * add_todo 的三件新入参（1.0.63）：缺了它们，走 MCP 的 agent
   * 建不了「待确认」提议（proposed）、报不了 bug 类型事项、
   * 也标不了提出者 —— MCP 就永远是 CLI 的降级面。
   */
  it('add_todo：status/type/created_by 必须映射（否则建不了提议、报不了 bug）', () => {
    const argv = expectEveryKeyMapped('add_todo', {
      title: '提议一件事',
      project: 'DeskPartner',
      status: 'proposed',
      type: 'bug',
      created_by: 'agent:alice'
    })
    expect(argv[argv.indexOf('--status') + 1]).toBe('proposed')
    expect(argv[argv.indexOf('--type') + 1]).toBe('bug')
    expect(argv[argv.indexOf('--created-by') + 1]).toBe('agent:alice')
  })

  it('update_todo：id 在位置参数上，状态推进映射为 --status', () => {
    const argv = expectEveryKeyMapped('update_todo', {
      id: '52b6b726',
      status: 'awaiting_review',
      title: '新标题',
      desc: '新描述',
      priority: 'urgent',
      project: 'DeskPartner',
      category: '其他',
      due: 'clear',
      fixed_in: '1.0.59'
    }, { positional: ['id'] })
    expect(argv.slice(0, 3)).toEqual(['todo', 'update', '52b6b726'])
    expect(argv).toContain('--status')
  })

  it('comment_todo：正文走 --body（不是 --body-file —— 那是启动器专属 flag，服务端会报 usage_error）', () => {
    const argv = expectEveryKeyMapped('comment_todo', {
      id: '52b6b726',
      body: '结论写这里',
      reply_to: '5fb5ac96'
    }, { positional: ['id'] })
    expect(argv).toContain('--body')
    expect(argv).not.toContain('--body-file')
    expect(argv).not.toContain('--desc-file')
  })

  it('长正文原样透传：MCP 参数就是内容本身，不存在文件路径展开', () => {
    const body = '多行\n带"引号"与反引号`x`与 $ 符号'
    const argv = tool('comment_todo').toArgv({ id: 'x', body })
    expect(argv[argv.indexOf('--body') + 1]).toBe(body)
  })

  /**
   * create_project（1.0.63）：add_todo 撞到"项目不存在"时，报错让加 --create-project
   * 或先 project add —— 而 MCP 此前两样都没有，补救在 MCP 语境里不可执行。
   */
  it('create_project：name 必现，color 可选', () => {
    const argv = expectEveryKeyMapped('create_project', { name: 'DeskPartner', color: '#5388F6' })
    expect(argv.slice(0, 3)).toEqual(['project', 'add', '--name'])
    expect(argv[argv.indexOf('--color') + 1]).toBe('#5388F6')
  })

  /**
   * 注解（1.0.63）：宿主靠 readOnlyHint/destructiveHint 决定要不要弹确认、
   * 能不能自动重试。此前全部工具注解为空，宿主只能猜 —— 猜错的代价是
   * 写操作被当成读静默放行。这里钉住"每个工具都声明了、且读写的值对"。
   */
  it('每个工具都带 annotations，且读工具 readOnlyHint=true、写工具 false', () => {
    const READ = [
      'list_todos',
      'get_todo',
      'list_projects',
      'get_project',
      'search_project',
      'list_handoff_revisions',
      'get_handoff_revision',
      'list_agents'
    ]
    for (const t of TOOLS) {
      expect(t.annotations, `${t.name} 缺 annotations`).toBeTruthy()
      const isRead = READ.includes(t.name)
      expect(t.annotations.readOnlyHint, `${t.name} readOnlyHint`).toBe(isRead)
    }
  })

  it('只有写工具收 actor（读工具没有身份入参）', () => {
    const writers = TOOLS.filter((t) => t.actor).map((t) => t.name)
    expect(writers.sort()).toEqual([
      'add_todo',
      'comment_todo',
      // create_project 曾是唯一的例外（`1c1cedb0`），2026-10-20 补上；
      // 手工表里少一个就少一条"按调用声明身份"的路。
      'create_project',
      'rollback_handoff',
      'update_handoff',
      'update_todo'
    ])
  })
})

/**
 * actor → 子进程环境（1.0.63）
 *
 * actor 不进 argv，而是落成子进程的 `DESKPARTNER_AGENT`（启动器据此带凭据）。
 * 这一跳没有 argv 可断言，所以单独测这个纯函数 —— 它是"多凭据机器上
 * 写路径不再只剩改服务进程环境这一条路"的唯一实现点。
 */
describe('MCP actor → 子进程环境 / surface 声明（1.0.63）', () => {
  it('传了 actor 就设 DESKPARTNER_AGENT；且恒定声明 surface=mcp', async () => {
    const { buildChildEnv, MCP_SURFACE } = await import('../../../src/cli/mcp-server')
    const env = buildChildEnv('agent:bob', { PATH: '/x' } as NodeJS.ProcessEnv)
    expect(env.DESKPARTNER_AGENT).toBe('agent:bob')
    expect(env.DESKPARTNER_SURFACE).toBe(MCP_SURFACE)
    expect(env.PATH).toBe('/x') // 基线环境不能被丢掉
  })

  it('没传 actor 也要声明 surface=mcp（只读工具没有 actor，否则读调用又混回 cli 统计）', async () => {
    const { buildChildEnv } = await import('../../../src/cli/mcp-server')
    const env = buildChildEnv(undefined, {} as NodeJS.ProcessEnv)
    expect(env.DESKPARTNER_SURFACE).toBe('mcp')
    expect(env.DESKPARTNER_AGENT).toBeUndefined()
  })

  /**
   * 声明的 actor **必须压过**环境里已有的 `DESKPARTNER_AGENT`（1.0.107，`1c1cedb0`）。
   *
   * 这是卡上那条反向验证「声明与 env 不一致时以声明值为准」的实现点。
   * 顺序反过来的话，`actor` 入参就形同虚设：MCP 客户端传了值、工具也收下了，
   * 实际却仍按进程环境执行 —— 正是本文件反复治的「传了却不生效」。
   */
  it('声明的 actor 覆盖环境里已有的 DESKPARTNER_AGENT', async () => {
    const { buildChildEnv } = await import('../../../src/cli/mcp-server')
    const env = buildChildEnv('agent:penguin', {
      DESKPARTNER_AGENT: 'agent:alice',
      PATH: '/x'
    } as NodeJS.ProcessEnv)
    expect(env.DESKPARTNER_AGENT, '声明值必须赢，否则 actor 入参等于没接').toBe('agent:penguin')
    expect(env.PATH, '基线环境不能被丢掉').toBe('/x')
  })
})

/**
 * 接线层回归 —— 1.0.59 `bf736527` 被验收方判 P0 阻断的那次事故。
 *
 * 【事故】handler 写成 `async ({ arguments: args }) => …`，而 SDK 回调的第一个
 * 入参**就是 arguments 本身**。于是 args 恒为 undefined，7 个工具全部按空参执行。
 * 【为什么上面那组测试抓不到】它们只对着 `TOOLS[i].toArgv` 断言，**整条接线被绕开**；
 * 而事故的失效形态恰恰是"接线错了、映射表是对的"。
 * 【危害等级】它不报错：无参工具（list_projects）完全正常、带参工具返回
 * "数据不对但信封合法"，只看 `isError === false` 一律通过。
 *
 * 所以这里必须用 SDK 的真实传输跑一遍完整链路，并断言**参数真的影响到了 argv**。
 */
describe('MCP 接线层：客户端参数必须真的走到 toArgv（bf736527 P0 回归）', () => {
  /**
   * 假 schema 样本（1.0.68）
   *
   * 覆盖三档 risk（read / write / destructive）+ 一个**该被排除**的（doctor）
   * + 一个**新增命令**（`todo close`）——
   * 最后那个专门验「CLI 加了新命令，不用手改 MCP 就自动出现」。
   */
  const FAKE_SCHEMA_COMMANDS = [
    {
      name: 'todo list',
      desc: '查待办',
      risk: 'read',
      readOnly: true,
      args: [{ flag: '--status', type: 'enum', enum: ['any', 'todo'] }]
    },
    {
      name: 'todo update',
      desc: '改待办',
      risk: 'write',
      positional: { name: 'id', required: true },
      args: [{ flag: '--title', type: 'string' }]
    },
    { name: 'todo rm', desc: '删待办', risk: 'destructive', positional: { name: 'id', required: true }, args: [] },
    {
      name: 'project get',
      desc: '读项目详情',
      risk: 'read',
      readOnly: true,
      positional: { name: 'id', required: true },
      args: []
    },
    {
      name: 'project search',
      desc: '搜项目内容',
      risk: 'read',
      readOnly: true,
      positional: { name: 'id', required: true },
      args: [{ flag: '--query', type: 'string', required: true }]
    },
    {
      name: 'memo add',
      desc: '记一条备忘',
      risk: 'write',
      args: [{ flag: '--text', type: 'string', required: true }]
    },
    { name: 'doctor', desc: '自检', risk: 'read', readOnly: true, args: [] },
    {
      name: 'todo close',
      desc: '四段收口',
      risk: 'write',
      positional: { name: 'id', required: true },
      args: [
        { flag: '--did', type: 'string' },
        { flag: '--verified', type: 'string' }
      ]
    },
    /**
     * 批量容器（1.0.107，修 `0a9f42f8`）：`stdin` 是**命令自己声明**的，
     * 工具表据此给它一个 `records` 入参、handler 据此把记录写进子进程 stdin。
     */
    {
      name: 'batch',
      desc: '从 stdin 读取 NDJSON 批量执行',
      risk: 'write',
      stdin: 'ndjson',
      args: [
        { flag: '--stop-on-error', type: 'boolean' },
        { flag: '--doc', type: 'boolean' },
        { flag: '--dry-run', type: 'boolean' }
      ]
    }
  ]

  /** 建一对内存传输的 client/server，invoke 用假的记录收到的 argv 与 actor */
  async function connect() {
    const calls: string[][] = []
    const actors: (string | undefined)[] = []
    /** 第四个入参：要写进子进程 stdin 的文本（`batch` 的 NDJSON，`0a9f42f8`） */
    const stds: (string | undefined)[] = []
    // ⚠️ 1.0.68 起 createMcpServer 会先 spawn 一次 `dp schema` 生成工具表，
    // 所以假 invoke 必须认这条命令（1.0.67 及以前只处理业务命令）。
    const server = await createMcpServer('0', async (argv, actor, _rawText, stdinText) => {
      if (argv[0] === 'schema') {
        return { ok: true, data: { commands: FAKE_SCHEMA_COMMANDS } }
      }
      calls.push(argv)
      actors.push(actor)
      stds.push(stdinText)
      return { ok: true, data: { argv }, notice: '提醒：请读取顶层 notice' }
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return { client, calls, actors, stds }
  }

  /** 取回执正文（工具返回 content[0].text 是 JSON 串） */
  function textOf(res: unknown): string {
    const c = (res as { content?: { text?: string }[] })?.content?.[0]?.text ?? ''
    return String(c)
  }

  it('传了 limit＝1 —— 必须拼出 --limit 1（当年就是这里丢了全参数）', async () => {
    const { client, calls } = await connect()
    await client.callTool({ name: 'list_todos', arguments: { limit: 1 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('--limit')
    expect(calls[0][calls[0].indexOf('--limit') + 1]).toBe('1')
    await client.close()
  })

  it('位置参数 id 也要走到（get_todo 曾回 "待办不存在: undefined"）', async () => {
    const { client, calls } = await connect()
    await client.callTool({ name: 'get_todo', arguments: { id: '5fe6691c' } })
    expect(calls[0]).toEqual(['todo', 'get', '5fe6691c'])
    await client.close()
  })

  /**
   * 批量容器：`records` 必须**真的写进子进程 stdin**（1.0.107，修 `0a9f42f8`）
   *
   * 修前：`batch` 在 `tools/list` 里是个正常工具，可它的入参只有
   * stop_on_error/doc/dry_run，而 `invokeCli` 的子进程 stdin 是 `'ignore'` ——
   * 从 MCP 调它只能得到「stdin 为空」，一次都送不进内容。
   *
   * 这条盯的是**整条接线**：schema 声明 (`stdin`) → 工具入参 (`records`) →
   * handler 拼 NDJSON → invoke 的第四个参数。少任何一跳，工具又变成空壳。
   */
  it('batch 的 records 拼成 NDJSON 送进 stdin，且绝不混进 argv（0a9f42f8）', async () => {
    const { client, calls, actors, stds } = await connect()
    const res = await client.callTool({
      name: 'batch',
      arguments: {
        records: [
          { cmd: 'todo add', args: { '--title': '甲', '--project': 'P' } },
          '{"cmd":"todo done","positional":["abc12345"]}'
        ],
        stop_on_error: true,
        actor: 'agent:alice'
      }
    })
    expect((res as { isError?: boolean }).isError, '这条调用不该被拒').toBe(false)
    // 对象按一条记录序列化；字符串原样当一行
    expect(stds[0], 'records 没进 stdin —— 工具又只能回「stdin 为空」').toBe(
      '{"cmd":"todo add","args":{"--title":"甲","--project":"P"}}\n' +
        '{"cmd":"todo done","positional":["abc12345"]}\n'
    )
    // records 不是 CLI flag：拼成 `--records=[object Object]` 会让命令收到不认识的 flag
    expect(calls).toEqual([['batch', '--stop-on-error']])
    // 身份仍走 actor（不进 argv）—— 与别的写工具同一条规矩
    expect(actors).toEqual(['agent:alice'])
    await client.close()
  })

  it('batch 不传 records 时不喂任何东西（保持旧行为：命令自己报「stdin 为空」）', async () => {
    const { client, calls, stds } = await connect()
    await client.callTool({ name: 'batch', arguments: {} })
    expect(calls).toEqual([['batch']])
    expect(stds[0], '没内容就别开 stdin —— 伪造一个空 stdin 会让报错来源变模糊').toBeUndefined()
    await client.close()
  })

  it('只有声明了 stdin 的工具收 records（别的工具传它必须被显式拒绝）', async () => {
    const { client, calls } = await connect()
    const res = await client.callTool({
      name: 'list_todos',
      arguments: { records: [{ cmd: 'todo add' }] }
    })
    expect((res as { isError?: boolean }).isError, '读工具不该收 records').toBe(true)
    expect(calls).toHaveLength(0)
    await client.close()
  })

  it('项目详情和搜索参数穿过 MCP handler 后仍到达 CLI argv', async () => {
    const { client, calls } = await connect()
    await client.callTool({ name: 'get_project', arguments: { id: 'project-1' } })
    await client.callTool({
      name: 'search_project',
      arguments: { id: 'project-1', query: '%_needle' }
    })
    expect(calls).toEqual([
      ['project', 'get', 'project-1'],
      ['project', 'search', 'project-1', '--query=%_needle']
    ])
    await client.close()
  })

  it('接手说明修订：参数穿过 MCP handler 到达 argv；回滚的 actor 落到身份而不进 argv（36b44adb）', async () => {
    const { client, calls, actors } = await connect()
    await client.callTool({ name: 'list_handoff_revisions', arguments: { id: 'p1', limit: 3 } })
    await client.callTool({ name: 'get_handoff_revision', arguments: { id: 'p1', revision: '2' } })
    await client.callTool({
      name: 'rollback_handoff',
      arguments: { id: 'p1', revision: '#2', actor: 'agent:alice' }
    })
    expect(calls).toEqual([
      ['project', 'handoff-history', 'p1', '--limit', '3'],
      ['project', 'handoff-revision', 'p1', '--revision=2'],
      ['project', 'handoff-rollback', 'p1', '--revision=#2']
    ])
    expect(actors).toEqual([undefined, undefined, 'agent:alice'])
    await client.close()
  })

  it('接手说明修订：读工具不收 actor、回滚不认未知入参（显式拒绝而非静默忽略）', async () => {
    const { client, calls } = await connect()
    for (const [name, args] of [
      ['list_handoff_revisions', { id: 'p1', actor: 'agent:x' }],
      ['get_handoff_revision', { id: 'p1', revision: '1', actor: 'agent:x' }],
      ['rollback_handoff', { id: 'p1', revision: '1', bogus: 1 }]
    ] as const) {
      const res = await client.callTool({ name, arguments: args })
      expect((res as { isError?: boolean }).isError, `${name} 应拒绝未知入参`).toBe(true)
    }
    expect(calls).toHaveLength(0)
    await client.close()
  })

  it('多个参数不互相挤掉（status + project 同时出现）', async () => {
    const { client, calls } = await connect()
    await client.callTool({
      name: 'list_todos',
      arguments: { status: 'done', project: 'DeskPartner', brief: true }
    })
    const argv = calls[0]
    expect(argv).toContain('--status')
    expect(argv[argv.indexOf('--status') + 1]).toBe('done')
    expect(argv).toContain('--project')
    expect(argv[argv.indexOf('--project') + 1]).toBe('DeskPartner')
    expect(argv).toContain('--brief')
    await client.close()
  })

  it('写工具的参数同样不能丢（add_todo 的 title/project）', async () => {
    const { client, calls } = await connect()
    await client.callTool({
      name: 'add_todo',
      arguments: { title: '冒烟标题', project: 'DeskPartner' }
    })
    const argv = calls[0]
    expect(argv).toContain('--title')
    expect(argv[argv.indexOf('--title') + 1]).toBe('冒烟标题')
    expect(argv).toContain('--project')
    await client.close()
  })

  it('回执正文是合法的 JSON 信封（不是被 Error 包成的 usage_error）', async () => {
    const { client } = await connect()
    const res = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(() => JSON.parse(textOf(res))).not.toThrow()
    await client.close()
  })

  /**
   * actor 穿过整条接线（1.0.63）：客户端传 actor，invoke 的第二个入参必须收到它，
   * 且它**不能**混进 argv（argv 是给 CLI 的，actor 走环境变量）。
   * 这是"写路径身份"唯一的接缝，错了就又是"传了却不生效"。
   */
  it('写工具的 actor 传到 invoke，且不进 argv', async () => {
    const { client, calls, actors } = await connect()
    await client.callTool({
      name: 'add_todo',
      arguments: { title: 't', project: 'P', actor: 'agent:bob' }
    })
    expect(actors[0]).toBe('agent:bob')
    expect(calls[0]).not.toContain('--actor')
    expect(calls[0]).not.toContain('agent:bob')
    await client.close()
  })

  it('读工具没有 actor（不传时 invoke 收到 undefined）', async () => {
    const { client, actors } = await connect()
    await client.callTool({ name: 'list_todos', arguments: {} })
    expect(actors[0]).toBeUndefined()
    await client.close()
  })

  /**
   * 生成的写工具同样要能按调用声明身份（1.0.107，`1c1cedb0`）
   *
   * `add_todo` 那条测的是**手工表**那一路（`ToolMapping.actor = true`）；
   * `add_memos` 走的是**生成那一路**（`generateMcpTools` 给非只读命令补 actor）。
   * 两路各写各的，只测一路会有半个工具面没有覆盖 —— 这正是 `1c1cedb0` 的形状：
   * 一路全对，另一路漏了一个，而工具面上看起来"大部分是好的"。
   */
  it('生成的写工具也收 actor：add_memos 传到 invoke、不进 argv', async () => {
    const { client, calls, actors } = await connect()
    await client.callTool({
      name: 'add_memos',
      arguments: { text: '留意一下', actor: 'agent:penguin' }
    })
    expect(actors[0], '生成的写工具必须能按调用声明身份').toBe('agent:penguin')
    expect(calls[0]).toEqual(['memo', 'add', '--text=留意一下'])
    await client.close()
  })

  /**
   * `create_project` 是手工表里最后一个漏网的写工具（`1c1cedb0`，2026-10-20 补）。
   * 它曾经的症状很具体：传 `actor` 被当**未知入参**拒掉，而它恰好是
   * 「add_todo 报项目不存在」时唯一的可执行补救 —— 救不了场的那一步。
   */
  it('create_project 收 actor，且 identity 不进 argv', async () => {
    const { client, calls, actors } = await connect()
    await client.callTool({
      name: 'create_project',
      arguments: { name: 'X', actor: 'agent:penguin' }
    })
    expect(actors[0], 'create_project 必须能按调用声明身份').toBe('agent:penguin')
    expect(calls[0]).toEqual(['project', 'add', '--name', 'X'])
    await client.close()
  })

  it('list_todos 不带参数也兜上 --limit（默认有界真的作用在接线层）', async () => {
    const { client, calls } = await connect()
    await client.callTool({ name: 'list_todos', arguments: {} })
    expect(calls[0]).toContain('--limit')
    expect(calls[0]).toContain('--brief')
    await client.close()
  })

  /**
   * 未知入参不能被静默吞掉（1.0.63，qwen 实测报的失败模式）。
   *
   * 此前传一个不存在的键（如 actor）"不报错也不生效"——agent 以为设上了，
   * 实际什么都没发生。这是这一层最坏的失败形态：比报错更难查。
   * 判据：不认识的键必须让调用失败，而不是当没传。
   */
  it('未知入参必须报错，不能被静默忽略', async () => {
    const { client, calls } = await connect()
    let threw = false
    try {
      const res = await client.callTool({
        name: 'comment_todo',
        arguments: { id: 'x', body: 'b', totally_unknown_field: 'v' }
      })
      if ((res as { isError?: boolean }).isError) threw = true
    } catch {
      threw = true
    }
    // 要么调用报错，要么……那就说明它被吞了（不允许）
    expect(threw, '未知入参被当成没传静默放行').toBe(true)
    expect(calls).toHaveLength(0)
    await client.close()
  })

  /**
   * initialize 的 instructions 必须是**非空**且真的被 SDK 带出去（1.0.63）。
   * 之前它是空的 —— MCP 读者拿不到关口模型/身份任何一条规矩，只能犯错一次再学。
   */
  it('initialize 带上了非空的 instructions（MCP 读者的唯一说明书）', async () => {
    const { client } = await connect()
    const text = client.getInstructions()
    expect(typeof text).toBe('string')
    expect((text ?? '').length).toBeGreaterThan(100)
    // 必须真的讲到关键规矩，而不是一句占位
    expect(text).toContain('proposed')
    expect(text).toContain('ambiguous_identity')
    expect(text).toContain('get_profile')
    expect(text).toContain('get_protocol')
    expect(text).toContain('「审批」页')
    await client.close()
  })

  /* ── 1.0.68：工具表从 dp schema 生成（`69b9b651`）── */

  it('CLI 加了新命令，MCP 侧自动出现（不用手改 MCP 任何文件）', async () => {
    const { client } = await connect()
    // FAKE_SCHEMA_COMMANDS 里有 `todo close`，而它不在旧的 8 个手工工具里
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names, '`todo close` 没自动出现在 MCP —— 那这张卡白做了').toContain('close_todos')
  })

  it('自检与界面类命令被排除（对 agent 无意义，且不该扩大攻击面）', async () => {
    const { client } = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names, 'doctor 是自检类，不该给 agent').not.toContain('doctor')
    expect(names.some((n) => n.startsWith('ui_'))).toBe(false)
  })

  it('破坏性命令照常暴露，但注解标出来（授权交给宿主，不替它做决定）', async () => {
    const { client } = await connect()
    const tools = (await client.listTools()).tools
    const rm = tools.find((t) => t.name === 'rm_todos')
    expect(rm, '`todo rm` 应当暴露 —— 藏起来会让 agent 以为产品没有删除能力').toBeTruthy()
    expect(rm!.annotations?.destructiveHint, '删数据的必须标 destructive，宿主据此弹确认').toBe(true)
  })

  it('注解从 risk 派生（不是手写）', async () => {
    const { client } = await connect()
    const tools = (await client.listTools()).tools
    // ⚠️ 这三条断言的是**具体值**。我第一版只断言"存在"，
    // 那等于没验 —— 而"注解是否跟着 risk 走"正是这张卡要防的漂移。
    const list = tools.find((t) => t.name === 'list_todos')
    const close = tools.find((t) => t.name === 'close_todos')
    const rm = tools.find((t) => t.name === 'rm_todos')
    expect(list?.annotations?.readOnlyHint, 'todo list 是 read 档').toBe(true)
    expect(close?.annotations?.readOnlyHint, 'todo close 是 write 档，不该标成只读').toBe(false)
    expect(rm?.annotations?.destructiveHint, 'todo rm 是 destructive 档').toBe(true)
  })

  it('既有 8 个工具名一字未改（已有接入方在用，qwen 就是）', async () => {
    const { client } = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const legacy of ['add_todo', 'get_todo', 'list_todos', 'update_todo', 'comment_todo',
                           'create_project', 'list_projects', 'list_agents']) {
      expect(names, ).toContain(legacy)
    }
  })

  it('生成失败时退回手工表，MCP 仍能起（不能因生成失败就整体挂掉）', async () => {
    const server = await createMcpServer('0', async () => ({
      ok: false,
      code: 1,
      errorCode: 'boom',
      message: '模拟子进程起不来'
    }))
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    const tools = (await client.listTools()).tools
    const names = tools.map((t) => t.name)
    expect(names.length, '退回手工表后仍应有工具').toBeGreaterThan(0)
    expect(names).toContain('add_todo')

    /**
     * 降级必须**看得见**（1.0.107，修 `02ccb7ea`）。
     *
     * 原先只往 stderr 打一行日志，而宿主看不见 stderr —— `tools/list` 照常成功，
     * 接入方无从发现工具面塌了，只能按记忆发调用、收一片 not_found。
     * 这里盯住两个"宿主一定会读"的面：工具自己的 description 与 initialize 的 instructions。
     */
    const unmarked = tools.filter((t) => !String(t.description ?? '').includes('[降级'))
    expect(
      unmarked.map((t) => t.name),
      '降级时每个工具都要带标记 —— 少一个就有一处"看起来正常"'
    ).toEqual([])
    expect(
      String(client.getInstructions() ?? ''),
      'instructions 是握手时模型必读的那处，降级必须写在这里'
    ).toContain('[降级]')
  })

  /**
   * `text` 输出：stdout 不是 JSON 时**原样透传正文**（1.0.107，`a18681ae`）
   *
   * `get_guide` 映射到 CLI 的 `skill`，而 `skill` 输出的是 YAML 前置 + Markdown
   * —— 命令表里它**自己声明了** `output: 'text'`。按信封解析必然 `bad_output`，
   * 还把**整段说明书**塞进 `message`：一个"让接入方读说明书"的工具，
   * 读不到说明书，只收到一条夹着说明书的报错。
   *
   * 这里同时验**边界**：输出形态是 `json` 的工具遇到同一种输出，仍必须回错误信封 ——
   * 否则等于把"解析失败"伪装成正常输出，比原来的 `bad_output` 更难查。
   */
  it('text 输出的工具（get_guide）：Markdown 原样透传；json 输出的仍回错误信封', async () => {
    const MARKDOWN = '---\nname: desk-partner-todos\nversion: "1.0.107"\n---\n\n# DeskPartner：接入入口\n'
    const cmds = [
      { name: 'skill', desc: '说明书', readOnly: true, output: 'text', positional: { name: 'topic', desc: '主题' }, args: [] },
      { name: 'rules get', desc: '读规则', readOnly: true, args: [] }
    ]
    const server = await createMcpServer('0', async (argv, _actor, rawText) =>
      argv[0] === 'schema'
        ? { ok: true, data: { commands: cmds } }
        : rawText
          ? { ok: true, code: 0, rawText: MARKDOWN }
          : { ok: false, code: 1, errorCode: 'bad_output', message: 'CLI 子进程输出不是 JSON：---' }
    )
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])

    const guide = await client.callTool({ name: 'get_guide', arguments: { topic: 'core' } })
    expect(guide.isError, 'get_guide 不该再报错').toBe(false)
    expect(
      textOf(guide),
      '说明书正文应当原样透传：不是 JSON 信封，更不能是夹着正文的报错'
    ).toBe(MARKDOWN)

    const rules = await client.callTool({ name: 'get_rules', arguments: {} })
    expect(JSON.parse(textOf(rules)).errorCode, 'json 输出的工具必须仍然报解析失败').toBe(
      'bad_output'
    )
    await client.close()
  })

  /**
   * `ndjson` 输出：**每行一条**，不能当单份信封解析（1.0.107，`f99178d7`）
   *
   * `telemetry export` 的 stdout 是 NDJSON。此前一律按单份 JSON 解析，
   * 于是它**只有在恰好一条记录时才"成功"**，多一条就整段 `bad_output` ——
   * 一个导出工具，导出多条就不可用（卡上的现象：不带 limit 即失败）。
   *
   * 这里钉住三件事：① 多行不再被当成错误；② 条数从 `data.count` 直接可读
   * （卡上判据：与 limit 一致）；③ 命令声明成 `string` 的 `--limit` 收得下数字 `3`
   * —— 模型的自然写法，此前会被 JSON-RPC 以 -32602 拒掉。
   */
  it('ndjson 输出的工具（export_telemetry）：多记录不再 bad_output，条数可读', async () => {
    const LINES = [
      '{"ts":"2026-10-20T10:00:00Z","event":"tool_call","tool":"list_todos"}',
      '{"ts":"2026-10-20T10:00:01Z","event":"tool_call","tool":"get_todo"}',
      '{"ts":"2026-10-20T10:00:02Z","event":"tool_call","tool":"add_todo"}'
    ]
    const cmds = [
      {
        name: 'telemetry export',
        desc: '导出埋点',
        readOnly: true,
        output: 'ndjson',
        args: [{ flag: '--limit', type: 'string' }]
      }
    ]
    const seen: string[][] = []
    const server = await createMcpServer('0', async (argv, _actor, rawText) => {
      if (argv[0] === 'schema') return { ok: true, data: { commands: cmds } }
      seen.push(argv)
      return rawText
        ? { ok: true, code: 0, rawText: LINES.join('\n') }
        : { ok: false, code: 1, errorCode: 'bad_output', message: 'NDJSON 被当成了单份 JSON' }
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])

    // ① 不带 limit：多行也必须是数据，不是 bad_output
    //   （从 1.0.107 起这条 argv 还会兜上默认上界，见下面 7e321f6d 那条用例；这里只关心读法）
    const all = await client.callTool({ name: 'export_telemetry', arguments: {} })
    expect(all.isError, '多条 NDJSON 不该再被当成 bad_output').toBe(false)
    const body = JSON.parse(textOf(all))
    expect(body.ok).toBe(true)
    expect(body.data.count, '条数要从 data.count 读得到').toBe(3)
    expect(body.data.records).toHaveLength(3)
    expect(body.data.records[0]).toMatchObject({ tool: 'list_todos' })

    // ② 数字形式的 limit（schema 里声明的是 string）不能被 -32602 拒掉
    const limited = await client.callTool({ name: 'export_telemetry', arguments: { limit: 3 } })
    expect(limited.isError, '{"limit": 3} 不该因为 schema 是 string 就被拒').toBe(false)
    expect(JSON.parse(textOf(limited)).data.count, '返回条数与 limit 一致').toBe(3)
    expect(seen[1], '数字被 coerce 成 "3" 后照样拼进 argv').toEqual([
      'telemetry', 'export', '--limit=3'
    ])
    await client.close()
  })

  /**
   * 逐行输出的工具**默认有界**（1.0.107，修 `7e321f6d`）
   *
   * `export_telemetry` 不带 `limit` 时，MCP 侧把整份埋点聚成数组回给宿主：
   * 实测 **459,331 字节 / 1110 条**，一次调用就能撑满宿主上下文，而且**不报错**。
   * 处置与 `9fde5666` 当年给 `list_todos` 做的一样：**默认有界、不是硬上限**
   * —— 调用方显式传更大的 limit 仍照办。
   *
   * ⚠️ 这里断言的是**接线层**（`seen[0]` 里真的出现了 `--limit`），不是生成层：
   * 默认值就算在工具表里写着，接线断了症状完全一样 —— 无参调用仍旧全量。
   * `list_todos` 那条 1.0.63 的默认值就吃过这个亏：它写在 toArgv 里，
   * 只有对着拼出来的 argv 断言才验得到。
   */
  it('逐行输出的工具不带 limit 时兜上默认上界，显式传的仍然优先（7e321f6d）', async () => {
    const cmds = [
      {
        name: 'telemetry export',
        desc: '导出埋点',
        readOnly: true,
        output: 'ndjson',
        args: [{ flag: '--limit', type: 'string', desc: '最多导出多少条' }]
      }
    ]
    const seen: string[][] = []
    const server = await createMcpServer('0', async (argv, _actor, rawText) => {
      if (argv[0] === 'schema') return { ok: true, data: { commands: cmds } }
      seen.push(argv)
      return rawText
        ? { ok: true, code: 0, rawText: '{"event":"a"}' }
        : { ok: false, code: 1, errorCode: 'bad_output', message: 'NDJSON 被当成了单份 JSON' }
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])

    const all = await client.callTool({ name: 'export_telemetry', arguments: {} })
    expect(all.isError).toBe(false)
    expect(
      seen[0],
      '无参调用没兜上上界 —— 回执多大又由数据量决定，而数据量是调用方看不见的东西'
    ).toEqual(['telemetry', 'export', `--limit=${DEFAULT_ROW_LIMIT}`])

    const more = await client.callTool({ name: 'export_telemetry', arguments: { limit: 2000 } })
    expect(more.isError).toBe(false)
    expect(seen[1], '显式传的 limit 必须优先 —— 默认有界不等于硬上限').toEqual([
      'telemetry', 'export', '--limit=2000'
    ])
    await client.close()
  })
})