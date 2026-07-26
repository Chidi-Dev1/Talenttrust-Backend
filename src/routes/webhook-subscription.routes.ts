import { Router, Response } from 'express';
import { getDb } from '../db/database';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';
import { validateSchema } from '../middleware/validate.middleware';
import { requireAuth, requireRole } from '../middleware/authorization';
import { decodeCursor } from '../contracts/cursor.repository';
import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema,
  getWebhookSubscriptionSchema,
  listWebhookSubscriptionsQuerySchema,
  toCreateWebhookSubscriptionDto,
  toUpdateWebhookSubscriptionDto,
  toWebhookSubscriptionResponseDto,
  toListWebhookSubscriptionsQueryDto,
} from '../modules/webhooks/dto/webhook-subscription.dto';
import { AuthenticatedRequest } from '../lib/types';
import { validateWebhookUrl, findSubscriptionOrFail } from './webhook-subscription.validation';

const router = Router();

// DB and Repository setup is resolved at registration / execution time
const getRepo = () => new SqliteWebhookSubscriptionRepository(getDb());


/**
 * POST /api/v1/webhook-subscriptions
 * Creates a new webhook subscription. Admins can create subscription for any consumer,
 * but let's restrict it to admin-only or authenticated users.
 */
router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validateSchema(createWebhookSubscriptionSchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { url } = req.body;
      if (!validateWebhookUrl(url, res)) return;

      const repo = getRepo();
      const createDto = toCreateWebhookSubscriptionDto(req.body);
      const subscription = await repo.create(createDto);
      res.status(201).json({
        status: 'success',
        data: toWebhookSubscriptionResponseDto(subscription),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/webhook-subscriptions
 * Lists subscriptions with filter and cursor-based pagination support
 */
router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  validateSchema(listWebhookSubscriptionsQuerySchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const repo = getRepo();
      const query = toListWebhookSubscriptionsQueryDto(req.query as any);
      const { cursor: cursorStr, limit, ...filters } = query;
      if (cursorStr !== undefined) {
        try {
          decodeCursor(cursorStr);
        } catch (err) {
          return res.status(400).json({
            error: {
              code: 'invalid_cursor',
              message: (err as Error).message,
              requestId: res.locals.requestId || 'unknown',
            },
          });
        }
      }
      const filter = {
        consumerId: filters.consumerId,
        eventType: filters.eventType,
        active: filters.active,
      };
      const list = await repo.findAllPaginated(filter, { cursor: cursorStr, limit });
      res.status(200).json({
        status: 'success',
        data: {
          data: list.data.map((subscription) => toWebhookSubscriptionResponseDto(subscription)),
          nextCursor: list.nextCursor,
          hasNextPage: list.hasNextPage,
          limit: list.limit,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/webhook-subscriptions/:id
 * Retrieves a single subscription
 */
router.get(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validateSchema(getWebhookSubscriptionSchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const repo = getRepo();
      const subscription = await findSubscriptionOrFail(id, repo, res);
      if (!subscription) return;

      res.status(200).json({
        status: 'success',
        data: toWebhookSubscriptionResponseDto(subscription),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/webhook-subscriptions/:id
 * Updates a subscription
 */
router.patch(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validateSchema(updateWebhookSubscriptionSchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const { url } = req.body;

      if (url !== undefined && !validateWebhookUrl(url, res)) return;

      const repo = getRepo();
      const existing = await findSubscriptionOrFail(id, repo, res);
      if (!existing) return;

      const updateDto = toUpdateWebhookSubscriptionDto(req.body);
      const updated = await repo.update(id, updateDto);
      res.status(200).json({
        status: 'success',
        data: toWebhookSubscriptionResponseDto(updated),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/webhook-subscriptions/:id
 * Deletes a subscription
 */
router.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validateSchema(getWebhookSubscriptionSchema),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { id } = req.params;
      const repo = getRepo();
      if (!(await findSubscriptionOrFail(id, repo, res))) return;

      await repo.delete(id);
      res.status(200).json({
        status: 'success',
        data: {
          id,
          deleted: true,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as webhookSubscriptionRouter };
export default router;
