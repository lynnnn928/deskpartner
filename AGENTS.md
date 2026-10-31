# DeskPartner（本仓库）

人机共享的桌面工作台：人用界面，AI 用 CLI / MCP，两边读写同一份本地数据。
**这是产品本身的开发仓库**——使用说明见 `README.md` 与 CLI 的 `skill` 命令。
**要查历次版本的演进与改动 → `CHANGELOG.md`**。

> 📌 **往看板写事项前先读 `ISSUE_STYLE.md`**（标题与描述编写规范）。
> 事项是人机之间唯一的工作交接面：描述写含糊，代价不是"读起来费劲"，
> 而是**这件事实际上没交接出去** —— 一方以为说了，另一方看不懂，于是追问或漏掉。
> 待确认（`proposed`）项的判据最硬：**读完能直接回一句"选①"**。

## 怎么跑

```bash
npm install
npm run dev      # 启动开发态
npm test         # 运行单测与源码闸门
npm run build    # 构建主进程、渲染进程与 CLI/MCP 产物
npm run dist     # 打包安装包
```

测试推荐走 `npm test`（会自动对齐原生模块 ABI 并运行源码闸门与单测）。

## 技术栈

Electron 33 / Vite 5 / React 18 / TS 5.6 / better-sqlite3 / Zustand 5 / Radix / Tailwind 3

## 目录与工程约定

- `src/main/database/` —— 仓储层，**候选池守卫（G1/G2/G4）只在这里**，是唯一写入口，CLI 与 IPC 共用
- `src/main/cli/` —— CLI：**命令本身**在 `commands/<域>.ts`（todo / project / release / review / ops / governance / category / batch / agent / doc / ui / meta，每条自带参数声明，`schema` 直接序列化它，不维护第二份文档），`command-table.ts` 是它们的**聚合处**（各域数组按原表顺序拼成一张表，顺序即外部契约）与表级查询；公共基础在 `command-core.ts`（类型/上下文/守卫/参数解析）、口径常量在 `command-text.ts`、batch 体积上界在 `command-batch.ts`、单条执行在 `command-exec.ts`、schema 渲染在 `command-schema.ts`；`commands.ts` 只把它们再导出一次
- `src/renderer/lib/` —— 纯函数（分组、排序、时间），均配单测
- 界面的**设计规则**成文在 `docs/DESIGN.md`（令牌分组、刻度、四套主题职责、任意值禁令）：令牌值在 `src/renderer/styles/variables.css`，类名在 `tailwind.config.ts`，执法是 `tests/renderer/styles/design-tokens-2f6f8082.test.ts` —— **class 串里不许写任意值**（`w-[248px]` / `text-[11px]` / 裸色值），确实要写就在同一行留 `design-allow: <理由>`，闸门会数出来
- 新令牌名要**同步进 `src/renderer/lib/design-tokens.ts`**：`cn()`（tailwind-merge）不认识的名字会被当成颜色类**静默吞掉**
- 颜色令牌存的是 **R G B 三段通道**（`--color-x-rgb`，完整色值在 `variables.css` 的 `:root` 派生一次）：要透明度就写 `bg-accent/10` —— **别写** `bg-[color:var(--color-x)]/10`（Tailwind 3 对这个形态不产出 alpha 变体，类会静默失效）；主题文件只改通道变量，设置里的自定义颜色也只写通道（闸门 `tests/renderer/styles/color-channel-tokens-5fdf9b6d.test.ts`）
- 颜色令牌**只经工具类消费**：class 串里写 `bg-surface-muted`、`border-success/30`、`text-status-in-progress`，不许写 `bg-[var(--surface-muted)]` / `border-[color:var(--x)]/30` / `text-[--color-x]`。派生面（`surface-*`）没有 alpha 变体，要半透明的面就用通道色的 alpha（闸门 `tests/renderer/styles/token-utilities-5fdf9b6d.test.ts`）
- CLI 的**外部契约**（`schema` / `help` / MCP `tools/list`）有可重跑基线：`tests/main/cli/cli-contract-baseline.json`，由 `tests/main/cli/cli-contract-baseline-829ad776.test.ts` 逐条比对（名单顺序 + 逐条指纹，差异点名到具体命令/工具）。契约真变了才跑 `node scripts/update-cli-contract-baseline.mjs` 刷新，并把它的 diff 带进评审
- CLI 命令层**不许自己构造仓储**（`new XRepository()`）：构造点只有三处 —— `src/main/index.ts` 的无头通道与管道通道、`src/main/ipc.ts` 的批准回放；命令一律读 `ctx.deps.*`
- 改完必跑**两端 tsc**（vitest 不查类型）：`tsconfig.node.json` + `tsconfig.web.json`
- 前端改动要带**渲染断言**（`@testing-library/react` + happy-dom，用例写成 `.tsx`）：存量不补、增量必带（样板见 `tests/renderer/components/ui/button-render-935ea1e9.test.tsx`）
- CLI 命令层要有单测——"参数收下了没传下去"这类 bug 只长在这一层
- 交付：先升 `package.json` 版本号再打包；打包后必测 `resources/cli/deskpartner.cjs doctor`
- 静默安装路径**必须纯 ASCII**（中文路径会让 NSIS 的 `/D=` 字节错乱，生成乱码目录）

