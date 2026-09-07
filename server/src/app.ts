import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import * as Sentry from '@sentry/node';
import authRoutes from './routes/auth.js';
import zoomRoutes from './routes/zoom.js';
import aiRoutes from './routes/ai.js';
import emailRoutes from './routes/email.js';
import emailWebhooksRoutes from './routes/email-webhooks.js';
import emailOAuthRoutes from './routes/email-oauth.js';
import trackingRoutes from './routes/tracking.js';
import unsubscribeRoutes from './routes/unsubscribe.js';
import billingRoutes from './routes/billing.js';
import referralRoutes from './routes/referrals.js';
import apiKeyRoutes from './routes/api-keys.js';
import syncRoutes from './routes/sync.js';
import publicApiRoutes from './routes/public-api.js';
import { verifyAuth } from './middleware/auth.js';
import { requirePlan } from './middleware/plan.js';
import requestId from './middleware/requestId.js';
import sanitize from './middleware/sanitize.js';
import { errorHandler } from './middleware/errorHandler.js';
import log from './utils/logger.js';
import { config } from './config.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (config.isProd && process.env.SENTRY_DSN) {
  const scrub = (obj: any): any => {
    if (typeof obj === 'string') return obj.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out: Record<string, any> = { ...obj };
    for (const k of Object.keys(out)) {
      if (/api[-_]?key|transcript|email/i.test(k)) out[k] = '[Redacted]';
      else out[k] = scrub(out[k]);
    }
    return out;
  };
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.data) event.request.data = scrub(event.request.data);
      if (event.extra) event.extra = scrub(event.extra);
      // BYO keys travel in headers — redact them (and auth material) wherever
      // the SDK captured them.
      const headers = (event.request as { headers?: Record<string, unknown> } | undefined)?.headers;
      if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          if (/api[-_]?key|authorization|cookie|set-cookie/i.test(k)) headers[k] = '[Redacted]';
        }
      }
      return event;
    },
  });
}

const app = express();

// Trust first proxy (e.g. load balancer / reverse proxy) so req.ip /
// express-rate-limit see the real client IP via X-Forwarded-For.
app.set('trust proxy', 1);

const allowedOrigin = config.clientUrl || 'http://localhost:5173';
const allowedOrigins = new Set(
  [allowedOrigin, ...(process.env.CLIENT_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)],
);
const allowPreviewOrigins =
  process.env.ALLOW_PREVIEW_ORIGINS !== undefined
    ? process.env.ALLOW_PREVIEW_ORIGINS === 'true'
    : !config.isProd;
const isAllowedOrigin = (origin: string | undefined): boolean => {
  // Allow non-browser / same-origin requests with no Origin header.
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (!allowPreviewOrigins) return false;
  // Preview origins (dev only unless ALLOW_PREVIEW_ORIGINS=true): allow the
  // trusted Zoom client only. Preview deployments must be allowlisted
  // explicitly via CLIENT_URLS — never wildcard *.vercel.app (any attacker
  // can deploy there and would receive ACAO with Authorization/x-api-key).
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return true;
  } catch {
    // fall through to deny
  }
  return false;
};

app.use(helmet({
  contentSecurityPolicy: config.isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://appssdk.zoom.us"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "wss:", "ws:", allowedOrigin],
      imgSrc: ["'self'", "data:", "https:"]
    }
  } : false
}));
app.use(requestId);

// Key authenticated users by Firebase uid so limits are per-user,
// falling back to normalized IP for unauthenticated requests.
const uidKeyGenerator = (req: express.Request): string =>
  (req as unknown as { user?: { uid?: string } }).user?.uid || (req.ip ? ipKeyGenerator(req.ip) : 'unknown');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator,
  skip: (req) => req.originalUrl === '/api/health' || req.path === '/health',
  message: { error: 'Too many requests, please try again later.' }
});

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-ai-api-key', 'x-email-api-key', 'X-Request-Id']
}));
app.use(compression());

