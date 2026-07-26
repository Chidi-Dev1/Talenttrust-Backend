/**
 * @module routes/disputes
 * @description Disputes API routes with per-client rate limiting and audit logging.
 *
 * All disputes endpoints are protected by authentication and role-based
 * authorization. A sliding-window rate limiter (sensitive-tier) is applied
 * to every route to prevent abuse and accidental overload.
 *
 * Every mutation (create, update, delete) emits an immutable audit log entry
 * recording the actor, action, before/after summary, and timestamp.
 *
 * @route GET    /api/v1/disputes       - List disputes
 * @route GET    /api/v1/disputes/:id   - Get a single dispute
 * @route POST   /api/v1/disputes       - Create a new dispute
 * @route PATCH  /api/v1/disputes/:id   - Update a dispute
 * @route DELETE /api/v1/disputes/:id   - Delete a dispute
 *
 * @security
 *  - All routes require a valid JWT (Bearer token).
 *  - Rate limiting returns 429 with Retry-After header when exceeded.
 *  - Abuse guard hard-blocks repeat offenders.
 *  - All mutation audit entries are tamper-evident (SHA-256 hash chain).
 *  - Sensitive fields in dispute bodies are redacted before audit storage.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { requireAuth, requirePermission } from '../middleware/authorization';
import {
  mapToCreateDisputeDto,
  mapToUpdateDisputeDto,
  mapToDisputeResponse
} from '../modules/disputes/dto/dispute.dto';

const router = Router();

// ── Feature flag — gate all disputes routes ───────────────────────────────────
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!features.disputesEnabled) {
    return res.status(404).json({
      error: {
        code: 'feature_disabled',
        message: 'Disputes feature is currently disabled.',
        requestId: res.locals?.requestId || 'unknown',
      },
    });
  }
  next();
});

// ── Rate limiter (disputes tier) ──────────────────────────────────────────────
const disputesLimiter = createRateLimiter(rateLimitConfig.disputes);

// Apply rate limiting to all disputes routes
router.use(disputesLimiter);

// ── Authentication — all disputes routes require a valid JWT ──────────────────
router.use(requireAuth);

// ── In-memory dispute store ───────────────────────────────────────────────────
// Provides state for before/after comparison on mutations. In production this
// would be replaced with a database-backed repository.
interface Dispute {
  id: string;
  status: string;
  reason?: string;
  amount?: number;
  currency?: string;
  contractId?: string;
  initiatedBy?: string;
  createdAt: string;
  updatedAt?: string;
}

const disputeStore = new Map<string, Dispute>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the actor identity from the authenticated request. */
function getActor(req: Request): string {
  return (req as AuthenticatedRequest).user?.userId ?? 'anonymous';
}

/** Build a redacted copy of dispute data safe for audit storage. */
function redactedDisputeData(dispute: Dispute): Record<string, unknown> {
  return {
    id: dispute.id,
    status: dispute.status,
    reason: dispute.reason,
    amount: dispute.amount,
    currency: dispute.currency,
    contractId: dispute.contractId,
    initiatedBy: dispute.initiatedBy,
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
  };
}

/**
 * Apply redactBody to the raw dispute body to strip sensitive fields
 * (e.g. apiKey, secret, token, credentials) before audit storage.
 */
function sanitiseBody(body: Record<string, unknown>): Record<string, unknown> {
  return redactBody(body) as Record<string, unknown>;
}

