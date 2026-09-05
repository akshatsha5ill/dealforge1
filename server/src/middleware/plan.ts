import { Request, Response, NextFunction } from 'express';
import { getFirebaseFirestore } from '../services/firebase-admin.js';
import { getMonthlyAnalysisCount } from '../services/usage-service.js';
import { getEffectiveAnalysisLimit } from '../services/referral-service.js';
import { AppError } from './errorHandler.js';
import log from '../utils/logger.js';

export type PlanLevel = 'pro' | 'enterprise';

export interface PlanUser {
  uid: string;
  plan: 'free' | 'pro' | 'enterprise';
}

export const getPlanForUser = async (uid: string): Promise<'free' | 'pro' | 'enterprise'> => {
  const doc = await getFirebaseFirestore().collection('users').doc(uid).collection('subscription').doc('current').get();
  if (!doc.exists) return 'free';
  const data = doc.data();
  const plan = data?.plan as string | undefined;
  if (plan !== 'pro' && plan !== 'enterprise') return 'free';
  const status = data?.status as string | undefined;
  if (status === 'cancelled' || status === 'past_due' || status === 'expired') return 'free';
  const currentPeriodEnd = data?.currentPeriodEnd as string | null | undefined;
  if (currentPeriodEnd) {
    const endTime = new Date(currentPeriodEnd).getTime();
    if (!Number.isNaN(endTime) && endTime < Date.now()) return 'free';
  }
  return plan;
};

export function requirePlan(minPlan: PlanLevel) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const uid = (req as { user?: { uid?: string } }).user?.uid;
    if (!uid) {
      return next(new AppError('Unauthorized', 401));
    }

    try {
      const plan = await getPlanForUser(uid);
      (req as unknown as { plan?: string }).plan = plan;

      const allowed = plan === 'enterprise' || (minPlan === 'pro' && plan === 'pro');
      if (!allowed) {
        return next(new AppError(`This feature requires the ${minPlan} plan. Please upgrade to continue.`, 403));
      }
      return next();
    } catch (err) {
      log.error('Failed to check subscription for plan gate', { error: err, uid });
      return next(new AppError('Failed to check subscription', 500));
    }
  };
}

export function attachPlan() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const uid = (req as { user?: { uid?: string } }).user?.uid;
    if (!uid) {
      return next(new AppError('Unauthorized', 401));
    }

    try {
      const plan = await getPlanForUser(uid);
      (req as unknown as { plan?: string }).plan = plan;
      return next();
    } catch (err) {
      log.error('Failed to attach plan', { error: err, uid });
      return next(new AppError('Failed to check subscription', 500));
    }
  };
}

export function enforceAiModelAccess(req: Request, _res: Response, next: NextFunction): void {
  const plan = (req as unknown as { plan?: string }).plan || 'free';
  const rawModel = (req.body as { model?: unknown } | undefined)?.model;
  const model =
    typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim().toLowerCase() : 'openai';
  if (plan === 'free' && model !== 'openai') {
    return next(new AppError('The free plan includes 1 AI model (OpenAI). Upgrade to Pro for all models.', 403));
  }
  return next();
}

// In-flight reservations per uid to close the check-then-use race between
// enforceAnalysisLimit() (check) and recordAnalysisUsage() in routes/ai.ts
// (use, after await analyzeMeeting()). Without this, N concurrent requests can
// all read the same count < limit before any of them records usage.
// Single-instance only; multi-instance deployments still need a Firestore
// transaction/counter for a global guarantee.
const pendingAnalyses = new Map<string, number>();

export function __getPendingAnalysisCount(uid: string): number {
  return pendingAnalyses.get(uid) ?? 0;
}

export function __clearPendingAnalysisCounts(): void {
  pendingAnalyses.clear();
}

export function enforceAnalysisLimit() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = (req as unknown as { user?: { uid?: string } }).user?.uid;
    const plan = (req as unknown as { plan?: string }).plan || 'free';
    if (!uid || plan !== 'free') {
      return next();
    }

    try {
      const count = await getMonthlyAnalysisCount(uid);
      const limit = await getEffectiveAnalysisLimit(uid);
      // Critical section below must stay synchronous (no await) so concurrent
      // requests on this instance serialize on the event loop.
      const pending = pendingAnalyses.get(uid) ?? 0;
      if (count + pending >= limit) {
        return next(new AppError(`You've reached your free limit of ${limit} analyzed meetings per month. Upgrade to Pro for unlimited meetings.`, 403));
      }
      pendingAnalyses.set(uid, pending + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        const cur = pendingAnalyses.get(uid) ?? 0;
        if (cur <= 1) {
          pendingAnalyses.delete(uid);
        } else {
          pendingAnalyses.set(uid, cur - 1);
        }
      };
      // Hold the reservation until the response settles (usage is recorded
      // downstream in the route handler, after the AI call).
      if (typeof (res as unknown as { on?: unknown }).on === 'function') {
        (res as unknown as { on: (e: string, cb: () => void) => void }).on('finish', release);
        (res as unknown as { on: (e: string, cb: () => void) => void }).on('close', release);
      } else {
        // No response emitter (direct unit invocation): avoid leaking the slot.
        release();
      }
      return next();
    } catch (err) {
      log.error('Failed to check analysis usage limit', { error: err, uid });
      return next(new AppError('Failed to check usage limit', 500));
    }
  };
}
