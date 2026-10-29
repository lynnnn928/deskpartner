/**
 * IPC 通道一致性检查
 *
 * 渲染层在 types/ipc.ts 里声明通道，主进程在 windows.ts / ipc.ts 里注册 handler。
 * 两处是分开写的，一旦声明了没注册，调用就是一次**静默失败**——
 * 本项目吃过这个亏（渲染层曾普遍写 `{ input: x }` 包装，所有写操作失效，
 * 而测试只覆盖 Repository 层，从不经过 IPC，所以没被发现）。
 *
 * 这个脚本把"声明"与"注册"对齐，作为一道防止该问题再发生的闸门。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ipcTs = readFileSync(path.join(root, 'src/renderer/types/ipc.ts'), 'utf8')
const winTs = readFileSync(path.join(root, 'src/main/windows.ts'), 'utf8')
const ipcMainTs = readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8')
// app:quit 这类应用级通道注册在入口文件里，一并纳入
const indexTs = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')

/** 渲染层声明的通道名（形如   'todo:create': { input: ... ） */
const declared = [...ipcTs.matchAll(/^\s{2}'([a-z]+:[a-zA-Z]+)':/gm)].map((m) => m[1])

/** 主进程注册的 handler（含多行写法 ipcMain.handle(\n  'xxx' ） */
const main = winTs + ipcMainTs + indexTs
const registered = new Set(
  [...main.matchAll(/ipcMain\.handle\(\s*'([a-z]+:[a-zA-Z]+)'/g)].map((m) => m[1])
)

// event:* 是主进程→渲染进程的推送，不需要渲染层 "调用"，但仍要在声明里
const pushChannels = declared.filter((c) => c.startsWith('event:'))
const callChannels = declared.filter((c) => !c.startsWith('event:'))

const missing = callChannels.filter((c) => !registered.has(c))
const extra = [...registered].filter((c) => !declared.includes(c))

console.log('渲染层声明通道 :', declared.length, `（调用 ${callChannels.length} + 推送 ${pushChannels.length}）`)
console.log('主进程注册     :', registered.size)
console.log('')
console.log('声明了但没注册 :', missing.length ? missing.join(', ') : '（无）')
console.log('注册了但没声明 :', extra.length ? extra.join(', ') : '（无）')

if (missing.length || extra.length) {
  process.exitCode = 1
} else {
  console.log('\n✅ IPC 通道两侧一致')
}
