import { Registry } from 'prom-client';
import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics-service';

function makeService(httpRouteLabelLimit?: number) {
  const register = new Registry();
  const service = new MetricsService('test', register, { httpRouteLabelLimit });
  return { service, register };
}

function recordHttpRequest(
  service: MetricsService,
  request: {
    method?: string;
    baseUrl?: string;
    routePath?: string;
    statusCode?: number;
  },
) {
  const response = new EventEmitter() as Response & EventEmitter;
  response.statusCode = request.statusCode ?? 200;

  const req = {
    method: request.method ?? 'GET',
    baseUrl: request.baseUrl ?? '',
    route: request.routePath === undefined ? undefined : { path: request.routePath },
  } as unknown as Request;

  const next = jest.fn() as NextFunction;

  service.trackHttpRequest(req, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  response.emit('finish');
}

async function routeLabels(register: Registry): Promise<string[]> {
  const metrics = await register.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === 'http_requests_total');
  return ((counter?.values ?? []) as any[]).map((value) => value.labels.route);
}

describe('MetricsService — webhook metrics', () => {
  it('increments webhook_deliveries_total with outcome=success', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('success');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    expect(counter).toBeDefined();
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'success');
    expect(value?.value).toBe(1);
  });

  it('increments webhook_deliveries_total with outcome=failure', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('failure');
    service.recordWebhookDelivery('failure');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'failure');
    expect(value?.value).toBe(2);
  });

  it('increments webhook_deliveries_total with outcome=dlq', async () => {
    const { service, register } = makeService();

    service.recordWebhookDelivery('dlq');

    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'webhook_deliveries_total');
    const value = (counter!.values as any[]).find((v) => v.labels.outcome === 'dlq');
    expect(value?.value).toBe(1);
  });

  it('sets webhook_dlq_depth gauge', async () => {
    const { service, register } = makeService();

    service.setWebhookDlqDepth(3);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'webhook_dlq_depth');
    expect(gauge).toBeDefined();
    expect((gauge!.values as any[])[0].value).toBe(3);
  });

  it('updates webhook_dlq_depth on subsequent calls', async () => {
    const { service, register } = makeService();

    service.setWebhookDlqDepth(1);
    service.setWebhookDlqDepth(5);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'webhook_dlq_depth');
    expect((gauge!.values as any[])[0].value).toBe(5);
  });
});

describe('MetricsService — HTTP route labels', () => {
  it('uses the mounted Express route template instead of concrete paths', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, {
      method: 'GET',
      baseUrl: '/api/v1/contracts',
      routePath: '/:id/metadata/:metadataId',
    });

    expect(await routeLabels(register)).toContain('/api/v1/contracts/:id/metadata/:metadataId');
  });

  it('collapses unmatched requests into one bucket', async () => {
    const { service, register } = makeService();

    recordHttpRequest(service, { routePath: undefined, statusCode: 404 });
    recordHttpRequest(service, { routePath: undefined, statusCode: 404 });

    expect(await routeLabels(register)).toEqual(['unmatched']);
  });

  it('keeps new route labels through the configured cap boundary', async () => {
    const { service, register } = makeService(2);

    recordHttpRequest(service, { routePath: '/health' });
    recordHttpRequest(service, { routePath: '/metrics' });

    expect(await routeLabels(register)).toEqual(expect.arrayContaining(['/health', '/metrics']));
  });

  it('routes excess distinct templates to other under a high-cardinality flood', async () => {
    const { service, register } = makeService(3);

    for (let index = 0; index < 20; index += 1) {
      recordHttpRequest(service, {
        baseUrl: '/api/v1',
        routePath: `/resource-${index}/:id`,
      });
    }

    const labels = await routeLabels(register);
    const distinctLabels = new Set(labels);

    expect(distinctLabels.size).toBe(4);
    expect(labels).toContain('other');
    expect(labels).not.toContain('/api/v1/resource-19/:id');
  });
});
