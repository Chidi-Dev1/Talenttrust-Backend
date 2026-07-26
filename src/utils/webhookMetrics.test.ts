import { register } from 'prom-client';
import {
  webhookDlqRegistry,
  incrementDlqOperation,
  incrementDlqReplay,
  resetWebhookMetrics,
} from './webhookMetrics';

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

describe('webhookMetrics DLQ counters', () => {
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

  describe('incrementDlqReplay', () => {
    it('increments each replay outcome independently', async () => {
      incrementDlqReplay('success');
      incrementDlqReplay('success');
      incrementDlqReplay('failed');
      incrementDlqReplay('idempotent_noop');
      incrementDlqReplay('error');

      await expect(
        getCounterValue('webhook_dlq_replays_total', { outcome: 'success' }),
      ).resolves.toBe(2);
      await expect(
        getCounterValue('webhook_dlq_replays_total', { outcome: 'failed' }),
      ).resolves.toBe(1);
      await expect(
        getCounterValue('webhook_dlq_replays_total', { outcome: 'idempotent_noop' }),
      ).resolves.toBe(1);
      await expect(
        getCounterValue('webhook_dlq_replays_total', { outcome: 'error' }),
      ).resolves.toBe(1);
    });

    it('rejects invalid replay labels before mutating metrics', async () => {
      incrementDlqReplay('success');

      expect(() => incrementDlqReplay('https://example.com/callback' as any)).toThrow(TypeError);
      expect(() => incrementDlqReplay('invalid_outcome' as any)).toThrow(TypeError);
      expect(() => incrementDlqReplay(undefined as any)).toThrow(TypeError);

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
});
