/**
 * 开发启动脚本
 *
 * 解决两个关键问题：
 * 1. VS Code / Cursor 终端中 ELECTRON_RUN_AS_NODE=1 导致 Electron
 *    以 Node.js 模式启动、require('electron') 返回路径字符串
 * 2. better-sqlite3 需要为 Electron 运行时重新编译（与 Node.js ABI 不同）
 *
 * 此脚本在启动 electron-vite 前：
 * - 删除 ELECTRON_RUN_AS_NODE 环境变量
 * - 为 Electron 重新编译 better-sqlite3
 */

const { execSync, spawn } = require('child_process')
const path = require('path')

// 彻底删除 ELECTRON_RUN_AS_NODE，空字符串也会被 Electron 识别为 Node 模式
delete process.env.ELECTRON_RUN_AS_NODE

// 为 Electron 重新编译原生模块
try {
  console.log('[dev] 重新编译 better-sqlite3 for Electron...')
  execSync(
    'npm rebuild better-sqlite3 --runtime=electron --target=33.4.11 --dist-url=https://npmmirror.com/mirrors/electron/',
    { stdio: 'inherit', cwd: path.resolve(__dirname, '..') }
  )
  console.log('[dev] 原生模块编译完成')
} catch (err) {
  console.warn('[dev] 原生模块编译失败，如果应用无法启动请手动执行: npm run rebuild:electron')
}

const electronVite = path.resolve(__dirname, '..', 'node_modules', '.bin', 'electron-vite')

const child = spawn(electronVite, ['dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: true
})

child.on('close', (code) => {
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error('Failed to start electron-vite dev:', err)
  process.exit(1)
})
