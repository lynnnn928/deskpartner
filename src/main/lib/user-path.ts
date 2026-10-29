/**
 * 用户 PATH 的合并逻辑（1.0.55 从 `src/main/index.ts` 抽出；1.0.56 起**不再被调用**）
 *
 * ── 状态：保留，但不接线 ──
 *
 * 2026-09-28 主用户拍板 2cc71a13：「不进 PATH，改做 MCP Server」。于是
 * `index.ts` 里的 `ensurePathContains()` 已整体摘除，本模块**没有任何生产调用方**。
 *
 * 之所以不连代码一起删：
 * - 它守的判据（**删除不能建立在会骗人的信号上**）与具体功能无关，
 *   任何"碰用户环境变量"的改动都用得上；
 * - 它带着 9 条回归测试（`tests/main/lib/user-path.test.ts`），
 *   断言的是"别人的条目一条都不许删"—— 这条判据值得留档。
 * 若将来确认不会再回到 PATH 方案，本文件与它的测试可一并删除。
 *
 * ── 它守的那次事故（主用户 2026-09-28 实测）──
 *
 * 上一版 index.ts 里用的是：
 * ```
 * const cleaned = parts.filter((p) => fs.existsSync(p) || norm(p) === norm(dir))
 * ```
 * "顺手清理失效条目"，于是把**所有此刻读不到的路径**都删了 ——
 * 本机 `HKCU\Environment\Path` 从 7 项只剩 1 项，类型也从 REG_EXPAND_SZ 退成 REG_SZ。
 *
 * 根因不是"忘了保护"，而是**判据选错了**：
 * `existsSync` 回答的是"这一刻能不能读到"，而 PATH 条目的意义是
 * "将来可能要用"（网络盘、外接盘、休眠中的盘都可能暂时读不到）。
 * 拿一个会骗人的信号去驱动删除操作，必然出事。
 *
 * 所以这里的口径是**只允许删我们自己认领的旧条目**。
 */

/** REG_SZ / REG_EXPAND_SZ 的数值（`[Microsoft.Win32.RegistryValueKind]`） */
export const REG_SZ = 1
export const REG_EXPAND_SZ = 2

export interface MergeUserPathResult {
  /** 合并后的完整条目列表（顺序保持原样，新条目追加在末尾） */
  next: string[]
  /** 清掉了几条（只可能是我们自己的失效旧条目） */
  removed: number
  /** dir 是否已在列表里 */
  already: boolean
}

/** 规范化比较用：去尾部斜杠、统一小写（Windows 路径大小写不敏感） */
export function normalizePathEntry(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 这条 PATH 条目是不是**我们自己**（DeskPartner 的 CLI 目录）留下的？
 *
 * 判据取"身份"（路径形状）而不是"状态"（目录存不存在）——
 * 只有能确认是自家残骸的，才允许清。
 */
export function isDeskPartnerCliEntry(p: string): boolean {
  const n = normalizePathEntry(p)
  if (!n) return false
  return n.endsWith('resources\\cli') || n.endsWith('resources/cli')
}

/**
 * 把 `dir` 合并进用户 PATH。
 *
 * @param parts      现有条目（已按 `;` 切分、去空）
 * @param dir        要确保存在的目录
 * @param exists     文件系统探测函数（注入进来以便测试；**只用于判断自家的旧残骸**）
 */
export function mergeUserPath(
  parts: string[],
  dir: string,
  exists: (p: string) => boolean
): MergeUserPathResult {
  const target = normalizePathEntry(dir)
  const kept: string[] = []
  let removed = 0

  for (const p of parts) {
    /**
     * 只有"我们自己认领的、指向别处的、且确实已失效"的条目才清。
     *
     * 注意三个条件缺一不可 —— 特别是 `isDeskPartnerCliEntry`：
     * 少了它，这就是上一版那条误伤全场的规则。
     */
    if (isDeskPartnerCliEntry(p) && normalizePathEntry(p) !== target && !exists(p)) {
      removed++
      continue
    }
    kept.push(p)
  }

  const already = kept.some((p) => normalizePathEntry(p) === target)
  return { next: already ? kept : [...kept, dir], removed, already }
}
