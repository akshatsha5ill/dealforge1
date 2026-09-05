import express from 'express';
import crypto from 'crypto';
import { verifyAuth, AuthRequest } from '../middleware/auth.js';
import { config } from '../config.js';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';
import log from '../utils/logger.js';

const router = express.Router();

// FIX-EMAIL-E6: click wrapper must not break external links. The previous
// host allowlist (localhost + clientUrl) forced every external destination
// back to /dashboard/meetings. Allow any http/https destination, but only
// after HMAC-verifying the signed uid token (prevents open-redirect abuse).
// javascript:/data:/vbscript: are always blocked; anything invalid falls
// back to clientUrl.
const getTrackingSecret = (): string =>
  process.env.TRACKING_SECRET || process.env.SESSION_SECRET || '';

const verifyTrackingUid = (token?: string): string | null => {
  if (!token) return null;
  const secret = getTrackingSecret();
  // Legacy dev/test fallback (mirrors email.ts signTrackingUid): no secret
  // means the raw uid was sent unsigned.
  if (!secret) return token;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const uid = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(uid).digest('hex');
  try {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return uid;
};

const isSafeRedirect = (url: string): boolean => {
  try {
    const trimmed = url.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return false;
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return true;
  } catch {
    return false;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redis: any = null;
let useRedis = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trackingInbox = new Map<string, any[]>();
const MAX_EVENTS_PER_USER = 500;
const INBOX_TTL = 24 * 60 * 60 * 1000;
const inboxTimestamps = new Map<string, number>();

const initRedis = async () => {
  if (config.redis.url) {
    try {
      const ioredis = await import('ioredis');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Redis = ioredis.default as any;
      redis = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number) {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      });
      redis.on('connect', () => {
        useRedis = true;
        log.info('Redis connected for tracking service');
      });
      redis.on('error', (err: Error) => {
        if (useRedis) {
          log.error('Redis error in tracking, falling back to in-memory', { error: err.message });
          useRedis = false;
        }
      });
    } catch {
      log.warn('Redis not available for tracking, using in-memory');
    }
  }
};
initRedis();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeEvent = async (userId: string, event: any) => {
  if (!userId) return;

  if (useRedis && redis) {
    try {
      const key = `tracking:${userId}`;
      await redis.rpush(key, JSON.stringify(event));
      await redis.expire(key, Math.floor(INBOX_TTL / 1000));
      // Trim to max size
      await redis.ltrim(key, -MAX_EVENTS_PER_USER, -1);
      return;
    } catch {
      // Fall through to in-memory
    }
  }

  if (!trackingInbox.has(userId)) trackingInbox.set(userId, []);
  const events = trackingInbox.get(userId)!;
  events.push(event);
  if (events.length > MAX_EVENTS_PER_USER) {
    events.splice(0, events.length - MAX_EVENTS_PER_USER);
  }
  inboxTimestamps.set(userId, Date.now());
};

const cleanupInbox = () => {
  const now = Date.now();
  for (const [userId, timestamp] of inboxTimestamps.entries()) {
    if (now - timestamp > INBOX_TTL) {
      trackingInbox.delete(userId);
      inboxTimestamps.delete(userId);
    }
  }
};
const cleanupInterval = setInterval(cleanupInbox, 60 * 60 * 1000);
cleanupInterval.unref();

process.on('SIGTERM', () => clearInterval(cleanupInterval));
process.on('SIGINT', () => clearInterval(cleanupInterval));

const openSchema = z.object({
  uid: z.string().max(256).optional(),
  consent: z.string().optional()
});

// Privacy: email open/click tracking requires recipient consent.
// Default is off (including EU/EEA/UK where opt-in is required).
// Send `?consent=1` (or true/yes/on/granted) only when consent was obtained
// and disclosed at send time. Any other value — or a missing flag — means
// "do not track": serve the pixel/redirect without storing an event.
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'GB', 'IS', 'NO', 'LI', 'CH'
]);

const getViewerCountry = (req: express.Request): string | null => {
  const raw =
    req.get('cf-ipcountry') ||
    req.get('x-vercel-ip-country') ||
    req.get('x-country-code') ||
    req.get('cloudfront-viewer-country') ||
    req.get('x-geo-country');
  if (!raw) return null;
  const code = raw.trim().toUpperCase().slice(0, 2);
  return code || null;
};

const isEUViewer = (req: express.Request): boolean => {
  const country = getViewerCountry(req);
  // Unknown region: assume EU (privacy-safe, default off).
  if (!country) return true;
  return EU_COUNTRIES.has(country);
};

const hasTrackingConsent = (consent: unknown, req: express.Request): boolean => {
  if (typeof consent === 'string') {
    const v = consent.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'granted'].includes(v)) return true;
    return false;
  }
  // No flag supplied: default off for EU viewers, and default off
  // elsewhere too (privacy-safe). Consult region explicitly so the
  // EU default-off is auditable.
  if (isEUViewer(req)) return false;
  return false;
};

router.get('/open/:campaignId', validateRequest({ query: openSchema }), (req, res) => {
  const { campaignId } = req.params;
  const { uid, consent } = req.query as { uid?: string, consent?: string };

  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const pixelHeaders = { 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'private, no-store' };

  const verifiedUid = verifyTrackingUid(uid);
  if (!verifiedUid || verifiedUid.length > 128) {
    res.writeHead(200, pixelHeaders);
    res.end(pixel);
    return;
  }

  if (!hasTrackingConsent(consent, req)) {
    res.writeHead(200, pixelHeaders);
    res.end(pixel);
    return;
  }

  storeEvent(verifiedUid, {
    campaignId,
    event: 'open',
    timestamp: new Date().toISOString(),
  });

  res.writeHead(200, pixelHeaders);
  res.end(pixel);
});

const clickSchema = z.object({
  url: z.string().url().optional(),
  uid: z.string().max(256).optional(),
  consent: z.string().optional()
});

router.get('/click/:campaignId', validateRequest({ query: clickSchema }), (req, res) => {
  const { campaignId } = req.params;
  const { url, uid, consent } = req.query as { url?: string, uid?: string, consent?: string };

  res.set('Cache-Control', 'private, no-store');

  const verifiedUid = verifyTrackingUid(uid);

  if (verifiedUid && verifiedUid.length <= 128 && hasTrackingConsent(consent, req)) {
    storeEvent(verifiedUid, {
      campaignId,
      event: 'click',
      url: url || '',
      timestamp: new Date().toISOString(),
    });
  }

  const safeUrl = url && verifiedUid && isSafeRedirect(url) ? url : `${config.clientUrl}/dashboard/meetings`;
  res.redirect(safeUrl);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pullEvents = async (userId: string): Promise<any[]> => {
  if (useRedis && redis) {
    try {
      const key = `tracking:${userId}`;
      const events = await redis.lrange(key, 0, -1);
      await redis.del(key);
      return events.map((e: string) => JSON.parse(e));
    } catch {
      // Fall through to in-memory
    }
  }
  const events = trackingInbox.get(userId) || [];
  trackingInbox.delete(userId);
  return events;
};

router.get('/events', verifyAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.uid;
  const events = await pullEvents(userId);
  res.status(200).json({ status: 'success', events });
});

router.get('/events/:campaignId', verifyAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.uid;
  const { campaignId } = req.params;
  const allEvents = await pullEvents(userId);
  const events = allEvents.filter((e) => e.campaignId === campaignId);
  res.status(200).json({ status: 'success', events });
});

export default router;
