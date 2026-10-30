# DeskPartner

**让 AI 接着工作，从当前进展继续——多 AI 共享的本地结构化项目记忆与接续工作台。**

[产品主页](https://lynnnn928.github.io/deskpartner/) · [在线手册](https://lynnnn928.github.io/deskpartner/#manual) · [llms.txt (AI 读取)](https://lynnnn928.github.io/deskpartner/llms.txt) · [English](README.en.md) · [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [下载最新版](https://github.com/lynnnn928/deskpartner/releases)

> **3 秒看懂 DeskPartner 的定位与边界**
>
> - ❌ **不是 AI 调度平台**：不内置大模型、不持有 API 密钥、不主动发起推理，不替代你现有的 AI 工具。
> - ✅ **是标准 MCP 服务器与本地项目记忆空间**：接入你正在使用的 **Claude Desktop / Cursor / Codex** 等客户端，为它们提供统一的项目接手说明（Handoff）、历史决定检索、任务流转与人机审批关口。
>
> 🤖 **【AI 助手接入指引】**：若你是 AI 助手，请先调用 `get_guide` 工具或运行 `node "$DESKPARTNER_CLI" skill` 读取接入说明书，完成身份注册后再执行后续操作；未安装本机客户端时可直接读取 https://lynnnn928.github.io/deskpartner/llms.txt 。

---

## 为什么需要 DeskPartner？

当你同时使用两三个 AI 助手（Claude Desktop、Cursor、Codex 等）推进同一个长期项目时，往往会卡在三个痛点上：

1. **多个 AI 窗口上下文孤岛**：背景和决定散落在各自的聊天记录里，换个工具或新开会话就要从头复述一遍。
2. **执行进度与质量难以全局把控**：不知道哪个 AI 真做完了、哪个只改了一半，AI 还常把「代码写完」直接当成「验证通过」。
3. **给 AI 开放本地工具缺乏安全边界**：普通脚本或裸数据库工具一旦接通就能随意删改，缺少按风险分级的授权与人工把关。

### 三角色分工：只做中间层，不抢 AI 的活

| 角色 | 职责边界 |
|---|---|
| **AI 助手（执行者）** | 在你熟悉的客户端里理解意图、读取项目上下文、执行任务、提交验证证据与变更提议。 |
| **DeskPartner（共享记忆与状态服务）** | 作为本地标准 MCP / CLI 服务，保存项目背景、历史决定、7 态工作流与审计留痕，让不同 AI 看到同一份事实。 |
| **你（决定者与验收者）** | 掌握首尾两道关口（拍板立项与结果验收），审批高风险写入，决定项目下一步往哪里走。 |

---

## 核心差异化能力

- **跨 Agent 结构化项目记忆（Handoff）**：每个项目自带支持 50 版修订历史与 `#8位编号` 实时状态引用的「接手说明」。上一个 AI 交活时提交关键决定更新，下一个 AI 新开窗口调用 `get_project` / `search_project` 即可直接接着干。
- **首尾双关口与禁止自验自过**：事项沿 7 态流转（`proposed` → `todo` → `in_progress` → `awaiting_review` → `done` 及 `suspended` / `discarded`）。AI 提的新想法先进「待确认」等你立项；做完的活只能附四段式验证证据推到「待验收」，**执行者无法将自己做的事直接标为完成**。
- **四档权限分级与「批准即执行」**：
  - `01 只读查询`：免批通行；
  - `02 日常协作写入`：首次注册经你在桌面端一键批准身份后持本地凭据通行，随时可暂停或吊销；
  - `03 界面外观设置`：支持「允许一次」或会话级授权；
  - `04 删改数据与变更协议`：修改接手说明、协作协议或删除数据时，生成绑定目标与内容摘要的单次审批单，你在界面点「批准」的那一刻由系统代为执行。
- **100% 本地优先，纯离线无云端**：所有数据保存在本机 SQLite 数据库（`user.db`），无账号体系、不上传任何项目内容，升级与导入前自动生成快照备份。

---

## 界面预览

### 1. 项目接手说明：换个 AI 窗口也能直接从当前进展继续
![DeskPartner 项目接手说明](docs/assets/project-handoff.png)

### 2. 审批对比：看清改动差异再点头
![DeskPartner 审批中心](docs/assets/approval-view.png)

### 3. 共享看板：几个 AI 在干什么、哪张卡等你验收一眼看清
![DeskPartner 项目看板](docs/assets/kanban-board.png)

### 4. 快速上手：一键复制带本机路径的接入指令
![DeskPartner 快速上手](docs/assets/quickstart-view.png)

---

## 下载与安装

1. 前往 [GitHub Releases](https://github.com/lynnnn928/deskpartner/releases) 下载最新的安装包 **`DeskPartner.Setup.x.y.z.exe`**（支持 Windows 10 / 11 64 位）。
2. 双击运行安装程序，可自由选择安装目录（建议保持纯英文路径）。

### 关于 Windows SmartScreen 提示

作为个人开源项目，安装包暂未购买商业代码签名证书。首次运行安装程序时，若 Windows 弹出蓝色保护提示，请按以下两步放行：

![Windows SmartScreen 放行说明](docs/assets/smartscreen-guide.svg)

1. 点击窗口中的 **「更多信息」**（More info）；
2. 点击右下角出现的 **「仍要运行」**（Run anyway）即可正常安装。

---

## 3 步把你的 AI 助手接进来

安装并打开 DeskPartner 后，点击主窗口左下角的 **`?`（快速上手）**，即可一键复制**已自动填好你本机真实路径**的开场提示词发给 AI；也可以直接复制下方标准接入 Prompt 与 MCP 配置：

### 标准 AI 接入开场 Prompt（可直接复制发给你的 AI）

```text
请先调用 DeskPartner 的 get_guide 工具（若你有终端权限也可直接运行 node "$DESKPARTNER_CLI" skill）阅读接入说明书，用你自己的名字注册身份（agent register + agent credential），然后查看我当前的项目接手说明与待办事项。
```

### 第 1 步：将 DeskPartner 加进 AI 客户端的 MCP 配置

在支持 MCP 的客户端（如 Claude Desktop、Cursor、Codex 等）配置文件中加入 `deskpartner`（请将路径替换为你本机的实际安装位置，可在「快速上手」或「设置 → 系统」直接复制）：

```json
{
  "mcpServers": {
    "deskpartner": {
      "command": "C:\\Users\\<你的用户名>\\AppData\\Local\\Programs\\desk-partner\\resources\\cli\\mcp.cmd",
      "args": [],
      "env": {
        "DESKPARTNER_AGENT": "agent:claude"
      }
    }
  }
}
```

> **终端 CLI 直连方式**：如果你的 AI 助手可以直接执行终端命令，无需配置 MCP，直接让它运行 `node "$DESKPARTNER_CLI" skill` 即可（DeskPartner 启动时会自动在当前用户环境变量中写入 `DESKPARTNER_CLI` 指向本机 CLI 入口）。
>
> **安装目录迁移提示**：在原目录升级版本无需重新配置；若卸载重装时更换了安装目录，请重启一次已开启的终端/AI 宿主（或从「快速上手」复制最新路径），MCP 客户端覆盖新路径后重连即可。

### 第 2 步：让 AI 自助注册身份并领证

发送上方的标准开场 Prompt 后，AI 会自己办完注册与领证手续（`agent register` + `agent credential`）。此时它处于待批准状态，任何写操作都会被门禁拦截。

### 第 3 步：在桌面界面点一次「批准」

当 AI 完成注册时，DeskPartner 桌面端顶部会弹出提醒横幅（侧边栏「审批」也会亮起角标）。点击 **「批准」** 后，这个 AI 就可以正式在项目里读取上下文、记录进展并提交交付成果了。

---

## 数据存哪与隐私说明

- **数据存储位置**：
  - 核心数据库默认保存在本机 `%APPDATA%\desk-partner\user.db`（可在「设置 → 系统 → 数据存储目录」中一键打开文件夹，或随时迁移到其它磁盘目录）。
  - 每次数据库结构升级或导入备份前，都会在同一目录下自动生成带时间戳的 SQLite 一致性快照备份。
  - 本地 AI 凭据保存在 `~/.deskpartner/credentials.json`（导出 JSON 数据备份时会自动剥离凭据哈希，防止密钥外泄）。
- **隐私与联网说明**：
  - **本地使用统计（Telemetry）**：默认开启，用于生成侧边栏「统计」页的协作洞察与命令耗时分析；**数据只保存在本机 SQLite 数据库中**，可在「设置 → 数据管理 → 使用数据」中随时关闭或一键清空。
  - **网络访问边界**：应用**仅在检查版本更新时访问 GitHub Releases**（可在「设置 → 系统 → 自动检查更新」中关闭），无账号体系、无云端后台，**不上传任何本地数据**。

---

## 项目预期、赞助支持与文档导航

> **个人项目，尽力维护**：DeskPartner 是一个源于日常真实多 AI 协作需求的个人开源项目（MIT License）。每一个版本都在管理它自身的迭代中打磨验证。欢迎前往 [产品主页](https://lynnnn928.github.io/deskpartner/) 查看图览与 [在线使用手册](https://lynnnn928.github.io/deskpartner/#manual)，或提交 [Issue](https://github.com/lynnnn928/deskpartner/issues) 与 [Pull Request](https://github.com/lynnnn928/deskpartner/pulls)，作者会在业余时间尽力维护与响应。
>
> **赞助支持**：如果 DeskPartner 帮你理顺了手下多个 AI 的协作节奏，欢迎点亮一颗 Star，或通过 [爱发电 (AfDian)](https://afdian.com/a/lynnnn928) / [GitHub Sponsors](https://github.com/sponsors/lynnnn928) 请作者喝杯咖啡，支持后续迭代与代码签名证书筹备。

### 深入文档与工程契约

- [`CHANGELOG.md`](CHANGELOG.md) —— 历次版本更新日志与演进记录
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 本地开发环境搭建、测试门禁与贡献指南
- [`SECURITY.md`](SECURITY.md) —— 安全策略与私密漏洞报告渠道
- [`COLLABORATION.md`](COLLABORATION.md) & [`ISSUE_STYLE.md`](ISSUE_STYLE.md) —— 人机看板协作约定与四段式收口规范
- [`docs/DESIGN.md`](docs/DESIGN.md) —— 界面设计令牌、语义排版角色与 `UI_WHITELIST` 契约表
- [`docs/generated/headless-surface.md`](docs/generated/headless-surface.md) —— CLI / MCP 命令清单、权限档位与关口全表

### 当前源码基线（由校验脚本自动核对）

| 项 | 实况 |
|---|---|
| 代码版本 | **1.0.138**（`package.json`；当前源码基线） |
| schema | **v48**（当前唯一值见 `src/renderer/lib/constants.ts:DB_VERSION`；历史演进见 [`CHANGELOG.md`](CHANGELOG.md)） |
| CLI | **76 条命令**（命令表与 `schema` 同源；以 `node out/cli/deskpartner.cjs schema` 的 `data.commands` 为准） |
| MCP | **69 个工具**（由 CLI schema 扣除 MCP 排除表生成；以 MCP `tools/list` 为准） |
| 关口 | **15 条**（定义于 `src/main/cli/gates.ts`，由数据层与执行层统一守卫） |

---

## 许可证 (License)

本项目基于 [MIT License](LICENSE) 开源。Copyright (c) 2026 LiLin (lynnnn928).
