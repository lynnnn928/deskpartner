import { describe, it, expect } from 'vitest'
import {
  buildToolRoutes,
  DEFAULT_ROW_LIMIT,
  generateMcpTools,
  mcpToolName,
  RECORDS_PARAM,
  shouldExpose,
  toArgv
} from '../../../src/cli/mcp-tools-from-schema'
import { z } from 'zod'

/**
 * MCP 工具表从 `dp schema` 生成（`69b9b651`）
 *
 * ## 它治的病
 *
 * 工具表一直是**手工挑出来的 8 个**，CLI 有 44 条。加了新命令就"记得同步" ——
 * 而这正是本产品自己定的规矩要治的病。
 *
 * 实测后果（10-07 核代码）：
 * - 1.0.67 的 `todo close`（四段收口）**MCP 侧没有**
 *   ⇒ **从 MCP 接入的 agent 做不出收口**，而"待验收要有收口结论"是验收纪律
 * - 1.0.68 的 5 件（收口/通知判据/去重/对账/废弃列）**一件都没暴露**
 */
describe('MCP 工具表从 schema 生成（69b9b651）', () => {
  const CMDS = [
    { name: 'todo list', desc: '查待办', risk: 'read', readOnly: true, args: [{ flag: '--status', type: 'enum', enum: ['any', 'todo'] }] },
    { name: 'todo update', desc: '改待办', risk: 'write', positional: { name: 'id', required: true }, args: [{ flag: '--title', type: 'string' }] },
    { name: 'todo rm', desc: '删待办', risk: 'destructive', positional: { name: 'id', required: true }, args: [] },
    { name: 'todo close', desc: '四段收口', risk: 'write', positional: { name: 'id', required: true },
      args: [{ flag: '--did', type: 'string' }, { flag: '--verified', type: 'string' }] },
    { name: 'doctor', desc: '自检', risk: 'read', readOnly: true, args: [] }
  ]

  it('CLI 加了新命令就自动出现（这是这张卡存在的全部理由）', () => {
    const tools = generateMcpTools(CMDS as never, z)
    expect(
      tools.map((t) => t.name),
      '`todo close` 没自动出现 = CLI 加命令后还得手改 MCP = 这张卡白做了'
    ).toContain('close_todos')
  })

  it('仅自检与界面类被排除，Skill 作为 get_guide 暴露', () => {
    expect(shouldExpose('doctor')).toBe(false)
    expect(shouldExpose('skill')).toBe(true)
    expect(mcpToolName('skill')).toBe('get_guide')
    expect(shouldExpose('schema')).toBe(false)
    expect(shouldExpose('ui set')).toBe(false)
    expect(shouldExpose('telemetry clear')).toBe(false)
  })

  /**
   * 破坏性命令**照常暴露**。
   *
   * 判据：**授权交给宿主（`destructiveHint`），不该由工具表替宿主做决定**。
   * 藏起来的后果更糟 —— agent 会以为"产品没有删除能力"，于是它去写库。
   */
  it('破坏性命令照常暴露，但注解标出来', () => {
    const tools = generateMcpTools(CMDS as never, z)
    const rm = tools.find((t) => t.name === 'rm_todos')
    expect(rm, '`todo rm` 应当暴露').toBeTruthy()
    expect(rm!.annotations.destructiveHint).toBe(true)
  })

  it('注解从 risk 派生（不是手写 —— 手写就是第二套判据，迟早漂）', () => {
    const tools = generateMcpTools(CMDS as never, z)
    const at = (n: string) => tools.find((t) => t.name === n)!.annotations
    expect(at('list_todos').readOnlyHint, 'read 档').toBe(true)
    expect(at('close_todos').readOnlyHint, 'write 档不该标只读').toBe(false)
    expect(at('rm_todos').destructiveHint, 'destructive 档').toBe(true)
    expect(at('list_todos').destructiveHint).toBe(false)
  })

  it('所有生成的写工具都声明 actor，且 actor 不会伪装成 CLI flag', () => {
    const tools = generateMcpTools(CMDS as never, z)
    expect(tools.find((t) => t.name === 'close_todos')?.actor).toBe(true)
    expect(tools.find((t) => t.name === 'rm_todos')?.actor).toBe(true)
    expect(tools.find((t) => t.name === 'list_todos')?.actor).toBe(false)
    expect(toArgv('close_todos', { id: 'abc', did: '完成', actor: 'agent:test' })).toEqual([
      'todo', 'close', 'abc', '--did=完成'
    ])
  })

  it('get_guide 能反向还原 skill 主题读取', () => {
    expect(toArgv('get_guide', { topic: 'project' })).toEqual(['skill', 'project'])
  })

  it('生成的 profile/protocol/handoff proposal 工具可反向还原命令', () => {
    expect(toArgv('propose_protocol', {
      project: 'DeskPartner', block: 'language', body: '简体中文', actor: 'agent:test'
    })).toEqual([
      'protocol', 'propose', '--project=DeskPartner', '--block=language', '--body=简体中文'
    ])
    expect(toArgv('propose_handoff', {
      id: 'project-id', body: '新的接手说明', actor: 'agent:test'
    })).toEqual(['project', 'handoff-propose', 'project-id', '--body=新的接手说明'])
    expect(toArgv('list_handoff_proposals', { all: true })).toEqual([
      'project', 'handoff-proposals', '--all'
    ])
  })

  it('生成工具的输入 schema 显式声明 actor', () => {
    const tools = generateMcpTools(CMDS as never, z)
    const write = tools.find((t) => t.name === 'close_todos')!
    expect(write.input.actor).toHaveProperty('def')
    const read = tools.find((t) => t.name === 'list_todos')!
    expect(read.input.actor).toBeUndefined()
  })

  /**
   * 命名一致性 —— 实测踩到的三个形状。
   *
   * 判据：**工具名是给人与模型读的，命名不一致本身就是缺陷**。
   * "凑合能用"正是本产品反复在治的那类将就。
   */
  it('命名：多词命令的下划线要转（delete-comment_todo 是混用）', () => {
    expect(mcpToolName('todo delete-comment')).toBe('delete_comment_todos')
    expect(mcpToolName('todo set-owner')).toBe('set_owner_todos')
  })

  it('命名：复数与既有风格一致（list_todos 而非 list_todo）', () => {
    expect(mcpToolName('memo list')).toBe('list_memos')
    expect(mcpToolName('category add')).toBe('add_categories')
    expect(mcpToolName('notification list')).toBe('list_notifications')
    // telemetry 是动作名不是对象，不该复数化
    expect(mcpToolName('telemetry stats')).toBe('stats_telemetry')
  })

  /**
   * 往返必须通 —— **这是最容易漏的一环**。
   *
   * 我第一版 `toArgv` 的还原正则只认单数，于是 `list_todos`（既有约定的名字）
   * 一旦从生成版被调用就抛"无法还原"。**而它恰好是最常用的那个。**
   */
  it('名字能还原回命令（往返通）', () => {
    const cmds = [
      'todo close', 'todo list', 'todo set-owner', 'todo delete-comment',
      'memo add', 'memo list', 'category add', 'category list',
      'agent register', 'agent whoami', 'notification list',
      'telemetry stats', 'project add', 'project list', 'project get', 'project search',
      'project handoff-history', 'project handoff-revision', 'project handoff-rollback',
      'project handoff-propose', 'project handoff-proposals'
    ]
    for (const c of cmds) {
      const name = mcpToolName(c)
      const back = toArgv(name, {}).join(' ')
      expect(back, `${c} → ${name} 还原不回去`).toBe(c)
    }
  })

  it('既有 8 个工具名一字不改（已有接入方在用，qwen 就是）', () => {
    expect(mcpToolName('todo add')).toBe('add_todo')
    expect(mcpToolName('todo get')).toBe('get_todo')
    expect(mcpToolName('todo list')).toBe('list_todos')
    expect(mcpToolName('todo update')).toBe('update_todo')
    expect(mcpToolName('todo comment')).toBe('comment_todo')
    expect(mcpToolName('project add')).toBe('create_project')
    expect(mcpToolName('project list')).toBe('list_projects')
    expect(mcpToolName('project get')).toBe('get_project')
    expect(mcpToolName('project search')).toBe('search_project')
    expect(mcpToolName('project handoff-history')).toBe('list_handoff_revisions')
    expect(mcpToolName('project handoff-revision')).toBe('get_handoff_revision')
    expect(mcpToolName('project handoff-rollback')).toBe('rollback_handoff')
    expect(mcpToolName('agent list')).toBe('list_agents')
  })

  it('参数值用 `=` 拼（值以 - 开头时不会被当成另一个 flag）', () => {
    // ⚠️ 必须用**生成版**的名字测：既有 8 个手工工具走它们自己的 toArgv
    // （那里是空格分隔），拿 add_todo 测只会测到手工版、测不到生成版。
    // 而这条 CLI 自己就是这么修的：拆成两个 token 时 `--help` 会被当成另一个 flag。
    const argv = toArgv('add_todos', { title: '-x' })
    expect(argv.some((a) => a === '--title=-x'), '实际: ' + JSON.stringify(argv)).toBe(true)
    expect(argv.some((a) => a === '--title'), '不该把值拆成两个 token').toBe(false)
  })

  it('布尔 true 才带 flag，false 不带（`--yes false` 会把 "false" 掉进位置参数）', () => {
    expect(toArgv('rm_todos', { id: 'abc', yes: true })).toContain('--yes')
    expect(toArgv('rm_todos', { id: 'abc', yes: false })).not.toContain('--yes')
  })

  it('位置参数不挂 flag（id 就是 id，不是 --id）', () => {
    expect(toArgv('get_todo', { id: 'abc123' })).toEqual(['todo', 'get', 'abc123'])
  })

  /**
   * 反向表从 schema 派生（1.0.107，`251eb399`）
   *
   * 上面那条「名字能还原回命令（往返通）」测的是**我记得的那几个名字** ——
   * 所以它一直绿，而 1.0.107 实测有 9 个工具派发不出去。
   * 这里测的是"给了 schema 就必须全部还原得出"，且
   * **未覆盖的命令面**由 `mcp-dispatch-coverage.test.ts` 对着真实命令表把关。
   */
  describe('反向表从 schema 派生（251eb399）', () => {
    const REAL_SHAPES = [
      { name: 'batch', desc: '批处理', readOnly: true, args: [{ flag: '--dry-run', type: 'boolean' }] },
      { name: 'release list', desc: '列版本', readOnly: true, args: [{ flag: '--project', type: 'string' }] },
      { name: 'release show', desc: '看版本', readOnly: true, positional: { name: 'version', required: true, desc: '版本号' }, args: [{ flag: '--project', type: 'string' }] },
      { name: 'release rm', desc: '删版本', risk: 'destructive', positional: { name: 'version', required: true, desc: '版本号' }, args: [{ flag: '--yes', type: 'boolean' }] },
      { name: 'rules get', desc: '读规则', readOnly: true, args: [{ flag: '--project', type: 'string' }] },
      { name: 'rules proposals', desc: '读规则提议', readOnly: true, args: [{ flag: '--all', type: 'boolean' }] },
      { name: 'agent grants', desc: '列授权', readOnly: true, args: [{ flag: '--id', type: 'string' }] },
      {
        name: 'skill',
        desc: '说明书',
        readOnly: true,
        positional: { name: 'topic', required: false, desc: '主题' },
        args: [],
        output: 'text'
      },
      {
        name: 'telemetry export',
        desc: '导出埋点',
        readOnly: true,
        output: 'ndjson',
        args: [{ flag: '--limit', type: 'string' }]
      }
    ]

    it('这批真实形状全都能还原（就是实测派发不出去的那批）', () => {
      const routes = buildToolRoutes(REAL_SHAPES as never)
      const broken: string[] = []
      for (const c of REAL_SHAPES) {
        const tool = mcpToolName(c.name)
        const back = toArgv(tool, {}, routes).join(' ')
        if (back !== c.name) broken.push(`${c.name} → ${tool} → "${back}"`)
      }
      expect(
        broken,
        '这些工具派发不出去（1.0.107 实测就是这 9 个里的）：\n  ' + broken.join('\n  ')
      ).toEqual([])
    })

    it('位置参数只认命令自己声明的那个（写死集合的两个反例）', () => {
      const routes = buildToolRoutes(REAL_SHAPES as never)
      // `release show` 的位置参数叫 version —— 不在写死集合里，会被拼成 --version=
      expect(toArgv('show_release', { version: '1.0.107' }, routes)).toEqual([
        'release', 'show', '1.0.107'
      ])
      // `agent grants` 没有位置参数、筛选靠 --id —— 写死集合里的 id 会把筛选丢掉
      expect(toArgv('grants_agents', { id: 'agent:x' }, routes)).toEqual([
        'agent', 'grants', '--id=agent:x'
      ])
    })

    it('没传 routes 时仍走旧的兜底表与正则（兼容路径不许断）', () => {
      expect(toArgv('list_todos', {})).toEqual(['todo', 'list'])
      expect(toArgv('close_todos', { id: 'abc', actor: 'agent:t' })).toEqual(['todo', 'close', 'abc'])
    })

    /**
     * 输出形态**从命令声明派生**（1.0.107，修 `f99178d7`）。
     *
     * 早先这里有一份手写的 `NON_JSON_STDOUT` 名单 —— 而 `output` 在命令表里
     * 早就声明过了、只是没进 schema。两份名单迟早漂，正是本文件反复在治的病。
     */
    it('输出形态从命令声明派生：skill → text、telemetry export → ndjson、没声明按 json', () => {
      const tools = generateMcpTools(REAL_SHAPES as never, z)
      const kind = (n: string) => tools.find((t) => t.name === n)?.outputKind
      expect(kind('get_guide'), 'skill 的 stdout 是 YAML + Markdown').toBe('text')
      expect(kind('export_telemetry'), 'telemetry export 的 stdout 是 NDJSON').toBe('ndjson')
      expect(kind('get_rules'), '没声明 output 的命令按 json —— 那是缺省最该当成的东西').toBe('json')
    })

    it('字符串参数收下数字（{"limit": 3} 不该被 -32602 拒掉）', () => {
      const tools = generateMcpTools(REAL_SHAPES as never, z)
      const exp = tools.find((t) => t.name === 'export_telemetry')!
      const schema = exp.input.limit as { parse: (v: unknown) => unknown }
      expect(schema.parse(3), '数字 3 应当被收成 "3"').toBe('3')
      expect(schema.parse('3')).toBe('3')
    })
  })

  /**
   * `describe` 必须用方法链，不能用 `+` 拼字符串。
   *
   * 我第一版写成 `z.string().optional() + '.describe(...)'` ——
   * 那是在拼字符串，产物是 `"[object Object].describe(...)"`，
   * SDK 读 `.def` 时直接抛 `Cannot read properties of undefined (reading 'def')`。
   * **tsc 全绿、单元测试也过，只有真连 SDK 才炸。**
   */
  /**
   * 从 stdin 读记录的命令要有"送记录"的入口（1.0.107，修 `0a9f42f8`）
   *
   * 命令声明 `stdin: 'ndjson'`，生成工具表时就得补一个 `records` 数组入参 ——
   * MCP 侧没有管道，不补的话工具会挂在 `tools/list` 里，却永远只能回「stdin 为空」。
   * 与 `output` 同源：**能力由命令声明，通道按声明派生**。
   */
  describe('stdin 通道：从 stdin 读记录的命令（0a9f42f8）', () => {
    const WITH_STDIN = [
      {
        name: 'batch',
        desc: '批量执行',
        risk: 'write',
        stdin: 'ndjson',
        args: [{ flag: '--dry-run', type: 'boolean' }]
      },
      { name: 'todo list', desc: '查待办', risk: 'read', readOnly: true, args: [] }
    ]

    it('声明了 stdin 的命令才有 records 入参，且带上 stdinKind', () => {
      const tools = generateMcpTools(WITH_STDIN as never, z)
      const batch = tools.find((t) => t.name === 'batch')!
      expect(Object.keys(batch.input), 'batch 少了送记录的入口').toContain(RECORDS_PARAM)
      expect(batch.stdinKind, 'stdinKind 没带到工具上 —— handler 就不知道要喂 stdin').toBe('ndjson')
      const list = tools.find((t) => t.name === 'list_todos')!
      expect(Object.keys(list.input), '读工具不该有 records').not.toContain(RECORDS_PARAM)
      expect(list.stdinKind).toBeUndefined()
    })

    it('records 是可选的数组；且绝不混进 argv（不是 CLI flag）', () => {
      const routes = buildToolRoutes(WITH_STDIN as never)
      const tools = generateMcpTools(WITH_STDIN as never, z)
      const schema = tools.find((t) => t.name === 'batch')!.input[RECORDS_PARAM] as {
        parse: (v: unknown) => unknown
      }
      expect(schema.parse(undefined), '不传就该是"没有东西要喂"').toBeUndefined()
      expect(schema.parse([{ cmd: 'todo add' }, '{"cmd":"todo done"}']), '两种形态都收').toEqual([
        { cmd: 'todo add' },
        '{"cmd":"todo done"}'
      ])
      expect(
        toArgv('batch', { records: [{ cmd: 'todo add' }], dry_run: true }, routes),
        'records 混进 argv 会让命令收到一个不认识的 flag'
      ).toEqual(['batch', '--dry-run'])
    })
  })
})

