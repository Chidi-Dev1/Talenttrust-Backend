/**
 * Integration tests for the Webhook Subscription API
 *
 * Covers:
 *  POST   /api/v1/webhook-subscriptions
 *    - 401 no token / malformed header / expired token / wrong secret
 *    - 403 non-admin role (client, freelancer)
 *    - 400 missing required fields (url, eventType)
 *    - 400 invalid URL format
 *    - 400 SSRF-unsafe private URL
 *    - 400 empty eventType / eventType too long
 *    - 400 secret too long / secret empty string
 *    - 400 consumerId present but not a UUID
 *    - 201 success + full response shape
 *    - 201 success without optional secret
 *    - 201 created subscription is active=true by default
 *    - Idempotent-repeat: creating with same URL+eventType returns new distinct id (no server-side dedup)
 *
 *  GET    /api/v1/webhook-subscriptions
 *    - 401 / 403 guards
 *    - 200 empty list when no subscriptions exist
 *    - 200 full list
 *    - 200 filtered by eventType
 *    - 200 filtered by active flag
 *    - 400 invalid active query param value
 *    - 400 consumerId present but not a UUID
 *    - Response envelope shape
 *
 *  GET    /api/v1/webhook-subscriptions/:id
 *    - 401 / 403 guards
 *    - 200 returns correct record
 *    - 200 response shape (all expected fields present)
 *    - 404 unknown UUID
 *    - 400 id is not a valid UUID (validation error)
 *
 *  PATCH  /api/v1/webhook-subscriptions/:id
 *    - 401 / 403 guards
 *    - 200 partial update (url only)
 *    - 200 partial update (active flag only)
 *    - 200 partial update (eventType only)
 *    - 200 full update
 *    - 404 unknown id
 *    - 400 invalid URL format in body
 *    - 400 SSRF-unsafe URL in body
 *    - 400 id param not a UUID
 *    - 400 empty body is accepted (no-op update)
 *
 *  DELETE /api/v1/webhook-subscriptions/:id
 *    - 401 / 403 guards
 *    - 200 deletes and confirms
 *    - 404 deleting twice (idempotent-repeat → second call is 404)
 *    - 404 unknown UUID
 *    - 400 id param not a UUID
 */

// Set env vars before any module import so singletons pick them up
process.env.JWT_SECRET = 'webhook-routes-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createApp } from '../app';
import { getDb, closeDb } from '../db/database';

// ─── Constants ────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    process.env.JWT_SECRET = 'super-secret';
    process.env.DB_PATH = ':memory:';
    db = getDb();
    app = createApp({ includeTerminalHandlers: true });

// ─── Token helpers ────────────────────────────────────────────────────────────

function makeToken(
  role: string,
  sub = 'user-1',
  expiresIn: string | number = '1h',
): string {
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, {
    expiresIn,
  } as jwt.SignOptions) as string;
}

const adminToken = () => makeToken('admin', 'admin-uuid');
const clientToken = () => makeToken('client', 'client-uuid');
const freelancerToken = () => makeToken('freelancer', 'freelancer-uuid');

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

const validCreate = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://example.com/hook',
  eventType: 'contract.created',
  ...overrides,
});

// ─── App / DB lifecycle ───────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  getDb(); // run migrations
  app = createApp({ includeTerminalHandlers: true });
});

beforeEach(() => {
  getDb().exec('DELETE FROM webhook_subscriptions');
});

afterAll(() => {
  closeDb();
});

// ─── Helper: create a subscription as admin ───────────────────────────────────

