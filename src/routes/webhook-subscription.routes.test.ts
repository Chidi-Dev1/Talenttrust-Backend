import request from 'supertest';
import { createApp, attachTerminalHandlers } from '../app';
import { getDb, closeDb } from '../db/database';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

describe('Webhook Subscription Routes (Integration)', () => {
  let app: any;
  let db: any;
  let adminToken: string;
  let clientToken: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'super-secret';
    process.env.DB_PATH = ':memory:';
    db = getDb();
    app = createApp({ includeTerminalHandlers: true });

    adminToken = jwt.sign(
      { sub: 'admin-uuid', email: 'admin@test.com', role: 'admin' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256' }
    );

    clientToken = jwt.sign(
      { sub: 'client-uuid', email: 'client@test.com', role: 'client' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256' }
    );
  });

  afterAll(async () => {
    closeDb();
  });

  describe('POST /api/v1/webhook-subscriptions', () => {
    it('requires authentication', async () => {
      const response = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .send({
          url: 'https://example.com/webhook',
          eventType: 'contract.created',
        });
      expect(response.status).toBe(401);
    });

    it('requires admin role', async () => {
      const response = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          url: 'https://example.com/webhook',
          eventType: 'contract.created',
        });
      expect(response.status).toBe(403);
    });

    it('creates a subscription for valid payloads', async () => {
      const response = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          url: 'https://example.com/webhook-created',
          eventType: 'contract.created',
          secret: 'shh-secret',
        });
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('success');
      expect(response.body.data.url).toBe('https://example.com/webhook-created');
      expect(response.body.data.eventType).toBe('contract.created');
      expect(response.body.data.active).toBe(true);
    });

    it('validates SSRF-unsafe URLs', async () => {
      const originalBypassVal = process.env.SSRF_ALLOW_PRIVATE_HOSTS;
      process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'false';
      try {
        const response = await request(app)
          .post('/api/v1/webhook-subscriptions')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            url: 'http://127.0.0.1/sensitive',
            eventType: 'contract.created',
          });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('invalid_url');
      } finally {
        process.env.SSRF_ALLOW_PRIVATE_HOSTS = originalBypassVal;
      }
    });
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

  describe('PATCH /api/v1/webhook-subscriptions/:id', () => {
    it('updates subscription parameters', async () => {
      const createResponse = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          url: 'https://example.com/webhook-update-target',
          eventType: 'contract.updated',
        });
      const subId = createResponse.body.data.id;

      const response = await request(app)
        .patch(`/api/v1/webhook-subscriptions/${subId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          active: false,
          url: 'https://example.com/webhook-updated-url',
        });
      expect(response.status).toBe(200);
      expect(response.body.data.active).toBe(false);
      expect(response.body.data.url).toBe('https://example.com/webhook-updated-url');
    });
  });

  describe('DELETE /api/v1/webhook-subscriptions/:id', () => {
    it('deletes a subscription', async () => {
      const createResponse = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          url: 'https://example.com/webhook-delete-target',
          eventType: 'contract.deleted',
        });
      const subId = createResponse.body.data.id;

      const response = await request(app)
        .delete(`/api/v1/webhook-subscriptions/${subId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(response.status).toBe(200);
      expect(response.body.data.deleted).toBe(true);

      const checkResponse = await request(app)
        .get(`/api/v1/webhook-subscriptions/${subId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(checkResponse.status).toBe(404);
    });
  });
});