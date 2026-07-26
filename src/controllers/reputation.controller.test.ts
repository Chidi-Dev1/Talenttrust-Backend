import { NextFunction, Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';
import { AppError, ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
import { updateReputationSchema } from '../modules/reputation/dto/reputation.dto';

jest.mock('../services/reputation.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes(): { res: Partial<Response>; statusMock: jest.Mock; jsonMock: jest.Mock; nextMock: jest.Mock } {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const nextMock = jest.fn();
  const res: Partial<Response> = {
    status: statusMock,
    locals: { requestId: 'test-request-id' },
  } as unknown as Response;
  return { res, statusMock, jsonMock, nextMock };
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
// ReputationController — getProfile
// ---------------------------------------------------------------------------

describe('ReputationController.getProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with profile data on success', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 4.5, totalRatings: 10 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock, nextMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response, nextMock as NextFunction);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: mockProfile });
    expect(nextMock).not.toHaveBeenCalled();
  });

  it('forwards "Freelancer ID is required" as a 400 AppError to next', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Freelancer ID is required');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response, nextMock as NextFunction);

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('bad_request');
    expect(error.message).toBe('Freelancer ID is required');
  });

  it('forwards unknown errors to next unchanged', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Database down');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.getProfile(makeReq() as Request, res as Response, nextMock as NextFunction);

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Database down');
  });
});

// ---------------------------------------------------------------------------
// ReputationController.createRating — defense-in-depth guard
// ---------------------------------------------------------------------------

describe('ReputationController.createRating', () => {
  beforeEach(() => jest.clearAllMocks());

  const validBody = {
    reviewerId: 'reviewer-1',
    contextId: '550e8400-e29b-41d4-a716-446655440000',
    rating: 4,
  };

  it('returns 200 when payload is valid', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 4.0, totalRatings: 1 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, jsonMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response,
      nextMock as NextFunction
    );

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: mockProfile });
    expect(nextMock).not.toHaveBeenCalled();
  });

  // --- Missing / invalid required fields ---

  it('forwards 400 AppError when reviewerId is missing', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { rating: 3 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('forwards 400 AppError when rating is missing', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { reviewerId: 'reviewer-1' } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  // --- Out-of-range rating values ---

  it('forwards 400 AppError when rating = 0 (min - 1)', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 0 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('bad_request');
  });

  it('forwards 400 AppError when rating = 6 (max + 1)', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 6 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('forwards 400 AppError when rating = -1', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -1 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('forwards 400 AppError when rating = 100', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 100 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  // --- Non-integer ratings ---

  it('forwards 400 AppError when rating = 1.5 (decimal)', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1.5 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('forwards 400 AppError when rating = 4.9 (decimal)', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 4.9 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  // --- NaN and Infinity ---

  it('forwards 400 AppError when rating = NaN', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: NaN } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('forwards 400 AppError when rating = Infinity', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: Infinity } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  it('forwards 400 AppError when rating = -Infinity', async () => {
    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -Infinity } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
  });

  // --- Boundary: valid edge values ---

  it('accepts rating = 1 (minimum)', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 1.0, totalRatings: 1 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(nextMock).not.toHaveBeenCalled();
  });

  it('accepts rating = 5 (maximum)', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 5.0, totalRatings: 1 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 5 } }) as Request,
      res as Response,
      nextMock as NextFunction
    );
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(nextMock).not.toHaveBeenCalled();
  });

  // --- Service-layer errors are surfaced correctly ---

  it('forwards ForbiddenError to next', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ForbiddenError('Users cannot rate themselves');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response,
      nextMock as NextFunction
    );

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('Users cannot rate themselves');
  });

  it('forwards ConflictError to next', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ConflictError('Rating already exists');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response,
      nextMock as NextFunction
    );

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.statusCode).toBe(409);
  });

  it('forwards ValidationError to next', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ValidationError('Comment contains spam');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response,
      nextMock as NextFunction
    );

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(422);
  });

  it('forwards unknown errors to next unchanged', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected failure');
    });

    const { res, nextMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response,
      nextMock as NextFunction
    );

    expect(nextMock).toHaveBeenCalledTimes(1);
    const error = nextMock.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Unexpected failure');
  });
});
