import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { record } from '../services/suppression-service.js';
import { config } from '../config.js';
import { getTrackingSecret } from '../utils/tracking-secret.js';

const router = express.Router();

// Parse HTML form posts (confirm button) without touching global parsers.
// Capped at 10kb (server M10): the default extended parser has no useful
// bound for a 3-field confirm form.
router.use(express.urlencoded({ extended: false, limit: '10kb' }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// HMAC-signed email token (reuses tracking sign secret/algo).
// Token forms accepted:
//   1. `exp.sig` (new, expiring — server M2): sig = HMAC(`${email}.${exp}`),
//      exp = epoch ms; rejected when expired. Perpetual tokens are a permanent
//      mass-suppress capability if leaked, so all new sends carry an expiry.
//   2. raw hex HMAC(normalized-email) or signed `email.sig` (legacy,
//      perpetual — accepted so previously sent emails keep working).
// Fail-closed in prod when no secret is configured (mirrors tracking.ts):
// reject instead of allowing any token to mass-suppress anyone. In non-prod,
// allow unsigned for dev/test.
export const UNSUBSCRIBE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const signUnsubscribeToken = (email: string): string => {
  const secret = getTrackingSecret();
  if (!secret) return '';
  const normalized = email.trim().toLowerCase();
  const exp = Date.now() + UNSUBSCRIBE_TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', secret).update(`${normalized}.${exp}`).digest('hex');
  return `${exp}.${sig}`;
};

const timingSafeEqualStr = (a: string, b: string): boolean => {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

function verifyEmailToken(email: string, token: string): boolean {
  if (!token || !email) return false;
  const secret = getTrackingSecret();
  if (!secret) return config.isProd ? false : true;
  const normalized = email.trim().toLowerCase();
  const parts = token.split('.');
  // New expiring form `exp.sig`.
  if (parts.length === 2 && /^\d{10,}$/.test(parts[0])) {
    const exp = Number(parts[0]);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${normalized}.${parts[0]}`).digest('hex');
    return timingSafeEqualStr(parts[1], expected);
  }
  const expected = crypto.createHmac('sha256', secret).update(normalized).digest('hex');
  if (timingSafeEqualStr(token, expected)) return true;
  const idx = token.lastIndexOf('.');
  if (idx > 0) {
    const tokenEmail = token.slice(0, idx).trim().toLowerCase();
    const sig = token.slice(idx + 1);
    if (tokenEmail === normalized) {
      return timingSafeEqualStr(sig, expected);
    }
  }
  return false;
}

function invalidTokenResponse(req: Request, res: Response): void {
  res.status(403);
  if (wantsJson(req)) {
    res.json({ status: 'error', error: 'Invalid or missing unsubscribe token.' });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(errorPage('Invalid or missing unsubscribe link. Please use the link from your email.'));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getParam(req: Request, name: string): string {
  const q = req.query?.[name];
  const b = (req.body as Record<string, unknown> | undefined)?.[name];
  const raw = (typeof b === 'string' && b ? b : typeof q === 'string' ? q : '');
  return String(raw || '').trim();
}

function getEmailAndCampaign(req: Request): { email: string; campaign: string } {
  const email = getParam(req, 'email');
  const campaign = getParam(req, 'campaign') || getParam(req, 'campaignId');
  return { email, campaign };
}

function confirmPage(email: string, campaign: string, token: string): string {
  const safeEmail = escapeHtml(email);
  const safeCampaign = escapeHtml(campaign);
  const safeToken = escapeHtml(token);
  const campaignLine = campaign
    ? `<p style="margin:0 0 16px;color:#555;">Campaign: ${safeCampaign}</p>`
    : '';
  const action = `/unsubscribe?email=${encodeURIComponent(email)}${
    campaign ? `&amp;campaign=${encodeURIComponent(campaign)}` : ''
  }&amp;token=${encodeURIComponent(token)}`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Unsubscribe</title></head>` +
    `<body style="font-family:sans-serif;max-width:520px;margin:48px auto;padding:0 16px;">` +
    `<h1>Unsubscribe</h1>` +
    `<p>You are about to unsubscribe <strong>${safeEmail}</strong> from these emails.</p>` +
    campaignLine +
    `<form method="POST" action="${action}">` +
    `<input type="hidden" name="email" value="${safeEmail}">` +
    (campaign ? `<input type="hidden" name="campaign" value="${safeCampaign}">` : '') +
    `<input type="hidden" name="token" value="${safeToken}">` +
    `<button type="submit" style="padding:10px 20px;font-size:16px;cursor:pointer;">Confirm unsubscribe</button>` +
    `</form></body></html>`
  );
}

function successPage(email: string): string {
  const safeEmail = escapeHtml(email);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Unsubscribed</title></head>` +
    `<body style="font-family:sans-serif;max-width:520px;margin:48px auto;padding:0 16px;">` +
    `<h1>Unsubscribed</h1>` +
    `<p><strong>${safeEmail}</strong> has been unsubscribed. You will no longer receive these emails.</p>` +
    `</body></html>`
  );
}

function errorPage(message: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Unsubscribe error</title></head>` +
    `<body style="font-family:sans-serif;max-width:520px;margin:48px auto;padding:0 16px;">` +
    `<h1>Unsubscribe</h1><p>${escapeHtml(message)}</p>` +
    `</body></html>`
  );
}

function wantsJson(req: Request): boolean {
  return String(req.get('accept') || '').includes('application/json');
}

// GET /unsubscribe?email=&campaign=&token= — show confirm form.
router.get('/', (req: Request, res: Response) => {
  const { email, campaign } = getEmailAndCampaign(req);
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400);
    if (wantsJson(req)) {
      res.json({ status: 'error', error: 'Missing or invalid email address.' });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(errorPage('Missing or invalid email address.'));
    return;
  }
  // Token via query (one-click POSTs preserve query string); body fallback covered by getParam.
  const token = getParam(req, 'token');
  if (!verifyEmailToken(email, token)) {
    invalidTokenResponse(req, res);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(confirmPage(email, campaign, token));
});

// POST /unsubscribe — record suppression (supports one-click RFC 8058).
// Token read via getParam (body, query fallback) so one-click POSTs to the
// signed List-Unsubscribe URL keep working.
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, campaign } = getEmailAndCampaign(req);
    if (!email || !EMAIL_RE.test(email)) {
      res.status(400);
      if (wantsJson(req)) {
        res.json({ status: 'error', error: 'Missing or invalid email address.' });
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(errorPage('Missing or invalid email address.'));
      return;
    }
    const token = getParam(req, 'token');
    if (!verifyEmailToken(email, token)) {
      invalidTokenResponse(req, res);
      return;
    }
    const body = (req.body as Record<string, unknown>) || {};
    const oneClick =
      body['List-Unsubscribe'] === 'One-Click' ||
      String(req.get('list-unsubscribe') || '').toLowerCase().includes('one-click');
    await record(email, 'unsubscribe', {
      ...(campaign ? { campaignId: campaign } : {}),
      source: oneClick ? 'one-click' : 'unsubscribe-page',
    });
    if (wantsJson(req)) {
      res.status(200).json({ status: 'success', email: email.toLowerCase() });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(successPage(email));
  } catch (err) {
    next(err);
  }
});

export default router;
