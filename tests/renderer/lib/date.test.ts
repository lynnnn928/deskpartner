import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'
import { formatDate, formatRemindTime, timeFromNow, timeAgo, isExpired, nowISO } from '../../../src/renderer/lib/date'

describe('date utils', () => {
  describe('formatDate()', () => {
    it('should return empty string for null', () => {
      expect(formatDate(null)).toBe('')
    })

    it('should show only HH:mm for today', () => {
      const today = dayjs().format('YYYY-MM-DDTHH:mm:ss')
      const result = formatDate(today)
      expect(result).toMatch(/^\d{2}:\d{2}$/)
    })

    it('should show "昨天 HH:mm" for yesterday', () => {
      const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DDTHH:mm:ss')
      const result = formatDate(yesterday)
      expect(result).toMatch(/^昨天 \d{2}:\d{2}$/)
    })

    it('should show M/D HH:mm for this year', () => {
      // Use a date earlier this year but not today/yesterday
      const date = dayjs().month(0).date(1).hour(9).minute(30).format('YYYY-MM-DDTHH:mm:ss')
      const result = formatDate(date)
      expect(result).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/)
    })

    it('should show YYYY/M/D HH:mm for other year', () => {
      const pastYear = dayjs().subtract(2, 'year').format('YYYY-MM-DDTHH:mm:ss')
      const result = formatDate(pastYear)
      expect(result).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}$/)
    })
  })

  describe('formatRemindTime()', () => {
    it('should return empty string for null', () => {
      expect(formatRemindTime(null)).toBe('')
    })

    it('should show "今天 HH:mm" for today', () => {
      const today = dayjs().format('YYYY-MM-DDTHH:mm:ss')
      const result = formatRemindTime(today)
      expect(result).toMatch(/^今天 \d{2}:\d{2}$/)
    })

    it('should show "明天 HH:mm" for tomorrow', () => {
      const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DDTHH:mm:ss')
      const result = formatRemindTime(tomorrow)
      expect(result).toMatch(/^明天 \d{2}:\d{2}$/)
    })

    it('should show "M月D日 HH:mm" for this year', () => {
      const date = dayjs().month(0).date(1).hour(9).minute(30).format('YYYY-MM-DDTHH:mm:ss')
      const result = formatRemindTime(date)
      expect(result).toMatch(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
    })

    it('should show "YYYY年M月D日 HH:mm" for other year', () => {
      const pastYear = dayjs().subtract(2, 'year').format('YYYY-MM-DDTHH:mm:ss')
      const result = formatRemindTime(pastYear)
      expect(result).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
    })
  })

  describe('timeFromNow()', () => {
    it('should return "已过期" for past time', () => {
      const past = dayjs().subtract(1, 'hour').toISOString()
      expect(timeFromNow(past)).toBe('已过期')
    })

    it('should return "1分钟后" for 1 minute from now', () => {
      const future = dayjs().add(1, 'minute').add(10, 'second').toISOString()
      expect(timeFromNow(future)).toBe('1分钟后')
    })

    it('should return "2小时后" for 2 hours from now', () => {
      const future = dayjs().add(2, 'hour').add(10, 'minute').toISOString()
      expect(timeFromNow(future)).toBe('2小时后')
    })

    it('should return "3天后" for 3 days from now', () => {
      const future = dayjs().add(3, 'day').add(2, 'hour').toISOString()
      expect(timeFromNow(future)).toBe('3天后')
    })
  })

  /**
   * timeAgo() —— 过去时刻的「多久之前」（1.0.55，修 13583005）
   *
   * 这组断言的由来：通知里的时间戳（createdAt）永远是**过去**的，
   * 而 `timeFromNow` 是面向未来的（`diffMin < 0` 时返回「已过期」），
   * 于是整列收件箱的时间全显示「已过期」。主用户驳回**两次**，
   * 因为第一次我给的是"文案说修了、函数根本不存在"的假修复。
   *
   * 所以这组测试的重点有两个：
   *   1. 过去时刻要给出可读的相对时间，**绝不能**出现「已过期」；
   *   2. 边界（刚刚 / 昨天 / 跨年）都要覆盖，避免"只对某一个年龄段的
   *      时间戳生效"这种半吊子修法又蒙过去。
   */
  describe('timeAgo()', () => {
    it('刚刚发生的应显示「刚刚」，且绝不含「已过期」', () => {
      const r = timeAgo(dayjs().subtract(10, 'second').toISOString())
      expect(r).toBe('刚刚')
      expect(r).not.toContain('已过期')
    })

    it('过去的分钟级时间戳应显示「N 分钟前」', () => {
      expect(timeAgo(dayjs().subtract(5, 'minute').toISOString())).toBe('5 分钟前')
    })

    it('过去的小时级时间戳应显示「N 小时前」', () => {
      expect(timeAgo(dayjs().subtract(3, 'hour').toISOString())).toBe('3 小时前')
    })

    it('昨天应带「昨天」前缀且保留时刻', () => {
      const r = timeAgo(dayjs().subtract(1, 'day').toISOString())
      expect(r).toMatch(/^昨天 \d{2}:\d{2}$/)
    })

    it('更早但同年应显示「M月D日 HH:mm」', () => {
      const r = timeAgo(dayjs().subtract(3, 'month').toISOString())
      expect(r).toMatch(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
    })

    it('非法时间串返回空串，不抛错（防御脏数据）', () => {
      expect(timeAgo('not-a-date')).toBe('')
    })

    it('关键回归：任何年龄的过去时间戳都不得返回「已过期」', () => {
      // 这一条直接锁住主用户两次驳回的那个现象
      const ages = [
        dayjs().subtract(30, 'second'),
        dayjs().subtract(5, 'minute'),
        dayjs().subtract(3, 'hour'),
        dayjs().subtract(1, 'day'),
        dayjs().subtract(30, 'day'),
        dayjs().subtract(2, 'year')
      ]
      for (const d of ages) {
        expect(timeAgo(d.toISOString())).not.toContain('已过期')
      }
    })
  })

  describe('isExpired()', () => {
    it('should return false for null', () => {
      expect(isExpired(null)).toBe(false)
    })

    it('should return true for past time', () => {
      expect(isExpired(dayjs().subtract(1, 'hour').toISOString())).toBe(true)
    })

    it('should return false for future time', () => {
      expect(isExpired(dayjs().add(1, 'hour').toISOString())).toBe(false)
    })
  })

  describe('nowISO()', () => {
    it('should return a valid ISO string', () => {
      const result = nowISO()
      expect(new Date(result).toISOString()).toBe(result)
    })
  })
})
