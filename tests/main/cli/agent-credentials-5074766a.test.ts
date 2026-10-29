/**
 * 孤儿凭据的列出与清理（卡 `5074766a`，1.0.116）
 *
 * ## 它治的病
 *
 * 凭据文件（`~/.deskpartner/credentials.json`）与数据库是两份账：身份从库里
 * 消失之后，文件里那一份还在。于是"6 份凭据 / 5 个注册身份"，而启动器的规矩是
 * **多份又没声明身份就不猜** —— 每个调用方都被要求声明身份，其中一部分摩擦
 * 纯由那份死凭据贡献。此前文件里七个导出函数**一个删除入口都没有**，
 * 普通用户只能手改 JSON。
 *
 * ## 本文件盯的四件事
 *
 * ① **看得见**：`agent credentials` 列出文件里的每一份，标出「还在不在册」与
 *    「是不是默认」，且**不回 token**（那是能直接冒充身份的私钥）；
 * ② **删得掉**：未注册身份 + `--yes` → 文件里消失、份数减一；
 * ③ **删不该删的**：已注册身份一律不受理（提示走 `agent revoke`）；
 *    没带 `--yes` 时**文件一个字节都不动**；
 * ④ **默认身份不留悬空**：删掉的正好是 `default` 时，它自动换到剩下排序第一份；
 *    一份都不剩时 `default` 整个去掉（留一个指向不存在身份的 default 比没有更难查）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeOne } from '../../../src/main/cli/commands'
import {
  readCredentials,
  removeCredential,
  credentialsPath
} from '../../../src/cli/credentials'

/** 库里在册的身份（其余都算孤儿） */
const REGISTERED = ['agent:zed', 'agent:penguin']

function makeCtx() {
  return {
    deps: {
      agentRepo: {
        get: (id: string) => (REGISTERED.includes(id) ? { id, approved: true } : null),
        list: () => REGISTERED.map((id) => ({ id, approved: true })),
        touch: () => null,
        markWrite: () => null,
        listGrants: () => [],
        findUsableGrant: () => null,
        findAnyUsableGrant: () => null,
        findLatestGrant: () => null,
        consumeGrant: () => null
      },
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
    /** 人在终端敲：本文件验的是入口语义，不是门禁 */
    interactive: true,
    actor: 'human'
  } as never
}

const run = (args: string[]) => executeOne(makeCtx(), args)

let dir: string
let file: string

/**
 * 造一份"有一份孤儿"的凭据文件
 *
 * 三份：zed（在册、默认）、qwen（**孤儿**）、penguin（在册）。
 * 默认身份故意设成 zed —— 删孤儿时不该动它。
 */
function seed() {
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        default: 'agent:zed',
        profiles: {
          'agent:zed': { token: 'token-zed-PLAINTEXT', issuedAt: '2026-09-01T00:00:00.000Z' },
          'agent:qwen': { token: 'token-qwen-PLAINTEXT', issuedAt: '2026-10-06T00:00:00.000Z' },
          'agent:penguin': { token: 'token-penguin-PLAINTEXT', issuedAt: '2026-10-10T00:00:00.000Z' }
        }
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
}

const rawText = () => fs.readFileSync(file, 'utf8')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-creds-'))
  file = path.join(dir, 'credentials.json')
  process.env.DESKPARTNER_CREDENTIALS_FILE = file
  seed()
})

afterEach(() => {
  delete process.env.DESKPARTNER_CREDENTIALS_FILE
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 偶尔占着，留给系统清 */
  }
})

