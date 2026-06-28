import { RateLimiter } from './rateLimit';

describe('RateLimiter Queue Capping', () => {
  it('should reject requests when queue exceeds maxDepth', async () => {
    const limiter = new RateLimiter();
    const maxDepth = 1;

    // Fill the queue
    await limiter.acquireToken('provider-1', maxDepth);

    // Assert that the next request is rejected
    await expect(limiter.acquireToken('provider-1', maxDepth))
      .rejects.toThrow('RATE_LIMIT_QUEUE_FULL');
  });
});
