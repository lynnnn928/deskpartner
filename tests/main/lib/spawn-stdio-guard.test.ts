import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 结构性闸门：凡是读子进程 stdout 的**同步 spawn 家族**调用，
 * **必须显式声明 stdio**（2026-10-01 建立；同日扩到 execFileSync）。
 *
 * ── 为什么需要这条通用闸门，而不是继续逐个文件补 ──
 *
 * 这个坑在本项目已经出现**四次**，每次表现都不一样、但根因完全相同：
 *
 *   1. `scripts/lib/exe-version.mjs`（1.0.64 发版时发现）
 *      → 读不到 exe 版本号，看着像**打包失败**（实际包是好的）
 *   2. `scripts/release.mjs` 的 git 闸门（1.0.63）
 *      → 取不到工作区状态；而闸门的设计是"取不到就 die"，于是每次发版被误拦
 *   3. `scripts/cleanup-test-todos.mjs`（2026-10-01 发现，从 1.0.61 起一直坏着）
 *      → 报「读取生产库失败」，看着像**库读不了**（实际是子进程没起来）
 *   4. `scripts/lib/isolated-app.mjs`（2026-10-01 发现，从 1.0.61 起一直坏着）
 *      → 报「导出库快照失败」，看着像**数据库坏了**。
 *      **杀伤面最大**：该文件是所有隔离验证的公共底座，它坏 = 每一轮
 *      "跑在副本上"的验证都起不来。而前一轮的闸门**没抓到它**，
 *      因为闸门只扫 `spawnSync`，而这处用的是 `execFileSync`。
 *
 * 共同点：**失败态都指向错误的方向**，而且因为都有 try/catch 兜底，
 * 表现为"安静地给不出结果"，不会有人去追。tsc / lint / 单测全绿也查不出。
 *
 * ── 判据 ──
 *
 * 不检查"有没有用 spawn*"（那是正常需求），只检查**用它的方式**：
 * 调用参数对象里必须出现 `stdio:`。
 *
 * **覆盖面**：`spawnSync` / `execFileSync` / `execSync` 三个同步函数。
 * 第 4 次复现的教训就是"扫一个名字不够"—— 同族函数必须一起扫，
 * 否则修好一处、闸门仍然给假绿。
 *
 * 唯一豁免是调用点已经显式传了 `stdio` 之外的等价写法 —— 本项目目前没有，
 * 所以不留豁免名单；真需要时在这里加，并写清为什么。
 *
 * ── 反向验证 ──
 *
 * 把任意一个调用点的 `stdio:` 删掉，本测试必须变红。
 * （建立时与扩面后各实际执行过一次，确认能失败。）
 */

const ROOT = join(__dirname, '../../..')

/** 要扫的目录：脚本、构建期工具、测试辅助。src/ 与 tests/ 一并扫。 */
const SCAN_DIRS = ['scripts', 'src', 'tests']

/** 跳过：node_modules 不可能进来；lock/产物目录不进仓。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', 'archive'])

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * 从 `spawnSync(` / `execFileSync(` / `execSync(` 的位置往后取一段，
 * 检查这段里有没有 `stdio:`。
 *
 * 为什么用"取窗口"而不是语法分析：调用参数一般就在同一段内，
 * 取 700 字符足够覆盖多行参数对象；写成语法分析反而引入新依赖、且更难维护。
 * 反过来，如果窗口取太短会漏判，取太长可能把**后面另一个调用**的 stdio 算进来
 * —— 700 是本项目里实测的一个够用又不越界的值。
 */
const WINDOW = 700

/**
 * 要扫的同步 spawn 函数名。
 *
 * 🚨 第 4 次复现（`isolated-app.mjs` 用 `execFileSync`）的教训：
 * **只扫一个名字会给假绿** —— 闸门上线时只盯 `spawnSync`，
 * 于是同族的 `execFileSync` 一路漏过去，而那处恰好是隔离验证的公共底座。
 * 同族函数要么全扫，要么这条闸门就是在制造"已经管住了"的错觉。
 *
 * `spawn`（异步）不在此列：它不返回 stdout，读输出必须自己挂事件，
 * 参数形状也完全不同，硬套这条判据只会误判。
 */
