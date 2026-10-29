/**
 * 发版前置闸门：工作区必须干净（2026-09-30 事故的回归锁）
 *
 * ── 要锁住的现象 ──
 *
 * 1.0.63 打完包、写完文档之后才发现：**18 个源文件 / +2477 行的改动还在工作区**，
 * 一个 commit 都没提。后果不是"少一条记录"，而是**已经发出去的版本指不回任何源码**——
 * 真出问题要回退时，无路可退。
 *
 * 根因是发版单入口 `scripts/release.mjs` 里 **git 相关为 0 处**：
 * 它把构建、ABI、打包、latest.yml、产物核验都收进来了，唯独没管
 * "这个包对应的源码在不在"。所以"我记得先 commit"成了唯一防线，而它断了一次。
 *
 * ── 为什么写结构性断言而不只是跑一遍脚本 ──
 *
 * 脚本可以以后被人"顺手简化"掉这一步，测试却会当场红。
 * 同类先例：`pipe-name-isolation.test.ts`、`theme-vars.test.ts`。
 *
 * ⚠️ 另一个坑也一并锁住：**stdio 必须显式声明**。
 * 沙箱 / CI 里 `spawnSync(cmd, args, {encoding})` 会 EBUSY，
 * 表现和"命令不存在"一模一样 —— 当初闸门就是这么静默失效的（localhost 实测：
 * `spawnSync(process.execPath,['-e',...])` 默认 stdio → EBUSY；
 * 加 `stdio:['ignore','pipe','pipe']` → 正常）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'scripts', 'release.mjs'), 'utf8')

/** 取"工作区干净"这段的真实代码块。⚠️ 别用裸的"工作区是否干净"当锚点——
 *  它在文件头注释里也出现过，会截到注释、断言落空（本文件第一版就这么错过一次）。
 *  用 head() 的完整调用串才能唯一定位到代码。 */
const ANCHOR = "head('前置检查 · 工作区是否干净')"
function gateBlock(): string {
  const i = src.indexOf(ANCHOR)
  if (i < 0) throw new Error('release.mjs 里找不到工作区检查这一步（闸门被人删了？）')
  return src.slice(i, i + 2000)
}

describe('结构性闸门：发版前必须校验工作区干净', () => {
  it('脚本里真的调用了 git status --porcelain', () => {
    expect(src).toContain("'status'")
    expect(src).toContain("'--porcelain'")
  })

  it('脏工作区会中止发版（die），而不是只打个警告继续', () => {
    const block = gateBlock()
    // 必须存在一条"不是 allow-dirty 就 die"的分支
    expect(block).toContain('ALLOW_DIRTY')
    expect(block).toMatch(/die\(\s*\n?\s*`?工作区有/)
  })

  it('提供 --allow-dirty 逃生口（否则会被逼着去改脚本绕过）', () => {
    expect(src).toContain("argv.includes('--allow-dirty')")
  })

  it('git 的 spawn 显式声明了 stdio（默认 stdio 在沙箱里会 EBUSY）', () => {
    // GIT_OPTS 里必须有 stdio
    const m = src.match(/const GIT_OPTS\s*=\s*\{([\s\S]*?)\}/)
    expect(m, 'GIT_OPTS 没找到').toBeTruthy()
    expect(m![1]).toContain('stdio')
  })

  it('取不到 git 状态时**不静默放行**（那是"假干净"，正是事故的形态）', () => {
    // 必须有"取状态失败 → die/警告"的处理，而不是直接往下走
    expect(gateBlock()).toMatch(/st\.error|st\.status\s*!==\s*0/)
  })
})
