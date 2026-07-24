# Request Limits Implementation

## Queue Depth Management
To prevent memory exhaustion from unbounded waiter accumulation, we have introduced a **Hard Queue Cap**.

- **Policy**: When `queue.length >= maxQueueDepth`, the system throws `RATE_LIMIT_QUEUE_FULL`.
- **Handling**: Callers should catch this error to route the request to the Dead Letter Queue (DLQ).
- **Monitoring**: Rejections are recorded in `webhookMetrics` to trigger alerts before service degradation occurs.

---

## Redis-Backed Shared Token Bucket Store (Cluster-Wide Rate Limiting)

### Overview
In multi-replica or blue/green deployments, using per-process in-memory stores allows $N$ service replicas to send $N \times$ the intended token burst rate to external partners. The `BucketStore` abstraction in `src/rateLimit.ts` addresses this by allowing token replenishment and consumption to be backed by a centralized Redis instance while preserving local process FIFO waiter queues.

### Architecture & Abstraction
The system defines the `BucketStore` contract:

- **`InMemoryBucketStore`**: Default in-process Map storage for single-node development and testing.
- **`RedisBucketStore`**: Distributed Redis storage executing atomic token replenishment and consumption via Redis Lua scripts (`eval`).

```
 +-------------------------------------------------------+
 |                  TokenBucketLimiter                   |
 +-------------------------------------------------------+
                            |
                     (BucketStore)
                            |
             +--------------+--------------+
             |                             |
  [InMemoryBucketStore]          [RedisBucketStore]
             |                             |
      (Local Process)            (Atomic Redis Lua)
```

### Configuration & Upgrade Path
Enable cluster-wide rate limiting by setting environment variables validated in `src/config/env.schema.ts`:

```env
# Selected store backend: 'memory' (default) or 'redis'
RATE_LIMIT_STORE_TYPE=redis

# Connection URL for the shared Redis cluster
REDIS_URL=redis://redis.internal:6379

# Prefix for rate limit store keys (default: rate_limit:bucket:)
REDIS_KEY_PREFIX=rate_limit:bucket:
```

#### Upgrade Steps:
1. Provision a Redis cluster/instance reachable by all application replicas.
2. Set `RATE_LIMIT_STORE_TYPE=redis` and provide `REDIS_URL`.
3. Deploy the updated replicas. Replicas will atomically query and update bucket tokens from Redis without over-issuing tokens.

### Atomic Token Replenishment & Consumption
Redis token consumption is performed atomically via a Lua script:
- Accrues refilled tokens since `last_refill` timestamp up to `capacity`.
- Atomically checks if `tokens >= requested`.
- If allowed, decrements `tokens` and updates `last_refill` in a single Redis transaction (`HMSET`), setting an appropriate TTL key expiration (`EXPIRE`).

### Fallback Behavior & Trade-offs
- **Unconfigured**: If `REDIS_URL` or `RATE_LIMIT_STORE_TYPE=memory` is set, the system seamlessly defaults to `InMemoryBucketStore`.
- **Fault Tolerance**: If Redis connection fails or throws an operational error at runtime, `RedisBucketStore` catches the exception, logs a warning, and falls back to an internal `InMemoryBucketStore`.
- **Trade-off Note**: Operating in in-memory fallback mode protects application availability but reverts rate enforcement to per-replica boundaries during Redis outages.

### Security & Privacy
- **Key Redaction**: All provider identifiers and raw keys are hashed using `redactId(providerId)` (SHA-256) prior to being formatted into Redis storage keys (`rate_limit:bucket:<hash>`).
- **Secret Protection**: Provider secrets, raw tokens, or hostnames are never stored in Redis keys or printed in application log transports.
