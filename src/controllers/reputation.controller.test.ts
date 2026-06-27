import { Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';
import { ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
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
// ReputationController — getProfile
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
  });

  it('returns 400 with structured error when service throws "Freelancer ID is required"', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Freelancer ID is required');
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

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'success', data: mockProfile });
  });

  // --- Missing / invalid required fields ---

  it('returns 400 when reviewerId is missing', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { rating: 3 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating is missing', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { reviewerId: 'reviewer-1' } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- Out-of-range rating values ---

  it('returns 400 when rating = 0 (min - 1)', async () => {
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
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 6 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = -1', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -1 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = 100', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 100 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- Non-integer ratings ---

  it('returns 400 when rating = 1.5 (decimal)', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1.5 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = 4.9 (decimal)', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 4.9 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- NaN and Infinity ---

  it('returns 400 when rating = NaN', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: NaN } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = Infinity', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: Infinity } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rating = -Infinity', async () => {
    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: -Infinity } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(400);
  });

  // --- Boundary: valid edge values ---

  it('accepts rating = 1 (minimum)', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 1.0, totalRatings: 1 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 1 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('accepts rating = 5 (maximum)', async () => {
    const mockProfile = { freelancerId: 'user-1', score: 5.0, totalRatings: 1 };
    (ReputationService.getProfile as jest.Mock).mockReturnValue(mockProfile);

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: { ...validBody, rating: 5 } }) as Request,
      res as Response
    );
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  // --- Service-layer errors are surfaced correctly ---

  it('returns 403 when service throws ForbiddenError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ForbiddenError('Users cannot rate themselves');
    });

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Users cannot rate themselves' });
  });

  it('returns 409 when service throws ConflictError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ConflictError('Rating already exists');
    });

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(409);
  });

  it('returns 422 when service throws ValidationError', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new ValidationError('Comment contains spam');
    });

    const { res, statusMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(422);
  });

  it('returns 500 for unknown service errors', async () => {
    (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
      throw new Error('Unexpected failure');
    });

    const { res, statusMock, jsonMock } = makeRes();
    await ReputationController.createRating(
      makeReq({ body: validBody }) as Request,
      res as Response
    );

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Internal server error' });
  });
});
