import express, { Request, Response } from 'express';
import crypto from 'crypto';
import DodoPayments from 'dodopayments';
import { getFirebaseFirestore } from '../services/firebase-admin.js';
import { verifyAuth, AuthRequest } from '../middleware/auth.js';
import { config } from '../config.js';
import { z } from 'zod';
import { validateRequest } from '../middleware/validateRequest.js';
import { AppError } from '../middleware/errorHandler.js';
import log from '../utils/logger.js';
import { getFreeMonthsCredit, getMyClaims } from '../services/referral-service.js';

const router = express.Router();

function getDodoClient() {
  return new DodoPayments({
    bearerToken: config.dodo.apiKey || '',
    environment: 'live_mode',
  });
}

function getProductIdForPlan(plan: string): string | null {
  if (plan === 'pro') return process.env.DODO_PRO_PRODUCT_ID || null;
  if (plan === 'enterprise') return process.env.DODO_ENTERPRISE_PRODUCT_ID || null;
  return null;
}

// One-time payments are NOT forever: they grant Pro for a fixed window and
// require renewal. Subscription webhooks carry next_billing_date; one-time
// verify/Payment flows must synthesize currentPeriodEnd instead of null.
const ONE_TIME_ACCESS_DAYS = 30;

function oneTimePeriodEnd(fromExistingEnd?: string | null): string {
  const base = fromExistingEnd ? new Date(fromExistingEnd).getTime() : NaN;
  const start = !Number.isNaN(base) && base > Date.now() ? base : Date.now();
  return new Date(start + ONE_TIME_ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function isPeriodExpired(currentPeriodEnd: unknown): boolean {
  if (typeof currentPeriodEnd !== 'string' || !currentPeriodEnd) return false;
  const endTime = new Date(currentPeriodEnd).getTime();
  return !Number.isNaN(endTime) && endTime < Date.now();
}

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'enterprise']),
});

router.post('/checkout', verifyAuth, validateRequest({ body: checkoutSchema }), async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<unknown> => {
  const { plan } = req.body;
  const userId = req.user!.uid;

  const productId = getProductIdForPlan(plan);
  if (!productId) {
    return next(new AppError('Invalid plan', 400));
  }

  try {
    const dodo = getDodoClient();
    const response = await dodo.checkoutSessions.create({
      product_cart: [
        { product_id: productId, quantity: 1 },
      ],
      metadata: { userId, plan },
      return_url: `${config.clientUrl}/dashboard/billing?session_id={checkout_session_id}`,
      cancel_url: `${config.clientUrl}/dashboard/billing`,
    });

    log.info('Checkout session created', { userId, plan, sessionId: response.session_id });

    return res.status(200).json({ checkout_url: response.checkout_url });
  } catch (err) {
    log.error('Failed to create checkout session', { error: err, userId, plan });
    return next(new AppError('Failed to create checkout session', 500));
  }
});

const verifySchema = z.object({ session_id: z.string().min(1) });

