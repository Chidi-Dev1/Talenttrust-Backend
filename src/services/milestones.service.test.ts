import { MilestonesService } from './milestones.service';
import { ContractBoundsError, MAX_MILESTONES_PER_CONTRACT, MAX_CONTRACT_AMOUNT_STROOPS } from '../contracts/bounds';

describe('MilestonesService', () => {
  let milestonesService: MilestonesService;

  beforeEach(() => {
    milestonesService = new MilestonesService();
  });

  describe('validateMilestonesAgainstBudget', () => {
    it('validates successfully when there are no milestones', () => {
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, undefined);
      }).not.toThrow();
    });

    it('validates successfully with valid milestones and budget', () => {
      const milestones = [
        { title: 'M1', amount: 500 },
        { title: 'M2', amount: 500 }
      ];
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, milestones as any);
      }).not.toThrow();
    });

    it('throws ContractBoundsError when budget exceeds maximum', () => {
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(MAX_CONTRACT_AMOUNT_STROOPS + 1);
      }).toThrow(ContractBoundsError);
    });

    it('throws ContractBoundsError when total milestone amount exceeds contract budget', () => {
      const milestones = [
        { title: 'M1', amount: 1500 }
      ];
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, milestones as any);
      }).toThrow(/Total milestone amount exceeds maximum contract amount/);
    });

    it('throws ContractBoundsError when milestone count exceeds max allowed', () => {
      const milestones = Array.from({ length: MAX_MILESTONES_PER_CONTRACT + 1 }, (_, i) => ({
        title: `M${i}`, amount: 1
      }));
      expect(() => {
        milestonesService.validateMilestonesAgainstBudget(1000, milestones as any);
      }).toThrow(/Milestone count/);
    });
  });
});
