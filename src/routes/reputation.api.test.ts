import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_SECRET = TEST_SECRET;

import reputationRoutes from './reputation.routes';
import { reputationStore } from '../models/reputation.store';

const adminToken = jwt.sign({ sub: 'admin-1', email: 'admin@tt.com', role: 'admin' }, TEST_SECRET, { expiresIn: '1h' });

describe('Reputation API Integration Tests', () => {
  const freelancerId = 'api-user-123';
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);
    reputationStore.clear();
  });

  describe('GET /api/v1/reputation/:id', () => {
    it('should return a default profile for a new user', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.freelancerId).toBe(freelancerId);
      expect(response.body.data.score).toBe(0);
      expect(response.body.data.totalRatings).toBe(0);
    });

    // ── Cursor pagination query param tests ───────────────────────────
    it('should accept limit query param and return paginated response', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}?limit=5`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('nextCursor');
      expect(response.body.data).toHaveProperty('hasNextPage');
      expect(response.body.data).toHaveProperty('limit');
      expect(response.body.data.limit).toBe(5);
    });

    it('should return 400 for invalid cursor', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}?cursor=invalid!!!`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('bad_request');
    });

    it('should return 400 for limit exceeding max (101)', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}?limit=101`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('bad_request');
    });

    it('should return 400 for limit = 0', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}?limit=0`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(400);
    });

    it('should return 400 for negative limit', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}?limit=-5`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(400);
    });

    it('should return 400 for non-numeric limit', async () => {
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}?limit=abc`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/v1/reputation/:id', () => {
    it('should fail with 400 for invalid payload (missing rating)', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1' });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
    });
 
    it('should fail with 400 for invalid rating bounds', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1', rating: 10 });
      
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Validation failed');
    });

    it('should successfully update and return the new profile', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1', rating: 5, comment: 'Awesome', jobCompleted: true });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.score).toBe(5);
      expect(response.body.data.jobsCompleted).toBe(1);
    });

    it('should handle sequential updates correctly via the API', async () => {
      await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1', rating: 3, jobCompleted: true });

      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-2', rating: 4, jobCompleted: true });

      expect(response.status).toBe(200);
      expect(response.body.data.score).toBe(3.5);
      expect(response.body.data.totalRatings).toBe(2);
      expect(response.body.data.jobsCompleted).toBe(2);
    });
  });
});
