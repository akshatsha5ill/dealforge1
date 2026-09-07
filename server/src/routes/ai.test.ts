import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

vi.mock('../services/ai-service.js', () => ({
  analyzeMeeting: vi.fn().mockResolvedValue({ summary: 'Test summary' }),
}));

vi.mock('../services/ai-providers.js', () => ({
  AIFactory: {
    getProvider: vi.fn().mockReturnValue({
      scoreLead: vi.fn().mockResolvedValue({ score: 85, reason: 'Good fit' }),
    }),
  },
}));

vi.mock('../services/firebase-admin.js', () => ({
  getFirebaseFirestore: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: vi.fn().mockResolvedValue({ exists: false, data: () => null }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('../services/usage-service.js', () => ({
  confirmAnalysisSlot: vi.fn().mockResolvedValue(undefined),
  reserveAnalysisSlot: vi.fn().mockResolvedValue('reservation-1'),
  releaseAnalysisSlot: vi.fn().mockResolvedValue(undefined),
  AnalysisQuotaError: class AnalysisQuotaError extends Error {},
  DAILY_ANALYSIS_LIMIT: 100,
}));

vi.mock('../services/referral-service.js', () => ({
  getEffectiveAnalysisLimit: vi.fn().mockResolvedValue(3),
}));

import aiRouter from './ai.js';
import { analyzeMeeting } from '../services/ai-service.js';

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { uid: string } }).user = { uid: 'test-user-id' };
    next();
  });
  app.use('/ai', aiRouter);
  app.use(errorHandler);
  return app;
};

describe('AI Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /ai/analyze rejects requests without API keys', async () => {
    const res = await request(createApp())
      .post('/ai/analyze')
      .send({ transcript: 'hello world, this is a test', meetingId: 'm1', model: 'openai' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing API key/i);
  });

  it('POST /ai/analyze calls analyzeMeeting and returns success', async () => {
    vi.mocked(analyzeMeeting).mockResolvedValueOnce({ summary: 'Test summary' } as never);

    const res = await request(createApp())
      .post('/ai/analyze')
      .set('x-ai-api-key', 'test-key')
      .send({
        transcript: 'hello world, this is a sufficiently long transcript',
        meetingId: 'm1',
        meetingStartTime: new Date().toISOString(),
        model: 'openai',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(analyzeMeeting).toHaveBeenCalledWith(
      expect.stringContaining('hello world'),
      'openai',
      'test-key',
    );
  });
});
