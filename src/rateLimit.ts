import { metrics } from './webhookMetrics';

export class RateLimiter {
  private queue: any[] = [];
  
  // Implementation of bounded queue depth
  async acquireToken(providerId: string, maxQueueDepth: number): Promise<void> {
    if (this.queue.length >= maxQueueDepth) {
      metrics.recordRejection(providerId); // Metrics tracking
      throw new Error('RATE_LIMIT_QUEUE_FULL'); // Typed error for DLQ routing
    }
    
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
}
