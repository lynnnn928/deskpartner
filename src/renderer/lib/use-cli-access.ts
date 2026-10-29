import { useEffect, useState } from 'react'
import { invoke } from './ipc-client'
import type { CliAccess } from './onboarding-prompts'

/**
 * 取本机真实接入地址（1.0.132，卡 `25caac02`）
 *
 * 开场提示词要把入口写进正文，否则没接过 DeskPartner 的 agent 第一步就是
 * `dp: command not found` —— 产品从 1.0.55 起不写用户 PATH（`2cc71a13`），
 * 而过去的提示词只写「运行 dp skill」，等于假设入口已经配好。
 *
 * 取不到（IPC 失败、主进程还没起好）时返回 null：模板会退成不含绝对路径的
 * 通用说法。**不要在这里编路径** —— 编错比不给更糟，对方会照着跑然后报"找不到文件"。
 */
export function useCliAccess(): CliAccess | null {
  const [access, setAccess] = useState<CliAccess | null>(null)

  useEffect(() => {
    let alive = true
    try {
      // `Promise.resolve` 兜一层：单测里 invoke 的桩可能直接返回普通值或 undefined
      void Promise.resolve(invoke('cli:connectInfo'))
        .then((info) => {
          if (alive) setAccess(info ?? null)
        })
        .catch(() => undefined)
    } catch {
      /* 旧主进程没有这个通道：留在 null，提示词退成通用说法 */
    }
    return () => {
      alive = false
    }
  }, [])

  return access
}
