/**
 * 错误码清单 —— 唯一真相（1.0.73，续做 `3c522bdb`）
 *
 * ## 为什么单开一份
 *
 * 与 `gates.ts` 同源的病：`errorCode` 是**调用方唯一能可靠分流的信号**
 * （数字退出码只有 0/1/2/3/4/5 六档，而"守卫拒绝"底下有七八种含义完全不同的事）。
 * 但它此前**只以字符串字面量散在 `commands.ts` 各处**，schema 里一个都没有 ——
 * 于是 agent 拿到 `identity_pending` 时，不知道这是"等批准"还是"去注册"，
 * 只能按字面猜。
 *
 * 与 GATES 一样，这里**不手写第二遍**：本文件是唯一定义处，
 * `schema.errorCodes` 渲染它。若某个 errorCode 在代码里用了却不在本清单里，
 * 由 `tests/main/cli/error-codes-single-source.test.ts` 的源码扫描当场拦下。
 *
 * ## 字段取舍
 *
 * - `retry`：**"重试这条命令有没有用"** —— 这是 agent 最需要知道的一件事，
 *   而且与 `fix` 一起才构成完整答案（重试无用 + 该做什么）。
 * - `exitCode`：与 `gates.ts` 里的同一档位一致。同一个 errorCode 在两处
 *   报出不同退出码，会让按退出码分流的脚本行为不一致。
 * - `fix`：**调用方真能执行的那一步**。不是"对我最方便的那一步" ——
 *   反面教材见 `ambiguous_identity`（1.0.73 才把 MCP 那条路补上）。
 */

import { ConflictError, GuardError, NotFoundError, UsageError } from '../lib/domain-errors'

export interface ErrorCodeSpec {
  /** 稳定代号（脚本按它分流，改动等于破坏契约） */
  code: string
  /** 一句话说清它是什么意思 */
  what: string
  /** 对应退出码（与 gates.ts 同档位） */
  exitCode: number
  /**
   * 重试**这条命令**有没有用
   *
   * - `false`：重试必然再撞同一件事，先换路或等人
   * - `true`：可以原地重试（比如等锁超时后重来）
   * - `'read'`：不是重试而是**重读**（乐观锁冲突：读别人的改动再决定）
   */
  retry: boolean | 'read'
  /** 调用方该做什么 */
  fix: string
}

export const ERROR_CODES: readonly ErrorCodeSpec[] = [
  {
    code: 'usage_error',
    what: '参数缺失、枚举非法、时间无法解析',
    exitCode: 2,
    retry: false,
    fix: '按报错里列出的支持参数改命令，再来一次'
  },
  {
    code: 'not_found',
    what: '目标 id / 名字没找到',
    exitCode: 3,
    retry: false,
    fix: '用 `todo list` 拿真实 id 整段复制（别手写前缀）；报错里通常已列出本机已有项'
  },
  {
    code: 'guard_blocked',
    what: '守卫拒绝（候选池规则，见 schema.gates）',
    exitCode: 4,
    retry: false,
    fix: '重试无用。按报错指的那条关口改做法，或等人操作（如 proposed 只能由人在界面上放行）'
  },
  {
    code: 'identity_required',
    what: '无人值守的写命令没声明身份，且本机只有一份凭据（本可自动带上）',
    exitCode: 4,
    retry: false,
    fix: '声明 `DESKPARTNER_AGENT=agent:<名字>`（或 MCP 写工具传 `actor`）后重试'
  },
  {
    code: 'identity_unregistered',
    what: '声明了 `agent:<名字>` 但该身份还没注册',
    exitCode: 3,
    retry: false,
    fix: '`agent register` → `agent credential` → 请用户在界面上批准（注册与领凭据都是自助的）'
  },
  {
    code: 'identity_pending',
    what: '身份已注册，但还没被批准写入',
    exitCode: 4,
    retry: false,
    fix: '**等**：注册那一刻界面已弹横幅提醒用户，不需要重试写命令、也不必重复注册'
  },
  {
    code: 'ambiguous_identity',
    what: '本机有多份 agent 凭据，而这次调用没声明身份',
    exitCode: 4,
    retry: false,
    fix: 'CLI：`export DESKPARTNER_AGENT=<候选之一>`；MCP：写工具传 `actor` 入参 —— 别让它替你猜'
  },
  {
    code: 'credential_missing',
    what: '该身份还没领凭据',
    exitCode: 4,
    retry: false,
    fix: '`agent credential --id <身份>` 领一份'
  },
  {
    code: 'credential_invalid',
    what: '凭据不存在或已失效',
    exitCode: 4,
    retry: false,
    fix: '重新 `agent credential --id <身份>` 领一份'
  },
  {
    code: 'grant_required',
    what: '这次操作落在「改界面 / 删除」档，需要单独授权',
    exitCode: 4,
    retry: false,
    fix: '**别绕、别改参数**：申请已落库，等用户在「审批」页点允许；批准即按申请执行，不要重试原命令'
  },
  {
    code: 'permission_denied',
    what: '协作规则权限矩阵禁止当前身份执行该动作',
    exitCode: 4,
    retry: false,
    fix: '请让主用户在「用户与团队 → 协作规则配置」中调整该动作的权限，或改用允许的协作流程'
  },
  {
    code: 'approval_required',
    what: '该动作需要通过审批流程提交，不能直接写入',
    exitCode: 4,
    retry: false,
    fix: '使用对应的 propose 命令提交提议，等待主用户在「审批」页处理后再读取结果'
  },
  {
    code: 'conflict',
    what: '乐观锁冲突：你要改的这条，在你读到它之后被别人改过（什么都没写入）',
    exitCode: 5,
    retry: 'read',
    fix: '重新 `todo get <id>` 看一遍改动，再决定要不要带上新的 updatedAt 重做。**不要盲重试**'
  },
  {
    code: 'batch_all_failed',
    what: 'batch 里每一行都失败了',
    exitCode: 1,
    retry: false,
    fix: '逐条读 `results[i].ok` 与 `errorCode` 定位；部分成功时整体退出码是 0，别只看它'
  },
  {
    code: 'error',
    what: '其余未分类错误（数据层异常等）',
    exitCode: 1,
    retry: false,
    fix: '看 message 原文；不确定是否已写入时**不要重试**（可能重复写）'
  }
]

