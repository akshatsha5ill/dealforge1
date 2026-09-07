import express, { Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';
import { verifyAuth, AuthRequest } from '../middleware/auth.js';
import { attachPlan } from '../middleware/plan.js';
import { claimReferral, getReferralStatus } from '../services/referral-service.js';
import { AppError } from '../middleware/errorHandler.js';
import log from '../utils/logger.js';

const router = express.Router();

const claimSchema = z.object({
  code: z.string().min(1).max(32),
});

router.post(
  '/claim',
  attachPlan(),
  validateRequest({ body: claimSchema }),
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      if (req.user?.email_verified === false) {
        throw new AppError('Email verification required', 403);
      }
      if (req.user?.email_verified === undefined) {
        log.warn('Referral claim without email_verified claim, allowing (rate-limited)', { uid });
      }
      const plan = ((req as unknown as { plan?: string }).plan as 'free' | 'pro' | 'enterprise') || 'free';
      const result = await claimReferral(uid, (req.body as { code: string }).code, plan);
      res.status(200).json({ status: 'success', claimStatus: result.status, benefit: result.benefit, code: result.code });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/status',
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      const status = await getReferralStatus(uid);
      res.status(200).json({ status: 'success', ...status });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
