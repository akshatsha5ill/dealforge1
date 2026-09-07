import crypto from 'crypto';
import { config } from '../config.js';
import { encrypt, decrypt, CryptoPurpose } from '../utils/crypto.js';
import { getFirebaseFirestore } from './firebase-admin.js';
import { AppError } from '../middleware/errorHandler.js';
import log from '../utils/logger.js';

export type EmailProvider = 'gmail' | 'outlook';

export interface IntegrationStatus {
  connected: boolean;
  provider?: EmailProvider;
  email?: string;
  connectedAt?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface StoredIntegration {
  email: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: number;
  connectedAt: string;
  scopes: string[];
}

const PROVIDER_SCOPES: Record<EmailProvider, string> = {
  gmail: 'https://www.googleapis.com/auth/gmail.send openid email profile',
  outlook: 'Mail.Send User.Read offline_access',
};

export const isValidProvider = (provider: string): provider is EmailProvider =>
  provider === 'gmail' || provider === 'outlook';

const getProviderCredentials = (provider: EmailProvider) => {
  if (provider === 'gmail') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new AppError('Gmail OAuth is not configured', 500);
    }
    return { clientId, clientSecret };
  }
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError('Outlook OAuth is not configured', 500);
  }
  return { clientId, clientSecret };
};

const getRedirectUri = (provider: EmailProvider) =>
  `${config.email.oauthRedirectBase}/${provider}/callback`;

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// FIX-SEC-S3: single-use OAuth state cache. buildOAuthStartUrl() stores the
// nonce here; parseOAuthState() consumes it. In-memory only — sufficient for
// single-instance; use Redis/shared store if scaled horizontally.
const pendingOAuthStates = new Map<string, number>();

function pruneOAuthStates(now = Date.now()): void {
  for (const [nonce, exp] of pendingOAuthStates) {
    if (exp <= now) pendingOAuthStates.delete(nonce);
  }
}

// Test-only helper to reset single-use cache between tests.
export const __clearOAuthStateCache = (): void => {
  pendingOAuthStates.clear();
};

export const buildOAuthStartUrl = (provider: EmailProvider, uid: string, redirect: string): string => {
  const { clientId } = getProviderCredentials(provider);
  pruneOAuthStates();
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  pendingOAuthStates.set(nonce, exp);
  const state = encrypt(JSON.stringify({ uid, redirect, nonce, exp }), CryptoPurpose.EmailOAuthState);

  if (provider === 'gmail') {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getRedirectUri(provider),
      response_type: 'code',
      scope: PROVIDER_SCOPES.gmail,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(provider),
    response_type: 'code',
    scope: PROVIDER_SCOPES.outlook,
    response_mode: 'query',
    state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
};

export const parseOAuthState = (state: string): { uid: string; redirect: string } => {
  try {
    const parsed = JSON.parse(decrypt(state, CryptoPurpose.EmailOAuthState)) as { uid?: string; redirect?: string; nonce?: string; exp?: number };
    if (!parsed.uid) throw new Error('Missing uid in state');
    // FIX-SEC-S3: require nonce + expiry to block state replay.
    if (!parsed.nonce || typeof parsed.exp !== 'number') throw new Error('Missing nonce/exp in state');
    if (Date.now() > parsed.exp) {
      pendingOAuthStates.delete(parsed.nonce);
      throw new Error('Expired OAuth state');
    }
    pruneOAuthStates();
    const expectedExp = pendingOAuthStates.get(parsed.nonce);
    if (!expectedExp) throw new Error('Unknown or reused OAuth state');
    // Consume single-use: replay of the same state must fail.
    pendingOAuthStates.delete(parsed.nonce);
    return { uid: parsed.uid, redirect: parsed.redirect || '' };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Invalid OAuth state', 400);
  }
};

const exchangeCode = async (provider: EmailProvider, code: string): Promise<TokenResponse> => {
  const { clientId, clientSecret } = getProviderCredentials(provider);
  const tokenEndpoint =
    provider === 'gmail'
      ? 'https://oauth2.googleapis.com/token'
      : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: getRedirectUri(provider),
    grant_type: 'authorization_code',
  });

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as TokenResponse;

  if (!res.ok || data.error) {
    log.error('OAuth token exchange failed', { provider, error: data.error_description || data.error });
    throw new AppError(`OAuth token exchange failed: ${data.error_description || data.error || 'unknown error'}`, 500);
  }
  return data;
};

