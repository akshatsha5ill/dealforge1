import dotenv from 'dotenv';

dotenv.config();

// Fail-closed NODE_ENV: must be set explicitly. Defaulting to 'development'
// silently disables prod controls (CSP, webhook HMAC enforcement) when the
// variable is simply missing. Require an explicit value.
const rawEnv = process.env.NODE_ENV;
if (!rawEnv) {
  process.stderr.write(
    'FATAL: NODE_ENV must be explicitly set (development|test|production). Refusing to start with an implicit default.\n',
  );
  process.exit(1);
}

// Placeholder / low-entropy secret denylist. Values matching these patterns
// (e.g. change-me-*, changeme, placeholder, example) MUST NOT pass prod checks.
const PLACEHOLDER_PATTERNS = [
  /^change-?me/i,
  /^changeme/i,
  /^replace-?me/i,
  /^your-?/i,
  /placeholder/i,
  /example/i,
  /^test-?(123|secret|key|password)?$/i,
  /^password/i,
  /^secret-?(123|test)?$/i,
  /^12345/,
  /^abcd/i,
];

const WEAK_EXACT = new Set(
  [
    '',
    'test',
    'testing',
    'secret',
    'password',
    'password123',
    'changeme',
    'change-me',
    'placeholder',
    'example',
    '123456',
    '12345678',
    'development',
    'dev-secret',
  ].map((s) => s.toLowerCase()),
);

export function isPlaceholderSecret(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (WEAK_EXACT.has(lower)) return true;
  if (lower.includes('change-me') || lower.includes('changeme')) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

/** Fail-fast assertion for a single secret: entropy (min length) + denylist. */
export function assertSecret(name: string, value: unknown, minLen: number): void {
  if (typeof value !== 'string' || !value || isPlaceholderSecret(value)) {
    process.stderr.write(
      `FATAL: ${name} is missing or uses a placeholder/weak value. Set a unique high-entropy value.\n`,
    );
    process.exit(1);
  }
  if (value.trim().length < minLen) {
    process.stderr.write(
      `FATAL: ${name} must be at least ${minLen} characters (got ${value.trim().length}). Generate with e.g. openssl rand -hex 32.\n`,
    );
    process.exit(1);
  }
  // Reject trivially low-diversity values (e.g. all-same-char padding).
  const distinct = new Set(value.trim()).size;
  if (distinct < 8) {
    process.stderr.write(
      `FATAL: ${name} has insufficient entropy (only ${distinct} distinct characters). Use a random value.\n`,
    );
    process.exit(1);
  }
}

export const config = {
  env: rawEnv as string,
  port: Number(process.env.PORT || 3000),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  
  zoom: {
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET,
    redirectUri: process.env.ZOOM_REDIRECT_URI || `${process.env.CLIENT_URL || 'http://localhost:3000'}/api/zoom/oauth/callback`,
    get webhookSecretToken() {
      return process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    },
    sdkKey: process.env.ZOOM_SDK_KEY,
    sdkSecret: process.env.ZOOM_SDK_SECRET,
  },
  
  ai: {
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-pro',
  },
  
  email: {
    resendApiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || 'DealForge <support@dealforge.app>',
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID,
    microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    get oauthRedirectBase() {
      return process.env.OAUTH_REDIRECT_BASE || `${process.env.CLIENT_URL || 'http://localhost:3000'}/api/email/oauth`;
    },
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  dodo: {
    apiKey: process.env.DODO_PAYMENTS_API_KEY,
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
    proProductId: process.env.DODO_PRO_PRODUCT_ID,
    enterpriseProductId: process.env.DODO_ENTERPRISE_PRODUCT_ID,
  },

  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
};

if (config.isProd) {
  const required = [
    ['CLIENT_URL', config.clientUrl],
    ['ZOOM_CLIENT_ID', config.zoom.clientId],
    ['ZOOM_CLIENT_SECRET', config.zoom.clientSecret],
    ['ZOOM_WEBHOOK_SECRET_TOKEN', config.zoom.webhookSecretToken],
    ['SESSION_SECRET', process.env.SESSION_SECRET],
    ['TRACKING_SECRET', process.env.TRACKING_SECRET],
    ['TRACKING_BASE_URL', process.env.TRACKING_BASE_URL],
    ['ENCRYPTION_KEY', process.env.ENCRYPTION_KEY],
    ['RESEND_API_KEY', config.email.resendApiKey],
    ['FIREBASE_PROJECT_ID', config.firebase.projectId],
    ['FIREBASE_CLIENT_EMAIL', config.firebase.clientEmail],
    ['FIREBASE_PRIVATE_KEY', config.firebase.privateKey],
    ['DODO_PRO_PRODUCT_ID', config.dodo.proProductId],
    ['DODO_ENTERPRISE_PRODUCT_ID', config.dodo.enterpriseProductId],
  ];
  const missing = required.filter(([, val]) => !val);
  if (missing.length) {
    process.stderr.write(`Missing required environment variables: ${missing.map(([k]) => k).join(', ')}\n`);
    process.exit(1);
  }
  // Fail fast on placeholder / low-entropy secrets: presence alone is not
  // enough (e.g. change-me-xyz previously passed). High-value HMAC/encryption
  // secrets require >=32 chars; other credentials require >=16 chars.
  assertSecret('ZOOM_CLIENT_SECRET', config.zoom.clientSecret, 16);
  assertSecret('ZOOM_WEBHOOK_SECRET_TOKEN', config.zoom.webhookSecretToken, 16);
  assertSecret('SESSION_SECRET', process.env.SESSION_SECRET, 32);
  assertSecret('TRACKING_SECRET', process.env.TRACKING_SECRET, 32);
  assertSecret('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY, 32);
  assertSecret('RESEND_API_KEY', config.email.resendApiKey, 16);
  // Prod CLIENT_URL must be an https URL, never localhost/placeholder.
  const clientUrl = config.clientUrl || '';
  if (
    isPlaceholderSecret(clientUrl) ||
    /localhost|127\.0\.0\.1|0\.0\.0\.0|example\.com|change-?me/i.test(clientUrl) ||
    !/^https:\/\//i.test(clientUrl)
  ) {
    process.stderr.write(
      'FATAL: CLIENT_URL must be a valid https:// URL in production (no localhost/placeholder).\n',
    );
    process.exit(1);
  }
}
