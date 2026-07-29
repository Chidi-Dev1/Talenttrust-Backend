/**
 * Unit tests for the shared auth error response helpers.
 *
 * Covers:
 *   - sendAuthError produces consistent { error: { code, message, requestId } }
 *   - requestId fallback to 'unknown' when res.locals is absent
 *   - errorCause set on res.locals when available
 *   - Convenience wrappers set correct status/code
 */

import {
  sendAuthError,
  sendAuthUnauthorized,
  sendAuthForbidden,
  sendAuthConflict,
  sendAuthInternalError,
} from './errorResponses';
import { Response } from 'express';

function mockRes(locals?: Record<string, unknown>): Response {
  const res: Partial<Response> = {
    locals: locals ?? {},
  };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function bodyOf(res: Response): Record<string, unknown> {
  return (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
}

describe('sendAuthError', () => {
  it('produces a structured error envelope with code, message, and requestId', () => {
    const res = mockRes({ requestId: 'req-abc-123' });
    sendAuthError(res, 401, 'invalid_credentials', 'Bad credentials');

    expect(res.status).toHaveBeenCalledWith(401);
    expect(bodyOf(res)).toEqual({
      error: {
        code: 'invalid_credentials',
        message: 'Bad credentials',
        requestId: 'req-abc-123',
      },
    });
  });

  it('falls back to "unknown" requestId when res.locals.requestId is missing', () => {
    const res = mockRes({});
    sendAuthError(res, 500, 'internal_error', 'Oops');

    expect(res.status).toHaveBeenCalledWith(500);
    expect(bodyOf(res).error).toMatchObject({ requestId: 'unknown' });
  });

  it('falls back to "unknown" requestId when res.locals is undefined', () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);

    sendAuthError(res as Response, 401, 'unauthorized', 'Nope');

    expect(bodyOf(res as Response).error).toMatchObject({ requestId: 'unknown' });
  });

  it('sets res.locals.errorCause when locals is available', () => {
    const res = mockRes({ requestId: 'req-1' });
    sendAuthError(res, 409, 'conflict', 'Duplicate');

    expect(res.locals.errorCause).toBe('conflict');
  });

  it('does not throw when res.locals is undefined', () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);

    expect(() => sendAuthError(res as Response, 500, 'internal_error', 'err')).not.toThrow();
  });
});

describe('sendAuthUnauthorized', () => {
  it('returns 401 with code "unauthorized"', () => {
    const res = mockRes({ requestId: 'req-1' });
    sendAuthUnauthorized(res, 'No access');

    expect(res.status).toHaveBeenCalledWith(401);
    expect(bodyOf(res).error).toMatchObject({
      code: 'unauthorized',
      message: 'No access',
    });
  });

  it('defaults message to "Unauthorized"', () => {
    const res = mockRes({ requestId: 'req-2' });
    sendAuthUnauthorized(res);

    expect(bodyOf(res).error).toMatchObject({ message: 'Unauthorized' });
  });
});

describe('sendAuthForbidden', () => {
  it('returns 403 with code "forbidden"', () => {
    const res = mockRes({ requestId: 'req-1' });
    sendAuthForbidden(res, 'No permission');

    expect(res.status).toHaveBeenCalledWith(403);
    expect(bodyOf(res).error).toMatchObject({
      code: 'forbidden',
      message: 'No permission',
    });
  });
});

describe('sendAuthConflict', () => {
  it('returns 409 with code "conflict"', () => {
    const res = mockRes({ requestId: 'req-1' });
    sendAuthConflict(res, 'Already exists');

    expect(res.status).toHaveBeenCalledWith(409);
    expect(bodyOf(res).error).toMatchObject({
      code: 'conflict',
      message: 'Already exists',
    });
  });
});

describe('sendAuthInternalError', () => {
  it('returns 500 with code "internal_error" and a safe default message', () => {
    const res = mockRes({ requestId: 'req-1' });
    sendAuthInternalError(res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(bodyOf(res).error).toMatchObject({
      code: 'internal_error',
      message: 'An unexpected error occurred',
    });
  });
});
