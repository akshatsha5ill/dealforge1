import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { errorHandler } from '../middleware/errorHandler.js';

process.env.ENCRYPTION_KEY = 'test-encryption-key';
process.env.GOOGLE_CLIENT_ID = 'google-id';
process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.MICROSOFT_CLIENT_ID = 'ms-id';
process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';
process.env.CLIENT_URL = 'http://localhost:5173';

vi.mock('../services/firebase-admin.js', () => {
  const integrationDocs = new Map<string, Record<string, unknown>>();
  return {
    getFirebaseAuth: () => ({
      verifyIdToken: vi.fn().mockResolvedValue({ uid: 'test-user', email: 'test@example.com' }),
    }),
    getFirebaseFirestore: () => ({
      collection: () => ({
        doc: (uid: string) => ({
          collection: (colName: string) => {
            if (colName === 'subscription') {
              return {
                doc: () => ({
                  get: vi.fn().mockResolvedValue({
                    exists: true,
                    data: () => ({
                      plan: 'pro',
                      status: 'active',
                      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                      updatedAt: new Date().toISOString(),
                    }),
                  }),
                }),
              };
            }
            return {
              doc: (provider: string) => {
                const key = `${uid}:${provider}`;
                return {
                  get: vi.fn().mockImplementation(async () => ({ exists: integrationDocs.has(key), data: () => integrationDocs.get(key) })),
                  set: vi.fn().mockImplementation(async () => {}),
                  delete: vi.fn().mockImplementation(async () => { integrationDocs.delete(key); }),
                };
              },
            };
          },
          get: vi.fn().mockResolvedValue({ exists: true, data: () => ({ zoomLinked: false }) }),
        }),
      }),
    }),
    __integrationDocs: integrationDocs,
  };
});

const { default: oauthRouter } = await import('./email-oauth.js');
const { __integrationDocs } = await import('../services/firebase-admin.js');

function createServer() {
  const app = express();
  app.use(express.json());
  app.use(oauthRouter);
  app.use(errorHandler);
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer(app).listen(0, () => resolve(server));
  });
}

function makeRequest(server: http.Server, method: string, path: string, options: { headers?: Record<string, string>; body?: string | Record<string, unknown> } = {}) {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: Buffer; text: string }>((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path, method, headers: { 'Content-Type': 'application/json', ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString() });
        });
      }
    );
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('email-oauth routes', () => {
  let server: http.Server | null;

  beforeEach(() => {
    __integrationDocs.clear();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  const authedHeaders = { Authorization: 'Bearer test-token' };

  it('POST /start returns a provider authorize URL for authenticated users', async () => {
    server = await createServer();
    const res = await makeRequest(server, 'POST', '/start', {
      headers: authedHeaders,
      body: { provider: 'gmail', redirect: 'http://localhost:5173/settings' },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.url).toContain('accounts.google.com');
  });

  it('POST /start rejects an open redirect', async () => {
    server = await createServer();
    const res = await makeRequest(server, 'POST', '/start', {
      headers: authedHeaders,
      body: { provider: 'gmail', redirect: 'https://evil.example.com' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /start returns 401 without auth', async () => {
    server = await createServer();
    const res = await makeRequest(server, 'POST', '/start', {
      body: { provider: 'gmail' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /:provider/callback redirects with oauth_error on invalid state', async () => {
    server = await createServer();
    const res = await makeRequest(server, 'GET', '/gmail/callback?code=abc&state=bad', {});
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('oauth_error');
  });

  it('GET /:provider/callback rejects unknown providers', async () => {
    server = await createServer();
    const res = await makeRequest(server, 'GET', '/yahoo/callback?code=abc&state=bad', {});
    expect(res.status).toBe(400);
  });

  it('GET /status returns connected integrations only', async () => {
    server = await createServer();
    const empty = await makeRequest(server, 'GET', '/status', { headers: authedHeaders });
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.text).integrations).toEqual([]);

    __integrationDocs.set('test-user:gmail', { email: 'u@example.com', connectedAt: '2026-01-01' });
    const res = await makeRequest(server, 'GET', '/status', { headers: authedHeaders });
    const body = JSON.parse(res.text);
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0]).toMatchObject({ provider: 'gmail', email: 'u@example.com' });
  });

  it('POST /disconnect removes the integration', async () => {
    server = await createServer();
    __integrationDocs.set('test-user:gmail', { email: 'u@example.com' });
    const res = await makeRequest(server, 'POST', '/disconnect', {
      headers: authedHeaders,
      body: { provider: 'gmail' },
    });
    expect(res.status).toBe(200);
    expect(__integrationDocs.has('test-user:gmail')).toBe(false);
  });
});
