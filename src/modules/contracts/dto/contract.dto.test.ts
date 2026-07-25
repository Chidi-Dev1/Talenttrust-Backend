/**
 * Unit tests for contract.dto.ts
 *
 * Coverage:
 *  - createContractSchema: required fields, type errors, length/range bounds,
 *    unknown field stripping, milestone sub-schema, enum values
 *  - updateContractSchema: OCC version, partial fields, unknown field stripping
 *  - contractIdParamSchema: empty id, oversized id, valid id
 *  - contractQuerySchema: coercion, range bounds, enum values, unknown key stripping
 */

import {
  createContractSchema,
  updateContractSchema,
  contractIdParamSchema,
  contractQuerySchema,
  TITLE_MIN_LENGTH,
  TITLE_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  TERMS_MAX_LENGTH,
  MILESTONE_TITLE_MAX_LENGTH,
  MILESTONE_DESCRIPTION_MIN_LENGTH,
  MILESTONE_DESCRIPTION_MAX_LENGTH,
  CONTRACT_ID_MAX_LENGTH,
  QUERY_LIMIT_MAX,
} from './contract.dto';
import { MAX_CONTRACT_AMOUNT_STROOPS } from '../../../contracts/bounds';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLIENT_UUID = '00000000-0000-0000-0000-000000000001';
const FREELANCER_UUID = '00000000-0000-0000-0000-000000000002';

/** Minimal valid create body */
function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Valid Contract Title',
    description: 'This is a valid description that is long enough.',
    clientId: CLIENT_UUID,
    budget: 5000,
    ...overrides,
  };
}

/** Minimal valid update body (only version is required) */
function validUpdateBody(overrides: Record<string, unknown> = {}) {
  return {
    version: 0,
    title: 'Updated Title',
    ...overrides,
  };
}

function parseCreate(body: unknown) {
  return createContractSchema.safeParse({ body });
}

function parseUpdate(body: unknown) {
  return updateContractSchema.safeParse({ body });
}

// ─── createContractSchema ─────────────────────────────────────────────────────

describe('createContractSchema — happy path', () => {
  it('accepts a minimal valid body', () => {
    const result = parseCreate(validCreateBody());
    expect(result.success).toBe(true);
  });

  it('accepts a fully populated valid body', () => {
    const result = parseCreate(
      validCreateBody({
        freelancerId: FREELANCER_UUID,
        deadline: '2030-01-01T00:00:00.000Z',
        status: 'draft',
        terms: 'Standard terms apply.',
        milestones: [
          {
            title: 'Phase 1',
            description: 'Initial work',
            amount: 1000,
            deadline: '2029-01-01T00:00:00.000Z',
            completed: false,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts budget exactly at MAX_CONTRACT_AMOUNT_STROOPS', () => {
    const result = parseCreate(validCreateBody({ budget: MAX_CONTRACT_AMOUNT_STROOPS }));
    expect(result.success).toBe(true);
  });

  it('accepts title at exactly TITLE_MIN_LENGTH characters', () => {
    const result = parseCreate(validCreateBody({ title: 'A'.repeat(TITLE_MIN_LENGTH) }));
    expect(result.success).toBe(true);
  });

  it('accepts title at exactly TITLE_MAX_LENGTH characters', () => {
    const result = parseCreate(validCreateBody({ title: 'A'.repeat(TITLE_MAX_LENGTH) }));
    expect(result.success).toBe(true);
  });

  it('accepts description at exactly DESCRIPTION_MIN_LENGTH characters', () => {
    const result = parseCreate(validCreateBody({ description: 'A'.repeat(DESCRIPTION_MIN_LENGTH) }));
    expect(result.success).toBe(true);
  });

  it('accepts description at exactly DESCRIPTION_MAX_LENGTH characters', () => {
    const result = parseCreate(validCreateBody({ description: 'A'.repeat(DESCRIPTION_MAX_LENGTH) }));
    expect(result.success).toBe(true);
  });

  it('accepts terms at exactly TERMS_MAX_LENGTH characters', () => {
    const result = parseCreate(validCreateBody({ terms: 'A'.repeat(TERMS_MAX_LENGTH) }));
    expect(result.success).toBe(true);
  });

  it('strips unknown fields from body', () => {
    const result = parseCreate(validCreateBody({ __admin: true, injected: 'evil' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).not.toHaveProperty('__admin');
      expect(result.data.body).not.toHaveProperty('injected');
    }
  });

  it('trims whitespace from title', () => {
    const result = parseCreate(validCreateBody({ title: '  Valid Title Here  ' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.title).toBe('Valid Title Here');
    }
  });

  it('trims whitespace from description', () => {
    const result = parseCreate(validCreateBody({ description: '  ' + 'A'.repeat(DESCRIPTION_MIN_LENGTH) + '  ' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.description.startsWith(' ')).toBe(false);
    }
  });

  it('milestone description defaults to empty string when omitted', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [{ title: 'M1', amount: 100 }],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.milestones?.[0]?.description).toBe('');
    }
  });

  it('milestone completed defaults to false when omitted', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [{ title: 'M1', amount: 100 }],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.milestones?.[0]?.completed).toBe(false);
    }
  });

  it('strips unknown fields from milestone sub-objects', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [{ title: 'M1', amount: 100, __inject: 'bad' }],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.milestones?.[0]).not.toHaveProperty('__inject');
    }
  });
});

