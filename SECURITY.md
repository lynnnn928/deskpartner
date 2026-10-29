# 安全策略（Security Policy）

## 支持的版本

DeskPartner 当前仅对最新发布的 `1.0.x` 正式版本提供安全更新支持：

| 版本 | 是否支持 |
| --- | --- |
| 最新 `1.0.x` Release | ✅ 支持 |
| 旧历史版本 | ❌ 请升级至最新版 |

## 安全与隐私边界说明

DeskPartner 是运行在本地桌面的协作工具：
- **本地存储**：所有事项、项目、备忘、身份凭据与使用统计均保存在用户本机 SQLite 数据库（`%APPDATA%/desk-partner/user.db`）与用户目录（`~/.deskpartner/credentials.json`）中。
- **网络访问**：应用**仅在检查版本更新时**访问 GitHub Releases（可在「设置 → 系统 → 自动检查更新」中关闭），不设任何云端账号或后台上报服务，不会上传任何本地数据。
- **AI 权限门禁**：本地 AI 助手通过 CLI 或 MCP 接入时，写操作须经主用户在桌面界面批准身份，删除与配置类高风险操作须经主用户在界面点选授权后方可执行。

## 私下报告安全问题

如果你发现了潜在的安全漏洞（例如：未授权的本地权限绕过、HTML/Markdown 渲染沙箱逃逸、路径穿越等），**请勿在公开 Issue 中直接披露细节**。

请通过以下方式私下报告：
1. 使用 GitHub 仓库的 **Private Vulnerability Reporting**（[提交私密安全报告](https://github.com/lynnnn928/deskpartner/security/advisories/new)）。
2. 在报告中附上复现步骤、影响范围及所在版本号。

作为个人开源项目，维护者会在收到报告后尽快确认并排期修复，修复发布后再公开致谢与披露详情。
