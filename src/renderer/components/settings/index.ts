export { Section, Row, Segmented } from './Section'
export { ColorField } from './ColorField'
export { ShortcutInput } from './ShortcutInput'

export { PresetSection } from './sections/PresetSection'
export { CategorySection } from './sections/CategorySection'
export { FloatBallSection } from './sections/FloatBallSection'
export { KanbanSection } from './sections/KanbanSection'
export { QuickAddSection } from './sections/QuickAddSection'
export { ColorSection } from './sections/ColorSection'
export { TypographySection } from './sections/TypographySection'
export { SystemSection } from './sections/SystemSection'
export { TelemetrySection } from './sections/TelemetrySection'
export { BackupSection } from './sections/BackupSection'
export { AgentAccessSection } from './sections/AgentAccessSection'
// AgentApprovalSection 于 1.0.60 拆分退役（主用户驳回 2ccc6fc6 的信息架构归位）：
//   权限账本 → components/user/AgentRosterSection.tsx（用户页）
//   待表态 + 审计流水 → components/approval/ApprovalView.tsx（审批页）