const SYNC_SPAWN_FNS = ['spawnSync', 'execFileSync', 'execSync']

type Offense = { file: string; line: number; snippet: string }

/**
 * 把源码里的注释剥掉，避免"注释里写了 spawnSync('git', ...)"被判成真调用。
 *
 * 本轮实测踩到：release.mjs 的文档注释里有一句 `spawnSync('git', ...)`，
 * 它是**解释为什么不能这么写**的说明文字，却被扫描器当成违规调用。
 * 闸门必须只盯代码，否则会因为"解释得越详细越容易违规"这种荒谬的理由逼人删注释。
 *
 * 只处理块注释与行注释，不碰字符串字面量 —— 本项目里没有把 spawnSync(
 * 写在字符串里的用法；真有的话应该改调用方，而不是让闸门更聪明。
 */
function stripComments(src: string): string {
  // 用等长空白替换，保持行号与列偏移不变
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * 参数对象是否"已声明 stdio"。两种情况都算：
 *   - 直接写了 `stdio: [...]` / `stdio: 'ignore'`
 *   - 引用了带 stdio 的常量（如 `GIT_OPTS`），且该常量在同一文件里定义且含 stdio
 */
function declaresStdio(window: string, fileSrc: string): boolean {
  if (/stdio:\s*\[/.test(window) || /stdio:\s*'/.test(window)) return true
  // 常量引用：窗口里出现的标识符，若在同文件内定义为含 stdio 的对象，也算已声明
  const refs = window.match(/\b([A-Z][A-Z0-9_]{2,})\b/g) || []
  for (const ref of new Set(refs)) {
    const def = new RegExp(`(const|let|var)\\s+${ref}\\s*=\\s*\\{[^}]*\\}`)
    const m = fileSrc.match(def)
    if (m && /stdio:/.test(m[0])) return true
  }
  return false
}

function findOffenses(): Offense[] {
  const offenses: Offense[] = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // 本文件自己就写了 spawnSync 字样（注释里），跳过自身免误判
      if (file.endsWith('spawn-stdio-guard.test.ts')) continue

      const src = stripComments(raw)
      for (const fn of SYNC_SPAWN_FNS) {
        const re = new RegExp(`\\b${fn}\\s*\\(`, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) {
          const window = src.slice(m.index, m.index + WINDOW)
          if (declaresStdio(window, src)) continue
          // 没读到 stdout 的调用不受这条约束 —— 但本项目当前没有这种用法，
          // 若将来出现（例如只管副作用、输出直接 inherit），在此加白名单并说明。
          const line = src.slice(0, m.index).split('\n').length
          const snippet = window.split('\n')[0].trim().slice(0, 90)
          offenses.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line, snippet })
        }
      }
    }
  }
  return offenses
}

describe('同步 spawn 家族必须显式声明 stdio（同一坑已复现四次）', () => {
  const offenses = findOffenses()

  it('全仓库没有"读 stdout 却不声明 stdio"的调用', () => {
    if (offenses.length) {
      const detail = offenses
        .map((o) => `  ${o.file}:${o.line}\n      ${o.snippet}`)
        .join('\n')
      throw new Error(
        `以下同步 spawn 调用没有显式声明 stdio —— 受限环境下会 EBUSY，\n` +
          `stdout 变成 undefined，且失败态会指向完全错误的方向（见本文件顶部说明）：\n${detail}\n\n` +
          `改法：参数对象里加 stdio: ['ignore', 'pipe', 'pipe']\n` +
          `覆盖面：${SYNC_SPAWN_FNS.join(' / ')}`
      )
    }
    expect(offenses).toEqual([])
  })

  it('已修复的四处仍在（防止回退）', () => {
    // 这四个文件是"踩过坑的四处"，逐个点名，避免将来有人"顺手清理"。
    const mustHaveStdio = [
      'scripts/lib/exe-version.mjs',
      'scripts/release.mjs',
      'scripts/cleanup-test-todos.mjs',
      'scripts/lib/isolated-app.mjs'
    ]
    for (const p of mustHaveStdio) {
      const src = readFileSync(join(ROOT, p), 'utf8')
      expect(src, `${p} 应含显式 stdio`).toContain('stdio:')
    }
  })
})
