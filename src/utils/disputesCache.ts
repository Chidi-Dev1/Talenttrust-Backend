import { Counter, register as promRegister } from 'prom-client';
import { SWRCache } from './swrCache';
import { DISPUTES_METRICS, DISPUTES_CACHE_KEYS } from '../modules/disputes/constants';

export interface DisputesCacheConfig {
  ttlMs: number;
  swrMs: number;
  maxEntries: number;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_SWR_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 100;

export const disputesCacheHitsTotal = new Counter({
  name: DISPUTES_METRICS.CACHE_HITS_TOTAL,
  help: 'Total number of disputes cache hits',
  labelNames: ['type'] as const,
  registers: [promRegister],
});

export const disputesCacheMissesTotal = new Counter({
  name: DISPUTES_METRICS.CACHE_MISSES_TOTAL,
  help: 'Total number of disputes cache misses',
  labelNames: ['type'] as const,
  registers: [promRegister],
});

export class DisputesCache {
  private cache: SWRCache;
  private options: { ttlMs: number; swrMs: number };

  constructor(config?: Partial<DisputesCacheConfig>) {
    this.cache = new SWRCache({
      maxEntries: config?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    });
    this.options = {
      ttlMs: config?.ttlMs ?? DEFAULT_TTL_MS,
      swrMs: config?.swrMs ?? DEFAULT_SWR_MS,
    };
  }

  async getOrFetchList<T>(fetcher: () => Promise<T>): Promise<{ data: T; source: 'cache_fresh' | 'cache_stale' | 'upstream' }> {
    const result = await this.cache.get(DISPUTES_CACHE_KEYS.LIST, fetcher, this.options);
    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      disputesCacheHitsTotal.inc({ type: 'list' });
    } else {
      disputesCacheMissesTotal.inc({ type: 'list' });
    }
    return { data: result.data as T, source: result.source };
  }

  async getOrFetchDispute<T>(id: string, fetcher: () => Promise<T>): Promise<{ data: T; source: 'cache_fresh' | 'cache_stale' | 'upstream' }> {
    const result = await this.cache.get(DISPUTES_CACHE_KEYS.forDispute(id), fetcher, this.options);
    if (result.source === 'cache_fresh' || result.source === 'cache_stale') {
      disputesCacheHitsTotal.inc({ type: 'dispute' });
    } else {
      disputesCacheMissesTotal.inc({ type: 'dispute' });
    }
    return { data: result.data as T, source: result.source };
  }

  invalidateList(): void {
    this.cache.delete(DISPUTES_CACHE_KEYS.LIST);
  }

  invalidateDispute(id: string): void {
    this.cache.delete(DISPUTES_CACHE_KEYS.forDispute(id));
  }

  get size(): number {
    return this.cache.size;
  }

  get maxEntries(): number {
    return this.cache.maxEntries;
  }
}
