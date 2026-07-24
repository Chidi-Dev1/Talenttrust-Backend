# Request Limits Implementation

## Queue Depth Management
To prevent memory exhaustion from unbounded waiter accumulation, we have introduced a **Hard Queue Cap**.

- **Policy**: When queue.length >= maxQueueDepth, the system throws RATE_LIMIT_QUEUE_FULL.
- **Handling**: Callers should catch this error to route the request to the Dead Letter Queue (DLQ).
- **Monitoring**: Rejections are recorded in webhookMetrics to trigger alerts before service degradation occurs.