async function createSub(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post(BASE)
    .set(auth(adminToken()))
    .send(validCreate(overrides));
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

// =============================================================================
// POST /api/v1/webhook-subscriptions
// =============================================================================

describe('POST /api/v1/webhook-subscriptions', () => {
  // ── Auth / RBAC ─────────────────────────────────────────────────────────────

  it('returns 401 when no Authorization header is present', async () => {
    const res = await request(app).post(BASE).send(validCreate());
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthorized');
  });

  it('returns 401 for a malformed Authorization header (no Bearer prefix)', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', 'Token not-a-jwt')
      .send(validCreate());
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const expired = makeToken('admin', 'admin-uuid', -1);
    const res = await request(app)
      .post(BASE)
      .set(auth(expired))
      .send(validCreate());
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/expired/i);
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { sub: 'x', email: 'x@x.com', role: 'admin' },
      'wrong-secret',
    );
    const res = await request(app)
      .post(BASE)
      .set(auth(forged))
      .send(validCreate());
    expect(res.status).toBe(401);
  });

  it('returns 403 for a client role', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(clientToken()))
      .send(validCreate());
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
  });

  it('returns 403 for a freelancer role', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(freelancerToken()))
      .send(validCreate());
    expect(res.status).toBe(403);
  });

  describe('GET /api/v1/webhook-subscriptions', () => {
    it('lists and filters subscriptions (backward-compatible)', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ eventType: 'contract.created' });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('data');
      expect(Array.isArray(response.body.data.data)).toBe(true);
      expect(response.body.data.data.length).toBeGreaterThan(0);
    });

    it('returns empty result set when no subscriptions match', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ consumerId: crypto.randomUUID() });
      expect(response.status).toBe(200);
      expect(response.body.data.data).toEqual([]);
      expect(response.body.data.hasNextPage).toBe(false);
      expect(response.body.data.nextCursor).toBeNull();
    });

    it('returns first page with default limit', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('nextCursor');
      expect(response.body.data).toHaveProperty('hasNextPage');
      expect(response.body.data).toHaveProperty('limit');
      expect(typeof response.body.data.limit).toBe('number');
    });
  });

  describe('Cursor pagination', () => {
    const createdIds: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 25; i++) {
        const res = await request(app)
          .post('/api/v1/webhook-subscriptions')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            url: `https://example.com/cursor-test-${i}`,
            eventType: 'cursor.test',
          });
        createdIds.push(res.body.data.id);
      }
    });

    it('respects limit parameter', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 5, eventType: 'cursor.test' });
      expect(response.status).toBe(200);
      expect(response.body.data.data.length).toBe(5);
      expect(response.body.data.limit).toBe(5);
    });

    it('paginates across multiple pages', async () => {
      const page1 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 10, eventType: 'cursor.test' });
      expect(page1.status).toBe(200);
      expect(page1.body.data.data.length).toBe(10);
      expect(page1.body.data.hasNextPage).toBe(true);
      expect(page1.body.data.nextCursor).toBeTruthy();

      const page2 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 10, cursor: page1.body.data.nextCursor, eventType: 'cursor.test' });
      expect(page2.status).toBe(200);
      expect(page2.body.data.data.length).toBe(10);
      expect(page2.body.data.hasNextPage).toBe(true);

      const page3 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 10, cursor: page2.body.data.nextCursor, eventType: 'cursor.test' });
      expect(page3.status).toBe(200);
      expect(page3.body.data.data.length).toBe(5);
      expect(page3.body.data.hasNextPage).toBe(false);
      expect(page3.body.data.nextCursor).toBeNull();
    });

    it('exact page boundary returns correct nextCursor', async () => {
      const page = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 5, eventType: 'cursor.test' });
      expect(page.body.data.data.length).toBe(5);
      expect(page.body.data.hasNextPage).toBe(true);
      expect(page.body.data.nextCursor).toBeTruthy();
    });

    it('last page has no nextCursor', async () => {
      const page = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 25, eventType: 'cursor.test' });
      expect(page.body.data.data.length).toBe(25);
      expect(page.body.data.hasNextPage).toBe(false);
      expect(page.body.data.nextCursor).toBeNull();
    });

    it('rejects invalid cursor with 400', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ cursor: 'not-a-valid-cursor!!!' });
      expect(response.status).toBe(400);
    });

    it('rejects limit exceeding maximum', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 200 });
      expect(response.status).toBe(400);
    });

    it('preserves stable ordering across pages', async () => {
      const page1 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 8, eventType: 'cursor.test' });
      const page2 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 8, cursor: page1.body.data.nextCursor, eventType: 'cursor.test' });
      const page3 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 8, cursor: page2.body.data.nextCursor, eventType: 'cursor.test' });
      const page4 = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 8, cursor: page3.body.data.nextCursor, eventType: 'cursor.test' });

      const allIds = [
        ...page1.body.data.data.map((s: any) => s.id),
        ...page2.body.data.data.map((s: any) => s.id),
        ...page3.body.data.data.map((s: any) => s.id),
        ...page4.body.data.data.map((s: any) => s.id),
      ];

      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it('no duplicate or skipped records across pages', async () => {
      const allItems: any[] = [];
      let cursor: string | undefined;
      while (true) {
        const query: any = { limit: 7, eventType: 'cursor.test' };
        if (cursor) query.cursor = cursor;
        const res = await request(app)
          .get('/api/v1/webhook-subscriptions')
          .set('Authorization', `Bearer ${adminToken}`)
          .query(query);
        allItems.push(...res.body.data.data);
        if (!res.body.data.hasNextPage) break;
        cursor = res.body.data.nextCursor;
      }

      expect(allItems.length).toBe(25);
      const ids = allItems.map((s: any) => s.id);
      expect(new Set(ids).size).toBe(25);
    });
  });

  describe('GET /api/v1/webhook-subscriptions/:id', () => {
    it('returns a subscription by id', async () => {
      const createResponse = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          url: 'https://example.com/webhook-get',
          eventType: 'contract.updated',
        });
      const subId = createResponse.body.data.id;

      const response = await request(app)
        .get(`/api/v1/webhook-subscriptions/${subId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(subId);
    });

    it('returns 404 for missing subscription', async () => {
      const response = await request(app)
        .get(`/api/v1/webhook-subscriptions/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(response.status).toBe(404);
    });
  });

  it('returns 400 when url is not a valid URL string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ url: 'not-a-url' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when eventType is an empty string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ eventType: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when eventType exceeds 100 characters', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ eventType: 'x'.repeat(101) }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when secret is an empty string', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ secret: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when secret exceeds 256 characters', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ secret: 'a'.repeat(257) }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('returns 400 when consumerId is present but not a UUID', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ consumerId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  // ── SSRF guard ──────────────────────────────────────────────────────────────

  it('returns 400 with error code invalid_url for a private IP (SSRF)', async () => {
    const original = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';
    try {
      const res = await request(app)
        .post(BASE)
        .set(auth(adminToken()))
        .send(validCreate({ url: 'http://127.0.0.1/hook' }));
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('invalid_url');
    } finally {
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = original;
    }
  });

  it('returns 400 with error code invalid_url for a link-local address (SSRF)', async () => {
    const original = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';
    try {
      const res = await request(app)
        .post(BASE)
        .set(auth(adminToken()))
        .send(validCreate({ url: 'http://169.254.169.254/latest/meta-data' }));
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('invalid_url');
    } finally {
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = original;
    }
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  it('returns 201 and full response shape for a valid payload', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ secret: 'shh' }));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');

    const data = res.body.data;
    expect(data).toHaveProperty('id');
    expect(typeof data.id).toBe('string');
    expect(data.url).toBe('https://example.com/hook');
    expect(data.eventType).toBe('contract.created');
    expect(data.active).toBe(true);
    expect(data).toHaveProperty('createdAt');
    expect(data).toHaveProperty('updatedAt');
    // Secret must NOT be returned in the response
    expect(data.secret).toBeUndefined();
  });

  it('returns 201 without optional fields (no secret, no consumerId)', async () => {
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send({ url: 'https://example.com/no-secret', eventType: 'contract.updated' });
    expect(res.status).toBe(201);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.consumerId).toBeUndefined();
  });

  it('returns 201 with consumerId when a valid UUID is supplied', async () => {
    const consumerId = crypto.randomUUID();
    const res = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(validCreate({ consumerId }));
    expect(res.status).toBe(201);
    expect(res.body.data.consumerId).toBe(consumerId);
  });

  it('two POSTs with identical url+eventType produce two separate subscriptions (no server-side dedup)', async () => {
    const payload = validCreate();
    const r1 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(payload);
    const r2 = await request(app)
      .post(BASE)
      .set(auth(adminToken()))
      .send(payload);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.id).not.toBe(r2.body.data.id);
  });
});