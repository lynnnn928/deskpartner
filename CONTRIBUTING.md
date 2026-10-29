# 贡献指南（CONTRIBUTING）

感谢你关注并参与 DeskPartner 的开发！在提交 Pull Request 之前，请先阅读以下工程约定与验证流程。

## 1. 环境要求与安装

- **操作系统**：Windows 10 / 11（x64）
- **Node.js**：推荐 **Node.js 22 LTS**（亦兼容 Node 20 / 24：仓库根 `.prebuild-installrc` 与 `postinstall` 会自动拉取 Electron 33 预编译二进制，无需安装 Visual Studio C++ 编译工具链）

```bash
git clone https://github.com/lynnnn928/deskpartner.git
cd deskpartner
npm install
```

常用命令：

```bash
npm run dev      # 启动开发态（Electron + Vite 热更新）
npm run build    # 构建主进程、渲染进程与 CLI/MCP 产物（out/）
npm test         # 运行静态检查、闸门反向验证与全量 Vitest 单测
npm run dist     # 打包 Windows NSIS 安装包
```

## 2. 原生模块 ABI 切换说明

DeskPartner 在主进程（Electron 33，ABI 130）与单元测试（Node 22，ABI 127）之间共用 `node_modules/better-sqlite3`：

- `npm install` 时通过 `.prebuild-installrc` 与 `postinstall`（`node scripts/swap-abi.mjs electron`）自动拉取并对齐到 Electron ABI（130）。
- `npm test`（`scripts/run-tests.mjs`）在检测到 Node 22 时会切到 Node ABI（127）运行 Vitest 并在结束后还原为 Electron ABI（130）；若当前环境为 Node 20 / 24 且无本地 Node 22，会自动回退使用 `node_modules/electron` 内置 Node 运行时（`ELECTRON_RUN_AS_NODE=1`）直接完成测试。
- 在没有本地 `_prebuilds` 缓存的环境中，`scripts/swap-abi.mjs` 会自动调用 `prebuild-install` 拉取对应 ABI 的官方预编译二进制。

## 3. 提交前必过的五道门禁

### 3.1 双端 TypeScript 类型检查
Vitest 运行时不检查类型，改动任何 `.ts` / `.tsx` 后必须跑通两端类型检查：

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
```

### 3.2 前端改动需附带渲染断言
修改 React 组件的 DOM 结构、交互状态或样式类时，请使用 `@testing-library/react` + `happy-dom` 编写 `.tsx` 渲染断言单测（参考 `tests/renderer/components/ui/button-render-935ea1e9.test.tsx`），不要只写纯函数断言。

### 3.3 设计令牌与样式闸门
界面样式规则定义在 [`docs/DESIGN.md`](docs/DESIGN.md)，并由源码闸门自动检查：
- **禁止任意值（Arbitrary Values）**：class 字符串中不许出现 `w-[248px]`、`text-[11px]`、裸色值等写法；确需例外时必须在同一行附上 `// design-allow: <原因>`。
- **新令牌登记**：新增 Tailwind 自定义类名时，必须同步登记到 `src/renderer/lib/design-tokens.ts`（防止 `tailwind-merge` 静默吞掉自定义类）。
- **颜色通道变量**：颜色令牌在 `src/renderer/styles/variables.css` 中以 `--color-x-rgb` 三通道定义，通过工具类（如 `bg-accent/10`、`bg-surface-muted`）消费，禁止 `bg-[var(--...)]` 写法。

### 3.4 CLI / MCP 外部契约基线
CLI 命令表位于 `src/main/cli/commands/<域>.ts`，`src/main/cli/command-table.ts` 为唯一聚合处（命令顺序即外部契约）：
- 命令层禁止直接实例化仓储（`new XRepository()`），一律通过 `ctx.deps.*` 获取。
- `schema`、`help` 与 MCP `tools/list` 受 `tests/main/cli/cli-contract-baseline.json` 与 `docs/generated/headless-surface.md` 保护。
- 若有意新增/修改命令或参数，请运行以下两个脚本刷新基线，并将 diff 一并提交评审：
  ```bash
  node scripts/update-cli-contract-baseline.mjs
  node scripts/update-surface-inventory.mjs
  ```

### 3.5 候选池与状态关口
候选池守卫（G1–G10，如待确认事项保护、执行方不可自验转完成等）集中在 `src/main/database/` 仓储层，确保 GUI（IPC）与 AI（CLI / MCP）遵守同一套数据不变量。

## 4. Pull Request 提交流程

1. Fork 本仓库并从 `main` 创建分支（如 `feat/xxx` 或 `fix/xxx`）。
2. 完成代码与对应单测，确保本地 `npx tsc --noEmit -p tsconfig.node.json`、`npx tsc --noEmit -p tsconfig.web.json` 与 `npm test` 全部通过。
3. 提交 PR 并按模板填写改动背景、实现要点与实测输出。
