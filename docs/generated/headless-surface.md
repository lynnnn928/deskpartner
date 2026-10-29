# Headless 能力清点（生成文件）

> 本文件由 `node scripts/update-surface-inventory.mjs` 生成，**禁止手工编辑**。
> 唯一来源：`src/main/cli/command-table.ts`（命令）、`gates.ts`（关口）、
> `error-codes.ts`（错误码）、`src/cli/mcp-tools-from-schema.ts`（MCP 映射与排除表）。
> 源码侧闸门：`tests/main/cli/headless-surface-f45a49c1.test.ts`（逐字比对）。
> 实际返回形状不在这里 —— 见 `docs/reviews/2026-10-28-headless-baseline-probe.md`。

## 1. 规模

| 项 | 数量 |
|---|---:|
| CLI 命令 | **76** |
| MCP 工具（命令表 − 排除表 7 条） | **69** |
| 读档（免身份，可自由重试） | 38 |
| 写档（需已批准 + 有效凭据） | 30 |
| 配置档（仅本次会话有效） | 2 |
| 删除档（一次性授权，用掉即止） | 6 |
| 关口 | **15** |
| 稳定错误码 | 15 |

## 2. 命令清单

列含义：**风险档** = 这一条要什么手续（`read` 免身份 / `write` 需凭据 / `config` 仅本次会话 / `destructive` 一次性授权）；**data** = 成功回执里 `data` 的形状（`array` / `object`，信封类才有）；**MCP** = 这个能力能不能从 MCP 调。

