import { BrowserWindow } from 'electron'
import { EventsRepository } from '../database/events.repository'
import { DEFAULT_EVENTS } from '../../renderer/lib/constants'

type WindowMap = {
  floatBall?: BrowserWindow | null
  quickAdd?: BrowserWindow | null
  kanban?: BrowserWindow | null
  settings?: BrowserWindow | null
}

/**
 * 跨进程变更广播
 *
 * 解决的只有一件事：**别的进程**改了数据，正在运行的 GUI 要能察觉。
 *
 * 同一个进程内的改动走 Electron 的 webContents.send 直接广播就够了，
 * 不需要绕数据库；但 CLI 每次调用都是独立进程，它写完就退出，
 * GUI 毫不知情 —— 界面就会一直显示旧数据。
 * 所以两边约定：写库时往 events 表追加一条，GUI 轮询这张表。
 *
 * 为什么是轮询而不是监听文件：任务库跑在 WAL 模式下，
 * 文件变动事件在不同平台触发时机不一致，容易漏更新；
 * 直接读表更可靠。代价是最坏约一个轮询间隔的延迟（800ms），
 * 对桌面待办场景可以接受。
 *
 * 定位是**兜底**：正常路径（GUI 内操作、将来的通道 A）本来就天然同步，
 * 这里只补"GUI 在跑但改动来自另一个进程"这条窄路径。
 */
export class ChangeBroadcastService {
  private repo = new EventsRepository()
  private timer: ReturnType<typeof setInterval> | null = null
  private cursor = 0

  /**
   * @param selfActor 本进程标识。自己写入的事件已经在写入时就广播过了，
   *                  轮询遇到它只推进游标、不再重复广播。
   * @param onGrantRequest 有人在等授权点头（1.0.37）。
   *
   *   授权申请是**唯一一种需要 GUI 主动弹横幅**的跨进程事件：其它变更都只是
   *   "界面该刷新了"，而这一条是"agent 正卡在那条命令上等你表态" ——
   *   不弹出来，人根本不知道有这回事（主用户的原话就是"没看到任何审批提醒"）。
   *
   *   放在这里而不是让 CLI 直接调窗口管理器：CLI 可能跑在另一个进程里，
   *   本进程没有窗口可弹；而事件表是两条通道共用的既成机制，复用最省事。
   */
  constructor(
    private getWindows: () => WindowMap,
    private selfActor: string,
    private onGrantRequest?: (payload: {
      grantId: string
      agentId: string
      scope: string
      command: string | null
      /** 申请目标的可读摘要（1.0.39），如「todo rm「某待办标题」」；旧事件没有此字段 */
      summary?: string | null
    }) => void,
    /**
     * 新 agent 接入（1.0.63）。
     *
     * 与授权申请同属"人该去点一下头"的事，但**是两类不同的等待**：
     * 申请是"它卡在那条命令上、动不了"；注册是"它刚到场、还没干活"。
     * 所以要分别回调，让 GUI 给出不同的话（而不是都写成"AI 在等你批准"）。
     */
    private onAgentRegistered?: (payload: { agentId: string; displayName: string }) => void
  ) {}

  start(): void {
    if (this.timer) return
    // 从当前最大值起步：避免把历史事件当成新变更重放一遍
    this.cursor = this.repo.maxId()
    this.timer = setInterval(() => this.poll(), DEFAULT_EVENTS.pollIntervalMs)
    // 定时器不该阻止进程退出
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private poll(): void {
    try {
      const events = this.repo.listSince(this.cursor)
      if (!events.length) return

      this.cursor = events[events.length - 1].id

      // 自己写入的事件在写入时已经广播过，这里跳过，避免重复刷新
      const external = events.filter((e) => e.actor !== this.selfActor)
      if (!external.length) return

      /**
       * 授权申请：先弹横幅，再按常规广播刷新。
       *
       * 横幅在刷新之前发是刻意的 —— 设置页的红点靠的是自己的轮询，
       * 不依赖这条广播；但横幅越早出现越好，它才是"你被需要了"的那一下。
       * 多条申请合并成一条横幅：横幅只放得下"谁想干什么"，
       * 弹五条叠在一起等于没弹（设置页里那五条一条都不会少）。
       *
       * ⚠️ 取**最新**那条，不是最早那条（2026-09-22 修）。
       *
       * 原实现用 `find()`，取的是这批里**第一条**（最早）。一条申请时看不出问题，
       * 但轮询一旦被系统节流、挂起过（休眠、后台限速），下一批就会一次带回
       * 好几条 grant 事件 —— 于是横幅永远停在**最早**那条上，后面 agent 的申请
       * 一个也弹不出来。
       *
       * 主用户实测撞到的正是这个：14:41 alice 申请、14:52 Bob申请，
       * 横幅一直显示 alice，而设置页的待表态列表里躺着Bob。
       * 两边看起来"身份对不上"，其实是横幅压根没换过。
       *
       * 取最新才对：最新那条才是刚发生、还没人处理的那个；早点那条
       * 很可能已经批过了（或已过期），拿它当门面等于让横幅撒谎。
       */
      const grantEvents = external.filter((e) => e.type === 'grant')
      const grantEvent = grantEvents[grantEvents.length - 1]
      if (grantEvent && this.onGrantRequest) {
        const p = (grantEvent.payload ?? {}) as Record<string, unknown>
        try {
          this.onGrantRequest({
            grantId: String(p.grantId ?? ''),
            agentId: String(p.agentId ?? ''),
            scope: String(p.scope ?? ''),
            command: p.command == null ? null : String(p.command),
            summary: p.summary == null ? null : String(p.summary)
          })
        } catch (err) {
          // 弹横幅失败不该连累数据刷新
          console.error(
            '[ChangeBroadcast] 授权提醒弹出失败:',
            err instanceof Error ? err.message : String(err)
          )
        }
      }

      /**
       * 新 agent 接入（1.0.63）
       *
       * 与授权申请同样的取最新逻辑，不重复解释。差别在**去重**：
       * 一个身份只会有一条"刚注册"通知（重复注册不发，见 commands.ts），
       * 但它很可能跟一条 grant 事件**同批**返回（agent 注册完顺手申请授权）——
       * 两种通知各弹各的会互相盖掉，所以同一批里**优先弹申请**：
       * 申请是"它现在卡着"，注册是"它已经到了"，前者更急。
       *
       * 被盖掉的那条不算丢：它本来就同时体现在用户页/审批页的
       * 「待批准身份」上，横幅只是"来告诉你"的那一下。
       */
      const registerEvents = external.filter((e) => e.type === 'agent_register')
      const registerEvent = registerEvents[registerEvents.length - 1]
      if (!grantEvent && registerEvent && this.onAgentRegistered) {
        const p = (registerEvent.payload ?? {}) as Record<string, unknown>
        try {
          this.onAgentRegistered({
            agentId: String(p.agentId ?? ''),
            displayName: p.displayName == null ? '' : String(p.displayName)
          })
        } catch (err) {
          // 弹横幅失败不该连累数据刷新
          console.error(
            '[ChangeBroadcast] 新 agent 提醒弹出失败:',
            err instanceof Error ? err.message : String(err)
          )
        }
      }

      // 界面只需要知道"该重新拉一次了"，不需要逐条事件，
      // 所以按类型合并后各发一条即可
      const types = new Set(external.map((e) => e.type))
      for (const type of types) {
        const payload = { type }
        for (const win of Object.values(this.getWindows())) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('event:dataChanged', payload)
          }
        }
      }
    } catch (err) {
      // 广播失败绝不能影响主流程
      console.error(
        '[ChangeBroadcast] 轮询失败:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
