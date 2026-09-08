import express, { Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';
import { AuthRequest } from '../middleware/auth.js';
import { syncDerivedData, SyncMeeting, SyncAnalysis, SyncLead, SyncDeal } from '../services/api-data-service.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

const meetingSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
  startTime: z.string().max(100).optional(),
  endTime: z.string().max(100).optional(),
  duration: z.number().optional(),
  status: z.string().max(50).optional(),
});

const analysisSchema = z.object({
  id: z.string().min(1).max(200),
  meetingId: z.string().min(1).max(200),
  summary: z.string().max(20000).optional(),
  actionItems: z.array(z.string().max(2000)).max(100).optional(),
  leadScore: z.number().min(0).max(100).optional(),
  modelUsed: z.string().max(100).optional(),
  analyzedAt: z.string().max(100).optional(),
});

const leadSchema = z.object({
  id: z.string().min(1).max(200),
  meetingId: z.string().min(1).max(200).optional(),
  name: z.string().max(300).optional(),
  email: z.string().max(300).email().optional().or(z.literal('')),
  company: z.string().max(300).optional(),
  role: z.string().max(200).optional(),
  score: z.number().min(0).max(100).optional(),
  stage: z.string().max(100).optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});

const dealSchema = z.object({
  id: z.string().min(1).max(200),
  leadId: z.string().min(1).max(200).optional(),
  title: z.string().max(500).optional(),
  stage: z.string().max(100).optional(),
  value: z.number().min(0).optional(),
  probability: z.number().min(0).max(100).optional(),
  expectedClose: z.string().max(100).optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});

const syncSchema = z.object({
  meetings: z.array(meetingSchema).max(1000).optional(),
  analyses: z.array(analysisSchema).max(1000).optional(),
  leads: z.array(leadSchema).max(1000).optional(),
  deals: z.array(dealSchema).max(1000).optional(),
});

router.post(
  '/',
  validateRequest({ body: syncSchema }),
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      const body = req.body as {
        meetings?: unknown[];
        analyses?: unknown[];
        leads?: unknown[];
        deals?: unknown[];
      };
      await syncDerivedData(uid, {
        meetings: (body.meetings ?? []) as SyncMeeting[],
        analyses: (body.analyses ?? []) as SyncAnalysis[],
        leads: (body.leads ?? []) as SyncLead[],
        deals: (body.deals ?? []) as SyncDeal[],
      });
      res.status(200).json({ status: 'success' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
