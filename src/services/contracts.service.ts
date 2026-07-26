import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';
import { Contract } from '../db/types';
import type { IContractRepository } from '../repositories/contractRepository';
import { SorobanService } from './soroban.service';
import type { CursorPaginationInput, CursorPage } from '../contracts/cursor.types';

import { validateContractBounds, ContractBoundsError } from '../contracts/bounds';
import { MAX_MILESTONES_PER_CONTRACT, MAX_CONTRACT_AMOUNT_STROOPS } from '../contracts/bounds';
import { NotFoundError, MissingVersionError, InvalidVersionError, VersionConflictError } from '../errors/appError';
import { parseBoolEnv } from '../config/env';

/**
 * @dev Service layer for managing Freelancer Escrow Contracts.
 * Handles business logic, database interactions,
 * and orchestration with the Soroban smart contract service.
 */
export class ContractsService {
  private contractRepository: IContractRepository;
  private sorobanService: SorobanService;
  /**
   * When `false`, milestone fields are stripped from create/update payloads
   * before any validation or persistence occurs. The feature is fully
   * transparent to callers — requests still succeed but milestones are
   * silently ignored.
   *
   * Defaults to `true` (read from `MILESTONES_ENABLED` env var at
   * construction time) so the flag can be injected in tests without
   * touching `process.env`.
   */
  private readonly milestonesEnabled: boolean;

  constructor(contractRepository: IContractRepository, milestonesEnabled?: boolean) {
    this.sorobanService = new SorobanService();
    this.contractRepository = contractRepository;
    this.milestonesEnabled =
      milestonesEnabled !== undefined
        ? milestonesEnabled
        : parseBoolEnv('MILESTONES_ENABLED', true);
  }

  /**
   * Retrieves all contracts from the repository.
   * @returns Array of contract metadata including version field.
   */
  public async getAllContracts(): Promise<Contract[]> {
    return this.contractRepository.findAll();
  }

  /**
   * Retrieves a single contract by ID.
   * @param id The contract UUID.
   * @returns The contract or undefined if not found.
   */
  public async getContractById(id: string): Promise<Contract | undefined> {
    return this.contractRepository.findById(id);
  }

  /**
   * Returns a cursor-paginated page of contracts ordered by `createdAt DESC`.
   *
   * @param input - Optional `limit` (1–100) and opaque `cursor` string.
   * @returns A {@link CursorPage} with items and next-page cursor.
   */
  public async getContractsPage(
    input: CursorPaginationInput = {},
  ): Promise<CursorPage<Contract>> {
    return this.contractRepository.findPage(input);
  }

  /**
   * Creates a new contract off-chain, preparing it for escrow deposit.
   * Enforces milestone count and total amount caps before persisting.
   * @param data The contract details conforming to CreateContractDto.
   * @returns The newly created contract object.
   * @throws ContractBoundsError if budget or milestone totals exceed policy limits.
   */
  public async createContract(data: CreateContractDto): Promise<Contract> {
    // Strip milestones when the feature flag is disabled. Validation and
    // budget-cap checks are skipped entirely — the contract is created as if
    // no milestones were supplied.
    const effectiveData: CreateContractDto = this.milestonesEnabled
      ? data
      : { ...data, milestones: undefined };

    const boundsCheck = validateContractBounds(effectiveData.budget, effectiveData.milestones);
    if (!boundsCheck.valid) {
      throw new ContractBoundsError(boundsCheck.error);
    }

    // Enforce that the sum of milestone amounts does not exceed the contract
    // budget. `validateContractBounds` only guards the absolute policy cap
    // (MAX_CONTRACT_AMOUNT_STROOPS); the per-contract budget is the tighter,
    // caller-supplied limit that milestone payouts must never overrun.
    if (effectiveData.milestones && effectiveData.milestones.length > 0) {
      const totalMilestoneAmount = effectiveData.milestones.reduce(
        (sum, milestone) => sum + milestone.amount,
        0,
      );
      if (totalMilestoneAmount > effectiveData.budget) {
        throw new ContractBoundsError(
          `Total milestone amount exceeds maximum contract amount ` +
            `(milestones total ${totalMilestoneAmount} exceeds budget of ${effectiveData.budget})`,
        );
      }
    }

    const newContract = await this.contractRepository.create({
      title: effectiveData.title,
      clientId: effectiveData.clientId,
      freelancerId: effectiveData.freelancerId ?? '',
      amount: effectiveData.budget,
      status: effectiveData.status || 'draft',
    });

    // Notify the Soroban service to prepare the transaction
    try {
      await this.sorobanService.prepareEscrow(newContract.id, data.budget);
    } catch (error) {
      console.warn(`[ContractsService] Soroban prepareEscrow failed for contract ${newContract.id}:`, error);
    }

    return newContract;
  }

