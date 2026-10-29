# 设计规则（判据级）

> 只回答"什么时候用哪一个"。**值**在 `src/renderer/styles/variables.css`，**类名**在
> `tailwind.config.ts`，**执法**在 `tests/renderer/styles/design-tokens-2f6f8082.test.ts`。
> 旧的 `desk_partner_visualdesign.md` 头部已标"作废"，不要再以它为准。
> 本文只在"判据变了"时改，不抄代码 —— 抄了必然与代码漂移。

## 一句话

颜色只剩两种合法用途：**语义**（信号灯：绿=完成 / 琥珀=注意 / 红=逾期）与
**识别**（列头状态点、项目色带、身份角标）；其余 chrome 一律墨黑。

## 令牌分组

| 组 | 什么时候用 | 不要用来 |
|---|---|---|
| `--color-accent`（墨黑） | 主按钮、焦点框、激活态 | 表达"重要/优先"——那是优先级图标的事 |
| `--color-status-*` | 列头圆点、状态徽章 | 大面积底色（四条色带会盖过卡片） |
| `--color-danger / --status-warning` | 删除、逾期、失败 | 普通提示 |
| `--surface-subtle / -muted` | 次级容器、选中态的浅底 | 正文背景 |
| `--radius-*` | 见下表刻度 | 一处的"看起来更圆" |
| `--shadow-*` | card（静置）/ card-hover（可点）/ drag / float（悬浮层）/ soft·soft-hover·hero（onboarding）/ glow（悬浮球光晕） | 给静态块加浮起阴影 |
| `--size-*` | 侧栏、抽屉、对话框三档、内容区上限 | 组件内部的一处偏移 |

## 刻度

| 用途 | 令牌 | 值 |
|---|---|---|
| 微字（计数、时间戳、来源） | `text-caption` | 11px |
| 标签、按钮、正文、列标题、标题、整屏标题 | `text-label` 12 / `text-button` 13 / `text-content` 14 / `text-body` 16 / `text-column-title` 16 / `text-title` 22 / `text-display` 26 | 全部乘 `--font-scale` |
| 全大写小标题字距 / 大标题字距 | `tracking-label` 0.12em / `tracking-title` -0.02em | 两档，不要第三档 |
| 圆角 | `rounded-xs` 4 / `input`·`button` 8 / `tag` 11 / `card` 14 / `quick-add` 18 / `panel` 20 | — |
| 间距 | Tailwind 刻度 + 半档 `0.75`(3) `1.75`(7) `3.75`(15) `4.5`(18) `5.5`(22) | 别写 `px` 任意值 |
| 对话框宽 | `w-dialog-sm` 420 / `md` 560 / `lg` 720（值里自带 `min(…, 92vw)`） | 别自己写 `w-[…] max-w-[…]` 两份 |

## 颜色：存通道，不存色值

颜色变量只存 **R G B 三段**（`--color-accent-rgb: 17 24 39`），完整色值在 `:root` 派生一次
（`--color-accent: rgb(var(--color-accent-rgb))`），tailwind 映射到
`rgb(var(--color-accent-rgb) / <alpha-value>)`。

三条判据：

- **令牌颜色只经工具类消费，要透明度就直接写 `/10`、`/70`**（`bg-accent/10`、`border-success/30`）。
  不许在 class 串里写 `border-[color:var(--color-success)]/30`、`bg-[var(--surface-muted)]` ——
  那是把颜色层的写法在组件里又抄一遍，令牌改名时只有用到它的组件静默失效；
  更不许写 `text-[--color-x]`（Tailwind 3 的任意值里裸变量要 `var()`，这种简写**一条 CSS 都不产出**）。
  这三条由 `tests/renderer/styles/token-utilities-5fdf9b6d.test.ts` 扫全量源码执法。
- **主题只改通道变量**（`--color-x-rgb`），不许在 `themes/*.css` 里写完整色值 ——
  那是"同一件事两处来源"（闸门：`tests/renderer/styles/color-channel-tokens-5fdf9b6d.test.ts`）。
- **JS 写行内覆盖也写通道**（设置里的「自定义颜色」走 `applyCustomColors`）：
  只写 `--color-x` 时 `bg-accent`（主按钮底色）读的是通道变量，等于设了颜色却不生效。
- **派生面没有 alpha 过体**：`bg-surface-subtle` / `bg-surface-muted` 是由颜色通道 color-mix 出来的面，
  不是通道三元组，所以写 `bg-surface-muted/50` 等于什么都没产出。要一层半透明的面，
  用通道色的 alpha（`bg-text-primary/5`），别给派生的面加 alpha。

## 四套主题各改什么

`light` 不是一套主题文件，而是 `variables.css` 的 `:root`（**唯一权威**）。
`dark` / `frosted` / `japanese` 只覆盖**令牌值**（颜色、阴影、磨砂透明度），
不许写组件样式，也不许重复声明 `:root` 已有的变量 ——
后者是"两处来源"，1.0.48 的配色整轮没生效就是它（闸门：`tests/renderer/styles/theme-vars.test.ts`）。

