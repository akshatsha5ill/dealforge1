import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Key authenticated users by Firebase uid so limits are per-user,
// falling back to normalized IP for unauthenticated requests.
export const uidKeyGenerator = (req: express.Request): string =>
  (req as unknown as { user?: { uid?: string } }).user?.uid || (req.ip ? ipKeyGenerator(req.ip) : 'unknown');

const base = { standardHeaders: true, legacyHeaders: false } as const;

export const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: uidKeyGenerator,
  skip: (req) => req.originalUrl === '/api/health' || req.path === '/health',
  message: { error: 'Too many requests, please try again later.' },
});

export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth requests, please try again later.' },
});

export const trackingLimiter = rateLimit({
  ...base,
  windowMs: 1 * 60 * 1000,
  max: 300,
  message: { error: 'Too many tracking requests' },
});

export const aiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: uidKeyGenerator,
  message: { error: 'AI rate limit exceeded. Please wait before making another request.' },
});

export const emailLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: uidKeyGenerator, // key by uid (fallback ip)
  // Per-minute cap here; daily abuse quota is enforced in suppression-service.
  message: { error: 'Email rate limit exceeded. Please wait before sending another email.' },
});

export const billingLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Too many billing requests, please try again later.' },
});

export const referralLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Too many referral requests, please try again later.' },
});

export const apiKeyLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Too many API key requests, please try again later.' },
});

export const syncLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Sync rate limit exceeded. Please wait before syncing again.' },
});

export const publicApiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  max: 60,
  // Key by client IP only — never by the attacker-controlled x-api-key header.
  // Keying by header value would mint a fresh 60/min bucket per rotated fake
  // key, and every guess burns Firestore reads in findApiKeyOwner (key doc +
  // subscription doc), enabling brute-force + Firestore-read DoS.
  keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
  message: { error: 'API rate limit exceeded. Please slow down your requests.' },
});

export const emailWebhookLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many webhook requests' },
});