router.post('/verify', verifyAuth, validateRequest({ body: verifySchema }), async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<unknown> => {
  // NOTE: client-supplied plan is intentionally ignored. Plan, user binding,
  // product and amount are taken from the server-side checkout session.
  const { session_id } = req.body as { session_id: string };
  const userId = req.user!.uid;

  try {
    const dodo = getDodoClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await dodo.checkoutSessions.retrieve(session_id) as any;

    if (session?.payment_status !== 'succeeded') {
      return res.status(200).json({ status: 'pending', plan: 'free' });
    }

    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    const sessionUserId = (metadata.userId ?? metadata.user_id) as unknown;
    const sessionPlan = metadata.plan as unknown;

    if (typeof sessionUserId !== 'string' || sessionUserId.length === 0) {
      return next(new AppError('Session is missing user binding', 403));
    }
    if (sessionUserId !== userId) {
      return next(new AppError('Session does not belong to authenticated user', 403));
    }
    if (sessionPlan !== 'pro' && sessionPlan !== 'enterprise') {
      return next(new AppError('Invalid plan in session', 400));
    }
    const plan = sessionPlan as 'pro' | 'enterprise';

    // Validate session product matches the session plan when the gateway exposes it.
    const expectedProductId = getProductIdForPlan(plan);
    const candidateProductIds: string[] = [];
    const pushId = (v: unknown) => { if (typeof v === 'string' && v) candidateProductIds.push(v); };
    pushId(session?.product_id);
    pushId(session?.productId);
    pushId((metadata as Record<string, unknown>)?.product_id);
    pushId((metadata as Record<string, unknown>)?.productId);
    const carts = [session?.product_cart, session?.cart, session?.line_items, session?.items, session?.products];
    for (const cart of carts) {
      if (Array.isArray(cart)) {
        for (const item of cart) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const it = item as any;
          pushId(it?.product_id);
          pushId(it?.productId);
        }
      }
    }
    if (expectedProductId && candidateProductIds.length > 0 && !candidateProductIds.includes(expectedProductId)) {
      return next(new AppError('Session product does not match plan', 400));
    }

    // Validate a paid amount when the gateway exposes one.
    const candidateAmounts = [
      session?.total_amount,
      session?.amount,
      session?.total,
      session?.grand_total,
      session?.payment_amount,
      (metadata as Record<string, unknown>)?.amount,
    ];
    const numericAmounts = candidateAmounts.filter((v): v is number => typeof v === 'number');
    if (numericAmounts.length > 0 && !numericAmounts.some((a) => a > 0)) {
      return next(new AppError('Session has no paid amount', 400));
    }

    const db = getFirebaseFirestore();
    const userRef = db.collection('users').doc(userId).collection('subscription').doc('current');
    const processedRef = db.collection('processed_checkout_sessions').doc(session_id);

    // Single-use guard: a checkout session may only ever grant entitlement once.
    const already = await processedRef.get();
    if (already.exists) {
      const prior = already.data() as { userId?: unknown; plan?: unknown } | undefined;
      if (typeof prior?.userId === 'string' && prior.userId !== userId) {
        return next(new AppError('Session already processed', 409));
      }
      const existing = await userRef.get();
      if (existing.exists) {
        const d = existing.data() as { plan?: unknown; status?: unknown; currentPeriodEnd?: unknown; subscriptionId?: unknown } | undefined;
        // Downgrade on expiry: never return a stale active Pro for an expired one-time grant.
        if ((d?.plan === 'pro' || d?.plan === 'enterprise') && !d?.subscriptionId && isPeriodExpired(d?.currentPeriodEnd)) {
          await userRef.set({ plan: 'free', status: 'expired', updatedAt: new Date().toISOString() }, { merge: true });
          return res.status(200).json({ plan: 'free', status: 'expired', currentPeriodEnd: d?.currentPeriodEnd ?? null });
        }
        const e = existing.data() as { plan?: unknown; status?: unknown; currentPeriodEnd?: unknown } | undefined;
        return res.status(200).json({ plan: e?.plan ?? plan, status: e?.status ?? 'active', currentPeriodEnd: (e as { currentPeriodEnd?: unknown } | undefined)?.currentPeriodEnd ?? null });
      }
      return next(new AppError('Session already processed', 409));
    }

    // One-time purchase: grant a fixed 30-day window so renewal is required.
    // Referral free_month credit: when credit>0, extend by +30d and consume one credit.
    let currentPeriodEnd = oneTimePeriodEnd();
    let freeMonthApplied = false;
    try {
      const credit = await getFreeMonthsCredit(userId);
      if (credit > 0) {
        const claims = await getMyClaims(userId);
        const freeClaim = claims.find((c) => c.benefit === 'free_month');
        if (freeClaim) {
          currentPeriodEnd = oneTimePeriodEnd(currentPeriodEnd);
          try {
            await db.collection('users').doc(userId).collection('referrals').doc('claimed').collection('codes').doc(freeClaim.code).delete();
            freeMonthApplied = true;
          } catch (consumeErr) {
            log.warn('Failed to consume free_month credit', { userId, code: freeClaim.code, error: consumeErr });
          }
        }
      }
    } catch (creditErr) {
      log.warn('Free_month credit check failed, proceeding without extension', { userId, error: creditErr });
    }
    const subscriptionPayload = {
      plan,
      status: 'active',
      paymentId: session?.payment_id || null,
      subscriptionId: null,
      customerId: session?.customer_id || (session?.customer as { customer_id?: string } | undefined)?.customer_id || null,
      productId: candidateProductIds[0] || expectedProductId || null,
      amount: numericAmounts[0] ?? null,
      lastCheckoutSessionId: session_id,
      currentPeriodEnd,
      updatedAt: new Date().toISOString(),
    };
    const markerPayload = {
      userId,
      plan,
      paymentId: session?.payment_id || null,
      usedAt: new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    if (typeof dbAny.runTransaction === 'function') {
      await dbAny.runTransaction(async (tx: { get: (ref: unknown) => Promise<{ exists: boolean }>; set: (ref: unknown, data: unknown, opts?: unknown) => void }) => {
        const snap = await tx.get(processedRef);
        if (snap.exists) {
          throw new AppError('Session already processed', 409);
        }
        tx.set(userRef, subscriptionPayload, { merge: true });
        tx.set(processedRef, markerPayload);
      });
    } else {
      await userRef.set(subscriptionPayload, { merge: true });
      await processedRef.set(markerPayload);
    }

    log.info('Payment verified and subscription updated', { userId, plan, sessionId: session_id, freeMonthApplied });

    return res.status(200).json({ plan, status: 'active', currentPeriodEnd });
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }
    log.error('Verify session failed', { error: err, userId, sessionId: session_id });
    return res.status(200).json({ status: 'pending', plan: 'free' });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isSubscriptionData(data: any): data is { payload_type: 'Subscription'; subscription_id: string; status: string; metadata: Record<string, unknown>; customer: { customer_id: string } | null; next_billing_date: string | null; product_id: string } {
  return data?.payload_type === 'Subscription';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPaymentData(data: any): data is { payload_type: 'Payment'; status: string; metadata: Record<string, unknown> } {
  return data?.payload_type === 'Payment';
}

// Webhook hardening: Dodo HMAC must be computed over the exact wire bytes,
// not JSON.stringify(req.body) (key order / whitespace changes break or
// bypass verification). Prefers (req as any).rawBody (string|Buffer) when
// app.ts preserves it via express.json({ verify: ... }), falls back to
// JSON.stringify with a warn so misconfiguration is visible.
function getWebhookRawBody(req: Request): string {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Buffer.isBuffer(req.body)) return (req.body as Buffer).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  log.warn('Webhook rawBody missing, falling back to JSON.stringify (signature may fail)');
  return JSON.stringify(req.body);
}

function parseWebhookPlan(value: unknown): 'pro' | 'enterprise' | null {
  return value === 'pro' || value === 'enterprise' ? value : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getWebhookEventId(event: any, rawBody: string): string {
  const candidates = [
    event?.id,
    event?.event_id,
    event?.eventId,
    event?.data?.event_id,
    event?.data?.id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  // Fallback so exact replays are still deduped when the provider omits an id.
  return `hash:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractWebhookAmounts(data: any): number[] {
  const candidates = [
    data?.amount,
    data?.total_amount,
    data?.total,
    data?.grand_total,
    data?.payment_amount,
    data?.metadata?.amount,
  ];
  return candidates.filter((v): v is number => typeof v === 'number');
}

function webhookProductMatches(plan: 'pro' | 'enterprise', candidateIds: string[]): boolean {
  const expected = getProductIdForPlan(plan);
  if (!expected) return true;
  if (candidateIds.length === 0) return true;
  return candidateIds.includes(expected);
}

router.post('/webhook', async (req: Request, res: Response, next: express.NextFunction): Promise<unknown> => {
  const rawBody = getWebhookRawBody(req);
  const headers: Record<string, string> = {};
  for (const key of Object.keys(req.headers)) {
    const val = req.headers[key];
    if (val !== undefined) {
      headers[key] = Array.isArray(val) ? val.join(', ') : val;
    }
  }

  // Fail closed in prod when the webhook signing key is missing; warn in dev.
  const webhookKey = config.dodo.webhookKey || process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  if (!webhookKey) {
    log.error('Dodo webhook key not configured, rejecting webhook');
    if (config.isProd || process.env.NODE_ENV === 'production') {
      return next(new AppError('Webhook not configured', 500));
    }
    log.warn('Dodo webhook key missing in non-prod, proceeding without verification');
  }

  try {
    const dodo = getDodoClient();
    const event = dodo.webhooks.unwrap(rawBody, {
      headers,
      key: webhookKey || undefined,
    });

    const eventId = getWebhookEventId(event as unknown as Record<string, unknown>, rawBody);
    log.info('Dodo webhook received', { type: (event as { type?: string }).type, eventId });

    const db = getFirebaseFirestore();
    const processedEventRef = db.collection('processed_webhook_events').doc(eventId);
    const seen = await processedEventRef.get();
    if (seen.exists) {
      log.info('Duplicate webhook event ignored', { eventId, type: (event as { type?: string }).type });
      return res.status(200).json({ status: 'ok', deduped: true });
    }
    const markProcessed = async (extra: Record<string, unknown> = {}) => {
      try {
        await processedEventRef.set({
          eventId,
          type: (event as { type?: string }).type ?? null,
          receivedAt: new Date().toISOString(),
          ...extra,
        }, { merge: true });
      } catch (err) {
        log.warn('Failed to mark webhook event processed', { eventId, error: err });
      }
    };

    const { data } = event;

    if (isSubscriptionData(data)) {
      const metadata = data.metadata;
      const userId = metadata?.userId as string | undefined;

      if (!userId) {
        log.warn('Webhook missing userId in metadata', { subscriptionId: data.subscription_id });
        await markProcessed({ ignored: 'missing-userId', subscriptionId: data.subscription_id });
        return res.status(200).json({ status: 'ok' });
      }

      const userRef = getFirebaseFirestore().collection('users').doc(userId).collection('subscription').doc('current');

      let plan: string = 'free';
      let status: 'active' | 'cancelled' | 'past_due' | 'trialing' = 'active';

      if (data.status === 'active') {
        status = 'active';
        const parsed = parseWebhookPlan(metadata?.plan);
        if (!parsed) {
          log.warn('Webhook has invalid plan, ignoring', { subscriptionId: data.subscription_id, plan: metadata?.plan });
          await markProcessed({ ignored: 'invalid-plan', subscriptionId: data.subscription_id });
          return res.status(200).json({ status: 'ok' });
        }
        plan = parsed;
        const candidateIds: string[] = [];
        if (typeof data.product_id === 'string' && data.product_id) candidateIds.push(data.product_id);
        if (!webhookProductMatches(parsed, candidateIds)) {
          log.warn('Webhook product does not match plan, ignoring', { subscriptionId: data.subscription_id, plan: parsed, productId: data.product_id });
          await markProcessed({ ignored: 'product-mismatch', subscriptionId: data.subscription_id });
          return res.status(200).json({ status: 'ok' });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const amounts = extractWebhookAmounts(data as any);
        if (amounts.length > 0 && !amounts.some((a) => a > 0)) {
          log.warn('Webhook has no paid amount, ignoring', { subscriptionId: data.subscription_id });
          await markProcessed({ ignored: 'no-amount', subscriptionId: data.subscription_id });
          return res.status(200).json({ status: 'ok' });
        }
      } else if (data.status === 'cancelled' || data.status === 'expired') {
        status = 'cancelled';
      } else if (data.status === 'on_hold') {
        status = 'past_due';
      } else {
        log.warn('Unknown subscription status, ignoring webhook', { status: data.status, subscriptionId: data.subscription_id });
        await markProcessed({ ignored: 'unknown-status', subscriptionId: data.subscription_id });
        return res.status(200).json({ status: 'ok' });
      }

      await userRef.set({
        plan,
        status,
        currentPeriodEnd: data.next_billing_date || null,
        customerId: data.customer?.customer_id || null,
        subscriptionId: data.subscription_id,
        productId: data.product_id,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await markProcessed({ userId, plan, status, subscriptionId: data.subscription_id });
      log.info('Subscription updated in Firestore', { userId, plan, status });
    }

    if (isPaymentData(data)) {
      const metadata = data.metadata;
      const userId = metadata?.userId as string | undefined;

      if (userId && data.status === 'succeeded') {
        const parsed = parseWebhookPlan(metadata?.plan);
        if (!parsed) {
          log.warn('Payment webhook has invalid plan, ignoring', { plan: metadata?.plan });
          await markProcessed({ ignored: 'invalid-plan' });
        } else {
          // Validate product when the gateway exposes one.
          const candidateIds: string[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const d = data as any;
          for (const v of [d?.product_id, d?.productId, metadata?.product_id, metadata?.productId]) {
            if (typeof v === 'string' && v) candidateIds.push(v);
          }
          if (!webhookProductMatches(parsed, candidateIds)) {
            log.warn('Payment webhook product does not match plan, ignoring', { plan: parsed });
            await markProcessed({ ignored: 'product-mismatch' });
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const amounts = extractWebhookAmounts(data as any);
            if (amounts.length > 0 && !amounts.some((a) => a > 0)) {
              log.warn('Payment webhook has no paid amount, ignoring', { userId });
              await markProcessed({ ignored: 'no-amount', userId });
            } else {
              const plan = parsed;
              const userRef = getFirebaseFirestore().collection('users').doc(userId).collection('subscription').doc('current');
              // One-time Payment webhook: extend from existing future period when present
              // (renewal stacks), otherwise start a fresh 30-day window. Never leave null.
              let renewedPeriodEnd = oneTimePeriodEnd();
              try {
                const existing = await userRef.get();
                if (existing.exists) {
                  const d2 = existing.data() as { currentPeriodEnd?: unknown; subscriptionId?: unknown } | undefined;
                  // Only extend one-time grants here; recurring subscriptions are owned by Subscription events.
                  if (!d2?.subscriptionId) {
                    renewedPeriodEnd = oneTimePeriodEnd(typeof d2?.currentPeriodEnd === 'string' ? d2.currentPeriodEnd : null);
                  }
                }
              } catch {
                // Fall through with fresh 30-day window.
              }
              await userRef.set({
                plan,
                status: 'active',
                currentPeriodEnd: renewedPeriodEnd,
                subscriptionId: null,
                updatedAt: new Date().toISOString(),
              }, { merge: true });
              await markProcessed({ userId, plan });
              log.info('Payment succeeded, subscription activated', { userId, plan });
            }
          }
        }
      }

      if (userId && data.status === 'failed') {
        const userRef = getFirebaseFirestore().collection('users').doc(userId).collection('subscription').doc('current');
        await userRef.set({
          status: 'past_due',
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        await markProcessed({ userId, status: 'past_due' });
        log.info('Payment failed', { userId });
      }

      // Mark no-op payment events (e.g. missing userId) so replays stay deduped.
      const seenAfter = await processedEventRef.get();
      if (!seenAfter.exists) {
        await markProcessed({ ignored: 'no-op' });
      }
    } else {
      // Non payment/subscription events: still mark processed for idempotency.
      const seenAfter = await processedEventRef.get();
      if (!seenAfter.exists && !isSubscriptionData(data)) {
        await markProcessed({});
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error('Webhook verification failed', { error: (err as Error).message, stack: (err as Error).stack });
    return next(new AppError('Webhook verification failed', 401));
  }
});

router.get('/subscription', verifyAuth, async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<void> => {
  const userId = req.user!.uid;

  try {
    const doc = await getFirebaseFirestore().collection('users').doc(userId).collection('subscription').doc('current').get();

    if (!doc.exists) {
      res.status(200).json({
        plan: 'free',
        status: 'active',
        currentPeriodEnd: null,
        customerId: null,
        subscriptionId: null,
      });
      return;
    }

    const data = doc.data()!;
    // Downgrade on expiry: an expired one-time (or lapsed) period requires
    // renewal — persist downgrade so Pro is not served forever.
    if ((data.plan === 'pro' || data.plan === 'enterprise') && isPeriodExpired(data.currentPeriodEnd)) {
      await doc.ref.set({ plan: 'free', status: 'expired', updatedAt: new Date().toISOString() }, { merge: true });
      log.info('Subscription expired, downgraded to free', { userId });
      res.status(200).json({
        plan: 'free',
        status: 'expired',
        currentPeriodEnd: data.currentPeriodEnd || null,
        customerId: data.customerId || null,
        subscriptionId: data.subscriptionId || null,
      });
      return;
    }
    res.status(200).json({
      plan: data.plan || 'free',
      status: data.status || 'active',
      currentPeriodEnd: data.currentPeriodEnd || null,
      customerId: data.customerId || null,
      subscriptionId: data.subscriptionId || null,
    });
  } catch (err) {
    log.error('Failed to fetch subscription', { error: err, userId });
    return next(new AppError('Failed to fetch subscription', 500));
  }
});

router.post('/cancel', verifyAuth, async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<unknown> => {
  const userId = req.user!.uid;

  try {
    const doc = await getFirebaseFirestore().collection('users').doc(userId).collection('subscription').doc('current').get();

    if (!doc.exists) {
      return next(new AppError('No active subscription found', 404));
    }

    const data = doc.data()!;
    const subscriptionId = data.subscriptionId;

    if (!subscriptionId) {
      await doc.ref.set({ status: 'cancelled', updatedAt: new Date().toISOString() }, { merge: true });
      log.info('Subscription marked cancelled locally (no subscription ID from webhook yet)', { userId });
      res.status(200).json({ status: 'ok' });
      return;
    }

    const dodo = getDodoClient();
    await dodo.subscriptions.update(subscriptionId, {
      cancel_at_next_billing_date: true,
    });

    await doc.ref.set({
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    log.info('Subscription cancelled', { userId, subscriptionId });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error('Failed to cancel subscription', { error: err, userId });
    return next(new AppError('Failed to cancel subscription', 500));
  }
});

export default router;
