import express, { Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validateRequest.js';
import { AppError } from '../middleware/errorHandler.js';
import { verifyAuth, AuthRequest } from '../middleware/auth.js';
import { requirePlan } from '../middleware/plan.js';
import log from '../utils/logger.js';
import { config } from '../config.js';
import { defaultClientRedirect, isAllowedClientRedirect } from '../utils/origins.js';
import {
  EmailProvider,
  isValidProvider,
  buildOAuthStartUrl,
  handleOAuthCallback,
  getIntegrationStatus,
  disconnectIntegration,
} from '../services/email-oauth.js';

const router = express.Router();

const startSchema = z.object({
  provider: z.enum(['gmail', 'outlook']),
  redirect: z.string().optional(),
});

router.post('/start', verifyAuth, requirePlan('pro'), validateRequest({ body: startSchema }), (req: AuthRequest, res: Response) => {
  const { provider, redirect } = req.body;
  const uid = req.user!.uid;

  // Validate redirect URL to prevent open redirect
  const redirectUrl = redirect || `${config.clientUrl}/settings`;
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid redirect URL' });
  }
  const allowedHosts = [new URL(config.clientUrl).hostname, 'localhost', '127.0.0.1'];
  if (!allowedHosts.includes(parsedRedirect.hostname)) {
    return res.status(400).json({ error: 'Invalid redirect URL' });
  }

  const url = buildOAuthStartUrl(provider, uid, redirectUrl);
  return res.status(200).json({ url });
});

const statusSchema = z.object({ provider: z.enum(['gmail', 'outlook']).optional() });

router.get('/status', verifyAuth, requirePlan('pro'), validateRequest({ query: statusSchema }), async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<unknown> => {
  const uid = req.user!.uid;
  try {
    const providers: EmailProvider[] = ['gmail', 'outlook'];
    const results = await Promise.all(providers.map(async (p) => ({ provider: p, ...(await getIntegrationStatus(uid, p)) })));
    return res.status(200).json({ integrations: results.filter((r) => r.connected) });
  } catch (err) {
    log.error('Failed to fetch email integration status', { error: err, uid });
    return next(new AppError('Failed to fetch email integration status', 500));
  }
});

const disconnectSchema = z.object({ provider: z.enum(['gmail', 'outlook']) });

router.post('/disconnect', verifyAuth, requirePlan('pro'), validateRequest({ body: disconnectSchema }), async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<unknown> => {
  const uid = req.user!.uid;
  try {
    await disconnectIntegration(uid, req.body.provider as EmailProvider);
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error('Failed to disconnect email integration', { error: err, uid });
    return next(new AppError('Failed to disconnect email integration', 500));
  }
});

router.get('/:provider/callback', async (req: Request, res: Response, next: express.NextFunction): Promise<unknown> => {
  const { provider } = req.params;
  const { code, state, error } = req.query;

  if (!isValidProvider(provider)) {
    return next(new AppError('Invalid provider', 400));
  }

  if (error) {
    log.warn('OAuth callback returned an error', { provider, error });
    return res.redirect(`${config.clientUrl}/settings?oauth_error=${encodeURIComponent(String(error))}`);
  }

  if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
    return next(new AppError('Missing authorization code or state', 400));
  }

  try {
    const { redirect, email } = await handleOAuthCallback(provider, code, state);
    // Server M1: re-validate the state redirect at the callback (not just at
    // /start) against the client allowlist; fall back to the default settings
    // page instead of echoing an attacker-swapped URL.
    const safeRedirect = isAllowedClientRedirect(redirect) ? redirect : defaultClientRedirect();
    const callbackUrl = new URL(safeRedirect);
    callbackUrl.searchParams.set('oauth_success', 'true');
    callbackUrl.searchParams.set('provider', provider);
    callbackUrl.searchParams.set('email', email);
    return res.redirect(302, callbackUrl.toString());
  } catch (err) {
    log.error('OAuth callback failed', { error: err, provider });
    return res.redirect(`${config.clientUrl}/settings?oauth_error=${encodeURIComponent((err as Error).message || 'OAuth failed')}`);
  }
});

export default router;
