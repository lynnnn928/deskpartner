import React from 'react'

/** 空输入拦截提示 */
export const EmptyValidator: React.FC = () => {
  return (
    <p className="text-label text-red-400 mt-1">
      请输入要做的事项
    </p>
  )
}
