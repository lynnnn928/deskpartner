import { v4 as uuidv4 } from 'uuid'
import { TelemetryRepository, type RecordUsageInput, type UsageQuery } from '../database/telemetry.repository'

/**
 * 本地使用埋点服务
 *
 * 三条硬边界，改动时不要越过：
 * 1. **只写本地**，本服务不做任何网络行为
 * 2. **埋点失败绝不能影响主流程** —— 所有写入都吞掉异常
 * 3. **不采集正文内容**（待办标题、描述），只采集结构化行为元数据
 *
 * 数据出口只有两个：设置页导出，或 CLI 的 telemetry export。
 * 没有第三条（没有自动上传）。
 */
export class TelemetryService {
  private repo: TelemetryRepository
  private sessionId = uuidv4()
  private enabled: boolean

  constructor(enabled: boolean) {
    this.repo = new TelemetryRepository()
    this.enabled = enabled
  }

  /** 开关由设置项驱动 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get session(): string {
    return this.sessionId
  }

  /**
   * 记录一条事件；任何异常都不向上抛
   *
   * `sessionId` 可覆盖（1.0.49，修 3d6e4395）：
   *
   * 默认用本服务实例的 uuid（一次进程启动 = 一个会话，界面侧走这条）。
   * 但 CLI 侧调用方可能**自己声明对话标识**（`DESKPARTNER_SESSION`），
   * 目的是把同一轮对话里的多次调用串起来 —— 而此前那个签名是
   * `Omit<RecordUsageInput, 'sessionId'>`，调用方只能把标识塞进 `props`，
   * 于是 `session_id` 列永远是随机 uuid，"按对话归组"这件事根本没生效
   * （主用户 3d6e4395 要的正是这条曲线）。
   *
   * 所以：**显式传入优先，没传才回退到实例默认**。
   * 这不是"让调用方能改埋点"，而是承认"会话边界只有调用方知道" ——
   * 一个进程一个 uuid 是界面侧的合理近似，但对 CLI 不是。
   */
  record(input: Omit<RecordUsageInput, 'sessionId'> & { sessionId?: string | null }): void {
    if (!this.enabled) return
    try {
      this.repo.record({ ...input, sessionId: input.sessionId?.trim() || this.sessionId })
    } catch (err) {
      // 埋点本身出错不该让功能挂掉，也不该刷屏
      console.error('[Telemetry] 记录失败:', err instanceof Error ? err.message : String(err))
    }
  }

  query(filter: UsageQuery) {
    return this.repo.query(filter)
  }

  stats(filter: UsageQuery = {}) {
    return this.repo.stats(filter)
  }

  /** 启动时按保留策略清理一次 */
  prune(): number {
    try {
      return this.repo.prune()
    } catch (err) {
      console.error('[Telemetry] 清理失败:', err instanceof Error ? err.message : String(err))
      return 0
    }
  }

  clear(before?: string): number {
    try {
      return this.repo.clear(before)
    } catch (err) {
      console.error('[Telemetry] 清空失败:', err instanceof Error ? err.message : String(err))
      return 0
    }
  }
}
