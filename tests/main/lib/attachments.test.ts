import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  classifyByName,
  extOf,
  formatBytes,
  resolveRelPath,
  safeAttachmentName,
  ATTACHMENTS_DIR
} from '../../../src/main/lib/attachments'

/**
 * 附件文件层（schema v50）
 *
 * 这里钉的是**判据**，不是实现：扩展名怎么认、名字怎么净化、路径怎么挡穿越。
 * 真正的复制/删除走 attachment.repository.test.ts。
 */
describe('附件文件层', () => {
  it('扩展名：小写、带点；不正常的扩展名一律当没有', () => {
    expect(extOf('截图.PNG')).toBe('.png')
    expect(extOf('打包.tar.gz')).toBe('.gz')
    expect(extOf('README')).toBe('')
    expect(extOf('怪名字.abcdefghijk')).toBe('')
    expect(extOf('点结尾.')).toBe('')
  })

  it('按扩展名分类：认得的图片是 image，其余是 file 且带一个像样的 mime', () => {
    expect(classifyByName('a.png')).toEqual({ kind: 'image', mime: 'image/png' })
    expect(classifyByName('a.JPG')).toEqual({ kind: 'image', mime: 'image/jpeg' })
    expect(classifyByName('日志.log')).toEqual({ kind: 'file', mime: 'text/plain' })
    expect(classifyByName('交付.pdf').mime).toBe('application/pdf')
    // 认不出也必须是 file，而不是抛错 —— 附件要能挂"任何"文件
    expect(classifyByName('神秘文件.zzz')).toEqual({
      kind: 'file',
      mime: 'application/octet-stream'
    })
  })

  it('文件名净化：去掉路径分隔符与控制字符，空名给个占位', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(safeAttachmentName('a\\b\\c.txt')).toBe('a_b_c.txt')
    expect(safeAttachmentName('带\u0000空\u001f字符.txt')).toBe('带空字符.txt')
    expect(safeAttachmentName('   ')).toBe('未命名文件')
    expect(safeAttachmentName('超长'.repeat(200)).length).toBeLessThanOrEqual(120)
  })

  it('相对路径解析：正常拼在数据目录下，越界一律拒绝', () => {
    // 用 path.resolve 对齐：\data 这种"驱动器相对"路径会被解析成 D:\data
    const dataDir = path.resolve(path.join(path.sep, 'data'))
    expect(resolveRelPath(dataDir, `${ATTACHMENTS_DIR}/t1/a.png`)).toBe(
      path.join(dataDir, ATTACHMENTS_DIR, 't1', 'a.png')
    )
    expect(() => resolveRelPath(dataDir, '../../secret.txt')).toThrow(/越过了数据目录/)
    expect(() => resolveRelPath(dataDir, '..\\..\\secret.txt')).toThrow(/越过了数据目录/)
  })

  it('大小文案：B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
