/**
 * 隔离实例必须有自己的命名管道（2026-09-29 决策 A 的配套闸门）
 *
 * ── 要锁住的现象 ──
 *
 * 管道名原来只由用户名决定 → **同一台机器上只有一个管道**。
 * 于是按 `DESKPARTNER_DATA_DIR` 起隔离实例时会出现两种静默错误：
 *
 * 1. 隔离实例监听的仍是真实 GUI 的管道名。谁先监听谁赢，
 *    后到的那个**静默失去通道 A**，不报错。
 * 2. 更贵的反向：隔离实例里的 CLI 调用**不会**连到它自己，
 *    而是连上常驻的真实 GUI → "跑在隔离库上"的验证脚本
 *    写着写着就写进了真实看板。
 *
 * 这正是当时那 68 条销毁授权的现实来源：以为在隔离环境里。
 *
 * ── 为什么要写成结构性闸门 ──
 *
 * 光测 `dataDirKey()` 的函数行为**不够** —— 它可以写得很对，
 * 只要调用方（`pipeName()`）忘了拼上它，现象依旧。
 * 所以第二条用例直接读源码，断言"拼接"这件事真的发生了
 * （同类先例：`theme-vars.test.ts`、`preset-value-source.test.ts`）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeName, dataDirKey, currentUserKey } from '../../../src/cli/pipe-protocol'

const ENV_KEY = 'DESKPARTNER_DATA_DIR'
const original = process.env[ENV_KEY]

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = original
})

describe('dataDirKey：隔离目录 → 管道名后缀', () => {
  it('未声明数据目录时为**空串**（保持与已安装旧版的管道名兼容）', () => {
    delete process.env[ENV_KEY]
    expect(dataDirKey()).toBe('')
    // 兼容性关键：老版本算出的那个名字必须原样能连上
    expect(pipeName()).toBe(`\\\\.\\pipe\\deskpartner-cli-${currentUserKey()}`)
  })

  it('声明空值时不生成后缀（空值由 checkIsolation 拒绝启动，这里只需不产出怪名字）', () => {
    process.env[ENV_KEY] = '   '
    expect(dataDirKey()).toBe('')
  })

  it('声明了目录 → 产出稳定的短后缀', () => {
    process.env[ENV_KEY] = 'C:/workspace/desk-partner/desk-partner/.tmp-check/iso'
    const k = dataDirKey()
    expect(k).toMatch(/^-[0-9a-f]{8}$/)
    // 同输入必须同输出，否则两侧（服务端 / 客户端）会各连各的
    expect(dataDirKey()).toBe(k)
  })

  it('尾部分隔符与大小写归一化后视为同一个目录', () => {
    process.env[ENV_KEY] = 'C:/workspace/desk-partner/.tmp-check/iso'
    const a = dataDirKey()
    process.env[ENV_KEY] = 'c:\\workspace\\DESK-PARTNER\\.tmp-check\\iso\\'
    expect(dataDirKey()).toBe(a)
  })

  it('**不同隔离目录 → 不同管道**（这是本条修复的核心断言）', () => {
    process.env[ENV_KEY] = 'C:/workspace/desk-partner/.tmp-check/a'
    const a = dataDirKey()
    process.env[ENV_KEY] = 'C:/workspace/desk-partner/.tmp-check/b'
    expect(dataDirKey()).not.toBe(a)
  })

  it('隔离时的管道名与真实实例的**不相同**', () => {
    delete process.env[ENV_KEY]
    const real = pipeName()
    process.env[ENV_KEY] = 'C:/workspace/desk-partner/desk-partner/.tmp-check/iso'
    expect(pipeName()).not.toBe(real)
  })
})

/**
 * 取一个导出的顶层函数的**完整**函数体文本。
 *
 * ⚠️ 别用 `indexOf('}', start)` 找结尾 —— 那会停在模板字符串里的
 * `${currentUserKey()}` 那个 `}` 上，于是函数体被**截断在关键拼接之前**，
 * 断言"没有 dataDirKey()"会误报（本文件第一版就这么错过一次）。
 * 正确边界是**下一个顶层 `export`**（或文件末尾）。
 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}`)
  if (start < 0) throw new Error(`源码里找不到 export function ${name}`)
  const next = src.indexOf('\nexport ', start + 1)
  return src.slice(start, next < 0 ? undefined : next)
}

describe('结构性闸门：pipeName 必须真的拼上 dataDirKey', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'cli', 'pipe-protocol.ts'), 'utf8')

  it('pipeName() 的模板里同时含 currentUserKey 与 dataDirKey', () => {
    const body = fnBody(src, 'pipeName')
    expect(body).toContain('currentUserKey()')
    expect(body).toContain('dataDirKey()')
  })

  it('dataDirKey 只依赖 node: 内置模块（客户端不加载 Electron）', () => {
    const body = fnBody(src, 'dataDirKey')
    // 从 electron 取数据目录是错的：纯 Node 启动器里 require('electron') 只返回路径
    expect(body).not.toMatch(/\bapp\.getPath\b/)
  })

  it('服务端监听用的也是同一个 pipeName()（不是自己拼一份）', () => {
    const server = readFileSync(
      join(process.cwd(), 'src', 'main', 'services', 'cli-server.service.ts'),
      'utf8'
    )
    expect(server).toContain('pipeName()')
    // 不许出现第二份手写拼法
    expect(server).not.toMatch(/deskpartner-cli-\$\{/)
  })
})