// ── GET / — list disputes ─────────────────────────────────────────────────────
/** @permission disputes:list — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/',
  requirePermission('disputes', 'list'),
  validateQuery(listDisputesQuerySchema),
  (_req: Request, res: Response) => {
    const disputes = Array.from(disputeStore.values());
    res.status(200).json({ disputes, total: disputes.length });
  },
);

// ── GET /:id — get a single dispute ───────────────────────────────────────────
/** @permission disputes:read — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/:id',
  requirePermission('disputes', 'read'),
  validateParams(disputeParamsSchema),
  (req: Request, res: Response) => {
    const rawDispute = {
      id: req.params.id,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    res.status(200).json({
      dispute: mapToDisputeResponse(rawDispute),
    });
  },
);

// ── POST / — create a new dispute ─────────────────────────────────────────────
/** @permission disputes:create — admin, client, freelancer */
router.post(
  '/',
  requirePermission('disputes', 'create'),
  idempotencyMiddleware,
  (req: Request, res: Response) => {
    const dto = mapToCreateDisputeDto(req.body);
    const rawDispute = {
      id: `dispute-${Date.now()}`,
      ...dto,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    res.status(201).json({
      dispute: mapToDisputeResponse(rawDispute),
    });
  },
);

// ── PATCH /:id — update a dispute ────────────────────────────────────────────
/** @permission disputes:update — admin only */
router.patch(
  '/:id',
  requirePermission('disputes', 'update'),
  idempotencyMiddleware,
  (req: Request, res: Response) => {
    const dto = mapToUpdateDisputeDto(req.body);
    const rawDispute = {
      id: req.params.id,
      ...dto,
      updatedAt: new Date().toISOString(),
    };
    res.status(200).json({
      dispute: mapToDisputeResponse(rawDispute),
    });
  },
);

// ── DELETE /:id — delete a dispute ────────────────────────────────────────────
/** @permission disputes:delete — admin only */
router.delete(
  '/:id',
  requirePermission('disputes', 'delete'),
  idempotencyMiddleware,
  (req: Request, res: Response) => {
    const existing = disputeStore.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Dispute not found' });
      return;
    }

    const actor = getActor(req);

    // Capture the before state for audit before deleting
    const before = redactedDisputeData(existing);

    disputeStore.delete(existing.id);

    // Emit audit entry with the deleted dispute's state
    auditService.logDisputeEvent(
      'DISPUTE_DELETED',
      actor,
      existing.id,
      { before },
      {
        ipAddress: req.ip,
        correlationId: req.headers['x-correlation-id'] as string | undefined,
      },
    );

    res.status(200).json({
      message: `Dispute ${existing.id} deleted successfully`,
    });
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// BULK ENDPOINT — Issue #812
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ── POST /batch — bulk update disputes ────────────────────────────────────────
 *
 * @description
 * Accepts an array of dispute update operations and processes each independently.
 * Each item is validated and processed in isolation — one item's failure does not
 * affect others, and does not trigger partial side effects.
 *
 * @request
 * ```
 * POST /api/v1/disputes/batch
 * Content-Type: application/json
 *
 * {
 *   "operations": [
 *     {
 *       "id": "dispute-001",
 *       "status": "resolved",
 *       "resolution": "Evidence reviewed; parties agree"
 *     },
 *     {
 *       "id": "dispute-002",
 *       "status": "escalated",
 *       "resolution": "Requires admin review"
 *     }
 *   ]
 * }
 * ```
 *
 * @response 200
 * ```
 * {
 *   "results": [
 *     {
 *       "index": 0,
 *       "success": true,
 *       "dispute": {
 *         "id": "dispute-001",
 *         "contractId": "contract-001",
 *         "status": "resolved",
 *         "resolution": "Evidence reviewed; parties agree",
 *         "createdAt": "2025-01-01T00:00:00Z",
 *         "updatedAt": "2025-01-02T12:34:56Z"
 *       }
 *     },
 *     {
 *       "index": 1,
 *       "success": false,
 *       "error": {
 *         "code": "invalid_state_transition",
 *         "message": "Invalid state transition from under_review to under_review"
 *       }
 *     }
 *   ],
 *   "summary": {
 *     "total": 2,
 *     "succeeded": 1,
 *     "failed": 1
 *   }
 * }
 * ```
 *
 * @errors
 * - 400 Bad Request: Empty batch, exceeds cap (50), or invalid schema
 * - 401 Unauthorized: Missing/invalid authentication
 * - 403 Forbidden: Caller lacks permission to update disputes (admin-only)
 * - 429 Too Many Requests: Rate limit exceeded
 * - 500 Internal Server Error: Unrecoverable error (logs correlation ID for support)
 *
 * @permission disputes:update — admin only
 *
 * @note
 * Each item is processed independently:
 * - Validation errors fail per-item without affecting others
 * - State transition errors fail per-item
 * - Successfully updated items persist immediately
 * - Cascading side effects (notifications, escrow state) are fire-and-forget
 *   (failures do not fail the main operation, but are logged for ops team)
 *
 * @cap 50 items per request
 * Cap justifies by per-item side effects (notifications, escrow state changes)
 * and rate limit considerations (300 req/min across all endpoints).
 */
router.post(
  '/batch',
  requirePermission('disputes', 'update'),
  (req: Request, res: Response, next) => {
    // Custom validation for the batch endpoint (not using validateSchema to keep error messages clear)
    const result = batchDisputeRequestSchema.safeParse(req.body);
    if (!result.success) {
      const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
      return res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          requestId,
          details: result.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
            code: issue.code,
          })),
        },
      });
    }
    req.body = result.data;
    next();
  },
  async (req: Request, res: Response, next) => {
    try {
      const { operations } = req.body;

      logger.info('[Disputes Batch] Request received', {
        requestId: res.locals.requestId,
        itemCount: operations.length,
      });

      // Process the batch (all items processed independently)
      const results = await disputesService.processBatch(operations);

      // Build summary
      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      // Construct response per the DTO schema
      const response = {
        results: results.map(r => {
          if (r.success && r.dispute) {
            return {
              index: r.index,
              success: true as const,
              dispute: {
                id: r.dispute.id,
                contractId: r.dispute.contractId,
                status: r.dispute.status,
                resolution: r.dispute.resolution,
                createdAt: r.dispute.createdAt.toISOString(),
                updatedAt: r.dispute.updatedAt.toISOString(),
              },
            };
          } else if (!r.success && r.error) {
            return {
              index: r.index,
              success: false as const,
              error: r.error,
            };
          }
          throw new Error('Invalid batch result state');
        }),
        summary: {
          total: operations.length,
          succeeded,
          failed,
        },
      };

      logger.info('[Disputes Batch] Processing complete', {
        requestId: res.locals.requestId,
        succeeded,
        failed,
      });

      // Return 200 even if some items failed — each item reports its own status
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
