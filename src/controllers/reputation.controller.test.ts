import { Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';
import {
  ForbiddenError,
  ConflictError,
  ValidationError,
  AppError,
} from '../errors/appError';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';

jest.mock('../services/reputation.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const res: Partial<Response> = {
    status: statusMock,
    locals: { requestId: 'test-request-id' },
  } as unknown as Response;
  return { res, statusMock, jsonMock };
}

function makeReq(overrides: Partial<Request> = {}): Partial<Request> {
  return { params: { id: 'user-1' }, body: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// DTO Schema unit tests — validate boundary enforcement before the controller
// ---------------------------------------------------------------------------

describe('updateReputationSchema — rating field validation', () => {
  const validBase = {
    reviewerId: 'reviewer-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
  };

  describe('valid ratings', () => {
    it.each([1, 2, 3, 4, 5])('accepts rating = %i (boundary inclusive)', (rating) => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating });
      expect(result.success).toBe(true);
    });
  });

  describe('below minimum', () => {
    it('rejects rating = 0 (min - 1)', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 0 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/at least 1/i);
      }
    });

    it('rejects rating = -1', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('above maximum', () => {
    it('rejects rating = 6 (max + 1)', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 6 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/at most 5/i);
      }
    });

    it('rejects rating = 100', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 100 });
      expect(result.success).toBe(false);
    });
  });

  describe('non-integer values', () => {
    it('rejects decimal rating = 1.5', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 1.5 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/integer/i);
      }
    });

    it('rejects decimal rating = 4.9', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 4.9 });
      expect(result.success).toBe(false);
    });

    it('rejects decimal rating = 3.0001', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: 3.0001 });
      expect(result.success).toBe(false);
    });
  });

  describe('NaN and Infinity', () => {
    it('rejects NaN', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: NaN });
      expect(result.success).toBe(false);
    });

    it('rejects Infinity', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: Infinity });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/finite/i);
      }
    });

    it('rejects -Infinity', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: -Infinity });
      expect(result.success).toBe(false);
    });
  });

  describe('wrong type', () => {
    it('rejects string rating', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: '3' });
      expect(result.success).toBe(false);
    });

    it('rejects null rating', () => {
      const result = updateReputationSchema.safeParse({ ...validBase, rating: null });
      expect(result.success).toBe(false);
    });

    it('rejects missing rating', () => {
      const result = updateReputationSchema.safeParse({ ...validBase });
      expect(result.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// ReputationController — thin adapter delegating to ReputationService
// ---------------------------------------------------------------------------

describe('ReputationController.getProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with profile data on success', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 4.5, totalRatings: 10 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: mockProfile });
    expect(ReputationService.getProfile).toHaveBeenCalledWith('user-1');
  });

  it('returns 400 with structured error when service throws AppError(400, bad_request)', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Freelancer ID is required');
    });

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'bad_request',
        message: 'Freelancer ID is required',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 500 with structured error for unknown service errors', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Database down');
    });

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: 'test-request-id',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// ReputationController.createRating — thin adapter, no inline validation
// ---------------------------------------------------------------------------

describe('ReputationController.createRating', () => {
  beforeEach(() => jest.clearAllMocks());

  const validBody = {
    reviewerId: 'reviewer-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
    rating: 4,
  };

  it('returns 200 with updated profile when service succeeds', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 4.0, totalRatings: 1 };
    (ReputationService.updateProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: mockProfile });
    expect(ReputationService.updateProfile).toHaveBeenCalledWith('user-1', validBody);
  });

  // --- 400: missing/invalid payload — service throws AppError(400, bad_request) ---

  it('returns 400 when reviewerId is missing', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { rating: 3 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'bad_request' }) })
    );
  });

  it('returns 400 when rating is missing', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { reviewerId: 'reviewer-1' } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = 0 (min - 1)', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 0 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'bad_request' }) })
    );
  });

  it('returns 400 when rating = 6 (max + 1)', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 6 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = -1', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -1 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = 1.5 (decimal)', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1.5 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = NaN', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: NaN } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = Infinity', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new AppError(400, 'bad_request', 'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required');
    });
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: Infinity } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- 403 / 409 / 422: AppError subclasses from createRating guards ---

  it('returns 403 with structured error when service throws ForbiddenError', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new ForbiddenError('Users cannot rate themselves');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'forbidden',
        message: 'Users cannot rate themselves',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 409 with structured error when service throws ConflictError', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new ConflictError('Rating already exists');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'conflict',
        message: 'Rating already exists',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 422 with structured error when service throws ValidationError', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new ValidationError('Comment contains spam');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(422);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'validation_error',
        message: 'Comment contains spam',
        requestId: 'test-request-id',
      },
    });
  });

  it('returns 500 with structured error for unknown service errors', async () => {
    (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected failure');
    });
    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: 'test-request-id',
      },
    });
  });
});
