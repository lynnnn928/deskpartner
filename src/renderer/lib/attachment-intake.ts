import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from './constants'
import type { PickedFile } from '../types/todo'

/**
 * 从剪贴板 / 文件对话框进来的东西，先收成一份"待挂清单"（卡 `fc11793f`）
 *
 * ── 为什么要单独一层 ──
 *
 * 同一个动作现在有两个落点：详情里的附件区（选完/粘完**立刻就挂**），和新建卡片
 * （事项还没有 id，"先留在这张卡上、保存时一起挂"）。两份实现会让"什么算图片、
 * 粘贴的图叫什么名字、超限怎么说"各写一遍 —— 这类分叉不报错，表现是同一个动作
 * 在两个地方表现不一样。所以分流只写在这里。
 *
 * ── 分流判据 ──
 *
 * - 资源管理器里复制来的文件**有真实路径**（`webUtils.getPathForFile`）→ 走"给路径"
 *   那条通道：不复制字节、保留原文件名；
 * - 剪贴板里的图片没有路径（它是内存字节）→ 走"传字节"那条，名字由界面命名；
 * - 其余（纯文字、非图片的剪贴板内容）**不收**，也不拦 —— 那不是附件。
 */

/** 一份待挂的东西：要么是一台机器上的路径，要么是内存里的字节 */
export type PendingAttachment =
  | {
      kind: 'path'
      path: string
      /** 显示用名字（原文件名） */
      name: string
      size: number
    }
  | {
      kind: 'bytes'
      /** 显示用名字（图片按「粘贴图片-<时间戳>」命名） */
      name: string
      bytes: Uint8Array
      size: number
    }

/** 收一份东西的结果：收下的 + 说不清的（超限、不支持的形状） */
export interface IntakeResult {
  items: PendingAttachment[]
  /** 已经是一句能给人看的话：哪一份、为什么没进清单 */
  problems: string[]
}

/**
 * 剪贴板里那份东西在磁盘上的真实路径
 *
 * 从资源管理器复制来的文件有路径，截图没有（它是内存字节）。渲染层里没有 preload 时
 * （单测、纯浏览器预览）拿不到，一律退化成空串 —— 分流照旧，只是都走"传字节"那条。
 */
export const pathForFile = (file: File): string => {
  try {
    const api = window.api as { getPathForFile?: (f: File) => string } | undefined
    return api?.getPathForFile?.(file) ?? ''
  } catch {
    return ''
  }
}

/** 剪贴板给的 mime → 扩展名；认不出按 png */
const PASTE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
}

/**
 * 粘贴图片的默认文件名
 *
 * 不叫 `image.png`：一次会话里挂几张截图，`image.png / image(1).png` 互相认不出，
 * 而时间戳至少对得上"什么时候截的"。扩展名跟着 mime 走 —— 落库时的 kind/mime 由扩展名
 * 决定，名字说错类型，图就按错的类型存进去。
 */
export const pastedImageName = (mime: string): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `粘贴图片-${stamp}${PASTE_EXT[mime] ?? '.png'}`
}

/** 给人看的大小文案（与主进程 `formatBytes` 同一口径，够看就行） */
export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 超限那句话（与主进程 `attachmentTooLargeReason` 逐字一致）
 *
 * 同一件事在"选完当场"与"提交之后"两个时刻说两个样，用户会以为是两回事 ——
 * 所以小数位都跟着主进程那份走（那是对外那句，仓库里已有用例钉着它）。
 */
const tooLarge = (size: number, name: string): string =>
  `附件超过 ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(1)} MB 上限（${formatSize(size)}）：${name}`

/**
 * 把一次粘贴/选择拿到的东西收成待挂清单
 *
 * **超限在收的时候就判**（数字来自共享常量，判据与主进程一致）：不然要等提交时
 * 才知道某一份太大，而那时事项已经建好了。
 */
