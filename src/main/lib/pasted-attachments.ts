import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_ATTACHMENT_BYTES,
  attachmentTooLargeReason,
  safeAttachmentName
} from './attachments'
import type { TodoAttachment } from '../database/attachment.repository'

/**
 * 粘贴进来的附件（卡 `cce88967`）
 *
 * ── 它解决什么 ──
 *
 * 附件原来的唯一入口是系统文件对话框：想把一张截图挂到卡上，得先在别处存成文件、
 * 再在对话框里翻到它 —— 最常见的那次操作要走三步。
 *
 * ── 为什么不另写一套入库 ──
 *
 * `AttachmentRepository.add` 收的是**路径**（复制进数据目录、算 sha256、按扩展名认
 * mime/kind 都在那条路上）。剪贴板里的图片只有内存字节，所以这里的做法是：把字节落成
 * 数据目录下的一个临时文件，再走 add。用字节另写一条入库逻辑，等于把"什么算图片、
 * 存哪儿、怎么算 hash"复制成两份，迟早分叉。
 *
 * ── 临时文件放哪儿、什么时候没 ──
 *
 * 写在 `<数据目录>/tmp/`（**在数据目录内**：同一卷上复制才是真的复制，备份也跟着走），
 * 落地后立刻删，**失败也删**（`finally`）—— 磁盘上不留谁也认不出的残片。
 * 文件名就是给人看的那个名字：add 拿它当附件名（`<数据目录>/attachments/` 里落的是
 * `<id><ext>`，名字只用于显示），所以"粘贴图片-20261112-131500.png"这个名字才留得住。
 *
 * 纯文件层，不 import electron：单测跑在 node 下（与 attachments.ts 同源）。
 */

/** 粘贴内容暂存在数据目录下的这个子目录里（用完即删） */
export const PASTE_TMP_DIR = 'tmp'

export interface PastedBytes {
  /** 显示用名字（图片由界面命名成「粘贴图片-<时间戳>.png」） */
  name: string
  bytes: Uint8Array
}

/** 认得出 add 的仓储就够 —— 结构化类型，单测可以塞个替身 */
export interface AttachmentAdder {
  add(input: {
    todoId: string
    paths: string[]
    actor: string
  }): {
    added: TodoAttachment[]
    failed: Array<{ path: string; reason: string }>
  }
}

export interface PasteResult {
  added: TodoAttachment[]
  /** 失败按**粘贴进来的名字**报，而不是临时文件路径 —— 那个路径对人没有意义 */
  failed: Array<{ name: string; reason: string }>
}

export function addPastedAttachments(opts: {
  todoId: string
  files: PastedBytes[]
  dataDir: string
  repo: AttachmentAdder
}): PasteResult {
  const { todoId, files, dataDir, repo } = opts
  const added: TodoAttachment[] = []
  const failed: Array<{ name: string; reason: string }> = []

  const tmpDir = path.join(dataDir, PASTE_TMP_DIR)

  for (const file of files) {
    // 名字只用来显示，但这里是**磁盘上的文件名**，所以同样要净化（去掉分隔符/控制字符）
    const name = safeAttachmentName(file.name)
    const bytes = Buffer.from(file.bytes ?? [])
    if (!bytes.length) {
      failed.push({ name, reason: '这份内容没有字节（空的粘贴内容）' })
      continue
    }
    /**
     * 上限在落临时文件**之前**判
     *
     * 写一个注定被拒的文件纯属白费磁盘 —— 而 storeAttachmentFile 里那道预检
     * 是"复制之前"，到那时临时文件已经写完了。措辞用同一个函数，两处说的是同一句话。
     */
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      failed.push({ name, reason: attachmentTooLargeReason(bytes.length, name) })
      continue
    }

    fs.mkdirSync(tmpDir, { recursive: true })
    const tmp = path.join(tmpDir, name)
    try {
      fs.writeFileSync(tmp, bytes)
      const res = repo.add({ todoId, paths: [tmp], actor: 'human' })
      for (const item of res.added) added.push(item)
      // add 是逐个文件独立成败的：它说哪份失败，就按哪个名字往上报
      for (const bad of res.failed) failed.push({ name, reason: bad.reason })
    } finally {
      /**
       * 临时文件必须走，**包括 repo.add 抛错的时候**
       *
       * 所以这里是 finally 而不是"成功分支里删一次"：事项不存在这类错误会直接抛出来，
       * 那正是最该把残片收掉的时候。清理本身失败也只当占地方 —— 别让清理的动作
       * 盖住真正的错。
       */
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 删不掉就留着，不是这次失败的原因 */
      }
    }
  }

  return { added, failed }
}
