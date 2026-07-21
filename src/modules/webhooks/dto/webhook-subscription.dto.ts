import { z } from 'zod';

export const createWebhookSubscriptionSchema = z.object({
  body: z.object({
    consumerId: z.string().uuid().optional(),
    url: z.string().url(),
    eventType: z.string().min(1).max(100),
    secret: z.string().min(1).max(256).optional(),
  }),
});

export const updateWebhookSubscriptionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    url: z.string().url().optional(),
    eventType: z.string().min(1).max(100).optional(),
    secret: z.string().min(1).max(256).optional(),
    active: z.boolean().optional(),
  }),
});

export const getWebhookSubscriptionSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listWebhookSubscriptionsQuerySchema = z.object({
  query: z.object({
    consumerId: z.string().uuid().optional(),
    eventType: z.string().optional(),
    active: z.preprocess((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return val;
    }, z.boolean().optional()),
  }).partial(),
});
