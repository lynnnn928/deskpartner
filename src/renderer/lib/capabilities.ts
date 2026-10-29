/**
 * 能力对照表（1.0.100，M4）
 *
 * 把 PRD 7.1 的三端对照落成代码，供契约测试使用。
 * 每条能力声明：CLI 命令名、MCP 工具名、是否有 GUI 入口。
 *
 * 判据：CLI 命令表是唯一真相；MCP 工具名从 mcp-tools-from-schema 的
 * mcpToolName() 派生；GUI 入口只标注是否存在，不复制界面逻辑。
 * 三端对不上就让测试红 —— 不靠人记得去更新文档。
 */

export interface CapabilityRow {
  /** CLI 命令名（如 "todo add"） */
  cmd: string
  /** MCP 工具名；null 表示该命令不暴露给 MCP */
  mcp: string | null
  /** GUI 是否有对应入口 */
  gui: boolean
  /** 风险档位 */
  risk: 'read' | 'write' | 'config' | 'destructive'
  /** 备注（有意不同的原因等） */
  note?: string
}

/** MCP 不暴露的命令（与 mcp-tools-from-schema.ts 的 EXCLUDE 同源） */
export const MCP_EXCLUDED: readonly string[] = [
  'doctor',
  'schema',
  'help',
  'ui get',
  'ui set',
  'ui reset',
  'telemetry clear'
]

/**
 * 能力对照表。新命令必须在此登记，契约测试会核对：
 * 1. 命令在命令表里存在
 * 2. MCP 工具名与 mcpToolName() 一致
 * 3. MCP_EXCLUDED 里的命令 mcp 为 null，反之必有值
 */
