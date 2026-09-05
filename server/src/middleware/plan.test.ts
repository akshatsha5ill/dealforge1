import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requirePlan, attachPlan, enforceAiModelAccess, getPlanForUser } from './plan.js';
import { AppError } from './errorHandler.js';

vi.mock('../services/firebase-admin.js', () => {
  const planRef = vi.fn();
  return {
    getFirebaseFirestore: () => ({
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              get: planRef,
            }),
          }),
        }),
      }),
    }),
    __planRef: planRef,
  };
});

import { __planRef } from '../services/firebase-admin.js';

const errorHandler = (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof AppError ? err.statusCode : 500;
  res.status(status).json({ error: err instanceof AppError ? err.message : 'Internal error' });
};

const createApp = (middleware: express.RequestHandler) => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { uid: 'user-1' };
    next();
  });
  app.use(middleware);
  app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  return app;
};

describe('plan middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setPlan = (plan: string | null) => {
    if (!plan) {
      __planRef.mockResolvedValueOnce({ exists: false });
      return;
    }
    if (plan === 'free' || (plan !== 'pro' && plan !== 'enterprise')) {
      __planRef.mockResolvedValueOnce({ exists: true, data: () => ({ plan }) });
      return;
    }
    __planRef.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        plan,
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
  };

  describe('getPlanForUser', () => {
    it('returns free when no subscription doc exists', async () => {
      setPlan(null);
      await expect(getPlanForUser('user-1')).resolves.toBe('free');
    });

    it('returns the stored plan', async () => {
      setPlan('enterprise');
      await expect(getPlanForUser('user-1')).resolves.toBe('enterprise');
    });

    it('falls back to free for unknown plans', async () => {
      setPlan('mystery');
      await expect(getPlanForUser('user-1')).resolves.toBe('free');
    });
  });

  describe('requirePlan', () => {
    it('allows pro users through a pro gate', async () => {
      setPlan('pro');
      const res = await request(createApp(requirePlan('pro'))).get('/test');
      expect(res.status).toBe(200);
    });

    it('allows enterprise users through an enterprise gate', async () => {
      setPlan('enterprise');
      const res = await request(createApp(requirePlan('enterprise'))).get('/test');
      expect(res.status).toBe(200);
    });

    it('rejects free users from pro features', async () => {
      setPlan('free');
      const res = await request(createApp(requirePlan('pro'))).get('/test');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('pro');
    });

    it('rejects pro users from enterprise features', async () => {
      setPlan('pro');
      const res = await request(createApp(requirePlan('enterprise'))).get('/test');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('enterprise');
    });

    it('rejects users with no subscription', async () => {
      setPlan(null);
      const res = await request(createApp(requirePlan('pro'))).get('/test');
      expect(res.status).toBe(403);
    });
  });

  describe('enforceAiModelAccess', () => {
    const run = (plan: string | undefined, model: string | undefined) => {
      const next = vi.fn();
      const req = {
        plan,
        body: { model },
      } as unknown as express.Request;
      enforceAiModelAccess(req, {} as express.Response, next);
      return next;
    };

    it('allows free users to use OpenAI', () => {
      const next = run('free', 'openai');
      expect(next).toHaveBeenCalledWith();
    });

    it('allows free users with no model specified (defaults to openai)', () => {
      const next = run('free', undefined);
      expect(next).toHaveBeenCalledWith();
    });

    it('blocks free users from non-OpenAI models', () => {
      const next = run('free', 'anthropic');
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect((next.mock.calls[0][0] as AppError).statusCode).toBe(403);
    });

    it('allows pro users any model', () => {
      const next = run('pro', 'gemini');
      expect(next).toHaveBeenCalledWith();
    });

    it('allows enterprise users any model', () => {
      const next = run('enterprise', 'anthropic');
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('attachPlan', () => {
    it('attaches plan to the request', async () => {
      setPlan('pro');
      let captured: string | undefined;
      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        req.user = { uid: 'user-1' };
        next();
      });
      app.use(attachPlan());
      app.get('/test', (req: any, res) => {
        captured = req.plan;
        res.status(200).json({ ok: true });
      });
      await request(app).get('/test');
      expect(captured).toBe('pro');
    });
  });
});
