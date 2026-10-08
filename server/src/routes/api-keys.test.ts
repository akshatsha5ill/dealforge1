import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import apiKeyRoutes from './api-keys.js';
import { errorHandler } from '../middleware/errorHandler.js';

vi.mock('../services/api-key-service.js', () => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('../middleware/plan.js', () => ({
  requirePlan: () => (_req: any, _res: any, next: any) => next(),
}));

import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-key-service.js';

function createApp(uid: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (uid) req.user = { uid };
    next();
  });
  app.use('/api-keys', apiKeyRoutes);
  app.use(errorHandler);
  return app;
}

async function request(app: express.Express, path: string, init?: RequestInit): Promise<Response> {
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    server.close();
  }
}

describe('api-keys routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api-keys', () => {
    it('returns 401 without an authenticated user', async () => {
      const res = await request(createApp(null), '/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
      expect(res.status).toBe(401);
    });

    it('creates a key with a default name', async () => {
      vi.mocked(createApiKey).mockResolvedValue({ key: 'df_live_abc', keyHash: 'h', name: 'API key', prefix: 'df_live_ab…', createdAt: 't' });
      const res = await request(createApp('user-1'), '/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      expect(res.status).toBe(201);
      expect(createApiKey).toHaveBeenCalledWith('user-1', 'API key');
    });

    it('uses the provided name', async () => {
      vi.mocked(createApiKey).mockResolvedValue({ key: 'df_live_abc', keyHash: 'h', name: 'CRM sync', prefix: 'df_live_ab…', createdAt: 't' });
      const res = await request(createApp('user-1'), '/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'CRM sync' }) });
      expect(res.status).toBe(201);
      expect(createApiKey).toHaveBeenCalledWith('user-1', 'CRM sync');
    });

    it('returns 500 when the service fails', async () => {
      vi.mocked(createApiKey).mockResolvedValue(null);
      const res = await request(createApp('user-1'), '/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api-keys', () => {
    it('returns the users keys', async () => {
      vi.mocked(listApiKeys).mockResolvedValue([{ keyHash: 'h', name: 'CRM sync', prefix: 'df_live_ab…', createdAt: 't', lastUsedAt: null, revoked: false }]);
      const res = await request(createApp('user-1'), '/api-keys');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toHaveLength(1);
      expect(listApiKeys).toHaveBeenCalledWith('user-1');
    });

    it('returns 401 without an authenticated user', async () => {
      const res = await request(createApp(null), '/api-keys');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api-keys/:keyHash', () => {
    it('revokes the key', async () => {
      vi.mocked(revokeApiKey).mockResolvedValue(true);
      const keyHash = 'a'.repeat(64);
      const res = await request(createApp('user-1'), `/api-keys/${keyHash}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
      expect(revokeApiKey).toHaveBeenCalledWith('user-1', keyHash);
    });

    it('returns 400 for a malformed keyHash (doc injection guard)', async () => {
      const res = await request(createApp('user-1'), '/api-keys/abc123', { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect(revokeApiKey).not.toHaveBeenCalled();
    });

    it('returns 404 when the key is not found', async () => {
      vi.mocked(revokeApiKey).mockResolvedValue(false);
      const res = await request(createApp('user-1'), `/api-keys/${'b'.repeat(64)}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });
});
