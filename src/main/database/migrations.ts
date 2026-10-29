import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { DB_VERSION } from '../../renderer/lib/constants'
import {
  createFileMigrateLock,
  noopMigrateLock,
  type MigrateLock
} from './migrate-lock'

/**
 * 数据库 schema 版本迁移
 * 每次版本升级只追加新的迁移函数，不修改已有迁移
 */

/** 单个迁移函数 */
type MigrationFn = (db: Database.Database) => void

/** 迁移列表，索引对应版本号（版本 0 → 1 在 migrations[0]） */
const migrations: MigrationFn[] = [
  // v0 → v1: 初始 schema
  (db) => {
    // 待办事项表
    db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        remind_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
      );
    `)

    // 分类标签表
    db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
    `)

    // 应用设置表（单行键值对）
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // 索引
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
      CREATE INDEX IF NOT EXISTS idx_todos_category ON todos(category_id);
      CREATE INDEX IF NOT EXISTS idx_todos_remind_at ON todos(remind_at);
      CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order);
    `)
  },

  // v1 → v2: 悬浮球默认改为完全不透明
  (db) => {
    // 旧默认值 0.35 会让球体过于透明。仅在用户未曾改动过该值时提升为 1，
    // 避免覆盖用户主动设置过的透明度。
    db.prepare(
      `UPDATE settings SET value = '1' WHERE key = 'floatBallOpacity' AND value = '0.35'`
    ).run()
  },

  // v2 → v3: 兜底修正历史遗留的过低不透明度
  (db) => {
    // v1→v2 只匹配了精确的 '0.35'，未能覆盖此前被设成更低值的记录。
    // 低于新滑块下限(30%)的悬浮球几乎不可见，这里统一提升为完全不透明，
    // 用户可在设置中按需下调。
    db.prepare(
      `UPDATE settings SET value = '1'
        WHERE key = 'floatBallOpacity' AND CAST(value AS REAL) <= 0.35`
    ).run()
  },

  // v3 → v4: 品牌主色统一为 logo 的蓝 #5388F6
  (db) => {
    // 仅更新仍等于旧默认值 #6395F1 的记录，不动用户自定义过的颜色
    db.prepare(
      `UPDATE settings SET value = '#5388F6'
        WHERE key = 'floatBallColor' AND value = '#6395F1'`
    ).run()
    db.prepare(
      `UPDATE categories SET color = '#5388F6' WHERE color = '#6395F1'`
    ).run()
  },

  // v4 → v5: 详细版任务字段（描述 / 优先级 / 截止时间）
  (db) => {
    // SQLite 的 ALTER TABLE ADD COLUMN 对已有行会填默认值：
    // description / due_at 为 NULL，priority 为 'normal'，旧数据无需回填
    db.exec(`ALTER TABLE todos ADD COLUMN description TEXT;`)
    db.exec(
      `ALTER TABLE todos ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`
    )
    db.exec(`ALTER TABLE todos ADD COLUMN due_at TEXT;`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_due_at ON todos(due_at);`)
  },

  // v5 → v6: 本地使用埋点
  (db) => {
    /**
     * 与 v2 的 events 表要分开成两张：
     * - events（尚未建）用于数据变更广播，短期保留、会被高频轮询
     * - usage_events 用于行为分析，长期保留、量大
     * 混在一张表里，高频轮询会被海量行为事件拖慢。
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        surface TEXT NOT NULL,
        category TEXT NOT NULL,
        event TEXT NOT NULL,
        ok INTEGER,
        duration_ms INTEGER,
        props TEXT
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_cat_event ON usage_events(category, event);`)
  },

  // v6 → v7: 数据变更事件（跨进程广播用）
  (db) => {
    /**
     * 与 usage_events 的区别，别混：
     * - events：数据变更，短期保留（7 天 / 2000 条），会被高频轮询
     * - usage_events：行为埋点，长期保留（30 天 / 50000 条），量大
     * 合在一张表里，高频轮询会被海量行为事件拖慢。
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);`)
  },

  // v7 → v8: 任务归属（owner）
  (db) => {
    /**
     * 区分"用户自己要做的"与"agent 做过的/要做的"。
     *
     * 取值约定（与埋点 usage_events.actor 保持一致，将来能直接关联，不用映射表）：
     *   human              —— 用户自己（默认，历史数据全归这里）
     *   agent:<id>         —— 某个 agent，如 agent:alice
     *
     * **这是归属标注，不是身份认证。** 本机任何进程都能自称某个 agent。
     * 它解决"这条是谁记的、该给谁看"，不解决"防冒充"。
     * 参考的现成先例：skill 的 frontmatter 用 agent_created: true 标注
     * "这是 agent 建的"，同样只是自觉标注 + 一条规则，没有注册也没有认证。
     */
    const cols = (
      db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string }>
    ).map((c) => c.name)

    if (!cols.includes('owner')) {
      // 带 DEFAULT 才能加 NOT NULL 列，历史数据会自动落到 'human'
      db.exec(`ALTER TABLE todos ADD COLUMN owner TEXT NOT NULL DEFAULT 'human'`)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner);`)
  },

  // v8 → v9: 分类从「单值」变「多值」
  (db) => {
    /**
     * 一条待办可以同时关联多个方向。
     *
     * 起因是主用户举的反例：「调研 TAPD」既属于「竞品调研」这个大类，
     * 又是为「看板功能」做的 —— 单值分类表达不了这种"一石多鸟"。
     * 结论是：**不建父子层级，用多值关联**，并把进度改为按需查询
     * （不存进度，才能绕开"多归属时进度算给谁"）。
     */

    // 1. 关联表
    db.exec(`
      CREATE TABLE IF NOT EXISTS todo_categories (
        todo_id     TEXT NOT NULL,
        category_id TEXT NOT NULL,
        PRIMARY KEY (todo_id, category_id),
        FOREIGN KEY (todo_id)     REFERENCES todos(id)      ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_categories_category ON todo_categories(category_id);`)

    // 2. 把现有的单值分类搬进关联表（必须在重建表之前做）
    const cols = db.prepare('PRAGMA table_info(todos)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    const hasCategoryCol = cols.some((c) => c.name === 'category_id')
    if (!hasCategoryCol) return

    db.exec(`
      INSERT OR IGNORE INTO todo_categories (todo_id, category_id)
      SELECT id, category_id FROM todos
      WHERE category_id IS NOT NULL AND category_id != '';
    `)

    /**
     * 3. 重建 todos 表去掉 category_id
     *
     * 用 `ALTER TABLE ... DROP COLUMN` 是行不通的：SQLite 不允许删
     * **被外键约束引用的列**，而 category_id 上挂着
     * `FOREIGN KEY (category_id) REFERENCES categories(id)`。
     * 报错是 `error in table todos after drop column: unknown column
     * "category_id" in foreign key definition`。
     * SQLite 没有 DROP CONSTRAINT，要去掉只能重建表。
     *
     * 列定义从 PRAGMA 动态生成，避免把 schema 再抄一份在这里
     * （抄副本的代价之前已经吃过一次：迁移加字段后副本没跟上）。
     */
    const keep = cols.filter((c) => c.name !== 'category_id')
    const colDefs = keep
      .map((c) => {
        let def = `${c.name} ${c.type}`
        if (c.pk) def += ' PRIMARY KEY'
        if (c.notnull && !c.pk) def += ' NOT NULL'
        if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`
        return def
      })
      .join(',\n        ')
    const names = keep.map((c) => c.name).join(', ')

    db.exec(`DROP INDEX IF EXISTS idx_todos_category;`)
    db.exec(`CREATE TABLE todos_new (\n        ${colDefs}\n      );`)
    db.exec(`INSERT INTO todos_new (${names}) SELECT ${names} FROM todos;`)
    db.exec(`DROP TABLE todos;`)
    db.exec(`ALTER TABLE todos_new RENAME TO todos;`)

    // 索引随表一起被 DROP 掉了，重建
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
      CREATE INDEX IF NOT EXISTS idx_todos_remind_at ON todos(remind_at);
      CREATE INDEX IF NOT EXISTS idx_todos_due_at ON todos(due_at);
      CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner);
    `)
  },

  // v9 → v10: 项目（顶层容器）+ 父需求（事项自引用）
  (db) => {
    /**
     * 补上事项的四个维度里缺的两个：**项目**和**父需求**。
     *
     * 为什么项目要独立建表、不做成 todo：
     * 项目不是"一件要做的事"。做成 todo 的话它会混进看板的
     * 待办/已完成列——"DeskPartner 完成了"是没有意义的。
     * 独立表能给它归档状态，也不污染看板。
     *
     * 父需求用 parent_id 自引用（和 TAPD 同路子）：
     * 同一张表里靠一个字段串起来，深度天然支持（项目 → 故事 → 任务）。
     * 删父时用 SET NULL：子事项提升为顶层，不级联删除——
     * 删一个方向不该带走它下面的具体工作。
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL,
        archived   INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `)

    const cols = (
      db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string }>
    ).map((c) => c.name)

    if (!cols.includes('project_id')) {
      db.exec(
        `ALTER TABLE todos ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);`)
    }

    if (!cols.includes('parent_id')) {
      db.exec(
        `ALTER TABLE todos ADD COLUMN parent_id TEXT REFERENCES todos(id) ON DELETE SET NULL;`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);`)
    }
  },

  // v10 → v11: 备忘（memo）—— AI 给人递纸条的地方
  (db) => {
    /**
     * 备忘与待办的本质区别：**备忘不是"要做的事"**。
     *
     * AI 目前只能建待办 = 替人做决定"这是一件事"。
     * 而它在干活时发现的坑、值得留意的结论，只是**信息**——
     * 建成待办会混进人的执行队列，决定权也被悄悄拿走了。
     *
     * 备忘 = AI 说"这条你留意下"：不进看板、不占队列、没有完成语义，
     * 人看过（ack）就算送达。bell 面板显示未读条目 + 来源角标。
     *
     * linked_todo_id 可选：有些备忘是关于某条待办的，能跳过去看。
     * 用 SET NULL：待办删了，备忘的信息本身仍然成立，不该跟着消失。
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        id             TEXT PRIMARY KEY,
        author         TEXT NOT NULL,
        text           TEXT NOT NULL,
        linked_todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
        status         TEXT NOT NULL DEFAULT 'unread',
        created_at     TEXT NOT NULL,
        read_at        TEXT
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(status);`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memos_created ON memos(created_at);`)
  },

  // v11 → v12: 事项类型 + 提出者/执行者分离
  (db) => {
    /**
     * 两个改动一次迁：
     *
     * 1. type（bug/feature/task）：给事项补上"性质"维度。
     *    默认 task —— 大多数事项就是普通任务，历史数据全部落 task，
     *    不臆测"这条看起来像 bug"。
     *
     * 2. owner 拆成 created_by / executed_by：owner 混着"谁记的"和"该谁干"
     *    两层语义。agent 帮人记的事（owner=agent:x）实际是"agent 提出、人去
     *    执行"，只看 owner 会错读成 agent 自己的活。
     *    - created_by 全量回填原 owner —— "谁记的"是 owner 真正记录过的语义；
     *    - executed_by 留 NULL —— 含义就是"执行者即提出者"，比猜测回填诚实；
     *    - owner 列**保留不删**：删列在 SQLite 里麻烦（挂索引要重建表），
     *      而留着它没有任何风险 —— 新代码不再读写它，它只是历史化石。
     */
    const cols = (
      db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string }>
    ).map((c) => c.name)

    if (!cols.includes('type')) {
      db.exec(`ALTER TABLE todos ADD COLUMN type TEXT NOT NULL DEFAULT 'task'`)
    }

    if (!cols.includes('created_by')) {
      // 带 DEFAULT 才能加 NOT NULL 列；先建列、再回填原 owner（"谁记的"是 owner 真正记录过的语义）
      db.exec(`ALTER TABLE todos ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human'`)
      db.exec(`UPDATE todos SET created_by = owner`)
      // 执行者留 NULL = "执行者即提出者"，比猜测回填诚实
      db.exec(`ALTER TABLE todos ADD COLUMN executed_by TEXT`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_created_by ON todos(created_by);`)
    }
  },

  // v12 → v13: Agent 身份注册（R3-1）
  (db) => {
    /**
     * 从「标注」变成「身份」。
     *
     * 此前只有 `created_by` 文本（如 `agent:bob`）—— 那是**标注不是身份**：
     * 任何进程都能自称某个 agent，无从判断"这条是不是跨边界写"，
     * 也就没有"我的 / 全部 / 各 Agent"这种视角可言。
     * 真实试用跑起来之后（Bob是 agent 试点用户），这个缺口开始碍事。
     *
     * 两条刻意的取舍：
     *
     * 1. **不强制注册**。未注册的 `created_by` 继续可用 —— 历史数据、
     *    临时一次性调用都不该因为没注册就崩。它只是"没有身份"而已。
     *    `approved` 字段先留着（当前默认 1），等 R4-6 审批流程来用它。
     *
     * 2. **不删 `created_by` 文本**。它记的是"当时谁提的"这个事实，
     *    身份表是叠在它上面的另一层。两层并存，文本层继续当可搜索的标签。
     *
     * `id` 存与 `created_by` 同形的完整标识（如 `agent:bob`），
     * 这样关联时不用再做前缀拼接。
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        color        TEXT,
        approved     INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_approved ON agents(approved);`)
  },

  // v13 → v14: 状态迁移历史（动态的"流转过程"要靠它）
  (db) => {
    /**
     * 为什么单独建表，而不是复用 events 表：
     *
     * events 表是**变更广播**用的（GUI 轮询感知"数据被别的进程改了"），
     * 它的语义是"刚发生过变化"，所以会被 prune 定期清掉；
     * 而状态迁移是**历史**，要在动态里长期回看（"这件事是怎么一步步走完的"）。
     * 两种生命周期完全不同，混在一张表里结果一定是互相破坏。
     *
     * 记录什么：一条事项从哪个状态到哪个状态、**谁做的**、什么时候。
     * `from_status` 为 NULL 表示新建（此前没有状态）。
     *
     * `actor` 是**动作人**，不是提出者也不是执行者 ——
     * "谁把它拖到挂起的"和"这条是谁提的"是两件事，动态要显示的是前者。
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS todo_transitions (
        id          TEXT PRIMARY KEY,
        todo_id     TEXT NOT NULL,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        actor       TEXT,
        created_at  TEXT NOT NULL
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transitions_todo ON todo_transitions(todo_id);`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transitions_created ON todo_transitions(created_at);`)
  },

  // v14 → v15: agent 凭据（"自称身份"升级成"持证身份"）
  (db) => {
    /**
     * 背景：R3-1 的注册只是**记录了一个名字**，写入时并未校验 ——
     * 任何进程都能自称 `agent:xxx`，等于门没锁。主用户 2026-09-21 问的
     * "既然有注册机制，行动不该都能跟踪吗" 指的就是这个洞。
     *
     * 做法参考 Moltbook（注册发 key、之后每次请求带 Bearer）与
     * MCP（clientInfo 是协议必填、不由模型自觉）—— 关键是**凭据落在磁盘**，
     * agent 只在第一次需要人帮它注册，之后启动器自动带上，不用"记得"。
     *
     * 只存哈希不存明文：本地单机工具，但明文 token 一旦被别的程序读到
     * 就能冒名；哈希比对足以验证"持有者"，且泄露哈希也无法反推。
     */
    db.exec(`ALTER TABLE agents ADD COLUMN credential_hash TEXT;`)
  },

  // v15 → v16: 分级授权与审计（"批准"从一档变四档）
  (db) => {
    /**
     * 1.0.35 只有一档：批准 = 能写，不批准 = 只能读。
     * 但"往看板里加一条待办"和"把待办删掉"、"改掉整个界面的配色"
     * 根本不是一个量级的事 —— 一档等于让人在"全开"和"全关"之间二选一。
     *
     * 参考 Claude Code 的分层：同意的**有效期按风险分级**
     * （只读免批、文件修改到会话结束、危险操作每次都问）。
     * 这里拆成四档：读（免批）/ 写（批准一次长期有效）/ 改界面（本会话有效）/ 删除（每次都要）。
     *
     * 后两档不是"批准"能表达的 —— 它们需要**单次授权**，于是单独建表：
     * 一次高风险动作 = 一条授权记录，谁申请、谁批、何时、用掉没有，全在表里。
     * 这张表同时就是审计日志（撤销与审计要回答的正是"谁在什么时候被允许干了什么"）。
     */
    db.exec(`ALTER TABLE agents ADD COLUMN last_write_at TEXT;`)
    db.exec(`ALTER TABLE agents ADD COLUMN last_write_cmd TEXT;`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_grants (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        session_id  TEXT,
        status      TEXT NOT NULL,
        command     TEXT,
        created_at  TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        expires_at  TEXT
      );
    `)
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_grants_agent ON agent_grants(agent_id, scope, status);`
    )
  },

  // v16 → v17: 项目成为必填项（历史无项目的事项归入现有项目）
  (db) => {
    /**
     * 主用户 2026-09-21 提的：
     *
     * "现在所有的事项都没有强制跟项目关联。其实这很不合理。因为相当于我根本不知道
     *  每个 agent 现在具体在围绕着什么事情做事。虽然我现在自己心里清楚是 deskpartner，
     *  但实际上从数据看板很难了解，所以项目这个值应该设为必填项。"
     *
     * 她说到了根子上：看板的用途是"一眼看出谁在忙什么"，
     * 而项目正是那个"围绕什么事"的维度。项目可空 = 这个维度随时可以缺，
     * 缺了之后待办就退化成一条条孤立的动作，看不出它们服务于哪件事。
     *
     * 这一版只做**数据侧的收敛**：把历史遗留的无项目事项归到现有项目上，
     * 让"必填"从这一版起成立。校验（CLI / 界面不允许留空）在各自的写入口做 ——
     * 放在这里没有意义，迁移只跑一次。
     *
     * ⚠️ 为什么不做成 NOT NULL 列约束：
     * 表里有外键、还有别的表引用它，改列约束要重建整张表（v9 那次的做法），
     * 而重建期间一旦中断，用户库就有丢数据的风险。用代码层校验同样能守住"必填"，
     * 代价小得多 —— 这个取舍在只有一个人用的本地库上是划算的。
     */
    const projects = db
      .prepare(`SELECT id, name FROM projects ORDER BY created_at ASC`)
      .all() as Array<{ id: string; name: string }>

    const orphans = db
      .prepare(`SELECT COUNT(*) AS n FROM todos WHERE project_id IS NULL`)
      .get() as { n: number }

    if (!orphans.n) return

    /**
     * 归到哪个项目：**按现有项目名匹配待办里出现的线索**太玄学，
     * 主用户拍板的是"统一归到 DeskPartner"（她本机唯一的项目）。
     * 这里取列表里的第一个 —— 若本机还没有任何项目，则建一个"未分类"兜底，
     * 否则这批历史事项会卡在"既没项目、又不能不填"的死角里。
     */
    let targetId = projects[0]?.id
    if (!targetId) {
      targetId = 'migrated-default-project'
      // 注意 projects 表只有 created_at，没有 updated_at（别照着 todos 的列抄）
      db.prepare(
        `INSERT INTO projects (id, name, color, archived, sort_order, created_at)
         VALUES (?, ?, ?, 0, 0, ?)`
      ).run(targetId, '未分类', '#8E8E93', new Date().toISOString())
    }

    const moved = db
      .prepare(`UPDATE todos SET project_id = ? WHERE project_id IS NULL`)
      .run(targetId).changes

    console.log(
      `[Migration] 已把 ${moved} 条无项目的历史事项归入「${projects[0]?.name ?? '未分类'}」` +
        `（项目自此为必填项）`
    )
  },

  // v17 → v18: 授权申请记录带上「目标摘要」
  (db) => {
    /**
     * 主用户 2026-09-22 报的：
     * "审批详情里没有说明删除的事项是哪个（需要支持查看具体事项）"
     *
     * 根因是同一件事的数据散在两处：summary 上一版只写进了 events 表
     * （横幅读它），没写进 agent_grants（设置页读它）。两个消费者读两份数据，
     * 必然对不上 —— 横幅能说出"删的是什么"，同一时刻的审批列表却只有一条
     * `todo rm`，人没法凭它决定批不批。
     *
     * 授权记录本身是**审计凭据**，它就该自己说明"当时申请的是什么"，
     * 不能依赖事件表 —— 那张表按保留策略 prune，事后想复查"当初批了什么"
     * 就查不到了。加列而不是另建表：摘要与申请是一对一、同生共死的。
     *
     * ALTER TABLE ADD COLUMN 是 SQLite 上少数几个原地操作，不需要重建表，
     * 因此也没有 v9 那种"重建期间中断会丢数据"的风险。
     */
    db.exec(`ALTER TABLE agent_grants ADD COLUMN summary TEXT;`)
  },

  // v18 → v19: 授权记录带上「目标集合」，让"批准删 A"不能拿来删 B
  (db) => {
    /**
     * Bob 2026-09-22 实测（本机真实发生，非推演）：
     *
     * 它为清探针先申请删除 A（申请摘要明确写着「删 A」），申请被批准后，
     * 它紧接着执行的是 `todo rm B` —— **退出码 0、deleted:true**，
     * 那条针对 A 的授权就这样被 B 消费掉了。结果是：批准要删的 A 至今还在，
     * 没被批准的 B 被删了。
     *
     * 也就是说：一次性授权的「一次」只在**计数**上成立，在**目标**上不成立。
     * 「批准删除这条」实际等于「30 分钟内允许删任意一条」。
     * 更糟的是 v18/v1.0.40 刚加的摘要让这个漏洞**更具欺骗性** ——
     * 摘要写得越清楚，人越以为自己批的是定点手术。
     *
     * target_ids 存 JSON 数组（本次动作的确切目标集合）。
     * NULL = 没有目标概念（旧记录，或该命令解析不出目标）→ 不参与校验，
     * 这样 `ui set` 这类命令的行为完全不变。
     */
    db.exec(`ALTER TABLE agent_grants ADD COLUMN target_ids TEXT;`)
  },

  // v19 → v20: 授权申请带上「执行请求」，让批准即执行成为可能
  (db) => {
    /**
     * 主用户 2026-09-22 的判断（原话）：
     * 「所以才说删除审批应该直接服务端处理呀，要不然就要有发通知给 agent
     *   的机制，不然一定会出问题的。」
     *
     * 她把我一直当成「体验优化」的这条直接判成了**架构上必须解**的问题，
     * 并给出二选一：A. 服务端直接执行；B. 建立给 agent 发通知的机制。
     *
     * 选 A。B 只是把问题推后：agent 离线时通知会堆积，上线后还要判断
     * 哪些已过期 —— 复杂度从服务端转移到了 agent，而 agent 本来就是
     * 「说断就断」的角色。A 让「agent 回来执行」这一步根本不存在。
     *
     * 要服务端执行，就得把**这次动作**完整记下来，因为执行发生在
     * 另一个进程、另一个时刻（用户点「允许」时 agent 早已退出）：
     *
     * - `request_argv`：当初那条命令的完整 argv。授权记录原先只存
     *   `command`（如 `todo rm`），丢了参数 —— 没有参数就重建不出动作。
     * - `exec_status` / `exec_error` / `executed_at`：执行结果。
     *   人在界面上点「允许」之后必须看得到**到底发生了什么**：
     *   成功要说清删掉了什么，失败要说清为什么 —— 否则「批准」成了一个
     *   没有回执的动作，而人还以为自己完成了一次决策。
     *
     * 为什么把 argv 存进授权记录，而不是另建一张「待执行队列」表：
     * 待执行队列要额外处理「批准后 agent 又重试了怎么办」「队列里的条目
     * 过期了怎么办」—— 而这条记录本身就是那次申请的凭据，一对一、同生共死。
     * 多一张表就多一套一致性问题。
     */
    db.exec(`ALTER TABLE agent_grants ADD COLUMN request_argv TEXT;`)
    db.exec(`ALTER TABLE agent_grants ADD COLUMN exec_status TEXT;`)
    db.exec(`ALTER TABLE agent_grants ADD COLUMN exec_error TEXT;`)
    db.exec(`ALTER TABLE agent_grants ADD COLUMN executed_at TEXT;`)
  },

  /**
   * v20 → v21: 统一通知模型（1.0.48，v3 设计拍板：五类全收）
   *
   * 「备忘」升级为「通知中心」：待办提醒 / 审批申请 / 执行回执 / agent 备忘 /
   * 待验收交付，五类事件一个收件箱。此前它们散在五处（memos、events、
   * agent_grants.exec_*、todos.remindAt、todo_transitions），界面上
   * 没有"所有需要我知道的事"这一个地方。
   *
   * 选择写时落表、而不是读时五表聚合：
   * 聚合查询的已读口径会漂（已读状态没有单一事实来源），
   * 而通知的生命周期很简单 —— 产生、被读、没了。
   * 各写入口（提醒服务、授权事件、批准执行、备忘、流转到待验收）
   * 在事情发生时顺手写一行，已读就是这张表自己的 status。
   *
   * ref_id 指向源记录（todo / grant / memo 的 id），通知是**索引**，
   * 详情与操作仍回到源数据所在的地方。
   */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        ref_id TEXT,
        actor TEXT,
        status TEXT NOT NULL DEFAULT 'unread',
        meta TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
    `)
  },

  /**
   * v21 → v22: 悬浮球颜色改为「默认跟随全局强调色」（2026-09-25，修 86921424）
   *
   * 1.0.49 把全局强调色改成冷中性墨黑，而悬浮球的 `floatBallColor` 仍是
   * v4 那次统一品牌色留下的 `#5388F6` —— 于是界面上出现"青色的球配墨黑的
   * 强调色"，且设置里那个颜色看起来像是"我选的"，实际是历史默认值。
   *
   * 现在把这个字段的语义改成：**null = 跟随 `--color-accent`**（默认），
   * 有值才是用户自定义。迁移沿用 v4 的规矩 ——
   * **只动仍等于旧品牌蓝的记录，用户自己挑过的颜色一个不动。**
   *
   * 用空串表示 null（settings 表是 key-value 字符串存储），读取侧按
   * "空 = 跟随"还原。
   */
  (db) => {
    db.prepare(
      `UPDATE settings SET value = ''
        WHERE key = 'floatBallColor' AND value IN ('#5388F6', '#6395F1')`
    ).run()
  },

  /**
   * v22 → v23: 事项评论（1.0.54，主用户 2026-09-28 设计改良）
   *
   * 痛点：`todos.description` 一直身兼两职 —— 既是"原始需求规格"，
   * 又被当成"所有后续往来的记录箱"（进度、驳回理由、agent 回执全往里追加）。
   * 后果是描述越接越长、分不清哪句是规格（主用户 09-24 实测踩过：
   * 6 条描述被追加成 3 代文本 1137 字）。根因是**信息架构把"规格"和
   * "对话"塞进了同一个字段**。
   *
   * 本迁移把两者拆开：
   * - `todos.description` 回归"规格"语义（改 = 编辑规格，不再是追加）；
   * - 所有后续往来落到本表，成为挂在事项上的"评论线程"。
   *
   * 设计要点（主用户指定）：
   * - `parent_id` 支持回复（楼中楼）；
   * - `kind` 区分普通评论 / 驳回（reject）/ 返工（rework）/ 系统；
   * - `author_type` + `author_id` 让界面能区分 human / agent / system，
   *   从而**让 agent 评论默认展开、人类冗余评论可折叠**。
   *
   * 与 `notifications` 的分工：通知是**全局收件箱**（跨事项、带未读角标），
   * 评论是**单条事项内的上下文**（不参与未读计数）。驳回这个动作两边都写：
   * 通知告诉执行方"你有活被退回"，评论留下"为什么退回"。
   */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS todo_comments (
        id TEXT PRIMARY KEY,
        todo_id TEXT NOT NULL,
        parent_id TEXT,
        author_type TEXT NOT NULL DEFAULT 'human',
        author_id TEXT,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'comment',
        created_at TEXT NOT NULL,
        FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES todo_comments(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_todo_comments_todo
        ON todo_comments(todo_id, created_at);
    `)
  },

  /**
   * v23 → v24：事项的「解决于版本」（1.0.59，主用户 2026-09-29）
   *
   * 痛点原话：「我现在既不清楚你当前版本准备处理哪些问题，
   * 也不知道发布后具体解决了哪些问题」。
   *
   * 看板此前能答一半（todo/in_progress = 在做，done = 已解决），
   * 缺的是**事项与版本的映射** —— 这个版本到底收口了哪几条，界面上看不出来，
   * 只能去读 README 的版本段落（人读的文档，与看板脱节）。
   *
   * 加一列把映射建起来：发版时把该版收口的事项标上版本号，
   * 之后按版本筛选即可同时回答"在做的"和"已解决的"。
   *
   * 为什么是列而不是另一张关联表：一条事项只会归属一个版本
   * （"这条 bug 在 1.0.58 修好了"），多版本归属没有真实场景，
   * 建关联表只会多出一层要维护的完整性。
   *
   * NULL = 还没标注（不是"不属于任何版本"）—— 存量数据全是 NULL，
   * 语义上就是"尚未归入某版"，界面筛选里显示为「未标注」。
   */
  (db) => {
    db.exec(`
      ALTER TABLE todos ADD COLUMN fixed_in_version TEXT;
      CREATE INDEX IF NOT EXISTS idx_todos_fixed_in
        ON todos(fixed_in_version);
    `)
  },

  /**
   * v24 → v25：授权记录的「成功回执摘要」（1.0.62，收 10f0a5d6 最后一段）
   *
   * 此前这条记录留了 `exec_status` / `exec_error` / `executed_at` 三列 ——
   * 失败有原文（`exec_error`）、成功只有一个 'ok'。于是审批流水里
   * 两种结果的信息量严重不对称：
   *
   * - 失败那行：写了为什么失败，甚至能带着 G4 守卫的完整说明；
   * - 成功那行：只有一句「已允许并执行」，至于**执行出来是什么**
   *   （删掉了哪条、改成了什么值）只在通知中心里留了一份，
   *   而通知的生命周期是"产生 → 被读 → 没了"。
   *
   * 结果是：人刷卡批准过一件事，回头想核对"它到底做成了什么"，
   * 看得见失败的全部细节，却看不见成功的任何细节。
   *
   * 只有两种结果留下同等信息量的回执，当事人才能在事后核对当时到底发生了什么，
   * 这才谈得上「批准是一个有回执的动作」。
   *
   * 同一版还给 agents 加了 `rejected_at`：此前一个未经批准的身份
   * 会永远计进「等你点头」的红点里，而人在界面上只有一个选项 —— 批准它。
   * 不想批准就只能让它一直钉在角标上（aa0b4610）。拒绝也要是一次能结案的动作。
   */
  (db) => {
    db.exec(`
      ALTER TABLE agent_grants ADD COLUMN exec_summary TEXT;
      ALTER TABLE agents ADD COLUMN rejected_at TEXT;
    `)
  },
  // ── 26：验收者（`a6032512`，Carol 10-05 提，10-06 拍板不拆版一起做）──
  //
  // 为什么加这个字段：现规则按「身份」定权 —— 验收通过只能由人点，
  // 而实测 7 张待验收里 5 张卡在"等人点完成"，因为**人能验的只有界面/体验类**，
  // CLI 与内部机制类缺陷验不了。改为按「角色」定权：**运动员不当裁判**
  // （验收者 ≠ 执行者），而不是"人一律得当裁判"。
  //
  // ⚠️ 为什么默认取 createdBy 而不是执行者：验收者默认就是提出者 ——
  // 多数卡是 agent 提、人执行，那么默认的 verifier 就是 agent 自己，
  // 于是"verifier ≠ executor"天然成立（agent 提、人验），这是最常见也最合理的形态。
  // 真正要防的是"自己提出自己验收"，而那由显式指定 verifier 时才可能出现。
  (db) => {
    db.exec(`
      ALTER TABLE todos ADD COLUMN verifier TEXT;
    `)
    // 存量回填：默认验收者 = 提出者。
    // ⚠️ 用 UPDATE 而不是加 NOT NULL 默认值：SQLite 的 ALTER TABLE ADD COLUMN
    // 不支持带非恒定默认值的列（加常量 DEFAULT 会写死全表同一个值）。
    // 而这里要的默认值是**逐行不同的**（各自的 created_by）。
    db.prepare(
      `UPDATE todos SET verifier = created_by WHERE verifier IS NULL`
    ).run()
  },
  // ── 27：纸条分「递的人」与「给谁」（`3c436592`，qwen 提，主用户 10-06 拍板）──
  //
  // ⚠️ 修的是一个**不报错**的错：`memo add --owner agent:x` 把 **author 写成收件人**
  // （`commands.ts` 里 `create({ author: owner })`）——
  // 于是"这张纸条是谁递的"查不出来，**审计链是反的，而且静默**。
  //
  // ## 为什么必须拆列，而不是就地纠正 author
  //
  // 那一列同时装着两个身份（我递的 / 我给谁的），
  // **存量行已经分不出哪个是哪个了**。所以：
  // - `recipient` 新列 = 收件人
  // - `author` 归作者；**存量已错的置 NULL**（表示"历史行没记"）
  //
  // ⚠️ **不编造发起方** —— 宁可留 NULL，也不要写一个看起来对的值。
  // 判据来自今天早些时候那条：**可逆的东西不能修成不可查**。
  (db) => {
    db.exec(`ALTER TABLE memos ADD COLUMN recipient TEXT;`)
    /**
     * 存量回填：**能确定收件人的才填**。
     *
     * - `author` 形如 `agent:*` 且**不是 `agent:cli`** → 它当时其实是收件人
     *   （因为没传 `--owner` 时才会落 `agent:cli`）⇒ 迁到 `recipient`
     * - `author` 是 `agent:cli` / `human` → 那是没指定收件人的情况，落空
     */
    db.prepare(
      `UPDATE memos
          SET recipient = author
        WHERE recipient IS NULL
          AND author LIKE 'agent:%'
          AND author <> 'agent:cli'`
    ).run()
    /**
     * ⚠️⚠️ **这里原来写的是 `SET author = NULL` —— 它让 1.0.69 装上后界面起不来。**
     *
     * 实测（10-07，用户装 1.0.69 后界面等 2 分钟不出）：
     * 在**有数据的真库副本**上跑迁移 → `NOT NULL constraint failed: memos.author`。
     *
     * `memos` 的建表 SQL 是 `author TEXT NOT NULL`（v1 就有）——
     * **那一列从建表起就不能空**，而我写迁移时没查约束，
     * 只在**空测试库**上验过（空库没有行，`UPDATE` 影响 0 行 ⇒ 不报错）。
     *
     * ⇒ **判据：涉及迁移的改动必须在"有数据的老库副本"上验过**，
     * 空库跑通**什么都不能证明**（SQL 约束只在有行时才触发）。
     *
     * 改法：用**一个显式值**表达"历史行没记发起方"，而不是 NULL ——
     * 既保住 NOT NULL 契约，又不编造任何人。
     * `unknown:pre-1.0.68` 读起来就是"1.0.68 之前没记"，不是某个 agent。
     */
    db.prepare(
      `UPDATE memos SET author = 'unknown:pre-1.0.68' WHERE recipient IS NOT NULL AND author IS NOT NULL`
    ).run()
    /**
     * 存量行**拿不到 author** 的逐行回填（`768bb8fc`，主用户 10-08 拍板）。
     *
     * 上面两步只处理"author 有值"的行；旧 schema 宽松或外部写入的库里
     * 可能有**缺 author**（NULL / 空串）的行 —— 留着它们，
     * "每行都有 author" 的契约就是破的，而 author 是 NOT NULL 列。
     *
     * 回填口径（卡片建议原话："取旧列，取不到默认 human"）：
     * - 取旧列：有旧值的行上面已经处理完，这里不动；
     * - 取不到默认 `'human'`：宁保守不造假 —— 默认归人，
     *   **绝不编造某个 `agent:*`**（同 v7→v8 历史数据全归 human 的口径）。
     */
    db.prepare(
      `UPDATE memos SET author = 'human' WHERE author IS NULL OR author = ''`
    ).run()
  },
  // ── 28：通知按收件人定向 + 已读位按人存（`3c436592` 的第 2 环）──
  //
  // ## 为什么加这两列
  //
  // 实测 10-07：`notifications` 表**只有单个 `read_at`**，而本机有 4 个写入方
  // （alice / Bob / human / kimi）。于是：
  // ① **谁递的通知都不知道**（表里只有 `actor`＝发起方，没有"给谁"）
  // ② **A 读过了 B 就当已读** —— 未读位是一份全局的
  //
  // 后果：**两个 agent 无法知道"哪些是给我的、我读没读过"**，
  // 而"谁在什么时候提醒我什么"是这个产品对 agent 的核心卖点。
  //
  // ## 为什么不复用 `read_at`
  //
  // ⚠️ **已读位不是布尔，是"谁读过"这个集合** ——
  // 塞进一个字段就只能存"最后是谁读的"，而两个人交替读就会互相覆盖。
  //
  // ## 存量怎么处理
  //
  // `read_at` 保留（**人**读的标记，界面铃铛用它），
  // 新列 `read_by` 存 `actor:xxx` 逗号分隔：
  // - 存量 `read_at` 非空的 → `read_by` 置 NULL（**历史行不知道是谁读的**，不编造）
  // - 存量未读的 → 空串（= 没人读过，两种 agent 与人都算）
  (db) => {
    db.exec(`
      ALTER TABLE notifications ADD COLUMN recipient TEXT;
      ALTER TABLE notifications ADD COLUMN read_by TEXT;
    `)
    // 存量 recipient 只能填"指向的那件事的收件人"—— memo 类才有这个信息
    db.prepare(
      `UPDATE notifications
          SET recipient = (
            SELECT m.recipient FROM memos m WHERE m.id = notifications.ref_id
          )
        WHERE type = 'memo'
          AND recipient IS NULL`
    ).run()
    // 存量已读的：不知道是谁读的 ⇒ 不写 read_by
    db.prepare(
      `UPDATE notifications SET read_by = '' WHERE read_at IS NULL`
    ).run()
  },
  // ── 29：评论可 @ 定向给某个 agent（`b097ca99` 的「叫醒」，第三环）──
  //
  // ## 为什么已有 `parent_id` 还要加
  //
  // 核 10-07 实测：`todo_comments` 表**有 `parent_id`**（能回复某条评论），
  // 但**没有 `recipient`** —— 所以：
  // - `comment --reply-to <某条评论>` = **我知道有这条评论，才回它**（pull）
  // - `comment --to agent:x`        = **你在那条评论上留话，他能被动看到**（push）
  //
  // 提单原话：「**投递（pull）已有但坏了；叫醒（push）确实没有。**」
  // ①②（memo 拆列 + 通知定向）修的是 pull 的坏，这一条是 push。
  //
  // ## 为什么落在 comments 而不是复用 notifications
  //
  // 评论是"就这件事说的话"，通知是"索引/提醒"。
  // 让 recipient 落在 comments 上，`--to-me` 才有办法按**人**读到
  // "哪些事在等我回应" —— 那正是"叫醒"的查询面。
  //
  // ⚠️ **不联动写通知**：那会让人以为"评论一句就等于推了一条提醒"，
  // 而两者语义不同（我请你回应 vs 我提个醒）。
  (db) => {
    db.exec(`ALTER TABLE todo_comments ADD COLUMN recipient TEXT;`)
    // 存量不回填 —— 历史评论没记"给谁"，**不编造**
  },

  // ── 30：流转记录里定死"这次退回是不是驳回"（1.0.72，主用户看动态时指出）──
  //
  // ## 问题：动态把裁决显示成了推进
  //
  // `awaiting_review → in_progress` 这条流转有**两个来源**：
  //   1. 验收不通过 = `todo reject` 或界面拖拽退回 —— **裁决**；
  //   2. 执行方自己把卡从「等你验收」收回「进行中」重开观察期 —— **推进**。
  //
  // 动态（`buildTimeline`）此前把**所有**流转节点都归成一种、标签写「推进了」，
  // 于是被驳回的卡在动态里长成「Bob 推进了 xxx」——
  // **驳回是一种带裁决含义的退回，它长得像有人往前推了一步。**
  //
  // ## 为什么不能靠"现在有没有 reject 评论"去反推
  //
  // 那条评论确实存在（`isRejection()` 一直拿它当权威判据），但它是**当前状态**：
  // - 一条卡被驳回过、之后执行方自己收回重开 → 会被误标成驳回；
  // - 反向也成立：两次驳回时两条流转都会显示"驳回"。
  //
  // 判据：**事实要在发生的那一刻定死。** 历史无法还原，只能从现在起记准。
  //
  // ## 存量怎么办：不猜
  //
  // 历史流转一律留 NULL（= 未知），动态里**照实显示"未记录"**，不按
  // "这张卡现在有没有 reject 评论"倒推 —— 那是编造，且会让"驳回"这个词
  // 在动态里逐渐失真。动态的全部价值就是可信，宁可缺一屏不可疑一屏。
  //
  // ⚠️ 三处必须一起改，否则判据分叉：
  //   ① 这里建列 ② `recordTransition` 写入时定值 ③ `buildTimeline` 读它分类
  (db) => {
    db.exec(`ALTER TABLE todo_transitions ADD COLUMN is_rejection INTEGER;`)
    // 存量一律留 NULL（未知），不倒推、不编造
  },

  // ── 31：把「版本」从一列涨成一个对象（1.0.73，主用户 10-07 提） ──
  //
  // ## 问题：版本此前只是一个字符串
  //
  // v24 给 `todos` 加了 `fixed_in_version TEXT`，能回答"这条是哪个版本修的"。
  // 但版本**自己没有实体** —— 于是"这个版本里做了什么、为什么发这一版"
  // 只能写在 README 的版本段落里（人读的文档，与看板脱节），
  // 或者散在一堆被标了同一版本号的事项里靠人拼。
  //
  // 主用户原话：「版本应该不只是一个字段，它应该是一个对象」——
  // 可以在它上面记录"这个版本里做了什么、关联了哪些卡片"。
  //
  // ## 为什么不把 fixed_in_version 换成外键
  //
  // ① 存量数据里 `fixed_in_version` 存的是**字符串版本号**（如 "1.0.72"），
  //    改成外键要先把它们全部解析、匹配到 releases 行上 ——
  //    而历史版本的 `shipped_at` / summary 根本无从还原，
  //    强行回填等于编造（同 v30 的判据：历史无法还原就留白）。
  // ② `fixed_in_version` 现在承载"这条**解决于**哪一版"这一个语义，
  //    它不需要引用完整性 —— 事项标了 1.0.72 而 releases 里没有那一行，
  //    是"版本元信息缺失"，不是"数据坏了"。用外键反而会把这种正常情形变成写入失败。
  //
  // 所以：**两张表靠 `version` 字符串对齐，各自独立**。
  // `releases` 是版本对象的登记处，`todos.fixed_in_version` 是指向它的引用。
  // 判据同 `2cc71a13` 的"不编造"：没有 release 行时，事项照常标版本，界面显示"未登记"。
  //
  // ## 为什么 project_id 可空
  //
  // 一个版本可能收口多个项目的事（本机 DeskPartner 与知彼都发过版），
  // 也可能谁都没关联。**不设 NOT NULL** —— 强制归属会逼调用方瞎填一个项目。
  // 它是"这版主要属于谁"的提示，不是完整性约束。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        version    TEXT PRIMARY KEY,
        project_id TEXT,
        shipped_at TEXT,
        summary    TEXT,
        highlights TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_releases_project ON releases(project_id);
      CREATE INDEX IF NOT EXISTS idx_releases_shipped ON releases(shipped_at);
    `)
    // 存量不回填 —— 历史版本没有"发布时刻/摘要"，不倒推、不编造
  },
  // ── 32：releases.tested —— 这版发版前跑没跑测试（`065dcde4`）──
  //
  // 为什么加：发版链 `--skip-tests` 时只在终端打一行"没过测试闸门"，
  // 发版后**无从查证** —— 验收方（Carol f6c186b8）想核"测试默认跑"没有任何出口。
  // 于是"这个产物过没过测试"只存在于发版那个人的终端历史里，换个验收人就断了。
  //
  // 值域（三值 + 不知道）：
  //   'yes'     跑了且过了测试闸门（发版链默认路径的产物）
  //   'no'      跑了但没过（人工补记：跑了没过还发了的情形）
  //   'skipped' 显式 --skip-tests 跳过，**没过测试闸门**
  //   NULL      历史行 / 未声明 —— 不知道就是不知道，**不回填、不编造**
  //             （与 v31「没有行就是没有行」同一条判据：宁可缺，不给一个猜的值）
  //
  // 判据（卡面）：releases 表里每行能答「这版跑没跑测试」，
  // --skip-tests 发的版事后能被认出来。
  (db) => {
    db.exec(`ALTER TABLE releases ADD COLUMN tested TEXT`)
    // 存量不回填：迁移前登记的版本行 tested 一律 NULL（当时的事实就是没记）
  },

  // ── 33：版本归项目下 —— 版本空间**按项目独立**（a2ea95f8）──
  //
  // 主用户 10-09 拍板（她指出这是设计错误）：
  // 「常规的项目管理或产品管理工具，版本规范肯定是一样的，总有一天会撞上同一个版本号，
  //   怎么可能 A 用了一个版本号，B 就不能用了呢？版本号本来就应该跟产品、项目、模块去关联。」
  //
  // v31 把 version 设成**全局主键**，于是两个项目永远不能有同名版本 ——
  // 「整库只有一个版本号库」本身就是错的。这一版把版本改成**项目下的二级概念**：
  //
  //   PRIMARY KEY (project_id, version)
  //   「知彼 1.0.76」与「DeskPartner 1.0.76」各是各的，互不相干。
  //
  // ## 为什么重建表（v9 先例）
  // SQLite 不支持改主键/改列约束，只能建新表 → 拷数据 → 换名。
  // 重建期间中断的风险由两层兜着：runMigrations 在事务里跑（失败回滚到迁移前），
  // 迁移前自动备份（c5b30fb3：备份与清旧备份进同一临界区）。
  //
  // ## project_id 变 NOT NULL + 外键 ON DELETE CASCADE
  // 主用户 10-09：「项目现在变重了，没有一开始设计的那么轻……删除项目的话，
  // 就彻底清空整个项目数据，不做数据保留。」
  // 版本必挂项目 → 项目没了版本跟着没（CASCADE），**不留脱钩的孤儿版本**
  // （v31 的 SET NULL 正是那个"删项目后版本变无归属"的口子）。
  // 归档是建议路径，删除是破坏性操作 —— 项目删除语义另有一张卡。
  //
  // ## 存量 NULL 行的回填（她已批：本机 4 行挂 DeskPartner）
  // 机制照 v16「项目必填」那次的先例：取第一个项目（created_at 最早），
  // 一个项目都没有就建「未分类」兜底 —— 否则这批版本卡在"必填又没值"的死角。
  (db) => {
    db.exec(`
      CREATE TABLE releases_new (
        version    TEXT NOT NULL,
        project_id TEXT NOT NULL,
        shipped_at TEXT,
        summary    TEXT,
        highlights TEXT,
        created_at TEXT NOT NULL,
        tested     TEXT,
        PRIMARY KEY (project_id, version),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `)

    // 回填目标：第一个项目 / 「未分类」兜底（同 v16 的取法）
    const projects = db
      .prepare(`SELECT id, name FROM projects ORDER BY created_at ASC`)
      .all() as Array<{ id: string; name: string }>
    let targetId = projects[0]?.id
    let targetName = projects[0]?.name ?? '未分类'
    if (!targetId) {
      targetId = 'migrated-default-project'
      targetName = '未分类'
      // projects 表只有 created_at，没有 updated_at（别照 todos 的列抄）
      db.prepare(
        `INSERT INTO projects (id, name, color, archived, sort_order, created_at)
         VALUES (?, ?, ?, 0, 0, ?)`
      ).run(targetId, '未分类', '#8E8E93', new Date().toISOString())
    }

    // 拷数据：无归属的行归到目标项目（COALESCE 保证 NOT NULL 成立）
    const moved = db
      .prepare(
        `INSERT INTO releases_new (version, project_id, shipped_at, summary, highlights, created_at, tested)
         SELECT version, COALESCE(project_id, ?), shipped_at, summary, highlights, created_at, tested
         FROM releases`
      )
      .run(targetId).changes

    db.exec(`
      DROP TABLE releases;
      ALTER TABLE releases_new RENAME TO releases;
      CREATE INDEX IF NOT EXISTS idx_releases_project ON releases(project_id);
      CREATE INDEX IF NOT EXISTS idx_releases_shipped ON releases(shipped_at);
    `)

    console.log(
      `[Migration] releases 已改为项目内的版本空间（${moved} 行迁入；` +
        `无归属的归入「${targetName}」，自此版本必挂项目）`
    )
  },
  // ── 34：项目接手说明（单一 Markdown 字段；动态状态仍由 todos 派生）──
  (db) => {
    db.exec(`ALTER TABLE projects ADD COLUMN handoff_markdown TEXT NOT NULL DEFAULT ''`)
  },
  // ── 35：接手说明修订历史（36b44adb）──
  // 此前 handoff_markdown 保存即覆盖，误写后旧内容无法找回。
  // 每次**内容有变化的保存**留一行全文；seq 是项目内单调递增的版本序号
  // （修剪最旧版本后也不回收、不重排，所以「第 7 版」永远指同一版）。
  // source_revision_id 不加外键：来源版本可能已被修剪，回滚记录不能因此失去来源线索。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_handoff_revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'save' CHECK (kind IN ('save', 'rollback')),
        source_revision_id TEXT,
        source_seq INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, seq)
      );
    `)
  },
  // ── 36：跨进程会话提醒快照；不与 GUI 已读或长期审计混用 ──
  (db) => {
    db.exec(`
      CREATE TABLE cli_reminder_receipts (
        actor TEXT NOT NULL,
        session_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (actor, session_id)
      );
    `)
  },
  // ── 37：用户页协作协议（全局 / 项目两级）──
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS protocol_blocks (
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        block_key TEXT NOT NULL,
        body TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, project_id, block_key),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_protocol_project ON protocol_blocks(project_id);
    `)
  },
  // ── 38：主用户档案（全局 / 项目两级）──
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_blocks (
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        block_key TEXT NOT NULL,
        body TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, project_id, block_key),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_profile_project ON profile_blocks(project_id);
    `)
  },
  // ── 39：用户档案提议（agent 不能直接让档案生效）──
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_proposals (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        block_key TEXT NOT NULL,
        body TEXT NOT NULL,
        proposer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_profile_proposals_pending ON profile_proposals(status, created_at);
    `)
  },
  // ── 40：协作协议提议，统一由审批页处理 ──
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS protocol_proposals (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        block_key TEXT NOT NULL,
        body TEXT NOT NULL,
        proposer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_protocol_proposals_pending ON protocol_proposals(status, created_at);
    `)
  },
  // ── 41：审批提议快照与最终采纳内容 ──
  // 保存提议时看到的原文及版本戳，审批时可发现内容已被他人更新，避免覆盖。
  (db) => {
    const addColumnIfMissing = (table: string, column: string, definition: string) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    for (const table of ['profile_proposals', 'protocol_proposals']) {
      addColumnIfMissing(table, 'original_body', 'TEXT')
      addColumnIfMissing(table, 'base_updated_at', 'TEXT')
      addColumnIfMissing(table, 'decided_body', 'TEXT')
    }
  },
  // ── 42：agent 接入与审批决定审计事件 ──
  // 只记录升级后实际发生的动作；旧 agent 当前状态不能反推其历史审批过程。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_approval_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('registered', 'approved', 'rejected', 'revoked', 'reopened')),
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_approval_events_time ON agent_approval_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_approval_events_agent ON agent_approval_events(agent_id, created_at DESC);
    `)
  },
  // ── 43：项目接手说明提议 ──
  // Agent 不能直接覆盖项目事实入口；先保存原文和修订基准，审批页采纳后才生效。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_handoff_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        original_body TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        decided_body TEXT,
        proposer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_handoff_proposals_status ON project_handoff_proposals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_handoff_proposals_project ON project_handoff_proposals(project_id, created_at);
    `)
  },
  // ── 44：协作规则配置（流转规则 / 权限矩阵 / 提醒 + 规则提议）──
  // 出厂默认 = 当前产品行为；项目覆盖 → 全局 → 出厂默认。
  // 权限矩阵仅 GUI 可改，CLI/MCP 无入口（安全底线）。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_rules (
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        rule_key TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('flow', 'notice')),
        enforcement TEXT NOT NULL CHECK (enforcement IN ('block', 'authorize', 'notice', 'off')),
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, project_id, rule_key),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_collab_rules_project ON collaboration_rules(project_id);

      CREATE TABLE IF NOT EXISTS permission_matrix (
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        action TEXT NOT NULL,
        subject TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'require_approval', 'deny')),
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, project_id, action, subject),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_permission_matrix_project ON permission_matrix(project_id);

      CREATE TABLE IF NOT EXISTS rule_proposals (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        category TEXT NOT NULL CHECK (category IN ('flow', 'notice')),
        rule_key TEXT NOT NULL,
        proposed_enforcement TEXT NOT NULL CHECK (proposed_enforcement IN ('block', 'authorize', 'notice', 'off')),
        original_enforcement TEXT NOT NULL,
        base_updated_at TEXT,
        decided_enforcement TEXT,
        proposer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_rule_proposals_status ON rule_proposals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_rule_proposals_project ON rule_proposals(project_id, created_at);
    `)
  },
  // ── 45：档案与协作规则修订历史 ──
  // 保存可回滚的层级快照；首次升级时为既有值建立基线，重置操作也保留“无覆盖”状态。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_revisions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        block_key TEXT NOT NULL,
        body TEXT NOT NULL,
        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
        present INTEGER NOT NULL CHECK (present IN (0, 1)),
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_profile_revisions_scope ON profile_revisions(scope, project_id, block_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS rule_revisions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        rule_key TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('flow', 'notice')),
        enforcement TEXT CHECK (enforcement IS NULL OR enforcement IN ('block', 'authorize', 'notice', 'off')),
        has_override INTEGER NOT NULL CHECK (has_override IN (0, 1)),
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CHECK ((has_override = 0 AND enforcement IS NULL) OR (has_override = 1 AND enforcement IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_rule_revisions_scope ON rule_revisions(scope, project_id, rule_key, created_at DESC);

      INSERT INTO profile_revisions (id, scope, project_id, block_key, body, confirmed, present, author, created_at)
      SELECT lower(hex(randomblob(16))), scope, project_id, block_key, body, confirmed, 1, updated_by, updated_at
      FROM profile_blocks;

      INSERT INTO rule_revisions (id, scope, project_id, rule_key, category, enforcement, has_override, author, created_at)
      SELECT lower(hex(randomblob(16))), scope, project_id, rule_key, category, enforcement, 1, updated_by, updated_at
      FROM collaboration_rules;
    `)
  },
  // ── 46：主用户补进"谁读过"这个集合（卡 `c13dbb16`）──
  //
  // ## 为什么必须回填
  //
  // 界面（铃铛角标 / 通知列表）此前一律按全局 `status` 算未读，本轮改成按主体算，
  // 主体是**主用户**（PRD 2.1：主用户的主要通道是 GUI；实体表写着通知的
  // 未读/已读"按主体分别记"）。
  //
  // 麻烦在于存量：**1.0.68 之前读过的行，`read_by` 是 NULL**（迁移 28 的原话是
  // "历史行不知道是谁读的，不编造"），之后在界面上读过的行也从没写过 `read_by`
  // （界面只写全局位）。不回填的话，升级后界面上会**凭空多出一批"未读"**。
  //
  // 实测（2026-10-22，真库只读盘点）：474 条通知里 `read_by` 空/NULL 且
  // `status='read'` 的共 **111** 条 —— 就是这批会重新亮起来。
  //
  // ## 为什么敢认成 'human'
  //
  // 迁移 28 与 `NotificationRepository` 都把 `status`/`read_at` 记为
  // "**人**读的标记（界面铃铛用它）"：这些行的全局已读位就是主用户翻的。
  // 有一小撮分辨不出（agent `memo ack` 走 `markReadByRef` 也会写全局位），
  // 只能一起认成主用户读过 —— 旧数据里没有任何字段能把它们分开，
  // 而**认错的方向是"少一条未读"而不是"凭空多一条未读"**。
  //
  // ⚠️ 判据是 `read_by IS NULL OR read_by = ''`，**不覆盖**已经有读者的行：
  // `read_by` 是集合，追加才是它的语义（`markReadBy` 也是这么写的）。
  // 重复执行也不会重复写（第一次之后就都带 'human' 了）。
  (db) => {
    db.prepare(
      `UPDATE notifications
          SET read_by = 'human'
        WHERE (read_by IS NULL OR read_by = '')
          AND status = 'read'`
    ).run()
  },
  // ── 47：接手说明的"事实快照 / 覆盖声明 / 待复核标记"（卡 `e2a06fd7`）──
  //
  // 病：接手说明是一段自由 Markdown，**谁也不知道它基于哪一版事实写的**。
  // 现场（卡 607871b2）：DeskPartner 的说明写"正式发布为 1.0.97，schema v42"，
  // 而实际已是 1.0.109/schema v45 —— 落 12 个版本，首读的人看不出来。
  //
  // 分层（只做可判的那几层，叙述权仍归人）：
  // - **自动事实**：版本 / schema / 事项计数 / 当前主线 —— 运行时可算，永不落库改写正文；
  // - **覆盖声明**：保存那一刻的事实快照 + 确认人（哪一版说明自称覆盖什么）；
  // - **待复核标记**：发布 / 提议被拒这类"事实之外"的变化，按项目去重记一条，不刷屏。
  //
  // 旧行不回填：没有快照就是"无法核对"，读的时候如实说 `review_required`，
  // 不编一个快照出来（与迁移 28 对 `read_by` 的处置同一条原则）。
  (db) => {
    /**
     * 逐列判存在再加（SQLite 没有 `ADD COLUMN IF NOT EXISTS`）。
     *
     * 为什么这次要幂等：迁移测试会用"当前库 + 把版本号改回 44"来模拟升级路径
     * （`rules-migration` 的那条），此时这些列已经在了 —— 裸 ALTER 会撞
     * `duplicate column name`，而真实的升级路径不该被这种模拟卡住。
     * 顺带也挡住"版本行丢了、迁移重跑"的现实情况。
     */
    const addColumn = (table: string, column: string, ddl: string): void => {
      /**
       * 表不在了就跳过：迁移会按顺序跑到这里，真实的 v47 老库里两张接手表一定存在
       * （v35 / v43 建的）。只有"残缺的合成库"（某些迁移用例为省事只建用得到的表）
       * 才会走到这个分支 —— 对那种库补列没有意义，硬 ALTER 只会抛 `no such table`
       * 把整条迁移链打断。
       */
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(table) as Array<{ name: string }>
      if (!tables.length) return
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
      }
    }
    addColumn('project_handoff_revisions', 'coverage_version', 'TEXT')
    addColumn('project_handoff_revisions', 'coverage_schema', 'INTEGER')
    addColumn('project_handoff_revisions', 'facts_snapshot', 'TEXT')
    addColumn('project_handoff_revisions', 'confirmed_by', 'TEXT')
    addColumn('project_handoff_proposals', 'facts_snapshot', 'TEXT')
    addColumn('project_handoff_proposals', 'source_todo_ids', 'TEXT')
    addColumn('projects', 'handoff_dirty_key', 'TEXT')
    addColumn('projects', 'handoff_dirty_reasons', 'TEXT')
    addColumn('projects', 'handoff_dirty_at', 'TEXT')
    addColumn('projects', 'docs_dir', 'TEXT')
  },
  // ── 48：再回填一次"全局已读却没人记名"（卡 `15557194`，1.0.132）──
  //
  // 迁移 46 把**存量**认成主用户读过，但治不了之后新写出来的行：
  // `memo ack` 走的是 `markReadByRef(id)` —— 只写全局位、不写 `read_by`。
  // 于是每到一条备忘 ack 就多一行"已读却没人记名"，主用户按自己的 `read_by`
  // 算仍是未读，收件箱把它重新亮出来（清了又亮，正是 `c13dbb16` 要消灭的形态）。
  // 2026-10-29 真库里积了 5 条，全是当天的收口备忘。
  //
  // 写入侧已在同版修掉（`markReadByRef(refId, reader)` 与 `MemoRepository.ack(id, reader)`
  // 的 reader 改成必填，追加进 `read_by`），这条只负责清历史。
  // 口径与 46 同一句：分辨不出是谁读的，认成主用户 —— 认错的方向是
  // "少一条未读"，而不是"凭空多一条未读"。重复执行幂等（第一次之后都带 'human'）。
  (db) => {
    db.prepare(
      `UPDATE notifications
          SET read_by = 'human'
        WHERE (read_by IS NULL OR read_by = '')
          AND status = 'read'`
    ).run()
  }
]

/**
 * 迁移前备份数据库
 *
 * 迁移不可逆，而用户库里已经有真实数据 —— 出问题时能拿回一份原样文件，
 * 比任何回滚代码都可靠。（这个做法借鉴自 MoliTodo 的迁移流程。）
 *
 * 注意 WAL：只拷主文件会丢掉还在 -wal 里、尚未 checkpoint 的事务，
 * 所以先做一次 TRUNCATE checkpoint，把 WAL 内容并回主文件再拷。
 */
function backupBeforeMigrate(
  db: Database.Database,
  fromVersion: number
): string | null {
  try {
    const dbPath = db.name
    // 内存库（单测用）没有文件可备份
    if (!dbPath || dbPath === ':memory:') return null

    db.pragma('wal_checkpoint(TRUNCATE)')

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = `${dbPath}.backup-v${fromVersion}-${stamp}`
    fs.copyFileSync(dbPath, dest)
    console.log(`[Migration] 迁移前已备份: ${dest}`)
    pruneOldBackups(dbPath)
    return dest
  } catch (err) {
    // 备份失败不阻断迁移，但必须让人看见 —— 静默失败等于没有备份
    console.warn(
      '[Migration] 迁移前备份失败，将直接迁移:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * 只保留最近几份迁移备份（1.0.40，1.0.49 修 sidecar 处理）
 *
 * 原实现每次都写一份 `<db>.backup-v<版本>-<时间戳>` 且从不清理 ——
 * 每升一次 schema 就留一份完整库文件（当前约 3~4 MB），
 * 长期用下来 userData 目录会被这些历史快照堆满，而它们几乎不会被翻出来看。
 *
 * 保留 2 份而不是 1 份：留一点冗余，万一最新那份恰好是在一次坏迁移前拷的，
 * 还有上一版可用。**只删文件、不动当前库**；删失败就跳过（下次再试），
 * 绝不因为这个清理动作把迁移流程搞挂。
 *
 * ── 🚨 1.0.49 修：`-wal` / `-shm` 必须成组处理（主用户 0c05da32）──
 *
 * 原实现把目录里所有 `user.db.backup-*` 前缀的文件**各自当成一份快照**。
 * 但备份文件被打开过之后，SQLite 会生成 `<备份>.backup-...-wal` 与 `-shm`：
 *
 * - **计数错位**：一份快照占 3 个文件名，于是 `keep = 2` 实际只保住了
 *   0.67 份快照，或者反过来把 sidecar 当快照留下；
 * - **孤儿 sidecar**：按 mtime 排序删的时候，主文件与它的 sidecar 顺序
 *   可能不挨着，于是出现"主文件被删、`-shm` 还留在目录里"。
 *   人打开目录会以为**还有备份**（主用户实测：只剩一个孤儿 `-shm`，
 *   主文件不见，以为手里还有两份快照实际一份都没有）。
 *
 * 现在按**主文件**（不带 `-wal` / `-shm` 后缀）分组，删的时候三件套一起删。
 * 这样"还剩几条退路"才等于目录里能看到的主文件数。
 *
 * ⚠️ 导出仅为**可测性**：它是纯文件操作（给定目录 → 决定删哪些），
 * 而"删错文件"这类 bug 的代价是**丢掉救命快照**（1.0.49 事故的直接教训），
 * 必须能用单测钉住。不导出就只能靠 runMigrations 间接测，那层噪音太大。
 */
export function pruneOldBackups(dbPath: string, keep = 2): void {
  try {
    const dir = path.dirname(dbPath)
    const prefix = `${path.basename(dbPath)}.backup-`
    const all = fs.readdirSync(dir).filter((f) => f.startsWith(prefix))

    /**
     * 分组：主文件 → 它的 sidecar。
     * `-wal` / `-shm` 只是 SQLite 的运行时附属文件，不是独立备份。
     */
    const groups = new Map<string, string[]>()
    for (const name of all) {
      const isSidecar = name.endsWith('-wal') || name.endsWith('-shm')
      const main = isSidecar ? name.replace(/-(wal|shm)$/, '') : name
      const list = groups.get(main) ?? []
      list.push(name)
      groups.set(main, list)
    }

    // 只按主文件的 mtime 排序 —— 快照的"新旧"由主文件决定
    const ordered = [...groups.entries()]
      .map(([main, files]) => {
        let mtime = 0
        try {
          mtime = fs.statSync(path.join(dir, main)).mtimeMs
        } catch {
          // 主文件不见了（被手工删过）：用 sidecar 里最新的时间兜底，
          // 免得它永远排在最后、永远不被清理
          for (const f of files) {
            try {
              mtime = Math.max(mtime, fs.statSync(path.join(dir, f)).mtimeMs)
            } catch {
              /* 读不到就算了 */
            }
          }
        }
        return { main, files, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime) // 最新在前

    for (const { files } of ordered.slice(keep)) {
      for (const name of files) {
        try {
          fs.unlinkSync(path.join(dir, name))
          // 措辞不点名调用方（卡 71270463）：现在**导入前的备份**也走这一套轮转，
          // 日志说 "[Migration]" 会让人往迁移上查
          console.log(`[快照轮转] 已清理旧备份: ${name}`)
        } catch {
          // 删不掉（占用/权限）就留着，不该因此中断
        }
      }
    }
  } catch {
    // 清理失败不影响迁移本身
  }
}

/**
 * 列出当前可用的迁移快照（1.0.49，修 0c05da32）
 *
 * 主用户的原话是「恢复完成后在界面上回报当前可用快照清单，让人知道自己
 * 还剩几条退路」。这条正是那件事的数据层：**只数主文件**，
 * 顺带把孤儿 sidecar 报出来（它们会让目录看起来比实际更有退路）。
 *
 * 不做"自动清理孤儿"：孤儿 `-shm` 删掉是安全的，但把它**报出来**
 * 比悄悄删掉更有价值 —— 它的存在本身就是一次"主文件被搬走了"的证据，
 * 而那正是 2026-09-22 环境恢复留下的痕迹。
 */
export function listSnapshots(dbPath: string): {
  snapshots: { name: string; mtimeMs: number; sizeBytes: number }[]
  orphanSidecars: string[]
} {
  try {
    const dir = path.dirname(dbPath)
    const prefix = `${path.basename(dbPath)}.backup-`
    const all = fs.readdirSync(dir).filter((f) => f.startsWith(prefix))

    const mainNames = all.filter((f) => !f.endsWith('-wal') && !f.endsWith('-shm'))
    const mainSet = new Set(mainNames)

    const snapshots = mainNames
      .map((name) => {
        const st = fs.statSync(path.join(dir, name))
        return { name, mtimeMs: st.mtimeMs, sizeBytes: st.size }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    const orphanSidecars = all.filter((f) => {
      if (!f.endsWith('-wal') && !f.endsWith('-shm')) return false
      return !mainSet.has(f.replace(/-(wal|shm)$/, ''))
    })

    return { snapshots, orphanSidecars }
  } catch {
    return { snapshots: [], orphanSidecars: [] }
  }
}

/**
 * 迁移失败（`c5b30fb3` 的「失败硬停」半边）
 *
 * 与 `MigrateLockTimeoutError` 分开：那个是"稍后重试"，这个是
 * "库停在旧版本，先看备份再决定怎么办" —— 两种话必须分得开。
 * message 自带备份路径，调用方（启动层硬停）直接展示即可，不用再拼。
 */
export class MigrationError extends Error {
  readonly backupPath: string | null
  readonly fromVersion: number
  constructor(
    message: string,
    opts: { backupPath: string | null; fromVersion: number; cause?: unknown }
  ) {
    super(message)
    this.name = 'MigrationError'
    this.backupPath = opts.backupPath
    this.fromVersion = opts.fromVersion
    // cause 不走 ErrorOptions：目标 ES 版本没有那个构造参数
    ;(this as { cause?: unknown }).cause = opts.cause
  }
}

export interface RunMigrationsOptions {
  /** 仅可测性：注入排他锁（默认按库文件建文件锁；内存库为 no-op） */
  lock?: MigrateLock
  /** 仅可测性：注入迁移列表（默认全部）——用于构造"迁移中失败"而不写死版本号 */
  migrations?: MigrationFn[]
}

/**
 * 执行数据库迁移
 *
 * ⚠️ 整个"版本复核 → 迁移前备份/清旧备份 → 迁移 → 版本写入"都在
 * **同一个跨进程排他锁**里（`c5b30fb3`）。两层各管一件事：
 * - 文件锁：跨进程互斥，连备份/清旧备份一起罩住（实测两进程各备份各清理过）；
 * - 库事务：迁移本身要么全成、要么全滚（失败后版本号不动，下次启动重试）。
 *
 * **版本号必须在拿到锁之后再读**：拿到锁之前读到的"待迁移"是过期事实，
 * 等锁期间别人可能已经迁完 —— 不复核就会把迁移重跑一遍撞 duplicate column。
 */
export function runMigrations(db: Database.Database, options: RunMigrationsOptions = {}): void {
  const dbPath = typeof db.name === 'string' ? db.name : ''
  const lock =
    options.lock ??
    (dbPath && dbPath !== ':memory:' ? createFileMigrateLock(dbPath) : noopMigrateLock())

  lock.acquire()
  try {
    runMigrationsLocked(db, options.migrations ?? migrations)
  } finally {
    lock.release()
  }
}

/** 持锁后的迁移本体。只由 `runMigrations` 调 —— 直接调它等于裸奔（无跨进程排他） */
function runMigrationsLocked(db: Database.Database, list: MigrationFn[]): void {
  // 创建版本追踪表
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER NOT NULL
    );
  `)

  // 读取当前版本（**在锁内**：等锁期间别人可能已经迁完，这里读的才是事实）
  // 注意：早期实现未给该表设置主键，INSERT OR REPLACE 退化为普通插入，
  // 表内可能累积多行历史版本。这里取最大值作为真实版本。
  const row = db.prepare('SELECT MAX(version) AS version FROM _schema_version').get() as
    | { version: number | null }
    | undefined
  const currentVersion = row?.version ?? 0

  // 增量执行迁移
  if (currentVersion < DB_VERSION) {
    // 先备份再动结构：迁移不可逆，用户库里已有真实数据
    const backupPath = backupBeforeMigrate(db, currentVersion)

    /**
     * 重建表（v9 去掉 category_id 用的就是这招）期间必须关掉外键：
     * 别的表引用了 todos，带外键 DROP TABLE 会失败。
     * PRAGMA foreign_keys 在事务内是空操作，所以只能在事务外开关。
     */
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1
    if (fkWasOn) db.pragma('foreign_keys = OFF')

    try {
      const migrate = db.transaction(() => {
        for (let i = currentVersion; i < DB_VERSION; i++) {
          console.log(`[Migration] 执行迁移 v${i} → v${i + 1}`)
          list[i](db)
        }
        // 更新版本号：先清空历史行，避免版本号累积导致迁移重复执行
        db.prepare('DELETE FROM _schema_version').run()
        db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(DB_VERSION)
      })
      migrate()
      console.log(`[Migration] 数据库已迁移到版本 ${DB_VERSION}`)
    } catch (err) {
      /**
       * 失败必须**明确报出来**（`c5b30fb3`：此前是未处理拒绝，
       * 进程带着不确定的库状态继续跑命令）。事务已回滚，库停在
       * `fromVersion` —— 这句话和备份路径要让调用方看得见。
       */
      const detail = err instanceof Error ? err.message : String(err)
      throw new MigrationError(
        `数据库迁移失败（v${currentVersion} → v${DB_VERSION}）：${detail}` +
          (backupPath
            ? `。迁移前已备份：${backupPath}`
            : '。迁移前没有备份成功（备份失败不阻断迁移，但请知悉）') +
          '。数据库已回滚到迁移前状态，程序停止运行以免带着不确定的库状态执行命令。',
        { backupPath, fromVersion: currentVersion, cause: err }
      )
    } finally {
      // 无论成败都要恢复，留着关闭状态后续写入就不再校验外键了
      if (fkWasOn) db.pragma('foreign_keys = ON')
    }
  } else {
    console.log(`[Migration] 数据库已是最新版本 ${DB_VERSION}`)
  }
}
