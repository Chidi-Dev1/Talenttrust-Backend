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
import { fail, ok } from '../utils/apiResponse';
import { getCorrelationId, getRequestId } from '../utils/correlationId';
import { applyPagination, parsePaginationQuery } from '../utils/pagination';
import type { Logger } from '../logger';

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
>;

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
  constructor(private readonly service: ContractsService) {}

  public async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info('contracts.getContracts: start', ctx);

    try {
      const pagination = parsePaginationQuery(
        (req.query ?? {}) as Record<string, unknown>,
      );
      if (!pagination.ok) {
        log.warn('contracts.getContracts: bad pagination params', { ...ctx, error: pagination.error });
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

      log.info('contracts.getContracts: success', { ...ctx, total });
      ok(res, pageItems, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
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
      await this.service.deleteContract(id, correlationId);
      log.info('contracts.deleteContract: success', { ...ctx, contractId: id });
      ok(res, { message: 'Contract deleted successfully' });
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
      log.info('contracts.getContractStats: success', { ...ctx, total: stats.total });
      ok(res, stats);
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
    ok(res, CONTRACT_BOUNDS);
  }

  /** @deprecated Use getContracts (unified cursor/offset handler) instead. */
  public async getContractsCursor(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    return this.getContracts(req, res, next);
  }

  /** Static variant used in route registrations that don't have an instance. */
  static getBounds(_req: Request, res: Response): void {
    ok(res, CONTRACT_BOUNDS);
  }
}

export { CURSOR_DEFAULT_LIMIT };

export function createContractsController(service: ContractsService) {
  const controller = new ContractsController(service);
  return {
    getContracts: controller.getContracts.bind(controller),
    getContractById: controller.getContractById.bind(controller),
    createContract: controller.createContract.bind(controller),
    updateContract: controller.updateContract.bind(controller),
    deleteContract: controller.deleteContract.bind(controller),
    getContractStats: controller.getContractStats.bind(controller),
    getBounds: controller.getBounds.bind(controller),
    getContractsCursor: controller.getContractsCursor.bind(controller),
  };
}
