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
 * - The integrity endpoint should be rate-limited to prevent DoS on large logs.
 *
 * POST /api/v1/audit — Idempotent audit write
 * - Accepts Idempotency-Key header for idempotent writes.
 * - Replays the original response on key reuse; returns 409 on body mismatch.
 * - Keys expire after 24 hours; store is bounded to 1000 entries.
 */

import { Router, Request, Response, type RequestHandler } from 'express';
import { pipeline } from 'stream/promises';
import { auditService, AuditService } from './service';
import { auditExportService, AuditExportService, type AuditExportFilters } from './exportService';
import { idempotencyStore, hashIdempotencyInput } from './idempotency';
import type { AuditAction, AuditQuery, AuditSeverity, CreateAuditEntryInput } from './types';
import { decodeCursor } from './types';

export interface AuditRouterOptions {
  service?: AuditService;
  exportService?: AuditExportService;
  accessMiddleware?: RequestHandler[];
  exportMiddleware?: RequestHandler[];
  idempotencyStore?: typeof idempotencyStore;
}

const VALID_ACTIONS = new Set<AuditAction>([
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
  'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
]);

const VALID_SEVERITIES = new Set<AuditSeverity>(['INFO', 'WARNING', 'CRITICAL']);

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
  const store = options.idempotencyStore ?? idempotencyStore;

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
  router.get('/integrity', ...accessMiddleware, (_req: Request, res: Response): void => {
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
