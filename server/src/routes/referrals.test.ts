import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import referralRouter from './referrals.js';
import { claimReferral, getReferralStatus } from '../services/referral-service.js';
import { errorHandler } from '../middleware/errorHandler.js';

vi.mock('../services/referral-service.js', () => ({
  claimReferral: vi.fn(),
  getReferralStatus: vi.fn(),
}));

vi.mock('../middleware/plan.js', () => ({
  attachPlan: () => (req: any, _res: any, next: any) => {
    req.plan = req.plan || 'free';
    next();
  },
}));

function createApp(uid: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (uid) req.user = { uid, email_verified: true };
    next();
  });
  app.use('/referrals', referralRouter);
  app.use(errorHandler);
  return app;
}

describe('referral routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function request(app: express.Express, path: string, init?: RequestInit): Promise<Response> {
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      return await fetch(`http://localhost:${port}${path}`, init);
    } finally {
      server.close();
    }
  }

  describe('POST /referrals/claim', () => {
    it('returns 401 without an authenticated user', async () => {
      const res = await request(createApp(null), '/referrals/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'DF-ABCD2345' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects a missing code', async () => {
      const res = await request(createApp('user-1'), '/referrals/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns the claim result from the service', async () => {
      vi.mocked(claimReferral).mockResolvedValue({ status: 'claimed', benefit: 'meeting_bonus', code: 'DF-ABCD2345' });
      const res = await request(createApp('user-1'), '/referrals/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'DF-ABCD2345' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimStatus).toBe('claimed');
      expect(body.benefit).toBe('meeting_bonus');
      expect(claimReferral).toHaveBeenCalledWith('user-1', 'DF-ABCD2345', 'free');
    });
  });

  describe('GET /referrals/status', () => {
    it('returns 401 without an authenticated user', async () => {
      const res = await request(createApp(null), '/referrals/status');
      expect(res.status).toBe(401);
    });

    it('returns the referral status payload', async () => {
      vi.mocked(getReferralStatus).mockResolvedValue({
        code: 'DF-ABCD2345',
        claims: [],
        bonusMeetings: 1,
        freeMonthsCredit: 0,
        referralsMade: [{ uid: 'claimant-9', claimedAt: '2026-08-02T00:00:00Z' }],
      });
      const res = await request(createApp('user-1'), '/referrals/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.code).toBe('DF-ABCD2345');
      expect(body.bonusMeetings).toBe(1);
      expect(body.referralsMade).toHaveLength(1);
    });
  });
});