/** 按代号取一条，供文案与测试引用（避免各处硬写字符串） */
export function errorCodeById(code: string): ErrorCodeSpec | undefined {
  return ERROR_CODES.find((e) => e.code === code)
}

/**
 * 把抛出的错误按**类型**归成 `{ errorCode, exitCode }` —— 出口层唯一一处分类判定。
 *
 * ## 为什么要有这一处（1.0.110，收 `7a6ac97e`）
 *
 * 分类原先只写在 `executeOne` 的 catch 里，于是**只有走命令执行那条路的错误**才有分类。
 * 启动器自己抛的错（`--desc-file` 指了个不存在的文件、`dp skill` 主题写错）
 * 落到 `main().catch`，那里无条件写 `code: 'error'` + exit 1 ——
 * 调用方看不出"我参数写错了"还是"环境坏了"，而这两件事该做的事**完全相反**
 * （改命令 / 换台机器）。同一个"参数写错"，在无头通道是 exit 2、在启动器出口是 exit 1，
 * 两条通道还互不一致。
 *
 * 判据：**分类只有一个出处** —— 这里。出口（`executeOne` 的 catch、启动器的 catch）
 * 只负责把分类结果放进各自信封的形状里。
 *
 * ⚠️ 认类型不认文案：`err instanceof X` 说的是抛出点**声明**了什么；
 * 提示文案、语言、关口编号都只供人阅读（见 `domain-error-classification` 用例）。
 * ⚠️ 那四个类必须**值导入**（不是 `import type`）：`import type` 编译后会被抹掉，
 * 这里会在运行时报 `X is not defined`。
 */
export function classifyError(err: unknown): { errorCode: string; exitCode: number } {
  const errorCode =
    err instanceof UsageError
      ? 'usage_error'
      : err instanceof ConflictError
        ? 'conflict'
        : err instanceof NotFoundError
          ? 'not_found'
          : err instanceof GuardError
            ? 'guard_blocked'
            : 'error'
  /**
   * 退出码取自错误码清单（`errorCodeById`）而不是另写一张表：
   * 同一个 errorCode 在两处报出不同退出码，会让"按退出码分流"和
   * "按错误码分流"的两拨脚本行为不一致（`error-codes-single-source` 用例盯着）。
   */
  return { errorCode, exitCode: errorCodeById(errorCode)?.exitCode ?? 1 }
}

