import { Router } from 'express';
import { ReputationController } from '../controllers/reputation.controller';
import { registry } from '../docs/openapi-registry';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';
import { validateSchema } from '../middleware/validate.middleware';
import { createRateLimiter } from '../middleware/rateLimiter';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { rateLimitConfig } from '../config/rateLimit';
import { authRateLimitKeyFn } from '../auth/rateLimitKey';
import { z } from 'zod';

const router = Router();
const reputationLimiter = createRateLimiter({
  ...rateLimitConfig.reputation,
  keyFn: req => `reputation:${authRateLimitKeyFn(req)}`,
});

// Dedicated per-client limiter. Keys are namespaced because the store is shared.
router.use(reputationLimiter);

// ── Authentication guard — all reputation routes require a valid JWT ──────────
registry.registerPath({
  method: 'get',
  path: '/reputation/{id}',
  summary: 'Get freelancer reputation',
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    }
  ],
  responses: {
    200: {
      description: 'Freelancer reputation profile',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: {
                type: 'object',
                properties: {
                  freelancerId: { type: 'string' },
                  score: { type: 'number' },
                  totalRatings: { type: 'number' },
                  reviews: { type: 'array' }
                }
              }
            }
          }
        }
      }
    }
  }
});

registry.registerPath({
  method: 'post',
  path: '/reputation/{id}/rate',
  summary: 'Create reputation rating',
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' }
    }
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/UpdateReputation' }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Rating created successfully',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'success' },
              data: { type: 'object' }
            }
          }
        }
      }
    },
    400: { description: 'Invalid payload' },
    403: { description: 'Forbidden - self-rating or unauthorized' },
    409: { description: 'Conflict - duplicate rating' },
    422: { description: 'Validation error' }
  }
});

export function createReputationRouter(
  options: ReputationObservabilityOptions = {},
): Router {
  const router = Router();

  // Run before auth and validation so 401/400 responses are observable too.
  router.use(createReputationObservabilityMiddleware(options));
  router.use(requireAuth);

  // GET /api/v1/reputation/:id - Retrieve reputation for a freelancer
  // All authenticated roles (admin, client, freelancer) may read reviews.
  router.get('/:id', requirePermission('reviews', 'read'), ReputationController.getProfile);

  // PUT /api/v1/reputation/:id - Submit a reputation review for a freelancer.
  // Requires 'reviews.create' permission — granted to admin, client, freelancer.
  router.put(
    '/:id',
    requirePermission('reviews', 'create'),
    validateSchema(z.object({ body: updateReputationSchema, params: z.object({ id: z.string().min(1) }) })),
    ReputationController.createRating
  );

  return router;
}

const router = createReputationRouter();

export default router;
