/**
 * CLI 命令定义
 *
 * 每条命令都自带参数声明（flags），`schema` 命令直接把这份声明序列化输出。
 * 这样接口文档不可能与实现脱节 —— 手写一份文档早晚会漂移，
 * 本项目在测试里已经吃过一次这个亏（测试抄了一份 CREATE TABLE，加字段后全红）。
 *
 * 当前实现：schema / doctor / skill / todo add|list|done|rm / telemetry / batch。
 * 命令既能走无头进程，也能走常驻管道（两条通道共用同一套执行逻辑）。
 *
 * ── 文件布局 ──
 *
 * 1.0.112（卡 bbeb1b51）先把六种职责从同一个 9600 行文件里按**内聚区**分开；
 * 之后卡 d1b71d28 又把命令表按**业务域**切进了 `commands/<域>.ts`。
 * 本文件始终只剩"再导出一次"的门面 —— 既有的 `./commands` 导入路径与导出名
 * 一个都没少（调用方无需改动）：
 *
 *   command-text.ts     口径常量与回执文案
 *   command-core.ts     类型 / 上下文 / 守卫 / 参数解析
 *   command-table.ts    命令表的**聚合处**（各域数组按原序拼成一张表）与表级查询
 *   command-batch.ts    batch 的体积上界与逐行收束
 *   command-exec.ts     单条执行与代人执行
 *   command-schema.ts   schema 渲染
 *   commands/           命令本身，按业务域：todo / project / release / review / ops /
 *                       governance / category / batch / agent / ui / meta
 *
 * 依赖方向：text → core → table → {commands/*, batch, exec, schema}。
 *
 * ⚠️ 有几组是**循环引用**，与 `agent-guide.ts` ↔ 本文件那条同一手法 ——
 * 两边都只在**函数体内**取对方的值，谁都不在模块顶层求值（表是惰性的 `run`，
 * core 是守卫与解析函数）：
 *   · core ↔ table：core 的守卫需要 `findCommand` / `canonicalGrantArgv`，
 *     而表本身需要 core 的类型与守卫；
 *   · table ↔ {commands/*, exec, schema}：`batch` 调 `executeOne` 与 `findCommand`，
 *     `schema` / `help` 调 `buildSchema` 并按名字查表，`category` 要
 *     `confirmationCommands` —— 而它们都定义在聚合器里。
 * 加新代码时别在模块顶层读兄弟模块的 `const`（那会踩 TDZ）。
 */
export * from './command-text'
export * from './command-core'
export * from './command-table'
export * from './command-batch'
export * from './command-exec'
export * from './command-schema'
