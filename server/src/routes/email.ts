import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sendDraft, sendViaGmail, sendViaOutlook } from '../services/email-service.js';
import { getValidAccessToken } from '../services/email-oauth.js';
import { AIFactory } from '../services/ai-providers.js';
import { recordAnalysisUsage } from '../services/usage-service.js';
import { AppError } from '../middleware/errorHandler.js';
import { attachPlan, enforceAiModelAccess, enforceAnalysisLimit, requirePlan } from '../middleware/plan.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { checkStrict } from '../services/suppression-service.js';
import { config } from '../config.js';
import { registerClickTarget } from './tracking.js';

// Re-export for any existing imports
export { validateRequest } from '../middleware/validateRequest.js';

const router = express.Router();

interface AuthenticatedRequest extends Request {
  user?: { uid: string };
}

// FIX-EMAIL-E5: canonical tracking base + signed uid token.
// TRACKING_BASE_URL is required in production to prevent Host header
// poisoning (req Host is attacker-controlled and must never seed URLs
// embedded in outgoing email HTML). Throw 500 when missing in prod.
const getTrackingBaseUrl = (req: Request): string => {
  const canonical = (process.env.TRACKING_BASE_URL || '').trim().replace(/\/+$/, '');
  if (canonical) return canonical;
  if (process.env.NODE_ENV === 'production') {
    throw new AppError('TRACKING_BASE_URL is not configured.', 500);
  }
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const host = req.get('host');
  return `${protocol}://${host}/api/tracking`;
};

const signTrackingUid = (uid: string): string => {
  const secret = process.env.TRACKING_SECRET || process.env.SESSION_SECRET || '';
  // Fail-closed in prod: never emit a raw Firebase uid in email URLs/logs and
  // never emit forgeable tracking tokens. Mirrors tracking.ts verify (which
  // rejects unsigned uids in prod) and getTrackingBaseUrl above.
  if (!secret) {
    if (config.isProd || process.env.NODE_ENV === 'production') {
      throw new AppError('TRACKING_SECRET is not configured.', 500);
    }
    return uid;
  }
  const sig = crypto.createHmac('sha256', secret).update(uid).digest('hex');
  return `${uid}.${sig}`;
};

const sendSchema = z.object({
  to: z.string().email("Invalid email address"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
  campaignId: z.string().optional(),
  unsubscribeUrl: z.string().url().optional(),
  replyTo: z.string().email().optional(),
  isBulk: z.boolean().optional(),
  // Privacy: open/click tracking in tracking.ts defaults OFF (no `consent`
  // flag = do not store). Set `trackingConsent: true` only when the
  // recipient gave tracking consent disclosed at send time; the sender then
  // forwards `consent=1` on the pixel/click URLs so events may be stored.
  trackingConsent: z.boolean().optional(),
  emailApiKey: z.string().min(1, "Missing Email API key").optional(),
  via: z.enum(['resend', 'gmail', 'outlook']).optional(),
});


router.post(
  '/send',
  validateRequest({ body: sendSchema }),
  // Defense-in-depth plan gate: app.ts also mounts requirePlan('pro') for
  // /api/email, but the router must enforce itself so a free authed user
  // cannot POST directly and bypass UI canEmail checks (BYO-key = zero
  // server cost). Placed after validateRequest so 400 validation tests
  // still pass before the Firestore plan lookup.
  requirePlan('pro'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { to, subject, body, campaignId, unsubscribeUrl, replyTo, isBulk, trackingConsent, via = 'resend' } = req.body;
      const emailApiKey = req.body.emailApiKey;
      delete req.body.emailApiKey;
      delete req.body.via;
      const uid = req.user?.uid;

      try {
        if (to && await checkStrict(to)) {
          return res.status(410).json({ status: "error", message: "Email address is suppressed" });
        }
      } catch (suppressionError) {
        return res.status(503).json({ status: "error", message: "Suppression check unavailable" });
      }

      let finalBody = body;
      
      if (campaignId && uid) {
        const trackingBase = getTrackingBaseUrl(req);
        const trackingUid = encodeURIComponent(signTrackingUid(uid));
        // Forward sender-supplied consent to tracking.ts (`?consent=1`).
        // Absent/false = no flag = tracking defaults off (not stored).
        const consentSuffix = trackingConsent ? '&consent=1' : '';
        
        finalBody = finalBody.replace(/<a\s+(?:[^>]*?\s+)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))([^>]*)>/gi, (match: string, dqUrl: string, sqUrl: string, uqUrl: string, rest: string) => {
          const url = dqUrl ?? sqUrl ?? uqUrl ?? '';
          if (url.startsWith('http')) {
            const h = registerClickTarget(campaignId, url);
            const hSuffix = h ? `&h=${encodeURIComponent(h)}` : '';
            const wrapped = `${trackingBase}/click/${campaignId}?uid=${trackingUid}&url=${encodeURIComponent(url)}${hSuffix}${consentSuffix}`;
            return `<a href="${wrapped}"${rest}>`;
          }
          return match;
        });
        
        const pixel = `<img src="${trackingBase}/open/${campaignId}?uid=${trackingUid}${consentSuffix}" width="1" height="1" style="display:none;" />`;
        finalBody = `${finalBody}${pixel}`;
      }

      let data;
      if (via === 'gmail' || via === 'outlook') {
        if (!uid) {
          throw new AppError('Unauthorized', 401);
        }
        const { accessToken } = await getValidAccessToken(uid, via);
        const bulkOptions = { campaignId, unsubscribeUrl, replyTo, isBulk };
        data = via === 'gmail'
          ? await sendViaGmail(accessToken, to, subject, finalBody, undefined, bulkOptions)
          : await sendViaOutlook(accessToken, to, subject, finalBody, undefined, bulkOptions);
      } else {
        data = await sendDraft(to, subject, finalBody, { apiKey: emailApiKey, campaignId, unsubscribeUrl, replyTo, isBulk });
      }
      return res.status(200).json({ status: "success", data });
    } catch (error) {
      next(error);
    }
  }
);

