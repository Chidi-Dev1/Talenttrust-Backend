import type { NextFunction, Request, Response } from 'express';
import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { resolveCursorQueryParam, parseLimit } from '../contracts/cursor.repository';
import { CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';
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

export const MILESTONE_EVENTS = {
  CREATED: 'milestone.created',
  UPDATED: 'milestone.updated',
  DELETED: 'milestone.deleted',
} as const;

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
  private readonly webhookService: WebhookService;

  constructor(private readonly service: ContractsService) {
    this.webhookService = new WebhookService();
  }

  public async getContracts(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawCursor = (req.query ?? {}).cursor;
      const cursorResult = resolveCursorQueryParam(rawCursor);
      if (!cursorResult.ok) {
        fail(res, 'bad_request', cursorResult.message, 400);
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

      // Fire-and-forget milestone webhook if milestones are present
      if (dto.milestones && dto.milestones.length > 0) {
        this.webhookService
          .trigger(
            MILESTONE_EVENTS.CREATED,
            { contractId: contract.id, milestones: dto.milestones },
            req.headers['x-correlation-id'] as string | undefined,
          )
          .catch(() => { /* webhook delivery errors are logged by the service */ });
      }

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
      const contract = await this.service.updateContract(
        req.params.id!,
        dto,
      );

      // Fire-and-forget milestone webhook if milestones are being updated
      if (dto.milestones) {
        this.webhookService
          .trigger(
            MILESTONE_EVENTS.UPDATED,
            { contractId: contract.id, milestones: dto.milestones },
            req.headers['x-correlation-id'] as string | undefined,
          )
          .catch(() => { /* webhook delivery errors are logged by the service */ });
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
      const contract = await this.service.getContractById(req.params.id!);

      await this.service.deleteContract(req.params.id!);

      // Fire-and-forget milestone webhook if the deleted contract had milestones
      if (contract && contract.milestones && contract.milestones.length > 0) {
        this.webhookService
          .trigger(
            MILESTONE_EVENTS.DELETED,
            { contractId: contract.id },
            req.headers['x-correlation-id'] as string | undefined,
          )
          .catch(() => { /* webhook delivery errors are logged by the service */ });
      }

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

  public async bulkMilestones(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { operations } = req.body as { operations: BulkMilestoneOperationDto[] };

      const results = await this.service.bulkMilestones(operations);

      const succeeded = results.filter((r) => r.status === 'success').length;
      const failed = results.filter((r) => r.status === 'error').length;

      const response: BulkMilestonesResponseDto = {
        results,
        summary: {
          total: results.length,
          succeeded,
          failed,
        },
      };

      ok(res, response);
    } catch (error) {
      next(error);
    }
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
    bulkMilestones: controller.bulkMilestones.bind(controller),
  };
}
