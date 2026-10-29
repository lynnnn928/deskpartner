import dayjs from 'dayjs'

/** 格式化日期为友好显示 */
export function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = dayjs(dateStr)
  const now = dayjs()

  if (d.isSame(now, 'day')) return d.format('HH:mm')
  if (d.isSame(now.subtract(1, 'day'), 'day')) return `昨天 ${d.format('HH:mm')}`
  if (d.isSame(now, 'year')) return d.format('M/D HH:mm')
  return d.format('YYYY/M/D HH:mm')
}

/** 格式化提醒时间（更详细） */
export function formatRemindTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = dayjs(dateStr)
  const now = dayjs()

  if (d.isSame(now, 'day')) return `今天 ${d.format('HH:mm')}`
  if (d.isSame(now.add(1, 'day'), 'day')) return `明天 ${d.format('HH:mm')}`
  if (d.isSame(now, 'year')) return d.format('M月D日 HH:mm')
  return d.format('YYYY年M月D日 HH:mm')
}

/** 距离现在的时间描述 */
export function timeFromNow(dateStr: string): string {
  const d = dayjs(dateStr)
  const now = dayjs()
  const diffMin = d.diff(now, 'minute')

  if (diffMin < 0) return '已过期'
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟后`
  const diffHour = d.diff(now, 'hour')
  if (diffHour < 24) return `${diffHour}小时后`
  const diffDay = d.diff(now, 'day')
  return `${diffDay}天后`
}

/**
 * 过去时刻的「多久之前」描述（1.0.55，修 13583005）
 *
 * 为什么必须有它：`timeFromNow` 算的是「距离现在**还有**多久」，语义面向**未来**
 * （截止/提醒），`diffMin < 0` 时它返回「已过期」。而时间戳（通知的 createdAt、
 * 评论的 createdAt）永远是**过去**的 —— 用它就恒返回「已过期」，
 * 一整列收件箱的时间全部不可读，还让"待验收交付"这类通知看起来像失效了。
 *
 * 主用户实测驳回（两次）：通知里时间依然全部显示「已过期」。
 * 上一轮的描述写着"已用 timeAgo 修复"，但那个函数根本不存在 ——
 * 文案先行、代码没落地。这次是真的落地。
 */
export function timeAgo(dateStr: string): string {
  const d = dayjs(dateStr)
  const now = dayjs()
  if (!d.isValid()) return ''
  const diffMin = now.diff(d, 'minute')

  if (diffMin < 0) return formatDate(dateStr) // 极端情况：时钟偏差导致"未来"，按绝对时间显示
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = now.diff(d, 'hour')
  if (diffHour < 24) return `${diffHour} 小时前`
  if (d.isSame(now.subtract(1, 'day'), 'day')) return `昨天 ${d.format('HH:mm')}`
  if (d.isSame(now, 'year')) return d.format('M月D日 HH:mm')
  return d.format('YYYY年M月D日')
}

/** 判断是否已过期 */
export function isExpired(dateStr: string | null): boolean {
  if (!dateStr) return false
  return dayjs(dateStr).isBefore(dayjs())
}

/**
 * 格式化截止时间
 *
 * 与提醒时间不同：逾期与否是用户最关心的信息，所以「今天 / 明天」用相对词，
 * 更远的用日期，让一眼能判断还剩多少余地。
 */
export function formatDueDate(dateStr: string): string {
  const d = dayjs(dateStr)
  const now = dayjs()

  if (d.isSame(now, 'day')) return `今天 ${d.format('HH:mm')}`
  if (d.isSame(now.add(1, 'day'), 'day')) return `明天 ${d.format('HH:mm')}`
  if (d.isSame(now, 'year')) return d.format('M月D日 HH:mm')
  return d.format('YYYY年M月D日 HH:mm')
}

/** 截止时间是否已逾期（是否已完成由调用方自行叠加判断） */
export function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false
  return dayjs(dateStr).isBefore(dayjs())
}

/** 获取当前 ISO 时间 */
export function nowISO(): string {
  return dayjs().toISOString()
}

/**
 * 时间线的日期分组标题
 *
 * 「今天 / 昨天」是回忆时真正会用的词，再往前才退化成日期。
 * 跨年的必须带年份 —— 否则"1月5日"会让人误以为是今年。
 */
export function formatDayHeading(dateStr: string): string {
  const d = dayjs(dateStr)
  const now = dayjs()

  if (d.isSame(now, 'day')) return '今天'
  if (d.isSame(now.subtract(1, 'day'), 'day')) return '昨天'
  if (d.isSame(now, 'year')) return d.format('M月D日')
  return d.format('YYYY年M月D日')
}

/** 只取时分，与日期标题配合使用（标题已经交代了是哪天） */
export function formatTimeOnly(dateStr: string): string {
  return dayjs(dateStr).format('HH:mm')
}

/** 日期分组用的键（YYYY-MM-DD），不能直接用 toISOString —— 那是 UTC，会跨天错位 */
export function dayKey(dateStr: string): string {
  return dayjs(dateStr).format('YYYY-MM-DD')
}
