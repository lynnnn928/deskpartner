/**
 * 管道请求字段转发检查
 *
 * 为什么需要这道闸门（1.0.57，Bob 52b6b726 驳回）：
 *
 * 调用方的东西要送进服务端，中间有**三跳**：
 *   1. 启动器读自己的环境/凭据 → 2. 写进 PipeRequest → 3. 服务端拿它构造 ctx
 * 命令实现只认 ctx。任何一跳断了，表现都是"声明了却不生效"——
 * **不报错、不崩溃、静默失效**，只有真正踩到的人才知道。
 *
 * 52b6b726 就是这个形态：`DESKPARTNER_SKILL_VERSION` 第 1、3 跳都写了，
 * 第 2 跳漏了 → GUI 开着时漂移提醒恒不触发，偏偏 `NO_PIPE=1` 走无头正常
 * （那时服务端就是调用方的子进程，第 2 跳不经过）。Bob拿着这个不一致
 * 连错四轮才定位。同类问题此前已在 actor / credential / ambiguousIds 上反复出现过。
 *
 * 判据很朴素：**PipeRequest 里的每个字段，都必须在启动器里被转发**。
 * 这个接口里没有"服务端自己能填"的字段——它的存在意义就是"客户端带过来的东西"，
 * 所以"声明了却没人填"就是一种确定无疑的遗漏。不需要维护白名单。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const protocolTs = readFileSync(path.join(root, 'src/cli/pipe-protocol.ts'), 'utf8')
const launcherTs = readFileSync(path.join(root, 'src/cli/launcher.ts'), 'utf8')

/** 取出 `export interface PipeRequest { ... }` 的字段名 */
function fieldsOfInterface(src, name) {
  const start = src.indexOf(`export interface ${name} {`)
  if (start < 0) return []
  const body = src.slice(start)
  const end = body.indexOf('\n}')
  const block = end < 0 ? body : body.slice(0, end)
  return [...block.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)].map((m) => m[1])
}

/**
 * 去掉整行注释后再找字段，避免"只在注释里提过"就算转发。
 * 行尾注释不影响：代码部分还在那一行里，匹配得到。
 */
const codeLines = launcherTs
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

const fields = fieldsOfInterface(protocolTs, 'PipeRequest')

/** 该字段是否作为对象属性 key（`f:`）或简写（`{ f }`）出现过 */
function forwarded(f) {
  const re = new RegExp(`(^|[^\\w.])${f}\\s*[,}:]`, 'm')
  const shorthand = new RegExp(`\\{\\s*${f}\\s*[,}]`, 'm')
  return re.test(codeLines) || shorthand.test(codeLines)
}

const missing = fields.filter((f) => !forwarded(f))

console.log('PipeRequest 字段 :', fields.length, fields.join(', '))
console.log('')
console.log('声明了但启动器没转发 :', missing.length ? missing.join(', ') : '（无）')

if (missing.length) {
  console.error(
    '\n[pipe] 上述字段客户端没有转发 —— 服务端在管道路径下读不到它们，\n' +
      '     表现为"声明了却不生效"的静默失效。请在 launcher.ts 的请求构造里补上。'
  )
  process.exitCode = 1
} else {
  console.log('\n✅ 管道请求字段全部有转发')
}
