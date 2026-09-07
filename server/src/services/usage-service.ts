import { randomUUID } from 'node:crypto';
import { getFirebaseFirestore } from './firebase-admin.js';
import log from '../utils/logger.js';

const FREE_ANALYSIS_LIMIT = 3;
// Abuse-prevention cap: bounds re-analyze loops even for unlimited plans.
// Monthly free-tier enforcement stays in middleware/plan.ts; this is defense-in-depth.
const DAILY_ANALYSIS_LIMIT = 10;

export function getMonthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function getDayKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

async function withFallback<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error('Firestore usage tracking unavailable, failing open', { error: err });
    return fallback;
  }
}

// Internal fetch that throws on Firestore error (fail-closed).
// Enforcement path must use this (via getMonthlyAnalysisCount / Strict below)
// so middleware/plan.ts enforceAnalysisLimit catches -> 500 instead of allowing free.
async function fetchMonthlyAnalysisCount(uid: string, month: string): Promise<number> {
  const snap = await getFirebaseFirestore()
    .collection('users')
    .doc(uid)
    .collection('usage')
    .doc(month)
    .collection('analyses')
    .listDocuments();
  return snap.length;
}

export async function getMonthlyAnalysisCount(uid: string, monthKey?: string): Promise<number> {
  const month = monthKey || getMonthKey();
  try {
    return await fetchMonthlyAnalysisCount(uid, month);
  } catch (err) {
    // Fail-closed for enforceAnalysisLimit(): never return 0 on error (would grant unlimited free).
    log.error('Firestore usage tracking unavailable, failing closed for enforcement', { error: err });
    throw err;
  }
}

// Explicit strict alias for the enforce path (middleware/plan.ts).
export async function getMonthlyAnalysisCountStrict(uid: string, monthKey?: string): Promise<number> {
  return getMonthlyAnalysisCount(uid, monthKey);
}

// Fail-open read variant for display/diagnostic paths only (NOT for enforcement).
// Keeps old withFallback(0) behaviour where under-counting is acceptable.
export async function getMonthlyAnalysisCountWithFallback(uid: string, monthKey?: string): Promise<number> {
  const month = monthKey || getMonthKey();
  return withFallback(0, async () => fetchMonthlyAnalysisCount(uid, month));
}

export async function getDailyAnalysisCount(uid: string, dayKey?: string, monthKey?: string): Promise<number> {
  const day = dayKey || getDayKey();
  const month = monthKey || day.slice(0, 7);
  return withFallback(0, async () => fetchDailyAnalysisCount(uid, day, month));
}

// Fail-closed daily read for enforcement paths (middleware, pipeline).
// Never returns 0-on-outage (which would grant unlimited analyses).
export async function getDailyAnalysisCountStrict(uid: string, dayKey?: string, monthKey?: string): Promise<number> {
  const day = dayKey || getDayKey();
  const month = monthKey || day.slice(0, 7);
  try {
    return await fetchDailyAnalysisCount(uid, day, month);
  } catch (err) {
    log.error('Firestore daily usage tracking unavailable, failing closed for enforcement', { error: err });
    throw err;
  }
}

async function fetchDailyAnalysisCount(uid: string, day: string, month: string): Promise<number> {
  const analyses = getFirebaseFirestore()
    .collection('users')
    .doc(uid)
    .collection('usage')
    .doc(month)
    .collection('analyses') as unknown as {
    listDocuments: () => Promise<Array<{ get?: () => Promise<{ exists?: boolean; data?: () => unknown }> }>>;
    where?: (field: string, op: string, value: string) => { get: () => Promise<{ size?: number; docs?: unknown[] }> };
  };
  // Fast path: indexed equality query on `day`.
  try {
    if (typeof analyses.where === 'function') {
      const snap = await analyses.where('day', '==', day).get();
      if (typeof snap?.size === 'number') return snap.size;
      if (Array.isArray(snap?.docs)) return snap.docs.length;
    }
  } catch {
    // Fall through to list + filter below.
  }
  // Fallback: list monthly docs and filter by day (also covers legacy docs via `at`).
  const refs = await analyses.listDocuments();
  let count = 0;
  for (const ref of refs) {
    try {
      if (!ref || typeof ref.get !== 'function') continue;
      const snap = await ref.get();
      if (snap && (snap as { exists?: boolean }).exists === false) continue;
      const data = (snap?.data?.() as { day?: unknown; at?: unknown } | undefined) ?? undefined;
      if (typeof data?.day === 'string') {
        if (data.day === day) count++;
      } else if (typeof data?.at === 'string') {
        if ((data.at as string).slice(0, 10) === day) count++;
      }
    } catch {
      continue;
    }
  }
  return count;
}

