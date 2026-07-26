import { Request, Response, NextFunction } from 'express';
import { ContractBoundsError, CONTRACT_BOUNDS } from '../contracts/bounds';

const mockGetAllContracts = jest.fn();
const mockGetContractById = jest.fn();
const mockCreateContract = jest.fn();
const mockGetContractsPage = jest.fn();
const mockUpdateContract = jest.fn();
const mockDeleteContract = jest.fn();
const mockGetContractStats = jest.fn();
const mockGetContractHistory = jest.fn();

jest.mock('../db/database', () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock('../repositories/contractRepository', () => ({
  ContractRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/contracts.service', () => ({
  ContractsService: jest.fn().mockImplementation(() => ({
    getAllContracts: mockGetAllContracts,
    getContractById: mockGetContractById,
    createContract: mockCreateContract,
    getContractsPage: mockGetContractsPage,
    updateContract: mockUpdateContract,
    deleteContract: mockDeleteContract,
    getContractStats: mockGetContractStats,
    getContractHistory: mockGetContractHistory,
    getBounds: jest.fn().mockReturnValue(CONTRACT_BOUNDS),
  })),
}));

import { ContractsController } from './contracts.controller';

describe('ContractsController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let controller: ContractsController;
  let mockAuditService: { log: jest.Mock; query: jest.Mock; queryWithCursor: jest.Mock };

  beforeEach(() => {
    mockRequest = {
      body: { title: 'Test Contract' },
      query: {},
      params: {},
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: { audit: {} as never },
    };
    mockNext = jest.fn();

    mockGetAllContracts.mockClear();
    mockGetContractById.mockClear();
    mockCreateContract.mockClear();
    mockGetContractsPage.mockClear();
    mockUpdateContract.mockClear();
    mockDeleteContract.mockClear();
    mockGetContractStats.mockClear();
    mockGetContractHistory.mockClear();

    mockAuditService = {
      log: jest.fn(),
      query: jest.fn().mockReturnValue([]),
      queryWithCursor: jest.fn().mockReturnValue({ entries: [], count: 0, limit: 20 }),
    };

    const { ContractsService } = require('../services/contracts.service');
    controller = new ContractsController(new ContractsService(), mockAuditService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getContracts — cursor pagination
  // -------------------------------------------------------------------------

  describe('getContracts — cursor pagination', () => {
    it('returns 200 with cursor page on first page (no cursor)', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { limit: '20' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 20, cursor: undefined });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: [],
        meta: { limit: 20, nextCursor: null, hasNextPage: false },
        requestId: 'unknown',
      });
    });

    it('defaults limit to CURSOR_DEFAULT_LIMIT when only cursor is provided', async () => {
      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 20, cursor: validCursor });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('passes limit and cursor to service when both provided', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 5 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');

      mockRequest.query = { limit: '5', cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 5,
        cursor: validCursor,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('returns cursor page with hasNextPage and nextCursor in meta', async () => {
      const fakePage = {
        data: [{ id: '1', title: 'Test' }],
        nextCursor: 'next-cursor-value',
        hasNextPage: true,
        limit: 5,
      };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { limit: '5' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      const callArg = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(callArg.status).toBe('success');
      expect(callArg.requestId).toBe('unknown');
      expect(callArg.meta).toEqual({
        limit: 5,
        nextCursor: 'next-cursor-value',
        hasNextPage: true,
      });
    });

    it('defaults to cursor pagination with no params', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = {};

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 20, cursor: undefined });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — validation errors (400)
  // -------------------------------------------------------------------------

  describe('getContracts — validation errors', () => {
    it('returns 400 when limit exceeds 100', async () => {
      mockRequest.query = { limit: '101' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 400 when limit is 0', async () => {
      mockRequest.query = { limit: '0' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when limit is negative', async () => {
      mockRequest.query = { limit: '-1' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when limit is non-numeric', async () => {
      mockRequest.query = { limit: 'abc' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for a malformed cursor', async () => {
      mockRequest.query = { cursor: 'not-a-valid-cursor' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 400 for a cursor missing the id field', async () => {
      const bad = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
        'utf8',
      ).toString('base64url');
      mockRequest.query = { cursor: bad };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for a cursor with an invalid date', async () => {
      const bad = Buffer.from(
        JSON.stringify({ createdAt: 'not-a-date', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');
      mockRequest.query = { cursor: bad };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for a cursor exceeding max length', async () => {
      const oversized = 'a'.repeat(257);
      mockRequest.query = { cursor: oversized };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — error propagation
  // -------------------------------------------------------------------------

  describe('getContracts — error propagation', () => {
    it('calls next() when service throws', async () => {
      const mockError = new Error('DB Down');
      mockGetContractsPage.mockRejectedValue(mockError);
      mockRequest.query = { limit: '5' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(mockError);
    });

    it('calls next() when legacy service throws', async () => {
      const mockError = new Error('DB Down');
      mockGetAllContracts.mockRejectedValue(mockError);

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // getContractsCursor
  // -------------------------------------------------------------------------

  describe('getContractsCursor', () => {
    it('returns 200 with cursor page', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 20, cursor: undefined });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('uses provided limit and cursor', async () => {
      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');
      const fakePage = { data: [{ id: '1' }], nextCursor: null, hasNextPage: false, limit: 10 };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = { limit: '10', cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 10, cursor: validCursor });
    });

    it('returns 400 for malformed cursor', async () => {
      mockRequest.query = { cursor: 'invalid' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('calls next() when service throws', async () => {
      const error = new Error('Service error');
      mockGetContractsPage.mockRejectedValue(error);

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // -------------------------------------------------------------------------
  // getContractById
  // -------------------------------------------------------------------------

  describe('getContractById', () => {
    it('returns 200 with contract data', async () => {
      const contract = { id: 'abc', title: 'Test' };
      mockGetContractById.mockResolvedValue(contract);
      mockRequest.params = { id: 'abc' };
      await controller.getContractById(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({ status: 'success', data: contract, requestId: 'unknown' });
    });

    it('delegates to next() for NotFoundError when contract missing', async () => {
      mockGetContractById.mockResolvedValue(null);
      mockRequest.params = { id: 'missing' };
      await controller.getContractById(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
      const error = (mockNext as jest.Mock).mock.calls[0][0];
      expect(error.name).toBe('AppError');
      expect(error.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // createContract
  // -------------------------------------------------------------------------

  describe('createContract', () => {
    it('returns 201 on success', async () => {
      const contract = { id: 'abc', status: 'PENDING' };
      mockCreateContract.mockResolvedValue(contract);
      await controller.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: contract,
        requestId: 'unknown',
      });
    });

    it('returns 422 when service throws ContractBoundsError', async () => {
      mockCreateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum contract amount'),
      );
      await controller.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'contract_bounds_error',
          message: 'Budget exceeds maximum contract amount',
          requestId: 'unknown',
        },
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('delegates non-bounds errors to next()', async () => {
      const mockError = new Error('Creation failed');
      mockCreateContract.mockRejectedValue(mockError);
      await controller.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(mockError);
    });

    // ─── Milestones audit trail (issue #858) ──────────────────────────────

    it('records a MILESTONES_CREATED audit entry when the payload includes milestones', async () => {
      const contract = { id: 'contract-1', status: 'draft' };
      mockCreateContract.mockResolvedValue(contract);
      mockRequest.body = {
        title: 'Test Contract',
        milestones: [{ title: 'Kickoff', description: 'Start', amount: 1000, completed: false }],
      };
      (mockRequest as unknown as { user: { id: string } }).user = { id: 'user-42' };

      await controller.createContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      const entry = mockAuditService.log.mock.calls[0][0];
      expect(entry).toMatchObject({
        action: 'MILESTONES_CREATED',
        severity: 'INFO',
        actor: 'user-42',
        resource: 'milestones',
        resourceId: 'contract-1',
      });
      expect(entry.metadata.before).toBeNull();
      expect(entry.metadata.after).toMatchObject({ count: 1, totalAmount: 1000 });
    });

    it('falls back to actor "system" when the request has no authenticated user', async () => {
      const contract = { id: 'contract-2', status: 'draft' };
      mockCreateContract.mockResolvedValue(contract);
      mockRequest.body = {
        title: 'Test Contract',
        milestones: [{ title: 'Kickoff', description: 'Start', amount: 100, completed: false }],
      };

      await controller.createContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ actor: 'system' }),
      );
    });

    it('does not record an audit entry when the payload has no milestones', async () => {
      const contract = { id: 'contract-3', status: 'draft' };
      mockCreateContract.mockResolvedValue(contract);
      mockRequest.body = { title: 'Test Contract' };

      await controller.createContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('redacts secret-shaped values inside a milestone title before logging', async () => {
      const contract = { id: 'contract-4', status: 'draft' };
      mockCreateContract.mockResolvedValue(contract);
      mockRequest.body = {
        title: 'Test Contract',
        milestones: [{ title: 'owner@example.com', description: 'x', amount: 100, completed: false }],
      };

      await controller.createContract(mockRequest as Request, mockResponse as Response, mockNext);

      const entry = mockAuditService.log.mock.calls[0][0];
      expect(entry.metadata.after.items[0].title).toBe('own***@example.com');
    });

    it('still returns 201 to the caller even if audit logging throws', async () => {
      const contract = { id: 'contract-5', status: 'draft' };
      mockCreateContract.mockResolvedValue(contract);
      mockAuditService.log.mockImplementation(() => {
        throw new Error('audit store unavailable');
      });
      mockRequest.body = {
        title: 'Test Contract',
        milestones: [{ title: 'Kickoff', description: 'Start', amount: 100, completed: false }],
      };

      await controller.createContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // updateContract
  // -------------------------------------------------------------------------

  describe('updateContract', () => {
    it('returns 200 on success', async () => {
      const updated = { id: 'abc', title: 'Updated' };
      mockUpdateContract.mockResolvedValue(updated);
      mockRequest.params = { id: 'abc' };
      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('returns 422 when service throws ContractBoundsError', async () => {
      mockUpdateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum'),
      );
      mockRequest.params = { id: 'abc' };
      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('delegates non-bounds errors to next()', async () => {
      const error = new Error('Update failed');
      mockUpdateContract.mockRejectedValue(error);
      mockRequest.params = { id: 'abc' };
      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(error);
    });

    // ─── Milestones audit trail (issue #858) ──────────────────────────────

    it('does not record an audit entry when the patch does not touch milestones', async () => {
      mockUpdateContract.mockResolvedValue({ id: 'abc', title: 'Updated' });
      mockRequest.params = { id: 'abc' };
      mockRequest.body = { version: 1, title: 'Updated' };

      await controller.updateContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('records MILESTONES_CREATED when this is the first milestones write for the contract', async () => {
      mockUpdateContract.mockResolvedValue({ id: 'abc', title: 'Updated' });
      mockAuditService.query.mockReturnValue([]); // no prior milestones snapshot
      mockRequest.params = { id: 'abc' };
      mockRequest.body = {
        version: 1,
        milestones: [{ title: 'First MS', description: 'x', amount: 500, completed: false }],
      };

      await controller.updateContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MILESTONES_CREATED', resourceId: 'abc' }),
      );
    });

    it('records MILESTONES_UPDATED when milestones content changed relative to the last snapshot', async () => {
      mockUpdateContract.mockResolvedValue({ id: 'abc', title: 'Updated' });
      mockAuditService.query.mockReturnValue([
        {
          metadata: {
            after: { count: 1, totalAmount: 100, truncated: false, items: [{ title: 'Old', amount: 100, completed: false }] },
          },
        },
      ]);
      mockRequest.params = { id: 'abc' };
      mockRequest.body = {
        version: 1,
        milestones: [{ title: 'New', description: 'x', amount: 200, completed: false }],
      };

      await controller.updateContract(mockRequest as Request, mockResponse as Response, mockNext);

      const entry = mockAuditService.log.mock.calls[0][0];
      expect(entry.action).toBe('MILESTONES_UPDATED');
      expect(entry.severity).toBe('INFO');
      expect(entry.metadata.before.items[0].title).toBe('Old');
      expect(entry.metadata.after.items[0].title).toBe('New');
    });

    it('records a WARNING-severity MILESTONES_DELETED entry when milestones are cleared to an empty array', async () => {
      mockUpdateContract.mockResolvedValue({ id: 'abc', title: 'Updated' });
      mockAuditService.query.mockReturnValue([
        {
          metadata: {
            after: { count: 1, totalAmount: 100, truncated: false, items: [{ title: 'Old', amount: 100, completed: false }] },
          },
        },
      ]);
      mockRequest.params = { id: 'abc' };
      mockRequest.body = { version: 1, milestones: [] };

      await controller.updateContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MILESTONES_DELETED', severity: 'WARNING' }),
      );
    });

    it('does not record a no-op audit entry when the resubmitted milestones are unchanged', async () => {
      const identical = { count: 1, totalAmount: 100, truncated: false, items: [{ title: 'Same', amount: 100, completed: false }] };
      mockUpdateContract.mockResolvedValue({ id: 'abc', title: 'Updated' });
      mockAuditService.query.mockReturnValue([{ metadata: { after: identical } }]);
      mockRequest.params = { id: 'abc' };
      mockRequest.body = {
        version: 1,
        milestones: [{ title: 'Same', description: 'x', amount: 100, completed: false }],
      };

      await controller.updateContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // deleteContract
  // -------------------------------------------------------------------------

  describe('deleteContract', () => {
    it('returns 200 on success', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockRequest.params = { id: 'abc' };
      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('delegates errors to next()', async () => {
      const error = new Error('Delete failed');
      mockDeleteContract.mockRejectedValue(error);
      mockRequest.params = { id: 'abc' };
      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(error);
    });

    // ─── Milestones audit trail (issue #858) ──────────────────────────────

    it('records a MILESTONES_DELETED audit entry when the deleted contract had a recorded milestones snapshot', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockAuditService.query.mockReturnValue([
        {
          metadata: {
            after: { count: 1, totalAmount: 100, truncated: false, items: [{ title: 'Old', amount: 100, completed: false }] },
          },
        },
      ]);
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MILESTONES_DELETED',
          severity: 'WARNING',
          resource: 'milestones',
          resourceId: 'abc',
        }),
      );
      const entry = mockAuditService.log.mock.calls[0][0];
      expect(entry.metadata.after).toBeNull();
    });

    it('does not record an audit entry when the deleted contract never had a milestones snapshot', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockAuditService.query.mockReturnValue([]);
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('does not record an audit entry when contract deletion fails (404)', async () => {
      mockDeleteContract.mockRejectedValue(new Error('not found'));
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getMilestonesAuditLog
  // -------------------------------------------------------------------------

  describe('getMilestonesAuditLog', () => {
    it('returns 404 when the contract does not exist', async () => {
      mockGetContractById.mockResolvedValue(undefined);
      mockRequest.params = { id: 'ghost' };

      await controller.getMilestonesAuditLog(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const err = (mockNext as jest.Mock).mock.calls[0][0];
      expect(err.message).toMatch(/not found/i);
    });

    it('returns a bounded, cursor-paginated page of milestones audit entries newest-first', async () => {
      mockGetContractById.mockResolvedValue({ id: 'abc' });
      const older = { id: 'e1', timestamp: '2026-01-01T00:00:00.000Z' };
      const newer = { id: 'e2', timestamp: '2026-01-02T00:00:00.000Z' };
      mockAuditService.queryWithCursor.mockReturnValue({ entries: [older, newer], count: 2, limit: 20 });
      mockRequest.params = { id: 'abc' };
      mockRequest.query = {};

      await controller.getMilestonesAuditLog(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.queryWithCursor).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'milestones', resourceId: 'abc', limit: 20 }),
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      const body = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(body.data.entries).toEqual([newer, older]);
    });

    it('honours a custom limit query parameter', async () => {
      mockGetContractById.mockResolvedValue({ id: 'abc' });
      mockAuditService.queryWithCursor.mockReturnValue({ entries: [], count: 0, limit: 5 });
      mockRequest.params = { id: 'abc' };
      mockRequest.query = { limit: '5' };

      await controller.getMilestonesAuditLog(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockAuditService.queryWithCursor).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 }),
      );
    });

    it('delegates repository errors to next()', async () => {
      const error = new Error('boom');
      mockGetContractById.mockRejectedValue(error);
      mockRequest.params = { id: 'abc' };

      await controller.getMilestonesAuditLog(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // -------------------------------------------------------------------------
  // getContractStats
  // -------------------------------------------------------------------------

  describe('getContractStats', () => {
    it('returns 200 with stats', async () => {
      const stats = { total: 5, byStatus: { draft: 3, active: 2 }, totalBudget: 5000 };
      mockGetContractStats.mockResolvedValue(stats);
      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('returns 422 when service throws ContractBoundsError', async () => {
      mockGetContractStats.mockRejectedValue(
        new ContractBoundsError('Bounds exceeded'),
      );
      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('delegates non-bounds errors to next()', async () => {
      const error = new Error('Stats failed');
      mockGetContractStats.mockRejectedValue(error);
      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // -------------------------------------------------------------------------
  // getBounds
  // -------------------------------------------------------------------------

  describe('getBounds', () => {
    it('returns 200 with CONTRACT_BOUNDS (instance)', () => {
      controller.getBounds(mockRequest as Request, mockResponse as Response);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: CONTRACT_BOUNDS,
        requestId: 'unknown',
      });
    });

    it('returns 200 with CONTRACT_BOUNDS (static)', () => {
      controller.getBounds(mockRequest as Request, mockResponse as Response);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  // -------------------------------------------------------------------------
  // createContractsController factory
  // -------------------------------------------------------------------------

  describe('createContractsController factory', () => {
    it('returns bound handler methods', () => {
      const { createContractsController } = require('./contracts.controller');
      const controller = createContractsController(new (require('../services/contracts.service').ContractsService)());
      expect(controller).toHaveProperty('getContracts');
      expect(controller).toHaveProperty('getContractById');
      expect(controller).toHaveProperty('createContract');
      expect(controller).toHaveProperty('updateContract');
      expect(controller).toHaveProperty('deleteContract');
      expect(controller).toHaveProperty('getContractStats');
      expect(controller).toHaveProperty('getBounds');
      expect(controller).toHaveProperty('getContractHistory');
    });
  });

  // -------------------------------------------------------------------------
  // getContractsCursor
  // -------------------------------------------------------------------------

  describe('getContractsCursor', () => {
    it('returns 200 with cursor page when no cursor is provided', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);
      mockRequest.query = {};

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 20, cursor: undefined });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: fakePage,
        }),
      );
    });

    it('returns 200 with cursor page when a valid cursor is provided', async () => {
      const fakePage = { data: [{ id: 'abc' }], nextCursor: null, hasNextPage: false, limit: 10 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');

      mockRequest.query = { limit: '10', cursor: validCursor };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({ limit: 10, cursor: validCursor });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 for a malformed cursor', async () => {
      mockRequest.query = { cursor: 'not-a-valid-cursor' };

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error: expect.objectContaining({
            code: 'bad_request',
            message: expect.stringMatching(/invalid pagination cursor/i),
          }),
        }),
      );
    });

    it('calls next() when service throws', async () => {
      const mockError = new Error('DB Down');
      mockGetContractsPage.mockRejectedValue(mockError);
      mockRequest.query = {};

      await controller.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // updateContract
  // -------------------------------------------------------------------------

  describe('updateContract', () => {
    it('returns 200 on success', async () => {
      const updatedContract = { id: 'abc', title: 'Updated', version: 1 };
      mockRequest.params = { id: 'abc' };
      mockRequest.body = { version: 0, title: 'Updated' };
      mockUpdateContract.mockResolvedValue(updatedContract);

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      // Third arg is the authenticated actor id (used for the contract audit
      // log — see #853); undefined here since this mock request has no
      // req.user attached.
      expect(mockUpdateContract).toHaveBeenCalledWith('abc', { version: 0, title: 'Updated' }, undefined);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: updatedContract,
        requestId: 'unknown',
      });
    });

    it('returns 422 on ContractBoundsError', async () => {
      mockRequest.params = { id: 'abc' };
      mockRequest.body = { version: 0, budget: 999_000_000_000_000_000 };
      mockUpdateContract.mockRejectedValue(
        new ContractBoundsError('Budget exceeds maximum contract amount'),
      );

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(422);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'contract_bounds_error',
          message: 'Budget exceeds maximum contract amount',
          requestId: 'unknown',
        },
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('delegates non-bounds errors to next()', async () => {
      const mockError = new Error('Update failed');
      mockRequest.params = { id: 'abc' };
      mockUpdateContract.mockRejectedValue(mockError);

      await controller.updateContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // deleteContract
  // -------------------------------------------------------------------------

  describe('deleteContract', () => {
    it('returns 200 on success', async () => {
      mockDeleteContract.mockResolvedValue(undefined);
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      // Second arg is the authenticated actor id (used for the contract audit
      // log — see #853); undefined here since this mock request has no
      // req.user attached.
      expect(mockDeleteContract).toHaveBeenCalledWith('abc', undefined);
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: { message: 'Contract deleted successfully' },
        requestId: 'unknown',
      });
    });

    it('delegates errors to next()', async () => {
      const mockError = new Error('Delete failed');
      mockDeleteContract.mockRejectedValue(mockError);
      mockRequest.params = { id: 'abc' };

      await controller.deleteContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // getContractStats
  // -------------------------------------------------------------------------

  describe('getContractStats', () => {
    it('returns 200 with stats', async () => {
      const stats = { total: 5, totalBudget: 10000, byStatus: { draft: 3, active: 2 } };
      mockGetContractStats.mockResolvedValue(stats);

      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: stats,
        requestId: 'unknown',
      });
    });

    it('delegates errors to next()', async () => {
      const mockError = new Error('Stats failed');
      mockGetContractStats.mockRejectedValue(mockError);

      await controller.getContractStats(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // getContractHistory
  // -------------------------------------------------------------------------

  describe('getContractHistory', () => {
    it('returns 200 with history data from service', async () => {
      const historyData = [{ eventId: 'evt-1' }];
      mockGetContractHistory.mockResolvedValue(historyData);
      mockRequest.params = { id: 'contract-123' };

      await controller.getContractHistory(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractHistory).toHaveBeenCalledWith('contract-123');
      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(historyData);
    });

    it('delegates errors to next()', async () => {
      const mockError = new Error('History failed');
      mockGetContractHistory.mockRejectedValue(mockError);
      mockRequest.params = { id: 'contract-123' };

      await controller.getContractHistory(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });
});
