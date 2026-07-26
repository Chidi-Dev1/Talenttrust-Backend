import type { NextFunction, Request, Response } from 'express';
import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { parseLimit, resolveCursorQueryParam } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';
import { parseLimit, resolveCursorQueryParam } from '../contracts/cursor.repository';
import { NotFoundError } from '../errors/appError';
import {
  CreateContractRequestDto,
  UpdateContractRequestDto,
  BulkMilestonesResponseDto,
  toContractResponseDto,
  toCreateContractDto,
  toUpdateContractDto,
} from '../modules/contracts/dto/contracts-boundary.dto';
import {
  assertResponseSchema,
  contractBoundsResponseSchema,
  contractStatsResponseSchema,
  deleteContractResponseSchema,
  ContractBoundsResponse,
  ContractStatsResponse,
  DeleteContractResponse,
} from '../modules/contracts/dto/contract-response.dto';
import { ContractsService } from '../services/contracts.service';
import { WebhookService } from '../services/webhook.service';
import { fail, ok } from '../utils/apiResponse';
import { getCorrelationId, getRequestId } from '../utils/correlationId';
import { applyPagination, parsePaginationQuery } from '../utils/pagination';
import type { Logger } from '../logger';

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
> & { user?: { id: string } };

/**
 * Extract the request-scoped logger from res.locals, falling back to a
 * module-level import so the controller works without middleware in unit tests.
 */
function resolveLogger(res: Response): Logger {
  const log = res.locals['log'] as Logger | undefined;
  if (log) return log;
  // Lazy import avoids a top-level circular-dep risk and keeps unit tests simple.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../logger').logger as Logger;
}

/**
 * Build a trace context object from res.locals for structured logging.
 * Only includes correlationId when present to keep records clean.
 * Falls back to 'unknown' for requestId so the controller works in unit tests
 * that don't run requestIdMiddleware.
 */
function traceContext(res: Response): Record<string, string> {
  const requestId =
    typeof res.locals['requestId'] === 'string'
      ? (res.locals['requestId'] as string)
      : 'unknown';
  const ctx: Record<string, string> = { requestId };
  const correlationId = getCorrelationId(res);
  if (correlationId !== undefined) ctx['correlationId'] = correlationId;
  return ctx;
}

/**
 * Presentation layer for contracts. Transport DTOs are mapped explicitly at
 * this boundary so service and persistence types do not leak into handlers.
 *
 * Every handler:
 *  1. Extracts the request-scoped logger (bound to requestId + correlationId)
 *     from res.locals.log — set by requestIdMiddleware.
 *  2. Logs entry/exit/error with the trace context.
 *  3. Forwards the correlationId to service calls so structured logs at the
 *     service layer carry the same trace token.
 */
export class ContractsController {
  constructor(
    private readonly service: ContractsService,
    private readonly auditService: Pick<AuditService, 'log' | 'query' | 'queryWithCursor'> = defaultAuditService,
  ) {}

  /** Actor identifier for audit entries. Falls back to 'system' when a request reaches the controller without an authenticated user (defensive only — production routes always run requireAuth first). */
  private actorFor(req: ContractRequest): string {
    return req.user?.id ?? 'system';
  }

  private auditContext(req: ContractRequest): { ipAddress?: string; correlationId?: string } {
    const correlationId = req.headers?.['x-correlation-id'];
    return {
      ...(req.ip !== undefined && { ipAddress: req.ip }),
      ...(typeof correlationId === 'string' && { correlationId }),
    };
  }

  /**
   * Records a MILESTONES_* audit entry when a write meaningfully changes a
   * contract's milestones, comparing against the last recorded snapshot for
   * that contract (see modules/contracts/milestonesAudit.ts for rationale).
   * A logging failure is caught and reported, but never fails the request —
   * the primary write has already succeeded by the time this runs.
   */
  private recordMilestonesAudit(
    req: ContractRequest,
    contractId: string,
    afterMilestones: Parameters<typeof summarizeMilestones>[0],
  ): void {
    try {
      const before = getLastMilestonesSnapshot(this.auditService, contractId);
      const after = summarizeMilestones(afterMilestones);
      const action = determineMilestonesAction(before, after);
      if (!action) {
        return;
      }
      this.auditService.log({
        action,
        severity: action === 'MILESTONES_DELETED' ? 'WARNING' : 'INFO',
        actor: this.actorFor(req),
        resource: 'milestones',
        resourceId: contractId,
        metadata: buildMilestonesAuditMetadata(before, after),
        ...this.auditContext(req),
      });
    } catch (error) {
      // Never let audit logging break the primary request flow.
      console.error('[ContractsController] Failed to record milestones audit entry:', error);
    }
  }

  public async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info('contracts.getContracts: start', ctx);

