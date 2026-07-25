/**
 * @module routes/disputes
 * @description Disputes API routes with per-client rate limiting and audit logging.
 *
 * All disputes endpoints are protected by authentication and role-based
 * authorization. A sliding-window rate limiter (sensitive-tier) is applied
 * to every route to prevent abuse and accidental overload.
 *
 * Every mutation (create, update, delete) emits an immutable audit log entry
 * recording the actor, action, before/after summary, and timestamp.
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
 *  - All mutation audit entries are tamper-evident (SHA-256 hash chain).
 *  - Sensitive fields in dispute bodies are redacted before audit storage.
 */

import { Router, Request, Response } from 'express';
import { createRateLimiter } from '../middleware/rateLimiter';
import { rateLimitConfig } from '../config/rateLimit';
import { requireAuth, requirePermission } from '../middleware/authorization';
import { auditService } from '../audit/service';
import { redactBody } from '../audit/redact';
import type { AuthenticatedRequest } from '../auth/authenticate';

const router = Router();

// ── Rate limiter (disputes tier) ──────────────────────────────────────────────
const disputesLimiter = createRateLimiter(rateLimitConfig.disputes);

// Apply rate limiting to all disputes routes
router.use(disputesLimiter);

// ── Authentication — all disputes routes require a valid JWT ──────────────────
router.use(requireAuth);

// ── In-memory dispute store ───────────────────────────────────────────────────
// Provides state for before/after comparison on mutations. In production this
// would be replaced with a database-backed repository.
interface Dispute {
  id: string;
  status: string;
  reason?: string;
  amount?: number;
  currency?: string;
  contractId?: string;
  initiatedBy?: string;
  createdAt: string;
  updatedAt?: string;
}

const disputeStore = new Map<string, Dispute>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the actor identity from the authenticated request. */
function getActor(req: Request): string {
  return (req as AuthenticatedRequest).user?.userId ?? 'anonymous';
}

/** Build a redacted copy of dispute data safe for audit storage. */
function redactedDisputeData(dispute: Dispute): Record<string, unknown> {
  return {
    id: dispute.id,
    status: dispute.status,
    reason: dispute.reason,
    amount: dispute.amount,
    currency: dispute.currency,
    contractId: dispute.contractId,
    initiatedBy: dispute.initiatedBy,
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
  };
}

/**
 * Apply redactBody to the raw dispute body to strip sensitive fields
 * (e.g. apiKey, secret, token, credentials) before audit storage.
 */
function sanitiseBody(body: Record<string, unknown>): Record<string, unknown> {
  return redactBody(body) as Record<string, unknown>;
}

// ── GET / — list disputes ─────────────────────────────────────────────────────
/** @permission disputes:list — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/',
  requirePermission('disputes', 'list'),
  (_req: Request, res: Response) => {
    const disputes = Array.from(disputeStore.values());
    res.status(200).json({ disputes, total: disputes.length });
  },
);

// ── GET /:id — get a single dispute ───────────────────────────────────────────
/** @permission disputes:read — admin, auditor, client (ownOnly), freelancer (ownOnly) */
router.get(
  '/:id',
  requirePermission('disputes', 'read'),
  (req: Request, res: Response) => {
    const dispute = disputeStore.get(req.params.id);
    if (!dispute) {
      res.status(404).json({ error: 'Dispute not found' });
      return;
    }
    res.status(200).json({ dispute });
  },
);

// ── POST / — create a new dispute ─────────────────────────────────────────────
/** @permission disputes:create — admin, client, freelancer */
router.post(
  '/',
  requirePermission('disputes', 'create'),
  (req: Request, res: Response) => {
    const body = req.body ?? {};
    const actor = getActor(req);
    const dispute: Dispute = {
      id: `dispute-${Date.now()}`,
      status: 'open',
      reason: body.reason ?? undefined,
      amount: body.amount ?? undefined,
      currency: body.currency ?? undefined,
      contractId: body.contractId ?? undefined,
      initiatedBy: actor,
      createdAt: new Date().toISOString(),
    };

    disputeStore.set(dispute.id, dispute);

    // Emit audit entry with redacted metadata
    const sanitisedBody = sanitiseBody(body);
    auditService.logDisputeEvent(
      'DISPUTE_CREATED',
      actor,
      dispute.id,
      {
        after: redactedDisputeData(dispute),
        requestBody: sanitisedBody,
      },
      {
        ipAddress: req.ip,
        correlationId: req.headers['x-correlation-id'] as string | undefined,
      },
    );

    res.status(201).json({ dispute });
  },
);

// ── PATCH /:id — update a dispute ────────────────────────────────────────────
/** @permission disputes:update — admin, client (ownOnly) */
router.patch(
  '/:id',
  requirePermission('disputes', 'update'),
  (req: Request, res: Response) => {
    const existing = disputeStore.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Dispute not found' });
      return;
    }

    const body = req.body ?? {};
    const actor = getActor(req);

    // Capture the before state for audit
    const before = redactedDisputeData(existing);

    // Apply updates
    const updated: Dispute = {
      ...existing,
      ...(body.status !== undefined && { status: body.status }),
      ...(body.reason !== undefined && { reason: body.reason }),
      ...(body.amount !== undefined && { amount: body.amount }),
      ...(body.currency !== undefined && { currency: body.currency }),
      updatedAt: new Date().toISOString(),
    };

    disputeStore.set(updated.id, updated);

    // Emit audit entry with before/after summary and redacted request body
    const sanitisedBody = sanitiseBody(body);
    auditService.logDisputeEvent(
      'DISPUTE_UPDATED',
      actor,
      updated.id,
      {
        before,
        after: redactedDisputeData(updated),
        changes: sanitisedBody,
      },
      {
        ipAddress: req.ip,
        correlationId: req.headers['x-correlation-id'] as string | undefined,
      },
    );

    res.status(200).json({ dispute: updated });
  },
);

// ── DELETE /:id — delete a dispute ────────────────────────────────────────────
/** @permission disputes:delete — admin only */
router.delete(
  '/:id',
  requirePermission('disputes', 'delete'),
  (req: Request, res: Response) => {
    const existing = disputeStore.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Dispute not found' });
      return;
    }

    const actor = getActor(req);

    // Capture the before state for audit before deleting
    const before = redactedDisputeData(existing);

    disputeStore.delete(existing.id);

    // Emit audit entry with the deleted dispute's state
    auditService.logDisputeEvent(
      'DISPUTE_DELETED',
      actor,
      existing.id,
      { before },
      {
        ipAddress: req.ip,
        correlationId: req.headers['x-correlation-id'] as string | undefined,
      },
    );

    res.status(200).json({
      message: `Dispute ${existing.id} deleted successfully`,
    });
  },
);

export default router;
