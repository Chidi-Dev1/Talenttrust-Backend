/**
 * @module utils/swrCache
 * @description Stale-While-Revalidate (SWR) in-memory cache layer.
 * Provides high-availability fallback by returning stale data with a
 * degraded signal while transparently updating from upstream in the background.
 */

export interface CacheOptions {
  /** Time-To-Live in milliseconds. Cache is considered fresh during this period. */
  ttlMs: number;
  /** Stale-While-Revalidate window in milliseconds. Allowed time past TTL to serve stale data. */
  swrMs: number;
}

export interface SWRResult<T> {
  data: T;
  /** True if the data served was stale (SWR window) */
  degraded: boolean;
  /** Identifies the origin of the response payload */
  source: 'upstream' | 'cache_fresh' | 'cache_stale';
}

interface CacheEntry<T> {
  data: T;
  updatedAt: number;
}

/**
 * Stale-While-Revalidate (SWR) cache implementation.
 *
 * Provides high-availability fallback by returning stale data with a degraded signal
 * while transparently updating from upstream in the background. Supports coalesced
 * concurrent requests to prevent upstream stampedes.
 *
 * @example
 * ```typescript
 * const cache = new SWRCache();
 * const result = await cache.get('user:123', fetchUser, { ttlMs: 5000, swrMs: 30000 });
 * if (result.degraded) {
 *   // Data is stale but available immediately
 * }
 * ```
 */
export class SWRCache {
  /**
   * In-memory SWR cache store mapping keys to cached entries.
   * Each entry stores the payload and the last update timestamp.
   */
  private cache = new Map<string, CacheEntry<any>>();
  /**
   * Tracks in-flight fetches keyed by cache key.
   * Used to coalesce concurrent requests for the same key
   * so upstream is not hit redundantly.
   */
  private activeFetches = new Map<string, Promise<any>>();

  /**
   * Retrieve data from cache or upstream fetcher using SWR strategy.
   *
   * The SWR strategy follows these rules:
   * - Fresh hit: Returns cached value without calling fetcher (age < ttlMs)
   * - Stale hit: Returns stale value immediately, triggers background revalidation (ttlMs <= age < ttlMs + swrMs)
   * - Miss/Expired: Blocks and waits for upstream fetch, coalescing concurrent requests
   *
   * @param key - The cache key. Use scoped keys (e.g. `resource:userId`) to prevent access control violations.
   * @param fetcher - Async function to fetch fresh data from upstream.
   * @param options - TTL and SWR window configurations.
   * @returns Promise resolving to the cached or fresh data with metadata.
   */
  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions
  ): Promise<SWRResult<T>> {
    const now = Date.now();
    const entry = this.cache.get(key);

    if (entry) {
      const age = now - entry.updatedAt;

      // 1. Fresh hit
      if (age < options.ttlMs) {
        return { data: entry.data as T, degraded: false, source: 'cache_fresh' };
      }

      // 2. Stale hit (within SWR window)
      if (age < options.ttlMs + options.swrMs) {
        if (!this.activeFetches.has(key)) {
          this.revalidate(key, fetcher);
        }
        return { data: entry.data as T, degraded: true, source: 'cache_stale' };
      }
    }

    // 3. Cache miss or completely expired - block and wait for upstream
    if (this.activeFetches.has(key)) {
      // Coalesce identical overlapping fetches to prevent upstream stampedes
      const data = await this.activeFetches.get(key);
      return { data, degraded: false, source: 'upstream' };
    }

    const data = await this.revalidate(key, fetcher);
    return { data, degraded: false, source: 'upstream' };
  }

  /**
   * Revalidates the cache entry by fetching fresh data from upstream.
   * Manages active fetch tracking to coalesce concurrent requests.
   * On error, logs to console and removes the pending fetch tracking.
   *
   * @param key - The cache key to revalidate.
   * @param fetcher - Async function to fetch fresh data.
   * @returns Promise resolving to the fetched data.
   */
  private async revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const fetchPromise = fetcher()
      .then((newData) => {
        this.cache.set(key, { data: newData, updatedAt: Date.now() });
        this.activeFetches.delete(key);
        return newData;
      })
      .catch((err) => {
        this.activeFetches.delete(key);
        console.error(`[SWR Cache] Background revalidation failed for key: ${key}`, err.message);
        throw err;
      });

    this.activeFetches.set(key, fetchPromise);
    return fetchPromise;
  }
}