## 可调界面参数契约表（`UI_WHITELIST`，卡 `e5c23a1e`）

CLI `dp ui get / set / reset` 与设置页共用的 17 项纯视觉参数契约（真源：`src/main/cli/commands/ui.ts` 与 `src/main/database/settings.repository.ts`，由 `tests/renderer/styles/ui-whitelist-contract-e5c23a1e.test.ts` 守同源）：

| 参数名（`key`） | 说明 | 类型与合法范围 | 默认值 | 令牌落点与覆盖陷阱 |
|---|---|---|---|---|
| `theme` | 明暗主题 | `enum`: `light / dark` | `light` | `dataset.theme`；`light` 直接走 `variables.css` 的 `:root`，不挂独立文件 |
| `stylePreset` | 风格预设 | `enum`: `frosted / japanese` | `frosted` | `dataset.preset`；只改令牌值，不写组件样式 |
| `bgOpacityOverride` | 磨砂底色不透明度覆盖（null/留空 = 跟随风格预设） | `number`: `0.3~1`（或 `null`） | `null` | `--frosted-bg-opacity`；**覆盖陷阱**：`null` 时不写行内样式，交由 `themes/*.css` 生效；显式设值后写行内压过预设，需 `ui reset --key bgOpacityOverride` 复位 |
| `fontSizeScale` | 全局字号 | `enum`: `small / normal / large` | `normal` | `--font-scale`（`0.9 / 1 / 1.1`），所有 `text-*` 刻度均乘此系数 |
| `kanbanBorderRadius` | 看板圆角 | `number`: `0~32` | `20` | `--radius-panel`（px） |
| `cardBorderRadius` | 卡片圆角 | `number`: `0~24` | `14` | `--radius-card`（px） |
| `kanbanColumnHeaderHeight` | 列头高度 | `enum`: `compact / standard / spacious` | `standard` | `--column-header-height` |
| `cardSpacing` | 卡片间距 | `enum`: `compact / standard / spacious` | `standard` | `--space-card` |
| `cardActionsAlwaysVisible` | 卡片操作按钮常显 | `boolean`: `true / false` | `false` | `false` 时仅悬停显现操作按钮 |
| `quickAddBorderRadius` | 快速新增弹窗圆角 | `number`: `0~24` | `18` | `--radius-quick-add`（px） |
| `quickAddPadding` | 快速新增弹窗内边距 | `enum`: `compact / standard / spacious` | `standard` | `--space-quick-add` |
| `floatBallSize` | 悬浮球大小 | `number`: `32~96` | `48` | 悬浮球直径与窗口尺寸（px） |
| `floatBallOpacity` | 悬浮球不透明度 | `number`: `0.3~1` | `1` | 悬浮球容器整体不透明度 |
| `floatBallColor` | 悬浮球颜色 | `color`: `#RGB 或 #RRGGBB`（或 `null`） | `null` | **覆盖陷阱**：`null` 时跟随全局强调色 `--color-accent`；设色后独立覆盖，用 `ui reset --key floatBallColor` 恢复跟随 |
| `floatBallEdgeHide` | 悬浮球贴边隐藏 | `boolean`: `true / false` | `true` | 拖至屏幕边缘自动收起 |
| `floatBallShowIcon` | 悬浮球显示图标 | `boolean`: `true / false` | `true` | 显示中央品牌/自定义图标 |
| `floatBallShowGlow` | 悬浮球显示光晕 | `boolean`: `true / false` | `true` | 开启时使用 `--shadow-glow` 呼吸光晕 |

**不向 Agent 开放的系统/隐私/坐标项（`UI_EXCLUDED`）**：`autoStart`（开机自启）、`globalShortcut`（全局快捷键）、`telemetryEnabled`（隐私审计开关）、`kanbanAlwaysOnTop`（窗口置顶行为）、`kanbanWindowBounds`（主窗口坐标）、`floatBallPosition`（悬浮球坐标）、`customColors`（嵌套通道色对象，写行内需同步写 `--color-x-rgb` 通道变量）。

## 基础件

- **Button**：变体与尺寸是数据（`buttonVariants`，cva），加第四种只加一行；页面里别再内联覆盖尺寸。
- **Badge / EmptyState**：独立文件（`components/ui/Badge.tsx`、`EmptyState.tsx`）。
- **卡片还没有基础件**（`Card` 待做）：新页面请复用现有 `rounded-card border … bg-bg-card` 组合，
  并在卡里记一笔 —— 往同一文件里再抄一遍是这张待办在涨。
- 组件外裸 `<button>`（117 处 / 50 文件）与手写 `rounded-button`（26 处 / 13 文件）尚未收编，
  属两张独立待办。数字由 `grep` 数出（排除注释行与 `ui/Button.tsx`），会随改动漂移。

## 布局与控件（决定体感的三条）

