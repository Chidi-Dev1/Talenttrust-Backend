/**
 * @module audit/router
 * @description REST endpoints for querying the audit log.
 *
 * Routes:
 *   GET  /api/v1/audit          - Query audit entries with optional filters
 *   GET  /api/v1/audit/:id      - Retrieve a single entry by ID
 *   GET  /api/v1/audit/integrity - Verify the hash chain integrity
 *
 * Security notes:
 * - In production these routes MUST be protected by authentication and
 *   role-based authorisation (admin/auditor roles only).
 * - Query parameters are validated and clamped to prevent abuse.
 * - All routes are rate-limited per client (issue #746): `accessMiddleware`
 *   carries the general `audit` tier, `/export` additionally gets the
 *   `auditExport` tier via `exportMiddleware`, and `/integrity` additionally
 *   gets the stricter `auditIntegrity` tier via `integrityMiddleware` — see
 *   `rateLimitConfig` in `src/config/rateLimit.ts`.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import type { ZodError } from 'zod';
import { pipeline } from 'stream/promises';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters } from './exportService';
import type { AuditQuery } from './types';
import { buildAuditQuerySchema, createAuditEntryBodySchema, type AuditQueryParams } from './schemas';
import { mapZodErrorToDetails, type ValidationErrorResponse } from '../middleware/validate.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  accessMiddleware?: RequestHandler[];
  exportMiddleware?: RequestHandler[];
  /**
   * Middleware applied only to `GET /integrity`, in addition to
   * `accessMiddleware`. Verifying the hash chain walks the entire audit
   * log, so this endpoint gets its own (tighter) rate limiter — see
   * `rateLimitConfig.auditIntegrity` in `src/config/rateLimit.ts`.
   */
  integrityMiddleware?: RequestHandler[];
}

function buildValidationErrorResponse(requestId: string, error: ZodError): ValidationErrorResponse {
  return {
    error: {
      code: 'validation_error',
      message: 'Request validation failed',
      requestId,
      details: mapZodErrorToDetails(error),
    },
  };
}

function getRequestId(res: Response): string {
  return typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';
}

/**
 * Parses and validates query filters against the audit query schema and, on
 * failure, writes the shared structured 400 validation response directly
 * instead of throwing. Used by every handler below that accepts query
 * filters, so the "parse, then reject" preamble lives in one place instead
 * of being repeated per-route.
 */
function parseAuditQueryOrRespond(
  req: Request,
  res: Response,
  options: { defaultLimit?: number; maxLimit: number },
): { query: AuditQuery; limit?: number; offset: number } | undefined {
  const result = buildAuditQuerySchema(options).safeParse(req.query);

  if (!result.success) {
    res.status(400).json(buildValidationErrorResponse(getRequestId(res), result.error));
    return undefined;
  }

  const params: AuditQueryParams = result.data;
  const { action, severity, actor, resource, resourceId, from, to, limit, offset, cursor } = params;

  return {
    query: {
      ...(action && { action }),
      ...(severity && { severity }),
      ...(actor && { actor }),
      ...(resource && { resource }),
      ...(resourceId && { resourceId }),
      ...(from && { from }),
      ...(to && { to }),
      ...(limit !== undefined && { limit }),
      offset,
      ...(cursor && { cursor }),
    },
    limit,
    offset,
  };
}