## 当前状态（2026-10-20，运行时事实以校验脚本为准）

版本 **1.0.139**（本地 main），schema **v48**，CLI **76 条命令**，MCP 工具 **69 个**，
关口 **15 条**。CLI 数量以 `node out/cli/deskpartner.cjs schema` 的 `data.commands` 为准，
MCP 数量由同一 schema 扣除 `src/cli/mcp-tools-from-schema.ts` 的唯一排除表得到；
入口文档这些数字由 `scripts/lib/current-facts.mjs` 一份判据管着：`npm test` 按**源码事实**自动核（不依赖构建产物），`npm run verify:facts` 另按跑着的应用的**运行时事实**核（含 `doctor` 来源自证），发版升号那一步用 `--fix-source` 同步版本号。
测试数量不在本文件手工维护，以最近一次 `npm test` 实测输出为准。

> 当前事实不是历史发布记录。历史版本数字必须保留在对应版本段落中，不得作为顶部当前状态。
> 任何版本、schema、CLI 或 MCP 数字变化，必须先更新唯一来源校验与入口文档，再继续开发或发布。

## 写任务库前先注册身份（agent 侧硬约束）

用 CLI / MCP 往数据库写东西时，**声明 `agent:<id>` 身份前必须已注册並经主用户批准**：

```bash
node "$DESKPARTNER_CLI" agent register   --id agent:alice --name "Alice"   # 手续：agent 自己办
node "$DESKPARTNER_CLI" agent credential --id agent:alice                  # 手续：签发本地凭据
# 然后：主窗口左下角点头像 → 用户页 → 点「批准」                             # 审批：只能由主用户做
```

**权限分四档**（`CommandSpec.risk`，未标按 write 处理）：

| 档位 | 覆盖 | 要什么手续 | 有效期 |
|---|---|---|---|
| read | 所有只读命令 | 无 | — |
| write | 改待办数据 | 批准 + 凭据 | 批准一次，长期 |
| config | `ui set` / `ui reset` | 批准 + 凭据 + **单独授权** | **仅本次会话**（8h + 会话绑定） |
| destructive | `todo rm` / `memo rm` / `project rm` / `category rm` / `telemetry clear` | 批准 + 凭据 + **单独授权** | **一次性**，用掉即止 |

撞到后两档会返回退出码 4 + `grant_required`，同时自动生成一条待审批申请；主用户在界面点允许即当场执行，agent 不需要重试。

## 常见排障要点

1. **改了主进程代码，CLI 行为却没变** → 忘了重新构建。CLI 真正加载的是 `out/main/index.js`，必须跑 `npm run build`。
2. **`npm test` 卡在原生模块切换阶段** → 多半是开发版 Electron 进程还在运行并锁着 `better_sqlite3.node`，先关闭开发版实例再测。
3. **刚加的 CLI 命令报未知命令或不接受某参数** → GUI 在跑时 CLI 默认走命名管道连正在运行的旧实例；验证未安装的本地新代码请加 `DESKPARTNER_NO_PIPE=1` 强制走无头通道。
