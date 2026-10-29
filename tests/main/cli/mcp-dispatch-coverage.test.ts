/**
 * MCP 派发覆盖闸门（1.0.107，`251eb399`）
 *
 * ## 它守的是什么
 *
 * `251eb399` 从 1.0.97 挂到 1.0.107：MCP 广播的工具里有 **9 个一次都派发不出去**
 * （`tools/call` 一律回「无法把工具名还原成命令」）。根因是"命令→工具名"与
 * "工具名→命令"各写了一张表，两张表漂了。
 *
 * 卡片【选项】里自己提的修法就是「**加 CI 闸门，遍历 `tools/list` 逐个派发**」——
 * 那条建议没落地，于是 1.0.101 新增的 `rules` 三件又掉了进去（同一个坑吃三次）。
 *
 * 这条闸门是那条建议在单测层的可执行版本。
 *
 * ## ⚠️ 为什么必须走 `buildToolsFromSchema`，不能只测 `toArgv(name, {}, routes)`
 *
 * 因为反向表就是从同一份 schema 派生的 —— 直接喂 `routes` 再断言"能还原"，
 * **恒真，是假闸门**（本项目在 `cli-wiring-gate.test.ts` 里已经栽过一次这种跟头：
 * "每个参数都在 schema 里"在当前结构下永远成立，写了等于没写）。
 *
 * 真会坏的地方是**接线**：`mcp-server.ts` 有没有把 `routes` 真的传下去。
 * 所以这里走完整条生成链路（假 invoke 喂真实 schema → 拿回工具表 → 逐个拼 argv），
 * 并配一条反向验证证明"不接 `routes` 就必须红"。
 */
import { describe, it, expect } from 'vitest'
import { buildToolRoutes, mcpToolName, RECORDS_PARAM, shouldExpose, toArgv } from '../../../src/cli/mcp-tools-from-schema'
import { buildSchema, commands } from '../../../src/main/cli/commands'
import type { SchemaCommand } from '../../../src/cli/mcp-tools-from-schema'

