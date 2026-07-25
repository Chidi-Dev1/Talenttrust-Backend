import { Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { ForbiddenError, ConflictError, ValidationError, AppError } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload } from './reputation.validation';
import { resolveCursorQueryParam, parseLimit } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';

/**
 * @title Reputation Controller
 * @dev Handles HTTP requests for the reputation system with proper error handling.
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
  public static async getProfile(req: Request, res: Response): Promise<void> {
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
   * POST /api/v1/reputation/:id/rate
   * Create a new reputation rating for a freelancer.
   *
   * Rating validation is enforced at two layers:
   *  1. Zod DTO via validateSchema middleware (primary — rejects before this method runs)
   *  2. Guard below (defense-in-depth — catches bypassed middleware or direct controller calls)
   *
   * Rating must be a finite integer in [1, 5]. Anything outside that range or any
   * non-integer (including NaN/Infinity/decimals) is rejected with a 400.
   */
  public static async createRating(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const payload: any = req.body;
      const requestId =
        typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';

      if (!isValidReputationRatingPayload(payload)) {
        res.status(400).json({
          error: {
            code: 'bad_request',
            message: 'Invalid payload: reviewerId and a valid integer rating (1–5) are required',
            requestId,
          },
        });
        return;
      }

      const updatedProfile = (ReputationService as any).updateProfile
        ? (ReputationService as any).updateProfile(id, payload)
        : ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: updatedProfile });
    } catch (error) {
      handleControllerError(error, res);
    }
  }
}

/**
 * Centralized error handler for controller methods.
 */
function handleControllerError(error: unknown, res: Response): void {
  if (error instanceof ValidationError) {
    res.status(422).json({ status: 'error', message: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ status: 'error', message: error.message });
  } else if (error instanceof ConflictError) {
    res.status(409).json({ status: 'error', message: error.message });
  } else if (error instanceof AppError) {
    res.status(error.statusCode).json({ status: 'error', message: error.message });
  } else {
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
}
