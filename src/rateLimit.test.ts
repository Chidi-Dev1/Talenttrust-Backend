import { RateLimitStore } from './lib/rateLimitStore';
import {
  TokenBucketLimiter,
  loadRateLimiterConfig,
  InMemoryBucketStore,
  RedisBucketStore,
  createBucketStore,
  redactId,
} from './rateLimit';

jest.mock('./webhookMetrics', () => ({
  recordThrottled: jest.fn(),
}));

/** Mock Redis implementation supporting eval (Lua) and basic hash operations */
class MockRedisClient {
  private readonly data = new Map<string, Map<string, string>>();
  public isConnected = true;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, cb: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(cb);
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    if (!this.isConnected) {
      throw new Error('Redis connection lost');
    }
    const hash = this.data.get(key);
    if (!hash) return fields.map(() => null);
    return fields.map((f) => hash.get(f) ?? null);
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.isConnected) {
      throw new Error('Redis connection lost');
    }
    const prefix = pattern.replace('*', '');
    return Array.from(this.data.keys()).filter((k) => k.startsWith(prefix));
  }

  async eval(script: string, numkeys: number, key: string, ...args: string[]): Promise<[number, number]> {
    if (!this.isConnected) {
      throw new Error('Redis connection lost');
    }
    const capacity = parseFloat(args[0]);
    const refillRate = parseFloat(args[1]);
    const now = parseFloat(args[2]);
    const requested = parseFloat(args[3]);

    let hash = this.data.get(key);
    let tokens: number;
    let lastRefill: number;

    if (!hash) {
      hash = new Map<string, string>();
      this.data.set(key, hash);
      tokens = capacity;
      lastRefill = now;
    } else {
      tokens = parseFloat(hash.get('tokens') ?? capacity.toString());
      lastRefill = parseFloat(hash.get('last_refill') ?? now.toString());
      const elapsedMs = now - lastRefill;
      if (elapsedMs > 0) {
        const refilled = (elapsedMs / 1000.0) * refillRate;
        tokens = Math.min(capacity, tokens + refilled);
        lastRefill = now;
      }
    }

    let consumed = 0;
    if (tokens >= requested) {
      tokens -= requested;
      consumed = 1;
    }

    hash.set('tokens', tokens.toString());
    hash.set('last_refill', lastRefill.toString());

    return [consumed, tokens];
  }

  async quit(): Promise<'OK'> {
    this.data.clear();
    return 'OK';
  }
}

