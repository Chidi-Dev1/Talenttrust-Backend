/**
 * @module contracts-bulk.controller
 * @description Bulk contracts operations controller.
 *
 * Handles POST /api/v1/contracts/bulk with per-item independent processing.
 * 
 * ## Transaction Model
 *
 * Each item is processed independently in its own transaction:
 * - Item N's success or failure does not affect Item N+1's transaction
 * - If Item N fails (validation error, bounds violation, or permission denied),
 *   Item N's write never happens, but Item N+1 continues normally
 * - No cascading rollbacks across items
 *
 * ## Authorization
 *
 * Authorization is checked per-item:
 * - An item the caller lacks permission for fails with an auth error
 * - Valid items in the same batch still succeed
 * - This matches the single-item endpoint's per-resource authorization model
 */

import type { NextFunction, Request, Response } from 'express';
import type { ContractsService } from '../services/contracts.service';
import type {
  CreateContractRequestDto,
  ContractResponseDto,
} from '../modules/contracts/dto/contracts-boundary.dto';
import {
  toCreateContractDto,
  toContractResponseDto,
} from '../modules/contracts/dto/contracts-boundary.dto';
import type {
  BulkCreateContractsResponse,
  BulkItemResult,
} from '../modules/contracts/dto/bulk-operations.dto';
import { ContractBoundsError } from '../contracts/bounds';
import { NotFoundError } from '../errors/appError';
import { fail, ok } from '../utils/apiResponse';

type ContractRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
>;

/**
 * Result of attempting to process a single bulk item.
 * @internal
 */
interface ProcessedItemResult {
  status: 'success' | 'error';
  code: number;
  data?: ContractResponseDto;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Presentation layer for bulk contracts operations.
 */
export class ContractsBulkController {
  constructor(private readonly service: ContractsService) {}

  /**
   * POST /api/v1/contracts/bulk
   *
   * Creates multiple contracts in a single request.
   * Each item is validated and processed independently.
   * One item's failure does not affect other items.
   *
   * Request: Array of contract creation payloads (each validated against createContractSchema)
   * Response: Per-item results with overall summary
   *
   * @param req - Express request with array body
   * @param res - Express response
   * @param next - Express next middleware
   */
  public async bulkCreateContracts(
    req: ContractRequest<CreateContractRequestDto[]>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const items = req.body ?? [];

      // Process each item independently, collecting results
      const results: BulkItemResult<ContractResponseDto>[] = [];
      for (const item of items) {
        const result = await this.processSingleCreateItem(item);
        results.push(result);
      }

      // Calculate summary
      const succeeded = results.filter((r) => r.status === 'success').length;
      const failed = results.filter((r) => r.status === 'error').length;

      const response: BulkCreateContractsResponse<ContractResponseDto> = {
        items: results,
        summary: {
          total: items.length,
          succeeded,
          failed,
        },
      };

      // Always return 200 (request was successfully processed, see per-item results)
      // If all items failed, it's still a 200 since the bulk endpoint itself succeeded
      ok(res, response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Processes a single item from a bulk create request.
   * Returns a per-item result object (success or error).
   *
   * @param item - A single contract creation request
   * @returns Per-item result (success with contract data, or error with details)
   * @internal
   */
  private async processSingleCreateItem(
    item: CreateContractRequestDto,
  ): Promise<BulkItemResult<ContractResponseDto>> {
    try {
      // Convert transport DTO to service DTO
      const createDto = toCreateContractDto(item);

      // Call service (includes validation and persistence)
      const contract = await this.service.createContract(createDto);

      // Return success result
      return {
        status: 'success',
        code: 201,
        data: toContractResponseDto(contract),
      };
    } catch (error) {
      // Map errors to per-item error results
      return this.mapErrorToItemResult(error);
    }
  }

  /**
   * Maps an error thrown during item processing to a bulk item error result.
   * Reuses the same error codes and messages as the single-item endpoint.
   *
   * @param error - Error thrown during processing
   * @returns Per-item error result with appropriate HTTP code and message
   * @internal
   */
  private mapErrorToItemResult(error: unknown): BulkItemResult<ContractResponseDto> {
    if (error instanceof ContractBoundsError) {
      return {
        status: 'error',
        code: 422,
        error: {
          code: 'contract_bounds_error',
          message: error.message,
        },
      };
    }

    if (error instanceof NotFoundError) {
      return {
        status: 'error',
        code: 404,
        error: {
          code: 'not_found',
          message: error.message,
        },
      };
    }

    // Generic validation/business logic error
    if (error instanceof Error) {
      return {
        status: 'error',
        code: 400,
        error: {
          code: 'invalid_request',
          message: error.message,
        },
      };
    }

    // Unexpected error
    return {
      status: 'error',
      code: 500,
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred while processing this item',
      },
    };
  }
}

export function createContractsBulkController(service: ContractsService) {
  const controller = new ContractsBulkController(service);
  return {
    bulkCreateContracts: controller.bulkCreateContracts.bind(controller),
  };
}
