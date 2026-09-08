import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import requestId from './requestId.js';

const randomUUIDSpy = vi.spyOn(crypto, 'randomUUID');

afterAll(() => {
  randomUUIDSpy.mockRestore();
});

describe('requestId middleware', () => {
  let req: { headers: Record<string, string>; requestId?: string };
  let res: { setHeader: ReturnType<typeof vi.fn> };
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {} };
    res = { setHeader: vi.fn() };
    next = vi.fn();
    (crypto.randomUUID as ReturnType<typeof vi.fn>).mockReturnValue('mock-uuid-1234');
  });

  it('assigns a generated UUID when no X-Request-Id header is present', () => {
    requestId(req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);

    expect(crypto.randomUUID).toHaveBeenCalled();
    expect(req.requestId).toBe('mock-uuid-1234');
    expect(next).toHaveBeenCalled();
  });

  it('uses existing X-Request-Id header when provided', () => {
    req.headers['x-request-id'] = 'client-provided-id';

    requestId(req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);

    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(req.requestId).toBe('client-provided-id');
  });

  it('sets X-Request-Id response header', () => {
    req.headers['x-request-id'] = 'my-request-id';

    requestId(req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'my-request-id');
  });

  it('rejects X-Request-Id values with unsafe characters', () => {
    req.headers['x-request-id'] = 'evil\nlog-injection <script>';

    requestId(req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);

    expect(crypto.randomUUID).toHaveBeenCalled();
    expect(req.requestId).toBe('mock-uuid-1234');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'mock-uuid-1234');
  });

  it('rejects overlong X-Request-Id values', () => {
    req.headers['x-request-id'] = 'a'.repeat(65);

    requestId(req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);

    expect(crypto.randomUUID).toHaveBeenCalled();
    expect(req.requestId).toBe('mock-uuid-1234');
  });

  it('calls next() to pass control to the next middleware', () => {
    requestId(req as unknown as Request, res as unknown as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