export const intakeFiles = async (
  files: File[],
  /** 这张卡上**已经**占了多少（新建卡片把待挂清单的合计递进来）；不给 = 只判单份 */
  opts: { usedBytes?: number } = {}
): Promise<IntakeResult> => {
  const items: PendingAttachment[] = []
  const problems: string[] = []
  let used = opts.usedBytes ?? 0

  for (const file of files) {
    const path = pathForFile(file)
    if (path) {
      /**
       * 资源管理器复制来的文件：`size` 剪贴板给得到，给不到就是 0
       *
       * 给不到时既显示成 0 B、也少算一份的余量 —— 两个都只是"当场那句提示"的精度问题，
       * 落盘那一刻主进程拿真实 `stat.size` 再判一次才是权威。
       */
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(tooLarge(file.size, file.name))
        continue
      }
      if (used + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        problems.push(totalTooLargeReason(used, file.size, file.name))
        continue
      }
      used += file.size
      items.push({ kind: 'path', path, name: file.name || path.split(/[\\/]/).pop() || path, size: file.size })
      continue
    }
    if (!file.type.startsWith('image/')) continue
    const name = pastedImageName(file.type)
    /**
     * 先按声明的大小判，**再读字节**
     *
     * 一个 200MB 的粘贴不该先把整段读进内存才发现超限。`File.size` 就是字节数
     * （剪贴板给的 blob 自带），判据与主进程同一份常量。
     */
    if (file.size > MAX_ATTACHMENT_BYTES) {
      problems.push(tooLarge(file.size, name))
      continue
    }
    if (used + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      problems.push(totalTooLargeReason(used, file.size, name))
      continue
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!bytes.length) {
      problems.push(`${name}：这份内容没有字节（空的粘贴内容）`)
      continue
    }
    used += bytes.length
    items.push({ kind: 'bytes', name, bytes, size: bytes.length })
  }

  return { items, problems }
}

/**
 * 把"挑了但还没挂"的实况按余量筛一遍（文件对话框那条路：字节不经过渲染层）
 *
 * 与 `intakeFiles` 同一条判据，只是进来的形状不同：那边是 `File`（要读字节、要认图片），
 * 这边是主进程回的实况（已经有路径、有大小、有"为什么不能挂"）。
 */
export const fitPickedFiles = (picked: PickedFile[], usedBytes = 0): IntakeResult => {
  const items: PendingAttachment[] = []
  const problems: string[] = []
  let used = usedBytes

  for (const p of picked) {
    if (p.problem) {
      problems.push(p.problem)
      continue
    }
    if (used + p.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      problems.push(totalTooLargeReason(used, p.size, p.name))
      continue
    }
    used += p.size
    items.push({ kind: 'path', path: p.path, name: p.name, size: p.size })
  }

  return { items, problems }
}

/** 待挂清单的合计体积（算余量与界面上那句"共多少"都走它） */
export const pendingTotalBytes = (items: PendingAttachment[]): number =>
  items.reduce((n, item) => n + item.size, 0)

/**
 * 待挂清单**总量**超标那句话（与主进程 `attachmentTotalTooLargeReason` 同一个意思）
 *
 * 这里主语是"待挂的"，因为此刻它们确实还没挂上（界面上那句"保存时一起挂上"同理）；
 * 主进程在落盘那一刻还会再说一次 —— 那一次才是权威。
 */
export const totalTooLargeReason = (used: number, incoming: number, name: string): string => {
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
  return (
    `待挂的附件总量超过 ${mb(MAX_ATTACHMENT_TOTAL_BYTES)} MB 上限` +
    `（已有 ${mb(used)} MB，加这一份会到 ${mb(used + incoming)} MB）：${name}`
  )
}

/** 失败信息里只报文件名，整条路径太长会把那一行撑爆（与附件区同一口径） */
export const baseName = (p: string): string => p.split(/[\\/]/).pop() || p
