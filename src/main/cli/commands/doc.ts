/**
 * 文档出口（卡 `588d2d67`，选①）
 *
 * ## 它治的病
 *
 * 验收方（agent）判「无法判定」：`COLLABORATION.md` 这类**约定文件**落在仓库里，
 * 而 agent 的硬约束是读不到 D 盘仓库文件的 —— 产品出口（`dp skill` / `dp schema`）
 * 里又全文检索不到「COLLABORATION」四个字母。于是"这份文件到底写了什么"
 * 只有人能看，agent 只能跳过，而跳过就等于没验收。
 *
 * ## 为什么是"出口"而不是"并进说明书"
 *
 * 约定文件的设计初衷是**可编辑、改它不发版**（与硬关口分开）。并进 `dp skill`
 * 会把它绑回发版周期，初衷就没了；给它一条独立的只读出口，两件事都保住。
 *
 * ## 判据
 *
 * 1. `dp doc list` 能列出有哪些约定文件、多大、指纹多少 —— **不含正文**（一眼看全）；
 * 2. `dp doc show <name>` 给出正文与指纹，agent 拿指纹就能说"我核对的是这一份"；
 * 3. 文件不在（没打进包 / 路径不对）时**明说不在**，不返回空字符串装作读过。
 *
 * ⚠️ 出口只服务**打进包里的那一份**：验收方要核的是"交付出去的东西"，
 * 不是开发机上随手改过的副本。所以根目录优先取 `resources/app.asar`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { NotFoundError, UsageError } from '../../lib/domain-errors'
import type { CommandSpec } from '../command-core'

export type DocCategory = 'convention' | 'architecture' | 'review'

interface DocEntry {
  /** 命令里用的短名（给人打，`dp doc show collaboration`） */
  name: string
  /** 文档类别：约定 / 架构与映射 / 验收与盘点报告 */
  category: DocCategory
  /** 相对仓库根的路径 */
  file: string
  /** 一句话说明它是什么 */
  about: string
}

/**
 * 出口面清单 —— **要维护的就是这一张表**（卡上写明的代价）
 *
 * 每条都得真的打进包（`package.json` 的 `build.files`），否则 `available: false`。
 * 加条目时两处一起改，别只改这里。
 */
export const DOC_CATALOG: DocEntry[] = [
  {
    name: 'collaboration',
    category: 'convention',
    file: 'COLLABORATION.md',
    about: '协作约定：人能改、改它不发版；agent 验收时以它为准'
  },
  { name: 'issue-style', category: 'convention', file: 'ISSUE_STYLE.md', about: '事项怎么写：描述与往来的边界、四段收口' },
  { name: 'testing', category: 'convention', file: 'TESTING.md', about: '测试与验证怎么跑、什么算通过' },
  { name: 'design', category: 'convention', file: 'docs/DESIGN.md', about: '界面与设计令牌的判据' },
  { name: 'releases', category: 'convention', file: 'CHANGELOG.md', about: '版本更新日志（CHANGELOG）' },
  {
    name: 'gui-page-capability-map',
    category: 'architecture',
    file: 'docs/architecture/2026-10-28-gui-page-capability-map.md',
    about: 'GUI 16 页 ↔ Headless 已验证能力映射表（卡 3f6b66e1，逐页 C 编号出处）'
  },
  {
    name: 'headless-surface',
    category: 'architecture',
    file: 'docs/generated/headless-surface.md',
    about: 'Headless 表面清点（生成物）：CLI/MCP 命令、参数与风险档'
  }
]

/**
 * 文档根目录：**优先取打进包里的那一份**
 *
 * - `DESKPARTNER_DOC_ROOT`：仅可测性（用例指到仓库根，不依赖构建产物）；
 * - `process.resourcesPath/app.asar`：装好之后真正交付出去的那份；
 * - `app.getAppPath()`：dev 下 electron 的 app 根；
 * - `process.cwd()`：最后兜底。
 *
 * 取不到就是"没有"，由调用方明说"不可用"，**不猜、不返回空串**。
 */
function docRoot(): string {
  const override = process.env.DESKPARTNER_DOC_ROOT?.trim()
  if (override) return override
  const candidates: string[] = []
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) candidates.push(path.join(resources, 'app.asar'))
  try {
    // electron 只在主进程里有；用例里 require 不到，走 catch
    const req = eval('require') as NodeRequire
    const electron = req('electron') as { app?: { getAppPath?: () => string } }
    const p = electron?.app?.getAppPath?.()
    if (p) candidates.push(p)
  } catch {
    /* 非 Electron 环境 */
  }
  candidates.push(process.cwd())
  /**
   * ⚠️ 取**第一个真的在**的候选根，而不是"第一个候选"。
   *
   * 两条通道的 `resourcesPath` 都指得到，但 dev 下 `resources/app.asar` 并不存在
   * （那是打包产物），直接取第一个就会把"仓库里明明有这份文件"读成"不可用" ——
   * 一个必然假红的出口比没有出口更糟。存在与否是可测的事实，就按事实挑。
   */
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 路径不可达就当它不在 */
    }
  }
  return process.cwd()
}

