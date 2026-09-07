import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
// Tests enforceAnalysisLimit + attachPlan from ./plan.js (renamed from
// usage-limit.test.ts to reflect the actual unit under test).
import { enforceAnalysisLimit, attachPlan } from './plan.js';
import { AppError } from './errorHandler.js';

const mocks = vi.hoisted(() => {
  const reserveAnalysisSlot = vi.fn();
  const releaseAnalysisSlot = vi.fn();
  class AnalysisQuotaError extends Error {
    kind: 'monthly' | 'daily';
    limit: number;
    constructor(kind: 'monthly' | 'daily', limit: number, message: string) {
      super(message);
      this.kind = kind;
      this.limit = limit;
    }
  }
  return { reserveAnalysisSlot, releaseAnalysisSlot, AnalysisQuotaError };
});

const { reserveAnalysisSlot, releaseAnalysisSlot, AnalysisQuotaError } = mocks;

vi.mock('../services/usage-service.js', () => ({
  reserveAnalysisSlot: (...args: unknown[]) => mocks.reserveAnalysisSlot(...args),
  releaseAnalysisSlot: (...args: unknown[]) => mocks.releaseAnalysisSlot(...args),
  confirmAnalysisSlot: vi.fn().mockResolvedValue(undefined),
  AnalysisQuotaError: mocks.AnalysisQuotaError,
  DAILY_ANALYSIS_LIMIT: 10,
}));

vi.mock('../services/referral-service.js', () => ({
  getEffectiveAnalysisLimit: vi.fn().mockResolvedValue(3),
}));

vi.mock('../services/firebase-admin.js', () => ({
  getFirebaseFirestore: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: vi.fn().mockResolvedValue({ exists: true, data: () => ({ plan: 'free' }) }),
          }),
        }),
      }),
    }),
  }),
}));

const errorHandler = (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof AppError ? err.statusCode : 500;
  res.status(status).json({ error: err instanceof AppError ? err.message : 'Internal error' });
};

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req: unknown, _res, next) => {
    (req as { user: { uid: string } }).user = { uid: 'user-1' };
    next();
  });
  app.use(attachPlan());
  app.post('/analyze', enforceAnalysisLimit(), (_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  return app;
};

describe('enforceAnalysisLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks free users who reached the monthly analysis limit', async () => {
    reserveAnalysisSlot.mockRejectedValueOnce(new AnalysisQuotaError('monthly', 3, 'limit reached'));
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('3 analyzed meetings');
  });

  it('allows free users below the limit', async () => {
    reserveAnalysisSlot.mockResolvedValueOnce('reservation-1');
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(200);
  });

  it('allows free users with no recorded usage', async () => {
    reserveAnalysisSlot.mockResolvedValueOnce('reservation-1');
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(200);
  });

  it('fails closed when usage check cannot be determined', async () => {
    reserveAnalysisSlot.mockRejectedValueOnce(new Error('boom'));
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(500);
  });
});
