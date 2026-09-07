import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';
import { analyzeMeeting } from '../services/ai-service.js';
import { AIFactory } from '../services/ai-providers.js';
import { confirmAnalysisSlot } from '../services/usage-service.js';
import { AppError } from '../middleware/errorHandler.js';
import { attachPlan, enforceAiModelAccess, enforceAnalysisLimit } from '../middleware/plan.js';

const router = express.Router();

const TRANSCRIPT_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

function enforceTranscriptHistory(plan: string, meetingStartTime?: string): void {
  if (plan !== 'free') return;
  if (!meetingStartTime) return;
  const startTime = new Date(meetingStartTime).getTime();
  if (Number.isNaN(startTime)) {
    throw new AppError('Invalid meetingStartTime.', 400);
  }
  if (Date.now() - startTime > TRANSCRIPT_HISTORY_MS) {
    throw new AppError('This meeting is older than 30 days and requires a Pro plan. Upgrade to access full transcript history.', 403);
  }
}

interface AuthenticatedRequest extends Request {
  user?: { uid: string };
}

// BYO-key presence check (no Firestore): accepts the x-ai-api-key header or a
// legacy body key. Runs before attachPlan so missing keys 400 without needing
// Firestore.
function requireByoKey(req: Request, _res: Response, next: NextFunction): void {
  const key = (req.header('x-ai-api-key') || ((req.body as Record<string, unknown>)?.apiKey as string) || '').trim();
  if (!key) return next(new AppError('Missing API key. Please configure your API key in Settings.', 400));
  return next();
}

const analyzeSchema = z.object({
  transcript: z.string().min(10).max(100000, "Transcript too long"),
  meetingId: z.string().min(1),
  meetingStartTime: z.string().min(1, "Missing meeting start time").optional(),
  model: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  // BYO key travels in the x-ai-api-key header (never the body). Body key
  // accepted only as a legacy fallback; header wins.
  apiKey: z.string().min(1, "Missing API key").optional()
});

router.post(
  '/analyze', 
  requireByoKey,
  attachPlan(),
  enforceAiModelAccess,
  enforceAnalysisLimit(),
  validateRequest({ body: analyzeSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { transcript, meetingId, meetingStartTime, model } = req.body;
      // Header-first: keeps the key out of req.body (logs, Sentry payloads).
      const apiKey = (req.header('x-ai-api-key') || (req.body.apiKey as string) || '').trim();
      // Securely drop API key from memory/request object immediately
      delete req.body.apiKey;
      if (!apiKey) {
        throw new AppError('Missing API key. Please configure your API key in Settings.', 400);
      }

      const plan = (req as unknown as { plan?: string }).plan || 'free';
      if (plan === 'free' && !meetingStartTime) {
        throw new AppError('Missing meeting start time', 400);
      }
      if (meetingStartTime) {
        enforceTranscriptHistory(plan, meetingStartTime);
      }
      
      const effectiveModel = model || 'openai';
      const uid = req.user?.uid;

      if (!uid) {
        throw new AppError('Unauthorized: Missing user information.', 401);
      }

      const analysis = await analyzeMeeting(transcript, effectiveModel, apiKey);

      // Confirm the pre-AI quota reservation (best-effort inside; the
      // reservation itself already counted, so a write failure here can't
      // grant free usage).
      await confirmAnalysisSlot(uid, (req as unknown as { analysisReservationId?: string }).analysisReservationId ?? '', meetingId);

      return res.status(200).json({
        status: "success",
        analysis
      });
    } catch (error: any) {
      if (error.message && error.message.includes('API key')) {
        return next(new AppError(error.message, 400));
      }
      next(error);
    }
  }
);

const scoreSchema = z.object({
  transcript: z.string().min(10).max(100000, "Transcript too long"),
  leadContext: z.record(z.any()),
  meetingId: z.string().min(1).optional(),
  meetingStartTime: z.string().min(1, "Missing meeting start time").optional(),
  model: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  // BYO key travels in the x-ai-api-key header (never the body). Body key
  // accepted only as a legacy fallback; header wins.
  apiKey: z.string().min(1, "Missing API key").optional()
});

router.post(
  '/score', 
  requireByoKey,
  attachPlan(),
  enforceAiModelAccess,
  enforceAnalysisLimit(),
  validateRequest({ body: scoreSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { transcript, leadContext, model, meetingId, meetingStartTime } = req.body;
      // Header-first: keeps the key out of req.body (logs, Sentry payloads).
      const apiKey = (req.header('x-ai-api-key') || (req.body.apiKey as string) || '').trim();
      // Securely drop API key from memory/request object immediately
      delete req.body.apiKey;
      if (!apiKey) {
        throw new AppError('Missing API key. Please configure your API key in Settings.', 400);
      }

      const plan = (req as unknown as { plan?: string }).plan || 'free';
      if (plan === 'free' && !meetingStartTime) {
        throw new AppError('Missing meeting start time', 400);
      }
      if (meetingStartTime) {
        enforceTranscriptHistory(plan, meetingStartTime);
      }

      const effectiveModel = model || 'openai';
      const uid = req.user?.uid;
      
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }

      const provider = AIFactory.getProvider(effectiveModel, apiKey);
      const scoreResult = await provider.scoreLead(transcript, leadContext);

      // Confirm the pre-AI quota reservation (best-effort inside).
      await confirmAnalysisSlot(uid, (req as unknown as { analysisReservationId?: string }).analysisReservationId ?? '', meetingId ?? randomUUID());

      return res.status(200).json({
        status: "success",
        score: scoreResult
      });
    } catch (error: any) {
      if (error.message && error.message.includes('API key')) {
        return next(new AppError(error.message, 400));
      }
      next(error);
    }
  }
);

export default router;