describe('TokenBucketLimiter & BucketStore', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('InMemoryBucketStore', () => {
    it('stores provider buckets in the unified rate-limit store', async () => {
      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter({ capacity: 2, refillRatePerSec: 1 }, store);

      await limiter.acquireToken('provider-a');
      await limiter.acquireToken('provider-b');

      expect(store.tokenBucketSize).toBe(2);
      expect(await limiter.getTokenCount('provider-a')).toBe(1);
      expect(await limiter.getTokenCount('provider-b')).toBe(1);

      store.destroy();
    });

    it('preserves token-bucket queuing and refill behavior', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1_000);
      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const store = new RateLimitStore({ sweepIntervalMs: 0 });
      const limiter = new TokenBucketLimiter({ capacity: 1, refillRatePerSec: 1 }, store);

      await limiter.acquireToken('provider-a');
      const queued = limiter.acquireToken('provider-a');

      expect(limiter.getQueueDepth('provider-a')).toBe(1);

      jest.setSystemTime(2_000);
      jest.advanceTimersByTime(1_000);
      await queued;

      expect(limiter.getQueueDepth('provider-a')).toBe(0);
      expect(await limiter.getTokenCount('provider-a')).toBe(0);

      store.destroy();
    });
  });

  describe('RedisBucketStore (Cross-instance & Atomic operations)', () => {
    it('enforces limit cluster-wide across multiple instances sharing a Redis store', async () => {
      const mockRedis = new MockRedisClient();
      const redisStore = new RedisBucketStore({ redisClient: mockRedis });

      const instance1 = new TokenBucketLimiter({ capacity: 3, refillRatePerSec: 1 }, redisStore);
      const instance2 = new TokenBucketLimiter({ capacity: 3, refillRatePerSec: 1 }, redisStore);

      // Acquire 2 tokens on instance1
      await instance1.acquireToken('provider-x');
      await instance1.acquireToken('provider-x');

      expect(await redisStore.getTokenCount('provider-x')).toBe(1);

      // Acquire 1 token on instance2 (3rd total token, now bucket is empty)
      await instance2.acquireToken('provider-x');

      expect(await redisStore.getTokenCount('provider-x')).toBe(0);

      // Attempt 4th token on instance1 — bucket empty, should enqueue
      let instance1Acquired = false;
      const p4 = instance1.acquireToken('provider-x').then(() => {
        instance1Acquired = true;
      });

      expect(limiterQueueDepth(instance1, 'provider-x')).toBe(1);
      expect(instance1Acquired).toBe(false);

      await redisStore.destroy();
    });

    it('handles burst over capacity cleanly', async () => {
      const mockRedis = new MockRedisClient();
      const redisStore = new RedisBucketStore({ redisClient: mockRedis });

      const capacity = 2;
      const consumed1 = await redisStore.consumeToken('provider-y', capacity, 1);
      const consumed2 = await redisStore.consumeToken('provider-y', capacity, 1);
      const consumed3 = await redisStore.consumeToken('provider-y', capacity, 1);

      expect(consumed1).toBe(true);
      expect(consumed2).toBe(true);
      expect(consumed3).toBe(false);

      await redisStore.destroy();
    });

    it('falls back cleanly to in-process memory mode when Redis throws an error', async () => {
      const mockRedis = new MockRedisClient();
      const redisStore = new RedisBucketStore({ redisClient: mockRedis });

      // Consume 1 token successfully
      const c1 = await redisStore.consumeToken('provider-z', 2, 1);
      expect(c1).toBe(true);

      // Simulate Redis disconnect / error
      mockRedis.isConnected = false;

      // Next consume should fall back to memory store without throwing
      const c2 = await redisStore.consumeToken('provider-z', 2, 1);
      expect(typeof c2).toBe('boolean');

      await redisStore.destroy();
    });
  });

  describe('createBucketStore factory', () => {
    it('creates InMemoryBucketStore when RATE_LIMIT_STORE_TYPE is memory', () => {
      const store = createBucketStore({ RATE_LIMIT_STORE_TYPE: 'memory' });
      expect(store).toBeInstanceOf(InMemoryBucketStore);
      store.destroy();
    });

    it('creates RedisBucketStore when custom redisClient is provided', () => {
      const mockRedis = new MockRedisClient();
      const store = createBucketStore({}, mockRedis);
      expect(store).toBeInstanceOf(RedisBucketStore);
      store.destroy();
    });
  });

  describe('Security & redaction', () => {
    it('hashes provider IDs so raw secrets or identifiers never appear in store keys', () => {
      const rawSecretProvider = 'secret-provider-key-12345';
      const opaqueKey = redactId(rawSecretProvider);

      expect(opaqueKey).not.toContain('secret-provider-key');
      expect(opaqueKey).toHaveLength(64); // SHA-256 hex string
    });
  });
});

describe('loadRateLimiterConfig', () => {
  it('reads token-bucket defaults from centralized rate-limit config', () => {
    const originalCapacity = process.env.WEBHOOK_BUCKET_CAPACITY;
    const originalRefill = process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    process.env.WEBHOOK_BUCKET_CAPACITY = '7';
    process.env.WEBHOOK_REFILL_RATE_PER_SEC = '3';

    expect(loadRateLimiterConfig()).toEqual({ capacity: 7, refillRatePerSec: 3 });

    if (originalCapacity === undefined) {
      delete process.env.WEBHOOK_BUCKET_CAPACITY;
    } else {
      process.env.WEBHOOK_BUCKET_CAPACITY = originalCapacity;
    }

    if (originalRefill === undefined) {
      delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    } else {
      process.env.WEBHOOK_REFILL_RATE_PER_SEC = originalRefill;
    }
  });
});

function limiterQueueDepth(limiter: TokenBucketLimiter, providerId: string): number {
  return limiter.getQueueDepth(providerId);
}
