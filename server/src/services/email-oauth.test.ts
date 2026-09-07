import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError } from '../middleware/errorHandler.js';

process.env.ENCRYPTION_KEY = 'test-encryption-key';
process.env.GOOGLE_CLIENT_ID = 'google-id';
process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.MICROSOFT_CLIENT_ID = 'ms-id';
process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';

vi.mock('../services/firebase-admin.js', () => {
  const docRefs = new Map<string, any>();
  return {
    getFirebaseFirestore: () => ({
      collection: () => ({
        doc: (uid: string) => ({
          collection: () => ({
            doc: (provider: string) => {
              const key = `${uid}:${provider}`;
              return {
                get: vi.fn().mockImplementation(async () => ({
                  exists: docRefs.has(key),
                  data: () => docRefs.get(key),
                  ref: {
                    set: vi.fn().mockImplementation(async (data, opts) => {
                      docRefs.set(key, { ...(docRefs.get(key) || {}), ...data });
                    }),
                  },
                })),
                set: vi.fn().mockImplementation(async (data) => { docRefs.set(key, data); }),
                delete: vi.fn().mockImplementation(async () => { docRefs.delete(key); }),
              };
            },
          }),
        }),
      }),
    }),
    __docRefs: docRefs,
  };
});

const { decrypt, CryptoPurpose } = await import('../utils/crypto.js');
const { __docRefs } = await import('../services/firebase-admin.js');
const oauth = await import('./email-oauth.js');

const mockFetch = (url: string, options: { body?: string } = {}) => {
  const body = new URLSearchParams(options.body || '');
  if (url.includes('/token') || url.includes('oauth2/v2.0/token') || url.includes('/token')) {
    if (body.get('grant_type') === 'authorization_code') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'access-123', refresh_token: 'refresh-456', expires_in: 3600 }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'access-refreshed', expires_in: 3600 }),
    } as Response);
  }
  if (url.includes('userinfo') || url.includes('graph.microsoft.com')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ email: 'user@example.com' }),
    } as Response);
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  } as Response);
};

describe('email-oauth service', () => {
  beforeEach(() => {
    __docRefs.clear();
    oauth.__clearOAuthStateCache();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(mockFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('buildOAuthStartUrl', () => {
    it('builds a Gmail authorize URL with encrypted state', () => {
      const url = oauth.buildOAuthStartUrl('gmail', 'user-1', 'https://app.example/settings');
      expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('client_id')).toBe('google-id');
      expect(parsed.searchParams.get('access_type')).toBe('offline');
      const state = parsed.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(JSON.parse(decrypt(state!, CryptoPurpose.EmailOAuthState))).toEqual(
        expect.objectContaining({ uid: 'user-1', redirect: 'https://app.example/settings' }),
      );
      const payload = JSON.parse(decrypt(state!, CryptoPurpose.EmailOAuthState)) as { nonce?: string; exp?: number };
      expect(typeof payload.nonce).toBe('string');
      expect(typeof payload.exp).toBe('number');
    });

    it('builds an Outlook authorize URL', () => {
      const url = oauth.buildOAuthStartUrl('outlook', 'user-1', 'https://app.example/settings');
      expect(url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBe(true);
    });

    it('throws when credentials are not configured', () => {
      const saved = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      try {
        expect(() => oauth.buildOAuthStartUrl('gmail', 'u', 'https://x')).toThrow(AppError);
      } finally {
        process.env.GOOGLE_CLIENT_ID = saved;
      }
    });
  });

  describe('handleOAuthCallback', () => {
    const makeState = () => {
      const url = oauth.buildOAuthStartUrl('gmail', 'user-1', 'https://app.example/settings');
      return new URL(url).searchParams.get('state')!;
    };

    it('exchanges the code, stores encrypted tokens, and returns the redirect', async () => {
      const state = makeState();
      const result = await oauth.handleOAuthCallback('gmail', 'code-1', state);
      expect(result.email).toBe('user@example.com');
      expect(result.redirect).toBe('https://app.example/settings');

      const stored = __docRefs.get('user-1:gmail');
      expect(stored).toBeTruthy();
      expect(stored.email).toBe('user@example.com');
      expect(decrypt(stored.accessTokenEnc, CryptoPurpose.EmailToken)).toBe('access-123');
      expect(decrypt(stored.refreshTokenEnc, CryptoPurpose.EmailToken)).toBe('refresh-456');
      expect(stored.expiresAt).toBeGreaterThan(Date.now());
    });

    it('rejects invalid state', async () => {
      await expect(oauth.handleOAuthCallback('gmail', 'code-1', 'garbage-state')).rejects.toThrow(AppError);
    });
  });

  describe('getValidAccessToken', () => {
    it('returns the stored access token', async () => {
      const url = oauth.buildOAuthStartUrl('gmail', 'user-1', 'https://app.example/settings');
      const state = new URL(url).searchParams.get('state')!;
      await oauth.handleOAuthCallback('gmail', 'code-1', state);
      const tokens = await oauth.getValidAccessToken('user-1', 'gmail');
      expect(tokens.accessToken).toBe('access-123');
      expect(tokens.email).toBe('user@example.com');
    });

    it('refreshes an expired token', async () => {
      const cryptoMod = await import('../utils/crypto.js');
      __docRefs.set('user-1:gmail', {
        email: 'user@example.com',
        accessTokenEnc: cryptoMod.encrypt('expired-token', cryptoMod.CryptoPurpose.EmailToken),
        refreshTokenEnc: cryptoMod.encrypt('refresh-456', cryptoMod.CryptoPurpose.EmailToken),
        expiresAt: Date.now() - 1000,
        connectedAt: new Date().toISOString(),
        scopes: [],
      });
      const tokens = await oauth.getValidAccessToken('user-1', 'gmail');
      expect(tokens.accessToken).toBe('access-refreshed');
    });

    it('throws when no integration exists', async () => {
      await expect(oauth.getValidAccessToken('user-1', 'gmail')).rejects.toThrow('Connect your Gmail');
    });
  });

  describe('getIntegrationStatus / disconnect', () => {
    it('returns disconnected when no doc exists', async () => {
      const status = await oauth.getIntegrationStatus('user-1', 'gmail');
      expect(status.connected).toBe(false);
    });

    it('disconnects an integration', async () => {
      const url = oauth.buildOAuthStartUrl('gmail', 'user-1', 'https://app.example/settings');
      const state = new URL(url).searchParams.get('state')!;
      await oauth.handleOAuthCallback('gmail', 'code-1', state);
      await oauth.disconnectIntegration('user-1', 'gmail');
      expect(__docRefs.has('user-1:gmail')).toBe(false);
    });
  });
});