| # | 命令 | 风险档 | 出参 | data | MCP 工具 | 位置参数 | 必填参数 |
|---:|---|---|---|---|---|---|---|
| 1 | `schema` | read | json | `object` | 不暴露（排除表） | — | — |
| 2 | `notification list` | read | json | `object` | `list_notifications` | — | — |
| 3 | `todo inbox` | read | json | `object` | `inbox_todos` | — | — |
| 4 | `todo comment` | write | json | `object` | `comment_todo` | `id`（必填） | — |
| 5 | `todo reject` | write | json | `object` | `reject_todos` | `id`（必填） | — |
| 6 | `todo close` | write | json | `object` | `close_todos` | `id`（必填） | — |
| 7 | `todo delete-comment` | write | json | `object` | `delete_comment_todos` | `id`（必填） | — |
| 8 | `reminder snooze` | read | json | `object` | `snooze_reminder` | — | — |
| 9 | `doctor` | read | json | `object` | 不暴露（排除表） | — | — |
| 10 | `todo add` | write | json | `object` | `add_todo` | — | `--title` `--project` |
| 11 | `todo list` | read | json | `array` | `list_todos` | — | — |
| 12 | `todo update` | write | json | `object` | `update_todo` | `id`（必填） | — |
| 13 | `todo done` | write | json | `object` | `done_todos` | `id`（必填） | — |
| 14 | `todo pin` | write | json | `object` | `pin_todos` | `id`（必填） | — |
| 15 | `todo unpin` | write | json | `object` | `unpin_todos` | `id`（必填） | — |
| 16 | `todo rm` | destructive | json | `object` | `rm_todos` | `id`（必填） | — |
| 17 | `todo get` | read | json | `object` | `get_todo` | `id`（必填） | — |
| 18 | `todo history` | read | json | `object` | `history_todos` | `id`（必填） | — |
| 19 | `todo children` | read | json | `object` | `children_todos` | `id`（必填） | — |
| 20 | `telemetry stats` | read | json | `object` | `stats_telemetry` | — | — |
| 21 | `telemetry export` | read | ndjson | 无信封（NDJSON 逐行） | `export_telemetry` | — | — |
| 22 | `telemetry clear` | destructive | json | `object` | 不暴露（排除表） | — | — |
| 23 | `protocol get` | read | json | `object` | `get_protocol` | — | — |
| 24 | `profile get` | read | json | `object` | `get_profile` | — | — |
| 25 | `profile propose` | write | json | `object` | `propose_profile` | — | `--block` `--body` |
| 26 | `profile proposals` | read | json | `array` | `list_profile_proposals` | — | — |
| 27 | `protocol propose` | write | json | `object` | `propose_protocol` | — | `--block` `--body` |
| 28 | `protocol proposals` | read | json | `array` | `list_protocol_proposals` | — | — |
| 29 | `rules get` | read | json | `object` | `get_rules` | — | — |
| 30 | `rules propose` | write | json | `object` | `propose_rules` | — | `--rule` `--enforcement` |
| 31 | `rules proposals` | read | json | `array` | `list_rule_proposals` | — | — |
| 32 | `project handoff-propose` | write | json | `object` | `propose_handoff` | `id`（必填） | — |
| 33 | `project handoff-proposals` | read | json | `array` | `list_handoff_proposals` | — | — |
| 34 | `project handoff-update` | write | json | `object` | `update_handoff` | `id`（必填） | — |
| 35 | `skill` | read | text | 无信封（正文） | `get_guide` | `topic`（可选） | — |
| 36 | `todo set-owner` | write | json | `object` | `set_owner_todos` | `id`（必填） | `--owner` |
| 37 | `project add` | write | json | `object` | `create_project` | — | `--name` |
| 38 | `project list` | read | json | `array` | `list_projects` | — | — |
| 39 | `project get` | read | json | `object` | `get_project` | `id`（必填） | — |
| 40 | `project search` | read | json | `array` | `search_project` | `id`（必填） | `--query` |
| 41 | `project handoff-history` | read | json | `object` | `list_handoff_revisions` | `id`（必填） | — |
| 42 | `project handoff-revision` | read | json | `object` | `get_handoff_revision` | `id`（必填） | `--revision` |
| 43 | `project handoff-rollback` | write | json | `object` | `rollback_handoff` | `id`（必填） | `--revision` |
| 44 | `project archive` | write | json | `object` | `archive_projects` | `id`（必填） | — |
| 45 | `project unarchive` | write | json | `object` | `unarchive_projects` | `id`（必填） | — |
| 46 | `project rm` | destructive | json | `object` | `rm_projects` | `id`（必填） | — |
| 47 | `release add` | write | json | `object` | `add_release` | — | `--version` `--project` |
| 48 | `release list` | read | json | `array` | `list_release` | — | — |
| 49 | `release show` | read | json | `object` | `show_release` | `version`（必填） | `--project` |
| 50 | `release audit` | read | json | `object` | `audit_release` | — | `--project` |
| 51 | `release update` | write | json | `object` | `update_release` | `version`（必填） | `--project` |
| 52 | `release rm` | destructive | json | `object` | `rm_release` | `version`（必填） | `--project` |
| 53 | `memo add` | write | json | `object` | `add_memos` | — | `--text` |
| 54 | `memo list` | read | json | `array` | `list_memos` | — | — |
| 55 | `memo ack` | write | json | `object` | `ack_memos` | `id`（必填） | — |
| 56 | `memo rm` | destructive | json | `object` | `rm_memos` | `id`（必填） | — |
| 57 | `category list` | read | json | `array` | `list_categories` | — | — |
| 58 | `category add` | write | json | `object` | `add_categories` | — | `--name` |
| 59 | `category rm` | destructive | json | `object` | `rm_categories` | `id`（必填） | — |
| 60 | `category merge` | write | json | `object` | `merge_categories` | `ids`（可选） | — |
| 61 | `batch` | write | json | `object` | `batch` | — | — |
| 62 | `ui get` | read | json | `object` | 不暴露（排除表） | — | — |
| 63 | `ui set` | config | json | `object` | 不暴露（排除表） | — | `--key` `--value` |
| 64 | `ui reset` | config | json | `object` | 不暴露（排除表） | — | — |
| 65 | `help` | read | json | `object` | 不暴露（排除表） | `command`（可选） | — |
| 66 | `agent register` | write | json | `object` | `register_agents` | — | `--id` `--name` |
| 67 | `agent list` | read | json | `array` | `list_agents` | — | — |
| 68 | `agent whoami` | read | json | `object` | `whoami_agents` | `id`（可选） | — |
| 69 | `agent credential` | write | json | `object` | `credential_agents` | — | `--id` |
| 70 | `agent grants` | read | json | `object` | `grants_agents` | — | — |
| 71 | `agent revoke` | write | json | `object` | `revoke_agents` | — | `--id` |
| 72 | `agent credentials` | read | json | `array` | `credentials_agents` | — | — |
| 73 | `agent purge-credentials` | write | json | `object` | `purge_credentials_agents` | — | `--id` |
| 74 | `doc list` | read | json | `array` | `list_doc` | — | — |
| 75 | `doc show` | read | json | `object` | `show_doc` | `name`（必填） | — |
| 76 | `work next` | read | json | `object` | `next_work` | — | — |