const draftSchema = z.object({
  transcript: z.string({ required_error: "invalid input" }).min(10, "invalid input").max(100000, "invalid input"),
  leadContext: z.record(z.any()).optional(),
  meetingStartTime: z.string().min(1, "Missing meeting start time").optional(),
  model: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  apiKey: z.string({ required_error: "invalid input" }).min(1, "invalid input")
});

const TRANSCRIPT_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

function enforceTranscriptHistory(plan: string, meetingStartTime: string): void {
  if (plan !== 'free') return;
  const startTime = new Date(meetingStartTime).getTime();
  if (Number.isNaN(startTime)) {
    throw new AppError('Invalid meetingStartTime.', 400);
  }
  if (Date.now() - startTime > TRANSCRIPT_HISTORY_MS) {
    throw new AppError('This meeting is older than 30 days and requires a Pro plan. Upgrade to access full transcript history.', 403);
  }
}

router.post(
  '/draft',
  validateRequest({ body: draftSchema }),
  attachPlan(),
  enforceAiModelAccess,
  enforceAnalysisLimit(),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { transcript, leadContext, model, meetingStartTime } = req.body;
      const apiKey = req.body.apiKey;
      // Securely drop API key from memory/request object immediately
      delete req.body.apiKey;

      const plan = (req as unknown as { plan?: string }).plan || 'free';
      if (plan === 'free' && !meetingStartTime) {
        throw new AppError('Missing meeting start time', 400);
      }
      if (meetingStartTime) {
        enforceTranscriptHistory(plan, meetingStartTime);
      }

      const uid = req.user?.uid;
      
      if (!uid) {
        throw new AppError('Unauthorized', 401);
      }

      const effectiveModel = model || 'openai';
      const provider = AIFactory.getProvider(effectiveModel, apiKey);

      if (!provider.generateEmailDraft) {
        throw new AppError('Email drafting not supported for this provider yet.', 501);
      }

      const draft = await provider.generateEmailDraft(transcript, leadContext || {}) as Record<string, unknown>;
      // Track usage for free-tier limit enforcement (best-effort)
      await recordAnalysisUsage(uid, randomUUID());
      const subject = typeof draft.subject === 'string' ? draft.subject : '';
      const body = typeof draft.body === 'string' ? draft.body : typeof draft.content === 'string' ? (draft.content as string) : '';
      return res.status(200).json({ status: 'success', subject, body, draft });
    } catch (error: any) {
      if (error.message && error.message.includes('API key')) {
        return next(new AppError(error.message, 400));
      }
      next(error);
    }
  }
);

export default router;
