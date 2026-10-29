import path from 'node:path'

/**
 * 数据目录隔离的**防呆校验**（1.0.49）
 *
 * 主用户 2026-09-23 拍板：「设了隔离开关却没生效时应拒绝运行」。
 *
 * ── 为什么必须有这道检查 ──
 *
 * `DESKPARTNER_DATA_DIR` 是"我要在隔离库里操作"的唯一表达方式。
 * 而它生效需要一连串条件同时成立：环境变量非空、`mkdirSync` 成功、
 * `app.setPath` 没抛错、且调用发生在 `app.whenReady()` 之前。
 * **任一环失败，程序都会退回默认目录（真实库）继续跑。**
 *
 * 原实现的处置是 `console.error` 然后照常运行 —— 这对"跑在 CLI 里、
 * stdout 要留给 JSON 解析"的调用方等于**什么都没说**：它以为自己在
 * 隔离环境里演练，实际改的是真实库。这正是 2026-09-22 演练事故的形状：
 * 不是操作者不小心，是他以为隔离生效了。
 *
 * 所以判据从"尽力隔离"改成"**要么真的隔离，要么别跑**"：
 * 隔离是声明式的意图，意图与实际不符时，沉默地继续跑是最贵的选项。
 *
 * ── 两种"设了却没生效" ──
 *
 * 1. **空值**（`DESKPARTNER_DATA_DIR=` 或 `=$SOME_UNSET_VAR`）——
 *    最常见的坑是变量没展开。原代码用 `?.trim()` 后当 falsy 处理，
 *    于是静默走真实库。**"我设了但它是空的"必须当成设了**：
 *    没人会故意 export 一个空值来表达"用真实库"。
 * 2. **解析后路径不一致** —— `mkdirSync` 或 `setPath` 失败后退回默认目录。
 *
 * ⚠️ 这个函数是**纯函数**（不读 electron、不碰文件系统），
 * 因为它的判据必须能被单测钉住，而 `src/main/index.ts` 顶层
 * 在 vitest 里加载不了。
 */

export type IsolationCheck =
  | { ok: true }
  | {
      ok: false
      /** 调用方声明的隔离目录（原始环境变量值） */
      requested: string
      /** 实际会用的目录 —— 也就是**真实库**所在 */
      actual: string
      reason: 'empty' | 'mismatch'
    }

/** 路径比较：Windows 上大小写不敏感，`path.relative` 比字符串相等更稳 */
function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === ''
}

export function checkIsolation(
  rawEnv: string | undefined,
  actualUserData: string
): IsolationCheck {
  // 压根没设 → 本来就没打算隔离，不是错误
  if (rawEnv === undefined) return { ok: true }

  // 设了但是空值：几乎必然是变量没展开，当成"设了却没生效"
  if (rawEnv.trim() === '') {
    return { ok: false, requested: rawEnv, actual: actualUserData, reason: 'empty' }
  }

  if (!samePath(rawEnv, actualUserData)) {
    return { ok: false, requested: rawEnv, actual: actualUserData, reason: 'mismatch' }
  }

  return { ok: true }
}

/**
 * 把校验失败翻译成**调用方能照着自救**的话。
 *
 * 只说"隔离未生效"等于让调用方猜：是路径写错了？还是没权限？
 * 所以三条信息缺一不可 —— 它声明了什么、实际会动哪个库、以及
 * **"别重试"**（重试同样会失败，得先修环境）。
 */
export function isolationErrorMessage(check: Extract<IsolationCheck, { ok: false }>): string {
  const why =
    check.reason === 'empty'
      ? `DESKPARTNER_DATA_DIR 是空值（多半是变量没展开，如 =$SOME_UNSET_VAR）`
      : `DESKPARTNER_DATA_DIR 指向 ${path.resolve(check.requested)}，但数据目录最终仍是 ${check.actual}` +
        `（创建目录或 app.setPath 失败，已退回默认目录）`
  return (
    `隔离数据目录未生效，已拒绝运行：${why}。` +
    `继续运行会读写**真实库**，与"我在隔离环境里"的预期不符 —— ` +
    `这正是 2026-09-22 演练改坏真实数据的成因。` +
    `请修正 DESKPARTNER_DATA_DIR（用绝对路径、确认可写），或清空该变量明确表示"就用真实库"。`
  )
}