describe('createContractSchema — required field errors', () => {
  it('rejects missing title', () => {
    const { title: _t, ...body } = validCreateBody();
    const result = parseCreate(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('body.title');
    }
  });

  it('rejects missing description', () => {
    const { description: _d, ...body } = validCreateBody();
    const result = parseCreate(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('body.description');
    }
  });

  it('rejects missing clientId', () => {
    const { clientId: _c, ...body } = validCreateBody();
    const result = parseCreate(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('body.clientId');
    }
  });

  it('rejects missing budget', () => {
    const { budget: _b, ...body } = validCreateBody();
    const result = parseCreate(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('body.budget');
    }
  });

  it('rejects entirely empty body', () => {
    const result = parseCreate({});
    expect(result.success).toBe(false);
  });

  it('rejects null body', () => {
    const result = parseCreate(null);
    expect(result.success).toBe(false);
  });

  it('rejects non-object body', () => {
    const result = parseCreate('string body');
    expect(result.success).toBe(false);
  });
});

describe('createContractSchema — type errors', () => {
  it('rejects non-string title', () => {
    const result = parseCreate(validCreateBody({ title: 12345 }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string description', () => {
    const result = parseCreate(validCreateBody({ description: true }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string clientId', () => {
    const result = parseCreate(validCreateBody({ clientId: 999 }));
    expect(result.success).toBe(false);
  });

  it('rejects non-number budget', () => {
    const result = parseCreate(validCreateBody({ budget: 'five-thousand' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string freelancerId', () => {
    const result = parseCreate(validCreateBody({ freelancerId: 42 }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string terms', () => {
    const result = parseCreate(validCreateBody({ terms: { nested: true } }));
    expect(result.success).toBe(false);
  });
});

describe('createContractSchema — string length bounds', () => {
  it('rejects title shorter than TITLE_MIN_LENGTH', () => {
    const result = parseCreate(validCreateBody({ title: 'A'.repeat(TITLE_MIN_LENGTH - 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects title longer than TITLE_MAX_LENGTH', () => {
    const result = parseCreate(validCreateBody({ title: 'A'.repeat(TITLE_MAX_LENGTH + 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects description shorter than DESCRIPTION_MIN_LENGTH', () => {
    const result = parseCreate(validCreateBody({ description: 'A'.repeat(DESCRIPTION_MIN_LENGTH - 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects description longer than DESCRIPTION_MAX_LENGTH', () => {
    const result = parseCreate(validCreateBody({ description: 'A'.repeat(DESCRIPTION_MAX_LENGTH + 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects terms longer than TERMS_MAX_LENGTH', () => {
    const result = parseCreate(validCreateBody({ terms: 'A'.repeat(TERMS_MAX_LENGTH + 1) }));
    expect(result.success).toBe(false);
  });
});

describe('createContractSchema — numeric range bounds', () => {
  it('rejects budget of zero', () => {
    const result = parseCreate(validCreateBody({ budget: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative budget', () => {
    const result = parseCreate(validCreateBody({ budget: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects budget exceeding MAX_CONTRACT_AMOUNT_STROOPS', () => {
    const result = parseCreate(validCreateBody({ budget: MAX_CONTRACT_AMOUNT_STROOPS + 1 }));
    expect(result.success).toBe(false);
  });
});

describe('createContractSchema — UUID validation', () => {
  it('rejects non-UUID clientId', () => {
    const result = parseCreate(validCreateBody({ clientId: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID freelancerId', () => {
    const result = parseCreate(validCreateBody({ freelancerId: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('accepts valid freelancerId UUID', () => {
    const result = parseCreate(validCreateBody({ freelancerId: FREELANCER_UUID }));
    expect(result.success).toBe(true);
  });

  it('accepts omitted freelancerId', () => {
    const result = parseCreate(validCreateBody({ freelancerId: undefined }));
    expect(result.success).toBe(true);
  });
});

describe('createContractSchema — deadline validation', () => {
  it('rejects invalid datetime string', () => {
    const result = parseCreate(validCreateBody({ deadline: 'not-a-date' }));
    expect(result.success).toBe(false);
  });

  it('rejects deadline that is too long', () => {
    const result = parseCreate(validCreateBody({ deadline: 'A'.repeat(65) }));
    expect(result.success).toBe(false);
  });

  it('accepts valid ISO-8601 datetime', () => {
    const result = parseCreate(validCreateBody({ deadline: '2030-06-15T12:00:00.000Z' }));
    expect(result.success).toBe(true);
  });

  it('accepts omitted deadline', () => {
    const result = parseCreate(validCreateBody({ deadline: undefined }));
    expect(result.success).toBe(true);
  });
});

describe('createContractSchema — status enum', () => {
  const validStatuses = ['draft', 'active', 'completed', 'cancelled', 'disputed'];

  it.each(validStatuses)('accepts status "%s"', (status) => {
    const result = parseCreate(validCreateBody({ status }));
    expect(result.success).toBe(true);
  });

  it('rejects invalid status value', () => {
    const result = parseCreate(validCreateBody({ status: 'pending' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string status', () => {
    const result = parseCreate(validCreateBody({ status: 1 }));
    expect(result.success).toBe(false);
  });
});

describe('createContractSchema — milestone validation', () => {
  it('rejects milestone with empty title', () => {
    const result = parseCreate(
      validCreateBody({ milestones: [{ title: '', amount: 100 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with title exceeding max length', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [{ title: 'A'.repeat(MILESTONE_TITLE_MAX_LENGTH + 1), amount: 100 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with description exceeding max length', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [
          {
            title: 'Valid',
            description: 'A'.repeat(MILESTONE_DESCRIPTION_MAX_LENGTH + 1),
            amount: 100,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with zero amount', () => {
    const result = parseCreate(
      validCreateBody({ milestones: [{ title: 'M1', amount: 0 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with negative amount', () => {
    const result = parseCreate(
      validCreateBody({ milestones: [{ title: 'M1', amount: -50 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with amount exceeding MAX_CONTRACT_AMOUNT_STROOPS', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [{ title: 'M1', amount: MAX_CONTRACT_AMOUNT_STROOPS + 1 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with invalid deadline', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [{ title: 'M1', amount: 100, deadline: 'bad-date' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts milestones: undefined (optional)', () => {
    const result = parseCreate(validCreateBody({ milestones: undefined }));
    expect(result.success).toBe(true);
  });

  it('accepts milestones: empty array', () => {
    const result = parseCreate(validCreateBody({ milestones: [] }));
    expect(result.success).toBe(true);
  });

  it('accepts milestone with description at exactly MILESTONE_DESCRIPTION_MIN_LENGTH', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [
          {
            title: 'M1',
            description: 'A'.repeat(MILESTONE_DESCRIPTION_MIN_LENGTH),
            amount: 100,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts milestone with description at exactly MILESTONE_DESCRIPTION_MAX_LENGTH', () => {
    const result = parseCreate(
      validCreateBody({
        milestones: [
          {
            title: 'M1',
            description: 'A'.repeat(MILESTONE_DESCRIPTION_MAX_LENGTH),
            amount: 100,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ─── updateContractSchema ─────────────────────────────────────────────────────

describe('updateContractSchema — happy path', () => {
  it('accepts body with only version', () => {
    // version alone is technically valid at the schema level; the service layer
    // rejects no-op updates with a separate check.
    const result = parseUpdate({ version: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts a full update body', () => {
    const result = parseUpdate({
      version: 3,
      title: 'Updated Title Here',
      description: 'This is an updated description that is long enough.',
      freelancerId: FREELANCER_UUID,
      clientId: CLIENT_UUID,
      budget: 9999,
      deadline: '2031-01-01T00:00:00.000Z',
      status: 'active',
      terms: 'Updated terms.',
      milestones: [
        {
          title: 'Phase A',
          description: 'Phase A work',
          amount: 4000,
          deadline: '2030-06-01T00:00:00.000Z',
          completed: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('strips unknown fields from update body', () => {
    const result = parseUpdate(validUpdateBody({ __secret: 'leak', extra: 99 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).not.toHaveProperty('__secret');
      expect(result.data.body).not.toHaveProperty('extra');
    }
  });

  it('accepts freelancerId: null (clearing the freelancer)', () => {
    const result = parseUpdate(validUpdateBody({ freelancerId: null }));
    expect(result.success).toBe(true);
  });

  it('accepts deadline: null (clearing the deadline)', () => {
    const result = parseUpdate(validUpdateBody({ deadline: null }));
    expect(result.success).toBe(true);
  });

  it('accepts terms: null (clearing terms)', () => {
    const result = parseUpdate(validUpdateBody({ terms: null }));
    expect(result.success).toBe(true);
  });

  it('accepts version = 0 (first update)', () => {
    const result = parseUpdate(validUpdateBody({ version: 0 }));
    expect(result.success).toBe(true);
  });

  it('accepts a large version number', () => {
    const result = parseUpdate(validUpdateBody({ version: 999999 }));
    expect(result.success).toBe(true);
  });
});

describe('updateContractSchema — version field errors', () => {
  it('rejects missing version', () => {
    const { version: _v, ...body } = validUpdateBody();
    const result = parseUpdate(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('body.version');
    }
  });

  it('rejects negative version', () => {
    const result = parseUpdate(validUpdateBody({ version: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects float version', () => {
    const result = parseUpdate(validUpdateBody({ version: 1.5 }));
    expect(result.success).toBe(false);
  });

  it('rejects string version', () => {
    const result = parseUpdate(validUpdateBody({ version: '0' }));
    expect(result.success).toBe(false);
  });

  it('rejects null version', () => {
    const result = parseUpdate(validUpdateBody({ version: null }));
    expect(result.success).toBe(false);
  });
});

describe('updateContractSchema — field constraints', () => {
  it('rejects title shorter than TITLE_MIN_LENGTH', () => {
    const result = parseUpdate(validUpdateBody({ title: 'A'.repeat(TITLE_MIN_LENGTH - 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects title longer than TITLE_MAX_LENGTH', () => {
    const result = parseUpdate(validUpdateBody({ title: 'A'.repeat(TITLE_MAX_LENGTH + 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects description shorter than DESCRIPTION_MIN_LENGTH', () => {
    const result = parseUpdate(validUpdateBody({ description: 'short' }));
    expect(result.success).toBe(false);
  });

  it('rejects description longer than DESCRIPTION_MAX_LENGTH', () => {
    const result = parseUpdate(
      validUpdateBody({ description: 'A'.repeat(DESCRIPTION_MAX_LENGTH + 1) }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects budget of zero', () => {
    const result = parseUpdate(validUpdateBody({ budget: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative budget', () => {
    const result = parseUpdate(validUpdateBody({ budget: -100 }));
    expect(result.success).toBe(false);
  });

  it('rejects budget exceeding MAX_CONTRACT_AMOUNT_STROOPS', () => {
    const result = parseUpdate(validUpdateBody({ budget: MAX_CONTRACT_AMOUNT_STROOPS + 1 }));
    expect(result.success).toBe(false);
  });

  it('rejects invalid status', () => {
    const result = parseUpdate(validUpdateBody({ status: 'archived' }));
    expect(result.success).toBe(false);
  });

  it('rejects terms exceeding TERMS_MAX_LENGTH', () => {
    const result = parseUpdate(validUpdateBody({ terms: 'A'.repeat(TERMS_MAX_LENGTH + 1) }));
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID freelancerId', () => {
    const result = parseUpdate(validUpdateBody({ freelancerId: 'bad-id' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID clientId', () => {
    const result = parseUpdate(validUpdateBody({ clientId: 'bad-id' }));
    expect(result.success).toBe(false);
  });

  it('rejects invalid deadline string', () => {
    const result = parseUpdate(validUpdateBody({ deadline: 'not-a-date' }));
    expect(result.success).toBe(false);
  });
});

describe('updateContractSchema — milestone validation', () => {
  it('rejects milestone with empty title', () => {
    const result = parseUpdate(
      validUpdateBody({ milestones: [{ title: '', description: 'Valid desc', amount: 100 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone with missing description (required in update schema)', () => {
    const result = parseUpdate(
      validUpdateBody({ milestones: [{ title: 'M1', amount: 100 }] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      // The path should point to the description field
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => /description/.test(p))).toBe(true);
    }
  });

  it('rejects milestone description shorter than MILESTONE_DESCRIPTION_MIN_LENGTH', () => {
    const result = parseUpdate(
      validUpdateBody({ milestones: [{ title: 'M1', description: '', amount: 100 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone description exceeding MILESTONE_DESCRIPTION_MAX_LENGTH', () => {
    const result = parseUpdate(
      validUpdateBody({
        milestones: [
          {
            title: 'M1',
            description: 'A'.repeat(MILESTONE_DESCRIPTION_MAX_LENGTH + 1),
            amount: 100,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects milestone amount of zero', () => {
    const result = parseUpdate(
      validUpdateBody({ milestones: [{ title: 'M1', description: 'Some desc', amount: 0 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('strips unknown milestone fields in update schema', () => {
    const result = parseUpdate(
      validUpdateBody({
        milestones: [
          { title: 'M1', description: 'Valid description', amount: 200, __hack: true },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.milestones?.[0]).not.toHaveProperty('__hack');
    }
  });
});

// ─── contractIdParamSchema ────────────────────────────────────────────────────

describe('contractIdParamSchema', () => {
  it('accepts a valid short id', () => {
    const result = contractIdParamSchema.safeParse({ id: 'abc-123' });
    expect(result.success).toBe(true);
  });

  it('accepts a UUID as id', () => {
    const result = contractIdParamSchema.safeParse({ id: CLIENT_UUID });
    expect(result.success).toBe(true);
  });

  it('accepts an id at exactly CONTRACT_ID_MAX_LENGTH characters', () => {
    const result = contractIdParamSchema.safeParse({ id: 'a'.repeat(CONTRACT_ID_MAX_LENGTH) });
    expect(result.success).toBe(true);
  });

  it('rejects an empty string id', () => {
    const result = contractIdParamSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/not be empty/i);
    }
  });

  it('rejects an id exceeding CONTRACT_ID_MAX_LENGTH', () => {
    const result = contractIdParamSchema.safeParse({ id: 'a'.repeat(CONTRACT_ID_MAX_LENGTH + 1) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/must not exceed/i);
    }
  });

  it('rejects missing id field', () => {
    const result = contractIdParamSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects numeric id', () => {
    const result = contractIdParamSchema.safeParse({ id: 12345 });
    expect(result.success).toBe(false);
  });

  it('strips unknown params', () => {
    const result = contractIdParamSchema.safeParse({ id: 'abc', extra: 'drop-me' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('extra');
    }
  });
});

// ─── contractQuerySchema ──────────────────────────────────────────────────────

describe('contractQuerySchema — happy path', () => {
  it('accepts empty query object and applies defaults', () => {
    const result = contractQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(10);
    }
  });

  it('coerces string page and limit to numbers', () => {
    const result = contractQuerySchema.safeParse({ page: '3', limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(25);
    }
  });

  it('accepts limit exactly at QUERY_LIMIT_MAX', () => {
    const result = contractQuerySchema.safeParse({ limit: String(QUERY_LIMIT_MAX) });
    expect(result.success).toBe(true);
  });

  it('accepts all valid status values', () => {
    const statuses = ['draft', 'active', 'completed', 'cancelled', 'disputed'];
    statuses.forEach((status) => {
      const result = contractQuerySchema.safeParse({ status });
      expect(result.success).toBe(true);
    });
  });

  it('accepts valid clientId UUID', () => {
    const result = contractQuerySchema.safeParse({ clientId: CLIENT_UUID });
    expect(result.success).toBe(true);
  });

  it('accepts valid freelancerId UUID', () => {
    const result = contractQuerySchema.safeParse({ freelancerId: FREELANCER_UUID });
    expect(result.success).toBe(true);
  });

  it('accepts valid sortOrder values', () => {
    ['asc', 'desc'].forEach((sortOrder) => {
      const result = contractQuerySchema.safeParse({ sortOrder });
      expect(result.success).toBe(true);
    });
  });

  it('strips unknown query keys', () => {
    const result = contractQuerySchema.safeParse({
      page: '1',
      admin: 'true',
      debug: '1',
      __inject: 'evil',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('admin');
      expect(result.data).not.toHaveProperty('debug');
      expect(result.data).not.toHaveProperty('__inject');
    }
  });
});

describe('contractQuerySchema — validation errors', () => {
  it('rejects page = 0', () => {
    const result = contractQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects negative page', () => {
    const result = contractQuerySchema.safeParse({ page: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects float page', () => {
    const result = contractQuerySchema.safeParse({ page: '1.5' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric page string', () => {
    const result = contractQuerySchema.safeParse({ page: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects limit = 0', () => {
    const result = contractQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects limit exceeding QUERY_LIMIT_MAX', () => {
    const result = contractQuerySchema.safeParse({ limit: String(QUERY_LIMIT_MAX + 1) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/must not exceed/i);
    }
  });

  it('rejects invalid status value', () => {
    const result = contractQuerySchema.safeParse({ status: 'pending' });
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID clientId', () => {
    const result = contractQuerySchema.safeParse({ clientId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID freelancerId', () => {
    const result = contractQuerySchema.safeParse({ freelancerId: 'bad-id' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid sortOrder', () => {
    const result = contractQuerySchema.safeParse({ sortOrder: 'random' });
    expect(result.success).toBe(false);
  });

  it('rejects cursor exceeding 512 characters', () => {
    const result = contractQuerySchema.safeParse({ cursor: 'a'.repeat(513) });
    expect(result.success).toBe(false);
  });

  it('rejects invalid sortBy value', () => {
    const result = contractQuerySchema.safeParse({ sortBy: 'injectedField' });
    expect(result.success).toBe(false);
  });
});

describe('contractQuerySchema — boundary values', () => {
  it('page = 1 is the minimum valid value', () => {
    const result = contractQuerySchema.safeParse({ page: '1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.page).toBe(1);
  });

  it('limit = 1 is the minimum valid value', () => {
    const result = contractQuerySchema.safeParse({ limit: '1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(1);
  });

  it('cursor at exactly 512 characters is accepted', () => {
    const result = contractQuerySchema.safeParse({ cursor: 'a'.repeat(512) });
    expect(result.success).toBe(true);
  });
});