export function createAuditRouter(options: AuditRouterOptions = {}): Router {
  const router = Router();
  const service = options.service ?? auditService;
  const exportService = options.exportService ?? auditExportService;
  const accessMiddleware = options.accessMiddleware ?? [];
  const exportMiddleware = options.exportMiddleware ?? [];
  const integrityMiddleware = options.integrityMiddleware ?? [];

  /**
   * POST /api/v1/audit
   *
   * Write an audit entry with idempotency support.
   * Accepts an Idempotency-Key header to prevent duplicate entries.
   */
  router.post(
    '/',
    idempotencyMiddleware,
    ...accessMiddleware,
    (req: Request, res: Response): void => {
      try {
        const parseResult = createAuditEntryBodySchema.safeParse(req.body);

        if (!parseResult.success) {
          res.status(400).json(buildValidationErrorResponse(getRequestId(res), parseResult.error));
          return;
        }

        const entry = service.log(parseResult.data);
        res.status(201).json(entry);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  router.get('/', ...accessMiddleware, (req: Request, res: Response): void => {
    const parsed = parseAuditQueryOrRespond(req, res, { defaultLimit: 50, maxLimit: 100 });
    if (!parsed) {
      return;
    }

    const { query } = parsed;
    
    // Use cursor-based pagination if cursor is provided, otherwise use legacy offset
    if (query.cursor) {
      const result = service.queryWithCursor(query);
      res.json({ 
        entries: result.entries, 
        count: result.count, 
        limit: result.limit,
        nextCursor: result.nextCursor,
      });
    } else {
      // Legacy offset-based pagination for backward compatibility
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const entries = service.query(query);
      res.json({ entries, count: entries.length, limit, offset });
    }
  });

/**
 * GET /api/v1/audit/export
 * Streams a file-backed NDJSON export for compliance downloads.
 */
  router.get('/export', ...accessMiddleware, ...exportMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = parseAuditQueryOrRespond(req, res, { maxLimit: 50_000 });
    if (!parsed) {
      return;
    }
    const { query } = parsed;

    let exportResult:
      | Awaited<ReturnType<AuditExportService['createNdjsonExport']>>
      | undefined;

    try {
      const actor = (req as Request & { user?: { id?: string } }).user?.id ?? 'anonymous';

      // Extract the filter fields. Offset is not meaningful for an export, but an
      // explicit limit caps how many records are written so callers can request a
      // bounded export (e.g. a preview) rather than the entire log.
      const filters: AuditExportFilters = {
        ...(query.action && { action: query.action }),
        ...(query.severity && { severity: query.severity }),
        ...(query.actor && { actor: query.actor }),
        ...(query.resource && { resource: query.resource }),
        ...(query.resourceId && { resourceId: query.resourceId }),
        ...(query.from && { from: query.from }),
        ...(query.to && { to: query.to }),
        ...(query.limit !== undefined && { limit: query.limit }),
      };

      exportResult = await exportService.createNdjsonExport(filters);

      service.log({
        action: 'ADMIN_ACTION',
        severity: 'CRITICAL',
        actor,
        resource: 'audit-log',
        resourceId: 'export',
        metadata: {
          operation: 'export',
          format: 'ndjson',
          filters: {
            action: filters.action ?? null,
            severity: filters.severity ?? null,
            actor: filters.actor ?? null,
            resource: filters.resource ?? null,
            resourceId: filters.resourceId ?? null,
            from: filters.from ?? null,
            to: filters.to ?? null,
          },
          recordCount: exportResult.recordCount,
          bytesWritten: exportResult.bytesWritten,
        },
        ipAddress: req.ip,
        correlationId: typeof res.locals['requestId'] === 'string'
          ? res.locals['requestId']
          : undefined,
      });

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportResult.fileName}"`);
      res.setHeader('X-Audit-Export-Records', String(exportResult.recordCount));

      await pipeline(exportResult.openReadStream(), res);
    } catch (error) {
      if (!res.headersSent) {
        const status = (error as Error).message.startsWith('Invalid ') ? 400 : 500;
        res.status(status).json({ error: (error as Error).message });
      }
    } finally {
      if (exportResult) {
        await exportResult.cleanup();
      }
    }
  });

/**
 * GET /api/v1/audit/integrity
 * Verify the tamper-evident hash chain.
 * Returns 200 if valid, 409 if corruption is detected.
 */
  router.get('/integrity', ...accessMiddleware, ...integrityMiddleware, (_req: Request, res: Response): void => {
    const report = service.verifyIntegrity();
    const status = report.valid ? 200 : 409;
    res.status(status).json(report);
  });

/**
 * GET /api/v1/audit/:id
 * Retrieve a single audit entry by its UUID.
 */
  router.get('/:id', ...accessMiddleware, (req: Request, res: Response): void => {
    const entry = service.getById(req.params['id'] ?? '');
    if (!entry) {
      res.status(404).json({ error: 'Audit entry not found' });
      return;
    }
    res.json(entry);
  });

  return router;
}

export const auditRouter = createAuditRouter();
