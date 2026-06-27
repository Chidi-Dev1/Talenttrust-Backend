import { SWRCache, CacheOptions } from './swrCache';

describe('SWRCache', () => {
  const TTL_MS = 1000;
  const SWR_MS = 1000;
  const options: CacheOptions = { ttlMs: TTL_MS, swrMs: SWR_MS };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('fresh hit', () => {
    it('returns cached value without calling the fetcher', async () => {
      const cache = new SWRCache();
      const fetcher = jest.fn().mockResolvedValue('fresh');
      const key = 'test:key';

      const first = await cache.get(key, fetcher, options);

      expect(first).toEqual({ data: 'fresh', degraded: false, source: 'upstream' });

      const result = await cache.get(key, fetcher, options);

      expect(result).toEqual({ data: 'fresh', degraded: false, source: 'cache_fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns fresh value for entries within TTL', async () => {
      const cache = new SWRCache();
      const fetcher = jest.fn().mockResolvedValue('data');
      const key = 'test:fresh-ttl';

      await cache.get(key, fetcher, options);

      jest.advanceTimersByTime(500);

      const result = await cache.get(key, fetcher, options);
      expect(result).toEqual({ data: 'data', degraded: false, source: 'cache_fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale hit', () => {
    it('returns stale value immediately and revalidates in background once', async () => {
      const cache = new SWRCache();
      const fetcher = jest.fn().mockResolvedValue('initial');
      const key = 'test:stale';

      await cache.get(key, fetcher, options);

      expect(fetcher).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(TTL_MS + 10);

      const revalidateFetcher = jest.fn().mockResolvedValue('v2');
      const p1 = cache.get(key, revalidateFetcher, options);
      const p2 = cache.get(key, revalidateFetcher, options);
      const p3 = cache.get(key, revalidateFetcher, options);

      const results = await Promise.all([p1, p2, p3]);

      expect(results[0]).toEqual({ data: 'initial', degraded: true, source: 'cache_stale' });
      expect(results[1]).toEqual({ data: 'initial', degraded: true, source: 'cache_stale' });
      expect(results[2]).toEqual({ data: 'initial', degraded: true, source: 'cache_stale' });

      expect(revalidateFetcher).toHaveBeenCalledTimes(1);

      await Promise.resolve();

      const after = await cache.get(key, revalidateFetcher, options);
      expect(after).toEqual({ data: 'v2', degraded: false, source: 'cache_fresh' });
    });
  });

  describe('cache miss', () => {
    it('awaits the fetcher and populates the entry', async () => {
      const cache = new SWRCache();
      const fetcher = jest.fn().mockResolvedValue('upserted');
      const key = 'test:miss';

      const result = await cache.get(key, fetcher, options);

      expect(result).toEqual({ data: 'upserted', degraded: false, source: 'upstream' });
      expect(fetcher).toHaveBeenCalledTimes(1);

      const fresh = await cache.get(key, fetcher, options);
      expect(fresh).toEqual({ data: 'upserted', degraded: false, source: 'cache_fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('completely refetches if SWR window has expired', async () => {
      const cache = new SWRCache();
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce('initial')
        .mockResolvedValueOnce('renewed');
      const key = 'test:expired';

      await cache.get(key, fetcher, options);

      expect(fetcher).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(TTL_MS + SWR_MS + 100);

      const result = await cache.get(key, fetcher, options);
      expect(result).toEqual({ data: 'renewed', degraded: false, source: 'upstream' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('revalidation error', () => {
    it('does not throw to callers and retains stale value after background revalidation fails', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const cache = new SWRCache();
      const seedFetcher = jest.fn().mockResolvedValue('stale-data');
      const key = 'test:reval-error';

      await cache.get(key, seedFetcher, options);

      expect(seedFetcher).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(TTL_MS + 10);

      const failedFetcher = jest.fn().mockRejectedValue(new Error('network down'));

      const result = await cache.get(key, failedFetcher, options);

      expect(result).toEqual({ data: 'stale-data', degraded: true, source: 'cache_stale' });
      expect(failedFetcher).toHaveBeenCalledTimes(1);

      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Background revalidation failed'),
        'network down'
      );

      consoleSpy.mockRestore();
    });

    it('does not rethrow revalidation errors to stale callers', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const cache = new SWRCache();
      const fetcher = jest.fn().mockResolvedValue('original');
      const key = 'test:reval-no-throw';

      await cache.get(key, fetcher, options);

      jest.advanceTimersByTime(TTL_MS + 10);

      const errorPromise = cache.get(key, jest.fn().mockRejectedValue(new Error('fetch failed')), options);

      const result = await errorPromise;

      expect(result).toEqual({ data: 'original', degraded: true, source: 'cache_stale' });

      await expect(errorPromise).resolves.toEqual(result);

      consoleSpy.mockRestore();
    });
  });

  describe('concurrent miss coalescing', () => {
    it('awaits a single fetch for overlapping callers', async () => {
      const cache = new SWRCache();
      let resolveFetcher: (value: string) => void;
      const fetcher = jest.fn().mockImplementation(
        () =>
          new Promise<string>((res) => {
            resolveFetcher = res;
          })
      );
      const key = 'test:coalesce';

      const p1 = cache.get(key, fetcher, options);
      const p2 = cache.get(key, fetcher, options);
      const p3 = cache.get(key, fetcher, options);

      expect(fetcher).toHaveBeenCalledTimes(1);

      resolveFetcher!('coalesced');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1).toEqual({ data: 'coalesced', degraded: false, source: 'upstream' });
      expect(r2).toEqual({ data: 'coalesced', degraded: false, source: 'upstream' });
      expect(r3).toEqual({ data: 'coalesced', degraded: false, source: 'upstream' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('propagates error on initial fetch failure', async () => {
      const cache = new SWRCache();
      const fetcher = jest.fn().mockRejectedValue(new Error('upstream failed'));
      const key = 'test:error';

      await expect(cache.get(key, fetcher, options)).rejects.toThrow('upstream failed');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