## 2b. 写入型命令回执形状（38 条，卡 cd5f3832）

判据：在隔离夹具中以已批准身份（`agent:probe`，`approved=1`，`interactive=false`）逐条实跑；`destructive` 与 `config` 等无人值守不可达的命令明确标「**需人工授权，形状未知**」及返回的错误信封，同时附人工授权放行后的真实顶层键（由 `tests/main/cli/write-receipt-shapes-cd5f3832.test.ts` 双路径锁死）。

| # | 命令 | 风险档 | 声明 | 无人值守实跑 | 回执顶层键 / 错误信封与边界 |
|---:|---|---|---|---|---|
| 1 | `todo comment` | write | `object` | 直通（`ok=true`） | `ok` `commentId` `todoId` `parentId` `author` `createdAt` `commentCount` `message` |
| 2 | `todo reject` | write | `object` | 直通（`ok=true`） | `ok` `todoId` `status` `commentId` `reason` `rejectedBy` `message` |
| 3 | `todo close` | write | `object` | 直通（`ok=true`） | `todoId` `status` `commentId` `leftoverNotifiedTo` `leftoverMemoId` `message`（当 --leftover 填「无」或收口人即执行方时，不返回 leftoverNotifiedTo / leftoverMemoId） |
| 4 | `todo delete-comment` | write | `object` | 直通（`ok=true`） | `ok` `commentId` `todoId` `cascadedReplies` `commentCount` `message`（删自己写的普通评论属 write 档直通；删他人评论或驳回理由升为 destructive（需人工授权，code=grant_required）） |
| 5 | `todo add` | write | `object` | 直通（`ok=true`） | `id` `title` |
| 6 | `todo update` | write | `object` | 直通（`ok=true`） | `id` `title` `fixedInVersion` `description` `categoryIds` `categoryId` `projectId` `parentId` `status` `priority` `type` `createdBy` `executedBy` `verifier` `dueAt` `remindAt` `isPinned` `createdAt` `updatedAt` `completedAt` `changed` |
| 7 | `todo done` | write | `object` | 直通（`ok=true`） | `id` `title` `fixedInVersion` `description` `categoryIds` `categoryId` `projectId` `parentId` `status` `priority` `type` `createdBy` `executedBy` `verifier` `dueAt` `remindAt` `isPinned` `createdAt` `updatedAt` `completedAt` |
| 8 | `todo pin` | write | `object` | 直通（`ok=true`） | `id` `title` `isPinned` |
| 9 | `todo unpin` | write | `object` | 直通（`ok=true`） | `id` `title` `isPinned` |
| 10 | `todo rm` | destructive | `object` | **需人工授权，形状未知**（`grant_required`） | 需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：id deleted）；授权后顶层键：`id` `deleted` |
| 11 | `telemetry clear` | destructive | `object` | **需人工授权，形状未知**（`grant_required`） | 需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：removed）；授权后顶层键：`removed` |
| 12 | `profile propose` | write | `object` | 直通（`ok=true`） | `id` `scope` `projectId` `blockKey` `body` `originalBody` `baseUpdatedAt` `decidedBody` `proposer` `status` `decidedBy` `decidedAt` `createdAt` |
| 13 | `protocol propose` | write | `object` | 直通（`ok=true`） | `id` `scope` `projectId` `blockKey` `body` `originalBody` `baseUpdatedAt` `decidedBody` `proposer` `status` `decidedBy` `decidedAt` `createdAt` |
| 14 | `rules propose` | write | `object` | 直通（`ok=true`） | `id` `scope` `projectId` `category` `ruleKey` `proposedEnforcement` `originalEnforcement` `baseUpdatedAt` `decidedEnforcement` `proposer` `status` `decidedBy` `decidedAt` `createdAt` |
| 15 | `project handoff-propose` | write | `object` | 直通（`ok=true`） | `project` `proposal` |
| 16 | `project handoff-update` | write | `object` | **需人工授权，形状未知**（`approval_required`） | 默认权限矩阵要求 Agent 走提议（错误信封 code=approval_required, exitCode=4，请用 project handoff-propose；授权直写后键：project changed revision）；授权后顶层键：`project` `changed` `revision` |
| 17 | `todo set-owner` | write | `object` | 直通（`ok=true`） | `id` `title` `createdBy` |
| 18 | `project add` | write | `object` | 直通（`ok=true`） | `id` `name` `color` `archived` `sortOrder` `createdAt` `handoffMarkdown` `notice`（同名项目复用时返回 id name docsDir(可选) reused） |
| 19 | `project handoff-rollback` | write | `object` | 直通（`ok=true`） | `project` `changed` `revision` |
| 20 | `project archive` | write | `object` | 直通（`ok=true`） | `id` `name` `archived` `message` |
| 21 | `project unarchive` | write | `object` | 直通（`ok=true`） | `id` `name` `archived` `message` |
| 22 | `project rm` | destructive | `object` | **需人工授权，形状未知**（`grant_required`） | 需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted projectName removed message）；授权后顶层键：`deleted` `projectName` `removed` `message` |
| 23 | `release add` | write | `object` | 直通（`ok=true`） | `version` `projectId` `shippedAt` `highlights` `tested` `linkedTodos` `note` |
| 24 | `release update` | write | `object` | 直通（`ok=true`） | `version` `projectId` `shippedAt` `summary` `highlights` `tested` `linkedTodos` |
| 25 | `release rm` | destructive | `object` | **需人工授权，形状未知**（`grant_required`） | 需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted orphanTodos）；授权后顶层键：`deleted` `orphanTodos` |
| 26 | `memo add` | write | `object` | 直通（`ok=true`） | `id` `author` `recipient` `text`（传 --reply-to 追加同线程回复时返回 id replyTo replyId author recipient text replies） |
| 27 | `memo ack` | write | `object` | 直通（`ok=true`） | `id` `status` `readAt` |
| 28 | `memo rm` | destructive | `object` | **需人工授权，形状未知**（`grant_required`） | 需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted ok）；授权后顶层键：`deleted` `ok` |
| 29 | `category add` | write | `object` | 直通（`ok=true`） | `id` `name` |
| 30 | `category rm` | destructive | `object` | **需人工授权，形状未知**（`grant_required`） | 需人工授权，形状未知（无人值守不可达，错误信封 code=grant_required, exitCode=4；人工授权后键：deleted affectedTodos）；授权后顶层键：`deleted` `affectedTodos` |
| 31 | `category merge` | write | `object` | **需人工授权，形状未知**（`grant_required`） | 源分类非空时需人工授权，形状未知（code=grant_required, exitCode=4）；源分类为空（0 条待办）或人工授权后键：merged into movedTodos；授权后顶层键：`merged` `into` `movedTodos` |
| 32 | `batch` | write | `object` | 直通（`ok=true`） | `total` `failed` `allFailed` `results` |
| 33 | `ui set` | config | `object` | **需人工授权，形状未知**（`grant_required`） | 配置档需人工会话授权，形状未知（无人值守默认 code=grant_required, exitCode=4；会话授权后键：key before after changed note）；授权后顶层键：`key` `before` `after` `changed` `note` |
| 34 | `ui reset` | config | `object` | **需人工授权，形状未知**（`grant_required`） | 配置档需人工会话授权，形状未知（无人值守默认 code=grant_required, exitCode=4；会话授权后键：reset affected settings）；授权后顶层键：`reset` `affected` `settings` |
| 35 | `agent register` | write | `object` | 直通（`ok=true`） | `id` `displayName` `color` `approved` `rejectedAt` `hasCredential` `createdAt` `lastSeenAt` `lastWriteAt` `lastWriteCmd` `reused` `needsApproval` `nextSteps` `humanNotified` `nextHint` |
| 36 | `agent credential` | write | `object` | 直通（`ok=true`） | `agentId` `credentialPath` `declaredAs` `otherCredentials` `note` |
| 37 | `agent revoke` | write | `object` | 直通（`ok=true`） | `agentId` `scope` `revokedGrants` `note` |
| 38 | `agent purge-credentials` | write | `object` | 直通（`ok=true`） | `agentId` `credentialPath` `removed` `wasDefault` `defaultAfter` `remaining` `note` |

