import { createHash, randomBytes } from 'node:crypto';
import { getFirebaseFirestore } from './firebase-admin.js';
import log from '../utils/logger.js';

const KEY_PREFIX = 'df_live_';
const KEY_BYTES = 24;

export interface ApiKeyRecord {
  keyHash: string;
  uid: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface NewApiKey {
  key: string;
  keyHash: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export interface ApiKeySummary {
  keyHash: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export function generateApiKey(): { key: string; keyHash: string; prefix: string } {
  const raw = randomBytes(KEY_BYTES).toString('base64url');
  const key = `${KEY_PREFIX}${raw}`;
  return { key, keyHash: hashApiKey(key), prefix: `${KEY_PREFIX}${raw.slice(0, 4)}…` };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

async function withFallback<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error('API key service unavailable, failing open', { error: err });
    return fallback;
  }
}

function keyDoc(keyHash: string) {
  return getFirebaseFirestore().collection('api-keys').doc(keyHash);
}

export async function createApiKey(uid: string, name: string): Promise<NewApiKey | null> {
  const { key, keyHash, prefix } = generateApiKey();
  const record: ApiKeyRecord = {
    keyHash,
    uid,
    name,
    prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revoked: false,
  };
  const ok = await withFallback(false, async () => {
    await keyDoc(keyHash).set(record);
    return true;
  });
  if (!ok) return null;
  return { key, keyHash, name, prefix, createdAt: record.createdAt };
}

export async function listApiKeys(uid: string): Promise<ApiKeySummary[]> {
  return withFallback([], async () => {
    const snap = await getFirebaseFirestore()
      .collection('api-keys')
      .where('uid', '==', uid)
      .get();
    const keys: ApiKeySummary[] = [];
    snap.forEach((doc) => {
      const data = doc.data() as Partial<ApiKeyRecord>;
      keys.push({
        keyHash: data.keyHash || doc.id,
        name: data.name || 'API key',
        prefix: data.prefix || 'df_live_…',
        createdAt: data.createdAt || new Date().toISOString(),
        lastUsedAt: data.lastUsedAt || null,
        revoked: !!data.revoked,
      });
    });
    return keys.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  });
}

export async function revokeApiKey(uid: string, keyHash: string): Promise<boolean> {
  return withFallback(false, async () => {
    const doc = await keyDoc(keyHash).get();
    if (!doc.exists) return false;
    if (doc.data()?.uid !== uid) return false;
    await doc.ref.update({ revoked: true });
    return true;
  });
}

export async function findApiKeyOwner(key: string): Promise<{ uid: string; keyHash: string } | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const keyHash = hashApiKey(key);
  const doc = await keyDoc(keyHash).get();
  if (!doc.exists) return null;
  const data = doc.data() as Partial<ApiKeyRecord>;
  if (data.revoked || !data.uid) return null;
  // API keys require an active paid plan. Deny if free/expired so keys do
  // not survive a downgrade, cancellation, or period end.
  const uid = data.uid;
  try {
    const subDoc = await getFirebaseFirestore()
      .collection('users')
      .doc(uid)
      .collection('subscription')
      .doc('current')
      .get();
    if (!subDoc.exists) return null;
    const sub = subDoc.data();
    const plan = sub?.plan as string | undefined;
    if (plan !== 'pro' && plan !== 'enterprise') return null;
    const status = sub?.status as string | undefined;
    if (status === 'cancelled' || status === 'past_due' || status === 'expired') return null;
    const currentPeriodEnd = sub?.currentPeriodEnd as string | null | undefined;
    if (typeof currentPeriodEnd === 'string' && currentPeriodEnd) {
      const endTime = new Date(currentPeriodEnd).getTime();
      if (!Number.isNaN(endTime)) {
        if (endTime < Date.now()) return null;
        return { uid, keyHash };
      }
      // Invalid date string falls through to fail-closed handling below.
    }
    // Fail-closed: null/missing/invalid expiry must not grant perpetual access.
    // Allow a 30d grace from updatedAt so transient webhook nulls don't lock out
    // immediately; otherwise treat as expired. Covers null + no subscriptionId.
    const updatedAt = sub?.updatedAt as string | null | undefined;
    const updatedTime = typeof updatedAt === 'string' && updatedAt ? new Date(updatedAt).getTime() : NaN;
    const GRACE_MS = 30 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(updatedTime) || Date.now() - updatedTime > GRACE_MS) return null;
  } catch (err) {
    log.error('Failed to check subscription for API key', { error: err, uid });
    return null;
  }
  return { uid, keyHash };
}

export async function touchApiKeyLastUsed(keyHash: string): Promise<void> {
  await withFallback(undefined, async () => {
    await keyDoc(keyHash).update({ lastUsedAt: new Date().toISOString() });
  });
}

export { KEY_PREFIX };