app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use(sanitize);
app.use('/api', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, please try again later.' }
});

const trackingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tracking requests' }
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator,
  message: { error: 'AI rate limit exceeded. Please wait before making another request.' }
});

const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator, // key by uid (fallback ip)
  // TODO: add daily quota wired to suppression-service
  message: { error: 'Email rate limit exceeded. Please wait before sending another email.' }
});

const billingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Too many billing requests, please try again later.' }
});

const referralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Too many referral requests, please try again later.' }
});

const apiKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Too many API key requests, please try again later.' }
});

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: uidKeyGenerator,
  message: { error: 'Sync rate limit exceeded. Please wait before syncing again.' }
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by client IP only — never by the attacker-controlled x-api-key header.
  // Keying by header value would mint a fresh 60/min bucket per rotated fake
  // key, and every guess burns Firestore reads in findApiKeyOwner (key doc +
  // subscription doc), enabling brute-force + Firestore-read DoS.
  keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
  message: { error: 'API rate limit exceeded. Please slow down your requests.' }
});

const emailWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests' }
});

const SENSITIVE_QUERY_RE = /([?&])(token|code|state|api[-_]?key|x-[a-z-]*api[-_]?key|secret)(=[^&#]*)/gi;

// Redact single-use credentials / tokens in query strings (?token=, ?code=,
// ?state=, api keys). The WS handshake rejects query tokens and requires
// auth.token, but polling URLs + proxies log the raw query — never persist
// the secret itself.
function redactSensitiveQuery(url: string): string {
  return url.replace(SENSITIVE_QUERY_RE, '$1$2=[Redacted]');
}

const requestLogger = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    log.info('Request', {
      method: req.method,
      url: redactSensitiveQuery(req.originalUrl),
      status: res.statusCode,
      duration: `${duration}ms`,
      requestId: (req as any).requestId,
    });
  });
  next();
};
app.use(requestLogger);

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/zoom', zoomRoutes);
// Public Dodo webhook (HMAC-verified inside billing router) must bypass Firebase verifyAuth.
app.use('/api/billing/webhook', billingLimiter, (req, res, next) => {
  req.url = '/webhook';
  billingRoutes(req, res, next);
});
app.use('/api/billing', verifyAuth, billingLimiter, billingRoutes);
app.use('/api/referrals', verifyAuth, referralLimiter, referralRoutes);
app.use('/api/tracking', trackingLimiter, trackingRoutes);
app.use('/unsubscribe', trackingLimiter, unsubscribeRoutes);
app.use('/api/ai', verifyAuth, aiLimiter, aiRoutes);
app.use('/api/email/oauth', billingLimiter, emailOAuthRoutes);
app.use('/api/email/webhooks', emailWebhookLimiter, emailWebhooksRoutes);
app.use('/api/email', verifyAuth, requirePlan('pro'), emailLimiter, emailRoutes);
app.use('/api/api-keys', verifyAuth, apiKeyLimiter, apiKeyRoutes);
app.use('/api/sync', verifyAuth, requirePlan('pro'), syncLimiter, syncRoutes);
app.use('/api/v1', publicApiLimiter, publicApiRoutes);

app.get('/api', (req, res) => {
  res.status(200).json({ message: 'API is running', version: '1.0.0' });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

app.get('/api/docs', (req, res) => {
  fs.readFile(path.join(__dirname, 'swagger.json'), 'utf8', (err, data) => {
    if (err) {
      return res.status(404).json({ error: 'Swagger doc not generated yet' });
    }
    try {
      res.json(JSON.parse(data));
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Swagger doc' });
    }
  });
});

app.get('/zoomverify/verifyzoom.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(process.env.ZOOM_VERIFY_TOKEN || 'zoomverify token not configured');
});

if (config.isProd && process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}
app.use(errorHandler);

export { app };
