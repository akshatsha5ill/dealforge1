import express, { Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validateRequest.js';
import { AuthRequest, verifyAuth } from '../middleware/auth.js';
import { requirePlan } from '../middleware/plan.js';
import { syncDerivedData, SyncMeeting, SyncAnalysis, SyncLead, SyncDeal } from '../services/api-data-service.js';
import { AppError } from '../middleware/errorHandler.js';
import log from '../utils/logger.js';
import { getFirebaseFirestore } from '../services/firebase-admin.js';
import { FieldValue } from 'firebase-admin/firestore';

const router = express.Router();

// Defense-in-depth: enforce auth + Pro plan at the router (app.ts also mounts
// both). Skip auth when a user is already attached (avoids double verify).
router.use((req, res, next) => {
  if ((req as unknown as { user?: { uid?: string } }).user?.uid) return next();
  return verifyAuth(req as unknown as Parameters<typeof verifyAuth>[0], res, next);
});
router.use(requirePlan('pro'));

// Firestore doc() injection guard: sync ids become collection doc ids.
// Restrict to alphanumerics, dash, underscore (no `/`, `.`, `..` traversal).
const DOC_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');

// Server M5 bounds: at most 200 items and 50KB of JSON per request, plus a
// per-user daily request quota. Without these, one authed caller can force
// thousands of Firestore writes per request, every request, all day.
const MAX_SYNC_ITEMS_TOTAL = 200;
const MAX_SYNC_BODY_BYTES = 50 * 1024;
const MAX_DAILY_SYNC_REQUESTS = 100;

const getDayKeyUTC = (date = new Date()): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

// Fail-open on Firestore outage (sync is availability-sensitive and unit
// tests run without Firestore); the per-request caps above still hold.
const checkSyncQuota = async (uid: string): Promise<boolean> => {
  try {
    const ref = getFirebaseFirestore()
      .collection('users').doc(uid)
      .collection('sync_usage').doc(getDayKeyUTC());
    const snap = await ref.get();
    const raw = snap.exists ? (snap.data()?.count as unknown) : 0;
    const count = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (count >= MAX_DAILY_SYNC_REQUESTS) return false;
    await ref.set({ count: FieldValue.increment(1), updatedAt: new Date().toISOString() }, { merge: true });
    return true;
  } catch (err) {
    log.warn('Sync quota check unavailable, allowing request', { error: (err as Error)?.message });
    return true;
  }
};

const meetingSchema = z.object({
  id: DOC_ID,
  title: z.string().max(500).optional(),
  startTime: z.string().max(100).optional(),
  endTime: z.string().max(100).optional(),
  duration: z.number().optional(),
  status: z.string().max(50).optional(),
});

const analysisSchema = z.object({
  id: DOC_ID,
  meetingId: DOC_ID,
  summary: z.string().max(20000).optional(),
  actionItems: z.array(z.string().max(2000)).max(100).optional(),
  leadScore: z.number().min(0).max(100).optional(),
  modelUsed: z.string().max(100).optional(),
  analyzedAt: z.string().max(100).optional(),
});

const leadSchema = z.object({
  id: DOC_ID,
  meetingId: DOC_ID.optional(),
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
  id: DOC_ID,
  leadId: DOC_ID.optional(),
  title: z.string().max(500).optional(),
  stage: z.string().max(100).optional(),
  value: z.number().min(0).optional(),
  probability: z.number().min(0).max(100).optional(),
  expectedClose: z.string().max(100).optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});

const syncSchema = z.object({
  // Server M5: 4000 writes/req (4x1000) is a Firestore-cost DoS. Cap each
  // array at 100 and the combined total at 200 (client chunks at <=25/type).
  meetings: z.array(meetingSchema).max(100).optional(),
  analyses: z.array(analysisSchema).max(100).optional(),
  leads: z.array(leadSchema).max(100).optional(),
  deals: z.array(dealSchema).max(100).optional(),
}).refine(
  (v) =>
    (v.meetings?.length ?? 0) +
    (v.analyses?.length ?? 0) +
    (v.leads?.length ?? 0) +
    (v.deals?.length ?? 0) <=
    MAX_SYNC_ITEMS_TOTAL,
  { message: 'Sync batch exceeds 200 total items' },
);

router.post(
  '/',
  validateRequest({ body: syncSchema }),
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }
      // 50KB serialized-body ceiling (the global 100kb JSON limit is not
      // enough: sync payloads fan out into one Firestore write per item).
      try {
        if (Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > MAX_SYNC_BODY_BYTES) {
          throw new AppError('Sync payload exceeds 50KB; split into smaller batches', 413);
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError('Invalid sync payload', 400);
      }
      if (!(await checkSyncQuota(uid))) {
        throw new AppError(`Daily sync limit of ${MAX_DAILY_SYNC_REQUESTS} reached. Please try again tomorrow.`, 429);
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
