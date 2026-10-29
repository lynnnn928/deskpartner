/**
 * MCP server 的可执行入口（打成 out/cli/mcp.cjs）
 *
 * 与 mcp-server.ts 分开：server 模块保持可导出（单测直接 import 工具表），
 * 这里只做「接上 stdio、跑起来」。
 */
import { runMcpServer } from './mcp-server'

// __MCP_VERSION__ 由 build-cli.mjs 用 esbuild define 注入（值 = package.json 的 version）
declare const __MCP_VERSION__: string

runMcpServer({
  version: __MCP_VERSION__,
  onClose: () => process.exit(0)
}).catch((err) => {
  // ⚠️ stdout 只承载 MCP 协议报文，任何日志都只能去 stderr
  process.stderr.write(`[mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
