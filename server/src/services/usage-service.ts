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
  return withFallback(0, async () => {
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
  });
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
