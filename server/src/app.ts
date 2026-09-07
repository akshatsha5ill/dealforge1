import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
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
import { isAllowedOrigin } from './utils/origins.js';
import {
  apiLimiter,
  authLimiter,
  trackingLimiter,
  aiLimiter,
  emailLimiter,
  billingLimiter,
  referralLimiter,
  apiKeyLimiter,
  syncLimiter,
  publicApiLimiter,
  emailWebhookLimiter,
} from './middleware/rateLimits.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (config.isProd && process.env.SENTRY_DSN) {
  const scrub = (obj: unknown): unknown => {
    if (typeof obj === 'string') return obj.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
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
      if (event.request?.data) event.request.data = scrub(event.request.data) as typeof event.request.data;
      if (event.extra) event.extra = scrub(event.extra) as typeof event.extra;
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

app.use(helmet({
  contentSecurityPolicy: config.isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://appssdk.zoom.us"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://*.googleapis.com", "https://*.firebaseio.com", "wss:", "ws:", config.clientUrl || 'http://localhost:5173'],
      imgSrc: ["'self'", "data:", "https:"]
    }
  } : false
}));
app.use(requestId);

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-ai-api-key', 'x-email-api-key', 'X-Request-Id']
}));
app.use(compression());

interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { (req as RawBodyRequest).rawBody = buf; } }));
app.use(sanitize);
app.use('/api', apiLimiter);

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
      requestId: (req as unknown as { requestId?: string }).requestId,
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
