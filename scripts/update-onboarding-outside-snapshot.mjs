/**
 * 刷新「开场提示词·步骤段以外的原文」快照（卡 `a19054a1`）
 *
 * 产物：`tests/renderer/fixtures/onboarding-prompt-outside.json` ——
 * 两版提示词（`buildMigratePrompt(null)` / `buildFreshPrompt(null)`）里
 * **开头一段（含接入地址段）、标题行、【硬要求】** 这三块的逐字原文。
 *
 * 平时测试逐字比对这份快照：那几段里改一个字，用例就红。
 *
 * ── 为什么要冻结（复审 round 3 第四轮）──
 *
 * 那三块不在编号步骤里，顺序闸门的所有断言都看不见它们，助手却照做。
 * 词表拦过三轮都不行：黑名单换个说法就漏；白名单 + 几个豁免短语，评审试了 20 种
 * 写法，18 种判绿（全角、零宽字符、拆词、「立项」，还有借豁免短语绕过去的）。
 * 词表永远追不上说法，所以干脆**冻结原文**：要改这三块，就得跑这个脚本，
 * 让刷新动作留在命令历史里，评审看 diff 才有得看。
 *
 * 用法：`node scripts/update-onboarding-outside-snapshot.mjs`
 * 之后 `git diff tests/renderer/fixtures/onboarding-prompt-outside.json` —— 确认每一处
 * 差异都是你有意改的。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
/** 只读提示词与清单两个文件，不碰数据库 —— 不需要切 better-sqlite3 的 ABI */
const SPEC = 'tests/renderer/lib/onboarding-order-matches-prompt.test.ts'
const SNAPSHOT = 'tests/renderer/fixtures/onboarding-prompt-outside.json'

const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', SPEC], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, UPDATE_ONBOARDING_OUTSIDE: '1' }
})

if (r.error) console.error(`vitest 没起来：${r.error.message}`)
const code = r.status ?? 1

console.log(
  code === 0
    ? `\n> 快照已刷新。下一步：\`git diff ${SNAPSHOT}\` —— 确认每一处差异都是你有意改的`
    : '\n> 刷新失败（见上面的 vitest 输出）'
)
process.exit(code)
