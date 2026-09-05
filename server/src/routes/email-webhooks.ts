import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { record, type SuppressionKind } from '../services/suppression-service.js';
import { config } from '../config.js';
import log from '../utils/logger.js';

const router = express.Router();

const WEBHOOK_SECRET_ENV = 'RESEND_WEBHOOK_SECRET';
const TIMESTAMP_TOLERANCE_SEC = 300;

function getRawBodyString(req: Request): string {
  const raw = (req as unknown as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  try {
    return JSON.stringify((req as unknown as { body?: unknown }).body ?? {});
  } catch {
    return '';
  }
}

function verifySvixSignature(rawBody: string, id: string, timestamp: string, signature: string, secret: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > TIMESTAMP_TOLERANCE_SEC) return false;

  const keyB64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, 'base64');
    if (key.length === 0) return false;
  } catch {
    return false;
  }

  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');

  const candidates = signature.split(' ');
  for (const candidate of candidates) {
    const sig = candidate.startsWith('v1,') ? candidate.slice(3) : candidate;
    if (!sig) continue;
    try {
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) continue;
      if (crypto.timingSafeEqual(a, b)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function extractEmails(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.includes('@')) out.push(v);
  };
  const to = (data as { to?: unknown }).to;
  if (Array.isArray(to)) {
    for (const t of to) push(t);
  } else {
    push(to);
  }
  push((data as { email?: unknown }).email);
  push((data as { recipient?: unknown }).recipient);
  return [...new Set(out.map((e) => e.trim()).filter(Boolean))];
}

function kindForType(type: string): SuppressionKind | null {
  const t = type.toLowerCase();
  if (t === 'email.bounced' || t.endsWith('.bounced') || t === 'bounce') return 'bounce';
  if (t === 'email.complained' || t.includes('complain')) return 'complaint';
  if (t.includes('unsubscri')) return 'unsubscribe';
  return null;
}

function reasonFor(data: Record<string, unknown>, type: string): string | undefined {
  const bounce = (data as { bounce?: { message?: unknown } }).bounce;
  if (bounce && typeof bounce.message === 'string' && bounce.message) return bounce.message.slice(0, 500);
  return type || undefined;
}

// POST /resend — mounted at /api/email/webhooks in app.ts,
// so the full path is POST /api/email/webhooks/resend.
router.post('/resend', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const secret = (process.env[WEBHOOK_SECRET_ENV] || '').trim();
    const rawBody = getRawBodyString(req);

    if (secret) {
      const id = String(req.header('svix-id') || '');
      const timestamp = String(req.header('svix-timestamp') || '');
      const signature = String(req.header('svix-signature') || '');
      if (!id || !timestamp || !signature) {
        log.warn('Resend webhook missing Svix headers', { hasId: Boolean(id) });
        res.status(400).json({ status: 'error', error: 'Missing webhook signature headers.' });
        return;
      }
      if (!verifySvixSignature(rawBody, id, timestamp, signature, secret)) {
        log.warn('Resend webhook signature verification failed', { id });
        res.status(400).json({ status: 'error', error: 'Invalid webhook signature.' });
        return;
      }
    } else if (config.isProd) {
      log.error('RESEND_WEBHOOK_SECRET not configured, rejecting webhook');
      res.status(500).json({ status: 'error', error: 'Webhook not configured.' });
      return;
    } else {
      log.warn('RESEND_WEBHOOK_SECRET not configured, skipping Svix verification');
    }

    const body = (req.body as { type?: unknown; data?: unknown }) || {};
    const type = typeof body.type === 'string' ? body.type : '';
    if (!type) {
      res.status(400).json({ status: 'error', error: 'Missing event type.' });
      return;
    }

    const kind = kindForType(type);
    const data = (body.data as Record<string, unknown>) || {};
    log.info('Resend webhook received', { type });

    if (!kind) {
      // Ignore delivery/open/click/sent events — no suppression needed.
      res.status(200).json({ status: 'ok', ignored: type });
      return;
    }

    const emails = extractEmails(data);
    if (emails.length === 0) {
      log.warn('Resend webhook has no recipient address', { type });
      res.status(200).json({ status: 'ok', recorded: 0 });
      return;
    }

    const reason = reasonFor(data, type);
    let recorded = 0;
    for (const email of emails) {
      try {
        await record(email, kind, {
          ...(reason ? { reason } : {}),
          source: 'resend-webhook',
        });
        recorded += 1;
      } catch (err) {
        log.warn('Resend webhook suppression record failed', { email, kind, error: String(err) });
      }
    }

    log.info('Resend webhook suppressions recorded', { type, kind, recorded });
    res.status(200).json({ status: 'ok', recorded });
  } catch (err) {
    next(err);
  }
});

export default router;
