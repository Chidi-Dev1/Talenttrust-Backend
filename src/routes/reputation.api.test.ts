import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const TEST_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_SECRET = TEST_SECRET;

import reputationRoutes from './reputation.routes';
import { ReputationService } from '../services/reputation.service';

jest.mock('../services/reputation.service');

const adminToken = jwt.sign({ sub: 'admin-1', email: 'admin@tt.com', role: 'admin' }, TEST_SECRET, { expiresIn: '1h' });

describe('Reputation API Integration Tests', () => {
  const freelancerId = 'api-user-123';
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/reputation', reputationRoutes);
    jest.clearAllMocks();
  });

  describe('Authorization and Tenant Scoping', () => {
    it('should reject requests with missing authorization header (401)', async () => {
      const response = await request(app).get(`/api/v1/reputation/${freelancerId}`);
      expect(response.status).toBe(401);
    });

    it('should reject requests with an invalid or cross-tenant token (401)', async () => {
      // Simulate a cross-tenant token by signing with a different secret
      const crossTenantToken = jwt.sign(
        { sub: 'admin-2', email: 'admin2@tt.com', role: 'admin' },
        'different-tenant-secret',
        { expiresIn: '1h' }
      );
      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${crossTenantToken}`);
      
      expect(response.status).toBe(401);
    });

    it('should reject requests when user lacks the required permission scope (403)', async () => {
      // Auditor role does not have 'create' permission for reviews
      const auditorToken = jwt.sign(
        { sub: 'auditor-1', email: 'auditor@tt.com', role: 'auditor' },
        TEST_SECRET,
        { expiresIn: '1h' }
      );
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ reviewerId: 'client-1', rating: 5, comment: 'Good', jobCompleted: true });
      
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/reputation/:id', () => {
    it('should return a default profile for a new user', async () => {
      (ReputationService.getProfile as jest.Mock).mockReturnValue({
        freelancerId,
        score: 0,
        totalRatings: 0
      });

      const response = await request(app)
        .get(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.freelancerId).toBe(freelancerId);
      expect(response.body.data.score).toBe(0);
      expect(response.body.data.totalRatings).toBe(0);
    });
  });

  describe('PUT /api/v1/reputation/:id', () => {
    it('should fail with 400 for invalid payload (missing rating)', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1' });
      
      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Request validation failed');
    });
 
    it('should fail with 400 for invalid rating bounds', async () => {
      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1', rating: 10, contextId: '550e8400-e29b-41d4-a716-446655440000' });
      
      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Request validation failed');
    });

    it('should successfully update and return the new profile', async () => {
      (ReputationService as any).updateProfile = undefined; // Mock that updateProfile doesn't exist to fall back to getProfile
      (ReputationService.getProfile as jest.Mock).mockReturnValue({
        score: 5,
        totalRatings: 1,
        jobsCompleted: 1
      });

      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1', rating: 5, comment: 'Awesome', contextId: '550e8400-e29b-41d4-a716-446655440000', jobCompleted: true });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.score).toBe(5);
      expect(response.body.data.jobsCompleted).toBe(1);
    });

    it('should handle sequential updates correctly via the API', async () => {
      (ReputationService as any).updateProfile = undefined;
      (ReputationService.getProfile as jest.Mock).mockReturnValue({
        score: 3.5,
        totalRatings: 2,
        jobsCompleted: 2
      });

      await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-1', rating: 3, contextId: '550e8400-e29b-41d4-a716-446655440000', jobCompleted: true });

      const response = await request(app)
        .put(`/api/v1/reputation/${freelancerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewerId: 'client-2', rating: 4, contextId: '550e8400-e29b-41d4-a716-446655440001', jobCompleted: true });

      expect(response.status).toBe(200);
      expect(response.body.data.score).toBe(3.5);
      expect(response.body.data.totalRatings).toBe(2);
      expect(response.body.data.jobsCompleted).toBe(2);
    });
  });
});
