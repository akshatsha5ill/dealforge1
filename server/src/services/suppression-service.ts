import { getFirebaseFirestore } from './firebase-admin.js';
import { config } from '../config.js';
import log from '../utils/logger.js';

/**
 * Suppression service (wave 1 — storage layer only, no route wiring).
 *
 * Firestore layout:
 *   collection `suppressions`, doc id = normalized email
 *   fields: { email: string, kind: SuppressionKind, at: string (ISO) }
 *
 * Kinds cover the email-compliance gaps:
 *   - bounce        — hard bounce / permanent delivery failure
 *   - complaint     — spam complaint / abuse report (SES/Resend/Gmail FBL)
 *   - unsubscribe   — one-click / List-Unsubscribe / footer opt-out
 *   - stop-on-reply — recipient replied, stop sequence immediately
 *   - manual        — admin / user added manually
 *
 * Next wave (routes, not this file) will:
 *   - check() before send in email-service / routes/email.ts
 *   - record() from bounce/complaint webhooks + unsubscribe + reply detector
 */

export type SuppressionKind =
  | 'bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'stop-on-reply'
  | 'manual';

export interface SuppressionRecord {
  email: string;
  kind: SuppressionKind;
  at: string;
  reason?: string;
  campaignId?: string;
  source?: string;
}

export interface RecordSuppressionOptions {
  reason?: string;
  campaignId?: string;
  source?: string;
  /** Override timestamp (defaults to now). Accepts Date or ISO string. */
  at?: string | Date;
}

const COLLECTION = 'suppressions';

const VALID_KINDS: ReadonlySet<string> = new Set([
  'bounce',
  'complaint',
  'unsubscribe',
  'stop-on-reply',
  'manual',
]);

// In-memory fallback for dev without Firebase creds and for Firestore outages.
// Mirrors the Firestore shape so behavior is identical when failing open.
const memoryStore = new Map<string, SuppressionRecord>();

export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function isValidKind(kind: unknown): kind is SuppressionKind {
  return typeof kind === 'string' && VALID_KINDS.has(kind);
}

function toIsoAt(at?: string | Date): string {
  if (at instanceof Date) return at.toISOString();
  if (typeof at === 'string' && at) {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return at;
  }
  return new Date().toISOString();
}

/**
 * Fetch the suppression record for an email, or null if not suppressed.
 * Fail-closed in prod: throws on Firestore outage unless the in-memory
 * fallback has a hit (prior write kept in memory still suppresses).
 * In non-prod, falls back to memory/null so dev without Firebase works.
 */
export async function getSuppression(email: string): Promise<SuppressionRecord | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  try {
    const snap = await getFirebaseFirestore().collection(COLLECTION).doc(normalized).get();
    if (snap.exists) {
      const data = snap.data() as Partial<SuppressionRecord> | undefined;
      if (data && typeof data.email === 'string' && isValidKind(data.kind) && typeof data.at === 'string') {
        return {
          email: data.email,
          kind: data.kind,
          at: data.at,
          ...(data.reason ? { reason: data.reason } : {}),
          ...(data.campaignId ? { campaignId: data.campaignId } : {}),
          ...(data.source ? { source: data.source } : {}),
        };
      }
      // Doc exists but malformed — treat as suppressed to stay compliant.
      log.warn('Malformed suppression doc, treating as suppressed', { email: normalized });
      return {
        email: normalized,
        kind: (data?.kind as SuppressionKind) || 'manual',
        at: typeof data?.at === 'string' ? data.at : new Date().toISOString(),
      };
    }
  } catch (err) {
    const memHit = memoryStore.get(normalized);
    if (memHit) {
      log.warn('Firestore suppression lookup failed, using memory fallback hit', {
        email: normalized,
      });
      return memHit;
    }
    log.error('Firestore suppression lookup unavailable', {
      error: err,
      email: normalized,
    });
    // Fail-closed in prod so outage never sends to bounced/complained/
    // unsubscribed addresses. Memory-only state is per-process and lost on
    // restart, so a miss must block rather than allow.
    if (config.isProd) throw err;
  }

  return memoryStore.get(normalized) ?? null;
}

/**
 * Check whether an email is suppressed (bounce/complaint/unsubscribe/stop-on-reply).
 * Returns true when a suppression record exists, false otherwise.
 * Fail-closed in prod: throws on Firestore outage (unless memory fallback has
 * it) so callers block send. For display-only paths that must never throw,
 * catch and treat error as suppressed. For pre-send enforcement use
 * checkStrict() instead.
 */
export async function check(email: string): Promise<boolean> {
  const record = await getSuppression(email);
  return record !== null;
}

/**
 * Strict pre-send guard: same semantics as check() but fails closed.
 * Throws on Firestore outage instead of failing open to false, so callers
 * must block send on error. Memory fallback is still consulted when Firestore
 * succeeds (covers prior writes kept in memory), but never masks an outage.
 * Not wired to callers this wave — check() remains for display/UI.
 */
export async function checkStrict(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const snap = await getFirebaseFirestore().collection(COLLECTION).doc(normalized).get();
  if (snap.exists) {
    const data = snap.data() as Partial<SuppressionRecord> | undefined;
    if (data && typeof data.email === 'string' && isValidKind(data.kind) && typeof data.at === 'string') {
      return true;
    }
    // Doc exists but malformed — treat as suppressed to stay compliant.
    log.warn('Malformed suppression doc, treating as suppressed', { email: normalized });
    return true;
  }

  return memoryStore.has(normalized);
}

/**
 * Record a suppression: creates/overwrites
 * `suppressions/{normalized-email}` with { email, kind, at, ...opts }.
 * Also mirrors into the in-memory fallback so dev/test without Firestore works.
 * Fail-closed in prod: throws on Firestore write failure (memory-only state
 * is per-process and lost on restart, so callers must retry rather than
 * assume durable suppression).
 */
export async function record(
  email: string,
  kind: SuppressionKind,
  opts: RecordSuppressionOptions = {},
): Promise<SuppressionRecord> {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw new Error('record() requires a valid email address.');
  }
  if (!isValidKind(kind)) {
    throw new Error(`record() requires a valid kind: ${[...VALID_KINDS].join(', ')}.`);
  }

  const entry: SuppressionRecord = {
    email: normalized,
    kind,
    at: toIsoAt(opts.at),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  };

  // Keep memory fallback in sync first so a Firestore outage still suppresses
  // in-process (checkStrict consults it after a successful read).
  memoryStore.set(normalized, entry);

  try {
    await getFirebaseFirestore().collection(COLLECTION).doc(normalized).set(entry);
  } catch (err) {
    log.error('Firestore suppression write failed', {
      error: err,
      email: normalized,
      kind,
    });
    if (config.isProd) throw err;
  }

  return entry;
}

/**
 * Remove a suppression (admin resubscribe / successful re-opt-in only).
 * Deletes the Firestore doc and clears the memory fallback.
 */
export async function remove(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  memoryStore.delete(normalized);
  try {
    await getFirebaseFirestore().collection(COLLECTION).doc(normalized).delete();
  } catch (err) {
    log.error('Firestore suppression delete failed', { error: err, email: normalized });
  }
}

// Aliases for readability at future call sites (pre-send guard, webhooks).
export const isSuppressed = check;
export const recordSuppression = record;
export const getSuppressionFor = getSuppression;
export const removeSuppression = remove;
