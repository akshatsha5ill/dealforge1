import express, { Response, NextFunction } from 'express';
import { z } from 'zod';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import { AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import {
  getMeetingsWithAnalyses,
  getMeetingDetail,
  getLeads,
  getDeals,
} from '../services/api-data-service.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

router.use(apiKeyAuth);

// Firestore doc() injection guard: meeting ids become collection doc ids.
// Restrict to alphanumerics, dash, underscore (no `/`, `.`, `..` traversal).
const MEETING_ID_PARAMS = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id'),
});

router.get(
  '/meetings',
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      const meetings = await getMeetingsWithAnalyses(uid);
      res.status(200).json({ data: meetings });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/meetings/:id',
  validateRequest({ params: MEETING_ID_PARAMS }),
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      const meeting = await getMeetingDetail(uid, req.params.id);
      if (!meeting) {
        throw new AppError('Meeting not found', 404);
      }
      res.status(200).json({ data: meeting });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/leads',
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      const leads = await getLeads(uid);
      res.status(200).json({ data: leads });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/deals',
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      const deals = await getDeals(uid);
      res.status(200).json({ data: deals });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
