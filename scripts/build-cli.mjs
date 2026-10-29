/**
 * 把 CLI 客户端启动器打成单文件
 *
 * 为什么要单独打一份：启动器必须能在**不加载 Electron** 的前提下运行
 * （它的全部意义就是省掉 Electron 的启动开销），所以不能用 electron-vite
 * 那套面向 Electron 运行时的构建。
 *
 * 产出 out/cli/deskpartner.cjs，纯 Node，node: 内置模块之外零依赖。
 */
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'out', 'cli', 'deskpartner.cjs')
const MCP_OUT = path.join(ROOT, 'out', 'cli', 'mcp.cjs')

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  await build({
    entryPoints: [path.join(ROOT, 'src', 'cli', 'launcher.ts')],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // 保持零外部依赖：只有 node: 内置模块
    external: [],
    logLevel: 'warning'
  })

  const size = fs.statSync(OUT).size
  console.log(`[build-cli] 已产出 ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(1)} KB)`)

  /**
   * MCP server bundle（1.0.59，bf736527）
   *
   * 与启动器分开打：它要带 @modelcontextprotocol/sdk + zod（打进产物，
   * 因为打包版运行环境里没有 node_modules）。入口是 mcp-main.ts，
   * 版本号用 define 注入 —— RunAsNode 运行时读不到 package.json。
   */
  await build({
    entryPoints: [path.join(ROOT, 'src', 'cli', 'mcp-main.ts')],
    outfile: MCP_OUT,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    define: { __MCP_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'warning'
  })
  const mcpSize = fs.statSync(MCP_OUT).size
  console.log(`[build-cli] 已产出 ${path.relative(ROOT, MCP_OUT)} (${(mcpSize / 1024).toFixed(1)} KB)`)

  writeCmdLauncher(OUT)
  writeMcpCmd(MCP_OUT)
}

/**
 * 生成 dp.cmd（1.0.39）：让命令行有个能直接敲的名字
 *
 * 两条约束决定了它长这样：
 *
 * 1. **不能依赖系统装了 node**。deskpartner.cjs 是纯 Node 脚本，
 *    但用户的机器上未必有 node —— 而 Electron 二进制本身就是一个
 *    Node 运行时，设 ELECTRON_RUN_AS_NODE=1 就能让它当 node 用。
 *    所以这里用「旁边的 DeskPartner.exe」来执行，零外部依赖。
 *
 * 2. **必须跑启动器（.cjs）而不是 `DeskPartner.exe --cli`**。
 *    直接 --cli 会绕过启动器，于是①不再先试常驻管道（每次都冷启动
 *    Electron，慢几十倍）；②没人注入凭据，agent 的写命令全部失败。
 *    启动器才是 CLI 的入口，--cli 只是它降级时用的后备通道。
 *
 * 目录关系：dp.cmd 与 deskpartner.cjs 同在 <安装目录>/resources/cli/，
 * 程序本体在再上两级。
 */
function writeCmdLauncher(cjsPath) {
  const cmdPath = path.join(path.dirname(cjsPath), 'dp.cmd')
  const body = [
    '@echo off',
    'setlocal',
    'rem DeskPartner 命令行入口；由 build-cli.mjs 生成，勿手改',
    'set ELECTRON_RUN_AS_NODE=1',
    '"%~dp0..\\..\\DeskPartner.exe" "%~dp0deskpartner.cjs" %*',
    'endlocal'
  ].join('\r\n')

  fs.writeFileSync(cmdPath, body + '\r\n', 'utf8')
  console.log(`[build-cli] 已产出 ${path.relative(ROOT, cmdPath)}`)
}

/**
 * 生成 mcp.cmd：MCP 客户端的启动入口
 *
 * 与 dp.cmd 同一机制（ELECTRON_RUN_AS_NODE=1 借 DeskPartner.exe 当 node），
 * 因为 MCP 客户端只认「一个可执行命令」——不能要求用户机器装了 node。
 * MCP 客户端（Claude Desktop 等）里配置 command 指到这个 cmd 即可。
 */
function writeMcpCmd(cjsPath) {
  const cmdPath = path.join(path.dirname(cjsPath), 'mcp.cmd')
  const body = [
    '@echo off',
    'setlocal',
    'rem DeskPartner MCP Server 入口；由 build-cli.mjs 生成，勿手改',
    'set ELECTRON_RUN_AS_NODE=1',
    '"%~dp0..\\..\\DeskPartner.exe" "%~dp0mcp.cjs" %*',
    'endlocal'
  ].join('\r\n')

  fs.writeFileSync(cmdPath, body + '\r\n', 'utf8')
  console.log(`[build-cli] 已产出 ${path.relative(ROOT, cmdPath)}`)
}

main().catch((err) => {
  console.error('[build-cli] 构建失败:', err.message)
  process.exitCode = 1
})
