/**
 * @module constants/audit
 * @description Centralized, immutable constants for the audit module.
 *
 * Exported objects are frozen (`Object.freeze`) and strictly typed (`as const`)
 * to prevent runtime modifications and guarantee type safety.
 */

/**
 * All valid audit action types.
 */
export const AUDIT_ACTIONS = Object.freeze({
  CONTRACT_CREATED: 'CONTRACT_CREATED',
  CONTRACT_UPDATED: 'CONTRACT_UPDATED',
  CONTRACT_CANCELLED: 'CONTRACT_CANCELLED',
  CONTRACT_COMPLETED: 'CONTRACT_COMPLETED',
  CONTRACT_DELETED: 'CONTRACT_DELETED',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_RELEASED: 'PAYMENT_RELEASED',
  PAYMENT_DISPUTED: 'PAYMENT_DISPUTED',
  REPUTATION_UPDATED: 'REPUTATION_UPDATED',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  AUTH_LOGIN: 'AUTH_LOGIN',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_LOCKOUT_TRIGGERED: 'AUTH_LOCKOUT_TRIGGERED',
  AUTH_LOCKOUT_RELEASED: 'AUTH_LOCKOUT_RELEASED',
  ADMIN_ACTION: 'ADMIN_ACTION',
  ENDPOINT_ACCESS: 'ENDPOINT_ACCESS',
  ENDPOINT_MUTATION: 'ENDPOINT_MUTATION',
  DEPLOYMENT_PROMOTED: 'DEPLOYMENT_PROMOTED',
  DEPLOYMENT_ROLLED_BACK: 'DEPLOYMENT_ROLLED_BACK',
  MILESTONES_CREATED: 'MILESTONES_CREATED',
  MILESTONES_UPDATED: 'MILESTONES_UPDATED',
  MILESTONES_DELETED: 'MILESTONES_DELETED',
  AUDIT_CREATED: 'AUDIT_CREATED',
  AUDIT_UPDATED: 'AUDIT_UPDATED',
  AUDIT_DELETED: 'AUDIT_DELETED',
} as const);

export type AuditActionType = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Ordered array of audit actions used for runtime schema validation.
 */
export const AUDIT_ACTIONS_LIST = Object.freeze(Object.values(AUDIT_ACTIONS)) as readonly [
  AuditActionType,
  ...AuditActionType[]
];

/**
 * Audit severity levels.
 */
export const AUDIT_SEVERITIES = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
} as const);

export type AuditSeverityType = (typeof AUDIT_SEVERITIES)[keyof typeof AUDIT_SEVERITIES];

/**
 * Ordered array of audit severities used for runtime schema validation.
 */
export const AUDIT_SEVERITIES_LIST = Object.freeze(Object.values(AUDIT_SEVERITIES)) as readonly [
  AuditSeverityType,
  ...AuditSeverityType[]
];

/**
 * Resource names targeted by audit logs.
 */
export const AUDIT_RESOURCES = Object.freeze({
  CONTRACT: 'contract',
  USER: 'user',
  PAYMENT: 'payment',
  AUTH: 'auth',
  DISPUTE: 'dispute',
  MILESTONES: 'milestones',
  REPUTATION: 'reputation',
  AUDIT_LOG: 'audit-log',
  ENDPOINT: 'endpoint',
  EXPORT: 'export',
} as const);

/**
 * Standard error and status messages emitted by the audit module.
 */
export const AUDIT_MESSAGES = Object.freeze({
  NOT_FOUND: 'Audit entry not found',
  NOT_FOUND_OR_DELETED: 'Audit entry not found or already deleted',
  NOT_FOUND_OR_NOT_SOFT_DELETED: 'Audit entry not found or not soft-deleted',
  INVALID_OFFSET: 'Invalid offset',
  INVALID_LIMIT: 'Invalid limit',
  INVALID_CURSOR_FORMAT: 'Invalid cursor format',
  INVALID_FROM_TIMESTAMP: 'Invalid from timestamp',
  INVALID_TO_TIMESTAMP: 'Invalid to timestamp',
  MISSING_REQUIRED_FIELDS: 'Missing required fields: action, severity, actor, resource, resourceId',
  VALIDATION_FAILED: 'Request validation failed',
  CANNOT_RESTORE_PAST_RETENTION: 'Cannot restore entry past retention window',
  REENTRANCY_DETECTED: 'AuditStore append re-entrancy detected',
  CURSOR_FILTERS_MISMATCH: 'Cursor filters do not match query filters',
} as const);

/**
 * Default constants used within the audit subsystem.
 */
export const AUDIT_DEFAULTS = Object.freeze({
  GENESIS_HASH: 'GENESIS',
  ANONYMOUS_ACTOR: 'anonymous',
  SYSTEM_ACTOR: 'system',
} as const);
