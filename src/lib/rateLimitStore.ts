export interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface TokenBucketEntry {
  tokens: number;
  lastRefillMs: number;
  queue: Waiter[];
}

export interface StoreOptions {
  sweepIntervalMs?: number;
}

export interface RateLimitStoreInterface {
  get(rawKey: string): any;
  set(rawKey: string, entry: any): void;
  delete(rawKey: string): void;
  getTokenBucket(rawKey: string): TokenBucketEntry | undefined;
  setTokenBucket(rawKey: string, entry: TokenBucketEntry): void;
  readonly size: number;
  readonly tokenBucketSize: number;
  sweep(windowMs?: number): void;
  destroy(): void;
}
