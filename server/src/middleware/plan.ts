import { Request, Response, NextFunction } from 'express';
import { getFirebaseFirestore } from '../services/firebase-admin.js';
import { AnalysisQuotaError, releaseAnalysisSlot, reserveAnalysisSlot, DAILY_ANALYSIS_LIMIT } from '../services/usage-service.js';
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
  if (typeof currentPeriodEnd === 'string' && currentPeriodEnd) {
    const endTime = new Date(currentPeriodEnd).getTime();
    if (!Number.isNaN(endTime)) {
      if (endTime < Date.now()) return 'free';
      return plan;
    }
    // Invalid date string falls through to fail-closed handling below.
  }
  // Fail-closed: null/missing/invalid expiry must not grant perpetual access.
  // Allow a 30d grace from updatedAt so transient webhook nulls don't lock out
  // immediately; otherwise treat as expired. Covers null + no subscriptionId.
  const updatedAt = data?.updatedAt as string | null | undefined;
  const updatedTime = typeof updatedAt === 'string' && updatedAt ? new Date(updatedAt).getTime() : NaN;
  const GRACE_MS = 30 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(updatedTime) || Date.now() - updatedTime > GRACE_MS) return 'free';
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

// Quota reservations are cross-instance (Firestore transaction in
// reserveAnalysisSlot): N parallel requests across any number of instances
// serialize on the month marker doc, so bursts can't multiply the free limit.
// The reservation id is attached to the request; the route confirms it after
// a successful AI call, or it is released when the response is an error.
export function enforceAnalysisLimit() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = (req as unknown as { user?: { uid?: string } }).user?.uid;
    const plan = (req as unknown as { plan?: string }).plan || 'free';
    if (!uid) {
      return next();
    }
    const enforceMonthly = plan === 'free';

    try {
      const monthlyLimit = enforceMonthly ? await getEffectiveAnalysisLimit(uid) : 0;
      const body = (req as unknown as { body?: { meetingId?: unknown } }).body;
      const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : undefined;
      let reservationId: string;
      try {
        reservationId = await reserveAnalysisSlot(uid, { meetingId, enforceMonthly, monthlyLimit });
      } catch (err) {
        if (err instanceof AnalysisQuotaError) {
          const status = err.kind === 'daily' ? 429 : 403;
          const message =
            err.kind === 'daily'
              ? `Daily analysis limit of ${DAILY_ANALYSIS_LIMIT} reached. Please try again tomorrow.`
              : `You've reached your free limit of ${err.limit} analyzed meetings per month. Upgrade to Pro for unlimited meetings.`;
          return next(new AppError(message, status));
        }
        throw err;
      }
      (req as unknown as { analysisReservationId?: string }).analysisReservationId = reservationId;
      if (typeof (res as unknown as { on?: unknown }).on === 'function') {
        const on = (res as unknown as { on: (e: string, cb: () => void) => void }).on.bind(res);
        // Release the hold when the request fails; on success the route
        // confirms it (release of a confirmed id is a no-op delete).
        const maybeRelease = (): void => {
          try {
            if (res.statusCode >= 400) void releaseAnalysisSlot(uid, reservationId);
          } catch {
            // never break the response path
          }
        };
        on('finish', maybeRelease);
        on('close', maybeRelease);
      }
      return next();
    } catch (err) {
      log.error('Failed to check analysis usage limit', { error: err, uid });
      return next(new AppError('Failed to check usage limit', 500));
    }
  };
}
