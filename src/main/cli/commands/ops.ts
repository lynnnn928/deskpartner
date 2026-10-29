/**
 * 诊断与埋点命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * ⚠️ 为什么这个文件导出**多段**：原表里它们被别的域隔开（不是按域连续排的），
 *    而顺序不能改。各段在 `command-table.ts` 的聚合处按原次序展开：
 *      · doctorCommands
 *      · telemetryCommands
 */

import { UsageError } from '../../lib/domain-errors'
import { resolveLauncherPath } from '../agent-guide'
import { listSnapshots } from '../../database/migrations'
import fs from 'node:fs'
import { LIMIT_ZERO_DOC, parseLimit, parseOffset } from '../command-text'
import type { CommandSpec } from '../command-core'

export const doctorCommands: CommandSpec[] = [
  {
    name: 'doctor',
    dataShape: 'object',
    readOnly: true,
    desc: '环境自检：版本、任务库路径、数据结构版本、当前可用通道',
    args: [
      {
        flag: '--json',
        type: 'boolean',
        desc: '兼容写法，可省略：输出向来就是 JSON'
      }
    ],
    run: (ctx) => ({
      version: ctx.meta.version,
      /**
       * 接入说明（dp skill 生成物）的版本 —— 它就是 CLI 版本，
       * 因为说明由 CLI 自己生成、与 CLI 同代。
       *
       * 有了这一项，agent 一次自省就能知道手上的 skill 差多少代：
       * 自己那份 frontmatter 的 version 低于这里，就该重跑 dp skill。
       * （Bob 3f90eab6：本机散着三份说明书副本，谁新谁旧只能逐字节 diff。）
       */
      skillVersion: ctx.meta.version,
      declaredSkillVersion: ctx.skillVersion ?? null,
      dbPath: ctx.meta.dbPath,
      schemaVersion: ctx.meta.schemaVersion,
      /** 并发相关配置，出问题时要能直接读到而不是猜 */
      concurrency: {
        busyTimeoutMs: ctx.meta.busyTimeoutMs,
        writeRetry: 'SQLITE_BUSY / LOCKED / READONLY 时最多重试 3 次，线性退避（仅限能确认未写入的错误）'
      },
      channels: ctx.meta.channels,
      via: ctx.meta.via,
      /**
       * CLI 启动器寻址状态（1.0.49，Bob 8bf64514「寻址三件套」第三件）
       *
       * 为什么要报这一项：说明书（`dp skill` 生成物）教 agent 用
       * `$DESKPARTNER_CLI` 变量寻址，并把绝对路径降级成兜底。
       * 但"教了怎么用"与"能不能核实"是两件事 —— 若不在这里报出来，
       * agent 拿到一份说明书后**无法自证**变量在不在、指的还对不对，
       * 于是又会退回到硬写绝对路径（那正是这条缺陷要解决的问题）。
       *
       * `source` 三态，各自对应一句能直接照做的处置：
       * - `env`：变量在且文件真实存在 —— 正常，照说明书用即可。
       * - `env-missing-file`：变量在但**文件不在**（被挪走/卸载残留）——
       *   这是最坏的一种：命令会报"找不到文件"，而变量看着"配好了"。
       * - `fallback`：变量没写（开发态 / 没启动过 GUI）—— 用实测路径兜底。
       *
       * ⚠️ 读的是**当前进程环境**。GUI 刚写过变量而本进程在广播之前启动时，
       * 可能读到空 —— 所以 `fallback` 不等于"变量从未写过"，
       * 只能说"本进程没看到"。措辞上不要写成断言。
       */
      cli: (() => {
        const fromEnv = process.env.DESKPARTNER_CLI?.trim() || null
        const fallback = resolveLauncherPath()
        const effective = fromEnv ?? fallback
        let exists = false
        try {
          exists = fs.existsSync(effective)
        } catch {
          /* 路径含非法字符等 —— 当作不存在 */
        }
        const source: 'env' | 'env-missing-file' | 'fallback' = !fromEnv
          ? 'fallback'
          : exists
            ? 'env'
            : 'env-missing-file'
        return {
          envVar: 'DESKPARTNER_CLI',
          value: effective.replace(/\\/g, '/'),
          source,
          exists,
          note:
            source === 'env'
              ? '已用环境变量寻址，安装目录搬家也不会失效'
              : source === 'env-missing-file'
                ? '变量指向的文件不存在 —— DeskPartner 可能被挪走或卸载了。请让用户重新安装，或启动一次界面让它重写这个变量'
                : '本进程没读到环境变量（开发态，或界面还没启动过）。当前用实测路径兜底'
        }
      })(),
      /**
       * 还剩几条退路（1.0.49，修主用户 0c05da32）
       *
       * 她的原话：「恢复完成后在界面上回报当前可用快照清单，
       * 让人知道自己还剩几条退路」。
       *
       * 为什么必须报出来：快照是**唯一**能救回"导入改坏了"的东西，
       * 而它原先会因两件事静默消失 —— ①恢复是移动不是复制（用一次少一份）；
       * ②`pruneOldBackups` 把 `-wal`/`-shm` 当独立快照计数，导致实际保留数
       * 与"看到的主文件数"对不上。实测撞到的形状是：目录里只剩一个孤儿
       * `-shm`，主文件不见，人以为自己还有两份快照，实际一份都没有。
       *
       * `orphanSidecars` 单独报而不是悄悄删：它的存在本身就是
       * "主文件被搬走了"的证据，删掉等于销毁现场。
       */
      snapshots: (() => {
        const s = listSnapshots(ctx.meta.dbPath)
        return {
          count: s.snapshots.length,
          latest: s.snapshots[0]
            ? {
                name: s.snapshots[0].name,
                at: new Date(s.snapshots[0].mtimeMs).toISOString(),
                sizeMB: Number((s.snapshots[0].sizeBytes / 1024 / 1024).toFixed(1))
              }
            : null,
          all: s.snapshots.map((x) => x.name),
          /** 孤儿 sidecar：主文件已不在，留着会让人误判还有备份 */
          orphanSidecars: s.orphanSidecars,
          note:
            s.snapshots.length === 0
              ? '没有可用快照。导入/迁移改坏数据时将无法从快照恢复 —— 请先在界面「数据管理」里导出一份 JSON 备份'
              : `共 ${s.snapshots.length} 份可回滚快照（保留最近 2 份，旧的会自动清理）`
        }
      })(),
      note:
        ctx.meta.via === 'pipe'
          ? '本次经常驻管道（通道 A）执行，界面正在运行'
          : '本次以无头模式（通道 B）执行，界面未运行或管道不可用'
    })
  },
]

