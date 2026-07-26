/**
 * @module audit/router
 * @description REST endpoints for querying and writing the audit log.
 *
 * Routes:
 *   GET  /api/v1/audit          - Query audit entries with optional filters
 *   GET  /api/v1/audit/export   - Stream an NDJSON export for compliance
 *   GET  /api/v1/audit/integrity - Verify the hash chain integrity
 *   POST /api/v1/audit          - Write a single audit entry
 *   POST /api/v1/audit/bulk     - Write a bounded batch of audit entries
 *
 * Security notes:
 * - In production these routes MUST be protected by authentication and
 *   role-based authorisation (admin/auditor roles only).
 * - Query parameters are validated and clamped to prevent abuse.
 * - All routes are rate-limited per client (issue #746): `accessMiddleware`
 *   carries the general `audit` tier, `/export` additionally gets the
 *   `auditExport` tier via `exportMiddleware`, `/integrity` additionally
 *   gets the stricter `auditIntegrity` tier via `integrityMiddleware`, and
 *   `/bulk` additionally gets the `auditBulk` tier via `bulkMiddleware` —
 *   see `rateLimitConfig` in `src/config/rateLimit.ts`.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters } from './exportService';
import type { AuditAction, AuditQuery, AuditSeverity, BulkAuditItemResult, CreateAuditEntryInput } from './types';
import { decodeCursor } from './types';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { validateRequest } from '../middleware/validate.middleware';

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
  /**
   * Middleware applied only to `POST /bulk`, in addition to
   * `accessMiddleware`. Bulk writes can append up to `MAX_BULK_AUDIT_ITEMS`
   * entries per request, so this endpoint gets its own rate limiter — see
   * `rateLimitConfig.auditBulk` in `src/config/rateLimit.ts`.
   */
  bulkMiddleware?: RequestHandler[];
}

const AUDIT_ACTIONS = [
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
  'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
  'DISPUTE_CREATED', 'DISPUTE_UPDATED', 'DISPUTE_DELETED',
]);

const AUDIT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const satisfies readonly AuditSeverity[];

const VALID_ACTIONS = new Set<AuditAction>(AUDIT_ACTIONS);
const VALID_SEVERITIES = new Set<AuditSeverity>(AUDIT_SEVERITIES);

/** Hard cap on the number of items accepted by a single `POST /bulk` request. */
export const MAX_BULK_AUDIT_ITEMS = 100;

/**
 * Validates only the envelope shape of a bulk request: `entries` must be a
 * bounded, non-empty array. Individual item field validation intentionally
 * happens per-item in the route handler (see `validateBulkAuditItem`) rather
 * than here, so that one malformed item fails only itself instead of
 * rejecting the whole batch with a 400.
 */
const bulkAuditRequestSchema = z.object({
  entries: z
    .array(z.unknown())
    .min(1, 'entries must contain at least 1 item')
    .max(MAX_BULK_AUDIT_ITEMS, `entries must not exceed ${MAX_BULK_AUDIT_ITEMS} items`),
});

/**
 * Validates a single bulk-batch item, mirroring the hand-rolled checks used
 * by `POST /` (required fields) plus the action/severity enum checks already
 * applied to query filters. Returns an error message, or `undefined` if the
 * item is valid.
 */
function validateBulkAuditItem(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Item must be an object';
  }

  const input = raw as Partial<CreateAuditEntryInput>;

  if (!input.action || !input.severity || !input.actor || !input.resource || !input.resourceId) {
    return 'Missing required fields: action, severity, actor, resource, resourceId';
  }

  if (!VALID_ACTIONS.has(input.action as AuditAction)) {
    return `Invalid action: ${String(input.action)}`;
  }

  if (!VALID_SEVERITIES.has(input.severity as AuditSeverity)) {
    return `Invalid severity: ${String(input.severity)}`;
  }

  return undefined;
}

