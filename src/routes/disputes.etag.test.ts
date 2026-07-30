/**
 * @file disputes.etag.test.ts
 * @description Comprehensive tests for ETag / conditional-GET (If-None-Match → 304)
 * on disputes read endpoints.
 *
 * Coverage:
 *   - GET /api/v1/disputes        (list)   — 200 with ETag on first request
 *   - GET /api/v1/disputes/:id    (single) — 200 with ETag on first request
 *   - Matching If-None-Match  → 304, no body
 *   - Non-matching If-None-Match → 200 with fresh body
 *   - Wildcard If-None-Match (*) → 304
 *   - Weak ETag (W/"…") in If-None-Match → 304
 *   - Multiple ETags in If-None-Match header (at least one matches) → 304
 *   - Different dispute IDs produce different ETags
 *   - Changed payload produces a new ETag (ETag changes when resource changes)
 *   - ETag header value is correctly quoted
 *   - 304 response has no body
 *   - Non-read endpoints (POST, PATCH, DELETE) do NOT emit the disputes ETag
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../middleware/requestId';
import { createDisputesRouter } from './disputes.routes';
import { buildEtag } from '../utils/etag';
import { Logger } from '../logger';

// ── Mock auth — passthrough ────────────────────────────────────────────────────
jest.mock('../middleware/authorization', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// ── Feature flag always enabled ────────────────────────────────────────────────
jest.mock('../config/features', () => ({
  features: { disputesEnabled: true },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const silentLogger = new Logger();
jest.spyOn(silentLogger as any, 'log').mockImplementation(() => undefined);

const router = createDisputesRouter({ log: silentLogger });

function buildApp() {
  const app = express();
  // Disable Express's built-in ETag generation so only our explicit headers appear
  app.set('etag', false);
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/v1/disputes', router);
  return app;
}

const app = buildApp();

// Valid UUIDs for tests (required by disputeParamsSchema)
const DISPUTE_ID_1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const DISPUTE_ID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const DISPUTE_ID_3 = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

// ── LIST endpoint — GET /api/v1/disputes ──────────────────────────────────────

describe('GET /api/v1/disputes — ETag support (list)', () => {
  it('returns a quoted ETag header on a fresh GET', async () => {
    const res = await request(app).get('/api/v1/disputes');

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeDefined();
    // ETag must be a quoted string: "…"
    expect(res.headers['etag']).toMatch(/^"[^"]+"$/);
  });

  it('returns the same ETag for identical successive requests', async () => {
    const res1 = await request(app).get('/api/v1/disputes');
    const res2 = await request(app).get('/api/v1/disputes');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.headers['etag']).toBe(res2.headers['etag']);
  });

  it('returns 304 with no body when If-None-Match matches the ETag', async () => {
    const first = await request(app).get('/api/v1/disputes');
    expect(first.status).toBe(200);
    const etag = first.headers['etag'] as string;

    const second = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    // 304 must not have a body
    expect(second.text).toBe('');
  });

  it('returns 304 when If-None-Match is a wildcard (*)', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
  });

  it('returns 304 when If-None-Match contains a weak variant of the ETag', async () => {
    const first = await request(app).get('/api/v1/disputes');
    const etag = first.headers['etag'] as string;
    const weakEtag = `W/${etag}`;

    const second = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', weakEtag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns 304 when If-None-Match contains multiple tags, one of which matches', async () => {
    const first = await request(app).get('/api/v1/disputes');
    const etag = first.headers['etag'] as string;

    const second = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', `"unrelated-tag-1", ${etag}, "unrelated-tag-2"`);

    expect(second.status).toBe(304);
  });

  it('returns 200 with body when If-None-Match does NOT match', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', '"totally-different-etag"');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body.status).toBe('success');
    expect(res.headers['etag']).toBeDefined();
  });

  it('always returns an ETag even without an If-None-Match header', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toMatch(/^"[^"]+"$/);
  });

  it('ETag matches buildEtag("disputes:list", { disputes: [], total: 0 })', async () => {
    const listData = { disputes: [], total: 0 };
    const expectedEtag = buildEtag('disputes:list', listData);

    const res = await request(app).get('/api/v1/disputes');
    expect(res.headers['etag']).toBe(expectedEtag);
  });

  it('list ETag is stable (deterministic for the same payload)', () => {
    const data = { disputes: [], total: 0 };
    const tag1 = buildEtag('disputes:list', data);
    const tag2 = buildEtag('disputes:list', data);
    expect(tag1).toBe(tag2);
  });
});

// ── SINGLE endpoint — GET /api/v1/disputes/:id ────────────────────────────────

describe('GET /api/v1/disputes/:id — ETag support (single)', () => {
  it('returns a quoted ETag header on a fresh GET', async () => {
    const res = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_1}`);

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toMatch(/^"[^"]+"$/);
  });

  it('returns 200 with body and ETag on fresh GET with no If-None-Match', async () => {
    const res = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_1}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.dispute.id).toBe(DISPUTE_ID_1);
    expect(res.headers['etag']).toBeDefined();
  });

  it('returns 304 when If-None-Match is a wildcard (*)', async () => {
    const res = await request(app)
      .get(`/api/v1/disputes/${DISPUTE_ID_1}`)
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
  });

  it('returns 304 when wildcard is combined with other tags', async () => {
    const res = await request(app)
      .get(`/api/v1/disputes/${DISPUTE_ID_1}`)
      .set('If-None-Match', '"stale-tag", *');

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const res = await request(app)
      .get(`/api/v1/disputes/${DISPUTE_ID_1}`)
      .set('If-None-Match', '"completely-wrong-etag"');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.headers['etag']).toBeDefined();
  });

  it('different dispute IDs produce different ETags', async () => {
    const res1 = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_1}`);
    const res2 = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_2}`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Different IDs → different scope ("disputes:item:<id>") → different ETags
    expect(res1.headers['etag']).not.toBe(res2.headers['etag']);
  });

  it('always emits an ETag regardless of whether If-None-Match is present', async () => {
    const res = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_3}`);
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toMatch(/^"[^"]+"$/);
  });

  it('ETag scope includes the dispute ID (scope is "disputes:item:<id>")', () => {
    // Verify that the scope distinguishes different IDs
    const payload1 = { dispute: { id: DISPUTE_ID_1, status: 'open', createdAt: '2026-01-01T00:00:00.000Z' } };
    const payload2 = { dispute: { id: DISPUTE_ID_2, status: 'open', createdAt: '2026-01-01T00:00:00.000Z' } };

    const etag1 = buildEtag(`disputes:item:${DISPUTE_ID_1}`, payload1);
    const etag2 = buildEtag(`disputes:item:${DISPUTE_ID_2}`, payload2);

    expect(etag1).not.toBe(etag2);
  });
});

// ── ETag changes when resource changes ────────────────────────────────────────

describe('ETag changes when payload changes', () => {
  it('list ETag changes when the underlying data changes', () => {
    const payload1 = { disputes: [], total: 0 };
    const payload2 = { disputes: [{ id: DISPUTE_ID_1, status: 'open' }], total: 1 };

    const etag1 = buildEtag('disputes:list', payload1);
    const etag2 = buildEtag('disputes:list', payload2);

    expect(etag1).not.toBe(etag2);
  });

  it('single-dispute ETag changes when the status field changes', () => {
    const id = DISPUTE_ID_1;

    const payload1 = { dispute: { id, status: 'open', createdAt: '2026-01-01T00:00:00.000Z' } };
    const payload2 = { dispute: { id, status: 'under_review', createdAt: '2026-01-01T00:00:00.000Z' } };

    const etag1 = buildEtag(`disputes:item:${id}`, payload1);
    const etag2 = buildEtag(`disputes:item:${id}`, payload2);

    expect(etag1).not.toBe(etag2);
  });

  it('single-dispute ETag changes when the createdAt field changes', () => {
    const id = DISPUTE_ID_1;

    const payload1 = { dispute: { id, status: 'open', createdAt: '2026-01-01T00:00:00.000Z' } };
    const payload2 = { dispute: { id, status: 'open', createdAt: '2026-06-01T00:00:00.000Z' } };

    const etag1 = buildEtag(`disputes:item:${id}`, payload1);
    const etag2 = buildEtag(`disputes:item:${id}`, payload2);

    expect(etag1).not.toBe(etag2);
  });

  it('ETag changes when the dispute ID changes (scope includes the ID)', () => {
    const samePayload = { dispute: { status: 'open', createdAt: '2026-01-01T00:00:00.000Z' } };

    const etag1 = buildEtag(`disputes:item:${DISPUTE_ID_1}`, samePayload);
    const etag2 = buildEtag(`disputes:item:${DISPUTE_ID_2}`, samePayload);

    expect(etag1).not.toBe(etag2);
  });
});

// ── Non-read endpoints must NOT emit the disputes-specific ETag ───────────────

describe('Non-read endpoints — no disputes ETag header', () => {
  it('POST /api/v1/disputes does not emit a disputes ETag', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .send({
        contractId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        reason: 'Payment dispute for completed work',
      });

    expect(res.status).toBe(201);
    // We set app.set('etag', false) so no auto-ETag is generated either
    expect(res.headers['etag']).toBeUndefined();
  });

  it('PATCH /api/v1/disputes/:id does not emit a disputes ETag', async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/${DISPUTE_ID_1}`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeUndefined();
  });

  it('DELETE /api/v1/disputes/:id does not emit a disputes ETag', async () => {
    const res = await request(app)
      .delete(`/api/v1/disputes/${DISPUTE_ID_1}`);

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeUndefined();
  });
});

// ── ETag header format validation ─────────────────────────────────────────────

describe('ETag header format', () => {
  it('list ETag is a strong quoted string (no W/ prefix)', async () => {
    const res = await request(app).get('/api/v1/disputes');
    const etag = res.headers['etag'] as string;

    // Must start with " (strong ETag, not W/"…")
    expect(etag).toMatch(/^"/);
    expect(etag).not.toMatch(/^W\//);
  });

  it('single-dispute ETag is a strong quoted string (no W/ prefix)', async () => {
    const res = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_1}`);
    const etag = res.headers['etag'] as string;

    expect(etag).toMatch(/^"/);
    expect(etag).not.toMatch(/^W\//);
  });

  it('list ETag is non-empty between the quotes', async () => {
    const res = await request(app).get('/api/v1/disputes');
    const etag = res.headers['etag'] as string;

    // Remove surrounding quotes and verify content is non-empty
    const inner = etag.replace(/^"|"$/g, '');
    expect(inner.length).toBeGreaterThan(0);
  });

  it('single-dispute ETag is non-empty between the quotes', async () => {
    const res = await request(app).get(`/api/v1/disputes/${DISPUTE_ID_1}`);
    const etag = res.headers['etag'] as string;

    const inner = etag.replace(/^"|"$/g, '');
    expect(inner.length).toBeGreaterThan(0);
  });
});

// ── 304 response contract ─────────────────────────────────────────────────────

describe('304 response contract', () => {
  it('list 304 response has no body content', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
    expect(Object.keys(res.body).length).toBe(0);
  });

  it('single-dispute 304 response has no body content', async () => {
    const res = await request(app)
      .get(`/api/v1/disputes/${DISPUTE_ID_1}`)
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
    expect(Object.keys(res.body).length).toBe(0);
  });

  it('list still emits ETag on 304', async () => {
    const res = await request(app)
      .get('/api/v1/disputes')
      .set('If-None-Match', '*');

    // Even on 304, the ETag header should be present (set before the check)
    expect(res.status).toBe(304);
    expect(res.headers['etag']).toBeDefined();
  });

  it('single-dispute still emits ETag on 304', async () => {
    const res = await request(app)
      .get(`/api/v1/disputes/${DISPUTE_ID_1}`)
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
    expect(res.headers['etag']).toBeDefined();
  });
});