- **表头即筛选**：带表头的列表不在表外另摆一排同维度下拉框；6 列维度直接在对应表头列触发筛选并回显已选值，表外标题行只留关键字搜索与重置。
- **属性表替代胶囊平铺**：详情抽屉与表单采用「左固定宽标签 + 右紧凑控件」对齐行；候选 > 4 项的枚举（标签、提出者、父需求）默认只展示已选值与展开入口，禁止把几十个未选项平铺在表面。
- **色点 + 中性底色替代彩块**：项目与标签色只画 `6px` 圆点，胶囊底色统一走中性面（`bg-bg-card` / `bg-surface-subtle`），禁止 `color + '40'` 彩底配 `border-2 scale-105`。
- **详情抽屉三段式**：顶部文档区（编号/父级面包屑 + 无底线大标题 + 规格描述框）→ 中部属性面板 → 底部动态区（子任务 / 本次变更 / 评论 / 变更记录）+ 常驻保存栏。

## 语义角色与五大交互契约（1.0.122 四契约，卡 d930dfb5；命名契约卡 66be78f4）

- **语义排版四角色（禁止单页混排 > 3 种字号、> 2 种字重）**：
  - `SectionTitle`（卡片/区块标题）：统一 `text-content font-semibold text-text-primary`（14px/600）。
  - `ItemTitle`（事项/条目主标题）：全站所有页面统一 `text-content font-normal text-text-primary`（14px/400），禁止缩为 12px 或整行加粗 600。
  - `BodyText`（正文/说明）：`text-label text-text-secondary`（12px/400）。
  - `MetaText`（元信息/时间戳/短号）：`text-caption text-text-secondary`（11px/400，数字等宽 `font-mono`）。
- **五大交互契约**：
  - **同物同形契约**：全站事项状态统一调用 `<TodoStatusPill status={...} />`（7 色专属状态圆点 + 状态名）；优先级统一调用 `<TodoPriorityBadge priority={...} />`。
  - **读写分离契约**：事项描述、项目接手说明默认渲染 `<MarkdownContent>` 阅读视图，点击切入 `<textarea>` 编辑；列表单行摘要统一经 `stripMarkdown()` 剥离 `# * \`` 语法符号。
  - **行动即达契约**：待办动作（如审批失败行的二次确认 `[仍然删除] [放弃]`）直接浮现在行面右侧，不藏进折叠层。
  - **心智隔离契约**：界面严禁裸露 `G1~G10`、`agent:xxx`、`human` 等内部代号。
  - **审批动作命名契约**：同一状态在横幅 / 审批页 / 审批历史行必须是同一个词，字只从 `src/renderer/lib/approval-copy.ts` 取。
    首次同意统一「允许」+ 范围后缀（**一次** = 一次性授权 / **本次会话** = 界面配置 / **无后缀** = 长期写入）；
    覆盖警告的那一步统一「仍然 + 动词」（`[仍然删除]`），别再用「确认删除」——那会把"我知道有风险、仍然继续"读成"请确认第一步"；
    撤销统一「放弃」，从未同意的才是「拒绝」。**副作用不写进按钮名**（「允许并执行」已废弃）：
    "允许后会发生什么"交给旁边的说明（明细行 / `title`），按钮只回答"我在同意哪一步"。

## 任意值

class 串里不许出现 `w-[248px]`、`text-[11px]`、`shadow-[…rgba(…)]`：magic number 与裸色值一律进令牌。
确实要写（打印宽度、第三方给的尺寸）时，在**同一行**写 `design-allow: <理由>`，闸门会把它数出来。
**令牌引用型任意值**（`bg-[var(--surface-muted)]`、`border-[color:var(--x)]/30`、`text-[--color-x]`）
也不再允许：接进 tailwind 后一律用名字（`bg-surface-muted`、`border-success/30`、`text-status-in-progress`）。
剩下的合法例外是间距 / 尺寸这类**没有对应工具类**的令牌引用（`p-[var(--space-page)]`），
它们由 `design-tokens-2f6f8082` 的扫描器明确放过；颜色层的不放过。

## 已知缺口（2026-10-27，1.0.115 后）

- **数据里的颜色**（分类/项目色板、agent 紫 `#A855F7`、系统灰 `#94A3B8`）仍在 `lib/constants.ts` 等处散着。
- **亮色下的 warning / success 对比度偏低**：`#D97706` 在 `#F7F7F5` 上是 2.97:1、`#16A34A` 是 3.07:1
  （小字标签读起来偏灰）。这是既定调色板的读数，改值属设计决定，**没动**；
  深色下那两个提亮档（`--color-danger-rgb` / `--status-warning-rgb`）已于 1.0.115 补齐（5.05 / 7.5:1）。
- **普通 CSS 类会压过同一元素上的工具类**：`.sidebar-nav .nav-group-label`（`globals.css`）
  自带 `font-size: 10px / letter-spacing: 0.04em`，元素上那个 `text-label` **形同虚设**
  （实测计算值仍是 10px，不是 12px）。要么把这些值也换成令牌，要么别在元素上留这个类。
