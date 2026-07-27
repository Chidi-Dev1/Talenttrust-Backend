import type { NextFunction, Request, Response } from 'express';
import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';
import { NotFoundError } from '../errors/appError';
import {
  CreateContractRequestDto,
  UpdateContractRequestDto,
  toContractResponseDto,
  toCreateContractDto,
  toUpdateContractDto,
} from '../modules/contracts/dto/contracts-boundary.dto';
import { ContractsService } from '../services/contracts.service';
import { createLogger } from '../logger';
import type { MetricsServiceLike } from '../observability/metrics-service';
import { fail, ok } from '../utils/apiResponse';
import { applyPagination, parsePaginationQuery } from '../utils/pagination';

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
>;

/**
 * Presentation layer for contracts. Transport DTOs are mapped explicitly at
 * this boundary so service and persistence types do not leak into handlers.
 */
export class ContractsController {
  private readonly log = createLogger({ controller: 'contracts' });

  constructor(
    private readonly service: ContractsService,
    private readonly metrics?: MetricsServiceLike,
  ) {}

  public async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const pagination = parsePaginationQuery(
        (req.query ?? {}) as Record<string, unknown>,
      );
      if (!pagination.ok) {
        fail(res, 'bad_request', pagination.error, 400);
        return;
      }

      const allContracts = await this.service.getAllContracts();
      const { page, limit, offset } = pagination.value;
      const pageItems = applyPagination(allContracts, {
        page,
        limit,
        offset,
      }).map(toContractResponseDto);
      const total = allContracts.length;

      ok(res, pageItems, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      next(error);
    }
  }

  public async getContractById(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startMs = Date.now();
    const contractId = req.params.id ?? '';
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
    const log = this.log.child({ operation: 'read', contractId, requestId });

    log.info('Milestone read operation started');

    try {
      const contract = await this.service.getContractById(contractId);
      if (!contract) {
        const durationSeconds = (Date.now() - startMs) / 1000;
        log.warn('Milestone read failed: contract not found');
        this.metrics?.recordMilestoneOperation('read', 'client_error', durationSeconds, 'not_found');
        throw new NotFoundError('The requested resource was not found');
      }

      const durationSeconds = (Date.now() - startMs) / 1000;
      log.info('Milestone read operation succeeded');
      this.metrics?.recordMilestoneOperation('read', 'success', durationSeconds);
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Already recorded — re-throw to let the error handler format the response.
        next(error);
        return;
      }
      const durationSeconds = (Date.now() - startMs) / 1000;
      log.error('Milestone read operation failed with unexpected error', { err: error instanceof Error ? error : undefined });
      this.metrics?.recordMilestoneOperation('read', 'server_error', durationSeconds, 'internal_error');
      next(error);
    }
  }

  public async createContract(
    req: ContractRequest<CreateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startMs = Date.now();
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
    const hasMilestones = Array.isArray(req.body?.milestones) && req.body.milestones.length > 0;
    const log = this.log.child({ operation: 'create', requestId, hasMilestones });

    log.info('Milestone create operation started');

    try {
      const contract = await this.service.createContract(
        toCreateContractDto(req.body),
      );

      const durationSeconds = (Date.now() - startMs) / 1000;
      log.info('Milestone create operation succeeded');
      this.metrics?.recordMilestoneOperation('create', 'success', durationSeconds);
      ok(res, toContractResponseDto(contract), undefined, 201);
    } catch (error) {
      const durationSeconds = (Date.now() - startMs) / 1000;
      if (error instanceof ContractBoundsError) {
        log.warn('Milestone create rejected: contract bounds violation', { errorMessage: error.message });
        this.metrics?.recordMilestoneOperation('create', 'client_error', durationSeconds, 'contract_bounds_error');
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      log.error('Milestone create operation failed with unexpected error', { err: error instanceof Error ? error : undefined });
      this.metrics?.recordMilestoneOperation('create', 'server_error', durationSeconds, 'internal_error');
      next(error);
    }
  }

  public async updateContract(
    req: ContractRequest<UpdateContractRequestDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const startMs = Date.now();
    const contractId = req.params.id ?? '';
    const requestId =
      typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
    const hasMilestones = Array.isArray(req.body?.milestones) && req.body.milestones.length > 0;
    const log = this.log.child({ operation: 'update', contractId, requestId, hasMilestones });

    log.info('Milestone update operation started');

    try {
      const contract = await this.service.updateContract(
        contractId,
        toUpdateContractDto(req.body),
      );

      const durationSeconds = (Date.now() - startMs) / 1000;
      log.info('Milestone update operation succeeded');
      this.metrics?.recordMilestoneOperation('update', 'success', durationSeconds);
      ok(res, toContractResponseDto(contract));
    } catch (error) {
      const durationSeconds = (Date.now() - startMs) / 1000;
      if (error instanceof ContractBoundsError) {
        log.warn('Milestone update rejected: contract bounds violation', { errorMessage: error.message });
        this.metrics?.recordMilestoneOperation('update', 'client_error', durationSeconds, 'contract_bounds_error');
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      if (error instanceof NotFoundError) {
        log.warn('Milestone update failed: contract not found');
        this.metrics?.recordMilestoneOperation('update', 'client_error', durationSeconds, 'not_found');
        next(error);
        return;
      }
      log.error('Milestone update operation failed with unexpected error', { err: error instanceof Error ? error : undefined });
      this.metrics?.recordMilestoneOperation('update', 'server_error', durationSeconds, 'internal_error');
      next(error);
    }
  }

  public async deleteContract(
    req: ContractRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      await this.service.deleteContract(req.params.id!);
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
    ok(res, CONTRACT_BOUNDS);
  }
}

export { CURSOR_DEFAULT_LIMIT };

export function createContractsController(
  service: ContractsService,
  metrics?: MetricsServiceLike,
) {
  const controller = new ContractsController(service, metrics);
  return {
    getContracts: controller.getContracts.bind(controller),
    getContractById: controller.getContractById.bind(controller),
    createContract: controller.createContract.bind(controller),
    updateContract: controller.updateContract.bind(controller),
    deleteContract: controller.deleteContract.bind(controller),
    getContractStats: controller.getContractStats.bind(controller),
    getBounds: controller.getBounds.bind(controller),
  };
}
