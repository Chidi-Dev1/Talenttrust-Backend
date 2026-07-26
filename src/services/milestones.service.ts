import { Milestone, validateContractBounds, ContractBoundsError } from '../contracts/bounds';

/**
 * Service layer for milestone business logic.
 */
export class MilestonesService {
  /**
   * Validates milestones against policy bounds only.
   * Throws ContractBoundsError if validation fails.
   */
  public validateBounds(budget: number, milestones?: Milestone[]): void {
    const boundsCheck = validateContractBounds(budget, milestones);
    if (!boundsCheck.valid) {
      throw new ContractBoundsError(boundsCheck.error);
    }
  }

  /**
   * Validates milestones against policy bounds and the contract's budget.
   * Throws ContractBoundsError if validation fails.
   *
   * @param budget The total contract budget in stroops.
   * @param milestones Optional list of milestones to validate.
   */
  public validateMilestonesAgainstBudget(budget: number, milestones?: Milestone[]): void {
    this.validateBounds(budget, milestones);

    // Enforce that the sum of milestone amounts does not exceed the contract
    // budget. `validateContractBounds` only guards the absolute policy cap
    // (MAX_CONTRACT_AMOUNT_STROOPS); the per-contract budget is the tighter,
    // caller-supplied limit that milestone payouts must never overrun.
    if (milestones && milestones.length > 0) {
      const totalMilestoneAmount = milestones.reduce(
        (sum, milestone) => sum + milestone.amount,
        0,
      );
      if (totalMilestoneAmount > budget) {
        throw new ContractBoundsError(
          `Total milestone amount exceeds maximum contract amount ` +
            `(milestones total ${totalMilestoneAmount} exceeds budget of ${budget})`,
        );
      }
    }
  }
}
