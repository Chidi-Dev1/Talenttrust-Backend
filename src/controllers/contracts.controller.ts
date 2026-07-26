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
import { BulkMilestoneOperationDto } from '../modules/contracts/dto/contract.dto';
import { ContractsService } from '../services/contracts.service';
import { WebhookService } from '../services/webhook.service';
import { fail, ok } from '../utils/apiResponse';
import { applyPagination, parsePaginationQuery } from '../utils/pagination';
import { auditService as defaultAuditService, AuditService } from '../audit/service';
import {
  buildMilestonesAuditMetadata,
  determineMilestonesAction,
  getLastMilestonesSnapshot,
  summarizeMilestones,
} from '../modules/contracts/milestonesAudit';

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
> & { user?: { id: string } };

/**
 * Presentation layer for contracts. Transport DTOs are mapped explicitly at
 * this boundary so service and persistence types do not leak into handlers.
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

      const page = await this.service.getContractsPage({
        cursor: cursorResult.cursor,
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
      next(error);
    }
  }

  public async getContractById(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contract = await this.service.getContractById(req.params.id!);
      if (!contract) {
        throw new NotFoundError('The requested resource was not found');
      }
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
    try {
      const dto = toCreateContractDto(req.body);
      const contract = await this.service.createContract(dto);
      this.recordMilestonesAudit(req, contract.id, dto.milestones);
      ok(res, toContractResponseDto(contract), undefined, 201);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  public async updateContract(
    req: ContractRequest<UpdateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const dto = toUpdateContractDto(req.body);
      const contract = await this.service.updateContract(req.params.id!, dto);
      if (dto.milestones !== undefined) {
        this.recordMilestonesAudit(req, contract.id, dto.milestones);
      }
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  public async deleteContract(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = req.params.id!;
      await this.service.deleteContract(id);
      // Reuses the same create/update/delete classification: passing no
      // milestones as the "after" state naturally resolves to
      // MILESTONES_DELETED when — and only when — this contract had a
      // recorded milestones snapshot to lose.
      this.recordMilestonesAudit(req, id, undefined);
      ok(res, { message: 'Contract deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  public async getContractStats(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      ok(res, await this.service.getContractStats());
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  public getBounds(_req: Request, res: Response): void {
    ok(res, this.service.getBounds());
  }

  public async getContractHistory(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const history = await this.service.getContractHistory(req.params.id!);
      res.status(200).json(history);
    } catch (error) {
      next(error);
    }
  }

  public getBounds(req: Request, res: Response): void {
    ContractsController.getBounds(req, res);
  }

  /**
   * GET /:id/milestones/audit-log — bounded, cursor-paginated read view of
   * the MILESTONES_* audit entries recorded for a single contract, newest
   * first. Reuses the audit store's own pagination bound (1–100 per page,
   * default 20) rather than introducing a second limit policy.
   */
  public async getMilestonesAuditLog(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contract = await this.service.getContractById(req.params.id!);
      if (!contract) {
        throw new NotFoundError('The requested resource was not found');
      }

      const rawLimit = req.query?.['limit'];
      const limit =
        typeof rawLimit === 'string' && rawLimit.trim() !== '' && Number.isFinite(Number(rawLimit))
          ? Number(rawLimit)
          : 20;
      const cursor = typeof req.query?.['cursor'] === 'string' ? req.query['cursor'] : undefined;

      const page = this.auditService.queryWithCursor({
        resource: 'milestones',
        resourceId: req.params.id!,
        limit,
        ...(cursor !== undefined && { cursor }),
      });

      // Newest-first for a "what happened, most recent first" review view;
      // the store returns entries in insertion (oldest-first) order.
      ok(res, { ...page, entries: [...page.entries].reverse() });
    } catch (error) {
      next(error);
    }
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
    getMilestonesAuditLog: controller.getMilestonesAuditLog.bind(controller),
  };
}