/**
 * 逐行输出（`ndjson`）的命令在通道侧**默认有界**（1.0.107，修 `7e321f6d`）
 *
 * ## 它治的病
 *
 * `export_telemetry` 不带 `limit` 时，MCP 侧把整份埋点聚成 `records` 数组回给宿主：
 * 实测 **459,331 字节 / 1110 条**（本机埋点全量）。一次工具调用就能把宿主上下文撑满，
 * 而且**不报错** —— 回执是 `ok`。这与 `9fde5666` 治过的"一次 `list_todos` 回
 * 456,206 字符"是同一个病，处置也用同一手法：**默认有界，不是硬上限**。
 *
 * ## 判据只取自命令自己的声明
 *
 * `output: 'ndjson'`（它逐行吐、可能很长）+ 它声明了 `--limit`（它能收窄）——
 * 两条都从命令表来，不在这里再写一份"哪些命令要兜"的名单。
 * 少任何一条都兜不上：那张"逐行输出的命令必须有 `--limit`"的网由
 * `mcp-dispatch-coverage.test.ts` 的闸门盯着。
 */
describe('逐行输出的默认上界（7e321f6d）', () => {
  const WITH_NDJSON = [
    {
      name: 'telemetry export',
      desc: '导出埋点',
      readOnly: true,
      output: 'ndjson',
      args: [{ flag: '--limit', type: 'string', desc: '最多导出多少条' }]
    },
    // 同样有 --limit，但不是逐行输出 —— 上界只挂逐行那一类
    { name: 'todo list', desc: '查待办', readOnly: true, args: [{ flag: '--limit', type: 'string' }] },
    // 逐行输出却没有 --limit —— 通道侧兜不上界（闸门会拦这种命令）
    { name: 'telemetry tail', desc: '逐行但无 limit', readOnly: true, output: 'ndjson', args: [] }
  ]

  it('只有"逐行输出 + 声明了 --limit"的命令带 defaultLimitKey', () => {
    const tools = generateMcpTools(WITH_NDJSON as never, z)
    const key = (n: string) => tools.find((t) => t.name === n)?.defaultLimitKey
    expect(
      key('export_telemetry'),
      '没带 key —— handler 就不会替它兜 --limit，无参调用仍会灌满宿主上下文'
    ).toBe('limit')
    expect(key('list_todos'), 'json 信封类命令不挂它（体量另有约束）').toBeUndefined()
    expect(key('tail_telemetry'), '没声明 --limit 就兜不上 —— 这类命令该被闸门拦下').toBeUndefined()
  })

  it('默认值写进参数的说明里（调用方要在调用之前就能读到）', () => {
    const tools = generateMcpTools(WITH_NDJSON as never, z)
    const limit = tools.find((t) => t.name === 'export_telemetry')!.input.limit as {
      description?: string
    }
    const desc = limit.description ?? ''
    expect(desc, '默认值不在说明里 —— 调用方读了也不知道不传会拿到多少').toContain(
      `默认 ${DEFAULT_ROW_LIMIT} 条`
    )
    // 说明是**追加**，不是覆盖：命令自己那句"最多导出多少条"必须还在
    expect(desc, '命令自己的说明被覆盖了').toContain('最多导出多少条')
  })
})