const refreshTokens = async (provider: EmailProvider, refreshToken: string): Promise<TokenResponse> => {
  const { clientId, clientSecret } = getProviderCredentials(provider);
  const tokenEndpoint =
    provider === 'gmail'
      ? 'https://oauth2.googleapis.com/token'
      : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as TokenResponse;

  if (!res.ok || data.error) {
    log.error('OAuth token refresh failed', { provider, error: data.error_description || data.error });
    throw new AppError('OAuth token refresh failed. Please reconnect your email account.', 401);
  }
  return data;
};

const fetchProfileEmail = async (provider: EmailProvider, accessToken: string): Promise<string> => {
  const url =
    provider === 'gmail'
      ? 'https://openidconnect.googleapis.com/v1/userinfo'
      : 'https://graph.microsoft.com/v1.0/me';

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new AppError('Failed to fetch account profile', 500);
  }
  const data = (await res.json()) as { email?: string; mail?: string; userPrincipalName?: string };
  return data.email || data.mail || data.userPrincipalName || '';
};

const integrationDoc = (uid: string, provider: EmailProvider) =>
  getFirebaseFirestore().collection('users').doc(uid).collection('email_integrations').doc(provider);

export const handleOAuthCallback = async (
  provider: EmailProvider,
  code: string,
  state: string
): Promise<{ uid: string; redirect: string; email: string }> => {
  const { uid, redirect } = parseOAuthState(state);
  const tokenData = await exchangeCode(provider, code);
  const accessToken = tokenData.access_token;
  const email = await fetchProfileEmail(provider, accessToken);

  const stored: StoredIntegration = {
    email,
    accessTokenEnc: encrypt(accessToken, CryptoPurpose.EmailToken),
    refreshTokenEnc: encrypt(tokenData.refresh_token || '', CryptoPurpose.EmailToken),
    expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : Date.now() + 3600 * 1000,
    connectedAt: new Date().toISOString(),
    scopes: PROVIDER_SCOPES[provider].split(' '),
  };

  await integrationDoc(uid, provider).set(stored, { merge: true });
  log.info('Email integration connected', { provider, uid, email });
  return { uid, redirect, email };
};

export const getIntegrationStatus = async (uid: string, provider: EmailProvider): Promise<IntegrationStatus> => {
  const doc = await integrationDoc(uid, provider).get();
  if (!doc.exists) return { connected: false };
  const data = doc.data() as StoredIntegration;
  return { connected: true, provider, email: data.email, connectedAt: data.connectedAt };
};

export const getValidAccessToken = async (
  uid: string,
  provider: EmailProvider
): Promise<{ accessToken: string; email: string }> => {
  const doc = await integrationDoc(uid, provider).get();
  if (!doc.exists) {
    throw new AppError(`Connect your ${provider === 'gmail' ? 'Gmail' : 'Outlook'} account in Settings first.`, 400);
  }
  const data = doc.data() as StoredIntegration;

  // Try the current domain purpose first, then the legacy default purpose
  // (pre-separation rows).
  const decryptEmailToken = (v: string): string => {
    try {
      return decrypt(v, CryptoPurpose.EmailToken);
    } catch {
      return decrypt(v, CryptoPurpose.Default);
    }
  };

  let accessToken = decryptEmailToken(data.accessTokenEnc);
  const expiresAt = data.expiresAt;

  if (Date.now() >= expiresAt - 60000) {
    if (!data.refreshTokenEnc) {
      throw new AppError('Connected account session expired. Please reconnect in Settings.', 401);
    }
    const refreshed = await refreshTokens(provider, decryptEmailToken(data.refreshTokenEnc));
    accessToken = refreshed.access_token;
    await doc.ref.set(
      {
        accessTokenEnc: encrypt(accessToken, CryptoPurpose.EmailToken),
        refreshTokenEnc: refreshed.refresh_token
          ? encrypt(refreshed.refresh_token, CryptoPurpose.EmailToken)
          : data.refreshTokenEnc,
        expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : expiresAt,
      },
      { merge: true }
    );
  }

  return { accessToken, email: data.email };
};

export const disconnectIntegration = async (uid: string, provider: EmailProvider): Promise<void> => {
  await integrationDoc(uid, provider).delete();
  log.info('Email integration disconnected', { provider, uid });
};
