# 页面 ↔ 能力映射（卡 `3f6b66e1`）

> 2026-10-28 · 基线 **1.0.124**（schema v46 / CLI 75 条 / MCP 68 个）
> 能力的出处一律指向 `docs/reviews/2026-10-28-headless-acceptance.md` 的 **C 编号**（产品出口：`dp doc show headless-acceptance`）；
> 本映射表产品出口：`dp doc show gui-page-capability-map`（与 `dp doc list` 的 `architecture` / `review` 分类同源，独立验收方无需访问本地仓库目录即可按 sha256 核对）；
> 实测回执指向 `docs/reviews/2026-10-28-headless-baseline-probe.md`。
>
> **判据**：每一页都能说清"背后是哪条已验证能力、报告里有没有出处"。**任一页找不到 C 编号即不通过**
> （本节末尾有逐页清单，16 页全覆盖才算过）。
>
> 这份表是 GUI 改造的输入（H0-4 冻结边界的落实）：页面只能消费**已有出处**的能力；
> 想新增页面，先有 C 编号，再谈界面。页面自己不得重新计算一套业务规则（路线图 §5 G2）。

| 页面（文件） | 人在这页做什么 | 背后能力 | 出处 | 判定 |
|---|---|---|---|---|
| 浮球 `windows/FloatBall.tsx` | 随手记一笔、看待批提议的入口 | 事项新建 · 待处理提议 · agent 名单 | C17、C6 | 有出处 |
| 快速添加 / 事项详情抽屉 `windows/QuickAdd.tsx`、`components/quick-add/*` | 新建与编辑事项、@ 人、挂父需求 | `todo add/update/get` · 评论与驳回 · 收口四段 | C17、C10 | 有出处 |
| 工作台 `components/workbench/WorkbenchView.tsx` | "我现在该处理什么" | `todo inbox` · `todo list`（open 四列）· 驳回/等待项 | C5、C7 | 有出处（C5 体验未通过） |
| 项目概览 `components/project/ProjectOverviewView.tsx` | 项目目标、接手说明、历史决定、最近动态、入口 | `project get` · `handoff-history` · `release list` | C4、C8、C11 | 有出处 |
| 项目事项 · 看板 `components/kanban/KanbanBoard.tsx`（含侧栏、批量条、卡片动作） | 按状态推进事项、拖拽、批量操作 | `todo list/update` · 守卫 G4/G6/G10 · 收口与驳回 · 项目增删改 | C5、C9、C10 | 有出处（C5 体验未通过） |
| 项目动态 / 项目通知 `components/timeline/TimelineView.tsx` | "这个项目发生过什么" | `todo history` · `notification list` | C12、C7 | 有出处 |
| 项目版本 `components/releases/ReleasesView.tsx` | 这一版修了什么、能否对账 | `release list/show/audit` | C11 | 有出处 |
| 全局查找 `components/workbench/GlobalSearchView.tsx` | 跨项目找事、找决定 | `project search`（`source/snippet/todoId`） | C4 | 有出处 |
| 通知中心 `components/notification/NotificationsView.tsx` | 谁交付了什么、谁驳回了什么 | `notification list` · `reminder snooze` | C12、C7 | 有出处 |
| 审批 `components/approval/ApprovalView.tsx` | 批准接入、采纳提议、处理删除授权 | `agent` 批准 · `profile/protocol/rules proposals` · 授权 | C2、C6、C7 | 有出处 |
| 统计 `components/stats/StatsView.tsx` | 吞吐、在制、交付周期、项目对比 | `telemetry stats` · `todo list`（任意状态） | C15、C5 | 有出处 |
| 用户页 `components/user/UserView.tsx` | 协作方式、关于我、团队与权限、修订历史 | `profile/protocol/rules get` · 提议 · 修订回滚 | C3、C6、C8 | 有出处 |
| 设置 `components/settings/SettingsView.tsx` | 外观、提醒、接入资料、数据目录、诊断 | `ui get/set` · `doc list/show` · `doctor` · `agent credential` | C16、C13、C14、C1 | 有出处 |
| 帮助与产品手册 `components/onboarding/QuickStartView.tsx` | 第一次上手、按章查 | `skill`（正文 + 主题）· `doc list/show` | C13 | 有出处（口径更正：整本无出口是定案，逐节可达 23/23） |
| 首次见面 `windows/Onboarding.tsx`、`windows/Welcome.tsx` | 问名字、讲怎么把 AI 接进来 | `profile` 区段 · 接入说明 | C3、C1 | 有出处 |
| 提醒横幅 `windows/ReminderBanner.tsx` | 到点提醒、一次点掉 | `reminder snooze` | C12 | 有出处 |

## 逐页清单（判据用）

16 页全部有 C 编号：浮球 · 快速添加/详情抽屉 · 工作台 · 项目概览 · 项目事项看板 · 项目动态/通知 ·
项目版本 · 全局查找 · 通知中心 · 审批 · 统计 · 用户页 · 设置 · 帮助与产品手册 · 首次见面 · 提醒横幅。

**带缺口的不是页面本身，是它们指向的能力。** 独立一手记录（`1b176fcb`）判成不通过的只有一处，
映射表跟着标出来，不当成"有出处就没事"：

- **C5（选工作）**：工作台与项目事项看板都指向它。能力都在（`todo inbox`、`todo list`），
  但陌生 agent 没有入口直接回答"我现在该动什么"（记录 §4）—— 页面有出处，**体验未通过**。
  `work next` 已实现（commit `0468f92`，未发版）；发版后由独立 agent 复验，通过前这行不改。
  （新建类页面挂在 C17「事项新建与编辑」上，不从这个缺口借账。）
- **C13（帮助与说明书）**：记录按卡标题把它读成"整本不可达"，核过之后是 **2026-10-22 的定案** ——
  整本只当真源、不补全文导出，交付判据是逐节可达；`a034c939` 的棘轮今天 23 节全部有出口。所以这页**没有缺口**。
- 其余页指向的能力体验侧通过，或未被这一轮记录逐项覆盖（**未覆盖不等于通过**，见验收报告 §2 的 ⚠️ 列）。
