import { Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { ForbiddenError, ConflictError, ValidationError, AppError } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload } from './reputation.validation';
import { isValidReputationBulkItem } from './reputation.validation';

/**
 * @title Reputation Controller
 * @dev Handles HTTP requests for the reputation system with proper error handling.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile.
   */
  public static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const profile = ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: profile });
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
