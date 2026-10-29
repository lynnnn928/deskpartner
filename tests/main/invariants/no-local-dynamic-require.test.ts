import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 禁止主进程对本地模块使用动态 require（1.0.102，修 1.0.101 启动失败）
 *
 * ── 事故形状 ──
 *
 * 1.0.101 装上后启动失败：
 *   Cannot find module './database/rules.repository'
 *   Require stack: ...\\resources\\app.asar\\out\\main\\index.js
 *
 * 根因是 `src/main/ipc.ts` 里有一行：
 *   const rulesRepo = new (require('./database/rules.repository').RulesRepository)()
 *
 * electron-vite 把主进程打成**单文件** `out/main/index.js`，静态 `import`
 * 会被 rollup 收进 bundle，但**动态 `require('./相对路径')` 会被原样保留**。
 * 打包成 asar 后 `out/main/` 下只有 `index.js`，没有 `database/rules.repository.js`
 * 这个文件，于是运行时 require 直接找不到模块，进程带着不确定状态退出。
 *
 * ── 为什么测试当时没拦住 ──
 *
 * vitest 走的是源码/ESM 解析，动态 require 在测试环境还能解析到 .ts 源文件，
 * 于是「测试全绿、装上起不来」。这类缺陷只有打包后的产物才能暴露，
 * 源码层必须用闸门堵死。
 *
 * ── 判据 ──
 *
 * 1. 只禁**相对路径**（`./` `../`）：`require('node:fs')` 这类内置模块由
 *    externalizeDepsPlugin 外置，运行时在 Electron 的 Node 里能直接解析，是安全的。
 *    真正会逃出 bundle 的只有指向源码目录的相对路径 —— 打包后那个位置根本不存在。
 * 2. 只看**代码区**的 require：文档字符串里的 shell 示例（如 agent-guide 的
 *    `node -p "require('./package.json').version"`）不是可执行调用，不该被误伤。
 *    用一个轻量状态机追踪单引号/双引号/模板字符串/注释，只扫描代码状态下的调用。
 *
 * 所以规则是：**本地模块一律用静态 `import`，禁止动态 `require`。**
 */

const SRC_MAIN = path.resolve(__dirname, '../../../src/main')

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * 判断 source[index] 处是否处于字符串/注释内部。
 * 只追踪代码区的引号状态，不解析模板字符串的 ${} 插值
 * （插值里出现动态 require 同样该被禁，按代码状态处理反而更严）。
 */
function isInsideLiteral(source: string, index: number): boolean {
  type State = 'code' | 'single' | 'double' | 'template' | 'lineComment' | 'blockComment'
  let state: State = 'code'
  let i = 0
  while (i < index && i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'lineComment'; i += 2; continue }
      if (c === '/' && next === '*') { state = 'blockComment'; i += 2; continue }
      if (c === "'") { state = 'single'; i++; continue }
      if (c === '"') { state = 'double'; i++; continue }
      if (c === '`') { state = 'template'; i++; continue }
      i++
    } else if (state === 'single' || state === 'double' || state === 'template') {
      if (c === '\\') { i += 2; continue }
      if ((state === 'single' && c === "'") ||
          (state === 'double' && c === '"') ||
          (state === 'template' && c === '`')) {
        state = 'code'
      }
      i++
    } else if (state === 'lineComment') {
      if (c === '\n') state = 'code'
      i++
    } else {
      // blockComment
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
      i++
    }
  }
  return state !== 'code'
}

/** 相对路径动态 require：require('./x') / require("../y") */
const LOCAL_REQUIRE = /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g

/** 收集源码代码区（非字符串、非注释）里的本地动态 require */
function findLocalDynamicRequires(source: string): string[] {
  const hits: string[] = []
  LOCAL_REQUIRE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOCAL_REQUIRE.exec(source))) {
    if (isInsideLiteral(source, m.index)) continue
    hits.push(m[1])
  }
  return hits
}

describe('禁止主进程本地模块动态 require', () => {
  const files = collectTsFiles(SRC_MAIN)

  it('扫描范围覆盖 src/main', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('不得对本地相对路径模块使用 require()，必须用静态 import', () => {
    const hits: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      for (const target of findLocalDynamicRequires(source)) {
        hits.push(`${path.relative(SRC_MAIN, file)}: require('${target}')`)
      }
    }
    expect(hits).toEqual([])
  })

  it('反向验证：事故现场的动态 require 必须被抓住', () => {
    const sample = `const rulesRepo = new (require('./database/rules.repository').RulesRepository)()`
    expect(findLocalDynamicRequires(sample)).toEqual(['./database/rules.repository'])
  })

  it('反向验证：内置模块的 require 不该被误伤', () => {
    const builtin = `const fs = require('node:fs') as typeof import('node:fs')`
    expect(findLocalDynamicRequires(builtin)).toEqual([])
  })

  it('反向验证：文档字符串里的 shell 示例不该被误伤', () => {
    const doc = '| 版本号已升 | `node -p "require(\'./package.json\').version"` | 指向一个不存在的版本 |'
    // 整行位于模板字符串内时，状态机应判定为字面量内部（agent-guide 的实际形状）
    const wrapped = 'const guide = `' + doc + '`'
    expect(findLocalDynamicRequires(wrapped)).toEqual([])
  })

  it('反向验证：同样的 require 写在纯代码区必须被抓住', () => {
    // 不用带反引号的 markdown 行做反向样本：反引号本身会让状态机进入字面量，
    // 那是正确行为。这里用干净的代码行证明闸门不是靠白名单蒙混过关。
    expect(findLocalDynamicRequires(`const v = require('./package.json').version`)).toEqual(['./package.json'])
  })
})
