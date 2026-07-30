import { describe, it, expect } from '@jest/globals';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  mapErrorToPayload,
} from '../../errors/appError';
import { ZodError } from 'zod';

/**
 * Snapshot tests for auth error-response bodies (RFC 7807 / structured shape).
 *
 * These tests lock the shape of error payloads so that unintended drift
 * is caught during code review.  Update the snapshots intentionally when
 * the API contract changes.
 */
describe('auth error-response snapshots', () => {
  it('400 validation error shape', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['body', 'email'],
        message: 'Required',
      },
    ]);
    const { payload } = mapErrorToPayload(zodError, 'req-auth-001');
    expect(payload).toMatchSnapshot();
  });

  it('401 unauthorized error shape', () => {
    const err = new UnauthorizedError('Invalid credentials');
    const { payload } = mapErrorToPayload(err, 'req-auth-002');
    expect(payload).toMatchSnapshot();
  });

  it('404 not-found error shape', () => {
    const err = new NotFoundError('Auth resource not found');
    const { payload } = mapErrorToPayload(err, 'req-auth-003');
    expect(payload).toMatchSnapshot();
  });

  it('409 conflict error shape', () => {
    const err = new ConflictError('An account with that email already exists');
    const { payload } = mapErrorToPayload(err, 'req-auth-004');
    expect(payload).toMatchSnapshot();
  });

  it('500 internal-server-error shape', () => {
    const err = new Error('Unexpected database failure');
    const { payload } = mapErrorToPayload(err, 'req-auth-005');
    expect(payload).toMatchSnapshot();
  });
});