export async function recordAnalysisUsage(uid: string, meetingId: string, monthKey?: string): Promise<void> {
  const now = new Date();
  const month = monthKey || getMonthKey(now);
  const day = getDayKey(now);
  // Per-day abuse cap (fails open on read errors via getDailyAnalysisCount fallback).
  const dailyCount = await getDailyAnalysisCount(uid, day, month);
  if (dailyCount >= DAILY_ANALYSIS_LIMIT) {
    log.warn('Daily analysis limit reached, rejecting usage write', { uid, dailyCount, limit: DAILY_ANALYSIS_LIMIT });
    throw new Error(`Daily analysis limit of ${DAILY_ANALYSIS_LIMIT} reached. Please try again tomorrow.`);
  }
  await withFallback(undefined, async () => {
    // Per-analysis doc with uuid: re-analyzing the same meetingId creates a new
    // doc instead of overwriting doc(meetingId), so monthly/daily counts are exact.
    const id = randomUUID();
    await getFirebaseFirestore()
      .collection('users')
      .doc(uid)
      .collection('usage')
      .doc(month)
      .collection('analyses')
      .doc(id)
      .set({ meetingId, at: now.toISOString(), day });
  });
}

export { FREE_ANALYSIS_LIMIT, DAILY_ANALYSIS_LIMIT };
// Alias for forward-compat with alternate import names.
export const MAX_DAILY_ANALYSES = DAILY_ANALYSIS_LIMIT;

// ---------------------------------------------------------------------------
// Cross-instance quota reservations (fixes check-then-use TOCTOU across
// instances; the old in-memory pending map only serialized one process).
//
// Flow: enforceAnalysisLimit() calls reserveAnalysisSlot() BEFORE the AI call
// (inside a Firestore transaction: count + write atomically). The route calls
// confirmAnalysisSlot() after a successful AI call, or the reservation is
// released (delete) on failure. Reservations live in the same `analyses`
// collection with status:'reserved' so every counter already includes them
// (fail-closed slant while in flight); expired reservations are pruned lazily
// and ignored by the quota math.
// ---------------------------------------------------------------------------

export class AnalysisQuotaError extends Error {
  readonly kind: 'monthly' | 'daily';
  readonly limit: number;
  constructor(kind: 'monthly' | 'daily', limit: number, message: string) {
    super(message);
    this.name = 'AnalysisQuotaError';
    this.kind = kind;
    this.limit = limit;
  }
}

export interface ReserveOptions {
  meetingId?: string;
  monthKey?: string;
  /** Enforce the monthly free-tier cap (false for unlimited plans). */
  enforceMonthly?: boolean;
  monthlyLimit?: number;
  /** Enforce the daily abuse cap (all plans). Default true. */
  enforceDaily?: boolean;
}

// In-memory fallback when Firestore transactions are unavailable (unit tests
// without firebase-admin). Mirrors the old single-instance pending map.
const memPending = new Map<string, number>();

export function __getPendingAnalysisCount(uid: string): number {
  return memPending.get(uid) ?? 0;
}

export function __clearPendingAnalysisCounts(): void {
  memPending.clear();
}

const RESERVATION_TTL_MS = 15 * 60 * 1000;

function reservationCounts(
  docs: Array<{ ref?: unknown; data?: () => unknown }>,
  day: string,
  nowMs: number,
): { monthlyUsed: number; dailyUsed: number; expiredRefs: unknown[] } {
  let monthlyUsed = 0;
  let dailyUsed = 0;
  const expiredRefs: unknown[] = [];
  for (const doc of docs) {
    let data: { status?: unknown; expiresAt?: unknown; day?: unknown; at?: unknown } | undefined;
    try {
      data = (typeof doc.data === 'function' ? doc.data() : undefined) as typeof data;
    } catch {
      continue;
    }
    if (data?.status === 'reserved') {
      const exp = typeof data.expiresAt === 'string' ? new Date(data.expiresAt).getTime() : NaN;
      if (Number.isFinite(exp) && (exp as number) <= nowMs) {
        if (doc.ref) expiredRefs.push(doc.ref);
        continue;
      }
    }
    monthlyUsed++;
    if (typeof data?.day === 'string') {
      if (data.day === day) dailyUsed++;
    } else if (typeof data?.at === 'string') {
      if ((data.at as string).slice(0, 10) === day) dailyUsed++;
    }
  }
  return { monthlyUsed, dailyUsed, expiredRefs };
}

// Test-only alias for the quota-counting pure helper.
export { reservationCounts as __reservationCounts };