/**
 * Extracts and validates the typed {@link AuditQueryParamsDto} from an Express
 * request, then delegates coercions and ISO-date parsing to {@link toAuditQuery}.
 *
 * Action and severity allowlist checks are done here (before DTO conversion) so
 * the DTO mapper can treat them as already-validated opaque strings.
 *
 * @throws {Error} When any query parameter fails validation (action, severity,
 *                 limit, offset, from, to, or cursor).
 */
function parseAuditQueryDto(
  req: Request,
  options: { defaultLimit?: number; maxLimit: number },
): ReturnType<typeof toAuditQuery> {
  const raw = req.query as Record<string, string | undefined>;
  const { action, severity } = raw;

  if (action && !VALID_ACTIONS.has(action as AuditAction)) {
    throw new Error(`Invalid action: ${action}`);
  }

  if (severity && !VALID_SEVERITIES.has(severity as AuditSeverity)) {
    throw new Error(`Invalid severity: ${severity}`);
  }

  const dto: AuditQueryParamsDto = {
    ...(action !== undefined && { action }),
    ...(severity !== undefined && { severity }),
    ...(raw['actor'] !== undefined && { actor: raw['actor'] }),
    ...(raw['resource'] !== undefined && { resource: raw['resource'] }),
    ...(raw['resourceId'] !== undefined && { resourceId: raw['resourceId'] }),
    ...(raw['from'] !== undefined && { from: raw['from'] }),
    ...(raw['to'] !== undefined && { to: raw['to'] }),
    ...(raw['limit'] !== undefined && { limit: raw['limit'] }),
    ...(raw['offset'] !== undefined && { offset: raw['offset'] }),
    ...(raw['cursor'] !== undefined && { cursor: raw['cursor'] }),
  };

  // Validate cursor format before delegating — the DTO mapper doesn't decode it
  if (dto.cursor) {
    try {
      decodeCursor(cursor);
    } catch {
      throw new Error('Invalid cursor format');
    }
  }

  return toAuditQuery(dto, options);
}

/**
 * Runs `parseAuditQueryDto` and, on failure, writes the shared 400 validation
 * response directly instead of throwing. Used by every handler below that
 * accepts query filters, so the "parse, then reject with a 400 on the same
 * shape of error" preamble lives in one place instead of being repeated
 * per-route.
 */
