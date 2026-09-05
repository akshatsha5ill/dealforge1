import express, { Request, Response, NextFunction } from 'express';
import { record } from '../services/suppression-service.js';

const router = express.Router();

// Parse HTML form posts (confirm button) without touching global parsers.
router.use(express.urlencoded({ extended: false }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function confirmPage(email: string, campaign: string): string {
  const safeEmail = escapeHtml(email);
  const safeCampaign = escapeHtml(campaign);
  const campaignLine = campaign
    ? `<p style="margin:0 0 16px;color:#555;">Campaign: ${safeCampaign}</p>`
    : '';
  const action = `/unsubscribe?email=${encodeURIComponent(email)}${
    campaign ? `&amp;campaign=${encodeURIComponent(campaign)}` : ''
  }`;
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

// GET /unsubscribe?email=&campaign= — show confirm form.
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
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(confirmPage(email, campaign));
});

// POST /unsubscribe — record suppression (supports one-click RFC 8058).
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
