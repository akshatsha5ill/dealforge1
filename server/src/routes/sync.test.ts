import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import syncRoutes from './sync.js';
import { errorHandler } from '../middleware/errorHandler.js';

vi.mock('../services/api-data-service.js', () => ({
  syncDerivedData: vi.fn(),
}));

import { syncDerivedData } from '../services/api-data-service.js';

function createApp(uid: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (uid) req.user = { uid };
    next();
  });
  app.use('/sync', syncRoutes);
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

describe('sync routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without an authenticated user', async () => {
    const res = await request(createApp(null), '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(401);
  });

  it('syncs derived data for the user', async () => {
    vi.mocked(syncDerivedData).mockResolvedValue(undefined);
    const payload = {
      meetings: [{ id: 'm1', title: 'Discovery call', startTime: '2026-08-01T10:00:00Z', endTime: '2026-08-01T10:30:00Z', duration: 30, status: 'completed' }],
      analyses: [{ id: 'a1', meetingId: 'm1', summary: 'Good call', actionItems: ['Send proposal'], leadScore: 72, modelUsed: 'openai', analyzedAt: '2026-08-01T10:31:00Z' }],
      leads: [{ id: 'l1', meetingId: 'm1', name: 'Jane', email: 'jane@acme.com', company: 'Acme', role: 'VP', score: 72, stage: 'qualified', createdAt: 't', updatedAt: 't' }],
      deals: [{ id: 'd1', leadId: 'l1', title: 'Acme rollout', stage: 'proposal', value: 5000, probability: 50, expectedClose: '2026-09-01', createdAt: 't', updatedAt: 't' }],
    };
    const res = await request(createApp('user-1'), '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(res.status).toBe(200);
    expect(syncDerivedData).toHaveBeenCalledWith('user-1', payload);
  });

  it('accepts an empty payload', async () => {
    vi.mocked(syncDerivedData).mockResolvedValue(undefined);
    const res = await request(createApp('user-1'), '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
  });

  it('rejects invalid items', async () => {
    const res = await request(createApp('user-1'), '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetings: [{ title: 'no id' }] }) });
    expect(res.status).toBe(400);
  });

  it('rejects oversized batches', async () => {
    const meetings = Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` }));
    const res = await request(createApp('user-1'), '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetings }) });
    expect(res.status).toBe(400);
    expect(syncDerivedData).not.toHaveBeenCalled();
  });

  it('rejects malformed lead emails', async () => {
    const res = await request(createApp('user-1'), '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leads: [{ id: 'l1', email: 'not-an-email' }] }) });
    expect(res.status).toBe(400);
    expect(syncDerivedData).not.toHaveBeenCalled();
  });
});
