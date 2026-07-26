/**
 * @module modules/disputes/dto
 * @description Data Transfer Objects for disputes API.
 *
 * Defines Zod schemas for request/response validation on all disputes endpoints.
 */

import { z } from 'zod';

/**
 * Dispute status enum — defines the full state machine for disputes.
 * Valid transitions are validated at the service layer.
 */
export const DisputeStatusEnum = z.enum(
  ['open', 'under_review', 'resolved', 'escalated'],
  {
    errorMap: () => ({
      message: `Status must be one of: open, under_review, resolved, escalated`,
    }),
  },
);

export type DisputeStatus = z.infer<typeof DisputeStatusEnum>;

/**
 * Schema for a single dispute ID (used in route params and batch operations).
 * IDs are UUIDs or similar format — kept simple for demo.
 */
export const disputeIdSchema = z
  .string()
  .min(1, 'Dispute ID cannot be empty')
  .max(255, 'Dispute ID is too long')
  .describe('Unique identifier for a dispute');

/**
 * Schema for a single batch operation item.
 * Represents one dispute to update in a batch request.
 */
export const batchDisputeOperationSchema = z.object(
  {
    id: disputeIdSchema,
    status: DisputeStatusEnum,
    resolution: z
      .string()
      .max(1000, 'Resolution note cannot exceed 1000 characters')
      .optional()
      .describe('Optional resolution note or reasoning'),
  },
  {
    description: 'A single dispute update operation within a batch',
  },
);

export type BatchDisputeOperation = z.infer<typeof batchDisputeOperationSchema>;

/**
 * Schema for the bulk batch request.
 * Maximum 50 operations per request.
 */
export const batchDisputeRequestSchema = z.object(
  {
    operations: z
      .array(batchDisputeOperationSchema)
      .min(1, 'Batch must contain at least one operation')
      .max(50, 'Batch size cannot exceed 50 operations')
      .describe('Array of dispute operations to process'),
  },
  {
    description: 'Bulk dispute update request',
  },
);

export type BatchDisputeRequest = z.infer<typeof batchDisputeRequestSchema>;

/**
 * Dispute object returned in responses.
 */
export const disputeResponseSchema = z.object(
  {
    id: z.string(),
    status: DisputeStatusEnum,
    contractId: z.string(),
    resolution: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  },
  {
    description: 'A dispute object',
  },
);

export type DisputeResponse = z.infer<typeof disputeResponseSchema>;

/**
 * Schema for a single batch result item (success case).
 */
export const batchResultSuccessSchema = z.object(
  {
    index: z.number().int().min(0),
    success: z.literal(true),
    dispute: disputeResponseSchema,
  },
  {
    description: 'Successful batch operation result',
  },
);

/**
 * Schema for a single batch result item (error case).
 */
export const batchResultErrorSchema = z.object(
  {
    index: z.number().int().min(0),
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  },
  {
    description: 'Failed batch operation result',
  },
);

/**
 * Schema for the bulk batch response.
 */
export const batchDisputeResponseSchema = z.object(
  {
    results: z.array(z.union([batchResultSuccessSchema, batchResultErrorSchema])),
    summary: z.object({
      total: z.number().int().min(0),
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
  },
  {
    description: 'Bulk dispute update response',
  },
);

export type BatchDisputeResponse = z.infer<typeof batchDisputeResponseSchema>;

/**
 * Update dispute schema (single item, reused from PATCH endpoint).
 */
export const updateDisputeSchema = z.object(
  {
    status: DisputeStatusEnum.optional(),
    resolution: z.string().max(1000).optional(),
  },
  {
    description: 'Dispute update payload',
  },
);

export type UpdateDisputePayload = z.infer<typeof updateDisputeSchema>;
