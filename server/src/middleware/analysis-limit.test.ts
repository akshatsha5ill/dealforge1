import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { enforceAnalysisLimit, attachPlan } from './plan.js';
import { AppError } from './errorHandler.js';

const getCount = vi.fn();

vi.mock('../services/usage-service.js', () => ({
  getMonthlyAnalysisCount: (...args: unknown[]) => getCount(...args),
  FREE_ANALYSIS_LIMIT: 3,
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
  app.use((req: any, _res, next) => {
    req.user = { uid: 'user-1' };
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
    getCount.mockResolvedValueOnce(3);
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('3 analyzed meetings');
  });

  it('allows free users below the limit', async () => {
    getCount.mockResolvedValueOnce(2);
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(200);
  });

  it('allows free users with no recorded usage', async () => {
    getCount.mockResolvedValueOnce(0);
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(200);
  });

  it('fails open when usage count cannot be determined', async () => {
    getCount.mockRejectedValueOnce(new Error('boom'));
    const res = await request(createApp()).post('/analyze');
    expect(res.status).toBe(500);
  });
});