export const CAPABILITIES: readonly CapabilityRow[] = [
  // ── 事项 ──
  { cmd: 'todo add', mcp: 'add_todo', gui: true, risk: 'write' },
  { cmd: 'todo get', mcp: 'get_todo', gui: true, risk: 'read' },
  { cmd: 'todo list', mcp: 'list_todos', gui: true, risk: 'read' },
  { cmd: 'todo update', mcp: 'update_todo', gui: true, risk: 'write' },
  { cmd: 'todo comment', mcp: 'comment_todo', gui: true, risk: 'write' },
  { cmd: 'todo reject', mcp: 'reject_todos', gui: true, risk: 'write' },
  { cmd: 'todo close', mcp: 'close_todos', gui: true, risk: 'write' },
  { cmd: 'todo done', mcp: 'done_todos', gui: true, risk: 'write' },
  { cmd: 'todo rm', mcp: 'rm_todos', gui: true, risk: 'destructive', note: '删除档需授权' },
  { cmd: 'todo pin', mcp: 'pin_todos', gui: true, risk: 'write' },
  { cmd: 'todo unpin', mcp: 'unpin_todos', gui: true, risk: 'write' },
  { cmd: 'todo inbox', mcp: 'inbox_todos', gui: true, risk: 'read' },
  { cmd: 'todo children', mcp: 'children_todos', gui: true, risk: 'read' },
  { cmd: 'todo history', mcp: 'history_todos', gui: true, risk: 'read' },
  { cmd: 'todo delete-comment', mcp: 'delete_comment_todos', gui: true, risk: 'destructive' },
  { cmd: 'todo set-owner', mcp: 'set_owner_todos', gui: true, risk: 'write' },
  { cmd: 'batch', mcp: 'batch', gui: true, risk: 'write', note: '批量执行 + 汇总回执' },

  // ── 项目 ──
  { cmd: 'project add', mcp: 'create_project', gui: true, risk: 'write' },
  { cmd: 'project get', mcp: 'get_project', gui: true, risk: 'read', note: '默认不返回事项清单' },
  { cmd: 'project list', mcp: 'list_projects', gui: true, risk: 'read' },
  { cmd: 'project search', mcp: 'search_project', gui: true, risk: 'read' },
  { cmd: 'project rm', mcp: 'rm_projects', gui: true, risk: 'destructive', note: '永久删除＝清空项目内全部数据；要留数据用 project archive' },
  { cmd: 'project archive', mcp: 'archive_projects', gui: true, risk: 'write', note: '可逆，只置标志位' },
  { cmd: 'project unarchive', mcp: 'unarchive_projects', gui: true, risk: 'write', note: '取消归档，恢复成新建候选' },
  { cmd: 'project handoff-update', mcp: 'update_handoff', gui: true, risk: 'write', note: '仅供主用户直接保存' },
  { cmd: 'project handoff-propose', mcp: 'propose_handoff', gui: true, risk: 'write', note: 'agent 提议走审批' },
  { cmd: 'project handoff-proposals', mcp: 'list_handoff_proposals', gui: true, risk: 'read' },
  { cmd: 'project handoff-history', mcp: 'list_handoff_revisions', gui: true, risk: 'read' },
  { cmd: 'project handoff-revision', mcp: 'get_handoff_revision', gui: true, risk: 'read' },
  { cmd: 'project handoff-rollback', mcp: 'rollback_handoff', gui: true, risk: 'write' },

  // ── 用户档案 / 协作协议 ──
  { cmd: 'profile get', mcp: 'get_profile', gui: true, risk: 'read' },
  { cmd: 'profile propose', mcp: 'propose_profile', gui: true, risk: 'write' },
  { cmd: 'profile proposals', mcp: 'list_profile_proposals', gui: true, risk: 'read' },
  { cmd: 'protocol get', mcp: 'get_protocol', gui: true, risk: 'read' },
  { cmd: 'protocol propose', mcp: 'propose_protocol', gui: true, risk: 'write' },
  { cmd: 'protocol proposals', mcp: 'list_protocol_proposals', gui: true, risk: 'read' },
  { cmd: 'rules get', mcp: 'get_rules', gui: true, risk: 'read' },
  { cmd: 'rules propose', mcp: 'propose_rules', gui: true, risk: 'write' },
  { cmd: 'rules proposals', mcp: 'list_rule_proposals', gui: true, risk: 'read' },

  // ── 身份与授权 ──
  { cmd: 'agent register', mcp: 'register_agents', gui: true, risk: 'write' },
  { cmd: 'agent credential', mcp: 'credential_agents', gui: true, risk: 'write' },
  { cmd: 'agent list', mcp: 'list_agents', gui: true, risk: 'read' },
  { cmd: 'agent whoami', mcp: 'whoami_agents', gui: true, risk: 'read' },
  { cmd: 'agent grants', mcp: 'grants_agents', gui: true, risk: 'read' },
  { cmd: 'agent revoke', mcp: 'revoke_agents', gui: true, risk: 'destructive' },

  // ── 版本 ──
  { cmd: 'release add', mcp: 'add_release', gui: true, risk: 'write' },
  { cmd: 'release list', mcp: 'list_release', gui: true, risk: 'read' },
  { cmd: 'release show', mcp: 'show_release', gui: true, risk: 'read' },
  { cmd: 'release update', mcp: 'update_release', gui: true, risk: 'write' },
  { cmd: 'release rm', mcp: 'rm_release', gui: true, risk: 'destructive' },

  // ── 分类 / 备忘 / 通知 ──
  { cmd: 'category add', mcp: 'add_categories', gui: true, risk: 'write' },
  { cmd: 'category list', mcp: 'list_categories', gui: true, risk: 'read' },
  { cmd: 'category merge', mcp: 'merge_categories', gui: true, risk: 'write' },
  { cmd: 'category rm', mcp: 'rm_categories', gui: true, risk: 'destructive' },
  { cmd: 'memo add', mcp: 'add_memos', gui: true, risk: 'write' },
  { cmd: 'memo list', mcp: 'list_memos', gui: true, risk: 'read' },
  { cmd: 'memo ack', mcp: 'ack_memos', gui: true, risk: 'write' },
  { cmd: 'memo rm', mcp: 'rm_memos', gui: true, risk: 'destructive' },
  { cmd: 'notification list', mcp: 'list_notifications', gui: true, risk: 'read' },

  // ── 使用数据 ──
  { cmd: 'telemetry stats', mcp: 'stats_telemetry', gui: true, risk: 'read' },
  { cmd: 'telemetry export', mcp: 'export_telemetry', gui: true, risk: 'read' },

  // ── 不暴露给 MCP ──
  { cmd: 'doctor', mcp: null, gui: true, risk: 'read', note: '人排障用，agent 用 whoami' },
  { cmd: 'skill', mcp: 'get_guide', gui: true, risk: 'read', note: '渐进式读取 Agent 接入说明' },
  { cmd: 'schema', mcp: null, gui: false, risk: 'read', note: '开发自检用' },
  { cmd: 'help', mcp: null, gui: false, risk: 'read' },
  { cmd: 'ui get', mcp: null, gui: true, risk: 'config', note: '改的是人的窗口配置' },
  { cmd: 'ui set', mcp: null, gui: true, risk: 'config' },
  { cmd: 'ui reset', mcp: null, gui: true, risk: 'config' },
  { cmd: 'telemetry clear', mcp: null, gui: true, risk: 'destructive', note: '不可逆，agent 没有需要清的理由' }
]
