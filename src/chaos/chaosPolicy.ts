import { AppConfig } from '../appConfiguration';

export type ChaosResult = 'none' | 'error' | 'timeout';

/**
 * Decides whether to inject deterministic or probabilistic failures for a dependency call.
 * 
 * Decision Matrix:
 * 1. Target match: If `chaosTargets` is empty, all dependencies match. Otherwise, matched case-insensitively. If no match, returns 'none'.
 * 2. Mode dispatch:
 *    - 'error': returns 'error'
 *    - 'timeout': returns 'timeout'
 *    - 'random': evaluates `Math.random() < chaosProbability` ? 'error' : 'none'
 *    - default (e.g. 'off' or unknown): returns 'none'
 */
export class ChaosPolicy {
  constructor(private readonly config: Pick<AppConfig, 'chaosMode' | 'chaosTargets' | 'chaosProbability'>) {}

  decide(dependencyName: string): ChaosResult {
    const dependency = dependencyName.toLowerCase();

    if (!this.isTargeted(dependency)) {
      return 'none';
    }

    switch (this.config.chaosMode) {
      case 'error':
        return 'error';
      case 'timeout':
        return 'timeout';
      case 'random':
        return Math.random() < this.config.chaosProbability ? 'error' : 'none';
      default:
        return 'none';
    }
  }

  private isTargeted(dependencyName: string): boolean {
    if (this.config.chaosTargets.length === 0) {
      return true;
    }

    return this.config.chaosTargets.includes(dependencyName);
  }
}
