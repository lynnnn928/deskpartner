/**
 * 公开仓库内容清理与脱敏闸门（卡 `9aee52ce`，模式级白名单由卡 `90dbea16` 补上）
 *
 * 守护阶段 1 的五项清理成果不回退：
 * 1. 内部过程文档（docs/plans|reviews|design|prototypes|prd|research、根目录演练报告等）不再受版本控制；
 * 2. 保留文件中不含内部协作者名与代号；
 * 3. 公开版 AGENTS.md 不含本机绝对路径与 wsl 黑名单私货；
 * 4. 根目录 CHANGELOG.md 存在且作为 doc show releases 的出口文件；
 * 5. 保留文件中不含作者本机绝对路径（Users/L、2026/desk_partner、Programs 等）或私钥 token。
 *
 * ── 90dbea16：从"黑名单"改成"模式级白名单" ──
 *
 * 黑名单只拦得住**写得出来那几个**：`agent:` 后面换一个没登记的代号
 * （如 `'agent:' + 'mt'`）就照过。所以 `agent:<handle>` 这个形状整个收进闸门 ——
 * 仓库里允许出现的代号必须**在 `ALLOWED_AGENT_HANDLES` 里登记**，没登记就是违规。
 * 代价是名单要维护：新代号第一次出现会在用例 2 里红（这次就是这么补齐的）。
 *
 * 注：为使 `git grep` 字面量扫描在全仓保持 0 命中，敏感词模式由分段字符串拼装。
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

const FORBIDDEN_NAMES = [
  '\u6728\u6728',
  '\u5343\u95ee',
  'work' + 'buddy',
  '\u82b1\u5377',
  'hua' + 'juan',
  // 卡 90dbea16：内部协作者代号也进黑名单（同类代号换拼法由下面的白名单兜底）
  'pen' + 'guin',
  'new' + 'max'
]

const FORBIDDEN_PATHS = [
  '[C-Z]:[\\\\/]+Users[\\\\/]+L\\b',
  'D:[\\\\/]+2026\\b',
  'D:[\\\\/]+Programs\\b',
  'ghp_[A-Za-z0-9]{10,}',
  'sk-[A-Za-z0-9]{16,}'
]

const NAME_RE = new RegExp(FORBIDDEN_NAMES.join('|'), 'i')
const PATH_RE = new RegExp(FORBIDDEN_PATHS.join('|'), 'i')

/**
 * 允许出现在仓库里的 `agent:<handle>` 白名单（卡 `90dbea16`）
 *
 * 两类：① 测试与示例里的中性代号；② `agent:` 前缀的 IPC 通道名
 * （`agent:listGrants`、`agent:resolveGrant`… 与身份字面量同形，一并登记）。
 * 判据是"集合相等"而不是"不许写某些词"：**没登记就算违规**。
 */
const ALLOWED_AGENT_HANDLES = new Set([
  'alice',
  'bob',
  'carol',
  'dave',
  'claude',
  'codex',
  'cursor',
  'kimi',
  'zcode',
  'zed',
  'qwen',
  'a',
  'a1',
  'a2',
  'aa',
  'b',
  'c',
  'q',
  't',
  'x',
  'xxx',
  'zz',
  'author',
  'auto-ok',
  'boot',
  'brandnew',
  'cli',
  'e2ebot',
  'early',
  'executor',
  'ghost',
  'ghost-x',
  'ghost2',
  'gone',
  'headless-fixture',
  'headless-pending',
  'helper',
  'history',
  'id',
  'inject-check',
  'late',
  'legacy',
  'list',
  'listGrantHistory',
  'listGrants',
  'me',
  'me2',
  'never-registered',
  'new-probe',
  'nobody',
  'noname',
  'old',
  'other',
  'poc-new',
  'poc-other',
  'probe',
  'probe-orphan',
  'register',
  'resolveGrant',
  'reviewer',
  'revokeGrants',
  'rookie',
  'rules-history',
  'runner',
  'setApproved',
  'setRejected',
  'smoke-a',
  'smoke-b',
  'smoke-c',
  'smoke-join',
  'smoke-join-a',
  'smoke-join-b',
  'smoke-join-c',
  'smoke-join-d',
  'smoke-never',
  'smoke-pending',
  'smoke-pending2',
  'smoke-pending3',
  'someone',
  'someone-else',
  'stale',
  'test',
  'tester',
  'verifier',
  'worker',
  'writer',
  '__banner_probe_a__',
  '__banner_probe_b__',
  '__banner_probe_c__'
])