describe('MCP 派发覆盖闸门（251eb399）', () => {
  const schemaCommands = (buildSchema() as { commands: SchemaCommand[] }).commands
  /** 假 invoke：只认生成工具表要的那一次 `schema`，其余一律拒绝 */
  const fakeInvoke = async (argv: string[]) =>
    argv[0] === 'schema'
      ? { ok: true, data: { commands: schemaCommands } }
      : { ok: false, code: 2, errorCode: 'usage_error', message: '本闸门不执行业务命令' }

  it('扫到了真实的命令面（闸门自己别瞎了）', () => {
    expect(schemaCommands.length, '一条命令都扫不到 —— 这条闸门等于没跑').toBeGreaterThan(30)
    expect(commands.length, '命令表为空').toBeGreaterThan(30)
  })

  it('生成出来的每个工具，都能还原回一条真实命令（逐个拼 argv）', async () => {
    const { buildToolsFromSchema, TOOLS } = await import('../../../src/cli/mcp-server')
    const built = await buildToolsFromSchema(fakeInvoke)
    expect(built.source, '工具表退回了手工表 —— 生成链路坏了，闸门要按生成版判').toBe('schema')

    /**
     * 手工那 10 几个工具走**它们自己的** toArgv（参数默认值、`--brief` 之类都由它定），
     * 不属于这条闸门的范围 —— 它们有 `mcp-server.test.ts` 逐条断言。
     * 但"跳过"必须可核对：见下面那条"没有工具被静默跳过"。
     */
    const handwritten = new Set(TOOLS.map((t) => t.name))
    const names = new Set(schemaCommands.map((c) => c.name))
    const broken: string[] = []
    let checked = 0
    for (const tool of built.tools) {
      if (handwritten.has(tool.name)) continue
      const expected = schemaCommands.find((c) => mcpToolName(c.name) === tool.name)
      if (!expected) {
        broken.push(`${tool.name} 在命令表里找不到对应的命令名`)
        continue
      }
      checked += 1
      let joined: string
      try {
        joined = tool.toArgv({}).join(' ')
      } catch (e) {
        broken.push(`${tool.name} → 抛错：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      if (joined !== expected.name) broken.push(`${tool.name} → "${joined}"，应为 "${expected.name}"`)
      if (!names.has(expected.name)) broken.push(`${tool.name} → "${expected.name}" 不是真实命令`)
    }
    expect(checked, '一个生成工具都没查到 —— 闸门空转').toBeGreaterThan(30)
    expect(
      broken,
      '这些工具派发不出去（1.0.107 实测就是这 9 个）：\n  ' + broken.join('\n  ')
    ).toEqual([])
  })

  it('没有暴露的命令被静默跳过：要么在工具表里，要么是手工工具', async () => {
    const { buildToolsFromSchema, TOOLS } = await import('../../../src/cli/mcp-server')
    const built = await buildToolsFromSchema(fakeInvoke)
    const inTable = new Set(built.tools.map((t) => t.name))
    const handwritten = new Set(TOOLS.map((t) => t.name))
    const skipped = schemaCommands
      .filter((c) => shouldExpose(c.name))
      .map((c) => mcpToolName(c.name))
      .filter((n) => !inTable.has(n) && !handwritten.has(n))
    expect(skipped, '这些命令既没进工具表、又不是手工工具 —— 等于从 MCP 侧消失').toEqual([])
  })

  it('反向验证：不接 routes 的旧路径必须还原不出 release / rules / batch', () => {
    const routes = buildToolRoutes(schemaCommands)
    const withoutRoutes = (tool: string) => {
      try {
        return toArgv(tool, {}).join(' ')
      } catch {
        return '<抛错：无法把工具名还原成命令>'
      }
    }
    const withRoutes = (tool: string) => toArgv(tool, {}, routes).join(' ')
    const expected: Record<string, string> = {
      show_release: 'release show',
      list_release: 'release list',
      get_rules: 'rules get',
      list_rule_proposals: 'rules proposals',
      batch: 'batch'
    }
    for (const [tool, cmd] of Object.entries(expected)) {
      // 旧路径下必须坏 —— 否则说明这条闸门守的缺口根本不存在（假闸门）
      expect(
        withoutRoutes(tool),
        `${tool} 在旧路径下竟然还原成了 "${cmd}" —— 那这条闸门守的是什么？`
      ).not.toBe(cmd)
      // 带上 routes 之后同样这几个必须好
      expect(withRoutes(tool)).toBe(cmd)
    }
  })

  it('每个命令都建了 route，含被 EXCLUDE 的（过滤规则调整不该突然掐掉能力）', () => {
    const routes = buildToolRoutes(schemaCommands)
    const missing = schemaCommands.filter((c) => !routes.has(mcpToolName(c.name))).map((c) => c.name)
    expect(missing, '这些命令的工具名进不了反向表').toEqual([])
  })

  it('工具名互不重名（重名＝`tools/list` 两条同名、只有一条能派到）', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const c of schemaCommands) {
      if (!shouldExpose(c.name)) continue
      const tool = mcpToolName(c.name)
      const prev = seen.get(tool)
      if (prev) dup.push(`${tool}: ${prev} 与 ${c.name}`)
      else seen.set(tool, c.name)
    }
    expect(dup).toEqual([])
  })

  it('位置参数由命令自己声明，不靠写死的键名集合猜', () => {
    const routes = buildToolRoutes(schemaCommands)
    // `release show` 的位置参数叫 version —— 不在写死集合里，会被拼成 --version=
    expect(toArgv('show_release', { version: '1.0.107' }, routes)).toEqual(['release', 'show', '1.0.107'])
    // `agent grants` 没有位置参数、筛选靠 --id —— 写死集合里的 id 会把筛选**丢掉**
    expect(toArgv('grants_agents', { id: 'agent:x' }, routes)).toEqual(['agent', 'grants', '--id=agent:x'])
  })

  /**
   * 输出形态必须**从命令声明带进工具表**（1.0.107，`f99178d7` / `a18681ae`）
   *
   * `CommandSpec.output` 早就存在（`skill` 是 `text`、`telemetry export` 是 `ndjson`），
   * 只是没进 `buildSchema()` 的投影 —— 于是 MCP 侧一律按 JSON 信封解析：
   * 说明书读不到、埋点导出多条即 `bad_output`。
   *
   * 这条闸门盯的是**两跳**：① schema 投影带出来了没有；② 生成工具表时带上去了没有。
   * 少任何一跳，MCP 侧的读法就退回"全都按 JSON"，故障形态与原来一模一样。
   */
  it('非 json 的输出形态从命令声明一路传到工具表（不许中途丢）', async () => {
    const { buildToolsFromSchema } = await import('../../../src/cli/mcp-server')
    const nonJson = schemaCommands
      .filter((c) => shouldExpose(c.name) && (c.output ?? 'json') !== 'json')
      .map((c) => `${c.name}=${c.output}`)
      .sort()
    expect(
      nonJson,
      '命令表里声明非 json 输出的命令变了吗？变了就把下面两条期望一起更新'
    ).toEqual(['skill=text', 'telemetry export=ndjson'])

    const built = await buildToolsFromSchema(fakeInvoke)
    const kindOf = (n: string) => built.tools.find((t) => t.name === n)?.outputKind
    expect(kindOf('get_guide'), 'skill 的 text 没带到 get_guide 上 —— 说明书又会读不到').toBe('text')
    expect(
      kindOf('export_telemetry'),
      'telemetry export 的 ndjson 没带到 export_telemetry 上 —— 多条导出又会 bad_output'
    ).toBe('ndjson')
    expect(kindOf('get_rules'), '缺省应当按 json（最常见的形态）').toBe('json')
  })

  /**
   * 写工具必须都能按调用声明身份（1.0.107，修 `1c1cedb0`）
   *
   * `1c1cedb0` 报的是「27 个写工具只有 4 个带 `actor`」。核过之后：那 23 个缺口
   * 在 1.0.97 之后（`fec6f65`，10-16）已由**生成那一路**补齐 —— 但**手工表
   * 那一路没有同样的规矩**，于是 `create_project` 一直漏到 1.0.107：
   * 实测产物里 31 个写工具 30 个有、只有它没有，传 `actor` 撞「未知入参」。
   *
   * 判据：**「写工具必带 actor」得是一条能被 CI 检查的规矩，不是"记得改"。**
   * 这条闸门对着**真实命令表 + 真实手工表**产出的工具表逐个核：
   * 将来手工加一个写工具、或生成规则被改窄，都在这里红，而不是在用户的第一条写命令上红。
   */
  it('每个写工具都能按调用声明身份（readOnlyHint=false ⇒ 带 actor，且 handler 会读它）', async () => {
    const { buildToolsFromSchema } = await import('../../../src/cli/mcp-server')
    const built = await buildToolsFromSchema(fakeInvoke)

    const writers = built.tools.filter((t) => t.annotations?.readOnlyHint === false)
    expect(writers.length, '一个写工具都没扫到 —— 闸门瞎了').toBeGreaterThan(20)

    /**
     * 两处缺一不可：`input.actor` 决定客户端传它会不会被 `unknownInputKeys`
     * 当未知入参拒掉；`actor: true` 决定 handler 会不会把它读出来落进子进程环境。
     * 只查一处就会漏掉"收下了却不生效"那种（本文件最早的 P0 事故就是这个形状）。
     */
    const missing = writers
      .filter((t) => !Object.prototype.hasOwnProperty.call(t.input, 'actor') || t.actor !== true)
      .map(
        (t) =>
          `${t.name}（input.actor=${Object.prototype.hasOwnProperty.call(t.input, 'actor')}, actor=${t.actor}）`
      )
    expect(
      missing,
      '这些写工具声明不了身份 —— 多凭据宿主上只剩改服务进程环境一条路（1.0.63 注释自己点名过「不可执行」）'
    ).toEqual([])

    // 反向：读工具不该多一个身份入参。多一个就是第二套判据，且会误导宿主。
    const readersWithActor = built.tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .filter((t) => Object.prototype.hasOwnProperty.call(t.input, 'actor'))
      .map((t) => t.name)
    expect(readersWithActor, '读工具不该带 actor（读的身份没有意义，只会让宿主多填一个）').toEqual([])
  })

  /**
   * 命令声明的 stdin 通道必须一路传到工具表（1.0.107，修 `0a9f42f8`）
   *
   * 与上面那条 `output` 的闸门同构，盯的也是**两跳**：
   * ① `buildSchema()` 有没有把 `CommandSpec.stdin` 投影出来；
   * ② 生成工具表时有没有把它变成 `records` 入参 + `stdinKind`。
   *
   * 少任何一跳，MCP 的 `batch` 就又变成一个"送不进内容"的空壳：
   * 工具在 `tools/list` 里挂着，调它只能得到「stdin 为空」（实测就这么回）。
   * 判据与 `output` 一样：**声明了却没有出口，等于没声明。**
   */
  it('从 stdin 读记录的命令：声明一路带到工具表（records + stdinKind）', async () => {
    const { buildToolsFromSchema } = await import('../../../src/cli/mcp-server')
    const declared = schemaCommands
      .filter((c) => shouldExpose(c.name) && c.stdin)
      .map((c) => `${c.name}=${c.stdin}`)
      .sort()
    expect(
      declared,
      '命令表里声明 stdin 的命令变了吗？变了就把下面的期望一起更新'
    ).toEqual(['batch=ndjson'])

    const built = await buildToolsFromSchema(fakeInvoke)
    const tool = built.tools.find((t) => t.name === 'batch')
    expect(tool, 'batch 不在工具表里').toBeTruthy()
    expect(
      Object.keys(tool!.input),
      'batch 少了 records 入参 —— 从 MCP 调它又只能回「stdin 为空」'
    ).toContain(RECORDS_PARAM)
    expect(tool!.stdinKind, 'stdinKind 没带过去 —— handler 不会把记录喂进子进程 stdin').toBe(
      'ndjson'
    )

    // 反向：别的工具不该有这个东西（多一个就是第二套判据）
    const others = built.tools.filter((t) => t.stdinKind !== undefined).map((t) => t.name)
    expect(others, '只有声明了 stdin 的命令才该有 stdinKind').toEqual(['batch'])
  })

  /**
   * 逐行输出的命令必须兜得上默认上界（1.0.107，修 `7e321f6d`）
   *
   * 通道侧的上界靠"替它补 `--limit`"实现，所以**每条逐行输出的命令都必须声明 `--limit`**
   * —— 少这一条，某个新导出工具就会成为又一条"回执多大由数据量决定"的路，
   * 而没有任何东西会红（实测 `export_telemetry` 无参调用回 459KB / 1110 条，且**不报错**）。
   *
   * 与上面 `output` / `stdin` 两条闸门同构，盯的也是**两跳**：
   * ① 命令的声明能让通道兜得上（它得有 `--limit`）；
   * ② 生成工具表时这件事得带出去（`defaultLimitKey`）。
   * 少任何一跳，MCP 侧就又变回"无参调用有多大回多大"。
   */
  it('逐行输出的命令都兜得上默认上界（有 --limit，且工具表里带 defaultLimitKey）', async () => {
    const { buildToolsFromSchema } = await import('../../../src/cli/mcp-server')
    const { DEFAULT_ROW_LIMIT } = await import('../../../src/cli/mcp-tools-from-schema')

    const rowCmds = schemaCommands.filter((c) => shouldExpose(c.name) && c.output === 'ndjson')
    expect(
      rowCmds.map((c) => c.name).sort(),
      '逐行输出的命令变了吗？变了就把下面两条期望一起更新'
    ).toEqual(['telemetry export'])
    const unbounded = rowCmds
      .filter((c) => !(c.args ?? []).some((a) => a.flag === '--limit'))
      .map((c) => c.name)
    expect(
      unbounded,
      '这些命令逐行输出、却没有 --limit —— 通道侧兜不上界，无参调用就有多大回多大'
    ).toEqual([])

    const built = await buildToolsFromSchema(fakeInvoke)
    const tool = built.tools.find((t) => t.name === 'export_telemetry')
    expect(tool, 'export_telemetry 不在工具表里').toBeTruthy()
    expect(
      tool!.defaultLimitKey,
      'defaultLimitKey 没带到工具表 —— handler 不会替它兜 --limit，上界等于没设'
    ).toBe('limit')
    expect(DEFAULT_ROW_LIMIT, '默认上界得是个正数（0 或负数会让"默认有界"变成"默认什么都没有"）').toBeGreaterThan(0)

    // 反向：别的工具不该有这个键（多一个就是第二套判据）
    expect(
      built.tools.filter((t) => t.defaultLimitKey !== undefined).map((t) => t.name),
      '只有逐行输出的命令才该有 defaultLimitKey'
    ).toEqual(['export_telemetry'])
  })
})
