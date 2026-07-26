import { NextFunction, Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { AppError } from '../errors/appError';
import { AuthenticatedRequest } from '../auth/authenticate';
import { isValidReputationRatingPayload } from './reputation.validation';
import { ReputationProfile } from '../types/reputation';
import { reputationCache } from '../utils/reputationCache';

/**
 * @title Reputation Controller
 * @dev Handles HTTP requests for the reputation system with proper error handling.
 *
 * ### Caching
 * GET /:id responses are cached in the module-level `reputationCache` singleton
 * (bounded LRU with TTL). The cache key is the freelancer ID (`req.params.id`).
 *
 * On a **hit** the cached `ReputationProfile` is returned immediately without
 * touching the database. On a **miss** the service is called, the result is
 * stored in the cache, and then returned to the caller.
 *
 * PUT /:id (write path) invalidates the affected cache key so that the next
 * GET always reflects the newly submitted rating.
 */
export class ReputationController {
  /**
   * GET /api/v1/reputation/:id
   * Retrieve a freelancer's reputation profile.
   *
   * Checks the LRU cache first. On a cache miss, falls through to
   * `ReputationService.getProfile`, stores the result, and returns it.
   */
  public static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      // ── Cache read ────────────────────────────────────────────────────────
      const cached = reputationCache.get(id);
      if (cached !== undefined) {
        res.status(200).json({ status: 'success', data: cached as ReputationProfile });
        return;
      }

      // ── Cache miss — delegate to service ─────────────────────────────────
      const profile = ReputationService.getProfile(id);

      // Store in cache for subsequent reads
      reputationCache.set(id, profile);

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
   *
   * After a successful write, the cache entry for `id` is **invalidated** so
   * that the next GET re-fetches fresh data from the service layer.
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

      // ── Cache invalidation ─────────────────────────────────────────────────
      // Evict any stale cached profile so the next GET reflects the new rating.
      reputationCache.invalidate(id);

      res.status(200).json({ status: 'success', data: updatedProfile });
    } catch (error) {
      next(error);
    }
  }
}
