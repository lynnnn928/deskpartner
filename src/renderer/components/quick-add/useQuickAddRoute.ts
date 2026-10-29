import React from 'react'

export interface QuickAddRoute {
  /** 编辑模式：已有待办的 id。新增模式为 null */
  todoId: string | null
  /** 新增模式从哪一列进来（决定初始状态） */
  status: string | null
  /** 新增模式明确指定的项目；编辑模式忽略该参数 */
  projectId: string | null
  /** 项目搜索评论命中时，详情抽屉应展开并定位的评论 */
  commentId: string | null
}

/**
 * 读弹窗的路由参数（hash 上的 query）
 *
 * 为什么不能 `useMemo` 只在挂载时算一次：
 * `loadURL` 只改 hash 时 Chromium 走**同文档导航**，不重新加载 JS、组件也不重挂载。
 * 于是挂载时算一次就永远停在旧模式，表现是"双击卡片却弹出新增待办"。
 * 必须听 hashchange。
 *
 * 抽成 hook 是因为**外壳和表单都要知道当前是新增还是编辑**：
 * 外壳据此决定用居中卡片还是右侧抽屉，表单据此决定填充还是重置。
 * 两边各读一次的话，迟早会出现"外壳是抽屉、表单却以为是新增"。
 */
export function useQuickAddRoute(): QuickAddRoute {
  const [route, setRoute] = React.useState<QuickAddRoute>(() => readRoute())

  React.useEffect(() => {
    const onHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return route
}

function readRoute(): QuickAddRoute {
  const p = new URLSearchParams(window.location.hash.split('?')[1] || '')
  return {
    todoId: p.get('todoId'),
    status: p.get('status'),
    projectId: p.get('projectId'),
    commentId: p.get('commentId')
  }
}
