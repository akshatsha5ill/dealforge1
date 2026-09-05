import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
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
    from: process.env.EMAIL_FROM || 'DealForge <noreply@dealforge.app>',
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
    ['RESEND_API_KEY', config.email.resendApiKey],
    ['FIREBASE_PROJECT_ID', config.firebase.projectId],
    ['FIREBASE_CLIENT_EMAIL', config.firebase.clientEmail],
    ['FIREBASE_PRIVATE_KEY', config.firebase.privateKey],
    ['DODO_PRO_PRODUCT_ID', config.dodo.proProductId],
    ['DODO_ENTERPRISE_PRODUCT_ID', config.dodo.enterpriseProductId],
  ];
  const missing = required.filter(([, val]) => !val);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
}
