/** 稳定的业务错误类型：调用方按类型分流，不依赖可变的提示文案。 */
export class GuardError extends Error {}
export class NotFoundError extends Error {}
export class UsageError extends Error {}
export class ConflictError extends Error {}