/** 身份字面量的形状：`agent:` + 代号（与通道名同形，所以两者共用一个名单） */
const AGENT_HANDLE_RE = /\bagent:([a-zA-Z0-9_-]+)\b/g

export function scanSanitizationViolations(files: Array<{ file: string; content: string }>): string[] {
  const violations: string[] = []
  for (const { file, content } of files) {
    const nm = content.match(NAME_RE)
    if (nm) {
      violations.push(`${file}: 含内部代号 "${nm[0]}"`)
    }
    if (file !== 'package-lock.json') {
      const pm = content.match(PATH_RE)
      if (pm) {
        violations.push(`${file}: 含本机路径或凭据 "${pm[0]}"`)
      }
    }
    /**
     * 模式级白名单：任何 `agent:<handle>` 都必须登记过 —— 内部代号换拼法也拦得住。
     * `matchAll` 自己克隆正则，模块级 `AGENT_HANDLE_RE` 的 `lastIndex` 不会跨文件留下状态。
     */
    for (const m of content.matchAll(AGENT_HANDLE_RE)) {
      if (!ALLOWED_AGENT_HANDLES.has(m[1])) {
        violations.push(`${file}: 含非白名单 agent 代号 "agent:${m[1]}"`)
      }
    }
  }
  return violations
}

describe('公开仓库内容清理与脱敏闸门（9aee52ce）', () => {
  const tracked = execSync('git ls-files -z', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
    .split('\0')
    .filter(Boolean)

  it('1. 排除清单中的内部过程文档不再留在 git 跟踪列表', () => {
    const forbiddenPrefixes = [
      'docs/plans/',
      'docs/reviews/',
      'docs/design/',
      'docs/prototypes/',
      'docs/prd/',
      'docs/research/'
    ]
    const leaked = tracked.filter((f) => forbiddenPrefixes.some((p) => f.startsWith(p)))
    expect(leaked).toEqual([])
    expect(tracked).not.toContain('docs/RELEASES.md')
    expect(tracked).toContain('CHANGELOG.md')
  })

  it('2. 保留文件中内部协作者人名、本机绝对路径与非白名单 agent 代号扫描均为 0', () => {
    const textFiles = tracked
      .filter((f) => !f.endsWith('.png') && !f.endsWith('.ico'))
      .map((file) => ({
        file,
        content: fs.readFileSync(path.join(ROOT, file), 'utf8')
      }))

    expect(scanSanitizationViolations(textFiles)).toEqual([])
  })

  it('3. 公开版 AGENTS.md 无本机路径，CHANGELOG.md 为有效产品更新日志', () => {
    const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')
    expect(agents).not.toMatch(/[C-Z]:[\\/]/i)
    expect(agents).not.toMatch(/wsl\.exe/i)

    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toContain('# 更新日志（CHANGELOG）')
    expect(changelog).toContain('## 1.0.133')
  })

  it('4. 反向验证：注入内部代号 / 未登记 agent 代号 / 本机路径时扫描器必须检出', () => {
    const injected: Array<{ file: string; content: string; kind: string }> = [
      { file: 'tests/sample.ts', content: `const actor = 'agent:${'work' + 'buddy'}'`, kind: '含内部代号' },
      { file: 'tests/code-name-a.ts', content: `const who = '${'pen' + 'guin'}'`, kind: '含内部代号' },
      { file: 'tests/code-name-b.ts', content: `const who = '${'new' + 'max'}'`, kind: '含内部代号' },
      { file: 'scripts/sample.mjs', content: `const dir = '${'C:/' + 'Users/L/AppData'}'`, kind: '含本机路径或凭据' },
      {
        file: 'tests/sample-secret.ts',
        content: `const actor = 'agent:${'internal_secret_bot'}'`,
        kind: '含非白名单 agent 代号'
      }
    ]

    for (const { file, content, kind } of injected) {
      const res = scanSanitizationViolations([{ file, content }])
      expect(res.some((v) => v.includes(kind)), `${file} 没被检出：${JSON.stringify(res)}`).toBe(true)
      expect(res.every((v) => v.startsWith(`${file}: `))).toBe(true)
    }

    // 反向验证的另一半：白名单里的中性名与通道名不许被报 —— 否则"白名单"就变成"一律不许写 agent:"。
    expect(
      scanSanitizationViolations([
        {
          file: 'tests/ok.ts',
          content: "const a = 'agent:alice'; const c = 'agent:carol'; const ch = 'agent:listGrants'"
        }
      ])
    ).toEqual([])
  })
})
