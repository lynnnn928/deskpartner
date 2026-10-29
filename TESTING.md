# DeskPartner 测试

> **改写说明**：本文早期是一份逐文件快照报告（7 文件 78 用例）。
> 这类快照随每次改动必然腐烂（现已到 20 文件 336 用例，早年的原表全错）。
> **逐文件明细的权威来源是 `npm test` 的实际输出，不在本文维护。**
> 本文只留稳定的机制：怎么跑、覆盖哪几层、有什么坑。

## 怎么跑

```bash
npm test
```

`npm test` 内部走 `scripts/run-tests.mjs`：跑完会**自动重建 Electron 版 better-sqlite3**。
直接用 `npx vitest` 会因 ABI 不匹配失败——**必须用 `npm test`**。
只跑单个用例文件用 `test:only`。

## 覆盖分层

| 层 | 位置 | 为什么这一层不能省 |
|---|---|---|
| Repository | `tests/main/database/` | 数据读写与候选池守卫（G1/G2/G4）的唯一写入口 |
| **CLI 命令层** | `tests/main/cli/commands.test.ts` | **"参数收下了却没传下去"这类 bug 只长在这一层** —— tsc 抓不到（结构兼容），repository 单测也走不到这层 |
| Renderer 逻辑 | `tests/renderer/lib/`、`tests/renderer/stores/` | 纯函数与状态机（排序、分组、时间范围） |
| Renderer 渲染 | `tests/renderer/components/ui/*.test.tsx` | **改一个组件的 class / DOM 结构，纯逻辑用例一条都不会红** —— 渲染断言用 `@testing-library/react` + happy-dom（1.0.114 起，卡 935ea1e9）。存量不补，新增/改动的组件必带一条 |

**两端 tsc 要单独跑**（vitest 不查类型）：`tsconfig.node.json` + `tsconfig.web.json`。

## 当前概况（2026-09-24 实测，1.0.50）

- 测试文件 **29** 个（28 跑 + 1 依赖真库、刻意跳过），用例 **481** 个（**477 通过 + 4 刻意跳过**）。
- 数字会随改动变化，以 `npm test` 输出为准。
- **真实数据演练已 fixture 化**（1.0.49，修主用户 8e238221）：
  `tests/main/services/backup.drill.test.ts` 不再用某台机器的 v19 历史快照作基线
  （基线不存在就 `describe.skipIf` 整体跳过 → 4 条用例长期"假绿"，
  而演练恰恰是数据安全最后一道自检）。现在由 `tests/main/services/drill-fixture.ts`
  用真实 `runMigrations` 建表 + 合成 **200 条真实形状数据**（54 done / 20 todo /
  12 proposed / 8 in_progress / 4 awaiting_review / 2 suspended，含 emoji、
  472 字超长描述、多行、引号、父子结构、跨主体执行者、16 分类 / 2 项目 /
  2 身份 / 2 备忘），跑「导出 → 清空 → 导入 → 逐字段比对」。
  基线自检断言会先验形状（`shape.todos=200` 等），避免 fixture 退化后仍然全绿。
- **真数据黑盒往返验收**（1.0.49，兑现Bob 65e5ebc7）：`npm run verify:backup`
  一条命令跑完。它与上面的 fixture 演练**互补而非重复** ——
  fixture 回答"形状会不会退化"（任何机器都跑得住，所以进 npm test）；
  它回答"**本机真库导出的那份 JSON，导回去还一样吗**"（依赖真库，所以独立成命令）。
  做法：用 sqlite **backup API** 取真库一致性副本 → 在副本上跑往返 → 真库全程只读。
  ⚠️ 取副本**不能用 copyFile**：WAL 下最新事务可能还在 `-wal` 里没 checkpoint，
  copyFile 会拿到旧数据，那样比出来的"一致"是假的。
  ⚠️ 脚本**不能只看 vitest 退出码**：整组被跳过时退出码同样是 0
  （实测 `Tests 4 skipped (4)` → exit 0），所以脚本要自己数用例条数，
  要求 `>= 4 且 skipped == 0`。这是 8e238221"静默跳过还全绿"的同构风险。
  2026-09-23 实测：267 待办 / 16 分类 / 2 项目 / 2 身份 / 2 备忘 → 导出 316 KB →
  清空 → 导入，`skipped=0`、逐字段零差异、id 全保（含 38 条挂父级）。

## 坑

