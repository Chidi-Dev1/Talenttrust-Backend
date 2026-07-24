/**
 * rateLimit.ts — outbound webhook delivery pacing via a token-bucket limiter.
 *
 * The {@link TokenBucketLimiter} paces per-provider outbound webhook deliveries.
 * All bucket state (token counts, refill timestamps, and the FIFO waiter queue)
 * lives in the shared {@link RateLimitStore} so that the HTTP request limiter and
 * the webhook limiter share consistent key hashing and lifecycle semantics.
 */

import { recordThrottled } from './webhookMetrics';
import type { RateLimitStore, TokenBucketEntry } from './lib/rateLimitStore';
import { loadWebhookTokenBucketConfig } from './config/rateLimit';

/** Parsed token-bucket configuration for the outbound webhook limiter. */
export interface RateLimiterConfig {
  /** Maximum burst capacity; the bucket never holds more than this many tokens. */
  capacity: number;
  /** Steady-state token replenishment rate, in tokens per second. */
  refillRatePerSec: number;
}

/**
 * Reads the token-bucket defaults from the centralized rate-limit configuration.
 *
 * Delegates to {@link loadWebhookTokenBucketConfig} so the limiter and the rest
 * of the system agree on `WEBHOOK_BUCKET_CAPACITY` / `WEBHOOK_REFILL_RATE_PER_SEC`.
 */
export function loadRateLimiterConfig(env: NodeJS.ProcessEnv = process.env): RateLimiterConfig {
  return loadWebhookTokenBucketConfig(env);
}

/**
 * Per-provider token-bucket limiter backed by the unified {@link RateLimitStore}.
 *
 * Each `acquireToken` call refills the provider's bucket based on elapsed wall
 * time, then either consumes a token immediately or enqueues the caller until a
 * token refills. Queued callers are released in FIFO order.
 */
export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly store: RateLimitStore;
  /** Active drain timers keyed by provider id. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: RateLimiterConfig, store: RateLimitStore) {
    this.capacity = config.capacity;
    this.refillRatePerSec = config.refillRatePerSec;
    this.store = store;
  }

  /**
   * Acquire a single token for `providerId`, resolving immediately when one is
   * available or once one refills. Enqueued waiters resolve in FIFO order.
   */
  acquireToken(providerId: string): Promise<void> {
    const bucket = this.getOrCreateBucket(providerId);
    this.refill(bucket);

    // Serve immediately only when nobody is already waiting, preserving FIFO.
    if (bucket.queue.length === 0 && bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.store.setTokenBucket(providerId, bucket);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      bucket.queue.push(resolve);
      this.store.setTokenBucket(providerId, bucket);
      recordThrottled(providerId);
      this.scheduleDrain(providerId);
    });
  }

  /** Number of callers currently queued for `providerId`. */
  getQueueDepth(providerId: string): number {
    return this.store.getTokenBucket(providerId)?.queue.length ?? 0;
  }

  private getOrCreateBucket(providerId: string): TokenBucketEntry {
    const existing = this.store.getTokenBucket(providerId);
    if (existing) return existing;
    const bucket: TokenBucketEntry = {
      tokens: this.capacity,
      lastRefillMs: Date.now(),
      queue: [],
    };
    this.store.setTokenBucket(providerId, bucket);
    return bucket;
  }

  /** Add tokens accrued since the last refill, capped at capacity. */
  private refill(bucket: TokenBucketEntry): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refilled = (elapsedMs / 1000) * this.refillRatePerSec;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
    bucket.lastRefillMs = now;
  }

  /** Ensure a timer is pending to release queued waiters as tokens refill. */
  private scheduleDrain(providerId: string): void {
    if (this.timers.has(providerId)) return;
    const delayMs = Math.max(1, Math.ceil(1000 / this.refillRatePerSec));
    const timer = setTimeout(() => {
      this.timers.delete(providerId);
      this.drain(providerId);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(providerId, timer);
  }

  /** Release as many queued waiters as refilled tokens allow. */
  private drain(providerId: string): void {
    const bucket = this.store.getTokenBucket(providerId);
    if (!bucket) return;
    this.refill(bucket);

    while (bucket.queue.length > 0 && bucket.tokens >= 1) {
      bucket.tokens -= 1;
      const resolve = bucket.queue.shift();
      resolve?.();
    }
    this.store.setTokenBucket(providerId, bucket);

    if (bucket.queue.length > 0) {
      this.scheduleDrain(providerId);
    }
  }
}
