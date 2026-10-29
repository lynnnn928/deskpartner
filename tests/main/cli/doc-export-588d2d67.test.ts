/**
 * 文档出口 `dp doc list` / `dp doc show`（卡 `588d2d67`，选①）
 *
 * ## 它治的病
 *
 * `COLLABORATION.md` 这类**约定文件**落在仓库里，而验收方 agent 的硬约束是
 * 读不到仓库文件；产品出口（`dp skill` / `dp schema`）里又全文检索不到
 * 「COLLABORATION」四个字母 —— 于是"这份文件到底写了什么"只有人能看，
 * 验收只能判「无法判定」。验收方验收 `7a4509c0` 就是这么退回的。
 *
 * ## 本文件盯的五件事
 *
 * ① **列得全**：`doc list` 回 5 条，每条都有字节数与 sha256，且**不含正文**；
 * ② **拿得到**：`doc show <name>` 的正文与磁盘逐字节一致（按 sha256 对，不按"看着像"）；
 * ③ **缺就说缺**：根指向一个空目录时 `available:false` + `meta.missing`，
 *    `show` 抛 `not_found` 并明说"报成交付缺口"——**不能返回空串装作读过**；
 *    这条是出口的全部价值所在，返回空串会让验收方得出"文档是空的"这个相反结论；
 * ④ **清单进得了包**：`package.json` 的 `build.files` 必须覆盖 `DOC_CATALOG` 的每一份
 *    —— 清单与打包是两处，漏一处就是"开发机上有、交付出去没有"；
 * ⑤ **名不对就报错**：`doc show` 给错名字是 `not_found`，不给名字是 `usage_error`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { executeOne } from '../../../src/main/cli/commands'
import { DOC_CATALOG } from '../../../src/main/cli/commands/doc'

/** 仓库根：用例跑在仓库里，文档就在这儿（`DESKPARTNER_DOC_ROOT` 指过来） */
const REPO_ROOT = process.cwd()

function makeCtx() {
  return {
    deps: {
      agentRepo: { get: () => null, list: () => [], touch: () => null },
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => null, clear: () => 0, query: () => [] }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 99,
      busyTimeoutMs: 5000,
      channels: ['headless'],
      via: 'headless',
      startedAt: 0
    },
    interactive: true,
    actor: 'human'
  } as never
}

const run = (args: string[]) => executeOne(makeCtx(), args)

/** 回执里的 `data`（`__meta` 已被执行层摘走，这里只看正文部分） */
function dataOf(res: { data?: unknown }): Record<string, unknown>[] {
  return (res.data ?? []) as Record<string, unknown>[]
}

function sha256Of(rel: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, rel))).digest('hex')
}

let emptyRoot: string

beforeEach(() => {
  process.env.DESKPARTNER_DOC_ROOT = REPO_ROOT
  emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-doc-empty-'))
})

