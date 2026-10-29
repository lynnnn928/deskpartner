/**
 * `batch` 的体积上界与逐行收束（拆分卡 bbeb1b51，纯搬移）
 *
 * 单行信封上界（`BATCH_LINE_LIMIT`）、整批上界（`BATCH_TOTAL_LIMIT`）、
 * 以及把一行结果压进上界的 `boundBatchLine`。判据：**回执多大不能由数据量决定**。
 */

// ── 调度：单条执行与批量执行共用同一套逻辑，保证行为完全一致 ──

/**
 * `batch` **单行结果**的信封体积上界（1.0.107，修 `a7f94301`）。
 *
 * ## 它治的病
 *
 * 行结果是把子命令的 `Outcome` 原样摊平进 `results`，所以 records 里写一条
 * `{"cmd":"telemetry export"}` 就能让一次 `batch` 调用回 **546,868 字节**
 * （2026-10-20 实测：一行里 1143 条记录）。`7e321f6d` 给"逐行输出的**工具**"兜过
 * 默认条数上界，但那一跳挂在**工具的入参**上，而 batch 的参数是**命令** ——
 * 同一条病的第二条路，它管不到。判据不变：**没有上界，回执多大就由数据量决定**，
 * 而数据量是调用方看不见的东西。
 *
 * ## 为什么是"截断 + 显式标记"，不是"拒绝执行"
 *
 * 拒绝会让一条本来正常的命令整批失败；截断保住了"这条确实跑了、这就是结果"，
 * 而 `truncated` 标记保证调用方**不会把截断当成全量**。这是底线：
 * **静默截断比不截断更坏** —— 调用方会据此得出"就这么多"的结论。
 *
 * ## 保留什么、丢什么
 *
 * - `data` 是数组（导出类的主要形状）：**按条留到预算内**，并给出
 *   `total` / `returned` / `bytes` —— 调用方据此知道还有多少没看到、该往哪儿取。
 * - `data` 是别的（大对象、长字符串）：只留一段 `preview` 与体积。
 * - 行里的 `ok` / `code` / `exitCode` / `errorCode` / `message` / `notice`
 *   **一个都不动**：截断的是"数据有多大"，不是"这条成没成功"。按 `exitCode`
 *   分流的调用方读到的仍是同一件事（`e209441e` 好不容易统一的正是这个）。
 *
 * ⚠️ 上界是**单行**的，不是整批的：整批多大由调用方自己写的行数决定 —— 那是它
 * 看得见的量；它看不见的是"一行能有多大"。要全量数据，用子命令自己的翻页参数
 * （`--limit` / `--since`）分批取，或直接跑 CLI。
 *
 * ⚠️ 量的是**缩进 2 的序列化**（调用方看到的就是那个形状），量紧凑 JSON 会给出
 * 一个比实际输出小得多的数，那样的上界是假的。
 */
export const BATCH_LINE_LIMIT = 64 * 1024

/**
 * `batch` **整批回执**的体积上界（1.0.108，修 `a7f94301`）。
 *
 * ## 为什么单行上界不够
 *
 * 单行上界治的是"一行能有多大"，而一次 batch 可以有很多行：1000 行 × 单行上界 = 64MB。
 * 判据仍是同一条 —— **回执多大不能由数据量决定**。"我写了几行"调用方看得见，
 * 但"一行会有多大"它看不见，所以整批必须有自己的上界（bob 驳回本卡时点名的第二件事）。
 *
 * ## 为什么是 256KB
 *
 * - 它是**单行上界（64KB）的 4 倍**：一次批几十条小记录（`todo get` 之类，每条 1–3KB）
 *   离它还远，正常的批量用法不会撞上；
 * - 它**只有被投诉那个数（456KB / 546KB）的一半**：即便记录里显式写 `--limit 0`、
 * - 超过它就**停止执行剩下的记录**并标 `truncated`（见下面的注释）；
 *   越过预算的那一行只回判定与一段说明（不回数据），所以回执的实际体积是
 *   "上界 + 那段说明 + 几十字节的信封"。
 *
 * ## 越过预算的那一行是"已执行、数据不回"
 *
 * 一行的体积要跑完才知道，所以拦不到"执行前"。这里扣的是**数据**不是**成败**：
 * `ok` / `exitCode` / `errorCode` 照常返回 —— **跑了却不说**才是更坏的那种
 * （调用方会重发，于是做两遍）。剩下的记录**没有执行**，信封里的 `skipped` 说明还剩几条。
 *
 * ⚠️ 与 `BATCH_LINE_LIMIT` 一样，量的是"印进整批信封里"的体积（`batchLineBytes`），
 * 两把尺子同一套口径。
 */
export const BATCH_TOTAL_LIMIT = 256 * 1024

/**
 * 量"这一行印在整批信封里"的真实体积。
 *
 * ## 为什么不能直接量这一行自己
 *
 * 它印出来时嵌在 `data.results[i]` 里（信封 → data → results → 行），比单独
 * `JSON.stringify(line, null, 2)` **深三层**：里面每一行都多几个空格。
 * 实测（2000 条埋点）单独量 59,740 字节、真印出来 75,833 字节 —— **差 27%**。
 * 量错方向的上界等于没有上界，所以这里把它嵌进一个**固定参考信封**再量：
 * 参考信封自己那几十字节的骨架也一并算进去（有意偏保守）。
 */
export function batchLineBytes(line: Record<string, unknown>): number {
  const embedded = JSON.stringify({ data: { results: [line] } }, null, 2) ?? ''
  return Buffer.byteLength(embedded, 'utf8')
}

/**
 * 把一行结果压进 `BATCH_LINE_LIMIT`。没超就**原样返回**：不复制、不加任何键，
 * 小结果的字节与改前逐字节一致（这条是"不涉及导出类命令的 batch 行为不变"的落点）。
 */
export function boundBatchLine(line: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(line, null, 2) ?? '', 'utf8')
  if (batchLineBytes(line) <= BATCH_LINE_LIMIT) return line

  const hint =
    `本行结果 ${bytes} 字节，超过批量回执的单行上界（${BATCH_LINE_LIMIT} 字节），已截断。` +
    `要看全量：用子命令自己的翻页参数（如 --limit / --since）分批取，或直接跑 CLI。`

  if (Array.isArray(line.data)) {
    const all = line.data
    const build = (k: number): Record<string, unknown> => ({
      ...line,
      data: {
        truncated: true,
        bytes,
        total: all.length,
        returned: k,
        records: all.slice(0, k),
        note: k ? hint : `${hint}（单条记录本身就超过上界，一条也没保留）`
      }
    })
    /**
     * 二分出"最多留几条还落回上界"。
     *
     * 为什么不逐条累加字节：同一条记录**单独序列化**与**嵌进这一行**的字节数
     * 不同（深几层、每行多几个空格），累加出来的只是"大约" —— 而这一卡治的
     * 正是"大约的上界"。体积对条数单调，所以二分既准确又便宜
     * （2000 条只要 log₂ ≈ 11 次序列化）。
     */
    let lo = 0
    let hi = all.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2)
      if (batchLineBytes(build(mid)) <= BATCH_LINE_LIMIT) lo = mid
      else hi = mid - 1
    }
    return build(lo)
  }

  return {
    ...line,
    data: {
      truncated: true,
      bytes,
      preview: (JSON.stringify(line.data ?? null) ?? '').slice(0, 500),
      note: hint
    }
  }
}