describe('agent credentials：看得见（1.0.116）', () => {
  it('三份都列出来，孤儿标 registered:false', async () => {
    const res = await run(['agent', 'credentials'])
    const rows = (res.data ?? []) as Record<string, unknown>[]

    expect(res.ok, JSON.stringify(res).slice(0, 200)).toBe(true)
    expect(rows.map((r) => r.agentId)).toEqual(['agent:penguin', 'agent:qwen', 'agent:zed'])
    expect(rows.find((r) => r.agentId === 'agent:qwen')?.registered).toBe(false)
    expect(rows.find((r) => r.agentId === 'agent:zed')?.registered).toBe(true)
    expect(rows.find((r) => r.agentId === 'agent:zed')?.isDefault).toBe(true)
  })

  it('meta 里点名孤儿，并给出清理命令', async () => {
    const res = await run(['agent', 'credentials'])
    expect(res.meta?.orphanCount).toBe(1)
    expect(res.meta?.orphans).toEqual(['agent:qwen'])
    expect(String(res.meta?.hint)).toContain('agent purge-credentials')
  })

  it('**不回 token**（那是能直接冒充身份的私钥）', async () => {
    const res = await run(['agent', 'credentials'])
    const dumped = JSON.stringify(res)
    expect(dumped).not.toContain('PLAINTEXT')
    expect(dumped).not.toContain('token-qwen')
  })

  it('凭据文件不存在时也不炸，回空数组并把路径带上', async () => {
    fs.rmSync(file)
    const res = await run(['agent', 'credentials'])
    expect(res.ok).toBe(true)
    expect(res.data).toEqual([])
    expect(res.meta?.path).toBe(file)
  })
})

describe('agent purge-credentials：删得掉，也删不该删的（1.0.116）', () => {
  it('孤儿 + --yes → 文件里消失、份数减一', async () => {
    const res = await run(['agent', 'purge-credentials', '--id', 'agent:qwen', '--yes'])

    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.removed).toBe(true)
    expect(data.remaining).toBe(2)

    const after = readCredentials()
    expect(Object.keys(after.profiles)).toEqual(['agent:penguin', 'agent:zed'])
    // 默认身份没被牵连
    expect(after.default).toBe('agent:zed')
  })

  it('没带 --yes：报 usage_error，**文件一个字节都不动**', async () => {
    const before = rawText()
    const res = await run(['agent', 'purge-credentials', '--id', 'agent:qwen'])

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
    expect(res.message).toContain('--yes')
    expect(rawText()).toBe(before)
  })

  it('已注册身份不受理：报 usage_error 并指向 agent revoke，文件不动', async () => {
    const before = rawText()
    const res = await run(['agent', 'purge-credentials', '--id', 'agent:penguin', '--yes'])

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
    expect(res.message).toContain('agent revoke')
    expect(rawText()).toBe(before)
  })

  it('文件里没有这个身份 → not_found，并列出现有的', async () => {
    const res = await run(['agent', 'purge-credentials', '--id', 'agent:nobody', '--yes'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
    expect(res.message).toContain('agent:qwen')
  })

  it('删的是默认身份时，默认自动换人', async () => {
    // 把孤儿设成默认再删它
    const cur = JSON.parse(rawText()) as { default: string }
    cur.default = 'agent:qwen'
    fs.writeFileSync(file, JSON.stringify(cur, null, 2))

    const res = await run(['agent', 'purge-credentials', '--id', 'agent:qwen', '--yes'])
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.wasDefault).toBe(true)
    expect(data.defaultAfter).toBe('agent:penguin')
    expect(readCredentials().default).toBe('agent:penguin')
  })
})

describe('removeCredential：把文件改对（含最后一份的收尾）', () => {
  it('删掉最后一份 → default 整个去掉，不留悬空值', () => {
    // 造一份只有孤儿的文件，且默认身份就是它
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          default: 'agent:qwen',
          profiles: { 'agent:qwen': { token: 'token-qwen-PLAINTEXT', issuedAt: '2026-10-06T00:00:00.000Z' } }
        },
        null,
        2
      )
    )

    const result = removeCredential('agent:qwen')
    expect(result).toEqual({ removed: true, wasDefault: true, defaultAfter: null, remaining: 0 })

    const written = JSON.parse(rawText()) as Record<string, unknown>
    expect(written.profiles).toEqual({})
    expect(written).not.toHaveProperty('default')
    expect(credentialsPath()).toBe(file)
  })

  it('身份不存在时回 removed:false，且**不写文件**（不制造空文件）', () => {
    const before = rawText()
    const result = removeCredential('agent:nobody')
    expect(result.removed).toBe(false)
    expect(result.remaining).toBe(3)
    expect(rawText()).toBe(before)
  })
})
