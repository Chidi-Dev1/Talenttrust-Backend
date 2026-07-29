/**
 * @module auth/errorResponses
 * @description Shared error response helpers for the auth subsystem.
 *
 * Centralises auth error response formatting into a single module so that
 * every auth handler (routes, middleware, API key auth) produces the same
 * structured error envelope:
 *
 *   { error: { code, message, requestId } }
 *
 * The `requestId` is sourced from `res.locals.requestId` (set by the
 * global `requestIdMiddleware`) and falls back to `"unknown"` when the
 * middleware was unexpectedly skipped.
 *
 * Every helper also sets `res.locals.errorCause` so the observability
 * layer can tag metrics with the underlying error code without parsing
 * the response body.
 *
 * ## Usage
 *
 * ```ts
 * import { sendAuthError } from '../auth/errorResponses';
 *
 * // In a route handler:
 * sendAuthError(res, 401, 'invalid_credentials', 'Request validation failed');
 *
 * // Convenience helpers:
 * sendAuthUnauthorized(res, 'Invalid token');
 * sendAuthForbidden(res, 'Insufficient permissions');
 * sendAuthConflict(res, 'An account with that email already exists');
 * sendAuthInternalError(res);
 * ```
 */

import type { Response } from 'express';

/**
 * Extracts the `requestId` from `res.locals` (set by the global
 * `requestIdMiddleware`) with a safe fallback.
 */
function getRequestId(res: Response): string {
  return typeof res.locals?.requestId === 'string' && res.locals.requestId.length > 0
    ? res.locals.requestId
    : 'unknown';
}

/**
 * Sends a structured auth error response and sets `res.locals.errorCause`
 * when `res.locals` is available.
 *
 * @param res     - Express response object.
 * @param status  - HTTP status code (400-599).
 * @param code    - Machine-readable error code (e.g. `"invalid_credentials"`).
 * @param message - Human-readable error message.
 */
export function sendAuthError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  if (res.locals) {
    res.locals.errorCause = code;
  }
  res.status(status).json({
    error: {
      code,
      message,
      requestId: getRequestId(res),
    },
  });
}

/**
 * Sends a 401 Unauthorized auth error.
 *
 * @param res     - Express response object.
 * @param message - Human-readable detail; defaults to `"Unauthorized"`.
 */
export function sendAuthUnauthorized(
  res: Response,
  message = 'Unauthorized',
): void {
  sendAuthError(res, 401, 'unauthorized', message);
}

/**
 * Sends a 403 Forbidden auth error.
 *
 * @param res     - Express response object.
 * @param message - Human-readable detail; defaults to `"Forbidden"`.
 */
export function sendAuthForbidden(
  res: Response,
  message = 'Forbidden',
): void {
  sendAuthError(res, 403, 'forbidden', message);
}

/**
 * Sends a 409 Conflict auth error.
 *
 * @param res     - Express response object.
 * @param message - Human-readable detail; defaults to `"Conflict"`.
 */
export function sendAuthConflict(
  res: Response,
  message = 'Conflict',
): void {
  sendAuthError(res, 409, 'conflict', message);
}

/**
 * Sends a 500 Internal Server Error auth response.
 *
 * @param res     - Express response object.
 * @param message - Human-readable detail; defaults to a safe generic message.
 */
export function sendAuthInternalError(
  res: Response,
  message = 'An unexpected error occurred',
): void {
  sendAuthError(res, 500, 'internal_error', message);
}
