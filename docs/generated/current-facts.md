# 当前产品事实（生成文件）

> 本文件由 `node scripts/verify-current-facts.mjs` 生成。禁止手工编辑；它只记录当前源码事实，不记录历史版本。

| 项目 | 当前值 | 唯一来源 |
|---|---:|---|
| 产品版本 | **1.0.139** | `package.json` |
| schema | **v48** | `src/renderer/lib/constants.ts:DB_VERSION` |
| CLI 命令 | **76** | `src/main/cli/commands.ts` / `schema` |
| MCP 工具 | **69** | CLI 命令表 − MCP 排除表（7） |

## 使用规则

- README、AGENTS.md、Skill 和发布报告不得自行维护另一套当前数字。
- 历史发布记录可以保留历史数字，但必须明确属于历史版本。
- 若本脚本失败，说明入口文档可能已经漂移；不得把失败当成“文档问题以后再修”。
