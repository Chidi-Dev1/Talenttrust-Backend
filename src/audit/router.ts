/**
 * @module audit/router
 * @description REST endpoints for reading and appending to the audit log.
 *
 * Routes:
 *   GET  /api/v1/audit          - Query audit entries with optional filters
 *   GET  /api/v1/audit/export   - Stream an NDJSON export for compliance
 *   GET  /api/v1/audit/integrity - Verify the hash chain integrity
 *   GET  /api/v1/audit/:id      - Retrieve a single entry by ID
 *   POST /api/v1/audit          - Append a new entry
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
 * - Write bodies are validated and bounded by `./inputValidation` before they
 *   reach the store; see that module for the enforced limits.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import { pipeline } from 'stream/promises';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters } from './exportService';
import type { AuditAction, AuditQuery, AuditSeverity } from './types';
import { AUDIT_ACTIONS, AUDIT_SEVERITIES, decodeCursor } from './types';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { readValidatedBody, validateCreateAuditEntry } from './inputValidation';

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

// Derived from the canonical lists in `./types` so query filters accept exactly
// the actions and severities that can be written. Previously these were spelled
// out here and had drifted: DEPLOYMENT_PROMOTED / DEPLOYMENT_ROLLED_BACK were
// writable but could not be filtered on.
const VALID_ACTIONS = new Set<AuditAction>(AUDIT_ACTIONS);

const VALID_SEVERITIES = new Set<AuditSeverity>(AUDIT_SEVERITIES);

function parseOptionalIsoDate(
  value: string | undefined,
  fieldName: 'from' | 'to',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${fieldName} timestamp`);
  }

  return new Date(parsed).toISOString();
}

function parseOffset(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Invalid offset');
  }

  return parsed;
}

function parseLimit(value: string | undefined, maxLimit: number, defaultLimit?: number): number | undefined {
  if (value === undefined) {
    return defaultLimit;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Invalid limit');
  }

  return Math.min(parsed, maxLimit);
}

function parseAuditQuery(
  req: Request,
  options: { defaultLimit?: number; maxLimit: number },
): { query: AuditQuery; limit?: number; offset: number } {
  const {
    action, severity, actor, resource, resourceId, cursor,
  } = req.query as Record<string, string | undefined>;

  if (action && !VALID_ACTIONS.has(action as AuditAction)) {
    throw new Error(`Invalid action: ${action}`);
  }

  if (severity && !VALID_SEVERITIES.has(severity as AuditSeverity)) {
    throw new Error(`Invalid severity: ${severity}`);
  }

  const limit = parseLimit(req.query['limit'] as string | undefined, options.maxLimit, options.defaultLimit);
  const offset = parseOffset(req.query['offset'] as string | undefined);
  const from = parseOptionalIsoDate(req.query['from'] as string | undefined, 'from');
  const to = parseOptionalIsoDate(req.query['to'] as string | undefined, 'to');

  // Validate cursor format if provided
  if (cursor) {
    try {
      decodeCursor(cursor);
    } catch (_error) {
      throw new Error('Invalid cursor format');
    }
  }

  return {
    query: {
      ...(action && { action: action as AuditAction }),
      ...(severity && { severity: severity as AuditSeverity }),
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

/**
 * Runs `parseAuditQuery` and, on failure, writes the shared 400 validation
 * response directly instead of throwing. Used by every handler below that
 * accepts query filters, so the "parse, then reject with a 400 on the same
 * shape of error" preamble lives in one place instead of being repeated
 * per-route.
 */
function parseAuditQueryOrRespond(
  req: Request,
  res: Response,
  options: { defaultLimit?: number; maxLimit: number },
): { query: AuditQuery; limit?: number; offset: number } | undefined {
  try {
    return parseAuditQuery(req, options);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return undefined;
  }
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
   * Append a new entry to the audit log.
   *
   * The body is validated by the {@link validateCreateAuditEntry} middleware,
   * which rejects unknown fields, wrong types, unbounded strings and oversized
   * or over-nested metadata before anything reaches the store — entries are
   * immutable and hash-chained, so an accepted mistake is permanent.
   *
   * Middleware order matters. Validation runs *before* `idempotencyMiddleware`
   * because that middleware caches whatever the handler sends and replays it
   * with a 200 on retry; letting a rejected body through would cache a 400 and
   * replay it as a success. Rejected requests therefore never reach the
   * idempotency layer, and a corrected retry under the same key still works.
   *
   * Accepts an `Idempotency-Key` header so a retried write is deduplicated
   * rather than appended twice.
   *
   * @body {CreateAuditEntryInput} action, severity, actor, resource, resourceId,
   *   optional metadata (defaults to `{}`), ipAddress and correlationId.
   * @returns 201 - The created AuditEntry, including its hash chain fields.
   * @returns 200 - The cached entry, when an Idempotency-Key is replayed.
   * @returns 400 - `validation_error` envelope with one `details` entry per problem.
   * @returns 409 - The Idempotency-Key was reused with a different payload.
   */
  router.post(
    '/',
    ...accessMiddleware,
    validateCreateAuditEntry,
    idempotencyMiddleware,
    (_req: Request, res: Response): void => {
      const entry = service.log(readValidatedBody(res));
      res.status(201).json(entry);
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