/**
 * 渲染成说明书里那张错误码表（人读）—— 9d0df867。
 *
 * 存在的意义与 `gates.ts` 的 `renderGatesTable` 同源：**让说明书不再手写这张表**。
 * 手写那份只剩 `2`/`3`/`4` 三行，而清单里退出码 1 与 5 早有定义 ——
 * 漂移不会报错，只会让 agent 拿着过期情报决定"重试还是换路"。
 *
 * 行 = 清单条目本身：`code` 是调用方分流用的稳定代号，必须进表 ——
 * 没有它，agent 拿到 `{"code": "conflict"}` 对不上表里任何一行。
 *
 * ⚠️ `escapeBackticks` 与 `renderGatesTable` 同款开关。
 * 说明书这两处（错误码表、尾部退出码行）原文用的是**裸反引号**，
 * 所以调用处不传它；留着开关是为了将来口径要一起改时不用动接口。
 */
export function renderErrorCodesTable(options: { escapeBackticks?: boolean } = {}): string {
  const esc = (s: string): string => (options.escapeBackticks ? s.replace(/`/g, '\\`') : s)
  const lines: string[] = [
    '| 退出码 | errorCode | 含义 | 该做什么 |',
    '| --- | --- | --- | --- |'
  ]
  for (const e of ERROR_CODES) {
    lines.push(`| \`${e.exitCode}\` | \`${e.code}\` | ${e.what} | ${e.fix} |`)
  }
  return esc(lines.join('\n'))
}

/**
 * 每档退出码的速查标签（尾部自检行用）。
 *
 * ⚠️ 这里**只许是文案**（每档一句话的摘要）；**档位集合不许在这手写** ——
 * 集合由 `renderExitCodesLine` 从 `ERROR_CODES` 派生。
 * 手写集合就是第二份真相：上一版说明书尾部列到 `4` 为止，
 * 而 `conflict`（5）1.0.73 进清单后没人记得补它。
 * 新增退出码没写标签时，渲染回退成该档各条 `what` 的拼接 —— 宁可啰嗦，不许缺档。
 */
const EXIT_CODE_SUMMARY: Readonly<Record<number, string>> = {
  0: '成功',
  1: '一般错误',
  2: '用法错误',
  3: '目标不存在',
  4: '守卫拒绝（G1/G2/G4/G6 候选池规则，重试无用，需等用户操作或改用合法路径）',
  5: '乐观锁冲突（先重读再决定，别盲重试）'
}

/** 尾部自检行：`退出码：0 成功 / 1 … / 5 …`（档位集合来自 ERROR_CODES，9d0df867） */
export function renderExitCodesLine(options: { escapeBackticks?: boolean } = {}): string {
  const esc = (s: string): string => (options.escapeBackticks ? s.replace(/`/g, '\\`') : s)
  const codes = [...new Set([0, ...ERROR_CODES.map((e) => e.exitCode)])].sort((a, b) => a - b)
  const segs = codes.map((n) => {
    const label =
      EXIT_CODE_SUMMARY[n] ??
      ERROR_CODES.filter((e) => e.exitCode === n)
        .map((e) => e.what)
        .join('；')
    return `\`${n}\` ${label}`
  })
  return esc(`退出码：${segs.join(' / ')}。`)
}

/**
 * 启动器自己抛错时的失败信封（`main().catch` 用）—— 与两条通道**同一个分类口径**。
 *
 * ## 为什么放在这里，而不是 launcher.ts
 *
 * ① 启动器是 esbuild 单独打的包、**不在任何 tsconfig 的 include 里**
 *    （本仓只靠源码扫描用例看着它）—— 放进去就等于这条形状没人类型检查；
 * ② 信封形状与错误码是同一件事的两面，分两处写必然漂：一条通道改了码、
 *    另一条没跟上，调用方按码分流时行为不一致。
 *
 * ## 形状
 *
 * 非 TTY 给 JSON 信封（`code` 是**字符串**错误码，与 CLI 失败信封同名同义）；
 * TTY 给人读的一行。退出码由分类给 —— `--desc-file` 读不到文件这类
 * **参数写错**从此是 `usage_error` / 2，而 `error` / 1 只留给"真的预期外"。
 */
export function formatUncaughtFailure(
  err: unknown,
  tty: boolean
): { stdout: string; stderr: string; exitCode: number } {
  const message = err instanceof Error ? err.message : String(err)
  const { errorCode, exitCode } = classifyError(err)
  return tty
    ? { stdout: '', stderr: `错误: ${message}\n`, exitCode }
    : {
        stdout: JSON.stringify({ ok: false, code: errorCode, message }, null, 2) + '\n',
        stderr: '',
        exitCode
      }
}
