import { NextFunction, Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { mapErrorToPayload } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';

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
   * Retrieve a freelancer's aggregated reputation profile.
   */
  public static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const profile = ReputationService.getProfile(req.params.id);
      res.status(200).json({ status: 'success', data: profile });
    } catch (error) {
      sendError(res, error);
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