export async function reserveAnalysisSlot(uid: string, opts: ReserveOptions = {}): Promise<string> {
  const now = new Date();
  const month = opts.monthKey || getMonthKey(now);
  const day = getDayKey(now);
  const enforceMonthly = opts.enforceMonthly ?? true;
  const monthlyLimit = opts.monthlyLimit ?? FREE_ANALYSIS_LIMIT;
  const enforceDaily = opts.enforceDaily ?? true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  try {
    db = getFirebaseFirestore() as any;
  } catch {
    db = null; // firebase-admin unconfigured: mem-fallback below
  }

  if (typeof db?.runTransaction !== 'function') {
    // No-transaction env (unit tests without firebase-admin): synchronous
    // in-memory check-and-hold. Production Firestore always has transactions.
    const key = `${uid}:${month}:${day}`;
    const pending = memPending.get(key) ?? 0;
    if (enforceDaily && pending >= DAILY_ANALYSIS_LIMIT) {
      throw new AnalysisQuotaError('daily', DAILY_ANALYSIS_LIMIT, `Daily analysis limit of ${DAILY_ANALYSIS_LIMIT} reached. Please try again tomorrow.`);
    }
    if (enforceMonthly && pending >= monthlyLimit) {
      throw new AnalysisQuotaError('monthly', monthlyLimit, `You've reached your free limit of ${monthlyLimit} analyzed meetings per month. Upgrade to Pro for unlimited meetings.`);
    }
    memPending.set(key, pending + 1);
    return `mem:${key}:${pending + 1}:${Date.now()}`;
  }

  try {
    return await db.runTransaction(async (tx: {
      get: (ref: unknown) => Promise<{ size?: number; docs?: Array<{ ref?: unknown; data?: () => unknown }> }>;
      set: (ref: unknown, data: unknown, opts?: unknown) => void;
      delete: (ref: unknown) => void;
    }) => {
      const monthDoc = db.collection('users').doc(uid).collection('usage').doc(month);
      const analysesCol = monthDoc.collection('analyses');
      const snap = await tx.get(analysesCol);
      const docs = Array.isArray(snap?.docs) ? snap.docs : [];
      const { monthlyUsed, dailyUsed, expiredRefs } = reservationCounts(docs, day, now.getTime());
      if (enforceMonthly && monthlyUsed >= monthlyLimit) {
        throw new AnalysisQuotaError('monthly', monthlyLimit, `You've reached your free limit of ${monthlyLimit} analyzed meetings per month. Upgrade to Pro for unlimited meetings.`);
      }
      if (enforceDaily && dailyUsed >= DAILY_ANALYSIS_LIMIT) {
        throw new AnalysisQuotaError('daily', DAILY_ANALYSIS_LIMIT, `Daily analysis limit of ${DAILY_ANALYSIS_LIMIT} reached. Please try again tomorrow.`);
      }
      // Lazily prune expired reservations so crashed requests don't leak quota.
      for (const ref of expiredRefs) {
        try {
          tx.delete(ref);
        } catch {
          // best-effort inside the transaction
        }
      }
      // Serialization point: concurrent reserves contend on this doc, so the
      // loser retries and re-reads the winner's reservation above.
      tx.set(monthDoc, { updatedAt: now.toISOString() }, { merge: true });
      const id = randomUUID();
      tx.set(analysesCol.doc(id), {
        meetingId: opts.meetingId ?? null,
        at: now.toISOString(),
        day,
        status: 'reserved',
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
      });
      return id;
    });
  } catch (err) {
    if (err instanceof AnalysisQuotaError) throw err;
    // Fail-closed: a quota check that errored must not grant a provider call.
    log.error('Analysis slot reservation failed, failing closed', { error: err, uid });
    throw err;
  }
}

// Mark a reservation complete after a successful AI call. Best-effort: never
// throws, so a usage-write failure can't turn a successful analysis into a
// 500 (the reservation itself already counted toward quota, fail-closed).
export async function confirmAnalysisSlot(uid: string, reservationId: string, meetingId?: string, monthKey?: string): Promise<void> {
  if (!reservationId) return;
  if (reservationId.startsWith('mem:')) {
    const key = reservationId.slice('mem:'.length).split(':').slice(0, 3).join(':');
    // Release the in-memory hold and record the detail doc like recordAnalysisUsage.
    const cur = memPending.get(key) ?? 0;
    if (cur <= 1) memPending.delete(key);
    else memPending.set(key, cur - 1);
    await recordAnalysisUsage(uid, meetingId ?? randomUUID(), monthKey);
    return;
  }
  const month = monthKey || getMonthKey();
  try {
    await getFirebaseFirestore()
      .collection('users').doc(uid)
      .collection('usage').doc(month)
      .collection('analyses').doc(reservationId)
      .set({ status: 'complete', ...(meetingId ? { meetingId } : {}), confirmedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    log.warn('Failed to confirm analysis usage (reservation still counts toward quota)', { error: err, uid });
  }
}

// Release a reservation after a failed AI call. Best-effort, never throws.
export async function releaseAnalysisSlot(uid: string, reservationId: string, monthKey?: string): Promise<void> {
  if (!reservationId) return;
  if (reservationId.startsWith('mem:')) {
    const key = reservationId.slice('mem:'.length).split(':').slice(0, 3).join(':');
    const cur = memPending.get(key) ?? 0;
    if (cur <= 1) memPending.delete(key);
    else memPending.set(key, cur - 1);
    return;
  }
  const month = monthKey || getMonthKey();
  try {
    await getFirebaseFirestore()
      .collection('users').doc(uid)
      .collection('usage').doc(month)
      .collection('analyses').doc(reservationId)
      .delete();
  } catch (err) {
    log.warn('Failed to release analysis reservation', { error: err, uid });
  }
}
