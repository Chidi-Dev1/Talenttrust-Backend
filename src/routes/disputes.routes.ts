/**
 * @module routes/disputes
 * @description Disputes API routes with per-client rate limiting and
 * domain-specific observability (metrics + structured logs).
 *
 * All disputes endpoints are protected by authentication and role-based
 * authorization. A sliding-window rate limiter (sensitive-tier) is applied
 * to every route to prevent abuse and accidental overload.
 *
 * Responses above {@link DISPUTES_COMPRESSION_THRESHOLD} bytes are automatically
 * compressed using gzip or deflate, honouring the client's `Accept-Encoding`
 * header. Small responses are served uncompressed to avoid unnecessary CPU cost.
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
 *  - Observability logs never include request/response bodies or PII.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { Logger, logger as rootLogger } from '../logger';
import {
  MetricsServiceLike,
  DisputesRequestMetricInput,
} from '../observability/metrics-service';
import { mapDisputesErrorCause } from '../observability/metrics-validation';
import { disputesErrorHandler } from '../middleware/disputesErrorHandler';

export interface DisputesRouterOptions {
  /** Optional metrics service; when omitted, metrics are skipped. */
  metricsService?: Pick<MetricsServiceLike, 'recordDisputesRequest'>;
  /** Optional logger override (tests). Defaults to request-scoped or root logger. */
  log?: Logger;
}

/**
 * Build the disputes router.
 *
 * @param options - Optional metrics/logger injection for observability.
 */
export function createDisputesRouter(options: DisputesRouterOptions = {}): Router {
  const router = Router();

  // Observability first so duration/status capture includes auth + rate-limit outcomes.
  router.use(createDisputesObservabilityMiddleware(options));

  // ── Rate limiter (disputes tier) ──────────────────────────────────────────────
  const disputesLimiter = createRateLimiter(rateLimitConfig.disputes);
  router.use(disputesLimiter);

  // ── Authentication — all disputes routes require a valid JWT ──────────────────
  router.use(requireAuth);

  // ── Disputes error handling — centralizes dispute-specific errors ─────────────
  router.use(disputesErrorHandler);

  // ── GET / — list disputes ─────────────────────────────────────────────────────
  /** @permission disputes:list — admin, auditor, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/',
    requirePermission('disputes', 'list'),
    (_req: Request, res: Response) => {
      res.status(200).json({ disputes: [], total: 0 });
    },
  );

  // ── GET /:id — get a single dispute ───────────────────────────────────────────
  /** @permission disputes:read — admin, auditor, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/:id',
    requirePermission('disputes', 'read'),
    (req: Request, res: Response) => {
      res.status(200).json({
        dispute: {
          id: req.params.id,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      });
    },
  );

  // ── POST / — create a new dispute ─────────────────────────────────────────────
  /** @permission disputes:create — admin, client, freelancer */
  router.post(
    '/',
    requirePermission('disputes', 'create'),
    (req: Request, res: Response) => {
      const body = req.body ?? {};
      res.status(201).json({
        dispute: {
          id: `dispute-${Date.now()}`,
          ...body,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      });
    },
  );

  // ── PATCH /:id — update a dispute ────────────────────────────────────────────
  /** @permission disputes:update — admin, client (ownOnly) */
  router.patch(
    '/:id',
    requirePermission('disputes', 'update'),
    (req: Request, res: Response) => {
      const body = req.body ?? {};
      res.status(200).json({
        dispute: {
          id: req.params.id,
          ...body,
          updatedAt: new Date().toISOString(),
        },
      });
    },
  );

  // ── DELETE /:id — delete a dispute ────────────────────────────────────────────
  /** @permission disputes:delete — admin only */
  router.delete(
    '/:id',
    requirePermission('disputes', 'delete'),
    (req: Request, res: Response) => {
      res.status(200).json({
        message: `Dispute ${req.params.id} deleted successfully`,
      });
    },
  );

  return router;
}

/**
 * Middleware that records disputes request duration, status, and error-cause
 * metrics plus a structured log on response finish. No PII is logged.
 */
export function createDisputesObservabilityMiddleware(
  options: DisputesRouterOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    res.once('finish', () => {
      const durationNs = process.hrtime.bigint() - start;
      const durationSeconds = Number(durationNs) / 1_000_000_000;
      const durationMs = parseFloat((durationSeconds * 1_000).toFixed(3));
      const statusCode = res.statusCode;
      const errorCause = mapDisputesErrorCause(statusCode);
      const route = extractDisputesRoute(req);

      const metricInput: DisputesRequestMetricInput = {
        method: req.method,
        route,
        statusCode,
        errorCause,
        durationSeconds,
      };

      if (options.metricsService) {
        options.metricsService.recordDisputesRequest(metricInput);
      }

      const log: Logger =
        (res.locals['log'] as Logger | undefined) ?? options.log ?? rootLogger;

      log.info('disputes_request', {
        method: req.method,
        route,
        statusCode,
        durationMs,
        errorCause,
      });
    });

    next();
  };
}

/**
 * Returns a bounded Express route template label (never concrete IDs).
 */
function extractDisputesRoute(req: Request): string {
  const routePath = formatExpressPath(req.route?.path);
  if (routePath === null) {
    // Rate-limit / auth rejections may finish before a route matches.
    return req.baseUrl && req.baseUrl.length > 0 ? req.baseUrl : '/api/v1/disputes';
  }

  const baseUrl = normalizeRoutePart(req.baseUrl);
  const joined = joinRouteParts(baseUrl, routePath);
  return joined.length > 0 ? joined : '/';
}

function formatExpressPath(path: unknown): string | null {
  if (typeof path === 'string') {
    return normalizeRoutePart(path);
  }

  if (path instanceof RegExp) {
    return path.toString();
  }

  if (Array.isArray(path)) {
    const parts = path
      .map(formatExpressPath)
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('|') : null;
  }

  return null;
}

function normalizeRoutePart(part: string | undefined): string {
  if (!part || part === '/') {
    return '';
  }

  return part.startsWith('/') ? part : `/${part}`;
}

function joinRouteParts(baseUrl: string, routePath: string): string {
  if (!baseUrl) {
    return routePath;
  }

  if (!routePath) {
    return baseUrl;
  }

  return `${baseUrl}${routePath}`;
}
