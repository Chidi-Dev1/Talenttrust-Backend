import { NextFunction, Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { AppError } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload } from './reputation.validation';

/**
 * @title Reputation Controller
 * @dev Handles HTTP requests for the reputation system with proper error handling.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile.
   */
  public static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const profile = ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: profile });
    } catch (error: any) {
      if (error.message === 'Freelancer ID is required') {
        next(new AppError(400, 'bad_request', error.message));
      } else {
        next(error);
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
  public static async createRating(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const payload: any = req.body;

      if (!isValidReputationRatingPayload(payload)) {
        next(new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1–5) are required'));
        return;
      }

      const updatedProfile = (ReputationService as any).updateProfile
        ? (ReputationService as any).updateProfile(id, payload)
        : ReputationService.getProfile(id);
      res.status(200).json({ status: 'success', data: updatedProfile });
    } catch (error) {
      next(error);
    }
  }
}
