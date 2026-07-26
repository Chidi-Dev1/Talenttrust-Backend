import { register } from 'prom-client';
import {
  webhookDlqRegistry,
  incrementDlqOperation,
  incrementDlqReplay,
  resetWebhookMetrics,
} from './webhookMetrics';

/**
 * Extract the current value of a counter for a specific label set.
 *
 * @param metricName - The prom-client metric name.
 * @param labels - The label key/value pair to look up.
 * @returns The counter value, or `undefined` if the label set has not been
 *   observed yet.
 */
async function getCounterValue(
  metricName: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const metrics = await webhookDlqRegistry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === metricName);
  if (!metric) return undefined;

  const values = metric.values as Array<{
    labels: Record<string, string>;
    value: number;
  }>;

  const match = values.find((v) =>
    Object.entries(labels).every(([key, value]) => v.labels[key] === value),
  );
  return match?.value;
}

async function getMetricLabelNames(metricName: string): Promise<string[]> {
  const metrics = await webhookDlqRegistry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === metricName);
  if (!metric) return [];

  const values = metric.values as Array<{ labels: Record<string, string> }>;
  const keys = new Set<string>();
  for (const value of values) {
    for (const key of Object.keys(value.labels)) {
      keys.add(key);
    }
  }
  return Array.from(keys).sort();
}

async function getMetricLabelValues(
  metricName: string,
  labelKey: string,
): Promise<string[]> {
  const metrics = await webhookDlqRegistry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === metricName);
  if (!metric) return [];

  const values = metric.values as Array<{ labels: Record<string, string> }>;
  const seen = new Set<string>();
  for (const value of values) {
    if (labelKey in value.labels) {
      seen.add(value.labels[labelKey]);
    }
  }
  return Array.from(seen).sort();
}

function resetWebhookMetrics(): void {
  webhookDlqOperationsTotal.reset();
  webhookDlqReplaysTotal.reset();
}

describe('incrementDlqOperation', () => {
  beforeEach(() => {
    resetWebhookMetrics();
  });

  describe('incrementDlqOperation', () => {
    it('increments each operation independently', async () => {
      incrementDlqOperation('enqueue');
      incrementDlqOperation('enqueue');
      incrementDlqOperation('drop_overflow');
      incrementDlqOperation('drop_poison');

      await expect(
        getCounterValue('webhook_dlq_operations_total', { operation: 'enqueue' }),
      ).resolves.toBe(2);
      await expect(
        getCounterValue('webhook_dlq_operations_total', { operation: 'drop_overflow' }),
      ).resolves.toBe(1);
      await expect(
        getCounterValue('webhook_dlq_operations_total', { operation: 'drop_poison' }),
      ).resolves.toBe(1);
    });

    it('rejects invalid operation labels before mutating metrics', async () => {
      incrementDlqOperation('enqueue');

      expect(() => incrementDlqOperation('https://example.com/webhook' as any)).toThrow(TypeError);
      expect(() => incrementDlqOperation('invalid_operation' as any)).toThrow(TypeError);
      expect(() => incrementDlqOperation(undefined as any)).toThrow(TypeError);

      await expect(
        getCounterValue('webhook_dlq_operations_total', { operation: 'enqueue' }),
      ).resolves.toBe(1);
    });

    it('emits only bounded operation label values', async () => {
      incrementDlqOperation('enqueue');
      incrementDlqOperation('drop_overflow');
      incrementDlqOperation('drop_poison');

      await expect(getMetricLabelNames('webhook_dlq_operations_total')).resolves.toEqual(['operation']);
      await expect(getMetricLabelValues('webhook_dlq_operations_total', 'operation')).resolves.toEqual([
        'drop_overflow',
        'drop_poison',
        'enqueue',
      ]);
    });
  });

  it('increments the drop_poison counter', async () => {
    incrementDlqOperation('drop_poison');
    const value = await getCounterValue('webhook_dlq_operations_total', {
      operation: 'drop_poison',
    });
    expect(value).toBe(1);
  });

      await expect(
        getCounterValue('webhook_dlq_replays_total', { outcome: 'success' }),
      ).resolves.toBe(1);
    });

    it('emits only bounded replay label values', async () => {
      incrementDlqReplay('success');
      incrementDlqReplay('failed');
      incrementDlqReplay('idempotent_noop');
      incrementDlqReplay('error');

      await expect(getMetricLabelNames('webhook_dlq_replays_total')).resolves.toEqual(['outcome']);
      await expect(getMetricLabelValues('webhook_dlq_replays_total', 'outcome')).resolves.toEqual([
        'error',
        'failed',
        'idempotent_noop',
        'success',
      ]);
    });
  });

  describe('registry isolation and constants', () => {
    it('uses an isolated registry instead of the global prom-client registry', () => {
      expect(webhookDlqRegistry).not.toBe(register);
      expect(webhookDlqOperationsTotal.registers).toContain(webhookDlqRegistry);
      expect(webhookDlqReplaysTotal.registers).toContain(webhookDlqRegistry);
    });

    it('exports the expected metric names and help text', () => {
      expect(webhookDlqOperationsTotal.name).toBe('webhook_dlq_operations_total');
      expect(webhookDlqReplaysTotal.name).toBe('webhook_dlq_replays_total');
      expect(webhookDlqOperationsTotal.help).toContain('DLQ');
      expect(webhookDlqReplaysTotal.help).toContain('DLQ');
    });

    it('does not expose URL-like label names or values', async () => {
      incrementDlqOperation('enqueue');
      incrementDlqReplay('success');

      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      for (const metric of metrics) {
        for (const value of metric.values as Array<{ labels: Record<string, string> }>) {
          for (const [key, labelValue] of Object.entries(value.labels)) {
            expect(key).not.toMatch(/url|path|host|endpoint/i);
            expect(labelValue).not.toMatch(/^https?:\/\//);
          }
        }
      }
    });
  });

  it('replays metric never exposes raw URLs in any label', async () => {
    incrementDlqReplay('success');

    const metrics = await webhookDlqRegistry.getMetricsAsJSON();
    const replays = metrics.find((m) => m.name === 'webhook_dlq_replays_total');
    const values = (replays?.values ?? []) as Array<{
      labels: Record<string, string>;
    }>;

    for (const v of values) {
      for (const [key, val] of Object.entries(v.labels)) {
        expect(key).not.toMatch(/url|path|host|endpoint/i);
        expect(val).not.toMatch(/^https?:\/\//);
      }
    }
  });

  it('operations metric has exactly one label dimension', async () => {
    incrementDlqOperation('enqueue');
    incrementDlqOperation('drop_overflow');

    const labelNames = await getMetricLabelNames('webhook_dlq_operations_total');
    expect(labelNames).toHaveLength(1);
  });

  it('replays metric has exactly one label dimension', async () => {
    incrementDlqReplay('success');
    incrementDlqReplay('failed');

    const labelNames = await getMetricLabelNames('webhook_dlq_replays_total');
    expect(labelNames).toHaveLength(1);
  });
});
