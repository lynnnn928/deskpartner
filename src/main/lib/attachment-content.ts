import fs from 'node:fs'

/**
 * 附件**内容**读出来的口径（卡 `89f3b3bc`，1.0.146）
 *
 * 主用户 2026-11-12 把这一档要了回来：她挂上来的 bug 截图是给 agent 看的，
 * agent 读不到就等于白挂。这一层只回答"这份文件能不能当文本读、读出来是什么"，
 * 图片与其它二进制由调用方按 kind 分流 —— **不在这里猜**。
 *
 * 为什么要有两层判断（扩展名 + mime）：扩展名认不出但 mime 说是文本（`.log` 之外
 * 的日志、`.conf`）也该读；两边都不认就当二进制，宁可不给，也不要把二进制
 * 塞进上下文（乱码进模型是纯噪声，还占额度且收不回）。
 */

/**
 * 单次给出去的正文字符上限（64K 字符）
 *
 * 挑这个数不是为了"好看"：bug 日志、堆栈、一份 JSON 通常在这个量级以内；
 * 再上去读完也只剩噪声，而上下文额度是不可逆的。超了**截断并明说还剩多少**，
 * 让人/agent 知道"要看全得自己开文件"，而不是拿着半截正文当全文。
 */
export const MAX_TEXT_CHARS = 64_000

/** 扩展名白名单：认识的才当文本读 */
const TEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.md',
  '.markdown',
  '.json',
  '.ndjson',
  '.jsonl',
  '.csv',
  '.tsv',
  '.yml',
  '.yaml',
  '.xml',
  '.html',
  '.htm',
  '.ini',
  '.conf',
  '.env',
  '.sql',
  '.php',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.py',
  '.sh',
  '.bat',
  '.ps1'
])

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/x-ndjson'
])

/** 这份附件能不能当文本读（按扩展名 + mime 两个依据，见文件头） */
export function isTextContent(ext: string, mime: string): boolean {
  const e = ext.toLowerCase()
  if (TEXT_EXTS.has(e)) return true
  if (mime.startsWith('text/')) return true
  return TEXT_MIMES.has(mime)
}

export interface TextView {
  /** 给出去的正文（可能被截断） */
  text: string
  /** 给出去多少字符 */
  chars: number
  /** 文件一共多少字符 */
  totalChars: number
  truncated: boolean
}

/**
 * 读一份文本附件的正文
 *
 * file 必须是**已经挡住目录穿越**的绝对路径（`resolveRelPath` 之后），
 * 这里只做读。
 */
export function readTextView(absPath: string): TextView {
  const full = fs.readFileSync(absPath, 'utf8')
  const totalChars = full.length
  if (totalChars <= MAX_TEXT_CHARS) {
    return { text: full, chars: totalChars, totalChars, truncated: false }
  }
  return {
    text: full.slice(0, MAX_TEXT_CHARS),
    chars: MAX_TEXT_CHARS,
    totalChars,
    truncated: true
  }
}
