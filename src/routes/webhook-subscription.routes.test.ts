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
    // Set up environment overrides
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
    it('lists and filters subscriptions', async () => {
      const response = await request(app)
        .get('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ eventType: 'contract.created' });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/webhook-subscriptions/:id', () => {
    it('returns a subscription by id', async () => {
      // 1. Create one
      const createResponse = await request(app)
        .post('/api/v1/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          url: 'https://example.com/webhook-get',
          eventType: 'contract.updated',
        });
      const subId = createResponse.body.data.id;

      // 2. Fetch it
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
