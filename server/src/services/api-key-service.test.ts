import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map<string, Map<string, unknown>>());
const subStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../services/firebase-admin.js', () => ({
  getFirebaseFirestore: () => ({
    collection: (name: string) => {
      if (name === 'users') {
        return {
          doc: (uid: string) => ({
            collection: () => ({
              doc: () => ({
                get: async () => ({
                  exists: subStore.has(uid),
                  data: () => subStore.get(uid),
                }),
              }),
            }),
          }),
        };
      }
      if (!store.has(name)) store.set(name, new Map());
      const coll = store.get(name)!;
      return {
        doc: (id: string) => {
          return {
            get: async () => ({ exists: coll.has(id), data: () => coll.get(id), ref: { update: async (patch: Record<string, unknown>) => { coll.set(id, { ...coll.get(id), ...patch }); } } }),
            set: async (data: unknown) => { coll.set(id, data); },
            update: async (patch: Record<string, unknown>) => {
              coll.set(id, { ...coll.get(id), ...patch });
            },
          };
        },
        where: (field: string, _op: string, value: unknown) => {
          const matches = [...coll.entries()].filter(([, v]) => (v as Record<string, unknown>)[field] === value);
          return {
            get: async () => ({
              forEach: (cb: (d: { data: () => unknown; id: string }) => void) => {
                matches.forEach(([id, v]) => cb({ data: () => v, id }));
              },
            }),
          };
        },
      };
    },
  }),
}));

import { createApiKey, listApiKeys, revokeApiKey, findApiKeyOwner, hashApiKey, generateApiKey, KEY_PREFIX } from './api-key-service.js';

beforeEach(() => {
  store.clear();
  subStore.clear();
  // Default: active Pro subscription so findApiKeyOwner passes the paid-plan gate.
  subStore.set('user-1', {
    plan: 'pro',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

describe('generateApiKey / hashApiKey', () => {
  it('generates a key with the live prefix and a matching hash', () => {
    const { key, keyHash, prefix } = generateApiKey();
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(KEY_PREFIX.length + 8);
    expect(keyHash).toBe(hashApiKey(key));
    expect(prefix).toContain('…');
  });

  it('produces distinct keys on successive calls', () => {
    expect(generateApiKey().key).not.toBe(generateApiKey().key);
  });
});

describe('createApiKey / listApiKeys / revokeApiKey', () => {
  it('creates a key and lists it for the owner', async () => {
    const result = await createApiKey('user-1', 'CRM sync');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('CRM sync');

    const keys = await listApiKeys('user-1');
    expect(keys).toHaveLength(1);
    expect(keys[0].keyHash).toBe(result!.keyHash);
    expect(keys[0].revoked).toBe(false);
  });

  it('never returns the full key from the list', async () => {
    const result = await createApiKey('user-1', 'CRM sync');
    const keys = await listApiKeys('user-1');
    expect(keys[0].prefix).not.toContain(result!.key);
  });

  it('does not list other users keys', async () => {
    await createApiKey('user-1', 'mine');
    const keys = await listApiKeys('user-2');
    expect(keys).toHaveLength(0);
  });

  it('revokes a key owned by the user', async () => {
    const result = await createApiKey('user-1', 'CRM sync');
    const ok = await revokeApiKey('user-1', result!.keyHash);
    expect(ok).toBe(true);
    const keys = await listApiKeys('user-1');
    expect(keys[0].revoked).toBe(true);
  });

  it('refuses to revoke another user key', async () => {
    const result = await createApiKey('user-1', 'CRM sync');
    const ok = await revokeApiKey('user-2', result!.keyHash);
    expect(ok).toBe(false);
  });
});

describe('findApiKeyOwner', () => {
  it('resolves the owner for a valid, active key', async () => {
    const result = await createApiKey('user-1', 'CRM sync');
    const owner = await findApiKeyOwner(result!.key);
    expect(owner).toEqual({ uid: 'user-1', keyHash: result!.keyHash });
  });

  it('returns null for unknown keys', async () => {
    expect(await findApiKeyOwner('df_live_not-a-real-key')).toBeNull();
  });

  it('returns null for revoked keys', async () => {
    const result = await createApiKey('user-1', 'CRM sync');
    await revokeApiKey('user-1', result!.keyHash);
    expect(await findApiKeyOwner(result!.key)).toBeNull();
  });

  it('returns null for keys without the live prefix', async () => {
    expect(await findApiKeyOwner('some-other-format')).toBeNull();
  });
});