## 3. 关口（守卫与门禁）

判据：`enforcement` 决定调用方该做什么 —— `block` 重试无用、`authorize` 去申请、`notice` 只是提醒。

| 编号 | 守什么 | 强度 | 退出码 | errorCode | 实装位置 |
|---|---|---|---:|---|---|
| G1 | 父需求还在「待确认」时，不能围绕它建子任务 | block | 4 | `guard_blocked` | `src/main/database/todo.repository.ts` |
| G2 | 父需求转「待验收」时，它下面所有子任务必须已全部完成 | block | 4 | `guard_blocked` | `src/main/database/todo.repository.ts` |
| G4-status | 把「待确认」的条目挪走（改成别的状态） | block | 4 | `guard_blocked` | `src/main/database/todo.repository.ts` |
| G4-delete | 把「待确认」的条目**删掉** | authorize | 4 | `grant_required` | `src/main/database/todo.repository.ts` |
| G6 | 父需求**直接**置「已完成」时，子任务必须全部完成 | block | 4 | `guard_blocked` | `src/main/database/todo.repository.ts` |
| G3 | 事项转「待验收」时没留收口结论 | notice | 0 | — | `src/main/cli/commands/todo.ts` |
| G5 | 事项标完成时没留**带结构性要素的**收口结论 | notice | 0 | — | `src/main/database/closure-structure.ts` |
| G7 | 「待确认」的事项描述缺要素（背景 / 目标 / 判据） | notice | 0 | — | `src/main/cli/commands/todo.ts` |
| G8 | 你手上那份说明书版本落后于当前版本 | notice | 0 | — | `src/main/cli/command-exec.ts` |
| G9 | 在「待验收」的事项上写了评论，但**状态没动** | notice | 0 | — | `src/main/cli/commands/todo.ts` |
| G10 | **执行者**不能验收自己做的事（运动员不当裁判） | block | 4 | `guard_blocked` | `src/main/database/todo.repository.ts` |
| identity | 非交互调用却没持证 / 注册未获批准 | block | 4 | `identity_required / identity_pending / credential_missing / credential_invalid` | `src/main/cli/command-core.ts` |
| grant | 改界面参数 / 删除类破坏操作，没拿到单次授权 | block | 4 | `grant_required` | `src/main/cli/command-core.ts` |
| ambiguous_identity | 本机有多份凭据，而这次调用没声明身份 | block | 4 | `ambiguous_identity` | `src/main/cli/command-core.ts` |
| project_required | `todo add` 没带 `--project` | block | 2 | `usage_error` | `src/main/cli/command-core.ts` |

