import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { record } from '../services/suppression-service.js';

const router = express.Router();

// Parse HTML form posts (confirm button) without touching global parsers.
router.use(express.urlencoded({ extended: false }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// HMAC-signed email token (reuses tracking sign secret/algo).
// Token forms accepted: raw hex HMAC(normalized-email), or signed
// `email.sig` (tracking sign style). No secret (dev/test) allows
// unsigned, mirroring tracking.ts legacy fallback.
const getTrackingSecret = (): string =>
  process.env.TRACKING_SECRET || process.env.SESSION_SECRET || '';

function verifyEmailToken(email: string, token: string): boolean {
  if (!token) return false;
  const secret = getTrackingSecret();
  if (!secret) return true;
  const normalized = email.trim().toLowerCase();
  const expected = crypto.createHmac('sha256', secret).update(normalized).digest('hex');
  try {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  } catch {
    // fall through to signed-email form
  }
  const idx = token.lastIndexOf('.');
  if (idx > 0) {
    const tokenEmail = token.slice(0, idx).trim().toLowerCase();
    const sig = token.slice(idx + 1);
    if (tokenEmail === normalized) {
      try {
        const a = Buffer.from(sig, 'utf8');
        const b = Buffer.from(expected, 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      } catch {
        return false;
      }
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
