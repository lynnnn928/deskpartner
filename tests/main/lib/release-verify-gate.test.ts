import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 发版验收脚本的两个结构性缺陷（1.0.64 发版时实测踩中，各补一条锁）
 *
 * ── 缺陷一：读 exe 版本时没声明 stdio ──
 *
 * `exeVersion()` 用 spawnSync 调 PowerShell 读 PE 版本元数据。
 * 不声明 stdio 时，受限环境下直接 **EBUSY**，`r.stdout` 是 undefined
 * → 返回 null → 验收层报"读不到版本"，而**包其实完全是好的**。
 *
 * 这个失败态最坑的是它指向错误方向：看起来像打包坏了（可能让人白重打一次），
 * 实际是校验脚本自己没读到。所以判据不是"有没有调 spawnSync"，
 * 而是"有没有显式声明 stdio"。tsc / lint / 单测全绿也查不出这个。
 *
 * ── 缺陷二：关键字符串只扫主进程 ──
 *
 * 原来只从 app.asar 里取 `out/main/index.js`。但界面改动打进的是
 * `out/renderer/assets/*.js` —— "只改了界面"的版本用关键字符串验会**假通过**。
 */

const ROOT = join(__dirname, '../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('发版验收脚本闸门（1.0.64）', () => {
  describe('exe 版本读取必须显式声明 stdio', () => {
    const src = read('scripts/lib/exe-version.mjs')

    it('spawnSync 调用带 stdio，且三个管道都写死', () => {
      const i = src.indexOf('spawnSync(')
      expect(i).toBeGreaterThan(-1)
      const call = src.slice(i, i + 500)
      expect(call).toContain('stdio:')
      // 只写 'inherit' 不够 —— 这里要的是能读到 stdout
      expect(call).toMatch(/stdio:\s*\[\s*'ignore'\s*,\s*'pipe'\s*,\s*'pipe'\s*\]/)
    })

    it('读不到时返回 null 而不是崩溃（让上层能给出人话提示）', () => {
      expect(src).toContain('return out || null')
    })
  })

  describe('关键字符串必须同时扫主进程、界面、MCP', () => {
    const src = read('scripts/verify-package.mjs')

    it('扫了 renderer 的 assets bundle', () => {
      // 不写复杂正则（转义层数多、易写错），直接断言关键片段都在
      expect(src).toContain('renderer')
      expect(src).toContain('assets')
      expect(src).toContain('rendererSrc')
    })

    it('三处命中任一处才算通过', () => {
      // 判据表达式要同时含 inAsar / inRenderer / inMcp
      expect(src).toContain('inRenderer')
      expect(src).toMatch(/inAsar\s*\|\|\s*inMcp\s*\|\|\s*inRenderer/)
    })
  })
})