export const telemetryCommands: CommandSpec[] = [
  {
    name: 'telemetry stats',
    dataShape: 'object',
    readOnly: true,
    desc:
      '查看本地使用埋点的汇总（总量、各维度分布、耗时分位、**失败分两桶**）',
    args: [
      {
        flag: '--since',
        type: 'string',
        desc:
          '起始时间（ISO 8601）。看失败分布时建议显式指定 —— 早期事件没有 cmd 归因，' +
          '混进来会误读（返回里的 attributionCoverage 会告诉你这批有多少条归因不上）'
      },
      { flag: '--until', type: 'string', desc: '结束时间（ISO 8601）' },
      { flag: '--category', type: 'string', desc: '只看某个大类' }
    ],
    run: (ctx, flags) =>
      ctx.deps.telemetry.stats({
        since: flags['--since'] ? String(flags['--since']) : undefined,
        until: flags['--until'] ? String(flags['--until']) : undefined,
        category: flags['--category'] ? String(flags['--category']) : undefined
      })
  },
  {
    name: 'telemetry export',
    readOnly: true,
    desc: '导出埋点原始数据，stdout 为纯 NDJSON（每行一条），可直接重定向成文件带走',
    args: [
      { flag: '--since', type: 'string', desc: '起始时间（ISO 8601）' },
      {
        flag: '--limit',
        type: 'string',
        desc: `最多导出多少条；**默认取最新的 N 条**（输出仍按时间正序），排障看"刚发生了什么"用它；${LIMIT_ZERO_DOC}`
      },
      {
        flag: '--offset',
        type: 'string',
        desc:
          '分页偏移（默认 0）：跳过排在最前面的 N 条，再从那儿取下一段（配 --limit / --oldest 翻页）。' +
          '**本命令是逐行输出（NDJSON），没有信封可放 `nextOffset`** —— ' +
          '所以终点判据是**回空**（这一页一条都没有就到底了），' +
          '别用"本页少于 --limit 就到底"反推，那条在恰好整除时是错的'
      },
      { flag: '--category', type: 'string', desc: '只看某个大类' },
      {
        flag: '--oldest',
        type: 'boolean',
        desc: '改取最旧的 N 条（翻旧账用；不传则取最新）'
      }
    ],
    // 直接输出 NDJSON 而不是 JSON 信封：事件日志按行存储才能追加、拼接、流式处理
    output: 'ndjson',
    run: (ctx, flags) =>
      ctx.deps.telemetry.query({
        since: flags['--since'] ? String(flags['--since']) : undefined,
        category: flags['--category'] ? String(flags['--category']) : undefined,
        limit: parseLimit(flags['--limit'], 'telemetry export'),
        /**
         * 偏移（1.0.109，修 `7f21841f`）下推到仓储，**在排序之后切片** ——
         * "先定顺序，再切片"是 `3675f993` 立下的判据；在命令层切数组则要先把整表
         * 读进内存，而这条命令读的正是最长的表（实测全量 1110 条 / 459KB）。
         */
        offset: parseOffset(flags['--offset'], 'telemetry export'),
        order: flags['--oldest'] ? 'oldest' : 'newest'
      })
  },
  {
    name: 'telemetry clear',
    dataShape: 'object',
    risk: 'destructive',
    desc: '清空本地埋点数据',
    args: [
      { flag: '--yes', type: 'boolean', desc: '确认清空（必填）' },
      { flag: '--before', type: 'string', desc: '只清该时间点之前的' }
    ],
    run: (ctx, flags) => {
      if (!flags['--yes']) {
        throw new UsageError('清空埋点需显式加 --yes')
      }
      const removed = ctx.deps.telemetry.clear(
        flags['--before'] ? String(flags['--before']) : undefined
      )
      return { removed }
    }
  },
]
