import { NextFunction, Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { mapErrorToPayload } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload } from './reputation.validation';
import { resolveCursorQueryParam, parseLimit } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';

/**
 * @title Reputation Controller
 * @dev Thin HTTP adapter.
 *
 * All reputation business logic lives in {@link ReputationService}. This
 * controller only:
 *   1. extracts path parameters from the HTTP request,
 *   2. delegates to the service, and
 *   3. serializes the service's response (or thrown error) to JSON.
 *
 * Error serialization goes through the shared {@link mapErrorToPayload} helper
 * so that all endpoints emit the canonical `{ error: { code, message, requestId } }`
 * payload shape - matching every other controller in the codebase.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile with optional cursor pagination.
   *
   * Query params:
   *   - cursor  (optional, opaque string): anchor for the next page.
   *   - limit   (optional, positive integer 1-100, default 20): page size.
   */
  public static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';

      // ── Resolve cursor query parameter ──────────────────────────────────
      const cursorResult = resolveCursorQueryParam(req.query['cursor']);
      if (!cursorResult.ok) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: cursorResult.message,
            requestId,
          },
        });
        return;
      }

      // ── Resolve limit query parameter ───────────────────────────────────
      let limit = CURSOR_DEFAULT_LIMIT;
      try {
        limit = parseLimit(req.query['limit']);
      } catch (err: any) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: err.message,
            requestId,
          },
        });
        return;
      }

      const isPaginated =
        cursorResult.cursor !== undefined || req.query['limit'] !== undefined;

      if (isPaginated) {
        const profile = ReputationService.getProfilePaginated(id, {
          cursor: cursorResult.cursor,
          limit,
        });
        res.status(200).json({ status: 'success', data: profile });
      } else {
        const profile = ReputationService.getProfile(id);
        res.status(200).json({ status: 'success', data: profile });
      }
    } catch (error: any) {
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
      if (error.message === 'Freelancer ID is required') {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: error.message,
            requestId,
          },
        });
      } else {
        res.status(500).json({
          error: {
            code: 'internal_error',
            message: 'An unexpected error occurred',
            requestId,
          },
        });
      }
    }
  }

  /**
   * POST /api/v1/reputation/:id/rate / PUT /api/v1/reputation/:id
   * Record a new rating and return the recomputed profile.
   *
   * Payload validation is enforced at two layers:
   *  1. Zod DTO via `validateSchema` middleware (primary - rejects before
   *     this method runs).
   *  2. `ReputationService.updateProfile` (defense-in-depth - catches
   *     bypassed middleware or direct service callers).
   */
  public static async createRating(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const updatedProfile = ReputationService.updateProfile(req.params.id, req.body);
      res.status(200).json({ status: 'success', data: updatedProfile });
    } catch (error) {
      sendError(res, error);
    }
  }

  /**
   * POST /api/v1/reputation/bulk
   * Create multiple reputation ratings in a single request.
   *
   * Returns per-item results. HTTP 200 when all items succeed, 207 when some
   * items fail. Individual item failures never prevent other items from being
   * processed.
   */
  public static async createBulkRatings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { items } = req.body as { items: unknown[] };
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';

      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: 'Request body must contain a non-empty items array',
            requestId,
          },
        });
        return;
      }

      const validItems: Array<{ reviewerId: string; targetId: string; rating: number; contextId: string; comment?: string }> = [];
      const validationErrors: Array<{ index: number; error: { code: string; message: string } }> = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isValidReputationBulkItem(item)) {
          validItems.push(item);
        } else {
          validationErrors.push({
            index: i,
            error: {
              code: 'validation_error',
              message: 'Invalid item: reviewerId, targetId, contextId are required, and rating must be a finite integer (1–5)',
            },
          });
        }
      }

      const serviceResults = validItems.length > 0
        ? ReputationService.createBulkRatings(validItems)
        : [];

      const allResults: Array<{ index: number; success: boolean; data?: any; error?: { code: string; message: string } }> = [];

      let viIdx = 0;
      let valErrIdx = 0;
      for (let i = 0; i < items.length; i++) {
        if (valErrIdx < validationErrors.length && validationErrors[valErrIdx].index === i) {
          allResults.push({ index: i, success: false, error: validationErrors[valErrIdx].error });
          valErrIdx++;
        } else {
          allResults.push(serviceResults[viIdx]);
          viIdx++;
        }
      }

      const failures = allResults.filter((r) => !r.success);
      const statusCode = failures.length === 0 ? 200 : 207;

      res.status(statusCode).json({
        status: statusCode === 200 ? 'success' : 'partial_failure',
        data: allResults,
      });
    } catch (error) {
      handleControllerError(error, res);
    }
  }
}

/**
 * Single error-serialization boundary for reputation endpoints.
 *
 * Delegates to {@link mapErrorToPayload} so AppError subclasses, Zod errors,
 * and unknown errors all map to the same `{ error: { code, message, requestId } }`
 * shape used elsewhere in the codebase.
 */
function sendError(res: Response, error: unknown): void {
  const requestId =
    typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
  const { statusCode, payload } = mapErrorToPayload(error, requestId);
  res.status(statusCode).json(payload);
}