  /**
   * Updates a contract using Optimistic Concurrency Control (OCC).
   *
   * Requires the caller to supply the `version` they last observed. The update
   * succeeds only when the stored version matches the supplied value; the version
   * is then atomically incremented by 1. If the stored version differs (another
   * writer got there first), a {@link VersionConflictError} is thrown.
   *
   * Maps every updatable field from {@link UpdateContractDto} into the update
   * payload and re-runs {@link validateContractBounds} whenever `budget` or
   * `milestones` are included in the patch. Rejects empty patches with a
   * validation error so callers receive a clear signal rather than a misleading
   * 200 that changed nothing.
   *
   * @param id - UUID of the contract to update.
   * @param dto - Partial update payload including the OCC `version`.
   * @returns The updated Contract with an incremented version.
   * @throws {MissingVersionError} When `version` is not provided.
   * @throws {InvalidVersionError} When `version` is not a non-negative integer.
   * @throws {ContractBoundsError} When amount or milestone bounds are violated.
   * @throws {VersionConflictError} When the version is stale (another update won).
   * @throws {NotFoundError} When the contract ID does not exist.
   *
   * @security The version check is enforced at the database level via a single
   * atomic `UPDATE ... WHERE version = ?` statement. It cannot be bypassed by
   * omitting the version field because this method validates it before calling
   * the repository.
   */
  public async updateContract(id: string, dto: UpdateContractDto): Promise<Contract> {
    const { version, ...fields } = dto;

    // Defense-in-depth: validate version even though middleware already checked
    if (version === undefined || version === null) {
      throw new MissingVersionError();
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new InvalidVersionError();
    }

    // Strip milestones from the update payload when the feature flag is
    // disabled, so milestone data supplied by callers is silently ignored.
    const effectiveFields = this.milestonesEnabled
      ? fields
      : { ...fields, milestones: undefined };

    // Reject no-op updates
    const hasFields = Object.keys(effectiveFields).some(
      (k) => (effectiveFields as Record<string, unknown>)[k] !== undefined,
    );
    if (!hasFields) {
      throw new Error('At least one field must be provided for an update.');
    }

    // Re-validate bounds when amount or milestones are being changed
    const budget = effectiveFields.budget;
    const milestones = effectiveFields.milestones;
    if (budget !== undefined || milestones !== undefined) {
      // Fall back to 0 if budget is absent so the bounds check can still run on milestones alone
      const boundsCheck = validateContractBounds(budget ?? 0, milestones);
      if (!boundsCheck.valid) {
        throw new ContractBoundsError(boundsCheck.error);
      }
    }

    const updateFields: Partial<Contract> = {};
    if (effectiveFields.title !== undefined) updateFields.title = effectiveFields.title;
    if (effectiveFields.status !== undefined) updateFields.status = effectiveFields.status;
    if (effectiveFields.budget !== undefined) updateFields.amount = effectiveFields.budget;
    if (effectiveFields.freelancerId !== undefined) updateFields.freelancerId = effectiveFields.freelancerId ?? '';

    return this.contractRepository.updateWithVersion(id, updateFields, version);
  }

  /**
   * Deletes a contract by ID.
   */
  public async deleteContract(id: string): Promise<void> {
    const deleted = await this.contractRepository.delete(id);
    if (!deleted) {
      throw new NotFoundError(`Contract with id ${id} not found`);
    }
  }

  /**
   * Retrieves contract statistics.
   */
  public async getContractStats() {
    const all = await this.getAllContracts();
    const stats = {
      total: all.length,
      totalBudget: all.reduce((sum, c) => sum + c.amount, 0),
      byStatus: all.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
    return stats;
  }

  /**
   * Retrieves policy bounds.
   */
  public getBounds() {
    return {
      maxMilestones: MAX_MILESTONES_PER_CONTRACT,
      maxAmount: MAX_CONTRACT_AMOUNT_STROOPS,
    };
  }
}