    try {
      const query = (req.query ?? {}) as Record<string, unknown>;
      if (
        query['page'] === undefined &&
        (query['cursor'] !== undefined || query['limit'] !== undefined)
      ) {
        await this.getContractsCursor(req, res, next);
        return;
      }

      const pagination = parsePaginationQuery(
        query,
      );
      if (!pagination.ok) {
        log.warn('contracts.getContracts: bad pagination params', { ...ctx, error: pagination.error });
        fail(res, 'bad_request', pagination.error, 400);
        return;
      }

      let limit: number;
      try {
        limit = parseLimit((req.query ?? {}).limit);
      } catch (err) {
        fail(res, 'bad_request', (err as Error).message, 400);
        return;
      }

      log.info('contracts.getContracts: success', { ...ctx, total });
      ok(res, pageItems, {
        page,
        limit,
      });

      const items = page.data.map(toContractResponseDto);

      ok(res, items, {
        limit: page.limit,
        nextCursor: page.nextCursor,
        hasNextPage: page.hasNextPage,
      });
    } catch (error) {
      next(error);
    }
  }

  public async getContractsCursor(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      let limit: number;
      try {
        limit = parseLimit(req.query.limit);
      } catch (error) {
        res.status(400).json({
          status: 'error',
          message: (error as Error).message,
        });
        return;
      }

      const cursor = resolveCursorQueryParam(req.query.cursor);
      if (!cursor.ok) {
        res.status(400).json({
          status: 'error',
          message: cursor.message,
        });
        return;
      }

      const page = await this.service.getContractsPage({
        limit,
        cursor: cursor.cursor,
      });
      res.status(200).json({ status: 'success', data: page });
    } catch (error) {
      next(error);
    }
  }

  public async getContractsCursor(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const query = (req.query ?? {}) as Record<string, unknown>;
      let limit: number;
      try {
        limit = parseLimit(query['limit']);
      } catch (error) {
        res.status(400).json({
          status: 'error',
          message: error instanceof Error ? error.message : 'Invalid limit',
        });
        return;
      }

      const cursorResult = resolveCursorQueryParam(query['cursor']);
      if (!cursorResult.ok) {
        res.status(400).json({
          status: 'error',
          message: cursorResult.message,
        });
        return;
      }

      const page = await this.service.getContractsPage({
        limit,
        cursor: cursorResult.cursor,
      });
      res.status(200).json({ status: 'success', data: page });
    } catch (error) {
      log.error('contracts.getContracts: error', { ...ctx, err: error as Error });
      next(error);
    }
  }

  public async getContractById(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const id = req.params.id!;
    log.info('contracts.getContractById: start', { ...ctx, contractId: id });

    try {
      const contract = await this.service.getContractById(id);
      if (!contract) {
        log.warn('contracts.getContractById: not found', { ...ctx, contractId: id });
        throw new NotFoundError('The requested resource was not found');
      }
      log.info('contracts.getContractById: success', { ...ctx, contractId: id });
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      next(error);
    }
  }

  public async createContract(
    req: ContractRequest<CreateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const correlationId = getCorrelationId(res);
    log.info('contracts.createContract: start', ctx);

    try {
      const contract = await this.service.createContract(
        toCreateContractDto(req.body),
        correlationId,
      );
      log.info('contracts.createContract: success', { ...ctx, contractId: contract.id });
      ok(res, toContractResponseDto(contract), undefined, 201);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        log.warn('contracts.createContract: bounds error', { ...ctx, error: (error as Error).message });
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      log.error('contracts.createContract: error', { ...ctx, err: error as Error });
      next(error);
    }
  }

  public async updateContract(
    req: ContractRequest<UpdateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const correlationId = getCorrelationId(res);
    const id = req.params.id!;
    log.info('contracts.updateContract: start', { ...ctx, contractId: id });

    try {
      const contract = await this.service.updateContract(
        id,
        toUpdateContractDto(req.body),
        correlationId,
      );
      log.info('contracts.updateContract: success', { ...ctx, contractId: id });
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        log.warn('contracts.updateContract: bounds error', { ...ctx, contractId: id, error: (error as Error).message });
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      log.error('contracts.updateContract: error', { ...ctx, contractId: id, err: error as Error });
      next(error);
    }
  }

  public async deleteContract(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const correlationId = getCorrelationId(res);
    const id = req.params.id!;
    log.info('contracts.deleteContract: start', { ...ctx, contractId: id });

    try {
      await this.service.deleteContract(req.params.id!);
      ok(
        res,
        assertResponseSchema<DeleteContractResponse>(
          deleteContractResponseSchema,
          { message: 'Contract deleted successfully' },
          'DeleteContract',
        ),
      );
    } catch (error) {
      log.error('contracts.deleteContract: error', { ...ctx, contractId: id, err: error as Error });
      next(error);
    }
  }

  public async getContractStats(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info('contracts.getContractStats: start', ctx);

    try {
      const stats = await this.service.getContractStats();
      ok(
        res,
        assertResponseSchema<ContractStatsResponse>(
          contractStatsResponseSchema,
          stats,
          'ContractStats',
        ),
      );
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      log.error('contracts.getContractStats: error', { ...ctx, err: error as Error });
      next(error);
    }
  }

  public getBounds(_req: Request, res: Response): void {
    ok(
      res,
      assertResponseSchema<ContractBoundsResponse>(
        contractBoundsResponseSchema,
        CONTRACT_BOUNDS,
        'ContractBounds',
      ),
    );
  }
}

export { CURSOR_DEFAULT_LIMIT };

export function createContractsController(
  service: ContractsService,
  auditService?: ConstructorParameters<typeof ContractsController>[1],
) {
  const controller = new ContractsController(service, auditService);
  return {
    getContracts: controller.getContracts.bind(controller),
    getContractsCursor: controller.getContractsCursor.bind(controller),
    getContractById: controller.getContractById.bind(controller),
    createContract: controller.createContract.bind(controller),
    updateContract: controller.updateContract.bind(controller),
    deleteContract: controller.deleteContract.bind(controller),
    getContractStats: controller.getContractStats.bind(controller),
    getBounds: controller.getBounds.bind(controller),
    getContractsCursor: controller.getContractsCursor.bind(controller),
  };
}
