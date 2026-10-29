/**
 * 公开仓库内容清理与脱敏闸门（卡 `9aee52ce`）
 *
 * 守护阶段 1 的五项清理成果不回退：
 * 1. 内部过程文档（docs/plans|reviews|design|prototypes|prd|research、根目录演练报告等）不再受版本控制；
 * 2. 保留文件中不含内部协作者名与代号；
 * 3. 公开版 AGENTS.md 不含本机绝对路径与 wsl 黑名单私货；
 * 4. 根目录 CHANGELOG.md 存在且作为 doc show releases 的出口文件；
 * 5. 保留文件中不含作者本机绝对路径（Users/L、2026/desk_partner、Programs 等）或私钥 token。
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
  'hua' + 'juan'
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

  it('2. 保留文件中内部协作者人名与本机绝对路径扫描均为 0', () => {
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

  it('4. 反向验证：注入内部人名或本机路径时扫描器必须检出违规', () => {
    const badSamples = [
      { file: 'tests/sample.ts', content: `const actor = 'agent:${'work' + 'buddy'}'` },
      { file: 'scripts/sample.mjs', content: `const dir = '${'C:/' + 'Users/L/AppData'}'` }
    ]
    const res = scanSanitizationViolations(badSamples)
    expect(res).toHaveLength(2)
    expect(res[0]).toContain('含内部代号')
    expect(res[1]).toContain('含本机路径或凭据')
  })
})