function parseAuditQueryOrRespond(
  req: Request,
  res: Response,
  options: { defaultLimit?: number; maxLimit: number },
): ReturnType<typeof toAuditQuery> | undefined {
  try {
    return parseAuditQueryDto(req, options);
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
  const bulkMiddleware = options.bulkMiddleware ?? [];

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
        const input = req.body as CreateAuditEntryInput;

        if (!input.action || !input.severity || !input.actor || !input.resource || !input.resourceId) {
          res.status(400).json({ error: 'Missing required fields: action, severity, actor, resource, resourceId' });
          return;
        }

        const entry = service.log(input);
        res.status(201).json(entry);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  /**
   * POST /api/v1/audit/bulk
   *
   * Write a bounded batch of audit entries in one request. Each item is
   * validated and appended independently — a malformed or failing item is
   * reported in its own `results[]` slot without discarding the rest of the
   * batch. The whole request is rejected with 400 only when the envelope
   * itself is invalid (not an array, empty, or over `MAX_BULK_AUDIT_ITEMS`).
   *
   * Entries are appended sequentially (not in parallel) to preserve the
   * tamper-evident hash chain, so a large batch is O(n) requests to the
   * underlying store — bounded by `MAX_BULK_AUDIT_ITEMS`.
   *
   * The whole batch shares one Idempotency-Key, matching `POST /`: a retried
   * request with an identical body replays the cached aggregate response.
   *
   * Responds 201 when every item succeeded, or 207 (Multi-Status) when at
   * least one item failed, so callers can distinguish "fully applied" from
   * "needs per-item inspection" without parsing the body first.
   */
  router.post(
    '/bulk',
    idempotencyMiddleware,
    ...accessMiddleware,
    ...bulkMiddleware,
    validateRequest(bulkAuditRequestSchema),
    (req: Request, res: Response): void => {
      const { entries } = req.body as { entries: unknown[] };

      const results: BulkAuditItemResult[] = entries.map((raw, index) => {
        const validationError = validateBulkAuditItem(raw);
        if (validationError) {
          return { index, success: false, error: validationError };
        }

        try {
          const entry = service.log(raw as CreateAuditEntryInput);
          return { index, success: true, entry };
        } catch (error) {
          return { index, success: false, error: (error as Error).message };
        }
      });

      const failed = results.filter((result) => !result.success).length;
      const succeeded = results.length - failed;
      const status = failed === 0 ? 201 : 207;

      res.status(status).json({ results, succeeded, failed });
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
      res.json(toAuditQueryCursorResponseDto(result));
    } else {
      // Legacy offset-based pagination for backward compatibility
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const entries = service.query(query);
      res.json(toAuditQueryResponseDto(entries, limit, offset));
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
 * POST /api/v1/audit
 * Idempotent audit write. Accepts an Idempotency-Key header to prevent
 * duplicate entries from retried requests.
 *
 * On first write with a given key: creates the entry and returns 201.
 * On replay (same key, same body): returns 200 with the original entry.
 * On conflict (same key, different body): returns 409.
 *
 * Idempotency keys expire after 24 hours. The store is bounded to 1000 entries.
 */
  router.post('/', ...accessMiddleware, (req: Request, res: Response): void => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (idempotencyKey === undefined || idempotencyKey === null) {
      res.status(400).json({ error: 'Idempotency-Key header is required' });
      return;
    }

    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      res.status(400).json({ error: 'Idempotency-Key must be a string between 1 and 128 characters' });
      return;
    }

    const body = req.body as Record<string, unknown>;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Request body is required' });
      return;
    }

    const action = body['action'];
    const severity = body['severity'];
    const actor = body['actor'];
    const resource = body['resource'];
    const resourceId = body['resourceId'];
    const metadata = body['metadata'] ?? {};

    if (!VALID_ACTIONS.has(action as AuditAction)) {
      res.status(400).json({ error: `Invalid action: ${String(action)}` });
      return;
    }

    if (!VALID_SEVERITIES.has(severity as AuditSeverity)) {
      res.status(400).json({ error: `Invalid severity: ${String(severity)}` });
      return;
    }

    if (typeof actor !== 'string' || actor.length === 0) {
      res.status(400).json({ error: 'actor is required and must be a non-empty string' });
      return;
    }

    if (typeof resource !== 'string' || resource.length === 0) {
      res.status(400).json({ error: 'resource is required and must be a non-empty string' });
      return;
    }

    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      res.status(400).json({ error: 'resourceId is required and must be a non-empty string' });
      return;
    }

    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      res.status(400).json({ error: 'metadata must be a plain object' });
      return;
    }

    const input: CreateAuditEntryInput = {
      action: action as AuditAction,
      severity: severity as AuditSeverity,
      actor,
      resource,
      resourceId,
      metadata: metadata as Record<string, unknown>,
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      correlationId: typeof res.locals['requestId'] === 'string'
        ? res.locals['requestId']
        : (req.headers['x-correlation-id'] as string | undefined),
    };

    const existing = store.get(idempotencyKey);

    if (existing) {
      const currentHash = hashIdempotencyInput(input);

      if (existing.bodyHash !== currentHash) {
        res.status(409).json({ error: 'Idempotency-Key already used with a different request body' });
        return;
      }

      res.status(200).json(existing.response);
      return;
    }

    const entry = service.log(input);
    store.set(idempotencyKey, input, entry);
    res.status(201).json(entry);
  });

/**
 * GET /api/v1/audit/integrity
 * Verify the tamper-evident hash chain.
 * Returns 200 if valid, 409 if corruption is detected.
 */
  router.get('/integrity', ...accessMiddleware, ...integrityMiddleware, (_req: Request, res: Response): void => {
    const report = service.verifyIntegrity();
    const status = report.valid ? 200 : 409;
    res.status(status).json(toIntegrityReportResponseDto(report));
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
    res.json(toAuditEntryResponseDto(entry));
  });

  return router;
}

export const auditRouter = createAuditRouter();
