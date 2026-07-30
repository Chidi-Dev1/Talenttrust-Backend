/**
 * @module modules/disputes/constants
 * @description Central registry of literal string constants used across the
 * disputes subsystem. Centralising these values prevents typo-driven bugs,
 * makes globally-consistent renames a one-line change, and gives TypeScript a
 * single source of truth for type narrowing.
 *
 * Usage:
 *   import { DISPUTE_STATUS, DISPUTE_ERRORS } from '../modules/disputes/constants';
 */

// ─── Dispute Status Values ────────────────────────────────────────────────────

/**
 * All valid dispute lifecycle statuses.
 * Used in the service state machine, DTOs, validation schemas, and the error
 * handler.
 */
export const DISPUTE_STATUS = {
  OPEN: 'open',
  UNDER_REVIEW: 'under_review',
  RESOLVED: 'resolved',
  ESCALATED: 'escalated',
  CANCELLED: 'cancelled',
} as const;

/** Union type derived from DISPUTE_STATUS values. */
export type DisputeStatusValue = (typeof DISPUTE_STATUS)[keyof typeof DISPUTE_STATUS];

// ─── Dispute Error Codes ──────────────────────────────────────────────────────

/**
 * Machine-readable error codes for disputes operations.
 * These are stable API-contract strings that clients may branch on.
 * Never rename or remove an existing code — only append new ones.
 */
export const DISPUTE_ERRORS = {
  NOT_FOUND: 'dispute_not_found',
  ALREADY_DELETED: 'dispute_already_deleted',
  NOT_DELETED: 'dispute_not_deleted',
  INVALID_STATE_TRANSITION: 'invalid_state_transition',
  INTERNAL_ERROR: 'internal_error',
} as const;

/** Union type derived from DISPUTE_ERRORS values. */
export type DisputeErrorCode = (typeof DISPUTE_ERRORS)[keyof typeof DISPUTE_ERRORS];

// ─── User-Facing Error Messages ───────────────────────────────────────────────

/**
 * Safe, user-facing messages keyed by error code.
 * These MUST NOT expose internal details (stack traces, DB queries, etc.).
 */
export const DISPUTE_ERROR_MESSAGES: Record<string, string> = {
  [DISPUTE_ERRORS.NOT_FOUND]: 'The requested dispute was not found',
  [DISPUTE_ERRORS.INVALID_STATE_TRANSITION]:
    'The requested state transition is not allowed',
  [DISPUTE_ERRORS.INTERNAL_ERROR]:
    'An unexpected error occurred while processing the dispute',
} as const;

// ─── Feature Flag Error ───────────────────────────────────────────────────────

/**
 * Error code and message returned when the disputes feature flag is disabled.
 */
export const DISPUTES_FEATURE_DISABLED_CODE = 'feature_disabled' as const;
export const DISPUTES_FEATURE_DISABLED_MESSAGE =
  'Disputes feature is currently disabled.' as const;

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * RBAC permission strings for disputes endpoints.
 * Used in route definitions and authorization middleware.
 */
export const DISPUTES_PERMISSIONS = {
  LIST: 'disputes:list',
  READ: 'disputes:read',
  CREATE: 'disputes:create',
  UPDATE: 'disputes:update',
  DELETE: 'disputes:delete',
} as const;

/** Union type derived from DISPUTES_PERMISSIONS values. */
export type DisputesPermission =
  (typeof DISPUTES_PERMISSIONS)[keyof typeof DISPUTES_PERMISSIONS];

// ─── Cache Keys ───────────────────────────────────────────────────────────────

/**
 * Cache key constants for the disputes SWR cache.
 */
export const DISPUTES_CACHE_KEYS = {
  /** Key for the full disputes list cache entry. */
  LIST: 'disputes:list',
  /**
   * Build a per-dispute cache key.
   * @param id - Dispute identifier
   */
  forDispute: (id: string): string => `disputes:${id}`,
} as const;

// ─── Metrics Names ────────────────────────────────────────────────────────────

/**
 * Prometheus metric names for disputes cache instrumentation.
 */
export const DISPUTES_METRICS = {
  CACHE_HITS_TOTAL: 'disputes_cache_hits_total',
  CACHE_MISSES_TOTAL: 'disputes_cache_misses_total',
} as const;

// ─── Log Prefixes ─────────────────────────────────────────────────────────────

/**
 * Structured log identifier for the DisputesService.
 * Use as the first segment of log messages to make log filtering easy.
 */
export const DISPUTES_LOG_PREFIX = '[DisputesService]' as const;

// ─── Seed / Demo Data ─────────────────────────────────────────────────────────

/**
 * IDs used by seedDemoDisputes() in DisputesService.
 * Kept here so tests that reference seed data use the same identifiers.
 */
export const DISPUTES_SEED = {
  DISPUTE_001_ID: 'dispute-001',
  DISPUTE_002_ID: 'dispute-002',
  CONTRACT_001_ID: 'contract-001',
  CONTRACT_002_ID: 'contract-002',
} as const;

// ─── Placeholder Credentials (demo only) ─────────────────────────────────────

/**
 * Demo placeholder values injected into EscrowHooks when the real request
 * context is unavailable.  These must never appear in production code paths.
 */
export const DISPUTES_DEMO_CONTEXT = {
  USER_EMAIL: 'admin@talenttrust.example',
  USER_ID: 'admin-id',
} as const;