afterEach(() => {
  delete process.env.DESKPARTNER_DOC_ROOT
  try {
    fs.rmSync(emptyRoot, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔占着，临时目录留给系统清 */
  }
})

describe('doc list：有哪些、多大、指纹多少（不含正文）', () => {
  it('五份都列出来，且每份都真的读得到', async () => {
    const res = await run(['doc', 'list'])
    const rows = dataOf(res)

    expect(res.ok, JSON.stringify(res).slice(0, 200)).toBe(true)
    expect(rows).toHaveLength(DOC_CATALOG.length)
    for (const row of rows) {
      expect(row.available, `${row.name} 应可读（root=${process.env.DESKPARTNER_DOC_ROOT}）`).toBe(true)
      expect(row.bytes as number).toBeGreaterThan(0)
      expect(String(row.sha256)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('指纹与磁盘一致（不是"看着像"，是逐字节）', async () => {
    const res = await run(['doc', 'list'])
    const rows = dataOf(res)
    for (const entry of DOC_CATALOG) {
      const row = rows.find((r) => r.name === entry.name)!
      expect(row.sha256, `${entry.file} 的指纹应与磁盘一致`).toBe(sha256Of(entry.file))
    }
  })

  it('列表不含正文 —— 一眼看全而不是刷屏', async () => {
    const res = await run(['doc', 'list'])
    const row = dataOf(res).find((r) => r.name === 'collaboration')!
    expect(row).not.toHaveProperty('content')
    // 正文里必然有这几个字，出现在列表回执里就说明顺手把正文带出来了
    expect(JSON.stringify(res.data)).not.toContain('看板协作约定（可编辑')
  })

  it('meta 里带着 root 与 byCategory：验收时要能说清"读的是哪一份"且按类别列全（收 3f6b66e1）', async () => {
    const res = await run(['doc', 'list'])
    expect(res.meta?.root).toBe(REPO_ROOT)
    expect(res.meta?.availableCount).toBe(DOC_CATALOG.length)
    const byCategory = res.meta?.byCategory as Record<string, string[]>
    expect(byCategory.convention).toContain('collaboration')
    expect(byCategory.architecture).toContain('gui-page-capability-map')

    const map = await run(['doc', 'show', 'gui-page-capability-map'])
    expect(map.ok).toBe(true)
    expect((map.data as Record<string, unknown>).category).toBe('architecture')
    expect(String((map.data as Record<string, unknown>).content)).toContain('页面 ↔ 能力映射')
  })
})

describe('doc show：正文 + 指纹', () => {
  it('collaboration 的正文与磁盘逐字节一致', async () => {
    const res = await run(['doc', 'show', 'collaboration'])
    expect(res.ok, JSON.stringify(res).slice(0, 200)).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.file).toBe('COLLABORATION.md')
    expect(data.sha256).toBe(sha256Of('COLLABORATION.md'))
    expect(String(data.content)).toContain('# COLLABORATION.md')
    expect(data.bytes).toBe(fs.statSync(path.join(REPO_ROOT, 'COLLABORATION.md')).size)
  })

  it('也可以直接用文件名问（`doc show COLLABORATION.md`）', async () => {
    const res = await run(['doc', 'show', 'COLLABORATION.md'])
    expect(res.ok).toBe(true)
    expect((res.data as Record<string, unknown>).name).toBe('collaboration')
  })

  it('五份都能读到，且都非空', async () => {
    for (const entry of DOC_CATALOG) {
      const res = await run(['doc', 'show', entry.name])
      expect(res.ok, `${entry.name}: ${JSON.stringify(res).slice(0, 160)}`).toBe(true)
      const data = res.data as Record<string, unknown>
      expect(String(data.content).length).toBeGreaterThan(0)
      expect(data.sha256).toBe(sha256Of(entry.file))
    }
  })
})

describe('缺就说缺（出口最要紧的那条）', () => {
  it('根指向空目录 → 全部 available:false，meta.missing 列全', async () => {
    process.env.DESKPARTNER_DOC_ROOT = emptyRoot
    const res = await run(['doc', 'list'])
    expect(res.ok).toBe(true)
    expect(dataOf(res).every((r) => r.available === false)).toBe(true)
    expect(res.meta?.missing as string[]).toHaveLength(DOC_CATALOG.length)
    expect(res.meta?.availableCount).toBe(0)
  })

  it('文件不在时 show 抛 not_found，并明说"报成交付缺口"（不返回空串）', async () => {
    process.env.DESKPARTNER_DOC_ROOT = emptyRoot
    const res = await run(['doc', 'show', 'collaboration'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
    expect(res.message).toContain('交付缺口')
  })
})

describe('名不对就报错', () => {
  it('没有这份文档 → not_found，并列出可选的', async () => {
    const res = await run(['doc', 'show', 'no-such-doc'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
    expect(res.message).toContain('collaboration')
  })

  it('不给名字 → usage_error', async () => {
    const res = await run(['doc', 'show'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
  })
})

describe('清单必须真的打进包（否则开发机上有、交付出去没有）', () => {
  it('package.json 的 build.files 覆盖 DOC_CATALOG 的每一份', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      build?: { files?: string[] }
    }
    const files = pkg.build?.files ?? []
    for (const entry of DOC_CATALOG) {
      expect(
        files,
        `${entry.file} 没写进 build.files —— 装好的包里 doc ${entry.name} 会报"交付缺口"`
      ).toContain(entry.file)
    }
  })

  it('清单里的每一份在仓库里都存在（清单不许指向不存在的文件）', () => {
    for (const entry of DOC_CATALOG) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry.file)), `缺文件：${entry.file}`).toBe(true)
    }
  })
})
