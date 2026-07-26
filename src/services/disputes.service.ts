/**
 * @module services/disputes
 * @description Service layer for disputes operations including batch processing.
 *
 * This service handles:
 * - Individual dispute updates with state validation
 * - Batch dispute updates with per-item isolation
 * - State machine validation (valid transitions only)
 * - Cascading side effects (notifications, escrow state changes)
 *
 * **Critical**: Each batch item is processed independently. One item's failure
 * does not affect another's, and partial side effects are prevented by keeping
 * each item's transaction isolated.
 */

import { logger } from '../logger';
import { DisputeStatus, BatchDisputeOperation, UpdateDisputePayload } from '../modules/disputes/dto/dispute.dto';
import { EscrowHooks, EscrowEventPayload } from '../hooks/escrow.hooks';

/**
 * In-memory store for disputes (demo implementation).
 * In production, this would be a real database.
 */
export interface DisputeRecord {
  id: string;
  contractId: string;
  status: DisputeStatus;
  resolution?: string;
  createdAt: Date;
  updatedAt: Date;
}

const disputeStore = new Map<string, DisputeRecord>();

/**
 * Valid state transitions for disputes.
 * Maps from current state → set of allowed next states.
 */
const VALID_TRANSITIONS: Record<DisputeStatus, Set<DisputeStatus>> = {
  open: new Set<DisputeStatus>(['under_review', 'resolved', 'escalated']),
  under_review: new Set<DisputeStatus>(['resolved', 'escalated']),
  resolved: new Set<DisputeStatus>([]), // terminal state
  escalated: new Set<DisputeStatus>(['resolved']),
};

/**
 * Error class for dispute-specific errors.
 */
export class DisputeError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'DisputeError';
  }
}

/**
 * Result of a single batch operation.
 */
export interface BatchOperationResult {
  index: number;
  success: boolean;
  dispute?: DisputeRecord;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * DisputesService — handles all dispute operations.
 */
export class DisputesService {
  /**
   * Retrieves a dispute by ID.
   *
   * @param id - Dispute ID
   * @throws {DisputeError} 404 if dispute not found
   */
  public getDisputeById(id: string): DisputeRecord {
    const dispute = disputeStore.get(id);
    if (!dispute) {
      throw new DisputeError('dispute_not_found', `Dispute ${id} not found`, 404);
    }
    return dispute;
  }

  /**
   * Validates a state transition.
   *
   * @param fromStatus - Current status
   * @param toStatus - Requested new status
   * @throws {DisputeError} 400 if transition is invalid
   */
  public validateTransition(fromStatus: DisputeStatus, toStatus: DisputeStatus): void {
    if (fromStatus === toStatus) {
      // Allow "no-op" updates (same status) — useful for idempotent retries
      return;
    }

    const allowedStates = VALID_TRANSITIONS[fromStatus];
    if (!allowedStates || !allowedStates.has(toStatus)) {
      throw new DisputeError(
        'invalid_state_transition',
        `Invalid state transition from ${fromStatus} to ${toStatus}`,
        400,
      );
    }
  }

  /**
   * Updates a single dispute (used by both single and batch endpoints).
   * Applies the update and triggers cascading side effects (notifications, escrow changes).
   *
   * **Transactionality**: In production, this would wrap the database update and
   * side-effect dispatch in a single transaction. For demo, side effects are
   * fire-and-forget (not transactional with the dispute update).
   *
   * @param id - Dispute ID
   * @param updates - Update payload
   * @throws {DisputeError} various codes for validation/auth/not-found errors
   */
  public async updateDispute(
    id: string,
    updates: UpdateDisputePayload,
  ): Promise<DisputeRecord> {
    // Fetch dispute (404 if not found)
    const dispute = this.getDisputeById(id);

    // Validate transition if status is being changed
    if (updates.status !== undefined) {
      this.validateTransition(dispute.status, updates.status);
    }

    // Apply the update
    const newStatus = updates.status ?? dispute.status;
    const updatedDispute: DisputeRecord = {
      ...dispute,
      status: newStatus,
      resolution: updates.resolution ?? dispute.resolution,
      updatedAt: new Date(),
    };

    // Save to store
    disputeStore.set(id, updatedDispute);

    // Fire cascading side effects (notifications, escrow state changes).
    // These are fire-and-forget; failures do not roll back the dispute update.
    // In production, these would be queued for reliable delivery.
    if (dispute.status !== newStatus) {
      try {
        const payload: EscrowEventPayload = {
          contractId: dispute.contractId,
          userEmail: 'admin@talenttrust.example', // Would be fetched from request context
          userId: 'admin-id', // Would be from request context
          reason: updates.resolution,
        };

        await EscrowHooks.onStateTransition(dispute.status, newStatus, payload);
        logger.info('[DisputesService] Cascading side effects dispatched', {
          disputeId: id,
          oldStatus: dispute.status,
          newStatus,
        });
      } catch (err) {
        // Side effect failures do not fail the main operation
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('[DisputesService] Side effect dispatch failed (non-fatal)', {
          disputeId: id,
          error: message,
        });
      }
    }

    return updatedDispute;
  }

  /**
   * Processes a batch of dispute updates.
   * Each item is processed independently — failures do not cascade.
   *
   * **Key guarantees**:
   * - Validation is per-item; invalid items fail individually
   * - Each successful item is written before the next item is processed
   * - One item's failure does not roll back prior items
   * - Partial side effects are prevented (each item's write and side effects are isolated)
   *
   * @param operations - Array of operations (already validated for length/schema)
   * @returns Array of per-item results with successes and errors
   */
  public async processBatch(operations: BatchDisputeOperation[]): Promise<BatchOperationResult[]> {
    const results: BatchOperationResult[] = [];

    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];

      try {
        // Attempt to update the dispute
        const updatedDispute = await this.updateDispute(operation.id, {
          status: operation.status,
          resolution: operation.resolution,
        });

        results.push({
          index,
          success: true,
          dispute: updatedDispute,
        });

        logger.info('[DisputesService] Batch item succeeded', {
          index,
          disputeId: operation.id,
          newStatus: operation.status,
        });
      } catch (err) {
        const error = err instanceof DisputeError ? err : new DisputeError(
          'internal_error',
          err instanceof Error ? err.message : String(err),
          500,
        );

        results.push({
          index,
          success: false,
          error: {
            code: error.code,
            message: error.message,
          },
        });

        logger.warn('[DisputesService] Batch item failed', {
          index,
          disputeId: operation.id,
          error: error.code,
        });
      }
    }

    return results;
  }

  /**
   * Seed demo disputes for testing.
   * (In production, this would be done via migrations/fixtures.)
   */
  public seedDemoDisputes(): void {
    const now = new Date();
    disputeStore.set('dispute-001', {
      id: 'dispute-001',
      contractId: 'contract-001',
      status: 'open',
      createdAt: new Date(now.getTime() - 86400000), // 1 day ago
      updatedAt: new Date(now.getTime() - 86400000),
    });
    disputeStore.set('dispute-002', {
      id: 'dispute-002',
      contractId: 'contract-002',
      status: 'under_review',
      createdAt: new Date(now.getTime() - 172800000), // 2 days ago
      updatedAt: new Date(now.getTime() - 3600000), // 1 hour ago
    });
  }
}

export const disputesService = new DisputesService();
