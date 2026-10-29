import React from 'react'
import { PanelContent } from '../components/panel/PanelContent'

/**
 * 悬浮面板窗口入口
 *
 * 与 QuickAdd 一样不加压暗遮罩：本窗口自身透明，背后是桌面而不是内容，
 * 加遮罩只会变成桌面上悬着的一块黑方块。
 */
const Panel: React.FC = () => {
  return (
    <div className="w-screen h-screen p-1">
      <div className="h-full">
        <PanelContent />
      </div>
    </div>
  )
}

export default Panel
