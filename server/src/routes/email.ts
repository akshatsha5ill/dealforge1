import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { sendDraft, sendViaGmail, sendViaOutlook } from '../services/email-service.js';
import { getValidAccessToken } from '../services/email-oauth.js';
import { AIFactory } from '../services/ai-providers.js';
import { AppError } from '../middleware/errorHandler.js';
import { attachPlan, enforceAiModelAccess, enforceAnalysisLimit } from '../middleware/plan.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { check as checkSuppression } from '../services/suppression-service.js';

// Re-export for any existing imports
export { validateRequest } from '../middleware/validateRequest.js';

const router = express.Router();

interface AuthenticatedRequest extends Request {
  user?: { uid: string };
}

// FIX-EMAIL-E5: canonical tracking base + signed uid token.
// Request-host base causes domain mismatch (proxy/internal host); raw `?uid=`
// leaks the Firebase uid. Prefer TRACKING_BASE_URL and HMAC-sign the uid,
// falling back to legacy behavior when env/secret is unset (dev/test).
const getTrackingBaseUrl = (req: Request): string => {
  const canonical = (process.env.TRACKING_BASE_URL || '').trim().replace(/\/+$/, '');
  if (canonical) return canonical;
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const host = req.get('host');
  return `${protocol}://${host}/api/tracking`;
};

const signTrackingUid = (uid: string): string => {
  const secret = process.env.TRACKING_SECRET || process.env.SESSION_SECRET || '';
  if (!secret) return uid;
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
  emailApiKey: z.string().min(1, "Missing Email API key").optional(),
  via: z.enum(['resend', 'gmail', 'outlook']).optional(),
});


router.post(
  '/send', 
  validateRequest({ body: sendSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { to, subject, body, campaignId, unsubscribeUrl, replyTo, isBulk, via = 'resend' } = req.body;
      const emailApiKey = req.body.emailApiKey;
      delete req.body.emailApiKey;
      delete req.body.via;
      const uid = req.user?.uid;

      if (to && await checkSuppression(to)) {
        return res.status(410).json({ status: "error", message: "Email address is suppressed" });
      }

      let finalBody = body;
      
      if (campaignId && uid) {
        const trackingBase = getTrackingBaseUrl(req);
        const trackingUid = encodeURIComponent(signTrackingUid(uid));
        
        finalBody = finalBody.replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"([^>]*)>/gi, (match: string, url: string, rest: string) => {
          if (url.startsWith('http')) {
            const wrapped = `${trackingBase}/click/${campaignId}?uid=${trackingUid}&url=${encodeURIComponent(url)}`;
            return `<a href="${wrapped}"${rest}>`;
          }
          return match;
        });
        
        const pixel = `<img src="${trackingBase}/open/${campaignId}?uid=${trackingUid}" width="1" height="1" style="display:none;" />`;
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
  model: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  apiKey: z.string({ required_error: "invalid input" }).min(1, "invalid input")
});

router.post(
  '/draft',
  attachPlan(),
  enforceAiModelAccess,
  enforceAnalysisLimit(),
  validateRequest({ body: draftSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
    try {
      const { transcript, leadContext, model } = req.body;
      const apiKey = req.body.apiKey;
      // Securely drop API key from memory/request object immediately
      delete req.body.apiKey;

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
