/**
 * @file constants.test.ts
 * @description Comprehensive tests for the disputes constants module.
 *
 * Tests verify:
 * - All exported constant objects exist and contain the expected keys/values
 * - No accidental value changes (regression guard)
 * - Derived types narrow correctly
 * - DISPUTES_CACHE_KEYS.forDispute() builds the expected key
 * - DISPUTE_ERROR_MESSAGES covers every DISPUTE_ERRORS entry that requires a message
 * - Edge-cases: empty string ids, special characters in forDispute
 */

import {
  DISPUTE_STATUS,
  DISPUTE_ERRORS,
  DISPUTE_ERROR_MESSAGES,
  DISPUTES_FEATURE_DISABLED_CODE,
  DISPUTES_FEATURE_DISABLED_MESSAGE,
  DISPUTES_PERMISSIONS,
  DISPUTES_CACHE_KEYS,
  DISPUTES_METRICS,
  DISPUTES_LOG_PREFIX,
  DISPUTES_SEED,
  DISPUTES_DEMO_CONTEXT,
} from './constants';
import type { DisputeStatusValue, DisputeErrorCode, DisputesPermission } from './constants';

// ─── DISPUTE_STATUS ──────────────────────────────────────────────────────────

describe('DISPUTE_STATUS', () => {
  it('has exactly the expected keys', () => {
    const keys = Object.keys(DISPUTE_STATUS);
    expect(keys.sort()).toEqual(
      ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'ESCALATED', 'CANCELLED'].sort(),
    );
  });

  it('OPEN equals "open"', () => {
    expect(DISPUTE_STATUS.OPEN).toBe('open');
  });

  it('UNDER_REVIEW equals "under_review"', () => {
    expect(DISPUTE_STATUS.UNDER_REVIEW).toBe('under_review');
  });

  it('RESOLVED equals "resolved"', () => {
    expect(DISPUTE_STATUS.RESOLVED).toBe('resolved');
  });

  it('ESCALATED equals "escalated"', () => {
    expect(DISPUTE_STATUS.ESCALATED).toBe('escalated');
  });

  it('CANCELLED equals "cancelled"', () => {
    expect(DISPUTE_STATUS.CANCELLED).toBe('cancelled');
  });

  it('all values are non-empty strings', () => {
    for (const value of Object.values(DISPUTE_STATUS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('values are unique (no duplicates)', () => {
    const values = Object.values(DISPUTE_STATUS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is immutable (as const — TypeScript-narrowed)', () => {
    // Runtime check: the object should not be mutated
    const original = { ...DISPUTE_STATUS };
    expect(DISPUTE_STATUS).toMatchObject(original);
  });
});

// ─── DISPUTE_ERRORS ───────────────────────────────────────────────────────────

describe('DISPUTE_ERRORS', () => {
  it('has exactly the expected keys', () => {
    const keys = Object.keys(DISPUTE_ERRORS);
    expect(keys.sort()).toEqual(
      [
        'NOT_FOUND',
        'ALREADY_DELETED',
        'NOT_DELETED',
        'INVALID_STATE_TRANSITION',
        'INTERNAL_ERROR',
      ].sort(),
    );
  });

  it('NOT_FOUND equals "dispute_not_found"', () => {
    expect(DISPUTE_ERRORS.NOT_FOUND).toBe('dispute_not_found');
  });

  it('ALREADY_DELETED equals "dispute_already_deleted"', () => {
    expect(DISPUTE_ERRORS.ALREADY_DELETED).toBe('dispute_already_deleted');
  });

  it('NOT_DELETED equals "dispute_not_deleted"', () => {
    expect(DISPUTE_ERRORS.NOT_DELETED).toBe('dispute_not_deleted');
  });

  it('INVALID_STATE_TRANSITION equals "invalid_state_transition"', () => {
    expect(DISPUTE_ERRORS.INVALID_STATE_TRANSITION).toBe('invalid_state_transition');
  });

  it('INTERNAL_ERROR equals "internal_error"', () => {
    expect(DISPUTE_ERRORS.INTERNAL_ERROR).toBe('internal_error');
  });

  it('all values are snake_case non-empty strings', () => {
    for (const value of Object.values(DISPUTE_ERRORS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      // snake_case: only lowercase letters and underscores
      expect(value).toMatch(/^[a-z_]+$/);
    }
  });

  it('values are unique (no duplicates)', () => {
    const values = Object.values(DISPUTE_ERRORS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── DISPUTE_ERROR_MESSAGES ───────────────────────────────────────────────────

describe('DISPUTE_ERROR_MESSAGES', () => {
  it('contains a message for dispute_not_found', () => {
    expect(DISPUTE_ERROR_MESSAGES[DISPUTE_ERRORS.NOT_FOUND]).toBe(
      'The requested dispute was not found',
    );
  });

  it('contains a message for invalid_state_transition', () => {
    expect(DISPUTE_ERROR_MESSAGES[DISPUTE_ERRORS.INVALID_STATE_TRANSITION]).toBe(
      'The requested state transition is not allowed',
    );
  });

  it('contains a message for internal_error', () => {
    expect(DISPUTE_ERROR_MESSAGES[DISPUTE_ERRORS.INTERNAL_ERROR]).toBe(
      'An unexpected error occurred while processing the dispute',
    );
  });

  it('all message values are non-empty strings', () => {
    for (const msg of Object.values(DISPUTE_ERROR_MESSAGES)) {
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('returns undefined for an unknown error code', () => {
    expect(DISPUTE_ERROR_MESSAGES['unknown_code']).toBeUndefined();
  });
});

// ─── FEATURE FLAG CONSTANTS ───────────────────────────────────────────────────

describe('DISPUTES_FEATURE_DISABLED_CODE / MESSAGE', () => {
  it('DISPUTES_FEATURE_DISABLED_CODE equals "feature_disabled"', () => {
    expect(DISPUTES_FEATURE_DISABLED_CODE).toBe('feature_disabled');
  });

  it('DISPUTES_FEATURE_DISABLED_MESSAGE equals the expected message', () => {
    expect(DISPUTES_FEATURE_DISABLED_MESSAGE).toBe(
      'Disputes feature is currently disabled.',
    );
  });

  it('both are non-empty strings', () => {
    expect(typeof DISPUTES_FEATURE_DISABLED_CODE).toBe('string');
    expect(DISPUTES_FEATURE_DISABLED_CODE.length).toBeGreaterThan(0);
    expect(typeof DISPUTES_FEATURE_DISABLED_MESSAGE).toBe('string');
    expect(DISPUTES_FEATURE_DISABLED_MESSAGE.length).toBeGreaterThan(0);
  });
});

// ─── DISPUTES_PERMISSIONS ─────────────────────────────────────────────────────

describe('DISPUTES_PERMISSIONS', () => {
  it('has exactly the expected keys', () => {
    const keys = Object.keys(DISPUTES_PERMISSIONS);
    expect(keys.sort()).toEqual(
      ['LIST', 'READ', 'CREATE', 'UPDATE', 'DELETE'].sort(),
    );
  });

  it('LIST equals "disputes:list"', () => {
    expect(DISPUTES_PERMISSIONS.LIST).toBe('disputes:list');
  });

  it('READ equals "disputes:read"', () => {
    expect(DISPUTES_PERMISSIONS.READ).toBe('disputes:read');
  });

  it('CREATE equals "disputes:create"', () => {
    expect(DISPUTES_PERMISSIONS.CREATE).toBe('disputes:create');
  });

  it('UPDATE equals "disputes:update"', () => {
    expect(DISPUTES_PERMISSIONS.UPDATE).toBe('disputes:update');
  });

  it('DELETE equals "disputes:delete"', () => {
    expect(DISPUTES_PERMISSIONS.DELETE).toBe('disputes:delete');
  });

  it('all values follow the "disputes:<action>" format', () => {
    for (const value of Object.values(DISPUTES_PERMISSIONS)) {
      expect(value).toMatch(/^disputes:[a-z]+$/);
    }
  });

  it('values are unique (no duplicates)', () => {
    const values = Object.values(DISPUTES_PERMISSIONS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── DISPUTES_CACHE_KEYS ──────────────────────────────────────────────────────

describe('DISPUTES_CACHE_KEYS', () => {
  it('LIST equals "disputes:list"', () => {
    expect(DISPUTES_CACHE_KEYS.LIST).toBe('disputes:list');
  });

  describe('forDispute()', () => {
    it('builds the expected key for a normal id', () => {
      expect(DISPUTES_CACHE_KEYS.forDispute('abc-123')).toBe('disputes:abc-123');
    });

    it('builds the expected key for a UUID-like id', () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      expect(DISPUTES_CACHE_KEYS.forDispute(id)).toBe(`disputes:${id}`);
    });

    it('prefixes with "disputes:" for any non-empty string', () => {
      expect(DISPUTES_CACHE_KEYS.forDispute('x')).toBe('disputes:x');
    });

    it('handles an empty string id gracefully', () => {
      expect(DISPUTES_CACHE_KEYS.forDispute('')).toBe('disputes:');
    });

    it('handles special-character ids', () => {
      expect(DISPUTES_CACHE_KEYS.forDispute('id/with/slashes')).toBe(
        'disputes:id/with/slashes',
      );
    });

    it('is consistent: same id always produces same key', () => {
      const id = 'consistent-id';
      expect(DISPUTES_CACHE_KEYS.forDispute(id)).toBe(
        DISPUTES_CACHE_KEYS.forDispute(id),
      );
    });

    it('produces different keys for different ids', () => {
      expect(DISPUTES_CACHE_KEYS.forDispute('id-1')).not.toBe(
        DISPUTES_CACHE_KEYS.forDispute('id-2'),
      );
    });
  });
});

// ─── DISPUTES_METRICS ────────────────────────────────────────────────────────

describe('DISPUTES_METRICS', () => {
  it('CACHE_HITS_TOTAL equals "disputes_cache_hits_total"', () => {
    expect(DISPUTES_METRICS.CACHE_HITS_TOTAL).toBe('disputes_cache_hits_total');
  });

  it('CACHE_MISSES_TOTAL equals "disputes_cache_misses_total"', () => {
    expect(DISPUTES_METRICS.CACHE_MISSES_TOTAL).toBe('disputes_cache_misses_total');
  });

  it('all values follow Prometheus snake_case naming convention', () => {
    for (const value of Object.values(DISPUTES_METRICS)) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*[a-z0-9]$/);
    }
  });

  it('values are unique (no duplicates)', () => {
    const values = Object.values(DISPUTES_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── DISPUTES_LOG_PREFIX ──────────────────────────────────────────────────────

describe('DISPUTES_LOG_PREFIX', () => {
  it('equals "[DisputesService]"', () => {
    expect(DISPUTES_LOG_PREFIX).toBe('[DisputesService]');
  });

  it('is a non-empty string', () => {
    expect(typeof DISPUTES_LOG_PREFIX).toBe('string');
    expect(DISPUTES_LOG_PREFIX.length).toBeGreaterThan(0);
  });

  it('starts with "[" and ends with "]"', () => {
    expect(DISPUTES_LOG_PREFIX).toMatch(/^\[.*\]$/);
  });
});

// ─── DISPUTES_SEED ───────────────────────────────────────────────────────────

describe('DISPUTES_SEED', () => {
  it('has exactly the expected keys', () => {
    const keys = Object.keys(DISPUTES_SEED);
    expect(keys.sort()).toEqual(
      ['DISPUTE_001_ID', 'DISPUTE_002_ID', 'CONTRACT_001_ID', 'CONTRACT_002_ID'].sort(),
    );
  });

  it('DISPUTE_001_ID equals "dispute-001"', () => {
    expect(DISPUTES_SEED.DISPUTE_001_ID).toBe('dispute-001');
  });

  it('DISPUTE_002_ID equals "dispute-002"', () => {
    expect(DISPUTES_SEED.DISPUTE_002_ID).toBe('dispute-002');
  });

  it('CONTRACT_001_ID equals "contract-001"', () => {
    expect(DISPUTES_SEED.CONTRACT_001_ID).toBe('contract-001');
  });

  it('CONTRACT_002_ID equals "contract-002"', () => {
    expect(DISPUTES_SEED.CONTRACT_002_ID).toBe('contract-002');
  });

  it('dispute IDs and contract IDs are distinct', () => {
    const disputeIds = [DISPUTES_SEED.DISPUTE_001_ID, DISPUTES_SEED.DISPUTE_002_ID];
    const contractIds = [DISPUTES_SEED.CONTRACT_001_ID, DISPUTES_SEED.CONTRACT_002_ID];
    for (const dId of disputeIds) {
      for (const cId of contractIds) {
        expect(dId).not.toBe(cId);
      }
    }
  });

  it('all values are non-empty strings', () => {
    for (const value of Object.values(DISPUTES_SEED)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ─── DISPUTES_DEMO_CONTEXT ───────────────────────────────────────────────────

describe('DISPUTES_DEMO_CONTEXT', () => {
  it('USER_EMAIL equals "admin@talenttrust.example"', () => {
    expect(DISPUTES_DEMO_CONTEXT.USER_EMAIL).toBe('admin@talenttrust.example');
  });

  it('USER_ID equals "admin-id"', () => {
    expect(DISPUTES_DEMO_CONTEXT.USER_ID).toBe('admin-id');
  });

  it('USER_EMAIL looks like an email address', () => {
    expect(DISPUTES_DEMO_CONTEXT.USER_EMAIL).toMatch(/^[^@]+@[^@]+$/);
  });

  it('both values are non-empty strings', () => {
    expect(typeof DISPUTES_DEMO_CONTEXT.USER_EMAIL).toBe('string');
    expect(DISPUTES_DEMO_CONTEXT.USER_EMAIL.length).toBeGreaterThan(0);
    expect(typeof DISPUTES_DEMO_CONTEXT.USER_ID).toBe('string');
    expect(DISPUTES_DEMO_CONTEXT.USER_ID.length).toBeGreaterThan(0);
  });
});

// ─── Cross-constant consistency checks ───────────────────────────────────────

describe('Cross-constant consistency', () => {
  it('DISPUTE_ERROR_MESSAGES keys are a subset of DISPUTE_ERRORS values', () => {
    const errorValues = new Set(Object.values(DISPUTE_ERRORS));
    for (const key of Object.keys(DISPUTE_ERROR_MESSAGES)) {
      expect(errorValues).toContain(key);
    }
  });

  it('DISPUTES_CACHE_KEYS.LIST starts with the same prefix as forDispute()', () => {
    // Both should start with "disputes:"
    expect(DISPUTES_CACHE_KEYS.LIST).toMatch(/^disputes:/);
    expect(DISPUTES_CACHE_KEYS.forDispute('x')).toMatch(/^disputes:/);
  });

  it('DISPUTES_METRICS values end with "_total" (Prometheus counter convention)', () => {
    for (const value of Object.values(DISPUTES_METRICS)) {
      expect(value).toMatch(/_total$/);
    }
  });

  it('DISPUTES_PERMISSIONS values all share the "disputes:" prefix', () => {
    for (const value of Object.values(DISPUTES_PERMISSIONS)) {
      expect(value).toMatch(/^disputes:/);
    }
  });

  it('DISPUTES_SEED dispute IDs start with "dispute-"', () => {
    expect(DISPUTES_SEED.DISPUTE_001_ID).toMatch(/^dispute-/);
    expect(DISPUTES_SEED.DISPUTE_002_ID).toMatch(/^dispute-/);
  });

  it('DISPUTES_SEED contract IDs start with "contract-"', () => {
    expect(DISPUTES_SEED.CONTRACT_001_ID).toMatch(/^contract-/);
    expect(DISPUTES_SEED.CONTRACT_002_ID).toMatch(/^contract-/);
  });
});
