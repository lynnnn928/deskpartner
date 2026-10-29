import React from 'react'

/** 未处理提醒红点 */
export const UnreadBadge: React.FC = () => {
  return (
    <div
      className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 border-2 border-white"
    />
  )
}
