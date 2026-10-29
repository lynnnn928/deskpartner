/**
 * 读 exe 的版本元数据（PE VersionInfo），并和 package.json 比对
 *
 * ── 为什么需要它 ──
 *
 * 打包这条路有一个 booked 的坑：**退出码会骗人**。
 * safe-delete 闸门会拦下删除中间产物（`.7z`）的动作，于是
 * `electron-builder` 退出码是 **1**，但**安装包其实已经完整生成**了。
 * 反过来也有"退出码是 0 但产物是旧的"的情况（构建没真的重跑）。
 *
 * 所以判据不能是退出码，只能是**产物的版本号**：
 * exe 的 `FileVersion` 必须等于 `package.json` 的 `version`。
 *
 * ── 为什么走 PowerShell ──
 *
 * 读 PE 资源在纯 Node 里要手解析节表，没必要。Windows 自带
 * `(Get-Item x.exe).VersionInfo.FileVersion` 就是权威答案。
 * 用 `-LiteralPath` 因为安装包名里有空格。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './prebuild-abi.mjs'

export function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return pkg.version
}

/**
 * 读某个 exe 的 FileVersion（读不到返回 null）
 *
 * 🚨 `stdio` 必须显式声明（2026-09-30 修复，1.0.64 发版实测踩中）：
 * 不声明时 spawnSync 走默认管道，在受限环境下直接 **EBUSY**，
 * `r.stdout` 是 `undefined` → 本函数返回 null → 验收层报"读不到版本"，
 * 而**包其实完全是好的**。这个失败态最坑的地方是它指向了错误的方向：
 * 看起来像打包坏了（可能让人重打一遍、白等两分钟），实际是校验脚本自己没读到。
 * 表现同"命令不存在"，区分不了 —— 所以一律显式写死三个管道。
 */
export function exeVersion(exePath) {
  if (!existsSync(exePath)) return null
  const ps = `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.FileVersion`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const out = (r.stdout || '').trim()
  return out || null
}

/**
 * 核对某个 exe 的版本是否等于 package.json。
 *
 * ⚠️ 刻意**不**据此判定"打包成功/失败"的整体结论 —— 它只回答
 * "这个 exe 是不是这个版本的"。产物是否存在、latest.yml 是否自洽
 * 由各自的检查回答。把多件事压成一个 ok 会让失败原因变得说不清。
 */
export function checkExeVersion(exePath, { log = console.log, label = '' } = {}) {
  const want = packageVersion()
  const got = exeVersion(exePath)
  const tag = label ? `${label} ` : ''

  if (!existsSync(exePath)) {
    log(`[exe] ${tag}FAIL  文件不存在：${exePath}`)
    return { ok: false, reason: 'missing', want, got }
  }
  if (!got) {
    log(`[exe] ${tag}FAIL  读不到版本元数据：${exePath}`)
    return { ok: false, reason: 'unreadable', want, got }
  }
  /**
   * FileVersion 常带四段（`1.0.60.0`），package.json 是三段 → 只比前缀，
   * 但必须是**段边界**上的前缀（`1.0.6` 不能匹配 `1.0.60`）。
   */
  const ok = got === want || got.startsWith(want + '.')
  log(`[exe] ${tag}${ok ? 'PASS' : 'FAIL'}  版本元数据 ${got}（期望 ${want}）`)
  return { ok, reason: ok ? 'ok' : 'mismatch', want, got }
}

/** 打包产物里的两个 exe：win-unpacked 的程序本体 与 安装包 */
export function artifactPaths(version) {
  return {
    unpackedExe: join(ROOT, 'dist', 'win-unpacked', 'DeskPartner.exe'),
    installer: join(ROOT, 'dist', `DeskPartner Setup ${version}.exe`)
  }
}