| 问题 | 解决 |
|---|---|
| better-sqlite3 为 Electron 编译，Node.js 下无法加载 | `npm test` 结束后自动还原；不要直接 `npx vitest` |
| 测试覆盖原生模块 | 必须走 `scripts/run-tests.mjs`，不能用裸 vitest |
| 🚨 **`npm rebuild better-sqlite3` 在本机必然失败** | 它走 node-gyp 现场编译，而本机没有 VS Build Tools（"Could not find any Visual Studio installation"）→ **`npm test` 死在第一步，一条用例都跑不到**（2026-09-22 实际发生）。改为 `scripts/swap-abi.mjs`：预编译产物本就在 npm 缓存里（`_prebuilds/`，node-v127 与 electron-v130 各一份），**解包替换即可**，更快且不依赖编译器。⚠️ 别用系统 `tar` 解 —— Windows 上 `C:\...` 会被当成 `host:path` 报 "Cannot connect to C: resolve failed"，脚本里改用手写 tar 解析 |
| 🚨 **vitest 要用 Node 22 跑，不能用 npm 默认的 Node 24** | npm 默认走 Node 24（ABI **137**），而缓存里只有 node-v**127**（Node 22）与 electron-v130 → 11 个测试文件全在 `new Database()` 挂掉，报 "compiled against 127, requires 137"。`run-tests.mjs` 里固定用 Node 22 的绝对路径调 `vitest.mjs` |
| **开发版 Electron 正跑着时 `npm test` 会挂** | 它在切换原生模块时要覆盖 `better_sqlite3.node`，被运行中的应用锁住就失败。**跑测试前先关掉开发版** |
| **改了主进程代码，CLI 测试好像"没生效"** | CLI 真正执行的是 `out/main/index.js`，只跑 `build-cli.mjs`（启动器）不够，**必须先 `node node_modules/electron-vite/bin/electron-vite.js build`**。2026-09-20 因此排查了两轮 |
| 起开发版报 `requestSingleInstanceLock` undefined | 环境里残留 `ELECTRON_RUN_AS_NODE`，启动前 `unset` 掉 |
| **实测新加的 CLI 命令却"不存在"** | GUI 在跑时命令走常驻管道，那头是旧代码。加 `DESKPARTNER_NO_PIPE=1` 走无头通道 |
| **改了命令表（加/删参数）忘了自检** | `DESKPARTNER_NO_PIPE=1 node out/cli/deskpartner.cjs schema` —— 1.0.32 起未知参数一律拒绝，声明没同步就是调用方直接被拒 |
| 数据库相关用例 | 用 `:memory:` + mock `getDatabase()`；schema 唯一真相是调真实 `runMigrations(db)` |
| 测外键约束 | 在用例内临时开 `foreign_keys=OFF` |
| **断言迁移 / 事件条数要用相对增量** | 全库共用一份内存库，历史记录会混进来（曾 `expected 25 to be 5`）。断言 `after - before`，不要写绝对总数 |
| **迁移 id 别用被 mock 的 `uuid`** | 用 `node:crypto` 的 `randomUUID`。被 mock 时全量 UNIQUE 冲突炸过一次（54 个测试全挂） |
| 🚨 **mock 了数据库 ≠ mock 了文件系统** | `commands.test.ts` 曾只 mock `getDatabase()`，而 `writeCredential()` 照写**真实** `~/.deskpartner/credentials.json` —— 每跑一次 `npm test` 就把Bob的凭据换成随机 token，且完全无感。**只要被测代码会落盘，就必须 `vi.mock` 掉那层**。自查法：跑测试前后对目标文件算 sha256 比对 |
| 🚨 **`beforeEach` 里 `seq = 0` 与预建对象的顺序** | 顺序反了会让预建对象消耗 `cli-uuid-N`、随后 seq 归零，用例内新建对象撞同一个 id → `UNIQUE constraint failed`。因为 N 取决于前序 describe 跑了多少次，表现是**单跑通过、全量失败**。**先重置计数器，再预建** |
| 🚨 **"单跑过、全量挂"先打印真实报错** | 上一条卡了很久，根因是**始终没打印 `res.message`** —— 一直在猜"是不是某条校验太严"，而真实报错第一行就写着是哪张表撞了。**别先改断言，先打错误** |
| ⚠️ **`run-tests.mjs` 不透传参数** | 想单跑某个用例，得手动按顺序来：`node scripts/swap-abi.mjs node` → `node node_modules/vitest/vitest.mjs run <file> -t "<用例名>"` → 跑完记得 `node scripts/swap-abi.mjs electron` 还原。直接 `npx vitest` 会撞 ABI（`NODE_MODULE_VERSION 130 vs 127`），且 npm 的 Node 24 是 ABI 137，同样对不上 |
| **原生模块 ABI 不匹配时报 `NODE_MODULE_VERSION`** | 说明 `better_sqlite3.node` 是 Electron 版。走 `scripts/run-tests.mjs`（它会切换 + 还原），别直接调 vitest |
| 🚨 **fixture 的生成时机必须在"打开库"之前** | `backup.drill.test.ts` 第一版把 `createFixtureDb()` 放在 `beforeAll`，而 `new Database(WORK_DB)` 在**模块顶层**执行 —— 文件还不存在 → 库里 0 条 → **所有断言在空库上通过**（假绿）。修复：fixture 生成移到模块顶层、且排在 `new Database` 之前。判据：**任何"依赖前序准备"的测试，都要确认准备动作真的在断言之前跑过** |
| 🚨 **`await import(...)` 只能放模块顶层，不能进 `describe` 回调** | `describe(() => { const {X} = await import(...) })` 直接报 `PARSE_ERROR: await is only allowed within async functions`，**整个文件 0 用例**（不是某条失败，是收集阶段就挂了）。2026-09-23 连踩两次。修复：动态 import 提到模块顶层，或放进 `beforeAll` 里赋值给 `let` 变量 |
| 🚨 **fixture 的形状参数要断言，不能只信"我写了"** | 同上文件第二版：`LONG_DESC` 用 `.repeat(3)` 但实际只有 173 字（漏写导致比预期短），`done` 用均匀随机只占 ~17%（34 条，真实数据是 54/200）。修复：`.repeat(2)` 实测 472 字；改用 `STATUS_PATTERN` 按真实比例的数组；**并在用例开头加 fixture 自检断言**（`expect(shape.todos).toBe(200)` 等），fixture 一旦退化立刻红 |
| ⚠️ **给"文件操作类纯函数"留导出，否则测不了** | `pruneOldBackups` 原是模块私有，只能靠 `runMigrations` 间接测（噪音大、还依赖迁移流程）。它的 bug 代价是**丢掉救命快照**（1.0.49 事故直接教训），必须能单测 → 导出并注明"仅为可测性"。同类：`listSnapshots` 本就为 doctor 而导出 |