## 4. 错误码

判据：`重试` 一列回答"原地再来一次有没有用" —— `false` 换路或等人、`read` 是重读而不是重试。

| errorCode | 含义 | 退出码 | 重试 | 该做什么 |
|---|---|---:|---|---|
| `usage_error` | 参数缺失、枚举非法、时间无法解析 | 2 | false | 按报错里列出的支持参数改命令，再来一次 |
| `not_found` | 目标 id / 名字没找到 | 3 | false | 用 `todo list` 拿真实 id 整段复制（别手写前缀）；报错里通常已列出本机已有项 |
| `guard_blocked` | 守卫拒绝（候选池规则，见 schema.gates） | 4 | false | 重试无用。按报错指的那条关口改做法，或等人操作（如 proposed 只能由人在界面上放行） |
| `identity_required` | 无人值守的写命令没声明身份，且本机只有一份凭据（本可自动带上） | 4 | false | 声明 `DESKPARTNER_AGENT=agent:<名字>`（或 MCP 写工具传 `actor`）后重试 |
| `identity_unregistered` | 声明了 `agent:<名字>` 但该身份还没注册 | 3 | false | `agent register` → `agent credential` → 请用户在界面上批准（注册与领凭据都是自助的） |
| `identity_pending` | 身份已注册，但还没被批准写入 | 4 | false | **等**：注册那一刻界面已弹横幅提醒用户，不需要重试写命令、也不必重复注册 |
| `ambiguous_identity` | 本机有多份 agent 凭据，而这次调用没声明身份 | 4 | false | CLI：`export DESKPARTNER_AGENT=<候选之一>`；MCP：写工具传 `actor` 入参 —— 别让它替你猜 |
| `credential_missing` | 该身份还没领凭据 | 4 | false | `agent credential --id <身份>` 领一份 |
| `credential_invalid` | 凭据不存在或已失效 | 4 | false | 重新 `agent credential --id <身份>` 领一份 |
| `grant_required` | 这次操作落在「改界面 / 删除」档，需要单独授权 | 4 | false | **别绕、别改参数**：申请已落库，等用户在「审批」页点允许；批准即按申请执行，不要重试原命令 |
| `permission_denied` | 协作规则权限矩阵禁止当前身份执行该动作 | 4 | false | 请让主用户在「用户与团队 → 协作规则配置」中调整该动作的权限，或改用允许的协作流程 |
| `approval_required` | 该动作需要通过审批流程提交，不能直接写入 | 4 | false | 使用对应的 propose 命令提交提议，等待主用户在「审批」页处理后再读取结果 |
| `conflict` | 乐观锁冲突：你要改的这条，在你读到它之后被别人改过（什么都没写入） | 5 | read | 重新 `todo get <id>` 看一遍改动，再决定要不要带上新的 updatedAt 重做。**不要盲重试** |
| `batch_all_failed` | batch 里每一行都失败了 | 1 | false | 逐条读 `results[i].ok` 与 `errorCode` 定位；部分成功时整体退出码是 0，别只看它 |
| `error` | 其余未分类错误（数据层异常等） | 1 | false | 看 message 原文；不确定是否已写入时**不要重试**（可能重复写） |

## 5. 未知 / 不在本清单里的

盘点口径：**空缺只有被点名才算盘点过。**

- 信封类命令的 `dataShape`：**无空缺**（逐条已声明，闸门盯着）。
- **没有信封 `data` 的命令（2 条）**：`telemetry export`（ndjson）、`skill`（text） —— 形状由出参形态回答，别去读 `data`。
- **不暴露给 MCP 的命令（7 条）**：`schema`、`doctor`、`telemetry clear`、`ui get`、`ui set`、`ui reset`、`help` —— 是排除表的选择（自检类 / 人类界面类），不代表产品没这个能力。
- **实际返回的形状（顶层键、空值、墓碑结构）**：不在本文件。它是跑出来的，证据见 `docs/reviews/2026-10-28-headless-baseline-probe.md`，重跑命令 `node scripts/verify-headless-baseline.mjs`。
- **界面侧的 IPC 通道与页面行为**：本文件只盘点 CLI/MCP 这条面。页面 ↔ 能力映射见 `docs/architecture/2026-10-28-gui-page-capability-map.md`。