function readDocFile(entry: DocEntry): { content: string; bytes: number; sha256: string } | null {
  const abs = path.join(docRoot(), entry.file)
  try {
    const buf = fs.readFileSync(abs)
    return {
      content: buf.toString('utf8'),
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex')
    }
  } catch {
    return null
  }
}

export const docCommands: CommandSpec[] = [
  {
    name: 'doc list',
    dataShape: 'array',
    readOnly: true,
    desc: '列出产品自带的约定文档，或指定项目关联本地文档目录下的 .md 文件（不含正文，一眼看全）',
    args: [
      {
        flag: '--project',
        type: 'string',
        desc: '项目名称或 id 前缀：列出该项目关联本地文档目录下的 .md 文件（不传则列产品自带约定文档）'
      }
    ],
    run: (ctx, flags) => {
      if (flags['--project'] !== undefined) {
        const rawProject = String(flags['--project']).trim()
        if (!rawProject) throw new UsageError('--project 不能为空')
        const res = ctx.deps.projectRepo.listProjectDocs(rawProject)
        return {
          __meta: {
            projectId: res.projectId,
            project: res.projectName,
            docsDir: res.docsDir,
            available: res.available,
            count: res.docs.length
          },
          data: res.docs
        }
      }
      const rows = DOC_CATALOG.map((e) => {
        const read = readDocFile(e)
        return {
          name: e.name,
          category: e.category,
          file: e.file,
          about: e.about,
          available: read !== null,
          bytes: read?.bytes ?? null,
          sha256: read?.sha256 ?? null
        }
      })
      const byCategory: Record<DocCategory, string[]> = {
        convention: [],
        review: [],
        architecture: []
      }
      for (const e of DOC_CATALOG) {
        byCategory[e.category].push(e.name)
      }
      const missing = rows.filter((r) => !r.available).map((r) => r.name)
      return {
        /**
         * `root` 是**读的是哪一份**：验收时要核的是"交付出去的那一份"，
         * 而同一台机器上仓库副本与包内副本可能不同 —— 不给根就没法解释差异。
         */
        __meta: {
          root: docRoot(),
          count: rows.length,
          availableCount: rows.length - missing.length,
          byCategory,
          ...(missing.length
            ? {
                missing,
                hint:
                  `这 ${missing.length} 份在 root 下找不到 —— 要么没打进包（\`package.json\` 的 build.files），` +
                  '要么读到的不是交付出去的那一份'
              }
            : {})
        },
        data: rows
      }
    }
  },
  {
    name: 'doc show',
    dataShape: 'object',
    readOnly: true,
    desc:
      '输出一份产品约定文档或指定项目关联文档目录中某篇 .md 的正文与指纹',
    args: [
      {
        flag: '--project',
        type: 'string',
        desc: '项目名称或 id 前缀：读取该项目关联文档目录下的 .md 文件（不传则读产品自带约定文档）'
      }
    ],
    positional: { name: 'name', required: true, desc: '文档短名或项目内相对路径，见 `dp doc list`' },
    run: (ctx, flags, positional) => {
      const name = (positional[0] ?? '').trim()
      if (flags['--project'] !== undefined) {
        const rawProject = String(flags['--project']).trim()
        if (!rawProject) throw new UsageError('--project 不能为空')
        return ctx.deps.projectRepo.readProjectDoc(rawProject, name)
      }
      if (!name) {
        throw new UsageError(
          `缺少文档名。可选：${DOC_CATALOG.map((e) => e.name).join('、')}（` + '`dp doc list` 看全）'
        )
      }
      const entry = DOC_CATALOG.find((e) => e.name === name || e.file === name)
      if (!entry) {
        throw new NotFoundError(
          `没有这份文档：${name}。可选：${DOC_CATALOG.map((e) => e.name).join('、')}`
        )
      }
      const read = readDocFile(entry)
      if (!read) {
        /**
         * 文件不在就明说"不在"：返回空串会让 agent 以为"这份文档是空的"，
         * 而它真正该做的是报"交付物缺失"—— 两种情况结论相反。
         */
        throw new NotFoundError(
          `文档 ${entry.name}（${entry.file}）不在这次交付里：读不到文件。` +
            `要么它没被打进包，要么这个安装不是从这里构建的 —— 请把它报成交付缺口，别当成"文档为空"。`
        )
      }
      return {
        name: entry.name,
        category: entry.category,
        file: entry.file,
        about: entry.about,
        bytes: read.bytes,
        sha256: read.sha256,
        content: read.content
      }
    }
  }
]
